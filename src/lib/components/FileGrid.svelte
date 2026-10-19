<script lang="ts">
	import FileItem from './FileItem.svelte';
	import Modal from './Modal.svelte';
	import { detectKind } from '$lib';
	import { invalidateAll } from '$app/navigation';
	import logo from '$lib/assets/images/ghost.png';

	type Entry = { name: string; isFolder: boolean; cached?: boolean; size: number | null };
	type GroupBy = 'none' | 'type' | 'cached';
	type SortBy = 'name' | 'size';
	type Group = { key: string; label: string; items: Entry[] };

	let {
		driveId,
		path: dirPath,
		entries,
		peers = 0,
		isGuest = false,
		canWrite = false
	}: {
		driveId: string;
		path: string;
		entries: Entry[];
		peers?: number;
		isGuest?: boolean;
		canWrite?: boolean;
	} = $props();

	let query = $state('');
	let groupBy = $state<GroupBy>('type');
	let sortBy = $state<SortBy>('name');
	let dropdownOpen = $state(false);

	let fileInput: HTMLInputElement | undefined = $state();
	let folderInput: HTMLInputElement | undefined = $state();
	let uploading = $state<{ done: number; total: number; name: string } | null>(null);
	let notice = $state<string | null>(null);
	let pendingDelete = $state<Entry | null>(null);
	let confirmDelete = $state(false);

	// Encode per segment: a full encodeURIComponent would turn the separators into
	// %2F and hand the route one giant segment.
	function apiPath(relative: string) {
		const full = dirPath === '/' ? `/${relative}` : `${dirPath}/${relative}`;
		const encoded = full.split('/').map(encodeURIComponent).join('/');
		return `/api/files/${driveId}${encoded}`;
	}

	async function uploadFiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (files.length === 0) return;

		notice = null;
		uploading = { done: 0, total: files.length, name: files[0].name };

		for (const file of files) {
			uploading = { ...uploading, name: file.name };
			// Picked folders carry their path relative to the chosen root.
			const relative = (file as any).webkitRelativePath || file.name;
			try {
				const res = await fetch(apiPath(relative), { method: 'PUT', body: file });
				if (!res.ok) throw new Error((await res.text()) || res.statusText);
			} catch (err: any) {
				notice = `Could not upload ${relative}: ${err.message}`;
				setTimeout(() => (notice = null), 6000);
				break;
			}
			uploading = { ...uploading, done: uploading.done + 1 };
		}

		uploading = null;
		await invalidateAll();
	}

	async function removeEntry() {
		const entry = pendingDelete;
		if (!entry) return;

		notice = null;
		try {
			const res = await fetch(apiPath(entry.name), { method: 'DELETE' });
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
		} catch (err: any) {
			pendingDelete = null;
			notice = `Could not delete ${entry.name}: ${err.message}`;
			setTimeout(() => (notice = null), 6000);
			return;
		}

		pendingDelete = null;
		await invalidateAll();
	}

	// Reset query when directory changes
	$effect(() => {
		dirPath;
		query = '';
	});

	const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
		{ value: 'none', label: 'No Group' },
		{ value: 'type', label: 'By Type' },
		{ value: 'cached', label: 'By Cache' }
	];
	const currentGroupLabel = $derived(
		GROUP_OPTIONS.find((o) => o.value === groupBy)?.label ?? 'Group'
	);

	function joinPath(name: string) {
		return dirPath === '/' ? '/' + name : `${dirPath}/${name}`;
	}

	function entryKind(e: Entry): string {
		if (e.isFolder) return 'folder';
		return detectKind(e.name.split('.').pop()?.toLowerCase() ?? '');
	}

	function compareEntries(a: Entry, b: Entry): number {
		if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
		if (sortBy === 'size') {
			const diff = (b.size ?? -1) - (a.size ?? -1);
			if (diff !== 0) return diff;
		}
		return a.name.localeCompare(b.name);
	}

	const TYPE_ORDER: Record<string, number> = {
		folder: 0,
		image: 1,
		video: 2,
		audio: 3,
		code: 4,
		doc: 5,
		pdf: 6,
		spreadsheet: 7,
		archive: 8,
		data: 9,
		generic: 10
	};

	const TYPE_LABEL: Record<string, string> = {
		folder: 'Folders',
		image: 'Images',
		video: 'Video',
		audio: 'Audio',
		code: 'Code',
		doc: 'Documents',
		pdf: 'PDF',
		spreadsheet: 'Spreadsheets',
		archive: 'Archives',
		data: 'Data Files',
		generic: 'Other'
	};

	const filtered = $derived(
		query.trim()
			? entries.filter((e) => e.name.toLowerCase().includes(query.trim().toLowerCase()))
			: entries
	);

	const flatSorted = $derived([...filtered].sort(compareEntries));

	const groups = $derived.by((): Group[] => {
		if (groupBy === 'none') return [];
		const sorted = [...filtered].sort(compareEntries);

		if (groupBy === 'type') {
			const map = new Map<string, Entry[]>();
			for (const e of sorted) {
				const k = entryKind(e);
				if (!map.has(k)) map.set(k, []);
				map.get(k)!.push(e);
			}
			return [...map.entries()]
				.sort(([a], [b]) => (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99))
				.map(([key, items]) => ({ key, label: TYPE_LABEL[key] ?? key, items }));
		}

		if (groupBy === 'cached') {
			const result: Group[] = [];
			const c = sorted.filter((e) => e.cached);
			const u = sorted.filter((e) => !e.cached);
			if (c.length) result.push({ key: 'cached', label: 'Cached', items: c });
			if (u.length) result.push({ key: 'uncached', label: 'Not Cached', items: u });
			return result;
		}

		return [];
	});

	const GRID = 'grid gap-3 p-4' as const;
	const GRID_COLS = 'grid-template-columns: repeat(auto-fill, minmax(110px, 1fr))' as const;
