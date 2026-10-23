const Hyperschema = require('hyperschema');
const HyperDB = require('hyperdb/builder');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, 'spec', 'hyperschema');
const DB_DIR = path.join(__dirname, 'spec', 'hyperdb');

// --- Hyperschema structs ---
const schema = Hyperschema.from(SCHEMA_DIR);
const ns = schema.namespace('ghostdrive');

ns.register({
	name: 'session',
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'name', type: 'string', required: true },
		{ name: 'icon', type: 'buffer', required: true }, // raw image bytes, rendered as base64 data URI
		{ name: 'createdAt', type: 'uint', required: true },
		{ name: 'remoteKey', type: 'string' }, // hex key of remote drive (guest sessions only)
		{ name: 'lastOpened', type: 'uint' },
		// Appended, never reordered: hyperschema identifies fields by position.
		{ name: 'metaKey', type: 'string' } // hex key of the repo metadata core (guest sessions only)
	]
});

ns.register({
	name: 'registration',
	fields: [
		{ name: 'sessionId', type: 'string', required: true },
		{ name: 'target', type: 'string', required: true }, // local path or hyperdrive hex key
		{ name: 'type', type: 'string', required: true }, // 'local' | 'hyperdrive'
		{ name: 'createdAt', type: 'uint', required: true }
	]
});

ns.register({
	name: 'invite',
	fields: [
		{ name: 'sessionId', type: 'string', required: true },
		{ name: 'capKey', type: 'string', required: true }, // hex-encoded 32-byte capability key
		{ name: 'used', type: 'bool', required: true },
		{ name: 'createdAt', type: 'uint', required: true }
	]
});

ns.register({
	name: 'join',
	fields: [
		{ name: 'sessionId', type: 'string', required: true },
		{ name: 'peerKey', type: 'string', required: true }, // hex-encoded remote public key
		{ name: 'capKey', type: 'string', required: true }, // hex-encoded capability key used
		{ name: 'createdAt', type: 'uint', required: true }
	]
});

ns.register({
	name: 'user', // device identity -> human profile, replicated on a directory topic
	fields: [
		{ name: 'peerKey', type: 'string', required: true }, // hex corestore public key
		{ name: 'handle', type: 'string', required: true },
		{ name: 'displayName', type: 'string' },
		{ name: 'bio', type: 'string' },
		{ name: 'avatar', type: 'buffer', required: true }, // raw image bytes, data-URI rendered
		{ name: 'kind', type: 'string' }, // 'user' | 'org'
		{ name: 'joinedAt', type: 'uint', required: true }
	]
});

// NOTE: existing session/registration/invite/join structs are the P2P file-share
// core and are kept as-is (additive refactor, per spec/PEERHUB_MVP.md). Everything
// below are the PeerHub GitHub-feature records: repos, git objects, issue/PR
// tracker, reviews, social graph, activity/notifications. List-shaped values
// (topics, labelIds, treeDigest, events) are stored as serialized strings to keep
// to primitive types and match the existing schema style. Register changes here and
// run `npm run build:schema`; never hand-edit spec/hyperdb/* or spec/hyperschema/*.

ns.register({
	name: 'repo', // extends the session/drive concept into a repository
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'ownerKey', type: 'string', required: true }, // hex corestore public key
		{ name: 'name', type: 'string', required: true },
		{ name: 'description', type: 'string' },
		{ name: 'visibility', type: 'string' }, // 'public' | 'private'
		{ name: 'defaultBranch', type: 'string' },
		{ name: 'topics', type: 'string' }, // serialized list
		{ name: 'createdAt', type: 'uint', required: true },
		// Appended fields (hyperschema is positional): fork attribution.
		{ name: 'forkedFrom', type: 'string' }, // repo id of the source repo
		{ name: 'sourceKey', type: 'string' }, // hex drive key of the source repo
		// Who may change content. 'owner' (default) = one-way, only the repo
		// owner's writes reach peers; 'peers' = peers may push back.
		{ name: 'writeMode', type: 'string' }
	]
});

ns.register({
	name: 'ref', // branch/tag pointer
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'name', type: 'string', required: true },
		{ name: 'sha', type: 'string', required: true }
	]
});

