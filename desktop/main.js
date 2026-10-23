import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDir } from '../shared/data-dir.js';
import { describeInstall, installCli, uninstallCli } from './cli-install.js';

// PeerHub desktop shell.
//
// The SvelteKit server runs *in this process*: adapter-node emits
// `build/handler.js`, we wrap it in a plain node:http server on a random
// loopback port, and the window loads that URL. No sidecar, no second runtime,
// no shell integration — one process tree, one lifecycle.
//
// Everything that touches the peer's identity lives in src/lib/server; this
// file only owns the window, the menu and the server's lifetime. `--smoke`
// boots the server, fetches `/`, prints the result and exits — used by
// `npm run desktop:smoke` and CI.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ICON = path.join(root, 'resources', 'icon.png');
// The CLI reads this to find the running app on its random port.
const ENDPOINT_FILE = path.join(dataDir(), '.cli-url');

const isSmoke = process.argv.includes('--smoke') || process.env.PEERHUB_SMOKE === '1';
// Maintenance flags: install or remove the `ph` command without opening a
// window. Also what an unattended repair (or a test) uses.
const isInstallCli = process.argv.includes('--install-cli');
const isUninstallCli = process.argv.includes('--uninstall-cli');
const devUrl = process.env.PEERHUB_DEV_URL || null;

let server = null;
let win = null;
let origin = null;
let cliInstall = null;

// adapter-node derives `url.origin` from the request headers and assumes **https**
// when PROTOCOL_HEADER is unset. Everything here is plain HTTP on loopback, so
// without this SvelteKit believes every request is `https://127.0.0.1:<port>`;
// its CSRF check then rejects every form POST (and every `text/plain` PUT) as
// cross-site. Must be set before `build/handler.js` is imported: the header name
// is read once, at module load.
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';

app.setName('PeerHub');

// --- server ---------------------------------------------------------------

async function startServer() {
	const { handler } = await import(pathToFileURL(path.join(root, 'build', 'handler.js')).href);

	server = http.createServer((req, res) => {
		// Forced, not defaulted: the loopback server never speaks TLS, and a client
		// must not be able to claim another scheme to shift `url.origin`.
		req.headers['x-forwarded-proto'] = 'http';
		handler(req, res, () => {
			res.statusCode = 404;
			res.end('Not found');
		});
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});

	const address = server.address();
	const port = address && typeof address === 'object' ? address.port : 0;
	if (!port) throw new Error('The HTTP server did not report a port');

	const url = `http://127.0.0.1:${port}`;
	publishEndpoint(url);
	console.log(`[peerhub] serving ${url}`);
	return url;
}

function publishEndpoint(url) {
	try {
		fs.mkdirSync(path.dirname(ENDPOINT_FILE), { recursive: true });
		// URL first, pid second: the CLI ignores a file whose process is gone, so
		// a hard kill (which skips will-quit) cannot leave a stale endpoint behind
		// that shadows the dev-server default.
		fs.writeFileSync(ENDPOINT_FILE, `${url}\n${process.pid}\n`);
	} catch (err) {
		// Not fatal: `peerhub --url <url>` still works.
		console.warn(`[peerhub] could not write ${ENDPOINT_FILE}:`, err?.message ?? err);
	}
}

function unpublishEndpoint() {
	try {
		fs.unlinkSync(ENDPOINT_FILE);
	} catch {
		// Already gone.
	}
}

function stopServer() {
	unpublishEndpoint();
	if (!server) return;
	const closing = server;
	server = null;
	closing.close(() => {});
}

// --- window ---------------------------------------------------------------

function openExternal(url) {
	if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) {
		shell.openExternal(url).catch(() => {});
	}
	// Never let a link replace the app itself; anything else is dropped.
	return { action: 'deny' };
}

function createWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 960,
		minHeight: 600,
		title: 'PeerHub',
		icon: ICON,
		backgroundColor: '#05090d',
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: true
		}
	});

	win.once('ready-to-show', () => win?.show());
	win.on('closed', () => {
		win = null;
	});

	win.webContents.setWindowOpenHandler(({ url }) => openExternal(url));
	win.webContents.on('will-navigate', (event, url) => {
		if (origin && url.startsWith(origin)) return;
		event.preventDefault();
		openExternal(url);
	});

	win.loadURL(origin);
	// DevTools stay closed unless asked for: the View menu toggles them, and
	// PEERHUB_DEVTOOLS=1 opens them on start.
	if (devUrl && process.env.PEERHUB_DEVTOOLS === '1') {
		win.webContents.openDevTools({ mode: 'detach' });
	}
}

