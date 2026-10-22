# PeerHub — P2P GitHub MVP Spec

Goal: turn Ghost Drive (a P2P file-share on the Holepunch stack) into a peer-to-peer
code-hosting + collaboration platform ("PeerHub") that reproduces the useful parts of
GitHub without a central server. This file is the build plan: what already exists, what
must be added, and what must be modified, feature by feature, with an MVP cut line.

Every "modify" below references a real file/symbol in this repo so the work is scoped to
the actual code, not a greenfield design.

---

## 1. What we already have (the P2P starter)

| Capability today                                 | Where it lives                                                                                         | Reusable as                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Persistent device identity (keypair)             | `app.ts` `_open()` → `store.createKeyPair('ghost-drive')`, `app.key`                                   | a "user"/"org" identity seed        |
| Ephemeral shared workspace ("session"/drive)     | `session.ts` `DriveSession`, created by `app.createSession()`                                          | a "repository" container            |
| Content-addressed file storage                   | `hyperdrive` + `localdrive` mounted into `SharedDrive`                                                 | the repo working tree / blob store  |
| Peer discovery + encrypted transport             | `hyperswarm` + `store.replicate(conn)` in `app.ts`                                                     | repo clone/fetch channel            |
| Read over P2P (lazy, chunked)                    | `shared-drive.ts` (extends `distributed-drive`)                                                        | `git fetch` / file serving          |
| Write over P2P (put/del/stat/manifest/range RPC) | `shared-drive.ts` `WRITE_PROTOCOL = 'ghost-drive/shared'`                                              | push / commit write path            |
| Replicated metadata DB                           | `hyperdb` over `hyperbee2` (`app.db`), schema in `spec/hyperschema`, generated `spec/hyperdb/index.js` | issues, PRs, reviews, social graph  |
| Two-way local↔remote reconcile                   | `sync.ts` `SessionSync`                                                                                | working-copy sync for a local clone |
| Invite / join capability flow                    | `app.ts` `encodeInvite/parseInvite/acceptInvite`, `session.ts` invites+joins                           | share/private-repo access grant     |
| HTTP endpoints (SvelteKit `+server.ts`)          | `routes/api/files/...`, `routes/drive/[id]/stream`, `downloads/stream`                                 | seed for REST API + webhooks        |
| File browse / preview / settings UI              | `routes/drive/[id]/*`, `components/FileGrid.svelte`, `FileItem.svelte`, `Sidebar.svelte`               | repo browser shell                  |

**Key gap to internalize first:** the metadata DB (`app.db`, the `ghost-db` Hyperbee) is a
single global bee on the local corestore. It replicates with whatever peers the _corestore_
connects to, but today it holds only `sessions/registrations/invites/joins` and is not
scoped per repository or deliberately shared between collaborators. Nearly every GitHub
feature (issues, PRs, stars, activity) is _shared, replicated metadata_, so the single
biggest architectural change is: **give each repository its own replicated metadata log and
swarm topic**, and treat the DB as collaborative, not local-only.

---

## 2. MVP scope decision

MVP = a coherent product where two peers can host, browse, discuss, and review code
repositories over P2P. Anything requiring centralized compute, secret marketplaces, or
heavy ML is deferred.

- **IN (MVP):** Repository hosting (public/private), Git commit model (blobs/trees/commits/refs),
  branches, code browsing + file preview + README, Issues, Pull Requests + basic Code Review,
  Milestones & Labels, Star, Fork, Watch/notifications, Following, Contributions graph,
  replicated metadata, read REST API + webhooks (emit-only).
- **LATER (post-MVP):** Project boards/tables, Discussions, Wiki, code search index, branch
  protection rules, GraphQL API, secret scanning, dependency scanning.
- **OUT (not a P2P fit for MVP):** GitHub Actions CI runners, Codespaces, Copilot, Packages,
  Marketplace, Sponsors, Pages (static hosting), code scanning, end-to-end encrypted
  whitelisting beyond capability keys.

Feature-category → tier map (using the requested GitHub list):

