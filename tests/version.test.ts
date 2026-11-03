// Release numbering — the number the updater decides with.
//
// A peer only accepts a release whose version is strictly newer than the one it
// is running, so the build command has to hand out a number nobody has seen.
// These tests pin the arithmetic and the two cases that must not bump: a CI tag
// (the tag is the version) and an explicit version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion, tagVersion } from '../scripts/bump-version.mjs';

test('a release bumps the patch number by default', () => {
	assert.equal(nextVersion('0.1.1', 'patch'), '0.1.2');
	assert.equal(nextVersion('0.1.9', 'patch'), '0.1.10', 'numeric, not string, order');
	assert.equal(nextVersion('9.9.9', 'patch'), '9.9.10');
});

test('minor and major zero what is below them', () => {
	assert.equal(nextVersion('0.1.7', 'minor'), '0.2.0');
	assert.equal(nextVersion('1.4.2', 'major'), '2.0.0');
});

test('a pre-release suffix is dropped, not carried forward', () => {
	// `0.2.0-beta.1` cannot be compared by the updater's ordering, and a release
	// is the finished build: the suffix ends here.
	assert.equal(nextVersion('0.2.0-beta.1', 'patch'), '0.2.1');
	assert.equal(nextVersion('1.0.0-rc.2', 'minor'), '1.1.0');
});

test('a version that is not x.y.z is refused instead of guessed', () => {
	assert.throws(() => nextVersion('1.2', 'patch'), /not x\.y\.z/);
	assert.throws(() => nextVersion('', 'patch'), /not x\.y\.z/);
	assert.throws(() => nextVersion('latest', 'patch'), /not x\.y\.z/);
});

test('a CI tag supplies the version', () => {
	assert.equal(tagVersion('refs/tags/v1.4.0'), '1.4.0');
	assert.equal(tagVersion('v2.0.0'), '2.0.0', 'GITHUB_REF_NAME carries the bare name');
	assert.equal(tagVersion('1.2.3'), '1.2.3');
});

test('anything that is not a version tag means "no version here"', () => {
	assert.equal(tagVersion(undefined), null);
	assert.equal(tagVersion(''), null);
	assert.equal(tagVersion('refs/heads/main'), null);
	assert.equal(tagVersion('refs/heads/v1.2.3-next'), null, 'a branch that starts like a tag');
	assert.equal(tagVersion('v1.2'), null);
	assert.equal(tagVersion('vNext'), null);
});
