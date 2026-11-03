import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { getUpdates } from '$lib/server/updates';

// Publishing a release into the repo this peer owns.
//
// Two steps, both token-guarded like /api/cli: upload each installer as a raw
// byte stream, then ask for the manifest. The digests in the signed manifest are
// the ones measured while the bytes were written here, so a caller cannot
// advertise a file it did not send.
//
//   curl -X POST --data-binary @PeerHub-Setup.exe \
//        -H "x-peerhub-token: $TOKEN" \
//        "http://127.0.0.1:PORT/api/updates/publish?asset=PeerHub-Setup.exe"
//   curl -X POST -H "x-peerhub-token: $TOKEN" -H 'content-type: application/json' \
//        -d '{"version":"0.2.0","assets":[{"platform":"win32","arch":"x64","name":"PeerHub-Setup.exe"}]}' \
//        http://127.0.0.1:PORT/api/updates/publish
//
// `scripts/publish-release.mjs` does both. The directory the publish runs in is
// sent as `folder` (the script sends its cwd): when that folder is a repo on
// this machine, the release belongs to that repo, so the files land there rather
// than in a store repo the app created earlier under the same name. With no
// folder — or a folder that is not a repo — the configured release repo is used,
// and a publish with none yet creates it (updates.ts `ensureReleaseRepo`).

function requireApp(locals: any) {
	const app = locals.app;
	if (!app) throw error(503, 'PeerHub is not running');
	return app;
}

/** The directory the publisher ran in; both spellings are accepted. */
function publishFolder(url: URL): string | null {
	const value = url.searchParams.get('folder') ?? url.searchParams.get('cwd');
	return value && value.trim() ? value.trim() : null;
}

function requireToken(app: any, request: Request): void {
	const token = request.headers.get('x-peerhub-token');
	if (!app.cliToken || token !== app.cliToken) {
		throw error(401, 'Invalid CLI token — run the command from the same machine as the app');
	}
}

/** Adapt the request body so a repo write can stream it instead of buffering it. */
async function* bodyStream(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value && value.byteLength > 0) yield Buffer.from(value);
		}
	} finally {
		reader.releaseLock();
	}
}

export const GET: RequestHandler = async ({ locals, request, url }) => {
	const app = requireApp(locals);
	await app.ready();
	requireToken(app, request);
	const updates = getUpdates(app);
	const state = updates.snapshot();
	// Resolved, not inferred: the publisher script decides whether to start a
	// large upload from this, so "the repo is there and writable" has to be the
	// answer here rather than something the upload discovers mid-transfer.
	const publish = await updates.publishStatus(publishFolder(url));
	return json({
		ok: true,
		repo: publish.repo,
		writable: publish.writable,
		missing: publish.missing,
		folder: publish.folder,
		settings: state.settings,
		version: state.version
	});
};

export const POST: RequestHandler = async ({ locals, request, url }) => {
	const app = requireApp(locals);
	await app.ready();
	requireToken(app, request);
	const updates = getUpdates(app);

	const asset = url.searchParams.get('asset');
	const folder = publishFolder(url);
	try {
		if (asset) {
			if (!request.body) throw new Error('Upload has no body');
			const record = await updates.publishAsset(asset, bodyStream(request.body), folder);
			return json({ ok: true, asset: record });
		}

		let body: any;
		try {
			body = await request.json();
		} catch {
			throw new Error('Body must be JSON when no asset is named');
		}
		if (!body?.version) throw new Error('version is required');
		const release = await updates.publishRelease({
			version: String(body.version),
			notes: typeof body.notes === 'string' ? body.notes : '',
			assets: Array.isArray(body.assets) ? body.assets : [],
			folder: typeof body.folder === 'string' ? body.folder : folder
		});
		return json({ ok: true, release });
	} catch (err: any) {
		return json({ ok: false, error: err?.message ?? String(err) }, { status: 400 });
	}
};
