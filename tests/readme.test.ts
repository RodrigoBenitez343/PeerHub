// README loading: which file wins, and where its relative links point. The
// mapping matters because a wrong route is a dead link in every repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReadme, markdownOptions } from '../src/lib/server/readme.ts';
import { memoryDrive } from './helpers.ts';

const session = () => memoryDrive('test-repo').session;

test('README.md wins over the other accepted names', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/README.txt', Buffer.from('# txt'));
	memory.write('/readme.markdown', Buffer.from('# markdown'));
	memory.write('/README.md', Buffer.from('# md'));

	const view = await loadReadme(memory.session);
	assert.equal(view!.path, '/README.md');
	assert.ok(view!.html.includes('<h1 class="md-h md-h1">md</h1>'));
});

test('readme.txt is accepted when it is the only one', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/readme.txt', Buffer.from('plain *text*'));
	const view = await loadReadme(memory.session);
	assert.equal(view!.path, '/readme.txt');
	assert.ok(view!.html.includes('<em>text</em>'));
});

test('a README in a subdirectory is not the repo README', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/docs/README.md', Buffer.from('# inner'));
	assert.equal(await loadReadme(memory.session), null);
});

test('no README, or an unreadable manifest, is null rather than an error', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/a.txt', Buffer.from('x'));
	assert.equal(await loadReadme(memory.session), null);

	memory.drive.manifestShared = async () => {
		throw new Error('offline');
	};
	assert.equal(await loadReadme(memory.session), null);
});

test('a binary README is skipped in favour of the next text candidate', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/README.md', Buffer.from([0, 1, 2, 3]));
	memory.write('/README.txt', Buffer.from('fallback'));

	const view = await loadReadme(memory.session);
	assert.equal(view!.path, '/README.txt', 'a NUL byte means the preview has no text');
	assert.ok(view!.html.includes('fallback'));
});

test('an unreadable first candidate falls through to the next one', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/README.txt', Buffer.from('second'));
	// Listed but missing from the drive: previewFile throws and the loop moves on.
	const manifest = [
		{ path: '/README.md', size: 1, mtime: 0 },
		{ path: '/README.txt', size: 6, mtime: 0 }
	];
	const view = await loadReadme(memory.session, manifest);
	assert.equal(view!.path, '/README.txt');
});

test('README content is escaped like any other markdown', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/README.md', Buffer.from('<img src=x onerror=alert(1)>'));
	const view = await loadReadme(memory.session);
	assert.ok(!view!.html.includes('<img src=x'), view!.html);
	assert.ok(view!.html.includes('&lt;img src=x'));
});

test('images are served from the files API with an encoded repo path', () => {
	const opts = markdownOptions(session(), '/');
	assert.equal(opts.imageHref!('/logo.png'), '/api/files/test-repo/logo.png');
	assert.equal(
		opts.imageHref!('/assets/a b.png'),
		'/api/files/test-repo/assets/a%20b.png',
		'a space must be encoded or the route 404s'
	);
});

test('markdown links go to the code page with dir and path', () => {
	const opts = markdownOptions(session(), '/docs');
	const href = opts.linkHref!('/docs/guide.md', 'guide.md#install')!;
	const url = new URL(href, 'http://localhost');
	assert.equal(url.pathname, '/drive/test-repo/code');
	assert.equal(url.searchParams.get('dir'), '/docs');
	assert.equal(url.searchParams.get('path'), '/docs/guide.md');
	assert.equal(url.hash, '#install', 'the in-page anchor has to survive the rewrite');
});

test('a link to a markdown file elsewhere keeps its own directory', () => {
	const opts = markdownOptions(session(), '/docs');
	const href = opts.linkHref!('/notes.md', '../notes.md')!;
	const url = new URL(href, 'http://localhost');
	assert.equal(url.pathname, '/drive/test-repo/code');
	assert.equal(url.searchParams.get('dir'), '/');
	assert.equal(url.searchParams.get('path'), '/notes.md');
});

test('other files go to the preview page, extensionless ones to the listing', () => {
	const opts = markdownOptions(session(), '/');
	const file = new URL(opts.linkHref!('/src/main.ts', 'src/main.ts')!, 'http://x');
	assert.equal(file.pathname, '/drive/test-repo/preview');
	assert.equal(file.searchParams.get('file'), '/src/main.ts');

	const dir = new URL(opts.linkHref!('/src', 'src')!, 'http://x');
	assert.equal(dir.pathname, '/drive/test-repo');
	assert.equal(dir.searchParams.get('path'), '/src');

	const hidden = new URL(opts.linkHref!('/.gitignore', '.gitignore')!, 'http://x');
	assert.equal(hidden.pathname, '/drive/test-repo', 'a dotfile is not a file preview');
});

test('an escape attempt never produces a link', async () => {
	const memory = memoryDrive('test-repo');
	memory.write('/README.md', Buffer.from('[out](../../etc/passwd)'));
	const view = await loadReadme(memory.session);
	assert.ok(!view!.html.includes('<a '), view!.html);
	assert.ok(view!.html.includes('out'));
});
