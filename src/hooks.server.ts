import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import PeerHubApp from '$lib/server/app.js';
import storage from 'bare-storage';
import path from 'path';
import process from 'process';

let app: any = null;

if (!building && !app) {
	// The data directory keeps its original name on purpose: it holds this peer's
	// corestore identity (`createKeyPair('ghost-drive')`), so renaming it here
	// would look like a brand-new peer and orphan every existing repo.
	const dir = path.join(storage.persistent(), 'ghost-drive');
	console.log('[boot] data dir:', dir);
	const started = Date.now();
	app = new PeerHubApp({ dir });
	console.log('[boot] app constructed, opening…');
	app
		.ready()
		.then(() =>
			console.log(
				`[boot] peerhub ready in ${Date.now() - started}ms, key: ${app.key.toString('hex')}`
			)
		)
		.catch((err: Error) => {
			console.error(`[boot] FAILED after ${Date.now() - started}ms:`, err);
			console.error('[boot] stack:', err?.stack);
		});

	process.on('sveltekit:close', async () => {
		try {
			await app?.close();
		} catch {}
	});
}

export const handle: Handle = ({ event, resolve }) => {
	if (!app) console.warn('[boot] request hit before the app instance existed (building?)');
	else if (!app.opened) {
		console.warn(
			`[boot] request ${event.url.pathname} while still opening (${app.closed ? 'closed' : 'opening'})`
		);
	}
	event.locals.app = app;
	return resolve(event);
};
