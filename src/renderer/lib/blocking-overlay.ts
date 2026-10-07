import { useLayoutEffect, useSyncExternalStore } from "react";

// Count modal owners so shell keyboard actions can respect blocking surfaces.
// Dismissing one overlay must not release another overlay's ownership.
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const isBlockingOverlayActive = () => owners.size > 0;

export function useBlockingOverlay(active = true) {
  useLayoutEffect(() => {
    if (!active) return;
    const owner = Symbol();
    owners.add(owner);
    notify();
    return () => { owners.delete(owner); notify(); };
  }, [active]);
}

export function useBlockingOverlayActive() {
  return useSyncExternalStore(subscribe, isBlockingOverlayActive, () => false);
}
