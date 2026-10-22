import type { PageServerLoad } from './$types';
import { listRepoMeta } from '$lib/server/repos';
import { listAnnouncements } from '$lib/server/directory';
import { selfKeyHex } from '$lib/server/users';

// Cross-repo search: everything this device owns or opened, plus everything
// other peers announced. Private remote repos appear by name only and can only
// be entered with an invite link.

type Scope = 'all' | 'yours' | 'public' | 'private';

interface Result {
	key: string;
	kind: 'own' | 'remote';
	repoId: string;
	name: string;
	description: string | null;
	visibility: string;
	owner: string;
	ownerKey: string;
	peers: number;
	branch: string;
	driveKey: string | null;
	metaKey: string | null;
	openable: boolean;
	mirror: boolean;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.app) {
		return {
			query: '',
			scope: 'all' as Scope,
			results: [],
			counts: { all: 0, yours: 0, public: 0, private: 0 }
		};
	}
	await locals.app.ready();

	const query = (url.searchParams.get('q') ?? '').trim();
	const scopeParam = url.searchParams.get('scope') ?? 'all';
	const scope: Scope = ['all', 'yours', 'public', 'private'].includes(scopeParam)
		? (scopeParam as Scope)
		: 'all';

	const self = selfKeyHex(locals.app);
	const sessions = locals.app.sessions as Map<string, any>;
	const catalog = await listRepoMeta(locals.app);
	const announcements = await listAnnouncements(locals.app);

	const results: Result[] = [];

	for (const repo of catalog) {
		const session = sessions.get(repo.id);
		if (!session) continue;
		results.push({
			key: 'own:' + repo.id,
			kind: 'own',
			repoId: repo.id,
			name: repo.name,
			description: repo.description,
			visibility: repo.visibility,
			owner: self.slice(0, 8),
			ownerKey: self,
			peers: session.peerCount,
			branch: repo.defaultBranch,
			driveKey: session.drive ? session.drive.key.toString('hex') : null,
			metaKey: session.metaKeyHex ?? null,
			openable: true,
			mirror: !!session.isGuest
		});
	}

	const openedKeys = new Set<string>();
	for (const session of sessions.values()) {
		if (session.drive?.key) openedKeys.add(session.drive.key.toString('hex'));
	}

	for (const entry of announcements) {
		if (entry.driveKey && openedKeys.has(entry.driveKey)) continue;
		results.push({
			key: 'remote:' + entry.peerKey + ':' + entry.repoId,
			kind: 'remote',
			repoId: entry.repoId,
			name: entry.name,
			description: entry.description,
			visibility: entry.visibility,
			owner: entry.peerKey.slice(0, 8),
			ownerKey: entry.peerKey,
			peers: 0,
			branch: entry.defaultBranch,
			driveKey: entry.driveKey,
			metaKey: entry.metaKey,
			openable: entry.visibility === 'public' && !!entry.driveKey,
			mirror: false
		});
	}

	const needle = query.toLowerCase();
	const matches = (result: Result) =>
		needle.length === 0 ||
		result.name.toLowerCase().includes(needle) ||
		(result.description ?? '').toLowerCase().includes(needle) ||
		result.owner.includes(needle);

	const inScope = (result: Result) => {
		if (scope === 'yours') return result.kind === 'own';
		if (scope === 'public') return result.visibility === 'public';
		if (scope === 'private') return result.visibility === 'private';
		return true;
	};

	const filtered = results
		.filter((result) => matches(result) && inScope(result))
		.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'own' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

	const counts = {
		all: results.filter(matches).length,
		yours: results.filter((r) => r.kind === 'own' && matches(r)).length,
		public: results.filter((r) => r.visibility === 'public' && matches(r)).length,
		private: results.filter((r) => r.visibility === 'private' && matches(r)).length
	};

	return { query, scope, results: filtered, counts };
};
