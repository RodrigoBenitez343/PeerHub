import b4a from 'b4a';
import type PeerHubApp from './app.js';

// A human profile mapped to a device's corestore public key. Lives in the global
// `@ghostdrive/users` collection (the root ghost-db bee), which replicates to every
// peer connected on the directory topic (see app.ts). This turns the raw 32-byte
// `app.key` into something resolvable and displayable, like a GitHub user.

export interface Profile {
	peerKey: string;
	handle: string;
	displayName: string | null;
	bio: string | null;
	avatar: Uint8Array | null;
	kind: string | null; // 'user' | 'org'
	joinedAt: number;
}

export function selfKeyHex(app: PeerHubApp): string {
	return b4a.toString(app.key!, 'hex');
}

// These helpers run from inside `app._open()` (profile seeding), so they must
// never `await app.ready()` — that would wait on the open call itself and hang
// boot forever. They require the db to exist instead; route code reaches them
// through loaders.getSession(), which has already awaited ready.
function dbOf(app: PeerHubApp) {
	if (!app.db) throw new Error('PeerHub database is not open yet');
	return app.db;
}

export async function getProfile(app: PeerHubApp, peerKey: string): Promise<Profile | null> {
	return (await dbOf(app).get('@ghostdrive/users', { peerKey })) as Profile | null;
}

export async function resolveHandle(app: PeerHubApp, handle: string): Promise<Profile | null> {
	const rows = (await dbOf(app)
		.find('@ghostdrive/users-by-handle', { gte: { handle }, lte: { handle } })
		.toArray()) as Profile[];
	return rows.find((r) => r.handle === handle) ?? null;
}

// Insert-or-update by peerKey. Missing fields fall back to the previous record so a
// partial patch (e.g. just a new bio) never wipes the rest of the profile.
export async function putProfile(
	app: PeerHubApp,
	patch: Partial<Profile> & { peerKey: string }
): Promise<Profile> {
	const existing = await getProfile(app, patch.peerKey);
	const rec: Profile = {
		peerKey: patch.peerKey,
		handle: patch.handle ?? existing?.handle ?? patch.peerKey.slice(0, 8),
		displayName: patch.displayName ?? existing?.displayName ?? null,
		bio: patch.bio ?? existing?.bio ?? null,
		avatar: patch.avatar ?? existing?.avatar ?? b4a.alloc(0),
		kind: patch.kind ?? existing?.kind ?? 'user',
		joinedAt: existing?.joinedAt ?? patch.joinedAt ?? Date.now()
	};
	await dbOf(app).insert('@ghostdrive/users', rec);
	await dbOf(app).flush();
	return rec;
}

// Seed this device's own profile once, so its key always maps to a handle.
// Called from `app._open()`: db-only helpers, no ready() await.
export async function ensureDefaultProfile(app: PeerHubApp): Promise<void> {
	const peerKey = selfKeyHex(app);
	const existing = await getProfile(app, peerKey);
	console.log(`[app] profile lookup: ${existing ? existing.handle : 'none'}`);
	if (existing) return;
	await putProfile(app, { peerKey, handle: peerKey.slice(0, 8), kind: 'user' });
}

export async function listProfiles(app: PeerHubApp): Promise<Profile[]> {
	return (await dbOf(app).find('@ghostdrive/users', { gte: {}, lte: {} }).toArray()) as Profile[];
}
