import fs from 'fs';
import path from 'path';
import Localdrive from 'localdrive';
import b4a from 'b4a';
import { randombytes_buf } from 'sodium-native';

import { writeIntoStream } from './shared-drive.js';
import { invalidateEntries } from './loaders.js';
import type DriveSession from './session.js';

// Two-way local sync: a local folder and the shared file system are reconciled
// in both directions. The first run links them (copies whatever is missing on
// either side); every later run propagates changes, additions and deletions.
//
// The last known state of each path is kept per side, so a copy is only redone
// when that side actually changed — a fresh mtime on the receiving side can
// never bounce back and forth.

const AUTO_INTERVAL = 15_000;
const MTIME_SLACK = 2000;
const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const TEMP_SUFFIX = '.localdrive.tmp';

export interface SyncPair {
	id: string;
	path: string;
	auto: boolean;
	createdAt: number;
	lastSyncAt: number | null;
	lastResult: string | null;
}

export interface SyncPairView extends SyncPair {
	running: boolean;
}

export interface SyncSummary {
	added: number;
	updated: number;
	deleted: number;
	conflicts: number;
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
			throw new Error('Pick a folder outside Ghost Drive storage');
		}
		if (this.pairs.some((pair) => path.relative(pair.path, resolved) === '')) {
			throw new Error('This folder is already being synced');
		}

		const pair: SyncPair = {
			id: randomId(),
			path: resolved,
			auto: false,
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

	setAuto(id: string, auto: boolean): void {
		const pair = this.pairs.find((p) => p.id === id);
		if (!pair) throw new Error('Sync folder not found');

		pair.auto = auto;
		this.save();

		const timer = this.timers.get(pair.id);
		if (timer) clearInterval(timer);
		this.timers.delete(pair.id);
		if (auto) this.schedule(pair);
	}

	async run(id: string): Promise<SyncSummary> {
		const pair = this.pairs.find((p) => p.id === id);
		if (!pair) throw new Error('Sync folder not found');
		if (this.running.has(id)) throw new Error('This folder is already syncing');

		return this.exclusive(pair);
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
		if (!this.session.drive?.canWrite) return;

		try {
			await this.exclusive(pair);
		} catch {
			// lastResult already records why; auto runs stay quiet.
		}
	}

	private async exclusive(pair: SyncPair): Promise<SyncSummary> {
		this.running.add(pair.id);

		try {
			const summary = await syncOnce(this.session, pair, this.stateFile(pair.id));
			pair.lastSyncAt = Date.now();
			pair.lastResult = formatSummary(summary);
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
	stateFile: string
): Promise<SyncSummary> {
	const drive = session.drive;
	if (!drive) throw new Error('Drive not ready');
	if (!drive.canWrite) throw new Error('Not connected to the host');
	if (!fs.existsSync(pair.path)) throw new Error(`Folder is gone: ${pair.path}`);

	const local = new Localdrive(pair.path, { atomic: true });
	await local.ready();

	const summary: SyncSummary = { added: 0, updated: 0, deleted: 0, conflicts: 0, errors: [] };
	const state = readState(stateFile);

	const localFiles = await localManifest(local);
	const sharedFiles = new Map<string, SideStat>();
	for (const file of await drive.manifestShared('/')) {
		sharedFiles.set(file.path, { size: file.size, mtime: file.mtime });
	}

	const localToShared = (filePath: string) =>
		drive.putShared(filePath, local.createReadStream(filePath));
	const sharedToLocal = async (filePath: string) => {
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

		const localChanged = !unchanged(localStat, base?.local);
		const sharedChanged = !unchanged(sharedStat, base?.shared);
		if (!localChanged && !sharedChanged) continue;

		try {
			if (localChanged && !sharedChanged) {
				if (localStat && !sharedStat) {
					await localToShared(filePath);
					summary.added++;
				} else if (localStat && sharedStat) {
					await localToShared(filePath);
					summary.updated++;
				} else if (!localStat && sharedStat) {
					await drive.deleteShared(filePath);
					summary.deleted++;
				}
			} else if (!localChanged && sharedChanged) {
				if (sharedStat && !localStat) {
					await sharedToLocal(filePath);
					summary.added++;
				} else if (sharedStat && localStat) {
					await sharedToLocal(filePath);
					summary.updated++;
				} else if (!sharedStat && localStat) {
					await local.del(filePath);
					summary.deleted++;
				}
			} else if (localStat && sharedStat) {
				// Both sides moved: the newer write wins, unless both already hold
				// the same amount of data (then it is almost certainly the copy we
				// made ourselves, with a fresher mtime on one side).
				if (localStat.size !== sharedStat.size) {
					summary.conflicts++;
					if (newer(localStat, sharedStat, base)) await localToShared(filePath);
					else await sharedToLocal(filePath);
				}
			} else if (localStat && !sharedStat && base?.shared) {
				// Deleted on the shared side but edited here — keep the edit.
				summary.conflicts++;
				await localToShared(filePath);
			} else if (sharedStat && !localStat && base?.local) {
				// Deleted here but edited on the shared side — bring it back.
				summary.conflicts++;
				await sharedToLocal(filePath);
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

async function localManifest(local: Localdrive): Promise<Map<string, SideStat>> {
	const out = new Map<string, SideStat>();

	for await (const entry of local.list('/')) {
		if (!entry?.key || entry.value?.linkname) continue;
		if (isIgnored(entry.key)) continue;
		out.set(entry.key, {
			size: entry.value?.blob?.byteLength ?? 0,
			mtime: typeof entry.mtime === 'number' ? entry.mtime : null
		});
	}

	return out;
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

function newer(current: SideStat, other: SideStat, base: StateEntry | undefined): boolean {
	const currentMtime = current.mtime ?? base?.local?.mtime ?? 0;
	const otherMtime = other.mtime ?? base?.shared?.mtime ?? 0;
	return currentMtime >= otherMtime;
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
	if (summary.errors.length > 0) parts.push(`${summary.errors.length} errors`);
	return parts.join(', ');
}

function randomId(): string {
	const buf = b4a.allocUnsafe(8);
	randombytes_buf(buf);
	return b4a.toString(buf, 'hex');
}
