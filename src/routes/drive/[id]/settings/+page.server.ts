import type { Actions, PageServerLoad } from './$types';
import { error, fail } from '@sveltejs/kit';
import { getSession, loadPeers } from '$lib/server/loaders';
import { formatSummary } from '$lib/server/sync';
import { pickerAvailable, pickDirectory } from 'ghost-picker';

export const load: PageServerLoad = async ({ locals, params }) => {
	const session = await getSession(locals.app, params.id);
	return {
		drive: { id: session.id, name: session.name },
		drives: session.listDrives(),
		inviteUrl: locals.app.encodeInvite(session),
		peers: loadPeers(locals.app, params.id),
		canPickDirectory: pickerAvailable(),
		canWrite: session.canWrite,
		syncPairs: session.listSyncPairs()
	};
};

export const actions: Actions = {
	addDrive: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const target = (form.get('target') ?? '').toString().trim();
		if (!target) return fail(400, { error: 'Target required' });

		try {
			if (/^[0-9a-f]{64}$/i.test(target)) {
				await session.addHyperdrive(target);
			} else {
				await session.addLocalDrive(target);
			}
		} catch (err: any) {
			return fail(400, { error: err.message });
		}

		return {};
	},

	pickFolder: async ({ locals, params }) => {
		if (!pickerAvailable()) return fail(400, { error: 'Folder picker not supported here' });

		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const picked = await pickDirectory();
		if (!picked) return { cancelled: true };
		if (!picked.path) {
			return fail(400, { error: `Could not resolve a path for ${picked.uri} — type it instead` });
		}

		try {
			await session.addLocalDrive(picked.path);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}

		return {};
	},

	removeDrive: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const target = (form.get('target') ?? '').toString();
		if (!target || target === 'cache') return fail(400, { error: 'Cannot remove cache' });

		try {
			await session.removeDrive(target);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		return {};
	},

	// --- Local sync ---

	addSync: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const target = (form.get('path') ?? '').toString().trim();
		if (!target) return fail(400, { error: 'Folder path required' });

		try {
			const pair = await session.addSyncPair(target);
			return { message: `Syncing with ${pair.path}` };
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
	},

	pickSyncFolder: async ({ locals, params }) => {
		if (!pickerAvailable()) return fail(400, { error: 'Folder picker not supported here' });

		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const picked = await pickDirectory();
		if (!picked) return { cancelled: true };
		if (!picked.path) {
			return fail(400, { error: `Could not resolve a path for ${picked.uri} — type it instead` });
		}

		try {
			await session.addSyncPair(picked.path);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}

		return {};
	},

	removeSync: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const id = (form.get('syncId') ?? '').toString();
		if (!id) return fail(400, { error: 'Missing sync folder' });

		await session.removeSyncPair(id);
		return {};
	},

	toggleSyncAuto: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const id = (form.get('syncId') ?? '').toString();
		const auto = (form.get('auto') ?? '') === '1';
		if (!id) return fail(400, { error: 'Missing sync folder' });

		try {
			await session.setSyncAuto(id, auto);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		return {};
	},

	// Manual run: waits for the reconcile so the result can be shown.
	syncNow: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const id = (form.get('syncId') ?? '').toString();
		if (!id) return fail(400, { error: 'Missing sync folder' });

		try {
			const summary = await session.runSync(id);
			return { message: `Sync done — ${formatSummary(summary)}` };
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
	},

	deleteSession: async ({ locals, params }) => {
		await locals.app.removeSession(params.id);
		return {};
	}
};
