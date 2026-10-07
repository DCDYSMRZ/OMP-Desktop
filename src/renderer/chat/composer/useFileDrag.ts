import { useEffect, useState } from 'react';

/** Observe genuine file drags without changing the authorized drop destination. */
export function useFileDrag(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      depth++;
      setCount(Array.from(event.dataTransfer.items).filter(item => item.kind === 'file').length || event.dataTransfer.files.length || 1);
    };
    const leave = () => { if (--depth <= 0) { depth = 0; setCount(0); } };
    const reset = () => { depth = 0; setCount(0); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', reset); window.removeEventListener('dragend', reset); window.removeEventListener('blur', reset);
    };
  }, [enabled]);
  return count;
}
