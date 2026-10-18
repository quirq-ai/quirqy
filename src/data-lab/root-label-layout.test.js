import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeRootLabels } from './root-label-layout.js';

const overlaps = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left
  && a.top < b.top + b.height && a.top + a.height > b.top;
const file = (key, x, y, width = 80) => ({ key, kind: 'file', x, y, width, height: 22 });

test('clear horizontal names remain directly beneath their own tips', () => {
  const records = [file('a', 140, 120), file('b', 360, 120), file('c', 580, 120)];
  const placed = placeRootLabels(records, { width: 800, height: 500 });
  for (const record of records) {
    const box = placed.get(record.key);
    assert.equal(box.left, record.x - record.width / 2);
    assert.equal(box.top, record.y + 8);
    assert.equal(box.width, record.width);
    assert.equal(box.height, record.height);
  }
});

test('ten nearby horizontal names use compact nonoverlapping positions with no detached column', () => {
  const records = Array.from({ length: 10 }, (_, i) => file(`f${i}`, 160 + i * 20, 180));
  const placed = placeRootLabels(records, { width: 800, height: 500, focusMode: true });
  const boxes = [...placed.values()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j]), false);
  for (const record of records) {
    const box = placed.get(record.key);
    const dx = Math.max(box.left - record.x, record.x - box.left - box.width, 0);
    const dy = Math.max(box.top - record.y, record.y - box.top - box.height, 0);
    assert.ok(Math.hypot(dx, dy) <= 36, 'every name stays within a compact distance of its true tip');
  }
});

test('folders reserve their junction space before file names', () => {
  const folder = { key: 'folder:src', kind: 'folder', x: 200, y: 180, width: 70, height: 24 };
  const records = [file('file:a', 230, 180), folder, file('file:b', 250, 180)];
  const placed = placeRootLabels(records, { width: 700, height: 500, focusMode: true });
  assert.equal(placed.get(folder.key).left, folder.x + 10);
  for (const record of records.filter(record => record.kind === 'file')) assert.equal(overlaps(placed.get(folder.key), placed.get(record.key)), false);
});

test('placement is deterministic regardless of input order and retains all dense names', () => {
  const records = Array.from({ length: 2501 }, (_, i) => file(`f${i}`, 200, 180, 60 + i % 80));
  const options = { width: 430, height: 700, focusMode: true };
  const placed = placeRootLabels(records, options);
  assert.equal(placed.size, 2501);
  assert.deepEqual(placeRootLabels([...records].reverse(), options), placed);
  for (const box of placed.values()) {
    assert.ok([box.left, box.top, box.width, box.height].every(Number.isFinite));
    assert.ok(box.left >= 6 && box.top >= 6);
    assert.ok(box.left + box.width <= 424 && box.top + box.height <= 694);
  }
});

test('screen edges and playback obstacles keep names within available nearby space', () => {
  const records = [file('left', 1, 40), file('right', 429, 40), file('bottom', 210, 620)];
  const obstacle = { left: 100, top: 650, width: 250, height: 45 };
  const placed = placeRootLabels(records, { width: 430, height: 700, focusMode: true, obstacles: [obstacle] });
  for (const box of placed.values()) {
    assert.ok(box.left >= 6 && box.left + box.width <= 424);
    assert.ok(box.top >= 6 && box.top + box.height <= 694);
    assert.equal(overlaps(box, obstacle), false);
  }
});

test('irregular portrait tip rows resolve small residual collisions without distant labels', () => {
  const records = [
    { key: 'folder', kind: 'folder', x: 192.04, y: 378.44, width: 49, height: 18 },
    ...[
      [258.35, 322.99, 70], [263.31, 312.78, 57], [267, 302.57, 64],
      [270.62, 291.52, 70], [276.96, 253.17, 90], [281.19, 232.93, 123],
      [284.31, 212.77, 97], [285.17, 201.76, 97], [285.84, 192.02, 97],
      [286.48, 182.12, 97], [286.4, 172.48, 90], [284.16, 166.11, 97],
    ].map(([x, y, width], i) => ({ key: `file:${i}`, kind: 'file', x, y, width, height: 16 })),
  ];
  const options = { width: 430, height: 932, focusMode: true };
  const placed = placeRootLabels(records, options), boxes = [...placed.values()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j]), false);
  for (const record of records) {
    const box = placed.get(record.key);
    const dx = Math.max(box.left - record.x, record.x - box.left - box.width, 0);
    const dy = Math.max(box.top - record.y, record.y - box.top - box.height, 0);
    assert.ok(Math.hypot(dx, dy) <= 52);
  }
  assert.deepEqual(placeRootLabels([...records].reverse(), options), placed);
});

test('side panels keep edge-tip names facing inward without moving their anchors', () => {
  const records = [file('left', 298, 190), file('right', 702, 210), file('center', 500, 200)];
  const obstacles = [{ left: 0, top: 60, width: 300, height: 400 }, { left: 700, top: 60, width: 300, height: 400 }];
  const before = structuredClone(records);
  const placed = placeRootLabels(records, { width: 1000, height: 600, focusMode: true, obstacles });
  for (const box of placed.values()) for (const obstacle of obstacles) assert.equal(overlaps(box, obstacle), false);
  assert.ok(placed.get('left').left >= 300);
  assert.ok(placed.get('right').left + placed.get('right').width <= 700);
  assert.deepEqual(records, before);
});
