// The peer directory: what a peer's repo list does to ours.
//
// Deleting a repo must reach other peers; a repo may only be retired by the
// peer that announced it. Both are asserted here, including the spoofing case.
import test from 'node:test';
import assert from 'node:assert/strict';
import b4a from 'b4a';
import {
	ingestAnnouncements,
	listAnnouncements,
	ownAnnouncements,
	pruneAnnouncements,
	refreshAnnouncements
} from '../src/lib/server/directory.ts';
import { fakeApp } from './helpers.ts';

const SELF = b4a.toString(Buffer.alloc(32, 1), 'hex');
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const DRIVE_A = '1'.repeat(64);
const DRIVE_B = '2'.repeat(64);

function announcement(overrides: Record<string, any> = {}) {
	return {
		peerKey: ALICE,
		repoId: 'repo-1',
		name: 'alpha',
		description: null,
		visibility: 'public',
		defaultBranch: 'main',
		driveKey: DRIVE_A,
		metaKey: null,
		writeMode: 'owner',
		ts: 1,
		lastSeen: 1,
		...overrides
	};
}

function envelope(peerKey: string, repos: any[]) {
	return JSON.stringify({ peerKey, repos });
}

function stored(app: any) {
	return [...app.rows.values()].map((row) => `${row.peerKey.slice(0, 4)}/${row.repoId}`);
}

test('a push envelope retires a repo the sender no longer lists', async () => {
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));
	await ingestAnnouncements(
		app,
		envelope(ALICE, [announcement({ repoId: 'repo-2', driveKey: DRIVE_B })])
	);

	assert.deepEqual(stored(app), ['aaaa/repo-2'], 'repo-1 must be gone, repo-2 must remain');
});

test('pruning is scoped to the sender', async () => {
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));
	await ingestAnnouncements(app, envelope(BOB, [announcement({ peerKey: BOB, repoId: 'bob-1' })]));

	// Alice now reports an empty list.
	await ingestAnnouncements(app, envelope(ALICE, []));

	assert.deepEqual(stored(app), ['bbbb/bob-1'], "Bob's rows must survive Alice's empty list");
});

test('rows claiming our own key are dropped and cannot prune anybody', async () => {
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));

	// A payload that claims to be us must not create rows under our key…
	await ingestAnnouncements(
		app,
		JSON.stringify([announcement({ peerKey: SELF, repoId: 'mine-now' })])
	);
	assert.deepEqual(stored(app), ['aaaa/repo-1']);

	// …and an envelope claiming to be us cannot retire Alice's repo either.
	await ingestAnnouncements(app, envelope(SELF, []));
	assert.deepEqual(stored(app), ['aaaa/repo-1']);
});

test('a bare array (older peer) merges and never prunes', async () => {
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));
	await ingestAnnouncements(app, JSON.stringify([]));

	assert.deepEqual(stored(app), ['aaaa/repo-1'], 'a payload with no sender cannot prove anything');
});

test('legacy bare arrays still accept new repos', async () => {
	const app = fakeApp();
	const count = await ingestAnnouncements(
		app,
		JSON.stringify([announcement({ repoId: 'legacy' })])
	);

	assert.equal(count, 1);
	assert.deepEqual(stored(app), ['aaaa/legacy']);
});

test('private repos never carry keys across the wire', async () => {
	const app = fakeApp();
	await ingestAnnouncements(
		app,
		envelope(ALICE, [
			announcement({ visibility: 'private', driveKey: DRIVE_A, metaKey: '3'.repeat(64) })
		])
	);

	const row = [...app.rows.values()][0];
	assert.equal(row.visibility, 'private');
	assert.equal(row.driveKey, null, 'a private repo must not leak its drive key');
	assert.equal(row.metaKey, null, 'a private repo must not leak its meta key');
});

