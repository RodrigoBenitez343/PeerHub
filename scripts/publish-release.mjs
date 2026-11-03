#!/usr/bin/env node
// Publish built installers into the release repo, so peers can update from it.
//
//   npm run dist
//   npm run publish:release -- --notes "what changed"
//
// The running app does the writing: it owns the repo, so it can stream the
// bytes into the content drive and sign the manifest with the key peers already
// know it by. This script only finds the app, uploads the files and asks for the
// manifest — nothing here opens the corestore.
//
// The version is whatever package.json says, because `npm run dist` just bumped
// it and stamped that number into the installers. Passing a different one is
// refused: a manifest that advertises a version nobody built is how a peer ends
// up downloading the wrong file, or never seeing the update at all.
//
// Assets are taken from --asset (repeatable, `platform-arch=path`) or, when
// omitted, from the newest installer per platform in --dir (default `dist`).
// Arch defaults to the machine running this script, which is right for a release
// built on it. Old installers from earlier builds stay in dist and are skipped.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../shared/data-dir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `publish-release — push a build into the PeerHub release repo

  --version <x.y.z>          version the manifest advertises (default: package.json)
  --notes "..."              changelog shown in the update prompt
  --asset win32-x64=<file>   one installer, repeatable
  --dir <path>               folder to scan when --asset is omitted (default: dist)
  --arch <arch>              arch for scanned assets (default: this machine)
  --url <url>                app URL (default: the running app, else :5173)
  --json                     raw output
