import ReadyResource from 'ready-resource';
import Hyperswarm from 'hyperswarm';
import Corestore from 'corestore';
import Hyperbee from 'hyperbee2';
import HyperDB from 'hyperdb';
import { randombytes_buf, crypto_generichash } from 'sodium-native';
import b4a from 'b4a';
import path from 'path';

import DriveSession from './session.js';
import def from '../../../spec/hyperdb/index.js';
import { ensureDefaultProfile } from './users.js';
import { ensureCliToken } from './cli-token.js';
import { registerRepo } from './repos.js';
import { JobRunner } from './jobs.js';
import {
	attachDirectory,
	broadcastAnnouncements,
	pruneAnnouncements,
	refreshAnnouncements
} from './directory.js';

interface PeerHubAppOptions {
	dir?: string;
	bootstrap?: unknown;
}

export interface SessionInfo {
	id: string;
	name: string;
	icon: Buffer | Uint8Array;
	peerCount: number;
}

export interface ParsedInvite {
	keyHex: string;
	name: string | null;
	metaKeyHex: string | null;
}

export default class PeerHubApp extends ReadyResource {
	dir: string;
	bootstrap: unknown;
	store: Corestore | null;
	swarm: Hyperswarm | null;
	db: ReturnType<typeof HyperDB.bee2> | null;
	bee: Hyperbee | null;
	key: Buffer | null;
	sessions: Map<string, DriveSession>;
	/** Shared secret the local CLI must present; see ensureCliToken(). */
	cliToken: string | null;
	/** Swarm discovery for the directory topic, so the list can be refreshed. */
	private directory: any;
	private directoryTimer: ReturnType<typeof setInterval> | null;
	private directoryWarmup: Array<ReturnType<typeof setTimeout>>;
	/**
	 * Open directory channels. Lives on the app, not in a module variable: the
	 * route bundle and the app bundle get their own copy of a module, so a module
	 * level Set here would be empty on the page side and every peer to peer
	 * exchange would be skipped as "no peers".
	 */
	directoryPeers: Set<any>;
	/**
	 * Peers with an open directory channel. Used to keep a quiet-but-connected
	 * peer's announcements alive while a disappeared peer's rows expire.
	 */
	directoryRemotes: Set<string>;
	/** Long file operations that outlive the request that started them. */
	jobs: JobRunner;

	constructor({ dir = '', bootstrap = null }: PeerHubAppOptions = {}) {
		super();
		this.dir = dir;
		this.bootstrap = bootstrap;
		this.store = null;
		this.swarm = null;
		this.db = null;
		this.bee = null;
		this.key = null;
		this.sessions = new Map();
		this.cliToken = null;
		this.directory = null;
		this.directoryTimer = null;
		this.directoryWarmup = [];
		this.directoryPeers = new Set();
		this.directoryRemotes = new Set();
		this.jobs = new JobRunner();
	}

	protected async _open(): Promise<void> {
		const t0 = Date.now();
		const log = (step: string, extra = '') =>
			console.log(`[app] ${step} (+${Date.now() - t0}ms)${extra ? ' — ' + extra : ''}`);

		log('opening corestore', this.dir);
		this.store = new Corestore(path.join(this.dir, 'corestore'));
		await this.store.ready();
		log('corestore ready');

		const keyPair = await this.store.createKeyPair('ghost-drive');
		this.key = keyPair.publicKey;
		log('keypair', b4a.toString(this.key, 'hex').slice(0, 12));

		this.bee = new Hyperbee(this.store, { name: 'ghost-db' });
		this.db = HyperDB.bee2(this.bee, def);
		log('opening root db');
		await this.db!.ready();
		log('root db ready');

		this.swarm = new Hyperswarm({ bootstrap: this.bootstrap, keyPair });

		this.swarm.on('connection', (conn) => {
			conn.on('error', () => {});
			console.log('[app] swarm connection');
			this.store!.replicate(conn);
			// Every connection gets the repo-directory channel, so peers learn what
			// each other hosts without a server.
			attachDirectory(this, conn);
		});

		// A constant topic so any PeerHub peer can discover and replicate profiles.
		// The `users` collection lives in the root ghost-db bee, which the connection
		// handler above already replicates — joining the topic just finds the peers.
		//
		// The first lookup races the other peer's announce (two peers started at the
		// same time can miss each other and never retry), so discovery is refreshed
		// periodically and on demand — see refreshDirectory().
		const dirTopic = b4a.alloc(32);
		crypto_generichash(dirTopic, b4a.from('ghostdrive/directory'));
		this.directory = this.swarm.join(dirTopic);
		log('directory topic joined', b4a.toString(dirTopic, 'hex').slice(0, 12));

		const refreshMs = Number(process.env.PEERHUB_DISCOVERY_REFRESH_MS ?? 60_000);
		if (refreshMs > 0) {
			this.directoryTimer = setInterval(() => {
				this.refreshDirectory().catch(() => {});
				// Re-announce and re-ask in the same tick: our rows on a peer's side
				// stay fresh, and rows from a peer that stopped answering expire.
				void (async () => {
					await refreshAnnouncements(this).catch(() => {});
					await broadcastAnnouncements(this).catch(() => {});
					await pruneAnnouncements(this).catch(() => {});
				})();
			}, refreshMs);
			// Never a reason to keep the process alive on its own.
			this.directoryTimer.unref?.();
		}

		// The boot lookup only finds peers that had already announced — two peers
		// started together usually miss each other. Two short retries make the mesh
		// form in seconds instead of waiting for the periodic refresh.
		for (const delay of [8_000, 25_000]) {
			const timer = setTimeout(() => this.refreshDirectory().catch(() => {}), delay);
			timer.unref?.();
			this.directoryWarmup.push(timer);
		}

		await ensureDefaultProfile(this);
		log('default profile ensured');

		// Rows left by a peer that is not here any more must not wait for the first
		// refresh tick to disappear.
		await pruneAnnouncements(this).catch(() => {});

		this.cliToken = ensureCliToken(this.dir);
		log('cli token ready');

		const sessions = (await this.db!.find('@ghostdrive/sessions', {
			gte: {},
			lte: {}
		}).toArray()) as any[];
		log('sessions found', String(sessions.length));

		for (const meta of sessions) {
			const s0 = Date.now();
			log(`session ${meta.id} opening`, meta.remoteKey ? 'guest' : 'host');
			const session = new DriveSession({
				app: this,
				id: meta.id,
				name: meta.name,
				icon: meta.icon,
				key: meta.remoteKey ? b4a.from(meta.remoteKey, 'hex') : null,
				metaKey: meta.metaKey ?? null
			});
			await session.ready();
			this.sessions.set(meta.id, session);
			log(`session ${meta.id} ready`, `${Date.now() - s0}ms`);
		}

		log('open complete', `${this.sessions.size} sessions`);
	}

