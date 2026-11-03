import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDir } from '../shared/data-dir.js';
import { describeInstall, installCli, uninstallCli } from './cli-install.js';
import { createUpdater } from './updater.js';

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

// Shown until the app reports that it finished opening. Without it the window
// loads a URL whose handler is still waiting on the corestore, and the user
// stares at the background colour with no idea whether anything is happening.
const BOOT_PAGE =
	'data:text/html;charset=utf-8,' +
	encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>PeerHub</title><style>
	html,body{height:100%;margin:0;background:#05090d;color:#8b98a5;
		font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
		letter-spacing:2.5px;text-transform:uppercase;
		display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px}
	.dot{width:7px;height:7px;border-radius:50%;background:#22d3ee;
		animation:pulse 1.1s ease-in-out infinite}
	@keyframes pulse{0%,100%{opacity:.15;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
</style></head>
<body><span class="dot"></span><span>starting peerhub</span></body></html>`);

// Shown when an installer is about to replace the app on disk.
//
// The process has to exit for that to happen, so this is the last frame the old
// build can paint: saying what is going on beats a window that disappears and a
// desktop that looks like a crash. The boot page is the first frame of the new
// build, so the gap in between is the only part with nothing on screen.
function updatingPage(version) {
	const label = version ? `peerhub ${version}` : 'peerhub';
	return (
		'data:text/html;charset=utf-8,' +
		encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>PeerHub</title><style>
	html,body{height:100%;margin:0;background:#05090d;color:#8b98a5;
		font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
		letter-spacing:2.5px;text-transform:uppercase;
		display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px}
	.ring{width:18px;height:18px;border-radius:50%;border:2px solid #1c333d;
		border-top-color:#22d3ee;animation:spin .9s linear infinite}
	.hint{margin-top:4px;color:#4b5966;font-size:10px;letter-spacing:1.6px}
	@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><span class="ring"></span><span>installing ${label}</span>
<span class="hint">this window closes, then peerhub reopens</span></body></html>`)
	);
}

/** Put the window on the installing page, if there is one to put it on. */
function showUpdating(version) {
	const url = updatingPage(version);
	console.log(`[peerhub] installing ${version ?? 'the update'} — window shows it`);
	if (!win) {
		createWindow(url);
		return;
	}
	// A window the user had hidden should come back for this: it is the only
	// notice that the app is being replaced.
	win.show();
	win.loadURL(url).catch(() => {
		// Superseded by the app closing; nothing to do.
	});
}

async function waitForBoot(url, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`${url}/api/status`);
			const body = await res.json();
			if (body?.booted || body?.error) return body;
		} catch {
			// The server is up before the app is; either may still be opening.
		}
		if (Date.now() > deadline) return { booted: false, error: 'timed out while starting' };
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

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
let updater = null;

// adapter-node derives `url.origin` from the request headers and assumes **https**
// when PROTOCOL_HEADER is unset. Everything here is plain HTTP on loopback, so
// without this SvelteKit believes every request is `https://127.0.0.1:<port>`;
// its CSRF check then rejects every form POST (and every `text/plain` PUT) as
// cross-site. Must be set before `build/handler.js` is imported: the header name
// is read once, at module load.
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
// adapter-node caps a request body at 512KB by default, and a release installer
// is uploaded through this server: without this, the publish refused the body
// halfway through a 144MB transfer. Read once, at handler import, like the
// header name above — 2G is fourteen times today's installer and stays a bound.
process.env.BODY_SIZE_LIMIT = process.env.BODY_SIZE_LIMIT ?? '2G';

app.setName('PeerHub');
// The server bundle has no package.json beside it in a packaged build, and it
// must compare the release manifest against the version that is actually
// running — this is the only place that knows it.
process.env.PEERHUB_VERSION = app.getVersion();

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

// The window is a web page, so the only way it can ask the OS for a folder is
// through these two channels (see preload.js). Both are matched to the app's own
// origin: a page from anywhere else must not be able to open dialogs or shell out.
function trusted(event) {
	const from = event?.senderFrame?.url ?? '';
	try {
		const url = new URL(from);
		if (!origin) return false;
		return url.origin === new URL(origin).origin;
	} catch {
		return false;
	}
}

function registerIpc() {
	ipcMain.handle('peerhub:pick-folder', async (event, title) => {
		if (!trusted(event)) throw new Error('Not allowed');
		const options = {
			// `createDirectory` is what lets the user make the folder from inside
			// the chooser, which is how a clone into a new folder happens.
			properties: ['openDirectory', 'createDirectory'],
			title: typeof title === 'string' && title.trim() ? title.slice(0, 120) : 'Choose a folder'
		};
		const picked = win
			? await dialog.showOpenDialog(win, options)
			: await dialog.showOpenDialog(options);
		return picked.canceled ? null : (picked.filePaths[0] ?? null);
	});

	ipcMain.handle('peerhub:open-path', async (event, target) => {
		if (!trusted(event)) throw new Error('Not allowed');
		if (typeof target !== 'string' || !path.isAbsolute(target)) {
			throw new Error('A folder to open is required');
		}
		// Empty string means it worked; anything else is the OS complaint.
		return shell.openPath(target);
	});
}

function createWindow(url = BOOT_PAGE) {
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
			spellcheck: true,
			preload: path.join(here, 'preload.js')
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

	win.loadURL(url).catch(() => {
		// A navigation that is superseded (boot page -> app) rejects; nothing to do.
	});
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

// Version waiting to be installed, for the Help menu label. The menu is rebuilt
// whenever the updater's state changes, so this stays in step with a check.
function readyVersion() {
	const state = updater?.state;
	return state?.status === 'ready' ? (state.target?.version ?? '') : '';
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
				{ label: 'Check for Updates…', click: () => void updater?.checkNow() },
				{
					label: `Install Update${readyVersion() ? ` ${readyVersion()}` : ''} and Restart`,
					visible: !!readyVersion(),
					click: () => void updater?.applyDownloaded()
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
	registerIpc();
	createWindow();

	// The window is already up on the boot page; swap it for the app once the
	// server says the corestore and its repos are open. A failed boot is reported
	// too, so the window can never sit on a spinner without a reason in the log.
	const status = await waitForBoot(origin);
	if (status.error) console.error(`[peerhub] boot did not complete: ${status.error}`);
	else console.log(`[peerhub] app ready, ${status.repos} repo(s)`);
	win?.loadURL(origin).catch(() => {});

	// Self-update runs in the background of the app it belongs to: the server
	// half finds and verifies a release over the peer network, this half is what
	// can replace the files on disk. Menu labels follow its state.
	if (!devUrl) {
		updater = createUpdater({
			app,
			dialog,
			shell,
			getOrigin: () => origin,
			onChange: () => Menu.setApplicationMenu(buildMenu()),
			// The installer needs this process gone, so the last thing painted here is
			// the "installing" page — not a window that simply vanishes.
			onInstalling: (details) => showUpdating(details?.version)
		});
		updater.start();
	}
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
		// The app is open by the time a window is recreated, so skip the boot page.
		if (BrowserWindow.getAllWindows().length === 0 && origin) createWindow(origin);
	});

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit();
	});

	app.on('will-quit', () => {
		updater?.stop();
		stopServer();
	});
}