</script>

<Modal
	bind:open={confirmDelete}
	title="Delete file"
	message={pendingDelete
		? `Remove "${pendingDelete.name}" from the shared drive for every peer?`
		: ''}
	confirmLabel="Delete"
	danger
	onConfirm={removeEntry}
/>

<input bind:this={fileInput} type="file" multiple class="hidden" onchange={uploadFiles} />
<input bind:this={folderInput} type="file" webkitdirectory class="hidden" onchange={uploadFiles} />

{#if entries.length === 0 && !query}
	<div class="flex h-full items-center justify-center">
		{#if peers === 0 && isGuest}
			<div class="flex flex-col items-center gap-3 text-center">
				<img src={logo} alt="" class="h-10 w-10 opacity-20" />
				<p class="text-text-muted font-mono text-xs tracking-wider uppercase">No cached files</p>
				<p class="text-text-muted font-mono text-[10px] leading-relaxed">
					Cache files while connected<br />to browse them offline
				</p>
			</div>
		{:else if !isGuest}
			<div class="flex flex-col items-center gap-3 text-center">
				<svg
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1"
					class="text-text-muted h-8 w-8 opacity-40"
				>
					<path d="M2 4h12v8H2z" />
					<path d="M6 8h4M8 6v4" stroke-width="1.2" />
				</svg>
				<p class="text-text-muted font-mono text-xs tracking-wider uppercase">No content</p>
				<div class="flex gap-2">
					{#if canWrite}
						<button
							onclick={() => fileInput?.click()}
							class="bg-accent text-bg-primary rounded px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase transition hover:brightness-110"
						>
							Upload files
						</button>
						<button
							onclick={() => folderInput?.click()}
							class="border-border text-text-secondary hover:border-accent-dim hover:text-accent rounded border px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase transition"
						>
							Upload folder
						</button>
					{/if}
					<a
						href="/drive/{driveId}/settings"
						class="border-border text-text-secondary hover:border-accent-dim hover:text-accent rounded border px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase transition"
					>
						Add a Drive in Settings
					</a>
				</div>
			</div>
		{:else}
			<div class="flex flex-col items-center gap-3 text-center">
				<p class="text-text-muted font-mono text-xs tracking-wider uppercase">Empty</p>
				{#if canWrite}
					<div class="flex gap-2">
						<button
							onclick={() => fileInput?.click()}
							class="bg-accent text-bg-primary rounded px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase transition hover:brightness-110"
						>
							Upload files
						</button>
						<button
							onclick={() => folderInput?.click()}
							class="border-border text-text-secondary hover:border-accent-dim hover:text-accent rounded border px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase transition"
						>
							Upload folder
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<!-- Toolbar: sort left · search centre · group right -->
	<div class="border-border bg-bg-primary sticky top-0 z-10 border-b">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 md:flex-nowrap">
			<!-- Sort (left) -->
			<div class="border-border order-1 flex shrink-0 overflow-hidden rounded border">
				<button
					onclick={() => (sortBy = 'name')}
					class="px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition {sortBy ===
					'name'
						? 'bg-accent-dim/20 text-accent'
						: 'text-text-muted hover:text-text-secondary'}"
				>
					A-Z
				</button>
				<button
					onclick={() => (sortBy = 'size')}
					class="border-border border-l px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition {sortBy ===
					'size'
						? 'bg-accent-dim/20 text-accent'
						: 'text-text-muted hover:text-text-secondary'}"
				>
					Size
				</button>
			</div>

			{#if canWrite}
				<button
					onclick={() => fileInput?.click()}
					disabled={!!uploading}
					class="border-border text-text-secondary hover:border-accent-dim hover:text-accent order-1 shrink-0 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition disabled:opacity-50"
				>
					{uploading ? 'Uploading' : 'Upload'}
				</button>
				<button
					onclick={() => folderInput?.click()}
					disabled={!!uploading}
					class="border-border text-text-secondary hover:border-accent-dim hover:text-accent order-1 shrink-0 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition disabled:opacity-50"
					title="Upload a folder with all of its files"
				>
					Folder
				</button>
			{/if}

			<!-- Search (full-width row 2 on mobile, flex-1 centre on desktop) -->
			<div class="relative order-3 w-full min-w-0 md:order-2 md:w-auto md:flex-1">
				<svg
					class="text-text-muted pointer-events-none absolute top-1/2 left-2.5 h-3 w-3 -translate-y-1/2"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
				>
					<circle cx="6.5" cy="6.5" r="4" />
					<path d="M10.5 10.5l3 3" stroke-linecap="round" />
				</svg>
				<input
					type="text"
					bind:value={query}
					placeholder="Filter…"
					class="border-border bg-bg-tertiary text-text-primary placeholder:text-text-muted focus:border-accent-dim w-full rounded border py-1.5 pr-6 pl-7 font-mono text-[11px] outline-none"
				/>
				{#if query}
					<button
						onclick={() => (query = '')}
						class="text-text-muted hover:text-text-primary absolute top-1/2 right-2 -translate-y-1/2 transition"
						aria-label="Clear filter"
					>
						<svg
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							class="h-3 w-3"
						>
							<path d="M3 3l10 10M13 3L3 13" />
						</svg>
					</button>
				{/if}
			</div>

			<!-- Group (right of row 1 on mobile, rightmost on desktop) -->
			<div class="relative order-2 ml-auto shrink-0 md:order-3 md:ml-0">
				<button
					onclick={() => (dropdownOpen = !dropdownOpen)}
					class="border-border bg-bg-tertiary text-text-secondary hover:border-accent-dim flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[9px] tracking-wider uppercase transition {dropdownOpen
						? 'border-accent-dim'
						: ''}"
				>
					{currentGroupLabel}
					<svg
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="h-2.5 w-2.5 transition-transform duration-150 {dropdownOpen ? 'rotate-180' : ''}"
					>
						<path d="M4 6l4 4 4-4" />
					</svg>
				</button>

				{#if dropdownOpen}
					<button
						class="fixed inset-0 z-10"
						onclick={() => (dropdownOpen = false)}
						aria-hidden="true"
						tabindex="-1"
					></button>
					<div
						class="border-border bg-bg-secondary absolute top-full right-0 z-20 mt-1 w-36 overflow-hidden rounded border shadow-lg"
					>
						{#each GROUP_OPTIONS as opt}
							<button
								onclick={() => {
									groupBy = opt.value;
									dropdownOpen = false;
								}}
								class="hover:bg-bg-hover flex w-full items-center justify-between px-3 py-2.5 font-mono text-[10px] tracking-wider uppercase transition {groupBy ===
								opt.value
									? 'text-accent'
									: 'text-text-secondary'}"
							>
								{opt.label}
								{#if groupBy === opt.value}
									<svg
										viewBox="0 0 16 16"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										class="h-2.5 w-2.5"
									>
										<path d="M3 8l4 4 6-7" />
									</svg>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		{#if uploading || notice}
			<div class="border-border flex items-center gap-2 border-t px-3 py-1.5">
				{#if uploading}
					<span class="text-accent font-mono text-[10px] tracking-wider uppercase">
						{uploading.done}/{uploading.total} · {uploading.name}
					</span>
				{:else if notice}
					<span class="text-danger font-mono text-[10px]">{notice}</span>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Content -->
	{#if filtered.length === 0}
		<div class="flex flex-col items-center gap-2 py-16 text-center">
			<p class="text-text-muted font-mono text-xs tracking-wider uppercase">No matches</p>
			<button
				onclick={() => (query = '')}
				class="text-accent hover:text-accent/80 font-mono text-[10px] tracking-wider uppercase transition"
			>
				Clear filter
			</button>
		</div>
	{:else if groupBy === 'none'}
		<div class={GRID} style={GRID_COLS}>
			{#each flatSorted as e (e.name)}
				<FileItem
					name={e.name}
					isFolder={e.isFolder}
					cached={e.cached}
					size={e.size}
					{peers}
					{isGuest}
					onDelete={canWrite ? () => ((pendingDelete = e), (confirmDelete = true)) : null}
					href={e.isFolder
						? `/drive/${driveId}?path=${encodeURIComponent(joinPath(e.name))}`
						: `/drive/${driveId}/preview?file=${encodeURIComponent(joinPath(e.name))}`}
				/>
			{/each}
		</div>
	{:else}
		{#each groups as group (group.key)}
			<div class="px-4 pt-4 pb-1">
				<p class="text-text-muted font-mono text-[9px] tracking-[3px] uppercase">
					{group.label}
					<span class="ml-1 opacity-50">{group.items.length}</span>
				</p>
			</div>
			<div class={GRID} style={GRID_COLS}>
				{#each group.items as e (e.name)}
					<FileItem
						name={e.name}
						isFolder={e.isFolder}
						cached={e.cached}
						size={e.size}
						{peers}
						{isGuest}
						onDelete={canWrite ? () => ((pendingDelete = e), (confirmDelete = true)) : null}
						href={e.isFolder
							? `/drive/${driveId}?path=${encodeURIComponent(joinPath(e.name))}`
							: `/drive/${driveId}/preview?file=${encodeURIComponent(joinPath(e.name))}`}
					/>
				{/each}
			</div>
		{/each}
	{/if}
{/if}
