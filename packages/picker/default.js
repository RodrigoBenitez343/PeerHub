// Noop picker for every platform except Android, selected by the package's
// `default` export condition (used in dev and on desktop). Callers check
// `pickerAvailable()` and fall back to opening the file URL in the browser.

export function pickerAvailable() {
	return false;
}

export async function downloadToDocument() {
	throw new Error('File picker unavailable on this platform');
}

export async function pickDirectory() {
	throw new Error('File picker unavailable on this platform');
}
