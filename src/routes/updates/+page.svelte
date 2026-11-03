<script lang="ts">
	import type { PageData } from './$types';
	import Icon from '$lib/components/Icon.svelte';

	let { data }: { data: PageData } = $props();

	// The load function answers with the snapshot the server holds; a download
	// keeps running after the page renders, so the component polls that same
	// endpoint while one is in flight instead of reloading the whole page. A fresh
	// load (a form action) wins over whatever the poll last saw.
	let polled = $state<PageData['state'] | null>(null);
	const live = $derived(polled ?? data.state);

	$effect(() => {
		data.state;
		polled = null;
	});

	const downloading = $derived(live?.status === 'downloading');

	$effect(() => {
		if (!downloading) return;
		const timer = setInterval(async () => {
			try {
				const res = await fetch('/api/updates');
				const body = await res.json();
				if (body?.state) polled = body.state;
			} catch {
				// The app is going away (an install restarts it); the next load tells.
			}
		}, 1000);
		return () => clearInterval(timer);
	});

	const percent = $derived(
		live?.progress && live.progress.total > 0
			? Math.min(100, Math.round((live.progress.received / live.progress.total) * 100))
			: 0
	);

	function bytes(value: number | null | undefined): string {
		const n = Number(value) || 0;
		if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
		if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
		if (n >= 1024) return `${Math.round(n / 1024)} KB`;
		return `${n} B`;
	}

	function when(ts: number | null): string {
		if (!ts) return 'never';
		return new Date(ts).toLocaleString();
	}
</script>

<svelte:head>
	<title>Updates · PeerHub</title>
</svelte:head>

