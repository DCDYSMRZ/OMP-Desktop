import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent } from '../../shared/contracts';
import type { NativeAsyncDeliveryJob } from '../../shared/native-task-results';
import type { BodyProps } from '../chat/body-props';
import { contentText, messageText, printable, record, text, type ChatMessage, type ToolActivity } from '../chat/model';
import type { TurnActivity } from '../chat/presentation';
import { DisclosureScope, useAutomaticDisclosure } from '../chat/disclosure';
import { ToolRawDetails } from '../chat/tools/ToolStep';
import { toolStepLabel } from '../chat/tools/tool-model';
import { ResultImages } from '../chat/tools/detail-primitives';
import { Collapse } from '../ui/Collapse';
import { IconChevronRight } from '../ui/icons';
import { SubagentStage } from './SubagentStage';
import { AgentStatus, type AgentDelivery } from './TaskCards';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { flattenSubagentTree, plannedSubagents, subagentTitle, subagentTree, withTaskResults, type SubagentNode } from './subagent-model';

/** A task-call roster keeps linked deliveries on their agent rows and literal unmatched results reachable. */
export function TaskStep({ tool, resultRow, activities = [], byToolCall, resolvedTrees, observedLive, activeSubagentId, onOpenSubagent, live, ...body }: BodyProps & { tool: ToolActivity; resultRow?: ChatMessage; activities?: TurnActivity[]; byToolCall: Map<string, NativeSubagent[]>; resolvedTrees: SubagentNode[]; observedLive: boolean; activeSubagentId?: string | null; onOpenSubagent: (id: string) => void; live?: boolean }) {
  const { t } = useTranslation();
  const roots = byToolCall.get(tool.id) ?? [];
  const planned = useMemo(() => plannedSubagents(tool.args), [tool.args]);
  const trees = withTaskResults(resolvedTrees.length ? resolvedTrees.filter(node => roots.some(agent => agent.id === node.agent.id)) : subagentTree(roots), record(record(tool.result).details).results);
  const agents = trees.map(node => node.agent);
  const all = flattenSubagentTree(trees);
  const deliveries = new Map<string, AgentDelivery[]>();
  const remaining: { activity: TurnActivity; job?: NativeAsyncDeliveryJob; anchor?: string }[] = [];
  for (const activity of activities) {
    let anchor = activity.canonicalAnchor ? activity.row.id : undefined;
    for (const job of activity.delivery?.jobs ?? []) {
      const alias = job.agentId || text(record(job.raw).agentUrlId).replace(/^agent:\/\//, '') || job.id;
      const matches = job.ambiguous ? [] : all.filter(agent => [agent.id, agent.nativeId, text(agent.name), subagentTitle(agent)].includes(alias));
      if (matches.length === 1) { const id = matches[0].id; const rows = deliveries.get(id) ?? []; rows.push({ job, anchor }); deliveries.set(id, rows); }
      else remaining.push({ activity, job, anchor });
      anchor = undefined;
    }
    if (!activity.delivery || activity.delivery.residualContent.length || activity.delivery.diagnostics.length || !(activity.delivery.jobs.length)) remaining.push({ activity, anchor });
  }
  return <SubagentStage title={toolStepLabel(tool, t)} toolCallId={tool.id} agents={agents} planned={planned} resolvedTrees={trees} toolStatus={tool.status} toolError={tool.status === 'error' ? contentText(record(tool.result).content) : undefined} observedLive={observedLive} activeSubagentId={activeSubagentId} onOpen={onOpenSubagent} deliveries={deliveries} activityAttention={activities.some(activity => activity.delivery?.jobs.some(job => job.status === 'failed' || job.status === 'aborted'))} rawDetails={<><ToolRawDetails tool={tool} resultRow={resultRow} {...body} />{activities.map(activity => <pre key={activity.row.id} className="selectable">{printable(activity.row.raw)}</pre>)}</>} activityContent={<>{record(tool.result).historyResourceDeferred !== true && <ResultImages result={tool.result} onOpenSessionResource={body.onOpenSessionResource} />}{remaining.map(({ activity, job, anchor }, index) => <DeliveryRow key={`${activity.row.id}:${job?.id ?? index}`} job={job} activity={activity} anchor={anchor} />)}</>} />;
}
function DeliveryRow({ job, activity, anchor }: { job?: NativeAsyncDeliveryJob; activity: TurnActivity; anchor?: string }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const disclosure = useAutomaticDisclosure(false, `delivery:${activity.row.id}:${job?.id ?? 'residual'}`);
  const id = `delivery-${activity.row.id}-${job?.id ?? 'residual'}`;
  const result = job ? job.result || job.content || job.error || job.abortReason || printable(job.raw) : activity.delivery ? [contentText(activity.delivery.residualContent), ...activity.delivery.diagnostics].filter(Boolean).join('\n') : messageText(activity.row.raw);
  return <div className="task-delivery" data-message-id={anchor}><button ref={disclosure.titleRef} type="button" aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}><AgentStatus phase={job?.status ?? 'unknown'} /><span>{job?.label || t('omp.roster.delivery')}</span>{job?.durationMs !== undefined ? <span>{formatElapsed(job.durationMs, durationStyle, i18n.language)}</span> : job?.duration && <span>{job.duration}</span>}<IconChevronRight size="var(--icon-caption)" /></button><DisclosureScope disclosure={disclosure}><Collapse id={id} open={disclosure.open} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}><pre className="selectable">{result}</pre>{job && <pre className="selectable">{printable(job.raw)}</pre>}</Collapse></DisclosureScope></div>;
}
