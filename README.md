# PeerHub

Experimental peer-to-peer file sharing and media preview app built on the [Holepunch](https://holepunch.to) stack.

Share local folders across devices over encrypted P2P connections — no servers, no cloud.

## Tech Stack

- **[bare](https://github.com/holepunchto/bare)** / **[bare-native](https://github.com/holepunchto/bare-native)** — Runtime and native app builds (macOS, Android)
- **[hyperswarm](https://github.com/holepunchto/hyperswarm)** — Peer discovery and connections via DHT
- **[corestore](https://github.com/holepunchto/corestore)** — Persistent identity and storage
- **[distributed-drive](https://www.npmjs.com/package/distributed-drive)** — Aggregates multiple drives (local, remote) with RPC over protomux
- **[localdrive](https://github.com/holepunchto/localdrive)** — File system drive interface

## Features

- Add local drive folders to share
- Automatic sharing of drive meta to Peers over stream. Files are not copied, they are streamed.
- **Two-way sharing** — every peer with the session key can add, change and delete files in the
  shared file system, not just browse it. Edits to an existing shared file change the original
  file; new files land in the session's `shared` folder on the host.
- Browse files with lazy-loaded directory tree
- Upload files or whole folders and delete files from any peer
- **Local sync** — link a local folder to the shared files and push/pull manually, or let it sync
  automatically while connected. Additions, edits and deletions travel both ways.
- Preview video, audio, images, and text files
- Stream media over P2P connections in chunks
- Join peers by key — persistent across restarts
- Persistent identity via corestore keypair
- Cross-platform: macOS desktop + Android
- Any drive added is shared with Peers. One peer might add 10 different drives, and 2nd peer just connects to them, and caches files for later use! You don't need to know where the original file comes from, no duplicates, just transparent file access.

### Supported Drives

- LocalDrive - Add a path
- HyperDrive - Add a key
- gip-remote - Add a `git+pear://...` url

## Usage

```bash
# Install dependencies
npm install

# Build and run (macOS)
npm run dev

# Build for Android
npm run build:android
```

On startup, your peer key is displayed in the sidebar. Share it with another device running Ghost Drive and enter it in the "Join" field to connect.

Add local folders via the "Drives" section — files are only shared after explicitly adding a drive path.

### Writing

The peer that created the session hosts the files; everyone else forwards writes over the same
encrypted connection (a second `protomux-rpc` channel). A path that already exists in one of the
host's drives is written or deleted in place; a new path is created in the session's shared folder
(`<storage>/ghost-drive/sessions/<id>/shared`). Upload is available from the file grid, delete from
the per-file hover action. While disconnected a guest can only read its offline cache.

### Local sync

In a drive's settings, link a folder on this device to the shared files:

- **Sync now** — one reconcile run: files missing on either side are copied, changed files are
  copied to the other side, deletions propagate. The newest change wins when both sides changed.
- **Auto** — repeat the same reconcile every 15 seconds and right after a peer connects, so edits
  on either side show up on the other.

Per-path state from the last run is stored under the session directory, so a fresh copy is never
re-copied just because its mtime changed.

## Status

This is an early experiment. Known limitations:

- No encryption/whitelisting of peers yet (anyone with your key can browse and write)
- Writes are relayed through the session host, so they need it online
- Concurrent edits of the same file are resolved last-write-wins (no merge)
- File type detection is extension-based
