// PeerHub keeps its own bookkeeping inside a repo's shared drive. Everything
// under `/.peerhub` is infrastructure, never repo content: file listings, tree
// digests, upload guards and local sync all skip it.
//
// Living inside the shared drive (instead of a separate core) means history
// replicates to every peer that has the repo, with no extra key to distribute.

export const RESERVED_ROOT = '.peerhub';
export const HISTORY_PREFIX = `/${RESERVED_ROOT}/history`;

export function isReservedRepoPath(path: string): boolean {
	const first = path.replace(/^\/+/, '').split('/')[0];
	return first === RESERVED_ROOT;
}
