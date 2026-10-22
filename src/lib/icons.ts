// One vector set for the whole app: 24-grid outline icons, stroke inherited from
// the current text colour. Kept as markup strings because each entry is a small
// fixed group of shapes; rendered only through Icon.svelte (never user content).

export type IconName =
	| 'home'
	| 'search'
	| 'globe'
	| 'repo'
	| 'folder'
	| 'folder-open'
	| 'file'
	| 'branch'
	| 'commit'
	| 'code'
	| 'settings'
	| 'fork'
	| 'lock'
	| 'plus'
	| 'refresh'
	| 'chevron-left'
	| 'chevron-right'
	| 'arrow-right'
	| 'link'
	| 'upload';

export const ICONS: Record<IconName, string> = {
	home: '<path d="M3 11 12 3l9 8"/><path d="M5.5 9.5V21h13V9.5"/><path d="M10 21v-6h4v6"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/>',
	globe:
		'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
	repo: '<path d="M6 3h11a2 2 0 0 1 2 2v16H8a2 2 0 0 1-2-2z"/><path d="M6 17h13"/><path d="M10 7h5"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	'folder-open':
		'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2"/><path d="M3 9h18l-2 9a2 2 0 0 1-2 1.6H5A2 2 0 0 1 3 18z"/>',
	file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
	branch:
		'<circle cx="6.5" cy="5.5" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="M6.5 8v6a5 5 0 0 0 5 5h3.5"/>',
	commit: '<circle cx="12" cy="12" r="4"/><path d="M2 12h6"/><path d="M16 12h6"/>',
	code: '<path d="M9 7 3.5 12 9 17"/><path d="M15 7l5.5 5L15 17"/>',
	settings:
		'<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>',
	fork: '<circle cx="6.5" cy="5" r="2.2"/><circle cx="6.5" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6.5 7.2v9.6"/><path d="M15.8 12H10a3.5 3.5 0 0 1-3.5-3.5"/>',
	lock: '<rect x="4" y="10" width="16" height="10.5" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
	plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
	refresh:
		'<path d="M20.5 12a8.5 8.5 0 0 1-14.6 6"/><path d="M3.5 12a8.5 8.5 0 0 1 14.6-6"/><path d="M18.5 3.5V7H15"/><path d="M5.5 20.5V17H9"/>',
	'chevron-left': '<path d="M15 4.5 7.5 12 15 19.5"/>',
	'chevron-right': '<path d="M9 4.5 16.5 12 9 19.5"/>',
	'arrow-right': '<path d="M4 12h15"/><path d="M13 6l6 6-6 6"/>',
	link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7L12.5 18"/>',
	upload:
		'<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'
};
