import fs from 'fs';
import path from 'path';
import Localdrive from 'localdrive';
import b4a from 'b4a';
import { randombytes_buf } from 'sodium-native';

import { writeIntoStream } from './shared-drive.js';
import type SharedDrive from './shared-drive.js';
import type { ChangePage, SharedFile } from './shared-drive.js';
import { invalidateEntries } from './loaders.js';
import { loadIgnoreSources } from './ignores.js';
import { isReservedRepoPath } from './paths.js';
import { DIGEST_SIZE_CAP, digestBytes } from './git.js';
import { compileIgnore, type IgnoreMatcher, type IgnoreSource } from '$lib/ignore';
import type DriveSession from './session.js';

// Local folder sync. One-way by default: the repo is the source of truth and a
// linked folder is a checkout that follows it. That is the same default the
// repo itself has (owner → peers).
//
// A one-way folder receives, so a file it holds that the repo does not have can
// never be pushed anywhere. Two rules follow, and they are the user's choice:
// by default such a file is kept and counted as pending local work; with the
// pair's `prune` on, it is deleted, and the folder mirrors the repo exactly.
//
// Two-way is opt-in per folder: only then can a local edit, addition or
// deletion reach the repo. Even then the newer side wins per path, so a stale
// folder can never overwrite a version that moved after it — the propagation
// rule is newest → oldest, not "whoever syncs last".
//
// The last known state of each path is kept per side, so a copy is only redone
// when that side actually changed — a fresh mtime on the receiving side can
// never bounce back and forth.
//
// The repo side is not listed from scratch every run. The owner keeps a change
// log (see changelog.ts), the state remembers how far it was consumed, and a run
// asks for "everything after N": the paths that did not move are not even named,
// so a large repo costs what its changes cost. A repo that cannot answer for the
// cursor (no log, trimmed past it, an older peer) sends the whole listing and the
// run carries on exactly as it did before.
//
// mtime alone is not enough: an editor can rewrite a file with the same length
// inside the two-second tolerance, and that edit used to be invisible (a commit
// would snapshot the old bytes). Small files therefore also store a content
// digest in the state, consulted exactly in that ambiguous window. Large files
// keep the size+mtime rule, where hashing would cost more than the copy.

const AUTO_INTERVAL = 15_000;
const MTIME_SLACK = 2000;
const DIGEST_CAP = DIGEST_SIZE_CAP;
// A file in flight reports itself every PROGRESS_STEP bytes, and only above
// PROGRESS_MIN: below that the wait is shorter than the line would live.
const PROGRESS_STEP = 1024 * 1024;
const PROGRESS_MIN = 2 * 1024 * 1024;
const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const TEMP_SUFFIX = '.localdrive.tmp';

/** 'pull' = repo → folder only (default). 'two-way' = the folder may push. */
export type SyncDirection = 'pull' | 'two-way';

export interface SyncPair {
	id: string;
	path: string;
	auto: boolean;
	/** When true, an automatic pass that moved files also records a commit. */
	autoCommit: boolean;
	/** Default 'pull'. Anything else must be chosen by the user. */
	direction: SyncDirection;
	/**
	 * One-way only: remove local files the repo does not have, so the folder stays
	 * an exact checkout of the repo. Off by default — it deletes files nothing else
	 * can bring back, so the user has to ask for it.
	 */
	prune: boolean;
	createdAt: number;
	lastSyncAt: number | null;
	lastResult: string | null;
}

export interface SyncPairView extends SyncPair {
	running: boolean;
}

/** One step of a run, reported live so the CLI can print a running list. */
export interface SyncProgress {
	/** 'scan' is the walk and the plan; the rest are files that moved. */
	kind: 'scan' | 'upload' | 'download' | 'delete';
	path: string;
	/**
	 * Files decided so far, counted against `total`. A byte tick repeats the count
	 * of the file in flight, because it is not a new file.
	 */
	done: number;
	/** Files this run will decide. Absent while the folder is still being walked. */
	total?: number;
	/** What those files add up to, so a caller can say how much has to move. */
	totalBytes?: number;
	/** Files the folder walk has seen so far; only on a 'scan' event. */
	scanned?: number;
	/** Size of the file in flight, when either side says what it is. */
	size?: number;
	/** Bytes of that file through so far; absent on the event that starts it. */
	loaded?: number;
}

export type SyncProgressFn = (ev: SyncProgress) => void;

export interface SyncSummary {
	added: number;
	updated: number;
	deleted: number;
	conflicts: number;
	/** Local files the repo does not have, kept because the folder does not mirror. */
	skipped: number;
	errors: string[];
	/** Paths the repo's change log reported for this run. */
	changes: number;
	/** Where the repo's file list came from: the log, or a full listing. */
	source: 'log' | 'listing';
}

interface SideStat {
	size: number;
	mtime: number | null;
	/** Content hash for files up to DIGEST_CAP; absent for large files and old state. */
	digest?: string;
	/** Version stamp of the repo's copy, when it lives in the content drive. */
	stamp?: string;
}

interface StateEntry {
	local?: SideStat;
	shared?: SideStat;
}

