# PeerHub

A peer-to-peer code host. Repositories, history, branches, forks and shareable links —
served from your machine over encrypted P2P connections, with no central server.

Self-hosted meaning here: one peer hosts the repo, everyone with its key (public repo) or
invite link (private repo) replicates the files and the metadata from it. Nothing is
uploaded to a company.

Built on the [Holepunch](https://holepunch.to) stack. Started as Ghost Drive (a P2P file
share); the file-share core is still the transport this sits on. The build plan and the
gap list live in [`spec/PEERHUB_MVP.md`](spec/PEERHUB_MVP.md).

## Status

Early. It runs, and the flows below work end to end, but it is not a GitHub replacement
yet. Known gaps are listed near the bottom instead of being quietly skipped.

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173
```

On Windows use `run.bat`, on macOS/Linux `run.sh`. Both refuse to start a second instance
(the app binds one port; a listening port means it is already up) and install dependencies
on first run.

The web UI and the desktop/mobile build share the same server code:

```bash
npm run build                              # vite build
npm run make:darwin-arm64                  # bare-build desktop bundle
npm run make:android-arm64                 # bare-build android bundle
```

Data lives outside the repo, in the platform data dir under `ghost-drive/`:

- Windows `%APPDATA%\ghost-drive`
- macOS `~/Library/Application Support/ghost-drive`
- Linux `~/.local/share/ghost-drive`

Your peer key, repositories, metadata and cached files are all in there. Delete the folder
to start over as a new peer.

## What works today

| Area             | Behaviour                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Repositories** | Create with name, description, visibility (public/private), default branch and icon. Each repo is a shared drive plus its own replicated metadata log. |
| **Browse**       | Files tab (grid, grouping, filter, preview for image/video/audio/text) and Code tab (directory tree, folder navigation, sizes, README preview).        |
| **Markdown**     | `.md` files render read-only. Renderer is small and escapes everything — no raw HTML.                                                                  |
| **Commits**      | The Commit tab diffs the live tree against HEAD (`A`/`M`/`D` per path) and records a snapshot on the chosen branch.                                    |
| **Branches**     | Create from an existing branch, switch, delete (default branch protected).                                                                             |
| **Forks**        | Fork a public repo: it mirrors the drive into a new repo you own and keeps the source attribution.                                                     |
| **Explore**      | Search every repo this device owns or opened, plus everything other peers announced. Filters for yours / public / private.                             |
| **Public repos** | Open a read-only mirror with no invite. Private repos show by name only and need an invite link.                                                       |
| **Uploads**      | Files or whole folders from any peer. `.gitignore` is honoured on both ends (see below).                                                               |
| **Local sync**   | Link a folder on disk; reconcile on demand or every 15 s, two-way, additions/edits/deletions.                                                          |
| **Identity**     | Persistent keypair stored in the data dir; a profile record (handle, display name, bio, avatar) is seeded on first run and replicated to peers.        |

### .gitignore-aware uploads

Rules come from `.gitignore` files at any depth, including ones that arrive _inside_ the
folder being uploaded. Each file's rules are relative to its own directory, parent files
apply first, child files override — git's order.

Supported: comments, blank lines, `!negation`, `dir/`, `/anchor`, basename matching at any
depth (`*.log`), `*`, `?`, `**` (`**/cache/`, `docs/**/*.tmp`), last-match-wins. `.git` is
always ignored.

Not supported: `[a-z]` character classes, escaped trailing spaces.

Enforcement is in two places so neither alone can be bypassed:

- the browser drops ignored files before sending a byte, and uploads the `.gitignore`
  files first;
- `PUT /api/files/...` re-checks every path and answers `{ skipped: 'gitignore' }` without
  storing anything.

Linked folders go through the same matcher, so a mirrored project folder does not push its
`node_modules` into the shared drive.

## How it works

```
peer A (host)                                   peer B (guest)
─────────────────────────────────────────       ─────────────────────────────
corestore  → keypair (identity)                 corestore → keypair
  ├ ghost-db (hyperdb over hyperbee)              ├ ghost-db (own copy)
  │   users, repos, announcements,                │
  │   activities, notifications                   │
  ├ repo-meta/<id> (hyperdb, writable)            ├ repo-meta/<id> (read replica)
  │   commits, refs                               │
  └ sessions/<id>/shared (hyperdrive)  ◄──────►   shared (replicated)
                                                    └ sync pair ↔ local folder
