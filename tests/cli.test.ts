// The CLI surface: repo location, status, commit, log/show and restore. These
// are what `bin/peerhub.mjs` calls, so a regression here is a broken terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import SessionSync from '../src/lib/server/sync.ts';
import {
	commitWorkingTree,
	locateRepo,
	log,
	restore,
	setAuto,
	setDirection,
	show,
	status,
	syncNow
} from '../src/lib/server/cli.ts';
import { metaSession } from './helpers.ts';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-cli-'));
let seq = 0;

async function rig() {
	const n = ++seq;
	const root = path.join(sandbox, `r${n}`);
	const appDir = path.join(root, 'app');
	const folder = path.join(root, 'repo');
	fs.mkdirSync(appDir, { recursive: true });
	fs.mkdirSync(folder, { recursive: true });

	const base = metaSession();
	const session: any = base;
	session.id = `cli-${n}`;
	session.name = `cli-${n}`;
	session.canWrite = true;
	session.isGuest = false;
	session.app.dir = appDir;
	session.app.ready = async () => {};

	const sync = new SessionSync(session);
	await sync.ready();
	session.listSyncPairs = () => sync.list();
	session.runSync = (id: string, opts: any) => sync.run(id, opts);
	session.setSyncDirection = (id: string, direction: any) => sync.setDirection(id, direction);
	session.setSyncAuto = (id: string, auto: boolean, autoCommit?: boolean, direction?: any) =>
		sync.setAuto(id, auto, autoCommit, direction);
	session.app.sessions.set(session.id, session);

	const pair = sync.add(folder);
	return { root, appDir, folder, memory: base.memory, session, app: session.app, sync, pair };
}

