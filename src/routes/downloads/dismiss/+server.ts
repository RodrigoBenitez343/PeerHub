import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { downloads } from '$lib/server/downloads';

// Remove a finished (or errored) download from the tray without waiting for the
// auto-clear timer.
export const POST: RequestHandler = async ({ request }) => {
	const { id } = await request.json();
	if (id) downloads.dismiss(String(id));
	return json({ ok: true });
};