```

The metadata schema already carries the collections for issues, pull requests, reviews,
labels, milestones, stars, forks, wiki and webhooks. Nothing writes to them yet — see the
gap list.

- **Identity** — a corestore keypair; `users` maps the public key to a profile.
- **A repo is two things** — a shared drive (files, replicated with hyperdrive) and a
  metadata core (commits, refs, and the collections for issues/PRs/social). Both ride the
  same `corestore` replication stream, so opening one repo gets you the other.
- **Single writer, forwarded writes** — hyperbee2 has one writer, the repo host. A guest's
  write is forwarded over the existing `protomux-rpc` channel and applied by the host
  against a collection allowlist (`META_WRITE_COLLECTIONS` in `session.ts`). File writes go
  the same way; a guest that is offline can only read its cache.
- **Discovery** — every peer joins one constant swarm topic and exchanges the list of repos
  it hosts (`directory.ts`). That list is what the Explore tab reads. Public repos advertise
  their drive and metadata keys; private ones advertise only name/description.
- **Git layer** — hyperdrive stores the _current_ tree, not history. `git.ts` builds one
  digest per path, and a commit is a record of that snapshot plus parent and message. Branch
  refs are pointers into that DAG. (No tags yet.)
- **Events** — a commit appends a `push` entry to one `activity` stream (`events.ts`), which
  already fans out to watchers' notifications. Stars, issues and reviews will use the same
  stream instead of inventing their own.

### Code map

| Path                             | Role                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `src/lib/server/app.ts`          | corestore, keypair, swarm, root db, repo registry, join/create/fork                   |
| `src/lib/server/session.ts`      | one repository: cache + shared drives, metadata core, write forwarding                |
| `src/lib/server/shared-drive.ts` | RPC layer over `distributed-drive` (uploads, deletes, meta writes)                    |
| `src/lib/server/git.ts`          | tree digests, commits, refs, diff, file preview                                       |
| `src/lib/server/repos.ts`        | repo catalog rows, fork, open-public                                                  |
| `src/lib/server/directory.ts`    | peer repo announcements                                                               |
| `src/lib/server/users.ts`        | identity and profiles                                                                 |
| `src/lib/server/events.ts`       | activity and notifications                                                            |
| `src/lib/server/ignores.ts`      | `.gitignore` loading for the upload guard and sync                                    |
| `src/lib/server/sync.ts`         | linked-folder two-way reconcile                                                       |
| `src/lib/ignore.ts`              | shared `.gitignore` parser/matcher and upload planner                                 |
| `build.cjs`                      | hyperschema definitions → `spec/hyperschema`, `spec/hyperdb`                          |
| `src/routes/`                    | `/` dashboard, `/explore`, `/drive/[id]` with `code`, `commit`, `settings`, `preview` |

Schema is generated, never hand-edited:

```bash
npm run build:schema    # node build.cjs — bump version, regenerate spec/*
```

Fields are appended, not reordered: hyperschema identifies them by position.

## Commands

| Command                                            | What it does                                                 |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `npm run dev`                                      | Vite dev server                                              |
| `npm run build`                                    | Production build                                             |
| `npm run preview`                                  | Preview the production build                                 |
| `npm run build:schema`                             | Regenerate the HyperDB schema                                |
| `npm run check`                                    | `svelte-check` over the project                              |
| `npm run format` / `npm run lint`                  | Prettier write / check (lint is the CI gate, with the build) |
| `npm run make:darwin-arm64` / `make:android-arm64` | Native bundles via `bare-build`                              |
| `npm run clean`                                    | Remove `out`, `build`, `.svelte-kit`                         |

## Tech stack

- **SvelteKit 2 / Svelte 5**, Vite, Tailwind CSS 4
- **bare** runtime with **bare-build** for the desktop and Android bundles
- **corestore** — keys, storage, replication sessions
- **hyperswarm** — DHT discovery and encrypted connections
- **hyperdrive** — content-addressed replicated files
- **hyperdb + hyperbee2 + hyperschema** — replicated, schema-typed metadata
- **distributed-drive** — aggregates local and remote drives behind one interface
- **protomux-rpc** — request/response over an encrypted peer connection
- **localdrive** — filesystem drive for local folders and caches

## Known gaps

Honest list, all of it planned work rather than hidden behaviour:

- **No issues, pull requests or reviews UI yet.** The collections and schema exist
  (`issues`, `labels`, `milestones`, `pulls`, `reviews`, `comments`); nothing writes to them.
- **Commits are snapshots, not blob history.** You can see what changed, not check out an
  old revision of a file. Content-addressed snapshots are the missing layer.
- **No merge.** Branches diverge; nothing reconciles them. File writes are last-write-wins.
- **Forks copy files, not history.** The new repo mirrors the source tree but starts with its
  own empty metadata log.
- **Metadata needs the host online.** Guests queue nothing yet — a write fails while
  disconnected.
- **Private means "unlisted, key required".** Invite links are capability URLs; there is no
  per-user authorisation inside a repo. Anyone holding the link can write.
- **Ordering is enforced client-side.** A third-party client that uploads files in arbitrary
  order can land an ignored file before its `.gitignore` exists; the server cannot
  retro-delete it.
- **Commit authorship is a raw key.** Profiles exist, but the UI shows the first 8 hex
  characters instead of a handle, and there is no profile editor yet.
- **The only way to change a `.gitignore` is to upload it again.** No in-app file editor.
- **Android launcher icons are stale** (`resources/android/mipmap-*`); the web and desktop
  icons are current.
- **No tests in the repo.** `npm test` points at a `test/` folder that does not exist yet;
  verification so far has been scripted HTTP round trips and browser checks.
