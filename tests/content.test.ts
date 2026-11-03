// Content migration: a repo that predates the content drive has its files moved
// into it, verified, and only then loses the copy in the plain folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Localdrive from 'localdrive';
import Corestore from 'corestore';
import Hyperdrive from 'hyperdrive';

import { migrateLegacyShared, migrationDone } from '../src/lib/server/content.ts';
import { decodeEntryMeta } from '../src/lib/server/shared-drive.ts';
import { digestBytes } from '../src/lib/server/git.ts';

function put(folder: string, name: string, text: string) {
	const file = path.join(folder, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

async function rig() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-content-'));
	const sharedDir = path.join(root, 'shared');
	fs.mkdirSync(sharedDir, { recursive: true });

	const store = new Corestore(path.join(root, 'store'));
	await store.ready();
	const content = new Hyperdrive(store.session(), { name: 'content' });
	await content.ready();
	const shared = new Localdrive(sharedDir, { atomic: true });
	await shared.ready();

	const session: any = {
		id: 'repo-content',
		isGuest: false,
		app: { dir: path.join(root, 'app') },
		shared,
		content
	};

	return {
		root,
		sharedDir,
		session,
		content,
		async close() {
			await content.close();
			await store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

test('the legacy folder moves into the content drive, verified, once', async () => {
	const r = await rig();
	put(r.sharedDir, 'a.txt', 'hello');
	put(r.sharedDir, 'nested/b.txt', 'nested content');

	const report = await migrateLegacyShared(r.session);

	assert.deepEqual(report, { moved: 2, already: 0, failed: [], bytes: 19 });
	assert.deepEqual(fs.readdirSync(r.sharedDir), [], 'the local copies are gone once verified');
	assert.equal(migrationDone(r.session), true);

	const a = await r.content.entry('/a.txt');
	assert.equal(a?.value.blob.byteLength, 5);
	const meta = decodeEntryMeta(a?.value.metadata);
	assert.equal(meta.hash, digestBytes(Buffer.from('hello')), 'the hash travels with the entry');
	assert.ok(meta.mtime && meta.mtime > 0, 'and so does the mtime the folder had');

	const nested = await r.content.entry('/nested/b.txt');
	assert.equal(nested?.value.blob.byteLength, 14);

	// The marker says it is done: a second open has nothing to do.
	assert.equal(await migrateLegacyShared(r.session), null);

	await r.close();
});

test('a path the drive already holds is dropped from the folder, not copied again', async () => {
	const r = await rig();
	put(r.sharedDir, 'same.txt', 'same bytes');

	// Pretend an earlier run copied this file and crashed before deleting it.
	const ws = r.content.createWriteStream('/same.txt', {
		metadata: Buffer.from(JSON.stringify({ mtime: 1000, hash: digestBytes(Buffer.from('same bytes')) }))
	});
	await new Promise<void>((resolve, reject) => {
		ws.on('error', reject);
		ws.on('close', resolve);
		ws.end(Buffer.from('same bytes'));
	});

	const report = await migrateLegacyShared(r.session);

	assert.deepEqual(report, { moved: 0, already: 1, failed: [], bytes: 0 });
	assert.deepEqual(fs.readdirSync(r.sharedDir), []);

	await r.close();
});

test('a copy that cannot be verified keeps the local file and leaves no marker', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-content-bad-'));
	const sharedDir = path.join(root, 'shared');
	fs.mkdirSync(sharedDir, { recursive: true });
	put(sharedDir, 'keep.txt', 'only copy');
	const shared = new Localdrive(sharedDir, { atomic: true });
	await shared.ready();

	// A drive that accepts the stream but stores nothing: the size check is what
	// must catch it, because the local copy is the only one left.
	const broken = {
		supportsMetadata: true,
		async entry() {
			return null;
		},
		createWriteStream() {
			const handlers: Record<string, (err?: unknown) => void> = {};
			return {
				write() {
					return true;
				},
				on(event: string, fn: (err?: unknown) => void) {
					handlers[event] = fn;
					return this;
				},
				end() {
					setImmediate(() => handlers.close?.());
				}
			};
		}
	};

	const session: any = {
		id: 'repo-broken',
		isGuest: false,
		app: { dir: path.join(root, 'app') },
		shared,
		content: broken
	};

	const report = await migrateLegacyShared(session);

	assert.equal(report?.moved, 0);
	assert.equal(report?.failed.length, 1);
	assert.match(report!.failed[0], /drive holds nothing of \d+ bytes/);
	assert.deepEqual(fs.readdirSync(sharedDir), ['keep.txt'], 'the only copy stays put');
	assert.equal(migrationDone(session), false, 'a failure must retry on the next open');

	await shared.close();
	fs.rmSync(root, { recursive: true, force: true });
});

test('a repo created after content moved has nothing to migrate', async () => {
	const r = await rig();
	fs.rmSync(r.sharedDir, { recursive: true, force: true });

	assert.deepEqual(await migrateLegacyShared(r.session), { moved: 0, already: 0, failed: [], bytes: 0 });
	assert.equal(migrationDone(r.session), true, 'no folder is settled, not a repeated failure');
	assert.equal(await migrateLegacyShared(r.session), null);

	await r.close();
});

test('a guest never migrates: it does not own the folder', async () => {
	const r = await rig();
	put(r.sharedDir, 'a.txt', 'hello');
	r.session.isGuest = true;

	assert.equal(await migrateLegacyShared(r.session), null);
	assert.deepEqual(fs.readdirSync(r.sharedDir), ['a.txt']);
	assert.equal(migrationDone(r.session), false);

	await r.close();
});
