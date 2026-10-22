<script lang="ts">
	import { page } from '$app/state';
	import logo from '$lib/assets/images/ghost-mark.png';
	import Icon from './Icon.svelte';

	type SessionInfo = {
		id: string;
		name: string;
		icon: string | null;
		peerCount: number;
	};

	let { sessions, onClose = () => {} }: { sessions: SessionInfo[]; onClose?: () => void } =
		$props();

	const activeId = $derived(page.params?.id ?? null);
	const path = $derived(page.url.pathname);
</script>

<aside
	class="border-border bg-bg-secondary flex h-full w-full flex-col border-r md:w-64"
	style="padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px)"
>
	<header class="border-border flex h-14 items-center justify-between border-b px-4">
		<a href="/" class="flex items-center gap-2.5">
			<img src={logo} alt="" class="h-10 w-10 shrink-0" />
			<span class="text-accent font-mono text-[11px] tracking-[4px] uppercase">PeerHub</span>
		</a>
		<button
			type="button"
			aria-label="Close sidebar"
			onclick={onClose}
			class="text-text-muted hover:text-accent flex h-7 w-7 items-center justify-center rounded transition md:hidden"
		>
			<Icon name="chevron-left" size={18} />
		</button>
	</header>

	<nav class="border-border border-b px-2 py-2">
		<a
			href="/"
			class="flex items-center gap-3 rounded px-2.5 py-2 font-mono text-[11px] tracking-wider uppercase transition {path ===
			'/'
				? 'bg-bg-hover text-accent'
				: 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
		>
			<Icon name="home" size={18} />
			Home
		</a>
		<a
			href="/explore"
			class="flex items-center gap-3 rounded px-2.5 py-2 font-mono text-[11px] tracking-wider uppercase transition {path ===
			'/explore'
				? 'bg-bg-hover text-accent'
				: 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
		>
			<Icon name="globe" size={18} />
			Explore
		</a>
	</nav>

	<nav class="flex-1 overflow-y-auto py-2">
		<p class="text-text-muted px-3 pt-1 pb-2 font-mono text-[9px] tracking-[3px] uppercase">
			Repositories
		</p>
		{#if sessions.length === 0}
			<div class="flex flex-col items-center gap-2 px-4 py-6 text-center">
				<Icon name="repo" size={26} class="text-text-muted opacity-30" />
				<p class="text-text-muted font-mono text-[10px] tracking-wider uppercase">No repos yet</p>
			</div>
		{:else}
			<ul>
				{#each sessions as s (s.id)}
					{@const active = s.id === activeId}
					<li>
						<a
							href={`/drive/${s.id}`}
							class="hover:bg-bg-hover flex items-center gap-3 border-l-2 px-4 py-2.5 transition md:px-3 md:py-2 {active
								? 'bg-bg-hover border-l-accent'
								: 'border-transparent'}"
						>
							<span
								class="bg-bg-tertiary flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded"
								class:text-accent={active}
								class:text-text-muted={!active}
							>
								{#if s.icon}
									<img src={s.icon} alt="" class="h-full w-full object-cover" />
								{:else}
									<Icon name="repo" size={18} />
								{/if}
							</span>
							<span
								class="flex-1 truncate font-mono text-xs"
								class:text-text-primary={active}
								class:text-text-secondary={!active}>{s.name}</span
							>
							{#if s.peerCount > 0}
								<span class="flex items-center gap-1.5">
									<span
										class="bg-success h-2 w-2 rounded-full"
										style="box-shadow: 0 0 6px rgba(52, 211, 153, 0.7)"
									></span>
									<span class="text-success font-mono text-[10px]">{s.peerCount}</span>
								</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</nav>

	<footer class="border-border border-t p-2">
		<a
			href="/?action=new"
			class="text-text-secondary hover:bg-bg-hover hover:text-accent flex items-center gap-3 rounded px-2.5 py-2.5 font-mono text-[11px] tracking-wider uppercase transition"
		>
			<Icon name="plus" size={17} />
			New repository
		</a>
		<a
			href="/?action=join"
			class="text-text-secondary hover:bg-bg-hover hover:text-accent flex items-center gap-3 rounded px-2.5 py-2.5 font-mono text-[11px] tracking-wider uppercase transition"
		>
			<Icon name="link" size={17} />
			Join with invite
		</a>
	</footer>
</aside>
