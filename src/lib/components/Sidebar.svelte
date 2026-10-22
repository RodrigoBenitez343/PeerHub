<script lang="ts">
	import { page } from '$app/state';
	import logo from '$lib/assets/images/ghost.png';

	type SessionInfo = {
		id: string;
		name: string;
		icon: string | null;
		peerCount: number;
	};

	let { sessions, onClose = () => {} }: { sessions: SessionInfo[]; onClose?: () => void } =
		$props();

	const activeId = $derived(page.params?.id ?? null);
</script>

<aside
	class="border-border bg-bg-secondary flex h-full w-full flex-col border-r md:w-64"
	style="padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px)"
>
	<header class="border-border flex h-11 items-center justify-between border-b px-4">
		<a href="/" class="flex items-center gap-2">
			<img src={logo} alt="" class="h-5 w-5 shrink-0 opacity-80" />
			<span class="text-accent font-mono text-[10px] tracking-[4px] uppercase">Ghost Drive</span>
		</a>
		<button
			type="button"
			aria-label="Close sidebar"
			onclick={onClose}
			class="text-text-muted hover:text-accent flex h-6 w-6 items-center justify-center rounded transition md:hidden"
		>
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-4 w-4">
				<path d="M3 3l10 10M13 3L3 13" />
			</svg>
		</button>
	</header>

	<nav class="flex-1 overflow-y-auto py-2">
		{#if sessions.length === 0}
			<div class="flex flex-col items-center gap-2 px-4 py-8 text-center">
				<img src={logo} alt="" class="h-6 w-6 opacity-20" />
				<p class="text-text-muted font-mono text-[10px] tracking-wider uppercase">No repos yet</p>
			</div>
		{:else}
			<ul>
				{#each sessions as s (s.id)}
					{@const active = s.id === activeId}
					<li>
						<a
							href={`/drive/${s.id}`}
							class="hover:bg-bg-hover flex items-center gap-3 border-l-2 px-4 py-3 transition md:px-3 md:py-2 {active
								? 'bg-bg-hover border-l-accent'
								: 'border-transparent'}"
						>
							<span
								class="bg-bg-tertiary flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded"
								class:text-accent={active}
								class:text-accent-dim={!active}
							>
								{#if s.icon}
									<img src={s.icon} alt="" class="h-full w-full object-cover" />
								{:else}
									<svg
										viewBox="0 0 16 16"
										fill="none"
										stroke="currentColor"
										stroke-width="1.2"
										class="h-3.5 w-3.5"
									>
										<path d="M2 4h12v8H2z" />
										<circle cx="12" cy="8" r="1" />
									</svg>
								{/if}
							</span>
							<span
								class="flex-1 truncate font-mono text-xs"
								class:text-text-primary={active}
								class:text-text-secondary={!active}>{s.name}</span
							>
							{#if s.peerCount > 0}
								<span class="flex items-center gap-1">
									<span
										class="bg-success h-1.5 w-1.5 rounded-full"
										style="box-shadow: 0 0 4px rgba(34,197,94,.6)"
									></span>
									<span class="text-success font-mono text-[9px]">{s.peerCount}</span>
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
			class="text-text-secondary hover:bg-bg-hover hover:text-accent flex items-center gap-2 rounded px-4 py-3 font-mono text-[10px] tracking-wider uppercase transition md:px-3 md:py-2"
		>
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				class="h-3 w-3 shrink-0"
			>
				<path d="M8 2v12M2 8h12" />
			</svg>
			New repository
		</a>
		<a
			href="/?action=join"
			class="text-text-secondary hover:bg-bg-hover hover:text-accent flex items-center gap-2 rounded px-4 py-3 font-mono text-[10px] tracking-wider uppercase transition md:px-3 md:py-2"
		>
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				class="h-3 w-3 shrink-0"
			>
				<path d="M8 2v8M4 7l4 4 4-4M2 13h12" />
			</svg>
			Join with invite
		</a>
	</footer>
</aside>
