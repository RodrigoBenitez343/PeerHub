import type { Actions, PageServerLoad } from './$types';
import { error, fail } from '@sveltejs/kit';
import { getSession, loadPeers } from '$lib/server/loaders';
import { formatSummary } from '$lib/server/sync';
import { isEnhancedRequest, type JobHandle } from '$lib/server/jobs';
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
		connected: session.connected,
		isGuest: session.isGuest,
		// 'owner' = one-way (default). The owner flips it; a guest can re-ask.
		writeMode: session.writeMode,
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

	// One-way (default) vs two-way for a single linked folder. A one-way folder
	// only receives; two-way lets it push, subject to the repo policy above.
	setSyncDirection: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const id = (form.get('syncId') ?? '').toString();
		const direction = (form.get('direction') ?? '') === 'two-way' ? 'two-way' : 'pull';
		if (!id) return fail(400, { error: 'Missing sync folder' });

		try {
			await session.setSyncDirection(id, direction);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		return {
			message:
				direction === 'two-way'
					? 'Folder set to two-way — local changes can be pushed'
					: 'Folder set to one-way — it now only receives'
		};
	},

	// Owner only: flip the repo between one-way and two-way. This is the switch
	// that lets other peers write at all; it is off by default.
	setWriteMode: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const mode = (form.get('mode') ?? '') === 'peers' ? 'peers' : 'owner';

		try {
			await session.setWriteMode(mode);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		return {
			message:
				mode === 'peers'
					? 'Peer writes enabled — connected peers can now push'
					: 'Peer writes disabled — this repo is one-way again'
		};
	},

	// Guest side: ask the host for the current policy instead of waiting for a
	// reconnect (announcements cover public repos, this covers invite-only ones).
	refreshPolicy: async ({ locals, params }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		try {
			const allowed = await session.refreshWritePolicy();
			return {
				message: allowed
					? 'Peer writes are enabled by the owner'
					: 'This repository is one-way: only the owner can write'
			};
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
	},

	// Manual run: waits for the reconcile so the result can be shown.
	syncNow: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const id = (form.get('syncId') ?? '').toString();
		if (!id) return fail(400, { error: 'Missing sync folder' });

		if (isEnhancedRequest(request)) {
			// A reconcile can move thousands of files; it runs detached and the
			// button polls instead of holding the form submission open.
			const job = locals.app.jobs.start(
				{ kind: 'sync', label: 'Syncing folder', repoId: params.id },
				async (handle: JobHandle) => {
					const summary = await session.runSync(id, {
						onProgress: (ev: { done: number }) => handle.progress(ev.done)
					});
					return { summary, message: `Sync done — ${formatSummary(summary)}` };
				}
			);
			return { jobId: job.id };
		}

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
