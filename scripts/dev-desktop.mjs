import { spawn } from 'node:child_process';
import process from 'node:process';
import electron from 'electron';

// Development launcher: Vite for the app, Electron for the window.
//
// The window loads the Vite dev server instead of `build/`, so hot reload works
// exactly as before; `desktop/main.js` only starts its own server when
// PEERHUB_DEV_URL is absent.

const PORT = Number(process.env.PORT ?? 5173);
const url = `http://localhost:${PORT}`;

const vite = spawn(
	process.execPath,
	['node_modules/vite/bin/vite.js', 'dev', '--port', String(PORT), '--strictPort'],
	{ stdio: 'inherit' }
);

let child = null;
let closing = false;

function shutdown(code = 0) {
	if (closing) return;
	closing = true;
	child?.kill();
	vite.kill();
	process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForVite() {
	for (let attempt = 0; attempt < 240; attempt++) {
		try {
			const res = await fetch(`${url}/`);
			if (res.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Vite did not answer on ${url}`);
}

try {
	await waitForVite();
} catch (err) {
	console.error(`[desktop:dev] ${err.message}`);
	shutdown(1);
}

console.log(`[desktop:dev] opening ${url}`);

child = spawn(electron, ['desktop/main.js'], {
	stdio: 'inherit',
	env: { ...process.env, PEERHUB_DEV_URL: url }
});

child.on('exit', (code) => shutdown(code ?? 0));
