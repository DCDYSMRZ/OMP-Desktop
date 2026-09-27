/** One delegated, frame-throttled highlight tracker for all glass controls. */
export function installGlassSpecular(): () => void {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const selector = '.lg-thin,.lg-regular,.lg-thick,.liuli';
  let active: HTMLElement | null = null;
  let pending: HTMLElement | null = null;
  let frame: number | undefined;
  let clientX = 0;
  let clientY = 0;

  function clearActive() {
    active?.style.removeProperty('--lg-mx');
    active?.style.removeProperty('--lg-my');
    active = null;
  }

  function clear() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pending = null;
    clearActive();
  }

  function paint() {
    frame = undefined;
    if (motion.matches || !pending?.isConnected) { clear(); return; }
    if (active !== pending) clearActive();
    active = pending;
    const rect = active.getBoundingClientRect();
    active.style.setProperty('--lg-mx', `${clientX - rect.left}px`);
    active.style.setProperty('--lg-my', `${clientY - rect.top}px`);
  }

  function move(event: PointerEvent) {
    pending = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
    if (!pending) { clear(); return; }
    if (active !== pending) clearActive();
    clientX = event.clientX;
    clientY = event.clientY;
    if (frame === undefined) frame = requestAnimationFrame(paint);
  }

  function leave(event: PointerEvent) {
    const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest<HTMLElement>(selector) : null;
    if (next !== pending) clear();
  }

  function detach() {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerout', leave);
    window.removeEventListener('blur', clear);
    clear();
  }

  function updateMotion() {
    detach();
    if (motion.matches) return;
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerout', leave, { passive: true });
    window.addEventListener('blur', clear);
  }

  motion.addEventListener('change', updateMotion);
  updateMotion();
  return () => { motion.removeEventListener('change', updateMotion); detach(); };
}
