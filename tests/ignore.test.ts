// .gitignore semantics — the rule set that decides what a folder sync uploads.
//
// Written against git's documented behaviour, not against the implementation:
// where the two disagree the assertion stays as git defines it, so the
// disagreement shows up as a failure instead of being papered over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileIgnore, pickedRelPath, planUpload, type IgnoreSource } from '../src/lib/ignore.ts';

function matcher(...rules: string[]) {
	return compileIgnore([{ base: '/', text: rules.join('\n') }]);
}

test('an empty rule set ignores nothing but .git', () => {
	const m = matcher();
	assert.equal(m.rules, 0);
	assert.equal(m.ignored('/README.md'), false);
	assert.equal(m.ignored('/.git/config'), true);
	assert.equal(m.ignored('/src/.git/HEAD'), true, '.git is metadata at any depth');
});

test('a bare name matches at any depth', () => {
	const m = matcher('node_modules/');
	assert.equal(m.ignored('/node_modules/x.js'), true);
	assert.equal(m.ignored('/packages/app/node_modules/x.js'), true);
	assert.equal(m.ignored('/node_modules.txt'), false, 'the pattern must not match a prefix');
});

test('*.log matches files in subdirectories', () => {
	const m = matcher('*.log');
	assert.equal(m.ignored('/a.log'), true);
	assert.equal(m.ignored('/logs/deep/b.log'), true);
	assert.equal(m.ignored('/a.log.txt'), false);
});

test('a leading slash anchors the pattern to the root', () => {
	const m = matcher('/dist');
	assert.equal(m.ignored('/dist'), true);
	assert.equal(m.ignored('/dist/bundle.js'), true);
	assert.equal(
		m.ignored('/packages/dist/bundle.js'),
		false,
		'anchored rules must not match deeper'
	);
});

test('a pattern containing a slash is anchored', () => {
	const m = matcher('src/generated');
	assert.equal(m.ignored('/src/generated/x.ts'), true);
	assert.equal(m.ignored('/app/src/generated/x.ts'), false);
});

test('negation re-includes a file that an earlier rule matched', () => {
	const m = matcher('*.log', '!important.log');
	assert.equal(m.ignored('/debug.log'), true);
	assert.equal(m.ignored('/important.log'), false);
	assert.equal(
		m.ignored('/logs/important.log'),
		false,
		'negation matches at the same depth as the rule'
	);
});

test('the last matching rule wins, also across nested files', () => {
	const m = compileIgnore([
		{ base: '/', text: '*.md' },
		{ base: '/docs', text: '!kept.md' }
	]);
	assert.equal(m.ignored('/README.md'), true);
	assert.equal(m.ignored('/docs/kept.md'), false);
	assert.equal(
		m.ignored('/other/kept.md'),
		true,
		'a nested rule only applies below its own directory'
	);
});

test('**/ matches any number of leading directories', () => {
	const m = matcher('**/temp');
	assert.equal(m.ignored('/temp'), true);
	assert.equal(m.ignored('/a/temp'), true);
	assert.equal(m.ignored('/a/b/temp'), true);
});

test('a middle ** spans directories', () => {
	const m = matcher('a/**/b');
	assert.equal(m.ignored('/a/b'), true);
	assert.equal(m.ignored('/a/x/b'), true);
	assert.equal(m.ignored('/a/x/y/b'), true);
	assert.equal(m.ignored('/x/a/b'), false);
});

test('? matches exactly one character and never a slash', () => {
	const m = matcher('file?.txt');
	assert.equal(m.ignored('/file1.txt'), true);
	assert.equal(m.ignored('/file12.txt'), false);
	assert.equal(m.ignored('/dir/file1.txt'), true);
});

test('comments and blank lines are not rules', () => {
	const m = matcher('# a comment', '', '   ', '#!not-a-rule');
	assert.equal(m.rules, 0);
});

test('an escaped leading ! or # is a literal pattern', () => {
	const m = matcher('\\!important', '\\#notes');
	assert.equal(m.ignored('/!important'), true);
	assert.equal(m.ignored('/#notes'), true);
});

test('a directory-only pattern does not ignore a file of the same name', () => {
	// git: "logs/" matches a directory; a plain file called "logs" must upload.
	const m = matcher('logs/');
	assert.equal(m.ignored('/logs/app.log'), true);
	assert.equal(
		m.ignored('/logs'),
		false,
		'a file named logs is not a directory and must not be ignored'
	);
});

