import Localdrive from 'localdrive';
import path from 'path';
import type PeerHubApp from './app.js';
import type DriveSession from './session.js';
import type { SyncPairView, SyncSummary } from './sync.js';
import {
	DEFAULT_BRANCH,
	commit,
	DIGEST_SIZE_CAP,
	digestBytes,
	digestStat,
	diffTrees,
	getCommit,
	getRef,
	listCommits,
	parseChanges,
	serializeTree,
	shortSha,
	type Commit,
	type TreeChange,
	type TreeEntry
} from './git.js';
import { restoreCommit, type RestoreAction } from './history.js';
import { buildIgnore, type SyncProgressFn } from './sync.js';
import { isReservedRepoPath } from './paths.js';
import { selfKeyHex } from './users.js';

// The terminal side of PeerHub: work on a linked folder the way you would on a
// git checkout, while the app keeps running and stays the only writer.
//
// Everything here goes through the running server (see api/cli/+server.ts), so
// there is one writer, one set of caches, and no second process opening the
// corestore. "Tracked" means the path is in the last commit; the local folder is
// the working tree, and a commit pushes it through the existing sync engine
// before recording the snapshot.

export interface RepoLocation {
	session: DriveSession;
	pair: SyncPairView;
}

export interface StatusReport {
	repo: { id: string; name: string; branch: string; path: string };
	head: { sha: string; short: string; message: string; ts: number } | null;
	changes: TreeChange[];
	/** Local folder entries that are not in the repo at all (subset of `changes`). */
	untracked: string[];
	clean: boolean;
	/** How the linked folder is allowed to move: 'pull' (default) or 'two-way'. */
	direction: 'pull' | 'two-way';
	/** True when a push would actually be accepted (owner, or peer writes on). */
	canPush: boolean;
}

function normalize(path: string): string {
	const withSlash = path.startsWith('/') ? path : '/' + path;
	return withSlash.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}
/** Find the repo whose linked folder contains `cwd` (longest match wins). */
export async function locateRepo(app: PeerHubApp, cwd: string): Promise<RepoLocation> {
	await app.ready();
	const target = path.resolve(cwd ?? process.cwd());
	let best: RepoLocation | null = null;

	for (const session of app.sessions.values()) {
		for (const pair of session.listSyncPairs()) {
			const root = path.resolve(pair.path);
			const relative = path.relative(root, target);
			if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
			if (!best || root.length > path.resolve(best.pair.path).length) {
				best = { session, pair };
			}
		}
	}

	if (best) return best;

	// Show the folders that are linked, so the user knows where to run the CLI.
	const repos = await listRepos(app);
	const linked = repos
		.filter((repo) => repo.pairs.length > 0)
		.map((repo) => `  ${repo.name}  ${repo.pairs[0]}`);
	throw new Error(
		`No repository is linked to ${target}. Link one from the app's Settings tab, or run:\n` +
			'  peerhub create <name> --path .' +
			(linked.length ? `\nLinked repos:\n${linked.join('\n')}` : '')
	);
}

