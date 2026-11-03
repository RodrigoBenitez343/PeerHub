// The release manifest and the version ordering an updater lives by. Both are
// pure functions on purpose: a signature scheme that only works end to end is
// the kind of thing that silently stops verifying after a refactor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crypto_sign_keypair } from 'sodium-native';

import {
	RELEASE_FORMAT,
	assetFor,
	compareVersions,
	payloadBytes,
	runningVersion,
	signRelease,
	verifyRelease,
	type ReleasePayload
} from '../src/lib/server/updates.ts';

// A fresh ed25519 pair per call: the point of the refusal test below is two
// identities that really are different.
function keyPair() {
	const publicKey = Buffer.alloc(32);
	const secretKey = Buffer.alloc(64);
	crypto_sign_keypair(publicKey, secretKey);
	return { publicKey, secretKey };
}

function release(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
	return {
		format: RELEASE_FORMAT,
		version: '0.2.0',
		notes: 'faster sync',
		publishedAt: 1_700_000_000_000,
		assets: [
			{
				platform: 'win32',
				arch: 'x64',
				path: '/release/assets/PeerHub-Setup-0.2.0.exe',
				name: 'PeerHub-Setup-0.2.0.exe',
				size: 1024,
				sha256: 'a'.repeat(64)
			}
		],
		...overrides
	};
}

test('versions compare numerically, not as strings', () => {
	assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '0.10 follows 0.9');
	assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
	assert.equal(compareVersions('1.0', '1.0.0'), 0, 'a missing patch is zero');
	assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
	assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('a pre-release sorts before its release', () => {
	assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
	assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
	assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
});

test('a signed release verifies against the key that signed it', () => {
	const keys = keyPair();
	const signed = signRelease(keys, release());

	assert.equal(signed.format, RELEASE_FORMAT);
	assert.equal(signed.signer, keys.publicKey.toString('hex'));

	const { payload, signer } = verifyRelease(JSON.stringify(signed), signed.signer);
	assert.equal(signer, keys.publicKey.toString('hex'));
	assert.equal(payload.version, '0.2.0');
	assert.equal(payload.assets.length, 1);
	assert.equal(payload.assets[0].sha256, 'a'.repeat(64));
});

test('a manifest signed by somebody else is refused', () => {
	const trusted = keyPair();
	const stranger = keyPair();
	const signed = signRelease(stranger, release());

	assert.throws(
		() => verifyRelease(JSON.stringify(signed), trusted.publicKey.toString('hex')),
		/signed by .* but this peer trusts/
	);
	// No expectation pinned: the envelope verifies, and the caller learns the key.
	assert.equal(verifyRelease(JSON.stringify(signed)).signer, stranger.publicKey.toString('hex'));
});

test('tampering with the payload invalidates the signature', () => {
	const keys = keyPair();
	const signed = signRelease(keys, release());
	const forged = Buffer.from(
		JSON.stringify({
			...release({ version: '9.9.9' }),
			format: RELEASE_FORMAT
		})
	).toString('base64');

	assert.throws(
		() =>
			verifyRelease(JSON.stringify({ ...signed, payload: forged }), keys.publicKey.toString('hex')),
		/signature does not verify/
	);
});

test('a manifest that is not one is rejected, not guessed at', () => {
	assert.throws(() => verifyRelease('not json'), /not JSON/);
	assert.throws(() => verifyRelease(JSON.stringify({ format: 'something-else' })), /Not a PeerHub/);
	assert.throws(
		() =>
			verifyRelease(
				JSON.stringify({ format: RELEASE_FORMAT, payload: '', signer: '', signature: '' })
			),
		/malformed/
	);
});

test('an asset entry that could escape the staging folder is refused', () => {
	const keys = keyPair();
	const signed = signRelease(
		keys,
		release({
			assets: [
				{
					platform: 'win32',
					arch: 'x64',
					path: '/release/assets/x.exe',
					// A separator or a dot-dot here would write outside the update folder.
					name: '../x.exe',
					size: 10,
					sha256: 'b'.repeat(64)
				}
			]
		})
	);
	assert.throws(() => verifyRelease(JSON.stringify(signed)), /unusable asset/);
});

test('an installer name with spaces is accepted', () => {
	const keys = keyPair();
	const signed = signRelease(
		keys,
		release({
			assets: [
				{
					platform: 'win32',
					arch: 'x64',
					path: '/release/assets/PeerHub Setup 0.2.0.exe',
					// electron-builder names the NSIS installer exactly like this.
					name: 'PeerHub Setup 0.2.0.exe',
					size: 10,
					sha256: 'e'.repeat(64)
				}
			]
		})
	);
	assert.equal(
		verifyRelease(JSON.stringify(signed)).payload.assets[0].name,
		'PeerHub Setup 0.2.0.exe'
	);
});

test('the asset for this machine is picked, and a missing one is null', () => {
	const payload = release({
		assets: [
			{
				platform: 'win32',
				arch: 'x64',
				path: '/r/a.exe',
				name: 'a.exe',
				size: 1,
				sha256: 'c'.repeat(64)
			},
			{
				platform: 'linux',
				arch: 'x64',
				path: '/r/a.AppImage',
				name: 'a.AppImage',
				size: 1,
				sha256: 'd'.repeat(64)
			}
		]
	});

	assert.equal(assetFor(payload, 'linux', 'x64')?.name, 'a.AppImage');
	assert.equal(assetFor(payload, 'darwin', 'arm64'), null);
});

test('the payload bytes are stable across a parse and re-serialise', () => {
	const original = release();
	const bytes = payloadBytes(original);
	const reparsed = JSON.parse(bytes.toString('utf8'));
	assert.deepEqual(
		payloadBytes(reparsed),
		bytes,
		'a signature over one is a signature over the other'
	);
	assert.equal(payloadBytes({ ...original, notes: undefined as any }).length > 0, true);
});

test('the running version is a version string', () => {
	assert.match(runningVersion(), /^\d+\.\d+/);
});
