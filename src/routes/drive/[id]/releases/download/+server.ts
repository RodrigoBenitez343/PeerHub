import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { getSession } from '$lib/server/loaders';
import { getUpdates } from '$lib/server/updates';
import type { ReleaseFile } from '$lib/server/updates';
import { isReleaseStorePath } from '$lib/server/paths';

// Download one file out of a repo's release store.
//
//   /drive/<id>/releases/download?path=/release/assets/PeerHub Setup 0.1.7.exe
//
// Only store paths are served, so this route cannot become a second, unlisted
// way to read repo files. The bytes come from the content drive — the one whose
// blocks replicate — instead of the shared drive the generic file API reads
// through.
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const session = await getSession(locals.app, params.id);
	const filePath = url.searchParams.get('path') ?? '';
	if (!isReleaseStorePath(filePath)) throw error(404, 'Not a release file');

	const name = filePath.split('/').pop() || 'download';
	let opened: ReleaseFile;
	try {
		opened = await getUpdates(locals.app).openReleaseFile(session, filePath);
	} catch (err: any) {
		throw error(404, err?.message ?? 'File not found');
	}

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of opened.stream) {
					controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				}
				controller.close();
			} catch (err: any) {
				// A peer that goes away mid-download fails the response instead of
				// leaving the browser waiting for bytes that will never come.
				controller.error(err);
			}
		}
	});

	return new Response(body, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(opened.size),
			'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
			'cache-control': 'no-store'
		}
	});
};