const write = (folder: string, name: string, text: string) => {
	const file = path.join(folder, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
};

test('locateRepo finds the linked folder from a subdirectory and prefers the longest match', async () => {
	const a = await rig();
	fs.mkdirSync(path.join(a.folder, 'docs'));

	const found = await locateRepo(a.app, path.join(a.folder, 'docs'));
	assert.equal(found.session.id, a.session.id);
	assert.equal(found.pair.path, a.pair.path);

	// A second repo linked to a subfolder of the first one wins for paths below it.
	const nested = path.join(a.folder, 'docs');
	const second = metaSession();
	const session2: any = second;
	session2.id = 'cli-nested';
	Object.assign(session2.app, { dir: a.appDir, ready: async () => {} });
	const sync2 = new SessionSync(session2);
	await sync2.ready();
	session2.listSyncPairs = () => sync2.list();
	const pair2 = sync2.add(nested);
	a.app.sessions.set('cli-nested', session2);

	const deep = await locateRepo(a.app, path.join(nested, 'x'));
	assert.equal(deep.pair.path, pair2.path, 'the deepest linked folder owns the file');
});

test('locateRepo explains where to run the CLI when nothing is linked', async () => {
	const r = await rig();
	const outside = path.join(r.root, 'elsewhere');
	fs.mkdirSync(outside);

	await assert.rejects(locateRepo(r.app, outside), (err: any) => {
		assert.match(err.message, /No repository is linked/);
		assert.match(err.message, /peerhub create/);
		assert.match(err.message, new RegExp(r.session.name), 'the error lists the linked repos');
		return true;
	});
});

test('status before the first commit shows untracked files and respects ignores', async () => {
	const r = await rig();
	write(r.folder, 'a.txt', 'one');
	write(r.folder, '.gitignore', '*.log\nnode_modules/\n');
	write(r.folder, 'debug.log', 'noise');
	write(r.folder, 'node_modules/dep/index.js', 'huge');

	const report = await status(r.app, r.folder);

	assert.equal(report.head, null);
	assert.equal(report.clean, false);
	assert.deepEqual(report.untracked, ['/.gitignore', '/a.txt']);
	assert.deepEqual(
		report.changes.map((c) => c.path),
		['/.gitignore', '/a.txt']
	);
	assert.equal(report.direction, 'pull');
	assert.equal(report.canPush, true);
	assert.equal(report.repo.id, r.session.id);
});

test('commit pushes the working tree, records a changelist and then reports clean', async () => {
	const r = await rig();
	write(r.folder, 'a.txt', 'one');
	write(r.folder, '.gitignore', '*.log\n');
	write(r.folder, 'debug.log', 'noise');

	await assert.rejects(commitWorkingTree(r.app, r.folder, '  '), /message required/i);

	const result = await commitWorkingTree(r.app, r.folder, 'first commit');

	assert.match(result.sha, /^[0-9a-f]{64}$/);
	assert.equal(result.short, result.sha.slice(0, 7));
	assert.equal(result.message, 'first commit');
	assert.deepEqual(result.changes, [
		{ path: '/.gitignore', status: 'added' },
		{ path: '/a.txt', status: 'added' }
	]);
	assert.equal(result.sync!.added, 2, 'commit is an explicit push');
	assert.equal(r.memory.files.get('/a.txt')!.toString(), 'one');
	assert.equal(r.memory.files.has('/debug.log'), false, 'ignored files are not committed');

	const after = await status(r.app, r.folder);
	assert.equal(after.clean, true, `pending: ${JSON.stringify(after.changes)}`);
	assert.equal(after.head!.sha, result.sha);

	write(r.folder, 'a.txt', 'two');
	const dirty = await status(r.app, r.folder);
	assert.deepEqual(dirty.changes, [{ path: '/a.txt', status: 'modified' }]);
});

test('log, show by full and short sha, and the ambiguous case', async () => {
	const r = await rig();
	write(r.folder, 'a.txt', 'one');
	const first = await commitWorkingTree(r.app, r.folder, 'first');
	write(r.folder, 'a.txt', 'two, longer');
	const second = await commitWorkingTree(r.app, r.folder, 'second');

	const entries = await log(r.app, r.folder);
	assert.deepEqual(
		entries.map((e) => e.message),
		['second', 'first']
	);
	assert.equal(entries[0].sha, second.sha);
	assert.equal(entries[0].author.length, 8);
	assert.deepEqual(entries[0].changes, [{ path: '/a.txt', status: 'modified' }]);

	const byFull = await show(r.app, r.folder, second.sha);
	assert.equal(byFull.message, 'second');
	const byShort = await show(r.app, r.folder, second.sha.slice(0, 7));
	assert.equal(byShort.sha, second.sha);
	assert.equal(byShort.parent, first.short);
	assert.equal((await log(r.app, r.folder, 1)).length, 1, 'the limit must be honoured');

	await assert.rejects(show(r.app, r.folder, 'ffffffff'), /No commit matches/);
	// An empty prefix matches every commit, which is exactly the ambiguous case.
	await assert.rejects(show(r.app, r.folder, ''), /Ambiguous sha.*2 commits match/);
});

test('restore: dry run, single path and whole tree', async () => {
	const r = await rig();
	write(r.folder, 'a.txt', 'v1');
	write(r.folder, 'keep.txt', 'keep');
	const first = await commitWorkingTree(r.app, r.folder, 'first');

	write(r.folder, 'a.txt', 'v2 changed');
	write(r.folder, 'later.txt', 'added later');
	const second = await commitWorkingTree(r.app, r.folder, 'second');

	const plan = await restore(r.app, r.folder, first.sha, ['/a.txt'], { dryRun: true });
	assert.deepEqual(plan.actions, [{ path: '/a.txt', action: 'restored' }]);
	assert.equal(
		fs.readFileSync(path.join(r.folder, 'a.txt'), 'utf8'),
		'v2 changed',
		'a dry run changes nothing'
	);

	const one = await restore(r.app, r.folder, first.sha, ['/a.txt']);
	assert.equal(one.dryRun, false);
	assert.deepEqual(
		one.actions.map((a) => a.action),
		['restored']
	);
	assert.equal(fs.readFileSync(path.join(r.folder, 'a.txt'), 'utf8'), 'v1');
	assert.equal(
		fs.existsSync(path.join(r.folder, 'later.txt')),
		true,
		'a path restore keeps everything else'
	);

	const tree = await restore(r.app, r.folder, first.sha);
	assert.ok(
		tree.actions.some((a) => a.path === '/later.txt' && a.action === 'deleted'),
		JSON.stringify(tree.actions)
	);
	assert.equal(
		fs.existsSync(path.join(r.folder, 'later.txt')),
		false,
		'a tree restore matches the commit'
	);
	assert.equal(fs.readFileSync(path.join(r.folder, 'keep.txt'), 'utf8'), 'keep');

	await assert.rejects(restore(r.app, r.folder, 'f'.repeat(64)), /No commit matches/);
});

test('syncNow, setDirection and setAuto follow the folder settings', async () => {
	const r = await rig();
	write(r.folder, 'local.txt', 'mine');

	const oneWay = await syncNow(r.app, r.folder);
	assert.equal(oneWay.skipped, 1);
	assert.equal(r.memory.files.has('/local.txt'), false);

	const pushed = await syncNow(r.app, r.folder, { push: true });
	assert.equal(pushed.added, 1);
	assert.equal(r.memory.files.get('/local.txt')!.toString(), 'mine');

	assert.deepEqual(await setDirection(r.app, r.folder, 'two-way'), {
		direction: 'two-way',
		pair: r.folder
	});
	assert.equal(r.session.listSyncPairs()[0].direction, 'two-way');

	const auto = await setAuto(r.app, r.folder, 'on', { commit: true });
	assert.deepEqual(
		{ auto: auto.auto, autoCommit: auto.autoCommit, direction: auto.direction },
		{ auto: true, autoCommit: true, direction: 'two-way' },
		'auto-commit implies pushing, and says so'
	);

	const off = await setAuto(r.app, r.folder, 'off');
	assert.equal(off.auto, false);
	assert.equal(off.autoCommit, false);
});

test.after(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});
