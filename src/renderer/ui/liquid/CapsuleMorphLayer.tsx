import { useLayoutEffect, useSyncExternalStore, type JSX } from 'react';
import { useReducedMotion } from '../../lib/agent-motion/ticker';
import { capsuleMorphSnapshot, capsuleTarget, finishCapsuleMorph, subscribeCapsuleMorphs, subscribeCapsuleTargets, type CapsuleMorph } from './capsule-morph';

function MorphingCapsule({ morph }: { morph: CapsuleMorph }): null {
  useLayoutEffect(() => {
    let frame: number | undefined, crossfade: number | undefined, clone: HTMLElement | undefined;
    let started = false, finished = false;
    const animations: Animation[] = [];
    const finish = () => {
      if (finished) return;
      finished = true; clone?.remove();
      for (const animation of animations) animation.cancel();
      finishCapsuleMorph(morph.key);
    };
    const deadline = window.setTimeout(finish, Math.max(0, 700 - (performance.now() - morph.startedAt)));
    const attempt = () => {
      if (started || finished || frame !== undefined || !capsuleTarget(morph.agentId)) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (finished || performance.now() - morph.startedAt >= 700) { finish(); return; }
        const target = capsuleTarget(morph.agentId), source = morph.source;
        if (!target) return;
        if (!source.isConnected || source.closest('[inert], [hidden], [aria-hidden="true"]') || !source.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) { finish(); return; }
        const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
        if (!from.width || !from.height || from.bottom <= 0 || from.right <= 0 || from.top >= window.innerHeight || from.left >= window.innerWidth || !to.width || !to.height) { finish(); return; }
        started = true;
        const sourceStyle = getComputedStyle(source);
        clone = source.cloneNode(true) as HTMLElement;
        clone.removeAttribute('id');
        clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        clone.inert = true; clone.setAttribute('aria-hidden', 'true');
        clone.classList.add('liq-capsule-morph');
        Object.assign(clone.style, { position: 'fixed', pointerEvents: 'none', left: from.x + 'px', top: from.y + 'px', width: from.width + 'px', height: from.height + 'px', minWidth: '0', maxWidth: 'none', margin: '0', transform: 'none', boxSizing: 'border-box', zIndex: '10000', font: sourceStyle.font, color: sourceStyle.color });
        document.body.appendChild(clone);
        const hidden = target.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 460, fill: 'forwards' });
        animations.push(hidden);
        animations.push(clone.animate([
          { left: from.x + 'px', top: from.y + 'px', width: from.width + 'px', height: from.height + 'px', borderRadius: sourceStyle.borderRadius },
          { left: to.x + 'px', top: to.y + 'px', width: to.width + 'px', height: to.height + 'px', borderRadius: getComputedStyle(target).borderRadius },
        ], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }));
        crossfade = window.setTimeout(() => {
          hidden.cancel();
          if (target.isConnected) animations.push(target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 }));
          if (!clone) return;
          const fade = clone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
          animations.push(fade); fade.onfinish = finish;
        }, 460 * .85);
      });
    };
    const unsubscribe = subscribeCapsuleTargets(attempt);
    attempt();
    return () => { finished = true; unsubscribe(); clearTimeout(deadline); clearTimeout(crossfade); if (frame !== undefined) cancelAnimationFrame(frame); clone?.remove(); for (const animation of animations) animation.cancel(); };
  }, [morph]);
  return null;
}

export function CapsuleMorphLayer(): JSX.Element {
  const morphs = useSyncExternalStore(subscribeCapsuleMorphs, capsuleMorphSnapshot);
  const reduced = useReducedMotion();
  useLayoutEffect(() => { if (reduced) for (const morph of morphs) finishCapsuleMorph(morph.key); }, [reduced, morphs]);
  return <>{!reduced && morphs.map(morph => <MorphingCapsule key={morph.key} morph={morph}/>)}</>;
}
