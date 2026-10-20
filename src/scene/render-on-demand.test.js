import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderScheduler, requestRender } from './render-on-demand.js';

function clock(start = 0) {
  let time = start;
  return { now: () => time, advance: ms => { time += ms; return time; } };
}

test('renders during the startup grace period, then only at the keep-alive rate', () => {
  const { now, advance } = clock();
  const scheduler = createRenderScheduler({ target: new EventTarget(), now, graceMs: 2000, keepaliveMs: 1000 });
  let drawn = 0;
  for (let frame = 0; frame < 600; frame++) if (scheduler.shouldRender(advance(1000 / 60))) drawn++;
  // 10 s at 60 fps: about 120 frames during the 2 s grace, then one per second.
  assert.ok(drawn >= 118 && drawn <= 130, `drew ${drawn} frames`);
  scheduler.dispose();
});

test('busy frames always render and leaving busy restarts the grace period', () => {
  const { now, advance } = clock();
  const scheduler = createRenderScheduler({ target: new EventTarget(), now, graceMs: 2000, keepaliveMs: 1000 });
  advance(5000);
  assert.equal(scheduler.shouldRender(now(), false), true); // keep-alive
  assert.equal(scheduler.shouldRender(advance(16), false), false);
  assert.equal(scheduler.shouldRender(advance(16), true), true);
  assert.equal(scheduler.shouldRender(advance(16), true), true);
  assert.equal(scheduler.shouldRender(advance(16), false), true);
  assert.equal(scheduler.shouldRender(advance(1900), false), true);
  assert.equal(scheduler.shouldRender(advance(200), false), false);
  scheduler.dispose();
});

test('input events, control changes and requestRender invalidate', () => {
  const { now, advance } = clock();
  const target = new EventTarget();
  const controls = new EventTarget();
  const scheduler = createRenderScheduler({ target, controls, now, graceMs: 2000, keepaliveMs: 1000 });
  advance(5000);
  scheduler.shouldRender(now());
  assert.equal(scheduler.shouldRender(advance(16)), false);
  target.dispatchEvent(new Event('pointermove'));
  assert.equal(scheduler.shouldRender(advance(16)), true);
  advance(3000); scheduler.shouldRender(now());
  assert.equal(scheduler.shouldRender(advance(16)), false);
  controls.dispatchEvent(new Event('change'));
  assert.equal(scheduler.shouldRender(advance(16)), true);
  advance(3000); scheduler.shouldRender(now());
  assert.equal(scheduler.shouldRender(advance(16)), false);
  requestRender();
  assert.equal(scheduler.shouldRender(advance(16)), true);
  scheduler.dispose();
  advance(3000); scheduler.shouldRender(now());
  target.dispatchEvent(new Event('pointermove'));
  requestRender();
  assert.equal(scheduler.shouldRender(advance(16)), false, 'disposed scheduler ignores input');
});
