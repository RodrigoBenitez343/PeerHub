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
//
// `from` is the key of the connection the payload arrived on. When it is known it
// wins over whatever the payload claims: a peer may only speak for itself, so a
// forged `peerKey` can neither store rows under somebody else's name nor prune
// their repos from our list.
function sanitize(app: PeerHubApp, raw: any, from: string | null = null): Announcement | null {
	if (!raw || typeof raw !== 'object') return null;

	const peerKey = from ?? (typeof raw.peerKey === 'string' ? raw.peerKey : '');
	if (!HEX64.test(peerKey) || peerKey === selfHex(app)) return null;
	if (typeof raw.repoId !== 'string' || typeof raw.name !== 'string') return null;
	if (!raw.repoId || !raw.name) return null;

	const visibility = raw.visibility === 'private' ? 'private' : 'public';
	const driveKey =
		typeof raw.driveKey === 'string' && HEX64.test(raw.driveKey) ? raw.driveKey : null;
	const metaKey = typeof raw.metaKey === 'string' && HEX64.test(raw.metaKey) ? raw.metaKey : null;

	return {
		peerKey,
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
	payload: string | Announcement[] | PushEnvelope,
	from: string | null = null
): Promise<number> {
	if (!app.db) return 0;

	const transport = from && HEX64.test(from) ? from : null;
	const parsed = (typeof payload === 'string' ? safeParse(payload) : payload) as
		Announcement[] | PushEnvelope | null;
	let list: any[] = [];
	let sender: string | null = transport;

	if (Array.isArray(parsed)) {
		list = parsed;
	} else if (parsed && typeof parsed === 'object') {
		// Envelope form. The list is the sender's complete current set, which is
		// what lets a deleted repo disappear here instead of lingering forever.
		const envelope = parsed as PushEnvelope;
		list = Array.isArray(envelope.repos) ? (envelope.repos as any[]) : [];
		// Without a transport key, the payload is all we have (older peer, local call).
		sender ??=
			typeof envelope.peerKey === 'string' && HEX64.test(envelope.peerKey)
				? envelope.peerKey
				: null;
	}

	let stored = 0;
	const accepted: Announcement[] = [];
	for (const raw of list) {
		const record = sanitize(app, raw, transport);
		if (!record) continue;
		await app.db.insert('@ghostdrive/announcements', record);
		accepted.push(record);
		stored++;
	}

	// The sender's list is authoritative for the sender: drop the repos it no
	// longer hosts. A bare array carries no sender, so it is merged only.
	const removed: Announcement[] = [];
	if (sender && sender !== selfHex(app)) {
		const live = new Set(accepted.map((record) => record.repoId));
		const known = (await app.db
			.find('@ghostdrive/announcements', { gte: { peerKey: sender }, lte: { peerKey: sender } })
			.toArray()) as Announcement[];
		for (const row of known) {
			if (live.has(row.repoId)) continue;
			removed.push(row);
			await app.db.delete('@ghostdrive/announcements', {
				peerKey: row.peerKey,
				repoId: row.repoId
			});
		}
	}

	// A mirror of a repo the owner stopped announcing is this peer's own copy of
	// the files, so it is not deleted — but it must stop looking like a live
	// repo. Cleared again if the owner starts announcing it.
	const keyOf = (record: Announcement) => record.driveKey;
	const goneKeys = removed.map(keyOf).filter((key): key is string => !!key);
	const liveKeys = accepted.map(keyOf).filter((key): key is string => !!key);
	if (goneKeys.length > 0 || liveKeys.length > 0) {
		app.markRemovedSources(goneKeys, liveKeys);
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

/**
 * How long a peer's repo list stays listed without a refresh. Peers re-announce
 * on every refresh tick, well inside this window. A non-numeric override falls
 * back to the default instead of expiring everything at once.
 */
const TTL_OVERRIDE = Number(process.env.PEERHUB_ANNOUNCEMENT_TTL_MS);
export const ANNOUNCEMENT_TTL_MS =
	Number.isFinite(TTL_OVERRIDE) && TTL_OVERRIDE > 0 ? TTL_OVERRIDE : 5 * 60_000;

/**
 * Forget repos announced by peers that stopped answering.
 *
 * A deletion only reaches peers that were connected at the time; a peer that
 * went offline before it is otherwise listed forever. A row is kept while its
 * peer has an open directory channel, so a quiet-but-connected peer is never
 * expired — only a peer that is both silent and gone.
 */
export async function pruneAnnouncements(
	app: PeerHubApp,
	options: { ttlMs?: number; now?: number } = {}
): Promise<{ expired: number }> {
	if (!app.db) return { expired: 0 };

	const ttlMs = options.ttlMs ?? ANNOUNCEMENT_TTL_MS;
	const now = options.now ?? Date.now();
	const connected = app.directoryRemotes ?? new Set<string>();

	const rows = (await app.db
		.find('@ghostdrive/announcements', { gte: {}, lte: {} })
		.toArray()) as Announcement[];

	const dropped = new Set<Announcement>();
	for (const row of rows) {
		if (connected.has(row.peerKey)) continue;
		if (now - (Number(row.lastSeen) || 0) <= ttlMs) continue;
		await app.db.delete('@ghostdrive/announcements', {
			peerKey: row.peerKey,
			repoId: row.repoId
		});
		dropped.add(row);
	}

	if (dropped.size === 0) return { expired: 0 };
	await app.db.flush();

	// The dropped repos belong to a peer that is gone, so any mirror of them has
	// lost its source. Everything still listed stays live.
	const gone = rows.filter((row) => dropped.has(row) && row.driveKey).map((row) => row.driveKey!);
	const live = rows.filter((row) => !dropped.has(row) && row.driveKey).map((row) => row.driveKey!);
	app.markRemovedSources(gone, live);

	return { expired: dropped.size };
}

// --- wire ---

function respond(app: PeerHubApp, rpc: any, remote: string): void {
	rpc.on('error', () => {});
	// Envelope, not a bare array: the reply is the sender's complete set, and only
	// a reply that says *who* is speaking lets the receiver retire a repo that is
	// no longer in it. Without that, a deleted repo only disappeared when a push
	// happened to arrive — a peer that was offline at the time kept it forever,
	// and every reconnect merged it back in.
	rpc.respond('announce', opts, async () => {
		const repos = await ownAnnouncements(app);
		return JSON.stringify({ peerKey: selfHex(app), repos });
	});
	rpc.respond('push', opts, async (payload: string) => {
		await ingestAnnouncements(app, payload, remote);
		return 'ok';
	});
}

function requestFrom(app: PeerHubApp, rpc: any, remote: string): void {
	const ask = () => {
		rpc
			.request('announce', '', opts)
			.then((payload: string) => ingestAnnouncements(app, payload, remote))
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
			track(app, rpc, remote);
		});
		return;
	}

	let rpc: any;
	try {
		rpc = new RPC(conn, { protocol: PROTOCOL });
	} catch {
		return;
	}
	track(app, rpc, remote);
}

function track(app: PeerHubApp, rpc: any, remote: string): void {
	if (remote) {
		rpc._remote = remote;
		app.directoryRemotes.add(remote);
	}
	app.directoryPeers.add(rpc);
	rpc.on('close', () => {
		app.directoryPeers.delete(rpc);
		if (!remote) return;
		// A second connection to the same peer keeps it "connected".
		for (const other of app.directoryPeers) {
			if (other._remote === remote) return;
		}
		app.directoryRemotes.delete(remote);
	});
	respond(app, rpc, remote);
	requestFrom(app, rpc, remote);
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
			// Attribute the reply to the channel it arrived on, not to whatever
			// `peerKey` the payload claims: a reply may only speak for its sender.
			.then((reply: string) => ingestAnnouncements(app, reply, rpc._remote ?? null))
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
