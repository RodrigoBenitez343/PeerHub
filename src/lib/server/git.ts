import b4a from 'b4a';
import { crypto_generichash } from 'sodium-native';
import type DriveSession from './session.js';
import { emitActivity } from './events.js';

// A minimal commit DAG on top of the repo's shared file system.
//
// Hyperdrive/hyperbee store the *current* tree, not history, so a commit here is
// a signed record of what the tree looked like: one digest per path, plus the
// parent commit and message. Branch/tag refs are pointers into that DAG, which
// is enough for browse, diff, history and merge-gating. Blob history (checking a
// file out at an old commit) needs content-addressed snapshots and is not part
// of this layer — see spec/PEERHUB_MVP.md "known gaps".

export const DEFAULT_BRANCH = 'main';

// Generated collection names (see build.cjs); the schema prefix is part of the id.
const REFS = '@ghostdrive/refs';
const COMMITS = '@ghostdrive/commits';

// Files above this size are digested from size+mtime instead of content: hashing
// has to buffer the file (sodium has no streaming generichash), so huge files
// would block the commit. Same-size-same-mtime edits of such a file can be
// missed, which is why the tree entry records which mode was used.
const HASH_CAP = 4 * 1024 * 1024;

export const DEFAULT_TREE_PREFIX = '/';

export interface TreeEntry {
	path: string;
	size: number;
	mtime: number | null;
	digest: string;
}

export interface Commit {
	repoId: string;
	sha: string;
	parent: string | null;
	treeDigest: string;
	authorKey: string;
	message: string;
	ts: number;
}

export interface Ref {
	repoId: string;
	name: string;
	sha: string;
}

export interface TreeChange {
	path: string;
	status: 'added' | 'removed' | 'modified';
}

function hashHex(input: string | Buffer): string {
	const out = b4a.alloc(32);
	crypto_generichash(out, typeof input === 'string' ? b4a.from(input) : input);
	return b4a.toString(out, 'hex');
}

export function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function sizeDigest(size: number, mtime: number | null): string {
	return `size:${size}:${mtime ?? 0}`;
}

async function fileDigest(session: DriveSession, path: string, size: number, mtime: number | null) {
	if (size > HASH_CAP) return sizeDigest(size, mtime);

	const chunks: Buffer[] = [];
	let seen = 0;
	for await (const chunk of session.drive!.readShared(path)) {
		chunks.push(Buffer.from(chunk));
		seen += chunk.byteLength;
		if (seen > HASH_CAP) return sizeDigest(size, mtime);
	}
	return hashHex(Buffer.concat(chunks));
}

// Snapshot the shared namespace (the repo's working tree, never the local
// offline cache) into digest entries.
export async function buildTree(
	session: DriveSession,
	prefix = DEFAULT_TREE_PREFIX
): Promise<TreeEntry[]> {
	const files = await session.drive!.manifestShared(prefix);
	const tree: TreeEntry[] = [];
	for (const file of files) {
		tree.push({
			path: file.path,
			size: file.size,
			mtime: file.mtime,
			digest: await fileDigest(session, file.path, file.size, file.mtime)
		});
	}
	return tree.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function serializeTree(tree: TreeEntry[]): string {
	return JSON.stringify(tree.map((entry) => [entry.path, entry.digest]));
}

export function parseTree(treeDigest: string | null): Array<[string, string]> {
	if (!treeDigest) return [];
	try {
		const parsed = JSON.parse(treeDigest);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is [string, string] =>
				Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
		);
	} catch {
		return [];
	}
}

