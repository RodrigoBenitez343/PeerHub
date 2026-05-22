export type FileKind =
	| 'folder'
	| 'video'
	| 'audio'
	| 'image'
	| 'doc'
	| 'code'
	| 'pdf'
	| 'archive'
	| 'spreadsheet'
	| 'data'
	| 'generic';

export function detectKind(ext: string): FileKind {
	if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'].includes(ext)) return 'video';
	if (['mp3', 'flac', 'ogg', 'wav', 'aac', 'm4a', 'opus'].includes(ext)) return 'audio';
	if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'ico', 'avif'].includes(ext))
		return 'image';
	if (ext === 'pdf') return 'pdf';
	if (
		[
			'js',
			'ts',
			'jsx',
			'tsx',
			'html',
			'css',
			'scss',
			'sh',
			'py',
			'go',
			'rs',
			'c',
			'cpp',
			'h',
			'java',
			'php',
			'rb',
			'swift',
			'kt',
			'vue',
			'svelte'
		].includes(ext)
	)
		return 'code';
	if (['txt', 'md', 'rtf', 'doc', 'docx', 'odt', 'pages'].includes(ext)) return 'doc';
	if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz'].includes(ext)) return 'archive';
	if (['csv', 'xlsx', 'xls', 'ods', 'numbers'].includes(ext)) return 'spreadsheet';
	if (['json', 'yaml', 'yml', 'toml', 'xml', 'sql'].includes(ext)) return 'data';
	return 'generic';
}

export function formatFileSize(bytes: number | null | undefined): string | null {
	if (bytes == null) return null;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
