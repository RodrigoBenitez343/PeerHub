import { digestBytes } from './git.js';
import { HISTORY_PREFIX, RESERVED_ROOT } from './paths.js';
import type DriveSession from './session.js';

// Content storage for `/.peerhub/history`.
//
// A commit digest says *that* a file changed, never what it contained, so the
// changed paths are snapshotted. Copying them whole is simple and exact, but it
// is also the entire file: a 2 GB binary edited a thousand times becomes 2 TB of
// history. So a large changed file is cut into content-defined chunks and stored
// as a manifest of hashes: chunks the repo already has cost one line, chunks it
// does not have are written once.
//
// A commit therefore stores only the sections that actually changed; an
// unchanged region costs one hash in the manifest. Identical regions in two
// different files share the same stored chunk for free.
//
// Boundaries come from a rolling hash over the last few bytes, not from a fixed
// grid, so an insert or delete only disturbs its own neighbourhood: the bytes
// after it still fall into the same chunks, instead of shifting every following
// chunk. That is the property a plain fixed-size diff lacks.
//
// Small files are still copied whole — a manifest would cost more than the file
// — and the record itself tells the two apart (magic header), so every history
// entry written before chunks existed still restores.

export const CHUNKS_PREFIX = `/${RESERVED_ROOT}/chunks`;

/** Files above this are chunked; at or below it a whole copy is cheaper. */
export const DELTA_THRESHOLD = 4 * 1024 * 1024;

const CHUNK_MIN = 64 * 1024;
// Capped at 1 MiB so the chunk an edit lands in can never cost more than that.
const CHUNK_MAX = 1024 * 1024;
// Probability of a boundary per byte once past CHUNK_MIN: 1 in 2^19, so chunks
// average about 512 KiB. Smaller chunks would pin an edit more tightly but pay
// one directory entry each: a 10 GB binary is already ~20k chunks at this size.
// The mask sits on the top bits: `gear` shifts left every byte, so the top bits
// only remember the last 32 bytes. That bound is what makes an edit local.
const BOUNDARY_MASK = 0xffffe000 | 0;

// Gear table: one fixed pseudo-random weight per byte value, generated here so
// the chunking is identical on every machine and after every restart.
const GEAR = (() => {
	const table = new Int32Array(256);
	let state = 0x9e3779b9 | 0;
	for (let i = 0; i < 256; i++) {
		state = (state + 0x9e3779b9) | 0;
		let z = Math.imul(state ^ (state >>> 16), 0x85ebca6b);
		z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
		table[i] = z ^ (z >>> 16);
	}
	return table;
})();

const MAGIC = Buffer.from('PEERHUB-DELTA/1\n');

type Op = { r: string };

interface Manifest {
	size: number;
	ops: Op[];
}

export interface DeltaStats {
	/** Bytes covered by the new version. */
	size: number;
	/** Chunks the repo did not have yet. */
	stored: number;
	/** Chunks reused from earlier commits. */
	reused: number;
}

export interface GcStats {
	removed: number;
	kept: number;
	bytes: number;
	/** True when the sweep was skipped instead of deleting anything. */
	skipped: boolean;
	reason?: string;
}

/**
 * Store `source` at `target` as a manifest of chunk references.
 *
 * Chunks land in a repo-wide store keyed by content hash, so the same bytes are
 * never written twice — not across versions of one file, not across files.
 */
export async function writeDelta(
	session: DriveSession,
	target: string,
	source: AsyncIterable<Buffer | Uint8Array>
): Promise<DeltaStats> {
	const ops: Op[] = [];
	const stats: DeltaStats = { size: 0, stored: 0, reused: 0 };

	for await (const chunk of chunkify(source)) {
		stats.size += chunk.byteLength;

		const hash = digestBytes(chunk);
		const chunkPath = `${CHUNKS_PREFIX}/${hash}`;
		const existing = await session.drive!.statShared(chunkPath).catch(() => null);

		if (existing?.exists) {
			stats.reused++;
		} else {
			await session.putFile(chunkPath, once(chunk));
			stats.stored++;
		}
		ops.push({ r: hash });
	}

	const manifest: Manifest = { size: stats.size, ops };
	// The header is what tells a reader this record is a manifest, not file bytes.
	await session.putFile(
		target,
		once(Buffer.concat([MAGIC, Buffer.from(JSON.stringify(manifest))]))
	);
	return stats;
}

/**
 * Read a history record: a plain snapshot, or a manifest to be reassembled.
 *
 * The first bytes decide. Old records (and every small file) are plain content
 * and are streamed straight through, never buffered whole.
 */
