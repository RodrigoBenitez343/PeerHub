// Node runs TypeScript natively (type stripping), but this project writes
// `./x.js` specifiers that only exist as `x.ts` before a build, and uses the
// `$lib/...` alias. Both are resolved here so tests can import the server
// modules as they are written, without a bundler or a test framework.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = ['', '.ts', '.js', '.mjs', '/index.ts', '/index.js'];

function probe(base) {
	for (const suffix of CANDIDATES) {
		const file = base + suffix;
		if (existsSync(file) && statSync(file).isFile()) return file;
	}
	return null;
}

export function resolve(specifier, context, next) {
	// `$lib/foo` and `$lib/server/foo` -> src/lib/...
	if (specifier.startsWith('$lib/')) {
		const file = probe(path.join(ROOT, 'src', 'lib', specifier.slice('$lib/'.length)));
		if (file) return next(pathToFileURL(file).href, context);
	}

	// `./x.js` written for the bundler, present here as `./x.ts`.
	if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
		const url = new URL(specifier, context.parentURL);
		if (!existsSync(fileURLToPath(url))) {
			const file = probe(fileURLToPath(url).replace(/\.js$/, ''));
			if (file) return next(pathToFileURL(file).href, context);
		}
	}

	return next(specifier, context);
}
