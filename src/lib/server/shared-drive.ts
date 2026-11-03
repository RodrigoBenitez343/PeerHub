import DistributedDrive from 'distributed-drive';
import Protomux from 'protomux';
import RPC from 'protomux-rpc';
import c from 'compact-encoding';
import { isReservedRepoPath } from './paths.js';
import type ChangeLog from './changelog.js';
import type { ChangeEntry, ChangeOp } from './changelog.js';

// SharedDrive extends distributed-drive (read-only in its stock form) with a
// second, bidirectional protomux-rpc channel on the same encrypted socket. The
// stock channel keeps serving reads; this channel serves writes (put/del) and
// the manifest/range calls the sync engine needs. Whoever holds the session key
// is therefore able to change the shared file system, not just browse it.
//
// Routing rules, applied on the host (the side that owns the files):
//   - a path that already exists in a writable drive is written/deleted in that
//     drive, so editing a shared file edits the original file;
//   - a new path lands in the session's `shared` folder;
//   - the offline cache is never a write target and never shadows the shared
//     view (it is mounted last, see session.ts).

type Buf = Buffer | Uint8Array;
type DriveLike = any;

const WRITE_PROTOCOL = 'ghost-drive/shared';
const CHUNK = 1024 * 1024;
const OPEN_TIMEOUT = 10_000;
const EMPTY = Buffer.alloc(0);

// Shown to a peer that tries to write a one-way repo. Deliberately actionable:
// the fix is on the owner's side, not the guest's.
export const READ_ONLY_MESSAGE =
	'This repository is one-way: only the owner can change it. Ask the owner to enable peer writes in Settings.';

// distributed-drive keeps _open/_close out of its type declarations, so the
// lifecycle hooks are reached through the prototype instead of `super`.
const BaseDrive = DistributedDrive as any;

export interface SharedFile {
	path: string;
	size: number;
	mtime: number | null;
	/** Content hash recorded by the writer, when it knew one. */
	hash?: string | null;
	/**
	 * Version stamp of the entry (see stampOf). Only the content drive has one: it
	 * is what lets a peer prove the copy it holds is the version in question.
	 */
	stamp?: string | null;
}

export interface SharedStat {
	exists: boolean;
	size: number;
	mtime: number | null;
	hash?: string | null;
	stamp?: string | null;
}

export interface PutResult {
	size: number;
	mtime: number | null;
	hash?: string | null;
	stamp?: string | null;
}

/**
 * What one ask of the change log returns: either the paths that moved since the
 * cursor, or the whole listing when the cursor cannot be served.
 */
export interface ChangePage {
	/** Identity of the log that answered; a cursor only means something inside it. */
	log: string;
	/** Last sequence number in this page; store it and ask from there next time. */
	head: number;
	entries: ChangeEntry[];
	/** True when more entries follow `head`. */
	more: boolean;
	/** True when `listing` is the whole shared file system instead of a diff. */
	full: boolean;
	listing: SharedFile[];
}

/** What the writer knows about the bytes it is about to send. */
export interface PutOptions {
	/** Content hash of the payload, stored with the entry for later comparison. */
	hash?: string | null;
}

interface MountedDrive {
	drive: DriveLike;
	mount: string;
}

interface Upload {
	drive: DriveLike;
	key: string;
	path: string;
	ws: any;
	error: Error | null;
	bytes: number;
	hash: string | null;
}

// --- wire formats ---

/**
 * A number a `uint` field can actually carry.
 *
 * Every numeric field on this channel is a `uint`, and compact-encoding writes a
 * varint whose *length* it derives from the value: a `NaN` or a negative number
 * makes the encode throw. protomux-rpc answers a response that fails to encode by
 * sending the failed value as the message body, which throws again — uncaught,
 * in the responder's process, as `ERR_OUT_OF_RANGE` from `Buffer.allocUnsafe`.
 * A size read off an entry the drive has not downloaded is exactly that kind of
 * value, so it is clamped here instead of killing the peer that served it.
 *
 * Exported for the wire-shape tests: nothing else should need it.
 */
export function count(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return n > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.round(n);
}

/**
 * Run a responder so that it cannot reject.
 *
 * A handler that throws leaves protomux-rpc encoding the *request* value as if
 * it were the response — a string where a struct belongs — which throws again
 * outside any catch and takes the process with it. The fallback is the shape the
 * caller expects, so a failure reads like an empty answer, never a crash.
 *
 * Exported for the wire-shape tests: nothing else should need it.
 */
export function serve<T>(label: string, fallback: () => T, run: () => Promise<T> | T): Promise<T> {
	return Promise.resolve()
		.then(run)
		.catch((err: any) => {
			console.warn(`[shared-drive] rpc ${label} failed:`, err?.message ?? err);
			return fallback();
		});
}

function struct(fields: Array<[string, any]>) {
	return {
		preencode(state: any, m: any) {
			for (const [key, enc] of fields) enc.preencode(state, m[key]);
		},
		encode(state: any, m: any) {
			for (const [key, enc] of fields) enc.encode(state, m[key]);
		},
		decode(state: any) {
			const m: any = {};
			for (const [key, enc] of fields) m[key] = enc.decode(state);
			return m;
		}
	};
}

