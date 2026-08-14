import type { RequestHandler } from './$types';
import { downloads } from '$lib/server/downloads';

// Server-Sent Events for background download progress. Emits a `downloads`
// event carrying the full list on every change (start, progress, done, error).
export const GET: RequestHandler = async () => {
	const enc = new TextEncoder();
	const frame = (data: unknown) =>
		enc.encode(`event: downloads\ndata: ${JSON.stringify(data)}\n\n`);

	let unsubscribe: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(frame(downloads.list()));
			controller.enqueue(enc.encode(': connected\n\n'));

			unsubscribe = downloads.subscribe(() => {
				try {
					controller.enqueue(frame(downloads.list()));
				} catch {
					unsubscribe?.();
				}
			});
		},
		cancel() {
			unsubscribe?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
