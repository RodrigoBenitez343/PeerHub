// Markdown renderer for READMEs and file previews. No dependency for parsing,
// no raw HTML: everything is escaped first, then a fixed set of constructs is
// converted, so a repo can never inject markup into the app shell.
//
// Supported: ATX headings, paragraphs, emphasis/strong/strike, inline code,
// fenced code (with a language tag), images, links, autolinks, ordered and
// unordered lists with nesting and task checkboxes, tables, blockquotes,
// horizontal rules.
//
// Not supported on purpose: raw HTML blocks, footnotes, reference-style links,
// setext headings. If a README needs them, the escape-first design would have to
// go, which is not worth the injection surface for a preview.
//
// Mermaid is emitted as `<pre class="md-mermaid">` and rendered on the client by
// `Markdown.svelte`; the parser never executes anything.

export interface MarkdownOptions {
	/** Directory of the source file, so relative links resolve from the right place. */
	baseDir?: string;
	/** Map a repo path to a URL for `<img src>`. Return null to drop the image. */
	imageHref?: (repoPath: string) => string | null;
	/** Map a repo path (plus the original href) to a URL for `<a href>`. */
	linkHref?: (repoPath: string, raw: string) => string | null;
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const SAFE_ABSOLUTE = /^(https?:|mailto:)/i;

// Turn a relative reference into a repo-absolute path, or null when it escapes
// the repo root (a link to ../../etc is not something we should invent a URL for).
export function resolveRepoPath(baseDir: string, target: string): string | null {
	const clean = target.replace(/\\/g, '/').split('#')[0].split('?')[0];
	if (!clean) return null;
	const start = clean.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
	const segments = clean.startsWith('/') ? [] : start;
	for (const part of clean.replace(/^\//, '').split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	return '/' + segments.join('/');
}

interface Target {
	href: string | null;
	external: boolean;
	label: string;
}

function resolveTarget(raw: string, opts: MarkdownOptions, kind: 'image' | 'link'): Target {
	const href = raw.trim();
	const external = SAFE_ABSOLUTE.test(href);

	if (external) return { href, external: true, label: href };

	// Anchors stay on the page; only an in-page reference is allowed through.
	if (href.startsWith('#')) return { href, external: false, label: href };

	// Anything with another scheme (javascript:, data:, file:) is refused.
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { href: null, external: false, label: href };

	const repoPath = resolveRepoPath(opts.baseDir ?? '/', href);
	if (!repoPath) return { href: null, external: false, label: href };

	const mapped =
		kind === 'image'
			? (opts.imageHref?.(repoPath) ?? null)
			: (opts.linkHref?.(repoPath, href) ?? null);

	// Relative and no mapper: keep the reference as written (preview pages do this).
	if (!mapped && !opts.imageHref && !opts.linkHref) {
		return {
			href: href.startsWith('/') || href.startsWith('./') ? href : href,
			external: false,
			label: href
		};
	}

	return { href: mapped, external: false, label: href };
}

function emphasize(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/__([^_]+)__/g, '<strong>$1</strong>')
		.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
		.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
		.replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

// Placeholders hold finished HTML until the end, so emphasis cannot reach into
// an href or an alt attribute. Tags nest (an image inside a link), so restoring
// loops until no placeholder is left.
function restore(text: string, marker: string, values: string[]): string {
	for (let pass = 0; pass < 8 && text.includes(marker); pass++) {
		text = text.replace(new RegExp(`${marker}(\\d+)${marker}`, 'g'), (_m, index: string) => {
			return values[Number(index)] ?? '';
		});
	}
	return text;
}

function inline(text: string, opts: MarkdownOptions = {}): string {
	let out = escapeHtml(text);

	// Inline code first: its content must not be touched by the other rules.
	const codes: string[] = [];
	out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
		codes.push(`<code class="md-code">${code}</code>`);
		return `\u0000${codes.length - 1}\u0000`;
	});

	const tags: string[] = [];
	const stash = (html: string) => `\u0001${tags.push(html) - 1}\u0001`;

	// ![alt](src "title")
	out = out.replace(
		/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
		(m, alt: string, src: string, title: string | undefined) => {
			const target = resolveTarget(src, opts, 'image');
			if (!target.href) return m;
			const titleAttr = title ? ` title="${title}"` : '';
			return stash(
				`<img class="md-img" src="${target.href}" alt="${alt}"${titleAttr} loading="lazy" />`
			);
		}
	);

	// [label](href "title") — runs after images, so [![alt](src)](href) nests.
	out = out.replace(
		/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
		(m, label: string, href: string) => {
			const target = resolveTarget(href, opts, 'link');
			if (!target.href) return emphasize(label);
			const external = target.external ? ' target="_blank" rel="noreferrer noopener"' : '';
			return stash(`<a class="md-link" href="${target.href}"${external}>${emphasize(label)}</a>`);
		}
	);

	// <https://example.com>
	out = out.replace(/&lt;((?:https?:|mailto:)[^\s&]+)&gt;/gi, (_m, href: string) => {
		return stash(
			`<a class="md-link" href="${href}" target="_blank" rel="noreferrer noopener">${href}</a>`
		);
	});

	out = restore(emphasize(out), '\u0001', tags);
	out = out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codes[Number(index)] ?? '');
	return out;
}

