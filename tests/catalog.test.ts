// Catalog and event modules: profiles, repo rows and the activity fan-out.
// The db here is a small stand-in for the hyperbee indices (each `find` filters
// on the same column the real schema keys the index by), so these tests check
// the logic in users.ts / repos.ts / events.ts, not the storage engine.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ensureDefaultProfile,
	getProfile,
	listProfiles,
	putProfile,
	resolveHandle,
	selfKeyHex
} from '../src/lib/server/users.ts';
import {
	getRepoMeta,
	listRepoMeta,
	listReposByOwner,
	registerRepo,
	updateRepo
} from '../src/lib/server/repos.ts';
import {
	emitActivity,
	listActivityByActor,
	listActivityByRepo,
	listNotifications
} from '../src/lib/server/events.ts';

type Row = Record<string, any>;

const INDEX: Record<string, { table: string; column: string }> = {
	'@ghostdrive/users-by-handle': { table: '@ghostdrive/users', column: 'handle' },
	'@ghostdrive/repos-by-owner': { table: '@ghostdrive/repos', column: 'ownerKey' },
	'@ghostdrive/activity-by-actor': { table: '@ghostdrive/activities', column: 'actorKey' },
	'@ghostdrive/activity-by-repo': { table: '@ghostdrive/activities', column: 'repoId' },
	'@ghostdrive/notification-by-to': { table: '@ghostdrive/notifications', column: 'toKey' },
	'@ghostdrive/watch-by-repo': { table: '@ghostdrive/watch-by-repo', column: 'repoId' }
};

const PRIMARY_KEY: Record<string, string> = {
	'@ghostdrive/users': 'peerKey',
	'@ghostdrive/repos': 'id'
};

function fakeApp(seed: Record<string, Row[]> = {}) {
	const tables = new Map<string, Row[]>();
	const flushes: number[] = [];

	const table = (name: string) => {
		if (!tables.has(name)) tables.set(name, []);
		return tables.get(name)!;
	};
	for (const [name, rows] of Object.entries(seed))
		table(name).push(...rows.map((row) => ({ ...row })));

	const db = {
		async get(collection: string, key: Row) {
			const pk = PRIMARY_KEY[collection] ?? 'id';
			return table(collection).find((row) => row[pk] === key[pk]) ?? null;
		},
		async insert(collection: string, row: Row) {
			const pk = PRIMARY_KEY[collection];
			if (pk) {
				const at = table(collection).findIndex((existing) => existing[pk] === row[pk]);
				if (at >= 0) table(collection)[at] = { ...row };
				else table(collection).push({ ...row });
				return;
			}
			table(collection).push({ ...row });
		},
		find(collection: string, range: { gte?: Row; lte?: Row }) {
			const index = INDEX[collection];
			if (!index) {
				// `find(table, {})` in the app means "every row"; anything keyed must
				// name the index it relies on.
				if (range.gte && Object.keys(range.gte).length > 0) {
					throw new Error(`test db: no index registered for ${collection}`);
				}
				return { toArray: async () => table(collection) };
			}
			const wanted = range.gte?.[index.column];
			const rows = table(index.table).filter(
				(row) => wanted === undefined || row[index.column] === wanted
			);
			return { toArray: async () => rows };
		},
		async flush() {
			flushes.push(Date.now());
		}
	};

	const app: any = {
		key: Buffer.alloc(32, 1),
		db,
		ready: async () => {},
		tables,
		flushes
	};
	return app;
}

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const KEY_C = 'cc'.repeat(32);

// --- users ----------------------------------------------------------------

test('selfKeyHex is the app key in hex', () => {
	assert.equal(selfKeyHex(fakeApp()), '01'.repeat(32));
});

