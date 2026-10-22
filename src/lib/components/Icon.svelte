<script lang="ts">
	import { ICONS, type IconName } from '$lib/icons';

	let {
		name,
		size = 20,
		stroke = 1.7,
		class: className = ''
	}: { name: IconName; size?: number; stroke?: number; class?: string } = $props();
</script>

<svg
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	class="shrink-0 {className}"
	aria-hidden="true"
>
	{@html ICONS[name] ?? ''}
</svg>
