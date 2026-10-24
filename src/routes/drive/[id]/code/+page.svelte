<script lang="ts">
	import type { PageData } from './$types';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import RepoHeader from '$lib/components/RepoHeader.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import { watchJob } from '$lib/jobs';

	let { data }: { data: PageData } = $props();

	let forkPending = $state(false);
	let forkError = $state<string | null>(null);

	function onFork() {
		forkPending = true;
		forkError = null;
		return async ({ result, update }: { result: any; update: () => Promise<void> }) => {
			try {
				if (result.type === 'redirect') {
					await goto(result.location);
					return;
				}
				if (result.type === 'failure') {
					await update();
					return;
				}
				const jobId = result.data?.jobId;
				if (!jobId) {
					await update();
					return;
				}
				const job = await watchJob(jobId);
				if (job.result?.repoId) await goto(`/drive/${job.result.repoId}/code`);
			} catch (err: any) {
				forkError = `Could not fork: ${err?.message ?? err}`;
			} finally {
				forkPending = false;
			}
		};
	}

	function bytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function when(ts: number): string {
		const minutes = Math.floor((Date.now() - ts) / 60_000);
		if (minutes < 1) return 'now';
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		return `${Math.floor(hours / 24)}d`;
	}

	const base = $derived(`/drive/${data.drive.id}/code?branch=${encodeURIComponent(data.branch)}`);
	const commitHref = $derived(
		`/drive/${data.drive.id}/commit?branch=${encodeURIComponent(data.branch)}`
	);
	const parentDir = $derived(
		data.dir === '/' ? null : data.dir.slice(0, data.dir.lastIndexOf('/')) || '/'
	);
	const segments = $derived(
		data.dir === '/'
			? []
			: data.dir
					.slice(1)
					.split('/')
					.map((name, i, all) => ({
						name,
						path: '/' + all.slice(0, i + 1).join('/')
					}))
	);

	function dirHref(dir: string): string {
		return `${base}&dir=${encodeURIComponent(dir)}`;
	}

	function fileHref(path: string): string {
		return `${base}&dir=${encodeURIComponent(data.dir)}&path=${encodeURIComponent(path)}`;
	}
</script>

