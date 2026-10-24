// Markdown renderer: the injection boundary first, then the constructs the
// preview and README pages actually render. A passing test here means the
// output string is safe to hand to `{@html}` — nothing more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, resolveRepoPath } from '../src/lib/markdown.ts';

test('raw HTML is escaped instead of passed through', () => {
	const html = renderMarkdown('<script>alert(1)</script>');
	assert.ok(!html.includes('<script'), 'a repo README must never emit a script tag');
	assert.ok(html.includes('&lt;script&gt;'));
});

test('a quote in link text or alt text cannot break out of an attribute', () => {
	const html = renderMarkdown('![x" onerror="alert(1)](pic.png)', {
		imageHref: () => '/api/files/pic.png'
	});
	assert.ok(!html.includes('onerror="'), `attribute escape: ${html}`);
	assert.ok(html.includes('<img'));
});

test('javascript:, data: and file: targets are refused, the label survives', () => {
	for (const target of [
		'javascript:alert(1)',
		'data:text/html;base64,PHNjcmlwdD4=',
		'file:///etc/passwd'
	]) {
		const html = renderMarkdown(`[label](${target})`, { linkHref: () => '/mapped' });
		assert.ok(!/href="(javascript|data|file):/i.test(html), `${target} must not become a link`);
		assert.ok(html.includes('label'), 'the text is kept, only the link is dropped');
	}
});

test('only http(s) and mailto count as safe absolute targets', () => {
	const ok = renderMarkdown('[a](https://example.com/x) [b](mailto:x@example.com)');
	assert.ok(ok.includes('href="https://example.com/x"'));
	assert.ok(ok.includes('href="mailto:x@example.com"'));

	// A scheme we did not allow, even a harmless-looking one, must not be linkified.
	const mixed = renderMarkdown('[a](ftp://example.com/x)');
	assert.ok(!mixed.includes('<a '), mixed);
});

test('external links get target and rel, anchors do not', () => {
	const external = renderMarkdown('[site](https://example.com/a?b=1)');
	assert.ok(external.includes('target="_blank"'));
	assert.ok(external.includes('rel="noreferrer noopener"'));

	const anchor = renderMarkdown('[top](#install)');
	assert.ok(anchor.includes('href="#install"'));
	assert.ok(!anchor.includes('target="_blank"'));
});

test('relative links keep the href as written when no mapper is given', () => {
	const html = renderMarkdown('[a](docs/x.md)', { baseDir: '/docs' });
	assert.ok(html.includes('href="docs/x.md"'), html);
});

test('a link mapper receives a repo-absolute path, not the raw href', () => {
	const seen: Array<[string, string]> = [];
	const html = renderMarkdown('[a](../src/x.ts?plain=1#L3)', {
		baseDir: '/docs',
		linkHref: (repoPath, raw) => {
			seen.push([repoPath, raw]);
			return `/drive/1/code${repoPath}`;
		}
	});
	assert.deepEqual(seen, [['/src/x.ts', '../src/x.ts?plain=1#L3']]);
	assert.ok(html.includes('href="/drive/1/code/src/x.ts"'), html);
});

test('a mapper that refuses drops the link and keeps the label', () => {
	const html = renderMarkdown('[a](../../etc/passwd)', {
		baseDir: '/docs',
		linkHref: () => null
	});
	assert.ok(!html.includes('<a '), html);
	assert.ok(html.includes('a'));
	// The escaped path must not leak through as text either: the label is all that stays.
	assert.ok(!html.includes('etc/passwd'));
});

test('images use the image mapper, are lazy and carry a title', () => {
	const html = renderMarkdown('![alt *x*](img/pic.png "the title")', {
		baseDir: '/docs',
		imageHref: (repoPath) => `/api/files/1${repoPath}`
	});
	assert.ok(html.includes('<img class="md-img" src="/api/files/1/docs/img/pic.png"'), html);
	assert.ok(html.includes('alt="alt *x*"'), 'alt text is not inline-rendered, it is an attribute');
	assert.ok(html.includes('title="the title"'));
	assert.ok(html.includes('loading="lazy"'));
});

test('an image the mapper refuses is dropped, not shown with a raw src', () => {
	const html = renderMarkdown('![a](javascript:alert(1))', {
		imageHref: () => '/mapped'
	});
	assert.ok(!html.includes('<img'), html);
	assert.ok(!html.includes('src="javascript:'));
});

test('resolveRepoPath clamps at the repo root and strips query and hash', () => {
	assert.equal(resolveRepoPath('/docs', 'x.md'), '/docs/x.md');
	assert.equal(resolveRepoPath('/docs', '../x.md'), '/x.md');
	assert.equal(resolveRepoPath('/docs', '../../x.md'), null, 'escaping the root is not a path');
	assert.equal(resolveRepoPath('/docs', '/abs/x.md'), '/abs/x.md');
	assert.equal(resolveRepoPath('/docs', 'a/../b.md'), '/docs/b.md');
	assert.equal(resolveRepoPath('/docs', './a.md#frag'), '/docs/a.md');
	assert.equal(resolveRepoPath('/docs', 'a.md?plain=1'), '/docs/a.md');
	assert.equal(resolveRepoPath('/docs', 'a\\b.md'), '/docs/a/b.md');
	assert.equal(resolveRepoPath('/docs', ''), null);
	assert.equal(resolveRepoPath('/docs', '#top'), null);
});

test('inline code is escaped and isolated from emphasis', () => {
	const html = renderMarkdown('use `a *b* <c>` here');
	assert.ok(html.includes('<code class="md-code">a *b* &lt;c&gt;</code>'), html);
	assert.ok(!html.includes('<em>'), 'emphasis must not reach inside inline code');
});

test('emphasis never rewrites inside an href or an alt attribute', () => {
	const link = renderMarkdown('[x](https://e.com/a**b**c)');
	assert.ok(link.includes('href="https://e.com/a**b**c"'), link);
	assert.ok(!link.includes('<strong>b</strong>'));

	const image = renderMarkdown('![alt *x*](img/pic.png)', {
		imageHref: () => '/api/files/pic.png'
	});
	assert.ok(image.includes('alt="alt *x*"'), image);
	assert.ok(!image.includes('alt="alt <em>'), 'a rendered tag must not be re-parsed');
});

test('a link label still gets emphasis, and an image can sit inside a link', () => {
	const label = renderMarkdown('[**bold** text](https://e.com)');
	assert.ok(label.includes('><strong>bold</strong> text</a>'), label);

	const nested = renderMarkdown('[![a](p.png)](https://e.com)', {
		imageHref: () => '/api/files/p.png'
	});
	assert.ok(nested.includes('<a class="md-link" href="https://e.com"'), nested);
	assert.ok(nested.includes('<img class="md-img" src="/api/files/p.png"'), nested);
});

test('a fenced block with a language becomes a pre with data-lang', () => {
	const html = renderMarkdown('```js\nconst a = 1;\n<script>alert(1)</script>\n```');
	assert.ok(html.includes('<pre class="md-pre"><code data-lang="js">'), html);
	assert.ok(html.includes('&lt;script&gt;'), 'code is escaped, not executed');
	assert.ok(!html.includes('<script>'));
	assert.ok(html.includes('const a = 1;\n'), 'line breaks inside code survive');
});

test('a fence closes only on its own marker and unclosed fences swallow the rest', () => {
	const tilde = renderMarkdown('~~~\na\n~~~');
	assert.ok(tilde.includes('<pre class="md-pre"><code>'), tilde);
	assert.ok(tilde.includes('a'));

	const mismatched = renderMarkdown('```\na\n~~~\nb\n```');
	assert.ok(mismatched.includes('~~~'), 'a tilde run does not close a backtick fence');

	const unclosed = renderMarkdown('```\na\n\nb');
	assert.ok(unclosed.includes('<pre class="md-pre">'), unclosed);
	assert.ok(
		unclosed.includes('b'),
		'an unclosed fence consumes to EOF instead of dropping content'
	);
});

test('mermaid gets its own holder so the client can replace it', () => {
	const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
	assert.ok(html.includes('<pre class="md-mermaid"><code>'), html);
	assert.ok(!html.includes('md-pre'));
});

test('headings, horizontal rules and paragraph joining', () => {
	const html = renderMarkdown('# one\n\nline a\nline b\n\n---');
	assert.ok(html.includes('<h1 class="md-h md-h1">one</h1>'));
	assert.ok(html.includes('<p>line a line b</p>'), 'soft wraps join with a space');
	assert.ok(html.includes('<hr class="md-hr" />'));
});

test('lists nest and keep ordered and unordered items separate', () => {
	const ul = renderMarkdown('- a\n  - b\n- c');
	assert.ok(ul.includes('<ul class="md-list">'), ul);
	assert.ok(/<li>a<ul class="md-list"><li>b<\/li><\/ul><\/li>/.test(ul), ul);
	assert.ok(ul.includes('<li>c</li>'));

	const ol = renderMarkdown('1. one\n2. two');
	assert.ok(ol.startsWith('<ol class="md-list">'), ol);
	assert.equal((ol.match(/<li>/g) ?? []).length, 2);
});

test('task items become disabled checkboxes', () => {
	const html = renderMarkdown('- [x] done\n- [ ] todo');
	assert.ok(html.includes('<input type="checkbox" class="md-task" disabled checked /> done'), html);
	assert.ok(html.includes('<input type="checkbox" class="md-task" disabled /> todo'), html);
});

test('tables align cells and render inline markup inside them', () => {
	const html = renderMarkdown('| a | b | c |\n|:--|:-:|--:|\n| **x** | `y` | z |');
	assert.ok(html.includes('<thead>'), html);
	assert.ok(html.includes('<th style="text-align:left">a</th>'), html);
	assert.ok(html.includes('<th style="text-align:center">b</th>'));
	assert.ok(html.includes('<th style="text-align:right">c</th>'));
	assert.ok(html.includes('<td style="text-align:left"><strong>x</strong></td>'), html);
	assert.ok(html.includes('<td style="text-align:center"><code class="md-code">y</code></td>'));
});

test('a table ends at a heading that contains a pipe', () => {
	const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n## head | tail');
	assert.ok(html.includes('<h2 class="md-h md-h2">head | tail</h2>'), html);
});

test('blockquotes join their lines', () => {
	const html = renderMarkdown('> one\n> two\n\nafter');
	assert.ok(html.includes('<blockquote class="md-quote">one two</blockquote>'), html);
	assert.ok(html.includes('<p>after</p>'));
});

test('CRLF input renders the same as LF', () => {
	const source = '# h\n\n- a\n- b\n';
	assert.equal(renderMarkdown(source.replace(/\n/g, '\r\n')), renderMarkdown(source));
});