/** Result of asking one side whether it moved away from the recorded state. */
interface Probe {
	changed: boolean;
	/** Digest of the current copy, when deciding that required reading it. */
	digest?: string;
}

/** What `record` may trust instead of measuring a side again. */
interface RecordHints {
	/** The local file as it stands now; null means it is gone. */
	local?: SideStat | null;
	/** The shared file as it stands now; null means it is gone. */
	shared?: SideStat | null;
	/** Digest already computed from the local copy. */
	localProbe?: string;
	/** Digest already computed from the shared copy. */
	sharedProbe?: string;
}

// Digest taken while the bytes are already in flight, so recording the new state
// costs neither side a second read. Files above DIGEST_CAP stop buffering and
// report no digest, exactly like cappedDigest.
class DigestTap {
	bytes = 0;
	private parts: Uint8Array[] = [];
	private over = false;

	async *through(source: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<Buffer> {
		for await (const chunk of source) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			this.bytes += buf.byteLength;
			if (!this.over) {
				if (this.bytes > DIGEST_CAP) {
					this.over = true;
					this.parts = [];
				} else this.parts.push(buf);
			}
			yield buf;
		}
	}

	digest(): string | undefined {
		if (this.over) return undefined;
		return digestBytes(Buffer.concat(this.parts));
	}
}

// Bytes of one file while it is in flight, so a large transfer shows how far it
// got instead of looking stuck. It holds nothing: the chunks pass through.
class ProgressTap {
	private loaded = 0;
	private reported = 0;
	private size: number | null;
	private emit: (loaded: number) => void;

	constructor(size: number | null, emit: (loaded: number) => void) {
		this.size = size;
		this.emit = emit;
	}

	async *through(source: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<Buffer> {
		for await (const chunk of source) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			this.loaded += buf.byteLength;
			if (
				this.size !== null &&
				this.size >= PROGRESS_MIN &&
				this.loaded - this.reported >= PROGRESS_STEP
			) {
				this.reported = this.loaded;
				this.emit(this.loaded);
			}
			yield buf;
		}

		// One last tick closes the file: the caller knows the copy is complete and
		// the line it was printing can be finished.
		if (this.reported > 0 && this.loaded !== this.reported) this.emit(this.loaded);
	}
}

type SyncState = {
	paths: Record<string, StateEntry>;
	/** Change-log sequence this folder has consumed; 0 when it never had one. */
	cursor: number;
	/** Which log that cursor belongs to; empty when there is none. */
	log: string;
};

export default class SessionSync {
	private session: DriveSession;
	private dir: string;
	private configFile: string;
	private stateDir: string;
	private pairs: SyncPair[] = [];
	private timers = new Map<string, ReturnType<typeof setInterval>>();
	private running = new Set<string>();
	private closed = false;

	constructor(session: DriveSession) {
		this.session = session;
		this.dir = path.join(session.app.dir, 'sessions', session.id);
		this.configFile = path.join(this.dir, 'sync-pairs.json');
		this.stateDir = path.join(this.dir, 'sync-state');
	}

	async ready(): Promise<void> {
		this.pairs = this.load();

		for (const pair of this.pairs) {
			if (pair.auto) this.schedule(pair);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const timer of this.timers.values()) clearInterval(timer);
		this.timers.clear();
	}

	list(): SyncPairView[] {
		return this.pairs.map((pair) => ({ ...pair, running: this.running.has(pair.id) }));
	}

	add(localPath: string): SyncPairView {
		const resolved = path.resolve((localPath ?? '').trim());
		if (!localPath?.trim()) throw new Error('Folder path required');

		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch {
			throw new Error(`Folder not found: ${resolved}`);
		}
		if (!stat.isDirectory()) throw new Error('Pick a folder, not a file');

		const appDir = path.resolve(this.session.app.dir);
		if (isInside(resolved, appDir) || isInside(appDir, resolved)) {
			throw new Error('Pick a folder outside PeerHub storage');
		}
		if (this.pairs.some((pair) => path.relative(pair.path, resolved) === '')) {
			throw new Error('This folder is already being synced');
		}

		const pair: SyncPair = {
			id: randomId(),
			path: resolved,
			auto: false,
			autoCommit: false,
			direction: 'pull',
			prune: false,
			createdAt: Date.now(),
			lastSyncAt: null,
			lastResult: null
		};

		this.pairs.push(pair);
		this.save();
		return { ...pair, running: false };
	}

	remove(id: string): void {
		const index = this.pairs.findIndex((pair) => pair.id === id);
		if (index === -1) return;

		const timer = this.timers.get(id);
		if (timer) clearInterval(timer);
		this.timers.delete(id);

		this.pairs.splice(index, 1);
		this.save();

		try {
			fs.unlinkSync(this.stateFile(id));
		} catch {}
	}

	setAuto(id: string, auto: boolean, autoCommit?: boolean, direction?: SyncDirection): void {
		const pair = this.pairs.find((p) => p.id === id);
		if (!pair) throw new Error('Sync folder not found');

		pair.auto = auto;
		pair.autoCommit = auto ? (autoCommit ?? pair.autoCommit) : false;
		if (direction) pair.direction = direction;
		this.save();

		const timer = this.timers.get(pair.id);
		if (timer) clearInterval(timer);
		this.timers.delete(pair.id);
		if (auto) this.schedule(pair);
	}

