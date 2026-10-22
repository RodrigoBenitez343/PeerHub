<script lang="ts">
	import './layout.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import DownloadsTray from '$lib/components/DownloadsTray.svelte';
	import type { LayoutData } from './$types';
	import { page } from '$app/state';
	import logo from '$lib/assets/images/ghost-icon.png';

	let { data, children }: { data: LayoutData; children: any } = $props();

	let sidebarOpen = $state(false);

	$effect(() => {
		page.url.pathname;
		sidebarOpen = false;
	});
</script>

<svelte:head>
	<title>Ghost Drive</title>
	<link rel="icon" href={logo} />
</svelte:head>

<div
	class="bg-bg-primary text-text-primary relative flex w-screen overflow-hidden"
	style="height: 100dvh;"
>
	<!-- Sidebar: fixed column on desktop, slide-over on mobile -->
	<div
		class="absolute inset-y-0 left-0 z-40 w-3/4 transition-transform sm:w-auto md:relative md:translate-x-0"
		class:-translate-x-full={!sidebarOpen}
		class:translate-x-0={sidebarOpen}
	>
		<Sidebar sessions={data.sessions} onClose={() => (sidebarOpen = false)} />
	</div>

	<!-- Backdrop on mobile -->
	{#if sidebarOpen}
		<button
			type="button"
			aria-label="Close sidebar"
			onclick={() => (sidebarOpen = false)}
			class="absolute inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
		></button>
	{/if}

	<main class="flex min-w-0 flex-1 flex-col overflow-hidden">
		<!-- Mobile-only top bar -->
		<div
			class="border-border bg-bg-secondary border-b md:hidden"
			style="padding-top: env(safe-area-inset-top, 0px)"
		>
			<div class="flex h-11 items-center gap-3 px-3">
				<button
					type="button"
					aria-label="Open menu"
					onclick={() => (sidebarOpen = !sidebarOpen)}
					class="text-text-secondary hover:text-accent shrink-0 rounded p-1.5 transition"
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						class="h-5 w-5"
					>
						<path d="M3 6h18M3 12h18M3 18h18" />
					</svg>
				</button>
				<span
					class="text-text-secondary min-w-0 flex-1 truncate font-mono text-[10px] tracking-[3px] uppercase"
				>
					{data.sessions.find((s: any) => s.id === page.params?.id)?.name ?? 'Ghost Drive'}
				</span>
			</div>
		</div>

		{@render children()}
	</main>

	<DownloadsTray />
</div>
