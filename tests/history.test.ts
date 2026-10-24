// Commit content storage and restore.
//
// The interesting behaviour is the decision "full copy or chunk manifest" and
// the walk that finds a path in an older commit; both are asserted directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Localdrive from 'localdrive';
import { DELTA_THRESHOLD } from '../src/lib/server/chunks.ts';
import { HISTORY_PREFIX } from '../src/lib/server/paths.ts';
import { resolveSnapshot, restoreCommit, writeSnapshots } from '../src/lib/server/history.ts';
import { serializeTree } from '../src/lib/server/git.ts';
import { metaSession } from './helpers.ts';

const MAGIC = 'PEERHUB-DELTA/1\n';

function commitRow(sha: string, parent: string | null, changes: string | null, tree: string) {
	return {
		repoId: 'test-repo',
		sha,
		parent,
		treeDigest: tree,
		authorKey: 'k',
		message: sha,
		ts: 1,
		changes
	};
}

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ph-history-'));
}

async function readLocal(dir: string, rel: string): Promise<Buffer> {
	const local = new Localdrive(dir);
	await local.ready();
	try {
		const parts: Buffer[] = [];
		for await (const chunk of local.createReadStream(rel)) parts.push(Buffer.from(chunk));
		return Buffer.concat(parts);
	} finally {
		await local.close();
	}
}

function record(session: any, sha: string, file: string): Buffer | undefined {
	return session.memory.files.get(`${HISTORY_PREFIX}/${sha}${file}`);
}

test('a small changed file is stored as a plain copy', async () => {
	const session = metaSession();
	session.memory.write('/notes.txt', Buffer.from('hello\n'));

	await writeSnapshots(session, 'c1', [{ path: '/notes.txt', status: 'added' }]);

	const stored = record(session, 'c1', '/notes.txt');
	assert.ok(stored);
	assert.equal(stored.toString(), 'hello\n', 'small files must stay human-readable copies');
});

test('a file above the threshold is stored as a chunk manifest', async () => {
	const session = metaSession();
	const big = randomBytes(DELTA_THRESHOLD + 1024);
	session.memory.write('/big.bin', big);

	await writeSnapshots(session, 'c1', [{ path: '/big.bin', status: 'added' }]);

	const stored = record(session, 'c1', '/big.bin');
	assert.ok(stored, 'no record written');
	assert.equal(stored.subarray(0, MAGIC.length).toString(), MAGIC);
	assert.ok(
		stored.byteLength < 4096,
		`manifest is ${stored.byteLength} bytes, expected a small list`
	);
});

test('the threshold is exclusive: a file exactly at the cap is copied whole', async () => {
	const session = metaSession();
	const exact = randomBytes(DELTA_THRESHOLD);
	session.memory.write('/exact.bin', exact);
	await writeSnapshots(session, 'c1', [{ path: '/exact.bin', status: 'added' }]);

	const stored = record(session, 'c1', '/exact.bin')!;
	assert.deepEqual(stored, exact, 'at the cap the record must be the bytes themselves');
});

test('removed paths get no snapshot', async () => {
	const session = metaSession();
	session.memory.files.set('/gone.txt', Buffer.from('x'));

	await writeSnapshots(session, 'c1', [{ path: '/gone.txt', status: 'removed' }]);

	assert.equal(record(session, 'c1', '/gone.txt'), undefined);
});

test('resolveSnapshot walks parents for a path the commit did not touch', async () => {
	const session = metaSession({
		'@ghostdrive/commits': [
			commitRow('a', null, 'A /keep.txt', '[]'),
			commitRow('b', 'a', 'M /other.txt', '[]')
		]
	});
	session.memory.write('/keep.txt', Buffer.from('kept'));

	await writeSnapshots(session, 'a', [{ path: '/keep.txt', status: 'added' }]);
	const hit = await resolveSnapshot(session, 'b', '/keep.txt');

	assert.equal(hit.state, 'present');
	assert.equal(hit.commit, 'a', 'the walk must stop at the commit that stored the content');
	assert.equal(hit.path, `${HISTORY_PREFIX}/a/keep.txt`);
});