<svelte:head>
	<title>{data.drive.name} · Code</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col">
	<RepoHeader
		id={data.drive.id}
		name={data.drive.name}
		visibility={data.repo.visibility}
		active="code"
		isGuest={data.drive.isGuest}
		canWrite={data.drive.canWrite}
		sourceRemoved={data.repo.sourceRemoved}
		forkedFrom={data.repo.forkedFrom}
	/>

	<div class="flex min-h-0 flex-1">
		<!-- Branches + history -->
		<aside class="border-border hidden w-64 shrink-0 flex-col overflow-auto border-r md:flex">
			<div class="border-border border-b px-3 py-2">
				<p class="text-text-muted font-mono text-[9px] tracking-[2px] uppercase">Branch</p>
				<form method="GET" class="mt-1.5">
					<input type="hidden" name="dir" value={data.dir} />
					<select
						name="branch"
						onchange={(event) => (event.currentTarget as HTMLSelectElement).form?.submit()}
						class="border-border bg-bg-tertiary text-text-secondary w-full rounded border px-2 py-1 font-mono text-[11px] outline-none"
						aria-label="Branch"
					>
						{#each data.branches as branch (branch.name)}
							<option value={branch.name} selected={branch.name === data.branch}>
								{branch.name} · {branch.sha}
							</option>
						{/each}
						{#if data.branches.length === 0}
							<option value={data.branch}>{data.branch} · no commits</option>
						{/if}
					</select>
				</form>

				{#if data.canCommit}
					<form method="POST" action="?/branch" class="mt-2 flex gap-1">
						<input type="hidden" name="from" value={data.branch} />
						<input
							name="name"
							required
							placeholder="new-branch"
							class="border-border bg-bg-tertiary text-text-primary placeholder:text-text-muted min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[10px] outline-none"
						/>
						<button
							type="submit"
							class="border-border text-text-secondary hover:border-accent hover:text-accent rounded border px-2 py-1 font-mono text-[9px] tracking-wider uppercase transition"
							title="Create branch from {data.branch}"
						>
							+
						</button>
					</form>
				{/if}

				{#if data.metaWritable && data.drive.canWrite && data.branch !== data.repo.defaultBranch}
					<form
						method="POST"
						action="?/removeBranch"
						onsubmit={(event) => {
							if (!confirm(`Delete branch ${data.branch}?`)) event.preventDefault();
						}}
						class="mt-1"
					>
						<input type="hidden" name="name" value={data.branch} />
						<input type="hidden" name="defaultBranch" value={data.repo.defaultBranch} />
						<button
							type="submit"
							class="text-text-muted hover:text-danger font-mono text-[9px] tracking-wider uppercase transition"
						>
							Delete this branch
						</button>
					</form>
				{/if}
			</div>

			<div
				class="border-border text-text-muted border-b px-3 py-2 font-mono text-[9px] tracking-[2px] uppercase"
			>
				History · {data.commits.length}
			</div>
			{#if data.commits.length === 0}
				<p class="text-text-muted px-3 py-3 text-[10px] leading-relaxed">
					No commits on {data.branch} yet.
				</p>
			{:else}
				<ul class="flex flex-col">
					{#each data.commits as entry (entry.sha)}
						<li class="border-border border-b px-3 py-2">
							<div class="flex items-center gap-1.5">
								<span class="text-accent font-mono text-[9px]">{entry.short}</span>
								{#if entry.sha === data.head?.sha}
									<span class="text-text-muted font-mono text-[8px] uppercase">head</span>
								{/if}
								<span class="text-text-muted ml-auto font-mono text-[8px]">{when(entry.ts)}</span>
							</div>
							<p class="text-text-secondary mt-1 line-clamp-2 text-[10px] break-words">
								{entry.message}
							</p>
						</li>
					{/each}
				</ul>
			{/if}
		</aside>

		<!-- Tree / file -->
		<section class="flex min-w-0 flex-1 flex-col overflow-auto">
			<div
				class="border-border bg-bg-secondary flex flex-wrap items-center gap-2 border-b px-3 py-2"
			>
				{#if data.selected}
					<a
						href={dirHref(data.dir)}
						class="text-text-muted hover:text-accent font-mono text-[10px] uppercase"
					>
						tree
					</a>
					<span class="text-text-muted">/</span>
					<span class="truncate font-mono text-[11px]">{data.selected}</span>
				{:else}
					<a href={dirHref('/')} class="text-text-muted hover:text-accent font-mono text-[10px]">
						{data.drive.name}
					</a>
					{#each segments as seg (seg.path)}
						<span class="text-text-muted">/</span>
						<a
							href={dirHref(seg.path)}
							class="text-text-secondary hover:text-accent font-mono text-[10px]"
						>
							{seg.name}
						</a>
					{/each}
				{/if}

				<div class="ml-auto flex items-center gap-2">
					<span class="text-text-muted font-mono text-[9px]">{data.totalFiles} files</span>
					{#if data.canCommit}
						<a
							href={commitHref}
							class="bg-accent/90 hover:bg-accent text-bg-primary flex items-center gap-1.5 rounded px-3 py-1.5 font-mono text-[9px] tracking-wider uppercase transition"
						>
							<Icon name="commit" size={13} />
							Commit changes
						</a>
					{/if}
					{#if data.drive.isGuest && data.repo.visibility === 'public' && data.driveKey}
						<form method="POST" action="/?/fork" use:enhance={onFork}>
							<input type="hidden" name="driveKey" value={data.driveKey} />
							<input type="hidden" name="repoId" value={data.drive.id} />
							<input type="hidden" name="name" value={data.drive.name} />
							<input type="hidden" name="description" value={data.repo.description ?? ''} />
							<button
								type="submit"
								disabled={forkPending}
								class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition disabled:opacity-50"
								title="Copy this repo to your device"
							>
								{#if forkPending}
									<Spinner size={11} />
									Forking…
								{:else}
									<Icon name="fork" size={13} />
									Fork
								{/if}
							</button>
						</form>
					{/if}
				</div>
			</div>

			{#if forkError}
				<p
					class="border-danger/40 bg-danger/5 text-danger border-b px-4 py-1.5 font-mono text-[10px]"
				>
					{forkError}
				</p>
			{/if}

			{#if data.selected}
				{#if data.file}
					<div class="border-border flex items-center gap-2 border-b px-3 py-1.5">
						<span class="text-text-muted truncate font-mono text-[10px]">{data.file.path}</span>
						<span class="text-text-muted ml-auto shrink-0 font-mono text-[9px]">
							{bytes(data.file.size)}
						</span>
					</div>
					{#if data.file.binary}
						<p class="text-text-muted px-4 py-6 text-[11px]">Binary file — no preview.</p>
					{:else if data.fileHtml !== null}
						<article class="px-4 py-4 md:px-6">
							<Markdown html={data.fileHtml} />
						</article>
					{:else}
						{#if data.file.truncated}
							<p class="text-text-muted border-border border-b px-4 py-1.5 font-mono text-[9px]">
								preview truncated at 256 KB
							</p>
						{/if}
						<pre
							class="text-text-secondary flex-1 overflow-auto px-4 py-3 font-mono text-[11px] leading-relaxed whitespace-pre">{data
								.file.text}</pre>
					{/if}
				{:else}
					<div class="px-4 py-6">
						<p class="text-danger font-mono text-[11px]">{data.fileError ?? 'File unavailable'}</p>
						<a
							href={dirHref(data.dir)}
							class="text-accent mt-2 inline-block font-mono text-[10px] uppercase"
						>
							back to tree
						</a>
					</div>
				{/if}
			{:else}
				{#if data.filesError}
					<p class="text-text-muted px-4 py-3 font-mono text-[10px]">
						files unavailable — {data.filesError}
					</p>
				{/if}

				<ul>
					{#if parentDir !== null}
						<li class="border-border border-b">
							<a
								href={dirHref(parentDir)}
								class="hover:bg-bg-hover flex items-center gap-2 px-3 py-2"
							>
								<Icon name="chevron-left" size={16} class="text-text-muted" />
								<span class="text-text-secondary font-mono text-[11px]">..</span>
							</a>
						</li>
					{/if}
					{#each data.folders as folder (folder.name)}
						<li class="border-border border-b">
							<a
								href={dirHref(`${data.dir === '/' ? '' : data.dir}/${folder.name}`)}
								class="hover:bg-bg-hover flex items-center gap-2 px-3 py-2"
							>
								<Icon name="folder" size={17} class="text-accent" />
								<span class="text-text-primary min-w-0 flex-1 truncate font-mono text-[11px]">
									{folder.name}/
								</span>
								<span class="text-text-muted font-mono text-[9px]">{folder.count}</span>
							</a>
						</li>
					{/each}
					{#each data.files as entry (entry.path)}
						<li class="border-border border-b">
							<a
								href={fileHref(entry.path)}
								class="hover:bg-bg-hover flex items-center gap-2 px-3 py-2"
							>
								<Icon name="file" size={17} class="text-text-muted" />
								<span class="text-text-secondary min-w-0 flex-1 truncate font-mono text-[11px]">
									{entry.name}
								</span>
								<span class="text-text-muted font-mono text-[9px]">{bytes(entry.size)}</span>
							</a>
						</li>
					{/each}
				</ul>

				{#if data.folders.length === 0 && data.files.length === 0 && !data.filesError}
					<p class="text-text-muted px-4 py-6 text-[11px]">
						This directory is empty. Add files from the
						<a href={`/drive/${data.drive.id}`} class="text-accent hover:underline">files view</a>.
					</p>
				{/if}

				{#if data.readme}
					<article class="border-border mt-3 border-t px-4 py-4 md:px-6">
						<p class="text-text-muted mb-3 font-mono text-[9px] tracking-[2px] uppercase">
							{data.readme.path}
						</p>
						<Markdown html={data.readme.html} />
					</article>
				{/if}

				{#if !data.canCommit}
					<div class="border-border mt-4 border-t px-3 py-3">
						<p class="text-text-muted text-[10px]">
							{#if !data.metaShared}
								This repo was joined before repository metadata was shared — rejoin with a fresh
								invite to commit.
							{:else}
								Commits are accepted by the repo owner. Connect to the owner to commit.
							{/if}
						</p>
					</div>
				{/if}
			{/if}
		</section>
	</div>
</div>