export function diffTrees(baseDigest: string | null, headDigest: string | null): TreeChange[] {
	const base = new Map(parseTree(baseDigest));
	const head = new Map(parseTree(headDigest));
	const changes: TreeChange[] = [];

	for (const [path, digest] of head) {
		const before = base.get(path);
		if (before === undefined) changes.push({ path, status: 'added' });
		else if (before !== digest) changes.push({ path, status: 'modified' });
	}
	for (const path of base.keys()) {
		if (!head.has(path)) changes.push({ path, status: 'removed' });
	}

	return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// --- refs ---

export async function getRef(session: DriveSession, name: string): Promise<Ref | null> {
	const ref = (await session.getMeta(REFS, { repoId: session.id, name })) as Ref | null;
	return ref ?? null;
}

export async function listRefs(session: DriveSession): Promise<Ref[]> {
	const refs = (await session.findMeta(REFS, {
		gte: { repoId: session.id },
		lte: { repoId: session.id }
	})) as Ref[];
	return refs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createBranch(
	session: DriveSession,
	name: string,
	from = DEFAULT_BRANCH
): Promise<Ref> {
	const branch = name.trim();
	if (!branch) throw new Error('Branch name required');
	if (/\s/.test(branch)) throw new Error('Branch names cannot contain spaces');
	if (await getRef(session, branch)) throw new Error(`Branch already exists: ${branch}`);

	const base = (await getRef(session, from)) ?? (await getRef(session, DEFAULT_BRANCH));
	if (!base) throw new Error('Commit something first — a branch needs a commit to point at');

	const ref: Ref = { repoId: session.id, name: branch, sha: base.sha };
	await session.putMeta(REFS, ref);
	return ref;
}

export async function deleteBranch(
	session: DriveSession,
	name: string,
	defaultBranch = DEFAULT_BRANCH
): Promise<void> {
	const branch = name.trim();
	if (!branch) throw new Error('Branch name required');
	if (branch === defaultBranch) throw new Error(`Cannot delete the default branch: ${branch}`);
	if (!(await getRef(session, branch))) throw new Error(`No such branch: ${branch}`);
	await session.deleteMeta(REFS, { repoId: session.id, name: branch });
}

// --- commits ---

export async function getCommit(session: DriveSession, sha: string): Promise<Commit | null> {
	const commit = (await session.getMeta(COMMITS, {
		repoId: session.id,
		sha
	})) as Commit | null;
	return commit ?? null;
}

export async function listCommits(session: DriveSession, limit = 50): Promise<Commit[]> {
	const commits = (await session.findMeta(COMMITS, {
		gte: { repoId: session.id },
		lte: { repoId: session.id }
	})) as Commit[];
	// The collection is keyed (repoId, sha), so time order is applied here.
	return commits.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export async function commit(
	session: DriveSession,
	options: { message: string; authorKey: string; branch?: string }
): Promise<Commit> {
	const message = options.message.trim();
	if (!message) throw new Error('Commit message required');

	const branch = options.branch || DEFAULT_BRANCH;
	const parentRef = await getRef(session, branch);
	const tree = await buildTree(session);
	const treeDigest = serializeTree(tree);
	const ts = Date.now();
	const parent = parentRef?.sha ?? null;

	const sha = hashHex(
		JSON.stringify({
			repoId: session.id,
			parent,
			treeDigest,
			authorKey: options.authorKey,
			message,
			ts
		})
	);

	const record: Commit = {
		repoId: session.id,
		sha,
		parent,
		treeDigest,
		authorKey: options.authorKey,
		message,
		ts
	};

	await session.putMeta(COMMITS, record);
	await session.putMeta(REFS, { repoId: session.id, name: branch, sha });
	await emitActivity(session.app, {
		actorKey: options.authorKey,
		repoId: session.id,
		type: 'push',
		refId: sha
	});

	return record;
}

// What a commit would change right now: HEAD tree vs the live working tree.
export async function pendingChanges(
	session: DriveSession,
	branch = DEFAULT_BRANCH
): Promise<{ head: Commit | null; changes: TreeChange[] }> {
	const ref = await getRef(session, branch);
	const head = ref ? await getCommit(session, ref.sha) : null;
	const tree = await buildTree(session);
	return { head, changes: diffTrees(head?.treeDigest ?? null, serializeTree(tree)) };
}

// --- file contents ---

const MAX_PREVIEW = 256 * 1024;

export interface FilePreview {
	path: string;
	size: number;
	text: string | null;
	binary: boolean;
	truncated: boolean;
}

export async function previewFile(session: DriveSession, path: string): Promise<FilePreview> {
	const stat = await session.drive!.statShared(path);
	if (!stat.exists) throw new Error(`Not found: ${path}`);

	const chunks: Buffer[] = [];
	let seen = 0;
	for await (const chunk of session.drive!.readShared(path)) {
		chunks.push(Buffer.from(chunk));
		seen += chunk.byteLength;
		if (seen >= MAX_PREVIEW) break;
	}

	const bytes = Buffer.concat(chunks).subarray(0, MAX_PREVIEW);
	const binary = bytes.includes(0);
	return {
		path,
		size: stat.size,
		text: binary ? null : bytes.toString('utf-8'),
		binary,
		truncated: stat.size > bytes.byteLength
	};
}
