// Directory listings and the cache the pages depend on: a stale listing after a
// write is a user-visible bug, and a hidden dotfile is a leak of app state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	getSession,
	invalidateEntries,
	loadDrive,
	loadEntries,
	loadSessions
} from '../src/lib/server/loaders.ts';

interface Tree {
	files: Record<string, string>;
	cached?: string[];
}

function fakeSession(id: string, tree: Tree) {
	let readdirCalls = 0;
	const session: any = {
		id,
		name: `repo ${id}`,
		icon: null,
		isGuest: false,
		canWrite: true,
		writeMode: 'owner',
		peerCount: 2,
		tree,
		get readdirCalls() {
			return readdirCalls;
		},
		cache: {
			async entry(path: string) {
				return tree.cached?.includes(path) ?? false;
			}
		},
		drive: {
			async entry(path: string) {
				if (path in tree.files) return { value: { blob: Buffer.from(tree.files[path]) } };
				return null;
			},
			async *readdir(dir: string) {
				readdirCalls++;
				if ((tree as any).fail) throw new Error('peer gone');
				const prefix = dir === '/' ? '/' : dir + '/';
				const names = new Set<string>();
				for (const path of Object.keys(tree.files)) {
					if (!path.startsWith(prefix)) continue;
					names.add(path.slice(prefix.length).split('/')[0]);
				}
				for (const name of (tree as any).dirs ?? []) names.add(name);
				yield* names;
			}
		}
	};
	return session;
}

function fakeApp(sessions: any[]) {
	const map = new Map(sessions.map((s) => [s.id, s]));
	const updates: string[] = [];
	const app: any = {
		ready: async () => {},
		getSession: (id: string) => map.get(id) ?? null,
		listSessions: () => [...map.values()],
		updateSession: async (id: string) => {
			updates.push(id);
		},
		updates
	};
	return app;
}

test('a listing hides dotfiles, puts folders first and sorts by name', async () => {
	const session = fakeSession('list-1', {
		files: {
			'/b.txt': 'bbb',
			'/a.txt': 'a',
			'/nested/deep.txt': 'deep',
			'/.hidden': 'secret',
			'/.git/config': 'x'
		},
		cached: ['/nested', '/b.txt']
	});
	const app = fakeApp([session]);

	const { entries, fresh } = loadEntries(app, 'list-1', '/');
	assert.equal(fresh, null, 'a cold entry has nothing to revalidate');
	assert.deepEqual(
		(await entries).map((e) => [e.name, e.isFolder, e.size]),
		[
			['nested', true, null],
			['a.txt', false, 1],
			['b.txt', false, 3]
		]
	);

	const root = await loadEntries(app, 'list-1', '/').entries;
	assert.equal(root[0].name, 'nested');
	assert.equal(root[0].cached, true, 'a cached folder is shown as cached');
	assert.equal(root[1].cached, false);
	assert.equal(root[2].cached, true, 'a cached file is shown as cached');
});

test('a subdirectory listing only shows its own children', async () => {
	const session = fakeSession('list-2', {
		files: { '/docs/a.md': 'a', '/docs/sub/b.md': 'b', '/other.txt': 'x' }
	});
	const app = fakeApp([session]);

	assert.deepEqual(
		(await loadEntries(app, 'list-2', '/docs').entries).map((e) => e.name),
		['sub', 'a.md']
	);
});

test('a readdir failure yields an empty listing instead of an error page', async () => {
	const session = fakeSession('list-3', { files: {} });
	(session.tree as any).fail = true;
	const app = fakeApp([session]);

	assert.deepEqual(await loadEntries(app, 'list-3', '/').entries, []);
});

