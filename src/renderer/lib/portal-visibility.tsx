import { createContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export const PortalVisibilityContext = createContext(true);

export function PortalVisibilityProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <PortalVisibilityContext.Provider value={visible}>
      {children}
    </PortalVisibilityContext.Provider>
  );
}

export function visiblePortalContent(node: ReactNode) {
  return (
    <PortalVisibilityContext.Consumer>
      {(visible) => (visible ? node : null)}
    </PortalVisibilityContext.Consumer>
  );
}

export function portalToBody(node: ReactNode) {
  return typeof document === "undefined"
    ? node
    : createPortal(visiblePortalContent(node), document.body);
}

const glassExits = new Map<string, () => void>();

/** Keep only an inert visual snapshot after close; focus and React lifetimes stay unchanged. */
export function useGlassExit(ref: RefObject<HTMLElement | null>, open = true, sheet = false) {
  const pending = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    pending.current?.();
    const surface = ref.current;
    if (!surface) return;
    const source = sheet ? surface.parentElement : surface;
    const host = source?.parentElement;
    if (!source || !host) return;
    const key = surface.className.replace(/\blg-(?:morph|sheet)-(?:in|out)\b/g, '').trim();
    glassExits.get(key)?.();
    return () => {
      if (document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      if (surface.isConnected && getComputedStyle(surface).visibility === "hidden") return;
      pending.current?.();
      glassExits.get(key)?.();
      const clone = source.cloneNode(true) as HTMLElement;
      const animated = sheet ? clone.querySelector<HTMLElement>(".lg-sheet") : clone;
      if (!animated) return;
      clone.removeAttribute("id");
      clone.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
      clone.inert = true;
      clone.setAttribute("aria-hidden", "true");
      clone.style.pointerEvents = "none";
      clone.classList.add("lg-exit-snapshot");
      animated.classList.remove("lg-morph-in", "lg-sheet-in");
      animated.classList.add(sheet ? "lg-sheet-out" : "lg-morph-out");
      let timer: number;
      const remove = () => {
        window.clearTimeout(timer);
        clone.remove();
        if (pending.current === remove) pending.current = null;
        if (glassExits.get(key) === remove) glassExits.delete(key);
      };
      pending.current = remove;
      glassExits.set(key, remove);
      animated.addEventListener("animationend", event => { if (event.target === animated) remove(); });
      animated.addEventListener("animationcancel", event => { if (event.target === animated) remove(); });
      host.appendChild(clone);
      timer = window.setTimeout(remove, 400);
    };
  }, [open, ref, sheet]);
}
