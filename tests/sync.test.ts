// Local folder sync: pair bookkeeping and the one-way / two-way transfer rules.
// The folder is a real directory and Localdrive does the walking; only the
// shared drive is in memory, so these tests exercise the real engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import SessionSync from '../src/lib/server/sync.ts';
import { memoryDrive } from './helpers.ts';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-sync-'));
let seq = 0;

function rig(opts: { connected?: boolean; canWrite?: boolean; isGuest?: boolean } = {}) {
	const root = path.join(sandbox, `r${++seq}`);
	const appDir = path.join(root, 'app');
	const folder = path.join(root, 'folder');
	fs.mkdirSync(appDir, { recursive: true });
	fs.mkdirSync(folder, { recursive: true });

	const memory = memoryDrive(`sync-${seq}`);
	memory.session.app = { dir: appDir, key: Buffer.alloc(32, 3) };
	memory.session.isGuest = opts.isGuest ?? false;
	memory.session.drive.connected = opts.connected ?? true;
	memory.session.drive.canWrite = opts.canWrite ?? true;

	return { root, appDir, folder, memory, session: memory.session };
}

async function open(r: ReturnType<typeof rig>) {
	const sync = new SessionSync(r.session);
	await sync.ready();
	return sync;
}

const configPath = (r: ReturnType<typeof rig>) =>
	path.join(r.appDir, 'sessions', r.session.id, 'sync-pairs.json');

const put = (folder: string, name: string, text: string) => {
	const file = path.join(folder, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
};

test('add validates the path and the storage boundary', async () => {
	const r = rig();
	const sync = await open(r);

	assert.throws(() => sync.add(''), /Folder path required/);
	assert.throws(() => sync.add('   '), /Folder path required/);
	assert.throws(() => sync.add(path.join(r.root, 'missing')), /Folder not found/);

	const file = put(r.root, 'plain.txt', 'x');
	assert.throws(() => sync.add(file), /Pick a folder, not a file/);

	const inner = path.join(r.appDir, 'inner');
	fs.mkdirSync(inner);
	assert.throws(() => sync.add(inner), /outside PeerHub storage/);
	assert.throws(
		() => sync.add(r.root),
		/outside PeerHub storage/,
		'the parent of the app dir is not allowed either'
	);
});

test('a new pair is one-way, not automatic, and persists across a restart', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);

	assert.equal(pair.direction, 'pull', 'two-way must be an explicit choice');
	assert.equal(pair.auto, false);
	assert.equal(pair.running, false);
	assert.equal(pair.lastSyncAt, null);

	const stored = JSON.parse(fs.readFileSync(configPath(r), 'utf8'));
	assert.equal(stored.pairs.length, 1);
	assert.equal(stored.pairs[0].path, pair.path);

	const reopened = await open(r);
	assert.deepEqual(
		reopened.list().map((p) => p.id),
		[pair.id]
	);
	assert.throws(() => sync.add(r.folder), /already being synced/);
});

test('pairs written before directions existed load as one-way', async () => {
	const r = rig();
	fs.mkdirSync(path.dirname(configPath(r)), { recursive: true });
	fs.writeFileSync(
		configPath(r),
		JSON.stringify({ pairs: [{ id: 'old', path: r.folder, auto: true }] })
	);

	const sync = await open(r);
	const [pair] = sync.list();
	assert.equal(pair.id, 'old');
	assert.equal(
		pair.direction,
		'pull',
		'the old default was two-way; a missing field must not stay two-way'
	);
	assert.equal(pair.auto, true);
	assert.equal(pair.lastSyncAt, null);
});

test('a corrupt config is treated as no pairs instead of crashing boot', async () => {
	const r = rig();
	fs.mkdirSync(path.dirname(configPath(r)), { recursive: true });
	fs.writeFileSync(configPath(r), 'not json');

	const sync = await open(r);
	assert.deepEqual(sync.list(), []);
	assert.doesNotThrow(() => sync.add(r.folder));
});