<div class="flex-1 overflow-auto">
	<div class="mx-auto w-full max-w-3xl px-4 py-8">
		<header class="mb-6 flex items-center gap-3">
			<span
				class="text-accent border-border-accent bg-accent/5 flex h-11 w-11 items-center justify-center rounded-lg border"
			>
				<Icon name="download" size={22} />
			</span>
			<div class="min-w-0 flex-1">
				<h1 class="text-text-primary font-mono text-sm tracking-[3px] uppercase">Updates</h1>
				<p class="text-text-muted mt-1 text-[11px]">
					PeerHub updates itself from a release repo, the same way it moves files between peers.
				</p>
			</div>
			<span
				class="border-border text-text-secondary rounded border px-2 py-1 font-mono text-[10px]"
			>
				v{live?.version ?? '—'}
			</span>
		</header>

		{#if !live}
			<div
				class="border-border text-text-muted rounded-lg border border-dashed px-4 py-10 text-center text-[11px]"
			>
				The server is not running in this tab, so there is nothing to update from.
			</div>
		{:else}
			<section class="border-border bg-bg-secondary mb-4 rounded-lg border p-4">
				<div class="flex flex-wrap items-start gap-3">
					<div class="min-w-0 flex-1">
						<p class="text-text-primary font-mono text-xs">
							{#if live.status === 'ready'}
								PeerHub {live.target?.version} is downloaded and verified
							{:else if live.status === 'available'}
								PeerHub {live.target?.version} is available
							{:else if live.status === 'downloading'}
								Downloading PeerHub {live.target?.version}… {percent}%
							{:else if live.status === 'checking'}
								Checking for a newer release…
							{:else if live.status === 'current'}
								You are on the newest release
							{:else if live.status === 'error'}
								The update could not be completed
							{:else}
								Not checked from this screen yet
							{/if}
						</p>
						<p class="text-text-muted mt-1 font-mono text-[10px]">
							release repo
							<span class="text-text-secondary">{live.repo?.name ?? live.settings.repo}</span>
							· last check {when(live.checkedAt)}
							{#if live.repo}
								· {live.repo.isGuest ? 'mirror' : 'owner'}{live.repo.peers
									? ` · ${live.repo.peers} connected`
									: ''}{#if live.repo.folder}
									· {live.repo.folder}{/if}
							{:else}
								· not opened here yet
							{/if}
						</p>
						{#if live.error}
							<p class="text-danger mt-2 font-mono text-[10px]">{live.error}</p>
						{/if}
						{#if live.target?.notes}
							<pre
								class="text-text-secondary mt-2 max-h-40 overflow-auto font-mono text-[10px] whitespace-pre-wrap">{live
									.target.notes}</pre>
						{/if}
						{#if live.target?.asset}
							<p class="text-text-muted mt-2 font-mono text-[10px]">
								{live.target.asset.name} · {bytes(live.target.asset.size)} · sha256 {live.target.asset.sha256.slice(
									0,
									12
								)}…
							</p>
						{/if}
					</div>

					<div class="flex shrink-0 flex-wrap items-center gap-1.5">
						<form method="POST" action="?/check">
							<button
								type="submit"
								class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
							>
								<Icon name="refresh" size={12} />
								Check
							</button>
						</form>

						{#if live.status === 'available' || live.status === 'error'}
							<form method="POST" action="?/download">
								<button
									type="submit"
									class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
								>
									<Icon name="download" size={12} />
									Download
								</button>
							</form>
						{/if}

						{#if live.status === 'ready' && live.canInstall}
							<form method="POST" action="?/install">
								<button
									type="submit"
									class="border-accent bg-accent/10 text-accent flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
								>
									<Icon name="upload" size={12} />
									Install and restart
								</button>
							</form>
						{/if}
					</div>
				</div>

				{#if live.status === 'downloading' && live.progress}
					<div class="bg-bg-tertiary mt-3 h-1.5 w-full overflow-hidden rounded">
						<div class="bg-accent h-full transition-all" style={`width: ${percent}%`}></div>
					</div>
					<p class="text-text-muted mt-1 font-mono text-[9px]">
						{bytes(live.progress.received)} of {bytes(live.progress.total)}
					</p>
				{/if}

				{#if live.status === 'ready' && !live.canInstall}
					<p class="text-text-muted mt-3 font-mono text-[10px]">
						The file is ready at {live.target?.file}. Install it from the desktop app — a browser
						tab cannot replace a running binary.
					</p>
				{/if}
				{#if live.installRequested}
					<p class="text-accent mt-3 font-mono text-[10px]">
						The desktop shell will install the update and restart PeerHub.
					</p>
				{/if}
			</section>

			<section class="border-border bg-bg-secondary rounded-lg border p-4">
				<h2 class="text-text-secondary mb-3 font-mono text-[10px] tracking-[2px] uppercase">
					How updates arrive
				</h2>
				<form method="POST" action="?/save" class="grid gap-3 sm:grid-cols-2">
					<label class="sm:col-span-2">
						<span class="text-text-muted font-mono text-[9px] tracking-wider uppercase"
							>Release repo</span
						>
						<input
							name="repo"
							value={live.settings.repo}
							placeholder="peerhub"
							class="border-border bg-bg-primary text-text-primary placeholder:text-text-muted focus:border-accent mt-1 w-full rounded border px-2.5 py-1.5 font-mono text-[11px] outline-none"
						/>
					</label>

					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							name="autoCheck"
							checked={live.settings.autoCheck}
							class="border-border bg-bg-primary text-accent h-3.5 w-3.5 rounded border accent-current"
						/>
						<span class="text-text-secondary font-mono text-[10px]">Check on launch</span>
					</label>

					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							name="autoDownload"
							checked={live.settings.autoDownload}
							class="border-border bg-bg-primary text-accent h-3.5 w-3.5 rounded border accent-current"
						/>
						<span class="text-text-secondary font-mono text-[10px]">Download in the background</span
						>
					</label>

					<label class="flex items-center gap-2 sm:col-span-2">
						<input
							type="checkbox"
							name="autoInstall"
							checked={live.settings.autoInstall}
							class="border-border bg-bg-primary text-accent h-3.5 w-3.5 rounded border accent-current"
						/>
						<span class="text-text-secondary font-mono text-[10px]">
							Install without asking — PeerHub restarts on the new version when it quits
						</span>
					</label>

					<div class="sm:col-span-2">
						<button
							type="submit"
							class="border-border text-text-secondary hover:border-accent hover:text-accent rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
						>
							Save
						</button>
					</div>
				</form>

				<div class="border-border mt-4 border-t pt-3">
					<p class="text-text-muted font-mono text-[10px]">
						Publisher
						<span class="text-text-secondary"
							>{live.publisher?.slice(0, 16) ?? 'not known yet'}</span
						>
						{#if live.settings.trustedSigner}
							· pinned {live.settings.trustedSigner.slice(0, 16)}
						{/if}
					</p>
					<p class="text-text-muted mt-1 font-mono text-[10px]">
						Only a manifest signed by that key is installed. A release repo opened from an
						announcement carries its owner's key; an invite-only one is pinned to the first signer
						it serves.
					</p>
					{#if live.settings.trustedSigner}
						<form method="POST" action="?/unpin" class="mt-2">
							<button
								type="submit"
								class="border-danger text-danger rounded border px-2 py-1 font-mono text-[9px] tracking-wider uppercase transition"
							>
								Forget pinned key
							</button>
						</form>
					{/if}
				</div>
			</section>
		{/if}
	</div>
</div>
