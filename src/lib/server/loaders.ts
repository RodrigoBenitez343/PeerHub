import { error } from '@sveltejs/kit';
import b4a from 'b4a';
import type GhostDriveApp from './app.js';
import type DriveSession from './session.js';

type App = GhostDriveApp;
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

export async function loadEntries(app: App, id: string, dirPath: string): Promise<DriveEntry[]> {
	const session = await getSession(app, id);
	const result: DriveEntry[] = [];

	try {
		const seen = new Set<string>();
		for await (const item of session.drive!.readdir(dirPath)) {
			const name = typeof item === 'string' ? item : (item as any).key || (item as any).name;
			if (!name || name.startsWith('.')) continue;
			if (seen.has(name)) continue;
			seen.add(name);

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

			result.push({ name, isFolder, cached, size });
		}
	} catch (err) {
		console.warn('readdir failed:', err);
	}

	return result.sort((a, b) => {
		if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
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
