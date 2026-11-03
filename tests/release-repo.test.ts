// Which repo a release belongs to.
//
// Two repos can end up with the same name: the store a first publish created,
// and the source repo somebody initialised afterwards with `ph init`. Resolving
// by name alone picks whichever the session map happens to yield first, so the
// releases land in the repo nobody is looking at. These pin the two rules that
// replace it — a repo linked to a folder is the real repo, and a remembered id
// beats both — and the folder rule a publish from a checkout uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReleaseRepo, repoForFolder } from '../src/lib/server/updates.ts';
import type { RepoChoice } from '../src/lib/server/updates.ts';

function repo(
	id: string,
	name: string,
	extra: { isGuest?: boolean; folder?: string | null } = {}
): RepoChoice {
	return { id, name, isGuest: extra.isGuest ?? false, folder: extra.folder ?? null };
}

test('the repo linked to a folder wins over a store repo with the same name', () => {
	// The bug in order: the store was created first, so it comes first here.
	const choices = [
		repo('506ae958aef70299', 'peerhub'),
		repo('3657695bd32994f2', 'PeerHub', { folder: 'D:\\PeerHub' })
	];
	const picked = chooseReleaseRepo(choices, 'peerhub');
	assert.equal(picked?.id, '3657695bd32994f2');
});

test('a remembered id decides, even against a folder-linked repo', () => {
	const choices = [
		repo('506ae958aef70299', 'peerhub'),
		repo('3657695bd32994f2', 'PeerHub', { folder: 'D:\\PeerHub' })
	];
	assert.equal(chooseReleaseRepo(choices, 'peerhub', '506ae958aef70299')?.id, '506ae958aef70299');
	// A remembered id for a repo that is gone falls through to the normal order.
	assert.equal(chooseReleaseRepo(choices, 'peerhub', 'deadbeefdeadbeef')?.id, '3657695bd32994f2');
});

test('an own repo wins over a mirror, and a mirror is still an answer', () => {
	const both = [
		repo('aaaa1111aaaa1111', 'peerhub', { isGuest: true }),
		repo('bbbb2222bbbb2222', 'peerhub')
	];
	assert.equal(chooseReleaseRepo(both, 'peerhub')?.id, 'bbbb2222bbbb2222');

	const mirrorOnly = [repo('aaaa1111aaaa1111', 'peerhub', { isGuest: true })];
	assert.equal(chooseReleaseRepo(mirrorOnly, 'peerhub')?.id, 'aaaa1111aaaa1111');
});

test('the name is matched without case or surrounding space', () => {
	const choices = [repo('cccc3333cccc3333', 'PeerHub', { folder: 'D:\\PeerHub' })];
	assert.equal(chooseReleaseRepo(choices, '  peerhub ')?.id, 'cccc3333cccc3333');
});

test('no matching name, or no name at all, is null', () => {
	const choices = [repo('dddd4444dddd4444', 'docmaster', { folder: 'D:\\docs' })];
	assert.equal(chooseReleaseRepo(choices, 'peerhub'), null);
	assert.equal(chooseReleaseRepo(choices, '   '), null);
});

test('a publish from a repo folder resolves to that repo', () => {
	const choices = [
		repo('506ae958aef70299', 'peerhub'),
		repo('3657695bd32994f2', 'PeerHub', { folder: 'D:\\PeerHub' })
	];
	assert.equal(repoForFolder(choices, 'D:\\PeerHub')?.id, '3657695bd32994f2');
	// A subfolder is the same repo; people publish from wherever the build ran.
	assert.equal(repoForFolder(choices, 'D:\\PeerHub\\scripts')?.id, '3657695bd32994f2');
});

test('the nearest linked folder wins when repos are nested', () => {
	const choices = [
		repo('eeee5555eeee5555', 'outer', { folder: 'D:\\work' }),
		repo('ffff6666ffff6666', 'inner', { folder: 'D:\\work\\inner' })
	];
	assert.equal(repoForFolder(choices, 'D:\\work\\inner\\dist')?.id, 'ffff6666ffff6666');
	assert.equal(repoForFolder(choices, 'D:\\work\\other')?.id, 'eeee5555eeee5555');
});

test('a prefix that is only part of a folder name is not a match', () => {
	const choices = [repo('eeee5555eeee5555', 'hub', { folder: 'D:\\PeerHub' })];
	assert.equal(repoForFolder(choices, 'D:\\PeerHub2'), null);
});

test('a folder with no repo, or a mirror, is never a publish target', () => {
	const choices = [repo('aaaa1111aaaa1111', 'peerhub', { isGuest: true, folder: 'D:\\PeerHub' })];
	assert.equal(repoForFolder(choices, 'D:\\PeerHub'), null);
	assert.equal(repoForFolder([], 'D:\\PeerHub'), null);
	assert.equal(repoForFolder(choices, ''), null);
});

test('a store repo with no folder cannot be picked by folder', () => {
	const choices = [repo('506ae958aef70299', 'peerhub')];
	assert.equal(repoForFolder(choices, 'D:\\PeerHub'), null);
});
