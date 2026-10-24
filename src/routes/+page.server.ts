import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { listRepoMeta, forkRepo } from '$lib/server/repos';
import { isEnhancedRequest, type JobHandle } from '$lib/server/jobs';
import {
	broadcastAnnouncements,
	directoryPeerCount,
	listAnnouncements,
	refreshAnnouncements
} from '$lib/server/directory';
import { selfKeyHex } from '$lib/server/users';

// Home = repo dashboard: your repos, the public repos other peers announced, and
// the create/join forms.

const HEX64 = /^[0-9a-f]{64}$/i;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.app) return { repos: [], publicRepos: [], selfKey: '', peers: 0 };
	await locals.app.ready();

	// Ask connected peers for their lists in the background: an announcement that
	// was missed (peer came back, push lost) shows up on the next render instead
	// of waiting for the Refresh button.
	refreshAnnouncements(locals.app).catch(() => {});

	const catalog = await listRepoMeta(locals.app);
	const announcements = await listAnnouncements(locals.app);
	const sessions = locals.app.sessions as Map<string, any>;

	const repos = catalog
		.map((repo) => {
			const session = sessions.get(repo.id);
			if (!session) return null;
			return {
				id: repo.id,
				name: repo.name,
				description: repo.description,
				visibility: repo.visibility,
				defaultBranch: repo.defaultBranch,
				peers: session.peerCount as number,
				isGuest: session.isGuest as boolean,
				// Owner deleted the repo this is a mirror of: still listed, no longer live.
				sourceRemoved: !!session.sourceRemoved,
				forkedFrom: repo.forkedFrom
			};
		})
		.filter((repo): repo is NonNullable<typeof repo> => !!repo)
		.sort((a, b) => a.name.localeCompare(b.name));

	// A repo you already opened stays in the public list, marked as opened: making
	// it vanish looked like the list was losing entries. The drive key is what
	// both sides agree on.
	const openedByDriveKey = new Map<string, string>();
	for (const session of sessions.values()) {
		if (session.drive?.key) {
			openedByDriveKey.set(session.drive.key.toString('hex'), session.id as string);
		}
	}

	// The public catalogue is "every public repo this peer knows about": your own
	// public repos first, then what peers announced. Leaving your own out made the
	// section look empty on a single machine, where nobody else can announce.
	const ownPublic = repos.filter((repo) => !repo.isGuest && repo.visibility === 'public');
	const ownDriveKeys = new Set<string>();
	for (const repo of ownPublic) {
		const session = sessions.get(repo.id);
		if (session?.drive?.key) ownDriveKeys.add(session.drive.key.toString('hex'));
	}

	const publicRepos = [
		...ownPublic.map((repo) => ({
			key: `own:${repo.id}`,
			name: repo.name,
			description: repo.description,
			visibility: repo.visibility,
			owner: 'you',
			defaultBranch: repo.defaultBranch,
			ownId: repo.id as string | null,
			openedId: null as string | null,
			driveKey: null as string | null,
			metaKey: null as string | null,
			peerKey: '',
			repoId: repo.id,
			openable: false
		})),
		...announcements
			// Something already in "your repositories" is not listed as a stranger's.
			.filter((entry) => !entry.driveKey || !ownDriveKeys.has(entry.driveKey))
			.map((entry) => ({
				key: `${entry.peerKey}:${entry.repoId}`,
				name: entry.name,
				description: entry.description,
				visibility: entry.visibility,
				owner: entry.peerKey.slice(0, 8),
				defaultBranch: entry.defaultBranch,
				ownId: null as string | null,
				openedId: entry.driveKey ? (openedByDriveKey.get(entry.driveKey) ?? null) : null,
				driveKey: entry.driveKey,
				metaKey: entry.metaKey,
				peerKey: entry.peerKey,
				repoId: entry.repoId,
				openable: entry.visibility === 'public' && !!entry.driveKey
			}))
	];

	return {
		repos,
		publicRepos,
		selfKey: selfKeyHex(locals.app).slice(0, 8),
		peers: directoryPeerCount(locals.app)
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: 'Repository name is required' });

		const description = (form.get('description') ?? '').toString().trim();
		const visibility =
			(form.get('visibility') ?? 'public').toString() === 'private' ? 'private' : 'public';
		const defaultBranch = (form.get('defaultBranch') ?? 'main').toString().trim() || 'main';

		const iconFile = form.get('icon') as File | null;
		let icon: Buffer = Buffer.alloc(0);
		if (iconFile && iconFile.size > 0) {
			icon = Buffer.from(new Uint8Array(await iconFile.arrayBuffer()));
		}

		let session;
		try {
			session = await locals.app.createSession({
				name,
				icon,
				description: description || undefined,
				visibility,
				defaultBranch
			});
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		throw redirect(303, `/drive/${session.id}/code`);
	},

	accept: async ({ locals, request }) => {
		const form = await request.formData();
		const url = (form.get('url') ?? '').toString().trim();
		if (!url) return fail(400, { error: 'Invite link is required' });

		let session;
		try {
			session = await locals.app.acceptInvite(url);
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		throw redirect(303, `/drive/${session.id}/code`);
	},

	// Open a public repo read-only, straight from its announcement.
	open: async ({ locals, request }) => {
		const form = await request.formData();
		const driveKey = (form.get('driveKey') ?? '').toString();
		const metaKey = (form.get('metaKey') ?? '').toString();
		const name = (form.get('name') ?? '').toString() || 'Public repo';
		const description = (form.get('description') ?? '').toString();
		const ownerKey = (form.get('ownerKey') ?? '').toString();

		if (!HEX64.test(driveKey)) return fail(400, { error: 'That repo published no drive key' });

		let session;
		try {
			session = await locals.app.openPublicRepo({
				driveKey,
				metaKey: HEX64.test(metaKey) ? metaKey : null,
				name,
				description: description || null,
				ownerKey: HEX64.test(ownerKey) ? ownerKey : undefined
			});
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		throw redirect(303, `/drive/${session.id}/code`);
	},

	fork: async ({ locals, request }) => {
		const form = await request.formData();
		const driveKey = (form.get('driveKey') ?? '').toString();
		const repoId = (form.get('repoId') ?? '').toString();
		const name = (form.get('name') ?? '').toString() || 'fork';
		const description = (form.get('description') ?? '').toString();

		if (!HEX64.test(driveKey)) return fail(400, { error: 'That repo published no drive key' });

		if (isEnhancedRequest(request)) {
			// A fork mirrors the whole repo and can run for a minute; answer with a
			// job so the page stays usable and the button can poll.
			const job = locals.app.jobs.start(
				{ kind: 'fork', label: `Forking ${name}`, repoId },
				async (handle: JobHandle) => {
					const session = await forkRepo(locals.app, {
						repoId,
						name,
						description: description || null,
						driveKey
					});
					handle.progress(1, 1);
					return { repoId: session.id, name: session.name };
				}
			);
			return { jobId: job.id };
		}

		let session;
		try {
			session = await forkRepo(locals.app, {
				repoId,
				name,
				description: description || null,
				driveKey
			});
		} catch (err: any) {
			return fail(400, { error: err.message });
		}
		throw redirect(303, `/drive/${session.id}/code`);
	},

	refresh: async ({ locals }) => {
		// Discovery first: the initial DHT lookup only found peers that had already
		// announced, so this is what actually connects two peers that were both
		// running when they missed each other. Then exchange the lists.
		await locals.app.refreshDirectory().catch(() => {});
		await Promise.all([broadcastAnnouncements(locals.app), refreshAnnouncements(locals.app)]);
		return { error: undefined };
	}
};
