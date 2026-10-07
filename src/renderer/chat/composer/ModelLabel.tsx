import { useLayoutEffect, useRef, useState } from 'react';

/** A label swap never delays the native model or exposes two accessible names. */
export function ModelLabel({ label }: { label: string }) {
  const last = useRef(label);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (last.current === label) return;
    setOutgoing(last.current);
    last.current = label;
  }, [label]);
  return <span className={`composer-model-thinking-model composer-model-label${outgoing !== null ? ' is-swapping' : ''}`}>
    {outgoing !== null && <span key={`old:${label}`} className="composer-model-label-old" aria-hidden>{outgoing}</span>}
    <span key={label} className="composer-model-label-current" onAnimationEnd={() => setOutgoing(null)}>{label}</span>
  </span>;
}
