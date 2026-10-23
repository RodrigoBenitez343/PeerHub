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

## Setup

Node 22+ and npm. Nothing else — Electron downloads itself on install.

```bash
npm install            # dependencies, including the Electron binary
npm run desktop        # build, then open the app window
```

That is the whole setup. Pick the target you need:

| Goal                    | Command                 | Output                                                         |
| ----------------------- | ----------------------- | -------------------------------------------------------------- |
| Open the app            | `npm run desktop`       | window, no terminal needed                                     |
| Develop with hot reload | `npm run desktop:dev`   | Vite + window                                                  |
| Browser only            | `npm run dev`           | http://localhost:5173                                          |
| Installable app         | `npm run dist`          | `dist/PeerHub Setup <version>.exe` (NSIS), `.dmg`, `.AppImage` |
| Unpacked app            | `npm run dist:dir`      | `dist/win-unpacked/PeerHub.exe`                                |
| Headless boot check     | `npm run desktop:smoke` | prints the served URL + title, exits 0/1                       |
| Terminal command        | start the app once      | `ph` (and `peerhub`) on PATH, no Node needed                   |

`run.bat` (Windows) / `run.sh` (macOS, Linux) wrap `npm run desktop:dev`, install dependencies
on first run, and refuse a second instance.

### Both at once: the app and the terminal

Start the app normally (double-click the installed app, or `npm run desktop`). Then, from any
folder linked to a repo:

```bash
ph status                     # what changed vs HEAD
ph init                       # new repo, named after the folder and linked to it
ph commit -m "what changed"
ph log
```

