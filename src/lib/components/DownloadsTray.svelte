<script lang="ts">
	import { onMount } from 'svelte';
	import { formatFileSize } from '$lib';

	interface Download {
		id: string;
		name: string;
		total: number;
		written: number;
		status: 'pending' | 'active' | 'done' | 'error';
		error?: string;
	}

	let items = $state<Download[]>([]);

	// Any download still running: the streaming lives in the app process, so
	// closing the app kills it. Drives the "keep the app open" warning.
	const busy = $derived(items.some((d) => d.status === 'pending' || d.status === 'active'));

	onMount(() => {
		const es = new EventSource('/downloads/stream');
		es.addEventListener('downloads', (e) => {
			try {
				items = JSON.parse((e as MessageEvent).data);
			} catch {
				/* ignore malformed frame */
			}
		});
		return () => es.close();
	});

	function pct(d: Download): number {
		if (d.status === 'done') return 100;
		return d.total > 0 ? Math.min(100, Math.round((d.written / d.total) * 100)) : 0;
	}

	// No percentage to show: either waiting on the save dialog, or streaming a
	// file whose total size the drive didn't report. Both get a full pulsing bar.
	function indeterminate(d: Download): boolean {
		return d.status === 'pending' || (d.status === 'active' && d.total === 0);
	}

	function label(d: Download): string {
		if (d.status === 'pending') return 'Waiting for location…';
		if (d.status === 'error') return d.error ?? 'Failed';
		if (d.status === 'done') return 'Saved';
		const written = formatFileSize(d.written) ?? '0 B';
		return d.total > 0 ? `${written} / ${formatFileSize(d.total)}` : written;
	}

	function dismiss(id: string) {
		fetch('/downloads/dismiss', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id })
		}).catch(() => {});
	}
</script>

<!-- Full-width sheet on phones, corner card on wider screens. -->
{#if items.length > 0}
	<div
		class="fixed inset-x-0 bottom-0 z-50 sm:inset-x-auto sm:right-3 sm:bottom-3 sm:w-80"
		style="padding-bottom: env(safe-area-inset-bottom, 0px)"
	>
		<div class="border-border bg-bg-secondary border-t shadow-lg sm:rounded-md sm:border">
			{#if busy}
				<div
					class="border-border bg-accent/10 text-accent border-b px-3 py-2 font-mono text-[10px] leading-relaxed tracking-wider uppercase sm:rounded-t-md"
				>
					Keep the app open — closing it cancels the download
				</div>
			{/if}

			<div class="divide-border divide-y">
				{#each items as d (d.id)}
					<div class="p-3">
						<div class="flex items-baseline gap-2">
							<span class="text-text-primary flex-1 truncate font-mono text-[11px]">{d.name}</span>
							{#if d.status === 'active' && !indeterminate(d)}
								<span class="text-text-primary font-mono text-sm tabular-nums">{pct(d)}%</span>
							{/if}
							{#if d.status === 'done' || d.status === 'error'}
								<button
									type="button"
									onclick={() => dismiss(d.id)}
									class="text-text-muted hover:text-text-primary px-1 text-sm leading-none transition"
									title="Dismiss"
								>
									×
								</button>
							{/if}
						</div>

						<div class="bg-bg-tertiary mt-2 h-2 overflow-hidden rounded-full">
							<div
								class="h-full rounded-full transition-all duration-200"
								class:bg-accent={d.status !== 'error'}
								class:bg-danger={d.status === 'error'}
								class:animate-pulse={indeterminate(d)}
								style="width: {indeterminate(d) ? 100 : pct(d)}%"
							></div>
						</div>

						<div class="mt-1.5 font-mono text-[9px] tracking-wider uppercase">
							<span
								class:text-text-muted={d.status === 'active' || d.status === 'pending'}
								class:text-accent={d.status === 'done'}
								class:text-danger={d.status === 'error'}
							>
								{label(d)}
							</span>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