	setDirection(id: string, direction: SyncDirection): void {
		const pair = this.pairs.find((p) => p.id === id);
		if (!pair) throw new Error('Sync folder not found');
		pair.direction = direction === 'two-way' ? 'two-way' : 'pull';
		this.save();
	}

	/** Make a one-way folder an exact checkout: local extras are deleted. */
	setPrune(id: string, prune: boolean): void {
		const pair = this.pairs.find((p) => p.id === id);
		if (!pair) throw new Error('Sync folder not found');
		pair.prune = !!prune;
		this.save();
	}

	async run(
		id: string,
		options: { direction?: SyncDirection; prune?: boolean; onProgress?: SyncProgressFn } = {}
	): Promise<SyncSummary> {
		const pair = this.pairs.find((p) => p.id === id);
		if (!pair) throw new Error('Sync folder not found');
		if (this.running.has(id)) throw new Error('This folder is already syncing');

		return this.exclusive(pair, options.direction, options.prune, options.onProgress);
	}

	// Called when a peer connects: catch up on anything that moved meanwhile.
	triggerAuto(): void {
		for (const pair of this.pairs) {
			if (pair.auto) void this.runAuto(pair);
		}
	}

	private schedule(pair: SyncPair): void {
		if (this.closed || this.timers.has(pair.id)) return;

		const timer = setInterval(() => void this.runAuto(pair), AUTO_INTERVAL);
		if (typeof (timer as any).unref === 'function') (timer as any).unref();
		this.timers.set(pair.id, timer);
	}

	private async runAuto(pair: SyncPair): Promise<void> {
		if (this.closed) return;
		if (this.running.has(pair.id)) return;
		// Pulling needs a reachable owner, not write permission.
		if (!this.session.drive?.connected) return;

		try {
			await this.exclusive(pair);
		} catch {
			// lastResult already records why; auto runs stay quiet.
		}
	}

	private async exclusive(
		pair: SyncPair,
		direction?: SyncDirection,
		prune?: boolean,
		onProgress?: SyncProgressFn
	): Promise<SyncSummary> {
		this.running.add(pair.id);

		try {
			const summary = await syncOnce(this.session, pair, this.stateFile(pair.id), {
				direction: direction ?? pair.direction,
				prune: prune ?? pair.prune,
				onProgress
			});
			pair.lastSyncAt = Date.now();
			pair.lastResult = formatSummary(summary);

			// `auto --commit`: keep a changelist even when nobody commits by hand,
			// so every automatic pass can be inspected and restored later.
			if (pair.autoCommit) await this.checkpoint(summary);

			return summary;
		} catch (err: any) {
			pair.lastResult = `error: ${err?.message ?? err}`;
			throw err;
		} finally {
			this.running.delete(pair.id);
			this.save();
			// A sync changes both sides; drop cached listings so the next render shows it.
			invalidateEntries(this.session.id);
		}
	}

	private async checkpoint(summary: SyncSummary): Promise<void> {
		const moved = summary.added + summary.updated + summary.deleted;
		if (moved === 0) return;

		const { commit } = await import('./git.js');
		const { selfKeyHex } = await import('./users.js');
		try {
			await commit(this.session, {
				message: `auto: +${summary.added} ~${summary.updated} -${summary.deleted}`,
				authorKey: selfKeyHex(this.session.app)
			});
		} catch (err: any) {
			// Never fail the sync because a checkpoint could not be written; say so.
			console.warn(`sync auto-commit failed for ${this.session.id}:`, err?.message ?? err);
		}
	}

	private stateFile(id: string): string {
		return path.join(this.stateDir, `${id}.json`);
	}

	private load(): SyncPair[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
			const pairs = Array.isArray(parsed?.pairs) ? parsed.pairs : [];
			return pairs
				.filter((pair: any) => pair && typeof pair.id === 'string' && typeof pair.path === 'string')
				.map((pair: any) => ({
					id: pair.id,
					path: pair.path,
					auto: !!pair.auto,
					autoCommit: !!pair.autoCommit,
					// Pairs created before directions existed were two-way only because
					// that was the old default. Two-way is now an explicit choice, so a
					// pair with no stored direction comes back as one-way.
					direction: pair.direction === 'two-way' ? 'two-way' : 'pull',
					// Same for mirroring: a pair stored before it existed keeps local
					// extras until the user asks for them to be removed.
					prune: !!pair.prune,
					createdAt: pair.createdAt ?? Date.now(),
					lastSyncAt: pair.lastSyncAt ?? null,
					lastResult: pair.lastResult ?? null
				}));
		} catch {
			return [];
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			fs.writeFileSync(this.configFile, JSON.stringify({ pairs: this.pairs }));
		} catch (err: any) {
			console.warn('sync: could not save pairs:', err.message);
		}
	}
}

