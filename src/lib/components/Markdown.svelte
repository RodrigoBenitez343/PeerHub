<script lang="ts">
	// Renders the HTML produced by $lib/markdown and upgrades mermaid fences to
	// diagrams. The parser only emits escaped markup, so the only executable step
	// is the mermaid render below — client side, strict security level, network
	// access off (no remote fonts/icons).
	let { html, class: className = '' }: { html: string; class?: string } = $props();

	let container: HTMLDivElement | undefined = $state();
	let seq = 0;

	// Mermaid's own strict mode already sanitises its output. This is defence in
	// depth and it also avoids an HTML assignment: the SVG is parsed as XML, its
	// script-bearing parts are dropped, and the element is imported as a node.
	function toSvg(markup: string): SVGElement | null {
		const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
		const root = doc.documentElement;
		if (!root || root.nodeName.toLowerCase() !== 'svg') return null;

		for (const node of [...root.querySelectorAll('script')]) node.remove();
		for (const node of [...root.querySelectorAll('*')]) {
			for (const attr of [...node.attributes]) {
				if (/^on/i.test(attr.name) || /javascript:/i.test(attr.value)) {
					node.removeAttribute(attr.name);
				}
			}
		}

		return document.importNode(root, true) as unknown as SVGElement;
	}

	async function renderDiagrams(root: HTMLDivElement, run: number) {
		const nodes = [...root.querySelectorAll<HTMLElement>('pre.md-mermaid')].filter(
			(node) => !node.dataset.rendered
		);
		if (nodes.length === 0) return;

		const mermaid = (await import('mermaid')).default;
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			theme: 'dark',
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
			themeVariables: {
				background: '#0a1118',
				primaryColor: '#101b24',
				primaryTextColor: '#e6f4f8',
				primaryBorderColor: '#155e75',
				lineColor: '#22d3ee',
				secondaryColor: '#152430',
				tertiaryColor: '#0a1118',
				fontSize: '13px'
			}
		});

		for (const node of nodes) {
			if (run !== seq) return;
			const source = node.textContent ?? '';
			node.dataset.rendered = '1';
			try {
				const { svg } = await mermaid.render(`peerhub-mermaid-${run}-${seq++}`, source);
				const element = toSvg(svg);
				if (!element) throw new Error('renderer returned no svg');
				node.replaceChildren(element);
				node.classList.add('md-mermaid--done');
			} catch (err: any) {
				// Loud, not silent: keep the source, say what mermaid objected to.
				node.classList.add('md-mermaid--error');
				const note = document.createElement('p');
				note.className = 'md-mermaid-error';
				note.textContent = `mermaid: ${err?.message ?? String(err)}`;
				node.before(note);
			}
		}
	}

	$effect(() => {
		// Touch the inputs so the effect re-runs when a new document is rendered.
		html;
		const root = container;
		if (!root) return;
		const run = ++seq;
		const frame = requestAnimationFrame(() => void renderDiagrams(root, run));
		return () => cancelAnimationFrame(frame);
	});
</script>

<div bind:this={container} class="md {className}">
	{@html html}
</div>
