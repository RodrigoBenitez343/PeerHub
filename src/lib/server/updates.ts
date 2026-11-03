import b4a from 'b4a';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { crypto_sign_detached, crypto_sign_verify_detached } from 'sodium-native';
import { dataDir } from './data-dir.js';
import { broadcastAnnouncements, listAnnouncements } from './directory.js';
import { MANIFEST_FILE, RELEASE_ASSETS_DIR, RELEASE_VERSIONS_DIR } from './paths.js';
import { selfKeyHex } from './users.js';
import type PeerHubApp from './app.js';
import type DriveSession from './session.js';

// Self-update over the peer network.
//
// A release is one repo (default name `peerhub`) that carries a signed manifest
// plus the installers built from it. Nothing is fetched from a web server: the
// manifest and the binaries are read out of the repo's content Hyperdrive, so a
// peer pulls them from the owner — or from any other peer that already holds
// the blocks — over the same replication path repo files use. A peer that has
// downloaded an update keeps the blocks in its corestore, which is what makes
// the next peer's download come from its neighbour instead of the owner.
//
// Trust: the manifest is signed with the publisher's device key (the same
// ed25519 key the swarm handshake uses, derived from the corestore primary
// key), and the signature is checked against the key that peer is known by.
// A public release repo announces its repos with the announcer's key attached
// to an authenticated connection (directory.ts), so the publisher is learned,
// not guessed. For a repo that came in through an invite there is no such
// record: the first check pins the signer, and a later manifest signed by a
// different key is refused until the user unpins it.

export const RELEASE_FORMAT = 'peerhub-release/1';

// The manifest is a small JSON blob. Anything bigger is not one, and refusing
// early keeps a peer from spending its memory on a bogus file.
const MAX_MANIFEST = 256 * 1024;
const HEX64 = /^[0-9a-f]{64}$/i;
const SIGNATURE_BYTES = 64;
// Read retry window: a guest's replica starts empty, and the entry only shows
// up once the metadata core has replicated a few blocks from a peer.
const ENTRY_TIMEOUT_MS = 20_000;
// A download that stops delivering bytes is treated as failed instead of
// hanging the job forever (the peer may have gone away mid-file).
const IDLE_TIMEOUT_MS = 60_000;

export interface ReleaseAsset {
	platform: string;
	arch: string;
	/** Path inside the repo that holds the bytes. */
	path: string;
	/** File name, used for the staged copy on disk. */
	name: string;
	size: number;
	sha256: string;
}

/** What the signature covers: the manifest before it becomes a signed envelope. */
export interface ReleasePayload {
	format: string;
	version: string;
	notes: string;
	publishedAt: number;
	assets: ReleaseAsset[];
}

export interface SignedRelease {
	format: string;
	/** base64 of the exact bytes the signature covers. */
	payload: string;
	signer: string;
	signature: string;
}

export interface UpdateSettings {
	/** Repo that carries the releases. Matched by name, case-insensitive. */
	repo: string;
	/**
	 * Id of the repo that carried them last, so a name with two owners behind it
	 * (the store a first publish created, and the source repo somebody later
	 * initialised) cannot flip the choice between two repos.
	 */
	repoId: string | null;
	autoCheck: boolean;
	autoDownload: boolean;
	autoInstall: boolean;
	/** Pinned publisher key; null means "derive it, then pin on the first check". */
	trustedSigner: string | null;
}

export type UpdateStatus =
	'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';

export interface UpdateTarget {
	version: string;
	notes: string;
	publishedAt: number;
	signerKey: string;
	asset: ReleaseAsset;
	downloaded: number;
	/** Absolute path of the verified copy; null until it is complete. */
	file: string | null;
}

export interface UpdateRepoView {
	id: string;
	name: string;
	isGuest: boolean;
	peers: number;
	writable: boolean;
	/** Folder on this disk the repo is linked to, if any. */
	folder: string | null;
}

/**
 * A repo as the release-repo resolver sees it.
 *
 * The two facts that matter are `isGuest` (a mirror cannot be published into)
 * and `folder` (a repo somebody works in is the one their releases belong to).
 */
export interface RepoChoice {
	id: string;
	name: string;
	isGuest: boolean;
	folder: string | null;
}

/** One release as a repo carries it — what the repo's Releases tab lists. */
export interface RepoRelease {
	version: string;
	notes: string;
	publishedAt: number;
	/** Key the manifest names as its signer. */
	signer: string;
	/** The signature checked out against the key this peer knows the owner by. */
	verified: boolean;
	/** Why it does not verify, when it does not. */
	problem: string | null;
	assets: ReleaseAsset[];
}

export interface RepoReleases {
	/** Why nothing could be read, when something went wrong. */
	error: string | null;
	/** Owner key, when this peer knows it (an announcement names it). */
	publisher: string | null;
	items: RepoRelease[];
}

/** One file of a release store, open for reading. */
export interface ReleaseFile {
	size: number;
	stream: AsyncIterable<Buffer>;
}

export interface UpdateSnapshot {
	/** Version of the code that is running now. */
	version: string;
	platform: string;
	arch: string;
	/** False outside the desktop shell: a browser cannot replace a binary. */
	canInstall: boolean;
	status: UpdateStatus;
	error: string | null;
	checkedAt: number | null;
	target: UpdateTarget | null;
	progress: { received: number; total: number } | null;
	repo: UpdateRepoView | null;
	/** Key the release repo's owner is known by, when it is known. */
	publisher: string | null;
	settings: UpdateSettings;
	/** The desktop shell asked for the install and has not acted on it yet. */
	installRequested: boolean;
}

