#!/usr/bin/env node
// PeerHub CLI. Talks to the running app over localhost HTTP; it never opens the
// corestore itself, so the app stays the only writer.
//
// The installed desktop app puts this file behind the `ph` (and `peerhub`)
// command, so no Node install is needed: `ELECTRON_RUN_AS_NODE=1` runs it.
//
//   peerhub status
//   peerhub commit -m "what changed"
//   peerhub log [-n 20]
//   peerhub show <sha>
//   peerhub restore <sha> [paths...] [--dry-run]
//   peerhub sync [--push]
//   peerhub direction one-way|two-way
//   peerhub auto on|off [--commit]
//   peerhub repos
//   peerhub create <name> [--path .] [--private]
//   peerhub rm <path>
//   peerhub ping
//
// Run it from inside a folder linked to a repo (the app's Settings tab links
// folders, `peerhub create` links one for you).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { dataDir } from '../shared/data-dir.js';

const USAGE = `peerhub — talk to your running PeerHub from the terminal

  status                     tracked / modified / untracked files
  commit -m <msg>            push local changes to the repo and record a commit
  log [-n <count>]           commit history with changelists
  show <sha>                 one commit and what it changed
  restore <sha> [paths...]   write that commit's files back locally
      --dry-run              report what would change, write nothing
  sync [--push]              reconcile the linked folder with the repo now
      --push                 also push local changes (one run, folder stays one-way)
  direction one-way|two-way  how the linked folder is allowed to move
  auto on|off [--commit]     periodic sync; --commit keeps a changelist per pass
  repos                      repositories and their linked folders
  create <name> [--path d]   create a repo and link a folder to it
      [--private]
  init [name]                create a repo for this folder (name defaults to it)
  rm <path>                  delete a path locally and in the repo
  ping                       is the app running (and does the token work)

Global flags: --json (raw output), --url <url> (default: the running app's URL, else http://localhost:5173)`;

function token() {
	const fromEnv = process.env.PEERHUB_TOKEN;
	if (fromEnv) return fromEnv;
	const file = path.join(dataDir(), '.cli-token');
	try {
		return fs.readFileSync(file, 'utf8').trim();
	} catch {
		fail(
			`No CLI token at ${file}.\n` +
				'Start the app once (run.bat / run.sh / npm run desktop); it writes the token on boot.'
		);
	}
}

// The desktop app picks a random loopback port and writes it to `.cli-url`
// (`url`, then its pid) on boot, so the CLI finds the running instance without
// being told. An explicit --url wins, then PEERHUB_URL, then the file, then the
// dev-server default. A file whose process is gone is ignored and cleaned up:
// a hard kill skips the app's own cleanup.
function resolveEndpoint(override) {
	if (override) return override;
	if (process.env.PEERHUB_URL) return process.env.PEERHUB_URL;

	const file = path.join(dataDir(), '.cli-url');
	try {
		const [fromApp, pid] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
		if (fromApp) {
			if (pid && !processAlive(Number(pid))) {
				try {
					fs.unlinkSync(file);
				} catch {}
			} else {
				return fromApp;
			}
		}
	} catch {
		// No running desktop app.
	}
	return 'http://localhost:5173';
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true; // No pid recorded: trust it.
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === 'EPERM'; // Exists, owned by someone else.
	}
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseArgs(argv) {
	const flags = {
		json: false,
		dryRun: false,
		private: false,
		commit: false,
		push: false,
		limit: null
	};
	const positional = [];
	let url = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--json') flags.json = true;
		else if (arg === '--dry-run') flags.dryRun = true;
		else if (arg === '--private') flags.private = true;
		else if (arg === '--commit') flags.commit = true;
		else if (arg === '--push') flags.push = true;
		else if (arg === '--url') url = argv[++i];
		else if (arg === '-m' || arg === '--message') flags.message = argv[++i];
		else if (arg === '-n') flags.limit = Number(argv[++i]);
		else if (arg === '--path') flags.path = argv[++i];
		else if (arg === '-h' || arg === '--help') flags.help = true;
		else positional.push(arg);
	}

	return { flags, positional, url };
}

