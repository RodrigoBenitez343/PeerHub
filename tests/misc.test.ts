// Small server utilities: reserved-path guard, data dir, CLI token, ignore
// cache, sync summary and the stream write helper. These are the pieces every
// other module leans on, so a regression here is silent everywhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { isReservedRepoPath } from '../src/lib/server/paths.ts';
import { ensureCliToken, cliTokenPath } from '../src/lib/server/cli-token.ts';
import {
	loadIgnoreSources,
	loadIgnoreMatcher,
	invalidateIgnore
} from '../src/lib/server/ignores.ts';
import { buildIgnore, formatSummary } from '../src/lib/server/sync.ts';
import { dataDir } from '../shared/data-dir.js';
import { memoryDrive } from './helpers.ts';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'peerhub-misc-'));
const temp = (name: string) => path.join(sandbox, name);

test('isReservedRepoPath catches .peerhub only at the repo root', () => {
	assert.equal(isReservedRepoPath('/.peerhub/history/main/x'), true);
	assert.equal(isReservedRepoPath('/.peerhub'), true);
	assert.equal(isReservedRepoPath('//.peerhub/anything'), true, 'leading slashes are not a path');
	assert.equal(isReservedRepoPath('.peerhub'), true);

	assert.equal(isReservedRepoPath('/src/.peerhub/x'), false, 'only the root is reserved');
	assert.equal(isReservedRepoPath('/peerhub'), false, 'a prefix is not a match');
	assert.equal(isReservedRepoPath('/.peerhubish'), false);
});

test('dataDir honours the override and otherwise ends in the shared folder name', () => {
	const saved = process.env.PEERHUB_DATA_DIR;
	try {
		process.env.PEERHUB_DATA_DIR = temp('../relative-data-dir');
		assert.equal(dataDir(), path.resolve(temp('../relative-data-dir')));

		delete process.env.PEERHUB_DATA_DIR;
		assert.ok(path.isAbsolute(dataDir()));
		assert.equal(
			path.basename(dataDir()),
			'ghost-drive',
			'the folder name is a corestore identity'
		);
	} finally {
		if (saved === undefined) delete process.env.PEERHUB_DATA_DIR;
		else process.env.PEERHUB_DATA_DIR = saved;
	}
});

test('ensureCliToken mints a 32-char token, persists it and reuses it', () => {
	const dir = temp('cli');
	const token = ensureCliToken(dir);

	assert.match(token, /^[0-9a-f]{32}$/);
	assert.equal(fs.readFileSync(cliTokenPath(dir), 'utf8'), token + '\n');
	assert.equal(ensureCliToken(dir), token, 'a restart must not invalidate the CLI');
	assert.equal(ensureCliToken(dir), token);
});

test('ensureCliToken replaces a truncated token instead of trusting it', () => {
	const dir = temp('cli-short');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(cliTokenPath(dir), 'deadbeef\n');

	const token = ensureCliToken(dir);
	assert.match(token, /^[0-9a-f]{32}$/);
	assert.notEqual(token, 'deadbeef');
});

test('ensureCliToken works when the directory does not exist yet', () => {
	const dir = temp('nested/cli');
	assert.doesNotThrow(() => ensureCliToken(dir));
	assert.ok(fs.existsSync(cliTokenPath(dir)));
});

test('ignore sources come from every .gitignore, with the right base', async () => {
	const memory = memoryDrive('ignores-nested');
	memory.write('/.gitignore', Buffer.from('*.log\n'));
	memory.write('/sub/.gitignore', Buffer.from('*.tmp\n'));
	memory.write('/sub/deep/notes.txt', Buffer.from('x'));

	const sources = await loadIgnoreSources(memory.session);
	assert.deepEqual(
		sources.map((s) => s.base).sort(),
		['/', '/sub'],
		'a nested file must be anchored to its own directory'
	);

	const matcher = await loadIgnoreMatcher(memory.session);
	assert.equal(matcher.ignored('/a.log'), true);
	assert.equal(matcher.ignored('/sub/x.tmp'), true);
	assert.equal(matcher.ignored('/x.tmp'), false, 'a nested rule does not escape its folder');
});

test('the ignore cache is per repo and invalidateIgnore forces a re-read', async () => {
	const memory = memoryDrive('ignores-cache');
	memory.write('/.gitignore', Buffer.from('a.log\n'));

	const first = await loadIgnoreSources(memory.session);
	assert.equal(
		await loadIgnoreSources(memory.session),
		first,
		'a page load plus one PUT must not re-read'
	);

	memory.write('/.gitignore', Buffer.from('b.log\n'));
	assert.equal(
		(await loadIgnoreSources(memory.session))[0].text,
		'a.log\n',
		'within the TTL the old rules hold'
	);

	invalidateIgnore(memory.session.id);
	const after = await loadIgnoreSources(memory.session);
	assert.notEqual(after, first);
	assert.equal(after[0].text, 'b.log\n');
	invalidateIgnore(memory.session.id);
});

