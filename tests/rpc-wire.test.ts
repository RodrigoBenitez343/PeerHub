// What a shared-drive RPC answer may contain.
//
// Every numeric field on the write channel is a `uint`, and compact-encoding
// derives a varint's *length* from the value it is given: a NaN or a negative
// number makes the encode throw. protomux-rpc then answers by sending the failed
// value as the message body, which throws again — uncaught, in the responder's
// process, as `ERR_OUT_OF_RANGE: The value of "size" is out of range`. That is
// exactly the dialog an older build showed when a peer asked it for a manifest of
// a drive it had only partly downloaded.
//
// Two more of the same family are pinned here: `entry.metadata` as a Hyperdrive
// stores it (a JSON-Buffer object, not bytes) and the stock `entry`/`list`/
// `get`/`read`/`readdir` handlers, which re-raise a RangeError instead of
// skipping the drive that produced it. Both are fixed where the answer is built,
// so no request is ever answered with a body that cannot be encoded.
import test from 'node:test';
import assert from 'node:assert/strict';
import c from 'compact-encoding';
import { count, serve, wireEntryValue } from '../src/lib/server/shared-drive.ts';

test('a size that is not a number becomes zero, never NaN', () => {
	assert.equal(count(NaN), 0);
	assert.equal(count(undefined), 0);
	assert.equal(count(null), 0);
	assert.equal(count(''), 0);
	assert.equal(count('not a size'), 0);
	assert.equal(count(-1), 0);
	assert.equal(count(Infinity), 0);
});

test('a real size survives, rounded', () => {
	assert.equal(count(0), 0);
	assert.equal(count(1), 1);
	assert.equal(count(150929040), 150929040);
	assert.equal(count('150929040'), 150929040);
	assert.equal(count(12.7), 13);
});

test('a value beyond the wire integer range is clamped, not wrapped', () => {
	assert.equal(count(Number.MAX_SAFE_INTEGER + 1000), Number.MAX_SAFE_INTEGER);
});

test('a handler that throws answers with the fallback shape', async () => {
	const fallback = { exists: 0, size: 0, mtime: 0, hash: '', stamp: '' };
	const answer = await serve(
		'stat',
		() => fallback,
		() => {
			throw new Error('drive is not open');
		}
	);
	assert.deepEqual(answer, fallback);
});

test('a handler that rejects answers with the fallback shape', async () => {
	const answer = await serve(
		'manifest',
		() => ({ entries: [] as any[] }),
		async () => {
			throw new Error('no blocks from any peer');
		}
	);
	assert.deepEqual(answer, { entries: [] });
});

test('a handler that succeeds is passed through untouched', async () => {
	const answer = await serve(
		'stat',
		() => ({ exists: 0, size: 0, mtime: 0, hash: '', stamp: '' }),
		async () => ({ exists: 1, size: 42, mtime: 7, hash: 'abc', stamp: 'x' })
	);
	assert.equal(answer.size, 42);
	assert.equal(answer.exists, 1);
});

// The metadata a Hyperdrive hands back is the JSON shape of a Buffer, and the
// entry-value encoding of distributed-drive puts it on the wire with `c.buffer`:
// `byteLength` is undefined, the size becomes NaN, and the responder throws
// ERR_OUT_OF_RANGE from Buffer.allocUnsafe(NaN). So the value is normalized
// before it is sent, and nothing about it is lost on the way.
test('Hyperdrive metadata is turned into bytes before it reaches the wire', () => {
	const value = {
		executable: false,
		linkname: null,
		blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 5 },
		metadata: { type: 'Buffer', data: [123, 125] }
	};

	// The mechanism, pinned: the raw value cannot be encoded at all.
	assert.throws(
		() => c.encode(c.buffer, value.metadata),
		/RangeError|out of range/,
		'a JSON-Buffer has no byteLength, so the size is NaN'
	);

	const wired = wireEntryValue(value);
	assert.ok(Buffer.isBuffer(wired.metadata));
	assert.equal(wired.metadata!.toString('utf-8'), '{}');
	assert.deepEqual(wired.blob, value.blob, 'the rest of the value is untouched');
	assert.doesNotThrow(() => c.encode(c.buffer, wired.metadata));
});

