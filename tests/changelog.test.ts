// The per-repo change log: sequence numbers, windows, and the trim that makes an
// old cursor unanswerable instead of confidently wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ChangeLog from '../src/lib/server/changelog.ts';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-log-'));
let seq = 0;
const newFile = () => path.join(sandbox, `log${++seq}`, 'changelog.jsonl');

const put = (filePath: string) => ({
	op: 'put' as const,
	path: filePath,
	size: 3,
	mtime: 1000,
	hash: null
});

test('append numbers the entries and skips the repo bookkeeping', () => {
	const log = new ChangeLog(newFile());
	assert.equal(log.head, 0);

	const first = log.append({ op: 'put', path: '/a.txt', size: 3, mtime: 10, hash: 'h1' });
	assert.equal(first?.seq, 1, 'a fresh log starts at 1, not 0: 0 means "no cursor"');
	assert.equal(log.append({ op: 'del', path: '/b.txt', size: 0, mtime: null, hash: null })?.seq, 2);

	assert.equal(
		log.append(put('/.peerhub/history/main/x')),
		null,
		'history is not repo content'
	);
	assert.equal(log.head, 2, 'a skipped path must not move the sequence');
});

test('window returns only what follows the cursor', () => {
	const log = new ChangeLog(newFile());
	for (let i = 0; i < 5; i++) log.append({ ...put(`/f${i}.txt`), size: i + 1 });

	assert.deepEqual(
		log.window(0)?.entries.map((entry) => entry.seq),
		[1, 2, 3, 4, 5]
	);
	assert.deepEqual(
		log.window(3)?.entries.map((entry) => entry.seq),
		[4, 5]
	);
	assert.equal(log.window(3)?.head, 5);
	assert.deepEqual(log.window(5)?.entries, [], 'a cursor at the head has nothing to send');

	const page = log.window(0, null, 2);
	assert.equal(page?.entries.length, 2, 'a big tail is paged');
	assert.equal(page?.head, 2);
	assert.equal(page?.more, true);
});

test('a cursor from another log is refused', () => {
	const log = new ChangeLog(newFile());
	log.append(put('/a.txt'));
	assert.ok(log.id, 'a log that has written has an identity');

	assert.equal(log.window(0, log.id)?.entries.length, 1, 'the same log answers its own cursor');
	assert.equal(log.window(0, 'someone-else'), null, 'fresh numbers are not a valid answer');
	assert.equal(log.window(0, '')?.entries.length, 1, 'no identity stored yet: ask from the start');
});

test('a cursor this log cannot answer for is refused, not guessed', () => {
	const log = new ChangeLog(newFile(), { max: 4, keep: 3 });
	for (let i = 0; i < 8; i++) log.append(put(`/f${i}.txt`));

	assert.equal(log.head, 8);
	assert.ok(log.floor > 1, 'the front was trimmed');

	assert.equal(log.window(log.floor - 2), null, 'a cursor inside the trimmed part');
	assert.equal(log.window(99), null, 'a cursor from another log');
	assert.equal(log.window(8)?.entries.length, 0, 'the head is still answerable');
	assert.equal(
		log.window(log.floor - 1)?.entries.length,
		log.head - log.floor + 1,
		'the oldest answerable cursor returns everything still kept'
	);
});

test('the log survives a restart and drops a torn last line', () => {
	const file = newFile();
	const log = new ChangeLog(file);
	log.append({ op: 'put', path: '/a.txt', size: 3, mtime: 10, hash: 'h1' });
	log.append({ op: 'put', path: '/b.txt', size: 4, mtime: 11, hash: 'h2' });
	// What a crash in the middle of an append leaves behind.
	fs.appendFileSync(file, '{"seq":3,"op":"put","path":"/c');

	const reopened = new ChangeLog(file);
	assert.equal(reopened.head, 2, 'a torn line is dropped, not counted');
	assert.equal(reopened.window(1)?.entries.length, 1);

	assert.equal(reopened.append(put('/d.txt'))?.seq, 3, 'numbering continues after a restart');
	assert.equal(new ChangeLog(file).window(2)?.entries.length, 1, 'and it is on disk');
});

test('keeping the paths away from the log file leaves the log untouched', () => {
	const file = newFile();
	const log = new ChangeLog(file);
	log.append(put('/a.txt'));

	log.clear();
	assert.equal(log.head, 0);
	assert.equal(fs.existsSync(file), false);
	assert.equal(log.append(put('/a.txt'))?.seq, 1);
});

test.after(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});