const ManifestEntry = struct([
	['path', c.string],
	['size', c.uint],
	['mtime', c.uint],
	['hash', c.string],
	['stamp', c.string]
]);
const ManifestResponse = struct([['entries', c.array(c.frame(ManifestEntry))]]);
const StatResponse = struct([
	['exists', c.uint],
	['size', c.uint],
	['mtime', c.uint],
	['hash', c.string],
	['stamp', c.string]
]);
const OkResponse = struct([
	['ok', c.uint],
	['error', c.string],
	['size', c.uint],
	['mtime', c.uint],
	['hash', c.string],
	['stamp', c.string]
]);
const RangeRequest = struct([
	['path', c.string],
	['start', c.uint],
	['end', c.uint]
]);
const PutBeginRequest = struct([
	['id', c.string],
	['path', c.string],
	['hash', c.string]
]);
const ChangeEntryWire = struct([
	['seq', c.uint],
	['op', c.uint],
	['path', c.string],
	['size', c.uint],
	['mtime', c.uint],
	['hash', c.string],
	['stamp', c.string]
]);
// Either a page of the log, or the whole listing when the cursor cannot be
// served. Both in one answer keeps a sync at one round trip either way.
const ChangesResponse = struct([
	['log', c.string],
	['head', c.uint],
	['more', c.uint],
	['full', c.uint],
	['entries', c.array(c.frame(ChangeEntryWire))],
	['listing', c.array(c.frame(ManifestEntry))]
]);
const ChangesRequest = struct([
	['since', c.uint],
	['log', c.string]
]);
const PutChunkRequest = struct([
	['id', c.string],
	['data', c.buffer]
]);
const PutEndRequest = struct([['id', c.string]]);
// Repository metadata (commits, refs, issues, PRs) is owned by the host's
// writable core. Guests forward records over this channel so everyone
// replicating the repo sees them; the collection is a server-side allowlist.
const MetaPutRequest = struct([
	['collection', c.string],
	['doc', c.string]
]);
// Write policy, answered by the host. `peerWrites` is 1 only when the owner
// turned two-way sync on for this repo.
const PolicyResponse = struct([['peerWrites', c.uint]]);

const manifestOpts = { requestEncoding: c.string, responseEncoding: ManifestResponse };
const statOpts = { requestEncoding: c.string, responseEncoding: StatResponse };
const rangeOpts = { requestEncoding: RangeRequest, responseEncoding: c.buffer };
const delOpts = { requestEncoding: c.string, responseEncoding: OkResponse };
const putBeginOpts = { requestEncoding: PutBeginRequest, responseEncoding: OkResponse };
const putChunkOpts = { requestEncoding: PutChunkRequest, responseEncoding: OkResponse };
const putEndOpts = { requestEncoding: PutEndRequest, responseEncoding: OkResponse };
const metaPutOpts = { requestEncoding: MetaPutRequest, responseEncoding: OkResponse };
const policyOpts = { requestEncoding: c.uint, responseEncoding: PolicyResponse };
const changesOpts = { requestEncoding: ChangesRequest, responseEncoding: ChangesResponse };

// --- path helpers (mirror distributed-drive's mount rules) ----------------

function normalizePath(p: string): string {
	if (!p.startsWith('/')) p = '/' + p;
	return p;
}

function within(path: string, mount: string): boolean {
	return mount === '/' || path === mount || path.startsWith(mount + '/');
}

function toLocal(path: string, mount: string): string {
	if (mount === '/') return path;
	return path === mount ? '/' : path.slice(mount.length);
}

function toMounted(key: string, mount: string): string {
	if (mount === '/') return key;
	return key === '/' ? mount : mount + key;
}

function listBase(prefix: string, mount: string): string | null {
	if (within(prefix, mount)) return toLocal(prefix, mount);
	if (mount.startsWith(prefix === '/' ? '/' : prefix + '/')) return '/';
	return null;
}

function ok(
	size = 0,
	mtime: number | null = null,
	hash: string | null = null,
	stamp: string | null = null
) {
	return {
		ok: 1,
		error: '',
		size: count(size),
		mtime: mtime && mtime > 0 ? Math.round(mtime) : 0,
		hash: hash ?? '',
		stamp: stamp ?? ''
	};
}

function fail(err: any) {
	return { ok: 0, error: err?.message ?? String(err), size: 0, mtime: 0, hash: '', stamp: '' };
}

/** A changelog answer with nothing in it, for a handler that could not run. */
function emptyChanges() {
	return { log: '', head: 0, more: 0, full: 0, entries: [], listing: [] };
}

// Hyperdrive stores no mtime of its own, so the writer records the wall clock and
// the content hash as entry metadata. That metadata is what a manifest reports —
// it travels with the entry, so a reader never has to ask for the bytes to learn
// whether they moved.
interface EntryMeta {
	mtime: number | null;
	hash: string | null;
}

/**
 * Read the metadata a writer stored with an entry.
 *
 * A Hyperdrive keeps its file table as JSON, so the Buffer written into it comes
 * back as `{ type: 'Buffer', data: [...] }` rather than as bytes — both shapes are
 * accepted here, along with a plain object for drives that keep one.
 */
export function decodeEntryMeta(raw: any): EntryMeta {
	if (!raw) return { mtime: null, hash: null };

	let parsed: any = null;
	try {
		if (typeof raw === 'string') parsed = JSON.parse(raw);
		else if (typeof raw.byteLength === 'number')
			parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
		else if (Array.isArray(raw.data)) parsed = JSON.parse(Buffer.from(raw.data).toString('utf-8'));
		else if (typeof raw === 'object') parsed = raw;
	} catch {
		return { mtime: null, hash: null };
	}

	return {
		mtime: typeof parsed?.mtime === 'number' ? parsed.mtime : null,
		hash: typeof parsed?.hash === 'string' && parsed.hash ? parsed.hash : null
	};
}

/** Metadata for a write; null when there is nothing worth storing. */
export function encodeEntryMeta(meta: EntryMeta): Buffer | null {
	if (meta.mtime == null && !meta.hash) return null;
	return Buffer.from(JSON.stringify({ mtime: meta.mtime, hash: meta.hash }));
}

function readMeta(entry: any): EntryMeta {
	return decodeEntryMeta(entry?.value?.metadata);
}

/**
 * Version stamp of a drive entry.
 *
 * A Hyperdrive has no mtime and no version number, but every write allocates its
 * own place in the data core and the entry records it. Those four numbers can
 * only come from the same write, so a peer that holds an entry with the same
 * stamp holds exactly this version — proof it can check without hashing a
 * single byte, which is what lets a large file travel as blocks instead of
 * through a request per file.
 */
