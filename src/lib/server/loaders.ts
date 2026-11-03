import { error } from '@sveltejs/kit';
import b4a from 'b4a';
import { RELEASE_DIR, isReleaseStorePath, isStoreOnlyFolder } from './paths.js';
import type PeerHubApp from './app.js';
import type DriveSession from './session.js';

type App = PeerHubApp;
type Session = DriveSession;

export interface SessionInfo {
	id: string;
	name: string;
	icon: string | null;
	peerCount: number;
}

export interface DriveInfo {
	id: string;
	name: string;
	peerCount: number;
	isGuest: boolean;
	/** False for a mirror of a one-way repo: the owner has not enabled peer writes. */
	canWrite: boolean;
	writeMode: 'owner' | 'peers';
}

export interface DriveEntry {
	name: string;
	isFolder: boolean;
	cached: boolean;
	size: number | null;
}

export interface PeerInfo {
	key: string;
	short: string;
	online: boolean;
}

export async function getSession(app: App, id: string): Promise<Session> {
	await app.ready();
	const session = app.getSession(id);
	if (!session) throw error(404, 'Drive not found');
	return session;
}

export async function loadSessions(app: App): Promise<SessionInfo[]> {
	await app.ready();
	return app.listSessions().map((s: any) => ({
		id: s.id,
		name: s.name,
		icon: s.icon?.length > 0 ? bufferToDataUri(s.icon) : null,
		peerCount: s.peerCount
	}));
}

export async function loadDrive(app: App, id: string): Promise<DriveInfo> {
	const session = await getSession(app, id);
	app.updateSession(id).catch(() => {});
	return {
		id: session.id,
		name: session.name,
		peerCount: session.peerCount,
		isGuest: session.isGuest,
		canWrite: session.canWrite,
		writeMode: session.writeMode
	};
}

const REVALIDATE_AFTER = 15_000;

interface CacheEntry {
	entries: DriveEntry[];
	ts: number;
	pending?: Promise<DriveEntry[]>;
}

const entriesCache = new Map<string, CacheEntry>();

// The release store (`/release/channel.json` + the installers) is not source, so
// a repo that carries one must not open on a folder of binaries — that is what
// the Releases tab is for. Whether the folder holds anything else is a property
// of the repo, not of the request: decided once per session and reused, with a
// short bound because a guest may still be fetching the listing from a peer.
const storeFolderCache = new Map<string, Promise<boolean>>();

async function holdsOnlyReleaseStore(session: Session): Promise<boolean> {
	const content: any = session.content;
	if (!content) return false;

	const names: string[] = [];
	const scan = (async () => {
		for await (const item of content.readdir(RELEASE_DIR)) {
			const name = typeof item === 'string' ? item : (item?.key ?? item?.name);
			if (name) names.push(String(name).split('/').pop() as string);
		}
	})();

	scan.catch(() => {});
	await Promise.race([scan, new Promise((resolve) => setTimeout(resolve, 2500))]);
	return isStoreOnlyFolder(RELEASE_DIR, names);
}

function releaseFolderHidden(session: Session): Promise<boolean> {
	const hit = storeFolderCache.get(session.id);
	if (hit) return hit;
	const pending = holdsOnlyReleaseStore(session).catch(() => false);
	storeFolderCache.set(session.id, pending);
	return pending;
}

async function fetchEntries(app: App, id: string, dirPath: string): Promise<DriveEntry[]> {
	const session = await getSession(app, id);
	const seen = new Set<string>();
	const pending: Promise<DriveEntry>[] = [];

	async function resolveEntry(name: string): Promise<DriveEntry> {
		const fullPath = dirPath === '/' ? '/' + name : `${dirPath}/${name}`;
		let isFolder = false;
		let size: number | null = null;
		try {
			const entry = await session.drive!.entry(fullPath);
			isFolder = !entry || !(entry as any).value;
			if (!isFolder) {
				const blob = (entry as any)?.value?.blob;
				if (blob?.byteLength != null) size = blob.byteLength;
			}
		} catch {
			isFolder = true;
		}

		let cached = false;
		try {
			cached = !!(await session.cache!.entry(fullPath));
		} catch {}

		return { name, isFolder, cached, size };
	}

	try {
		const hideRelease = dirPath === '/' ? await releaseFolderHidden(session) : false;
		for await (const item of session.drive!.readdir(dirPath)) {
			const name = typeof item === 'string' ? item : (item as any).key || (item as any).name;
			if (!name || name.startsWith('.') || seen.has(name)) continue;
			const fullPath = dirPath === '/' ? '/' + name : `${dirPath}/${name}`;
			// Release store files are never listed; the store folder itself is
			// skipped when that is all it holds.
			if (isReleaseStorePath(fullPath)) continue;
			if (hideRelease && fullPath === RELEASE_DIR) continue;
			seen.add(name);
			pending.push(resolveEntry(name));
		}
	} catch (err) {
		console.warn('readdir failed:', err);
	}

	const entries = await Promise.all(pending);
	return entries.sort((a, b) => {
		if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

export function loadEntries(
	app: App,
	id: string,
	dirPath: string
): { entries: Promise<DriveEntry[]>; fresh: Promise<DriveEntry[]> | null } {
	const cacheKey = `${id}:${dirPath}`;
	const hit = entriesCache.get(cacheKey);

	if (!hit) {
		const p = fetchEntries(app, id, dirPath).then((entries) => {
			entriesCache.set(cacheKey, { entries, ts: Date.now() });
			return entries;
		});
		return { entries: p, fresh: null };
	}

	if (Date.now() - hit.ts < REVALIDATE_AFTER) {
		return { entries: Promise.resolve(hit.entries), fresh: null };
	}

	// Stale — return cached immediately, revalidate in background
	if (!hit.pending) {
		hit.pending = fetchEntries(app, id, dirPath)
			.then((entries) => {
				entriesCache.set(cacheKey, { entries, ts: Date.now() });
				return entries;
			})
			.finally(() => {
				const c = entriesCache.get(cacheKey);
				if (c) delete c.pending;
			});
	}

	return { entries: Promise.resolve(hit.entries), fresh: hit.pending };
}

// Drop cached directory listings after a write so the next render shows the
// change immediately instead of waiting for the revalidation window.
export function invalidateEntries(id: string): void {
	for (const key of entriesCache.keys()) {
		if (key.startsWith(`${id}:`)) entriesCache.delete(key);
	}
	storeFolderCache.delete(id);
}

export async function loadPeers(app: App, id: string): Promise<PeerInfo[]> {
	const session = await getSession(app, id);
	const result: PeerInfo[] = [];
	for await (const peer of (session.drive as any).getPeerKeys()) {
		const hex = b4a.toString(peer, 'hex');
		result.push({ key: hex, short: `${hex.slice(0, 6)}…${hex.slice(-4)}`, online: true });
	}
	return result;
}

function bufferToDataUri(buf: Buffer): string {
	const b0 = buf[0];
	const b1 = buf[1];
	let mime = 'image/png';
	if (b0 === 0xff && b1 === 0xd8) mime = 'image/jpeg';
	else if (b0 === 0x47 && b1 === 0x49) mime = 'image/gif';
	else if (b0 === 0x3c) mime = 'image/svg+xml';
	return `data:${mime};base64,${buf.toString('base64')}`;
}
