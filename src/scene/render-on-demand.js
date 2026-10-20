// Render on demand: the repository labs only redraw while something can change.
//
// A frame is drawn while the lab reports it is busy (playback), for a grace
// period after any invalidation (input, camera movement, data or view changes,
// late texture loads), and otherwise at most once per keep-alive interval as a
// safety net for an update that forgot to invalidate. The grace period is
// longer than every non-playback transition in the labs (at most 1.6 s).

export const RENDER_GRACE_MS = 2000;
export const RENDER_KEEPALIVE_MS = 1000;

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'focusin', 'resize', 'visibilitychange'];

let current = null;

/** Asks the active lab to draw again, e.g. after an image finishes loading. */
export function requestRender(ms) {
  current?.invalidate(ms);
}

export function createRenderScheduler({
  target = globalThis.window,
  controls = null,
  graceMs = RENDER_GRACE_MS,
  keepaliveMs = RENDER_KEEPALIVE_MS,
  now = () => performance.now(),
} = {}) {
  let activeUntil = now() + graceMs;
  let lastRender = -Infinity;
  let wasBusy = false;
  let renders = 0;
  const lifetime = new AbortController();
  const invalidate = (ms = graceMs) => { activeUntil = Math.max(activeUntil, now() + ms); };
  const onInput = () => invalidate();
  for (const type of INPUT_EVENTS) target?.addEventListener?.(type, onInput, { capture: true, passive: true, signal: lifetime.signal });
  controls?.addEventListener?.('change', onInput);

  const scheduler = {
    invalidate,
    /** True when this frame should be drawn; call once per animation frame. */
    shouldRender(time = now(), busy = false) {
      // Leaving playback still finishes its last transition and pause styling.
      if (wasBusy && !busy) invalidate();
      wasBusy = busy;
      if (!busy && time >= activeUntil && time - lastRender < keepaliveMs) return false;
      lastRender = time;
      renders++;
      return true;
    },
    get renders() { return renders; },
    dispose() {
      lifetime.abort();
      controls?.removeEventListener?.('change', onInput);
      if (current === scheduler) current = null;
    },
  };
  current = scheduler;
  return scheduler;
}
