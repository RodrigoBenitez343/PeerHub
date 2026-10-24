// Manual integration check (not part of `npm test`): a real hyperdb row from a
// silent peer is gone after a restart's boot prune.
// Run: node --import ./tests/register.mjs tests/live-prune.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PEERHUB_ANNOUNCEMENT_TTL_MS = '1000';

const { default: PeerHubApp } = await import('../src/lib/server/app.ts');
const { ingestAnnouncements } = await import('../src/lib/server/directory.ts');
const { ANNOUNCEMENT_TTL_MS } = await import('../src/lib/server/directory.ts');

const ALICE = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const DRIVE_A = '11'.repeat(32);
const DRIVE_B = '22'.repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-prune-live-'));

function row(peerKey, repoId, driveKey, lastSeen) {
	return {
		peerKey,
		repoId,
		name: repoId,
		description: null,
		visibility: 'public',
		defaultBranch: 'main',
		driveKey,
		metaKey: null,
		writeMode: 'owner',
		ts: lastSeen,
		lastSeen
	};
}

const list = async (app) =>
	(await app.db.find('@ghostdrive/announcements', { gte: {}, lte: {} }).toArray())
		.map((r) => `${r.peerKey.slice(0, 2)}/${r.repoId}`)
		.sort();

try {
	if (ANNOUNCEMENT_TTL_MS !== 1000) throw new Error(`TTL override ignored: ${ANNOUNCEMENT_TTL_MS}`);

	const one = new PeerHubApp({ dir, bootstrap: [] });
	await one.ready();
	// Store through the real ingest path first (so the row matches the schema),
	// then backdate Alice's lastSeen to simulate a peer that stopped answering.
	await ingestAnnouncements(one, JSON.stringify([row(ALICE, 'gone', DRIVE_A, Date.now())]));
	await ingestAnnouncements(one, JSON.stringify([row(BOB, 'kept', DRIVE_B, Date.now())]));
	await one.db.insert(
		'@ghostdrive/announcements',
		row(ALICE, 'gone', DRIVE_A, Date.now() - 60_000)
	);
	await one.db.flush();
	console.log('before restart:', await list(one));
	await one.close();

	const two = new PeerHubApp({ dir, bootstrap: [] });
	await two.ready();
	const after = await list(two);
	console.log('after restart:', after);
	if (after.join(',') !== 'bb/kept') throw new Error('boot prune did not expire the silent peer');
	await two.close();

	console.log('LIVE PRUNE OK');
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