const DEFAULT_SETTINGS: UpdateSettings = {
	repo: 'peerhub',
	repoId: null,
	autoCheck: true,
	autoDownload: true,
	// Installing closes the app, so it stays an explicit choice until asked for.
	autoInstall: false,
	trustedSigner: null
};

// --- manifest -------------------------------------------------------------

function withinPath(value: unknown): string | null {
	if (typeof value !== 'string' || !value.startsWith('/')) return null;
	if (value.includes('\0') || value.split('/').includes('..')) return null;
	return value;
}

function plainName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	// A staged file is written by its name, so it must not be able to escape the
	// staging folder or reach another path through a separator. Spaces are kept:
	// electron-builder names its installers "PeerHub Setup 0.2.0.exe".
	if (!/^[A-Za-z0-9._ -]{1,128}$/.test(value) || value === '.' || value === '..') return null;
	return value;
}

function assetOf(raw: any): ReleaseAsset | null {
	const assetPath = withinPath(raw?.path);
	const name = plainName(raw?.name);
	const sha = typeof raw?.sha256 === 'string' ? raw.sha256.toLowerCase() : '';
	if (!assetPath || !name || !HEX64.test(sha)) return null;
	if (typeof raw.platform !== 'string' || typeof raw.arch !== 'string') return null;
	const size = Math.round(Number(raw.size));
	if (!Number.isFinite(size) || size <= 0) return null;
	return {
		platform: raw.platform,
		arch: raw.arch,
		path: assetPath,
		name,
		size,
		sha256: sha
	};
}

/**
 * The exact bytes a signature covers.
 *
 * One function for signing and for verifying, so the two can never disagree
 * about field order or optional fields — the usual way a hand-rolled signature
 * stops verifying after a harmless refactor.
 */
export function payloadBytes(payload: ReleasePayload): Buffer {
	return Buffer.from(
		JSON.stringify({
			format: payload.format || RELEASE_FORMAT,
			version: payload.version,
			notes: payload.notes ?? '',
			publishedAt: Math.round(Number(payload.publishedAt) || 0),
			assets: (payload.assets ?? []).map((asset) => ({
				platform: asset.platform,
				arch: asset.arch,
				path: asset.path,
				name: asset.name,
				size: Math.round(Number(asset.size) || 0),
				sha256: String(asset.sha256 ?? '').toLowerCase()
			}))
		}),
		'utf8'
	);
}

export function signRelease(
	keyPair: { publicKey: Buf; secretKey: Buf },
	payload: ReleasePayload
): SignedRelease {
	const bytes = payloadBytes(payload);
	const signature = b4a.alloc(SIGNATURE_BYTES);
	crypto_sign_detached(signature, bytes, b4a.from(keyPair.secretKey));
	return {
		format: RELEASE_FORMAT,
		payload: bytes.toString('base64'),
		signer: b4a.toString(keyPair.publicKey, 'hex'),
		signature: b4a.toString(signature, 'hex')
	};
}

/**
 * Check a manifest's signature and shape.
 *
 * `expectedSigner` is the publisher this peer already trusts. The signer inside
 * the envelope is only used to pick the key that verifies it: a manifest that
 * says who signed it is not evidence of anything on its own.
 */
export function verifyRelease(
	raw: Buffer | string,
	expectedSigner?: string | null
): { payload: ReleasePayload; signer: string } {
	let envelope: any;
	try {
		envelope = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
	} catch {
		throw new Error('Release manifest is not JSON');
	}
	if (!envelope || envelope.format !== RELEASE_FORMAT) {
		throw new Error('Not a PeerHub release manifest');
	}

	const signer = typeof envelope.signer === 'string' ? envelope.signer.toLowerCase() : '';
	const signature = typeof envelope.signature === 'string' ? envelope.signature : '';
	const encoded = typeof envelope.payload === 'string' ? envelope.payload : '';
	if (!HEX64.test(signer) || !/^[0-9a-f]{128}$/i.test(signature) || !encoded) {
		throw new Error('Release manifest is malformed');
	}
	if (expectedSigner && signer !== expectedSigner.toLowerCase()) {
		throw new Error(
			`Release was signed by ${shortKey(signer)} but this peer trusts ${shortKey(expectedSigner)}`
		);
	}

	const bytes = Buffer.from(encoded, 'base64');
	const ok = crypto_sign_verify_detached(
		Buffer.from(signature, 'hex'),
		bytes,
		Buffer.from(signer, 'hex')
	);
	if (!ok) throw new Error('Release signature does not verify');

	let data: any;
	try {
		data = JSON.parse(bytes.toString('utf8'));
	} catch {
		throw new Error('Release payload is not JSON');
	}
	if (data?.format !== RELEASE_FORMAT) throw new Error('Release payload has the wrong format');
	if (typeof data.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(data.version)) {
		throw new Error(`Release version is not usable: ${data.version}`);
	}
	if (!Array.isArray(data.assets) || data.assets.length === 0) {
		throw new Error('Release manifest lists no files');
	}

	const assets: ReleaseAsset[] = [];
	for (const entry of data.assets) {
		const asset = assetOf(entry);
		if (!asset) throw new Error('Release manifest has an unusable asset entry');
		assets.push(asset);
	}

	return {
		signer,
		payload: {
			format: RELEASE_FORMAT,
			version: data.version,
			notes: typeof data.notes === 'string' ? data.notes : '',
			publishedAt: Math.round(Number(data.publishedAt) || 0),
			assets
		}
	};
}

export function assetFor(
	payload: ReleasePayload,
	platform: string,
	arch: string
): ReleaseAsset | null {
	return payload.assets.find((asset) => asset.platform === platform && asset.arch === arch) ?? null;
}

// --- versions -------------------------------------------------------------

