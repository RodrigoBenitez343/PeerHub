<script lang="ts">
	import { detectKind, formatFileSize } from '$lib';

	let {
		name,
		isFolder,
		cached,
		size = null,
		peers = 1,
		isGuest = false,
		href
	}: {
		name: string;
		isFolder: boolean;
		cached?: boolean;
		size?: number | null;
		peers?: number;
		isGuest?: boolean;
		href: string;
	} = $props();

	const ext = $derived(name.split('.').pop()?.toLowerCase() ?? '');
	const fileKind = $derived(isFolder ? 'folder' : detectKind(ext));
	const offline = $derived(isGuest && peers === 0 && !isFolder && !cached);
	const formattedSize = $derived(isFolder ? null : formatFileSize(size));
</script>

<a
	{href}
	class="group hover:bg-bg-hover relative flex flex-col items-center gap-1.5 rounded-md p-3 transition-all duration-150 hover:scale-[1.03]"
	class:opacity-40={offline}
	title={offline ? 'Not available offline' : name}
>
	<div
		class="relative flex h-12 w-12 items-center justify-center transition-all duration-150"
		class:text-accent={cached}
		class:text-accent-dim={!cached}
		style={cached ? 'filter: drop-shadow(0 0 8px rgba(200,168,78,0.5))' : ''}
	>
		{#if fileKind === 'folder'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<path d="M2 4h4l1.5 1.5H14V13H2z" />
			</svg>
		{:else if fileKind === 'image'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<rect x="2" y="2" width="12" height="12" />
				<circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" />
				<path d="M2 12l4-4 8 4" />
			</svg>
		{:else if fileKind === 'video'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<rect x="2" y="3" width="12" height="10" rx="1" />
				<rect
					x="2"
					y="3"
					width="2.5"
					height="10"
					fill="currentColor"
					opacity="0.25"
					stroke="none"
				/>
				<rect
					x="11.5"
					y="3"
					width="2.5"
					height="10"
					fill="currentColor"
					opacity="0.25"
					stroke="none"
				/>
				<path d="M2.5 5.5h1.5M2.5 8h1.5M2.5 10.5h1.5M12 5.5h1.5M12 8h1.5M12 10.5h1.5" />
				<path d="M6.5 6.5l4 1.5-4 1.5z" fill="currentColor" stroke="none" />
			</svg>
		{:else if fileKind === 'audio'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				class="h-10 w-10"
			>
				<path d="M1.5 8h1.5M4 6.5v3M6 4.5v7M8 3v10M10 4.5v7M12 6.5v3M14.5 8h-1.5" />
			</svg>
		{:else if fileKind === 'code'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<path d="M5 5L2 8l3 3M11 5l3 3-3 3M9 3l-2 10" />
			</svg>
		{:else if fileKind === 'doc'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<path d="M3 2h7l3 3v9H3z" />
				<path d="M10 2v3h3" />
				<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" />
			</svg>
		{:else if fileKind === 'pdf'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<path d="M3 2h7l3 3v9H3z" />
				<path d="M10 2v3h3" />
				<rect
					x="3"
					y="10.5"
					width="10"
					height="3.5"
					fill="currentColor"
					opacity="0.4"
					stroke="none"
				/>
				<path d="M5.5 7h5M5.5 8.8h3" />
			</svg>
		{:else if fileKind === 'archive'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<path d="M3 6h10v7H3z" />
				<path d="M5.5 6V4h5v2" />
				<path d="M5.5 8.5h5M5.5 10.5h5" />
			</svg>
		{:else if fileKind === 'spreadsheet'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<rect x="2" y="2" width="12" height="12" rx="0.5" />
				<rect
					x="2"
					y="2"
					width="12"
					height="3.5"
					fill="currentColor"
					opacity="0.25"
					stroke="none"
				/>
				<path d="M2 5.5h12M2 9.5h12M7.5 5.5v8.5" />
			</svg>
		{:else if fileKind === 'data'}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="h-10 w-10"
			>
				<path
					d="M8 2.5C6.5 2.5 5.5 3 5.5 4.5V7C5.5 7.8 4.5 8 4.5 8C4.5 8 5.5 8.2 5.5 9V11.5C5.5 13 6.5 13.5 8 13.5"
				/>
				<path
					d="M8 2.5C9.5 2.5 10.5 3 10.5 4.5V7C10.5 7.8 11.5 8 11.5 8C11.5 8 10.5 8.2 10.5 9V11.5C10.5 13 9.5 13.5 8 13.5"
				/>
			</svg>
		{:else}
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				class="h-10 w-10"
			>
				<path d="M3 2h7l3 3v9H3z" />
				<path d="M10 2v3h3" />
			</svg>
		{/if}
	</div>

	<span
		class="text-text-primary line-clamp-2 h-[2.5em] w-full overflow-hidden text-center text-[11px] leading-tight break-words"
	>
		{name}
	</span>

	{#if cached}
		<span class="text-accent font-mono text-[8px] tracking-widest uppercase">cached</span>
	{:else if formattedSize}
		<span class="text-text-muted font-mono text-[8px] tracking-widest">{formattedSize}</span>
	{:else}
		<span class="invisible font-mono text-[8px]">·</span>
	{/if}
</a>
