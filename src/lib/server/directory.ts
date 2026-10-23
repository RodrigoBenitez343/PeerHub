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
	// 'owner' (default) or 'peers'. Lets a guest show the right state before it
	// connects; the RPC `policy` call is still the authoritative answer.
	writeMode: string;
	ts: number;
	lastSeen: number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

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
			writeMode: repo?.writeMode === 'peers' ? 'peers' : 'owner',
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
		writeMode: raw.writeMode === 'peers' ? 'peers' : 'owner',
		ts: Number(raw.ts) || Date.now(),
		lastSeen: Date.now()
	};
}

export interface PushEnvelope {
	peerKey?: string;
	repos?: unknown;
}

export async function ingestAnnouncements(
	app: PeerHubApp,
	payload: string | Announcement[] | PushEnvelope
): Promise<number> {
	if (!app.db) return 0;

	const parsed = (typeof payload === 'string' ? safeParse(payload) : payload) as
		Announcement[] | PushEnvelope | null;
	let list: any[] = [];
	let sender: string | null = null;

	if (Array.isArray(parsed)) {
		list = parsed;
	} else if (parsed && typeof parsed === 'object') {
		// Envelope form. The list is the sender's complete current set, which is
		// what lets a deleted repo disappear here instead of lingering forever.
		const envelope = parsed as PushEnvelope;
		list = Array.isArray(envelope.repos) ? (envelope.repos as any[]) : [];
		sender =
			typeof envelope.peerKey === 'string' && HEX64.test(envelope.peerKey)
				? envelope.peerKey
				: null;
	}

	let stored = 0;
	const accepted: Announcement[] = [];
	for (const raw of list) {
		const record = sanitize(app, raw);
		if (!record) continue;
		await app.db.insert('@ghostdrive/announcements', record);
		accepted.push(record);
		stored++;
	}

	// The sender's list is authoritative for the sender: drop the repos it no
	// longer hosts. A bare array carries no sender, so it is merged only.
	if (sender && sender !== selfHex(app)) {
		const live = new Set(accepted.map((record) => record.repoId));
		const known = (await app.db
			.find('@ghostdrive/announcements', { gte: { peerKey: sender }, lte: { peerKey: sender } })
			.toArray()) as Announcement[];
		for (const row of known) {
			if (live.has(row.repoId)) continue;
			await app.db.delete('@ghostdrive/announcements', {
				peerKey: row.peerKey,
				repoId: row.repoId
			});
		}
	}

	if (stored > 0 || sender) await app.db.flush();

	// A connected peer that mirrors this repo should notice a policy change
	// without reconnecting. Matched by drive key, which only public repos
	// announce; an invite-only repo learns the policy from the RPC instead.
	for (const record of accepted) {
		if (!record.driveKey) continue;
		for (const session of app.sessions.values()) {
			if (!session.isGuest || !session.drive) continue;
			if (b4a.toString(session.drive.key, 'hex') !== record.driveKey) continue;
			session.applyRemoteWriteMode(record.writeMode);
		}
	}

	return stored;
}

function safeParse(payload: string): unknown {
	try {
		return JSON.parse(payload);
	} catch {
		return null;
	}
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
	app.directoryPeers.add(rpc);
	rpc.on('close', () => app.directoryPeers.delete(rpc));
	respond(app, rpc);
	requestFrom(app, rpc);
}

// Tell everyone we are connected to about our current repo list, and wait for
// the deliveries — a repo the user just created should reach connected peers
// before the page navigates. The timer keeps a slow peer from holding a page
// action hostage.
export async function broadcastAnnouncements(app: PeerHubApp, timeoutMs = 1500): Promise<void> {
	const channels = [...app.directoryPeers].filter((rpc) => rpc.opened);
	if (channels.length === 0) return;

	const list = await ownAnnouncements(app);
	const payload = JSON.stringify({ peerKey: selfHex(app), repos: list });
	const sends = channels.map((rpc) => rpc.request('push', payload, opts).catch(() => {}));
	await settleWithTimeout(sends, timeoutMs);
}

// Ask every connected peer for its list now. Used by the home page (cheap,
// fire-and-forget) and by the Refresh button (awaited, so the reply is already
// stored when the page reloads).
export async function refreshAnnouncements(app: PeerHubApp, timeoutMs = 2000): Promise<void> {
	const channels = [...app.directoryPeers].filter((rpc) => rpc.opened);
	if (channels.length === 0) return;

	const sends = channels.map((rpc) =>
		rpc
			.request('announce', '', opts)
			.then((reply: string) => ingestAnnouncements(app, reply))
			.catch(() => {})
	);
	await settleWithTimeout(sends, timeoutMs);
}

/** Peers currently reachable on the directory channel. */
export function directoryPeerCount(app: PeerHubApp): number {
	return app.directoryPeers.size;
}

async function settleWithTimeout(sends: Array<Promise<unknown>>, timeoutMs: number): Promise<void> {
	if (sends.length === 0) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		timer.unref?.();
		Promise.allSettled(sends).then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}
