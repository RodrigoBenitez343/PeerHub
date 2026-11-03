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

| Goal                    | Command                   | Output                                                                                                      |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Open the app            | `npm run desktop`         | window, no terminal needed                                                                                  |
| Develop with hot reload | `npm run desktop:dev`     | Vite + window                                                                                               |
| Browser only            | `npm run dev`             | http://localhost:5173                                                                                       |
| Installable app         | `npm run dist`            | `dist/PeerHub Setup <version>.exe` (NSIS), `.dmg`, `.AppImage` — bumps the version first, signed on Windows |
| Unpacked app            | `npm run dist:dir`        | `dist/win-unpacked/PeerHub.exe`                                                                             |
| Publish an update       | `npm run publish:release` | release in the `peerhub` repo, signed by this peer, peers copy it                                           |
| Headless boot check     | `npm run desktop:smoke`   | prints the served URL + title, exits 0/1                                                                    |
| Terminal command        | start the app once        | `ph` (and `peerhub`) on PATH, no Node needed                                                                |

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

PATH is only read when a shell starts, and Explorer hands out its own copy of the environment,
so two things keep this from needing a restart: the app broadcasts the environment change
(Explorer re-reads PATH for whatever it launches next) and it also mirrors the shims into
`%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on the default user PATH and therefore already
inside terminals that were opened before the install. Help → Command line tool (ph) shows the
shim path and can reinstall it; `PeerHub.exe --install-cli` and `--uninstall-cli` do the same
without opening a window.

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
                      cli-install.js writes the `ph` shims, updater.js replaces the binary
scripts/              build-schema.cjs, dev-desktop.mjs, clean.mjs, publish-release.mjs
cli/                  the `peerhub` terminal client (installed as `ph` in the app)
src/                  SvelteKit app
  lib/server/         all peer/storage logic (no UI imports)
  lib/components/     UI components
  routes/             /, /explore, /updates, /drive/[id]/{code,commit,settings,preview}, /api/*
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
| **Local clones** | Clone a repo into a folder from its header. One-way and mirroring by default (repo → folder); two-way is opt-in per clone, and even then the newer copy wins per file.                          |
| **Terminal CLI** | Work on a linked folder like a git checkout while the app runs: `status`, `commit`, `log`, `show`, `restore`, `sync`, `direction`, `auto on/off`.                                               |
| **Updates**      | The app updates itself from a signed release repo it replicates over P2P: check, download, verify, install. Publisher CLI included; no update server anywhere.                                  |
| **Large repos**  | A host-side change log means a linked folder asks "what changed after N" instead of listing the repo; the first full listing is the last one.                                                   |
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

### Cloning a repo into a folder

A folder that holds a repo is **cloned**, not linked by hand. Every repo header carries a
**Clone** button: it opens the OS folder chooser, and the repository is copied into the folder you
pick. From then on that folder follows the repo — additions, edits and **deletions** land on their
own.

- A clone starts empty, so its first sync records a complete base. That is what makes a later repo
  deletion apply: a folder that is handed files before it is ever synced has no base, and its stale
  copies are indistinguishable from local work — which is exactly how a "clone" used to end up with
  extra files that never went away.
- A clone is set up for the job: **one-way** (there is nowhere to push), **mirror** (a path the repo
  does not have is deleted from the folder) and **auto** (the owner's next pass lands without anyone
  pressing Sync). All three stay switchable per clone in Repo → Settings → Local clones.
- Cloning asks first when the folder already holds files. This app knows two cases: a folder it
  already clones _this_ repo into (same identity → the files are replaced, no question), and anything
  else, including a clone of a _different_ repo (that one is named, and you confirm before its files
  are replaced). A clone inside another clone, or a folder that contains one, is refused.
- `node_modules`, `.git` and anything the repo's `.gitignore` rules exclude are never pruned.

### One-way by default

Nothing a peer does reaches the repo unless the owner allows it. Separate switches, all of them
opt-in:

| Switch              | Where                                                     | Default       | What it changes                                                              |
| ------------------- | --------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------- |
| **Peer writes**     | Repo → Settings → Write direction                         | off (one-way) | Whether other peers may push files and commits to this repo at all           |
| **Clone direction** | Repo → Settings → Local clones → `1-way` / `2-way`        | one-way       | Whether a clone on this device can push, or only receives                    |
| **Keep extras**     | Repo → Settings → Local clones → `Keep extras` / `Mirror` | mirror        | One-way only: whether a local file the repo does not have is kept or deleted |

Propagation order is **newest → oldest**. With two-way on, a copy is only pushed when it is
strictly newer than the repo's; a tie goes to the repo, because that is the version every peer
already replicated. An older folder therefore cannot overwrite a newer file — the sync pulls
instead and reports the file as a conflict.

A one-way folder receives, so a file it holds that the repo does not have can never go anywhere.
A clone deletes it (mirror on) and counts it as `deleted`. Switch that clone to **Keep extras** and
the file is kept instead, reported as `local files not in the repo (kept)` — that is what a folder
holding your own scratch files wants, and it is what every folder did before mirroring existed.

A path with no recorded state is not a conflict: the run that adopts a folder reports what it
copied, and identical bytes on both sides are neither a conflict nor copied again. Local edits of
paths the repo still has are kept and left out of the sync state, so switching a clone to two-way
pushes them.

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

## Updates

The app updates itself the way it moves everything else: over the peer network, from a repo it
replicates. There is no update server, and no vendor is in the path between a publisher and the
machines running their build.

- **Release repo** — the repo named `peerhub` (case-insensitive; changeable on the Updates page).
  It is looked for among your own repos first, then among the public repos peers announced, so a
  teammate's mirror is enough when the publisher is offline.
- **What it carries** — `/release/channel.json` (the live manifest), `/release/versions/<version>.json`
  (one signed snapshot per publish) and the installers under `/release/assets/`, as ordinary files
  in that repo's content drive. Peers replicate them like any other file, which is why one machine's
  download becomes the next machine's source.
- **A tab, not a folder** — the store is infrastructure, so the repo's Files and Code tabs never list
  it: the repo shows its source, and its **Releases** tab shows the installers, with version, notes,
  date, signature check, size and SHA-256, each with a download link. Only the store's own paths are
  hidden (`release/channel.json`, `release/assets/…`, `release/versions/…`); a repo whose source has
  a `release/` folder keeps it.
- **Signed** — the manifest is an envelope (`peerhub-release/1`): a base64 payload plus an ed25519
  signature over the exact bytes of that payload. The signer must be the key that the directory
  says owns the repo. When that key is not known, the first manifest that verifies is pinned in
  `<data-dir>/updates.json` and every later check has to match it (`unpin` on the Updates page
  clears it). A manifest that does not verify is refused as a whole, never partly used.
- **Checked before it runs** — the installer is streamed into a staging folder while its SHA-256
  is computed, then size and digest are compared with the manifest. The desktop shell hashes the
  file again right before starting it, so a file swapped on disk after the check still cannot run.

| Where                               | What you can do                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/updates` (sidebar)                | See the running version, the release repo and the last check; check, download, install, change the repo name, turn auto-check/auto-download/auto-install on or off, unpin the signer |
| `/drive/<id>/releases` (repo tab)   | Every release the repo carries: version, notes, date, signer check, installers with size and SHA-256, and a download link                                                            |
| Help → Check for Updates…           | Same check, from the menu                                                                                                                                                            |
| Help → Install Update X and Restart | Appears once a verified installer is staged; applies it and quits the app                                                                                                            |

