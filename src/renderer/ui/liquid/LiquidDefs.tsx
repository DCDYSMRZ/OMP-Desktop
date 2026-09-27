import { useEffect, type JSX } from 'react';
import '../../styles/liquid.css';

/** Shared once by every inline stage, map and capsule. */
export function LiquidDefs(): JSX.Element {
  useEffect(() => {
    const update = () => document.documentElement.classList.toggle('liq-document-hidden', document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); document.documentElement.classList.remove('liq-document-hidden'); };
  }, []);
  return <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none' }}>
    <defs>
      <filter id="liq-glow" filterUnits="userSpaceOnUse" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4"/></filter>
      <filter id="liq-edge" filterUnits="userSpaceOnUse" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence baseFrequency=".9 .06" numOctaves="1" seed="3" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6" xChannelSelector="R" yChannelSelector="G"/></filter>
    </defs>
  </svg>;
}
