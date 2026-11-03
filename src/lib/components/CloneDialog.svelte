<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { watchJob } from '$lib/jobs';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	// Clone dialog: where the repo lands is the only question, then the first
	// sync runs as a job so a big repo reports progress instead of freezing.
	//
	// The folder comes from the desktop shell (`window.peerhub.pickFolder`): the
	// OS chooser is the only way to get a real path, so a browser tab explains
	// that instead of pretending an input field would do.

	let {
		id,
		name,
		open = $bindable(false)
	}: { id: string; name: string; open?: boolean } = $props();

	interface Target {
		path: string;
		state: 'new' | 'empty' | 'this-repo' | 'other-repo' | 'foreign';
		owner: { id: string; name: string } | null;
		files: number;
		needsConfirm: boolean;
	}

	let folder = $state('');
	let busy = $state(false);
	let error = $state('');
	let progress = $state<{ done: number; total: number | null } | null>(null);
	let confirmTarget = $state<Target | null>(null);
	let cloned = $state<{ path: string; message: string } | null>(null);

	const shell = () =>
		(globalThis as any).peerhub as
			| {
					pickFolder?: (title?: string) => Promise<string | null>;
					openPath?: (p: string) => Promise<string>;
			  }
			| undefined;

	function reset() {
		folder = '';
		error = '';
		progress = null;
		confirmTarget = null;
		cloned = null;
		busy = false;
	}

	function close() {
		if (busy) return;
		open = false;
		reset();
	}

	async function choose() {
		error = '';
		const pick = shell()?.pickFolder;
		if (!pick) {
			error = 'Choosing a folder needs the PeerHub desktop app.';
			return;
		}
		try {
			const chosen = await pick(`Clone ${name} into…`);
			if (!chosen) return;
			folder = chosen;
			confirmTarget = null;
			cloned = null;
		} catch (err: any) {
			error = err?.message ?? 'Could not open the folder chooser';
		}
	}

	async function clone(confirm = false) {
		if (!folder) {
			await choose();
			if (!folder) return;
		}

		busy = true;
		error = '';
		try {
			const body = new FormData();
			body.set('path', folder);
			if (confirm) body.set('confirm', '1');

			// A plain endpoint, so the answer is the answer: no wrapper to unwrap and
			// no case where a failure arrives without its reason.
			const res = await fetch(`/api/clone/${id}`, { method: 'POST', body });
			const answer = await res.json().catch(() => null);
			if (!answer) throw new Error(`Clone failed (${res.status})`);
			if (answer.error) throw new Error(answer.error);
			if (answer.needsConfirm) {
				confirmTarget = answer.target as Target;
				return;
			}
			if (!answer.jobId) throw new Error(`Clone failed (${res.status}): no job started`);

			const job = await watchJob(answer.jobId, {
				onUpdate: (view) => (progress = { done: view.done, total: view.total })
			});
			const done = job.result;
			if (!done?.summary) {
				// The job finished, so say what it finished as instead of guessing.
				throw new Error(`Clone job ended as ${job.state} without a summary`);
			}

			cloned = { path: done.path ?? folder, message: done.message ?? 'Clone done' };
			confirmTarget = null;
			// The settings list and the file grid both changed.
			await invalidateAll();
		} catch (err: any) {
			error = err?.message ?? String(err);
		} finally {
			busy = false;
			progress = null;
		}
	}

	async function reveal() {
		if (cloned) await shell()?.openPath?.(cloned.path);
	}

	function warning(target: Target): string {
		if (target.state === 'other-repo') {
			return `That folder is already the clone of ${target.owner?.name ?? 'another repository'}. Cloning ${name} there replaces those files, and deletes anything ${name} does not have.`;
		}
		return `That folder already holds ${target.files >= 100 ? 'more than 100' : target.files} files. Cloning ${name} there replaces them, and deletes anything ${name} does not have.`;
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		transition:fade={{ duration: 120 }}
	>
		<div
			class="border-border bg-bg-secondary mx-4 w-full max-w-lg rounded-lg border p-6 shadow-2xl"
			transition:scale={{ duration: 150, start: 0.96 }}
		>
			<div class="mb-4 flex items-center justify-between gap-3">
				<h3 class="text-accent font-mono text-xs tracking-[3px] uppercase">Clone {name}</h3>
				<button
					type="button"
					onclick={close}
					disabled={busy}
					class="text-text-muted hover:text-text-primary px-1 font-mono text-sm transition disabled:opacity-40"
					title="Close"
				>
					×
				</button>
			</div>

			{#if cloned}
				<p class="text-success mb-1 font-mono text-[11px]">Cloned.</p>
				<p class="text-text-muted mb-1 font-mono text-[10px] break-all">{cloned.path}</p>
				<p class="text-text-secondary mb-4 font-mono text-[10px]">{cloned.message}</p>
				<p class="text-text-muted mb-4 font-mono text-[9px] leading-relaxed">
					The folder is one-way and mirrors the repo: additions, edits and deletions made by the
					owner land here on their own.
				</p>
				<div class="flex justify-end gap-2">
					{#if shell()?.openPath}
						<button
							type="button"
							onclick={reveal}
							class="text-text-secondary hover:text-text-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition"
						>
							Open folder
						</button>
					{/if}
					<button
						type="button"
						onclick={close}
						class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition hover:brightness-110"
					>
						Done
					</button>
				</div>
			{:else}
				<p class="text-text-secondary mb-3 font-mono text-[10px] leading-relaxed">
					Choose an empty folder. The repository is copied into it, then kept in step: files the
					owner adds, changes or deletes follow automatically.
				</p>

				<div class="border-border bg-bg-tertiary mb-3 rounded border px-3 py-2">
					{#if folder}
						<p class="text-text-primary font-mono text-[10px] break-all">{folder}</p>
					{:else}
						<p class="text-text-muted font-mono text-[10px]">No folder chosen</p>
					{/if}
				</div>

				{#if confirmTarget}
					<div class="border-danger bg-bg-tertiary mb-3 rounded border px-3 py-2">
						<p class="text-danger mb-2 font-mono text-[10px] leading-relaxed">
							{warning(confirmTarget)}
						</p>
						<button
							type="button"
							onclick={() => clone(true)}
							disabled={busy}
							class="border-danger text-danger hover:bg-danger hover:text-bg-primary rounded border px-3 py-1.5 font-mono text-[9px] tracking-wider uppercase transition disabled:opacity-50"
						>
							Replace those files and clone
						</button>
					</div>
				{/if}

				{#if busy}
					<p class="text-text-muted mb-3 flex items-center gap-2 font-mono text-[10px]">
						<Spinner size={11} />
						{progress?.total
							? `${progress.done}/${progress.total} files`
							: 'cloning — scanning the folder…'}
					</p>
				{/if}

				{#if error}
					<p class="text-danger mb-3 font-mono text-[10px] leading-relaxed">{error}</p>
				{/if}

				<div class="flex items-center justify-end gap-2">
					<button
						type="button"
						onclick={choose}
						disabled={busy}
						class="text-text-secondary hover:text-text-primary flex items-center gap-1.5 rounded px-3 py-2 font-mono text-[10px] tracking-wider uppercase transition disabled:opacity-40"
					>
						<Icon name="folder-open" size={13} />
						{folder ? 'Choose another' : 'Choose folder'}
					</button>
					<button
						type="button"
						onclick={() => clone(false)}
						disabled={busy}
						class="bg-accent text-bg-primary flex items-center gap-1.5 rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition hover:brightness-110 disabled:opacity-50"
					>
						{#if busy}<Spinner size={11} />{/if}
						{folder ? 'Clone here' : 'Choose and clone'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
