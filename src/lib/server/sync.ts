import fs from 'fs';
import path from 'path';
import Localdrive from 'localdrive';
import b4a from 'b4a';
import { randombytes_buf } from 'sodium-native';

import { writeIntoStream } from './shared-drive.js';
import { invalidateEntries } from './loaders.js';
import { loadIgnoreSources } from './ignores.js';
import { isReservedRepoPath } from './paths.js';
import { compileIgnore, type IgnoreMatcher, type IgnoreSource } from '$lib/ignore';
import type DriveSession from './session.js';

// Local folder sync. One-way by default: the repo is the source of truth and a
// linked folder is a checkout that follows it. That is the same default the
// repo itself has (owner → peers).
//
// Two-way is opt-in per folder: only then can a local edit, addition or
// deletion reach the repo. Even then the newer side wins per path, so a stale
// folder can never overwrite a version that moved after it — the propagation
// rule is newest → oldest, not "whoever syncs last".
//
// The last known state of each path is kept per side, so a copy is only redone
// when that side actually changed — a fresh mtime on the receiving side can
// never bounce back and forth.

const AUTO_INTERVAL = 15_000;
const MTIME_SLACK = 2000;
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
	createdAt: number;
	lastSyncAt: number | null;
	lastResult: string | null;
}

export interface SyncPairView extends SyncPair {
	running: boolean;
}

/** One transferred file, reported live so the CLI can print a running list. */
export interface SyncProgress {
	kind: 'upload' | 'download' | 'delete';
	path: string;
	done: number;
}

export type SyncProgressFn = (ev: SyncProgress) => void;

export interface SyncSummary {
	added: number;
	updated: number;
	deleted: number;
	conflicts: number;
	/** Local changes left alone because the folder is one-way. */
	skipped: number;
	errors: string[];
}

interface SideStat {
	size: number;
	mtime: number | null;
}

interface StateEntry {
	local?: SideStat;
	shared?: SideStat;
}