/** Digest the local folder the same way `buildTree` digests the shared drive. */
export async function localTree(session: DriveSession, dir: string): Promise<TreeEntry[]> {
	const local = new Localdrive(dir, { atomic: true });
	await local.ready();
	const entries: TreeEntry[] = [];

	// Same rules the sync engine applies, so status never shows a file that a
	// commit would refuse to upload.
	const ignore = await buildIgnore(session, local);

	try {
		for await (const entry of local.list('/')) {
			if (!entry?.key || entry.value?.linkname) continue;
			if (isReservedRepoPath(entry.key)) continue;
			if (ignore.ignored(entry.key)) continue;

			const size = entry.value?.blob?.byteLength ?? 0;
			const mtime = typeof entry.mtime === 'number' ? entry.mtime : null;

			let digest: string;
			if (size > DIGEST_SIZE_CAP) {
				digest = digestStat(size, mtime);
			} else {
				const chunks: Buffer[] = [];
				for await (const chunk of local.createReadStream(entry.key))
					chunks.push(Buffer.from(chunk));
				digest = digestBytes(Buffer.concat(chunks));
			}

			entries.push({ path: entry.key, size, mtime, digest });
		}
	} finally {
		await local.close();
	}

	return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function headCommit(session: DriveSession, branch: string): Promise<Commit | null> {
	const ref = await getRef(session, branch);
	return ref ? await getCommit(session, ref.sha) : null;
}

export async function status(app: PeerHubApp, cwd: string): Promise<StatusReport> {
	const { session, pair } = await locateRepo(app, cwd);
	const branch = DEFAULT_BRANCH;
	const head = await headCommit(session, branch);
	const tree = await localTree(session, pair.path);
	const changes = diffTrees(head?.treeDigest ?? null, serializeTree(tree));

	return {
		repo: { id: session.id, name: session.name, branch, path: pair.path },
		head: head
			? { sha: head.sha, short: shortSha(head.sha), message: head.message, ts: head.ts }
			: null,
		changes,
		untracked: changes.filter((change) => change.status === 'added').map((change) => change.path),
		clean: changes.length === 0,
		direction: pair.direction,
		canPush: session.canWrite
	};
}

export interface CommitResult {
	sha: string;
	short: string;
	message: string;
	changes: TreeChange[];
	sync: SyncSummary | null;
}

export async function commitWorkingTree(
	app: PeerHubApp,
	cwd: string,
	message: string,
	options: { branch?: string; onProgress?: SyncProgressFn } = {}
): Promise<CommitResult> {
	if (!message?.trim()) throw new Error('Commit message required — pass -m "what changed"');

	const { session, pair } = await locateRepo(app, cwd);
	const branch = options.branch || DEFAULT_BRANCH;

	// Push the working tree into the repo first: the commit snapshots what the
	// repo holds, and the sync engine is the one component that knows how to
	// reconcile local edits, deletions and conflicts. Commit is an explicit push,
	// so it runs two-way even when the folder is normally one-way.
	const sync = await session.runSync(pair.id, {
		direction: 'two-way',
		onProgress: options.onProgress
	});

	const record = await commit(session, {
		message,
		authorKey: selfKeyHex(app),
		branch
	});

	return {
		sha: record.sha,
		short: shortSha(record.sha),
		message: record.message,
		changes: parseChanges(record.changes),
		sync
	};
}

export interface LogEntry {
	sha: string;
	short: string;
	message: string;
	ts: number;
	author: string;
	changes: TreeChange[];
}

export async function log(app: PeerHubApp, cwd: string, limit = 20): Promise<LogEntry[]> {
	const { session } = await locateRepo(app, cwd);
	const commits = await listCommits(session, limit);
	return commits.map((entry) => ({
		sha: entry.sha,
		short: shortSha(entry.sha),
		message: entry.message,
		ts: entry.ts,
		author: entry.authorKey.slice(0, 8),
		changes: parseChanges(entry.changes)
	}));
}

export interface ShowReport extends LogEntry {
	parent: string | null;
}

export async function show(app: PeerHubApp, cwd: string, sha: string): Promise<ShowReport> {
	const { session } = await locateRepo(app, cwd);
	const record = await findCommit(session, sha);
	return {
		sha: record.sha,
		short: shortSha(record.sha),
		message: record.message,
		ts: record.ts,
		author: record.authorKey.slice(0, 8),
		changes: parseChanges(record.changes),
		parent: record.parent ? shortSha(record.parent) : null
	};
}

async function findCommit(session: DriveSession, sha: string): Promise<Commit> {
	const exact = await getCommit(session, sha);
	if (exact) return exact;

	// Allow the short sha the CLI prints everywhere else.
	const matches = (await listCommits(session, 500)).filter((entry) => entry.sha.startsWith(sha));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new Error(`No commit matches ${sha}`);
	throw new Error(`Ambiguous sha ${sha}: ${matches.length} commits match`);
}

export interface RestoreReport {
	sha: string;
	short: string;
	dryRun: boolean;
	actions: RestoreAction[];
}

export async function restore(
	app: PeerHubApp,
	cwd: string,
	sha: string,
	paths: string[] = [],
	options: { dryRun?: boolean } = {}
): Promise<RestoreReport> {
	const { session, pair } = await locateRepo(app, cwd);
	const record = await findCommit(session, sha);
	const actions = await restoreCommit(session, pair.path, record.sha, paths, {
		dryRun: options.dryRun,
		// No explicit paths: make the folder match that commit exactly.
		tree: !paths || paths.length === 0
	});
	return { sha: record.sha, short: shortSha(record.sha), dryRun: !!options.dryRun, actions };
}

export async function syncNow(
	app: PeerHubApp,
	cwd: string,
	options: { push?: boolean; onProgress?: SyncProgressFn } = {}
): Promise<SyncSummary> {
	const { session, pair } = await locateRepo(app, cwd);
	// Default is whatever the folder is set to (one-way unless changed). `--push`
	// asks for a push for this run only, without changing the pair.
	return session.runSync(
		pair.id,
		options.push
			? { direction: 'two-way', onProgress: options.onProgress }
			: { onProgress: options.onProgress }
	);
}

export interface DirectionReport {
	direction: 'pull' | 'two-way';
	pair: string;
}

/** Set how a linked folder moves: one-way (pull) or two-way. */
export async function setDirection(
	app: PeerHubApp,
	cwd: string,
	direction: 'pull' | 'two-way'
): Promise<DirectionReport> {
	const { session, pair } = await locateRepo(app, cwd);
	const next = direction === 'two-way' ? 'two-way' : 'pull';
	await session.setSyncDirection(pair.id, next);
	return { direction: next, pair: pair.path };
}

export interface AutoReport {
	auto: boolean;
	autoCommit: boolean;
	direction: 'pull' | 'two-way';
	pair: string;
}

export async function setAuto(
	app: PeerHubApp,
	cwd: string,
	mode: 'on' | 'off',
	options: { commit?: boolean } = {}
): Promise<AutoReport> {
	const { session, pair } = await locateRepo(app, cwd);
	const auto = mode === 'on';
	const autoCommit = auto ? (options.commit ?? pair.autoCommit) : false;
	// An automatic checkpoint implies pushing: a periodic pass that only ever
	// pulls has nothing to commit. Make that explicit instead of silently
	// switching the folder to two-way without saying so.
	const direction = autoCommit ? 'two-way' : undefined;
	await session.setSyncAuto(pair.id, auto, autoCommit, direction);
	return {
		auto,
		autoCommit,
		direction: direction ?? pair.direction,
		pair: pair.path
	};
}

export interface RepoReport {
	id: string;
	name: string;
	visibility: string;
	writeMode: 'owner' | 'peers';
	pairs: string[];
	head: string | null;
	peers: number;
	isGuest: boolean;
}

export async function listRepos(app: PeerHubApp): Promise<RepoReport[]> {
	await app.ready();
	const repos: RepoReport[] = [];

	for (const session of app.sessions.values()) {
		const head = await headCommit(session, DEFAULT_BRANCH).catch(() => null);
		repos.push({
			id: session.id,
			name: session.name,
			visibility: 'public',
			writeMode: session.writeMode,
			pairs: session.listSyncPairs().map((pair) => pair.path),
			head: head ? shortSha(head.sha) : null,
			peers: session.peerCount,
			isGuest: session.isGuest
		});
	}

	// Visibility lives in the catalog row, not the session.
	const { listRepoMeta } = await import('./repos.js');
	const catalog = new Map((await listRepoMeta(app)).map((row) => [row.id, row]));
	for (const repo of repos) {
		repo.visibility = catalog.get(repo.id)?.visibility ?? repo.visibility;
	}

	return repos.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CreateReport {
	id: string;
	name: string;
	path: string;
	files: number;
}

export async function createRepo(
	app: PeerHubApp,
	name: string,
	dir: string,
	options: {
		visibility?: 'public' | 'private';
		sync?: boolean;
		onProgress?: SyncProgressFn;
	} = {}
): Promise<CreateReport> {
	await app.ready();
	const target = path.resolve(dir || '.');

	const session = await app.createSession({
		name: name?.trim() || path.basename(target),
		visibility: options.visibility ?? 'public'
	});

	const pair = await session.addSyncPair(target);
	// Creating a repo from a folder is an explicit push of that folder.
	const summary =
		options.sync === false
			? null
			: await session.runSync(pair.id, {
					direction: 'two-way',
					onProgress: options.onProgress
				});

	return {
		id: session.id,
		name: session.name,
		path: target,
		files: (summary?.added ?? 0) + (summary?.updated ?? 0)
	};
}

export interface RemoveReport {
	path: string;
	removed: boolean;
}

/** Remove a path from both the local folder and the repo. */
export async function removePath(
	app: PeerHubApp,
	cwd: string,
	target: string
): Promise<RemoveReport> {
	const { session, pair } = await locateRepo(app, cwd);
	const repoPath = normalize(target);

	const local = new Localdrive(pair.path, { atomic: true });
	await local.ready();
	let removed = false;
	try {
		if (await local.entry(repoPath).catch(() => null)) {
			await local.del(repoPath);
			removed = true;
		}
	} finally {
		await local.close();
	}

	const exists = await session.drive!.statShared(repoPath).catch(() => null);
	if (exists?.exists) {
		await session.deleteFile(repoPath);
		removed = true;
	}

	return { path: repoPath, removed };
}

/** One-shot dispatch used by the HTTP endpoint; keeps the command list in one place. */
export interface CliRequest {
	cmd: string;
	cwd?: string;
	message?: string;
	sha?: string;
	paths?: string[];
	name?: string;
	dir?: string;
	visibility?: 'public' | 'private';
	mode?: 'on' | 'off';
	commit?: boolean;
	push?: boolean;
	direction?: 'pull' | 'one-way' | 'two-way';
	dryRun?: boolean;
	limit?: number;
	/** Ask for an NDJSON progress stream instead of one JSON answer. */
	stream?: boolean;
}

export async function runCli(
	app: PeerHubApp,
	request: CliRequest,
	onProgress?: SyncProgressFn
): Promise<unknown> {
	const cwd = request.cwd || process.cwd();

	switch (request.cmd) {
		case 'status':
			return status(app, cwd);
		case 'commit':
			return commitWorkingTree(app, cwd, request.message ?? '', { onProgress });
		case 'log':
			return log(app, cwd, request.limit ?? 20);
		case 'show':
			if (!request.sha) throw new Error('commit sha required');
			return show(app, cwd, request.sha);
		case 'restore':
			if (!request.sha) throw new Error('commit sha required');
			return restore(app, cwd, request.sha, request.paths ?? [], { dryRun: request.dryRun });
		case 'sync':
			return syncNow(app, cwd, { push: request.push, onProgress });
		case 'auto':
			return setAuto(app, cwd, request.mode ?? 'on', { commit: request.commit });
		case 'direction':
			// Accept the words people type ('one-way') as well as the internal name
			// ('pull'), so the CLI and the API cannot disagree about the vocabulary.
			if (request.direction === 'pull' || request.direction === 'one-way') {
				return setDirection(app, cwd, 'pull');
			}
			if (request.direction === 'two-way') return setDirection(app, cwd, 'two-way');
			throw new Error("direction must be 'one-way' or 'two-way'");
		case 'repos':
			return listRepos(app);
		case 'create':
			if (!request.name) throw new Error('Repository name required');
			return createRepo(app, request.name, request.dir ?? cwd, {
				visibility: request.visibility,
				onProgress
			});
		case 'rm':
			if (!request.paths?.length) throw new Error('Path required');
			return removePath(app, cwd, request.paths[0]);
		default:
			throw new Error(`Unknown command: ${request.cmd}`);
	}
}
