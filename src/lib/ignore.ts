// .gitignore parsing and matching, shared by the server (upload guard) and the
// client (skip before sending bytes). Implements the subset that matters for
// uploads: comments, negation, directory-only rules, anchoring, `*`/`?`/`**`,
// nested .gitignore files (each rule is relative to its file's directory) and
// last-match-wins.
//
// Deliberately not covered: escaped leading `!`/`#`, `[a-z]` classes, and
// trailing-space escaping. Those are rare in practice and would add a lot of
// parser surface for an upload filter.

export interface IgnoreSource {
	base: string; // directory that contains the .gitignore, '/' for the repo root
	text: string;
}

interface Rule {
	base: string;
	regex: RegExp;
	negate: boolean;
	pattern: string;
}

export interface IgnoreMatcher {
	ignored(path: string): boolean;
	rules: number;
}

// `.git` is metadata, never repo content — at any depth.
function isGitDir(path: string): boolean {
	return path.split('/').includes('.git');
}

function escapeRegex(input: string): string {
	return input.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
}

function globToRegex(glob: string): string {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			const isDouble = glob[i + 1] === '*';
			if (isDouble) {
				const atStart = i === 0 || glob[i - 1] === '/';
				const followedBySlash = glob[i + 2] === '/';
				if (atStart && followedBySlash) {
					out += '(?:.*/)?'; // `**/` — any number of directories
					i += 2;
					continue;
				}
				out += '.*'; // trailing or embedded `**`
				i += 1;
				continue;
			}
			out += '[^/]*';
			continue;
		}
		if (ch === '?') {
			out += '[^/]';
			continue;
		}
		out += escapeRegex(ch);
	}
	return out;
}

function compileSource(source: IgnoreSource): Rule[] {
	const base = source.base === '/' ? '' : source.base.replace(/\/+$/, '');
	const rules: Rule[] = [];

	for (const rawLine of source.text.replace(/\r\n?/g, '\n').split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		const negate = line.startsWith('!');
		let body = negate ? line.slice(1).trim() : line;
		if (!body) continue;

		// `\#` / `\!` escapes: drop the backslash so the literal is matched.
		if (body.startsWith('\\')) body = body.slice(1);

		const anchored = body.startsWith('/');
		if (anchored) body = body.slice(1);

		// `dir/` means "a directory with this name". The trailing slash is not a
		// path separator, so strip it before deciding whether the pattern is
		// anchored to a path or matched against basenames.
		body = body.replace(/\/+$/, '');
		if (!body) continue;

		const hasSlash = body.includes('/');
		const glob = globToRegex(body);
		const prefix = base ? escapeRegex(base) + '/' : '/';

		// A rule that matches a directory also matches everything beneath it, so
		// every pattern gets an optional `/…` suffix.
		const regex = new RegExp(
			anchored || hasSlash ? `^${prefix}${glob}(?:/.*)?$` : `^${prefix}(?:.*/)?${glob}(?:/.*)?$`
		);

		rules.push({ base: source.base, regex, negate, pattern: line });
	}

	return rules;
}

function normalize(path: string): string {
	let out = path.startsWith('/') ? path : '/' + path;
	out = out.replace(/\/{2,}/g, '/');
	if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
	return out;
}

export function compileIgnore(sources: IgnoreSource[]): IgnoreMatcher {
	// Parent .gitignore files first, deeper ones after, so a nested file can
	// override its parent — the order git applies them in.
	const ordered = [...sources].sort((a, b) => a.base.length - b.base.length);
	const rules = ordered.flatMap(compileSource);

	return {
		rules: rules.length,
		ignored(path: string): boolean {
			const target = normalize(path);
			if (isGitDir(target)) return true;

			let ignored = false;
			for (const rule of rules) {
				if (!rule.regex.test(target)) continue;
				ignored = !rule.negate;
			}
			return ignored;
		}
	};
}

export interface PickedFile {
	name: string;
	webkitRelativePath?: string;
}

// Path of a picked file relative to the upload root. Folder picks carry the
// folder's own name as the first segment; `stripRootFolder` removes it so the
// contents land where the folder was picked from.
export function pickedRelPath(file: PickedFile, stripRootFolder = false): string {
	const rel = (file.webkitRelativePath || file.name).replace(/^\/+/, '');
	if (!stripRootFolder) return rel;
	const slash = rel.indexOf('/');
	return slash === -1 ? file.name : rel.slice(slash + 1);
}

// Decides what a folder/file pick actually uploads.
//
// The repo's own .gitignore files (already stored) are not enough: a fresh
// project folder carries its own .gitignore, and those files are not in the
// repo yet when the filter runs. So the picked files are read first and their
// .gitignore contents are compiled together with the repo's rules — otherwise
// `node_modules/` from the folder being uploaded would sail straight through.
//
// `stripRootFolder` is for folder picks: the picked directory is the repo (or
// the current directory), not a directory *inside* it, so its own name is
// dropped from every path. Picking `my-project` gives `/README.md`, not
// `/my-project/README.md` — the same thing `git init` in that folder produces.
//
// The returned list puts .gitignore files first, shallowest first, so the
// server-side guard in `PUT /api/files` also has the rules before the bytes
// that they exclude arrive.
export async function planUpload<T extends PickedFile>(
	files: T[],
	dirPath: string,
	repoSources: IgnoreSource[],
	readText: (file: T) => Promise<string>,
	options: { stripRootFolder?: boolean } = {}
): Promise<{ send: T[]; skipped: number; rules: number }> {
	const inRoot = dirPath === '/' || dirPath === '';
	const relOf = (file: T) => pickedRelPath(file, options.stripRootFolder);
	const fullOf = (rel: string) => (inRoot ? `/${rel}` : `${dirPath}/${rel}`);

	const entries = files.map((file) => ({ file, rel: relOf(file) }));

	const sources = [...repoSources];
	for (const { file, rel } of entries) {
		if (!rel.endsWith('.gitignore')) continue;
		const slash = rel.lastIndexOf('/');
		const dir = slash === -1 ? '' : rel.slice(0, slash);
		// Rules in a nested .gitignore are relative to the directory holding it.
		const base = (inRoot ? `/${dir}` : `${dirPath}/${dir}`).replace(/\/+$/, '') || '/';
		sources.push({ base, text: await readText(file) });
	}

	const matcher = compileIgnore(sources);
	const send: T[] = [];
	let skipped = 0;

	for (const { file, rel } of entries) {
		const path = fullOf(rel);
		// The ignore file itself is always kept: the server allows it too, and
		// dropping it would silently disable filtering for every later upload.
		if (path.endsWith('/.gitignore') || matcher.ignored(path) === false) {
			send.push(file);
			continue;
		}
		skipped++;
	}

	const depth = (file: T) => relOf(file).split('/').length;
	send.sort((a, b) => {
		const aIgnore = relOf(a).endsWith('.gitignore') ? 0 : 1;
		const bIgnore = relOf(b).endsWith('.gitignore') ? 0 : 1;
		if (aIgnore !== bIgnore) return aIgnore - bIgnore;
		return aIgnore === 0 ? depth(a) - depth(b) : 0;
	});

	return { send, skipped, rules: matcher.rules };
}