async function syncOnce(
	session: DriveSession,
	pair: SyncPair,
	stateFile: string,
	options: { direction?: SyncDirection; prune?: boolean; onProgress?: SyncProgressFn } = {}
): Promise<SyncSummary> {
	const { onProgress } = options;
	const direction: SyncDirection = options.direction ?? 'pull';
	const drive = session.drive;
	if (!drive) throw new Error('Drive not ready');
	if (!drive.connected) throw new Error('Not connected to the host');
	if (!fs.existsSync(pair.path)) throw new Error(`Folder is gone: ${pair.path}`);

	// Pushing needs the owner's permission. Say so instead of quietly turning a
	// two-way folder into a one-way one: a user who asked for two-way must know
	// why nothing left the machine.
	const twoWay = direction === 'two-way';
	if (twoWay && !drive.canWrite) {
		throw new Error(
			session.isGuest
				? 'This repository is one-way: the owner has not enabled peer writes, so local changes cannot be pushed.'
				: 'Not connected to the host — reconnect before pushing local changes.'
		);
	}

	// Mirroring is a one-way idea: a two-way folder offers a local file the repo
	// does not have back to the repo, so there is nothing to prune.
	const prune = !!options.prune && !twoWay;

	const local = new Localdrive(pair.path, { atomic: true });
	await local.ready();

	const summary: SyncSummary = {
		added: 0,
		updated: 0,
		deleted: 0,
		conflicts: 0,
		skipped: 0,
		errors: [],
		changes: 0,
		source: 'listing'
	};
	const state = readState(stateFile);

	// A mirrored folder is an upload: the same .gitignore rules that filter the
	// browser upload apply here. Local rules are read too — on the first run the
	// folder's .gitignore has not been shared yet, and that is exactly when a
	// linked project would otherwise mirror its node_modules. One walk feeds both
	// the ignore rules and the file list, so a folder with a huge ignored tree is
	// traversed once instead of twice.
	const { files: localFiles, sources: localIgnore } = await localScan(local, (seen) =>
		onProgress?.({ kind: 'scan', path: '', done: 0, scanned: seen })
	);

	// What the repo holds: the previous state, brought up to date with whatever the
	// owner's log reported since this folder last synced.
	const snapshot = await sharedSnapshot(drive, state);
	const sharedFiles = snapshot.files;
	summary.changes = snapshot.changes;
	summary.source = snapshot.source;

	const ignore = await buildIgnore(
		session,
		local,
		localIgnore,
		[...sharedFiles.keys()].map((filePath) => ({ path: filePath }))
	);

	// One event per file the run decides. It is counted against the plan, so the
	// bar and the printed list never disagree about where the run is.
	const report = (kind: SyncProgress['kind'], filePath: string, size?: number | null): number => {
		onProgress?.({
			kind,
			path: filePath,
			done: examined,
			total: candidates.length,
			size: size ?? undefined
		});
		return examined;
	};

	// Ticks for the file in flight. A consumer prints them on one line; a tick
	// repeats `done` because it is not a new file, only a new byte count.
	const ticking = (
		kind: SyncProgress['kind'],
		filePath: string,
		done: number,
		size: number | null
	) =>
		new ProgressTap(size, (loaded) =>
			onProgress?.({
				kind,
				path: filePath,
				done,
				total: candidates.length,
				size: size ?? undefined,
				loaded
			})
		);

	// Both directions return what the receiving side now holds, digest included, so
	// the state can be recorded without reading either copy a second time. A drive
	// that does not report the resulting stat leaves that side to be measured.
	//
	// An upload has to know the content hash *before* the write: the host stores it
	// as entry metadata, which is what lets any reader decide that a file moved
	// without asking for its bytes. The extra read is a local disk read, and it is
	// capped — a large file gets no hash and is compared by version stamp instead.
	const localToShared = async (
		filePath: string
	): Promise<{ shared?: SideStat; digest?: string }> => {
		const size = localFiles.get(filePath)?.size ?? null;
		const done = report('upload', filePath, size);
		const digest =
			size !== null && size <= DIGEST_CAP
				? await cappedDigest(local.createReadStream(filePath)).catch(() => undefined)
				: undefined;

		const bytes = ticking('upload', filePath, done, size).through(local.createReadStream(filePath));
		const result = await drive.putShared(filePath, bytes, { hash: digest ?? null });
		if (typeof result?.size !== 'number') return { digest };
		return {
			shared: {
				size: result.size,
				mtime: result.mtime ?? null,
				digest: digest ?? result.hash ?? undefined,
				stamp: result.stamp ?? undefined
			},
			digest
		};
	};

	// A download writes the bytes and, when the repo did not already say what they
	// hash to, hashes them on the way through. A peer reads from its own replica of
	// the content drive when that replica holds the version the log promised, and
	// from the host otherwise.
	const sharedToLocal = async (
		filePath: string,
		stat?: SideStat
	): Promise<{ local: SideStat; digest?: string }> => {
		const size = stat?.size ?? null;
		const done = report('download', filePath, size);
		const tap = stat?.digest ? null : new DigestTap();

		let bytes: AsyncIterable<Buffer> = drive.readSharedVersion(filePath, stat?.stamp ?? null);
		bytes = ticking('download', filePath, done, size).through(bytes);
		if (tap) bytes = tap.through(bytes);
		await writeIntoStream(local.createWriteStream(filePath), bytes);

		const entry = await local.entry(filePath).catch(() => null);
		const digest = stat?.digest ?? tap?.digest();
		return {
			local: {
				size: entry?.value?.blob?.byteLength ?? 0,
				mtime: typeof entry?.mtime === 'number' ? entry.mtime : Date.now(),
				digest
			},
			digest
		};
	};

	// Digest for one side: reuse a probe from this run or the recorded one when the
	// bytes cannot have moved, and only read when neither can answer.
	const digestOf = async (
		size: number,
		mtime: number | null,
		probe: string | undefined,
		previous: SideStat | undefined,
		read: () => Promise<string | undefined>
	): Promise<string | undefined> => {
		if (size > DIGEST_CAP) return undefined;
		if (probe) return probe;
		if (previous?.digest && previous.size === size && previous.mtime === mtime) {
			return previous.digest;
		}
		return read().catch(() => undefined);
	};

	const measureLocal = async (
		filePath: string,
		probe: string | undefined,
		previous: SideStat | undefined
	): Promise<SideStat | null> => {
		const localEntry = await local.entry(filePath).catch(() => null);
		if (!localEntry || localEntry.value?.linkname) return null;

		const size = localEntry.value?.blob?.byteLength ?? 0;
		const mtime = typeof localEntry.mtime === 'number' ? localEntry.mtime : null;
		return {
			size,
			mtime,
			digest: await digestOf(size, mtime, probe, previous, () =>
				cappedDigest(local.createReadStream(filePath))
			)
		};
	};

	const measureShared = async (
		filePath: string,
		probe: string | undefined,
		previous: SideStat | undefined
	): Promise<SideStat | null> => {
		const sharedEntry = await drive.statShared(filePath).catch(() => null);
		if (!sharedEntry?.exists) return null;

		const { size, mtime } = sharedEntry;
		return {
			size,
			mtime,
			digest: await digestOf(size, mtime, probe, previous, () =>
				cappedDigest(drive.readShared(filePath))
			),
			stamp: sharedEntry.stamp ?? undefined
		};
	};

	const record = async (filePath: string, hints: RecordHints = {}) => {
		const entry: StateEntry = {};
		const previous = state.paths[filePath];

		const localSide =
			hints.local !== undefined
				? hints.local
				: await measureLocal(filePath, hints.localProbe, previous?.local);
		if (localSide) entry.local = localSide;

		const sharedSide =
			hints.shared !== undefined
				? hints.shared
				: await measureShared(filePath, hints.sharedProbe, previous?.shared);
		if (sharedSide) entry.shared = sharedSide;

		if (entry.local || entry.shared) state.paths[filePath] = entry;
		else delete state.paths[filePath];
	};

	// The plan: every path this run has to look at, decided before the loop so the
	// run knows how many files and how many bytes it faces. A first sync of a large
	// folder is the case that matters — the caller used to learn the size of the
	// job from the transfers themselves, so a bar could never be more than a guess.
	// Paths an ignore rule rules out are dropped here, exactly as the loop would
	// have dropped them.
	const candidates: string[] = [];
	let planBytes = 0;
	for (const filePath of [
		...new Set([...localFiles.keys(), ...sharedFiles.keys(), ...Object.keys(state.paths)])
	].sort()) {
		if (isIgnored(filePath)) continue;

		// An ignored path never travels: skip the copy and the two stat round-trips
		// `record()` would spend tracking it, and drop any stale entry so an
		// enormous ignored tree does not bloat the state file. Anything already in
		// the repo still falls through below, left untouched.
		if (ignore.ignored(filePath) && !sharedFiles.has(filePath)) {
			if (state.paths[filePath]) delete state.paths[filePath];
			continue;
		}

		candidates.push(filePath);
		planBytes += localFiles.get(filePath)?.size ?? sharedFiles.get(filePath)?.size ?? 0;
	}

	onProgress?.({
		kind: 'scan',
		path: '',
		done: 0,
		total: candidates.length,
		totalBytes: planBytes
	});

	let examined = 0;
	let pendingWrites = 0;

	for (const filePath of candidates) {
		examined++;

		const localStat = localFiles.get(filePath);
		const sharedStat = sharedFiles.get(filePath);
		const base = state.paths[filePath];

		// Ignored paths already in the repo are left alone in both directions:
		// never pushed, and never removed from the shared drive (that data is not
		// ours to drop).
		const ignored = ignore.ignored(filePath);

		const localProbe = await changed(localStat, base?.local, () =>
			cappedDigest(local.createReadStream(filePath))
		);
		const sharedProbe = await changed(sharedStat, base?.shared, () =>
			cappedDigest(drive.readShared(filePath))
		);
		if (!localProbe.changed && !sharedProbe.changed) continue;

		const localChanged = localProbe.changed;
		const sharedChanged = sharedProbe.changed;

		try {
			// What each side holds once this branch is done, so `record` never reads a
			// file again just to store its digest.
			let localNow: SideStat | undefined;
			let sharedNow: SideStat | undefined;
			let localGone = false;
			let sharedGone = false;

			const push = async () => {
				const upload = await localToShared(filePath);
				sharedNow = upload.shared;
				if (localStat) localNow = { ...localStat, digest: upload.digest };
			};
			const pull = async () => {
				const landed = await sharedToLocal(filePath, sharedStat);
				localNow = landed.local;
				if (sharedStat) {
					sharedNow = { ...sharedStat, digest: landed.digest ?? sharedStat.digest };
				}
			};
			// Mirroring: the repo does not have this path, so the folder must not
			// either. Both sides are recorded as absent, which saves a stat round trip.
			const pruneLocal = async () => {
				report('delete', filePath);
				await local.del(filePath);
				summary.deleted++;
				localGone = true;
				sharedGone = true;
			};

			if (localChanged && sharedChanged) {
				// Both sides moved. Without a recorded base there is nothing either side
				// could have moved away from: that is the run that adopts the folder, and
				// counting every file as a conflict would bury the ones that matter.
				const diverged = !!base;

				if (localStat && sharedStat) {
					// Equal sizes are usually our own copy with a fresher mtime, but a
					// same-length edit on both sides is a real divergence: compare content
					// before deciding that nothing happened.
					const localDigest =
						localProbe.digest ??
						(await cappedDigest(local.createReadStream(filePath)).catch(() => undefined));
					const sharedDigest =
						sharedProbe.digest ??
						(await cappedDigest(drive.readShared(filePath)).catch(() => undefined));
					const same =
						localStat.size === sharedStat.size && !!localDigest && localDigest === sharedDigest;

					// The same bytes on both sides are not a divergence, whichever way the
					// mtimes fell: there is nothing to resolve and nothing to copy.
					if (!same) {
						if (diverged) summary.conflicts++;
						if (twoWay && !ignored && localIsNewer(localStat, sharedStat, base)) {
							// Newest → oldest: push only when this folder really is newer.
							await push();
							summary.updated++;
						} else {
							await pull();
							summary.updated++;
						}
					}
				} else if (localStat && !sharedStat) {
					// Gone from the repo, and this folder holds a copy of its own. A
					// two-way folder offers it back; a mirror drops it; a plain one-way
					// folder keeps it, because local work is never destroyed unasked.
					if (twoWay && !ignored) {
						await push();
						summary.added++;
					} else if (prune) {
						await pruneLocal();
					} else {
						if (diverged) summary.conflicts++;
						summary.skipped++;
					}
				} else if (!localStat && sharedStat) {
					// Deleted here but still in the repo: it comes back, so a one-way
					// folder can never silently lose content.
					await pull();
					summary.added++;
				}
			} else if (localChanged) {
				// Only this folder moved.
				if (ignored) {
					// Nothing to propagate upward.
				} else if (!twoWay) {
					// One-way: an edit of a path the repo still has stays local and stays
					// visible as pending (not recorded, so flipping the folder to two-way
					// pushes it). A local file the repo does not have is what a mirror is
					// asked to drop.
					if (prune && localStat && !sharedStat) {
						await pruneLocal();
					} else {
						summary.skipped++;
						continue;
					}
				} else if (localStat && !sharedStat) {
					await push();
					summary.added++;
				} else if (localStat && sharedStat) {
					await push();
					summary.updated++;
				} else if (!localStat && sharedStat) {
					report('delete', filePath);
					await drive.deleteShared(filePath);
					summary.deleted++;
					sharedGone = true;
				}
			} else {
				// Only the repo moved: repo → folder, in both directions.
				if (sharedStat && !localStat) {
					await pull();
					summary.added++;
				} else if (sharedStat && localStat) {
					await pull();
					summary.updated++;
				} else if (!sharedStat && localStat) {
					report('delete', filePath);
					await local.del(filePath);
					summary.deleted++;
					localGone = true;
				}
			}

			await record(filePath, {
				local: localNow ?? (localGone ? null : undefined),
				// The log already said what the shared side holds, hash included.
				shared: sharedNow ?? (sharedGone ? null : sharedStat),
				localProbe: localProbe.digest,
				sharedProbe: sharedProbe.digest
			});

			if (++pendingWrites >= 25) {
				writeState(stateFile, state);
				pendingWrites = 0;
			}
		} catch (err: any) {
			summary.errors.push(`${filePath}: ${err?.message ?? err}`);
		}
	}

	// A path that failed keeps the old cursor: the log is replayed next run, and a
	// replayed entry is harmless because the state already says what landed. A
	// cursor that ran ahead of a failure would drop that path from every later
	// sync without a word.
	if (summary.errors.length === 0) {
		state.cursor = snapshot.cursor;
		state.log = snapshot.log;
	}

	writeState(stateFile, state);
	return summary;
}

