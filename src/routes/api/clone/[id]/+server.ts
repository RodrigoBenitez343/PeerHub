import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cloneRepo, cloneTarget } from '$lib/server/clone';
import type { JobHandle } from '$lib/server/jobs';

// POST /api/clone/<repoId> — body: `path`, optional `confirm`.
//
// A plain endpoint rather than a form action on purpose: this is a client-driven
// flow (pick a folder, maybe confirm, then watch a job), and every failure has to
// arrive as JSON with the reason in it. SvelteKit's action responses wrap the
// answer in `{ type, data }` and report a thrown action as `{ type: 'error' }`
// with no `data` at all, which is how an UI ends up saying "no result" while the
// real reason is hidden in a field it did not read.
//
// Answers:
//   200 { jobId }                      the clone is running
//   200 { needsConfirm, target }       the folder already holds files: ask first
//   400 { error }                      nothing ran, and this is why
//   404 { error }                      no such repository
export const POST: RequestHandler = async ({ locals, params, request }) => {
	let step = 'open the repository';
	try {
		await locals.app.ready();
		const session = locals.app.getSession(params.id);
		if (!session) return json({ error: 'Repository not found' }, { status: 404 });

		step = 'read the target folder';
		const form = await request.formData();
		const target = (form.get('path') ?? '').toString();
		const confirm = (form.get('confirm') ?? '') === '1';

		step = 'check the target folder';
		const info = cloneTarget(locals.app, params.id, target);

		// Nothing is written until the user has seen what it costs: a clone
		// mirrors, so every file the repo does not have is about to be removed.
		if (info.needsConfirm && !confirm) return json({ needsConfirm: true, target: info });

		step = 'start the clone';
		const job = locals.app.jobs.start(
			{ kind: 'clone', label: `Cloning ${session.name}`, repoId: params.id },
			async (handle: JobHandle) => {
				const result = await cloneRepo(session, info.path, {
					onProgress: (ev) => {
						// The walk has no total yet; the plan does, and that is when the
						// bar stops being indeterminate.
						if (ev.total !== undefined) handle.progress(ev.done, ev.total);
					}
				});
				return { summary: result.summary, message: result.message, path: result.path };
			}
		);
		return json({ jobId: job.id });
	} catch (err: any) {
		const message = err?.message ?? String(err);
		console.warn(`[clone] could not ${step} for ${params.id}:`, message);
		return json({ error: `Could not ${step}: ${message}` }, { status: 400 });
	}
};
