import ReadyResource from 'ready-resource';
import Localdrive from 'localdrive';
import Hyperdrive from 'hyperdrive';
import path from 'path';
import b4a from 'b4a';
import fs from 'fs';
import SharedDrive from './shared-drive.js';
import SessionSync, { type SyncPairView, type SyncSummary } from './sync.js';
import { invalidateEntries } from './loaders.js';
import type GhostDriveApp from './app.js';

type Buf = Buffer | Uint8Array;

interface DriveSessionOptions {
	app: GhostDriveApp;
	id: string;
	name: string;
	icon?: Buf;
	key?: Buf | null;
}

export interface DriveListEntry {
	target: string;
	type: 'cache' | 'shared' | 'hyperdrive' | 'local';
}

export default class DriveSession extends ReadyResource {
	app: GhostDriveApp;
	id: string;
	name: string;
	icon: Buf;
	private _remoteKey: Buf | null;
	drive: SharedDrive | null;
	cache: Localdrive | null;
	shared: Localdrive | null;
	sharedPath: string;
	sync: SessionSync | null;
	private driveMap: Map<string, Localdrive | Hyperdrive>;

	constructor({ app, id, name, icon, key }: DriveSessionOptions) {
		super();
		this.app = app;
		this.id = id;
		this.name = name;
		this.icon = icon ?? b4a.alloc(0);
		this._remoteKey = key ?? null;
		this.drive = null;
		this.cache = null;
		this.shared = null;
		this.sharedPath = '';
		this.sync = null;
		this.driveMap = new Map();
	}

	get peerCount(): number {
		return this.drive ? this.drive.peers : 0;
	}

	get isGuest(): boolean {
		return !!this._remoteKey;
	}

	protected async _open(): Promise<void> {
		const sessionDir = path.join(this.app.dir, 'sessions', this.id);

		this.cache = new Localdrive(path.join(sessionDir, 'cache'));
		await this.cache.ready();

		// Everyone writes new files here; the host owns the folder on disk.
		this.sharedPath = path.join(sessionDir, 'shared');
		this.shared = new Localdrive(this.sharedPath, { atomic: true });
		await this.shared.ready();

		const initialDrives: (Localdrive | Hyperdrive)[] = [];

		const regs = (await this.app
			.db!.find('@ghostdrive/registrations-by-session', {
				gte: { sessionId: this.id },
				lte: { sessionId: this.id }
			})
			.toArray()) as any[];

		for (const reg of regs) {
			try {
				if (reg.type === 'local') {
					const local = new Localdrive(reg.target);
					this.driveMap.set(reg.target, local);
					initialDrives.push(local);
				} else if (reg.type === 'hyperdrive') {
					const key = b4a.from(reg.target, 'hex');
					const hd = new Hyperdrive(this.app.store!.session(), key);
					await hd.ready();
					this.driveMap.set(reg.target, hd);
					initialDrives.push(hd);
				}
			} catch (err: any) {
				console.warn(
					`session ${this.id}: failed to register ${reg.type} ${reg.target}:`,
					err.message
				);
			}
		}

		// The offline cache is mounted last: a cached copy must never shadow the
		// live shared file system while the host is reachable.
		initialDrives.push(this.shared, this.cache);

		const driveOpts: {
			drives: (Localdrive | Hyperdrive)[];
			key?: Buf;
			name?: string;
			cache: Localdrive;
			shared: Localdrive;
		} = {
			drives: initialDrives,
			cache: this.cache,
			shared: this.shared
		};

		if (this._remoteKey) {
			driveOpts.key = this._remoteKey;
		} else {
			driveOpts.name = 'ghost-drive/' + this.id;
		}

		this.drive = new SharedDrive(this.app.store!.session(), driveOpts as any);
		await this.drive!.ready();

		this.drive!.on('connected', () => {
			console.log(`[session ${this.id}] connected`);
			this.emit('peer-connected');
			this.sync?.triggerAuto();
		});

		this.drive!.on('disconnected', () => {
			console.log(`[session ${this.id}] disconnected`);
			this.emit('peer-disconnected');
		});

		// A peer changed a file: drop cached listings so the next render is fresh.
		this.drive!.on('changed', () => invalidateEntries(this.id));

		this.sync = new SessionSync(this);
		await this.sync.ready();

		console.log(
			`[session ${this.id}] opened — drives: ${this.drive!.drives.length}, key: ${b4a.toString(this.drive!.key, 'hex').slice(0, 12)}...`
		);
	}

	protected async _close(): Promise<void> {
		if (this.sync) await this.sync.close();
		this.sync = null;

		for (const drive of this.driveMap.values()) {
			try {
				await drive.close();
			} catch {}
		}
		this.driveMap.clear();
		if (this.cache) await this.cache.close();
		if (this.shared) await this.shared.close();
		if (this.drive) await this.drive.close();
	}

	// --- Drive registration ---

	async addLocalDrive(drivePath: string): Promise<void> {
		if (this.driveMap.has(drivePath)) return;

		const test = new Localdrive(drivePath);
		let valid = false;
		try {
			for await (const _ of test.readdir('/')) {
				valid = true;
				break;
			}
			if (!valid) {
				fs.accessSync(drivePath);
				valid = true;
			}
		} catch (err: any) {
			throw new Error(`Cannot access drive path: ${drivePath} (${err.message})`);
		}

		await this.app.db!.insert('@ghostdrive/registrations', {
			sessionId: this.id,
			target: drivePath,
			type: 'local',
			createdAt: Date.now()
		});
		await this.app.db!.flush();

		const local = new Localdrive(drivePath);
		this.driveMap.set(drivePath, local);
		this.drive!.register(local as any);
		this.drive!.keepCacheLast();
	}