ns.register({
	name: 'commit',
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'sha', type: 'string', required: true },
		{ name: 'parent', type: 'string' }, // null for root commit
		{ name: 'treeDigest', type: 'string', required: true }, // serialized path->{hash,size,mtime}
		{ name: 'authorKey', type: 'string', required: true },
		{ name: 'message', type: 'string', required: true },
		{ name: 'ts', type: 'uint', required: true },
		// Appended: serialized changelist ("A /a\nM /b\nD /c") so history and
		// restore do not have to re-diff trees. Null on root/legacy commits.
		{ name: 'changes', type: 'string' }
	]
});

ns.register({
	name: 'issue',
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'number', type: 'uint', required: true },
		{ name: 'title', type: 'string', required: true },
		{ name: 'body', type: 'string' },
		{ name: 'authorKey', type: 'string', required: true },
		{ name: 'state', type: 'string', required: true }, // 'open' | 'closed'
		{ name: 'assigneeKey', type: 'string' },
		{ name: 'milestoneId', type: 'string' },
		{ name: 'labelIds', type: 'string' }, // serialized list
		{ name: 'createdAt', type: 'uint', required: true },
		{ name: 'closedAt', type: 'uint' }
	]
});

ns.register({
	name: 'label',
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'id', type: 'string', required: true },
		{ name: 'name', type: 'string', required: true },
		{ name: 'color', type: 'string' }
	]
});

ns.register({
	name: 'milestone',
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'id', type: 'string', required: true },
		{ name: 'title', type: 'string', required: true },
		{ name: 'due', type: 'uint' },
		{ name: 'state', type: 'string', required: true }
	]
});

ns.register({
	name: 'pull',
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'number', type: 'uint', required: true },
		{ name: 'title', type: 'string', required: true },
		{ name: 'body', type: 'string' },
		{ name: 'headRef', type: 'string', required: true },
		{ name: 'baseRef', type: 'string', required: true },
		{ name: 'authorKey', type: 'string', required: true },
		{ name: 'state', type: 'string', required: true }, // 'open' | 'merged' | 'closed'
		{ name: 'mergeSha', type: 'string' },
		{ name: 'createdAt', type: 'uint', required: true }
	]
});

ns.register({
	name: 'review',
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'pullId', type: 'string', required: true },
		{ name: 'reviewerKey', type: 'string', required: true },
		{ name: 'state', type: 'string', required: true }, // 'approve' | 'changes' | 'comment'
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'comment', // shared by issues and pulls
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'kind', type: 'string', required: true }, // 'issue' | 'pr'
		{ name: 'parentId', type: 'string', required: true },
		{ name: 'authorKey', type: 'string', required: true },
		{ name: 'body', type: 'string', required: true },
		{ name: 'path', type: 'string' }, // set for inline review comments
		{ name: 'line', type: 'uint' },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'reviewComment',
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'pullId', type: 'string', required: true },
		{ name: 'path', type: 'string', required: true },
		{ name: 'line', type: 'uint', required: true },
		{ name: 'authorKey', type: 'string', required: true },
		{ name: 'body', type: 'string', required: true },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'star',
	fields: [
		{ name: 'byKey', type: 'string', required: true },
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'fork',
	fields: [
		{ name: 'byKey', type: 'string', required: true },
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'parentRepoId', type: 'string', required: true },
		{ name: 'newRepoId', type: 'string', required: true },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'watch',
	fields: [
		{ name: 'byKey', type: 'string', required: true },
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'level', type: 'string', required: true } // 'all' | 'mentions'
	]
});

ns.register({
	name: 'follow',
	fields: [
		{ name: 'followerKey', type: 'string', required: true },
		{ name: 'targetKey', type: 'string', required: true },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'activity', // append-only event log -> contributions graph + notifications
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'actorKey', type: 'string', required: true },
		{ name: 'repoId', type: 'string' },
		{ name: 'type', type: 'string', required: true }, // push|issue|pr|review|star|fork
		{ name: 'refId', type: 'string' },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'notification',
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'toKey', type: 'string', required: true },
		{ name: 'activityId', type: 'string', required: true },
		{ name: 'read', type: 'bool', required: true }
	]
});

ns.register({
	name: 'thread', // Discussions (later tier, declared now so schema is stable)
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'title', type: 'string', required: true },
		{ name: 'category', type: 'string' },
		{ name: 'authorKey', type: 'string', required: true },
		{ name: 'state', type: 'string', required: true },
		{ name: 'createdAt', type: 'uint', required: true }
	]
});

