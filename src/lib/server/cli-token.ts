import fs from 'fs';
import path from 'path';

// A local-only secret so the CLI endpoint cannot be driven by a web page the
// user happens to have open. The token sits in the data directory (outside the
// repo) and `bin/peerhub.mjs` reads the same file; a browser cannot read it.
//
// It is a guard against cross-origin misuse of the local server, not a security
// boundary against a local attacker — anyone who can read the file can already
// read the whole corestore.

const TOKEN_FILE = '.cli-token';

export function cliTokenPath(dir: string): string {
	return path.join(dir, TOKEN_FILE);
}

export function ensureCliToken(dir: string): string {
	const file = cliTokenPath(dir);

	try {
		const existing = fs.readFileSync(file, 'utf8').trim();
		if (existing.length >= 32) return existing;
	} catch {
		// Missing or unreadable: mint a new one.
	}

	const token = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
		''
	);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, token + '\n', { mode: 0o600 });
	} catch (err: any) {
		// The app still runs; the CLI just cannot authenticate. Say so instead of
		// pretending the token exists.
		console.warn(`[cli] could not write ${file}: ${err?.message ?? err}`);
		return token;
	}

	return token;
}
