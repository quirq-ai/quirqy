// Animate a decorative copy of the glass, never the live dock's dimensions.
// Dragging and refraction both measure the real panel, so its layout stays still
// until disclosure commits the final footprint.
const DURATION = 420;

export function createDockMotion(dock, grip, closing, onFinish) {
  if (typeof dock.animate !== 'function') return null;
  const bounds = dock.getBoundingClientRect();
  const anchor = grip.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const material = getComputedStyle(dock);
  const surface = document.createElement('div');
  surface.className = 'dock-motion-surface';
  surface.setAttribute('aria-hidden', 'true');
  surface.inert = true;
  Object.assign(surface.style, {
    left: `${-parseFloat(material.borderLeftWidth || 0)}px`,
    top: `${-parseFloat(material.borderTopWidth || 0)}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    background: material.background,
    borderTop: material.borderTop,
    borderRight: material.borderRight,
    borderBottom: material.borderBottom,
    borderLeft: material.borderLeft,
    borderRadius: material.borderRadius,
    boxShadow: material.boxShadow,
    backdropFilter: material.backdropFilter,
    webkitBackdropFilter: material.webkitBackdropFilter,
    transformOrigin: `${anchor.left + anchor.width / 2 - bounds.left}px ${anchor.top + anchor.height / 2 - bounds.top}px`,
  });
  const controls = [...dock.children].filter(child => child !== grip && getComputedStyle(child).display !== 'none');
  dock.prepend(surface);
  dock.classList.add('is-dock-animating');
  const timing = { duration: DURATION, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'both' };
  const glass = surface.animate([
    { transform: 'scale(1)', opacity: 1, offset: 0 },
    { opacity: 0.85, offset: 0.4 },
    { transform: `scale(${anchor.width / bounds.width}, ${anchor.height / bounds.height})`, opacity: 0, offset: 1 },
  ], timing);
  const animations = [glass, ...controls.map(child => child.animate([
    { opacity: getComputedStyle(child).opacity, translate: '0 0', offset: 0 },
    { opacity: 0, translate: '0 -8px', offset: 0.5 },
    { opacity: 0, translate: '0 -8px', offset: 1 },
  ], timing))];
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = closing ? 0 : DURATION;
  }
  glass.onfinish = onFinish;
  function play(next) {
    // One shared timeline makes rapid toggles reverse from the visible frame.
    for (const animation of animations) {
      animation.playbackRate = next ? 1 : -1;
      animation.play();
    }
  }
  play(closing);
  return {
    play,
    dispose() {
      glass.onfinish = null;
      for (const animation of animations) animation.cancel();
      surface.remove();
      dock.classList.remove('is-dock-animating');
    },
  };
}
