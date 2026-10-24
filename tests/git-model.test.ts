// Commit model: tree digests, diffs, refs and the commit itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
	DEFAULT_BRANCH,
	DIGEST_SIZE_CAP,
	buildTree,
	commit,
	createBranch,
	deleteBranch,
	diffTrees,
	digestBytes,
	digestStat,
	formatChanges,
	getCommit,
	getRef,
	listCommits,
	listRefs,
	parseChanges,
	parseTree,
	pendingChanges,
	previewFile,
	serializeTree,
	shortSha
} from '../src/lib/server/git.ts';
import { HISTORY_PREFIX } from '../src/lib/server/paths.ts';
import { metaSession } from './helpers.ts';

const AUTHOR = 'a'.repeat(64);

test('a tree digest round-trips and rejects anything else', () => {
	const tree = [
		{ path: '/a.txt', size: 1, mtime: 0, digest: 'd1' },
		{ path: '/b/c.txt', size: 2, mtime: 0, digest: 'd2' }
	];
	const serialized = serializeTree(tree);
	assert.deepEqual(parseTree(serialized), [
		['/a.txt', 'd1'],
		['/b/c.txt', 'd2']
	]);

	assert.deepEqual(parseTree(null), []);
	assert.deepEqual(parseTree('not json'), []);
	assert.deepEqual(parseTree('{"a":1}'), []);
	assert.deepEqual(parseTree('[["/a"],["b",1],["/ok","d"]]'), [['/ok', 'd']]);
});

test('diffTrees reports additions, modifications and removals, sorted', () => {
	const before = serializeTree([
		{ path: '/same', size: 1, mtime: 0, digest: 'x' },
		{ path: '/modified', size: 1, mtime: 0, digest: 'old' },
		{ path: '/removed', size: 1, mtime: 0, digest: 'x' }
	]);
	const after = serializeTree([
		{ path: '/same', size: 1, mtime: 0, digest: 'x' },
		{ path: '/modified', size: 1, mtime: 0, digest: 'new' },
		{ path: '/added', size: 1, mtime: 0, digest: 'x' }
	]);

	assert.deepEqual(diffTrees(before, after), [
		{ path: '/added', status: 'added' },
		{ path: '/modified', status: 'modified' },
		{ path: '/removed', status: 'removed' }
	]);
});

test('a first commit diffs against an empty tree', () => {
	const after = serializeTree([{ path: '/a', size: 1, mtime: 0, digest: 'x' }]);
	assert.deepEqual(diffTrees(null, after), [{ path: '/a', status: 'added' }]);
	assert.deepEqual(diffTrees(null, serializeTree([])), []);
});

test('changelists survive a round-trip, including paths with spaces', () => {
	const changes = [
		{ path: '/a b/c.txt', status: 'added' as const },
		{ path: '/kept.txt', status: 'modified' as const },
		{ path: '/gone.txt', status: 'removed' as const }
	];
	assert.deepEqual(parseChanges(formatChanges(changes)), changes);
});

test('changelist parsing ignores junk lines', () => {
	assert.deepEqual(parseChanges('A /a\n\nX /b\nZ /c\nM /d\n'), [
		{ path: '/a', status: 'added' },
		{ path: '/d', status: 'modified' }
	]);
	assert.deepEqual(parseChanges(null), []);
});

test('shortSha trims to seven characters', () => {
	assert.equal(shortSha('0123456789abcdef'), '0123456');
});

test('digests are content-addressed, stable and distinct', () => {
	assert.equal(digestBytes(Buffer.from('same')), digestBytes(Buffer.from('same')));
	assert.notEqual(digestBytes(Buffer.from('same')), digestBytes(Buffer.from('other')));
	assert.equal(digestBytes(Buffer.alloc(0)).length, 64);
});

test('the size digest encodes size and mtime, and is what large files use', () => {
	assert.equal(digestStat(10, 20), 'size:10:20');
	assert.equal(digestStat(10, null), 'size:10:0');
});

test('buildTree hashes small files, digests large ones, and skips bookkeeping', async () => {
	const session = metaSession();
	const small = Buffer.from('small');
	const large = randomBytes(DIGEST_SIZE_CAP + 1);
	session.memory.write('/small.txt', small);
	session.memory.write('/large.bin', large);
	session.memory.write('/.peerhub/history/x/whatever', Buffer.from('ignored'));

	const tree = await buildTree(session);

	assert.deepEqual(
		tree.map((entry) => entry.path),
		['/large.bin', '/small.txt'],
		'entries are sorted and /.peerhub is not content'
	);
	assert.equal(tree[1].digest, digestBytes(small));
	assert.equal(
		tree[0].digest,
		`size:${large.byteLength}:0`,
		'past the cap the digest is size+mtime'
	);
});

