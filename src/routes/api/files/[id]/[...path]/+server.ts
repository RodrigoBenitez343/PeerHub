import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { invalidateEntries } from '$lib/server/loaders';

const CHUNK_SIZE = 1024 * 1024; // 1MB

const MIME: Record<string, string> = {
	mp4: 'video/mp4',
	mkv: 'video/x-matroska',
	avi: 'video/x-msvideo',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mp3: 'audio/mpeg',
	flac: 'audio/flac',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
	txt: 'text/plain; charset=utf-8',
	md: 'text/plain; charset=utf-8',
	html: 'text/html; charset=utf-8',
	json: 'application/json; charset=utf-8'
};

function mimeFor(filePath: string) {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	return MIME[ext] || 'application/octet-stream';
}

function filePathOf(params: { path?: string }): string {
	return '/' + (params.path ?? '').replaceAll('+', ' ');
}

// Uploads arrive as a request body; hand the drive a stream so large files are
// never buffered in memory. Runtimes that hide the stream can still fall back
// to the buffered body.
async function* readBody(request: Request): AsyncGenerator<Buffer> {
	const body: any = (request as any).body;

	if (body && typeof body.getReader === 'function') {
		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value?.byteLength) {
					yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				}
			}
		} finally {
			reader.releaseLock?.();
		}
		return;
	}

	if (body && typeof body[Symbol.asyncIterator] === 'function') {
		for await (const chunk of body) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (buf.byteLength) yield buf;
		}
		return;
	}

	const buffered = Buffer.from(await request.arrayBuffer());
	if (buffered.byteLength) yield buffered;
}

export const GET: RequestHandler = async ({ locals, params, request, url }) => {
	if (!locals.app?.opened) await locals.app?.ready?.();

	const session = locals.app.getSession(params.id);
	if (!session) {
		console.warn(
			`[file-api] 404: session ${params.id} not found. Available: [${[...locals.app.sessions.keys()].join(', ')}]`
		);
		throw error(404, 'Drive not found');
	}

	const filePath = ('/' + (params.path ?? '')).replaceAll('+', ' ');
	console.log(
		`[file-api] looking up entry '${filePath}' — session=${params.id}, drives=${session.drive.drives.length}, drive-types=[${session.drive.drives.map((d: any) => d.constructor?.name || 'unknown').join(', ')}]`
	);

	const entry = await session.drive.entry(filePath);
	if (!entry) {
		// Extra diagnostic: try each drive individually
		for (let i = 0; i < session.drive.drives.length; i++) {
			const d = session.drive.drives[i];
			try {
				const e = await d.entry(filePath);
				console.warn(
					`[file-api]   drive[${i}] (${d.constructor?.name}, root=${d.root || 'n/a'}): entry=${e ? 'found' : 'null'}`
				);
			} catch (err: any) {
				console.warn(`[file-api]   drive[${i}] (${d.constructor?.name}): threw ${err.message}`);
			}
		}
		console.warn(
			`[file-api] 404: entry not found for ${filePath} in session ${params.id}, drives: ${session.drive.drives.length}`
		);
		throw error(404, 'File not found');
	}

	const size: number | null = entry.value?.blob?.byteLength ?? null;
	const mime = mimeFor(filePath);
	const filename = filePath.split('/').pop() || 'file';
	const isDownload = url.searchParams.get('dl') === '1';

	let start = 0;
	let end = size ? size - 1 : 0;
	let partial = false;

	const range = request.headers.get('range');
	if (range && size) {
		const m = /bytes=(\d+)-(\d*)/.exec(range);
		if (m) {
			start = parseInt(m[1], 10);
			end = m[2] ? parseInt(m[2], 10) : Math.min(start + CHUNK_SIZE - 1, size - 1);
			partial = true;
		}
	}

	const length = end - start + 1;

	const headers: Record<string, string> = { 'Content-Type': mime };
	if (size) {
		headers['Content-Length'] = String(length);
		headers['Accept-Ranges'] = 'bytes';
	}
	if (partial) {
		headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
	}
	if (isDownload) {
		headers['Content-Disposition'] = `attachment; filename="${filename}"`;
	}

	const drive = session.drive;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			for await (const head of drive.createReadStream(filePath, { start, end: end + 1 })) {
				controller.enqueue(new Uint8Array(head.buffer, head.byteOffset, head.byteLength));
			}
			controller.close();
		}
	});

	return new Response(stream, { status: partial ? 206 : 200, headers });
};

// Write a file into the shared file system (create or overwrite). Applies to
// whichever peer holds the session: guests forward the bytes to the host.
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.app?.opened) await locals.app?.ready?.();

	const session = locals.app.getSession(params.id);
	if (!session) throw error(404, 'Drive not found');
	if (!session.canWrite) throw error(409, 'Not connected to the host');

	try {
		await session.putFile(filePathOf(params), readBody(request));
	} catch (err: any) {
		throw error(500, err?.message ?? 'Upload failed');
	}

	invalidateEntries(params.id);
	return json({ ok: true });
};

// Remove a file from the shared file system.
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.app?.opened) await locals.app?.ready?.();

	const session = locals.app.getSession(params.id);
	if (!session) throw error(404, 'Drive not found');
	if (!session.canWrite) throw error(409, 'Not connected to the host');

	try {
		await session.deleteFile(filePathOf(params));
	} catch (err: any) {
		throw error(500, err?.message ?? 'Delete failed');
	}

	invalidateEntries(params.id);
	return json({ ok: true });
};
