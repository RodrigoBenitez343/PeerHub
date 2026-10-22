import { compileIgnore, type IgnoreMatcher, type IgnoreSource } from '$lib/ignore';
import type DriveSession from './session.js';

// Reads the repo's .gitignore files out of the shared drive and turns them into
// a matcher. Nested files are supported: rules are relative to the directory the
// file sits in.
//
// Cache: a page load plus one PUT per file would otherwise re-read the rules for
// every upload. Five seconds is short enough that a freshly edited .gitignore is
// picked up, and writes invalidate the entry explicitly.

const MAX_BYTES = 64 * 1024;
const TTL_MS = 5000;

const cache = new Map<string, { at: number; sources: IgnoreSource[] }>();

async function readIgnoreFile(session: DriveSession, path: string): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of session.drive!.readShared(path)) {
		chunks.push(Buffer.from(chunk));
		size += chunk.byteLength;
		if (size >= MAX_BYTES) break;
	}
	return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf-8');
}

export async function loadIgnoreSources(session: DriveSession): Promise<IgnoreSource[]> {
	const hit = cache.get(session.id);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.sources;

	let manifest: Array<{ path: string }> = [];
	try {
		manifest = await session.drive!.manifestShared('/');
	} catch {
		// Guest with no host reachable: no rules to apply. The upload itself will
		// fail for the same reason, so this never silently lets ignored files in.
		return [];
	}

	const sources: IgnoreSource[] = [];
	for (const entry of manifest) {
		if (entry.path !== '/.gitignore' && !entry.path.endsWith('/.gitignore')) continue;
		try {
			const text = await readIgnoreFile(session, entry.path);
			const base = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
			sources.push({ base, text });
		} catch {
			// A file listed in the manifest but unreadable is skipped; the rest of
			// the rules still apply.
		}
	}

	cache.set(session.id, { at: Date.now(), sources });
	return sources;
}

export async function loadIgnoreMatcher(session: DriveSession): Promise<IgnoreMatcher> {
	return compileIgnore(await loadIgnoreSources(session));
}

export function invalidateIgnore(repoId: string): void {
	cache.delete(repoId);
}