	async addHyperdrive(hex: string): Promise<void> {
		if (this.driveMap.has(hex)) return;
		if (!/^[0-9a-f]{64}$/i.test(hex)) {
			throw new Error('Invalid hyperdrive key (expected 64-char hex)');
		}

		const key = b4a.from(hex, 'hex');
		const hd = new Hyperdrive(this.app.store!.session(), key);
		await hd.ready();
		this.driveMap.set(hex, hd);
		this.drive!.register(hd as any);
		this.drive!.keepCacheLast();

		await this.app.db!.insert('@ghostdrive/registrations', {
			sessionId: this.id,
			target: hex,
			type: 'hyperdrive',
			createdAt: Date.now()
		});
		await this.app.db!.flush();
	}

	async removeDrive(target: string): Promise<void> {
		if (target === this.sharedPath) throw new Error('The shared folder cannot be removed');

		const drive = this.driveMap.get(target);
		if (!drive) return;

		this.drive!.unregister(drive as any);
		await drive.close();
		this.driveMap.delete(target);

		await this.app.db!.delete('@ghostdrive/registrations', { sessionId: this.id, target });
		await this.app.db!.flush();
	}

	listDrives(): DriveListEntry[] {
		const list: DriveListEntry[] = [
			{ target: 'cache', type: 'cache' },
			{ target: this.sharedPath, type: 'shared' }
		];
		for (const target of this.driveMap.keys()) {
			const type = /^[0-9a-f]{64}$/i.test(target) ? 'hyperdrive' : 'local';
			list.push({ target, type });
		}
		return list;
	}

	// --- Writing to the shared file system ---

	get canWrite(): boolean {
		return !!this.drive?.canWrite;
	}

	async putFile(filePath: string, source: AsyncIterable<Buf>): Promise<void> {
		const drive = this.writableDrive();
		await drive.putShared(filePath, source);
	}

	async deleteFile(filePath: string): Promise<void> {
		const drive = this.writableDrive();
		await drive.deleteShared(filePath);
	}

	private writableDrive(): SharedDrive {
		if (!this.drive) throw new Error('Drive not ready');
		if (!this.drive.canWrite) {
			throw new Error('Not connected to the host — reconnect before changing shared files');
		}
		return this.drive;
	}

	// --- Local sync ---

	listSyncPairs(): SyncPairView[] {
		return this.sync?.list() ?? [];
	}

	async addSyncPair(localPath: string): Promise<SyncPairView> {
		return this.requireSync().add(localPath);
	}

	async removeSyncPair(id: string): Promise<void> {
		await this.requireSync().remove(id);
	}

	async setSyncAuto(id: string, auto: boolean): Promise<void> {
		await this.requireSync().setAuto(id, auto);
	}

	async runSync(id: string): Promise<SyncSummary> {
		return this.requireSync().run(id);
	}

	private requireSync(): SessionSync {
		if (!this.sync) throw new Error('Sync is not ready yet');
		return this.sync;
	}

	// --- Invites ---

	async createInvite(): Promise<{ capKey: Buffer; capKeyHex: string }> {
		const capKeyHex = b4a.toString(this.drive!.key, 'hex');
		await this.app.db!.insert('@ghostdrive/invites', {
			sessionId: this.id,
			capKey: capKeyHex,
			used: false,
			createdAt: Date.now()
		});
		await this.app.db!.flush();
		return { capKey: this.drive!.key, capKeyHex };
	}

	async listInvites(): Promise<unknown[]> {
		return this.app
			.db!.find('@ghostdrive/invites-by-session', {
				gte: { sessionId: this.id },
				lte: { sessionId: this.id }
			})
			.toArray();
	}

	async unusedInvites(): Promise<unknown[]> {
		const all = (await this.listInvites()) as any[];
		return all.filter((i) => !i.used);
	}

	async markInviteUsed(capKeyHex: string): Promise<boolean> {
		const invite = (await this.app.db!.get('@ghostdrive/invites', {
			sessionId: this.id,
			capKey: capKeyHex
		})) as any;
		if (!invite || invite.used) return false;
		await this.app.db!.insert('@ghostdrive/invites', { ...invite, used: true });
		await this.app.db!.flush();
		return true;
	}

	// --- Joins ---

	async addJoin(peerKeyHex: string, capKeyHex: string): Promise<void> {
		await this.app.db!.insert('@ghostdrive/joins', {
			sessionId: this.id,
			peerKey: peerKeyHex,
			capKey: capKeyHex,
			createdAt: Date.now()
		});
		await this.app.db!.flush();
	}

	async removeJoin(peerKeyHex: string): Promise<void> {
		await this.app.db!.delete('@ghostdrive/joins', { sessionId: this.id, peerKey: peerKeyHex });
		await this.app.db!.flush();
	}

	async listJoins(): Promise<unknown[]> {
		return this.app
			.db!.find('@ghostdrive/joins-by-session', {
				gte: { sessionId: this.id },
				lte: { sessionId: this.id }
			})
			.toArray();
	}

	// --- Utility ---

	async cacheFile(filePath: string): Promise<void> {
		const entry = await this.drive!.entry(filePath);
		if (!entry) throw new Error('file not found: ' + filePath);
		const mirror = this.drive!.mirror(this.cache as any, { prefix: filePath });
		await mirror.done();
	}

	async clearCache(): Promise<void> {
		const batch = this.cache!.batch();
		for await (const entry of this.cache!.list('/')) {
			await batch.del(entry.key);
		}
		await batch.flush();
	}
}
