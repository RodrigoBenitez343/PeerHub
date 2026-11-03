import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bump the release version, before packaging.
//
// The updater compares the version in a release manifest with the version that is
// running and ignores anything that is not strictly newer, so every release has to
// carry a number nobody is running yet. Doing it here — inside the build command,
// before electron-builder reads package.json — is what makes the installer name,
// the running app's version and the manifest agree.
//
//   npm run dist                     patch bump, e.g. 0.1.1 -> 0.1.2
//   node scripts/bump-version.mjs --minor
//   node scripts/bump-version.mjs --major
//   node scripts/bump-version.mjs --set 2.0.0
//
// Two cases must not bump:
//   * a CI tag build (`v1.2.3`) — the tag is the version, or the artifact would
//     disagree with its own name;
//   * PEERHUB_NO_BUMP=1 — a rebuild for testing that is not meant to look like a
//     release to anyone.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/;

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value, indent) {
	fs.writeFileSync(file, JSON.stringify(value, null, indent) + '\n');
}

/** `v1.2.3` from a CI tag, or null. */
export function tagVersion(ref) {
	if (!ref) return null;
	const name = ref.replace(/^refs\/tags\//, '');
	return SEMVER.test(name.replace(/^v/, '')) ? name.replace(/^v/, '') : null;
}

export function nextVersion(current, mode) {
	const match = SEMVER.exec(current);
	if (!match) throw new Error(`package.json version "${current}" is not x.y.z`);
	const [major, minor, patch] = match.slice(1).map(Number);
	// A pre-release suffix (`0.2.0-beta.1`) is dropped: packaging a release means
	// the plain version, and the updater orders those cleanly.
	if (mode === 'major') return `${major + 1}.0.0`;
	if (mode === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function main() {
	const args = process.argv.slice(2);
	const explicit = args.includes('--set') ? args[args.indexOf('--set') + 1] : null;
	const mode = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch';

	const pkg = readJson(PKG);
	const current = String(pkg.version ?? '');
	const tagged = tagVersion(process.env.GITHUB_REF_NAME) ?? tagVersion(process.env.GITHUB_REF);
	const skip = process.env.PEERHUB_NO_BUMP === '1';

	let next;
	if (explicit) {
		if (!SEMVER.test(explicit) || explicit !== explicit.trim()) {
			throw new Error(`--set needs a version like 1.2.3, got "${explicit}"`);
		}
		next = explicit;
	} else if (skip) {
		console.log(`version ${current} (kept: PEERHUB_NO_BUMP=1)`);
		return;
	} else if (tagged) {
		// CI builds a tag: the version comes from the tag and is never bumped.
		next = tagged;
	} else {
		next = nextVersion(current, mode);
	}

	if (next === current) {
		console.log(`version ${current} (unchanged)`);
		return;
	}
	if (SEMVER.test(current) && SEMVER.test(next)) {
		const [a, b] = [current, next].map((v) => v.split('.').map(Number));
		if (
			b[0] < a[0] ||
			(b[0] === a[0] && b[1] < a[1]) ||
			(b[0] === a[0] && b[1] === a[1] && b[2] < a[2])
		) {
			console.warn(`[version] going backwards: ${current} -> ${next}`);
		}
	}

	pkg.version = next;
	writeJson(PKG, pkg, '\t');

	// The lock records the root version too; left stale it describes a project
	// that does not exist. It is gitignored here, but npm reads it.
	if (fs.existsSync(LOCK)) {
		try {
			const lock = readJson(LOCK);
			lock.version = next;
			if (lock.packages && lock.packages['']) lock.packages[''].version = next;
			writeJson(LOCK, lock, 2);
		} catch (err) {
			console.warn(`[version] package-lock.json left alone: ${err.message}`);
		}
	}

	console.log(`version ${current} -> ${next}`);
}

// Guarded: tests import the two pure helpers above without this file trying to
// rewrite package.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (err) {
		console.error(`[version] ${err.message}`);
		process.exit(1);
	}
}
