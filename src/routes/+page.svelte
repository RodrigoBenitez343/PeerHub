<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import logo from '$lib/assets/images/ghost.png';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const action = $derived(page.url.searchParams.get('action'));
	let submitting = $state(false);

	async function autoNavigate(autoOpen: Promise<string | null> | undefined) {
		if (!autoOpen) return;
		const id = await autoOpen;
		if (id) goto(`/drive/${id}`);
	}

	$effect(() => {
		autoNavigate(data.autoOpen);
	});

	function onActionSuccess({ result }: { result: any }) {
		submitting = false;
		if (result.type === 'success' && result.data?.redirect) {
			goto(result.data.redirect);
		}
	}
</script>

<div class="flex flex-1 items-center justify-center px-4">
	{#if action === 'new'}
		<form
			method="POST"
			action="?/create"
			enctype="multipart/form-data"
			use:enhance={() => {
				submitting = true;
				return async ({ result }) => onActionSuccess({ result });
			}}
			class="border-border bg-bg-secondary w-full max-w-sm space-y-4 rounded-lg border p-6"
		>
			<h2 class="text-accent font-mono text-xs tracking-[3px] uppercase">New Drive</h2>
			<label class="block">
				<span class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase">
					Name
				</span>
				<input
					name="name"
					type="text"
					required
					class="border-border bg-bg-tertiary text-text-primary focus:border-accent-dim w-full rounded border px-3 py-2 font-mono text-xs outline-none"
				/>
			</label>
			<label class="block">
				<span class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase">
					Icon (optional)
				</span>
				<input
					name="icon"
					type="file"
					accept="image/*"
					class="text-text-secondary w-full font-mono text-xs"
				/>
			</label>
			{#if form?.missing}
				<p class="text-danger font-mono text-[10px]">Name is required</p>
			{/if}
			<div class="flex justify-end gap-2">
				<a
					href="/"
					class="text-text-secondary hover:text-text-primary rounded px-3 py-2 font-mono text-[10px] tracking-wider uppercase"
				>
					Cancel
				</a>
				<button
					type="submit"
					disabled={submitting}
					class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{submitting ? 'Creating…' : 'Create'}
				</button>
			</div>
		</form>
	{:else if action === 'join'}
		<form
			method="POST"
			action="?/accept"
			use:enhance={() => {
				submitting = true;
				return async ({ result }) => onActionSuccess({ result });
			}}
			class="border-border bg-bg-secondary w-full max-w-sm space-y-4 rounded-lg border p-6"
		>
			<h2 class="text-accent font-mono text-xs tracking-[3px] uppercase">Accept Invite</h2>
			<label class="block">
				<span class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase">
					Invite URL
				</span>
				<input
					name="url"
					type="text"
					required
					placeholder="ghostdrive://..."
					class="border-border bg-bg-tertiary text-text-primary focus:border-accent-dim w-full rounded border px-3 py-2 font-mono text-xs outline-none"
				/>
			</label>
			{#if form?.error}
				<p class="text-danger font-mono text-[10px]">{form.error}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<a
					href="/"
					class="text-text-secondary hover:text-text-primary rounded px-3 py-2 font-mono text-[10px] tracking-wider uppercase"
				>
					Cancel
				</a>
				<button
					type="submit"
					disabled={submitting}
					class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{submitting ? 'Joining…' : 'Join'}
				</button>
			</div>
		</form>
	{:else}
		<div class="flex flex-col items-center gap-5 text-center">
			<img src={logo} alt="" class="h-12 w-12 opacity-20" />
			<div class="space-y-1">
				<p class="text-text-secondary font-mono text-xs tracking-[3px] uppercase">No drives yet</p>
				<p class="text-text-muted font-mono text-[10px]">
					Create a drive or accept an invite to get started
				</p>
			</div>
			<div class="flex gap-2">
				<a
					href="/?action=new"
					class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition hover:brightness-110"
				>
					New Drive
				</a>
				<a
					href="/?action=join"
					class="border-border text-text-secondary hover:border-accent-dim hover:text-accent rounded border px-4 py-2 font-mono text-[10px] tracking-wider uppercase transition"
				>
					Accept Invite
				</a>
			</div>
		</div>
	{/if}
</div>
