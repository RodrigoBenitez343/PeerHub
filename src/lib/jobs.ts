// Client side of a background job: the action returns `{ jobId }`, the button
// stays in its pending state, and this polls the server until the job is done.
// The promise resolves with the finished job (which carries `result`), rejects
// with the job's error, and rejects if the job never appears.

export type JobState = 'running' | 'done' | 'error';

export interface JobView {
	id: string;
	kind: string;
	label: string;
	repoId: string | null;
	state: JobState;
	done: number;
	total: number | null;
	startedAt: number;
	finishedAt: number | null;
	result: any;
	error: string | null;
}

export interface WatchOptions {
	/** Poll interval in ms (default 600). */
	intervalMs?: number;
	/** Give up after this long (default 15 min). */
	timeoutMs?: number;
	/** Called on every poll, including the first. */
	onUpdate?: (job: JobView) => void;
	/** Poll immediately instead of waiting one interval first. */
	immediate?: boolean;
}

export async function fetchJob(id: string): Promise<JobView> {
	const res = await fetch(`/api/jobs?id=${encodeURIComponent(id)}`, {
		headers: { accept: 'application/json' },
		cache: 'no-store'
	});
	if (res.status === 404) throw new Error('The server forgot this operation (it was restarted).');
	if (!res.ok) throw new Error((await res.text()) || res.statusText);
	const body = await res.json();
	if (!body?.job) throw new Error('Malformed job response');
	return body.job as JobView;
}

export async function watchJob(id: string, options: WatchOptions = {}): Promise<JobView> {
	const intervalMs = options.intervalMs ?? 600;
	const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);

	for (;;) {
		if (options.immediate !== false) {
			const job = await fetchJob(id);
			options.onUpdate?.(job);
			if (job.state === 'done') return job;
			if (job.state === 'error') throw new Error(job.error ?? 'The operation failed');
		}
		options.immediate = true;

		if (Date.now() > deadline) throw new Error('The operation did not finish in time');
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
