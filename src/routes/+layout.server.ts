import type { LayoutServerLoad } from './$types';
import { loadSessions } from '$lib/server/loaders';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	depends('app:layout');
	return { sessions: await loadSessions(locals.app) };
};
