import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Progress feed for long operations: the page POSTs an action, gets a job id,
// and polls here until the job reaches a terminal state.
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.app?.opened) await locals.app?.ready?.();

	const id = url.searchParams.get('id');
	if (id) {
		const job = locals.app.jobs?.get(id);
		if (!job) return json({ error: 'Job not found' }, { status: 404 });
		return json({ job }, { headers: { 'cache-control': 'no-store' } });
	}

	return json(
		{ jobs: locals.app.jobs?.list() ?? [] },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
