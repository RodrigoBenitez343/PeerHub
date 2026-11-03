// Local folder sync: pair bookkeeping and the one-way / two-way transfer rules.
// The folder is a real directory and Localdrive does the walking; only the
// shared drive is in memory, so these tests exercise the real engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import SessionSync from '../src/lib/server/sync.ts';
import type { SyncProgress } from '../src/lib/server/sync.ts';
import { DIGEST_SIZE_CAP, digestBytes } from '../src/lib/server/git.ts';
import { memoryDrive } from './helpers.ts';

async function* once(bytes: Buffer): AsyncGenerator<Buffer> {
	yield bytes;
}

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

const kept = (folder: string, name: string) => fs.existsSync(path.join(folder, name));

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
		onProgress: (ev) => {
			// The scan is the walk and the plan; this list is what moved.
			if (ev.kind === 'scan') return;
			progress.push(`${ev.kind} ${ev.path} ${ev.done}`);
		}
	});

	assert.deepEqual(summary, {
		added: 2,
		updated: 0,
		deleted: 0,
		conflicts: 0,
		skipped: 0,
		errors: [],
		changes: 0,
		source: 'listing'
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
			errors: [],
			changes: 0,
			source: 'log'
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

	await r.memory.drive.deleteShared('/a.txt');
	const summary = await sync.run(pair.id);
	assert.equal(summary.deleted, 1);
	assert.equal(summary.source, 'log', 'a logged delete is enough to reconcile');
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

test('a mirror deletes local files the repo does not have, and says so', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/kept.txt', Buffer.from('in the repo'));
	put(r.folder, 'kept.txt', 'in the repo');
	// What a folder copied from that project looks like: the repo deleted these.
	put(r.folder, 'gone.txt', 'was here last month');
	put(r.folder, 'src/old.ts', 'also gone');

	sync.setPrune(pair.id, true);
	const summary = await sync.run(pair.id);

	assert.equal(summary.deleted, 2, 'the repo does not have them, so a mirror drops them');
	assert.equal(summary.skipped, 0);
	assert.equal(kept(r.folder, 'gone.txt'), false);
	assert.equal(kept(r.folder, 'src/old.ts'), false);
	assert.equal(kept(r.folder, 'kept.txt'), true, 'repo content is never touched');

	const quiet = await sync.run(pair.id);
	assert.equal(quiet.deleted, 0, 'a mirrored folder is quiet once it matches');
});

test('a mirror still never deletes what the repo never had, when it is off', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	put(r.folder, '.gitignore', 'node_modules/\n');
	put(r.folder, 'mine.txt', 'draft');
	put(r.folder, 'node_modules/dep/index.js', 'huge');

	const summary = await sync.run(pair.id);

	assert.equal(summary.deleted, 0, 'the default never destroys local work');
	// The .gitignore itself is local work too; the ignored tree is not even a
	// candidate, so it can never be pruned either.
	assert.equal(summary.skipped, 2, 'the untracked files are reported, not removed');
	assert.equal(kept(r.folder, 'mine.txt'), true);
	assert.equal(kept(r.folder, 'node_modules/dep/index.js'), true);
	assert.equal(sync.list()[0].prune, false);
});

test('a mirror drops a local copy the repo deleted, edits included', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/a.txt', Buffer.from('hello'));
	put(r.folder, 'a.txt', 'hello');
	await sync.run(pair.id);

	// The folder edits it, the repo removes it: a mirror follows the repo.
	put(r.folder, 'a.txt', 'edited here');
	await r.memory.drive.deleteShared('/a.txt');
	sync.setPrune(pair.id, true);

	const summary = await sync.run(pair.id);
	assert.equal(summary.deleted, 1);
	assert.equal(kept(r.folder, 'a.txt'), false);
});

test('a two-way folder pushes its extras instead of pruning them', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	sync.setPrune(pair.id, true);
	put(r.folder, 'extra.txt', 'mine to keep');

	const summary = await sync.run(pair.id);
	assert.equal(summary.added, 1);
	assert.equal(summary.deleted, 0, 'pruning is a one-way idea');
	assert.equal(r.memory.files.get('/extra.txt')!.toString(), 'mine to keep');
});