| Category                 | MVP                                               | Later                                    | Out                                     |
| ------------------------ | ------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Repo hosting & code mgmt | hosting, branch model, browse                     | branch protection, code search, full API | —                                       |
| Collaboration & review   | PRs, code review                                  | Discussions, Wikis                       | —                                       |
| Issue tracking & PM      | Issues, labels, milestones                        | Projects (boards/tables)                 | —                                       |
| CI/CD & automation       | webhook emit                                      | workflow viz, Actions                    | Actions runners                         |
| Social & community       | star, fork, watch, following, contributions graph | —                                        | —                                       |
| Ecosystem                | Gists (= mini repos)                              | Marketplace, Pages                       | Pages, Marketplace                      |
| Security & compliance    | —                                                 | secret scan, dep scan, code scan         | —                                       |
| Advanced services        | —                                                 | —                                        | Copilot, Codespaces, Packages, Sponsors |

---

## 3. Core architecture changes (do these before features)

### 3.1 Repository as a first-class replicated unit

Today `DriveSession` is a "shared folder cluster". Redefine a **Repository** as:

- one `hyperdrive` (content/fork base) — reuse `session.ts` drive mount code,
- one **per-repo metadata core** owned by the repo host: `store.get({ name: 'repo-meta/<id>' })`
  → `new Hyperbee(session, { core })` → `HyperDB.bee2(bee, def)`. A guest opens the _same_ core
  read-only by key (`store.get({ key })`), so it replicates commits/issues/PRs along with the
  files. The key rides in the invite payload. **Do not pass `autoUpdate` to `bee2`:** that path
  calls `bee.on('update')` and hyperbee2 is not an EventEmitter — it throws `bee.on is not a
function` on the first session open. Guests call `db.update()` instead (`refreshMeta()` in
  `session.ts`) before each meta read.
- one **swarm topic** = repo discovery key so content + metadata replicate to collaborators.

Writes: hyperbee2 is single-writer, so only the host can append. A guest calling
`putMeta()` either writes locally (host) or forwards the record over the existing
`ghost-drive/shared` protomux-rpc channel (method `meta-put`), which the host applies to its
writable core against a collection allowlist (`META_WRITE_COLLECTIONS` in `session.ts`).
That is why a guest commit is visible to every peer instead of living in a private local copy.

Changes:

- `app.ts`: split `sessions` into `repos`. `createSession()` → `createRepo({ name, description,
visibility, defaultBranch })`. Keep the old call path working (do not delete it) and add the
  repo wrapper around it, per the "port features into modes, never delete logic" rule.
- `encodeInvite()`/`parseInvite()`/`acceptInvite()` carry `meta`, and `sessions.metaKey`
  persists it so a rejoined guest reopens the same core.

### 3.2 Commit / Git object model on hyperdrive

Hyperdrive gives an immutable snapshot tree but no commit DAG. Add a lightweight commit model
stored in the repo DB, referencing content in the drive:

- `commit` record: `{ repoId, sha, parent, treeDigest, authorKey, message, ts }` where
  `treeDigest` is a serialized `[[path, digest], …]` snapshot captured at commit time from
  `shared-drive.manifestShared()` (`buildTree()` in `git.ts`; files up to 4 MiB are hashed with
  `crypto_generichash`, larger ones fall back to `size:mtime`).
- `ref` record: `{ repoId, name (branch/tag), sha }` — branch = movable pointer, default `main`.
- Diffs derive by comparing `treeDigest` maps (`diffTrees()`); the parent chain gives history.
- **Known gap:** the digest only records _what_ the tree looked like, not the bytes. Checking a
  file out at an old commit needs content-addressed blob snapshots (Hypercore keeps the old
  blocks, but nothing records which block belonged to which commit) — separate later task.
  Browsing therefore always shows the live working tree.

Changes: `src/lib/server/git.ts` now owns `commit()`, `createBranch()`, `getRef()/listRefs()`,
`getCommit()/listCommits()`, `diffTrees()`, `buildTree()` and `previewFile()`. UI is the
`routes/drive/[id]/code` route plus a Code link in the drive header (not a button on the file
grid — the tree listing lives on that page).

### 3.3 Metadata DB schema growth

All new records go through the schema pipeline, not hand-edits:
edit `build.cjs` (`ns.register` + `dbns.collections/indexes.register`) → run
`npm run build:schema` → regenerates `spec/hyperschema/schema.json`, `spec/hyperdb/messages.js`,
`spec/hyperdb/index.js`. Never hand-edit the generated files. Add fields/collections as new
versions (the `version` flags in `messages.js` show the pattern: add optional field, bump
`VERSION`).

