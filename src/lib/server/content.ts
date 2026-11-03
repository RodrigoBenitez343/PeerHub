import fs from 'fs';
import path from 'path';
import { decodeEntryMeta, encodeEntryMeta, writeIntoStream } from './shared-drive.js';
import { cappedDigest } from './sync.js';
import { isReservedRepoPath } from './paths.js';
import type DriveSession from './session.js';

// Repo content used to live in `sessions/<id>/shared`, a plain folder on the
// owner's disk: every peer that wanted a byte had to ask the owner's process for
// it, one whole file per round trip. Content now lives in the repo's own
// Hyperdrive, whose cores replicate over the connection that is already open, so
// a peer pulls the blocks it asks for instead of the owner sending files.
//
// Moving the old folder happens once per repo, on open: hash the local file, copy
// it into the drive with that hash and its mtime as entry metadata, check the
// drive holds the number of bytes it should, and only then drop the local copy. A
// copy that cannot be verified keeps the file where it is and is reported — a
// half-migrated repo must never lose the only copy of a file.
//
// Symlinks stay in the folder: re-creating one in the drive would change what it
// points at, and the folder is still served while it holds them.

const MARKER = 'content-migrated.json';

export interface MigrationReport {
	moved: number;
	already: number;
	/** Paths whose local copy stays put, with the reason. */
	failed: string[];
	bytes: number;
}

function markerFile(session: DriveSession): string | null {
	const dir = session.app?.dir;
	if (!dir) return null;
	return path.join(dir, 'sessions', session.id, MARKER);
}

/** Has this repo already been moved? Failures leave no marker, so they retry. */
export function migrationDone(session: DriveSession): boolean {
	const file = markerFile(session);
	if (!file) return false;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		return !!parsed && typeof parsed.at === 'number';
	} catch {
		return false;
	}
}

function writeMarker(session: DriveSession, report: MigrationReport): void {
	const file = markerFile(session);
	if (!file) return;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({
				at: Date.now(),
				moved: report.moved,
				already: report.already,
				bytes: report.bytes
			})
		);
	} catch (err: any) {
		// Without a marker the next open simply checks every path again: the copies
		// that succeeded are already gone from the folder, so it is cheap.
		console.warn('content migration marker not written:', err?.message ?? err);
	}
}

/**
 * Copy the legacy `sessions/<id>/shared` folder into the repo's content drive.
 *
 * Returns null when there is nothing to do: a guest (it never owns the folder),
 * a repo without a content drive, or a repo already migrated. Callers only log.
 */
export async function migrateLegacyShared(
	session: DriveSession,
	options: { force?: boolean } = {}
): Promise<MigrationReport | null> {
	const shared = session.shared;
	const content = session.content;
	if (!shared || !content) return null;
	if (session.isGuest) return null;
	if (!options.force && migrationDone(session)) return null;

	const report: MigrationReport = { moved: 0, already: 0, failed: [], bytes: 0 };
	const supportsMeta = (content as any).supportsMetadata === true;

	// A repo created after content moved into the drive never had this folder. That
	// is not a failure: there is nothing to move, and the marker says so.
	if (!fs.existsSync(shared.root)) {
		writeMarker(session, report);
		return report;
	}

	for await (const entry of shared.list('/')) {
		if (!entry?.key) continue;
		if (entry.value?.linkname) continue; // see the note above about symlinks
		if (isReservedRepoPath(entry.key)) continue;

		const filePath: string = entry.key;
		const size = entry.value?.blob?.byteLength ?? 0;
		const mtime = typeof entry.mtime === 'number' ? entry.mtime : Date.now();

		try {
			// One read to know what the bytes are; the metadata has to carry the hash
			// from the start, and a second read is cheaper than rewriting the entry.
			const digest = await cappedDigest(shared.createReadStream(filePath)).catch(() => undefined);
			const existing = await content.entry(filePath).catch(() => null);
			const have = existing?.value?.blob?.byteLength ?? null;
			const haveHash = decodeEntryMeta(existing?.value?.metadata).hash;

			const identical =
				have === size && (digest ? haveHash === digest : haveHash === null && have === size);
			if (identical) {
				await shared.del(filePath);
				report.already++;
				continue;
			}

			const encoded = encodeEntryMeta({ mtime, hash: digest ?? null });
			const meta = supportsMeta && encoded ? { metadata: encoded } : {};
			await writeIntoStream(
				content.createWriteStream(filePath, meta),
				shared.createReadStream(filePath)
			);

			const after = await content.entry(filePath).catch(() => null);
			const written = after?.value?.blob?.byteLength;
			if (written !== size) {
				throw new Error(`drive holds ${written ?? 'nothing'} of ${size} bytes`);
			}

			await shared.del(filePath);
			report.moved++;
			report.bytes += size;
		} catch (err: any) {
			// The local copy stays: it is still served from the folder, so the repo
			// keeps working, and the next open tries this path again.
			report.failed.push(`${filePath}: ${err?.message ?? err}`);
		}
	}

	if (report.failed.length === 0) writeMarker(session, report);
	return report;
}