test('adopting a folder is not a conflict, and identical files are not copied', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/same.txt', Buffer.from('same'));
	r.memory.setMtime('/same.txt', Date.now() - 60_000);
	r.memory.write('/older.txt', Buffer.from('repo version'));
	r.memory.setMtime('/older.txt', Date.now() - 60_000);
	put(r.folder, 'same.txt', 'same');
	put(r.folder, 'older.txt', 'a stale copy');
	r.memory.resetStats();

	const summary = await sync.run(pair.id);

	assert.equal(summary.conflicts, 0, 'nothing diverged: there was no base to diverge from');
	assert.equal(summary.updated, 1, 'only the file that really differs is copied');
	assert.equal(summary.added, 0);
	assert.equal(fs.readFileSync(path.join(r.folder, 'older.txt'), 'utf8'), 'repo version');
	assert.equal(r.memory.stats.putCalls, 0, 'a one-way folder never writes');

	// A real divergence found later is still a conflict.
	r.memory.write('/older.txt', Buffer.from('repo moved on'));
	put(r.folder, 'older.txt', 'local moved on');
	const next = await sync.run(pair.id);
	assert.equal(next.conflicts, 1, 'a recorded base makes a conflict a conflict');
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

test('a first pull reads every file once: the copy in flight is the state', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/a.txt', Buffer.from('hello'));
	r.memory.write('/docs/b.txt', Buffer.from('nested'));
	r.memory.resetStats();

	const summary = await sync.run(pair.id);

	assert.equal(summary.added, 2);
	assert.equal(
		r.memory.stats.readCalls,
		2,
		'one read per file, no digest pass over the same bytes'
	);
	assert.equal(r.memory.stats.bytesRead, 11, 'exactly the content, once');
	assert.equal(r.memory.stats.manifestCalls, 1, 'one listing per run, not one per consumer');
});

test('a push records the state from the bytes it sent, without reading them back', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	put(r.folder, 'notes.txt', 'v1');
	r.memory.resetStats();

	const summary = await sync.run(pair.id);

	assert.equal(summary.added, 1);
	assert.equal(
		r.memory.stats.readCalls,
		0,
		'an upload must not download the file again to hash it'
	);
	assert.equal(r.memory.stats.statCalls, 0, 'the upload reports its own stat');

	r.memory.resetStats();
	const again = await sync.run(pair.id);
	assert.equal(again.updated + again.added + again.deleted, 0);
	assert.equal(r.memory.stats.readCalls, 0);
});

test('a same-length edit on both sides is resolved instead of left diverged', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	r.memory.write('/same.txt', Buffer.from('repo v1'));
	r.memory.setMtime('/same.txt', Date.now() - 120_000);
	await sync.run(pair.id);

	// Both sides rewritten to the same length: the size check alone would call this
	// "our own copy with a fresher mtime" and keep two different versions.
	const file = path.join(r.folder, 'same.txt');
	fs.writeFileSync(file, 'local v2');
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(file, future, future);
	r.memory.write('/same.txt', Buffer.from('repos v2'));
	r.memory.setMtime('/same.txt', Date.now() - 60_000);

	const summary = await sync.run(pair.id);
	assert.equal(summary.conflicts, 1);
	assert.equal(summary.updated, 1, 'a same-length divergence must still be copied');
	assert.equal(r.memory.files.get('/same.txt')!.toString(), 'local v2', 'newest side wins');

	const quiet = await sync.run(pair.id);
	assert.equal(quiet.updated, 0, 'the resolved pair is quiet on the next run');
});

test('the repo hash decides, so a same-size same-mtime rewrite is still pulled', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	sync.setDirection(pair.id, 'two-way');
	put(r.folder, 'h.txt', 'one');
	await sync.run(pair.id);

	// The repo rewrites the file with content of the same length and puts the mtime
	// back: size and mtime say "unchanged", the content hash does not.
	const state = JSON.parse(
		fs.readFileSync(
			path.join(r.appDir, 'sessions', r.session.id, 'sync-state', `${pair.id}.json`),
			'utf8'
		)
	);
	const mtime = state.paths['/h.txt'].shared.mtime;
	await r.memory.drive.putShared('/h.txt', once(Buffer.from('two')), {
		hash: digestBytes(Buffer.from('two'))
	});
	r.memory.setMtime('/h.txt', mtime);

	const summary = await sync.run(pair.id);

	assert.equal(summary.updated, 1, 'the hash is what decides now');
	assert.equal(fs.readFileSync(path.join(r.folder, 'h.txt'), 'utf8'), 'two');
});

