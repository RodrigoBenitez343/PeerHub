// Cloning: where a folder comes from now. The identity check decides whether a
// full folder may be replaced, and a clone is set up so a repo deletion lands
// without anyone configuring anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import SessionSync from '../src/lib/server/sync.ts';
import { cloneRepo, cloneTarget } from '../src/lib/server/clone.ts';
import { memoryDrive } from './helpers.ts';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-clone-'));
let seq = 0;

type Rig = {
	appDir: string;
	folder: string;
	memory: ReturnType<typeof memoryDrive>;
	sync: SessionSync;
	session: any;
	app: any;
	cloneAndPull: () => Promise<Awaited<ReturnType<typeof cloneRepo>>>;
};

async function rig(name = 'Arrow'): Promise<Rig> {
	const root = path.join(sandbox, `r${++seq}`);
	const appDir = path.join(root, 'app');
	// Two levels deep, so a folder that *contains* a clone can be tested without
	// also being the parent of PeerHub's own storage.
	const folder = path.join(root, 'clones', 'arrow');
	fs.mkdirSync(appDir, { recursive: true });

	const memory = memoryDrive(`clone-${seq}`);
	memory.session.app = { dir: appDir, key: Buffer.alloc(32, 3) };
	const sync = new SessionSync(memory.session);
	await sync.ready();

	const session = Object.assign(memory.session, {
		name,
		listSyncPairs: () => sync.list(),
		addSyncPair: async (target: string) => sync.add(target),
		removeSyncPair: async (id: string) => sync.remove(id),
		setSyncDirection: async (id: string, d: any) => sync.setDirection(id, d),
		setSyncPrune: async (id: string, v: boolean) => sync.setPrune(id, v),
		setSyncAuto: async (id: string, v: boolean) => sync.setAuto(id, v),
		runSync: async (id: string, o: any) => sync.run(id, o)
	});

	const app = { dir: appDir, sessions: new Map([[session.id, session]]) };
	return {
		appDir,
		folder,
		memory,
		sync,
		session,
		app,
		cloneAndPull: () => cloneRepo(session, folder, {})
	};
}

