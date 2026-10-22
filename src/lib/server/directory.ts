import b4a from 'b4a';
import Protomux from 'protomux';
import RPC from 'protomux-rpc';
import c from 'compact-encoding';
import type PeerHubApp from './app.js';

// Repo discovery without a server. Every peer joins one constant swarm topic
// (app.ts) and, on each connection, exchanges the list of repos it hosts over a
// small protomux-rpc channel. Announcements land in the local `announcements`
// collection, which is what the public-repo list on the home page reads.
//
// Public repos advertise their drive + metadata keys, so any peer can open a
// read-only view. Private repos advertise only name/description: the keys stay
// behind the invite link.

const PROTOCOL = 'ghostdrive/directory';
const opts = { requestEncoding: c.string, responseEncoding: c.string };

export interface Announcement {
	peerKey: string;
	repoId: string;
	name: string;
	description: string | null;
	visibility: string; // 'public' | 'private'
	defaultBranch: string;
	driveKey: string | null; // public only
	metaKey: string | null; // public only
	ts: number;
	lastSeen: number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

// Live channels, so a newly created repo can be pushed without waiting for a
// reconnect.
const peers = new Set<any>();

function selfHex(app: PeerHubApp): string {
	return app.key ? b4a.toString(app.key, 'hex') : '';
}

// What this peer hosts. Guests are skipped: re-announcing somebody else's repo
// as your own would misattribute it.
export async function ownAnnouncements(app: PeerHubApp): Promise<Announcement[]> {
	if (!app.db) return [];

	const now = Date.now();
	const out: Announcement[] = [];
	for (const session of app.sessions.values()) {
		if (session.isGuest) continue;
		const repo = (await app.db.get('@ghostdrive/repos', { id: session.id })) as any;
		out.push({
			peerKey: selfHex(app),
			repoId: session.id,
			name: session.name,
			description: repo?.description ?? null,
			visibility: repo?.visibility ?? 'public',
			defaultBranch: repo?.defaultBranch ?? 'main',
			driveKey: session.drive ? b4a.toString(session.drive.key, 'hex') : null,
			metaKey: session.metaKeyHex,
			ts: repo?.createdAt ?? now,
			lastSeen: now
		});
	}
	return out;
}

// Only take the keys when the peer actually published them, and only when they
// look like keys. Anything else is dropped instead of stored half-valid.
function sanitize(app: PeerHubApp, raw: any): Announcement | null {
	if (!raw || typeof raw.peerKey !== 'string' || raw.peerKey === selfHex(app)) return null;
	if (typeof raw.repoId !== 'string' || typeof raw.name !== 'string') return null;
	if (!raw.repoId || !raw.name) return null;

	const visibility = raw.visibility === 'private' ? 'private' : 'public';
	const driveKey =
		typeof raw.driveKey === 'string' && HEX64.test(raw.driveKey) ? raw.driveKey : null;
	const metaKey = typeof raw.metaKey === 'string' && HEX64.test(raw.metaKey) ? raw.metaKey : null;

	return {
		peerKey: raw.peerKey,
		repoId: raw.repoId,
		name: raw.name.slice(0, 120),
		description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : null,
		visibility,
		defaultBranch:
			typeof raw.defaultBranch === 'string' && raw.defaultBranch ? raw.defaultBranch : 'main',
		driveKey: visibility === 'public' ? driveKey : null,
		metaKey: visibility === 'public' ? metaKey : null,
		ts: Number(raw.ts) || Date.now(),
		lastSeen: Date.now()
	};
}

export async function ingestAnnouncements(
	app: PeerHubApp,
	payload: string | Announcement[]
): Promise<number> {
	if (!app.db) return 0;

	let list: any[];
	if (typeof payload === 'string') {
		try {
			const parsed = JSON.parse(payload);
			list = Array.isArray(parsed) ? parsed : [];
		} catch {
			return 0;
		}
	} else {
		list = Array.isArray(payload) ? payload : [];
	}

	let stored = 0;
	for (const raw of list) {
		const record = sanitize(app, raw);
		if (!record) continue;
		await app.db.insert('@ghostdrive/announcements', record);
		stored++;
	}
	if (stored > 0) await app.db.flush();
	return stored;
}

export async function listAnnouncements(app: PeerHubApp): Promise<Announcement[]> {
	if (!app.db) return [];
	const rows = (await app.db
		.find('@ghostdrive/announcements', { gte: {}, lte: {} })
		.toArray()) as Announcement[];
	return rows.sort((a, b) => b.lastSeen - a.lastSeen);
}

// --- wire ---

function respond(app: PeerHubApp, rpc: any): void {
	rpc.on('error', () => {});
	rpc.respond('announce', opts, async () => JSON.stringify(await ownAnnouncements(app)));
	rpc.respond('push', opts, async (payload: string) => {
		await ingestAnnouncements(app, payload);
		return 'ok';
	});
}

function requestFrom(app: PeerHubApp, rpc: any): void {
	const ask = () => {
		rpc
			.request('announce', '', opts)
			.then((payload: string) => ingestAnnouncements(app, payload))
			.catch(() => {});
	};
	if (rpc.opened) ask();
	else rpc.once('open', ask);
}

// Called for every swarm connection. Exactly one side opens the channel (the
// lexicographically smaller key) so both peers never open at once; the other
// side accepts it through `pair`. Either way both sides ask for the list.
export function attachDirectory(app: PeerHubApp, conn: any): void {
	let mux: any;
	try {
		mux = Protomux.from(conn);
	} catch {
		return;
	}

	const remote = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : '';
	const initiate = !remote || selfHex(app) < remote;

	if (!initiate) {
		mux.pair({ protocol: PROTOCOL }, () => {
			let rpc: any;
			try {
				rpc = new RPC(conn, { protocol: PROTOCOL });
			} catch {
				return; // channel already exists on this socket
			}
			track(app, rpc);
		});
		return;
	}

	let rpc: any;
	try {
		rpc = new RPC(conn, { protocol: PROTOCOL });
	} catch {
		return;
	}
	track(app, rpc);
}

function track(app: PeerHubApp, rpc: any): void {
	peers.add(rpc);
	rpc.on('close', () => peers.delete(rpc));
	respond(app, rpc);
	requestFrom(app, rpc);
}

// Tell everyone we are connected to about our current repo list.
export async function broadcastAnnouncements(app: PeerHubApp): Promise<void> {
	if (peers.size === 0) return;
	const payload = JSON.stringify(await ownAnnouncements(app));
	for (const rpc of peers) {
		if (!rpc.opened) continue;
		rpc.request('push', payload, opts).catch(() => {});
	}
}