Defaults: auto-check and auto-download on, **auto-install off** — installing closes the app, so it
stays an explicit click. Applying is per platform: Windows runs the NSIS installer with
`--updated /S --force-run` and quits; Linux writes the new AppImage next to the running one and
renames it into place (live on the next start); macOS opens the downloaded disk image.

### Publishing a release

```bash
npm run dist
npm run publish:release -- --notes "what changed"
```

The script finds the running app (its `.cli-url`), streams each installer to
`POST /api/updates/publish` — token-guarded, the same trust boundary as the CLI — and the app
writes the bytes into the release repo and signs the manifest with the peer key others already
know it by. The announcement that follows is what makes peers see the new version on their next
check.

The app has to be running: it owns the repo, and the script never opens the corestore.

**The folder decides the repo.** The script sends its working directory, and if that folder is a repo
on this machine — linked through `ph init`, the Settings tab, or a sync pair — the release is
published _into that repo_, and the app remembers it as the release repo from then on. Releases are
therefore part of the repo they are built from: they appear in that repo's Releases tab, and no
second repo is created next to it. A remembered repo id keeps the choice stable when two repos share
a name (the store an earlier first-publish created, and the source repo initialised afterwards —
the source repo wins). Only when no repo claims the folder does the configured **release repo**
apply, and a publish with none yet **creates** it: public, empty, with nothing linked to a folder on
disk. A repo of the same name that is a mirror of another peer's is refused either way: only an
owner can publish, and a local copy would shadow the repo that peer is supposed to follow.

