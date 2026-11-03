// Test doubles for the server modules. Nothing here fakes the logic under test:
// the drive is a plain in-memory tree, the meta store is a Map, and the tests
// drive the real functions.
import type { ChangeEntry } from '../src/lib/server/changelog.ts';
import type { ChangePage, SharedFile } from '../src/lib/server/shared-drive.ts';
import { mirrorsToForget } from '../src/lib/server/directory.ts';

export interface DriveStats {
	statCalls: number;
	readCalls: number;
	bytesRead: number;
	putCalls: number;
	manifestCalls: number;
	logCalls: number;
	/** Reads that were allowed to come from this peer's own replica (stamp matched). */
	replicaReads: number;
}

export interface MemoryDrive {
	files: Map<string, Buffer>;
	drive: {
		statShared(path: string): Promise<{
			exists: boolean;
			size: number;
			mtime: number | null;
			hash?: string | null;
		}>;
		readShared(path: string): AsyncGenerator<Buffer>;
		/** Same bytes, read from this peer's own replica when it holds the wanted hash. */
		readSharedVersion(path: string, stamp?: string | null): AsyncGenerator<Buffer>;
		putShared(
			path: string,
			source: AsyncIterable<Buffer | Uint8Array>,
			options?: { hash?: string | null }
		): Promise<{
			size: number;
			mtime: number | null;
			hash?: string | null;
		}>;
		deleteShared(path: string): Promise<void>;
		manifestShared(prefix?: string): Promise<SharedFile[]>;
		changesSince(cursor: number, logId?: string | null): Promise<ChangePage>;
	};
	/** The repo's change log as the fixture recorded it. */
	log: ChangeEntry[];
	/** Forget the log, so the next sync has to list the repo again. */
	forgetLog(): void;
	/** Everything written through `session.putFile`. */
	write(path: string, bytes: Buffer | Uint8Array): void;
	/** Give a fixture a real mtime; the default is 0. */
	setMtime(path: string, mtime: number): void;
	/** Round trips and bytes the peer served, so tests can prove a sync is quiet. */
	stats: DriveStats;
	resetStats(): void;
	session: any;
}

