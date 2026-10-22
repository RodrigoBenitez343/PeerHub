import type { PageServerLoad } from './$types';
import { loadDrive, loadEntries } from '$lib/server/loaders';
import { getRepoMeta } from '$lib/server/repos';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const dirPath = (url.searchParams.get('path') || '/').replaceAll('+', ' ');
	const { entries, fresh } = loadEntries(locals.app, params.id, dirPath);
	const repo = await getRepoMeta(locals.app, params.id);
	return {
		path: dirPath,
		drive: loadDrive(locals.app, params.id),
		repo: {
			visibility: repo?.visibility ?? 'public',
			forkedFrom: repo?.forkedFrom ?? null
		},
		entries,
		fresh
	};
};