interface SharedSnapshot {
	/** Every path the repo holds right now, with the stat its last write recorded. */
	files: Map<string, SideStat>;
	/** Sequence number to store once this run is done; 0 when there is no log. */
	cursor: number;
	/** Identity of the log that number belongs to. */
	log: string;
	/** Paths the log reported for this run. */
	changes: number;
	source: 'log' | 'listing';
}

/**
 * The repo side of one run: the paths the state already knew, brought up to date
 * with whatever the owner's log reported since that state was recorded.
 *
 * A log that cannot answer for the cursor sends the whole listing in the same
 * answer, so a sync never guesses and never pays two round trips to find out.
 */
async function sharedSnapshot(drive: SharedDrive, state: SyncState): Promise<SharedSnapshot> {
	const files = new Map<string, SideStat>();
	for (const [filePath, entry] of Object.entries(state.paths)) {
		if (entry?.shared) files.set(filePath, entry.shared);
	}

	let page: ChangePage | null = null;
	try {
		page = await drive.changesSince(state.cursor, state.log);
	} catch {
		// A peer from before the log existed: the listing below still works.
	}

	if (!page) {
		const listing = await drive.manifestShared('/');
		return { files: fromListing(listing), cursor: 0, log: '', changes: 0, source: 'listing' };
	}

	let changes = 0;
	let head = page.head;
	let guard = 0;

	while (true) {
		// A listing stands on its own: nothing older has to be reconstructed, and
		// the cursor restarts from what the owner just said its head was.
		if (page.full) {
			return {
				files: fromListing(page.listing),
				cursor: page.head,
				log: page.log,
				changes,
				source: 'listing'
			};
		}

		for (const entry of page.entries) {
			if (isReservedRepoPath(entry.path)) continue;
			changes++;
			if (entry.op === 'del') files.delete(entry.path);
			else
				files.set(entry.path, {
					size: entry.size,
					mtime: entry.mtime,
					digest: entry.hash ?? undefined,
					stamp: entry.stamp ?? undefined
				});
		}

		head = page.head;
		if (!page.more) break;
		// A very old cursor can hold a long tail of pages. Anything left is fetched
		// on the next run: the cursor stops at what was actually read.
		if (++guard > 50) break;

		page = await drive.changesSince(head, page.log);
	}

	return { files, cursor: head, log: page.log, changes, source: 'log' };
}

