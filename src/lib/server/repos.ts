import b4a from 'b4a';
import Hyperdrive from 'hyperdrive';
import type PeerHubApp from './app.js';
import type DriveSession from './session.js';
import { selfKeyHex } from './users.js';

// A repository is a shared drive (DriveSession) plus a replicated metadata log and a
// catalog row (`@ghostdrive/repos`) that makes the session addressable as a repo: owner,
// visibility, description, default branch. The per-repo metadata db itself lives on the
// DriveSession (session.ts `meta`), keyed by the same schema so commits/issues/PRs/stars
// replicate with the repo's content.

export interface RepoMeta {
	id: string;
	ownerKey: string;
	name: string;
	description: string | null;
	visibility: string; // 'public' | 'private'
	defaultBranch: string;
	topics: string | null; // serialized list
	createdAt: number;
	forkedFrom: string | null; // repo id of the source repo
	sourceKey: string | null; // hex drive key of the source repo
	// 'owner' (default) = one-way: peers replicate, only the owner writes.
	// 'peers' = two-way: peers may push back. See session.setWriteMode().
	writeMode: string | null;
}

// Write the catalog row for a session. Called from app.createSession / acceptInvite.
export async function registerRepo(
	app: PeerHubApp,
	session: DriveSession,
	meta: {
		description?: string;
		visibility?: string;
		defaultBranch?: string;
		ownerKey?: string;
		writeMode?: 'owner' | 'peers';
	}
): Promise<RepoMeta> {
	const rec: RepoMeta = {
		id: session.id,
		ownerKey: meta.ownerKey ?? b4a.toString(app.key!, 'hex'),
		name: session.name,
		description: meta.description ?? null,
		visibility: meta.visibility ?? 'public',
		defaultBranch: meta.defaultBranch ?? 'main',
		topics: null,
		createdAt: Date.now(),
		forkedFrom: null,
		sourceKey: null,
		// One-way unless asked otherwise, including for a mirror opened from a
		// public announcement: the owner's announcement/RPC decides, not this row.
		writeMode: meta.writeMode ?? 'owner'
	};
	await app.db!.insert('@ghostdrive/repos', rec);
	await app.db!.flush();
	return rec;
}

export async function getRepoMeta(app: PeerHubApp, id: string): Promise<RepoMeta | null> {
	await app.ready();
	return (await app.db!.get('@ghostdrive/repos', { id })) as RepoMeta | null;
}

export async function listRepoMeta(app: PeerHubApp): Promise<RepoMeta[]> {
	await app.ready();
	return (await app.db!.find('@ghostdrive/repos', { gte: {}, lte: {} }).toArray()) as RepoMeta[];
}

export async function listReposByOwner(app: PeerHubApp, ownerKey: string): Promise<RepoMeta[]> {
	await app.ready();
	return (await app
		.db!.find('@ghostdrive/repos-by-owner', { gte: { ownerKey }, lte: { ownerKey } })
		.toArray()) as RepoMeta[];
}

// Patch an existing catalog row (upsert on the same id).
export async function updateRepo(
	app: PeerHubApp,
	id: string,
	patch: Partial<RepoMeta>
): Promise<RepoMeta | null> {
	const existing = await getRepoMeta(app, id);
	if (!existing) return null;
	const next = { ...existing, ...patch, id };
	await app.db!.insert('@ghostdrive/repos', next);
	await app.db!.flush();
	return next;
}

// --- Forking ---

// A fork is a new local repo whose files are mirrored from the source drive,
// plus a `forkedFrom` pointer on its catalog row. Mirroring needs the source
// peer to be online: if it is not, the half-made repo is removed and the caller
// gets an error instead of an empty fork (project rule: never fail silently).
const FORK_TIMEOUT = 45_000;

export async function forkRepo(
	app: PeerHubApp,
	source: {
		repoId: string;
		name: string;
		description?: string | null;
		driveKey: string;
		/** Key of the drive that holds the source's content. */
		contentKey?: string | null;
	}
): Promise<DriveSession> {
	if (!source.driveKey || !/^[0-9a-f]{64}$/i.test(source.driveKey)) {
		throw new Error('This repo did not publish a drive key — fork needs a public repo');
	}
	if (!source.contentKey || !/^[0-9a-f]{64}$/i.test(source.contentKey)) {
		// Copying files needs the content drive; without its key a fork would be an
		// empty repo wearing the source's name, so refuse instead of pretending.
		throw new Error(
			'This repo did not publish a content key — the source peer has to run a PeerHub that shares repo content'
		);
	}

	const session = await app.createSession({
		name: source.name,
		description: source.description ?? undefined,
		visibility: 'public'
	});

	try {
		if (!session.content) throw new Error('This peer cannot hold repo content yet');

		// A content core can only be open in one session, so an already-open mirror is
		// reused; otherwise the source drive is opened just for this copy and closed.
		const already = [...app.sessions.values()].find(
			(candidate) =>
				candidate !== session && candidate.contentKeyHex === source.contentKey
		);

		const copy = async (from: any) => {
			const timeout = new Promise((_, reject) => {
				const timer = setTimeout(
					() => reject(new Error('Source peer is offline — cannot copy the files')),
					FORK_TIMEOUT
				);
				timer.unref?.();
			});
			await Promise.race([from.mirror(session.content).done(), timeout]);
		};

		if (already?.content) {
			await copy(already.content);
		} else {
			const hd = new Hyperdrive(app.store!.session(), b4a.from(source.contentKey, 'hex'));
			await hd.ready();
			try {
				await copy(hd);
			} finally {
				await hd.close().catch(() => {});
			}
		}
	} catch (err) {
		await app.removeSession(session.id).catch(() => {});
		throw err;
	}

	await updateRepo(app, session.id, {
		forkedFrom: source.repoId,
		sourceKey: source.driveKey
	});

	// Fork row lives in the new repo's metadata: the source repo's log belongs to
	// its owner, so attribution is recorded on the copy.
	await session
		.putMeta('@ghostdrive/forks', {
			byKey: selfKeyHex(app),
			repoId: session.id,
			parentRepoId: source.repoId,
			newRepoId: session.id,
			ts: Date.now()
		})
		.catch(() => {});

	return session;
}
