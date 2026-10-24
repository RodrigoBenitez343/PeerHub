// Chunked history records: what a commit actually stores.
//
// These assert the properties the design promises — exact round-trip, byte
// reuse across versions, locality of an edit or an insert — not just "it ran".
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
	DELTA_THRESHOLD,
	CHUNKS_PREFIX,
	gcChunks,
	readVersion,
	writeDelta
} from '../src/lib/server/chunks.ts';
import { memoryDrive } from './helpers.ts';

const MAGIC = 'PEERHUB-DELTA/1\n';

async function collect(iterable: AsyncIterable<Buffer>): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const chunk of iterable) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts);
}

/** Reassemble the record under `target`. */
function read(session: any, target: string) {
	return collect(readVersion(session, target));
}

function stream(bytes: Buffer) {
	return (async function* () {
		yield bytes;
	})();
}

async function manifestOf(mem: ReturnType<typeof memoryDrive>, target: string) {
	const bytes = mem.files.get(target);
	assert.ok(bytes, `no record stored at ${target}`);
	assert.equal(bytes.subarray(0, MAGIC.length).toString(), MAGIC, 'record must carry the magic');
	return JSON.parse(bytes.subarray(MAGIC.length).toString());
}

test('round-trips a multi-chunk payload byte for byte', async () => {
	const mem = memoryDrive();
	const payload = randomBytes(3 * 1024 * 1024 + 12345);

	const stats = await writeDelta(mem.session, '/h/a.bin', stream(payload));
	assert.equal(stats.size, payload.byteLength);
	assert.equal(stats.reused, 0);
	assert.ok(stats.stored > 3, `expected several chunks, got ${stats.stored}`);

	assert.deepEqual(await read(mem.session, '/h/a.bin'), payload);
});

test('reuses every chunk when the same bytes are stored again', async () => {
	const mem = memoryDrive();
	const payload = randomBytes(2 * 1024 * 1024);

	const first = await writeDelta(mem.session, '/h/a.bin', stream(payload));
	const second = await writeDelta(mem.session, '/h/b.bin', stream(payload));

	assert.ok(second.reused > 0);
	assert.equal(second.stored, 0, 'identical content must not be written twice');
	assert.equal(second.reused, first.stored, 'every chunk of the copy must be a reuse');
	assert.deepEqual(await read(mem.session, '/h/b.bin'), payload, 'the copy must still reassemble');
});

test('an in-place edit stores only the edited chunk', async () => {
	const mem = memoryDrive();
	const payload = randomBytes(4 * 1024 * 1024);
	await writeDelta(mem.session, '/h/v1.bin', stream(payload));

	const edited = Buffer.from(payload);
	randomBytes(4096).copy(edited, 2_000_000);
	const stats = await writeDelta(mem.session, '/h/v2.bin', stream(edited));

	assert.ok(stats.stored <= 2, `a 4 KiB edit stored ${stats.stored} chunks`);
	assert.ok(stats.reused >= 3, `only ${stats.reused} chunks were reused`);
	assert.deepEqual(await read(mem.session, '/h/v2.bin'), edited);
});

test('an insert near the start does not rewrite the rest of the file', async () => {
	// The property that separates content-defined chunking from a fixed grid: a
	// fixed 512 KiB grid would re-store everything after the insertion point.
	const mem = memoryDrive();
	const payload = randomBytes(4 * 1024 * 1024);
	await writeDelta(mem.session, '/h/v1.bin', stream(payload));

	const inserted = Buffer.concat([
		payload.subarray(0, 100_000),
		randomBytes(64),
		payload.subarray(100_000)
	]);
	const stats = await writeDelta(mem.session, '/h/v2.bin', stream(inserted));

	assert.ok(stats.stored <= 3, `a 64-byte insert stored ${stats.stored} chunks`);
	assert.deepEqual(await read(mem.session, '/h/v2.bin'), inserted);
});

test('chunking is deterministic: the same bytes produce the same references', async () => {
	const mem = memoryDrive();
	const payload = randomBytes(2 * 1024 * 1024);
	await writeDelta(mem.session, '/h/a.bin', stream(payload));
	await writeDelta(mem.session, '/h/b.bin', stream(payload));

	const a = await manifestOf(mem, '/h/a.bin');
	const b = await manifestOf(mem, '/h/b.bin');
	assert.deepEqual(a.ops, b.ops, 'the same input must chunk identically across runs');
	assert.equal(a.size, payload.byteLength);
});