### 3.4 Identity → user profiles

`app.key` is a raw 32-byte public key with no human identity. Add:

- `user` record: `{ peerKey, handle, displayName, bio, avatar(buffer, reuse session.icon
base64 pattern in loaders.ts bufferToDataUri), joinedAt }`.
- Handle→key resolution must be findable on the swarm so social features can resolve a key
  to a profile. Seed a global "directory" topic all peers join (`swarm.join(<const discoveryKey>)`
  in `app.ts._open()`) that replicates a `users` + `profile` DB.
- A device can own one profile; orgs are profiles with a `kind: 'org'` flag (post-MVP multi-id).

### 3.5 Notifications + activity feed (needed by watch/social)

- `activity` record (append-only): `{ id, actorKey, repoId, type ('push'|'issue'|'pr'|'review'|
'star'|'fork'), refId, ts }` — powers Contributions graph and Watch.
- `notification` record: `{ toKey, activityId, read }` fan-out on watch/star/mention.

---

## 4. Feature-by-feature plan

Legend: **[Reuse]** maps to existing code · **[Add]** new module/schema/UI · **[Modify]** edit
existing file/symbol. Each `Routes`/`Components` path is under `src/`.

### 4.1 Repository Hosting & Code Management (MVP core)

**Public/private hosting**

- [Add] `repo.visibility` field (`public`|`private`). Private = capability-key gated, reuse
  `session.ts createInvite/markInviteUsed` and `app.acceptInvite`; a private repo's DB/drive is
  only joined by peers holding the cap. [Modify] `app.ts createSession/acceptInvite` to carry
  visibility.
- [Add] repo `description`, `defaultBranch`, `topics[]` to `@ghostdrive/session` struct in
  `build.cjs` (bump schema `VERSION`).

**Branch model + refs**

- [Add] `git.ts` refs (section 3.2). Checkout/switch writes an active `headRef` per device in
  the local (non-replicated) portion of the store so collaborators don't clobber each other's
  view.

**Code search & navigation**

- [Add, Later] inverted index of tokens→paths built from `readdir`/manifest over the drive,
  stored in a local-only bee (`loaders.ts fetchEntries` already walks the tree; extend it to
  emit tokens for text/code files flagged by `detectKind()` in `src/lib/index.ts`).
- [Reuse] file tree navigation already exists (`FileGrid.svelte`, `Breadcrumbs.svelte`).

**Webhooks & APIs**

- [Add] REST read endpoints as SvelteKit `+server.ts` under `routes/api/` — pattern exists at
  `routes/api/files/[id]/[...path]/+server.ts`. New: `api/repos`, `api/repos/[id]`,
  `api/repos/[id]/issues`, `.../pulls`, `.../commits`.
- [Add] webhook _emitter_: on each `activity` insert, POST to subscriber URLs stored in a
  `webhook` record. (Delivery/retry is later; MVP = local event log + best-effort POST.)
- [Later] GraphQL = resolver layer over the same hyperdb collections.

### 4.2 Collaboration & Code Review (MVP: PRs + review)

**Pull Requests**

- [Add] `pull` collection: `{ repoId, number, title, body, headRef, baseRef, authorKey,
state('open'|'merged'|'closed'), mergeSha, createdAt }`. A PR = a ref in the author's fork
  proposed against the target repo's ref.
- [Reuse] fork content transport = existing `SharedDrive` write RPC; PR diff = commit-model
  diff between `headRef` and `baseRef`.
- [Add] UI `routes/repo/[id]/pulls/` + `components/PullList.svelte`, `PullView.svelte`.
- [Modify] `hooks.server.ts`/`+layout.server.ts` if a `locals.user` profile context is needed
  for "authored by".

**Code Review**

- [Add] `review` collection: `{ pullId, reviewerKey, state('approve'|'changes'|'comment'), ts }`
  and `reviewComment` collection: `{ pullId, path, line, authorKey, body, ts }`.
- [Add] line-comment UI over `preview/+page.svelte` (file preview already renders text/code).

**Discussions** [Later]

- [Add] `thread` + `post` collections; category tags. Reuse comment UI.