async function showCliDialog() {
	cliInstall = cliInstall ?? installCli({ root, version: app.getVersion() });
	const install = cliInstall;
	const where = install.ok
		? install.pathChanged
			? 'Added the shim folder to your user PATH. Open a new terminal to pick it up.'
			: install.pathError
				? `PATH was not changed (${install.pathError}). Add this folder to PATH:\n${install.binDir}`
				: 'Already on PATH. A terminal opened before the install may need a restart.'
		: `Not installed: ${install.error}`;

	const detail = install.ok
		? [
				'Any terminal can drive the running app:',
				'',
				'  ph init                 create a repo for the current folder',
				'  ph status               what changed',
				'  ph commit -m "message"  push changes and record a commit',
				'  ph log                  history',
				'',
				`Shim    ${install.command}`,
				`Folder  ${install.binDir}`,
				'',
				where
			].join('\n')
		: where;

	const { response } = await dialog.showMessageBox({
		type: install.ok ? 'info' : 'error',
		title: 'PeerHub',
		message: 'Terminal access: ph',
		detail,
		buttons: ['OK', install.ok ? 'Reinstall' : 'Try again'],
		defaultId: 0,
		cancelId: 0
	});
	if (response !== 1) return;

	cliInstall = installCli({ root, version: app.getVersion() });
	await dialog.showMessageBox({
		type: cliInstall.ok ? 'info' : 'error',
		title: 'PeerHub',
		message: cliInstall.ok ? 'ph is installed' : 'Could not install ph',
		detail: describeInstall(cliInstall)
	});
}

function buildMenu() {
	const isMac = process.platform === 'darwin';

	return Menu.buildFromTemplate([
		...(isMac ? [{ role: 'appMenu' }] : []),
		{ role: 'fileMenu' },
		{ role: 'editMenu' },
		{
			label: 'View',
			submenu: [
				{ role: 'reload' },
				{ role: 'forceReload' },
				...(devUrl ? [{ role: 'toggleDevTools' }] : []),
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' }
			]
		},
		{ role: 'windowMenu' },
		{
			role: 'help',
			submenu: [
				{
					label: 'About PeerHub',
					click: () =>
						dialog.showMessageBox({
							type: 'info',
							title: 'PeerHub',
							message: `PeerHub ${app.getVersion()}`,
							detail: `Peer-to-peer code hosting.\n\nServing ${origin ?? devUrl ?? 'nothing yet'}`
						})
				},
				{ type: 'separator' },
				{ label: 'Command line tool (ph)', click: showCliDialog }
			]
		}
	]);
}

// --- lifecycle ------------------------------------------------------------

async function boot() {
	if (isUninstallCli) {
		const result = uninstallCli();
		console.log(`[cli] ${describeInstall(result)}`);
		app.exit(result.pathError ? 1 : 0);
		return;
	}

	if (isInstallCli) {
		const result = installCli({ root, version: app.getVersion() });
		console.log(`[cli] ${describeInstall(result)}`);
		app.exit(result.ok ? 0 : 1);
		return;
	}

	if (isSmoke) {
		await runSmoke();
		return;
	}

	origin = devUrl ?? (await startServer());
	// After the server exists: the command is a client, and `.cli-url` must be
	// there before the first terminal asks for it. A failure here must never
	// keep the app from opening.
	cliInstall = installCli({ root, version: app.getVersion() });
	console.log(`[cli] ${describeInstall(cliInstall)}`);
	Menu.setApplicationMenu(buildMenu());
	createWindow();
}

async function runSmoke() {
	try {
		origin = devUrl ?? (await startServer());
		const res = await fetch(`${origin}/`);
		const html = await res.text();
		const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';

		// A GET alone does not prove the app is usable: the CSRF check only runs on
		// mutating requests, and an origin mismatch breaks every form in the UI
		// while the home page still renders. `?/refresh` is a real action that
		// mutates nothing, so this asserts the full POST path is intact.
		const post = await fetch(`${origin}/?/refresh`, {
			method: 'POST',
			headers: {
				origin,
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json'
			},
			body: ''
		});
		const postBody = await post.text();

		console.log(`[smoke] ${res.status} ${origin} title="${title}" bytes=${html.length}`);
		console.log(`[smoke] POST ?/refresh -> ${post.status} ${postBody.slice(0, 120)}`);

		const ok = res.ok && title.includes('PeerHub') && post.status === 200;
		stopServer();
		app.exit(ok ? 0 : 1);
	} catch (err) {
		fail(err);
	}
}

function fail(err) {
	const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
	console.error('[peerhub] failed to start:', message);
	try {
		dialog.showErrorBox('PeerHub failed to start', message);
	} catch {
		// No display (CI, smoke): stderr above is the record.
	}
	app.exit(1);
}

if (!isSmoke && !isInstallCli && !isUninstallCli && !app.requestSingleInstanceLock()) {
	// Corestore allows one writer per data directory, so a second window would
	// only fail on the file lock anyway. Focus the first one instead.
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	});

	app.whenReady().then(boot).catch(fail);

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0 && origin) createWindow();
	});

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit();
	});

	app.on('will-quit', stopServer);
}
