import type { NativeSubagent } from '../../../shared/contracts';

export interface CapsuleMorph { key: number; agentId: string; source: HTMLElement; startedAt: number }
let serial = 0;
let morphs: CapsuleMorph[] = [];
const listeners = new Set<() => void>();
const targets = new Map<string, HTMLElement>();
const targetListeners = new Set<() => void>();
const expiry = new Map<number, number>();
const pulses = new WeakMap<HTMLElement, number>();
export function launchCapsuleMorph(agentId: string, fromEl: HTMLElement, _snapshot: NativeSubagent): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden || !fromEl.isConnected) return;
  const panel = document.querySelector<HTMLElement>('.work-panel:not(.is-exiting)');
  if (!targets.has(agentId) && (!panel || !panel.checkVisibility({ checkVisibilityCSS: true }))) {
    clearTimeout(pulses.get(fromEl));
    fromEl.setAttribute('data-pulse', 'true');
    pulses.set(fromEl, window.setTimeout(() => { fromEl.removeAttribute('data-pulse'); pulses.delete(fromEl); }, 400));
    return;
  }
  for (const morph of morphs) if (morph.agentId === agentId) finishCapsuleMorph(morph.key);
  const key = ++serial;
  morphs = [...morphs, { key, agentId, source: fromEl, startedAt: performance.now() }];
  expiry.set(key, window.setTimeout(() => finishCapsuleMorph(key), 700));
  for (const listener of listeners) listener();
}
export function registerCapsuleTarget(agentId: string, el: HTMLElement | null): void {
  if (el) targets.set(agentId, el); else targets.delete(agentId);
  for (const listener of targetListeners) listener();
}
export function subscribeCapsuleMorphs(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function capsuleMorphSnapshot(): CapsuleMorph[] { return morphs; }
export function subscribeCapsuleTargets(listener: () => void): () => void { targetListeners.add(listener); return () => { targetListeners.delete(listener); }; }
export function capsuleTarget(agentId: string): HTMLElement | undefined {
  const target = targets.get(agentId);
  return target?.isConnected && !target.closest('[inert], [hidden], [aria-hidden="true"]') ? target : undefined;
}
export function finishCapsuleMorph(key: number): void {
  clearTimeout(expiry.get(key)); expiry.delete(key);
  if (!morphs.some(morph => morph.key === key)) return;
  morphs = morphs.filter(morph => morph.key !== key);
  for (const listener of listeners) listener();
}
