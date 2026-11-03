import fs from 'fs';
import path from 'path';

import type PeerHubApp from './app.js';
import type DriveSession from './session.js';
import type { SyncPairView, SyncProgressFn, SyncSummary } from './sync.js';
import { formatSummary } from './sync.js';

// Cloning a repository into a local folder.
//
// A linked folder used to be something the user pointed at from Settings, which
// made it possible to link a folder that already held files. Such a folder has
// no sync state, so every path it holds and the repo does not looks like a local
// edit: repo deletions never reach it, and the first run reports the whole
// folder as conflicts. A clone starts from an empty folder, so its first sync
// records a complete base and every later deletion has something to apply to.
//
// What a clone is set to follows from that: one-way (it has nowhere to push),
// mirroring (a path the repo does not have is removed), and auto (the owner's
// next pass lands without anyone pressing Sync).
//
// The only case that can lose data is cloning over a folder that already holds
// files, so that is the one case that asks first. This app knows two kinds of
// non-empty folder: one it already clones this repo into (same identity, so the
// files are replaced without asking) and everything else, including a clone of
// a *different* repo.

/** Samples enough entries to say "3 files" or "more than 100". */
const SAMPLE_FILES = 100;

/**
 * What the chosen folder already is.
 *
 * - `new` — it does not exist yet.
 * - `empty` — it exists and holds nothing.
 * - `this-repo` — this app already clones this repo here: re-cloning replaces.
 * - `other-repo` — this app clones a different repo here.
 * - `foreign` — content this app knows nothing about.
 */
export type CloneTargetState = 'new' | 'empty' | 'this-repo' | 'other-repo' | 'foreign';

export interface CloneTarget {
	/** Absolute path, resolved. */
	path: string;
	state: CloneTargetState;
	/** Repo whose clone already lives in this folder, when this app knows one. */
	owner: { id: string; name: string } | null;
	/** Files already present, sampled: never more than SAMPLE_FILES. */
	files: number;
	/** True when cloning would replace files the user did not ask to replace. */
	needsConfirm: boolean;
}

export interface CloneResult {
	pair: SyncPairView;
	summary: SyncSummary;
	/** One line for the dialog: what the first sync did. */
	message: string;
	path: string;
}

/** Every pair of every repo this app knows about, flattened. */
function pairsOf(app: PeerHubApp): Array<{ id: string; name: string; pair: SyncPairView }> {
	const out: Array<{ id: string; name: string; pair: SyncPairView }> = [];
	for (const session of app.sessions.values()) {
		for (const pair of session.listSyncPairs())
			out.push({ id: session.id, name: session.name, pair });
	}
	return out;
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function samePath(a: string, b: string): boolean {
	return path.relative(a, b) === '';
}

/** How many files the folder holds, counted only as far as the warning needs. */
function countFiles(dir: string): number {
	let seen = 0;
	const stack = [dir];

	while (stack.length > 0 && seen < SAMPLE_FILES) {
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			// Unreadable subfolder: it cannot be counted, and it does not change
			// the answer (the folder is still "not empty" once one file is seen).
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) stack.push(path.join(current, entry.name));
			else seen++;
			if (seen >= SAMPLE_FILES) break;
		}
	}

	return seen;
}

/** Is the folder missing, empty, or already known to this app? */
export function cloneTarget(app: PeerHubApp, repoId: string, target: string): CloneTarget {
	if (!target?.trim()) throw new Error('Choose where to clone the repository');

	const resolved = path.resolve(target.trim());
	const appDir = path.resolve(app.dir);
	if (isInside(resolved, appDir) || isInside(appDir, resolved)) {
		throw new Error('Pick a folder outside PeerHub storage');
	}

	// A clone inside another clone would be walked by both and pruned by the
	// outer one; a folder that contains a clone would prune the clone's own state.
	for (const entry of pairsOf(app)) {
		if (samePath(entry.pair.path, resolved)) {
			const files = countFiles(resolved);
			const own = entry.id === repoId;
			return {
				path: resolved,
				state: own ? 'this-repo' : 'other-repo',
				owner: { id: entry.id, name: entry.name },
				files,
				needsConfirm: !own && files > 0
			};
		}
		if (isInside(resolved, entry.pair.path)) {
			throw new Error(`That folder is inside the clone at ${entry.pair.path}`);
		}
		if (isInside(entry.pair.path, resolved)) {
			throw new Error(`That folder already contains the clone at ${entry.pair.path}`);
		}
	}

	if (!fs.existsSync(resolved)) {
		return { path: resolved, state: 'new', owner: null, files: 0, needsConfirm: false };
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch (err: any) {
		throw new Error(`Cannot read that folder: ${err?.message ?? err}`);
	}
	if (!stat.isDirectory()) throw new Error('Pick a folder, not a file');

	const files = countFiles(resolved);
	return {
		path: resolved,
		state: files === 0 ? 'empty' : 'foreign',
		owner: null,
		files,
		// An unknown folder with content is the only thing a clone would destroy.
		needsConfirm: files > 0
	};
}

/**
 * Clone into `target`: create the folder, link it, and run the first sync.
 *
 * The caller is expected to have asked `cloneTarget` first and to have the
 * user's answer to `needsConfirm`; this writes only what that answer allows.
 */
export async function cloneRepo(
	session: DriveSession,
	target: string,
	options: { onProgress?: SyncProgressFn } = {}
): Promise<CloneResult> {
	const resolved = path.resolve(target.trim());
	fs.mkdirSync(resolved, { recursive: true });

	// Cloning the same repo into the same folder again is a resync: the folder is
	// already this repo's clone, and its direction is the user's choice, not the
	// clone default's to overrule.
	const existing = session.listSyncPairs().find((pair) => samePath(pair.path, resolved));
	const pair = existing ?? (await session.addSyncPair(resolved));

	if (!existing) {
		try {
			await session.setSyncDirection(pair.id, 'pull');
			await session.setSyncPrune(pair.id, true);
			await session.setSyncAuto(pair.id, true);
		} catch (err) {
			// A pair that could not be configured would sync and never prune: it is
			// not the clone the user asked for, so it is not left behind half made.
			await session.removeSyncPair(pair.id).catch(() => {});
			throw err;
		}
	}

	const summary = await session.runSync(pair.id, { onProgress: options.onProgress });
	return { pair, summary, message: formatSummary(summary), path: resolved };
}
