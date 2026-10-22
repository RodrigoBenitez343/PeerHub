<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import RepoHeader from '$lib/components/RepoHeader.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let pending = $state(false);

	const badge = (status: string) => (status === 'added' ? 'A' : status === 'removed' ? 'D' : 'M');
	const badgeClass = (status: string) =>
		status === 'added'
			? 'text-success border-success/40'
			: status === 'removed'
				? 'text-danger border-danger/40'
				: 'text-accent border-accent-dim';

	function when(ts: number): string {
		const minutes = Math.floor((Date.now() - ts) / 60_000);
		if (minutes < 1) return 'now';
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		return `${Math.floor(hours / 24)}d`;
	}
</script>

<svelte:head>
	<title>{data.drive.name} · Commit</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col">
	<RepoHeader
		id={data.drive.id}
		name={data.drive.name}
		visibility={data.repo.visibility}
		active="commit"
		isGuest={data.drive.isGuest}
		forkedFrom={data.repo.forkedFrom}
	/>

	<div class="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-auto px-4 py-5">
		<form method="GET" class="mb-4 flex items-center gap-2">
			<span class="text-text-muted font-mono text-[9px] tracking-[2px] uppercase">Branch</span>
			<select
				name="branch"
				onchange={(event) => (event.currentTarget as HTMLSelectElement).form?.submit()}
				class="border-border bg-bg-tertiary text-text-secondary rounded border px-2 py-1 font-mono text-[11px] outline-none"
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
			<span class="text-text-muted ml-auto font-mono text-[9px]">
				{data.head ? `HEAD ${data.head.short}` : 'no commits on this branch'}
			</span>
		</form>

		{#if form?.error}
			<p
				class="border-danger/40 bg-danger/5 text-danger mb-4 rounded border px-3 py-2 font-mono text-[11px]"
			>
				{form.error}
			</p>
		{/if}

		{#if data.error}
			<p
				class="border-danger/40 bg-danger/5 text-danger mb-4 rounded border px-3 py-2 font-mono text-[11px]"
			>
				{data.error}
			</p>
		{/if}

		<section class="border-border bg-bg-secondary overflow-hidden rounded-lg border">
			<div class="border-border flex items-center justify-between border-b px-3 py-2">
				<h2 class="text-text-muted font-mono text-[9px] tracking-[3px] uppercase">
					Pending changes
				</h2>
				<span class="text-text-muted font-mono text-[9px]">{data.changes.length}</span>
			</div>
			{#if data.changes.length === 0}
				<p class="text-text-muted px-3 py-4 text-[11px]">
					Working tree matches {data.head ? `commit ${data.head.short}` : 'an empty tree'}. A commit
					now records the same snapshot again.
				</p>
			{:else}
				<ul>
					{#each data.changes as change (change.path)}
						<li class="border-border flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
							<span
								class="w-4 shrink-0 rounded border text-center font-mono text-[9px] {badgeClass(
									change.status
								)}"
							>
								{badge(change.status)}
							</span>
							<span class="text-text-secondary min-w-0 flex-1 truncate font-mono text-[11px]">
								{change.path}
							</span>
							<span class="text-text-muted font-mono text-[9px]">{change.status}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if data.canCommit}
			<form
				method="POST"
				action="?/commit"
				use:enhance={() => {
					pending = true;
					return async () => {
						pending = false;
					};
				}}
				class="border-border bg-bg-secondary mt-4 rounded-lg border p-4"
			>
				<input type="hidden" name="branch" value={data.branch} />
				<label class="block">
					<span
						class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase"
					>
						Commit message
					</span>
					<textarea
						name="message"
						required
						rows="3"
						placeholder="What changed and why"
						class="border-border bg-bg-tertiary text-text-primary placeholder:text-text-muted focus:border-accent-dim w-full resize-y rounded border px-3 py-2 font-mono text-xs outline-none"
					></textarea>
				</label>
				<div class="mt-3 flex items-center justify-between gap-3">
					<p class="text-text-muted text-[10px]">
						Snapshots {data.changes.length} changed file{data.changes.length === 1 ? '' : 's'} on
						<span class="text-text-secondary">{data.branch}</span>.
					</p>
					<button
						type="submit"
						disabled={pending}
						class="bg-accent text-bg-primary flex shrink-0 items-center gap-2 rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase hover:brightness-110 disabled:opacity-50"
					>
						<Icon name="commit" size={14} />
						{pending ? 'Committing…' : 'Commit'}
					</button>
				</div>
			</form>
		{:else}
			<p
				class="border-border text-text-muted mt-4 rounded-lg border border-dashed px-3 py-4 text-[11px]"
			>
				{#if !data.metaShared}
					This repo was joined before repository metadata was shared — rejoin with a fresh invite to
					commit.
				{:else}
					Commits are accepted by the repo owner. Connect to the owner to commit.
				{/if}
			</p>
		{/if}

		{#if data.recent.length > 0}
			<section class="mt-6">
				<h2 class="text-text-muted mb-2 font-mono text-[9px] tracking-[3px] uppercase">
					Recent commits
				</h2>
				<ul class="border-border divide-border divide-y overflow-hidden rounded-lg border">
					{#each data.recent as entry (entry.short + entry.ts)}
						<li class="bg-bg-secondary flex items-center gap-2 px-3 py-2">
							<span class="text-accent font-mono text-[9px]">{entry.short}</span>
							<span class="text-text-secondary min-w-0 flex-1 truncate text-[11px]"
								>{entry.message}</span
							>
							<span class="text-text-muted shrink-0 font-mono text-[9px]">{when(entry.ts)}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</div>
