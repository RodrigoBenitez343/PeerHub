import { error } from '@sveltejs/kit';
import b4a from 'b4a';
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
		isGuest: session.isGuest
	};
}

const REVALIDATE_AFTER = 15_000;

interface CacheEntry {
	entries: DriveEntry[];
	ts: number;
	pending?: Promise<DriveEntry[]>;
}

const entriesCache = new Map<string, CacheEntry>();

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
		for await (const item of session.drive!.readdir(dirPath)) {
			const name = typeof item === 'string' ? item : (item as any).key || (item as any).name;
			if (!name || name.startsWith('.') || seen.has(name)) continue;
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