ns.register({
	name: 'post',
	fields: [
		{ name: 'id', type: 'string', required: true },
		{ name: 'threadId', type: 'string', required: true },
		{ name: 'authorKey', type: 'string', required: true },
		{ name: 'body', type: 'string', required: true },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'wikiPage',
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'name', type: 'string', required: true },
		{ name: 'body', type: 'string', required: true },
		{ name: 'ts', type: 'uint', required: true }
	]
});

ns.register({
	name: 'webhook',
	fields: [
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'id', type: 'string', required: true },
		{ name: 'url', type: 'string', required: true },
		{ name: 'events', type: 'string', required: true }, // serialized list
		{ name: 'secret', type: 'string' }
	]
});

ns.register({
	name: 'announcement', // what a peer tells other peers about a repo it hosts
	fields: [
		{ name: 'peerKey', type: 'string', required: true }, // host key (hex)
		{ name: 'repoId', type: 'string', required: true },
		{ name: 'name', type: 'string', required: true },
		{ name: 'description', type: 'string' },
		{ name: 'visibility', type: 'string' }, // 'public' | 'private'
		{ name: 'defaultBranch', type: 'string' },
		{ name: 'driveKey', type: 'string' }, // public repos only
		{ name: 'metaKey', type: 'string' }, // public repos only
		{ name: 'ts', type: 'uint', required: true },
		{ name: 'lastSeen', type: 'uint', required: true },
		// Mirrors repo.writeMode so a guest knows, before writing, whether the
		// owner allows peer writes (the RPC policy call is still authoritative).
		{ name: 'writeMode', type: 'string' }
	]
});

Hyperschema.toDisk(schema, { esm: true });

// --- HyperDB collections + indexes ---
const db = HyperDB.from(SCHEMA_DIR, DB_DIR);
const dbns = db.namespace('ghostdrive');

dbns.collections.register({
	name: 'sessions',
	schema: '@ghostdrive/session',
	key: ['id']
});

// Composite primary key: unique per session+target
dbns.collections.register({
	name: 'registrations',
	schema: '@ghostdrive/registration',
	key: ['sessionId', 'target']
});

// Composite primary key: unique per session+capKey
dbns.collections.register({
	name: 'invites',
	schema: '@ghostdrive/invite',
	key: ['sessionId', 'capKey']
});

// Composite primary key: unique per session+peer
dbns.collections.register({
	name: 'joins',
	schema: '@ghostdrive/join',
	key: ['sessionId', 'peerKey']
});

// Secondary indexes for querying children by sessionId
dbns.indexes.register({
	name: 'registrations-by-session',
	collection: '@ghostdrive/registrations',
	unique: false,
	key: ['sessionId']
});

dbns.indexes.register({
	name: 'invites-by-session',
	collection: '@ghostdrive/invites',
	unique: false,
	key: ['sessionId']
});

dbns.indexes.register({
	name: 'joins-by-session',
	collection: '@ghostdrive/joins',
	unique: false,
	key: ['sessionId']
});