**A repo that moved strands older builds.** Builds before 0.1.8 resolve the release repo by _name_
against their own sessions first, so a machine that had already opened the old store repo keeps
reading that copy, which nothing publishes to any more. It has to be updated once by hand: copy the
current installer over, run it, and every later release arrives normally (the new build adopts the
repo its folder is in and remembers the id). Nothing the network does can move it, because the old
binary never asks again.

**A bad answer cannot kill a peer any more.** Every numeric field on the shared-drive channel is a
`uint`, and a `NaN` (a size read from an entry whose blocks were never downloaded) makes its encode
throw. protomux-rpc answers a failed encode by sending the same value as the message body, which
throws again — uncaught, in the peer that was _serving_ — as `ERR_OUT_OF_RANGE` from
`Buffer.allocUnsafe`. Sizes are clamped to a count and every handler answers with an empty shape
instead of throwing, so a missing block reads as an empty answer (0.1.10 onwards).

- Assets come from the newest installer per platform in `dist/` (older builds stay there and are skipped), or name them: `--asset win32-x64="dist/PeerHub Setup 0.1.4.exe"` (repeatable, `platform-arch=path`).
- `--dir`, `--arch`, `--url` and `--json` cover the rest; `--help` prints them.
- No `--version`: the manifest advertises whatever `package.json` says, because that is what the build stamped into the files. Asking for another version is refused instead of publishing a release nobody built.
- The server accepts bodies up to 2GB (`BODY_SIZE_LIMIT`, set by the desktop shell) — the default it would otherwise inherit from adapter-node is 512KB, which is smaller than one installer. Running `node build/index.js` by hand needs `BODY_SIZE_LIMIT=2G` in the environment for a publish to go through.

### Release number and signature

`npm run dist` is the release command, and it does three things before packaging:

1. **Bumps the version** — patch by default (`0.1.4` → `0.1.5`). A peer only accepts a
   release that is strictly newer than what it runs, so a number nobody has seen is what
   makes a build count as an update. `npm run version:bump -- --minor` / `--major` /
   `--set 2.0.0` pick another step; `PEERHUB_NO_BUMP=1 npm run dist` repackages without
   changing it. A CI build from a `v1.2.3` tag uses the tag and is never bumped, so the
   artifact cannot disagree with its own name.
2. **Finds the signing certificate** — a code-signing certificate with
   `CN=Rodrigo David Benitez, O=PeerHub` in the Windows certificate store, created once and
   reused (5 years, exportable). `npm run sign:cert` does just that step.
3. **Signs the build** — electron-builder signs `PeerHub.exe`, `elevate.exe`, the uninstaller
   and the installer with that certificate (`win.signtoolOptions` in `electron-builder.yml`),
   so Explorer shows `Rodrigo David Benitez` as the publisher. The executable's Company and
   Copyright fields carry the same name (`author` in `package.json`).

Caveat worth knowing: the certificate is self-signed, so a machine that has never trusted it
still calls the publisher unrecognised — the signature proves the build came from this
certificate, not that Windows was told to trust it. Options, in order of effort:

- **This machine** — import the certificate into _Trusted Root Certification Authorities_ and
  the signature validates locally. `PublicKey` prompts for consent once.
- **CI** — export the certificate as a `.pfx` and give electron-builder `CSC_LINK` +
  `CSC_KEY_PASSWORD`; it then signs on a runner that has no certificate store:
  `npm run sign:cert -- --export .certs/peerhub.pfx --password <secret>`. `.certs/` is
  gitignored — the file contains the private key. Without `CSC_LINK` the Windows CI job has
  nothing to sign with and fails rather than shipping an unsigned build.
- **Anyone else** — a bought code-signing certificate (or a trusted one) is the only way to
  avoid the SmartScreen warning on first run.

What it is not, yet: each update is the **full installer** (no binary deltas), the Windows build
is signed with a self-signed certificate rather than a bought one, so SmartScreen still warns on a
fresh installer, and publishing needs a source checkout — a compiled install can receive updates
but has no command to publish one.

## Large repositories: the change log

