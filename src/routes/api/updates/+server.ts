import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { getUpdates, type UpdateSettings } from '$lib/server/updates';

// State and controls for the self-updater.
//
// One endpoint answers with one object because the desktop shell, the Updates
// page and the CLI all want the same thing: what version is running, what the
// release repo says, how far a download got, and what the user chose.
export const GET: RequestHandler = async ({ locals }) => {
	const app = locals.app;
	if (!app) throw error(503, 'PeerHub is not running');
	await app.ready();
	return json({ ok: true, state: getUpdates(app).snapshot() });
};

const SETTING_KEYS = ['repo', 'autoCheck', 'autoDownload', 'autoInstall'] as const;

function pickSettings(raw: any): Partial<UpdateSettings> {
	const patch: Record<string, unknown> = {};
	if (!raw || typeof raw !== 'object') return patch;
	for (const key of SETTING_KEYS) {
		if (raw[key] !== undefined) patch[key] = raw[key];
	}
	// The pinned signer is changed deliberately, never by a bulk settings save:
	// it is the key every future manifest is checked against.
	if (typeof raw.trustedSigner === 'string' || raw.trustedSigner === null) {
		patch.trustedSigner = raw.trustedSigner;
	}
	return patch as Partial<UpdateSettings>;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const app = locals.app;
	if (!app) throw error(503, 'PeerHub is not running');
	await app.ready();
	const updates = getUpdates(app);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	try {
		switch (body?.action) {
			case 'check':
				return json({ ok: true, state: await updates.check() });
			case 'download':
				// Started, not awaited: a 100MB installer must not hold the request.
				return json({ ok: true, state: updates.startDownload() });
			case 'install':
				updates.requestInstall();
				return json({ ok: true, state: updates.snapshot() });
			case 'installed':
				// The shell consumed the request (successfully or not) and says so,
				// otherwise every poll would try the install again.
				updates.clearInstallRequest();
				return json({ ok: true, state: updates.snapshot() });
			case 'settings':
				updates.updateSettings(pickSettings(body.settings));
				return json({ ok: true, state: updates.snapshot() });
			case 'unpin':
				updates.updateSettings({ trustedSigner: null });
				return json({ ok: true, state: updates.snapshot() });
			default:
				return json({ ok: false, error: `Unknown action: ${body?.action}` }, { status: 400 });
		}
	} catch (err: any) {
		return json({ ok: false, error: err?.message ?? String(err) }, { status: 400 });
	}
};