function fromListing(listing: SharedFile[]): Map<string, SideStat> {
	const files = new Map<string, SideStat>();
	for (const file of listing) {
		// `/.peerhub` is the repo's own history store, not content to mirror.
		if (isReservedRepoPath(file.path)) continue;
		// The hash and the stamp travel with the entry, so change detection needs no read.
		files.set(file.path, {
			size: file.size,
			mtime: file.mtime,
			digest: file.hash ?? undefined,
			stamp: file.stamp ?? undefined
		});
	}
	return files;
}

// Rules for one sync run: the repo's stored .gitignore files plus the mirrored
// folder's own — on the first run the folder's files are not shared yet, and
// that is exactly when their rules matter. Exported so the CLI reports status
// against the same rules the sync engine would apply.
export async function buildIgnore(
	session: DriveSession,
	local: Localdrive,
	localSources?: IgnoreSource[],
	sharedManifest?: Array<{ path: string }>
): Promise<IgnoreMatcher> {
	const sources: IgnoreSource[] = [];

	try {
		sources.push(...(await loadIgnoreSources(session, sharedManifest)));
	} catch {
		// Shared rules unreachable: the local ones still apply.
	}

	if (localSources) sources.push(...localSources);
	else {
		// No pre-collected rules: walk the folder for its own .gitignore files.
		for await (const entry of local.list('/')) {
			if (!entry?.key || entry.value?.linkname) continue;
			if (!entry.key.endsWith('/.gitignore')) continue;
			try {
				const text = await readLocalText(local, entry.key);
				const base = entry.key.slice(0, entry.key.lastIndexOf('/')) || '/';
				sources.push({ base, text });
			} catch {
				// Unreadable ignore file: the remaining rules still apply.
			}
		}
	}

	return compileIgnore(sources);
}

