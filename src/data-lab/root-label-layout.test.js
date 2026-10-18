import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeRootLabels, placeReadableRootLabels } from './root-label-layout.js';

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
  const records = Array.from({ length: 2501 }, (_, i) => ({ ...file(`f${i}`, 200, 180, 60 + i % 80), parentPath: 'src' }));
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


test('siblings with slightly uneven tips share one nearby horizontal baseline', () => {
  const records = [200, 202, 197, 204].map((y, i) => ({
    key: `file:${i}`, kind: 'file', parentPath: 'src/components',
    x: 160 + i * 140, y, width: 80, height: 16,
  }));
  const options = { width: 800, height: 500, focusMode: true };
  const placed = placeRootLabels(records, options);
  assert.equal(new Set([...placed.values()].map(box => box.top)).size, 1);
  for (const record of records) {
    const box = placed.get(record.key);
    assert.ok(box.top >= record.y + 4 && box.top <= record.y + 16);
    assert.equal(box.left, record.x - record.width / 2);
  }
  assert.deepEqual(placeRootLabels([...records].reverse(), options), placed);
});

test('projected sibling rows follow a rotated branch without merging separate parents', () => {
  const records = [
    ...[0, 1, 2, 3, 4].map(i => ({ key: `a:${i}`, kind: 'file', parentPath: 'a', x: 180 + i * 8, y: 100 + i * 35, width: 74, height: 16 })),
    ...[0, 1].map(i => ({ key: `b:${i}`, kind: 'file', parentPath: 'b', x: 520 + i * 100, y: 113 + i * 2, width: 70, height: 16 })),
  ];
  const placed = placeRootLabels(records, { width: 800, height: 500, focusMode: true });
  assert.equal(placed.get('b:0').top, placed.get('b:1').top);
  assert.notEqual(placed.get('a:0').baseline, placed.get('b:0').baseline);
  for (const record of records) {
    const box = placed.get(record.key);
    const dx = Math.max(box.left - record.x, record.x - box.left - box.width, 0);
    const dy = Math.max(box.top - record.y, record.y - box.top - box.height, 0);
    assert.ok(Math.hypot(dx, dy) <= 52);
  }
  const boxes = [...placed.values()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j]), false);
});

test('a small clear gap between occupied areas is found between fixed nudge steps', () => {
  const record = { key: 'file', kind: 'file', x: 200, y: 200, width: 80, height: 16 };
  const obstacles = [
    { left: 0, top: 0, width: 164.5, height: 500 },
    { left: 247.5, top: 0, width: 252.5, height: 500 },
    { left: 164.5, top: 0, width: 83, height: 212.5 },
    { left: 164.5, top: 231.5, width: 83, height: 268.5 },
  ];
  const placed = placeRootLabels([record], { width: 500, height: 500, focusMode: true, obstacles });
  const box = placed.get(record.key);
  for (const obstacle of obstacles) assert.equal(overlaps(box, obstacle), false);
  assert.ok(box.left >= 164.5 && box.left + box.width <= 247.5);
  assert.ok(box.top >= 212.5 && box.top + box.height <= 231.5);
  assert.ok(box.top - record.y < 16, 'the name remains directly beside its actual endpoint');
});


test('dense names reveal with space without overlapping names or covering the HUD', () => {
  const records = Array.from({ length: 754 }, (_, i) => ({
    key: `file:${i}`, kind: 'file', depth: 2, x: 250 + i % 28 * 22,
    y: 120 + Math.floor(i / 28) * 12, width: 120, height: 16,
  }));
  const obstacles = [{ left: 0, top: 0, width: 220, height: 800 }, { left: 1000, top: 0, width: 300, height: 800 }];
  const placed = placeReadableRootLabels(records, { width: 1300, height: 800, obstacles });
  assert.ok(placed.size > 0 && placed.size < records.length);
  const overlaps = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
  const boxes = [...placed.values()];
  boxes.forEach((box, i) => {
    assert.ok(!obstacles.some(other => overlaps(box, other)));
    assert.ok(!boxes.slice(i + 1).some(other => overlaps(box, other)));
  });
  const close = records.slice(0, 16).map((record, i) => ({ ...record, x: 300 + i % 4 * 165, y: 200 + Math.floor(i / 4) * 40 }));
  assert.equal(placeReadableRootLabels(close, { width: 1300, height: 800, obstacles }).size, close.length);
});

test('selected dense names take priority and every file can be read when focused', () => {
  const records = Array.from({ length: 200 }, (_, i) => ({ key: `file:${i}`, kind: 'file', x: 200, y: 200, width: 140, height: 16 }));
  records.at(-1).priority = 100;
  assert.ok(placeReadableRootLabels(records, { width: 600, height: 400 }).has('file:199'));
  for (const record of records) assert.ok(placeReadableRootLabels([record], { width: 600, height: 400 }).has(record.key));
  assert.deepEqual([...placeReadableRootLabels(records, { width: 600, height: 400 })], [...placeReadableRootLabels([...records].reverse(), { width: 600, height: 400 })]);
});
