import b4a from 'b4a';
import { randombytes_buf } from 'sodium-native';
import type GhostDriveApp from './app.js';

// The single event stream every PeerHub feature writes into. One append-only
// `activity` row per action feeds the contributions graph, notifications and
// (later) webhooks, so no feature has to hand-roll its own event log.

export type ActivityType =
	'push' | 'issue' | 'pr' | 'review' | 'comment' | 'star' | 'fork' | 'follow';

export interface Activity {
	id: string;
	actorKey: string;
	repoId: string | null;
	type: string;
	refId: string | null;
	ts: number;
}

export interface Notification {
	id: string;
	toKey: string;
	activityId: string;
	read: boolean;
}

function newId(): string {
	const buf = b4a.allocUnsafe(8);
	randombytes_buf(buf);
	return b4a.toString(buf, 'hex');
}

// Same rule as users.ts: never `await app.ready()` here. Activity can be emitted
// while the app is still opening, and ready() would wait on that open forever.
function dbOf(app: GhostDriveApp) {
	if (!app.db) throw new Error('ghost-drive database is not open yet');
	return app.db;
}

export async function emitActivity(
	app: GhostDriveApp,
	ev: {
		actorKey: string;
		repoId?: string | null;
		type: ActivityType | string;
		refId?: string | null;
	}
): Promise<Activity> {
	const db = dbOf(app);
	const activity: Activity = {
		id: newId(),
		actorKey: ev.actorKey,
		repoId: ev.repoId ?? null,
		type: ev.type,
		refId: ev.refId ?? null,
		ts: Date.now()
	};
	await db.insert('@ghostdrive/activities', activity);

	// Fan out to watchers of the repo (a no-op while nobody watches, but the wiring
	// lands now so later features just call emitActivity).
	if (ev.repoId) {
		const watchers = (await db
			.find('@ghostdrive/watch-by-repo', {
				gte: { repoId: ev.repoId },
				lte: { repoId: ev.repoId }
			})
			.toArray()) as Array<{ byKey: string; level: string }>;
		for (const w of watchers) {
			if (w.byKey === ev.actorKey) continue; // never notify the actor
			await db.insert('@ghostdrive/notifications', {
				id: newId(),
				toKey: w.byKey,
				activityId: activity.id,
				read: false
			} satisfies Notification);
		}
	}

	await db.flush();
	return activity;
}

export async function listActivityByActor(
	app: GhostDriveApp,
	actorKey: string
): Promise<Activity[]> {
	return (await dbOf(app)
		.find('@ghostdrive/activity-by-actor', { gte: { actorKey }, lte: { actorKey } })
		.toArray()) as Activity[];
}

export async function listActivityByRepo(app: GhostDriveApp, repoId: string): Promise<Activity[]> {
	return (await dbOf(app)
		.find('@ghostdrive/activity-by-repo', { gte: { repoId }, lte: { repoId } })
		.toArray()) as Activity[];
}

export async function listNotifications(
	app: GhostDriveApp,
	toKey: string
): Promise<Notification[]> {
	return (await dbOf(app)
		.find('@ghostdrive/notification-by-to', { gte: { toKey }, lte: { toKey } })
		.toArray()) as Notification[];
}
