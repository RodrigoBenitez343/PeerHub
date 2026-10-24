// Test doubles for the server modules. Nothing here fakes the logic under test:
// the drive is a plain in-memory tree, the meta store is a Map, and the tests
// drive the real functions.
import type { SharedFile } from '../src/lib/server/shared-drive.ts';

export interface MemoryDrive {
	files: Map<string, Buffer>;
	drive: {
		statShared(path: string): Promise<{ exists: boolean; size: number; mtime: number | null }>;
		readShared(path: string): AsyncGenerator<Buffer>;
		putShared(path: string, source: AsyncIterable<Buffer | Uint8Array>): Promise<void>;
		deleteShared(path: string): Promise<void>;
		manifestShared(prefix?: string): Promise<SharedFile[]>;
	};
	/** Everything written through `session.putFile`. */
	write(path: string, bytes: Buffer | Uint8Array): void;
	/** Give a fixture a real mtime; the default is 0. */
	setMtime(path: string, mtime: number): void;
	session: any;
}

export function memoryDrive(id = 'test-repo'): MemoryDrive {
	const files = new Map<string, Buffer>();
	// Fixtures default to mtime 0 (stable digests); the sync tests set real ones.
	const mtimes = new Map<string, number>();
	const mtimeOf = (path: string) => mtimes.get(path) ?? 0;

	const drive = {
		key: Buffer.alloc(32, 7),
		connected: true,
		canWrite: true,
		async statShared(path: string) {
			const hit = files.get(path);
			return hit
				? { exists: true, size: hit.byteLength, mtime: mtimeOf(path) }
				: { exists: false, size: 0, mtime: null };
		},
		async *readShared(path: string) {
			const hit = files.get(path);
			if (!hit) throw new Error(`Not found: ${path}`);
			// Yield in uneven pieces so callers cannot assume one chunk per file.
			for (let at = 0; at < hit.byteLength; at += 100_000) {
				yield hit.subarray(at, Math.min(at + 100_000, hit.byteLength));
			}
		},
		async putShared(path: string, source: AsyncIterable<Buffer | Uint8Array>) {
			const parts: Buffer[] = [];
			for await (const chunk of source) parts.push(Buffer.from(chunk));
			files.set(path, Buffer.concat(parts));
		},
		async deleteShared(path: string) {
			files.delete(path);
			mtimes.delete(path);
		},
		async manifestShared(prefix = '/') {
			const out: SharedFile[] = [];
			for (const [path, bytes] of files) {
				if (prefix !== '/' && !path.startsWith(prefix)) continue;
				out.push({ path, size: bytes.byteLength, mtime: mtimeOf(path) });
			}
			return out.sort((a, b) => (a.path < b.path ? -1 : 1));
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
			seq++;
		},
		async deleteFile(path: string) {
			files.delete(path);
		}
	};

	return {
		files,
		drive,
		session,
		write(path, bytes) {
			files.set(path, Buffer.from(bytes));
		},
		setMtime(path, mtime) {
			mtimes.set(path, mtime);
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
		directoryPeers: new Set<any>(),
		directoryRemotes: new Set<string>(),
		markRemovedSources(gone: string[], live: string[]) {
			markCalls.push({ gone, live });
		},
		...overrides
	};

	return app;
}