test('a listing is cached, then revalidated in the background once stale', async () => {
	const tree: Tree = { files: { '/a.txt': 'one' } };
	const session = fakeSession('list-4', tree);
	const app = fakeApp([session]);

	const first = await loadEntries(app, 'list-4', '/').entries;
	assert.deepEqual(
		first.map((e) => e.name),
		['a.txt']
	);

	tree.files['/b.txt'] = 'two';
	const cached = loadEntries(app, 'list-4', '/');
	assert.deepEqual(
		(await cached.entries).map((e) => e.name),
		['a.txt'],
		'inside the window the stale-but-cached list is served'
	);
	assert.equal(cached.fresh, null);
	assert.equal(session.readdirCalls, 1, 'the cache must not hit the drive again');

	// Pretend fifteen seconds passed: the old list is served while a fresh one loads.
	const realNow = Date.now;
	Date.now = () => realNow() + 20_000;
	try {
		const stale = loadEntries(app, 'list-4', '/');
		assert.deepEqual(
			(await stale.entries).map((e) => e.name),
			['a.txt'],
			'the stale list is returned immediately'
		);
		assert.ok(stale.fresh, 'and a fresh promise is handed back');
		assert.deepEqual(
			(await stale.fresh!).map((e) => e.name),
			['a.txt', 'b.txt']
		);
	} finally {
		Date.now = realNow;
	}

	const after = loadEntries(app, 'list-4', '/');
	assert.deepEqual(
		(await after.entries).map((e) => e.name),
		['a.txt', 'b.txt']
	);
});

test('invalidateEntries only drops the repo it was given', async () => {
	const one = fakeSession('list-5', { files: { '/a.txt': 'a' } });
	const two = fakeSession('list-6', { files: { '/b.txt': 'b' } });
	const app = fakeApp([one, two]);

	await loadEntries(app, 'list-5', '/').entries;
	await loadEntries(app, 'list-6', '/').entries;

	invalidateEntries('list-5');
	await loadEntries(app, 'list-6', '/').entries;
	assert.equal(two.readdirCalls, 1, 'another repo must keep its cache');

	await loadEntries(app, 'list-5', '/').entries;
	assert.equal(one.readdirCalls, 2, 'the invalidated repo is refetched');
});

test('getSession reports a missing repo as a 404, not a crash', async () => {
	const app = fakeApp([]);
	await assert.rejects(getSession(app, 'nope'), (err: any) => {
		assert.equal(err.status, 404);
		assert.match(err.body.message, /Drive not found/);
		return true;
	});
});

test('loadDrive reports write permission and refreshes the session quietly', async () => {
	const session = fakeSession('drive-1', { files: {} });
	const app = fakeApp([session]);

	const info = await loadDrive(app, 'drive-1');
	assert.deepEqual(
		{
			id: info.id,
			name: info.name,
			peers: info.peerCount,
			isGuest: info.isGuest,
			canWrite: info.canWrite,
			writeMode: info.writeMode
		},
		{
			id: 'drive-1',
			name: 'repo drive-1',
			peers: 2,
			isGuest: false,
			canWrite: true,
			writeMode: 'owner'
		}
	);
	assert.deepEqual(app.updates, ['drive-1'], 'the page view is what keeps the peer count fresh');
});

test('session icons become data URIs with the right mime type', async () => {
	const png = fakeSession('icon-png', { files: {} });
	png.icon = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
	const jpeg = fakeSession('icon-jpg', { files: {} });
	jpeg.icon = Buffer.from([0xff, 0xd8, 0xff]);
	const gif = fakeSession('icon-gif', { files: {} });
	gif.icon = Buffer.from([0x47, 0x49, 0x46]);
	const svg = fakeSession('icon-svg', { files: {} });
	svg.icon = Buffer.from('<svg/>');
	const none = fakeSession('icon-none', { files: {} });
	none.icon = Buffer.alloc(0);

	const list = await loadSessions(fakeApp([png, jpeg, gif, svg, none]) as any);
	const icon = (id: string) => list.find((s) => s.id === id)!.icon;

	assert.ok(icon('icon-png')!.startsWith('data:image/png;base64,'));
	assert.ok(icon('icon-jpg')!.startsWith('data:image/jpeg;base64,'));
	assert.ok(icon('icon-gif')!.startsWith('data:image/gif;base64,'));
	assert.ok(icon('icon-svg')!.startsWith('data:image/svg+xml;base64,'));
	assert.equal(icon('icon-none'), null, 'no icon renders as no image, not an empty <img>');
});