const MAX_IGNORE_BYTES = 64 * 1024;

async function readLocalText(local: Localdrive, filePath: string): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of local.createReadStream(filePath)) {
		chunks.push(Buffer.from(chunk));
		size += chunk.byteLength;
		if (size >= MAX_IGNORE_BYTES) break;
	}
	return Buffer.concat(chunks).subarray(0, MAX_IGNORE_BYTES).toString('utf-8');
}

// One walk of the folder: every file's stat plus the text of each .gitignore.
// The matcher itself is applied later in the sync loop, so ignored-by-rule files
// still show up here (a rule change must be able to delete what an earlier run
// uploaded); only system noise and the repo's own history are dropped up front.
// ponytail: flat recursive list, so an ignored venv is still traversed; prune by
// directory if a folder ever grows past a single walk being tolerable.
async function localScan(
	local: Localdrive,
	onSeen?: (seen: number) => void
): Promise<{ files: Map<string, SideStat>; sources: IgnoreSource[] }> {
	const files = new Map<string, SideStat>();
	const sources: IgnoreSource[] = [];

	// A first walk of a linked project is the longest silence a sync has, and it is
	// silent because nothing is being copied. Report how many files have gone by —
	// how many are left cannot be known until the walk ends, so this is a count,
	// not a bar. Throttled by count and by time, so neither a huge tree nor a slow
	// disk turns the walk into a stream of events.
	let seen = 0;
	let reported = 0;
	let reportedAt = Date.now();
	const tick = (now: number) => {
		if (!onSeen) return;
		if (seen - reported < 250 && now - reportedAt < 250) return;
		reported = seen;
		reportedAt = now;
		onSeen(seen);
	};

	for await (const entry of local.list('/')) {
		if (!entry?.key || entry.value?.linkname) continue;
		seen++;
		tick(Date.now());
		if (entry.key.endsWith('/.gitignore')) {
			try {
				const text = await readLocalText(local, entry.key);
				const base = entry.key.slice(0, entry.key.lastIndexOf('/')) || '/';
				sources.push({ base, text });
			} catch {
				// Unreadable ignore file: the remaining rules still apply.
			}
		}
		if (isIgnored(entry.key)) continue;
		if (isReservedRepoPath(entry.key)) continue;
		files.set(entry.key, {
			size: entry.value?.blob?.byteLength ?? 0,
			mtime: typeof entry.mtime === 'number' ? entry.mtime : null
		});
	}

	return { files, sources };
}

