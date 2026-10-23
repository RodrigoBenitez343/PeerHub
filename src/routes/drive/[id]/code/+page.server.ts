import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import b4a from 'b4a';
import { getSession } from '$lib/server/loaders';
import { getRepoMeta } from '$lib/server/repos';
import type { SharedFile } from '$lib/server/shared-drive';
import { renderMarkdown } from '$lib/markdown';
import { loadReadme, markdownOptions } from '$lib/server/readme';
import { isReservedRepoPath } from '$lib/server/paths';
import {
	DEFAULT_BRANCH,
	createBranch,
	deleteBranch,
	listCommits,
	listRefs,
	previewFile,
	shortSha,
	type FilePreview
} from '$lib/server/git';

// Repo "Code" view: dir tree + branch selector + file/markdown preview on one
// page, with branch tooling and links to the commit flow.

function normalizeDir(raw: string | null): string {
	if (!raw) return '/';
	let dir = raw.startsWith('/') ? raw : '/' + raw;
	dir = dir.replace(/\/+$/, '');
	if (dir.split('/').includes('..')) return '/';
	return dir === '' ? '/' : dir;
}

function isMarkdown(path: string): boolean {
	return /\.(md|markdown)$/i.test(path);
}

function listDir(all: SharedFile[], dir: string) {
	const prefix = dir === '/' ? '/' : dir + '/';
	const folders = new Map<string, number>();
	const files: Array<{ path: string; name: string; size: number }> = [];

	for (const entry of all) {
		if (!entry.path.startsWith(prefix)) continue;
		// The repo's own history store lives here; it is not repo content.
		if (isReservedRepoPath(entry.path)) continue;
		const rest = entry.path.slice(prefix.length);
		if (!rest) continue;
		const slash = rest.indexOf('/');
		if (slash === -1) {
			files.push({ path: entry.path, name: rest, size: entry.size });
		} else {
			const name = rest.slice(0, slash);
			folders.set(name, (folders.get(name) ?? 0) + 1);
		}
	}

	return {
		folders: [...folders.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		files: files.sort((a, b) => a.name.localeCompare(b.name))
	};
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const session = await getSession(locals.app, params.id);
	const repo = await getRepoMeta(locals.app, params.id);

	const refs = await listRefs(session);
	const branches = refs.map((ref) => ({ name: ref.name, sha: shortSha(ref.sha) }));
	const branch = url.searchParams.get('branch') || repo?.defaultBranch || DEFAULT_BRANCH;
	const ref = refs.find((entry) => entry.name === branch) ?? null;

	const history = await listCommits(session, 40);

	// A guest with no peers cannot list the host's files; show history instead of
	// failing the page.
	let files: SharedFile[] = [];
	let filesError: string | null = null;
	try {
		files = await session.drive!.manifestShared('/');
	} catch (err: any) {
		filesError = err.message;
	}

	const dir = normalizeDir(url.searchParams.get('dir'));
	const listing = listDir(files, dir);

	const selected = url.searchParams.get('path');
	let file: FilePreview | null = null;
	let fileHtml: string | null = null;
	let fileError: string | null = null;

	if (selected) {
		try {
			file = await previewFile(session, selected);
			if (file.text !== null && isMarkdown(file.path)) {
				// Links and images resolve relative to the file being previewed,
				// so a README inside docs/ can reference docs/ assets.
				const dir = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
				fileHtml = renderMarkdown(file.text, markdownOptions(session, dir));
			}
		} catch (err: any) {
			fileError = err.message;
		}
	}

	// Nothing selected: show the README at the repo root if there is one.
	const readme = !selected && !filesError ? await loadReadme(session, files) : null;

	return {
		drive: {
			id: session.id,
			name: session.name,
			isGuest: session.isGuest,
			canWrite: session.canWrite
		},
		repo: {
			description: repo?.description ?? null,
			visibility: repo?.visibility ?? 'public',
			defaultBranch: repo?.defaultBranch ?? DEFAULT_BRANCH,
			forkedFrom: repo?.forkedFrom ?? null
		},
		branch,
		branches,
		head: ref ? { sha: ref.sha, short: shortSha(ref.sha) } : null,
		commits: history.map((entry) => ({
			sha: entry.sha,
			short: shortSha(entry.sha),
			message: entry.message,
			ts: entry.ts,
			author: entry.authorKey.slice(0, 8),
			parent: entry.parent ? shortSha(entry.parent) : null
		})),
		dir,
		folders: listing.folders,
		files: listing.files,
		totalFiles: files.filter((entry) => !isReservedRepoPath(entry.path)).length,
		filesError,
		selected: selected ?? null,
		file,
		fileHtml,
		fileError,
		readme,
		peers: session.peerCount,
		driveKey: session.drive ? b4a.toString(session.drive.key, 'hex') : null,
		canCommit: session.canWrite,
		metaShared: session.metaShared,
		metaWritable: session.metaWritable
	};
};

export const actions: Actions = {
	branch: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) return fail(404, { error: 'Repository not found' });

		const form = await request.formData();
		const name = (form.get('name') ?? '').toString();
		const from = (form.get('from') ?? '').toString() || DEFAULT_BRANCH;

		try {
			await createBranch(session, name, from);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		throw redirect(303, `/drive/${params.id}/code?branch=${encodeURIComponent(name.trim())}`);
	},

	removeBranch: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) return fail(404, { error: 'Repository not found' });

		const form = await request.formData();
		const name = (form.get('name') ?? '').toString();
		const fallback = (form.get('defaultBranch') ?? DEFAULT_BRANCH).toString();

		try {
			await deleteBranch(session, name, fallback);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		throw redirect(303, `/drive/${params.id}/code?branch=${encodeURIComponent(fallback)}`);
	}
};
