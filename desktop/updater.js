import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// Self-update, desktop half.
//
// The server owns everything that needs the peer network: it finds the release
// repo, verifies the signed manifest, downloads the installer through the
// content drive and checks its digest. This file owns the part a browser tab
// cannot do — replacing the app on disk — because that only works from the
// process that is actually running out of the install folder.
//
// The shell never trusts a path it did not see verified: `state.target.file` is
// only set once the digest matched, and every install re-checks the file exists.
//
// Applying:
//   Windows  electron-builder's NSIS installer understands `--updated` (skip the
//            pages, keep user data) and `--force-run` (start the app again when
//            it is done). It also waits for the running app to exit, so the
//            sequence is: spawn detached, ask the shell to quit.
//   Linux    An AppImage is a single file: write the new one beside it, rename
//            over the old path, chmod, relaunch.
//   macOS    A dmg cannot be applied in place without elevation, so it is opened
//            for the user to drop onto Applications.

const FIRST_DELAY_MS = 12_000;
// This process is the only one that can install, and the Updates page can only
// ask it to. So the shell looks at the server every couple of seconds: a click
// that waits half an hour to be noticed is what "the button does nothing" looks
// like. The look is a local GET; the network check below is what is expensive,
// and it has its own gap.
const TICK_MS = 2_000;
const CHECK_GAP_MS = 5 * 60_000;
// Long enough to read the line and to see the spinner, before the window closes
// for the installer. The install itself then takes a few seconds with nothing of
// ours on screen; that part cannot be covered from this process.
const INSTALL_LEAD_MS = 2_000;