function parseVersion(value: string): { nums: number[]; pre: string } {
	const text = String(value ?? '').trim();
	const dash = text.indexOf('-');
	const core = dash === -1 ? text : text.slice(0, dash);
	const pre = dash === -1 ? '' : text.slice(dash + 1);
	const nums = core.split('.').map((part) => {
		const parsed = Number.parseInt(part, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	});
	while (nums.length < 3) nums.push(0);
	return { nums, pre };
}

/**
 * Compare two versions the way an updater has to: numerically, so 0.10.0 is not
 * "older" than 0.9.0 the way a string comparison would claim, and a pre-release
 * sorts before its release.
 */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i++) {
		const l = left.nums[i] ?? 0;
		const r = right.nums[i] ?? 0;
		if (l !== r) return l < r ? -1 : 1;
	}
	if (left.pre === right.pre) return 0;
	if (!left.pre) return 1;
	if (!right.pre) return -1;
	return left.pre < right.pre ? -1 : 1;
}

function shortKey(key: string): string {
	return `${key.slice(0, 8)}…`;
}

// --- which repo carries the releases --------------------------------------

function sameName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Which of this peer's repos carries the releases.
 *
 * A name alone is not enough: the same name can sit behind two repos — a store
 * an earlier publish created, and the source repo somebody initialised
 * afterwards — and resolving to the wrong one files every release in a repo
 * nobody recognises as theirs. Order: the remembered repo, then a repo linked to
 * a folder on this disk (somebody's repo, not one the app made up), then any own
 * repo, then a mirror. One answer, so the tab, the updater and the publisher
 * cannot disagree.
 */
export function chooseReleaseRepo(
	choices: RepoChoice[],
	wanted: string,
	repoId?: string | null
): RepoChoice | null {
	if (!wanted || !wanted.trim()) return null;
	if (repoId) {
		const remembered = choices.find((choice) => choice.id === repoId);
		if (remembered) return remembered;
	}

	let linked: RepoChoice | null = null;
	let own: RepoChoice | null = null;
	let mirror: RepoChoice | null = null;
	for (const choice of choices) {
		if (!sameName(choice.name, wanted)) continue;
		if (choice.isGuest) mirror = mirror ?? choice;
		else if (choice.folder) linked = linked ?? choice;
		else own = own ?? choice;
	}
	return linked ?? own ?? mirror;
}

/**
 * A folder as it is compared: Windows ignores case and accepts both separators,
 * anywhere else the string has to match as it is or two different directories
 * would collapse into one.
 */
function folderKey(value: string): string {
	const trimmed = String(value ?? '')
		.trim()
		.replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
}

/**
 * The repo a folder belongs to — what a publish run inside that folder means.
 *
 * Longest match wins, so a repo checked out inside another one still resolves to
 * its own folder, and the repo wins over the configured name. Only repos this
 * peer owns can be published into, so a mirror is never the answer.
 */
export function repoForFolder(choices: RepoChoice[], folder: string): RepoChoice | null {
	const target = folderKey(folder);
	if (!target) return null;

	let best: RepoChoice | null = null;
	let bestLength = -1;
	for (const choice of choices) {
		if (choice.isGuest || !choice.folder) continue;
		const key = folderKey(choice.folder);
		if (!key) continue;
		if (target !== key && !target.startsWith(`${key}/`)) continue;
		if (key.length > bestLength) {
			best = choice;
			bestLength = key.length;
		}
	}
	return best;
}

/** Version of the code that is running. Electron passes its own; dev reads package.json. */
export function runningVersion(): string {
	const fromShell = process.env.PEERHUB_VERSION;
	if (fromShell) return fromShell;
	try {
		const file = new URL('../../../package.json', import.meta.url);
		const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (typeof pkg.version === 'string') return pkg.version;
	} catch {
		// A bundled build has no package.json next to the module; the shell sets
		// PEERHUB_VERSION there, so this is only the last resort.
	}
	return '0.0.0';
}

// --- files ----------------------------------------------------------------

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function settingsPath(): string {
	return path.join(dataDir(), 'updates.json');
}

function normalizeSettings(raw: any): UpdateSettings {
	const repo = typeof raw?.repo === 'string' ? raw.repo.trim() : '';
	const repoId = typeof raw?.repoId === 'string' ? raw.repoId.trim() : '';
	return {
		repo: repo || DEFAULT_SETTINGS.repo,
		repoId: repoId || null,
		autoCheck: raw?.autoCheck !== false,
		autoDownload: raw?.autoDownload !== false,
		autoInstall: raw?.autoInstall === true,
		trustedSigner:
			typeof raw?.trustedSigner === 'string' && HEX64.test(raw.trustedSigner)
				? raw.trustedSigner.toLowerCase()
				: null
	};
}

function loadSettings(): UpdateSettings {
	try {
		return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

function saveSettings(settings: UpdateSettings): void {
	const file = settingsPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// Written aside and renamed: a crash mid-write must not leave a settings file
	// that fails to parse and silently reverts every preference.
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
	fs.renameSync(tmp, file);
}

async function collect(source: AsyncIterable<Buf>, limit = MAX_MANIFEST): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of source) {
		total += chunk.byteLength;
		if (total > limit) throw new Error('File is larger than expected');
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/**
 * Yield a stream's chunks, failing when it goes quiet for `idleMs`.
 *
 * A Hyperdrive read waits for a block no connected peer has, which looks like a
 * hang rather than an error. The timer turns that into a message the UI can
 * show ("no peer is serving this file") without killing a slow-but-moving
 * transfer.
 */
async function* withIdleTimeout(
	source: AsyncIterable<Buf>,
	idleMs = IDLE_TIMEOUT_MS,
	label = 'transfer'
): AsyncGenerator<Buffer> {
	const iterator = source[Symbol.asyncIterator]();
	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} stalled — no peer is serving it`)),
					idleMs
				);
				timer.unref?.();
			});
			let next: IteratorResult<Buf>;
			try {
				next = await Promise.race([iterator.next(), timeout]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (next.done) return;
			if (next.value && next.value.byteLength > 0) yield Buffer.from(next.value);
		}
	} finally {
		// A stalled read is abandoned; the pending call settles on its own.
		await iterator.return?.(undefined).catch(() => {});
	}
}

// Bound a call that may never answer. A guest's RPC read waits on a host that
// can be gone without closing the socket; without this the check hangs instead
// of reporting it.
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	}) as Promise<T>;
}

// --- service --------------------------------------------------------------

/**
 * Per-app updater. One instance, because a check and a download share state
 * (target version, progress) and a second concurrent check would race itself.
 */
export class UpdateService {
	readonly app: PeerHubApp;
	private settings: UpdateSettings;
	private status: UpdateStatus = 'idle';
	private error: string | null = null;
	private checkedAt: number | null = null;
	private target: UpdateTarget | null = null;
	private progress: { received: number; total: number } | null = null;
	private repoView: UpdateRepoView | null = null;
	private publisher: string | null = null;
	private checking: Promise<void> | null = null;
	private downloading: Promise<void> | null = null;
	private installRequested = false;
	/** Assets uploaded in this process, keyed by file name: what a publish signs. */
	private uploads = new Map<string, { path: string; size: number; sha256: string }>();

	constructor(app: PeerHubApp) {
		this.app = app;
		this.settings = loadSettings();
	}

	get version(): string {
		return runningVersion();
	}

	get canInstall(): boolean {
		// Only the desktop shell can replace what is on disk; a browser tab cannot.
		return !!process.versions.electron;
	}

	get settingsSnapshot(): UpdateSettings {
		return { ...this.settings };
	}

	snapshot(): UpdateSnapshot {
		return {
			version: this.version,
			platform: process.platform,
			arch: process.arch,
			canInstall: this.canInstall,
			status: this.status,
			error: this.error,
			checkedAt: this.checkedAt,
			target: this.target ? { ...this.target, asset: { ...this.target.asset } } : null,
			progress: this.progress ? { ...this.progress } : null,
			repo: this.repoView ? { ...this.repoView } : null,
			publisher: this.publisher,
			settings: this.settingsSnapshot,
			installRequested: this.installRequested
		};
	}

	updateSettings(patch: Partial<UpdateSettings>): UpdateSettings {
		// A different name means a different repo: the remembered id belonged to the
		// old one and would otherwise keep answering for the new name.
		const renamed =
			typeof patch.repo === 'string' && patch.repo.trim() !== this.settings.repo.trim();
		this.settings = normalizeSettings({
			...this.settings,
			...patch,
			...(renamed ? { repoId: null } : {})
		});
		saveSettings(this.settings);
		// A changed repo invalidates what the last check found.
		this.target = null;
		this.status = 'idle';
		this.checkedAt = null;
		this.repoView = null;
		return this.settingsSnapshot;
	}

	requestInstall(): void {
		if (!this.canInstall)
			throw new Error('Replacing the app needs the desktop build, not a browser tab');
		if (this.status !== 'ready') throw new Error('No verified update is waiting to be installed');
		this.installRequested = true;
	}

	/** Called by the desktop shell once it has acted on the request. */
	clearInstallRequest(): void {
		this.installRequested = false;
	}

	// --- check ---

	async check(): Promise<UpdateSnapshot> {
		if (this.checking) {
			await this.checking;
			return this.snapshot();
		}
		this.checking = this.runCheck().finally(() => {
			this.checking = null;
		});
		await this.checking;
		return this.snapshot();
	}

	private async runCheck(): Promise<void> {
		this.status = 'checking';
		this.error = null;
		this.progress = null;
		try {
			const session = await this.resolveRepo();
			if (!session) {
				this.status = 'idle';
				this.target = null;
				this.error =
					this.error ??
					`No release repo named "${this.settings.repo}" is reachable. Create it (or open it from Explore) to receive updates.`;
				this.checkedAt = Date.now();
				return;
			}

			this.publisher = await this.publisherOf(session);
			let raw: Buffer;
			try {
				raw = await this.readRepoFile(session, MANIFEST_FILE);
			} catch (err: any) {
				this.status = 'idle';
				this.target = null;
				// A mirror nobody announces is the shape of a repo that moved: the copy
				// is still on this disk, so it keeps being chosen, and it will never
				// carry another release. Say that instead of "no manifest".
				const orphan = session.isGuest && !(await this.isAnnounced(session));
				this.error = orphan
					? `The release repo this peer follows ("${session.name}") is a copy of a repo nobody is publishing any more — its owner moved the releases. Open the current repo from Explore, or set its name on this page.`
					: `No release manifest in ${session.name}: ${err?.message ?? err}`;
				this.checkedAt = Date.now();
				return;
			}

			// The publisher this peer will accept: the announced owner when it is
			// known, then whatever the user pinned. An announced owner outranks a pin,
			// because the pin can only have come from a repo that had none.
			const expected = this.publisher ?? this.settings.trustedSigner;
			const { payload, signer } = verifyRelease(raw, expected);
			if (!expected) {
				// Invite-only repo, no announcement to attribute it to: pin the signer
				// the first time and hold every later manifest to the same key.
				this.settings = { ...this.settings, trustedSigner: signer };
				saveSettings(this.settings);
			}
			this.publisher = signer;

			const asset = assetFor(payload, process.platform, process.arch);
			this.checkedAt = Date.now();

			if (compareVersions(payload.version, this.version) <= 0) {
				this.status = 'current';
				this.target = null;
				return;
			}

			if (!asset) {
				this.status = 'idle';
				this.target = null;
				this.error = `Release ${payload.version} has no build for ${process.platform}-${process.arch}`;
				return;
			}

			// A previous check may already have staged this exact version: reuse it
			// instead of making the user download the same file twice. The digest is
			// re-checked by the shell immediately before it installs, so a stale copy
			// here cannot become an unverified install.
			const staged = this.stagedPath(payload.version, asset);
			const ready = fs.existsSync(staged) && fs.statSync(staged).size === asset.size;
			this.status = ready ? 'ready' : 'available';
			this.target = {
				version: payload.version,
				notes: payload.notes,
				publishedAt: payload.publishedAt,
				signerKey: signer,
				asset,
				downloaded: ready ? asset.size : 0,
				file: ready ? staged : null
			};
		} catch (err: any) {
			// Never a silent failure: the page and the shell both read `error`.
			this.status = 'error';
			this.error = err?.message ?? String(err);
			this.target = null;
			this.checkedAt = Date.now();
		}
	}

	// --- download ---

	startDownload(): UpdateSnapshot {
		if (this.downloading) return this.snapshot();
		if (!this.target) throw new Error('Nothing to download — check for an update first');
		const target = this.target;
		this.downloading = this.runDownload(target).finally(() => {
			this.downloading = null;
		});
		return this.snapshot();
	}

	async download(): Promise<UpdateSnapshot> {
		this.startDownload();
		await this.downloading?.catch(() => {});
		return this.snapshot();
	}
	/** Where a version's installer lives on disk once it is verified. */
	private stagedPath(version: string, asset: ReleaseAsset): string {
		return path.join(
			dataDir(),
			'updates',
			`${version}-${asset.platform}-${asset.arch}`,
			asset.name
		);
	}

	private async runDownload(target: UpdateTarget): Promise<void> {
		this.status = 'downloading';
		this.error = null;
		this.progress = { received: 0, total: target.asset.size };

		const file = this.stagedPath(target.version, target.asset);
		const tmp = `${file}.part`;

		try {
			await fsp.mkdir(path.dirname(file), { recursive: true });
			// A copy from an earlier attempt is re-verified below; starting over is
			// cheaper than trusting a file whose length happens to match.
			await fsp.rm(tmp, { force: true });

			const session = await this.resolveRepo();
			if (!session) throw new Error(`No release repo named "${this.settings.repo}" is reachable`);

			const hash = crypto.createHash('sha256');
			const handle = await fsp.open(tmp, 'w');
			let received = 0;
			let lastReport = 0;
			try {
				for await (const chunk of withIdleTimeout(
					this.readRepoStream(session, target.asset.path),
					IDLE_TIMEOUT_MS,
					target.asset.name
				)) {
					hash.update(chunk);
					await handle.write(chunk);
					received += chunk.byteLength;
					target.downloaded = received;
					const now = Date.now();
					if (now - lastReport > 200) {
						lastReport = now;
						this.progress = { received, total: target.asset.size };
					}
				}
			} finally {
				await handle.close();
			}

			this.progress = { received, total: target.asset.size };
			if (received !== target.asset.size) {
				throw new Error(
					`Downloaded ${received} of ${target.asset.size} bytes — the repo holds a different file`
				);
			}
			const digest = hash.digest('hex');
			if (digest !== target.asset.sha256) {
				throw new Error(
					`Checksum mismatch: got ${digest.slice(0, 12)}…, expected ${target.asset.sha256.slice(0, 12)}…`
				);
			}

			await fsp.rm(file, { force: true });
			await fsp.rename(tmp, file);
			target.file = file;
			this.status = 'ready';
			this.target = target;
		} catch (err: any) {
			await fsp.rm(tmp, { force: true }).catch(() => {});
			this.status = 'error';
			this.error = `Download failed: ${err?.message ?? err}`;
			this.progress = null;
		}
	}

	// --- publishing (owner only) ---

	/**
	 * Store one installer in the release repo and remember its digest.
	 *
	 * The bytes are hashed as they are written, so the manifest signs what the
	 * drive actually holds instead of what the caller claimed it was sending.
	 */
	async publishAsset(
		name: string,
		source: AsyncIterable<Buf>,
		folder?: string | null
	): Promise<{ path: string; size: number; sha256: string }> {
		const session = await this.ensureReleaseRepo(folder);

		const clean = plainName(name);
		if (!clean) throw new Error('Asset name must be a plain file name');

		const repoPath = `${RELEASE_ASSETS_DIR}/${clean}`;
		const hash = crypto.createHash('sha256');
		let size = 0;

		async function* passThrough() {
			for await (const chunk of source) {
				if (!chunk || chunk.byteLength === 0) continue;
				hash.update(chunk);
				size += chunk.byteLength;
				yield Buffer.from(chunk);
			}
		}

		await session.putFile(repoPath, passThrough());
		if (size === 0) throw new Error('Asset is empty');

		const record = { path: repoPath, size, sha256: hash.digest('hex') };
		this.uploads.set(clean, record);
		return record;
	}

	/**
	 * Sign the manifest and write it into the repo. Only the assets uploaded in
	 * this process can be published: their digests are the ones measured here.
	 */
	async publishRelease(input: {
		version: string;
		notes?: string;
		assets: Array<{ platform: string; arch: string; name: string }>;
		/** Directory the publish runs in; decides the repo (see ensureReleaseRepo). */
		folder?: string | null;
	}): Promise<ReleasePayload> {
		const session = await this.ensureReleaseRepo(input?.folder);
		if (!input?.assets?.length) throw new Error('Publish needs at least one asset');

		const assets: ReleaseAsset[] = [];
		for (const entry of input.assets) {
			const name = plainName(entry.name);
			const stored = name ? this.uploads.get(name) : null;
			if (!name || !stored) throw new Error(`Asset ${entry.name} was not uploaded in this session`);
			assets.push({
				platform: entry.platform,
				arch: entry.arch,
				path: stored.path,
				name,
				size: stored.size,
				sha256: stored.sha256
			});
		}

		const payload: ReleasePayload = {
			format: RELEASE_FORMAT,
			version: input.version,
			notes: input.notes ?? '',
			publishedAt: Date.now(),
			assets
		};

		// The key the swarm handshake already uses: a peer that trusts this peer's
		// identity trusts its releases without a second key to distribute.
		const keyPair = await (this.app.store as any).createKeyPair('ghost-drive');
		const signed = signRelease(keyPair, payload);
		const bytes = Buffer.from(JSON.stringify(signed, null, '\t') + '\n');
		await session.putFile(
			MANIFEST_FILE,
			(async function* () {
				yield bytes;
			})()
		);

		// One snapshot per version, beside the live manifest: the repo's Releases
		// tab lists them, so a publish replaces `channel.json` without erasing what
		// came before it. A version that cannot be a file name skips the snapshot —
		// the manifest above is what updates are actually read from.
		const snapshot = plainName(`${payload.version}.json`);
		if (snapshot) {
			await session
				.putFile(
					`${RELEASE_VERSIONS_DIR}/${snapshot}`,
					(async function* () {
						yield bytes;
					})()
				)
				.catch((err: any) =>
					console.warn('[updates] release snapshot not written:', err?.message ?? err)
				);
		}

		// The manifests now in the repo describe these uploads, so a second publish
		// of the same file name has to be a fresh upload, not the previous digest.
		for (const asset of assets) this.uploads.delete(asset.name);
		// Not 'current': the manifest usually advertises a newer version than the
		// build publishing it, and the next check is what decides.
		this.status = 'idle';
		this.target = null;
		this.checkedAt = Date.now();
		this.publisher = b4a.toString(keyPair.publicKey, 'hex');
		this.repoView = this.viewOf(session);
		return payload;
	}

	// --- repo plumbing ---

	private viewOf(session: DriveSession): UpdateRepoView {
		return {
			id: session.id,
			name: session.name,
			isGuest: session.isGuest,
			peers: session.peerCount,
			writable: session.canWrite,
			folder: session.localFolders()[0] ?? null
		};
	}

	/** Every repo this peer has, in the shape the resolvers take. */
	private choices(): RepoChoice[] {
		const list: RepoChoice[] = [];
		for (const session of this.app.sessions.values()) {
			list.push({
				id: session.id,
				name: session.name,
				isGuest: session.isGuest,
				folder: session.localFolders()[0] ?? null
			});
		}
		return list;
	}

	/**
	 * Remember which repo holds the releases, so the next resolution cannot land
	 * on the other repo behind the same name. `rename` also adopts that repo's
	 * name as the configured one — a publish declares the repo it wrote into; a
	 * read only remembers the id, because the name is what peers look for.
	 */
	private rememberRepo(session: DriveSession, rename: boolean): void {
		const next: UpdateSettings = {
			...this.settings,
			repo: rename ? session.name : this.settings.repo,
			repoId: session.id
		};
		if (next.repo === this.settings.repo && next.repoId === this.settings.repoId) return;
		this.settings = next;
		saveSettings(this.settings);
	}

	/**
	 * What a publish would write into, without writing anything.
	 *
	 * The publisher script asks this before uploading, so a read-only mirror or a
	 * repo that has to be created is reported in a line instead of after a
	 * hundred-megabyte transfer. `folder` is the directory the publish runs in:
	 * when it belongs to a repo, that repo is the answer — see
	 * `ensureReleaseRepo`.
	 */
	async publishStatus(folder?: string | null): Promise<{
		repo: UpdateRepoView | null;
		writable: boolean;
		missing: boolean;
		folder: string | null;
	}> {
		const target = folder ? repoForFolder(this.choices(), folder) : null;
		const session = target ? (this.app.sessions.get(target.id) ?? null) : await this.resolveRepo();
		if (session) this.repoView = this.viewOf(session);
		return {
			repo: session ? this.viewOf(session) : null,
			writable: !!session?.canWrite,
			missing: !session,
			folder: target ? (folder ?? null) : null
		};
	}

	/**
	 * The release repo, created by the first publish when it does not exist yet.
	 *
	 * `folder` is the directory the publish runs in, and it decides more than the
	 * configured name does: a release built and published from a repo's own folder
	 * belongs to that repo. Without this, the store a first publish created keeps
	 * the name and every later release lands in a second repo beside the source.
	 *
	 * Publishing is also the only flow that both needs a repo and has no other way
	 * of making one, so an absent one is created. A mirror of someone else's repo
	 * is refused rather than replaced — a local repo with the same name would
	 * shadow the one this peer is supposed to follow.
	 */
	private async ensureReleaseRepo(folder?: string | null): Promise<DriveSession> {
		const target = folder ? repoForFolder(this.choices(), folder) : null;
		const byFolder = target ? (this.app.sessions.get(target.id) ?? null) : null;
		if (byFolder) {
			if (!byFolder.canWrite)
				throw new Error(
					`"${byFolder.name}" is a mirror, not this peer's repo — only its owner can publish. ` +
						'Change the release repo on the Updates page.'
				);
			// Adopted: from now on this repo is where this peer's releases live.
			this.rememberRepo(byFolder, true);
			this.repoView = this.viewOf(byFolder);
			console.log(`[updates] publishing into ${byFolder.name} (${byFolder.id}) — ${folder}`);
			return byFolder;
		}

		const session = await this.resolveRepo();
		if (session) {
			if (!session.canWrite)
				throw new Error(
					`"${session.name}" is a mirror, not this peer's repo — only its owner can publish. ` +
						'Change the release repo on the Updates page.'
				);
			this.rememberRepo(session, false);
			return session;
		}

		const name = this.settings.repo.trim();
		const created = await this.app.createSession({
			name,
			description: "PeerHub releases — published from this repository's Releases tab",
			// Public on purpose: a peer only learns the release repo from an
			// announcement, and an unlisted one could never be updated from.
			visibility: 'public'
		});
		console.log(`[updates] created the release repo "${created.name}" (${created.id})`);
		this.rememberRepo(created, true);
		this.repoView = this.viewOf(created);
		return created;
	}

	/**
	 * Find the release repo, opening a public mirror if this peer only knows
	 * about it from an announcement.
	 *
	 * Opening it is the whole propagation mechanism for a new peer: joining the
	 * repo gives it the content drive, so it both reads the update and becomes
	 * somebody else's source for it.
	 */
	private async resolveRepo(): Promise<DriveSession | null> {
		const wanted = this.settings.repo.trim().toLowerCase();
		if (!wanted) return null;

		// A repo this peer owns is the answer whenever there is one, and the
		// remembered id decides between two repos that share the name.
		const picked = chooseReleaseRepo(this.choices(), wanted, this.settings.repoId);
		const local = picked ? (this.app.sessions.get(picked.id) ?? null) : null;
		if (local && !local.isGuest) {
			this.rememberRepo(local, false);
			this.repoView = this.viewOf(local);
			return local;
		}

		// A mirror is only as good as the repo it mirrors. When the owner announces
		// the same name under a different key — the repo was re-created, or the one
		// mirrored is gone — the announcement is the live answer, and a stale mirror
		// would keep serving a manifest nobody updates.
		const announcements = await listAnnouncements(this.app);
		const hits = announcements
			.filter(
				(entry) =>
					entry.visibility === 'public' &&
					!!entry.driveKey &&
					entry.name.trim().toLowerCase() === wanted
			)
			.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
		// A mirror re-announces what it carries, and asking a mirror for a repo it
		// only partly has is how a peer ends up reading half a manifest. The
		// publisher's own announcement is the one to follow when it is on the wire.
		const trusted = this.settings.trustedSigner;
		const hit = (trusted && hits.find((entry) => entry.peerKey === trusted)) || hits[0];

		const mirrorKey = local?.drive?.key ? b4a.toString(local.drive.key, 'hex') : null;
		if (!hit || (mirrorKey && hit.driveKey === mirrorKey)) {
			if (!local) return null;
			this.repoView = this.viewOf(local);
			return local;
		}

		try {
			const session = await this.app.openPublicRepo({
				driveKey: hit.driveKey!,
				metaKey: hit.metaKey,
				contentKey: hit.contentKey,
				name: hit.name,
				description: hit.description,
				// The announcement arrived on an authenticated connection, so this key
				// is the publisher's, not something the payload asserted about itself.
				ownerKey: hit.peerKey,
				defaultBranch: hit.defaultBranch
			});
			this.repoView = this.viewOf(session);
			console.log(
				`[updates] opened ${hit.name} from ${shortKey(hit.peerKey)} — ` +
					(hit.contentKey
						? 'content drive, blocks from any peer'
						: 'no content key, RPC reads only')
			);
			// Tell the peers this repo is here now, so the next peer can learn it
			// from us when the owner is offline.
			broadcastAnnouncements(this.app).catch(() => {});
			return session;
		} catch (err: any) {
			this.error = `Could not open ${hit.name}: ${err?.message ?? err}`;
			return null;
		}
	}

	/** Is this repo still on the wire — announced by somebody, owner or mirror? */
	private async isAnnounced(session: DriveSession): Promise<boolean> {
		const driveKey = session.drive?.key ? b4a.toString(session.drive.key, 'hex') : null;
		if (!driveKey) return false;
		return (await listAnnouncements(this.app)).some((entry) => entry.driveKey === driveKey);
	}

	/** Owner key of a release repo, or null when there is no authenticated record. */
	private async publisherOf(session: DriveSession): Promise<string | null> {
		if (!session.isGuest) return selfKeyHex(this.app);
		const driveKey = session.drive?.key ? b4a.toString(session.drive.key, 'hex') : null;
		if (!driveKey) return null;
		const hit = (await listAnnouncements(this.app)).find((entry) => entry.driveKey === driveKey);
		return hit?.peerKey ?? null;
	}

	/**
	 * The releases a repo carries, newest first — what its Releases tab shows.
	 *
	 * Read from `/release/versions/`, one signed snapshot per publish, so a repo's
	 * history survives the next publish replacing `channel.json`. A repo that
	 * published before snapshots existed has only the live manifest; that is the
	 * last thing tried. A manifest whose signature does not match the owner this
	 * peer knows is listed anyway and marked: an unexpected signer must be
	 * visible, not silently missing.
	 */
	async releasesOf(session: DriveSession, budgetMs = 6000): Promise<RepoReleases> {
		const publisher = await this.publisherOf(session).catch(() => null);
		const items: RepoRelease[] = [];
		let failure: string | null = null;

		const read = async (repoPath: string): Promise<void> => {
			try {
				items.push(
					this.releaseFrom(await this.readRepoFile(session, repoPath, budgetMs), publisher)
				);
			} catch (err: any) {
				failure = failure ?? `${repoPath}: ${err?.message ?? err}`;
			}
		};

		let snapshots: string[] = [];
		try {
			snapshots = await this.readRepoDir(session, RELEASE_VERSIONS_DIR, budgetMs);
		} catch (err: any) {
			failure = err?.message ?? String(err);
		}
		for (const name of snapshots.filter((entry) => /\.json$/i.test(entry)).sort()) {
			await read(`${RELEASE_VERSIONS_DIR}/${name}`);
		}
		if (items.length === 0) await read(MANIFEST_FILE);

		items.sort((a, b) => compareVersions(b.version, a.version));
		return { error: failure, publisher, items };
	}

	/**
	 * Open one release file as a stream, with the size to send as Content-Length.
	 *
	 * A release installer is read straight from the content drive, the same way
	 * the updater downloads one: the generic file API goes through the shared
	 * drive, which is built for listings and edits, and a 150MB download wants
	 * the drive whose blocks replicate.
	 */
	async openReleaseFile(session: DriveSession, repoPath: string): Promise<ReleaseFile> {
		const content: any = session.content;
		if (content) {
			const entry = await withTimeout(
				Promise.resolve(content.entry(repoPath).catch(() => null)),
				ENTRY_TIMEOUT_MS,
				`No peer answered for ${repoPath}`
			).catch(() => null);
			if (entry?.value?.blob) {
				return {
					size: entry.value.blob.byteLength,
					stream: withIdleTimeout(content.createReadStream(repoPath), IDLE_TIMEOUT_MS, repoPath)
				};
			}
		}

		const stat: any = await session.drive?.statShared(repoPath).catch(() => null);
		if (!stat?.exists) throw new Error(`${repoPath} is not in the repo`);
		return {
			size: stat.size,
			stream: withIdleTimeout(session.drive!.readShared(repoPath), IDLE_TIMEOUT_MS, repoPath)
		};
	}

	/** One signed envelope as a list entry. Throws only when it is not one at all. */
	private releaseFrom(raw: Buffer, publisher: string | null): RepoRelease {
		const shape = (payload: ReleasePayload, signer: string, problem: string | null) => ({
			version: payload.version,
			notes: payload.notes,
			publishedAt: payload.publishedAt,
			assets: payload.assets,
			signer,
			verified: problem === null,
			problem
		});

		try {
			const { payload, signer } = verifyRelease(raw, publisher);
			return shape(payload, signer, null);
		} catch (err: any) {
			// Still a manifest, just not one this peer trusts: show it, flagged.
			const { payload, signer } = verifyRelease(raw, null);
			return shape(payload, signer, err?.message ?? String(err));
		}
	}

	/** Names inside a repo directory; empty when the replica has not synced it yet. */
	private async readRepoDir(
		session: DriveSession,
		repoPath: string,
		budgetMs: number
	): Promise<string[]> {
		const content: any = session.content;
		if (!content) return [];

		const names: string[] = [];
		await withTimeout(
			(async () => {
				for await (const entry of content.readdir(repoPath)) {
					const name = typeof entry === 'string' ? entry : (entry?.key ?? entry?.name);
					if (name) names.push(String(name).split('/').pop() as string);
				}
			})(),
			budgetMs,
			`No peer answered for ${repoPath}`
		);
		return names;
	}

	/**
	 * Read a small file out of the repo.
	 *
	 * The content drive is tried first: it is a real Hyperdrive, so the bytes can
	 * arrive from any peer that has them. The RPC view of the shared drive is the
	 * fallback for a repo whose content key never made it into an old invite.
	 */
	private async readRepoFile(
		session: DriveSession,
		repoPath: string,
		budgetMs = ENTRY_TIMEOUT_MS
	): Promise<Buffer> {
		const content = session.content;
		if (content) {
			const deadline = Date.now() + budgetMs;
			for (;;) {
				// `entry` waits for a block no connected peer has; bound it, so a repo
				// whose owner is away answers instead of holding the request open.
				const entry = await withTimeout(
					Promise.resolve(content.entry(repoPath).catch(() => null)),
					budgetMs,
					`No peer answered for ${repoPath}`
				).catch(() => null);
				if (entry?.value?.blob) {
					return collect(withIdleTimeout(content.createReadStream(repoPath), budgetMs, repoPath));
				}
				if (Date.now() >= deadline) break;
				await wait(400);
			}
		}

		const stat: any = await withTimeout(
			Promise.resolve(session.drive?.statShared(repoPath).catch(() => null)),
			budgetMs,
			`No peer answered for ${repoPath}`
		).catch(() => null);
		if (!stat?.exists) throw new Error(`${repoPath} is not published yet`);
		if (stat.size > MAX_MANIFEST) throw new Error(`${repoPath} is too large to be a manifest`);
		return collect(withIdleTimeout(session.drive!.readShared(repoPath), budgetMs, repoPath));
	}

	private readRepoStream(session: DriveSession, repoPath: string): AsyncIterable<Buf> {
		const content = session.content;
		return (async function* () {
			if (content) {
				const entry = await content.entry(repoPath).catch(() => null);
				if (entry?.value?.blob) {
					for await (const chunk of content.createReadStream(repoPath)) yield chunk;
					return;
				}
			}
			const stat = await session.drive?.statShared(repoPath).catch(() => null);
			if (!stat?.exists) throw new Error(`${repoPath} is not in the repo`);
			for await (const chunk of session.drive!.readShared(repoPath)) yield Buffer.from(chunk);
		})();
	}
}

type Buf = Buffer | Uint8Array;

// One service per app instance. Kept off the module scope as a WeakMap because
// the route bundle and the app bundle each get their own copy of a module.
const services = new WeakMap<object, UpdateService>();

export function getUpdates(app: PeerHubApp): UpdateService {
	let service = services.get(app);
	if (!service) {
		service = new UpdateService(app);
		services.set(app, service);
	}
	return service;
}