export function stampOf(blob: any): string | null {
	if (!blob || typeof blob.blockOffset !== 'number' || typeof blob.blockLength !== 'number') {
		return null;
	}
	return `${blob.blockOffset}:${blob.blockLength}:${blob.byteOffset ?? 0}:${blob.byteLength ?? 0}`;
}

function concat(chunks: Buf[]): Buffer {
	if (chunks.length === 0) return EMPTY;
	if (chunks.length === 1) return Buffer.from(chunks[0]);
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function toBuffer(chunk: Buf): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

// Collapse arbitrary source chunks (network reads report 16-64KB) into
// messages large enough to keep the RPC round trips down.
async function* coalesce(source: AsyncIterable<Buf>, size = CHUNK): AsyncGenerator<Buffer> {
	let pending: Buf[] = [];
	let pendingBytes = 0;

	for await (const chunk of source) {
		if (!chunk || chunk.byteLength === 0) continue;
		pending.push(chunk);
		pendingBytes += chunk.byteLength;
		if (pendingBytes >= size) {
			yield concat(pending);
			pending = [];
			pendingBytes = 0;
		}
	}

	if (pendingBytes > 0) yield concat(pending);
}

function endStream(ws: any): Promise<void> {
	return new Promise((resolve, reject) => {
		let error: Error | null = null;
		ws.on('error', (err: Error) => {
			error = err;
		});
		ws.on('close', () => (error ? reject(error) : resolve()));
		ws.end();
	});
}

// Feed an async source into a drive write stream, honouring backpressure and
// surfacing errors from either side. Exported for the local sync engine.
export async function writeIntoStream(ws: any, source: AsyncIterable<Buf>): Promise<void> {
	for await (const chunk of source) {
		if (!chunk || chunk.byteLength === 0) continue;
		if (!ws.write(chunk)) await drained(ws);
	}
	await endStream(ws);
}

function drained(ws: any): Promise<void> {
	return new Promise((resolve, reject) => {
		const onDrain = () => (cleanup(), resolve());
		const onError = (err: Error) => (cleanup(), reject(err));
		const cleanup = () => {
			ws.off('drain', onDrain);
			ws.off('error', onError);
		};
		ws.once('drain', onDrain);
		ws.once('error', onError);
	});
}

/**
 * `entry.value` in the shape distributed-drive can put on the wire.
 *
 * Its `entry-value` schema encodes `metadata` with `c.buffer`, and a Hyperdrive
 * hands metadata back as the JSON shape of a Buffer — `{ type: 'Buffer', data }`,
 * a plain object, so `byteLength` is undefined. compact-encoding turns that into
 * a NaN size and the responder dies in `Buffer.allocUnsafe(NaN)`, in the main
 * process, right after the peer that asked for the entry loses its request.
 *
 * Every file this app's sync wrote carries that metadata, so *any* `entry` or
 * `list` answered from the content drive could do it. The rest of the value is
 * left exactly as the drive returned it.
 */
export function wireEntryValue(value: any): any {
	if (!value || typeof value !== 'object') return value;
	return { ...value, metadata: asBinary(value.metadata) };
}

function asBinary(value: any): Buffer | null {
	if (!value) return null;
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array)
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	// The JSON shape a Hyperdrive stores metadata in.
	if (Array.isArray(value.data)) return Buffer.from(value.data);
	if (typeof value === 'string') return Buffer.from(value, 'utf-8');
	// Nothing is dropped: an unexpected shape travels as the JSON bytes it already
	// is, which the reader parses straight back (see decodeEntryMeta).
	return Buffer.from(JSON.stringify(value));
}

// --- drive ----------------------------------------------------------------

export default class SharedDrive extends DistributedDrive {
	// The corestore session this drive was opened from. distributed-drive keeps it
	// but does not declare it; content cores replicate through it.
	readonly store: any;
	cache: DriveLike | null = null;
	shared: DriveLike | null = null;
	// The repo's own Hyperdrive: content lives here so peers replicate blocks
	// instead of asking this process for whole files. Writable on the owner only.
	content: DriveLike | null = null;
	// Set by the host session: applies a repo metadata record to the writable
	// metadata core on behalf of a guest.
	onMetaWrite: ((collection: string, doc: unknown) => Promise<void>) | null = null;
	// Same, for deletes (branch removal).
	onMetaDelete: ((collection: string, key: unknown) => Promise<void>) | null = null;
	// Host only: the append-only record of what changed in the shared file system.
	// Guests ask the host for it over the same channel they already use.
	changeLog: ChangeLog | null = null;

	// Repo write policy, owned by the host. Default is one-way: the owner writes,
	// every other peer replicates. A guest mirrors this value (see
	// refreshPolicy) and the host still refuses writes when it is false — the
	// flag is a courtesy, the RPC check is the gate.
	peerWrites = false;

	private _uploads = new Map<string, Upload>();
	private _writeRpcs = new Set<any>();
	private _writeRpc: any = null;
	private _writeOpening: Promise<any> | null = null;
	private _uploadSeq = 0;
	private _replicated = new WeakSet<object>();

	constructor(store: any, opts: any = {}) {
		super(store, opts);
		this.store = store;
		this.cache = opts.cache ?? null;
		this.shared = opts.shared ?? null;
		this.content = opts.content ?? null;
		this.onMetaWrite = opts.onMetaWrite ?? null;
		this.onMetaDelete = opts.onMetaDelete ?? null;
		this.changeLog = opts.changelog ?? null;
	}

	// True when this peer serves the files (it created the session) instead of
	// connecting to somebody else's.
	get isHost(): boolean {
		return !!(this as any).server;
	}

	// Reachable host: this peer is the owner, or a guest with at least one
	// connected peer. Reads and pulls only need this, not write permission.
	get connected(): boolean {
		return this.isHost || this.peers > 0;
	}