test('setAuto and setDirection update the stored pair', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);

	sync.setAuto(pair.id, true, true, 'two-way');
	assert.deepEqual(
		{
			auto: sync.list()[0].auto,
			autoCommit: sync.list()[0].autoCommit,
			direction: sync.list()[0].direction
		},
		{ auto: true, autoCommit: true, direction: 'two-way' }
	);

	sync.setAuto(pair.id, false);
	assert.equal(sync.list()[0].autoCommit, false, 'auto-commit cannot survive turning auto off');

	sync.setDirection(pair.id, 'sideways' as any);
	assert.equal(sync.list()[0].direction, 'pull', 'an unknown direction falls back to the safe one');

	assert.throws(() => sync.setAuto('nope', true), /not found/);
	assert.throws(() => sync.setDirection('nope', 'pull'), /not found/);
	sync.remove('nope');
});

test('remove drops the pair and its state file', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	const state = path.join(r.appDir, 'sessions', r.session.id, 'sync-state', `${pair.id}.json`);
	fs.mkdirSync(path.dirname(state), { recursive: true });
	fs.writeFileSync(state, '{}');

	sync.remove(pair.id);
	assert.deepEqual(sync.list(), []);
	assert.equal(fs.existsSync(state), false);
	assert.deepEqual(JSON.parse(fs.readFileSync(configPath(r), 'utf8')).pairs, []);
});

test('run refuses an unknown folder, an offline host and a vanished folder', async () => {
	const r = rig();
	const sync = await open(r);
	await assert.rejects(sync.run('nope'), /not found/);

	const pair = sync.add(r.folder);
	r.memory.session.drive.connected = false;
	await assert.rejects(sync.run(pair.id), /Not connected to the host/);
	assert.match(sync.list()[0].lastResult!, /^error: Not connected/);

	r.memory.session.drive.connected = true;
	fs.rmSync(r.folder, { recursive: true, force: true });
	await assert.rejects(sync.run(pair.id), /Folder is gone/);
});

test('a one-way peer cannot ask for two-way silently', async () => {
	const guest = rig({ canWrite: false, isGuest: true });
	const sync = await open(guest);
	const pair = sync.add(guest.folder);
	await assert.rejects(
		sync.run(pair.id, { direction: 'two-way' }),
		/owner has not enabled peer writes/
	);

	const owner = rig({ canWrite: false, isGuest: false });
	const ownerSync = await open(owner);
	const ownerPair = ownerSync.add(owner.folder);
	await assert.rejects(ownerSync.run(ownerPair.id, { direction: 'two-way' }), /reconnect/);
});

test('a pull copies the repo into an empty folder and then goes quiet', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/a.txt', Buffer.from('hello'));
	r.memory.write('/docs/b.txt', Buffer.from('nested'));

	const progress: string[] = [];
	const summary = await sync.run(pair.id, {
		onProgress: (ev) => progress.push(`${ev.kind} ${ev.path} ${ev.done}`)
	});

	assert.deepEqual(summary, {
		added: 2,
		updated: 0,
		deleted: 0,
		conflicts: 0,
		skipped: 0,
		errors: []
	});
	assert.equal(fs.readFileSync(path.join(r.folder, 'a.txt'), 'utf8'), 'hello');
	assert.equal(fs.readFileSync(path.join(r.folder, 'docs', 'b.txt'), 'utf8'), 'nested');
	assert.deepEqual(progress.sort(), ['download /a.txt 1', 'download /docs/b.txt 2']);
	assert.ok(sync.list()[0].lastSyncAt! > 0);
	assert.equal(sync.list()[0].lastResult, '2 added, 0 updated, 0 deleted');

	const again = await sync.run(pair.id);
	assert.deepEqual(
		again,
		{
			added: 0,
			updated: 0,
			deleted: 0,
			conflicts: 0,
			skipped: 0,
			errors: []
		},
		'a second run must not re-copy unchanged files'
	);
});

test('a repo deletion reaches the folder, and /.peerhub never does', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/a.txt', Buffer.from('hello'));
	r.memory.write('/.peerhub/history/main/x', Buffer.from('internal'));
	await sync.run(pair.id);

	assert.equal(
		fs.existsSync(path.join(r.folder, '.peerhub')),
		false,
		'history is not repo content'
	);
	assert.equal(fs.existsSync(path.join(r.folder, 'a.txt')), true);

	r.memory.files.delete('/a.txt');
	const summary = await sync.run(pair.id);
	assert.equal(summary.deleted, 1);
	assert.equal(
		fs.existsSync(path.join(r.folder, 'a.txt')),
		false,
		'a one-way folder mirrors repo deletions'
	);
});