test('putProfile fills the defaults for a brand-new peer', async () => {
	const app = fakeApp();
	const profile = await putProfile(app, { peerKey: KEY_A });

	assert.equal(profile.handle, KEY_A.slice(0, 8), 'a handle is derived, not guessed');
	assert.equal(profile.kind, 'user');
	assert.equal(profile.displayName, null);
	assert.equal(profile.bio, null);
	assert.equal(profile.avatar?.byteLength, 0);
	assert.ok(profile.joinedAt > 0);
	assert.equal(app.flushes.length, 1, 'a profile write must be durable before it replicates');
});

test('a partial patch keeps every field it did not mention', async () => {
	const app = fakeApp();
	const first = await putProfile(app, {
		peerKey: KEY_A,
		handle: 'ada',
		displayName: 'Ada',
		bio: 'builds things',
		avatar: Buffer.from([1, 2, 3]),
		kind: 'org'
	});

	const patched = await putProfile(app, { peerKey: KEY_A, bio: 'new bio' });

	assert.equal(patched.handle, 'ada');
	assert.equal(patched.displayName, 'Ada');
	assert.equal(patched.bio, 'new bio');
	assert.deepEqual([...patched.avatar!], [1, 2, 3]);
	assert.equal(patched.kind, 'org');
	assert.equal(patched.joinedAt, first.joinedAt, 'joining date must not move on an edit');
	assert.equal((await listProfiles(app)).length, 1, 'upsert, not append');
});

test('ensureDefaultProfile seeds once and leaves an existing profile alone', async () => {
	const app = fakeApp();
	await ensureDefaultProfile(app);
	await ensureDefaultProfile(app);
	assert.equal((await listProfiles(app)).length, 1);
	assert.equal((await getProfile(app, selfKeyHex(app)))!.handle, '01'.repeat(4));

	await putProfile(app, { peerKey: selfKeyHex(app), handle: 'chosen' });
	await ensureDefaultProfile(app);
	assert.equal((await getProfile(app, selfKeyHex(app)))!.handle, 'chosen');
});

test('resolveHandle is exact and returns null when nobody uses the handle', async () => {
	const app = fakeApp();
	await putProfile(app, { peerKey: KEY_A, handle: 'ada' });
	assert.equal((await resolveHandle(app, 'ada'))!.peerKey, KEY_A);
	assert.equal(await resolveHandle(app, 'ad'), null);
	assert.equal(await resolveHandle(app, 'ADA'), null, 'handles are case-sensitive today');
});

test('db-backed helpers refuse to run before the database exists', async () => {
	const app = fakeApp();
	app.db = undefined;
	await assert.rejects(getProfile(app, KEY_A), /not open yet/);
	await assert.rejects(putProfile(app, { peerKey: KEY_A }), /not open yet/);
});

// --- repos ----------------------------------------------------------------

test('registerRepo defaults to a public, one-way repo owned by this peer', async () => {
	const app = fakeApp();
	const session = { id: 'repo-1', name: 'notes' } as any;

	const rec = await registerRepo(app, session, {});

	assert.equal(rec.id, 'repo-1');
	assert.equal(rec.name, 'notes');
	assert.equal(rec.ownerKey, selfKeyHex(app));
	assert.equal(rec.visibility, 'public');
	assert.equal(rec.defaultBranch, 'main');
	assert.equal(rec.writeMode, 'owner', 'peers must not write unless the owner opted in');
	assert.equal(rec.description, null);
	assert.equal(rec.forkedFrom, null);
	assert.equal(rec.sourceKey, null);
	assert.equal(rec.topics, null);
	assert.ok(rec.createdAt > 0);
});

test('registerRepo honours explicit options, including the drive owner', async () => {
	const app = fakeApp();
	const rec = await registerRepo(app, { id: 'repo-2', name: 'mirror' } as any, {
		description: 'copied',
		visibility: 'private',
		defaultBranch: 'trunk',
		ownerKey: KEY_C,
		writeMode: 'peers'
	});

	assert.equal(rec.ownerKey, KEY_C, 'a mirror is not owned by the local key');
	assert.equal(rec.visibility, 'private');
	assert.equal(rec.defaultBranch, 'trunk');
	assert.equal(rec.writeMode, 'peers');
	assert.equal(rec.description, 'copied');
});

