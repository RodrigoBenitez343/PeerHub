<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	let {
		driveId,
		initial,
		reconnectSignal = 0,
		onchange
	}: {
		driveId: string;
		initial: number;
		reconnectSignal?: number;
		onchange?: (count: number) => void;
	} = $props();

	let peers = $state(initial);

	onMount(() => {
		onchange?.(initial);
	});

	$effect(() => {
		reconnectSignal; // reactive dependency — changing this closes and reopens the SSE
		const es = new EventSource(`/drive/${driveId}/stream`);
		es.addEventListener('peers', (e) => {
			try {
				const { count } = JSON.parse((e as MessageEvent).data);
				if (count !== peers) {
					peers = count;
					onchange?.(count);
					invalidateAll();
				}
			} catch {}
		});
		es.addEventListener('drives-changed', () => invalidateAll());
		return () => es.close();
	});
</script>

<span
	class="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase"
	class:text-success={peers > 0}
	class:text-text-muted={peers === 0}
>
	<span
		class="block h-1.5 w-1.5 shrink-0 rounded-full"
		class:bg-success={peers > 0}
		class:bg-text-muted={peers === 0}
		style:box-shadow={peers > 0 ? '0 0 6px rgba(34,197,94,.6)' : 'none'}
	></span>
	<span class="hidden sm:inline">{peers} {peers === 1 ? 'peer' : 'peers'}</span>
</span>