`;

class PublishError extends Error {}

function fail(message) {
	// Thrown, never process.exit(): a refused upload can still have a file handle
	// closing inside libuv, and exiting underneath it trips an assertion on
	// Windows (UV_HANDLE_CLOSING, src\win\async.c). This unwinds to the handler at
	// the bottom of the file, which sets the exit code and lets those handles go.
	throw new PublishError(message);
}

function parseArgs(argv) {
	const flags = {
		version: null,
		notes: '',
		assets: [],
		dir: 'dist',
		arch: process.arch,
		url: null,
		json: false
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) fail(`${arg} needs a value\n\n${USAGE}`);
			return value;
		};
		if (arg === '--version') flags.version = next();
		else if (arg === '--notes') flags.notes = next();
		else if (arg === '--asset') flags.assets.push(next());
		else if (arg === '--dir') flags.dir = next();
		else if (arg === '--arch') flags.arch = next();
		else if (arg === '--url') flags.url = next();
		else if (arg === '--json') flags.json = true;
		else if (arg === '--help' || arg === '-h') {
			console.log(USAGE);
			process.exit(0);
		} else fail(`Unknown argument: ${arg}\n\n${USAGE}`);
	}
	return flags;
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === 'EPERM';
	}
}

// Same resolution order as the CLI: explicit flag, env, the app's own endpoint
// file, then the dev server. Kept here rather than shared because the installed
// `ph` command only copies two files out of this tree (desktop/cli-install.js).
function resolveEndpoint(override) {
	if (override) return override;
	if (process.env.PEERHUB_URL) return process.env.PEERHUB_URL;
	const file = path.join(dataDir(), '.cli-url');
	try {
		const [fromApp, pid] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
		if (fromApp) {
			if (pid && !processAlive(Number(pid))) {
				try {
					fs.unlinkSync(file);
				} catch {}
			} else {
				return fromApp;
			}
		}
	} catch {
		// No desktop app running.
	}
	return 'http://localhost:5173';
}

function cliToken() {
	if (process.env.PEERHUB_TOKEN) return process.env.PEERHUB_TOKEN;
	const file = path.join(dataDir(), '.cli-token');
	try {
		return fs.readFileSync(file, 'utf8').trim();
	} catch {
		fail(`No CLI token at ${file}. Start the app once; it writes the token on boot.`);
	}
}

const PLATFORMS = [
	{ suffix: '.exe', platform: 'win32' },
	{ suffix: '.dmg', platform: 'darwin' },
	{ suffix: '.appimage', platform: 'linux' }
];

function inferPlatform(file) {
	const lower = file.toLowerCase();
	const hit = PLATFORMS.find((entry) => lower.endsWith(entry.suffix));
	return hit?.platform ?? null;
}

/** The version electron-builder put in the file name, when it did. */
export function versionInName(file) {
	const hit = /(\d+\.\d+\.\d+)/.exec(file);
	return hit ? hit[1].split('.').map(Number) : null;
}

function newerThan(candidate, best) {
	const a = versionInName(candidate.name);
	const b = best ? versionInName(best.name) : null;
	if (a && b) {
		for (let i = 0; i < 3; i++) {
			if (a[i] !== b[i]) return a[i] > b[i];
		}
		return candidate.mtimeMs > best.mtimeMs;
	}
	return candidate.mtimeMs > (best?.mtimeMs ?? 0);
}

/**
 * One installer per platform-arch: the newest, by version in the name and then by
 * file time. dist/ holds every build this machine ever made, so "all installers"
 * would publish a manifest with two win32-x64 assets and no rule for which one a
 * peer gets.
 */
export function pickNewest(candidates) {
	const best = new Map();
	for (const candidate of candidates) {
		// electron-builder builds the uninstaller beside the installer and normally
		// removes it afterwards. If a build stopped between the two, dist/ holds a
		// signed `….__uninstaller.exe` that is newer, same version and would win
		// this comparison — publishing it would hand every peer an uninstaller.
		if (/\.__uninstaller\.exe$/i.test(candidate.name ?? '')) continue;
		const key = `${candidate.platform}-${candidate.arch}`;
		if (newerThan(candidate, best.get(key))) best.set(key, candidate);
	}
	return [...best.values()];
}

function collectAssets(flags) {
	const out = [];
	if (flags.assets.length > 0) {
		for (const spec of flags.assets) {
			const eq = spec.indexOf('=');
			if (eq === -1) fail(`--asset must be platform-arch=<file>, got "${spec}"`);
			const [platform, arch] = spec.slice(0, eq).split('-');
			const file = path.resolve(spec.slice(eq + 1));
			if (!platform || !arch) fail(`--asset must be platform-arch=<file>, got "${spec}"`);
			out.push({ platform, arch, file });
		}
		return out;
	}

	const dir = path.resolve(flags.dir);
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		fail(`Cannot read ${dir}: ${err.message}. Run \`npm run dist\` first, or pass --asset.`);
	}

	// dist/ keeps every installer ever built here, and the manifest must name one
	// file per platform-arch: the newest, which is the one this run produced.
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const platform = inferPlatform(entry.name);
		if (!platform) continue;
		const file = path.join(dir, entry.name);
		candidates.push({
			platform,
			arch: flags.arch,
			file,
			name: entry.name,
			mtimeMs: fs.statSync(file).mtimeMs
		});
	}
	for (const candidate of pickNewest(candidates)) {
		const { name, mtimeMs, ...asset } = candidate;
		out.push(asset);
	}
	return out;
}

function bytes(value) {
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	if (value >= 1024) return `${Math.round(value / 1024)} KB`;
	return `${value} B`;
}

async function upload(endpoint, token, file, folder) {
	const name = path.basename(file);
	const total = fs.statSync(file).size;
	let sent = 0;

	// A counting pass-through: the request body stays a stream, so a 100MB
	// installer never sits in memory, and progress is real bytes on the wire.
	const source = fs.createReadStream(file);
	const counter = new Transform({
		transform(chunk, _encoding, callback) {
			sent += chunk.length;
			callback(null, chunk);
		}
	});
	const body = source.pipe(counter);

	try {
		const query = `asset=${encodeURIComponent(name)}&folder=${encodeURIComponent(folder)}`;
		const res = await fetch(`${endpoint}/api/updates/publish?${query}`, {
			method: 'POST',
			headers: { 'x-peerhub-token': token, 'content-type': 'application/octet-stream' },
			body: Readable.toWeb(body),
			duplex: 'half'
		});
		const answer = await res.json().catch(() => null);
		if (!answer?.ok)
			throw new PublishError(answer?.error ?? `Upload of ${name} failed (${res.status})`);
		return { ...answer.asset, sent, total };
	} catch (err) {
		if (err instanceof PublishError) throw err;
		// A server that refuses the body mid-stream closes the connection, and
		// fetch reports that as a bare "fetch failed" — the reason is in `cause`.
		const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message;
		throw new PublishError(
			`Upload of ${name} broke off (${cause}). Nothing was written to the repo. ` +
				'The app may refuse bodies this large: builds before 0.1.6 cap them at 512KB.'
		);
	} finally {
		// The server can answer before the file is fully read (a refusal on the
		// first block). Closing both ends here is what lets the process exit
		// without a handle still closing behind it.
		source.destroy();
		counter.destroy();
	}
}

