import test from 'node:test';
import assert from 'node:assert/strict';
import { placeCommitBubble } from './commit-bubble-layout.js';

const desktop = { x: 500, y: 300, width: 1200, height: 800, bubbleWidth: 300, bubbleHeight: 180 };
const mobile = { x: 195, y: 400, width: 390, height: 844, bubbleWidth: 320, bubbleHeight: 220 };

function assertWithinBounds(input, placed) {
  const bounds = { left: 12, top: 12, right: input.width - 12, bottom: input.height - 12, ...input.bounds };
  assert.ok(placed.left >= bounds.left);
  assert.ok(placed.top >= bounds.top);
  assert.ok(placed.left + input.bubbleWidth <= bounds.right);
  assert.ok(placed.top + input.bubbleHeight <= bounds.bottom);
  const edge = placed.side === 'right' || placed.side === 'left' ? input.bubbleHeight : input.bubbleWidth;
  const inset = Math.min(16, edge / 2);
  assert.ok(placed.tail >= inset && placed.tail <= edge - inset);
}

test('desktop bubble prefers the right of the portrait with the tail near its lower edge', () => {
  const result = placeCommitBubble(desktop);
  assert.deepEqual(result, { left: 534, top: 138, side: 'right', tail: 162 });
  assertWithinBounds(desktop, result);
  assert.ok(result.left >= desktop.x + 34, 'the portrait remains uncovered');
});

test('desktop bubble switches to the left when the right side meets a panel boundary', () => {
  const input = { ...desktop, x: 760, bounds: { left: 220, top: 70, right: 900, bottom: 720 } };
  const result = placeCommitBubble(input);
  assert.deepEqual(result, { left: 426, top: 138, side: 'left', tail: 162 });
  assertWithinBounds(input, result);
  assert.ok(result.left + input.bubbleWidth <= input.x - 34);
});

test('mobile uses the space above the portrait and keeps its tail aimed at the author', () => {
  const result = placeCommitBubble(mobile);
  assert.deepEqual(result, { left: 35, top: 146, side: 'above', tail: 160 });
  assertWithinBounds(mobile, result);
  assert.equal(result.top + mobile.bubbleHeight, mobile.y - 34);
});

test('near the top, mobile places the bubble below the portrait and author caption', () => {
  const input = { ...mobile, y: 110, bounds: { top: 70 } };
  const result = placeCommitBubble(input);
  assert.deepEqual(result, { left: 35, top: 174, side: 'below', tail: 160 });
  assertWithinBounds(input, result);
  assert.equal(result.top, input.y + 64);
});

test('desktop also falls back above when neither side fits between the panels', () => {
  const input = { ...desktop, y: 500, bounds: { left: 250, top: 80, right: 750, bottom: 700 } };
  const result = placeCommitBubble(input);
  assert.deepEqual(result, { left: 350, top: 286, side: 'above', tail: 150 });
  assertWithinBounds(input, result);
});

test('a tall message stays inside the safe viewport even when no placement fully clears the portrait', () => {
  const input = { ...mobile, y: 350, bubbleHeight: 650, bounds: { left: 12, top: 70, right: 378, bottom: 740 } };
  const result = placeCommitBubble(input);
  assert.deepEqual(result, { left: 35, top: 90, side: 'below', tail: 160 });
  assertWithinBounds(input, result);
});

test('side bubbles clamp vertically without losing the tail at the viewport edges', () => {
  for (const [y, expectedTop, expectedTail] of [[4, 12, 16], [798, 608, 164]]) {
    const input = { ...desktop, y };
    const result = placeCommitBubble(input);
    assert.equal(result.side, 'right');
    assert.equal(result.top, expectedTop);
    assert.equal(result.tail, expectedTail);
    assertWithinBounds(input, result);
  }
});

test('narrow screens constrain the full bubble while the tail follows authors near either edge', () => {
  for (const [x, expectedTail] of [[1, 16], [319, 280]]) {
    const input = { ...mobile, x, width: 320, bubbleWidth: 296 };
    const result = placeCommitBubble(input);
    assert.equal(result.left, 12);
    assert.equal(result.side, 'above');
    assert.equal(result.tail, expectedTail);
    assertWithinBounds(input, result);
  }
});

test('the mobile breakpoint and an exact side fit keep predictable placement', () => {
  const mobileInput = { ...desktop, width: 600, x: 150, y: 450, bubbleWidth: 180 };
  assert.equal(placeCommitBubble(mobileInput).side, 'above');
  const desktopInput = { ...desktop, width: 601, x: 255, bubbleWidth: 300 };
  assert.equal(placeCommitBubble(desktopInput).side, 'right');
  assert.equal(placeCommitBubble({ ...desktopInput, x: 256 }).side, 'above');
});

test('placement is deterministic and leaves the measured input and bounds unchanged', () => {
  const input = { ...desktop, bounds: { left: 220, top: 70, right: 900, bottom: 720 } };
  const before = structuredClone(input);
  const result = placeCommitBubble(input);
  assert.deepEqual(placeCommitBubble(input), result);
  assert.deepEqual(input, before);
});
