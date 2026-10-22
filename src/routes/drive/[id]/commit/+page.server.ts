import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { getSession } from '$lib/server/loaders';
import { getRepoMeta } from '$lib/server/repos';
import { selfKeyHex } from '$lib/server/users';
import {
	DEFAULT_BRANCH,
	commit,
	getRef,
	listCommits,
	listRefs,
	pendingChanges,
	shortSha
} from '$lib/server/git';

// Commit flow: shows exactly what the commit will change (HEAD tree vs the live
// working tree), then records the snapshot on the chosen branch.

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const session = await getSession(locals.app, params.id);
	const repo = await getRepoMeta(locals.app, params.id);

	const refs = await listRefs(session);
	const branch = url.searchParams.get('branch') || repo?.defaultBranch || DEFAULT_BRANCH;

	let changes: Array<{ path: string; status: string }> = [];
	let head: { sha: string; short: string; message: string } | null = null;
	let error: string | null = null;

	try {
		const pending = await pendingChanges(session, branch);
		changes = pending.changes;
		if (pending.head) {
			head = {
				sha: pending.head.sha,
				short: shortSha(pending.head.sha),
				message: pending.head.message
			};
		}
	} catch (err: any) {
		error = err.message;
	}

	const recent = await listCommits(session, 5);
	const ref = await getRef(session, branch);

	return {
		drive: { id: session.id, name: session.name, isGuest: session.isGuest },
		repo: {
			visibility: repo?.visibility ?? 'public',
			defaultBranch: repo?.defaultBranch ?? DEFAULT_BRANCH,
			forkedFrom: repo?.forkedFrom ?? null
		},
		branch,
		branches: refs.map((entry) => ({ name: entry.name, sha: shortSha(entry.sha) })),
		head,
		refSha: ref?.sha ?? null,
		changes,
		error,
		recent: recent.map((entry) => ({
			short: shortSha(entry.sha),
			message: entry.message,
			ts: entry.ts
		})),
		canCommit: session.metaWritable || session.peerCount > 0,
		metaShared: session.metaShared
	};
};

export const actions: Actions = {
	commit: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) return fail(404, { error: 'Repository not found' });

		const form = await request.formData();
		const message = (form.get('message') ?? '').toString();
		const branch = (form.get('branch') ?? '').toString() || DEFAULT_BRANCH;

		let record;
		try {
			record = await commit(session, {
				message,
				branch,
				authorKey: selfKeyHex(locals.app)
			});
		} catch (err: any) {
			return fail(400, { error: err.message });
		}

		throw redirect(
			303,
			`/drive/${params.id}/code?branch=${encodeURIComponent(branch)}&committed=${shortSha(record.sha)}`
		);
	}
};
