// Background jobs: the action must return before the work finishes, the work
// must never reject into the void, and progress must be readable while it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRunner, isEnhancedRequest } from '../src/lib/server/jobs.ts';

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test('start returns a running job before the work has done anything', async () => {
	const jobs = new JobRunner();
	const gate = deferred<string>();

	const job = jobs.start({ kind: 'fork', label: 'Fork repo' }, async () => {
		await gate.promise;
		return 'ok';
	});

	assert.equal(job.state, 'running');
	assert.equal(job.kind, 'fork');
	assert.equal(job.done, 0);
	assert.equal(job.total, null);
	assert.equal(job.finishedAt, null);
	assert.equal(jobs.get(job.id)!.state, 'running');

	gate.resolve('ok');
	await new Promise((resolve) => setImmediate(resolve));

	const done = jobs.get(job.id)!;
	assert.equal(done.state, 'done');
	assert.equal(done.result, 'ok');
	assert.ok(done.startedAt > 0);
	assert.ok(done.finishedAt! >= done.startedAt);
});

test('progress reports files and a total, and never moves backwards', async () => {
	const jobs = new JobRunner();
	const gate = deferred<void>();
	let handle: any;

	const job = jobs.start({ kind: 'upload', label: 'Upload folder' }, async (h) => {
		handle = h;
		await gate.promise;
		return null;
	});

	handle.progress(1, 10);
	assert.equal(jobs.get(job.id)!.done, 1);
	assert.equal(jobs.get(job.id)!.total, 10);

	handle.progress(4);
	handle.progress(2); // a late progress event from an earlier file
	handle.progress(Number.NaN);
	assert.equal(jobs.get(job.id)!.done, 4, 'done only grows');
	assert.equal(jobs.get(job.id)!.total, 10);

	gate.resolve();
	await new Promise((resolve) => setImmediate(resolve));
});

test('a failing job stores the error instead of throwing it away', async () => {
	const jobs = new JobRunner();

	const job = jobs.start({ kind: 'commit', label: 'Commit' }, async () => {
		throw new Error('snapshot failed');
	});
	await new Promise((resolve) => setImmediate(resolve));

	const failed = jobs.get(job.id)!;
	assert.equal(failed.state, 'error');
	assert.equal(failed.error, 'snapshot failed');
	assert.equal(failed.result, null);
	assert.ok(failed.finishedAt);
});

test('a synchronous throw in the work function is captured too', async () => {
	const jobs = new JobRunner();
	const job = jobs.start({ kind: 'sync', label: 'Sync' }, () => {
		throw new Error('bad folder');
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(jobs.get(job.id)!.state, 'error');
	assert.equal(jobs.get(job.id)!.error, 'bad folder');
});

test('get returns null for an unknown id and a copy for a known one', () => {
	const jobs = new JobRunner();
	const job = jobs.start({ kind: 'sync', label: 'Sync' }, async () => null);

	const view = jobs.get(job.id)!;
	view.state = 'error'; // mutating the snapshot must not touch the job
	assert.equal(jobs.get(job.id)!.state, 'running');
	assert.equal(jobs.get('nope'), null);
});

test('the job list is newest first and belongs to the runner', async () => {
	const jobs = new JobRunner();
	const gate = deferred<void>();
	const first = jobs.start({ kind: 'a', label: 'first' }, () => gate.promise);
	await new Promise((resolve) => setTimeout(resolve, 2));
	const second = jobs.start({ kind: 'b', label: 'second' }, () => gate.promise);

	assert.deepEqual(
		jobs.list().map((job) => job.id),
		[second.id, first.id]
	);

	gate.resolve();
	const list = jobs.list();
	assert.equal(list[0].id, second.id);
	list.length = 0;
	assert.equal(jobs.list().length >= 2, true, 'the list is a copy');
});

test('old finished jobs are trimmed instead of growing forever', async () => {
	const jobs = new JobRunner();
	for (let i = 0; i < 130; i++) {
		jobs.start({ kind: 'noop', label: `job ${i}` }, async () => i);
	}
	// Let the microtask queue drain all of them.
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

	const list = jobs.list();
	assert.ok(list.length <= 100, `kept ${list.length} jobs`);
	assert.ok(list.length >= 50, 'recent jobs must still be visible');
	assert.equal(
		list.every((job) => job.state === 'done'),
		true
	);
});

test('a job names the repo it belongs to so a page can match it', () => {
	const jobs = new JobRunner();
	const job = jobs.start({ kind: 'sync', label: 'Sync', repoId: 'repo-1' }, async () => null);
	assert.equal(job.repoId, 'repo-1');
	const other = jobs.start({ kind: 'sync', label: 'Sync' }, async () => null);
	assert.equal(other.repoId, null);
});

test('only enhanced form posts are allowed to follow a job', () => {
	const enhanced = new Request('http://localhost/', {
		method: 'POST',
		headers: { 'x-sveltekit-action': 'true' }
	});
	const plain = new Request('http://localhost/', { method: 'POST' });

	assert.equal(isEnhancedRequest(enhanced), true);
	assert.equal(isEnhancedRequest(plain), false, 'a no-JS post must keep the blocking path');
});
