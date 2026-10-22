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
import { registerRepo } from './repos.js';
import { attachDirectory, broadcastAnnouncements } from './directory.js';

interface GhostDriveAppOptions {
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

export default class GhostDriveApp extends ReadyResource {
	dir: string;
	bootstrap: unknown;
	store: Corestore | null;
	swarm: Hyperswarm | null;
	db: ReturnType<typeof HyperDB.bee2> | null;
	bee: Hyperbee | null;
	key: Buffer | null;
	sessions: Map<string, DriveSession>;

	constructor({ dir = '', bootstrap = null }: GhostDriveAppOptions = {}) {
		super();
		this.dir = dir;
		this.bootstrap = bootstrap;
		this.store = null;
		this.swarm = null;
		this.db = null;
		this.bee = null;
		this.key = null;
		this.sessions = new Map();
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
		const dirTopic = b4a.alloc(32);
		crypto_generichash(dirTopic, b4a.from('ghostdrive/directory'));
		this.swarm.join(dirTopic);
		log('directory topic joined', b4a.toString(dirTopic, 'hex').slice(0, 12));

		await ensureDefaultProfile(this);
		log('default profile ensured');

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
		broadcastAnnouncements(this).catch(() => {});
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

	encodeInvite(session: DriveSession): string {
		const payload = JSON.stringify({
			key: b4a.toString(session.drive!.key, 'hex'),
			meta: session.metaKeyHex,
			name: session.name
		});
		return (
			'ghostdrive://' +
			b4a
				.toString(b4a.from(payload), 'base64')
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '')
		);
	}

	parseInvite(url: string): ParsedInvite {
		if (!url.startsWith('ghostdrive://')) throw new Error('Invalid invite scheme');
		const encoded = url.slice('ghostdrive://'.length);
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
