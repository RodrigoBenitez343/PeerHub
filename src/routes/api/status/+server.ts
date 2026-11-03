import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';

// Boot progress for the desktop shell.
//
// Deliberately does not await app.ready(): the window is already up while the
// corestore and its repos are opening, and this is what it polls so it can show
// "starting" instead of a blank page — or report that boot failed.
export const GET: RequestHandler = ({ locals }) => {
	const app = locals.app;
	if (!app) return json({ ok: false, booted: false, error: 'not started' }, { status: 503 });

	return json(
		{
			ok: true,
			booted: !!app.opened,
			closed: !!app.closed,
			error: app.bootError ?? null,
			repos: app.sessions?.size ?? 0
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