test('metadata in any other shape still travels as bytes, never as NaN', () => {
	const bytes = Buffer.from('hello');
	assert.equal(wireEntryValue({ metadata: bytes }).metadata, bytes, 'bytes pass through');
	assert.equal(wireEntryValue({ metadata: null }).metadata, null);
	assert.equal(wireEntryValue({}).metadata, null);
	assert.equal(wireEntryValue({ metadata: 'text' }).metadata.toString(), 'text');
	assert.equal(
		wireEntryValue({ metadata: { nonsense: true } }).metadata.toString(),
		'{"nonsense":true}',
		'an unexpected shape is carried as the JSON bytes it already is'
	);
	for (const metadata of [bytes, 'text', { nonsense: true }, { type: 'Buffer', data: [1] }]) {
		assert.doesNotThrow(() => c.encode(c.buffer, wireEntryValue({ metadata }).metadata));
	}
});

// The stock handlers answer straight from the drive, and a throw there used to
// reach the encoder: protomux-rpc echoes the failed request as the body, which
// cannot be encoded, and the process died in Buffer.allocUnsafe(NaN). Each of
// the five answers has to stay the shape the caller decodes, even when the drive
// fails.
test('a drive that fails still answers in the caller’s shape', async () => {
	const { default: SharedDrive } = await import('../src/lib/server/shared-drive.ts');

	// A plain Error, the case safety-catch does not re-raise: the override has to
	// turn it into the miss shape, or the channel answers with an unencodable body.
	const boom = new Error('no blocks from any peer');
	const broken = {
		async entry() {
			throw boom;
		},
		async get() {
			throw boom;
		},
		async *list() {
			throw boom;
		},
		async *readdir() {
			throw boom;
		},
		createReadStream() {
			throw boom;
		}
	};
	const fake: any = Object.create(SharedDrive.prototype);
	fake.drives = [broken];
	fake._mounts = new Map([[broken, '/']]);
	fake._rpc = null;

	assert.deepEqual(await (SharedDrive.prototype as any)._onEntry.call(fake, '/a.txt'), {
		exists: false,
		entry: null
	});
	assert.deepEqual(await (SharedDrive.prototype as any)._onList.call(fake, '/'), { entries: [] });
	assert.deepEqual(await (SharedDrive.prototype as any)._onReaddir.call(fake, '/'), { names: [] });
	assert.equal((await (SharedDrive.prototype as any)._onGet.call(fake, '/a.txt')).byteLength, 0);
	assert.equal(
		(await (SharedDrive.prototype as any)._onRead.call(fake, { path: '/a.txt', start: 0, end: 4 }))
			.byteLength,
		0
	);
});

test('the entry and list answers are normalized where the base class builds them', async () => {
	const { default: SharedDrive } = await import('../src/lib/server/shared-drive.ts');

	// Just enough of a drive for the base class's own `_onEntry`/`_onList`.
	const value = {
		executable: false,
		linkname: null,
		blob: { byteLength: 2 },
		metadata: { type: 'Buffer', data: [123, 125] }
	};
	const fakeDrive = {
		async entry() {
			return { key: '/a.txt', value };
		},
		async *list() {
			yield { key: '/a.txt', value };
		}
	};
	const fake: any = Object.create(SharedDrive.prototype);
	fake.drives = [fakeDrive];
	fake._mounts = new Map([[fakeDrive, '/']]);

	const entry = await (SharedDrive.prototype as any)._onEntry.call(fake, '/a.txt');
	assert.ok(Buffer.isBuffer(entry.entry.value.metadata), 'entry: metadata is bytes');
	assert.doesNotThrow(() => c.encode(c.buffer, entry.entry.value.metadata));

	const list = await (SharedDrive.prototype as any)._onList.call(fake, '/');
	assert.equal(list.entries.length, 1);
	assert.ok(Buffer.isBuffer(list.entries[0].value.metadata), 'list: metadata is bytes');

	// And the drive's own object is not mutated on the way out.
	assert.ok(!Buffer.isBuffer(value.metadata));
});
