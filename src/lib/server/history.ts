import Localdrive from 'localdrive';
import type DriveSession from './session.js';
import { writeIntoStream } from './shared-drive.js';
import { HISTORY_PREFIX } from './paths.js';
import {
	diffTrees,
	getCommit,
	parseChanges,
	parseTree,
	type Commit,
	type TreeChange
} from './git.js';
import { isReservedRepoPath } from './paths.js';

// Content snapshots for commits, and restoring from them.
//
// A tree digest can tell you *that* a file changed, never what it contained, so
// a commit copies the content of every added/modified path to
// `/.peerhub/history/<sha>/<path>`. Unchanged paths are not copied: a restore
// walks the commit chain upwards until a snapshot for that path appears, which
// keeps storage close to "one copy per changed version".
//
// Deletions need no snapshot — the commit's changelist records them, and the
// walk stops there so a restore never resurrects a file through the parent.

export async function writeSnapshots(
	session: DriveSession,
	sha: string,
	changes: TreeChange[]
): Promise<number> {
	let written = 0;
	for (const change of changes) {
		if (change.status === 'removed') continue;
		const target = `${HISTORY_PREFIX}/${sha}${change.path}`;
		try {
			// Copy through the drive so a guest forwards it like any other write.
			await session.putFile(target, session.drive!.readShared(change.path));
			written++;
		} catch (err: any) {
			throw new Error(`Could not snapshot ${change.path}: ${err?.message ?? err}`);
		}
	}
	return written;
}

export interface SnapshotHit {
	state: 'present' | 'deleted' | 'missing' | 'unknown';
	/** Commit whose snapshot holds the content, or whose changelist deleted it. */
	commit: string | null;
	path: string | null;
}

async function changesOf(session: DriveSession, commit: Commit): Promise<TreeChange[]> {
	if (commit.changes) return parseChanges(commit.changes);
	// Commits written before changelists were recorded: derive them.
	const parent = commit.parent ? await getCommit(session, commit.parent) : null;
	return diffTrees(parent?.treeDigest ?? null, commit.treeDigest);
}

/** Where `path` lived at `sha`, walking parents for unchanged paths. */
export async function resolveSnapshot(
	session: DriveSession,
	sha: string,
	path: string
): Promise<SnapshotHit> {
	let commit = await getCommit(session, sha);
	let guard = 500;

	while (commit && guard-- > 0) {
		const changes = await changesOf(session, commit);
		const entry = changes.find((change) => change.path === path);

		if (entry?.status === 'removed') return { state: 'deleted', commit: commit.sha, path: null };

		const snapshotPath = `${HISTORY_PREFIX}/${commit.sha}${path}`;
		const stat = await session.drive!.statShared(snapshotPath).catch(() => null);
		if (stat?.exists) return { state: 'present', commit: commit.sha, path: snapshotPath };

		// The commit touched this path, so the content must be here; a miss means
		// the snapshot is gone rather than "look further back".
		if (entry) return { state: 'missing', commit: commit.sha, path: null };

		commit = commit.parent ? await getCommit(session, commit.parent) : null;
	}

	return { state: 'unknown', commit: null, path: null };
}

export interface RestoreAction {
	path: string;
	action: 'restored' | 'deleted' | 'skipped';
	reason?: string;
}

/**
 * Write the state of `sha` back into a local folder.
 *
 * Two modes:
 *  - paths given: only those paths are touched (`restore <sha> <paths…>`).
 *  - no paths: the folder is made to match that commit (`tree: true`) — its files
 *    are restored and files the repo tracks that this commit never had are
 *    removed. Untracked local files (ignored, new, `.git`) are never deleted.
 *
 * Overwrites are intentional — that is what restore means — but the caller can
 * pass `dryRun` to see the plan first, and every action is reported.
 */
export async function restoreCommit(
	session: DriveSession,
	localDir: string,
	sha: string,
	paths?: string[],
	options: { dryRun?: boolean; tree?: boolean } = {}
): Promise<RestoreAction[]> {
	const commit = await getCommit(session, sha);
	if (!commit) throw new Error(`No such commit: ${sha}`);

	const explicit = !!paths && paths.length > 0;
	const tree = new Map(parseTree(commit.treeDigest));

	const targets = explicit
		? paths.map((path) => (path.startsWith('/') ? path : '/' + path))
		: [...tree.keys()].sort();

	if (targets.length === 0 && !options.tree) {
		throw new Error('That commit has no files to restore');
	}

	// Exact-tree mode: paths the repo tracks today but this commit never had are
	// the ones to remove locally.
	let extras: string[] = [];
	if (!explicit && options.tree) {
		const manifest = await session.drive!.manifestShared('/').catch(() => []);
		extras = manifest
			.map((file) => file.path)
			.filter((path) => !isReservedRepoPath(path) && !tree.has(path));
	}

	const local = new Localdrive(localDir, { atomic: true });
	await local.ready();

	const actions: RestoreAction[] = [];
	try {
		for (const path of targets) {
			const hit = await resolveSnapshot(session, commit.sha, path);

			if (hit.state === 'present' && hit.path) {
				if (!options.dryRun) {
					await writeIntoStream(local.createWriteStream(path), session.drive!.readShared(hit.path));
				}
				actions.push({ path, action: 'restored' });
				continue;
			}

			if (hit.state === 'deleted') {
				const existing = await local.entry(path).catch(() => null);
				if (existing) {
					if (!options.dryRun) await local.del(path);
					actions.push({ path, action: 'deleted' });
				} else {
					actions.push({ path, action: 'skipped', reason: 'already absent' });
				}
				continue;
			}

			actions.push({
				path,
				action: 'skipped',
				reason:
					hit.state === 'missing'
						? `snapshot missing at ${hit.commit?.slice(0, 7)}`
						: 'not present at that commit'
			});
		}

		for (const path of extras) {
			const existing = await local.entry(path).catch(() => null);
			if (!existing) continue;
			if (!options.dryRun) await local.del(path);
			actions.push({ path, action: 'deleted', reason: 'not in that commit' });
		}
	} finally {
		await local.close();
	}

	return actions;
}
