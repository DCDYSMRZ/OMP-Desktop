// Adapted from PI-Desktop-main WorkPanel (LGPL-3.0). PI plugin/orchestration surfaces removed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent, PanelRequest } from '../../shared/contracts';
import { IconBot, IconClose, IconDatabase, IconDiff, IconFileText, IconFolder, IconPlus, IconPanelMaximize, IconPanelRestore, IconWorkflow } from '../ui/icons';
import { cx, TooltipButton } from '../ui/ui';
import { MAIN_PANE_MIN_WIDTH, WORK_PANEL_MIN_WIDTH, WORK_PANEL_DEFAULT_WIDTH, workPanelWidthBounds } from '../lib/work-panel-resize';
import { useLiquidIndicator } from '../lib/glass/useLiquidIndicator';
import { FilesTab } from './FilesTab';
import { ReviewTab } from './ReviewChangeCard';
import { SubagentTranscriptTab } from './SubagentTranscriptTab';
import { SubagentStage } from './SubagentStage';
import { AgentMap, type AgentMapBatch } from './AgentMap';
import { findSubagent, groupSubagentsByToolCall, subagentPhase } from './subagent-model';
import { SavedResourcePanel } from './SavedResourcePanel';
import './workspace.css';

interface PanelTarget extends Omit<PanelRequest, 'kind'> { kind: PanelRequest['kind'] | 'agents' }
interface Tab extends PanelTarget { id: string; revision?: number; resourceName?: string }
interface Context { tabs: Tab[]; active: string; maximized: boolean; lastRequest: PanelRequest | null }
interface Props { cwd: string; runtimeId: string | null; sessionTitle?: string; parentSessionPath?: string; historyLeafId?: string | null; subagents: NativeSubagent[]; request: PanelRequest | null; width: number; onWidthChange: (width: number) => void; onClose: () => void; onActiveSubagentChange?: (id: string | null) => void; exiting?: boolean; onExitComplete?: () => void }
const contexts = new Map<string, Context>();
const tabIcons = { file: IconFileText, changes: IconDiff, resource: IconDatabase, subagent: IconBot, agents: IconWorkflow };
export function WorkPanel(props: Props) {
  const key = JSON.stringify([props.runtimeId, props.parentSessionPath, props.historyLeafId, props.cwd]);
  return <PanelContext key={key} {...props} initial={contexts.get(key)} save={context => {
    contexts.delete(key); contexts.set(key, context);
    if (contexts.size > 64) contexts.delete(contexts.keys().next().value!);
  }} />;
}
function PanelContext({ cwd, runtimeId, sessionTitle, parentSessionPath, historyLeafId, subagents, request, width, onWidthChange, onClose, onActiveSubagentChange, exiting, onExitComplete, initial, save }: Props & { initial?: Context; save: (context: Context) => void }) {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<Tab[]>(initial?.tabs ?? []);
  const [active, setActive] = useState(initial?.active ?? '');
  const [maximized, setMaximized] = useState(initial?.maximized ?? false);
  const [launcher, setLauncher] = useState(!initial?.tabs.length);
  const [maximum, setMaximum] = useState(window.innerWidth - MAIN_PANE_MIN_WIDTH);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useLiquidIndicator(trackRef, launcher ? null : active, 'x');
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const resize = useRef<{ x: number; width: number; current: number } | null>(null);
  const lastRequest = useRef<PanelRequest | null>(initial?.lastRequest ?? null);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    if (exiting && node.contains(document.activeElement)) {
      const targets = ['.app-work-panel-toggle', '.composer-input[contenteditable="true"], .composer-input-wrap textarea'].flatMap(selector => Array.from(document.querySelectorAll<HTMLElement>(selector)));
      for (const target of targets) {
        if (target.closest('[inert], [hidden]') || !target.getClientRects().length || target.matches(':disabled')) continue;
        target.focus({ preventScroll: true });
        if (document.activeElement === target) break;
      }
    }
    node.inert = !!exiting;
  }, [exiting]);
  const activeTab = tabs.find(tab => tab.id === active);
  const activeSubagentId = !launcher && !exiting && activeTab?.kind === 'subagent' ? activeTab.subagentId ?? null : null;
  useLayoutEffect(() => { onActiveSubagentChange?.(activeSubagentId); }, [activeSubagentId, active, launcher, onActiveSubagentChange]);
  useLayoutEffect(() => () => { onActiveSubagentChange?.(null); }, [onActiveSubagentChange]);
  useLayoutEffect(() => { save({ tabs, active, maximized, lastRequest: lastRequest.current }); }, [tabs, active, maximized, save]);
  useLayoutEffect(() => {
    // The retained .app-chat-shell is display:contents: it has no layout box.
    // Measure the actual flex shell, never a panel-sized wrapper or the panel itself.
    const root = panel.current?.closest<HTMLElement>('.app-shell');
    if (!root) return;
    let observedSidebar: HTMLElement | null = null;
    const measure = () => {
      const sidebar = root.querySelector<HTMLElement>('.sidebar');
      if (sidebar !== observedSidebar) {
        if (observedSidebar) observer.unobserve(observedSidebar);
        observedSidebar = sidebar;
        if (sidebar) observer.observe(sidebar);
      }
      const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
      const panelStyle = panel.current ? getComputedStyle(panel.current) : null;
      const margins = (sidebarStyle ? parseFloat(sidebarStyle.marginLeft) + parseFloat(sidebarStyle.marginRight) : 0)
        + (panelStyle ? parseFloat(panelStyle.marginLeft) + parseFloat(panelStyle.marginRight) : 0);
      setMaximum(Math.max(1, root.clientWidth - (sidebar?.getBoundingClientRect().width ?? 0) - margins - MAIN_PANE_MIN_WIDTH));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    // Sidebar mount/unmount changes the shell class without resizing the shell.
    const shellChanges = new MutationObserver(measure);
    shellChanges.observe(root, { attributes: true, attributeFilter: ['class'] });
    measure();
    return () => { observer.disconnect(); shellChanges.disconnect(); };
  }, []);
  const bounds = workPanelWidthBounds(width < WORK_PANEL_MIN_WIDTH ? 1 : WORK_PANEL_MIN_WIDTH, maximum);
  const renderedWidth = Math.min(bounds.maximum, Math.max(bounds.minimum, previewWidth ?? width));
  const labelCounts = new Map<string, number>();
  const tabLabels: Record<string, string> = Object.fromEntries(tabs.map(tab => {
    let label = tab.kind === 'file' ? tab.path?.split('/').at(-1) || t('panel.tabs.file') : tab.kind === 'changes' ? t('omp.workspace.gitChanges') : tab.kind === 'resource' ? tab.resourceName || tab.reference || t('omp.resource.title', { defaultValue: 'Saved output' }) : tab.kind === 'agents' ? t('omp.panel.agents') : findSubagent(subagents, tab.subagentId ?? '')?.agent || tab.subagentId || t('panel.tabs.subagent');
    if (tab.kind === 'subagent') {
      const count = (labelCounts.get(label) ?? 0) + 1;
      labelCounts.set(label, count);
      if (count > 1) label += ` #${count}`;
    }
    return [tab.id, label];
  }));
  const open = useCallback((target: PanelTarget) => {
    const id = target.kind === 'agents' ? 'agents' : target.kind === 'resource' ? `resource:${encodeURIComponent(JSON.stringify({ parentPath: target.parentPath, subagentId: target.subagentId, leafId: target.leafId, reference: target.reference }))}` : `${target.kind}:${target.path ?? target.subagentId ?? ''}`;
    setTabs(old => old.some(tab => tab.id === id) ? old.map(tab => tab.id === id ? { ...tab, revision: (tab.revision ?? 0) + 1 } : tab) : [...old, { ...target, id }]);
    setActive(id); setLauncher(false);
  }, []);
  const nameResource = useCallback((id: string, name: string) => {
    setTabs(old => {
      const target = old.find(tab => tab.kind === 'resource' && tab.id === id);
      return !target || target.resourceName === name ? old : old.map(tab => tab === target ? { ...tab, resourceName: name } : tab);
    });
  }, []);
  useEffect(() => { if (request && request !== lastRequest.current) { lastRequest.current = request; open(request); } }, [request, open]);
  const closeTab = (id: string) => {
    const index = tabs.findIndex(tab => tab.id === id); const next = tabs[index + 1] ?? tabs[index - 1];
    setTabs(old => old.filter(tab => tab.id !== id));
    if (active === id) { setActive(next?.id ?? ''); setLauncher(!next); if (next) requestAnimationFrame(() => buttons.current[next.id]?.focus()); }
  };
  const reorder = (source: string, target: string, after: boolean) => {
    setTabs(old => { const moving = old.find(tab => tab.id === source); if (!moving || source === target) return old; const next = old.filter(tab => tab.id !== source); const index = next.findIndex(tab => tab.id === target); next.splice(index + Number(after), 0, moving); return next; });
  };
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = tabs.findIndex(tab => tab.id === id);
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); closeTab(id); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex]; if (!next) return;
    if (event.altKey) reorder(id, next.id, event.key === 'ArrowRight');
    else { setActive(next.id); setLauncher(false); buttons.current[next.id]?.focus(); }
  };
  const commitResize = (commit: boolean) => { const current = resize.current; resize.current = null; setPreviewWidth(null); if (commit && current && current.current !== current.width) onWidthChange(current.current); };
  const openFile = useCallback((path: string) => open({ kind: 'file', path }), [open]);
  const openSubagent = useCallback((id: string) => open({ kind: 'subagent', subagentId: id }), [open]);
  const backToAgents = () => {
    if (tabs.some(tab => tab.kind === 'agents')) { setActive('agents'); setLauncher(false); }
    else setLauncher(true);
  };
  const runningCount = subagents.filter(agent => subagentPhase(agent) === 'running').length;
  const style = { width: renderedWidth, '--work-panel-width': `${renderedWidth}px` } as CSSProperties;
  return <aside ref={panel} className={cx('work-panel lg-regular lg-pane', maximized && 'is-maximized', maximized && 'omp-panel-maximized', exiting && 'is-exiting')} onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === 'work-panel-out') onExitComplete?.(); }} style={maximized ? undefined : style} data-testid="work-panel" data-resizing={previewWidth !== null ? 'true' : undefined}>
    <div className="work-panel-resize no-drag" role="separator" aria-orientation="vertical" aria-label={t('panel.resize')} aria-valuemin={bounds.minimum} aria-valuemax={bounds.maximum} aria-valuenow={Math.round(renderedWidth)} aria-disabled={maximized} tabIndex={0} onPointerDown={event => { if (maximized || event.button !== 0) return; event.preventDefault(); resize.current = { x: event.clientX, width: renderedWidth, current: renderedWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { const gesture = resize.current; if (!gesture) return; gesture.current = Math.max(bounds.minimum, Math.min(bounds.maximum, gesture.width + gesture.x - event.clientX)); setPreviewWidth(gesture.current); }} onPointerUp={event => { commitResize(true); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => commitResize(false)} onLostPointerCapture={() => commitResize(false)} onDoubleClick={() => { if (!maximized) onWidthChange(Math.min(bounds.maximum, Math.max(bounds.minimum, WORK_PANEL_DEFAULT_WIDTH))); }} onKeyDown={event => { if (event.key === 'Escape') { commitResize(false); return; } if (maximized) return; const step = event.shiftKey ? 32 : 16; const next = event.key === 'ArrowLeft' ? renderedWidth + step : event.key === 'ArrowRight' ? renderedWidth - step : event.key === 'Home' ? bounds.minimum : event.key === 'End' ? bounds.maximum : null; if (next !== null) { event.preventDefault(); onWidthChange(Math.max(bounds.minimum, Math.min(bounds.maximum, next))); } }} />
    <div className="work-panel-main"><header className="work-panel-header"><div className="work-panel-tab-strip-wrap no-drag"><div ref={trackRef} className="work-panel-tab-strip lg-thin lg-static lg-capsule" role="tablist" aria-label={t('panel.tabsLabel')} onWheel={event => { if (event.currentTarget.scrollWidth > event.currentTarget.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY; }}>
      <div ref={indicatorRef} className="lg-liquid-indicator" aria-hidden />
      {tabs.map(tab => { const TabIcon = tabIcons[tab.kind]; return <div key={tab.id} className={cx('work-panel-tab', active === tab.id && !launcher && 'active', dragging === tab.id && 'is-dragging', dropTarget === tab.id && 'is-drop-before')} data-kind={tab.kind} data-work-panel-tab-id={tab.id} data-liquid-key={tab.id} onDragOver={event => { if (dragging) { event.preventDefault(); setDropTarget(tab.id); } }} onDrop={event => { event.preventDefault(); if (dragging) reorder(dragging, tab.id, event.clientX > event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2); setDragging(null); setDropTarget(null); }}>
        <button ref={node => { buttons.current[tab.id] = node; }} type="button" role="tab" id={`work-panel-tab-${tab.id}`} aria-selected={active === tab.id && !launcher} aria-controls={`work-panel-surface-${tab.id}`} tabIndex={active === tab.id ? 0 : -1} className="work-panel-tab-button" draggable onDragStart={event => { event.dataTransfer.setData('text/plain', tab.id); setDragging(tab.id); }} onDragEnd={() => { setDragging(null); setDropTarget(null); }} title={tab.path ?? tabLabels[tab.id]} onClick={() => { setActive(tab.id); setLauncher(false); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }} onKeyDown={event => tabKeyDown(event, tab.id)}><TabIcon size={14} /><span className="work-panel-tab-label">{tabLabels[tab.id]}</span></button><button type="button" className="work-panel-tab-close" aria-label={t('panel.closeTab', { name: tabLabels[tab.id] })} onClick={() => closeTab(tab.id)}><IconClose size={12} /></button>
      </div>; })}
    </div></div><div className="work-panel-actions no-drag"><TooltipButton type="button" className="work-panel-new-tab" tooltip={t('panel.new.open')} ariaLabel={t('panel.new.open')} onClick={() => setLauncher(true)}><IconPlus size={16} /></TooltipButton><TooltipButton type="button" className="work-panel-maximize" tooltip={t(maximized ? 'panel.restore' : 'panel.maximize')} ariaLabel={t(maximized ? 'panel.restore' : 'panel.maximize')} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? <IconPanelRestore size={15} /> : <IconPanelMaximize size={15} />}</TooltipButton><TooltipButton type="button" className="work-panel-maximize" tooltip={t('omp.workspace.closePanel')} ariaLabel={t('omp.workspace.closePanel')} onClick={onClose}><IconClose size={14} /></TooltipButton></div></header>
    <div className="work-panel-body">{tabs.map(tab => <div key={tab.id} id={`work-panel-surface-${tab.id}`} className="work-panel-tabpane" role="tabpanel" aria-labelledby={`work-panel-tab-${tab.id}`} hidden={launcher || tab.id !== active}>{tab.kind === 'file' ? <FilesTab cwd={cwd} initialPath={tab.path} initialPathRevision={tab.revision} onOpenFile={openFile} /> : tab.kind === 'changes' ? <ReviewTab key={`${tab.id}:${tab.revision ?? 0}`} cwd={cwd} path={tab.path} onOpenFile={openFile} /> : tab.kind === 'resource' ? <SavedResourcePanel resourceId={tab.id} parentPath={tab.parentPath} subagentId={tab.subagentId} leafId={tab.leafId} reference={tab.reference} visible={!launcher && tab.id === active} onName={nameResource} onOpenSessionResource={tab.parentPath ? reference => open({ kind: 'resource', parentPath: tab.parentPath, subagentId: tab.subagentId, leafId: tab.leafId, reference }) : undefined} /> : tab.kind === 'agents' ? <AgentsOverview agents={subagents} sessionTitle={sessionTitle} activeSubagentId={activeSubagentId} onOpen={openSubagent} /> : <SubagentTranscriptTab cwd={cwd} runtimeId={runtimeId} parentSessionPath={parentSessionPath} historyLeafId={historyLeafId} subagentId={tab.subagentId ?? ''} subagent={findSubagent(subagents, tab.subagentId ?? '')} visible={!launcher && tab.id === active} onBack={backToAgents} onOpenFile={openFile} onOpenSessionResource={parentSessionPath && tab.subagentId ? reference => open({ kind: 'resource', parentPath: parentSessionPath, subagentId: findSubagent(subagents, tab.subagentId!)?.savedId ?? findSubagent(subagents, tab.subagentId!)?.id ?? tab.subagentId, leafId: historyLeafId, reference }) : undefined} />}</div>)}
    {launcher && <div className="work-panel-tabpane"><div className="work-panel-launcher"><div className="work-panel-launcher-title">{t('panel.title')}</div><div className="work-panel-launcher-list" role="group" aria-label={t('panel.toolsAndPanels')}><button type="button" className="work-panel-launcher-row lg-thin lg-static lg-control lg-pressable" onClick={() => open({ kind: 'file' })}><span className="work-panel-launcher-icon lg-regular lg-static lg-capsule"><IconFolder size={18} /></span><span className="work-panel-launcher-label">{t('panel.tabs.file')}</span></button><button type="button" className="work-panel-launcher-row lg-thin lg-static lg-control lg-pressable" onClick={() => open({ kind: 'changes' })}><span className="work-panel-launcher-icon lg-regular lg-static lg-capsule"><IconDiff size={18} /></span><span className="work-panel-launcher-label">{t('omp.workspace.gitChanges')}</span></button>{subagents.length > 0 && <button type="button" className="work-panel-launcher-row lg-thin lg-static lg-control lg-pressable" onClick={() => open({ kind: 'agents' })}><span className="work-panel-launcher-icon lg-regular lg-static lg-capsule"><IconWorkflow size={18} /></span><span className="work-panel-launcher-label">{t('omp.panel.agents')}</span><span className="work-panel-launcher-badge lg-capsule">{subagents.length}</span>{runningCount > 0 && <span className="work-panel-running-dot" role="img" aria-label={t('omp.panel.runningCount', { count: runningCount })} />}</button>}</div></div></div>}
    </div></div></aside>;
}

function AgentsOverview({ agents, sessionTitle, activeSubagentId, onOpen }: { agents: NativeSubagent[]; sessionTitle?: string; activeSubagentId: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const groups = useMemo(() => groupSubagentsByToolCall(agents, new Set(agents.flatMap(agent => agent.parentToolCallId ? [agent.parentToolCallId] : []))), [agents]);
  const batches = useMemo(() => {
    const result: AgentMapBatch[] = Array.from(groups.byToolCall, ([id, children], index) => ({ id, agents: children, label: t('omp.panel.taskGroup', { number: index + 1 }) }));
    if (groups.orphans.length) result.push({ id: 'unanchored', agents: groups.orphans, label: t('omp.panel.otherAgents') });
    return result;
  }, [groups, t]);
  return <div className="work-panel-agents">
    <AgentMap batches={batches} sessionTitle={sessionTitle} hoveredId={hoveredId} onHover={setHoveredId} activeSubagentId={activeSubagentId} onOpen={onOpen} />
    {Array.from(groups.byToolCall, ([id, children], index) => <SubagentStage key={id} toolCallId={id} agents={children} resolvedTrees={groups.resolvedTrees} title={t('omp.panel.taskGroup', { number: index + 1 })} activeSubagentId={activeSubagentId} hoveredId={hoveredId} onHover={setHoveredId} onOpen={onOpen} />)}
    {groups.orphans.length > 0 && <SubagentStage agents={groups.orphans} resolvedTrees={groups.resolvedTrees} title={t('omp.panel.otherAgents')} activeSubagentId={activeSubagentId} hoveredId={hoveredId} onHover={setHoveredId} onOpen={onOpen} />}
  </div>;
}
