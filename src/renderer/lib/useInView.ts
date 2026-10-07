import { useEffect, useState, type RefObject } from 'react';

export function useInView<T extends Element>(ref: RefObject<T | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}
