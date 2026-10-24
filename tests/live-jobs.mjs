// Manual integration check (not part of `npm test`): the built server answers a
// fork POST at once with a job id while the mirror keeps running in the
// background; /api/jobs reports it. This checks the offload itself — with one
// peer the mirror can only end in the "source offline" error, which is exactly
// what the job has to carry to the page.
// Run: node --import ./tests/register.mjs tests/live-jobs.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5413;
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-jobs-live-'));

const env = {
	...process.env,
	PORT: String(PORT),
	ORIGIN: BASE,
	PEERHUB_DATA_DIR: dir,
	PEERHUB_DISCOVERY_REFRESH_MS: '0'
};

const server = spawn(process.execPath, ['build/index.js'], {
	env,
	stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (chunk) => (log += chunk));
server.stderr.on('data', (chunk) => (log += chunk));

async function waitForServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const res = await fetch(`${BASE}/api/jobs`);
			if (res.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`server did not start:\n${log}`);
}

async function action(pathname, fields) {
	const res = await fetch(`${BASE}${pathname}`, {
		method: 'POST',
		headers: {
			'x-sveltekit-action': 'true',
			accept: 'application/json',
			origin: BASE,
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams(fields),
		redirect: 'manual'
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, type: json?.type, data: json?.data, location: json?.location, text };
}

const jobOf = (result) => {
	const payload = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
	return Array.isArray(payload) ? payload[1] : payload?.jobId;
};

async function poll(id) {
	const res = await fetch(`${BASE}/api/jobs?id=${encodeURIComponent(id)}`);
	return (await res.json()).job;
}

try {
	await waitForServer();

	const created = await action('/?/create', { name: 'fork-live', description: '' });
	const repoId = (created.location ?? '').match(/\/drive\/([^/]+)\/code/)?.[1];
	if (!repoId) throw new Error(`create did not redirect: ${JSON.stringify(created).slice(0, 300)}`);

	const put = await fetch(`${BASE}/api/files/${repoId}/hello.txt`, {
		method: 'PUT',
		headers: { 'content-type': 'text/plain', origin: BASE },
		body: 'hello'
	});
	if (!put.ok) throw new Error(`upload failed: ${put.status} ${await put.text()}`);

	// Commit runs as a job too: the POST returns at once and the sha arrives later.
	const commitAction = await action(`/drive/${repoId}/commit?/commit`, {
		message: 'live commit',
		branch: 'main'
	});
	const commitJobId = jobOf(commitAction);
	if (commitAction.type !== 'success' || !commitJobId) {
		throw new Error(`commit did not start a job: ${JSON.stringify(commitAction).slice(0, 300)}`);
	}
	let commit = await poll(commitJobId);
	for (let i = 0; i < 120 && commit?.state === 'running'; i++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		commit = await poll(commitJobId);
	}
	if (commit?.state !== 'done' || !/^[0-9a-f]{64}$/.test(commit.result?.sha ?? '')) {
		throw new Error(`commit job did not finish: ${JSON.stringify(commit).slice(0, 300)}`);
	}
	console.log('commit job done:', commit.result.short);

	// The code page exposes the drive key in its hydration data.
	const code = await fetch(`${BASE}/drive/${repoId}/code`).then((res) => res.text());
	const driveKey = code.match(/driveKey:"([0-9a-f]{64})"/)?.[1];
	if (!driveKey) throw new Error('code page did not expose the drive key');

	const started = Date.now();
	const forked = await action('/?/fork', {
		driveKey,
		repoId,
		name: 'forked-live',
		description: ''
	});
	const elapsed = Date.now() - started;
	const jobId = jobOf(forked);
	if (forked.type !== 'success' || !jobId) {
		throw new Error(`fork did not start a job: ${JSON.stringify(forked).slice(0, 300)}`);
	}
	// The old action held the request open for up to FORK_TIMEOUT (45 s).
	if (elapsed > 5000) throw new Error(`fork POST blocked for ${elapsed} ms`);
	console.log(`fork POST answered in ${elapsed} ms with job ${jobId}`);

	const running = await poll(jobId);
	if (!running || running.state !== 'running') {
		throw new Error(`job not running right away: ${JSON.stringify(running)}`);
	}
	const listed = await fetch(`${BASE}/api/jobs`).then((res) => res.json());
	if (!listed.jobs.some((job) => job.id === jobId)) throw new Error('job missing from the list');
	console.log('job is running and listed while the page is free');

	// With no other peer the mirror cannot succeed; the job must say so instead
	// of dropping the failure (waits for FORK_TIMEOUT).
	const deadline = Date.now() + 60_000;
	let finished = running;
	while (finished.state === 'running' && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		finished = await poll(jobId);
	}
	if (finished.state !== 'error') {
		throw new Error(`expected the offline error with one peer, got ${finished.state}`);
	}
	console.log('job failed loudly:', finished.error);
	console.log('LIVE JOBS OK');
} finally {
	server.kill();
	await new Promise((resolve) => setTimeout(resolve, 800));
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch (err) {
		console.warn('cleanup:', err.message);
	}
}