type SyncState = Record<string, StateEntry>;

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

	async run(
		id: string,
		options: { direction?: SyncDirection; onProgress?: SyncProgressFn } = {}
	): Promise<SyncSummary> {
		const pair = this.pairs.find((p) => p.id === id);
		if (!pair) throw new Error('Sync folder not found');
		if (this.running.has(id)) throw new Error('This folder is already syncing');

		return this.exclusive(pair, options.direction, options.onProgress);
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
		onProgress?: SyncProgressFn
	): Promise<SyncSummary> {
		this.running.add(pair.id);

		try {
			const summary = await syncOnce(
				this.session,
				pair,
				this.stateFile(pair.id),
				direction ?? pair.direction,
				onProgress
			);
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
	direction: SyncDirection = 'pull',
	onProgress?: SyncProgressFn
): Promise<SyncSummary> {
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

	const local = new Localdrive(pair.path, { atomic: true });
	await local.ready();

	const summary: SyncSummary = {
		added: 0,
		updated: 0,
		deleted: 0,
		conflicts: 0,
		skipped: 0,
		errors: []
	};
	const state = readState(stateFile);

	// A mirrored folder is an upload: the same .gitignore rules that filter the
	// browser upload apply here. Local rules are read too — on the first run the
	// folder's .gitignore has not been shared yet, and that is exactly when a
	// linked project would otherwise mirror its node_modules. One walk feeds both
	// the ignore rules and the file list, so a folder with a huge ignored tree is
	// traversed once instead of twice.
	const { files: localFiles, sources: localIgnore } = await localScan(local);
	const ignore = await buildIgnore(session, local, localIgnore);

	const sharedFiles = new Map<string, SideStat>();
	for (const file of await drive.manifestShared('/')) {
		// `/.peerhub` is the repo's own history store, not content to mirror.
		if (isReservedRepoPath(file.path)) continue;
		sharedFiles.set(file.path, { size: file.size, mtime: file.mtime });
	}

	let transferred = 0;
	const report = (kind: SyncProgress['kind'], filePath: string) =>
		onProgress?.({ kind, path: filePath, done: ++transferred });

	const localToShared = (filePath: string) => {
		report('upload', filePath);
		return drive.putShared(filePath, local.createReadStream(filePath));
	};
	const sharedToLocal = async (filePath: string) => {
		report('download', filePath);
		await writeIntoStream(local.createWriteStream(filePath), drive.readShared(filePath));
	};

	const record = async (filePath: string) => {
		const entry: StateEntry = {};

		const localEntry = await local.entry(filePath).catch(() => null);
		if (localEntry && !localEntry.value?.linkname) {
			entry.local = {
				size: localEntry.value?.blob?.byteLength ?? 0,
				mtime: typeof localEntry.mtime === 'number' ? localEntry.mtime : null
			};
		}

		const sharedEntry = await drive.statShared(filePath).catch(() => null);
		if (sharedEntry?.exists) {
			entry.shared = { size: sharedEntry.size, mtime: sharedEntry.mtime };
		}

		if (entry.local || entry.shared) state[filePath] = entry;
		else delete state[filePath];
	};

	const paths = new Set<string>([
		...localFiles.keys(),
		...sharedFiles.keys(),
		...Object.keys(state)
	]);

	let pendingWrites = 0;

	for (const filePath of [...paths].sort()) {
		if (isIgnored(filePath)) continue;

		const localStat = localFiles.get(filePath);
		const sharedStat = sharedFiles.get(filePath);
		const base = state[filePath];

		// Ignored paths are left alone in both directions: never pushed, and
		// never removed from the shared drive (that data is not ours to drop).
		const ignored = ignore.ignored(filePath);

		// An ignored path never travels: skip the copy and the two stat round-trips
		// `record()` would spend tracking it, and drop any stale entry so an
		// enormous ignored tree does not bloat the state file. Anything already in
		// the repo still falls through below, left untouched.
		if (ignored && !sharedFiles.has(filePath)) {
			if (state[filePath]) delete state[filePath];
			continue;
		}

		const localChanged = !unchanged(localStat, base?.local);
		const sharedChanged = !unchanged(sharedStat, base?.shared);
		if (!localChanged && !sharedChanged) continue;

		try {
			if (localChanged && sharedChanged) {
				summary.conflicts++;
				if (localStat && sharedStat) {
					// Same amount of data on both sides is almost certainly the copy we
					// made ourselves, with a fresher mtime on one of them.
					if (localStat.size !== sharedStat.size) {
						if (twoWay && !ignored && localIsNewer(localStat, sharedStat, base)) {
							// Newest → oldest: push only when this folder really is newer.
							await localToShared(filePath);
							summary.updated++;
						} else {
							await sharedToLocal(filePath);
							summary.updated++;
						}
					}
				} else if (localStat && !sharedStat) {
					// Removed from the repo, edited here. Keep the edit when the folder
					// may push; otherwise leave it alone (never destroy local work).
					if (twoWay && !ignored) {
						await localToShared(filePath);
						summary.added++;
					} else summary.skipped++;
				} else if (!localStat && sharedStat) {
					// Deleted here but still in the repo: it comes back, so a one-way
					// folder can never silently lose content.
					await sharedToLocal(filePath);
					summary.added++;
				}
			} else if (localChanged) {
				// Only this folder moved.
				if (ignored) {
					// Nothing to propagate upward.
				} else if (!twoWay) {
					// One-way: local edits stay local and stay visible as pending.
					// Not recorded, so flipping the folder to two-way pushes them.
					summary.skipped++;
					continue;
				} else if (localStat && !sharedStat) {
					await localToShared(filePath);
					summary.added++;
				} else if (localStat && sharedStat) {
					await localToShared(filePath);
					summary.updated++;
				} else if (!localStat && sharedStat) {
					report('delete', filePath);
					await drive.deleteShared(filePath);
					summary.deleted++;
				}
			} else {
				// Only the repo moved: repo → folder, in both directions.
				if (sharedStat && !localStat) {
					await sharedToLocal(filePath);
					summary.added++;
				} else if (sharedStat && localStat) {
					await sharedToLocal(filePath);
					summary.updated++;
				} else if (!sharedStat && localStat) {
					report('delete', filePath);
					await local.del(filePath);
					summary.deleted++;
				}
			}

			await record(filePath);

			if (++pendingWrites >= 25) {
				writeState(stateFile, state);
				pendingWrites = 0;
			}
		} catch (err: any) {
			summary.errors.push(`${filePath}: ${err?.message ?? err}`);
		}
	}

	writeState(stateFile, state);
	return summary;
}

// Rules for one sync run: the repo's stored .gitignore files plus the mirrored
// folder's own — on the first run the folder's files are not shared yet, and
// that is exactly when their rules matter. Exported so the CLI reports status
// against the same rules the sync engine would apply.
export async function buildIgnore(
	session: DriveSession,
	local: Localdrive,
	localSources?: IgnoreSource[]
): Promise<IgnoreMatcher> {
	const sources: IgnoreSource[] = [];

	try {
		sources.push(...(await loadIgnoreSources(session)));
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
	local: Localdrive
): Promise<{ files: Map<string, SideStat>; sources: IgnoreSource[] }> {
	const files = new Map<string, SideStat>();
	const sources: IgnoreSource[] = [];

	for await (const entry of local.list('/')) {
		if (!entry?.key || entry.value?.linkname) continue;
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

function unchanged(current: SideStat | undefined, previous: SideStat | undefined): boolean {
	if (!current && !previous) return true;
	if (!current || !previous) return false;
	if (current.size !== previous.size) return false;
	if (current.mtime != null && previous.mtime != null) {
		return Math.abs(current.mtime - previous.mtime) <= MTIME_SLACK;
	}
	return true;
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

function readState(file: string): SyncState {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
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
	if (summary.skipped > 0) parts.push(`${summary.skipped} local changes not pushed (one-way)`);
	if (summary.errors.length > 0) parts.push(`${summary.errors.length} errors`);
	return parts.join(', ');
}

function randomId(): string {
	const buf = b4a.allocUnsafe(8);
	randombytes_buf(buf);
	return b4a.toString(buf, 'hex');
}
