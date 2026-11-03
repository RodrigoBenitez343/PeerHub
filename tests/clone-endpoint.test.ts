// The clone endpoint's contract: every answer is the answer.
//
// The dialog used to read a SvelteKit action result, and an action that threw is
// reported as `{ type: 'error' }` with no `data` — which is how a failed clone
// surfaced as "the clone ended without a result" while the reason sat in a field
// nobody read. This endpoint answers JSON for every branch, so the test below
// pins each one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobRunner } from '../src/lib/server/jobs.ts';
import { POST } from '../src/routes/api/clone/[id]/+server.ts';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-clone-endpoint-'));
let seq = 0;

function rig(options: { sessionThrows?: boolean } = {}) {
	const root = path.join(sandbox, `r${++seq}`);
	const appDir = path.join(root, 'app');
	const folder = path.join(root, 'targets', 'arrow');
	fs.mkdirSync(appDir, { recursive: true });

	const session = {
		id: 'repo-1',
		name: 'Arrow',
		listSyncPairs: () => [],
		// The endpoint only starts the job; what the job does with the session is
		// cloneRepo's business and has its own tests.
		addSyncPair: async () => {
			throw new Error('drive is not open');
		},
		removeSyncPair: async () => {},
		setSyncDirection: async () => {},
		setSyncPrune: async () => {},
		setSyncAuto: async () => {},
		runSync: async () => ({})
	};

	const app: any = {
		dir: appDir,
		sessions: new Map([[session.id, session]]),
		jobs: new JobRunner(),
		async ready() {},
		getSession(id: string) {
			if (options.sessionThrows) throw new Error('the corestore is locked');
			return this.sessions.get(id) ?? null;
		}
	};

	return { appDir, folder, session, app };
}

async function post(app: any, repoId: string, fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const response = await POST({
		locals: { app },
		params: { id: repoId },
		request: new Request(`http://localhost/api/clone/${repoId}`, {
			method: 'POST',
			body: form
		})
	} as any);
	return { status: response.status, body: await response.json() };
}

test('an unknown repository is a 404 with a reason', async () => {
	const r = rig();
	const { status, body } = await post(r.app, 'nope', { path: r.folder });
	assert.equal(status, 404);
	assert.equal(body.error, 'Repository not found');
});

test('a target that cannot be cloned says why, with a 400', async () => {
	const r = rig();
	const parent = path.dirname(r.folder);
	fs.mkdirSync(parent, { recursive: true });
	const file = path.join(parent, 'a-file');
	fs.writeFileSync(file, 'x');

	const { status, body } = await post(r.app, r.session.id, { path: file });
	assert.equal(status, 400);
	assert.match(body.error, /Pick a folder, not a file/);
});

test('a folder that already holds files asks first instead of cloning', async () => {
	const r = rig();
	fs.mkdirSync(r.folder, { recursive: true });
	fs.writeFileSync(path.join(r.folder, 'notes.txt'), 'mine');

	const { status, body } = await post(r.app, r.session.id, { path: r.folder });
	assert.equal(status, 200);
	assert.equal(body.needsConfirm, true);
	assert.equal(body.target.state, 'foreign');
	assert.equal(body.target.files, 1);
	assert.equal(body.jobId, undefined, 'nothing was started');
});

test('an empty target starts the clone and hands back the job id', async () => {
	const r = rig();
	const { status, body } = await post(r.app, r.session.id, { path: r.folder });
	assert.equal(status, 200);
	assert.equal(typeof body.jobId, 'string');
	assert.ok(r.app.jobs.get(body.jobId), 'the job is on the runner');
	assert.equal(fs.existsSync(r.folder), true, 'the folder is created before the job runs');
});

test('a repository that cannot be opened reports that, not a blank answer', async () => {
	const r = rig({ sessionThrows: true });
	const { status, body } = await post(r.app, r.session.id, { path: r.folder });
	assert.equal(status, 400);
	assert.match(body.error, /^Could not open the repository: the corestore is locked/);
});