	protected async _close(): Promise<void> {
		if (this.directoryTimer) {
			clearInterval(this.directoryTimer);
			this.directoryTimer = null;
		}
		for (const timer of this.directoryWarmup) clearTimeout(timer);
		this.directoryWarmup = [];
		for (const session of this.sessions.values()) {
			try {
				await session.close();
			} catch {}
		}
		this.sessions.clear();
		if (this.swarm) await this.swarm.destroy();
		if (this.db) await this.db.close();
		if (this.store) await this.store.close();
	}

	// --- Session CRUD ---

	/**
	 * Re-announce and look up the directory topic. Called periodically and by the
	 * "Refresh peers" button, because the initial DHT lookup only sees peers that
	 * had already announced at that moment.
	 */
	async refreshDirectory(timeoutMs = 8000): Promise<void> {
		const discovery = this.directory;
		if (!discovery?.refresh) return;

		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
			Promise.resolve(discovery.refresh({ client: true, server: true }))
				.catch(() => {})
				.then(() => {
					clearTimeout(timer);
					resolve();
				});
		});
	}

	async createSession({
		name,
		icon,
		description,
		visibility,
		defaultBranch
	}: {
		name: string;
		icon?: Buffer;
		description?: string;
		visibility?: 'public' | 'private';
		defaultBranch?: string;
	}): Promise<DriveSession> {
		const id = randomId();
		await this.db!.insert('@ghostdrive/sessions', {
			id,
			name,
			icon: icon || b4a.alloc(0),
			createdAt: Date.now()
		});
		await this.db!.flush();

		const session = new DriveSession({ app: this, id, name, icon });
		await session.ready();
		this.sessions.set(id, session);
		await registerRepo(this, session, { description, visibility, defaultBranch });
		// Awaited: the create action redirects straight into the new repo, so a peer
		// that is already connected should have the announcement before that page
		// loads. Bounded by a timeout inside, so a slow peer cannot stall the form.
		await broadcastAnnouncements(this).catch(() => {});
		return session;
	}

	async updateSession(id: string): Promise<void> {
		await this.db!.update('@ghostdrive/sessions', { id, lastOpened: Date.now() });
		await this.db!.flush();
	}

	async removeSession(id: string): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;

		const regs = (await this.db!.find('@ghostdrive/registrations-by-session', {
			gte: { sessionId: id },
			lte: { sessionId: id }
		}).toArray()) as any[];
		for (const r of regs) {
			await this.db!.delete('@ghostdrive/registrations', { sessionId: id, target: r.target });
		}

		const invites = (await this.db!.find('@ghostdrive/invites-by-session', {
			gte: { sessionId: id },
			lte: { sessionId: id }
		}).toArray()) as any[];
		for (const i of invites) {
			await this.db!.delete('@ghostdrive/invites', { sessionId: id, capKey: i.capKey });
		}

		const joins = (await this.db!.find('@ghostdrive/joins-by-session', {
			gte: { sessionId: id },
			lte: { sessionId: id }
		}).toArray()) as any[];
		for (const j of joins) {
			await this.db!.delete('@ghostdrive/joins', { sessionId: id, peerKey: j.peerKey });
		}

		await this.db!.delete('@ghostdrive/repos', { id });
		await this.db!.delete('@ghostdrive/sessions', { id });
		await this.db!.flush();
		await session.close();
		this.sessions.delete(id);

		// Peers treat a push as our complete list, so this retires the announcement
		// instead of leaving the repo listed as public forever.
		await broadcastAnnouncements(this).catch(() => {});
	}

	// Peers report their complete repo list; a mirror whose source is no longer in
	// it belongs to a repo the owner deleted. The local copy stays (those files
	// are this peer's own), but it must stop looking like a live repo. A source
	// that announces again clears the mark.
	markRemovedSources(gone: string[], live: string[]): void {
		if (gone.length === 0 && live.length === 0) return;

		const goneSet = new Set(gone);
		const liveSet = new Set(live);
		for (const session of this.sessions.values()) {
			if (!session.isGuest || !session.drive) continue;
			const key = b4a.toString(session.drive.key, 'hex');
			if (liveSet.has(key)) session.sourceRemoved = false;
			else if (goneSet.has(key)) session.sourceRemoved = true;
		}
	}

	listSessions(): SessionInfo[] {
		return [...this.sessions.values()].map((s) => ({
			id: s.id,
			name: s.name,
			icon: s.icon as Buffer,
			peerCount: s.peerCount
		}));
	}

	getSession(id: string): DriveSession | null {
		return this.sessions.get(id) ?? null;
	}

	// --- Invites ---

	// `peerhub://` is the current scheme. `ghostdrive://` links still parse, so an
	// invite that was already sent keeps working after the rename.
	encodeInvite(session: DriveSession): string {
		const payload = JSON.stringify({
			key: b4a.toString(session.drive!.key, 'hex'),
			meta: session.metaKeyHex,
			name: session.name
		});
		return (
			'peerhub://' +
			b4a
				.toString(b4a.from(payload), 'base64')
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '')
		);
	}

	parseInvite(url: string): ParsedInvite {
		const scheme = ['peerhub://', 'ghostdrive://'].find((candidate) => url.startsWith(candidate));
		if (!scheme) throw new Error('Invalid invite scheme');
		const encoded = url.slice(scheme.length);
		const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
		const obj = JSON.parse(b4a.toString(b4a.from(padded, 'base64')));
		if (!obj.key || obj.key.length !== 64) throw new Error('Invalid invite payload');
		const metaKeyHex = typeof obj.meta === 'string' && obj.meta.length === 64 ? obj.meta : null;
		return { keyHex: obj.key, name: obj.name ?? null, metaKeyHex };
	}

	async acceptInvite(url: string): Promise<DriveSession> {
		const { keyHex, name, metaKeyHex } = this.parseInvite(url);
		const key = b4a.from(keyHex, 'hex');

		for (const session of this.sessions.values()) {
			if (session.drive?.key && b4a.equals(session.drive.key, key)) return session;
		}

		const id = randomId();
		const sessionName = name ?? 'Shared Drive';

		await this.db!.insert('@ghostdrive/sessions', {
			id,
			name: sessionName,
			icon: b4a.alloc(0),
			createdAt: Date.now(),
			remoteKey: keyHex,
			...(metaKeyHex ? { metaKey: metaKeyHex } : {}),
			lastOpened: Date.now()
		});
		await this.db!.flush();

		const session = new DriveSession({
			app: this,
			id,
			name: sessionName,
			key,
			metaKey: metaKeyHex
		});
		await session.ready();
		this.sessions.set(id, session);
		await registerRepo(this, session, { ownerKey: keyHex, visibility: 'private' });
		return session;
	}

	// --- Public repos (no invite needed) ---

	// Open a read-only view of a repo another peer announced as public. Same shape
	// as an invite join, but the keys come from the directory instead of a
	// capability link, and nothing here is writable.
	async openPublicRepo({
		driveKey,
		metaKey,
		name,
		description,
		ownerKey,
		defaultBranch
	}: {
		driveKey: string;
		metaKey: string | null;
		name: string;
		description?: string | null;
		ownerKey?: string;
		defaultBranch?: string;
	}): Promise<DriveSession> {
		const key = b4a.from(driveKey, 'hex');

		for (const session of this.sessions.values()) {
			if (session.drive?.key && b4a.equals(session.drive.key, key)) return session;
		}

		const id = randomId();
		await this.db!.insert('@ghostdrive/sessions', {
			id,
			name,
			icon: b4a.alloc(0),
			createdAt: Date.now(),
			remoteKey: driveKey,
			...(metaKey ? { metaKey } : {}),
			lastOpened: Date.now()
		});
		await this.db!.flush();

		const session = new DriveSession({ app: this, id, name, key, metaKey });
		await session.ready();
		this.sessions.set(id, session);
		await registerRepo(this, session, {
			ownerKey: ownerKey ?? driveKey,
			description: description ?? undefined,
			visibility: 'public',
			defaultBranch
		});
		return session;
	}
}

function randomId(): string {
	const buf = b4a.allocUnsafe(8);
	randombytes_buf(buf);
	return b4a.toString(buf, 'hex');
}
