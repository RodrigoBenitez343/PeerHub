import DistributedDrive from 'distributed-drive';
import Protomux from 'protomux';
import RPC from 'protomux-rpc';
import c from 'compact-encoding';

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
}

export interface SharedStat {
	exists: boolean;
	size: number;
	mtime: number | null;
}

export interface PutResult {
	size: number;
	mtime: number | null;
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
}

// --- wire formats ---------------------------------------------------------

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
	['mtime', c.uint]
]);
const ManifestResponse = struct([['entries', c.array(c.frame(ManifestEntry))]]);
const StatResponse = struct([
	['exists', c.uint],
	['size', c.uint],
	['mtime', c.uint]
]);
const OkResponse = struct([
	['ok', c.uint],
	['error', c.string],
	['size', c.uint],
	['mtime', c.uint]
]);
const RangeRequest = struct([
	['path', c.string],
	['start', c.uint],
	['end', c.uint]
]);
const PutBeginRequest = struct([
	['id', c.string],
	['path', c.string]
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

function ok(size = 0, mtime: number | null = null) {
	return { ok: 1, error: '', size, mtime: mtime && mtime > 0 ? Math.round(mtime) : 0 };
}

function fail(err: any) {
	return { ok: 0, error: err?.message ?? String(err), size: 0, mtime: 0 };
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

// --- drive ----------------------------------------------------------------

export default class SharedDrive extends DistributedDrive {
	cache: DriveLike | null = null;
	shared: DriveLike | null = null;
	// Set by the host session: applies a repo metadata record to the writable
	// metadata core on behalf of a guest.
	onMetaWrite: ((collection: string, doc: unknown) => Promise<void>) | null = null;
	// Same, for deletes (branch removal).
	onMetaDelete: ((collection: string, key: unknown) => Promise<void>) | null = null;

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

	constructor(store: any, opts: any = {}) {
		super(store, opts);
		this.cache = opts.cache ?? null;
		this.shared = opts.shared ?? null;
		this.onMetaWrite = opts.onMetaWrite ?? null;
		this.onMetaDelete = opts.onMetaDelete ?? null;
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
		if (server) server.on('connection', (socket: any) => this._acceptWrites(socket));
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

	async manifestShared(prefix = '/'): Promise<SharedFile[]> {
		if (this.isHost) return this._localManifest(prefix);

		const rpc = await this._writeChannel();
		const res = await rpc.request('manifest', normalizePath(prefix), manifestOpts);
		return (res.entries as any[]).map((entry) => ({
			path: entry.path,
			size: entry.size,
			mtime: entry.mtime || null
		}));
	}

	async statShared(path: string): Promise<SharedStat> {
		path = normalizePath(path);
		if (this.isHost) {
			const hit = await this._findShared(path);
			if (!hit) return { exists: false, size: 0, mtime: null };
			return { exists: true, ...(await this._statOf(hit.drive, hit.key)) };
		}

		const rpc = await this._writeChannel();
		const res = await rpc.request('stat', path, statOpts);
		return { exists: !!res.exists, size: res.size, mtime: res.mtime || null };
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

	async putShared(path: string, source: AsyncIterable<Buf>): Promise<PutResult> {
		path = normalizePath(path);

		if (this.isHost) {
			const target = await this._routeWrite(path);
			await this._writeStream(target.drive, target.key, source);
			const stat = await this._statOf(target.drive, target.key);
			return { size: stat.size, mtime: stat.mtime };
		}

		const rpc = await this._writeChannel();
		const id = `${Date.now().toString(36)}-${++this._uploadSeq}`;

		const begin = await rpc.request('put-begin', { id, path }, putBeginOpts);
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
		return { size: end.size, mtime: end.mtime || null };
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
			return;
		}

		const rpc = await this._writeChannel();
		const res = await rpc.request('del', path, delOpts);
		if (!res.ok) throw new Error(res.error || 'Delete failed');
	}

	// --- local (host) side ---

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
	): Promise<{ size: number; mtime: number | null }> {
		const entry = await drive.entry(key).catch(() => null);
		if (!entry) return { size: 0, mtime: null };
		return {
			size: entry.value?.blob?.byteLength ?? 0,
			mtime: typeof entry.mtime === 'number' ? entry.mtime : null
		};
	}

	private async _localManifest(prefix: string): Promise<SharedFile[]> {
		prefix = normalizePath(prefix);
		const out = new Map<string, SharedFile>();

		for (const { drive, mount } of this._mounted()) {
			if (drive === this.cache) continue;
			const base = listBase(prefix, mount);
			if (base === null) continue;

			try {
				for await (const entry of drive.list(base)) {
					if (!entry?.key) continue;
					if (entry.value?.linkname) continue; // symlinks can't be recreated remotely
					const path = toMounted(entry.key, mount);
					if (out.has(path)) continue;
					out.set(path, {
						path,
						size: entry.value?.blob?.byteLength ?? 0,
						mtime: typeof entry.mtime === 'number' ? entry.mtime : null
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
		source: AsyncIterable<Buf>
	): Promise<void> {
		await writeIntoStream(drive.createWriteStream(key), source);
	}

	// --- RPC server side (host) ---

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

			rpc.respond('manifest', manifestOpts, (prefix: string) => this._onManifest(prefix));
			rpc.respond('stat', statOpts, (path: string) => this._onStat(path));
			rpc.respond('read', rangeOpts, (req: any) => this._onRead(req));
			rpc.respond('put-begin', putBeginOpts, (req: any) => this._onPutBegin(req));
			rpc.respond('put-chunk', putChunkOpts, (req: any) => this._onPutChunk(req));
			rpc.respond('put-end', putEndOpts, (req: any) => this._onPutEnd(req));
			rpc.respond('put-abort', putEndOpts, (req: any) => this._onPutAbort(req));
			rpc.respond('meta-put', metaPutOpts, (req: any) => this._onMetaPut(req));
			rpc.respond('meta-del', metaPutOpts, (req: any) => this._onMetaDelete(req));
			rpc.respond('del', delOpts, (path: string) => this._onDelete(path));
			rpc.respond('policy', policyOpts, () => ({ peerWrites: this.peerWrites ? 1 : 0 }));
		});
	}

	private async _onManifest(prefix: string) {
		const files = await this._localManifest(prefix);
		return {
			entries: files.map((file) => ({
				path: file.path,
				size: file.size,
				mtime: file.mtime && file.mtime > 0 ? Math.round(file.mtime) : 0
			}))
		};
	}

	private async _onStat(path: string) {
		const hit = await this._findShared(normalizePath(path));
		if (!hit) return { exists: 0, size: 0, mtime: 0 };
		const stat = await this._statOf(hit.drive, hit.key);
		return {
			exists: 1,
			size: stat.size,
			mtime: stat.mtime && stat.mtime > 0 ? Math.round(stat.mtime) : 0
		};
	}

	private async _onRead({ path, start, end }: { path: string; start: number; end: number }) {
		try {
			return await this._readRange(normalizePath(path), start, end);
		} catch {
			return EMPTY;
		}
	}

	private async _onPutBegin({ id, path }: { id: string; path: string }) {
		try {
			if (!this.peerWrites) return fail(new Error(READ_ONLY_MESSAGE));
			const normalized = normalizePath(path);
			const target = await this._routeWrite(normalized);
			const upload: Upload = {
				drive: target.drive,
				key: target.key,
				path: normalized,
				ws: target.drive.createWriteStream(target.key),
				error: null,
				bytes: 0
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
			// Typed event surface of distributed-drive stops at `on`, so announce
			// peer-driven changes through the EventEmitter it actually extends.
			(this as any).emit('changed', upload.path);
			return ok(stat.size, stat.mtime);
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
