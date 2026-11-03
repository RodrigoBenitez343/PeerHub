import type { PageServerLoad } from './$types';
import { getSession } from '$lib/server/loaders';
import { getRepoMeta } from '$lib/server/repos';
import { getUpdates } from '$lib/server/updates';

// The repo's Releases tab: the installers published from this repo, newest
// first, read straight out of its content drive.
//
// Nothing here is a separate index — the manifests live in the repo as
// `/release/versions/<version>.json` (signed, one per publish) and `/release/
// channel.json`, so a peer that has the repo has its releases too. The store is
// hidden from the file listing (paths.ts); this tab is where it is read.
//
// The budget is deliberately shorter than an update check's: a browser visit
// must answer even when the owner is away, and "waiting for the owner" is a
// better answer than a request that hangs.
const READ_BUDGET_MS = 4000;

export const load: PageServerLoad = async ({ locals, params }) => {
	const session = await getSession(locals.app, params.id);
	const repo = await getRepoMeta(locals.app, params.id);

	const { items, error, publisher } = await getUpdates(locals.app).releasesOf(
		session,
		READ_BUDGET_MS
	);

	return {
		drive: {
			id: session.id,
			name: session.name,
			isGuest: session.isGuest,
			canWrite: session.canWrite,
			peerCount: session.peerCount
		},
		repo: {
			visibility: repo?.visibility ?? 'public',
			forkedFrom: repo?.forkedFrom ?? null,
			sourceRemoved: !!session.sourceRemoved
		},
		publisher,
		error,
		releases: items.map((release) => ({
			version: release.version,
			notes: release.notes,
			publishedAt: release.publishedAt,
			signer: release.signer,
			verified: release.verified,
			problem: release.problem,
			assets: release.assets.map((asset) => ({
				name: asset.name,
				platform: asset.platform,
				arch: asset.arch,
				size: asset.size,
				sha256: asset.sha256,
				// Served by this repo's release route, which streams the content drive
				// — the bytes come from whichever peer holds them, this one included.
				href: `/drive/${session.id}/releases/download?path=${encodeURIComponent(asset.path)}`
			}))
		}))
	};
};