	// A guest can only change the shared file system when the host is reachable
	// *and* the owner enabled peer writes. One-way repos are the default.
	get canWrite(): boolean {
		return this.isHost || (this.peers > 0 && this.peerWrites);
	}

	get writeMode(): 'owner' | 'peers' {
		return this.peerWrites ? 'peers' : 'owner';
	}

	// Host side: apply a policy change coming from the repo owner.
	setPeerWrites(enabled: boolean): void {
		this.peerWrites = !!enabled;
	}

	// Guest side: ask the host what the current policy is. Called on connect and
	// before a write, so a toggle on the owner side takes effect without
	// reopening the repo.
	async refreshPolicy(): Promise<boolean> {
		if (this.isHost) return this.peerWrites;
		if (this.peers === 0) {
			this.peerWrites = false;
			return false;
		}

		try {
			const rpc = await this._writeChannel();
			const res = await rpc.request('policy', 0, policyOpts);
			this.peerWrites = !!res.peerWrites;
		} catch {
			// Host too old or connection dropped: stay read-only.
			this.peerWrites = false;
		}
		return this.peerWrites;
	}

	// Keep the offline cache last in the lookup order, whatever was registered
	// after it, so a stale cached copy never shadows a live file.
	keepCacheLast(): this {
		const drives = this.drives as DriveLike[];
		const index = this.cache ? drives.indexOf(this.cache) : -1;
		if (index !== -1 && index !== drives.length - 1) {
			drives.push(drives.splice(index, 1)[0]);
		}
		return this;
	}

	// distributed-drive only declares the events it emits itself; shared writes
	// add `changed`, fired on the host when a peer edits the file system.
	override on(event: 'changed', listener: (path: string) => void): this;
	override on(event: string, listener: (...args: any[]) => void): this;
	override on(event: string, listener: (...args: any[]) => void): this {
		return (BaseDrive.prototype.on as any).call(this, event, listener);
	}

	protected async _open(): Promise<void> {
		await BaseDrive.prototype._open.call(this);

		const server = (this as any).server;
		if (server) {
			server.on('connection', (socket: any) => {
				// Content is a Hyperdrive now, so its cores go over this very socket: the
				// peer pulls the blocks it asks for instead of a file per round trip.
				this._replicate(socket);
				this._acceptWrites(socket);
			});
			return;
		}

		// Guest: the same socket that carries the RPC channel also carries the
		// replication stream for the content drive.
		const rpc = (this as any)._rpc;
		if (rpc) {
			if (rpc.opened) this._replicate(rpc.stream);
			else rpc.on('open', () => this._replicate(rpc.stream));
		}
	}

	protected async _close(): Promise<void> {
		for (const upload of this._uploads.values()) {
			try {
				upload.ws.destroy();
			} catch {}
		}
		this._uploads.clear();

		for (const rpc of this._writeRpcs) {
			try {
				rpc.destroy();
			} catch {}
		}
		this._writeRpcs.clear();
		this._writeRpc = null;

		await BaseDrive.prototype._close.call(this);
	}

	// --- shared namespace API (same behaviour on host and guest) ---
	//
	// The stock answers first: distributed-drive answers `entry`, `get`, `list` and
	// `readdir` itself, and every one of those handlers re-raises a RangeError or
	// TypeError instead of skipping the drive that produced it (`safetyCatch` does
	// that on purpose). A throw there is fatal on this channel: protomux-rpc answers
	// a failed handler by echoing the *decoded request* as the message body, which
	// cannot be encoded (its size becomes NaN, `Buffer.allocUnsafe(NaN)`), and that
	// throw lands in the main process as "A JavaScript error occurred".
	//
	// So these overrides own the answers. Each one does what its stock handler
	// means to do — skip the drive that failed and report the caller's "nothing
	// here" shape — and each value handed back is one the encoding can carry.
	// `_onEntry`/`_onList` also normalize `entry.value` (see `wireEntryValue`),
	// because a Hyperdrive's metadata is not the Buffer the entry-value encoding
	// expects. `read` is already answered by this class (see `_onRead`).
	protected async _onEntry(entryPath: string): Promise<any> {
		try {
			const answer = await (BaseDrive.prototype as any)._onEntry.call(this, entryPath);
			if (answer?.entry?.value) answer.entry.value = wireEntryValue(answer.entry.value);
			return answer;
		} catch {
			return { exists: false, entry: null };
		}
	}

	protected async _onList(prefix: string): Promise<any> {
		try {
			const answer = await (BaseDrive.prototype as any)._onList.call(this, prefix);
			for (const entry of answer?.entries ?? []) entry.value = wireEntryValue(entry.value);
			return answer;
		} catch {
			return { entries: [] };
		}
	}

	protected async _onGet(filePath: string): Promise<any> {
		try {
			return await (BaseDrive.prototype as any)._onGet.call(this, filePath);
		} catch {
			return EMPTY;
		}
	}

	protected async _onReaddir(prefix: string): Promise<any> {
		try {
			return await (BaseDrive.prototype as any)._onReaddir.call(this, prefix);
		} catch {
			return { names: [] };
		}
	}

	async manifestShared(prefix = '/'): Promise<SharedFile[]> {
		if (this.isHost) return this._localManifest(prefix);

		const rpc = await this._writeChannel();
		const res = await rpc.request('manifest', normalizePath(prefix), manifestOpts);
		return (res.entries as any[]).map((entry) => ({
			path: entry.path,
			size: entry.size,
			mtime: entry.mtime || null,
			hash: entry.hash || null,
			stamp: entry.stamp || null
		}));
	}

