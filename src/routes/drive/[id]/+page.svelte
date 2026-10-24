<script lang="ts">
	import type { PageData } from './$types';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import FileGrid from '$lib/components/FileGrid.svelte';
	import LivePeerCount from '$lib/components/LivePeerCount.svelte';
	import RepoHeader from '$lib/components/RepoHeader.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import { invalidateAll } from '$app/navigation';

	type Entry = { name: string; isFolder: boolean; cached?: boolean; size: number | null };

	let { data }: { data: PageData } = $props();

	let peers = $state(0);
	let connectionLost = $state(false);
	let reconnectSignal = $state(0);
	let cachedEntries = $state<Entry[] | null>(null);

	$effect(() => {
		let cancelled = false;
		(async () => {
			cachedEntries = await data.entries;
			if (data.fresh && !cancelled) {
				cachedEntries = await data.fresh;
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	function handlePeersChange(n: number) {
		if (n === 0 && peers > 0) connectionLost = true;
		else if (n > 0) connectionLost = false;
		peers = n;
	}

	function retry() {
		reconnectSignal++;
		invalidateAll();
	}
</script>

{#await data.drive}
	<header class="border-border bg-bg-secondary flex h-11 items-center border-b px-3 md:px-4">
		<div class="bg-bg-tertiary h-3 w-40 animate-pulse rounded opacity-50"></div>
	</header>
{:then drive}
	<RepoHeader
		id={drive.id}
		name={drive.name}
		visibility={data.repo.visibility}
		active="files"
		isGuest={drive.isGuest}
		canWrite={drive.canWrite}
		sourceRemoved={data.repo.sourceRemoved}
		forkedFrom={data.repo.forkedFrom}
	/>
	<div class="border-border bg-bg-secondary flex items-center gap-2 border-b px-3 py-1.5 md:px-4">
		<div class="min-w-0 flex-1">
			<Breadcrumbs driveId={drive.id} driveName={drive.name} path={data.path} />
		</div>
		<LivePeerCount
			driveId={drive.id}
			initial={drive.peerCount}
			{reconnectSignal}
			onchange={handlePeersChange}
		/>
	</div>

	{#if drive.isGuest && !drive.canWrite}
		<div
			class="border-border bg-bg-secondary border-l-accent-dim flex items-center gap-3 border-b border-l-2 px-4 py-2"
		>
			<span class="bg-accent block h-1.5 w-1.5 shrink-0 rounded-full"></span>
			<span class="text-text-secondary flex-1 font-mono text-[10px] tracking-wider">
				One-way repository · the owner has not enabled peer writes, so this is a read-only copy
			</span>
		</div>
	{/if}

	{#if drive.isGuest && peers === 0}
		<div
			class="flex items-center gap-3 border-b px-4 py-2 {connectionLost
				? 'border-danger/40 bg-danger/5 border-l-danger border-l-2'
				: 'border-border border-l-text-muted bg-bg-secondary border-l-2'}"
		>
			<span
				class="block h-1.5 w-1.5 shrink-0 rounded-full"
				class:bg-danger={connectionLost}
				class:bg-text-muted={!connectionLost}
				class:animate-pulse={!connectionLost}
			></span>
			<span
				class="flex-1 font-mono text-[10px] tracking-wider"
				class:text-danger={connectionLost}
				class:text-text-secondary={!connectionLost}
			>
				{#if connectionLost}
					Connection lost · showing cached files only
				{:else}
					Waiting for host · files will appear when connected
				{/if}
			</span>
			<button
				type="button"
				onclick={retry}
				class="font-mono text-[10px] tracking-wider uppercase transition"
				class:text-danger={connectionLost}
				class:text-accent={!connectionLost}
			>
				Retry
			</button>
		</div>
	{/if}

	<section class="flex-1 overflow-auto">
		{#await data.entries}
			{#if cachedEntries !== null}
				<FileGrid
					driveId={drive.id}
					path={data.path}
					entries={cachedEntries}
					{peers}
					isGuest={drive.isGuest}
					canWrite={drive.canWrite}
					ignore={data.ignore}
				/>
			{:else}
				<div
					class="grid gap-3 p-4"
					style="grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));"
				>
					{#each Array.from({ length: 12 }) as _, i}
						<div class="flex flex-col items-center gap-2.5 rounded-lg p-3">
							<div
								class="bg-bg-tertiary h-14 w-14 animate-pulse rounded-lg opacity-60"
								style="animation-delay: {i * 40}ms"
							></div>
							<div
								class="bg-bg-tertiary h-2 animate-pulse rounded opacity-40"
								style="width: {50 + (i % 4) * 12}%; animation-delay: {i * 40 + 80}ms"
							></div>
						</div>
					{/each}
				</div>
			{/if}
		{:then entries}
			<FileGrid
				driveId={drive.id}
				path={data.path}
				entries={cachedEntries ?? entries}
				{peers}
				isGuest={drive.isGuest}
				canWrite={drive.canWrite}
				ignore={data.ignore}
			/>
		{/await}

		{#if data.readme}
			<article class="border-border mx-auto mt-2 max-w-4xl border-t px-4 py-6 md:px-6">
				<div class="mb-4 flex items-center gap-2">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="text-text-muted h-3.5 w-3.5"
					>
						<path d="M4 4h6l2 2h8v12H4z" />
					</svg>
					<a
						href={`/drive/${drive.id}/code?path=${encodeURIComponent(data.readme.path)}`}
						class="text-text-secondary hover:text-accent font-mono text-[10px] tracking-[2px] uppercase transition"
					>
						{data.readme.path.slice(1)}
					</a>
				</div>
				<Markdown html={data.readme.html} />
			</article>
		{/if}
	</section>
{/await}
