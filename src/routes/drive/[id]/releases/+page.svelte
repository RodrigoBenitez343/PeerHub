<script lang="ts">
	import type { PageData } from './$types';
	import RepoHeader from '$lib/components/RepoHeader.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data }: { data: PageData } = $props();

	function bytes(value: number): string {
		const n = Number(value) || 0;
		if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
		if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
		if (n >= 1024) return `${Math.round(n / 1024)} KB`;
		return `${n} B`;
	}

	function when(ts: number): string {
		if (!ts) return 'date unknown';
		return new Date(ts).toLocaleString();
	}

	function short(hex: string, length = 12): string {
		return hex ? `${hex.slice(0, length)}…` : '—';
	}
</script>

<svelte:head>
	<title>{data.drive.name} · Releases</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col">
	<RepoHeader
		id={data.drive.id}
		name={data.drive.name}
		visibility={data.repo.visibility}
		active="releases"
		isGuest={data.drive.isGuest}
		canWrite={data.drive.canWrite}
		sourceRemoved={data.repo.sourceRemoved}
		forkedFrom={data.repo.forkedFrom}
	/>

	<section class="flex-1 overflow-auto">
		<div class="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
			<header class="mb-5 flex items-start gap-3">
				<span
					class="text-accent border-border-accent bg-accent/5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
				>
					<Icon name="tag" size={18} />
				</span>
				<div class="min-w-0 flex-1">
					<h1 class="text-text-primary font-mono text-sm tracking-[3px] uppercase">Releases</h1>
					<p class="text-text-muted mt-1 text-[11px]">
						Installers published from this repository. Each one is signed by the peer that built it,
						and peers pass the files to each other like any other repo content.
					</p>
				</div>
				<span
					class="border-border text-text-secondary shrink-0 rounded border px-2 py-1 font-mono text-[10px]"
				>
					{data.releases.length}
					{data.releases.length === 1 ? 'release' : 'releases'}
				</span>
			</header>

			{#if data.releases.length === 0}
				<div
					class="border-border text-text-muted rounded-lg border border-dashed px-4 py-10 text-center text-[11px]"
				>
					{#if data.drive.isGuest && data.drive.peerCount === 0}
						Nothing to show yet — this mirror has no peer serving the release files, so the manifest
						cannot be read. It will appear when the owner or another peer is online.
					{:else}
						No releases published from this repository.
					{/if}
				</div>
			{:else}
				<ul class="flex flex-col gap-3">
					{#each data.releases as release (release.version)}
						<li class="border-border bg-bg-secondary rounded-lg border p-4">
							<div class="flex flex-wrap items-center gap-2">
								<span
									class="border-border-accent text-accent rounded border px-2 py-0.5 font-mono text-[11px] tracking-wider"
								>
									v{release.version}
								</span>
								<span class="text-text-muted font-mono text-[10px]">
									{when(release.publishedAt)}
								</span>
								{#if release.verified}
									<span
										class="border-border text-text-secondary ml-auto rounded border px-2 py-0.5 font-mono text-[9px] tracking-wider uppercase"
										title={`Signature verified against ${release.signer}`}
									>
										signed
									</span>
								{:else}
									<span
										class="border-danger/40 text-danger ml-auto rounded border px-2 py-0.5 font-mono text-[9px] tracking-wider uppercase"
										title="The signature does not match the owner this peer knows"
									>
										unverified
									</span>
								{/if}
							</div>

							{#if release.notes}
								<p class="text-text-secondary mt-3 text-[11px] whitespace-pre-wrap">
									{release.notes}
								</p>
							{/if}

							{#if release.problem}
								<p class="text-danger mt-2 font-mono text-[10px]">{release.problem}</p>
							{/if}

							<ul class="mt-3 flex flex-col gap-1.5">
								{#each release.assets as asset (asset.name)}
									<li class="flex flex-wrap items-center gap-x-3 gap-y-1">
										<a
											href={asset.href}
											download={asset.name}
											class="text-accent hover:text-accent-dim flex min-w-0 items-center gap-1.5 font-mono text-[11px] transition"
										>
											<Icon name="download" size={13} />
											<span class="truncate">{asset.name}</span>
										</a>
										<span class="text-text-muted font-mono text-[10px]">
											{asset.platform}-{asset.arch} · {bytes(asset.size)}
										</span>
										<code
											class="text-text-muted ml-auto font-mono text-[10px]"
											title={asset.sha256}
										>
											sha256 {short(asset.sha256)}
										</code>
									</li>
								{/each}
							</ul>

							<p class="text-text-muted mt-3 font-mono text-[9px] tracking-wider">
								signed by {short(release.signer, 8)}
								{#if data.publisher && data.publisher !== release.signer}
									· owner is {short(data.publisher, 8)}
								{/if}
							</p>
						</li>
					{/each}
				</ul>
			{/if}

			{#if data.error}
				<p class="text-text-muted mt-3 font-mono text-[10px]">{data.error}</p>
			{/if}

			{#if data.drive.canWrite}
				<p class="text-text-muted border-border mt-6 border-t pt-4 font-mono text-[10px]">
					Publish a build with
					<code class="text-text-secondary">npm run publish:release -- --notes "what changed"</code>
					— the app writes the manifest and the installers into this repository.
				</p>
			{/if}
		</div>
	</section>
</div>