export function memoryDrive(id = 'test-repo'): MemoryDrive {
	const files = new Map<string, Buffer>();
	// Fixtures default to mtime 0 (stable digests); the sync tests set real ones.
	const mtimes = new Map<string, number>();
	// The content hash the writer supplied, which a real drive keeps as metadata.
	const hashes = new Map<string, string | null>();
	// The version stamp a real content drive derives from the entry's blob.
	const stamps = new Map<string, string>();
	let stampSeq = 0;
	const stampOf = (path: string) => stamps.get(path) ?? null;
	const mtimeOf = (path: string) => mtimes.get(path) ?? 0;
	// The host's change log: what a real SharedDrive appends on every write.
	const log: ChangeEntry[] = [];
	let logSeq = 0;
	// The log's identity, so a cursor from an older log is refused rather than
	// answered out of fresh numbers.
	let logId = `log-${id}`;
	let forgot = 0;
	const logAppend = (
		op: 'put' | 'del',
		path: string,
		size: number,
		mtime: number | null,
		hash: string | null,
		stamp: string | null = null
	) => log.push({ seq: ++logSeq, op, path, size, mtime, hash, stamp });
	const stats: DriveStats = {
		statCalls: 0,
		readCalls: 0,
		bytesRead: 0,
		putCalls: 0,
		manifestCalls: 0,
		logCalls: 0,
		replicaReads: 0
	};

	const drive = {
		key: Buffer.alloc(32, 7),
		connected: true,
		canWrite: true,
		async statShared(path: string) {
			stats.statCalls++;
			const hit = files.get(path);
			return hit
				? {
						exists: true,
						size: hit.byteLength,
						mtime: mtimeOf(path),
						hash: hashes.get(path) ?? null,
						stamp: stampOf(path)
					}
				: { exists: false, size: 0, mtime: null, hash: null, stamp: null };
		},
		async *readShared(path: string) {
			stats.readCalls++;
			const hit = files.get(path);
			if (!hit) throw new Error(`Not found: ${path}`);
			// Yield in uneven pieces so callers cannot assume one chunk per file.
			for (let at = 0; at < hit.byteLength; at += 100_000) {
				const part = hit.subarray(at, Math.min(at + 100_000, hit.byteLength));
				stats.bytesRead += part.byteLength;
				yield part;
			}
		},
		// The double is the host itself: a replica cannot be staler than it. A
		// matching stamp is what a real peer would need before reading locally.
		readSharedVersion(path: string, stamp?: string | null) {
			if (stamp && stamp === stampOf(path)) stats.replicaReads++;
			return drive.readShared(path);
		},
		async putShared(
			path: string,
			source: AsyncIterable<Buffer | Uint8Array>,
			options: { hash?: string | null } = {}
		) {
			stats.putCalls++;
			const parts: Buffer[] = [];
			for await (const chunk of source) parts.push(Buffer.from(chunk));
			const bytes = Buffer.concat(parts);
			files.set(path, bytes);
			// A real drive stamps the write and reports the resulting stat, which is
			// what the sync state records, plus the hash the writer handed over.
			mtimes.set(path, Date.now());
			hashes.set(path, options.hash ?? null);
			stamps.set(path, `s${++stampSeq}`);
			logAppend(
				'put',
				path,
				bytes.byteLength,
				mtimeOf(path),
				hashes.get(path) ?? null,
				stampOf(path)
			);
			return {
				size: bytes.byteLength,
				mtime: mtimeOf(path),
				hash: hashes.get(path) ?? null,
				stamp: stampOf(path)
			};
		},
		async deleteShared(path: string) {
			files.delete(path);
			mtimes.delete(path);
			hashes.delete(path);
			stamps.delete(path);
			logAppend('del', path, 0, null, null);
		},
		async manifestShared(prefix = '/') {
			stats.manifestCalls++;
			const out: SharedFile[] = [];
			for (const [path, bytes] of files) {
				if (prefix !== '/' && !path.startsWith(prefix)) continue;
				out.push({
					path,
					size: bytes.byteLength,
					mtime: mtimeOf(path),
					hash: hashes.get(path) ?? null,
					stamp: stampOf(path)
				});
			}
			return out.sort((a, b) => (a.path < b.path ? -1 : 1));
		},
		// Same contract as SharedDrive: a page of the log, or the whole listing when
		// this fixture cannot answer for the cursor.
		async changesSince(cursor: number, wanted?: string | null): Promise<ChangePage> {
			stats.logCalls++;
			const head = logSeq;
			const since = Math.max(0, Math.round(cursor || 0));
			const floor = log.length > 0 ? log[0].seq : head + 1;
			const listing = async () => ({
				log: logId,
				head,
				more: false,
				full: true,
				entries: [],
				listing: await drive.manifestShared('/')
			});

			if (wanted && wanted !== logId) return listing();
			if (since === 0 || since > head || since < floor - 1) return listing();

			return {
				log: logId,
				head,
				more: false,
				full: false,
				entries: log.filter((entry) => entry.seq > since),
				listing: []
			};
		}
	};

	let seq = 0;
	const session: any = {
		id,
		isGuest: false,
		drive,
		async putFile(path: string, source: AsyncIterable<Buffer | Uint8Array>) {
			const parts: Buffer[] = [];
			for await (const chunk of source) parts.push(Buffer.from(chunk));
			files.set(path, Buffer.concat(parts));
			// Written without metadata, so any hash of the previous bytes is gone.
			hashes.delete(path);
			stamps.set(path, `s${++stampSeq}`);
			logAppend('put', path, files.get(path)!.byteLength, mtimeOf(path), null, stampOf(path));
			seq++;
		},
		async deleteFile(path: string) {
			files.delete(path);
		}
	};

	return {
		files,
		drive,
		log,
		forgetLog() {
			// A recreated log: the old entries are gone and the numbering starts over,
			// which is exactly what a peer's stored cursor must not be trusted against.
			log.length = 0;
			logSeq = 0;
			logId = `log-${id}-${++forgot}`;
		},
		stats,
		resetStats() {
			stats.statCalls = 0;
			stats.readCalls = 0;
			stats.bytesRead = 0;
			stats.putCalls = 0;
			stats.manifestCalls = 0;
			stats.logCalls = 0;
			stats.replicaReads = 0;
		},
		session,
		write(path, bytes) {
			files.set(path, Buffer.from(bytes));
			// A fixture write bypasses the drive, so the hash recorded for the old bytes
			// no longer describes this content.
			hashes.delete(path);
			stamps.set(path, `s${++stampSeq}`);
			logAppend('put', path, bytes.byteLength, mtimeOf(path), null, stampOf(path));
		},
		setMtime(path, mtime) {
			mtimes.set(path, mtime);
			// A real drive stamps the time as it writes, so the log entry for this path
			// carries the same time the fixture just set.
			for (let i = log.length - 1; i >= 0; i--) {
				if (log[i].path !== path) continue;
				log[i] = { ...log[i], mtime };
				break;
			}
		}
	};
}