export async function* readVersion(
	session: DriveSession,
	recordPath: string
): AsyncGenerator<Buffer> {
	const stream = session.drive!.readShared(recordPath)[Symbol.asyncIterator]();

	// Enough to test the magic, no more.
	const head: Buffer[] = [];
	let headBytes = 0;
	while (headBytes < MAGIC.length) {
		const next = await stream.next();
		if (next.done) break;
		const buf = toBuf(next.value);
		head.push(buf);
		headBytes += buf.byteLength;
	}

	const prefix = Buffer.concat(head, headBytes);
	if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
		if (prefix.byteLength > 0) yield prefix;
		for (;;) {
			const next = await stream.next();
			if (next.done) return;
			yield toBuf(next.value);
		}
	}

	// A manifest is small (one short entry per chunk); hold it whole.
	const rest: Buffer[] = [prefix];
	for (;;) {
		const next = await stream.next();
		if (next.done) break;
		rest.push(toBuf(next.value));
	}
	const manifest = parseManifest(Buffer.concat(rest).subarray(MAGIC.length), recordPath);

	let total = 0;
	for (const op of manifest.ops) {
		const chunkPath = `${CHUNKS_PREFIX}/${op.r}`;
		let seen = 0;
		try {
			for await (const chunk of session.drive!.readShared(chunkPath)) {
				seen += chunk.byteLength;
				total += chunk.byteLength;
				yield toBuf(chunk);
			}
		} catch (err: any) {
			// The drive throws `Not found` for a missing chunk; say what that means
			// for this record instead of surfacing a bare path.
			throw new Error(`History chunk missing: ${chunkPath} (${err?.message ?? err})`);
		}
		if (seen === 0) throw new Error(`History chunk missing: ${chunkPath} (empty)`);
	}

	if (total !== manifest.size) {
		throw new Error(
			`History record ${recordPath} is incomplete: reassembled ${total} of ${manifest.size} bytes`
		);
	}
}

function parseManifest(bytes: Buffer, recordPath: string): Manifest {
	let parsed: any;
	try {
		parsed = JSON.parse(bytes.toString('utf-8'));
	} catch {
		throw new Error(`Unreadable history record: ${recordPath}`);
	}

	const ops = parsed?.ops;
	if (typeof parsed?.size !== 'number' || !Array.isArray(ops)) {
		throw new Error(`Unreadable history record: ${recordPath}`);
	}

	for (const op of ops) {
		if (!op || typeof op !== 'object' || typeof op.r !== 'string') {
			throw new Error(`Unreadable history record: ${recordPath}`);
		}
		// A literal op from an earlier build cannot be resolved any more: its
		// payload lived in this record. Fail loudly instead of returning short data.
		if ('l' in op) throw new Error(`Unsupported history record: ${recordPath}`);
	}

	return { size: parsed.size, ops };
}