test('malformed rows are dropped, and only invalid keys are nulled', async () => {
	const app = fakeApp();
	const count = await ingestAnnouncements(
		app,
		envelope(ALICE, [
			announcement({ repoId: '' }),
			announcement({ repoId: 'no-name', name: null }),
			announcement({ repoId: 5 }),
			announcement({ repoId: 'bad-drive', driveKey: 'not-hex' }),
			announcement({ repoId: 'bad-meta', metaKey: 'nope' }),
			announcement({ repoId: 'good' })
		])
	);

	assert.equal(count, 3, 'three rows are structurally valid');
	const byId = new Map([...app.rows.values()].map((row) => [row.repoId, row]));
	assert.deepEqual([...byId.keys()].sort(), ['bad-drive', 'bad-meta', 'good']);
	assert.equal(byId.get('bad-drive').driveKey, null, 'an invalid drive key must not be stored');
	assert.equal(byId.get('bad-meta').metaKey, null, 'an invalid meta key must not be stored');
	assert.equal(byId.get('good').driveKey, DRIVE_A, 'a valid key must survive');
});

test('names and descriptions are truncated to the documented limits', async () => {
	const app = fakeApp();
	await ingestAnnouncements(
		app,
		envelope(ALICE, [announcement({ name: 'n'.repeat(500), description: 'd'.repeat(2000) })])
	);

	const row = [...app.rows.values()][0];
	assert.equal(row.name.length, 120);
	assert.equal(row.description.length, 500);
});

test('ingest reports how many rows it stored, not how many it saw', async () => {
	const app = fakeApp();
	const count = await ingestAnnouncements(
		app,
		envelope(ALICE, [announcement(), announcement({ repoId: 'x', name: '' })])
	);
	assert.equal(count, 1);
});

test('a repo that reappears clears the "source removed" mark', async () => {
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));
	await ingestAnnouncements(app, envelope(ALICE, []));
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));

	const last = app.markCalls.at(-1);
	assert.deepEqual(last, { gone: [], live: [DRIVE_A] });
});

test('pruning reports the removed drive key as gone', async () => {
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));
	await ingestAnnouncements(app, envelope(ALICE, []));

	const removed = app.markCalls.at(-1);
	assert.deepEqual(removed, { gone: [DRIVE_A], live: [] });
});

test('a peer may not retire another peer’s repos by claiming its key', async () => {
	// The sender is taken from the payload, not from the connection. Anyone
	// connected can therefore send { peerKey: victim, repos: [] } and wipe the
	// victim's repos from our list.
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(ALICE, [announcement()]));

	await ingestAnnouncements(app, envelope(ALICE, []), BOB);

	assert.deepEqual(
		stored(app),
		['aaaa/repo-1'],
		'an envelope must not act for a peer other than the one that sent it'
	);
});

test('rows are attributed to the connection, not to the payload', async () => {
	const app = fakeApp();
	await ingestAnnouncements(app, envelope(BOB, [announcement({ peerKey: BOB })]), ALICE);

	const row = [...app.rows.values()][0];
	assert.equal(
		row.peerKey,
		ALICE,
		'the transport identifies the sender; the payload cannot override it'
	);
});

test('ownAnnouncements skips mirrors and fills the documented defaults', async () => {
	const app = fakeApp();
	app.sessions.set('own', {
		id: 'own',
		name: 'mine',
		isGuest: false,
		drive: { key: Buffer.from(DRIVE_A, 'hex') },
		metaKeyHex: null
	});
	app.sessions.set('mirror', { id: 'mirror', name: 'theirs', isGuest: true, drive: null });
	app.repos.set('own', { description: 'd', visibility: 'private', defaultBranch: 'main' });

	const list = await ownAnnouncements(app);

	assert.equal(list.length, 1, 'a mirror is not ours to announce');
	assert.equal(list[0].peerKey, SELF);
	assert.equal(list[0].visibility, 'private');
	assert.equal(list[0].writeMode, 'owner');
	assert.equal(list[0].driveKey, DRIVE_A);
	assert.equal(list[0].metaKey, null);
});

test('ownAnnouncements reflects the peer-write policy', async () => {
	const app = fakeApp();
	app.sessions.set('own', {
		id: 'own',
		name: 'mine',
		isGuest: false,
		drive: { key: Buffer.alloc(32, 9) }
	});
	app.repos.set('own', { writeMode: 'peers' });

	const list = await ownAnnouncements(app);
	assert.equal(list[0].writeMode, 'peers');
});

