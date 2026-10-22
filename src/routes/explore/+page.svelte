<script lang="ts">
	import type { PageData } from './$types';
	import Icon from '$lib/components/Icon.svelte';

	let { data }: { data: PageData } = $props();

	const scopes = [
		{ key: 'all', label: 'All' },
		{ key: 'yours', label: 'Your repos' },
		{ key: 'public', label: 'Public' },
		{ key: 'private', label: 'Private' }
	] as const;

	function scopeHref(scope: string): string {
		const params = new URLSearchParams();
		if (data.query) params.set('q', data.query);
		params.set('scope', scope);
		return `/explore?${params.toString()}`;
	}
</script>

<svelte:head>
	<title>Explore · PeerHub</title>
</svelte:head>

<div class="flex-1 overflow-auto">
	<div class="mx-auto w-full max-w-3xl px-4 py-8">
		<header class="mb-6 flex items-center gap-3">
			<span
				class="text-accent border-border-accent bg-accent/5 flex h-11 w-11 items-center justify-center rounded-lg border"
			>
				<Icon name="globe" size={22} />
			</span>
			<div class="min-w-0 flex-1">
				<h1 class="text-text-primary font-mono text-sm tracking-[3px] uppercase">Explore</h1>
				<p class="text-text-muted mt-1 text-[11px]">
					Search across your repositories and everything other peers announced.
				</p>
			</div>
		</header>

		<form method="GET" class="relative">
			<input type="hidden" name="scope" value={data.scope} />
			<span class="text-text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2">
				<Icon name="search" size={20} />
			</span>
			<input
				name="q"
				value={data.query}
				placeholder="Search repositories by name, description or owner…"
				class="border-border bg-bg-secondary text-text-primary placeholder:text-text-muted focus:border-accent w-full rounded-lg border py-3 pr-3 pl-11 font-mono text-sm transition outline-none"
			/>
		</form>

		<nav class="mt-3 flex flex-wrap gap-1.5">
			{#each scopes as scope (scope.key)}
				<a
					href={scopeHref(scope.key)}
					class="rounded-full border px-3 py-1 font-mono text-[10px] tracking-wider uppercase transition {data.scope ===
					scope.key
						? 'border-accent bg-accent/10 text-accent'
						: 'border-border text-text-muted hover:text-text-secondary'}"
				>
					{scope.label}
					<span class="ml-1 opacity-60">{data.counts[scope.key]}</span>
				</a>
			{/each}
		</nav>

		<p class="text-text-muted mt-5 mb-2 font-mono text-[9px] tracking-[3px] uppercase">
			{data.results.length} result{data.results.length === 1 ? '' : 's'}
			{#if data.query}
				for “{data.query}”
			{/if}
		</p>

		{#if data.results.length === 0}
			<div
				class="border-border text-text-muted rounded-lg border border-dashed px-4 py-10 text-center text-[11px]"
			>
				{#if data.query}
					Nothing matched. Try a shorter query, or open the Public tab to see every announced repo.
				{:else}
					No repositories here yet. Create one from Home, or wait for a peer to announce theirs.
				{/if}
			</div>
		{:else}
			<ul class="border-border divide-border divide-y overflow-hidden rounded-lg border">
				{#each data.results as repo (repo.key)}
					<li class="bg-bg-secondary hover:bg-bg-hover px-4 py-3 transition">
						<div class="flex flex-wrap items-start gap-3">
							{#if repo.kind === 'own'}
								<a
									href={`/drive/${repo.repoId}/code`}
									class="bg-bg-tertiary text-accent flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
								>
									<Icon name="repo" size={22} />
								</a>
							{:else}
								<span
									class="bg-bg-tertiary text-text-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
								>
									<Icon name="repo" size={22} />
								</span>
							{/if}

							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									{#if repo.kind === 'own'}
										<a
											href={`/drive/${repo.repoId}/code`}
											class="text-text-primary hover:text-accent truncate font-mono text-xs"
										>
											{repo.name}
										</a>
									{:else}
										<span class="text-text-primary truncate font-mono text-xs">{repo.name}</span>
									{/if}
									<span
										class="border-border text-text-muted rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wider uppercase"
									>
										{repo.mirror ? 'mirror' : repo.visibility}
									</span>
									{#if repo.kind === 'own' && !repo.mirror}
										<span class="text-text-muted font-mono text-[9px] uppercase">yours</span>
									{/if}
								</div>
								{#if repo.description}
									<p class="text-text-muted mt-1 line-clamp-2 text-[11px]">{repo.description}</p>
								{/if}
								<p class="text-text-muted mt-1 font-mono text-[9px]">
									by {repo.owner} · {repo.branch}{#if repo.peers}· {repo.peers} peer{repo.peers ===
										1
											? ''
											: 's'}{/if}
								</p>
							</div>

							<div class="flex shrink-0 items-center gap-1.5">
								{#if repo.kind === 'own'}
									<a
										href={`/drive/${repo.repoId}/code`}
										class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
									>
										Open
										<Icon name="chevron-right" size={12} />
									</a>
								{:else if repo.openable && repo.driveKey}
									<form method="POST" action="/?/open">
										<input type="hidden" name="driveKey" value={repo.driveKey} />
										<input type="hidden" name="metaKey" value={repo.metaKey ?? ''} />
										<input type="hidden" name="name" value={repo.name} />
										<input type="hidden" name="description" value={repo.description ?? ''} />
										<input type="hidden" name="ownerKey" value={repo.ownerKey} />
										<button
											type="submit"
											class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
										>
											Open
											<Icon name="chevron-right" size={12} />
										</button>
									</form>
									<form method="POST" action="/?/fork">
										<input type="hidden" name="driveKey" value={repo.driveKey} />
										<input type="hidden" name="repoId" value={repo.repoId} />
										<input type="hidden" name="name" value={repo.name} />
										<input type="hidden" name="description" value={repo.description ?? ''} />
										<button
											type="submit"
											title="Copy this repo to your device"
											class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
										>
											<Icon name="fork" size={13} />
											Fork
										</button>
									</form>
								{:else}
									<a
										href="/?action=join"
										class="text-text-muted hover:text-accent flex items-center gap-1.5 font-mono text-[9px] tracking-wider uppercase transition"
									>
										<Icon name="lock" size={13} />
										invite required
									</a>
								{/if}
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