Listing a repo end to end for one changed file does not scale. The host now keeps a log of its own
writes, and a folder that has synced before only works the paths the log names.

- Every host write — a `put` or a `del`, from the UI or forwarded from a peer — appends one entry
  to `<data-dir>/sessions/<repo>/changelog.jsonl`: op, path, size, mtime, content hash and the
  version stamp the entry ended up with.
- A linked folder remembers where it stopped: a cursor plus the id of the log that handed it out.
  It asks for `changelog` over the existing `protomux-rpc` channel and applies only what came after
  that point, so a repo of 50k files costs what its changes cost.
- The log is bounded (50k entries, trimmed to 30k) and allowed to be incomplete: a cursor older
  than the front, or one that belongs to a recreated log, is answered with the **full listing**
  instead. An incomplete log never gets to tell a stale cursor "nothing changed".
- A path that fails keeps the old cursor, so the next run retries it; the cursor only moves past
  what was actually worked.
- When the diff came from the log, the sync summary says so: `sync: +2 ~1 -0 changes:3`.

Repo content itself no longer lives in the `sessions/<id>/shared` folder on the owner's disk. It
lives in the repo's own content drive, whose blocks replicate over the connection that is already
open, so a peer pulls the blocks it asks for instead of the owner sending whole files. The old
folder is migrated once per repo, on open: hash the local file, write it into the drive with that
hash and its mtime, verify the drive holds the expected number of bytes, and only then drop the
local copy. A copy that cannot be verified stays where it is and is reported — a half-migrated
repo must never lose the only copy of a file.

## Progress while it works

Both surfaces report the same events (`scan`, `upload`, `download`, `delete`), because both are
looking at one sync:

- **App** — the repo's Settings tab shows `scanning…` while the folder is walked and
  `12/1280 files` once the plan is known; the job bar counts real files rather than bytes guessed.
- **Terminal** — `ph status` / `ph sync` / `ph commit` draw a live line per file (`3/1280`), and a
  large file reports its own percentage and bytes (`47% 6/13 MiB`) on one rewritten line. Piped
  output prints one line per file instead, so logs stay readable.

The folder walk cannot know its own size until it ends, so it is reported as a count (`scanning
556 files …` on a terminal) and never as a percentage of an invented total.

## Terminal

The CLI talks to the running app over localhost; it never opens the corestore itself, so
there is still exactly one writer. Run it from inside a folder linked to a repo.

```bash
ph status          # installed app; from source: node cli/peerhub.mjs status
```

| Command                                        | What it does                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `peerhub ping`                                 | Is the app up, and does the token work?                                                                             |
| `peerhub status`                               | Branch, direction, HEAD, and the changelist: untracked / modified / deleted, plus `.gitignore` filtering            |
| `peerhub commit -m "msg"`                      | Pushes the folder (two-way for this run), then records a commit with its changelist and content snapshots           |
| `peerhub log [-n 20]`                          | History, newest first, with `+added ~modified -deleted` per commit                                                  |
| `peerhub show <sha>`                           | One commit, its parent and its full changelist (short shas work)                                                    |
| `peerhub restore <sha> [paths…]`               | Writes that commit back into the folder; with no paths the folder is made to match that commit                      |
| `peerhub sync [--push] [--prune]`              | One manual reconcile; `--push` also pushes local changes and `--prune` also deletes local extras, for that run only |
| `peerhub direction one-way\|two-way`           | How the clone may move: receive only (default) or push too                                                          |
| `peerhub auto on\|off [--commit]`              | Periodic sync; `--commit` records a checkpoint commit and turns the folder two-way                                  |
| `peerhub repos`                                | Repositories, their direction, linked folders and HEAD                                                              |
| `peerhub create <name> [--path .] [--private]` | New repo + link the folder + first sync                                                                             |
| `peerhub init [name]`                          | Same, with the repo named after the current folder                                                                  |
| `peerhub rm <path>`                            | Delete a path locally and in the repo                                                                               |

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
- Long commands narrate themselves: the folder walk counts files as it goes, each file gets a
  `done/total` line, and a large upload or download reports its own percentage. `--json` prints the
  result alone, with no progress mixed in.
- Auth: the endpoint requires the token the app writes to `<data-dir>/.cli-token` on boot. A web
  page cannot read that file, so a stray site cannot drive your repositories. The app must be
  running: `peerhub` is a client, not a second daemon.

### Terminal troubleshooting

