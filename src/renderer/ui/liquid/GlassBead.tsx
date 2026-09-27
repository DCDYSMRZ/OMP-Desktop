import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent } from '../../../shared/contracts';
import { subagentPhase } from '../../workspace/subagent-model';

export function GlassBead({ agent, size, ghost = false }: { agent: NativeSubagent | undefined; size: number; ghost?: boolean }): JSX.Element {
  const { t } = useTranslation();
  const phase = ghost || !agent ? 'pending' : subagentPhase(agent);
  const role = agent?.agent || (typeof agent?.progress?.agent === 'string' ? agent.progress.agent : '') || agent?.id || '';
  return <span className={'liq-bead liq-cabochon' + (ghost ? ' liq-bead-ghost' : '')} data-phase={phase} style={{ width: size, height: size }} role="img" aria-label={(role ? role + ': ' : '') + t('omp.subagent.stage.phase.' + phase)}>
    {!ghost && <>{phase === 'running' && <span className="liq-cabochon-ember" style={{ width: size * .36, height: size * .36 }}/>}<span className="liq-bead-letter" style={{ fontSize: size * .45 }}>{Array.from(role)[0]?.toLocaleUpperCase()}</span></>}
  </span>;
}