test('updateRepo patches the row, keeps the id and refuses to invent one', async () => {
	const app = fakeApp();
	await registerRepo(app, { id: 'repo-1', name: 'notes' } as any, {});

	const next = await updateRepo(app, 'repo-1', { id: 'hijacked', visibility: 'private' } as any);
	assert.equal(next!.id, 'repo-1', 'the id is the key and cannot be patched');
	assert.equal(next!.visibility, 'private');
	assert.equal(next!.name, 'notes');

	assert.equal(await updateRepo(app, 'missing', { name: 'x' }), null);
	assert.equal(await getRepoMeta(app, 'missing'), null);
});

test('repo listing and owner filtering read the rows that were written', async () => {
	const app = fakeApp();
	await registerRepo(app, { id: 'r1', name: 'one' } as any, { ownerKey: KEY_A });
	await registerRepo(app, { id: 'r2', name: 'two' } as any, { ownerKey: KEY_A });
	await registerRepo(app, { id: 'r3', name: 'three' } as any, { ownerKey: KEY_B });

	assert.deepEqual((await listRepoMeta(app)).map((r) => r.id).sort(), ['r1', 'r2', 'r3']);
	assert.deepEqual((await listReposByOwner(app, KEY_A)).map((r) => r.id).sort(), ['r1', 'r2']);
	assert.deepEqual(await listReposByOwner(app, KEY_C), []);
	assert.equal((await getRepoMeta(app, 'r2'))!.name, 'two');
});

// --- events ---------------------------------------------------------------

test('emitActivity records one row with the given fields and null defaults', async () => {
	const app = fakeApp();
	const before = Date.now();
	const activity = await emitActivity(app, { actorKey: KEY_A, type: 'push' });

	assert.match(activity.id, /^[0-9a-f]{16}$/);
	assert.equal(activity.actorKey, KEY_A);
	assert.equal(activity.repoId, null);
	assert.equal(activity.refId, null);
	assert.equal(activity.type, 'push');
	assert.ok(activity.ts >= before);
	assert.equal(app.tables.get('@ghostdrive/activities')!.length, 1);

	await emitActivity(app, { actorKey: KEY_A, repoId: 'r1', type: 'issue', refId: 'i1' });
	assert.equal((await listActivityByActor(app, KEY_A)).length, 2);
	assert.equal((await listActivityByRepo(app, 'r1')).length, 1);
});

test('watchers are notified, except the actor', async () => {
	const app = fakeApp({
		'@ghostdrive/watch-by-repo': [
			{ repoId: 'r1', byKey: KEY_B, level: 'all' },
			{ repoId: 'r1', byKey: KEY_C, level: 'all' },
			{ repoId: 'r2', byKey: KEY_A, level: 'all' }
		]
	});

	const activity = await emitActivity(app, { actorKey: KEY_B, repoId: 'r1', type: 'push' });
	const notes = app.tables.get('@ghostdrive/notifications')!;

	assert.equal(notes.length, 1, 'the actor must not be notified of their own action');
	assert.equal(notes[0].toKey, KEY_C);
	assert.equal(notes[0].activityId, activity.id);
	assert.equal(notes[0].read, false);
	assert.deepEqual(
		(await listNotifications(app, KEY_C)).map((n) => n.activityId),
		[activity.id]
	);
	assert.deepEqual(await listNotifications(app, KEY_B), []);
});

test('an activity with no repo does not fan out', async () => {
	const app = fakeApp({
		'@ghostdrive/watch-by-repo': [{ repoId: 'r1', byKey: KEY_B, level: 'all' }]
	});
	await emitActivity(app, { actorKey: KEY_A, type: 'follow' });
	assert.equal(app.tables.get('@ghostdrive/notifications')?.length ?? 0, 0);
});
