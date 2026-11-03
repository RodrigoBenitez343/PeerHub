import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { isReservedRepoPath } from './paths.js';

// Per-repo change log: what a peer asks for instead of the whole listing.
//
// Every host write into the shared file system appends one entry — put or del,
// with the size, mtime and content hash the entry ended up with — so a linked
// folder can ask "what happened after N?" and work only on those paths. A folder
// that has synced before never lists the repo end to end again, so a repo with
// 50k files costs what its changes cost.
//
// It is a log, not a database, and it is allowed to be incomplete. When a cursor
// is older than what is still kept (or there never was one), the host answers
// with a full listing instead — that keeps the log bounded without ever giving a
// stale cursor a confidently wrong answer.
//
// `/.peerhub` is the repo's own bookkeeping (history, chunk store) and is not
// content: it is skipped here the same way every listing skips it.

export type ChangeOp = 'put' | 'del';

export interface ChangeEntry {
	/** Strictly increasing, starting at 1. */
	seq: number;
	op: ChangeOp;
	path: string;
	size: number;
	mtime: number | null;
	hash: string | null;
	/** Version stamp of the entry in the content drive (see SharedDrive.stampOf). */
	stamp: string | null;
}

export type ChangeInput = Omit<ChangeEntry, 'seq' | 'stamp'> & { stamp?: string | null };

export interface ChangeWindow {
	/** Oldest sequence number still kept; a cursor below this cannot be served. */
	floor: number;
	/** Last sequence number included in this window. */
	head: number;
	entries: ChangeEntry[];
	/** True when more entries follow `head`. */
	more: boolean;
}

const FILE = 'changelog.jsonl';
// One entry is roughly 80 bytes, so this caps the file near 4 MB. The oldest
// part is dropped when it fills; a peer whose cursor fell off the front gets a
// full listing and carries on from there.
const MAX_ENTRIES = 50_000;
const KEEP_ENTRIES = 30_000;
const PAGE = 2000;

// The first line of the file identifies the log. A cursor only means something
// inside the log that handed it out, so a recreated log (file lost, app data
// wiped) must not answer a stale cursor out of its fresh numbers.
interface Header {
	id: string;
}

export default class ChangeLog {
	private file: string | null;
	private entries: ChangeEntry[] = [];
	private seq = 0;
	private logId = '';
	private header = false;
	private limits: { max: number; keep: number };
	private warned = false;

	constructor(
		file: string | null,
		limits: Partial<{ max: number; keep: number }> = {}
	) {
		this.file = file;
		this.limits = { max: limits.max ?? MAX_ENTRIES, keep: limits.keep ?? KEEP_ENTRIES };
		this.load();
	}

	static open(
		appDir: string | null | undefined,
		repoId: string,
		limits: Partial<{ max: number; keep: number }> = {}
	): ChangeLog {
		const file = appDir ? path.join(appDir, 'sessions', repoId, FILE) : null;
		return new ChangeLog(file, limits);
	}

	/** Last sequence number handed out; 0 for a log that never saw a write. */
	get head(): number {
		return this.seq;
	}

	/** Identity of this log. Empty until the first write. */
	get id(): string {
		return this.logId;
	}

	/** Oldest sequence number still kept. */
	get floor(): number {
		return this.entries.length > 0 ? this.entries[0].seq : this.seq + 1;
	}

	/** Record one host write. Returns null for a path that is not repo content. */
	append(change: ChangeInput): ChangeEntry | null {
		if (!change.path || isReservedRepoPath(change.path)) return null;

		this.logId ||= randomId();
		const entry: ChangeEntry = {
			seq: ++this.seq,
			op: change.op === 'del' ? 'del' : 'put',
			path: change.path,
			size: change.size > 0 ? Math.round(change.size) : 0,
			mtime: change.mtime && change.mtime > 0 ? Math.round(change.mtime) : null,
			hash: change.hash || null,
			stamp: change.stamp || null
		};

		this.entries.push(entry);
		this.write(entry);
		if (this.entries.length > this.limits.max) this.compact();
		return entry;
	}

