import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { runCli, type CliRequest } from '$lib/server/cli';

// Terminal access to the running app. Bound to this process, so the CLI never
// opens the corestore itself — one writer, one set of caches.
//
// Auth: `x-peerhub-token` must match the token written at `<data-dir>/.cli-token`
// on boot. A web page cannot read that file, so a stray site cannot drive this.
export const POST: RequestHandler = async ({ locals, request }) => {
	const app = locals.app;
	if (!app) throw error(503, 'PeerHub is not running');
	await app.ready();

	const token = request.headers.get('x-peerhub-token');
	if (!app.cliToken || token !== app.cliToken) {
		throw error(401, 'Invalid CLI token — run the command from the same machine as the app');
	}

	let body: CliRequest;
	try {
		body = (await request.json()) as CliRequest;
	} catch {
		throw error(400, 'Body must be JSON');
	}
	if (!body?.cmd) throw error(400, 'Command required');

	try {
		const result = await runCli(app, body);
		return json({ ok: true, result });
	} catch (err: any) {
		// Command failures are answers, not server faults: 400 + the message.
		return json({ ok: false, error: err?.message ?? String(err) }, { status: 400 });
	}
};

// Cheap liveness probe for `peerhub ping` and for scripts that wait for boot.
export const GET: RequestHandler = async ({ locals, request }) => {
	const app = locals.app;
	if (!app) return json({ ok: false, error: 'not running' }, { status: 503 });
	await app.ready();

	const token = request.headers.get('x-peerhub-token');
	if (!app.cliToken || token !== app.cliToken) {
		return json({ ok: false, error: 'invalid token' }, { status: 401 });
	}

	return json({
		ok: true,
		key: app.key ? Buffer.from(app.key).toString('hex') : null,
		repos: app.sessions.size
	});
};