// --- PeerHub collections (repos, git objects, tracker, social, activity) ---
dbns.collections.register({
	name: 'users',
	schema: '@ghostdrive/user',
	key: ['peerKey']
});
dbns.collections.register({
	name: 'repos',
	schema: '@ghostdrive/repo',
	key: ['id']
});
dbns.collections.register({
	name: 'refs',
	schema: '@ghostdrive/ref',
	key: ['repoId', 'name']
});
dbns.collections.register({
	name: 'commits',
	schema: '@ghostdrive/commit',
	key: ['repoId', 'sha']
});
dbns.collections.register({
	name: 'issues',
	schema: '@ghostdrive/issue',
	key: ['repoId', 'number']
});
dbns.collections.register({
	name: 'labels',
	schema: '@ghostdrive/label',
	key: ['repoId', 'id']
});
dbns.collections.register({
	name: 'milestones',
	schema: '@ghostdrive/milestone',
	key: ['repoId', 'id']
});
dbns.collections.register({
	name: 'pulls',
	schema: '@ghostdrive/pull',
	key: ['repoId', 'number']
});
dbns.collections.register({
	name: 'reviews',
	schema: '@ghostdrive/review',
	key: ['id']
});
dbns.collections.register({
	name: 'comments',
	schema: '@ghostdrive/comment',
	key: ['id']
});
dbns.collections.register({
	name: 'reviewComments',
	schema: '@ghostdrive/reviewComment',
	key: ['id']
});
dbns.collections.register({
	name: 'stars',
	schema: '@ghostdrive/star',
	key: ['byKey', 'repoId']
});
dbns.collections.register({
	name: 'forks',
	schema: '@ghostdrive/fork',
	key: ['byKey', 'repoId']
});
dbns.collections.register({
	name: 'watches',
	schema: '@ghostdrive/watch',
	key: ['byKey', 'repoId']
});
dbns.collections.register({
	name: 'follows',
	schema: '@ghostdrive/follow',
	key: ['followerKey', 'targetKey']
});
dbns.collections.register({
	name: 'activities',
	schema: '@ghostdrive/activity',
	key: ['id']
});
dbns.collections.register({
	name: 'notifications',
	schema: '@ghostdrive/notification',
	key: ['id']
});
dbns.collections.register({
	name: 'threads',
	schema: '@ghostdrive/thread',
	key: ['id']
});
dbns.collections.register({
	name: 'posts',
	schema: '@ghostdrive/post',
	key: ['id']
});
dbns.collections.register({
	name: 'wikiPages',
	schema: '@ghostdrive/wikiPage',
	key: ['repoId', 'name']
});
dbns.collections.register({
	name: 'webhooks',
	schema: '@ghostdrive/webhook',
	key: ['repoId', 'id']
});

dbns.collections.register({
	name: 'announcements',
	schema: '@ghostdrive/announcement',
	key: ['peerKey', 'repoId']
});

// --- PeerHub secondary indexes ---
const peerhubIndexes = [
	{ name: 'users-by-handle', collection: '@ghostdrive/users', key: ['handle'] },
	{ name: 'repos-by-owner', collection: '@ghostdrive/repos', key: ['ownerKey'] },
	{ name: 'refs-by-repo', collection: '@ghostdrive/refs', key: ['repoId'] },
	{ name: 'commits-by-repo', collection: '@ghostdrive/commits', key: ['repoId'] },
	{ name: 'issues-by-repo', collection: '@ghostdrive/issues', key: ['repoId'] },
	{ name: 'labels-by-repo', collection: '@ghostdrive/labels', key: ['repoId'] },
	{ name: 'milestones-by-repo', collection: '@ghostdrive/milestones', key: ['repoId'] },
	{ name: 'pulls-by-repo', collection: '@ghostdrive/pulls', key: ['repoId'] },
	{ name: 'reviews-by-pull', collection: '@ghostdrive/reviews', key: ['pullId'] },
	{ name: 'comments-by-parent', collection: '@ghostdrive/comments', key: ['kind', 'parentId'] },
	{
		name: 'reviewComments-by-pull',
		collection: '@ghostdrive/reviewComments',
		key: ['pullId']
	},
	{ name: 'star-by-repo', collection: '@ghostdrive/stars', key: ['repoId'] },
	{ name: 'star-by-user', collection: '@ghostdrive/stars', key: ['byKey'] },
	{ name: 'fork-by-repo', collection: '@ghostdrive/forks', key: ['repoId'] },
	{ name: 'fork-by-user', collection: '@ghostdrive/forks', key: ['byKey'] },
	{ name: 'watch-by-repo', collection: '@ghostdrive/watches', key: ['repoId'] },
	{ name: 'follow-by-target', collection: '@ghostdrive/follows', key: ['targetKey'] },
	{ name: 'activity-by-actor', collection: '@ghostdrive/activities', key: ['actorKey'] },
	{ name: 'activity-by-repo', collection: '@ghostdrive/activities', key: ['repoId'] },
	{ name: 'notification-by-to', collection: '@ghostdrive/notifications', key: ['toKey'] },
	{ name: 'threads-by-repo', collection: '@ghostdrive/threads', key: ['repoId'] },
	{ name: 'posts-by-thread', collection: '@ghostdrive/posts', key: ['threadId'] },
	{ name: 'announcement-by-peer', collection: '@ghostdrive/announcements', key: ['peerKey'] }
];
for (const idx of peerhubIndexes) {
	dbns.indexes.register({ ...idx, unique: false });
}

HyperDB.toDisk(db, { esm: true });
