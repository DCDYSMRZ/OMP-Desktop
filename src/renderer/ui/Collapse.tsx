import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react';

/** Must match --motion-duration-expand in tokens.css. */
export const COLLAPSE_DURATION_MS = 180;
export const InstantCollapse = createContext(false);

export interface CollapseProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  open: boolean;
  children: ReactNode;
  /** Keep children mounted after the first open (default). False unmounts once closed. */
  keepMounted?: boolean;
  innerClassName?: string;
  bodyRef?: Ref<HTMLDivElement>;
}

/**
 * Animated disclosure body. Closed bodies end up `hidden` + `inert` (after the
 * close transition), so reading-anchor code that skips `[hidden]` still works.
 */
export function Collapse({ open, children, keepMounted = true, className, innerClassName, bodyRef, ...rest }: CollapseProps) {
  const followSafe = useContext(InstantCollapse);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [settled, setSettled] = useState(open);
  const frame = useRef<number | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const initial = useRef(true);
  useLayoutEffect(() => {
    // Initial state is already correct; only transitions animate.
    if (initial.current) { initial.current = false; return; }
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    const instant = followSafe || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (open) {
      setMounted(true);
      setVisible(true);
      setSettled(false);
      if (instant) { setExpanded(true); setSettled(true); return; }
      // Paint the collapsed state once so the grid-rows transition runs.
      frame.current = requestAnimationFrame(() => {
        frame.current = requestAnimationFrame(() => {
          setExpanded(true);
          timer.current = window.setTimeout(() => setSettled(true), COLLAPSE_DURATION_MS + 40);
        });
      });
    } else {
      setExpanded(false);
      setSettled(false);
      if (instant) { setVisible(false); if (!keepMounted) setMounted(false); return; }
      timer.current = window.setTimeout(() => { setVisible(false); if (!keepMounted) setMounted(false); }, COLLAPSE_DURATION_MS + 40);
    }
  }, [open, keepMounted, followSafe]);
  useEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);
  if (!mounted) return null;
  return <div {...rest} ref={bodyRef} className={`ui-collapse${expanded ? ' is-open' : ''}${settled ? ' is-settled' : ''}${className ? ` ${className}` : ''}`} hidden={!visible} inert={!open}>
    <div className={`ui-collapse-inner${innerClassName ? ` ${innerClassName}` : ''}`}>{children}</div>
  </div>;
}