function sha256(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(file);
		stream.on('error', reject);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

/**
 * Whether a tick should spend a real check (a peer round trip) or only read the
 * state. A release download that already failed must not be retried every tick,
 * so this gap is what keeps the fast poll cheap.
 */
export function checkDue(state, intervalMs = CHECK_GAP_MS, now = Date.now()) {
	if (!state) return true;
	if (state.settings && state.settings.autoCheck === false) return false;
	if (!state.checkedAt) return true;
	return now - state.checkedAt >= intervalMs;
}

export function createUpdater({
	app,
	dialog,
	shell,
	getOrigin,
	onChange,
	/** Called just before this process exits to let the installer run. */
	onInstalling,
	intervalMs = CHECK_GAP_MS,
	firstDelayMs = FIRST_DELAY_MS
}) {
	let timer = null;
	let running = false;
	let stopped = false;
	let state = null;
	let signature = '';

	/** The menu is rebuilt only when what it says would change. */
	function emit() {
		const next = state
			? [
					state.version,
					state.status,
					state.target?.version,
					state.error,
					state.installRequested,
					state.repo?.name,
					state.repo?.peers
				].join('|')
			: '';
		if (next === signature) return;
		signature = next;
		onChange?.(state);
	}

	async function call(action) {
		const origin = getOrigin();
		if (!origin) throw new Error('PeerHub is not serving yet');
		const res = await fetch(`${origin}/api/updates`, {
			method: action ? 'POST' : 'GET',
			headers: action ? { 'content-type': 'application/json' } : undefined,
			body: action ? JSON.stringify({ action }) : undefined
		});
		const body = await res.json().catch(() => null);
		if (!body?.ok) throw new Error(body?.error ?? `Update service answered ${res.status}`);
		state = body.state;
		return state;
	}

	async function run({ interactive = false } = {}) {
		if (stopped || running) return state;
		running = true;
		try {
			state = await call(null);
			if (!state) return state;

			// A request that was queued from the Updates page: act on it before
			// anything else, so a click is not delayed by a fresh network check.
			if (state.installRequested) return await install({ quiet: true });

			let fresh = false;
			if (interactive || checkDue(state, intervalMs)) {
				state = await call('check');
				fresh = true;
			}

			// Only what a *fresh* check found is downloaded: re-running the poll while a
			// release waits for a click must not retry a download that already failed.
			if (fresh && state.status === 'available' && state.settings.autoDownload) {
				state = await call('download');
				// The download runs on the server; wait for it to settle before
				// deciding whether there is something to install.
				state = await waitForDownload();
			}

			if (state.status === 'ready' && (interactive || state.settings.autoInstall)) {
				if (interactive) {
					const choice = await dialog.showMessageBox({
						type: 'question',
						title: 'PeerHub',
						message: `PeerHub ${state.target?.version} is downloaded and verified`,
						detail: [state.target?.notes, '', 'Install it now? PeerHub will restart.']
							.filter(Boolean)
							.join('\n'),
						buttons: ['Install and restart', 'Later'],
						defaultId: 0,
						cancelId: 1
					});
					if (choice.response !== 0) return state;
				}
				await install({ quiet: !interactive });
			} else if (interactive) {
				await describe(state);
			}
			return state;
		} catch (err) {
			if (interactive) {
				dialog.showErrorBox('PeerHub update', err?.message ?? String(err));
			} else {
				console.warn('[updater]', err?.message ?? err);
			}
			return state;
		} finally {
			running = false;
			emit();
		}
	}

	async function waitForDownload() {
		const deadline = Date.now() + 30 * 60_000;
		let current = state;
		while (current?.status === 'downloading' && Date.now() < deadline) {
			await delay(1500);
			if (stopped) return current;
			current = await call(null);
		}
		return current;
	}

	async function describe(current) {
		if (current.status === 'current') {
			await dialog.showMessageBox({
				type: 'info',
				title: 'PeerHub',
				message: `PeerHub ${current.version} is the newest release`,
				detail: current.repo
					? `Release repo: ${current.repo.name} (${current.repo.peers} peer${current.repo.peers === 1 ? '' : 's'} connected)`
					: `No release repo named "${current.settings.repo}" is reachable.`
			});
			return;
		}
		if (current.status === 'ready') {
			await install({ quiet: false });
			return;
		}
		if (current.status === 'available') {
			await dialog.showMessageBox({
				type: 'info',
				title: 'PeerHub',
				message: `PeerHub ${current.target?.version} is available`,
				detail: current.target?.notes || 'Open Updates to download it.'
			});
			return;
		}
		if (current.error) {
			dialog.showErrorBox('PeerHub update', current.error);
		}
	}

	async function install({ quiet = false } = {}) {
		const current = state;
		const file = current?.target?.file;
		const label = current?.target?.version ?? 'the update';
		const fail = (message) => {
			if (quiet) console.warn('[updater]', message);
			else dialog.showErrorBox('PeerHub update', message);
			return current;
		};

		if (!current?.canInstall) return fail('This build cannot install updates in place');
		if (!file || !fs.existsSync(file)) return fail('The downloaded update is no longer on disk');

		// The digest is re-checked here, not only where it was downloaded: a file
		// found on disk (a reused copy) is not evidence that its bytes are the ones
		// the signed manifest described.
		const digest = await sha256(file).catch((err) => err);
		if (digest instanceof Error) return fail(`Could not read the update: ${digest.message}`);
		if (digest !== current.target.asset.sha256) {
			return fail(`The update file does not match its signature (${digest.slice(0, 12)}…)`);
		}

		// Consumed before anything is spawned: a failure below must not leave the
		// request pending, or every later poll would try again.
		await call('installed').catch(() => {});
		stopped = true;

		try {
			if (process.platform === 'win32' && file.toLowerCase().endsWith('.exe')) {
				// On screen before the window goes away: the install takes a few seconds
				// with no window of ours, and this is the only notice the user gets.
				onInstalling?.({ version: label, platform: process.platform });
				await delay(INSTALL_LEAD_MS);
				const child = spawn(file, ['--updated', '/S', '--force-run'], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true
				});
				child.on('error', (err) => console.error('[updater] installer failed:', err));
				child.unref();
				// Give the installer a moment to take the log file handle before the
				// app tears its own process down.
				await delay(400);
				app.quit();
				return current;
			}

			if (process.platform === 'linux' && process.env.APPIMAGE) {
				onInstalling?.({ version: label, platform: process.platform });
				await delay(INSTALL_LEAD_MS);
				const target = process.env.APPIMAGE;
				const staged = `${target}.new`;
				fs.copyFileSync(file, staged);
				fs.chmodSync(staged, 0o755);
				fs.renameSync(staged, target);
				const child = spawn(target, [], { detached: true, stdio: 'ignore' });
				child.unref();
				app.quit();
				return current;
			}

			// macOS and anything unrecognised: hand it to the OS. The user finishes
			// the drag-to-Applications step themselves.
			await shell.openPath(file);
			dialog.showMessageBox({
				type: 'info',
				title: 'PeerHub',
				message: `PeerHub ${label} is ready to install`,
				detail: `The installer was opened. PeerHub ${current.version} keeps running until you replace it.`
			});
			stopped = false;
			return current;
		} catch (err) {
			stopped = false;
			return fail(err?.message ?? String(err));
		}
	}

	function delay(ms) {
		return new Promise((resolve) => {
			const t = setTimeout(resolve, ms);
			t.unref?.();
		});
	}

	function schedule(ms) {
		if (stopped) return;
		timer = setTimeout(async () => {
			timer = null;
			await run();
			if (!stopped) schedule(TICK_MS);
		}, ms);
		timer.unref?.();
	}

	return {
		start() {
			schedule(firstDelayMs);
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		/** Called by the menu; returns the state it ended on. */
		checkNow() {
			return run({ interactive: true });
		},
		/** Install what the last check downloaded and verified. */
		applyDownloaded() {
			return install({ quiet: false });
		},
		/** State from the last poll, for the menu labels. */
		get state() {
			return state;
		}
	};
}
