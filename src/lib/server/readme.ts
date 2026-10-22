import { renderMarkdown, type MarkdownOptions } from '$lib/markdown';
import type DriveSession from './session.js';
import { previewFile } from './git.js';
import type { SharedFile } from './shared-drive.js';

// Root README detection and rendering, shared by the Files and Code tabs so both
// show the same document with the same link resolution.
//
// Links inside a README are repo-relative: `./docs/x.md`, `/img/logo.png`,
// `docs/` — the same references git hosts show. They are rewritten into app
// routes here, because a markdown file has no way of knowing how this app names
// its pages. Anything that escapes the repo root or uses a foreign scheme is
// left out (the renderer drops the link and keeps the text).

const README_NAME = /^\/readme(\.md|\.markdown|\.mdown|\.txt)?$/i;

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

function hasExtension(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.includes('.') && !name.startsWith('.');
}

/** Resolvers for a markdown document sitting in `baseDir` of this repo. */
export function markdownOptions(session: DriveSession, baseDir: string): MarkdownOptions {
	return {
		baseDir,
		imageHref(repoPath) {
			// Served straight from the shared drive with the right content type.
			return `/api/files/${session.id}${encodePath(repoPath)}`;
		},
		linkHref(repoPath, raw) {
			const hash = raw.includes('#') ? '#' + raw.slice(raw.indexOf('#') + 1) : '';

			if (/\.(md|markdown|mdown)$/i.test(repoPath)) {
				const dir = repoPath.slice(0, repoPath.lastIndexOf('/')) || '/';
				return `/drive/${session.id}/code?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(repoPath)}${hash}`;
			}

			if (hasExtension(repoPath)) {
				return `/drive/${session.id}/preview?file=${encodeURIComponent(repoPath)}${hash}`;
			}

			// No extension: treat it as a directory listing.
			return `/drive/${session.id}?path=${encodeURIComponent(repoPath)}`;
		}
	};
}

export interface ReadmeView {
	path: string;
	html: string;
}

/**
 * Find and render the README at the repo root. Returns null when there is none
 * or it cannot be read — callers treat that as "no README", not as an error,
 * since the file list is still the primary content.
 */
export async function loadReadme(
	session: DriveSession,
	files?: SharedFile[]
): Promise<ReadmeView | null> {
	let manifest = files;
	if (!manifest) {
		try {
			manifest = await session.drive!.manifestShared('/');
		} catch {
			return null;
		}
	}

	// Prefer README.md over .markdown/.txt when several exist.
	const candidates = manifest
		.filter((entry) => README_NAME.test(entry.path))
		.sort((a, b) => a.path.length - b.path.length);

	for (const candidate of candidates) {
		try {
			const preview = await previewFile(session, candidate.path);
			if (preview.text === null) continue;
			const dir = candidate.path.slice(0, candidate.path.lastIndexOf('/')) || '/';
			return {
				path: candidate.path,
				html: renderMarkdown(preview.text, markdownOptions(session, dir))
			};
		} catch {
			// Unreadable README: try the next candidate.
		}
	}

	return null;
}
