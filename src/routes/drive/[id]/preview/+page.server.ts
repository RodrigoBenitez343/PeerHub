import type { Actions, PageServerLoad } from './$types';
import { error, fail } from '@sveltejs/kit';
import { pickerAvailable } from 'ghost-picker';
import { downloads } from '$lib/server/downloads';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.app?.opened) await locals.app?.ready?.();

	const session = locals.app.getSession(params.id);
	if (!session) {
		console.warn(
			`[preview] 404: session ${params.id} not found. Available: [${[...locals.app.sessions.keys()].join(', ')}]`
		);
		throw error(404, 'Drive not found');
	}

	const filePath = url.searchParams.get('file')?.replaceAll('+', ' ');
	if (!filePath) throw error(400, 'Missing file');

	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	const kind = detectKind(ext);

	console.log(
		`[preview] looking up entry '${filePath}' — session=${params.id}, drives=${session.drive.drives.length}, drive-types=[${session.drive.drives.map((d: any) => d.constructor?.name || 'unknown').join(', ')}], peers=${session.drive.peers}`
	);

	const entry = await session.drive.entry(filePath);
	if (!entry) {
		if (session.isGuest && session.peerCount === 0) {
			return {
				drive: { id: session.id, name: session.name },
				path: filePath,
				kind,
				textPreview: null,
				isBinary: false,
				isEmpty: false,
				cached: false,
				unavailable: true,
				canPickDownload: pickerAvailable()
			};
		}
		// Extra diagnostic: try each drive individually
		for (let i = 0; i < session.drive.drives.length; i++) {
			const d = session.drive.drives[i];
			try {
				const e = await d.entry(filePath);
				console.warn(
					`[preview]   drive[${i}] (${d.constructor?.name}, root=${d.root || 'n/a'}): entry=${e ? 'found' : 'null'}`
				);
			} catch (err: any) {
				console.warn(`[preview]   drive[${i}] (${d.constructor?.name}): threw ${err.message}`);
			}
		}
		console.warn(
			`[preview] 404: entry not found for ${filePath} in session ${params.id}, drives: ${session.drive.drives.length}, peers: ${session.drive._peers?.size ?? '?'}`
		);
		throw error(404, 'File not found');
	}

	let textPreview: string | null = null;
	let isBinary = false;
	let isEmpty = true;

	if (kind === 'text') {
		const size = entry.value?.blob?.byteLength ?? 0;
		if (size > 0) {
			isEmpty = false;

			for await (const head of session.drive.createReadStream(filePath, {
				start: 0,
				end: Math.min(size - 1, 8191)
			})) {
				if (!head || head.length === 0) {
					isEmpty = true;
					break;
				}

				if (containsNullByte(head)) {
					isBinary = true;
				} else {
					try {
						const fullSize = Math.min(size, 256 * 1024); // cap text preview at 256KB
						let all = head;

						if (fullSize > head.length) {
							for await (const chunk of session.drive.createReadStream(filePath, {
								start: 0,
								end: fullSize - 1
							})) {
								if (chunk && chunk.length > 0) all = Buffer.concat([all, chunk]);
							}
						}

						textPreview = all.toString('utf-8');
						if ((textPreview as string).includes('�')) {
							isBinary = true;
							textPreview = null;
						}
					} catch {
						isBinary = true;
					}
				}
			}
		}
	}

	let cached = false;
	try {
		const c = await session.cache.entry(filePath);
		cached = !!c;
	} catch {}

	return {
		drive: { id: session.id, name: session.name },
		path: filePath,
		kind,
		textPreview,
		isBinary,
		isEmpty,
		cached,
		unavailable: false,
		canPickDownload: pickerAvailable()
	};
};

export const actions: Actions = {
	cache: async ({ locals, params, request }) => {
		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const filePath = (form.get('file') ?? '').toString();
		if (!filePath) return fail(400, { error: 'Missing file' });

		try {
			await session.cacheFile(filePath);
		} catch (err: any) {
			return fail(500, { error: err.message });
		}
		return {};
	},

	download: async ({ locals, params, request }) => {
		if (!pickerAvailable()) return fail(400, { error: 'Download not supported on this platform' });

		const session = locals.app.getSession(params.id);
		if (!session) throw error(404, 'Drive not found');

		const form = await request.formData();
		const filePath = (form.get('file') ?? '').toString();
		if (!filePath) return fail(400, { error: 'Missing file' });

		// Runs in the background; progress is reported over /downloads/stream.
		downloads.start(session, filePath);
		return { started: true };
	}
};

function detectKind(ext: string): 'video' | 'audio' | 'image' | 'text' | 'binary' {
	if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
	if (['mp3', 'flac', 'ogg', 'wav', 'aac', 'm4a'].includes(ext)) return 'audio';
	if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
	if (
		[
			'txt',
			'md',
			'json',
			'js',
			'ts',
			'html',
			'css',
			'sh',
			'py',
			'go',
			'rs',
			'yml',
			'yaml',
			'log'
		].includes(ext)
	)
		return 'text';
	return 'binary';
}

function containsNullByte(buf: Buffer) {
	for (let i = 0; i < buf.length && i < 8192; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}
