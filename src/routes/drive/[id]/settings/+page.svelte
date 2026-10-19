<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import Modal from '$lib/components/Modal.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let copied = $state(false);
	let confirmDelete = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
	let picking = $state(false);
	let syncingId = $state<string | null>(null);

	// Action results differ per form, so read them loosely.
	const actionError = $derived((form as any)?.error as string | undefined);
	const actionMessage = $derived((form as any)?.message as string | undefined);

	function onPickFolder() {
		picking = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			picking = false;
			await update();
		};
	}

	function onSync(id: string): SubmitFunction {
		return () =>
			async ({ update }: { update: () => Promise<void> }) => {
				syncingId = id;
				try {
					await update();
				} finally {
					syncingId = null;
				}
			};
	}

	function copy() {
		navigator.clipboard.writeText(data.inviteUrl).then(() => {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		});
	}

	function driveLabel(d: { target: string; type: string }) {
		if (d.type === 'cache') return 'Cache';
		if (d.type === 'shared') return 'Shared folder (writable by every peer)';
		if (d.type === 'hyperdrive') return `${d.target.slice(0, 6)}…${d.target.slice(-4)}`;
		return d.target.split('/').pop() || d.target;
	}

	function lastSyncLabel(pair: { lastSyncAt: number | null; lastResult: string | null }) {
		if (!pair.lastSyncAt) return pair.lastResult ? pair.lastResult : 'not synced yet';
		const when = new Date(pair.lastSyncAt).toLocaleString();
		return pair.lastResult ? `${when} · ${pair.lastResult}` : when;
	}
</script>

<Modal
	bind:open={confirmDelete}
	title="Delete Drive"
	message="Delete this drive session? Drives, invites and peers will be removed. Your registered local drives are not deleted."
	confirmLabel="Delete"
	danger
	onConfirm={() => deleteForm?.requestSubmit()}
/>

<header class="border-border bg-bg-secondary flex h-11 items-center gap-3 border-b px-4">
	<a
		href={`/drive/${data.drive.id}`}
		class="text-text-secondary hover:text-accent flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] transition"
	>
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3 w-3">
			<path d="M10 3L5 8l5 5" />
		</svg>
		Back
	</a>
	<h2 class="text-accent font-mono text-xs tracking-[3px] uppercase">
		{data.drive.name} / Settings
	</h2>
</header>

