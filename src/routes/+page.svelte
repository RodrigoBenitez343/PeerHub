<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import logo from '$lib/assets/images/ghost-mark.png';
	import Icon from '$lib/components/Icon.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const action = $derived(page.url.searchParams.get('action'));
	let pending = $state<string | null>(null);

	function submit(name: string) {
		return () => {
			pending = name;
			return async () => {
				pending = null;
			};
		};
	}
</script>

<div class="flex-1 overflow-auto">
	<div class="mx-auto w-full max-w-3xl px-4 py-8 md:py-10">
		<header class="mb-8 flex items-start gap-4">
			<img src={logo} alt="" class="mt-0.5 h-14 w-14 shrink-0" />
			<div class="min-w-0 flex-1">
				<h1 class="text-text-primary font-mono text-sm tracking-[3px] uppercase">PeerHub</h1>
				<p class="text-text-muted mt-1 text-[11px]">
					Repositories live on the peers that host them. No server, no account.
				</p>
			</div>
			{#if data.selfKey}
				<span
					class="border-border text-text-muted shrink-0 rounded border px-2 py-1 font-mono text-[9px]"
				>
					you: {data.selfKey}
				</span>
			{/if}
		</header>

		{#if form?.error}
			<p
				class="border-danger/40 bg-danger/5 text-danger mb-4 rounded border px-3 py-2 font-mono text-[11px]"
			>
				{form.error}
			</p>
		{/if}

		{#if action === 'new'}
			<form
				method="POST"
				action="?/create"
				enctype="multipart/form-data"
				use:enhance={submit('create')}
				class="border-border bg-bg-secondary rounded-lg border p-5"
			>
				<h2 class="text-accent font-mono text-[11px] tracking-[3px] uppercase">New repository</h2>
				<div class="mt-4 space-y-3">
					<label class="block">
						<span
							class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase"
						>
							Name
						</span>
						<input
							name="name"
							required
							placeholder="my-project"
							class="border-border bg-bg-tertiary text-text-primary placeholder:text-text-muted focus:border-accent-dim w-full rounded border px-3 py-2 font-mono text-xs outline-none"
						/>
					</label>
					<label class="block">
						<span
							class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase"
						>
							Description
						</span>
						<input
							name="description"
							placeholder="Short summary"
							class="border-border bg-bg-tertiary text-text-primary placeholder:text-text-muted focus:border-accent-dim w-full rounded border px-3 py-2 font-mono text-xs outline-none"
						/>
					</label>
					<div class="flex flex-col gap-3 sm:flex-row">
						<label class="flex-1">
							<span
								class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase"
							>
								Visibility
							</span>
							<select
								name="visibility"
								class="border-border bg-bg-tertiary text-text-secondary w-full rounded border px-3 py-2 font-mono text-xs outline-none"
							>
								<option value="public">public — any peer can open it</option>
								<option value="private">private — invite link required</option>
							</select>
						</label>
						<label class="w-full sm:w-40">
							<span
								class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase"
							>
								Default branch
							</span>
							<input
								name="defaultBranch"
								value="main"
								class="border-border bg-bg-tertiary text-text-primary w-full rounded border px-3 py-2 font-mono text-xs outline-none"
							/>
						</label>
					</div>
					<label class="block">
						<span
							class="text-text-secondary mb-1 block font-mono text-[10px] tracking-wider uppercase"
						>
							Icon (optional)
						</span>
						<input name="icon" type="file" accept="image/*" class="text-text-secondary text-xs" />
					</label>
				</div>
				<div class="mt-5 flex justify-end gap-2">
					<a
						href="/"
						class="text-text-secondary hover:text-text-primary rounded px-3 py-2 font-mono text-[10px] tracking-wider uppercase"
					>
						Cancel
					</a>
					<button
						type="submit"
						disabled={pending === 'create'}
						class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase hover:brightness-110 disabled:opacity-50"
					>
						{pending === 'create' ? 'Creating…' : 'Create repository'}
					</button>
				</div>
			</form>
		{:else if action === 'join'}
			<form
				method="POST"
				action="?/accept"
				use:enhance={submit('join')}
				class="border-border bg-bg-secondary rounded-lg border p-5"
			>
				<h2 class="text-accent font-mono text-[11px] tracking-[3px] uppercase">Join with invite</h2>
				<p class="text-text-muted mt-2 text-[11px]">
					Private repositories are opened with a capability link from their owner.
				</p>
				<input
					name="url"
					required
					placeholder="peerhub://..."
					class="border-border bg-bg-tertiary text-text-primary placeholder:text-text-muted focus:border-accent-dim mt-4 w-full rounded border px-3 py-2 font-mono text-xs outline-none"
				/>
				<div class="mt-5 flex justify-end gap-2">
					<a
						href="/"
						class="text-text-secondary hover:text-text-primary rounded px-3 py-2 font-mono text-[10px] tracking-wider uppercase"
					>
						Cancel
					</a>
					<button
						type="submit"
						disabled={pending === 'join'}
						class="bg-accent text-bg-primary rounded px-4 py-2 font-mono text-[10px] tracking-wider uppercase hover:brightness-110 disabled:opacity-50"
					>
						{pending === 'join' ? 'Joining…' : 'Open repository'}
					</button>
				</div>
			</form>
		{:else}
			<div class="mb-8 flex flex-wrap gap-2">
				<a
					href="/?action=new"
					class="bg-accent text-bg-primary flex items-center gap-2 rounded px-4 py-2.5 font-mono text-[10px] tracking-wider uppercase transition hover:brightness-110"
				>
					<Icon name="plus" size={15} />
					New repository
				</a>
				<a
					href="/?action=join"
					class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-2 rounded border px-4 py-2.5 font-mono text-[10px] tracking-wider uppercase transition"
				>
					<Icon name="link" size={15} />
					Join with invite
				</a>
				<a
					href="/explore"
					class="border-border text-text-secondary hover:border-accent hover:text-accent flex items-center gap-2 rounded border px-4 py-2.5 font-mono text-[10px] tracking-wider uppercase transition"
				>
					<Icon name="globe" size={15} />
					Explore
				</a>
				<form method="POST" action="?/refresh" use:enhance={submit('refresh')}>
					<button
						type="submit"
						disabled={pending === 'refresh'}
						class="border-border text-text-muted hover:text-text-secondary flex items-center gap-2 rounded border px-3 py-2.5 font-mono text-[10px] tracking-wider uppercase transition disabled:opacity-50"
					>
						<Icon name="refresh" size={15} />
						{pending === 'refresh' ? 'Asking peers…' : 'Refresh peers'}
					</button>
				</form>
			</div>

			<section class="mb-10">
				<h2 class="text-text-muted mb-2 font-mono text-[10px] tracking-[3px] uppercase">
					Your repositories · {data.repos.length}
				</h2>
				{#if data.repos.length === 0}
					<div
						class="border-border text-text-muted rounded-lg border border-dashed px-4 py-6 text-center text-[11px]"
					>
						No repositories yet. Create one — it exists only on this device until another peer opens
						it.
					</div>
				{:else}
					<ul class="border-border divide-border divide-y overflow-hidden rounded-lg border">
						{#each data.repos as repo (repo.id)}
							<li class="bg-bg-secondary hover:bg-bg-hover transition">
								<a href={`/drive/${repo.id}/code`} class="flex items-start gap-3 px-4 py-3">
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<span class="text-text-primary truncate font-mono text-xs">{repo.name}</span>
											<span
												class="border-border text-text-muted rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wider uppercase"
											>
												{repo.isGuest ? 'mirror' : repo.visibility}
											</span>
											{#if repo.forkedFrom}
												<span class="text-text-muted font-mono text-[9px]">fork</span>
											{/if}
										</div>
										{#if repo.description}
											<p class="text-text-muted mt-1 line-clamp-2 text-[11px]">
												{repo.description}
											</p>
										{/if}
										<p class="text-text-muted mt-1 font-mono text-[9px]">
											{repo.defaultBranch} · {repo.peers}
											{repo.peers === 1 ? 'peer' : 'peers'} online
										</p>
									</div>
									<span class="text-text-muted mt-1 font-mono text-[10px]">open →</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section>
				<h2
					class="text-text-muted mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] tracking-[3px] uppercase"
				>
					<span>Public repositories · {data.publicRepos.length}</span>
					<span class:text-accent={data.peers > 0} class="tracking-wider">
						· {data.peers}
						{data.peers === 1 ? 'peer' : 'peers'} on the network
					</span>
				</h2>
				{#if data.publicRepos.length === 0}
					<div
						class="border-border text-text-muted rounded-lg border border-dashed px-4 py-6 text-center text-[11px]"
					>
						{#if data.peers === 0}
							No other peer is connected right now. Public repos are announced peer to peer, so this
							list fills in when another peer hosting repos is online — press Refresh peers once it
							is. Private repos always need an invite link.
						{:else}
							The {data.peers} connected {data.peers === 1 ? 'peer has' : 'peers have'} not announced
							any public repos yet.
						{/if}
					</div>
				{:else}
					<ul class="border-border divide-border divide-y overflow-hidden rounded-lg border">
						{#each data.publicRepos as repo (repo.key)}
							<li class="bg-bg-secondary px-4 py-3">
								<div class="flex flex-wrap items-start gap-3">
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											{#if repo.ownId}
												<a
													href={`/drive/${repo.ownId}/code`}
													class="text-text-primary hover:text-accent truncate font-mono text-xs"
												>
													{repo.name}
												</a>
											{:else}
												<span class="text-text-primary truncate font-mono text-xs">{repo.name}</span
												>
											{/if}
											<span
												class="border-border text-text-muted rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wider uppercase"
											>
												{repo.visibility}
											</span>
											{#if repo.ownId}
												<span
													class="text-accent shrink-0 font-mono text-[9px] tracking-wider uppercase"
												>
													yours
												</span>
											{:else if repo.openedId}
												<a
													href={`/drive/${repo.openedId}/code`}
													class="text-accent shrink-0 font-mono text-[9px] tracking-wider uppercase hover:underline"
												>
													opened · mirror →
												</a>
											{/if}
										</div>
										{#if repo.description}
											<p class="text-text-muted mt-1 line-clamp-2 text-[11px]">
												{repo.description}
											</p>
										{/if}
										<p class="text-text-muted mt-1 font-mono text-[9px]">
											by {repo.owner} · {repo.defaultBranch}
										</p>
									</div>

									{#if repo.ownId}
										<a
											href={`/drive/${repo.ownId}/code`}
											class="text-text-muted hover:text-accent shrink-0 font-mono text-[9px] tracking-wider uppercase"
										>
											open →
										</a>
									{:else if repo.openable}
										<div class="flex shrink-0 items-center gap-1">
											{#if !repo.openedId}
												<form
													method="POST"
													action="?/open"
													use:enhance={submit('open:' + repo.repoId)}
												>
													<input type="hidden" name="driveKey" value={repo.driveKey} />
													<input type="hidden" name="metaKey" value={repo.metaKey ?? ''} />
													<input type="hidden" name="name" value={repo.name} />
													<input type="hidden" name="description" value={repo.description ?? ''} />
													<input type="hidden" name="ownerKey" value={repo.peerKey} />
													<button
														type="submit"
														disabled={pending === 'open:' + repo.repoId}
														class="border-border text-text-secondary hover:border-accent hover:text-accent rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition disabled:opacity-50"
													>
														Open
													</button>
												</form>
											{/if}
											<form
												method="POST"
												action="?/fork"
												use:enhance={submit('fork:' + repo.repoId)}
											>
												<input type="hidden" name="driveKey" value={repo.driveKey} />
												<input type="hidden" name="repoId" value={repo.repoId} />
												<input type="hidden" name="name" value={repo.name} />
												<input type="hidden" name="description" value={repo.description ?? ''} />
												<button
													type="submit"
													disabled={pending === 'fork:' + repo.repoId}
													class="border-border text-text-secondary hover:border-accent hover:text-accent rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition disabled:opacity-50"
													title="Copy this repo to your device"
												>
													Fork
												</button>
											</form>
										</div>
									{:else}
										<a
											href="/?action=join"
											class="text-text-muted hover:text-accent shrink-0 font-mono text-[9px] tracking-wider uppercase"
										>
											invite required →
										</a>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</div>
</div>
