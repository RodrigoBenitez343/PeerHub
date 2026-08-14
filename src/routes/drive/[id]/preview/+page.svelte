<script lang="ts">
	import type { PageData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import logo from '$lib/assets/images/ghost.png';

	let { data }: { data: PageData } = $props();

	function parentDir(p: string) {
		if (p === '/' || !p.includes('/')) return '/';
		const idx = p.lastIndexOf('/');
		return idx <= 0 ? '/' : p.slice(0, idx);
	}

	const fileUrl = $derived(`/api/files/${data.drive.id}${data.path}`);
	// Absolute URL so the WebView hands the link off to the system browser,
	// which can actually save the file (?dl=1 sets Content-Disposition: attachment).
	const dlUrl = $derived(`${page.url.origin}${fileUrl}?dl=1`);
	const parentPath = $derived(parentDir(data.path));
	const filename = $derived(data.path.split('/').pop() || data.path);

	// Native download (Android): the server streams the file into a location the
	// user picks via the system file dialog. Elsewhere we fall back to the link.
	let downloading = $state(false);
	let notice = $state('');

	function onDownload() {
		downloading = true;
		notice = '';
		return async ({ result }: { result: any }) => {
			downloading = false;
			// The download runs in the background; the downloads tray shows progress.
			notice = result.type === 'success' ? 'Downloading…' : (result.data?.error ?? 'Failed');
			globalThis.setTimeout(() => (notice = ''), 3000);
		};
	}
</script>

{#snippet downloadControl(label: string, klass: string)}
	{#if data.canPickDownload}
		<form method="POST" action="?/download" use:enhance={onDownload} class="contents">
			<input type="hidden" name="file" value={data.path} />
			<button type="submit" class={klass} disabled={downloading}>
				{downloading ? 'Saving…' : label}
			</button>
		</form>
	{:else}
		<a href={dlUrl} target="_blank" rel="noopener" class={klass}>{label}</a>
	{/if}
{/snippet}

<header class="border-border bg-bg-secondary flex h-11 items-center gap-3 border-b px-4">
	<a
		href={`/drive/${data.drive.id}?path=${encodeURIComponent(parentPath)}`}
		class="text-text-secondary hover:text-accent flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] transition"
	>
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3 w-3">
			<path d="M10 3L5 8l5 5" />
		</svg>
		Back
	</a>
	<span class="text-text-primary flex-1 truncate font-mono text-[11px]">{filename}</span>
	<span
		class="text-text-muted border-border rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wider uppercase"
	>
		{data.kind}
	</span>

	{#if data.cached}
		<span
			class="text-accent font-mono text-[10px] tracking-wider uppercase"
			style="filter: drop-shadow(0 0 6px rgba(200,168,78,0.4))"
		>
			cached
		</span>
	{:else}
		<form method="POST" action="?/cache" use:enhance class="contents">
			<input type="hidden" name="file" value={data.path} />
			<button
				type="submit"
				class="text-text-secondary hover:text-accent rounded px-2 py-1 font-mono text-[10px] tracking-wider uppercase transition"
				title="Save to local cache"
			>
				Cache
			</button>
		</form>
	{/if}
	{#if notice}
		<span class="text-text-muted font-mono text-[10px] tracking-wider uppercase">{notice}</span>
	{/if}
	{@render downloadControl(
		'Download',
		'bg-accent/10 text-accent hover:bg-accent/20 rounded px-2 py-1 font-mono text-[10px] tracking-wider uppercase transition disabled:opacity-50'
	)}
</header>

<section class="flex flex-1 items-center justify-center overflow-hidden p-4">
	{#if data.unavailable}
		<div class="flex flex-col items-center gap-3 text-center">
			<img src={logo} alt="" class="h-8 w-8 opacity-20" />
			<p class="text-text-secondary font-mono text-xs tracking-wider uppercase">
				Not available offline
			</p>
			<p class="text-text-muted font-mono text-[10px] leading-relaxed">
				Connect to the host to access this file,<br />then cache it for offline use
			</p>
			<a
				href={`/drive/${data.drive.id}?path=${encodeURIComponent(parentPath)}`}
				class="text-accent font-mono text-[10px] tracking-wider uppercase underline underline-offset-2"
			>
				Back to drive
			</a>
		</div>
	{:else if data.kind === 'video'}
		<video src={fileUrl} controls autoplay class="max-h-full max-w-full bg-black"></video>
	{:else if data.kind === 'audio'}
		<audio src={fileUrl} controls autoplay class="w-full max-w-2xl"></audio>
	{:else if data.kind === 'image'}
		<img src={fileUrl} alt={filename} class="max-h-full max-w-full object-contain" />
	{:else if data.kind === 'text' && data.isEmpty}
		<p class="text-text-muted font-mono text-xs tracking-wider uppercase">Empty file</p>
	{:else if data.kind === 'text' && data.isBinary}
		<div class="flex flex-col items-center gap-2 text-center">
			<p class="text-text-muted font-mono text-xs tracking-wider uppercase">Binary file</p>
			{@render downloadControl(
				'Download to open',
				'text-accent font-mono text-[10px] tracking-wider uppercase underline underline-offset-2 disabled:opacity-50'
			)}
		</div>
	{:else if data.kind === 'text' && data.textPreview != null}
		<pre
			class="border-border bg-bg-secondary text-text-primary h-full w-full overflow-auto rounded border p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{data.textPreview}</pre>
	{:else}
		<div class="flex flex-col items-center gap-2 text-center">
			<p class="text-text-muted font-mono text-xs tracking-wider uppercase">
				No preview for .{filename.split('.').pop()}
			</p>
			{@render downloadControl(
				'Download to open',
				'text-accent font-mono text-[10px] tracking-wider uppercase underline underline-offset-2 disabled:opacity-50'
			)}
		</div>
	{/if}
</section>
