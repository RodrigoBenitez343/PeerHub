import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { listRepoMeta, forkRepo } from '$lib/server/repos';
import { broadcastAnnouncements, listAnnouncements } from '$lib/server/directory';
import { selfKeyHex } from '$lib/server/users';

// Home = repo dashboard: your repos, the public repos other peers announced, and
// the create/join forms.

const HEX64 = /^[0-9a-f]{64}$/i;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.app) return { repos: [], publicRepos: [], selfKey: '' };
	await locals.app.ready();

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
				forkedFrom: repo.forkedFrom
			};
		})
		.filter((repo): repo is NonNullable<typeof repo> => !!repo)
		.sort((a, b) => a.name.localeCompare(b.name));

	// Announcements we already opened show up under "your repositories" instead.
	const openedKeys = new Set<string>();
	for (const session of sessions.values()) {
		if (session.drive?.key) openedKeys.add(session.drive.key.toString('hex'));
	}

	const publicRepos = announcements
		.filter((entry) => !openedKeys.has(entry.driveKey ?? ''))
		.map((entry) => ({
			peerKey: entry.peerKey,
			owner: entry.peerKey.slice(0, 8),
			repoId: entry.repoId,
			name: entry.name,
			description: entry.description,
			visibility: entry.visibility,
			defaultBranch: entry.defaultBranch,
			driveKey: entry.driveKey,
			metaKey: entry.metaKey,
			openable: entry.visibility === 'public' && !!entry.driveKey
		}));

	return { repos, publicRepos, selfKey: selfKeyHex(locals.app).slice(0, 8) };
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
		await broadcastAnnouncements(locals.app);
		return { error: undefined };
	}
};
