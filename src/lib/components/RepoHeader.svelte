<script lang="ts">
	import Icon from './Icon.svelte';
	import type { IconName } from '$lib/icons';

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

	const tabs = $derived.by(
		(): Array<{ key: RepoTab; label: string; icon: IconName; href: string }> => [
			{ key: 'files', label: 'Files', icon: 'folder', href: `/drive/${id}` },
			{ key: 'code', label: 'Code', icon: 'code', href: `/drive/${id}/code` },
			{ key: 'commit', label: 'Commit', icon: 'commit', href: `/drive/${id}/commit` },
			{ key: 'settings', label: 'Settings', icon: 'settings', href: `/drive/${id}/settings` }
		]
	);
</script>

<header class="border-border bg-bg-secondary border-b">
	<div class="flex items-center gap-2 px-3 pt-2.5 md:px-4">
		<a
			href="/"
			title="All repositories"
			class="text-text-muted hover:text-accent rounded p-1.5 transition"
		>
			<Icon name="chevron-left" size={20} />
		</a>
		<span class="text-text-primary truncate font-mono text-sm tracking-wider">{name}</span>
		<span
			class="border-border-accent text-accent/80 shrink-0 rounded border px-2 py-0.5 font-mono text-[9px] tracking-wider uppercase"
		>
			{isGuest ? 'mirror' : visibility}
		</span>
		{#if forkedFrom}
			<span class="text-text-muted flex shrink-0 items-center gap-1 font-mono text-[9px]">
				<Icon name="fork" size={12} />
				fork
			</span>
		{/if}
	</div>

	<nav class="mt-1.5 flex gap-1 overflow-x-auto px-2 md:px-3">
		{#each tabs as tab (tab.key)}
			<a
				href={tab.href}
				class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 font-mono text-[10px] tracking-wider uppercase transition {active ===
				tab.key
					? 'border-b-accent text-accent'
					: 'text-text-muted hover:text-text-secondary border-b-transparent'}"
			>
				<Icon name={tab.icon} size={15} />
				{tab.label}
			</a>
		{/each}
	</nav>
</header>
