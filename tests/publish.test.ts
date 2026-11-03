// Which installer a release manifest names.
//
// `dist/` accumulates every build this machine ever made, so a publish that took
// "all installers" would describe two win32-x64 assets and leave the choice to
// whoever reads the manifest first. One file per platform-arch, the newest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNewest, versionInName } from '../scripts/publish-release.mjs';

function asset(name, mtimeMs = 0, platform = 'win32', arch = 'x64') {
	return { name, mtimeMs, platform, arch, file: `/dist/${name}` };
}

test('the version in the file name decides, not the file time', () => {
	// The old build was touched later; it is still the old build.
	const picked = pickNewest([
		asset('PeerHub Setup 0.1.4.exe', 2000),
		asset('PeerHub Setup 0.1.10.exe', 1000)
	]);
	assert.deepEqual(
		picked.map((entry) => entry.name),
		['PeerHub Setup 0.1.10.exe'],
		'0.1.10 is newer than 0.1.4, numerically'
	);
});

test('the same version falls back to the most recent file', () => {
	const picked = pickNewest([
		asset('PeerHub Setup 0.1.4.exe', 1000),
		asset('PeerHub Setup 0.1.4.exe', 2000)
	]);
	assert.equal(picked.length, 1);
	assert.equal(picked[0].mtimeMs, 2000);
});

test('platforms and architectures are kept apart', () => {
	const picked = pickNewest([
		asset('PeerHub Setup 0.1.4.exe', 1000, 'win32', 'x64'),
		asset('PeerHub-0.1.4.dmg', 1000, 'darwin', 'arm64'),
		asset('PeerHub-0.1.4.AppImage', 1000, 'linux', 'x64'),
		asset('PeerHub Setup 0.1.3.exe', 5000, 'win32', 'x64')
	]);
	assert.deepEqual(picked.map((entry) => `${entry.platform}-${entry.arch}`).sort(), [
		'darwin-arm64',
		'linux-x64',
		'win32-x64'
	]);
});

test('a name with no version is still published, newest first', () => {
	const picked = pickNewest([asset('installer.exe', 1000), asset('installer.exe', 3000)]);
	assert.equal(picked.length, 1);
	assert.equal(picked[0].mtimeMs, 3000);
});

test('an uninstaller left beside the installer is never the release', () => {
	// Same version, newer file: only the name says which one is the product.
	const picked = pickNewest([
		asset('PeerHub Setup 0.1.4.exe', 1000),
		asset('PeerHub Setup 0.1.4.__uninstaller.exe', 2000)
	]);
	assert.deepEqual(
		picked.map((entry) => entry.name),
		['PeerHub Setup 0.1.4.exe']
	);
});

test('the version is read out of electron-builder names, spaces and all', () => {
	assert.deepEqual(versionInName('PeerHub Setup 0.1.3.exe'), [0, 1, 3]);
	assert.deepEqual(versionInName('PeerHub-1.20.4-arm64.dmg'), [1, 20, 4]);
	assert.equal(versionInName('PeerHub.AppImage'), null);
});