test('an unreachable manifest yields no rules instead of throwing', async () => {
	const memory = memoryDrive('ignores-offline');
	memory.drive.manifestShared = async () => {
		throw new Error('no host');
	};
	assert.deepEqual(await loadIgnoreSources(memory.session), []);
	invalidateIgnore(memory.session.id);
});

test('buildIgnore merges shared and local rules, local last so it can override', async () => {
	const memory = memoryDrive('ignores-merge');
	memory.write('/.gitignore', Buffer.from('*.log\nbuild/\n'));

	const matcher = await buildIgnore(memory.session, null as any, [
		{ base: '/', text: '!keep.log\n' }
	]);
	assert.equal(matcher.ignored('/app.log'), true, 'the shared rule still applies');
	assert.equal(
		matcher.ignored('/keep.log'),
		false,
		'the local rule is applied after the shared one'
	);
	assert.equal(matcher.ignored('/build/out.js'), true, 'all shared rules survive the merge');
	invalidateIgnore(memory.session.id);
});

test('buildIgnore still works when the shared side is unreachable', async () => {
	const memory = memoryDrive('ignores-merge-offline');
	memory.drive.manifestShared = async () => {
		throw new Error('no host');
	};
	const matcher = await buildIgnore(memory.session, null as any, [{ base: '/', text: '*.bak\n' }]);
	assert.equal(matcher.ignored('/x.bak'), true);
	invalidateIgnore(memory.session.id);
});

test('formatSummary reports the base counts and only mentions non-zero extras', () => {
	assert.equal(
		formatSummary({ added: 1, updated: 0, deleted: 2, conflicts: 0, skipped: 0, errors: [] }),
		'1 added, 0 updated, 2 deleted'
	);
	assert.equal(
		formatSummary({
			added: 0,
			updated: 0,
			deleted: 0,
			conflicts: 3,
			skipped: 4,
			errors: ['a', 'b']
		}),
		'0 added, 0 updated, 0 deleted, 3 conflicts, 4 local changes not pushed (one-way), 2 errors'
	);
});

function fakeStream() {
	const events = new EventEmitter();
	const writes: Buffer[] = [];
	let calls = 0;
	let allow = true;
	const ws = {
		writes,
		ended: false,
		write(chunk: Buffer) {
			writes.push(Buffer.from(chunk));
			calls++;
			return allow;
		},
		end() {
			ws.ended = true;
			events.emit('close');
		},
		on: events.on.bind(events),
		once: events.once.bind(events),
		off: events.off.bind(events)
	};
	return {
		ws,
		events,
		setAllow(value: boolean) {
			allow = value;
		},
		writes: () => calls
	};
}

const { writeIntoStream } = await import('../src/lib/server/shared-drive.ts');

test('writeIntoStream skips empty chunks and ends the stream', async () => {
	const { ws } = fakeStream();
	await writeIntoStream(
		ws,
		(async function* () {
			yield Buffer.alloc(0);
			yield Buffer.from('a');
			yield Buffer.alloc(0);
			yield Buffer.from('b');
		})()
	);

	assert.deepEqual(
		ws.writes.map((b) => b.toString()),
		['a', 'b']
	);
	assert.equal(ws.ended, true);
});

test('writeIntoStream waits for drain before writing more', async () => {
	const { ws, events, setAllow, writes } = fakeStream();
	setAllow(false);

	let settled = false;
	const done = writeIntoStream(
		ws,
		(async function* () {
			yield Buffer.from('one');
			yield Buffer.from('two');
		})()
	).then(() => (settled = true));

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(writes(), 1, 'a false write must stop the loop until drain');
	assert.equal(settled, false);

	setAllow(true);
	events.emit('drain');
	await done;

	assert.equal(writes(), 2);
	assert.equal(ws.ended, true);
});

test('writeIntoStream surfaces a source error instead of hanging', async () => {
	const { ws } = fakeStream();
	await assert.rejects(
		writeIntoStream(
			ws,
			(async function* () {
				yield Buffer.from('partial');
				throw new Error('read failed');
			})()
		),
		/read failed/
	);
});

test('writeIntoStream rejects when the stream errors after end', async () => {
	const { ws, events } = fakeStream();
	ws.end = () => {
		events.emit('error', new Error('disk full'));
		events.emit('close');
	};
	await assert.rejects(
		writeIntoStream(
			ws,
			(async function* () {
				yield Buffer.from('a');
			})()
		),
		/disk full/
	);
});

test.after(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});
