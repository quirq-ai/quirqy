/** Draw the view card's connector toward its existing active app link. */
export function mountRepositoryViewConnection(dock, nav, activeLink) {
  if (!dock || !nav || !activeLink) return { dispose() {} };
  const lifetime = new AbortController();
  let disposed = false;
  let frame = 0;

  function updateConnection() {
    frame = 0;
    if (disposed || !dock.isConnected || !nav.isConnected || !activeLink.isConnected
      || dock.classList.contains('is-dock-collapsed')) return;
    const dockBox = dock.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    const linkBox = activeLink.getBoundingClientRect();
    if ([dockBox, navBox, linkBox].some(box => box.width <= 0 || box.height <= 0)) return;
    const borderLeft = parseFloat(getComputedStyle(nav).borderLeftWidth) || 0;
    nav.style.setProperty('--view-connector-x', `${linkBox.left + linkBox.width / 2 - navBox.left - borderLeft}px`);
    nav.style.setProperty('--view-connector-height', `${Math.max(0, linkBox.top - navBox.bottom + 4)}px`);
  }

  function scheduleConnection() {
    if (!disposed && !frame) frame = requestAnimationFrame(updateConnection);
  }
  const observer = new ResizeObserver(scheduleConnection);
  for (const node of [dock, nav, activeLink]) observer.observe(node);
  window.addEventListener('resize', scheduleConnection, { signal: lifetime.signal });
  scheduleConnection();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      observer.disconnect();
      cancelAnimationFrame(frame);
      nav.style.removeProperty('--view-connector-x');
      nav.style.removeProperty('--view-connector-height');
    },
  };
}
