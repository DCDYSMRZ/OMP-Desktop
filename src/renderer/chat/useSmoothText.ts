import { useEffect, useRef, useState } from 'react';

/** Release active answer bursts at PI's adaptive cadence; history never waits. */
export function useSmoothText(source: string, streaming: boolean): string {
  const [revealed, setRevealed] = useState(source.length);
  const released = useRef(source.length);
  const previous = useRef(source);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    if (!streaming) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [streaming]);

  useEffect(() => {
    const replaced = !source.startsWith(previous.current);
    previous.current = source;
    if (!streaming || reducedMotion || replaced) {
      released.current = source.length;
      setRevealed(source.length);
      return;
    }
    if (released.current >= source.length) return;
    let frame = 0;
    let lastFrame = performance.now();
    const tick = (now: number) => {
      const backlog = source.length - released.current;
      const speed = Math.max(60, backlog / 0.5);
      const elapsed = Math.min(now - lastFrame, 100) / 1000;
      lastFrame = now;
      released.current = Math.min(source.length, released.current + Math.max(1, Math.round(speed * elapsed)));
      setRevealed(released.current);
      if (released.current < source.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [source, streaming, reducedMotion]);

  if (!streaming || reducedMotion || !source.startsWith(previous.current)) return source;
  let end = revealed;
  // Do not split a UTF-16 surrogate pair at the reveal boundary.
  const code = source.charCodeAt(end - 1);
  if (end < source.length && code >= 0xd800 && code <= 0xdbff) end++;
  return source.slice(0, end);
}
