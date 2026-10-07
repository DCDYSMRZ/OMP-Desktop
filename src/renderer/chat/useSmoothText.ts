import { useEffect, useRef, useState } from 'react';
import { StreamingReveal } from './streaming-reveal';
import { useReducedMotion } from '../ui/motion';

/** The release clock survives token updates; only newly appended source fades. */
export function useSmoothText(source: string, streaming: boolean): { source: string; reveal: StreamingReveal } {
  const reducedMotion = useReducedMotion();
  const reveal = useRef<StreamingReveal | null>(null);
  if (!reveal.current) reveal.current = new StreamingReveal(source, streaming);
  const state = reveal.current;
  const [, render] = useState(0);
  state.update(source, streaming, reducedMotion);


  const pending = state.pending;
  useEffect(() => {
    if (reducedMotion || !pending) return;
    let frame = 0;
    const tick = () => {
      if (state.tick(performance.now())) render(version => version + 1);
      if (state.pending) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state, streaming, reducedMotion, pending]);

  return { source: state.text, reveal: state };
}