	/**
	 * Entries newer than `cursor`, or null when this log cannot answer for it —
	 * the caller then sends a full listing instead of guessing.
	 *
	 * `logId` is the identity the caller stored with its cursor: a cursor from a
	 * different log says nothing about this one, whatever its number.
	 */
	window(cursor: number, logId?: string | null, limit = PAGE): ChangeWindow | null {
		if (logId && logId !== this.logId) return null;
		if (!Number.isFinite(cursor) || cursor < 0) return null;
		// A cursor from another log (the file was lost or compacted away) or from
		// the future (should not happen, but a wrong answer is worse than none).
		if (cursor > this.seq) return null;
		if (cursor < this.floor - 1) return null;

		const from = this.indexAfter(cursor);
		const taken = this.entries.slice(from, from + Math.max(1, Math.round(limit)));
		const head = taken.length > 0 ? taken[taken.length - 1].seq : cursor;
		return { floor: this.floor, head, entries: taken, more: head < this.seq };
	}

	/** Drop everything (the repo went away). */
	clear(): void {
		this.entries = [];
		this.seq = 0;
		this.logId = '';
		this.header = false;
		if (!this.file) return;
		try {
			fs.rmSync(this.file, { force: true });
		} catch {}
	}

	// --- storage ---

	private indexAfter(cursor: number): number {
		let lo = 0;
		let hi = this.entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.entries[mid].seq <= cursor) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	private load(): void {
		if (!this.file) return;

		let text = '';
		try {
			text = fs.readFileSync(this.file, 'utf8');
		} catch {
			return; // no log yet: the next append creates it
		}

		let torn = false;
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				// A torn line (crash mid-append) is dropped. The log rewrites itself
				// below, because the next append would otherwise join that fragment.
				torn = true;
				continue;
			}
			if (typeof parsed?.id === 'string' && parsed.path === undefined) {
				this.logId = parsed.id;
				this.header = true;
				continue;
			}
			if (typeof parsed?.seq !== 'number' || typeof parsed.path !== 'string') continue;
			this.entries.push({
				seq: parsed.seq,
				op: parsed.op === 'del' ? 'del' : 'put',
				path: parsed.path,
				size: typeof parsed.size === 'number' ? parsed.size : 0,
				mtime: typeof parsed.mtime === 'number' ? parsed.mtime : null,
				hash: typeof parsed.hash === 'string' && parsed.hash ? parsed.hash : null,
				stamp: typeof parsed.stamp === 'string' && parsed.stamp ? parsed.stamp : null
			});
			if (parsed.seq > this.seq) this.seq = parsed.seq;
		}

		if (torn) this.rewrite();
		if (this.entries.length > this.limits.max) this.compact();
	}

	private write(entry: ChangeEntry): void {
		if (!this.file) return;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// The header goes first and once: it is what a cursor is checked against.
			const head = this.header ? '' : JSON.stringify({ id: this.logId } satisfies Header) + '\n';
			fs.appendFileSync(this.file, head + JSON.stringify(entry) + '\n');
			this.header = true;
		} catch (err: any) {
			// A log that cannot be appended loses the fast path, not the data: the
			// next peer with no usable cursor gets a full listing.
			if (!this.warned) {
				this.warned = true;
				console.warn('changelog: could not append, peers will list instead:', err?.message ?? err);
			}
		}
	}

	private compact(): void {
		this.entries = this.entries.slice(-this.limits.keep);
		this.rewrite();
	}

	// Replace the file with what is in memory. Used after a torn line and after a
	// trim, so the file never disagrees with the entries this process serves.
	private rewrite(): void {
		if (!this.file) return;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const body = this.entries.map((entry) => JSON.stringify(entry) + '\n').join('');
			const head = this.header ? '' : JSON.stringify({ id: this.logId } satisfies Header) + '\n';
			fs.writeFileSync(this.file, head + body);
			this.header = true;
		} catch (err: any) {
			console.warn('changelog: could not rewrite:', err?.message ?? err);
		}
	}
}

function randomId(): string {
	return randomBytes(8).toString('hex');
}