async function main() {
	const flags = parseArgs(process.argv.slice(2));

	// The build already decided the version; the manifest only reports it. Anything
	// else means the files on disk are not the release being advertised.
	const built = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
	if (flags.version && flags.version !== built) {
		fail(
			`--version ${flags.version} does not match package.json ${built}.\n` +
				`Run \`npm run dist\` to build ${flags.version}, or publish ${built} without --version.`
		);
	}
	flags.version = built;

	const endpoint = resolveEndpoint(flags.url).replace(/\/+$/, '');
	const token = cliToken();
	const assets = collectAssets(flags);
	if (assets.length === 0) fail(`No installers found in ${path.resolve(flags.dir)}`);

	// The folder this runs in decides the repo: publishing from a repo's own
	// directory belongs to that repo, not to a store repo with the same name.
	const folder = process.cwd();

	// Fail before uploading: an unwritable repo is the usual reason this runs at
	// all, and finding out after a 100MB transfer wastes the wait.
	const healthRes = await fetch(
		`${endpoint}/api/updates/publish?folder=${encodeURIComponent(folder)}`,
		{
			headers: { 'x-peerhub-token': token }
		}
	).catch((err) => fail(`Cannot reach PeerHub at ${endpoint}: ${err.message}`));
	// `message` is what a 401 from a SvelteKit error() carries; `error` is this
	// route's own shape. Either is more useful than the status alone.
	const health = await healthRes.json().catch(() => null);
	if (!health?.ok) {
		fail(health?.error ?? health?.message ?? `PeerHub refused the request (${healthRes.status})`);
	}

	// Checked before the first byte goes out: a mirror is read-only, and finding
	// that out after a 144MB transfer wastes the wait for nothing.
	if (health.repo && !health.writable) {
		fail(
			`"${health.repo.name}" is a mirror of another peer's repo — only its owner can publish.\n` +
				`Open the publisher's own repo, or change the release repo name on the Updates page.`
		);
	}
	console.log(
		health.repo
			? `release repo: ${health.repo.name}` +
					(health.folder ? ` — ${health.folder}` : '') +
					` (${health.repo.id})`
			: `release repo: ${health.settings.repo} — created by this upload`
	);

	const published = [];
	for (const asset of assets) {
		const name = path.basename(asset.file);
		console.log(`uploading ${name} (${bytes(fs.statSync(asset.file).size)})…`);
		const stored = await upload(endpoint, token, asset.file, folder);
		console.log(`  -> ${stored.path} sha256 ${stored.sha256.slice(0, 16)}…`);
		published.push({ platform: asset.platform, arch: asset.arch, name });
	}

	const res = await fetch(`${endpoint}/api/updates/publish`, {
		method: 'POST',
		headers: { 'x-peerhub-token': token, 'content-type': 'application/json' },
		body: JSON.stringify({
			version: flags.version,
			notes: flags.notes,
			assets: published,
			folder
		})
	});
	const body = await res.json().catch(() => null);
	if (!body?.ok) fail(body?.error ?? `Publishing the manifest failed (${res.status})`);

	if (flags.json) {
		console.log(JSON.stringify(body.release, null, 2));
		return;
	}
	console.log(
		`published ${body.release.version} — ${body.release.assets.length} file(s), signed by the app's key`
	);
	console.log(
		'peers will see it on their next check; anyone who downloads it also serves it to the rest'
	);
}

// Guarded so the tests can import the selection helpers without this file trying
// to reach for a running app.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(err instanceof PublishError ? err.message : (err?.stack ?? String(err)));
		process.exitCode = 1;
		// Last resort for a socket that would otherwise keep the loop alive: an
		// unref'd timer never holds the process open on its own.
		setTimeout(() => process.exit(1), 500).unref();
	});
}