	/**
	 * What moved since `cursor`.
	 *
	 * The answer is either a page of the change log or, when this peer cannot
	 * answer for the cursor, the whole listing — one round trip either way, so a
	 * sync never has to guess whether a diff is available.
	 */
	async changesSince(cursor: number, logId?: string | null): Promise<ChangePage> {
		const since = Math.max(0, Math.round(cursor || 0));

		if (this.isHost) return this._localChanges(since, logId ?? '');

		const rpc = await this._writeChannel();
		const res = await rpc.request('changelog', { since, log: logId ?? '' }, changesOpts);
		return {
			log: res.log,
			head: res.head,
			more: !!res.more,
			full: !!res.full,
			entries: (res.entries as any[]).map((entry) => ({
				seq: entry.seq,
				op: entry.op === 1 ? 'del' : 'put',
				path: entry.path,
				size: entry.size,
				mtime: entry.mtime || null,
				hash: entry.hash || null,
				stamp: entry.stamp || null
			})),
			listing: (res.listing as any[]).map((entry) => ({
				path: entry.path,
				size: entry.size,
				mtime: entry.mtime || null,
				hash: entry.hash || null,
				stamp: entry.stamp || null
			}))
		};
	}

	async statShared(path: string): Promise<SharedStat> {
		path = normalizePath(path);
		if (this.isHost) {
			const hit = await this._findShared(path);
			if (!hit) return { exists: false, size: 0, mtime: null, hash: null, stamp: null };
			return { exists: true, ...(await this._statOf(hit.drive, hit.key)) };
		}

		const rpc = await this._writeChannel();
		const res = await rpc.request('stat', path, statOpts);
		return {
			exists: !!res.exists,
			size: res.size,
			mtime: res.mtime || null,
			hash: res.hash || null,
			stamp: res.stamp || null
		};
	}

	// Yields the file contents from the shared namespace only — never from the
	// caller's own drives or offline cache.
	async *readShared(path: string): AsyncGenerator<Buffer> {
		path = normalizePath(path);

		if (this.isHost) {
			const hit = await this._findShared(path);
			if (!hit) throw new Error(`Not found: ${path}`);
			for await (const chunk of hit.drive.createReadStream(hit.key)) yield toBuffer(chunk);
			return;
		}

		const rpc = await this._writeChannel();
		const stat = await this.statShared(path);
		if (!stat.exists) throw new Error(`Not found: ${path}`);

		let offset = 0;
		while (offset < stat.size) {
			const end = Math.min(offset + CHUNK, stat.size);
			const buf = await rpc.request('read', { path, start: offset, end }, rangeOpts);
			if (!buf || buf.byteLength === 0) {
				throw new Error(`Read stalled at ${offset} of ${stat.size} bytes`);
			}
			yield toBuffer(buf);
			offset += buf.byteLength;
		}
	}

	// A peer reads from its own copy of the content drive when that copy holds the
	// exact version the caller was told about. The stamp is what proves it (see
	// stampOf), so a large file travels as replicated blocks instead of a request
	// per chunk; a replica that lagged behind by one write fails the comparison and
	// the host is asked, because stale bytes recorded as current would be worse
	// than slow bytes.
	async *readSharedVersion(path: string, stamp: string | null | undefined): AsyncGenerator<Buffer> {
		path = normalizePath(path);

		if (!this.isHost && stamp && this.content) {
			const entry = await this.content.entry(path).catch(() => null);
			if (entry?.value?.blob && stampOf(entry.value.blob) === stamp) {
				for await (const chunk of this.content.createReadStream(path)) yield toBuffer(chunk);
				return;
			}
		}

		yield* this.readShared(path);
	}

	async putShared(
		path: string,
		source: AsyncIterable<Buf>,
		options: PutOptions = {}
	): Promise<PutResult> {
		path = normalizePath(path);

		if (this.isHost) {
			const target = await this._routeWrite(path);
			await this._writeStream(target.drive, target.key, source, {
				mtime: Date.now(),
				hash: options.hash ?? null
			});
			const stat = await this._statOf(target.drive, target.key);
			this._log('put', path, stat);
			return {
				size: stat.size,
				mtime: stat.mtime,
				hash: stat.hash ?? null,
				stamp: stat.stamp ?? null
			};
		}

		const rpc = await this._writeChannel();
		const id = `${Date.now().toString(36)}-${++this._uploadSeq}`;

		const begin = await rpc.request(
			'put-begin',
			{ id, path, hash: options.hash ?? '' },
			putBeginOpts
		);
		if (!begin.ok) throw new Error(begin.error || 'Could not start upload');

		try {
			for await (const chunk of coalesce(source)) {
				const res = await rpc.request('put-chunk', { id, data: chunk }, putChunkOpts);
				if (!res.ok) throw new Error(res.error || 'Upload failed');
			}
		} catch (err) {
			await rpc.request('put-abort', { id }, putEndOpts).catch(() => {});
			throw err;
		}

		const end = await rpc.request('put-end', { id }, putEndOpts);
		if (!end.ok) throw new Error(end.error || 'Upload failed');
		return {
			size: end.size,
			mtime: end.mtime || null,
			hash: end.hash || null,
			stamp: end.stamp || null
		};
	}

	async putMetaRemote(collection: string, doc: unknown): Promise<void> {
		if (this.isHost) throw new Error('This peer hosts the repo metadata already');

		const rpc = await this._writeChannel();
		const res = await rpc.request(
			'meta-put',
			{ collection, doc: JSON.stringify(doc) },
			metaPutOpts
		);
		if (!res.ok) throw new Error(res.error || 'Repository metadata write failed');
	}

	async deleteMetaRemote(collection: string, key: unknown): Promise<void> {
		if (this.isHost) throw new Error('This peer hosts the repo metadata already');

		const rpc = await this._writeChannel();
		const res = await rpc.request(
			'meta-del',
			{ collection, doc: JSON.stringify(key) },
			metaPutOpts
		);
		if (!res.ok) throw new Error(res.error || 'Repository metadata delete failed');
	}