/** Session with a metadata store: enough for git.ts commit/ref lookups. */
export function metaSession(meta: Record<string, any[]> = {}) {
	const memory = memoryDrive();
	const store: Record<string, Map<string, any>> = {
		'@ghostdrive/refs': new Map(),
		'@ghostdrive/commits': new Map()
	};

	// The collections this suite touches are keyed differently (a ref by name, a
	// commit by sha); a single "sha ?? name" guess would silently miss the refs.
	const keyOf = (collection: string, doc: any): string =>
		collection === '@ghostdrive/refs' ? doc.name : (doc.sha ?? doc.id ?? doc.name);

	for (const [collection, rows] of Object.entries(meta)) {
		store[collection] ??= new Map();
		for (const row of rows) store[collection].set(keyOf(collection, row), row);
	}

	return Object.assign(memory.session, {
		memory,
		app: {
			key: Buffer.alloc(32, 2),
			sessions: new Map(),
			db: {
				insert: async () => {},
				flush: async () => {},
				find: () => ({ toArray: async () => [] })
			}
		},
		getMeta: async (collection: string, key: any) =>
			store[collection]?.get(key.sha ?? key.name) ?? null,
		putMeta: async (collection: string, doc: any) => {
			store[collection] ??= new Map();
			store[collection].set(keyOf(collection, doc), doc);
		},
		deleteMeta: async (collection: string, key: any) => {
			store[collection]?.delete(key.sha ?? key.name);
		},
		findMeta: async (collection: string) => [...(store[collection]?.values() ?? [])]
	});
}

export function fakeApp(overrides: Record<string, any> = {}) {
	const rows = new Map<string, any>();
	const repos = new Map<string, any>();
	const markCalls: Array<{ gone: string[]; live: string[] }> = [];
	// Guest mirrors this peer has opened, as `forgetRemovedMirrors` sees them.
	const mirrors = new Map<string, { id: string; driveKey: string; ownerKey: string | null }>();
	const forgetCalls: Array<{ peerKey: string | null; gone: string[]; live: string[] }> = [];

	const db = {
		async get(_collection: string, key: any) {
			return repos.get(key?.id) ?? null;
		},
		async insert(_collection: string, record: any) {
			rows.set(`${record.peerKey}|${record.repoId}`, { ...record });
		},
		find(_collection: string, range: any) {
			const peerKey = range?.gte?.peerKey;
			const list = [...rows.values()].filter(
				(row) => peerKey === undefined || row.peerKey === peerKey
			);
			return { toArray: async () => list };
		},
		async delete(_collection: string, key: any) {
			rows.delete(`${key.peerKey}|${key.repoId}`);
		},
		async flush() {}
	};

	const app: any = {
		key: Buffer.alloc(32, 1),
		db,
		sessions: new Map(),
		rows,
		repos,
		markCalls,
		mirrors,
		forgetCalls,
		directoryPeers: new Set<any>(),
		directoryRemotes: new Set<string>(),
		markRemovedSources(gone: string[], live: string[]) {
			markCalls.push({ gone, live });
		},
		async forgetRemovedMirrors({ peerKey = null, gone = [], live = [] }: any = {}) {
			forgetCalls.push({ peerKey, gone, live });
			const ids = mirrorsToForget([...mirrors.values()], { peerKey, gone, live });
			for (const id of ids) mirrors.delete(id);
			return ids;
		},
		...overrides
	};

	return app;
}
