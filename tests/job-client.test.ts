// Client side of a job: polling must resolve on done, reject on error and honour
// its deadline. fetch is replaced for the duration of each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJob, watchJob, type JobView } from '../src/lib/jobs.ts';

function job(overrides: Partial<JobView> = {}): JobView {
	return {
		id: 'job-1',
		kind: 'fork',
		label: 'Forking repo',
		repoId: 'repo-1',
		state: 'running',
		done: 0,
		total: null,
		startedAt: 1,
		finishedAt: null,
		result: null,
		error: null,
		...overrides
	};
}

function stubFetch(replies: Array<() => Response>): { urls: string[]; restore: () => void } {
	const original = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (input: any) => {
		urls.push(String(input));
		const next = replies.shift();
		if (!next) throw new Error('unexpected extra poll');
		return next();
	}) as typeof fetch;
	return { urls, restore: () => (globalThis.fetch = original) };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

test('fetchJob asks for one job and returns it', async () => {
	const stub = stubFetch([() => json({ job: job() })]);
	try {
		const result = await fetchJob('job 1');
		assert.equal(result.id, 'job-1');
		assert.equal(stub.urls[0], '/api/jobs?id=job%201', 'the id has to be encoded');
	} finally {
		stub.restore();
	}
});

test('fetchJob explains a forgotten job instead of returning undefined', async () => {
	const stub = stubFetch([() => json({ error: 'Job not found' }, 404)]);
	try {
		await assert.rejects(fetchJob('gone'), /restarted/);
	} finally {
		stub.restore();
	}
});

test('watchJob polls until done and reports every update', async () => {
	const stub = stubFetch([
		() => json({ job: job({ done: 1, total: 3 }) }),
		() => json({ job: job({ done: 3, total: 3, state: 'done', result: { repoId: 'r2' } }) })
	]);
	const seen: string[] = [];
	try {
		const done = await watchJob('job-1', {
			intervalMs: 1,
			onUpdate: (update) => seen.push(`${update.state}:${update.done}`)
		});
		assert.equal(done.state, 'done');
		assert.deepEqual(done.result, { repoId: 'r2' });
		assert.deepEqual(seen, ['running:1', 'done:3']);
		assert.equal(stub.urls.length, 2);
	} finally {
		stub.restore();
	}
});

test('watchJob rejects with the job error, not a generic message', async () => {
	const stub = stubFetch([
		() => json({ job: job({ state: 'error', error: 'source peer is offline' }) })
	]);
	try {
		await assert.rejects(watchJob('job-1', { intervalMs: 1 }), /source peer is offline/);
	} finally {
		stub.restore();
	}
});

test('watchJob gives up instead of polling forever', async () => {
	const stub = stubFetch(Array.from({ length: 10 }, () => () => json({ job: job() })));
	try {
		await assert.rejects(
			watchJob('job-1', { intervalMs: 1, timeoutMs: 5 }),
			/did not finish in time/
		);
	} finally {
		stub.restore();
	}
});