| Symptom                                         | Cause and fix                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `File descriptor could not be locked`           | Two app instances are opening the same corestore. In dev mode an HMR reload can spawn a second one while the first still holds the store. Close the terminal and start the app again — only one process may own the data directory.                                                                 |
| `Cannot reach PeerHub at http://localhost:5173` | The app is not running, or it is on another port. The desktop app writes its URL to `<data-dir>/.cli-url` and the CLI reads it; in dev, pass `--url http://localhost:<port>` (or set `PEERHUB_URL`).                                                                                                |
| `No CLI token at …/.cli-token`                  | The app has never opened its data directory. Start it once; the token is written on boot. `PEERHUB_TOKEN` overrides the file.                                                                                                                                                                       |
| `PeerHub: Invalid CLI token`                    | The token file changed (fresh data dir) or the command ran against another machine. Re-read `<data-dir>/.cli-token`.                                                                                                                                                                                |
| `No repository is linked to <folder>`           | That folder is not a sync target. Link it in the repo's Settings tab, or run `peerhub create <name> --path .`. The error lists the folders that are linked.                                                                                                                                         |
| `'ph' is not recognized`                        | The shims are written when the app starts, so launch the app once after installing. If it still fails, the terminal predates the install and its PATH copy is stale: restart the app/terminal host, or run `PeerHub.exe --install-cli` again. Manual fix: add `%LOCALAPPDATA%\PeerHub\bin` to PATH. |
| History missing after deleting a repo           | Deleting a repo removes its records, not its folder: `sessions/<id>/` stays under the data directory. With the app stopped, delete that folder by hand to reclaim the space.                                                                                                                        |

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
  └ ghost-content/<id> (hyperdrive)  ◄────────►   content (replicated)
                                                    └ sync pair ↔ local folder
