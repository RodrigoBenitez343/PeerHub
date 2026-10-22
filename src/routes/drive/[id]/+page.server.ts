import type { PageServerLoad } from './$types';
import { loadDrive, loadEntries } from '$lib/server/loaders';
import { getRepoMeta } from '$lib/server/repos';
import { loadIgnoreSources } from '$lib/server/ignores';
import { loadReadme } from '$lib/server/readme';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const dirPath = (url.searchParams.get('path') || '/').replaceAll('+', ' ');
	const { entries, fresh } = loadEntries(locals.app, params.id, dirPath);
	const repo = await getRepoMeta(locals.app, params.id);
	const session = await locals.app.ready().then(() => locals.app.getSession(params.id));

	// Ignore rules travel to the client so folder uploads skip files before
	// sending them; the API route enforces the same rules server-side.
	const ignore = session ? await loadIgnoreSources(session) : [];

	// GitHub-style landing: at the repo root, show the rendered README under the
	// file grid. Subdirectories stay a plain listing.
	const readme = session && dirPath === '/' ? await loadReadme(session) : null;

	return {
		path: dirPath,
		drive: loadDrive(locals.app, params.id),
		repo: {
			visibility: repo?.visibility ?? 'public',
			forkedFrom: repo?.forkedFrom ?? null
		},
		ignore,
		readme,
		entries,
		fresh
	};
};
