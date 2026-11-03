import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { getUpdates } from '$lib/server/updates';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.app) return { state: null };
	await locals.app.ready();
	return { state: getUpdates(locals.app).snapshot() };
};

export const actions: Actions = {
	check: async ({ locals }) => {
		if (!locals.app) return fail(503, { error: 'PeerHub is not running' });
		await getUpdates(locals.app).check();
		return { ok: true };
	},

	download: async ({ locals }) => {
		if (!locals.app) return fail(503, { error: 'PeerHub is not running' });
		try {
			// Answers as soon as the transfer starts; the page polls for progress.
			getUpdates(locals.app).startDownload();
		} catch (err: any) {
			return fail(400, { error: err?.message ?? String(err) });
		}
		return { ok: true };
	},

	install: async ({ locals }) => {
		if (!locals.app) return fail(503, { error: 'PeerHub is not running' });
		try {
			getUpdates(locals.app).requestInstall();
		} catch (err: any) {
			return fail(400, { error: err?.message ?? String(err) });
		}
		return { ok: true };
	},

	unpin: async ({ locals }) => {
		if (!locals.app) return fail(503, { error: 'PeerHub is not running' });
		getUpdates(locals.app).updateSettings({ trustedSigner: null });
		return { ok: true };
	},

	save: async ({ locals, request }) => {
		if (!locals.app) return fail(503, { error: 'PeerHub is not running' });
		const form = await request.formData();
		const repo = (form.get('repo') ?? '').toString().trim();
		if (!repo) return fail(400, { error: 'The release repo needs a name' });

		getUpdates(locals.app).updateSettings({
			repo,
			autoCheck: form.get('autoCheck') === 'on',
			autoDownload: form.get('autoDownload') === 'on',
			autoInstall: form.get('autoInstall') === 'on'
		});
		return { ok: true };
	}
};