/**
 * Has `current` moved away from `previous`?
 *
 * Size decides first. When the size matches and the mtime is unchanged, the
 * file is untouched. When the size matches but the mtime drifted inside the
 * tolerance, that is the ambiguous case a fast same-size edit produces, so the
 * content is hashed and compared with the digest stored at record time. A digest
 * computed here is handed back so recording the state does not repeat the read.
 */
async function changed(
	current: SideStat | undefined,
	previous: SideStat | undefined,
	hash: () => Promise<string | undefined>
): Promise<Probe> {
	if (!current && !previous) return { changed: false };
	if (!current || !previous) return { changed: true };

	// A content hash on both sides answers the question without reading anything,
	// and it catches a rewrite that kept both the size and the mtime.
	if (current.digest && previous.digest) {
		return { changed: current.digest !== previous.digest, digest: current.digest };
	}

	// The version stamp is exact for a file too big to hash: two writes never share
	// one, and a peer that holds this stamp holds these bytes.
	if (current.stamp && previous.stamp) {
		return { changed: current.stamp !== previous.stamp };
	}

	if (current.size !== previous.size) return { changed: true };

	if (current.mtime != null && previous.mtime != null) {
		const drift = Math.abs(current.mtime - previous.mtime);
		if (drift > MTIME_SLACK) return { changed: true };
		if (drift === 0) return { changed: false };
	}

	// Old state files have no digest; keep the previous behaviour for them rather
	// than re-copying every file once after an upgrade.
	if (!previous.digest) return { changed: false };
	const digest = await hash().catch(() => undefined);
	if (!digest) return { changed: false };
	return { changed: digest !== previous.digest, digest };
}

export async function cappedDigest(
	source: AsyncIterable<Buffer | Uint8Array>
): Promise<string | undefined> {
	const parts: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of source) {
		const buf = Buffer.from(chunk);
		size += buf.byteLength;
		if (size > DIGEST_CAP) return undefined;
		parts.push(buf);
	}
	return digestBytes(Buffer.concat(parts));
}

// Newest → oldest. The folder may only overwrite the repo when its copy is
// strictly newer; a tie (or no mtime) goes to the repo, because the owner's
// version is the one every peer has already replicated.
function localIsNewer(local: SideStat, shared: SideStat, base: StateEntry | undefined): boolean {
	const localMtime = local.mtime ?? base?.local?.mtime ?? 0;
	const sharedMtime = shared.mtime ?? base?.shared?.mtime ?? 0;
	return localMtime > sharedMtime + MTIME_SLACK;
}

function isIgnored(filePath: string): boolean {
	const name = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
	return IGNORED_FILES.has(name) || name.endsWith(TEMP_SUFFIX);
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function emptyState(): SyncState {
	return { paths: {}, cursor: 0, log: '' };
}

function readState(file: string): SyncState {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!parsed || typeof parsed !== 'object') return emptyState();

		// A file written before the change log kept the paths at the top level. It is
		// read as a list with no cursor, so the first run after the upgrade lists the
		// repo once and everything continues from there.
		const paths =
			parsed.paths && typeof parsed.paths === 'object'
				? parsed.paths
				: typeof parsed.cursor === 'number'
					? {}
					: parsed;
		const cursor = typeof parsed.cursor === 'number' && parsed.paths ? parsed.cursor : 0;

		return { paths, cursor, log: typeof parsed.log === 'string' ? parsed.log : '' };
	} catch {
		return emptyState();
	}
}

function writeState(file: string, state: SyncState): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(state));
	} catch (err: any) {
		console.warn('sync: could not save state:', err.message);
	}
}

export function formatSummary(summary: SyncSummary): string {
	const parts = [
		`${summary.added} added`,
		`${summary.updated} updated`,
		`${summary.deleted} deleted`
	];
	if (summary.conflicts > 0) parts.push(`${summary.conflicts} conflicts`);
	// Not "changes": a one-way folder cannot push these, so they only become real
	// work when the folder is switched to two-way or made to mirror the repo.
	if (summary.skipped > 0) parts.push(`${summary.skipped} local files not in the repo (kept)`);
	if (summary.errors.length > 0) parts.push(`${summary.errors.length} errors`);
	return parts.join(', ');
}

function randomId(): string {
	const buf = b4a.allocUnsafe(8);
	randombytes_buf(buf);
	return b4a.toString(buf, 'hex');
}