	async deleteShared(path: string): Promise<void> {
		path = normalizePath(path);

		if (this.isHost) {
			const target = await this._routeDelete(path);
			if (!target) return;
			await target.drive.del(target.key);
			this._log('del', path);
			return;
		}

		const rpc = await this._writeChannel();
		const res = await rpc.request('del', path, delOpts);
		if (!res.ok) throw new Error(res.error || 'Delete failed');
	}

	// --- local (host) side ---

	// One host write, recorded for the peers that ask for a diff later.
	private _log(
		op: ChangeOp,
		path: string,
		stat?: { size: number; mtime: number | null; hash: string | null; stamp: string | null } | null
	): void {
		this.changeLog?.append({
			op,
			path,
			size: stat?.size ?? 0,
			mtime: stat?.mtime ?? null,
			hash: stat?.hash ?? null,
			stamp: stat?.stamp ?? null
		});
	}

	private _mounted(): MountedDrive[] {
		const mounts = (this as any)._mounts as Map<DriveLike, string> | undefined;
		return (this.drives as DriveLike[]).map((drive) => ({
			drive,
			mount: mounts?.get(drive) || '/'
		}));
	}

	private _writable(drive: DriveLike): boolean {
		if (!drive || drive === this.cache) return false;
		return typeof drive.put === 'function' && drive.writable !== false;
	}

	private async _routeWrite(path: string): Promise<{ drive: DriveLike; key: string }> {
		let fallback: { drive: DriveLike; key: string } | null = null;

		for (const { drive, mount } of this._mounted()) {
			if (!within(path, mount) || !this._writable(drive)) continue;
			const key = toLocal(path, mount);
			if (!fallback) fallback = { drive, key };
			const entry = await drive.entry(key).catch(() => null);
			if (entry) return { drive, key };
		}

		// New paths land in the repo's content drive, where they replicate as blocks;
		// the old shared folder stays as a fallback for repos mid-migration.
		if (this.content && this._writable(this.content)) return { drive: this.content, key: path };
		if (this.shared) return { drive: this.shared, key: path };
		if (fallback) return fallback;
		throw new Error('No writable drive in this session');
	}

	private async _routeDelete(path: string): Promise<{ drive: DriveLike; key: string } | null> {
		for (const { drive, mount } of this._mounted()) {
			if (!within(path, mount) || !this._writable(drive)) continue;
			const key = toLocal(path, mount);
			const entry = await drive.entry(key).catch(() => null);
			if (entry) return { drive, key };
		}
		return null;
	}

	private async _findShared(
		path: string
	): Promise<{ drive: DriveLike; key: string; entry: any } | null> {
		for (const { drive, mount } of this._mounted()) {
			if (drive === this.cache || !within(path, mount)) continue;
			const key = toLocal(path, mount);
			const entry = await drive.entry(key).catch(() => null);
			if (entry && entry.value && entry.value.blob) return { drive, key, entry };
		}
		return null;
	}

	private async _statOf(
		drive: DriveLike,
		key: string
	): Promise<{ size: number; mtime: number | null; hash: string | null; stamp: string | null }> {
		const entry = await drive.entry(key).catch(() => null);
		if (!entry) return { size: 0, mtime: null, hash: null, stamp: null };
		const meta = readMeta(entry);
		return {
			size: entry.value?.blob?.byteLength ?? 0,
			// A drive that stamps its own mtime wins; a Hyperdrive has none, so the
			// metadata written with the entry is the record of when it changed.
			mtime: typeof entry.mtime === 'number' ? entry.mtime : meta.mtime,
			hash: meta.hash,
			stamp: this._stampOfEntry(drive, entry)
		};
	}

	// Only the content drive is replicated to peers, so only it can prove a
	// replica's version. A mounted folder's blob numbers mean nothing (a plain
	// folder reports zeros), and publishing them would invite a false match.
	private _stampOfEntry(drive: DriveLike, entry: any): string | null {
		if (drive !== this.content) return null;
		return stampOf(entry?.value?.blob);
	}