test('a file cannot be re-included from inside an excluded directory', () => {
	// git: "It is not possible to re-include a file if a parent directory of
	// that file is excluded." Otherwise `build/` plus `!build/keep.md` silently
	// uploads a build artefact.
	const m = matcher('build/', '!build/keep.md');
	assert.equal(m.ignored('/build/keep.md'), true);
});

test('escaped trailing spaces are part of the pattern', () => {
	// git strips trailing spaces unless they are escaped with a backslash.
	const m = matcher('foo\\ ');
	assert.equal(m.ignored('/foo '), true);
	assert.equal(m.ignored('/foo'), false);
});

test('CRLF line endings parse the same as LF', () => {
	const m = compileIgnore([{ base: '/', text: 'a\r\nb\r\n' }]);
	assert.equal(m.rules, 2);
	assert.equal(m.ignored('/a'), true);
	assert.equal(m.ignored('/b'), true);
});

// --- upload planning -------------------------------------------------------

type Picked = { name: string; webkitRelativePath?: string };

function pick(path: string): Picked {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return { name, webkitRelativePath: path };
}

async function plan(
	files: Picked[],
	options: { dir?: string; sources?: IgnoreSource[]; text?: string; strip?: boolean } = {}
) {
	return planUpload(
		files,
		options.dir ?? '/',
		options.sources ?? [],
		async () => options.text ?? '',
		{
			stripRootFolder: options.strip ?? false
		}
	);
}

test('planUpload drops ignored files and reports the count', async () => {
	const files = [pick('x/README.md'), pick('x/node_modules/a.js'), pick('x/package.json')];
	const result = await plan(files, {
		sources: [{ base: '/', text: 'node_modules/' }],
		strip: true
	});

	assert.deepEqual(
		result.send.map((file) => file.name),
		['README.md', 'package.json']
	);
	assert.equal(result.skipped, 1);
});

test('planUpload keeps the .gitignore itself and sends it first', async () => {
	const files = [pick('x/src/a.ts'), pick('x/.gitignore'), pick('x/docs/.gitignore')];
	const result = await plan(files, { text: 'dist/', strip: true });

	assert.deepEqual(
		result.send.map((file) => file.webkitRelativePath),
		['x/.gitignore', 'x/docs/.gitignore', 'x/src/a.ts']
	);
});

test('planUpload applies rules from the picked folder’s own .gitignore', async () => {
	// The point of reading the picked files first: on a first upload the repo has
	// no .gitignore yet, and node_modules would otherwise sail through.
	const files = [pick('x/.gitignore'), pick('x/node_modules/a.js'), pick('x/src/a.ts')];
	const result = await plan(files, { text: 'node_modules/', strip: true });

	assert.deepEqual(
		result.send.map((file) => file.name),
		['.gitignore', 'a.ts']
	);
	assert.equal(result.rules, 1);
});

test('planUpload resolves a nested .gitignore relative to its own directory', async () => {
	const files = [pick('x/build/.gitignore'), pick('x/build/keep.txt'), pick('x/build/bundle.js')];
	const result = await plan(files, { text: '*.js', strip: true });

	assert.deepEqual(
		result.send.map((file) => file.name),
		['.gitignore', 'keep.txt']
	);
});

test('planUpload places files under the requested subdirectory', async () => {
	// Uploading into /docs: a rule written as "drafts/" must hit /docs/drafts/a.md.
	const files = [pick('a.md'), pick('drafts/b.md')];
	const result = await plan(files, { dir: '/docs', sources: [{ base: '/docs', text: 'drafts/' }] });

	assert.deepEqual(
		result.send.map((file) => file.name),
		['a.md']
	);
});

test('pickedRelPath handles a file without a relative path and root stripping', () => {
	assert.equal(pickedRelPath({ name: 'a.txt' }), 'a.txt');
	assert.equal(pickedRelPath({ name: 'a.txt', webkitRelativePath: 'proj/a.txt' }, true), 'a.txt');
	assert.equal(
		pickedRelPath({ name: 'a.txt', webkitRelativePath: 'proj/a.txt' }, false),
		'proj/a.txt'
	);
	assert.equal(pickedRelPath({ name: 'proj' }), 'proj');
});