<section class="flex-1 overflow-auto p-6">
	<div class="mx-auto max-w-3xl space-y-8">
		<!-- Drives -->
		<div>
			<h3 class="text-text-muted mb-3 font-mono text-[10px] tracking-[2px] uppercase">Drives</h3>
			<ul class="border-border bg-bg-secondary space-y-1 rounded-md border p-2">
				{#each data.drives as d (d.target)}
					<li class="group hover:bg-bg-hover flex items-center gap-3 rounded px-3 py-2 transition">
						<span class="text-accent-dim">
							{#if d.type === 'cache'}
								<svg
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									stroke-width="1.2"
									class="h-4 w-4"
								>
									<path d="M8 2v8M4 7l4 4 4-4M2 12v2h12v-2" />
								</svg>
							{:else if d.type === 'hyperdrive'}
								<svg
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									stroke-width="1.2"
									class="h-4 w-4"
								>
									<path d="M8 2L2 8l6 6 6-6z" />
									<circle cx="8" cy="8" r="1.5" />
								</svg>
							{:else}
								<svg
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									stroke-width="1.2"
									class="h-4 w-4"
								>
									<path d="M2 4h12v8H2z" />
									<circle cx="12" cy="8" r="1" />
								</svg>
							{/if}
						</span>
						<span class="flex-1 truncate text-sm">{driveLabel(d)}</span>
						<span class="text-text-muted font-mono text-[9px] tracking-wider uppercase">
							{d.type}
						</span>
						{#if d.type !== 'cache' && d.type !== 'shared'}
							<form method="POST" action="?/removeDrive" use:enhance>
								<input type="hidden" name="target" value={d.target} />
								<button
									type="submit"
									class="text-text-muted hover:text-danger px-1 transition md:opacity-0 md:group-hover:opacity-100"
									title="Remove"
								>
									×
								</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>

			<div class="mt-2 flex gap-2">
				<form method="POST" action="?/addDrive" use:enhance class="flex flex-1 gap-2">
					<input
						name="target"
						type="text"
						placeholder="Local path or 64-char hyperdrive key"
						class="border-border bg-bg-tertiary text-text-primary focus:border-accent-dim flex-1 rounded border px-3 py-2 font-mono text-xs outline-none"
					/>
					<button
						type="submit"
						class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase hover:brightness-110"
					>
						Add
					</button>
				</form>
				{#if data.canPickDirectory}
					<form method="POST" action="?/pickFolder" use:enhance={onPickFolder}>
						<button
							type="submit"
							disabled={picking}
							class="border-border text-text-secondary hover:border-accent-dim hover:text-accent rounded border px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition disabled:opacity-50"
						>
							{picking ? 'Picking…' : 'Pick folder'}
						</button>
					</form>
				{/if}
			</div>
			{#if actionError}
				<p class="text-danger mt-1 font-mono text-[10px]">{actionError}</p>
			{/if}
		</div>

		<!-- Invite -->
		<div>
			<h3 class="text-text-muted mb-3 font-mono text-[10px] tracking-[2px] uppercase">Invite</h3>
			<div class="border-border bg-bg-secondary rounded-md border p-4">
				<div class="flex items-start gap-2">
					<code
						class="border-border bg-bg-tertiary text-accent flex-1 rounded border px-3 py-2 font-mono text-[10px] break-all"
					>
						{data.inviteUrl}
					</code>
					<button
						type="button"
						onclick={copy}
						class="border-border text-text-secondary hover:border-accent-dim hover:text-accent rounded border px-3 py-2 font-mono text-[10px] tracking-wider uppercase transition"
					>
						{copied ? 'Copied' : 'Copy'}
					</button>
				</div>
				<p class="text-text-muted mt-2 font-mono text-[9px] tracking-wider uppercase">
					Share this link to let peers join this drive.
				</p>
			</div>
		</div>

		<!-- Local sync -->
		<div>
			<h3 class="text-text-muted mb-3 font-mono text-[10px] tracking-[2px] uppercase">
				Local sync
			</h3>
			<p class="text-text-muted mb-2 font-mono text-[9px] leading-relaxed">
				Link a folder on this device with the shared files. Each run copies whatever changed on
				either side; turn auto on to keep both in step while connected.
			</p>

			{#if actionMessage}
				<p class="text-success mb-2 font-mono text-[10px]">{actionMessage}</p>
			{/if}

			{#if !data.canWrite}
				<p
					class="border-border bg-bg-secondary text-text-muted rounded-md border px-3 py-4 text-center font-mono text-[10px] tracking-wider uppercase"
				>
					Connect to the host to sync
				</p>
			{:else}
				{#if data.syncPairs.length === 0}
					<p
						class="border-border bg-bg-secondary text-text-muted rounded-md border px-3 py-4 text-center font-mono text-[10px] tracking-wider uppercase"
					>
						No synced folders
					</p>
				{:else}
					<ul class="border-border bg-bg-secondary space-y-1 rounded-md border p-2">
						{#each data.syncPairs as pair (pair.id)}
							<li
								class="hover:bg-bg-hover flex flex-wrap items-center gap-2 rounded px-3 py-2 transition"
							>
								<span class="text-accent-dim">
									<svg
										viewBox="0 0 16 16"
										fill="none"
										stroke="currentColor"
										stroke-width="1.2"
										class="h-4 w-4"
									>
										<path d="M2 5h5l1 1h6v7H2z" />
										<path d="M8 8v4M6 10l2-2 2 2" />
									</svg>
								</span>
								<div class="min-w-0 flex-1">
									<p class="text-text-primary truncate font-mono text-xs">{pair.path}</p>
									<p class="text-text-muted font-mono text-[9px]">{lastSyncLabel(pair)}</p>
								</div>

								<form method="POST" action="?/syncNow" use:enhance={onSync(pair.id)}>
									<input type="hidden" name="syncId" value={pair.id} />
									<button
										type="submit"
										disabled={syncingId === pair.id || pair.running}
										class="bg-accent text-bg-primary rounded px-3 py-1.5 font-mono text-[9px] tracking-wider uppercase transition hover:brightness-110 disabled:opacity-50"
									>
										{syncingId === pair.id ? 'Syncing…' : 'Sync now'}
									</button>
								</form>

								<form method="POST" action="?/toggleSyncAuto" use:enhance>
									<input type="hidden" name="syncId" value={pair.id} />
									<input type="hidden" name="auto" value={pair.auto ? '0' : '1'} />
									<button
										type="submit"
										class="rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition {pair.auto
											? 'border-accent-dim text-accent'
											: 'border-border text-text-muted hover:text-text-secondary'}"
									>
										{pair.auto ? 'Auto on' : 'Auto off'}
									</button>
								</form>

								<form method="POST" action="?/removeSync" use:enhance>
									<input type="hidden" name="syncId" value={pair.id} />
									<button
										type="submit"
										class="text-text-muted hover:text-danger px-1 transition"
										title="Stop syncing"
									>
										×
									</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}

				<div class="mt-2 flex gap-2">
					<form method="POST" action="?/addSync" use:enhance class="flex flex-1 gap-2">
						<input
							name="path"
							type="text"
							placeholder="Local folder to sync, e.g. /home/me/Shared"
							class="border-border bg-bg-tertiary text-text-primary focus:border-accent-dim flex-1 rounded border px-3 py-2 font-mono text-xs outline-none"
						/>
						<button
							type="submit"
							class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase hover:brightness-110"
						>
							Add
						</button>
					</form>
					{#if data.canPickDirectory}
						<form method="POST" action="?/pickSyncFolder" use:enhance={onPickFolder}>
							<button
								type="submit"
								disabled={picking}
								class="border-border text-text-secondary hover:border-accent-dim hover:text-accent rounded border px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition disabled:opacity-50"
							>
								{picking ? 'Picking…' : 'Pick folder'}
							</button>
						</form>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Peers -->
		<div>
			<h3 class="text-text-muted mb-3 font-mono text-[10px] tracking-[2px] uppercase">Peers</h3>
			{#await data.peers}
				<div
					class="border-border bg-bg-secondary rounded-md border px-3 py-4 text-center font-mono text-[10px]"
				>
					<div class="bg-bg-tertiary mx-auto h-2 w-24 animate-pulse rounded opacity-40"></div>
				</div>
			{:then peers}
				{#if peers.length === 0}
					<p
						class="border-border bg-bg-secondary text-text-muted rounded-md border px-3 py-4 text-center font-mono text-[10px] tracking-wider uppercase"
					>
						No peers yet
					</p>
				{:else}
					<ul class="border-border bg-bg-secondary space-y-1 rounded-md border p-2">
						{#each peers as p (p.key)}
							<li class="hover:bg-bg-hover flex items-center gap-3 rounded px-3 py-2 transition">
								<span
									class="bg-success block h-1.5 w-1.5 rounded-full"
									style:box-shadow="0 0 6px rgba(34,197,94,.6)"
								></span>
								<span class="text-text-primary flex-1 truncate font-mono text-xs">{p.short}</span>
								<span class="text-success font-mono text-[9px] tracking-wider uppercase">
									online
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			{/await}
		</div>

		<!-- Danger zone -->
		<div>
			<h3 class="text-danger mb-3 font-mono text-[10px] tracking-[2px] uppercase">Danger</h3>
			<form
				bind:this={deleteForm}
				method="POST"
				action="?/deleteSession"
				use:enhance={() => async () => {
					goto('/', { invalidate: ['app:layout'] });
				}}
				class="border-danger/40 bg-bg-secondary rounded-md border p-4"
			>
				<p class="text-text-secondary mb-3 font-mono text-[10px]">
					Removes this drive session and all associated invites/joins. Your registered local drives
					are not deleted.
				</p>
				<button
					type="button"
					onclick={() => (confirmDelete = true)}
					class="border-danger text-danger hover:bg-danger hover:text-bg-primary cursor-pointer rounded border px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition"
				>
					Delete Drive Session
				</button>
			</form>
		</div>
	</div>
</section>
