// Manual integration check (not part of `npm test`): real corestore, real
// chunk store, real history. Run: node --import ./tests/register.mjs tests/live-gc.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import PeerHubApp from '../src/lib/server/app.ts';
import { commit } from '../src/lib/server/git.ts';
import { CHUNKS_PREFIX, gcChunks, readVersion } from '../src/lib/server/chunks.ts';
import { HISTORY_PREFIX } from '../src/lib/server/paths.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-gc-live-'));
const app = new PeerHubApp({ dir, bootstrap: [] });
const key = Buffer.alloc(32, 9).toString('hex');

try {
	await app.ready();
	const session = await app.createSession({ name: 'gc-live' });
	const payload = randomBytes(6 * 1024 * 1024);
	await session.putFile(
		'/big.bin',
		(async function* () {
			yield payload;
		})()
	);
	const first = await commit(session, { message: 'first', authorKey: key });
	await commit(session, { message: 'second', authorKey: key });

	const record = `${HISTORY_PREFIX}/${first.sha}/big.bin`;
	const before = (await session.drive.manifestShared(CHUNKS_PREFIX)).filter((e) =>
		/^[0-9a-f]{64}$/.test(e.path.split('/').pop())
	);
	console.log('chunks after commit:', before.length);

	const orphanPath = `${CHUNKS_PREFIX}/${'ab'.repeat(32)}`;
	await session.putFile(
		orphanPath,
		(async function* () {
			yield Buffer.from('orphan');
		})()
	);

	// Give the just-written chunk an mtime in the past so the live check exercises
	// deletion rather than the in-flight grace window.
	await new Promise((resolve) => setTimeout(resolve, 1200));

	const stats = await gcChunks(session, { graceMs: 0, force: true });
	console.log('gc:', JSON.stringify(stats));
	if (stats.removed !== 1) throw new Error('expected exactly one orphan removed');
	if (stats.kept !== before.length) throw new Error('referenced chunks were counted wrong');
	if (await session.drive.statShared(orphanPath).then((s) => s.exists)) {
		throw new Error('orphan still present');
	}

	let read = 0;
	for await (const chunk of readVersion(session, record)) read += chunk.byteLength;
	if (read !== payload.byteLength)
		throw new Error(`restore length ${read} != ${payload.byteLength}`);
	console.log('restore after gc:', read, 'bytes OK');

	const second = await gcChunks(session, { graceMs: 0 });
	console.log('second gc (throttled):', JSON.stringify(second));
	if (!second.skipped) throw new Error('second run should be throttled');
	console.log('LIVE GC OK');
} finally {
	await app.close().catch(() => {});
	fs.rmSync(dir, { recursive: true, force: true });
}
