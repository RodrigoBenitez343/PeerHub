// Tiny Markdown renderer for README/file previews. No dependency, no raw HTML:
// everything is escaped first, then a small set of constructs is converted, so
// a repo can never inject markup into the app shell.

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function safeHref(raw: string): string | null {
	const href = raw.trim();
	if (/^(https?:|mailto:)/i.test(href)) return href;
	if (href.startsWith('/') || href.startsWith('#') || href.startsWith('./')) return href;
	return null;
}

function inline(text: string): string {
	let out = escapeHtml(text);

	// `code` first: its content must not be touched by the other rules.
	const codes: string[] = [];
	out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
		codes.push(`<code class="md-code">${code}</code>`);
		return `\u0000${codes.length - 1}\u0000`;
	});

	out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) => {
		const href = safeHref(src);
		return href ? `<img class="md-img" src="${href}" alt="${alt}" loading="lazy" />` : m;
	});

	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
		const safe = safeHref(href);
		if (!safe) return m;
		const external = /^https?:/i.test(safe) ? ' target="_blank" rel="noreferrer noopener"' : '';
		return `<a class="md-link" href="${safe}"${external}>${label}</a>`;
	});

	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
	out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
	out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

	out = out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codes[Number(index)] ?? '');
	return out;
}

function isTableDivider(line: string): boolean {
	return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const html: string[] = [];

	let i = 0;
	let paragraph: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		html.push(`<p>${inline(paragraph.join(' '))}</p>`);
		paragraph = [];
	};

	while (i < lines.length) {
		const line = lines[i];

		// fenced code
		const fence = line.match(/^\s*```(\w*)\s*$/);
		if (fence) {
			flushParagraph();
			const lang = fence[1] || '';
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			i++; // closing fence
			html.push(
				`<pre class="md-pre"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`
			);
			continue;
		}

		// headings
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushParagraph();
			const level = heading[1].length;
			html.push(`<h${level} class="md-h md-h${level}">${inline(heading[2].trim())}</h${level}>`);
			i++;
			continue;
		}

		// horizontal rule
		if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
			flushParagraph();
			html.push('<hr class="md-hr" />');
			i++;
			continue;
		}

		// table (header row + divider row)
		if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
			flushParagraph();
			const split = (row: string) =>
				row
					.replace(/^\s*\|/, '')
					.replace(/\|\s*$/, '')
					.split('|')
					.map((cell) => cell.trim());
			const head = split(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].includes('|')) {
				rows.push(split(lines[i]));
				i++;
			}
			html.push(
				'<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
					head.map((cell) => `<th>${inline(cell)}</th>`).join('') +
					'</tr></thead><tbody>' +
					rows
						.map((row) => '<tr>' + row.map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>')
						.join('') +
					'</tbody></table></div>'
			);
			continue;
		}

		// blockquote
		if (/^\s*>\s?/.test(line)) {
			flushParagraph();
			const body: string[] = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
				body.push(lines[i].replace(/^\s*>\s?/, ''));
				i++;
			}
			html.push(`<blockquote class="md-quote">${inline(body.join(' '))}</blockquote>`);
			continue;
		}

		// lists (single level, nesting by indentation groups)
		if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
			flushParagraph();
			const ordered = /^\s*\d+\.\s+/.test(line);
			const items: string[] = [];
			while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
				i++;
			}
			const tag = ordered ? 'ol' : 'ul';
			html.push(
				`<${tag} class="md-list">` +
					items.map((item) => `<li>${inline(item)}</li>`).join('') +
					`</${tag}>`
			);
			continue;
		}

		// blank line closes a paragraph
		if (!line.trim()) {
			flushParagraph();
			i++;
			continue;
		}

		paragraph.push(line.trim());
		i++;
	}

	flushParagraph();
	return html.join('\n');
}