test('previewFile detects binary content, truncates, and refuses missing files', async () => {
	const session = metaSession();
	session.memory.write('/text.txt', Buffer.from('hello'));
	session.memory.write('/bin.dat', Buffer.from([1, 2, 0, 4]));
	session.memory.write('/big.txt', Buffer.alloc(300 * 1024, 97));

	const text = await previewFile(session, '/text.txt');
	assert.equal(text.text, 'hello');
	assert.equal(text.binary, false);
	assert.equal(text.truncated, false);

	const binary = await previewFile(session, '/bin.dat');
	assert.equal(binary.binary, true);
	assert.equal(binary.text, null);

	const big = await previewFile(session, '/big.txt');
	assert.equal(big.truncated, true, 'the preview must stop at its cap');
	assert.ok(big.text!.length <= 256 * 1024);

	await assert.rejects(previewFile(session, '/missing'), /Not found/i);
});

test('commit records the changes, moves the branch and stores snapshots', async () => {
	const session = metaSession();
	session.memory.write('/a.txt', Buffer.from('one'));

	const first = await commit(session, { message: 'first', authorKey: AUTHOR });

	assert.equal(first.parent, null);
	assert.match(first.changes!, /A \/a\.txt/);
	assert.equal((await getRef(session, DEFAULT_BRANCH))?.sha, first.sha);
	assert.ok(
		session.memory.files.has(`${HISTORY_PREFIX}/${first.sha}/a.txt`),
		'the changed file must be snapshotted before the commit is visible'
	);

	session.memory.write('/a.txt', Buffer.from('two'));
	session.memory.write('/b.txt', Buffer.from('new'));
	const second = await commit(session, { message: 'second', authorKey: AUTHOR });

	assert.equal(second.parent, first.sha);
	assert.match(second.changes!, /M \/a\.txt/);
	assert.match(second.changes!, /A \/b\.txt/);
	assert.notEqual(second.sha, first.sha);

	const log = await listCommits(session, 10);
	assert.deepEqual(
		log.map((entry) => entry.message),
		['second', 'first']
	);
});

test('an empty commit has no changelist but still records a commit', async () => {
	const session = metaSession();
	session.memory.write('/a.txt', Buffer.from('one'));
	await commit(session, { message: 'first', authorKey: AUTHOR });
	const empty = await commit(session, { message: 'noop', authorKey: AUTHOR });

	assert.equal(empty.changes, null);
	assert.equal(empty.parent, (await getCommit(session, empty.parent!))!.sha);
});

test('a commit message is required', async () => {
	const session = metaSession();
	await assert.rejects(commit(session, { message: '   ', authorKey: AUTHOR }), /message required/i);
});

test('pendingChanges compares HEAD with the live tree', async () => {
	const session = metaSession();
	session.memory.write('/a.txt', Buffer.from('one'));
	const first = await commit(session, { message: 'first', authorKey: AUTHOR });

	session.memory.write('/a.txt', Buffer.from('changed'));
	const pending = await pendingChanges(session);

	assert.equal(pending.head?.sha, first.sha);
	assert.deepEqual(pending.changes, [{ path: '/a.txt', status: 'modified' }]);
});

test('branches: created from HEAD, listed, and protected', async () => {
	const session = metaSession();
	await assert.rejects(createBranch(session, 'feature'), /Commit something first/i);

	session.memory.write('/a.txt', Buffer.from('one'));
	const first = await commit(session, { message: 'first', authorKey: AUTHOR });

	const branch = await createBranch(session, 'feature');
	assert.equal(branch.sha, first.sha);
	assert.deepEqual(
		(await listRefs(session)).map((ref) => ref.name),
		['feature', 'main']
	);

	await assert.rejects(createBranch(session, 'feature'), /already exists/i);
	await assert.rejects(createBranch(session, 'with space'), /cannot contain spaces/i);
	await assert.rejects(createBranch(session, ''), /name required/i);

	await assert.rejects(deleteBranch(session, DEFAULT_BRANCH), /Cannot delete the default branch/i);
	await assert.rejects(deleteBranch(session, 'nope'), /No such branch/i);

	await deleteBranch(session, 'feature');
	assert.deepEqual(
		(await listRefs(session)).map((ref) => ref.name),
		['main']
	);
});