**Where `ph` comes from.** The desktop app installs it on every launch: it copies the CLI and
the one module it imports into `%LOCALAPPDATA%\PeerHub\` (macOS/Linux: `~/.peerhub/`), writes
`ph.cmd` + `ph` shims in `bin/` that point at its own executable, and adds that folder to your
**user** PATH. No Node install is required — the app's executable doubles as the runtime via
`ELECTRON_RUN_AS_NODE=1`. `peerhub` is installed alongside `ph`, so both spellings work.

PATH is only read when a shell starts, so open a **new** terminal afterwards. Help → Command
line tool (ph) shows the shim path and can reinstall it; `PeerHub.exe --install-cli` and
`--uninstall-cli` do the same without opening a window.

**From source** (before packaging, or when hacking on the CLI):

```bash
npm run cli -- status                  # what changed vs HEAD
npm run cli -- commit -m "what changed"
npm run cli -- sync --push
```

Or drop the `npm run cli --` prefix once per machine:

```bash
npm link                               # then: peerhub status, peerhub commit -m "..."
```

The CLI is a client: it talks to the running app over loopback and reads the app's port from
`<data-dir>/.cli-url`, so there is no `--url` to pass. Both can be open at the same time — the
app stays the only writer. Full command list: [Terminal](#terminal).

The desktop app runs the SvelteKit server **in the Electron main process** and points the window
at a random loopback port. No sidecar, no external Node, no terminal.

Data lives outside the repo, in the platform data dir under `ghost-drive/`:

- Windows `%APPDATA%\ghost-drive`
- macOS `~/Library/Application Support/ghost-drive`
- Linux `~/.local/share/ghost-drive`

Your peer key, repositories, metadata and cached files are all in there. Delete the folder
to start over as a new peer.

> **Why `ghost-drive`?** The directory name, the corestore keypair name, the Hyperdrive core
> names, the `@ghostdrive/*` schema namespace and the `ghost-drive/shared` protocol are wire
> and storage identities, not branding. Renaming any of them would give this peer a new
> identity and orphan every existing repo, so they keep their original names. New invites use
> `peerhub://`; older `ghostdrive://` links still parse.

### Project layout

```
desktop/              Electron main process: window, menu, in-process HTTP server
                      cli-install.js writes the `ph` shims
scripts/              build-schema.cjs, dev-desktop.mjs, clean.mjs
cli/                  the `peerhub` terminal client (installed as `ph` in the app)
src/                  SvelteKit app
  lib/server/         all peer/storage logic (no UI imports)
  lib/components/     UI components
  routes/             /, /explore, /drive/[id]/{code,commit,settings,preview}, /api/*
packages/picker/      platform-conditional file picker (Android SAF, no-op elsewhere)
spec/                 generated hyperschema + hyperdb definitions (never hand-edited)
resources/            app icons (icon.png, icon.ico)
```

Rule of thumb: `src/lib/server/**` never imports a component or a `$app/*` module, and
`desktop/**` never imports app code directly — it only starts `build/handler.js`.

## What works today

| Area             | Behaviour                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repositories** | Create with name, description, visibility (public/private), default branch and icon. Each repo is a shared drive plus its own replicated metadata log.                                          |
| **Browse**       | Files tab (grid, grouping, filter, preview for image/video/audio/text) and Code tab (directory tree, folder navigation, sizes). At the repo root both tabs render the README under the listing. |
| **Markdown**     | READMEs and `.md` previews render with headings, nested/task lists, tables, quotes, code fences, images and resolved links. ` ```mermaid ` fences become diagrams client-side. No raw HTML.     |
| **Commits**      | The Commit tab diffs the live tree against HEAD (`A`/`M`/`D` per path) and records a snapshot on the chosen branch.                                                                             |
| **Branches**     | Create from an existing branch, switch, delete (default branch protected).                                                                                                                      |
| **Forks**        | Fork a public repo: it mirrors the drive into a new repo you own and keeps the source attribution.                                                                                              |
| **Explore**      | Search every repo this device owns or opened, plus everything other peers announced. Filters for yours / public / private.                                                                      |
| **Public repos** | The public catalogue: your own public repos and everything peers announced. Open a peer's repo as a read-only mirror; private ones show by name only and need an invite link.                   |
| **Uploads**      | Files or whole folders from any peer. Picking a folder uploads its **contents** into the current directory (no wrapper folder), and `.gitignore` is honoured on both ends.                      |
| **Local sync**   | Link a folder on disk. One-way by default (repo → folder); two-way is opt-in per folder, and even then the newer copy wins per file.                                                            |
| **Terminal CLI** | Work on a linked folder like a git checkout while the app runs: `status`, `commit`, `log`, `show`, `restore`, `sync`, `direction`, `auto on/off`.                                               |
| **Identity**     | Persistent keypair stored in the data dir; a profile record (handle, display name, bio, avatar) is seeded on first run and replicated to peers.                                                 |

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

A folder pick uploads what is _inside_ the folder. Picking `my-project` puts `README.md` at
`/README.md`, not `/my-project/README.md` — the same tree `git init` would give you.

### One-way by default

Nothing a peer does reaches the repo unless the owner allows it. Two separate switches, both
off by default:

| Switch               | Where                                            | Default       | What it changes                                                    |
| -------------------- | ------------------------------------------------ | ------------- | ------------------------------------------------------------------ |
| **Peer writes**      | Repo → Settings → Write direction                | off (one-way) | Whether other peers may push files and commits to this repo at all |
| **Folder direction** | Repo → Settings → Local sync → `1-way` / `2-way` | one-way       | Whether a linked folder on this device can push, or only receives  |

Propagation order is **newest → oldest**. With two-way on, a copy is only pushed when it is
strictly newer than the repo's; a tie goes to the repo, because that is the version every peer
already replicated. An older folder therefore cannot overwrite a newer file — the sync pulls
instead and reports the file as a conflict.

One-way folders never lose local work: local edits are counted as `local changes not pushed`,
kept on disk, and left out of the sync state so flipping the folder to two-way pushes them.

`peerhub commit` is an explicit push and runs two-way for that one pass, so a one-way folder
can still be committed from the terminal.

### Repository README

Enter a repo and, at the root, the README is rendered under the file listing (Files tab) and
under the tree (Code tab), the way a git host does it. Detection is case-insensitive
(`README.md`, `readme.markdown`, `README`, …) and the first match wins.

What renders:

- headings, emphasis, inline code, strikethrough, blockquotes, horizontal rules
- ordered and unordered lists, nested, with `- [x]` task checkboxes
- tables, including `:---` / `---:` alignment
- fenced code blocks with a language tag (no syntax highlighting yet)
- ` ```mermaid ` blocks, drawn as SVG diagrams in the browser
- images and links resolved **repo-relative**: `![logo](./img/logo.png)` loads the file from
  this repo, `[guide](docs/guide.md)` opens the file viewer, `docs/` opens the directory

Safety: the parser escapes everything first and only emits a fixed set of tags, so raw HTML in
a README is shown as text, never executed. `javascript:` links are dropped, links that climb
out of the repo root are reduced to their label, and mermaid runs with `securityLevel: 'strict'`
and no network access. A diagram that fails to parse keeps its source and prints mermaid's
error above it — it never renders blank.

## Terminal

The CLI talks to the running app over localhost; it never opens the corestore itself, so
there is still exactly one writer. Run it from inside a folder linked to a repo.

```bash
ph status          # installed app; from source: node cli/peerhub.mjs status
```

| Command                                        | What it does                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `peerhub ping`                                 | Is the app up, and does the token work?                                                                   |
| `peerhub status`                               | Branch, direction, HEAD, and the changelist: untracked / modified / deleted, plus `.gitignore` filtering  |
| `peerhub commit -m "msg"`                      | Pushes the folder (two-way for this run), then records a commit with its changelist and content snapshots |
| `peerhub log [-n 20]`                          | History, newest first, with `+added ~modified -deleted` per commit                                        |
| `peerhub show <sha>`                           | One commit, its parent and its full changelist (short shas work)                                          |
| `peerhub restore <sha> [paths…]`               | Writes that commit back into the folder; with no paths the folder is made to match that commit            |
| `peerhub sync [--push]`                        | One manual reconcile; `--push` also pushes local changes for that run only                                |
| `peerhub direction one-way\|two-way`           | How the linked folder may move: receive only (default) or push too                                        |
| `peerhub auto on\|off [--commit]`              | Periodic sync; `--commit` records a checkpoint commit and turns the folder two-way                        |
| `peerhub repos`                                | Repositories, their direction, linked folders and HEAD                                                    |
| `peerhub create <name> [--path .] [--private]` | New repo + link the folder + first sync                                                                   |
| `peerhub init [name]`                          | Same, with the repo named after the current folder                                                        |
| `peerhub rm <path>`                            | Delete a path locally and in the repo                                                                     |

**How it fits together**

- The linked folder is the working tree; the repo is the committed side. `status` digests the
  folder with the same hashing a commit uses, so what it lists is exactly what a commit records.
- `commit` runs the sync engine first, so local edits, deletions and `.gitignore` rules behave
  the same as they do from the UI, then writes the commit.
- Every commit stores a changelist (`A`/`M`/`D` per path) and a copy of each changed file under
  `/.peerhub/history/<sha>/…` inside the repo's shared drive. Unchanged files are not copied: a
  restore walks parents until a snapshot matches, so history costs about one copy per changed
  version and replicates to peers with the files.
- `restore <sha>` overwrites the folder with that commit. Add `--dry-run` to see the plan;
  files the repo tracks that the target commit never had are removed, but untracked local files
  (ignored, new, `.git`) are left alone.
- `auto on --commit` gives you a changelist even when nobody commits by hand: each pass that
  moved files becomes a commit named after its counts (`auto: +2 ~1 -1`).
- Auth: the endpoint requires the token the app writes to `<data-dir>/.cli-token` on boot. A web
  page cannot read that file, so a stray site cannot drive your repositories. The app must be
  running: `peerhub` is a client, not a second daemon.

### Terminal troubleshooting

| Symptom                                         | Cause and fix                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `File descriptor could not be locked`           | Two app instances are opening the same corestore. In dev mode an HMR reload can spawn a second one while the first still holds the store. Close the terminal and start the app again — only one process may own the data directory.  |
| `Cannot reach PeerHub at http://localhost:5173` | The app is not running, or it is on another port. The desktop app writes its URL to `<data-dir>/.cli-url` and the CLI reads it; in dev, pass `--url http://localhost:<port>` (or set `PEERHUB_URL`).                                 |
| `No CLI token at …/.cli-token`                  | The app has never opened its data directory. Start it once; the token is written on boot. `PEERHUB_TOKEN` overrides the file.                                                                                                        |
| `PeerHub: Invalid CLI token`                    | The token file changed (fresh data dir) or the command ran against another machine. Re-read `<data-dir>/.cli-token`.                                                                                                                 |
| `No repository is linked to <folder>`           | That folder is not a sync target. Link it in the repo's Settings tab, or run `peerhub create <name> --path .`. The error lists the folders that are linked.                                                                          |
| `'ph' is not recognized`                        | The shims are written when the app starts, so launch the app once after installing, and open a new terminal (PATH is read at shell start). Manual fix: add `%LOCALAPPDATA%\PeerHub\bin` to PATH, or run `PeerHub.exe --install-cli`. |
| History missing after deleting a repo           | Deleting a repo removes its records, not its folder: `sessions/<id>/` stays under the data directory. With the app stopped, delete that folder by hand to reclaim the space.                                                         |

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
  it hosts (`directory.ts`). That list is what the home page and the Explore tab read. Public
  repos advertise their drive and metadata keys; private ones advertise only name/description.
  Creating or deleting a repo pushes the full list to connected peers immediately, and the list
  is treated as authoritative for that peer — a deleted repo is retired on the other side
  rather than lingering.

  Discovery needs a DHT lookup, and the boot lookup only finds peers that had **already**
  announced, so two peers started together usually miss each other at first. The app therefore
  re-announces after 8 s and 25 s, every 60 s afterwards, and whenever you press **Refresh
  peers** (which also re-runs the lookup). The home page shows how many peers are on the
  network, so an empty catalogue is explainable instead of mysterious.

- **Git layer** — hyperdrive stores the _current_ tree, not history. `git.ts` builds one
  digest per path, and a commit is a record of that snapshot plus parent and message. Branch
  refs are pointers into that DAG. (No tags yet.)
- **Events** — a commit appends a `push` entry to one `activity` stream (`events.ts`), which
  already fans out to watchers' notifications. Stars, issues and reviews will use the same
  stream instead of inventing their own.

### Code map

| Path                                 | Role                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `src/lib/server/app.ts`              | corestore, keypair, swarm, root db, repo registry, join/create/fork                   |
| `src/lib/server/session.ts`          | one repository: cache + shared drives, metadata core, write forwarding                |
| `src/lib/server/shared-drive.ts`     | RPC layer over `distributed-drive` (uploads, deletes, meta writes)                    |
| `src/lib/server/git.ts`              | tree digests, commits, refs, diff, file preview                                       |
| `src/lib/server/repos.ts`            | repo catalog rows, fork, open-public                                                  |
| `src/lib/server/directory.ts`        | peer repo announcements                                                               |
| `src/lib/server/users.ts`            | identity and profiles                                                                 |
| `src/lib/server/events.ts`           | activity and notifications                                                            |
| `src/lib/server/ignores.ts`          | `.gitignore` loading for the upload guard and sync                                    |
| `src/lib/server/sync.ts`             | linked-folder two-way reconcile                                                       |
| `src/lib/server/readme.ts`           | root README detection + repo-relative link/image resolution                           |
| `src/lib/ignore.ts`                  | shared `.gitignore` parser/matcher and upload planner                                 |
| `src/lib/markdown.ts`                | markdown → HTML (escape-first; mermaid fences kept as placeholders)                   |
| `src/lib/components/Markdown.svelte` | renders markdown HTML, upgrades mermaid fences to SVG                                 |
| `src/lib/server/cli.ts`              | terminal operations: status, commit, restore, sync, auto, create, rm                  |
| `src/lib/server/history.ts`          | commit content snapshots and restoring them into a folder                             |
| `src/lib/server/paths.ts`            | the reserved `/.peerhub` area that holds history, never repo content                  |
| `src/lib/server/data-dir.ts`         | the one place that decides where the data directory lives                             |
| `src/lib/server/cli-token.ts`        | local token that guards the CLI endpoint                                              |
| `cli/peerhub.mjs`                    | the `peerhub` binary (npm `bin`)                                                      |
| `desktop/main.js`                    | Electron: single instance, in-process server, window, menu, `--smoke`                 |
| `desktop/cli-install.js`             | installs `ph` / `peerhub` shims and adds their folder to the user PATH                |
| `scripts/dev-desktop.mjs`            | Vite + Electron for development                                                       |
| `scripts/build-schema.cjs`           | hyperschema definitions → `spec/hyperschema`, `spec/hyperdb`                          |
| `electron-builder.yml`               | packaging: files, asar, icons, per-OS targets                                         |
| `src/routes/`                        | `/` dashboard, `/explore`, `/drive/[id]` with `code`, `commit`, `settings`, `preview` |

Schema is generated, never hand-edited:

```bash
npm run build:schema    # node scripts/build-schema.cjs — bump version, regenerate spec/*
```

Fields are appended, not reordered: hyperschema identifies them by position.

## Commands

| Command                   | What it does                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| `npm run desktop`         | Build, then open the app window                                           |
| `npm run desktop:dev`     | Vite + Electron, hot reload                                               |
| `npm run desktop:smoke`   | Headless boot check: server + `/` fetch, exit code 0/1                    |
| `npm run dist`            | Installer via electron-builder                                            |
| `npm run dist:dir`        | Unpacked app in `dist/`, no installer                                     |
| `npm run dev`             | Vite dev server only (browser)                                            |
| `npm run cli -- <cmd>`    | Terminal CLI (also `node cli/peerhub.mjs`, or `peerhub` after `npm link`) |
| `ph <cmd>`                | What the installed app puts on PATH (same CLI, includes `init`)           |
| `npm run build`           | Production build (adapter-node → `build/`)                                |
| `npm run build:schema`    | Regenerate the HyperDB schema                                             |
| `npm run check`           | `svelte-check` over the project                                           |
| `npm run format` / `lint` | Prettier write / check (lint is the CI gate, with the build)              |
| `npm run clean`           | Remove `build`, `dist`, `.svelte-kit`                                     |

## Tech stack

- **SvelteKit 2 / Svelte 5** with **adapter-node**, Vite, Tailwind CSS 4
- **Electron 40** — desktop window; the SvelteKit server runs in the main process
- **electron-builder** — NSIS / dmg / AppImage packaging
- **corestore** — keys, storage, replication sessions
- **hyperswarm** — DHT discovery and encrypted connections
- **hyperdrive** — content-addressed replicated files
- **hyperdb + hyperbee2 + hyperschema** — replicated, schema-typed metadata
- **distributed-drive** — aggregates local and remote drives behind one interface
- **protomux-rpc** — request/response over an encrypted peer connection
- **localdrive** — filesystem drive for local folders and caches
- **mermaid** — diagram rendering for README code fences (client-side, lazy-loaded)

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
- **Desktop packaging is only proven on Windows.** `npm run dist` produced
  `dist/PeerHub Setup 0.1.0.exe` here, and both the unpacked app and `--smoke` ran against the
  real data directory. The macOS dmg and Linux AppImage targets are configured but were not built
  in this environment; CI builds all three on a tag.
- **Commit authorship is a raw key.** Profiles exist, but the UI shows the first 8 hex
  characters instead of a handle, and there is no profile editor yet.
- **The only way to change a `.gitignore` is to upload it again.** No in-app file editor.
- **The CLI works on `main` only.** Branch creation and switching are UI-only for now, and
  there is no staging area/index: `commit` takes everything the folder changed.
- **Markdown is a deliberate subset.** No raw HTML blocks, footnotes, reference-style links or
  syntax highlighting. Mermaid is the one rich feature, and it ships as a lazy-loaded chunk.
- **No unit tests in the repo.** The automated check is `npm run desktop:smoke` (boots the server,
  fetches `/`, asserts the title, exits non-zero on failure); everything else has been scripted
  HTTP round trips and browser checks.
