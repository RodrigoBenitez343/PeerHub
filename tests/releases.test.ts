// The release store inside a repo: which paths belong to it, and when a folder
// is nothing but the store.
//
// These decide what the repo's Files and Code tabs show. Getting them wrong in
// the permissive direction puts a folder of installers in front of the source;
// getting them wrong in the strict direction hides a repo's real `release/`
// folder, so both directions are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MANIFEST_FILE,
	RELEASE_VERSIONS_DIR,
	isReleaseStorePath,
	isReservedRepoPath,
	isStoreOnlyFolder
} from '../src/lib/server/paths.ts';

test('the manifest, its assets and the version snapshots are the store', () => {
	assert.equal(isReleaseStorePath('/release/channel.json'), true);
	assert.equal(isReleaseStorePath(MANIFEST_FILE), true);
	assert.equal(isReleaseStorePath('/release/assets/PeerHub Setup 0.1.7.exe'), true);
	assert.equal(isReleaseStorePath('/release/assets'), true);
	assert.equal(isReleaseStorePath(`${RELEASE_VERSIONS_DIR}/0.1.7.json`), true);
	assert.equal(isReleaseStorePath(RELEASE_VERSIONS_DIR), true);
});

test('a repo that keeps its own release/ folder keeps it', () => {
	assert.equal(isReleaseStorePath('/release/notes.md'), false);
	assert.equal(isReleaseStorePath('/release'), false);
	assert.equal(isReleaseStorePath('/docs/release/channel.json'), false);
	assert.equal(isReleaseStorePath('/releases/assets/x.exe'), false);
});

test('leading and trailing slashes do not change what a store path is', () => {
	assert.equal(isReleaseStorePath('release/channel.json'), true);
	assert.equal(isReleaseStorePath('/release/assets/'), true);
	assert.equal(isReleaseStorePath('/release/assets/sub/x.exe'), true);
});

test('reserved paths cover the store as well as .peerhub', () => {
	assert.equal(isReservedRepoPath('/.peerhub/history/main/x'), true);
	assert.equal(isReservedRepoPath('/release/assets/x.exe'), true);
	assert.equal(isReservedRepoPath('/release/notes.md'), false);
	assert.equal(isReservedRepoPath('/src/index.ts'), false);
});

test('a folder is hidden only when everything in it is the store', () => {
	assert.equal(isStoreOnlyFolder('/release', ['assets', 'versions', 'channel.json']), true);
	assert.equal(isStoreOnlyFolder('/release', ['assets', 'release-notes.md']), false);
	assert.equal(isStoreOnlyFolder('/docs', ['channel.json']), false);
	assert.equal(isStoreOnlyFolder('/release', []), false, 'an empty folder is not the store');
});
