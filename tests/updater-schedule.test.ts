// When the desktop shell spends a real check.
//
// The shell looks at the server every couple of seconds so a click on the Updates
// page is acted on at once, but a check is a peer round trip and must not ride
// along with every look. This is the gate that separates the two.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDue } from '../desktop/updater.js';

const GAP = 5 * 60_000;
const NOW = 1_800_000_000_000;

function state(extra) {
	return { checkedAt: NOW, settings: { autoCheck: true }, ...extra };
}

test('never checked: due now', () => {
	assert.equal(checkDue(null, GAP, NOW), true);
	assert.equal(checkDue(state({ checkedAt: 0 }), GAP, NOW), true);
});

test('a check inside the gap is not repeated', () => {
	assert.equal(checkDue(state({ checkedAt: NOW - 30_000 }), GAP, NOW), false);
	assert.equal(checkDue(state({ checkedAt: NOW - GAP + 1 }), GAP, NOW), false);
});

test('a check older than the gap is due again', () => {
	assert.equal(checkDue(state({ checkedAt: NOW - GAP }), GAP, NOW), true);
	assert.equal(checkDue(state({ checkedAt: NOW - GAP - 1 }), GAP, NOW), true);
});

test('auto-check off means the tick only reads state', () => {
	assert.equal(checkDue(state({ settings: { autoCheck: false }, checkedAt: 1 }), GAP, NOW), false);
});