test('never exceeds the maximum chunk size', async () => {
	const mem = memoryDrive();
	// All-zero data cannot produce a content boundary, so the max-size cutoff is
	// the only thing that can split it. Every slice is identical, so they share
	// one store entry — the manifest, not the store, shows the real chunk count.
	await writeDelta(mem.session, '/h/zeros.bin', stream(Buffer.alloc(3 * 1024 * 1024)));
	const parsed = await manifestOf(mem, '/h/zeros.bin');

	assert.ok(
		parsed.ops.length >= 3,
		`expected the 3 MiB run to split, got ${parsed.ops.length} parts`
	);
	for (const op of parsed.ops) {
		const stored = mem.files.get(`${CHUNKS_PREFIX}/${op.r}`);
		assert.ok(stored, 'every referenced chunk must exist');
		assert.ok(
			stored.byteLength <= 1024 * 1024,
			`chunk of ${stored.byteLength} bytes exceeds the cap`
		);
	}
	// The whole payload must still reassemble: chunk reuse may not lose order.
	const rebuilt = await read(mem.session, '/h/zeros.bin');
	assert.equal(rebuilt.byteLength, 3 * 1024 * 1024);
	assert.ok(rebuilt.every((byte) => byte === 0));
});

test('an empty file produces an empty manifest that reassembles to nothing', async () => {
	const mem = memoryDrive();
	const stats = await writeDelta(mem.session, '/h/empty', stream(Buffer.alloc(0)));

	assert.equal(stats.size, 0);
	assert.equal(stats.stored, 0);
	const parsed = await manifestOf(mem, '/h/empty');
	assert.deepEqual(parsed, { size: 0, ops: [] });
	assert.equal((await read(mem.session, '/h/empty')).byteLength, 0);
});

test('a plain (pre-chunk) record is still returned verbatim', async () => {
	const mem = memoryDrive();
	const plain = Buffer.from('not a manifest, just an old snapshot');
	mem.write('/h/old.txt', plain);

	assert.deepEqual(await read(mem.session, '/h/old.txt'), plain);
});

test('a truncated record fails loudly instead of returning short data', async () => {
	const mem = memoryDrive();
	const payload = randomBytes(2 * 1024 * 1024);
	await writeDelta(mem.session, '/h/a.bin', stream(payload));

	const record = mem.files.get('/h/a.bin')!;
	const parsed = JSON.parse(record.subarray(MAGIC.length).toString());
	parsed.size += 4096; // lie about the length, as a half-written manifest would
	mem.files.set(
		'/h/a.bin',
		Buffer.concat([Buffer.from(MAGIC), Buffer.from(JSON.stringify(parsed))])
	);

	await assert.rejects(read(mem.session, '/h/a.bin'), /incomplete/i);
});

test('a missing chunk fails loudly and names the chunk', async () => {
	const mem = memoryDrive();
	await writeDelta(mem.session, '/h/a.bin', stream(randomBytes(2 * 1024 * 1024)));

	const parsed = await manifestOf(mem, '/h/a.bin');
	const victim = `${CHUNKS_PREFIX}/${parsed.ops[0].r}`;
	mem.files.delete(victim);

	await assert.rejects(read(mem.session, '/h/a.bin'), (err: Error) => {
		assert.match(err.message, /chunk missing/i);
		assert.ok(err.message.includes(victim), 'the error must name the missing chunk');
		return true;
	});
});

test('a corrupt manifest fails loudly', async () => {
	const mem = memoryDrive();
	mem.write('/h/bad.bin', Buffer.concat([Buffer.from(MAGIC), Buffer.from('{not json')]));

	await assert.rejects(read(mem.session, '/h/bad.bin'), /unreadable/i);
});

test('a manifest entry with no string hash is rejected, not skipped', async () => {
	const mem = memoryDrive();
	mem.write(
		'/h/bad2.bin',
		Buffer.concat([Buffer.from(MAGIC), Buffer.from(JSON.stringify({ size: 1, ops: [{ r: 7 }] }))])
	);

	await assert.rejects(read(mem.session, '/h/bad2.bin'), /unreadable/i);
});

test('DELTA_THRESHOLD is the documented 4 MiB', () => {
	assert.equal(DELTA_THRESHOLD, 4 * 1024 * 1024);
});

const H = '/.peerhub/history';

/** Every stored chunk path, sorted, so a test can name what survived. */
function chunks(mem: ReturnType<typeof memoryDrive>) {
	return [...mem.files.keys()]
		.filter((path) => path.startsWith(CHUNKS_PREFIX + '/'))
		.filter((path) => /^[0-9a-f]{64}$/.test(path.slice(path.lastIndexOf('/') + 1)))
		.sort();
}

