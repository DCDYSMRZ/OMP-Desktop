import type { JSX } from 'react';
import type { NativeSubagent } from '../../../shared/contracts';
import { subagentPhase } from '../../workspace/subagent-model';

export function DropletPill({ agents, planned = 0 }: { agents: NativeSubagent[]; planned?: number }): JSX.Element {
  const total = Math.max(agents.length, planned), count = Math.min(12, total);
  return <span className="liq-droplet-pill lg-static lg-thin lg-capsule" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <svg key={agents[index]?.id ?? index} className="liq-pill-drop" data-phase={agents[index] ? subagentPhase(agents[index]) : 'pending'} width="8" height="8" viewBox="0 0 8 10"><path d="M4 .6 C3 2.4 .7 4.8 .7 6.3 A3.3 3.3 0 0 0 7.3 6.3 C7.3 4.8 5 2.4 4 .6Z"/><circle className="liq-pill-highlight" cx="2.8" cy="5" r=".9"/></svg>)}
    {total > count && <span className="liq-pill-overflow">+{total - count}</span>}
  </span>;
}