function put(folder: string, name: string, text: string) {
	const file = path.join(folder, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

test('a missing or empty folder needs no confirmation', async () => {
	const r = await rig();

	const missing = cloneTarget(r.app, r.session.id, r.folder);
	assert.equal(missing.state, 'new');
	assert.equal(missing.needsConfirm, false);

	fs.mkdirSync(r.folder, { recursive: true });
	const empty = cloneTarget(r.app, r.session.id, r.folder);
	assert.equal(empty.state, 'empty');
	assert.equal(empty.needsConfirm, false);
});

test('a folder with content asks first, and counts what is there', async () => {
	const r = await rig();
	put(r.folder, 'notes.txt', 'mine');
	put(r.folder, 'src/app.ts', 'x');

	const target = cloneTarget(r.app, r.session.id, r.folder);
	assert.equal(target.state, 'foreign');
	assert.equal(target.files, 2);
	assert.equal(target.needsConfirm, true, 'cloning would replace files nobody asked to replace');
});

test('the same repo in the same folder replaces without asking', async () => {
	const r = await rig();
	r.memory.write('/a.txt', Buffer.from('hello'));
	await r.cloneAndPull();

	const again = cloneTarget(r.app, r.session.id, r.folder);
	assert.equal(again.state, 'this-repo');
	assert.equal(again.files, 1);
	assert.equal(again.needsConfirm, false, 'same identity: these files are the repo’s own');
});

test('another repo in the same folder asks first and names it', async () => {
	const r = await rig('Arrow');
	r.memory.write('/a.txt', Buffer.from('hello'));
	await r.cloneAndPull();

	const other = {
		dir: r.appDir,
		sessions: new Map([[r.session.id, r.session]])
	};
	const target = cloneTarget(other as any, 'a-different-repo', r.folder);
	assert.equal(target.state, 'other-repo');
	assert.equal(target.owner?.name, 'Arrow');
	assert.equal(target.files, 1);
	assert.equal(target.needsConfirm, true, 'another repo’s files are not ours to replace');
});

test('a clone inside or around another clone is refused', async () => {
	const r = await rig();
	await r.cloneAndPull();

	assert.throws(
		() => cloneTarget(r.app, r.session.id, path.join(r.folder, 'inner')),
		/inside the clone/
	);
	assert.throws(
		() => cloneTarget(r.app, r.session.id, path.dirname(r.folder)),
		/already contains the clone/
	);
});

test('the storage boundary and files are refused', async () => {
	const r = await rig();
	assert.throws(
		() => cloneTarget(r.app, r.session.id, path.join(r.appDir, 'inner')),
		/outside PeerHub storage/
	);
	assert.throws(
		() => cloneTarget(r.app, r.session.id, path.dirname(r.appDir)),
		/outside PeerHub storage/,
		'the folder that holds PeerHub’s data is not a clone target'
	);
	assert.throws(() => cloneTarget(r.app, r.session.id, '  '), /Choose where to clone/);

	put(r.folder, 'file.txt', 'x');
	assert.throws(
		() => cloneTarget(r.app, r.session.id, path.join(r.folder, 'file.txt')),
		/Pick a folder/
	);
});

test('a clone is one-way, mirrors, and keeps itself up to date', async () => {
	const r = await rig();
	r.memory.write('/a.txt', Buffer.from('hello'));
	r.memory.write('/docs/b.txt', Buffer.from('nested'));

	const result = await cloneRepo(r.session, path.join(r.folder, 'arrow'), {});

	assert.equal(result.summary.added, 2, 'the first sync is a full pull');
	assert.equal(result.summary.conflicts, 0, 'an empty folder cannot conflict with anything');
	assert.equal(result.summary.source, 'listing');

	const [pair] = r.sync.list();
	assert.equal(pair.direction, 'pull');
	assert.equal(pair.prune, true, 'a clone mirrors: repo deletions delete');
	assert.equal(pair.auto, true, 'the owner’s next pass lands on its own');
	assert.equal(fs.readFileSync(path.join(result.path, 'a.txt'), 'utf8'), 'hello');
	assert.equal(fs.readFileSync(path.join(result.path, 'docs/b.txt'), 'utf8'), 'nested');
});

test('cloning into the same folder again resyncs instead of failing', async () => {
	const r = await rig();
	r.memory.write('/a.txt', Buffer.from('hello'));
	await r.cloneAndPull();

	// The user keeps their direction: a second clone must not quietly undo it.
	r.sync.setDirection(r.sync.list()[0].id, 'two-way');
	r.memory.write('/b.txt', Buffer.from('later'));

	const again = await r.cloneAndPull();
	assert.equal(r.sync.list().length, 1, 'one folder is one clone');
	assert.equal(again.summary.added, 1);
	assert.equal(r.sync.list()[0].direction, 'two-way');
	assert.equal(fs.readFileSync(path.join(r.folder, 'b.txt'), 'utf8'), 'later');
});

test('a repo deletion lands in the clone, and an extra file is removed', async () => {
	const r = await rig();
	r.memory.write('/a.txt', Buffer.from('hello'));
	r.memory.write('/b.txt', Buffer.from('bye'));
	const result = await cloneRepo(r.session, r.folder, {});
	const [pair] = r.sync.list();

	// The owner deletes one file and edits another.
	await r.memory.drive.deleteShared('/b.txt');
	r.memory.write('/a.txt', Buffer.from('hello, again'));

	// And a file appears in the clone that the repo never had.
	put(r.folder, 'scratch.txt', 'local');

	const next = await r.sync.run(pair.id);
	assert.equal(next.deleted, 2, 'the repo deletion and the local extra both go');
	assert.equal(next.updated, 1);
	assert.equal(fs.existsSync(path.join(r.folder, 'b.txt')), false);
	assert.equal(fs.existsSync(path.join(r.folder, 'scratch.txt')), false);
	assert.equal(fs.readFileSync(path.join(r.folder, 'a.txt'), 'utf8'), 'hello, again');
	assert.equal(result.pair.path, path.resolve(r.folder));
});
