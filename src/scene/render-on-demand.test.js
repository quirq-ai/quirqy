import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderScheduler, requestRender, INPUT_EVENTS, RENDER_GRACE_MS, RENDER_KEEPALIVE_MS } from './render-on-demand.js';

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

test('every listened event type invalidates, including canvas-only and click-only changes', () => {
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel', 'keydown', 'input', 'change', 'focusin', 'resize', 'visibilitychange', 'pageshow', 'webglcontextrestored']) {
    assert.ok(INPUT_EVENTS.includes(type), `${type} is listened for`);
  }
  for (const type of INPUT_EVENTS) {
    const { now, advance } = clock();
    const target = new EventTarget();
    const scheduler = createRenderScheduler({ target, now });
    advance(5000); scheduler.shouldRender(now());
    assert.equal(scheduler.shouldRender(advance(16)), false, `${type}: idle before the event`);
    target.dispatchEvent(new Event(type));
    assert.equal(scheduler.shouldRender(advance(16)), true, `${type}: renders after the event`);
    assert.equal(scheduler.shouldRender(advance(RENDER_GRACE_MS - 100)), true, `${type}: still inside the grace period`);
    scheduler.dispose();
  }
});

test('invalidate(ms) covers transitions longer than the grace period and never shortens it', () => {
  const { now, advance } = clock();
  const scheduler = createRenderScheduler({ target: new EventTarget(), now });
  advance(5000); scheduler.shouldRender(now());
  // A paused Growth tree step at 0.5x lasts 3.2 s.
  scheduler.invalidate(3200 + 250);
  for (let t = 16; t <= 3400; t += 16) assert.equal(scheduler.shouldRender(advance(16)), true, `frame at +${t} ms`);
  assert.equal(scheduler.shouldRender(advance(100)), false);
  scheduler.invalidate();
  scheduler.invalidate(10);
  assert.equal(scheduler.shouldRender(advance(RENDER_GRACE_MS - 100)), true, 'a shorter request keeps the longer window');
  assert.ok(RENDER_GRACE_MS >= 1000, 'the grace period outlasts the 0.9 s camera tweens');
  assert.ok(RENDER_KEEPALIVE_MS <= 1000, 'a missed invalidation shows within a second');
  scheduler.dispose();
});