	private async _localManifest(prefix: string): Promise<SharedFile[]> {
		prefix = normalizePath(prefix);
		const out = new Map<string, SharedFile>();
		// `/.peerhub` is the repo's own bookkeeping (history, chunk store) and grows
		// with every commit. A root listing never carries it: every consumer filters
		// it out anyway, and putting it on the wire makes each manifest cost more the
		// longer the history gets.
		const skipReserved = prefix === '/';

		for (const { drive, mount } of this._mounted()) {
			if (drive === this.cache) continue;
			const base = listBase(prefix, mount);
			if (base === null) continue;

			try {
				for await (const entry of drive.list(base)) {
					if (!entry?.key) continue;
					if (entry.value?.linkname) continue; // symlinks can't be recreated remotely
					const path = toMounted(entry.key, mount);
					if (skipReserved && isReservedRepoPath(path)) continue;
					if (out.has(path)) continue;
					const meta = readMeta(entry);
					out.set(path, {
						path,
						size: entry.value?.blob?.byteLength ?? 0,
						mtime: typeof entry.mtime === 'number' ? entry.mtime : meta.mtime,
						hash: meta.hash,
						stamp: this._stampOfEntry(drive, entry)
					});
				}
			} catch {
				// A registered Hyperdrive may still be syncing; keep what we have.
			}
		}

		return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	private async _readRange(path: string, start: number, endExclusive: number): Promise<Buffer> {
		const hit = await this._findShared(path);
		if (!hit) return EMPTY;

		const want = endExclusive - start;
		if (want <= 0) return EMPTY;

		const chunks: Buffer[] = [];
		let have = 0;

		// Localdrive treats `end` as inclusive and Hyperdrive as exclusive, so ask
		// for the inclusive bound and trim to the requested window.
		for await (const chunk of hit.drive.createReadStream(hit.key, { start, end: endExclusive })) {
			chunks.push(toBuffer(chunk));
			have += chunk.byteLength;
			if (have >= want) break;
		}

		return concat(chunks).subarray(0, want);
	}

	private async _writeStream(
		drive: DriveLike,
		key: string,
		source: AsyncIterable<Buf>,
		meta?: EntryMeta
	): Promise<void> {
		// Only a drive that stores metadata gets one; a plain folder has nowhere to
		// put it and falls back to its own stat.
		const encoded = meta ? encodeEntryMeta(meta) : null;
		const opts = encoded && drive.supportsMetadata === true ? { metadata: encoded } : {};
		await writeIntoStream(drive.createWriteStream(key, opts), source);
	}

	// --- RPC server side (host) ---

	// Attach corestore replication to a socket once. A second attach on the same
	// stream throws inside corestore, so the socket is remembered.
	private _replicate(socket: any): void {
		if (!socket || this._replicated.has(socket)) return;
		this._replicated.add(socket);
		try {
			this.store.replicate(socket);
		} catch (err: any) {
			// Replication is how content travels now; a socket that cannot carry it
			// still answers RPC reads, so say what happened instead of pretending.
			console.warn('content replication not attached on this connection:', err?.message ?? err);
		}
	}

	private _acceptWrites(socket: any): void {
		let mux: any;
		try {
			mux = Protomux.from(socket);
		} catch {
			return;
		}

		// Pair instead of opening eagerly: an unanswered incoming channel-open is
		// rejected by protomux, so the guest's open must find a pair handler here.
		mux.pair({ protocol: WRITE_PROTOCOL }, () => {
			let rpc: any;
			try {
				rpc = new RPC(socket, { protocol: WRITE_PROTOCOL });
			} catch {
				return; // already paired on this socket
			}

			this._writeRpcs.add(rpc);
			rpc.on('close', () => this._writeRpcs.delete(rpc));
			rpc.on('error', () => {});

			// Every handler is wrapped: a rejection must come back as an empty
			// answer, because protomux-rpc cannot encode one and dies trying.
			rpc.respond('manifest', manifestOpts, (prefix: string) =>
				serve(
					'manifest',
					() => ({ entries: [] }),
					() => this._onManifest(prefix)
				)
			);
			rpc.respond('stat', statOpts, (path: string) =>
				serve(
					'stat',
					() => ({ exists: 0, size: 0, mtime: 0, hash: '', stamp: '' }),
					() => this._onStat(path)
				)
			);
			rpc.respond('read', rangeOpts, (req: any) =>
				serve(
					'read',
					() => EMPTY,
					() => this._onRead(req)
				)
			);
			rpc.respond('put-begin', putBeginOpts, (req: any) =>
				serve(
					'put-begin',
					() => fail(new Error('Upload refused')),
					() => this._onPutBegin(req)
				)
			);
			rpc.respond('put-chunk', putChunkOpts, (req: any) =>
				serve(
					'put-chunk',
					() => fail(new Error('Upload refused')),
					() => this._onPutChunk(req)
				)
			);
			rpc.respond('put-end', putEndOpts, (req: any) =>
				serve(
					'put-end',
					() => fail(new Error('Upload refused')),
					() => this._onPutEnd(req)
				)
			);
			rpc.respond('put-abort', putEndOpts, (req: any) =>
				serve(
					'put-abort',
					() => fail(new Error('No upload to abort')),
					() => this._onPutAbort(req)
				)
			);
			rpc.respond('meta-put', metaPutOpts, (req: any) =>
				serve(
					'meta-put',
					() => fail(new Error('Write refused')),
					() => this._onMetaPut(req)
				)
			);
			rpc.respond('meta-del', metaPutOpts, (req: any) =>
				serve(
					'meta-del',
					() => fail(new Error('Write refused')),
					() => this._onMetaDelete(req)
				)
			);
			rpc.respond('del', delOpts, (path: string) =>
				serve(
					'del',
					() => fail(new Error('Delete refused')),
					() => this._onDelete(path)
				)
			);
			rpc.respond('policy', policyOpts, () => ({ peerWrites: this.peerWrites ? 1 : 0 }));
			rpc.respond('changelog', changesOpts, (req: any) =>
				serve(
					'changelog',
					() => emptyChanges(),
					() => this._onChanges(req)
				)
			);
		});
	}

	private async _onChanges({ since, log }: { since: number; log: string }) {
		const page = await this._localChanges(Math.max(0, Math.round(since) || 0), log ?? '');
		return {
			log: page.log,
			head: count(page.head),
			more: page.more ? 1 : 0,
			full: page.full ? 1 : 0,
			entries: page.entries.map((entry) => ({
				seq: count(entry.seq),
				op: entry.op === 'del' ? 1 : 0,
				path: entry.path,
				size: count(entry.size),
				mtime: count(entry.mtime),
				hash: entry.hash ?? '',
				stamp: entry.stamp ?? ''
			})),
			listing: page.listing.map((file) => ({
				path: file.path,
				size: count(file.size),
				mtime: count(file.mtime),
				hash: file.hash ?? '',
				stamp: file.stamp ?? ''
			}))
		};
	}

	// The answer both a local sync and the RPC handler hand out.
	private async _localChanges(since: number, logId: string): Promise<ChangePage> {
		// The head is read *before* the listing: a write that lands while the drive
		// is being walked is then replayed next run instead of being skipped.
		const head = this.changeLog?.head ?? 0;
		const log = this.changeLog?.id ?? '';
		const page = since > 0 ? (this.changeLog?.window(since, logId) ?? null) : null;
		if (page) {
			return {
				log,
				head: page.head,
				more: page.more,
				full: false,
				entries: page.entries,
				listing: []
			};
		}

		return {
			log,
			head,
			more: false,
			full: true,
			entries: [],
			listing: await this._localManifest('/')
		};
	}

	private async _onManifest(prefix: string) {
		const files = await this._localManifest(prefix);
		return {
			entries: files.map((file) => ({
				path: file.path,
				size: count(file.size),
				mtime: count(file.mtime),
				hash: file.hash ?? '',
				stamp: file.stamp ?? ''
			}))
		};
	}

	private async _onStat(path: string) {
		const hit = await this._findShared(normalizePath(path));
		if (!hit) return { exists: 0, size: 0, mtime: 0, hash: '', stamp: '' };
		const stat = await this._statOf(hit.drive, hit.key);
		return {
			exists: 1,
			size: count(stat.size),
			mtime: count(stat.mtime),
			hash: stat.hash ?? '',
			stamp: stat.stamp ?? ''
		};
	}

	private async _onRead({ path, start, end }: { path: string; start: number; end: number }) {
		try {
			return await this._readRange(normalizePath(path), start, end);
		} catch {
			return EMPTY;
		}
	}

	private async _onPutBegin({ id, path, hash }: { id: string; path: string; hash?: string }) {
		try {
			if (!this.peerWrites) return fail(new Error(READ_ONLY_MESSAGE));
			const normalized = normalizePath(path);
			const target = await this._routeWrite(normalized);
			const encoded = encodeEntryMeta({ mtime: Date.now(), hash: hash ? hash : null });
			const opts = encoded && target.drive.supportsMetadata === true ? { metadata: encoded } : {};
			const upload: Upload = {
				drive: target.drive,
				key: target.key,
				path: normalized,
				ws: target.drive.createWriteStream(target.key, opts),
				error: null,
				bytes: 0,
				hash: hash ? hash : null
			};
			upload.ws.on('error', (err: Error) => {
				upload.error = err;
			});
			this._uploads.set(id, upload);
			return ok();
		} catch (err) {
			return fail(err);
		}
	}

	private _onPutChunk({ id, data }: { id: string; data: Buffer }) {
		const upload = this._uploads.get(id);
		if (!upload) return fail(new Error('Unknown upload'));
		if (upload.error) return fail(upload.error);
		try {
			upload.bytes += data.byteLength;
			upload.ws.write(data);
			return ok();
		} catch (err) {
			return fail(err);
		}
	}

	private async _onPutEnd({ id }: { id: string }) {
		const upload = this._uploads.get(id);
		if (!upload) return fail(new Error('Unknown upload'));
		this._uploads.delete(id);

		try {
			await endStream(upload.ws);
			if (upload.error) throw upload.error;
			const stat = await this._statOf(upload.drive, upload.key);
			// A peer's write is a repo write: it goes into the log like its own.
			this._log('put', upload.path, stat);
			// Typed event surface of distributed-drive stops at `on`, so announce
			// peer-driven changes through the EventEmitter it actually extends.
			(this as any).emit('changed', upload.path);
			return ok(stat.size, stat.mtime, stat.hash ?? null, stat.stamp ?? null);
		} catch (err) {
			return fail(err);
		}
	}

	private _onPutAbort({ id }: { id: string }) {
		const upload = this._uploads.get(id);
		if (upload) {
			this._uploads.delete(id);
			try {
				upload.ws.destroy();
			} catch {}
		}
		return ok();
	}

	private async _onMetaPut({ collection, doc }: { collection: string; doc: string }) {
		try {
			if (!this.peerWrites) throw new Error(READ_ONLY_MESSAGE);
			if (!this.onMetaWrite) throw new Error('This repo does not accept metadata writes');
			let parsed: unknown;
			try {
				parsed = JSON.parse(doc);
			} catch {
				throw new Error('Malformed metadata record');
			}
			if (!parsed || typeof parsed !== 'object') throw new Error('Malformed metadata record');
			await this.onMetaWrite(collection, parsed);
			return ok();
		} catch (err) {
			return fail(err);
		}
	}

	private async _onMetaDelete({ collection, doc }: { collection: string; doc: string }) {
		try {
			if (!this.peerWrites) throw new Error(READ_ONLY_MESSAGE);
			if (!this.onMetaDelete) throw new Error('This repo does not accept metadata deletes');
			let parsed: unknown;
			try {
				parsed = JSON.parse(doc);
			} catch {
				throw new Error('Malformed metadata key');
			}
			if (!parsed || typeof parsed !== 'object') throw new Error('Malformed metadata key');
			await this.onMetaDelete(collection, parsed);
			return ok();
		} catch (err) {
			return fail(err);
		}
	}

	private async _onDelete(path: string) {
		try {
			if (!this.peerWrites) return fail(new Error(READ_ONLY_MESSAGE));
			const normalized = normalizePath(path);
			const target = await this._routeDelete(normalized);
			if (!target) return ok();
			await target.drive.del(target.key);
			this._log('del', normalized);
			(this as any).emit('changed', normalized);
			return ok();
		} catch (err) {
			return fail(err);
		}
	}

	// --- RPC client side (guest) ---

	private async _writeChannel(): Promise<any> {
		if (this._writeRpc && !this._writeRpc.closed) return this._writeRpc;
		if (this._writeOpening) return this._writeOpening;

		const parent = (this as any)._rpc;
		if (!parent) throw new Error('Not connected to the host');

		const opening = (async () => {
			const rpc: any = new RPC(parent.stream, { protocol: WRITE_PROTOCOL });
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					try {
						rpc.destroy();
					} catch {}
					reject(
						new Error('Host does not accept shared writes (no response) — update PeerHub on it')
					);
				}, OPEN_TIMEOUT);

				rpc.once('open', () => {
					clearTimeout(timer);
					resolve();
				});
				rpc.once('close', () => {
					clearTimeout(timer);
					reject(new Error('Connection closed before the write channel opened'));
				});
			});

			this._writeRpc = rpc;
			rpc.on('close', () => {
				if (this._writeRpc === rpc) this._writeRpc = null;
			});
			return rpc;
		})().finally(() => {
			this._writeOpening = null;
		});

		this._writeOpening = opening;
		return opening;
	}
}