test('a synced folder works from the log: the repo is never listed again', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	await r.memory.drive.putShared('/a.txt', once(Buffer.from('one')), {
		hash: digestBytes(Buffer.from('one'))
	});

	const first = await sync.run(pair.id);
	assert.equal(first.source, 'listing', 'the first run has no cursor to offer');
	assert.equal(first.added, 1);

	// One write, no listing: the log names the path and the state says the rest.
	r.memory.resetStats();
	await r.memory.drive.putShared('/b.txt', once(Buffer.from('two')), {
		hash: digestBytes(Buffer.from('two'))
	});
	const second = await sync.run(pair.id);

	assert.equal(second.source, 'log');
	assert.equal(second.changes, 1, 'only the path that moved is reported');
	assert.equal(second.added, 1);
	assert.equal(r.memory.stats.manifestCalls, 0, 'a synced folder must not list the repo again');
	assert.equal(fs.readFileSync(path.join(r.folder, 'b.txt'), 'utf8'), 'two');

	// A file the log never mentions is not even looked at.
	r.memory.resetStats();
	const quiet = await sync.run(pair.id);
	assert.equal(quiet.source, 'log');
	assert.equal(quiet.changes, 0);
	assert.equal(r.memory.stats.statCalls, 0, 'nothing changed, so nothing is asked about');
});

test('a folder whose cursor fell off the log lists once and converges', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	await r.memory.drive.putShared('/a.txt', once(Buffer.from('one')), {
		hash: digestBytes(Buffer.from('one'))
	});
	await sync.run(pair.id);

	// The owner's log was trimmed (or lost) while this folder kept its cursor.
	r.memory.forgetLog();
	await r.memory.drive.putShared('/c.txt', once(Buffer.from('three')), {
		hash: digestBytes(Buffer.from('three'))
	});

	const summary = await sync.run(pair.id);
	assert.equal(summary.source, 'listing', 'a trimmed log means listing again');
	assert.equal(summary.added, 1);
	assert.equal(fs.readFileSync(path.join(r.folder, 'c.txt'), 'utf8'), 'three');
});

test('a failed copy keeps the cursor, so the same change is replayed', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	await r.memory.drive.putShared('/keep.txt', once(Buffer.from('keep')), {
		hash: digestBytes(Buffer.from('keep'))
	});
	await sync.run(pair.id);

	await r.memory.drive.putShared('/flaky.txt', once(Buffer.from('data')), {
		hash: digestBytes(Buffer.from('data'))
	});

	const real = r.memory.drive.readShared;
	(r.memory.drive as any).readShared = async function* () {
		throw new Error('offline');
	};

	const failed = await sync.run(pair.id);
	assert.equal(failed.added, 0);
	assert.equal(failed.errors.length, 1);
	assert.equal(failed.changes, 1, 'the entry was read and could not be applied');

	(r.memory.drive as any).readShared = real;
	const retried = await sync.run(pair.id);
	assert.equal(retried.source, 'log');
	assert.equal(retried.changes, 1, 'the cursor did not run ahead of the failure');
	assert.equal(retried.added, 1);
	assert.equal(fs.readFileSync(path.join(r.folder, 'flaky.txt'), 'utf8'), 'data');
});

test('a state file from before the log is read, not lost', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	await r.memory.drive.putShared('/a.txt', once(Buffer.from('one')), {
		hash: digestBytes(Buffer.from('one'))
	});
	await sync.run(pair.id);

	// The old shape kept the paths at the top level and had no cursor.
	const file = path.join(r.appDir, 'sessions', r.session.id, 'sync-state', `${pair.id}.json`);
	const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
	fs.writeFileSync(file, JSON.stringify(stored.paths));

	const summary = await sync.run(pair.id);
	assert.equal(summary.source, 'listing', 'no cursor means the repo is listed once');
	assert.equal(
		summary.added + summary.updated + summary.deleted,
		0,
		'but the paths it kept are still trusted'
	);
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cursor, 1, 'and a cursor is stored now');
});