**Wikis** [Later]

- [Add] wiki = a special per-repo hyperdrive of markdown files + a `page` metadata record;
  reuse drive mount + `preview` renderer.

### 4.3 Issue Tracking & Project Management (MVP: issues+labels+milestones)

**Issues**

- [Add] `issue` collection: `{ repoId, number, title, body, authorKey, state, assigneeKey,
milestoneId, labelIds[], createdAt, closedAt }`. `labels` + `milestones` as their own
  collections keyed by repo.
- [Add] UI `routes/repo/[id]/issues/` + `components/IssueList.svelte`, `IssueView.svelte`,
  `CommentBox.svelte` (comments = a `comment` collection reused by issues _and_ PRs).
- [Reuse] number allocation: monotonic per repo stored in repo meta (mirror `randomId()`
  helper pattern in `app.ts`).

**Milestones / Labels** — [Add] collections above, simple CRUD in repo settings.
**Projects (boards/tables)** — [Later] `project`/`column`/`card` collections mapping issue/pr
numbers; no cross-repo aggregation in MVP.

### 4.4 CI/CD & Automation

**Webhook events** [MVP, emit-only] — see 4.1; every `activity` insert fires subscribers.
**GitHub Actions / runners** [Out] — needs a scheduling + isolated-execution service; P2P
runner fleet is post-MVP research. **Workflow visualization** [Later] — once any pipeline
records exist, render them from `activity`.

### 4.5 Social & Community (MVP)

**Star**

- [Add] `star` collection `{ byKey, repoId, ts }` (index `star-by-repo`, `star-by-user`).
- [Reuse] repo discovery for "explore/popular" = `swarm` + repo meta already joinable.

**Fork**

- [Add] `fork` collection `{ byKey, repoId, parentRepoId, newRepoId, ts }`.
- [Reuse] cloning: `session.ts` already mounts a remote hyperdrive by key
  (`addHyperdrive(hex)`) — a fork = new repo whose base drive mirrors the parent key, then
  diverges via the write channel. Fast because hyperdrive blocks are content-addressed/deduped.

**Watch / notifications**

- [Add] `watch` collection `{ byKey, repoId, level('all'|'mentions') }`; on `activity` insert,
  fan out to `notification` rows for watchers (section 3.5).

**Following**

- [Add] `follow` collection `{ followerKey, targetKey, ts }`; feed = activity of followed keys.

**Contributions graph**

- [Add] aggregate `activity` rows by actorKey+day into a heatmap; render from `activity`
  index `activity-by-actor-ts`. [Add] `components/ContribGraph.svelte`.

### 4.6 Ecosystem & Extensibility

**Gists** [MVP-light]: a gist = a minimal single-file repo (`kind: 'gist'`) reusing the repo +
commit model + `ghostdrive://` invite encoding (`app.ts encodeInvite`). [Add] `gist` alias
collection or reuse `repo` with a flag.
**Marketplace / Pages** [Out/Later]: Pages needs static hosting + DNS — out; can revisit as
"serve a folder read-only over the existing stream route".

### 4.7 Security & Compliance [Later]

**Secret scanning**: regex/entropy sweep over committed blobs in `git.ts commitRepo`;
flag `secret` records. **Dependency / code scanning**: out of MVP (need parsers/analyzers).

### 4.8 Advanced & Specialized [Out for MVP]

Copilot (needs hosted model), Codespaces (needs remote dev containers), Packages (registry),
Sponsors (payments) — all require infrastructure beyond a P2P file+metadata layer.

---

## 5. Schema additions to register in `build.cjs`

Add these hyperschema structs (namespace `ghostdrive`) + hyperdb collections/indexes, then run
`npm run build:schema`. Keep `session/registration/invite/join` as-is (repos build on them).