```

The metadata schema already carries the collections for issues, pull requests, reviews,
labels, milestones, stars, forks, wiki and webhooks. Nothing writes to them yet — see the
gap list.

- **Identity** — a corestore keypair; `users` maps the public key to a profile.
- **A repo is two things** — a shared drive (files, replicated with hyperdrive) and a
  metadata core (commits, refs, and the collections for issues/PRs/social). Both ride the
  same `corestore` replication stream, so opening one repo gets you the other.
- **One content drive per repo, by namespace** — each repo opens its own content drive through
  `store.namespace('ghost-content/<id>')`. It is a namespace rather than a core name because
  hyperdrive ignores the name it is given: every host drive would otherwise be the same
  exclusive core, and the second repo to open would wait on the first forever. A repo created
  before that change adopts the old core once (`<data-dir>/legacy-content-owner` names the repo
  that kept it) so its files are not orphaned.
- **Boot is visible** — the window opens on a "starting peerhub" page and polls `/api/status`
  while the corestore and its repos open, then swaps to the app. Each repo gets 45 s to open;
  one unreadable repo logs an error and is skipped instead of holding the window hostage.
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

| Path                                 | Role                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `src/lib/server/app.ts`              | corestore, keypair, swarm, root db, repo registry, join/create/fork                               |
| `src/lib/server/session.ts`          | one repository: cache + shared drives, metadata core, write forwarding                            |
| `src/lib/server/shared-drive.ts`     | RPC layer over `distributed-drive` (uploads, deletes, meta writes)                                |
| `src/lib/server/changelog.ts`        | per-repo change log: what a folder asks for instead of a full listing                             |
| `src/lib/server/content.ts`          | one-time move of `sessions/<id>/shared` into the repo's content drive                             |
| `src/lib/server/updates.ts`          | release manifest (sign, verify), download+digest check, publish into the release repo             |
| `src/lib/server/git.ts`              | tree digests, commits, refs, diff, file preview                                                   |
| `src/lib/server/repos.ts`            | repo catalog rows, fork, open-public                                                              |
| `src/lib/server/directory.ts`        | peer repo announcements                                                                           |
| `src/lib/server/users.ts`            | identity and profiles                                                                             |
| `src/lib/server/events.ts`           | activity and notifications                                                                        |
| `src/lib/server/ignores.ts`          | `.gitignore` loading for the upload guard and sync                                                |
| `src/lib/server/sync.ts`             | linked-folder two-way reconcile                                                                   |
| `src/lib/server/readme.ts`           | root README detection + repo-relative link/image resolution                                       |
| `src/lib/ignore.ts`                  | shared `.gitignore` parser/matcher and upload planner                                             |
| `src/lib/markdown.ts`                | markdown → HTML (escape-first; mermaid fences kept as placeholders)                               |
| `src/lib/components/Markdown.svelte` | renders markdown HTML, upgrades mermaid fences to SVG                                             |
| `src/lib/server/cli.ts`              | terminal operations: status, commit, restore, sync, auto, create, rm                              |
| `src/lib/server/history.ts`          | commit content snapshots and restoring them into a folder                                         |
| `src/lib/server/paths.ts`            | the reserved `/.peerhub` area that holds history, never repo content                              |
| `src/lib/server/data-dir.ts`         | the one place that decides where the data directory lives                                         |
| `src/lib/server/cli-token.ts`        | local token that guards the CLI endpoint                                                          |
| `cli/peerhub.mjs`                    | the `peerhub` binary (npm `bin`)                                                                  |
| `desktop/main.js`                    | Electron: single instance, in-process server, window, menu, `--smoke`                             |
| `desktop/cli-install.js`             | installs `ph` / `peerhub` shims and adds their folder to the user PATH                            |
| `desktop/updater.js`                 | polls the app for a release, stages it, re-hashes it, applies it per platform                     |
| `scripts/publish-release.mjs`        | streams a built installer into the release repo and signs the manifest                            |
| `scripts/dev-desktop.mjs`            | Vite + Electron for development                                                                   |
| `scripts/build-schema.cjs`           | hyperschema definitions → `spec/hyperschema`, `spec/hyperdb`                                      |
| `electron-builder.yml`               | packaging: files, asar, icons, per-OS targets                                                     |
| `src/routes/`                        | `/` dashboard, `/explore`, `/updates`, `/drive/[id]` with `code`, `commit`, `settings`, `preview` |

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
| `npm run dist`            | Bump the version, sign, and package the installer                         |
| `npm run version:bump`    | Bump `package.json` only (`--minor`, `--major`, `--set x.y.z`)            |
| `npm run sign:cert`       | Create or show the Windows signing certificate (`--export` writes a .pfx) |
| `npm run dist:dir`        | Unpacked app in `dist/`, no installer                                     |
| `npm run publish:release` | Publish `dist/` installers as an update in the `peerhub` release repo     |
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
- **sodium-native** — ed25519 keys and the release-manifest signature
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
  `dist/PeerHub Setup 0.1.8.exe` here; installers have been run over the existing install and the
  installed app boots the real data directory (5 repos), serves `/`, `/explore`, `/updates` and the
  repo tabs, reports `booted: true` on `/api/status`, and published its own build into the repo the
  source folder is linked to. A peer running an older build found that repo from the announcement,
  saw the new version, and downloaded it with a digest matching the manifest. The macOS dmg and
  Linux AppImage targets are configured but were not built in this environment; CI builds all three
  on a tag.
- **Commit authorship is a raw key.** Profiles exist, but the UI shows the first 8 hex
  characters instead of a handle, and there is no profile editor yet.
- **The only way to change a `.gitignore` is to upload it again.** No in-app file editor.
- **The CLI works on `main` only.** Branch creation and switching are UI-only for now, and
  there is no staging area/index: `commit` takes everything the folder changed.
- **Markdown is a deliberate subset.** No raw HTML blocks, footnotes, reference-style links or
  syntax highlighting. Mermaid is the one rich feature, and it ships as a lazy-loaded chunk.
- **Updates deliver the whole installer.** No binary deltas, so a release costs a full download
  per peer. The manifest is signed with the publisher's peer key; the Windows binaries carry an
  Authenticode signature from the self-signed `Rodrigo David Benitez` certificate, which only
  validates on a machine that was told to trust it — everywhere else Windows still calls the
  publisher unrecognised. macOS builds are neither signed nor notarized.
- **The first check on a machine trusts what verifies.** Without a pinned signer, the first
  manifest that passes its own signature is pinned; the directory's owner key is used when the
  release repo was announced, but a repo opened only by key has to be pinned first. Publishing
  also needs a source checkout — there is no `ph publish` in a compiled install.
- **Tests cover the model, not the UI.** `npm test` runs the `node:test` suites over the server
  modules and the CLI: `.gitignore` matching, sync planning and change-log cursors, the git model,
  changelogs, the release manifest, the CLI copy the installer writes. Browser behaviour is still
  checked by hand plus `npm run desktop:smoke` (boots the server, fetches `/`, exits non-zero on
  failure).