async function call(url, method, payload) {
	const headers = { 'x-peerhub-token': token() };
	let body;
	if (payload) {
		headers['content-type'] = 'application/json';
		body = JSON.stringify(payload);
	}

	let res;
	try {
		res = await fetch(url + '/api/cli', { method, headers, body });
	} catch (err) {
		fail(
			`Cannot reach PeerHub at ${url} (${err?.message ?? err}).\n` +
				'Is the app running? Start it with run.bat / run.sh / npm run dev.'
		);
	}

	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* not json */
	}

	if (!res.ok) {
		const reason = json?.error?.message ?? json?.error ?? text.slice(0, 200);
		fail(`PeerHub: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
	}

	if (json?.ok === false) fail(`PeerHub: ${json.error}`);
	return json;
}

// --- human output ---

const STATUS_MARK = { added: 'UNTracked', modified: 'modified ', removed: 'deleted  ' };

function when(ts) {
	const date = new Date(ts);
	return date.toISOString().replace('T', ' ').slice(0, 16);
}

function printStatus(result, cwd) {
	const lines = [];
	lines.push(`Repository  ${result.repo.name}  (${result.repo.id})`);
	lines.push(`Folder      ${result.repo.path}`);
	lines.push(`Branch      ${result.repo.branch}`);
	lines.push(
		`Direction   ${result.direction === 'two-way' ? 'two-way (may push)' : 'one-way (receives only)'}`
	);
	lines.push(
		result.head
			? `HEAD        ${result.head.short}  ${result.head.message}  (${when(result.head.ts)})`
			: 'HEAD        no commits yet'
	);
	lines.push('');

	if (result.clean) {
		lines.push('Nothing to commit — the folder matches HEAD.');
	} else {
		const group = (label, status) => {
			const rows = result.changes.filter((change) => change.status === status);
			if (rows.length === 0) return;
			lines.push(`${label} (${rows.length})`);
			for (const row of rows) lines.push(`  ${STATUS_MARK[status]}  ${row.path}`);
			lines.push('');
		};
		group('Untracked — not in the repo yet', 'added');
		group('Modified — tracked, changed on disk', 'modified');
		group('Deleted — tracked, gone from disk', 'removed');
		lines.push('Commit with: peerhub commit -m "..."');
		if (result.direction !== 'two-way') {
			lines.push('');
			lines.push('This folder is one-way: these changes are local only.');
			lines.push('Push them with: peerhub commit -m "..."  (or: peerhub direction two-way)');
			if (!result.canPush) {
				lines.push('The repo owner has not enabled peer writes, so a push will be refused.');
			}
		}
	}

	if (result.repo.path !== cwd && !cwd.startsWith(result.repo.path)) {
		lines.push('');
		lines.push(`note: run from ${result.repo.path} to keep paths relative to the folder`);
	}
	console.log(lines.join('\n'));
}

function printLog(entries) {
	if (entries.length === 0) return console.log('No commits yet.');
	for (const entry of entries) {
		const counts = entry.changes.reduce((acc, change) => {
			acc[change.status[0]] = (acc[change.status[0]] ?? 0) + 1;
			return acc;
		}, {});
		const summary = `+${counts.a ?? 0} ~${counts.m ?? 0} -${counts.r ?? 0}`;
		console.log(`${entry.short}  ${when(entry.ts)}  ${summary.padEnd(12)}  ${entry.message}`);
	}
}

function printShow(entry) {
	console.log(`commit ${entry.sha}${entry.parent ? ` (parent ${entry.parent})` : ' (root)'}`);
	console.log(`author ${entry.author}`);
	console.log(`date   ${when(entry.ts)}`);
	console.log('');
	console.log(`    ${entry.message}`);
	console.log('');
	if (entry.changes.length === 0) {
		console.log('(no file changes recorded)');
		return;
	}
	console.log(`${entry.changes.length} file(s) changed`);
	for (const change of entry.changes) {
		const code = change.status === 'added' ? 'A' : change.status === 'modified' ? 'M' : 'D';
		console.log(`  ${code}  ${change.path}`);
	}
}

function printRestore(result) {
	console.log(`${result.dryRun ? 'Would restore' : 'Restoring'} ${result.short}:`);
	for (const action of result.actions) {
		const label =
			action.action === 'restored'
				? 'restored'
				: action.action === 'deleted'
					? 'deleted '
					: 'skipped ';
		console.log(`  ${label}  ${action.path}${action.reason ? `  (${action.reason})` : ''}`);
	}
	if (!result.dryRun) {
		console.log('');
		console.log(
			'Files written. Run `peerhub status` to see the diff, then commit if you want it in the repo.'
		);
	}
}

function printSummary(summary) {
	console.log(
		`sync: +${summary.added} ~${summary.updated} -${summary.deleted}` +
			(summary.conflicts ? ` conflicts:${summary.conflicts}` : '') +
			(summary.skipped ? ` local-only:${summary.skipped}` : '')
	);
	if (summary.skipped) {
		console.log('  these changes stayed local — the folder is one-way (peerhub direction two-way)');
	}
	for (const error of summary.errors ?? []) console.log(`  error: ${error}`);
}

// --- main ---

const { flags, positional, url: urlOverride } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = positional;
const cwd = process.cwd();
const url = resolveEndpoint(urlOverride);

if (flags.help || !cmd || cmd === 'help') {
	console.log(USAGE);
	process.exit(cmd || flags.help ? 0 : 1);
}

const send = async (payload, print) => {
	const response = await call(url, 'POST', { cwd, ...payload });
	if (flags.json) {
		console.log(JSON.stringify(response.result, null, 2));
		return;
	}
	print(response.result);
};

switch (cmd) {
	case 'ping': {
		const response = await call(url, 'GET');
		console.log(
			flags.json
				? JSON.stringify(response, null, 2)
				: `PeerHub is running · ${response.repos} repo(s) · key ${String(response.key).slice(0, 12)}…`
		);
		break;
	}

	case 'status':
		await send({ cmd: 'status' }, (result) => printStatus(result, cwd));
		break;

	case 'commit': {
		const message = flags.message ?? rest.join(' ');
		await send({ cmd: 'commit', message }, (result) => {
			if (result.sync) printSummary(result.sync);
			console.log(`[${result.short}] ${result.message}`);
			for (const change of result.changes) {
				const code = change.status === 'added' ? 'A' : change.status === 'modified' ? 'M' : 'D';
				console.log(`  ${code}  ${change.path}`);
			}
		});
		break;
	}

	case 'log':
		await send({ cmd: 'log', limit: flags.limit ?? 20 }, printLog);
		break;

	case 'show':
		if (!rest[0]) fail('usage: peerhub show <sha>');
		await send({ cmd: 'show', sha: rest[0] }, printShow);
		break;

	case 'restore': {
		const [sha, ...paths] = rest;
		if (!sha) fail('usage: peerhub restore <sha> [paths...] [--dry-run]');
		await send({ cmd: 'restore', sha, paths, dryRun: flags.dryRun }, printRestore);
		break;
	}

	case 'sync':
		await send({ cmd: 'sync', push: flags.push }, printSummary);
		break;

	case 'direction': {
		const wanted = rest[0];
		if (wanted !== 'one-way' && wanted !== 'two-way') {
			fail('usage: peerhub direction one-way|two-way');
		}
		await send(
			{ cmd: 'direction', direction: wanted === 'two-way' ? 'two-way' : 'pull' },
			(result) => {
				console.log(
					result.direction === 'two-way'
						? `${result.pair} — two-way: local changes can be pushed`
						: `${result.pair} — one-way: receives changes only`
				);
			}
		);
		break;
	}

	case 'auto': {
		const mode = rest[0] === 'off' ? 'off' : 'on';
		await send({ cmd: 'auto', mode, commit: flags.commit }, (result) => {
			console.log(
				result.auto
					? `auto sync ON for ${result.pair}` +
							(result.autoCommit ? ' — every pass that moves files records a commit' : '')
					: 'auto sync OFF'
			);
		});
		break;
	}

	case 'repos':
		await send({ cmd: 'repos' }, (repos) => {
			if (repos.length === 0) return console.log('No repositories yet.');
			for (const repo of repos) {
				const head = repo.head ?? 'no commits';
				const where = repo.pairs.length ? repo.pairs.join(', ') : '(not linked to a folder)';
				console.log(
					`${repo.name}  [${repo.visibility}]  ${repo.writeMode === 'peers' ? 'two-way' : 'one-way'}  ${head}  peers:${repo.peers}`
				);
				console.log(`  ${repo.id}`);
				console.log(`  ${where}`);
			}
		});
		break;

	case 'create':
	case 'init': {
		// `init` is the git-shaped spelling: no arguments, the folder names the
		// repo. `create` keeps requiring a name, so a typo cannot silently make
		// a repo called after whatever directory the terminal happened to be in.
		const name = rest[0] ?? (cmd === 'init' ? path.basename(cwd) : null);
		if (!name) fail('usage: peerhub create <name> [--path <folder>] [--private]');
		await send(
			{
				cmd: 'create',
				name,
				dir: flags.path ? path.resolve(flags.path) : cwd,
				visibility: flags.private ? 'private' : 'public'
			},
			(result) => {
				console.log(`Created ${result.name} (${result.id})`);
				console.log(`Linked   ${result.path}`);
				console.log(`Synced   ${result.files} file(s)`);
				console.log('Next: peerhub commit -m "initial commit"');
			}
		);
		break;
	}

	case 'rm':
		if (!rest[0]) fail('usage: peerhub rm <path>');
		await send({ cmd: 'rm', paths: [rest[0]] }, (result) => {
			console.log(result.removed ? `removed ${result.path}` : `${result.path} was not present`);
		});
		break;

	default:
		fail(`Unknown command: ${cmd}\n\n${USAGE}`);
}
