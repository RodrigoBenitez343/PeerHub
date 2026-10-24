import test from 'node:test';
import assert from 'node:assert/strict';
import { isReservedRepoPath } from '../src/lib/server/paths.ts';
import { DELTA_THRESHOLD } from '../src/lib/server/chunks.ts';

test('probe: ts imports resolve', () => {
	assert.equal(isReservedRepoPath('/.peerhub/history/x'), true);
	assert.equal(DELTA_THRESHOLD, 4 * 1024 * 1024);
});