async function seedHistory(mem: ReturnType<typeof memoryDrive>) {
	await writeDelta(mem.session, `${H}/main/a.bin`, stream(Buffer.from('alpha')));
	await writeDelta(mem.session, `${H}/dev/a.bin`, stream(Buffer.from('alpha')));
	await writeDelta(mem.session, `${H}/dev/b.bin`, stream(Buffer.from('beta')));
	mem.write(`${H}/main/plain.txt`, Buffer.from('old plain snapshot'));
	mem.write(`${CHUNKS_PREFIX}/${'f'.repeat(64)}`, Buffer.from('orphan'));
}

test('gc removes chunks no history record references and keeps the rest', async () => {
	const mem = memoryDrive();
	await seedHistory(mem);
	const orphan = `${CHUNKS_PREFIX}/${'f'.repeat(64)}`;
	const referenced = chunks(mem).filter((path) => path !== orphan);
	assert.equal(referenced.length, 2, 'two distinct contents, shared by three records');

	const stats = await gcChunks(mem.session, { graceMs: 0 });

	assert.equal(stats.removed, 1);
	assert.equal(stats.kept, referenced.length);
	assert.equal(mem.files.has(orphan), false);
	assert.deepEqual(chunks(mem), referenced, 'a chunk another record still needs must survive');
	assert.deepEqual(await read(mem.session, `${H}/main/a.bin`), Buffer.from('alpha'));
	assert.equal(mem.files.has(`${H}/main/plain.txt`), true, 'plain snapshots are not chunks');
});

test('gc aborts without deleting anything when a manifest is unreadable', async () => {
	const mem = memoryDrive();
	await seedHistory(mem);
	mem.write(`${H}/dev/broken.bin`, Buffer.concat([Buffer.from(MAGIC), Buffer.from('{oops')]));
	const orphan = `${CHUNKS_PREFIX}/${'f'.repeat(64)}`;

	const stats = await gcChunks(mem.session, { graceMs: 0, force: true });

	assert.equal(stats.skipped, true);
	assert.match(stats.reason!, /unreadable/i);
	assert.equal(mem.files.has(orphan), true, 'an unparsable record could reference anything');
});

test('gc only deletes content-addressed names, never foreign files', async () => {
	const mem = memoryDrive();
	await writeDelta(mem.session, `${H}/main/a.bin`, stream(Buffer.from('alpha')));
	mem.write(`${CHUNKS_PREFIX}/notes.txt`, Buffer.from('not a chunk hash'));
	mem.write(`${CHUNKS_PREFIX}/.gc`, Buffer.from('{"at":1}'));

	const stats = await gcChunks(mem.session, { graceMs: 0, force: true });

	assert.equal(stats.removed, 0);
	assert.equal(mem.files.has(`${CHUNKS_PREFIX}/notes.txt`), true);
	assert.equal(mem.files.has(`${CHUNKS_PREFIX}/.gc`), true);
});

test('gc leaves a fresh chunk alone so an in-flight commit cannot lose it', async () => {
	const mem = memoryDrive();
	await writeDelta(mem.session, `${H}/main/a.bin`, stream(Buffer.from('alpha')));
	const orphan = `${CHUNKS_PREFIX}/${'e'.repeat(64)}`;
	mem.write(orphan, Buffer.from('just written'));
	mem.setMtime(orphan, Date.now());

	const kept = await gcChunks(mem.session, { graceMs: 60_000, force: true });
	assert.equal(kept.removed, 0);
	assert.equal(mem.files.has(orphan), true);

	const swept = await gcChunks(mem.session, { graceMs: 0, force: true });
	assert.equal(swept.removed, 1);
});

test('gc runs at most once per throttle window unless forced', async () => {
	const mem = memoryDrive();
	await writeDelta(mem.session, `${H}/main/a.bin`, stream(Buffer.from('alpha')));
	const orphan = `${CHUNKS_PREFIX}/${'d'.repeat(64)}`;
	mem.write(orphan, Buffer.from('orphan'));

	const first = await gcChunks(mem.session, { graceMs: 0 });
	assert.equal(first.removed, 1);
	assert.equal(mem.files.has(`${CHUNKS_PREFIX}/.gc`), true, 'the run is stamped');

	mem.write(orphan, Buffer.from('orphan again'));
	const throttled = await gcChunks(mem.session, { graceMs: 0 });
	assert.equal(throttled.skipped, true);
	assert.equal(mem.files.has(orphan), true, 'a second run inside the window does nothing');

	const forced = await gcChunks(mem.session, { graceMs: 0, force: true });
	assert.equal(forced.removed, 1);
	assert.equal(mem.files.has(orphan), false);
});
