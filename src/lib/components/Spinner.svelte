<script lang="ts">
	let { size = 12, class: klass = '' }: { size?: number; class?: string } = $props();
</script>

<svg
	class="shrink-0 animate-spin {klass}"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	aria-hidden="true"
>
	<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" opacity="0.25" />
	<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
</svg>
