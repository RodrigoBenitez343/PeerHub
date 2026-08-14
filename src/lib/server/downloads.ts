import { downloadToDocument } from 'ghost-picker';
import type DriveSession from './session.js';

export type DownloadStatus = 'pending' | 'active' | 'done' | 'error';

export interface DownloadState {
	id: string;
	name: string;
	file: string;
	total: number;
	written: number;
	status: DownloadStatus;
	error?: string;
}

let nextId = 1;

// Tracks downloads that run in the background on the server: the streaming
// outlives the request that started it, so navigating away doesn't abort it.
// Clients watch progress over the /downloads/stream SSE feed.
class DownloadManager {
	private items = new Map<string, DownloadState>();
	private listeners = new Set<() => void>();
	private lastNotify = 0;

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	list(): DownloadState[] {
		return [...this.items.values()];
	}

	dismiss(id: string): void {
		if (this.items.delete(id)) this.notify(true);
	}

	// Kick off a background download and return its id immediately. The native
	// save dialog (and streaming) run without blocking the caller. Repeat calls
	// for a file already in flight return the existing id, so double-tapping
	// Download can't open two save dialogs for the same file.
	start(session: DriveSession, filePath: string): string {
		const inFlight = this.list().find(
			(d) => d.file === filePath && (d.status === 'pending' || d.status === 'active')
		);
		if (inFlight) return inFlight.id;

		const id = String(nextId++);
		const name = filePath.split('/').pop() || filePath;
		const item: DownloadState = {
			id,
			name,
			file: filePath,
			total: 0,
			written: 0,
			status: 'pending'
		};
		this.items.set(id, item);
		this.notify(true);

		downloadToDocument(session, filePath, (written: number, total: number) => {
			item.written = written;
			item.total = total;
			item.status = 'active';
			this.notify();
		})
			.then((res: { saved: boolean; cancelled?: boolean }) => {
				if (res?.cancelled) {
					this.items.delete(id);
				} else {
					item.status = 'done';
					if (item.total) item.written = item.total;
					this.scheduleRemove(id);
				}
				this.notify(true);
			})
			.catch((err: { message?: string }) => {
				item.status = 'error';
				item.error = err?.message ?? 'Download failed';
				this.scheduleRemove(id);
				this.notify(true);
			});

		return id;
	}

	// Coalesce progress bursts; status changes always notify (force = true).
	private notify(force = false): void {
		const now = Date.now();
		if (!force && now - this.lastNotify < 200) return;
		this.lastNotify = now;
		for (const fn of this.listeners) fn();
	}

	private scheduleRemove(id: string): void {
		globalThis.setTimeout(() => {
			if (this.items.delete(id)) this.notify(true);
		}, 8000);
	}
}

export const downloads = new DownloadManager();
