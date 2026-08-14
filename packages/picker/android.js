// Android picker backed by the native Storage Access Framework bindings,
// selected by the package's `android` export condition only — so the
// android-only native addon is never loaded on other platforms. The adapter
// keeps this package external, so bare-build resolves the condition at make
// time for the target host.
import { FilePicker } from 'bare-file-picker-android';

let picker = null;

function getPicker() {
	if (!picker) picker = new FilePicker();
	return picker;
}

const MIME = {
	mp4: 'video/mp4',
	mkv: 'video/x-matroska',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mp3: 'audio/mpeg',
	flac: 'audio/flac',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
	txt: 'text/plain',
	md: 'text/plain',
	json: 'application/json'
};

function mimeFor(name) {
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	return MIME[ext] || 'application/octet-stream';
}

export function pickerAvailable() {
	return true;
}

// Window size for each ranged read. Big enough to keep throughput up, small
// enough that one window fits comfortably in memory on a phone.
const CHUNK = 2 * 1024 * 1024;

// Wait for the writer to flush, but bail out if it errors meanwhile.
function drained(out) {
	return new Promise((resolve, reject) => {
		const onDrain = () => (cleanup(), resolve());
		const onError = (err) => (cleanup(), reject(err));
		const cleanup = () => {
			out.off('drain', onDrain);
			out.off('error', onError);
		};
		out.once('drain', onDrain);
		out.once('error', onError);
	});
}

// Prompt the user for a save location, then stream the drive file into it,
// reporting progress as bytes arrive. Resolves once fully written, or
// immediately when the user cancels. `onProgress(written, total)` is optional.
export async function downloadToDocument(session, filePath, onProgress) {
	const entry = await session.drive.entry(filePath);
	if (!entry) throw new Error('File not found');

	const total = entry.value?.blob?.byteLength ?? 0;
	const filename = filePath.split('/').pop() || 'file';
	const uri = await getPicker().createDocument(filename, mimeFor(filename));
	if (!uri) return { saved: false, cancelled: true };

	const out = getPicker().createWriteStream(uri);

	// Pull the file in bounded windows rather than one read. DistributedDrive only
	// fetches a slice when given a range: an unranged createReadStream over RPC
	// buffers the whole file into a single message, which exhausts memory on large
	// files and can only ever report 0% then 100%.
	//
	// `written` doubles as the read offset and advances by the bytes actually
	// received, never by CHUNK, so the loop stays correct whether the backing
	// drive treats `end` as inclusive (localdrive) or exclusive.
	let read = null;
	let written = 0;
	try {
		for (;;) {
			const offset = written;
			const stop = total ? Math.min(offset + CHUNK, total) : offset + CHUNK;
			read = session.drive.createReadStream(filePath, { start: offset, end: stop - 1 });

			// Honour the writer's backpressure: write() returns false when the
			// native queue is full, and resumes on 'drain'.
			for await (const chunk of read) {
				written += chunk.length;
				onProgress?.(written, total);
				if (!out.write(chunk)) await drained(out);
			}
			read = null;

			if (total && written >= total) break;

			// An empty window means EOF, which is only expected for an entry that
			// reported no size (a symlink, say). Short of the known total it means
			// the transfer died — fail rather than save a truncated file.
			if (written === offset) {
				if (total) throw new Error(`download stalled at ${written} of ${total} bytes`);
				break;
			}
		}

		await new Promise((resolve, reject) => {
			out.on('error', reject);
			out.on('finish', resolve);
			out.end();
		});
	} catch (err) {
		// Tear down both sides so neither is left holding the drive read nor the
		// native document handle.
		read?.destroy();
		out.destroy();
		throw err;
	}

	return { saved: true };
}

// Best-effort conversion of a SAF tree URI to a real filesystem path. The app
// holds MANAGE_EXTERNAL_STORAGE, so a Localdrive can open the path directly.
// Returns null for trees we can't map (e.g. cloud providers).
export function treeUriToPath(uri) {
	const m = /\/tree\/([^/]+)$/.exec(uri);
	if (!m) return null;

	const docId = decodeURIComponent(m[1]); // e.g. "primary:Movies/Clips"
	const sep = docId.indexOf(':');
	if (sep === -1) return null;

	const volume = docId.slice(0, sep);
	const rel = docId.slice(sep + 1);
	const base = volume === 'primary' ? '/storage/emulated/0' : `/storage/${volume}`;
	return rel ? `${base}/${rel}` : base;
}

// Prompt the user to pick a directory tree. Resolves to the SAF tree URI plus a
// best-effort filesystem path, or null if cancelled.
export async function pickDirectory() {
	const uri = await getPicker().openDirectory();
	if (!uri) return null;

	return { uri, path: treeUriToPath(uri) };
}