test('a pull asks for the version the log named, so a replica can answer', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	await r.memory.drive.putShared('/a.txt', once(Buffer.from('hello')), {
		hash: digestBytes(Buffer.from('hello'))
	});
	r.memory.resetStats();

	await sync.run(pair.id);

	assert.equal(r.memory.stats.replicaReads, 1, 'the stamp travelled with the request');
});

test('a big file reports how far it got, not just that it started', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	const big = Buffer.alloc(3 * 1024 * 1024, 7);
	r.memory.write('/big.bin', big);

	const events: SyncProgress[] = [];
	const summary = await sync.run(pair.id, { onProgress: (ev) => events.push(ev) });

	assert.equal(summary.added, 1);
	const moves = events.filter((ev) => ev.kind !== 'scan');
	const [start] = moves;
	assert.equal(start.kind, 'download');
	assert.equal(start.size, big.byteLength, 'the handler knows the size before the bytes move');
	assert.equal(start.loaded, undefined, 'the first event starts the file');

	const ticks = moves.filter((ev) => ev.loaded !== undefined);
	assert.ok(ticks.length >= 2, 'a 3 MB file reports more than once');
	assert.equal(ticks.at(-1)!.loaded, big.byteLength, 'the last tick is the whole file');
	assert.equal(ticks.at(-1)!.done, 1, 'a tick does not count as another file');
});

test('the version stamp catches a big rewrite that keeps its size and mtime', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	// Above the hash cap: no digest on either side, which is exactly the case the
	// stamp has to cover.
	const big = Buffer.alloc(DIGEST_SIZE_CAP + 1024, 1);
	const at = Date.now() - 60_000;
	r.memory.write('/big.bin', big);
	r.memory.setMtime('/big.bin', at);
	await sync.run(pair.id);

	const other = Buffer.alloc(DIGEST_SIZE_CAP + 1024, 2);
	await r.memory.drive.putShared('/big.bin', once(other));
	r.memory.setMtime('/big.bin', at);

	const summary = await sync.run(pair.id);

	assert.equal(summary.updated, 1, 'size and mtime said nothing had changed');
	assert.equal(fs.readFileSync(path.join(r.folder, 'big.bin'))[0], 2);
});

test('a first run says what it faces before it copies anything', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/a.txt', Buffer.from('hello'));
	r.memory.write('/docs/b.txt', Buffer.from('nested'));

	const events: SyncProgress[] = [];
	await sync.run(pair.id, { onProgress: (ev) => events.push(ev) });

	const plan = events[0];
	assert.equal(plan.kind, 'scan', 'the plan comes first');
	assert.equal(plan.total, 2, 'both files are named before the first copy');
	assert.equal(plan.totalBytes, 11, 'and so is what they add up to');

	const moves = events.filter((ev) => ev.kind !== 'scan');
	assert.equal(moves.length, 2);
	assert.ok(
		moves.every((ev) => ev.total === 2),
		'every move is counted against the same plan'
	);
	assert.ok(
		moves.every((ev) => ev.done >= 1 && ev.done <= 2),
		'the count never runs past the plan'
	);
});

test('a run with nothing to do still reports its plan', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	r.memory.write('/a.txt', Buffer.from('hello'));
	await sync.run(pair.id);

	const events: SyncProgress[] = [];
	const summary = await sync.run(pair.id, { onProgress: (ev) => events.push(ev) });

	assert.equal(summary.source, 'log');
	assert.deepEqual(
		events.map((ev) => [ev.kind, ev.total, ev.done]),
		[['scan', 1, 0]],
		'one file examined, nothing moved'
	);
});

test('the walk of a big folder reports as it goes', async () => {
	const r = rig();
	const sync = await open(r);
	const pair = sync.add(r.folder);
	for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(r.folder, `f${i}.txt`), 'x');

	const events: SyncProgress[] = [];
	const summary = await sync.run(pair.id, { onProgress: (ev) => events.push(ev) });

	const walk = events.filter((ev) => ev.kind === 'scan' && ev.total === undefined);
	assert.ok(walk.length >= 1, 'a long walk is not silent');
	assert.ok(walk.at(-1)!.scanned! >= 250, 'and it counts the files it has seen');
	assert.equal(summary.skipped, 260, 'a one-way folder keeps its own files local');
});

test.after(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});
