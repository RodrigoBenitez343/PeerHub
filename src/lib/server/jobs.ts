// Long file operations (fork a repo, commit, a sync pass) run detached from the
// request that started them. The action answers with a job id at once, the page
// keeps working, and the button polls until the job ends — no request is held
// open for the minutes a mirror or a folder sync can take.
//
// Why not `worker_threads`: the work is I/O through the repo's Hyperdrive, and a
// corestore cannot be opened twice in one process (the second open fails on the
// file lock). The write path is already async, so it yields between chunks; what
// used to block was the HTTP request waiting for the whole operation, not the
// event loop. The offload that matters is therefore "detached, with progress",
// which is what this runner provides.

export type JobState = 'running' | 'done' | 'error';

export interface JobSnapshot {
	id: string;
	kind: string;
	label: string;
	repoId: string | null;
	state: JobState;
	/** Units finished so far (files, steps). */
	done: number;
	/** Expected units, or null while the size is not known yet. */
	total: number | null;
	startedAt: number;
	finishedAt: number | null;
	result: unknown;
	error: string | null;
}

export interface JobHandle {
	progress(done: number, total?: number | null): void;
}

export interface JobSpec {
	kind: string;
	label: string;
	repoId?: string | null;
}

/**
 * True when the request came from `use:enhance` (the form can follow a job).
 * A plain form post has no JavaScript to poll, so those actions keep the old
 * blocking behaviour and still redirect.
 */
export function isEnhancedRequest(request: Request): boolean {
	return request.headers.get('x-sveltekit-action') === 'true';
}

/** Finished jobs kept for the UI; older ones are dropped. */
const KEEP_FINISHED = 50;

export class JobRunner {
	private jobs = new Map<string, JobSnapshot>();

	/** Start a job and return its snapshot before the work has run a single step. */
	start(spec: JobSpec, work: (job: JobHandle) => Promise<unknown>): JobSnapshot {
		const job: JobSnapshot = {
			id: crypto.randomUUID(),
			kind: spec.kind,
			label: spec.label,
			repoId: spec.repoId ?? null,
			state: 'running',
			done: 0,
			total: null,
			startedAt: Date.now(),
			finishedAt: null,
			result: null,
			error: null
		};
		this.jobs.set(job.id, job);
		this.trim();

		const handle: JobHandle = {
			progress(done: number, total?: number | null) {
				// A late event must not move the bar backwards.
				job.done = Math.max(job.done, Number.isFinite(done) ? done : job.done);
				if (total !== undefined) job.total = total;
			}
		};

		void (async () => {
			try {
				job.result = (await work(handle)) ?? null;
				job.state = 'done';
			} catch (err: any) {
				// Never an unhandled rejection: the failure lives on the job so the
				// page can show it (project rule: no silent failures).
				job.error = err?.message ?? String(err);
				job.state = 'error';
			} finally {
				job.finishedAt = Date.now();
				// Now that it is terminal it can be trimmed; running jobs never are.
				this.trim();
			}
		})();

		return { ...job };
	}

	get(id: string): JobSnapshot | null {
		const job = this.jobs.get(id);
		return job ? { ...job } : null;
	}

	/** Newest first, as the UI wants them. */
	list(): JobSnapshot[] {
		return [...this.jobs.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.map((job) => ({ ...job }));
	}

	private trim(): void {
		if (this.jobs.size <= KEEP_FINISHED * 2) return;
		const finished = [...this.jobs.values()]
			.filter((job) => job.state !== 'running')
			.sort((a, b) => a.startedAt - b.startedAt);
		while (finished.length > KEEP_FINISHED) {
			const oldest = finished.shift();
			if (oldest) this.jobs.delete(oldest.id);
		}
	}
}