test('listAnnouncements sorts the freshest peer first', async () => {
	const app = fakeApp();
	// lastSeen is stamped on receipt, so seed the rows directly to control it.
	app.rows.set('old', { peerKey: ALICE, repoId: 'old', lastSeen: 10 });
	app.rows.set('new', { peerKey: BOB, repoId: 'new', lastSeen: 99 });

	const rows = await listAnnouncements(app);
	assert.deepEqual(
		rows.map((row) => row.repoId),
		['new', 'old']
	);
});

test('a peer that never comes back is expired and its mirrors are marked', async () => {
	const app = fakeApp();
	app.rows.set(`${ALICE}|a1`, announcement({ repoId: 'a1', lastSeen: 1_000 }));
	app.rows.set(
		`${BOB}|b1`,
		announcement({ peerKey: BOB, repoId: 'b1', driveKey: DRIVE_B, lastSeen: 9_000 })
	);

	const stats = await pruneAnnouncements(app, { ttlMs: 5_000, now: 10_000 });

	assert.equal(stats.expired, 1);
	assert.deepEqual(stored(app), ['bbbb/b1'], 'only the silent peer is forgotten');
	assert.deepEqual(
		app.markCalls.at(-1),
		{ gone: [DRIVE_A], live: [DRIVE_B] },
		'a mirror of the expired repo must show as removed, the live one must not'
	);
});

test('a connected peer keeps its rows even when the TTL says stale', async () => {
	const app = fakeApp();
	app.directoryRemotes.add(ALICE);
	app.rows.set(`${ALICE}|a1`, announcement({ repoId: 'a1', lastSeen: 1_000 }));

	const stats = await pruneAnnouncements(app, { ttlMs: 5_000, now: 10_000 });

	assert.equal(stats.expired, 0);
	assert.deepEqual(stored(app), ['aaaa/a1'], 'a live connection is proof the peer is alive');
	assert.deepEqual(app.markCalls, []);
});

test('expiry is measured from lastSeen, and the boundary itself is kept', async () => {
	const app = fakeApp();
	app.rows.set(`${ALICE}|edge`, announcement({ repoId: 'edge', lastSeen: 5_000 }));
	app.rows.set(`${BOB}|late`, announcement({ peerKey: BOB, repoId: 'late', lastSeen: 5_001 }));

	const stats = await pruneAnnouncements(app, { ttlMs: 5_000, now: 10_000 });

	assert.equal(stats.expired, 0, 'exactly at the TTL is not yet expired');
	assert.deepEqual(stored(app), ['aaaa/edge', 'bbbb/late']);

	const later = await pruneAnnouncements(app, { ttlMs: 5_000, now: 10_001 });
	assert.equal(later.expired, 1);
	assert.deepEqual(stored(app), ['bbbb/late']);
});

test('pruning an empty directory does nothing', async () => {
	const app = fakeApp();
	const stats = await pruneAnnouncements(app, { ttlMs: 1, now: 10 });
	assert.equal(stats.expired, 0);
	assert.deepEqual(app.markCalls, []);
});

test('a refresh reply is attributed to the channel, so it cannot prune somebody else', async () => {
	const app = fakeApp();
	app.rows.set(`${ALICE}|kept`, announcement({ repoId: 'kept' }));

	const rpc = {
		opened: true,
		_remote: BOB,
		async request() {
			// Claims to be Alice while answering on Bob's channel.
			return envelope(ALICE, [announcement({ peerKey: ALICE, repoId: 'forged' })]);
		}
	};
	app.directoryPeers.add(rpc);

	await refreshAnnouncements(app, 10);

	assert.deepEqual(stored(app), ['aaaa/kept', 'bbbb/forged'].sort());
	assert.deepEqual(
		app.rows.get(`${BOB}|forged`)?.peerKey,
		BOB,
		'the row belongs to the channel, not to the claimed key'
	);
});
