import os from 'node:os';
import path from 'node:path';

// Where this peer keeps its identity, repositories and caches.
//
// Shared by the SvelteKit server (src/lib/server/data-dir.ts re-exports it),
// the Electron shell and the terminal CLI, so all three agree by construction.
//
// The folder is `ghost-drive` on purpose, whatever the product is called now:
// it holds the corestore keypair (`createKeyPair('ghost-drive')`) and every
// Hyperdrive core name, so renaming it would look like a brand-new peer and
// orphan existing repos. Branding lives in desktop/, not here.
//
// PEERHUB_DATA_DIR wins (tests, portable installs), then the platform
// convention.
const APP_DIR = 'ghost-drive';

export function dataDir() {
	const override = process.env.PEERHUB_DATA_DIR;
	if (override) return path.resolve(override);

	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, APP_DIR);
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR);
	}
	const share = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
	return path.join(share, APP_DIR);
}