test('resolveSnapshot reports a path deleted by that commit', async () => {
	const session = metaSession({
		'@ghostdrive/commits': [
			commitRow('a', null, 'A /x.txt', '[]'),
			commitRow('b', 'a', 'D /x.txt', '[]')
		]
	});
	session.memory.write('/x.txt', Buffer.from('x'));
	await writeSnapshots(session, 'a', [{ path: '/x.txt', status: 'added' }]);

	assert.equal((await resolveSnapshot(session, 'b', '/x.txt')).state, 'deleted');
});

test('resolveSnapshot distinguishes "missing record" from "never existed"', async () => {
	const session = metaSession({
		'@ghostdrive/commits': [commitRow('a', null, 'A /ghost.txt', '[]')]
	});
	// No snapshot written for /ghost.txt on purpose.
	assert.equal((await resolveSnapshot(session, 'a', '/ghost.txt')).state, 'missing');

	const other = metaSession({ '@ghostdrive/commits': [commitRow('a', null, null, '[]')] });
	assert.equal((await resolveSnapshot(other, 'a', '/never.txt')).state, 'unknown');
});

test('restore writes the exact bytes of a chunked and a plain record', async () => {
	const session = metaSession({
		'@ghostdrive/commits': [commitRow('a', null, 'A /big /small', '[]')]
	});
	const big = randomBytes(DELTA_THRESHOLD + 200_000);
	const small = Buffer.from('plain text');
	session.memory.write('/big.bin', big);
	session.memory.write('/small.txt', small);
	await writeSnapshots(session, 'a', [
		{ path: '/big.bin', status: 'added' },
		{ path: '/small.txt', status: 'added' }
	]);

	const dir = tempDir();
	const actions = await restoreCommit(session, dir, 'a', ['/big.bin', '/small.txt']);

	assert.deepEqual(
		actions.map((entry) => `${entry.path}:${entry.action}`),
		['/big.bin:restored', '/small.txt:restored']
	);
	assert.deepEqual(await readLocal(dir, '/big.bin'), big, 'restored bytes must match the original');
	assert.deepEqual(await readLocal(dir, '/small.txt'), small);
});

test('dryRun reports the plan and writes nothing', async () => {
	const session = metaSession({ '@ghostdrive/commits': [commitRow('a', null, 'A /n.txt', '[]')] });
	session.memory.write('/n.txt', Buffer.from('n'));
	await writeSnapshots(session, 'a', [{ path: '/n.txt', status: 'added' }]);

	const dir = tempDir();
	const actions = await restoreCommit(session, dir, 'a', ['/n.txt'], { dryRun: true });

	assert.equal(actions[0].action, 'restored');
	assert.equal(fs.readdirSync(dir).length, 0, 'dryRun must not create files');
});

test('exact-tree restore removes what that commit never had, and leaves untracked files alone', async () => {
	const tree = serializeTree([{ path: '/kept.txt', size: 4, mtime: 0, digest: 'd' }]);
	const session = metaSession({
		'@ghostdrive/commits': [commitRow('a', null, 'A /kept.txt', tree)]
	});
	session.memory.write('/kept.txt', Buffer.from('kept'));
	session.memory.write('/added-later.txt', Buffer.from('later'));
	await writeSnapshots(session, 'a', [{ path: '/kept.txt', status: 'added' }]);

	const dir = tempDir();
	fs.writeFileSync(path.join(dir, 'added-later.txt'), 'later');
	fs.writeFileSync(path.join(dir, 'local-only.txt'), 'mine');

	const actions = await restoreCommit(session, dir, 'a', [], { tree: true });

	const files = fs.readdirSync(dir).sort();
	assert.deepEqual(files, ['kept.txt', 'local-only.txt']);
	const removed = actions.find((entry) => entry.path === '/added-later.txt');
	assert.equal(removed?.action, 'deleted');
	assert.equal(removed?.reason, 'not in that commit');
	assert.ok(
		fs.existsSync(path.join(dir, 'local-only.txt')),
		'untracked files must survive a tree restore'
	);
});

test('restoring an unknown commit fails loudly', async () => {
	const session = metaSession({ '@ghostdrive/commits': [] });
	await assert.rejects(restoreCommit(session, tempDir(), 'nope', ['/x']), /No such commit/i);
});

test('a restore with no files at all is refused, not silently empty', async () => {
	const session = metaSession({ '@ghostdrive/commits': [commitRow('a', null, null, '[]')] });
	await assert.rejects(restoreCommit(session, tempDir(), 'a', []), /no files to restore/i);
});
