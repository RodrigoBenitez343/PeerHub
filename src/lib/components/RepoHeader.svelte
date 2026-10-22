<script lang="ts">
	export type RepoTab = 'files' | 'code' | 'commit' | 'settings';

	let {
		id,
		name,
		visibility = 'public',
		active = 'files',
		isGuest = false,
		forkedFrom = null
	}: {
		id: string;
		name: string;
		visibility?: string;
		active?: RepoTab;
		isGuest?: boolean;
		forkedFrom?: string | null;
	} = $props();

	const tabs = $derived.by((): Array<{ key: RepoTab; label: string; href: string }> => [
		{ key: 'files', label: 'Files', href: `/drive/${id}` },
		{ key: 'code', label: 'Code', href: `/drive/${id}/code` },
		{ key: 'commit', label: 'Commit', href: `/drive/${id}/commit` },
		{ key: 'settings', label: 'Settings', href: `/drive/${id}/settings` }
	]);
</script>

<header class="border-border bg-bg-secondary border-b">
	<div class="flex items-center gap-2 px-3 pt-2 md:px-4">
		<a
			href="/"
			title="All repositories"
			class="text-text-muted hover:text-accent shrink-0 rounded p-1 transition"
		>
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				class="h-3.5 w-3.5"
			>
				<path d="M10 3 5 8l5 5" />
			</svg>
		</a>
		<span class="text-text-primary truncate font-mono text-xs tracking-wider">{name}</span>
		<span
			class="border-border text-text-muted shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wider uppercase"
		>
			{isGuest ? 'mirror' : visibility}
		</span>
		{#if forkedFrom}
			<span
				class="text-text-muted shrink-0 font-mono text-[9px]"
				title={`forked from ${forkedFrom}`}
			>
				fork
			</span>
		{/if}
	</div>

	<nav class="mt-1 flex gap-1 overflow-x-auto px-2 md:px-3">
		{#each tabs as tab (tab.key)}
			<a
				href={tab.href}
				class="shrink-0 border-b-2 px-2.5 py-1.5 font-mono text-[10px] tracking-wider uppercase transition {active ===
				tab.key
					? 'border-b-accent text-accent'
					: 'text-text-muted hover:text-text-secondary border-b-transparent'}"
			>
				{tab.label}
			</a>
		{/each}
	</nav>
</header>