test('one-way keeps local edits local and counts them as skipped', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	put(r.folder, 'local.txt', 'mine');

	const summary = await sync.run(pair.id);
	assert.equal(summary.skipped, 1);
	assert.equal(summary.added, 0);
	assert.equal(r.memory.files.has('/local.txt'), false, 'a one-way folder must never push');
});

test('two-way uploads, updates and deletes', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');

	const file = put(r.folder, 'notes.txt', 'v1');
	const added = await sync.run(pair.id);
	assert.equal(added.added, 1);
	assert.equal(r.memory.files.get('/notes.txt')!.toString(), 'v1');

	fs.writeFileSync(file, 'v2');
	const future = new Date(Date.now() + 10_000);
	fs.utimesSync(file, future, future);
	const updated = await sync.run(pair.id);
	assert.equal(updated.updated, 1);
	assert.equal(r.memory.files.get('/notes.txt')!.toString(), 'v2');

	fs.rmSync(file);
	const deleted = await sync.run(pair.id);
	assert.equal(deleted.deleted, 1);
	assert.equal(r.memory.files.has('/notes.txt'), false);
});

test('ignored local files never reach the repo, even in two-way', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	put(r.folder, '.gitignore', 'node_modules/\n*.log\n');
	put(r.folder, 'node_modules/dep/index.js', 'huge');
	put(r.folder, 'debug.log', 'noise');
	put(r.folder, 'keep.txt', 'content');

	const summary = await sync.run(pair.id);

	assert.equal(r.memory.files.has('/node_modules/dep/index.js'), false);
	assert.equal(r.memory.files.has('/debug.log'), false);
	assert.equal(r.memory.files.get('/keep.txt')!.toString(), 'content');
	assert.equal(summary.added, 2, 'the .gitignore itself and keep.txt');
});

test('system noise files are skipped without a rule', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	put(r.folder, '.DS_Store', 'x');
	put(r.folder, 'Thumbs.db', 'x');
	put(r.folder, 'half.localdrive.tmp', 'x');

	const summary = await sync.run(pair.id);
	assert.equal(summary.added, 0);
	assert.deepEqual([...r.memory.files.keys()], []);
});

test('a same-size edit made right after a sync is still pushed', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	const file = put(r.folder, 'edit.txt', 'hello');

	await sync.run(pair.id);
	assert.equal(r.memory.files.get('/edit.txt')!.toString(), 'hello');

	// Same byte length, mtime only milliseconds newer: the size+mtime slack alone
	// treats this as unchanged, so the engine has to compare content.
	fs.writeFileSync(file, 'jello');
	const summary = await sync.run(pair.id);

	assert.equal(summary.updated, 1, 'a fast same-size edit must not be invisible');
	assert.equal(r.memory.files.get('/edit.txt')!.toString(), 'jello');
});

test('a two-way conflict goes to the newer side only', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	r.memory.write('/conflict.txt', Buffer.from('repo v1'));
	r.memory.setMtime('/conflict.txt', Date.now() - 120_000);
	await sync.run(pair.id);

	// Local is newer and bigger: it wins.
	const file = path.join(r.folder, 'conflict.txt');
	fs.writeFileSync(file, 'local wins (newer)');
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(file, future, future);
	r.memory.write('/conflict.txt', Buffer.from('repo v2, longer'));
	r.memory.setMtime('/conflict.txt', Date.now() - 60_000);

	const push = await sync.run(pair.id);
	assert.equal(push.conflicts, 1);
	assert.equal(push.updated, 1);
	assert.equal(r.memory.files.get('/conflict.txt')!.toString(), 'local wins (newer)');

	// Local is now older and a different size: the repo wins.
	fs.writeFileSync(file, 'local lost');
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(file, past, past);
	r.memory.write('/conflict.txt', Buffer.from('repo v3 wins now and more'));
	r.memory.setMtime('/conflict.txt', Date.now());

	const pull = await sync.run(pair.id);
	assert.equal(pull.conflicts, 1);
	assert.equal(pull.updated, 1);
	assert.equal(fs.readFileSync(file, 'utf8'), 'repo v3 wins now and more');
});

test.after(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});