```
# structs (fields abridged; optional fields bump schema VERSION like messages.js does)
user         { peerKey, handle, displayName, bio, avatar:buffer, kind, joinedAt }
profile-by-handle  index on user.handle
repo         { id, ownerKey, name, description, visibility, defaultBranch, topics, createdAt }  # extends session
ref          { repoId, name, sha }                       # index ref-by-repo
commit       { repoId, sha, parent, treeDigest, authorKey, message, ts }  # commit-by-repo
issue        { repoId, number, title, body, authorKey, state, assigneeKey, milestoneId, labelIds, createdAt, closedAt }
label        { repoId, id, name, color }
milestone    { repoId, id, title, due, state }
pull         { repoId, number, title, body, headRef, baseRef, authorKey, state, mergeSha, createdAt }
review       { pullId, reviewerKey, state, ts }
comment      { kind('issue'|'pr'), parentId, authorKey, body, path, line, ts }   # shared by issues+PRs
reviewComment{ pullId, path, line, authorKey, body, ts }
star         { byKey, repoId, ts }     # star-by-repo, star-by-user
fork         { byKey, repoId, parentRepoId, newRepoId, ts }
watch        { byKey, repoId, level }
follow       { followerKey, targetKey, ts }
activity     { id, actorKey, repoId, type, refId, ts }  # activity-by-actor-ts, activity-by-repo
notification { toKey, activityId, read }
thread / post            (Discussions, later)
wikiPage                 (Wiki, later)
webhook                  { repoId, url, events[], secret }
```

Numbering, uniqueness and secondary-index style follow the existing
`registrations-by-session` pattern in `build.cjs`.

---

## 6. New server modules / files

- `src/lib/server/git.ts` — commit model, refs, diffs, snapshot from `shared-drive.manifest()`.
- `src/lib/server/repos.ts` — repo CRUD wrapper over `DriveSession` + per-repo `hyperdb`.
- `src/lib/server/social.ts` — star/fork/watch/follow/contributions ops.
- `src/lib/server/tracker.ts` — issue/PR/label/milestone/review/comment ops (the "issues engine").
- `src/lib/server/events.ts` — `activity` insert → webhook fan-out + notifications.
- `src/lib/server/users.ts` — profile get/put, handle resolution, directory-topic join.
- `src/routes/api/**/+server.ts` — REST read API mirroring the tracker/repos/git services.
- `src/routes/repo/[id]/**` — repo workspace pages (Code / Issues / Pulls / Stars / Settings),
  evolved from today's `routes/drive/[id]/*`.

---

## 7. UI / route changes

- [Modify] `Sidebar.svelte`: add nav (Explore, Notifications, profile) + repo tabs; today it
  lists drives/peers.
- [Modify] `routes/drive/[id]/+page.svelte` → becomes repo "Code" tab: commit panel, branch
  selector, README render on top of the existing `FileGrid`.
- [Add] `routes/repo/[id]/issues`, `/pulls`, `/stargazers`, `/settings` pages + components.
- [Add] `components/ContribGraph.svelte`, `IssueList/IssueView`, `PullList/PullView`,
  `ReviewForm`, `CommentBox`.
- [Reuse] `preview/+page.svelte` for file/line context in reviews; `Modal.svelte`,
  `Breadcrumbs.svelte`, `LivePeerCount.svelte` unchanged.
- [Reuse] branding: README already calls the app **PeerHub**; keep the `ghostdrive://` invite
  scheme (rename later is cosmetic).

---

## 8. Build order (phased milestones)

Phase 0 — Foundations (blocks everything): per-repo replicated hyperdb + swarm topic (3.1),
`user` profiles + directory topic (3.4), schema pipeline additions (5).
Phase 1 — Git core: commit/ref/diff model (3.2, `git.ts`), repo browser + commit UI on the
existing drive page, public/private via capability keys (4.1).
Phase 2 — Issues: issue/label/milestone collections + tracker + UI (4.3).
Phase 3 — PRs + review: pull/review/comment collections, fork-to-propose, diff UI (4.2).
Phase 4 — Social: star/fork/watch/follow/activity + notifications (4.5, 3.5), contributions
graph (4.5), explore page.
Phase 5 — API & gists: REST read endpoints + webhook emitter (4.1), gists (4.6).
Phase 6 — Later tier: discussions, wiki, code search, branch protection, scanners.

---

## 9. Constraints, risks, rules

- **Offline writes:** today a guest can't write unless the host is online
  (`session.ts writableDrive()` throws "Not connected to the host"). PRs/issues must be
  queued locally and flushed to the repo DB on reconnect (reuse the `invites/joins` local-first
  write style; mirror `sync.ts` reconcile-on-connect).