// Cut a stream into chunks at content-defined boundaries.
//
// The rolling hash is `h = (h << 1) + GEAR[byte]`: a left shift, so a byte stops
// contributing after 32 steps and the boundary depends on the current 32 bytes
// only. After an edit, chunking realigns to the old boundaries as soon as 32
// unchanged bytes have gone by — one changed chunk, not the rest of the file.
// (A multiplicative hash cannot do this: `h * k mod 2^32` keeps every earlier
// byte in its low bits forever, so nothing after an edit ever realigns.)
// The hash restarts at every boundary so a run of identical data cannot produce
// an endless chain of maximum-size chunks.
async function* chunkify(source: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<Buffer> {
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let hash = 0;

	const pack = (): Buffer => {
		const chunk = Buffer.concat(pending, pendingBytes);
		pending = [];
		pendingBytes = 0;
		hash = 0;
		return chunk;
	};

	for await (const raw of source) {
		const buf = toBuf(raw);
		let start = 0;

		for (let i = 0; i < buf.byteLength; i++) {
			hash = ((hash << 1) + GEAR[buf[i]]) | 0;
			const size = pendingBytes + (i - start + 1);
			const cut = size >= CHUNK_MAX || (size >= CHUNK_MIN && (hash & BOUNDARY_MASK) === 0);
			if (!cut) continue;

			pending.push(buf.subarray(start, i + 1));
			pendingBytes += i - start + 1;
			yield pack();
			start = i + 1;
		}

		if (start < buf.byteLength) {
			pending.push(buf.subarray(start));
			pendingBytes += buf.byteLength - start;
		}
	}

	if (pendingBytes > 0) yield pack();
}

async function* once(chunk: Buffer): AsyncGenerator<Buffer> {
	yield chunk;
}

function toBuf(chunk: Buffer | Uint8Array): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

// --- garbage collection ---------------------------------------------------
//
// A chunk is written before the manifest that references it, so an interrupted
// commit (or a crash between the two writes) leaves a chunk nothing points at.
// Those are the only orphans: commits are never deleted, and a chunk shared by
// any record is reachable from it. The sweep therefore reads every history
// record, collects the hashes it names, and deletes the rest.
//
// Three safety rules: a manifest that cannot be parsed aborts the whole sweep
// (it could reference anything), freshly written chunks are exempt for a grace
// period (an in-flight commit may not have written its manifest yet), and only
// content-addressed names are ever deleted.

const GC_STAMP = `${CHUNKS_PREFIX}/.gc`;
const GC_THROTTLE_MS = 24 * 60 * 60 * 1000;
const GC_GRACE_MS = 60 * 60 * 1000;
const GC_RECORD_MAX = 8 * 1024 * 1024;
const HASH_NAME = /^[0-9a-f]{64}$/;

export interface GcOptions {
	/** Chunks older than this are deletable; default one hour. */
	graceMs?: number;
	/** Skip a sweep that ran within this window; default one day, 0 disables. */
	throttleMs?: number;
	force?: boolean;
	now?: number;
}

/**
 * Delete chunks no history record references.
 *
 * Safe to run while a commit is in flight: new chunks are protected by the
 * grace period and an unreadable record aborts the run. Callers ignore a
 * skipped result; the next sweep tries again.
 */
export async function gcChunks(session: DriveSession, options: GcOptions = {}): Promise<GcStats> {
	const now = options.now ?? Date.now();
	const graceMs = options.graceMs ?? GC_GRACE_MS;
	const throttleMs = options.throttleMs ?? GC_THROTTLE_MS;
	const skipped = (reason: string): GcStats => ({
		removed: 0,
		kept: 0,
		bytes: 0,
		skipped: true,
		reason
	});

	const drive = session.drive;
	if (!drive) return skipped('drive not ready');
	if (!drive.connected) return skipped('not connected');
	if (!drive.canWrite) return skipped('read-only');

	if (!options.force && throttleMs > 0) {
		const stamp = await readSmall(session, GC_STAMP).catch(() => null);
		if (stamp) {
			try {
				const at = Number(JSON.parse(stamp.toString('utf-8'))?.at);
				if (Number.isFinite(at) && now - at < throttleMs) return skipped('throttled');
			} catch {
				// A corrupt stamp just means "run again".
			}
		}
	}

	const history = await drive.manifestShared(HISTORY_PREFIX).catch(() => null);
	if (!history) return skipped('history unavailable');

	const referenced = new Set<string>();
	try {
		for (const entry of history) {
			const refs = await recordRefs(session, entry.path);
			if (!refs) continue;
			for (const ref of refs) referenced.add(ref);
		}
	} catch (err: any) {
		return skipped(err?.message ?? String(err));
	}

	const store = await drive.manifestShared(CHUNKS_PREFIX).catch(() => null);
	if (!store) return skipped('chunk store unavailable');

	let removed = 0;
	let kept = 0;
	let bytes = 0;
	for (const entry of store) {
		const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
		if (!HASH_NAME.test(name)) continue; // the stamp and anything foreign
		if (referenced.has(name)) {
			kept++;
			continue;
		}
		if (entry.mtime != null && now - entry.mtime < graceMs) {
			kept++;
			continue;
		}
		await session.deleteFile(entry.path);
		removed++;
		bytes += entry.size;
	}

	if (throttleMs > 0) {
		await session.putFile(GC_STAMP, once(Buffer.from(JSON.stringify({ at: now })))).catch(() => {});
	}

	return { removed, kept, bytes, skipped: false };
}

/** Hashes named by a history record, or null when the record is a plain snapshot. */
async function recordRefs(session: DriveSession, path: string): Promise<string[] | null> {
	const stream = session.drive!.readShared(path)[Symbol.asyncIterator]();

	const head: Buffer[] = [];
	let headBytes = 0;
	while (headBytes < MAGIC.length) {
		const next = await stream.next();
		if (next.done) break;
		const buf = toBuf(next.value);
		head.push(buf);
		headBytes += buf.byteLength;
	}

	const prefix = Buffer.concat(head, headBytes);
	if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
		// A plain snapshot: no chunks to protect, and none of it is buffered.
		await stream.return?.(undefined);
		return null;
	}

	const parts: Uint8Array[] = [prefix];
	let total = prefix.byteLength;
	for (;;) {
		const next = await stream.next();
		if (next.done) break;
		const buf = toBuf(next.value);
		total += buf.byteLength;
		if (total > GC_RECORD_MAX) throw new Error(`Unreadable history record: ${path}`);
		parts.push(buf);
	}

	return parseManifest(Buffer.concat(parts).subarray(MAGIC.length), path).ops.map((op) => op.r);
}

async function readSmall(session: DriveSession, path: string): Promise<Buffer | null> {
	const parts: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of session.drive!.readShared(path)) {
		const buf = toBuf(chunk);
		size += buf.byteLength;
		if (size > 1024 * 1024) return null;
		parts.push(buf);
	}
	return Buffer.concat(parts);
}