function isTableDivider(line: string): boolean {
	return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

// A table row is any line with a pipe, but a heading or a fence that happens to
// contain one starts a new block instead of extending the table.
function startsBlock(line: string): boolean {
	return (
		/^(#{1,6}\s|>\s?|\s*([-*+]|\d+\.)\s+)/.test(line) ||
		/^\s*(`{3,}|~{3,})/.test(line) ||
		/^\s*([-*_])\1{2,}\s*$/.test(line)
	);
}

const LIST_ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

function isFence(line: string): RegExpMatchArray | null {
	return line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
}

interface ListResult {
	html: string;
	next: number;
}

function parseList(lines: string[], start: number, opts: MarkdownOptions): ListResult {
	const first = lines[start].match(LIST_ITEM)!;
	const baseIndent = first[1].length;
	const ordered = /^\d+\./.test(first[2]);
	const items: string[] = [];

	let i = start;
	while (i < lines.length) {
		const match = lines[i].match(LIST_ITEM);
		if (!match) break;

		const indent = match[1].length;
		if (indent < baseIndent) break;
		if (/^\d+\./.test(match[2]) !== ordered) break;

		if (indent > baseIndent) {
			// Deeper marker: belongs to the previous item as a nested list.
			const nested = parseList(lines, i, opts);
			if (items.length > 0) items[items.length - 1] += nested.html;
			i = nested.next;
			continue;
		}

		let body = match[3];
		const task = body.match(/^\[([ xX])\]\s+(.*)$/);
		if (task) {
			const checked = task[1].trim() ? ' checked' : '';
			body = `<input type="checkbox" class="md-task" disabled${checked} /> ${inline(task[2], opts)}`;
		} else {
			body = inline(body, opts);
		}

		i++;

		// Continuation lines of the same item (indented, not a new marker).
		while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && !isFence(lines[i])) {
			const continuation = lines[i];
			if (!/^\s{2,}/.test(continuation)) break;
			body += ' ' + inline(continuation.trim(), opts);
			i++;
		}

		items.push(body);
	}

	const tag = ordered ? 'ol' : 'ul';
	return {
		html: `<${tag} class="md-list">${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`,
		next: i
	};
}

export function renderMarkdown(source: string, opts: MarkdownOptions = {}): string {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const html: string[] = [];

	let i = 0;
	let paragraph: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		html.push(`<p>${inline(paragraph.join(' '), opts)}</p>`);
		paragraph = [];
	};

	while (i < lines.length) {
		const line = lines[i];

		// fenced code
		const fence = isFence(line);
		if (fence) {
			flushParagraph();
			const marker = fence[1];
			const lang = (fence[2] || '').toLowerCase();
			const body: string[] = [];
			i++;
			while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			i++; // closing fence
			const code = escapeHtml(body.join('\n'));
			if (lang === 'mermaid') {
				// Rendered by Markdown.svelte; the source stays visible if that fails.
				html.push(`<pre class="md-mermaid"><code>${code}</code></pre>`);
			} else {
				html.push(
					`<pre class="md-pre"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${code}</code></pre>`
				);
			}
			continue;
		}

		// headings
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushParagraph();
			const level = heading[1].length;
			html.push(
				`<h${level} class="md-h md-h${level}">${inline(heading[2].trim(), opts)}</h${level}>`
			);
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
			const align = split(lines[i + 1]).map((cell) => {
				const left = cell.startsWith(':');
				const right = cell.endsWith(':');
				if (left && right) return 'center';
				if (right) return 'right';
				if (left) return 'left';
				return '';
			});
			const cell = (tag: 'th' | 'td', text: string, index: number) => {
				const style = align[index] ? ` style="text-align:${align[index]}"` : '';
				return `<${tag}${style}>${inline(text, opts)}</${tag}>`;
			};
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].includes('|') && !startsBlock(lines[i])) {
				rows.push(split(lines[i]));
				i++;
			}
			html.push(
				'<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
					head.map((text, index) => cell('th', text, index)).join('') +
					'</tr></thead><tbody>' +
					rows
						.map(
							(row) => '<tr>' + row.map((text, index) => cell('td', text, index)).join('') + '</tr>'
						)
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
			html.push(`<blockquote class="md-quote">${inline(body.join(' '), opts)}</blockquote>`);
			continue;
		}

		// lists, with nesting and task checkboxes
		if (LIST_ITEM.test(line)) {
			flushParagraph();
			const list = parseList(lines, i, opts);
			html.push(list.html);
			i = list.next;
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