- **Conflict resolution:** `shared-drive`/`sync.ts` are last-write-wins (README "Known
  limitations"). The commit DAG (3.2) is what makes real merge/3-way possible — implement
  merge in `git.ts` before allowing PR merges that touch overlapping files.
- **Metadata scale:** one global bee (current) won't hold a full social graph; the per-repo DB
  split (3.1) plus append-only `activity` with date-partitioned indexes is required, not
  optional.
- **No silent degradation:** if a needed Holepunch primitive is missing (e.g. cross-repo query,
  pub/sub notifications), fail loudly / implement a real equivalent, do not log-and-continue
  (project rule).
- **Additive refactors only:** when reworking `DriveSession`→repo or `drive/[id]`→`repo/[id]`,
  keep the working drive/sync code reachable (retire old routes on an explicit separate step),
  per the porting-not-deleting rule.
- **Generated files:** never hand-edit `spec/hyperdb/index.js`, `spec/hyperdb/messages.js`, or
  `spec/hyperschema/schema.json`; regenerate via `npm run build:schema` from `build.cjs`.
- **Capability keys ≠ encryption:** README notes "anyone with your key can browse and write";
  private repos in MVP rely on the same capability secrecy — real per-user authz is a
  documented gap, not a solved feature.

---

## 10. Phase 0 — concrete task breakdown (the unblocking slice)

Phase 0 has no user-visible GitHub feature yet; it lays the three foundations every later
phase sits on: a human identity, a repository that is a _replicated_ unit, and the schema
(the records are already registered in `build.cjs` and generate cleanly — schema is now v4,
collections `@ghostdrive/users … @ghostdrive/webhooks`). Do these in order.

**P0.1 — Human identity (`users.ts`)**

- New `src/lib/server/users.ts`: `getProfile(peerKey)`, `putProfile({handle,displayName,bio,avatar,kind})`,
  `resolveHandle(handle)` over the `users` collection + `users-by-handle` index.
- [Modify] `app.ts._open()`: after `createKeyPair('ghost-drive')`, seed a default profile row
  (handle = first 8 of key hex if unset) so `app.key` always maps to a `user`.
- Accept `avatar` as raw bytes → reuse `loaders.ts bufferToDataUri()` for render.

**P0.2 — Directory topic (find any peer's profile)**

- [Modify] `app.ts._open()`: open a dedicated `users` Hyperbee on its own `store.session()`,
  join a **constant** discovery topic (e.g. `swarm.join(sha256('ghostdrive/directory'))`), and
  `store.replicate`/bee-replicate it on every connection to that topic, so profiles propagate
  peer-to-peer without a server.
- Gate behind a `bootstrap` option already threaded through `GhostDriveAppOptions`.

**P0.3 — Repository as a replicated unit (`repos.ts`)**

- New `src/lib/server/repos.ts`: `createRepo(app, {name, description, visibility, defaultBranch})`
  that (a) calls the existing `app.createSession()` for the drive, (b) writes a `repos` record
  keyed by the session id, (c) opens a **per-repo hyperdb** (`new Hyperbee(store.session(), {name:'repo-'+id})`),
  (d) joins `swarm` on the repo discovery key so metadata + content replicate together.
- [Modify] `session.ts._open()`: after `this.drive = new SharedDrive(...)`, replicate the repo
  DB core to peers on the same connection (`app.repos.get(id).db.replicate(conn)` hooked into
  the swarm `connection` handler). This is the change that makes issues/PRs sync at all.
- Keep `listSessions()`/`getSession()` intact and add `listRepos()`/`getRepo()` beside them
  (additive; do not remove the drive path).

**P0.4 — Activity + events backbone (`events.ts`)**

- New `src/lib/server/events.ts`: `emitActivity(app, {actorKey, repoId, type, refId})` → inserts
  an `activity` row (id via the existing `randomId()` pattern in `app.ts`) and fans out
  `notification` rows to repo watchers (watch table may be empty in P0; wiring lands now).
- Single hook every later feature calls, so contributions graph / notifications / webhooks all
  read one stream.

**P0.5 — Schema/DB plumbing check**

- Records already compile (`npm run build:schema`, now v4). Add thin typed accessors in
  `src/lib/server/` that wrap `app.db`/repo-db `insert/get/find/update/delete` for `users` and
  `repos` so later phases never touch raw collection names.

**Exit criteria for Phase 0**

1. Two peers start, each has a `user` profile resolvable by the other over the directory topic.
2. `createRepo()` returns a repo whose drive AND metadata db replicate to a second peer that
   joined via invite (write a record on peer A, see it on peer B without a server).
3. `emitActivity()` on A shows up in B's `activity` query.
4. `npm run check` (svelte-check) passes with the new modules; `npm run build:schema` stays green.

**Suggested commit size:** P0.1+P0.2 (identity) → P0.3 (repo/replication) → P0.4 (events), as
three reviewable steps.

**Status (P0 landed, corrected):** `users.ts` (P0.1), directory-topic join + profile seeding in
`app.ts._open()` (P0.2), `repos.ts` catalog wiring in `createSession`/`acceptInvite` and a
per-repo metadata core on `DriveSession` (P0.3), `events.ts` activity/notification backbone
(P0.4) are implemented. The first P0 cut created the bee from a bare `store.session()` with
`{ name: 'repo-<id>' }` — hyperbee2 ignores that option, so every repo shared one local-only
bee and nothing would ever replicate. It is now an explicit per-repo core (host writable,
guest read-only by key, guest writes forwarded over RPC) as described in 3.1. Schema is v5
(`sessions.metaKey` appended).

---

## 11. Phase 1 — Git core (implemented)

**Landed**

- `src/lib/server/git.ts`: `buildTree()` (per-file digest snapshot of `manifestShared('/')`),
  `serializeTree()/parseTree()`, `diffTrees()`, `commit()`, `createBranch()`, `getRef()`,
  `listRefs()`, `getCommit()`, `listCommits()`, `previewFile()`, `shortSha()`.
  Collection ids are the generated `@ghostdrive/commits` / `@ghostdrive/refs`.
- `src/lib/server/shared-drive.ts`: `putMetaRemote()` (guest → host) and the `meta-put`
  responder calling `onMetaWrite`, so metadata writes travel on the channel that already
  carries shared-file writes.
- `src/lib/server/session.ts`: meta core is shared (host writable, guest read-only),
  `putMeta()` routes local-vs-forward, `metaWritable`/`metaShared`/`metaKeyHex` exposed for UI,
  and `META_WRITE_COLLECTIONS` is the allowlist the host enforces.
- `src/routes/drive/[id]/code/+page.server.ts` + `+page.svelte`: branch list/select, history
  panel, working-tree list, file preview (256 KB cap, binary detection), commit form and
  "new branch" form. Code link added to the drive header.
- `git.ts` emits `push` activity on every commit, so the history already feeds
  `events.ts` → contributions graph later.

**Verified**

- Dev boot traced end to end with `[boot]`/`[app]`/`[session …]` step logs (`hooks.server.ts`,
  `app.ts._open`, `session.ts._open`): ready in ~82 ms; `GET /` → 200 in 16 ms;
  `GET /drive/<id>/code` → 200 in 94 ms.
- **Boot bug found by that tracing:** `ensureDefaultProfile()` runs inside `app._open()` and
  used helpers that started with `await app.ready()` — waiting on the open that called them, so
  the promise never resolved and every request hung forever. `users.ts`/`events.ts` now require
  an already-open db (`dbOf(app)`) instead of awaiting ready; route code still reaches ready via
  `loaders.getSession()`.
- Second boot bug: `HyperDB.bee2(..., { autoUpdate: true })` throws `bee.on is not a function`
  (hyperbee2 is not an EventEmitter). Removed; guests refresh manually in `refreshMeta()`.
- `npm run build:schema` clean, schema v5, `metaKey` generated.
- `npm run lint` (the CI gate) clean; `svelte-check` reports no errors or warnings in any file
  touched here (the remaining 1063 errors are all in the generated `spec/hyperdb/*`).
- Node smoke test (throwaway script, since removed) proved the risky wiring in isolation:
  named core is writable with a stable key, `new Hyperbee(session, { core })` opens it,
  `HyperDB.bee2` inserts/gets/ranges against `@ghostdrive/refs`/`@ghostdrive/commits`, the
  second write to the same ref key updates instead of duplicating, and a second store opening
  the key gets `writable: false` on the identical key.

**Not verified / known gaps**

- No live two-peer run: replication of the metadata core and the `meta-put` forward are wired
  but not observed end to end. Treat cross-peer commits as unproven until that test exists.
- No blob history (see 3.2), no branch delete, no merge/three-way, no tag UI, no per-file
  blame. `createBranch()` requires an existing commit to point at.
- Legacy guest sessions joined before this change have no `metaKey`; `putMeta()` refuses them
  with an actionable error instead of writing a private, unseen copy. Rejoining with a fresh
  invite fixes it.
- Commits are attributed by `app.key`; handles are not yet rendered next to them (P0.1 exists,
  the code page shows the first 8 hex chars).

---

## 12. Phase 2 — repo UI + peer directory (implemented)

**Routes**

- `/` is now a repository dashboard: create form (name, description, visibility, default branch,
  icon), "your repositories" list with peer counts and mirror/fork badges, and "public
  repositories" — everything other peers announced, with Open (public only), Fork, or an
  "invite required" link for private ones. Plus a "Refresh peers" broadcast. The old
  auto-jump-to-last-drive behaviour is gone; it made the dashboard unreachable.
- `/drive/[id]` — `RepoHeader.svelte` adds Files / Code / Commit / Settings tabs; the peer count
  and breadcrumbs moved to a slim bar underneath.
- `/drive/[id]/code` — directory tree with breadcrumbs and a `..` row, folder/file rows with
  sizes, README auto-preview at the root, Markdown rendering for `.md`/`.markdown`, branch
  selector, create-branch and delete-branch forms, "Commit changes" link, and a Fork button for
  guests viewing a public repo.
- `/drive/[id]/commit` — pending changes (A/M/D against HEAD) and the commit form; posts and
  redirects back to the code page with `committed=<sha>`.

**Server**

- `src/lib/server/directory.ts` — the announcement channel. Both peers register a
  `ghostdrive/directory` protomux-rpc channel on each swarm connection (the peer with the
  smaller public key opens it, the other pairs), then exchange JSON repo lists via
  `announce`; `push` re-broadcasts after a repo is created. `sanitize()` drops malformed rows
  and strips keys from private repos, so privacy is enforced by what is _sent_, not by the
  reader. `broadcastAnnouncements()` keeps a live set of channels for that push.
- `repos.ts` — `updateRepo()`, `openPublicRepo()` (in `app.ts`: read-only session from an
  announcement, deduped by drive key) and `forkRepo()`. A fork mirrors the source drive into
  the new repo's shared folder, records `forkedFrom`/`sourceKey` on the catalog row, writes a
  `forks` row into the _new_ repo's meta (the source log belongs to its owner), and removes the
  half-made repo if the source peer does not answer within 45 s.
- `src/lib/markdown.ts` — dependency-free renderer (headings, lists, quotes, fenced code,
  tables, hr, inline code/bold/italic/strike, links, images). Everything is escaped before any
  rule runs and link targets are restricted to http(s)/mailto/relative, so a repo cannot inject
  markup. Styles live under `.md` in `layout.css`, not in the app shell.
- Schema v7: `announcement` struct + `@ghostdrive/announcements` collection (key
  `peerKey, repoId`), and `repo.forkedFrom` / `repo.sourceKey` appended.

**Verified** (HTTP smoke against the dev server, 16 checks, all PASS)

`GET /` 200 → create repo 303 → upload `README.md` → code page 200 with rendered `<h1>`/`<li>`,
README listed in the tree and a commit link present → commit 303 with sha → history shows the
message → commit page 200 with "Pending changes" → home lists the repo → create branch 303 →
branch page shows the same history → delete branch 303.

**Not verified / known gaps**

- Open-public and fork need a second peer; the single-process smoke cannot exercise the
  announcement exchange or the mirror. They are wired but unproven end to end.
- Announcements refresh on connect or on "Refresh peers" only — there is no periodic gossip, and
  stale rows (peer gone) never expire. Old rows still show in the list until overwritten.
- A fork copies files, not history: the new repo starts with no commits and no branches.
- Private repos still appear in the public list by name/description (no keys). That reveals
  existence; hiding them entirely would need a separate private discovery path.
- Markdown renderer is intentionally small: no nested lists, footnotes, HTML blocks or syntax
  highlighting.
