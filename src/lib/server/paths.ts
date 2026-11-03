// PeerHub keeps its own bookkeeping inside a repo's shared drive. Everything
// under `/.peerhub` is infrastructure, never repo content: file listings, tree
// digests, upload guards and local sync all skip it.
//
// Living inside the shared drive (instead of a separate core) means history
// replicates to every peer that has the repo, with no extra key to distribute.

export const RESERVED_ROOT = '.peerhub';
export const HISTORY_PREFIX = `/${RESERVED_ROOT}/history`;

// The release store a self-updated repo carries: the signed manifest, the
// installers it names, and one snapshot per published version (see updates.ts).
// Same status as `/.peerhub` — it belongs to the app, not to the repo's source —
// but only these exact paths are reserved, so a repo whose own source has a
// `release/` folder keeps it: `release/notes.md` is source, `release/assets/…`
// is not.
export const RELEASE_DIR = '/release';
export const RELEASE_ASSETS_DIR = `${RELEASE_DIR}/assets`;
export const RELEASE_VERSIONS_DIR = `${RELEASE_DIR}/versions`;
export const MANIFEST_FILE = `${RELEASE_DIR}/channel.json`;

function normalize(path: string): string {
	return '/' + String(path ?? '').replace(/^\/+/, '');
}

/** A path the update service owns — never shown as repo content. */
export function isReleaseStorePath(path: string): boolean {
	const clean = normalize(path).replace(/\/+$/, '');
	if (clean === MANIFEST_FILE) return true;
	return (
		clean === RELEASE_ASSETS_DIR ||
		clean.startsWith(`${RELEASE_ASSETS_DIR}/`) ||
		clean === RELEASE_VERSIONS_DIR ||
		clean.startsWith(`${RELEASE_VERSIONS_DIR}/`)
	);
}

export function isReservedRepoPath(path: string): boolean {
	const first = normalize(path).split('/')[1];
	if (first === RESERVED_ROOT) return true;
	return isReleaseStorePath(path);
}

/**
 * True when a folder holds nothing but the release store.
 *
 * Used by the file listing: a repo that only carries releases would otherwise
 * open on a folder of installers, which is exactly what the Releases tab is
 * for. A folder that mixes store and source keeps being shown.
 */
export function isStoreOnlyFolder(folder: string, children: string[]): boolean {
	const base = normalize(folder).replace(/\/+$/, '');
	if (base !== RELEASE_DIR) return false;
	return children.length > 0 && children.every((name) => isReleaseStorePath(`${base}/${name}`));
}
