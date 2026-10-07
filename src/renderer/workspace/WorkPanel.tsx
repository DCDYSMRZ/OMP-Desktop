// Adapted from PI-Desktop-main WorkPanel (LGPL-3.0). PI plugin/orchestration surfaces removed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent, PanelRequest as SharedPanelRequest, SavedSubagentEdge, SavedSubagentNavigation, SessionResourceContext } from '../../shared/contracts';
import type { ChangeOrigin } from '../../shared/turn-change-types';
import { IconBot, IconClose, IconDatabase, IconDiff, IconFileText, IconFolder, IconPlus, IconPanelMaximize, IconPanelRestore, IconWorkflow } from '../ui/icons';
import { cx, TooltipButton } from '../ui/ui';
import { MAIN_PANE_MIN_WIDTH, WORK_PANEL_MIN_WIDTH, WORK_PANEL_DEFAULT_WIDTH, workPanelWidthBounds, workPanelLayout } from '../lib/work-panel-resize';
import { parseFileTarget } from '../lib/file-target';
import { AnchoredMenu } from '../ui/AnchoredMenu';
import { FilesTab } from './FilesTab';
import { ReviewTab } from './ReviewChangeCard';
import { SubagentTranscriptTab } from './SubagentTranscriptTab';
import { TaskOverview } from './SubagentStage';
import { SessionInspector, type SessionInspectorProps } from './SessionInspector';
import { childPanelTarget, findSubagent, flattenSubagentTree, subagentActive, subagentPresentationId, subagentTitle, subagentTree, type SavedChildRecovery, type SubagentNode } from './subagent-model';
import { SavedResourcePanel } from './SavedResourcePanel';
import { SourceReadScope } from './source-read-scope';
import { belongsToRemoval, retainPanelSourceTabs, type PanelRemoval } from './panel-source-removal';
import { animateTo, isMotionPaused, motion, useReducedMotion } from '../ui/motion';
export type ReviewPanelRequest = SharedPanelRequest & { onRevealTool?: (toolId: string) => void };
type PanelRequest = ReviewPanelRequest;
import './workspace.css';

/** Document requests pin by default; tree previews replace only the single unpinned file.
 * Badge maps and reference sets use workspace-relative paths. Activity surfaces never enter the document strip. */
type PanelTarget = PanelRequest & { preview?: boolean; savedSubagent?: NativeSubagent; savedAncestry?: SavedSubagentEdge[]; savedRecovery?: SavedChildRecovery };
interface Tab extends PanelTarget { id: string; scope: SourceReadScope; revision?: number; resourceName?: string; sourceTitle?: string }
interface Context { tabs: Tab[]; active: string; selectedAgentId: string | null; maximized: boolean; lastRequest: PanelRequest | null }
interface Props { cwd: string; changedFiles?: ReadonlyMap<string, string>; referencedPaths?: ReadonlySet<string>; runtimeId: string | null; historyFollowing: boolean; observedLive?: boolean; parentSessionPath?: string; historyLeafId?: string | null; subagents: NativeSubagent[]; onSavedNavigation: (navigation: SavedSubagentNavigation) => void; request: PanelRequest | null; inspector?: SessionInspectorProps; onReturnToTurn?: (id: string) => void; width: number; onWidthChange: (width: number) => void; onClose: () => void; onActiveSubagentChange?: (id: string | null) => void; exiting?: boolean; onExitComplete?: () => void }
const contexts = new Map<string, Context>();
const removalListeners = new Set<(removal: PanelRemoval) => void>();
function pruneRemovedPanel(context: Context, removal: PanelRemoval, resolvedContexts?: Readonly<Record<string, SessionResourceContext>>): Context {
  const tabs = retainPanelSourceTabs(context.tabs, removal, false, resolvedContexts);
  if (tabs.length === context.tabs.length) return context;
  return { ...context, tabs, active: tabs.some(tab => tab.id === context.active) ? context.active : tabs[0]?.id ?? '', lastRequest: belongsToRemoval(context.lastRequest?.context, removal) ? null : context.lastRequest };
}
export function forgetWorkPanelSources(runtimeIds: readonly string[], sourcePath?: string): void {
  const removal = { runtimeIds, sourcePath };
  for (const [key, context] of contexts) {
    const [runtimeId, path] = JSON.parse(key) as [string | null, string | null];
    if (runtimeId && runtimeIds.includes(runtimeId) || sourcePath && path === sourcePath) { retainPanelSourceTabs(context.tabs, removal, true); contexts.delete(key); }
    else { const next = pruneRemovedPanel(context, removal); if (next !== context) contexts.set(key, next); }
  }
  for (const listener of removalListeners) listener(removal);
}
const tabIcons = { file: IconFileText, files: IconFolder, changes: IconDiff, resource: IconDatabase, subagent: IconBot, tasks: IconWorkflow, session: IconDatabase };
export function WorkPanel(props: Props) {
  const key = JSON.stringify([props.runtimeId, props.parentSessionPath, props.runtimeId ? null : props.historyLeafId, props.cwd]);
  return <PanelContext key={key} {...props} initial={contexts.get(key)} save={context => {
    contexts.delete(key); contexts.set(key, context);
    if (contexts.size > 64) contexts.delete(contexts.keys().next().value!);
  }} />;
}
function ScopedSubagentTranscript({ scope, ownerScope, onSavedNavigation, ...props }: ComponentProps<typeof SubagentTranscriptTab> & { scope: SourceReadScope; ownerScope: SourceReadScope }) {
  const publishNavigation = useCallback((navigation: SavedSubagentNavigation) => { if (scope.active && ownerScope.active) onSavedNavigation(navigation); }, [scope, ownerScope, onSavedNavigation]);
  return <SubagentTranscriptTab {...props} onSavedNavigation={publishNavigation} />;
}
function PanelContext({ cwd, changedFiles, referencedPaths, runtimeId, historyFollowing, observedLive = false, parentSessionPath, historyLeafId, subagents, onSavedNavigation, request, inspector, onReturnToTurn, width, onWidthChange, onClose, onActiveSubagentChange, exiting, onExitComplete, initial, save }: Props & { initial?: Context; save: (context: Context) => void }) {
  const { t } = useTranslation();
  const [sourceScope] = useState(() => new SourceReadScope(JSON.stringify([runtimeId, parentSessionPath])));
  const trees = useMemo(() => subagentTree(subagents), [subagents]);
  const allAgents = useMemo(() => flattenSubagentTree(trees), [trees]);
  const [resourceContexts, setResourceContexts] = useState<Record<string, SessionResourceContext>>({});
  const [tabs, setTabs] = useState<Tab[]>(initial?.tabs.length ? initial.tabs : [{ kind: 'files', id: 'files', scope: new SourceReadScope('files') }]);
  const [active, setActive] = useState(initial?.active || 'files');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initial?.selectedAgentId ?? null);
  const [maximized, setMaximized] = useState(initial?.maximized ?? false);
  const [menu, setMenu] = useState<'new' | 'tabs' | null>(null);
  const destinationOf = (tab?: Tab): 'files' | 'changes' | 'tasks' | 'session' => !tab || tab.kind === 'file' || tab.kind === 'files' ? 'files' : tab.kind === 'subagent' || tab.kind === 'tasks' ? 'tasks' : tab.kind === 'changes' ? 'changes' : 'session';
  const activeDestination = destinationOf(tabs.find(tab => tab.id === active));
  const documents = tabs.filter(tab => (tab.kind === 'file' || tab.kind === 'subagent' || tab.kind === 'resource') && destinationOf(tab) === activeDestination);
  const [workspaceChanges, setWorkspaceChanges] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (changedFiles || !cwd || request?.turnChangeQuery || tabs.find(tab => tab.id === active)?.turnChangeQuery) return;
    let current = true;
    window.ompDesktop.gitDiff(cwd, undefined, [...referencedPaths ?? []]).then(diff => { if (current) setWorkspaceChanges(new Map(diff.files.map(file => [file.path, file.status === '??' ? 'A' : file.status.trim().slice(-1)]))); }, () => { if (current) setWorkspaceChanges(new Map()); });
    return () => { current = false; };
  }, [cwd, changedFiles, request, referencedPaths, active]);
  const fileChanges = changedFiles ?? workspaceChanges;
  const [maximum, setMaximum] = useState(window.innerWidth - MAIN_PANE_MIN_WIDTH);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const resize = useRef<{ x: number; width: number; current: number } | null>(null);
  const lastRequest = useRef<PanelRequest | null>(initial?.lastRequest ?? null);
  const tabRects = useRef(new Map<string, number>());
  const tabsMounted = useRef(false);
  const geometry = useRef<{ maximized: boolean; rect: DOMRect } | null>(null);
  const tabClosures = useRef(new Map<string, Animation>());
  const currentTabs = useRef({ tabs, active });
  currentTabs.current = { tabs, active };
  const reducedMotion = useReducedMotion();
  const previousSurface = useRef({ active, index: tabs.findIndex(tab => tab.id === active) });
  // Child panes stay mounted: motion never owns paging or reading state.
  useLayoutEffect(() => {
    const previous = previousSurface.current;
    const index = tabs.findIndex(tab => tab.id === active);
    previousSurface.current = { active, index };
    if (previous.active === active) return;
    if (isMotionPaused()) return;
    const surface = document.getElementById(`work-panel-surface-${active}`);
    if (!surface) return;
    animateTo(surface, [{ opacity: 0, transform: reducedMotion ? 'none' : `translateX(${index >= previous.index ? 12 : -12}px)` }, { opacity: 1, transform: 'none' }], { duration: reducedMotion ? 80 : 240, easing: motion.enter });
  }, [active, tabs, reducedMotion, maximized]);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const easing = getComputedStyle(node).getPropertyValue('--motion-ease-out').trim();
    const next = new Map<string, number>();
    for (const tab of node.querySelectorAll<HTMLElement>('[data-work-panel-tab-id]')) {
      const id = tab.dataset.workPanelTabId!;
      const left = tab.offsetLeft;
      const previous = tabRects.current.get(id);
      if (!reduced && !isMotionPaused() && !tabClosures.current.has(id)) {
        if (previous !== undefined && previous !== left) animateTo(tab, [{ transform: `translateX(${previous - left}px)` }, { transform: 'none' }], { duration: motion.base, easing });
        else if (previous === undefined && tabsMounted.current) animateTo(tab, [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: motion.base, easing });
      }
      next.set(id, left);
    }
    tabRects.current = next;
    tabsMounted.current = true;
    const rect = node.getBoundingClientRect();
    const previous = geometry.current;
    if (previous && previous.maximized !== maximized && !reduced && !isMotionPaused()) {
      animateTo(node, [{ transformOrigin: 'top left', transform: `translate(${previous.rect.left - rect.left}px, ${previous.rect.top - rect.top}px) scale(${previous.rect.width / rect.width}, ${previous.rect.height / rect.height})` }, { transformOrigin: 'top left', transform: 'none' }], { duration: motion.expand, easing });
    }
    geometry.current = { maximized, rect };
  }, [tabs, maximized, width, previewWidth, maximum]);
  useEffect(() => () => { for (const animation of tabClosures.current.values()) animation.cancel(); }, []);
  useLayoutEffect(() => {
    const remove = (removal: PanelRemoval) => {
      const owned = !!runtimeId && removal.runtimeIds.includes(runtimeId) || !!removal.sourcePath && parentSessionPath === removal.sourcePath;
      if (owned) sourceScope.invalidate();
      const current = { tabs, active, selectedAgentId, maximized, lastRequest: lastRequest.current };
      const next = owned ? { ...current, tabs: retainPanelSourceTabs(tabs, removal, true), active: '', selectedAgentId: null, lastRequest: null } : pruneRemovedPanel(current, removal, resourceContexts);
      if (next !== current) { setTabs(next.tabs); setActive(next.active); setSelectedAgentId(next.selectedAgentId); lastRequest.current = next.lastRequest; }
      setResourceContexts(previous => Object.fromEntries(Object.entries(previous).filter(([, context]) => !belongsToRemoval(context, removal))));
    };
    removalListeners.add(remove);
    return () => { removalListeners.delete(remove); };
  }, [runtimeId, parentSessionPath, tabs, active, selectedAgentId, maximized, resourceContexts, sourceScope]);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    if (exiting && !reducedMotion && !isMotionPaused()) {
      const identity = node.querySelector<HTMLElement>('.work-panel-tabpane:not([hidden]) .subagent-detail-title[data-agent-identity]');
      const destination = identity && Array.from(document.querySelectorAll<HTMLElement>('.task-card [data-agent-identity]')).find(item => item.dataset.agentIdentity === identity.dataset.agentIdentity && item.getClientRects().length);
      if (identity && destination) {
        const from = identity.getBoundingClientRect(), to = destination.getBoundingClientRect();
        animateTo(identity, [{ transform: 'none', opacity: 1 }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px)`, opacity: 0 }], { duration: motion.fast, easing: motion.leave });
      }
    }
    if (exiting && node.contains(document.activeElement)) {
      const targets = ['.app-work-panel-toggle', '.composer-input[contenteditable="true"], .composer-input-wrap textarea'].flatMap(selector => Array.from(document.querySelectorAll<HTMLElement>(selector)));
      for (const target of targets) {
        if (target.closest('[inert], [hidden]') || !target.getClientRects().length || target.matches(':disabled')) continue;
        target.focus({ preventScroll: true });
        if (document.activeElement === target) break;
      }
    }
    node.inert = !!exiting;
  }, [exiting, reducedMotion]);
  const activeTab = tabs.find(tab => tab.id === active);
  const activeSubagentId = !exiting && activeTab?.kind === 'subagent' ? findSubagent(allAgents, activeTab.subagentId ?? '')?.id ?? activeTab.subagentId ?? null : null;
  useLayoutEffect(() => { if (activeTab?.kind === 'subagent' && activeTab.subagentId) setSelectedAgentId(activeTab.subagentId); }, [activeTab?.kind, activeTab?.subagentId]);
  useLayoutEffect(() => { onActiveSubagentChange?.(activeSubagentId); }, [activeSubagentId, active, onActiveSubagentChange]);
  useLayoutEffect(() => () => { onActiveSubagentChange?.(null); }, [onActiveSubagentChange]);
  useLayoutEffect(() => { if (!sourceScope.active) return; const retained = tabs.filter(tab => tab.scope.active); save({ tabs: retained, active: retained.some(tab => tab.id === active) ? active : retained[0]?.id ?? '', selectedAgentId, maximized, lastRequest: lastRequest.current }); }, [tabs, active, selectedAgentId, maximized, save, sourceScope]);
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
      const sidebarCollapsed = root.classList.contains('sidebar-collapsed');
      const sidebarStyle = sidebar && !sidebarCollapsed ? getComputedStyle(sidebar) : null;
      const panelStyle = panel.current ? getComputedStyle(panel.current) : null;
      const margins = (sidebarStyle ? parseFloat(sidebarStyle.marginLeft) + parseFloat(sidebarStyle.marginRight) : 0)
        + (panelStyle ? parseFloat(panelStyle.marginLeft) + parseFloat(panelStyle.marginRight) : 0);
      setMaximum(Math.max(1, workPanelLayout({ containerWidth: root.clientWidth - margins, sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0, sidebarCollapsed, requestedPanelWidth: WORK_PANEL_DEFAULT_WIDTH }).maxPanelWidth));
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
  const tabLabels: Record<string, string> = Object.fromEntries(tabs.map(tab => {
    const agent = tab.savedSubagent ?? findSubagent(allAgents, tab.subagentId ?? '');
    const label = tab.kind === 'file' ? tab.path?.split('/').at(-1) || t('panel.tabs.file') : tab.kind === 'files' ? t('omp.panel.files') : tab.kind === 'changes' ? t('omp.panel.changes') : tab.kind === 'resource' ? tab.resourceName || t('omp.resource.title') : tab.kind === 'tasks' ? t('omp.panel.tasks') : tab.kind === 'session' ? t('omp.panel.session') : (agent && subagentTitle(agent)) || tab.sourceTitle || tab.subagentId || t('panel.tabs.subagent');
    return [tab.id, label];
  }));
  const open = useCallback((target: PanelTarget, originScope?: SourceReadScope) => {
    if (!sourceScope.active || originScope?.active === false) return;
    const agent = target.kind === 'subagent' ? findSubagent(subagents, target.subagentId ?? '') : undefined;
    if (!target.savedAncestry && agent?.historical === true && agent.savedAncestry) target = { ...target, savedSubagent: { ...agent, savedChildren: undefined }, savedAncestry: agent.savedAncestry };
    const presentationId = agent && subagentPresentationId(agent);
    const uniqueAlias = agent && allAgents.filter(item => subagentPresentationId(item) === presentationId).length === 1;
    const identity = target.kind === 'subagent' && uniqueAlias && !target.savedAncestry ? presentationId : target.subagentId;
    const id = ['files', 'tasks', 'session'].includes(target.kind) ? target.kind : target.kind === 'changes' ? `changes:${target.turnChangeQuery ? JSON.stringify([target.turnChangeQuery.context, target.turnChangeQuery.anchorId]) : 'workspace'}` : target.kind === 'resource' ? `resource:${encodeURIComponent(JSON.stringify({ context: target.context, reference: target.reference }))}` : `${target.kind}:${target.path ?? identity ?? ''}${target.savedAncestry?.length ? `:${encodeURIComponent(JSON.stringify(target.savedAncestry))}` : ''}`;
    setTabs(old => {
      if (!sourceScope.active || originScope?.active === false) return old;
      const existing = old.find(tab => tab.id === id);
      if (!existing) {
        const replaced = target.preview ? old.find(tab => tab.kind === 'file' && tab.preview) : undefined;
        if (replaced) replaced.scope.invalidate();
        const retained = old.filter(tab => tab !== replaced);
        if (target.kind === 'subagent' && !retained.some(tab => tab.kind === 'tasks')) retained.push({ kind: 'tasks', id: 'tasks', scope: new SourceReadScope('tasks') });
        return [...retained, { ...target, id, scope: new SourceReadScope(id) }];
      }
      const visited = new Set<string>();
      let origin = target.originTabId;
      while (origin && !visited.has(origin) && origin !== id) { visited.add(origin); origin = old.find(tab => tab.id === origin)?.originTabId; }
      const navigation = origin === id ? { originTabId: existing.originTabId, originTurnId: existing.originTurnId } : { originTabId: target.originTabId, originTurnId: target.originTurnId };
      return old.map(tab => tab.id === id ? { ...tab, ...target, preview: tab.preview === true && target.preview === true, line: target.line, endLine: target.endLine, ...navigation, revision: (tab.revision ?? 0) + 1 } : tab);
    });
    setActive(id); setMenu(null);
    if (target.kind === 'subagent' && document.activeElement?.matches('button:focus-visible, a:focus-visible')) requestAnimationFrame(() => { if (!sourceScope.active || originScope?.active === false) return; const button = buttons.current[id]; if (button?.getAttribute('aria-selected') === 'true') button.focus(); });
  }, [subagents, allAgents, sourceScope]);
  const nameResource = useCallback((id: string, name: string) => {
    setTabs(old => {
      const target = old.find(tab => tab.kind === 'resource' && tab.id === id);
      return !target || target.resourceName === name ? old : old.map(tab => tab === target ? { ...tab, resourceName: name } : tab);
    });
  }, []);
  const nameSubagent = useCallback((id: string, revision: number | undefined, sourceTitle: string) => {
    setTabs(old => {
      const target = old.find(tab => tab.kind === 'subagent' && tab.id === id && tab.revision === revision);
      return !target || target.sourceTitle === sourceTitle ? old : old.map(tab => tab === target ? { ...tab, sourceTitle } : tab);
    });
  }, []);
  useEffect(() => { if (request && request !== lastRequest.current) { lastRequest.current = request; open(request); } }, [request, open]);
  useEffect(() => { if (!activeTab && sourceScope.active) open({ kind: 'files' }); }, [activeTab, open, sourceScope]);
  useLayoutEffect(() => { buttons.current[active]?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);
  const closeTab = (id: string) => {
    if (tabClosures.current.has(id)) return;
    const node = buttons.current[id]?.closest<HTMLElement>('.work-panel-tab');
    const remove = () => {
      tabClosures.current.delete(id);
      for (const tab of panel.current?.querySelectorAll<HTMLElement>('[data-work-panel-tab-id]') ?? []) tabRects.current.set(tab.dataset.workPanelTabId!, tab.offsetLeft);
      const current = currentTabs.current;
      const closing = current.tabs.find(tab => tab.id === id);
      const siblings = current.tabs.filter(tab => destinationOf(tab) === destinationOf(closing));
      const index = siblings.findIndex(tab => tab.id === id); const next = siblings[index + 1] ?? siblings[index - 1];
      setTabs(old => old.filter(tab => tab.id !== id));
      if (current.active === id) { setActive(next?.id ?? ''); if (next) requestAnimationFrame(() => buttons.current[next.id]?.focus()); }
    };
    if (!node || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { remove(); return; }
    node.inert = true;
    const animation = node.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(3px) scale(.98)' }], { duration: motion.exit, easing: motion.leave, fill: 'forwards' });
    tabClosures.current.set(id, animation);
    animation.onfinish = remove;
  };
  const reorder = (source: string, target: string, after: boolean) => {
    setTabs(old => { const moving = old.find(tab => tab.id === source); if (!moving || source === target) return old; const next = old.filter(tab => tab.id !== source); const index = next.findIndex(tab => tab.id === target); next.splice(index + Number(after), 0, moving); return next; });
  };
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = documents.findIndex(tab => tab.id === id);
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); closeTab(id); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? documents.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + documents.length) % documents.length;
    const next = documents[nextIndex]; if (!next) return;
    if (event.altKey) reorder(id, next.id, event.key === 'ArrowRight');
    else { setActive(next.id); buttons.current[next.id]?.focus(); }
  };
  const commitResize = (commit: boolean) => { const current = resize.current; resize.current = null; setPreviewWidth(null); if (commit && current && current.current !== current.width) onWidthChange(current.current); };
  const openFile = (path: string, scope?: SourceReadScope, preview = false) => open({ kind: 'file', ...parseFileTarget(path), preview, originTabId: active, originTurnId: activeTab?.originTurnId }, scope);
  const openSubagent = (id: string, scope?: SourceReadScope) => { if (id !== activeTab?.subagentId) open({ kind: 'subagent', subagentId: id, originTabId: active, originTurnId: activeTab?.originTurnId }, scope); };
  const openSavedSubagent = (agent: NativeSubagent, savedAncestry: SavedSubagentEdge[], scope?: SourceReadScope) => open({ kind: 'subagent', ...childPanelTarget(agent, savedAncestry, allAgents, observedLive && !!runtimeId), originTabId: active, originTurnId: activeTab?.originTurnId }, scope);
  const back = (tab: Tab) => {
    if (!sourceScope.active || !tab.scope.active) return;
    if (tab.originTabId && tabs.some(item => item.id === tab.originTabId)) { setActive(tab.originTabId); requestAnimationFrame(() => buttons.current[tab.originTabId!]?.focus()); }
    else if (tab.originTurnId && onReturnToTurn) { onReturnToTurn(tab.originTurnId); onClose(); }
    else open({ kind: tab.kind === 'file' ? 'files' : 'tasks' });
  };
  const resourceContext = (agent?: NativeSubagent): SessionResourceContext | undefined => runtimeId && agent?.historical !== true ? { kind: 'runtime', runtimeId, ...(agent ? { subagentId: agent.nativeId ?? agent.id } : {}) } : parentSessionPath ? { kind: 'saved', parentPath: parentSessionPath, leafId: historyLeafId, ...(agent ? { subagentId: agent.savedId ?? agent.id, ancestry: agent.savedAncestry } : {}) } : undefined;
  const ancestry = (id: string, nodes: SubagentNode[] = trees, parents: NativeSubagent[] = []): NativeSubagent[] | undefined => {
    for (const node of nodes) { if (node.agent.id === id) return parents; const found = ancestry(id, node.children, [...parents, node.agent]); if (found) return found; }
    return undefined;
  };
  const exitRect = exiting ? geometry.current?.rect : undefined;
  const style = exitRect
    ? { position: 'fixed', inset: 'auto', left: exitRect.left, top: exitRect.top, width: exitRect.width, height: exitRect.height, margin: 0, '--work-panel-width': `${exitRect.width}px` } as CSSProperties
    : maximized ? undefined : { width: renderedWidth, '--work-panel-width': `${renderedWidth}px` } as CSSProperties;
  return <aside ref={panel} className={cx('work-panel', maximized && 'is-maximized', maximized && 'omp-panel-maximized', exiting && 'is-exiting')} onAnimationEnd={event => { if (event.target instanceof HTMLElement && event.target.classList.contains('work-panel-main') && event.animationName === 'work-panel-out') onExitComplete?.(); }} style={style} data-testid="work-panel" data-resizing={previewWidth !== null ? 'true' : undefined}>
    <div className="work-panel-resize no-drag" role="separator" aria-orientation="vertical" aria-label={t('panel.resize')} aria-valuemin={bounds.minimum} aria-valuemax={bounds.maximum} aria-valuenow={Math.round(renderedWidth)} aria-disabled={maximized} tabIndex={0} onPointerDown={event => { if (maximized || event.button !== 0) return; event.preventDefault(); resize.current = { x: event.clientX, width: renderedWidth, current: renderedWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { const gesture = resize.current; if (!gesture) return; gesture.current = Math.max(bounds.minimum, Math.min(bounds.maximum, gesture.width + gesture.x - event.clientX)); setPreviewWidth(gesture.current); }} onPointerUp={event => { commitResize(true); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => commitResize(false)} onLostPointerCapture={() => commitResize(false)} onDoubleClick={() => { if (!maximized) onWidthChange(Math.min(bounds.maximum, Math.max(bounds.minimum, WORK_PANEL_DEFAULT_WIDTH))); }} onKeyDown={event => { if (event.key === 'Escape') { commitResize(false); return; } if (maximized) return; const step = event.shiftKey ? 32 : 16; const next = event.key === 'ArrowLeft' ? renderedWidth + step : event.key === 'ArrowRight' ? renderedWidth - step : event.key === 'Home' ? bounds.minimum : event.key === 'End' ? bounds.maximum : null; if (next !== null) { event.preventDefault(); onWidthChange(Math.max(bounds.minimum, Math.min(bounds.maximum, next))); } }} />
    <div className="work-panel-main">
    <nav className="work-panel-destinations" aria-label={t('panel.toolsAndPanels')}>{(['files', 'changes', 'tasks', 'session'] as const).map(kind => {
      const DestinationIcon = tabIcons[kind];
      const selected = activeDestination === kind;
      const count = kind === 'changes' ? fileChanges.size : kind === 'tasks' ? allAgents.filter(agent => subagentActive(agent, observedLive)).length : 0;
      const label = t(`omp.panel.${kind}`);
      const accessibleLabel = count > 0 ? `${label} · ${count}` : label;
      return <button key={kind} id={`work-panel-activity-${kind}`} type="button" aria-label={accessibleLabel} title={accessibleLabel} aria-pressed={selected} onClick={() => open({ kind })}><DestinationIcon size="var(--icon-meta)" /><span className="work-panel-destination-label" aria-hidden>{label}</span>{count > 0 && <span className="work-panel-activity-count" aria-hidden>{count > 99 ? '99+' : count}</span>}</button>;
    })}</nav>
    <header className="work-panel-header"><div className="work-panel-tab-strip-wrap no-drag" hidden={!documents.length}><div className="work-panel-tab-strip" role="tablist" aria-label={t('panel.tabsLabel')} onWheel={event => { if (event.currentTarget.scrollWidth > event.currentTarget.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY; }}>
      {documents.map(tab => { const TabIcon = tabIcons[tab.kind]; return <div key={tab.id} className={cx('work-panel-tab', active === tab.id && 'active', tab.preview && 'is-preview', dragging === tab.id && 'is-dragging', dropTarget === tab.id && 'is-drop-before')} data-kind={tab.kind} data-work-panel-tab-id={tab.id} onDragOver={event => { if (dragging) { event.preventDefault(); setDropTarget(tab.id); } }} onDrop={event => { event.preventDefault(); if (dragging) reorder(dragging, tab.id, event.clientX > event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2); setDragging(null); setDropTarget(null); }}>
        <button ref={node => { buttons.current[tab.id] = node; }} type="button" role="tab" id={`work-panel-tab-${tab.id}`} aria-selected={active === tab.id} aria-controls={`work-panel-surface-${tab.id}`} tabIndex={active === tab.id || !documents.some(item => item.id === active) && tab === documents[0] ? 0 : -1} className="work-panel-tab-button" draggable onDragStart={event => { event.dataTransfer.setData('text/plain', tab.id); setDragging(tab.id); }} onDragEnd={() => { setDragging(null); setDropTarget(null); }} title={tab.path ?? tabLabels[tab.id]} onClick={() => setActive(tab.id)} onDoubleClick={() => setTabs(old => old.map(item => item.id === tab.id ? { ...item, preview: false } : item))} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }} onKeyDown={event => tabKeyDown(event, tab.id)}><TabIcon size="var(--icon-meta)" /><span className="work-panel-tab-label">{tabLabels[tab.id]}</span></button><button type="button" className="work-panel-tab-close" aria-label={t('panel.closeTab', { name: tabLabels[tab.id] })} onClick={() => closeTab(tab.id)}><IconClose size="var(--icon-caption)" /></button>
      </div>; })}
    </div></div><div className="work-panel-actions no-drag">
      {documents.length > 0 && <AnchoredMenu open={menu === 'tabs'} onClose={() => setMenu(null)} role="menu" label={t('shell.allTabs')} menuClassName="work-panel-menu" align="end" trigger={ref => <button ref={ref} type="button" className="work-panel-new-tab" aria-label={t('shell.allTabs')} aria-haspopup="menu" aria-expanded={menu === 'tabs'} onClick={() => setMenu(menu === 'tabs' ? null : 'tabs')}>⌄</button>}>{documents.map(tab => <button type="button" role="menuitem" key={tab.id} title={tab.path ?? tabLabels[tab.id]} onClick={() => { setActive(tab.id); setMenu(null); }}><span className={tab.preview ? 'is-preview' : undefined}>{tabLabels[tab.id]}</span>{active === tab.id && <span aria-hidden>✓</span>}</button>)}</AnchoredMenu>}
      <AnchoredMenu open={menu === 'new'} onClose={() => setMenu(null)} role="menu" label={t('panel.new.open')} menuClassName="work-panel-menu" align="end" restoreFocus={false} trigger={ref => <button ref={ref} type="button" className="work-panel-new-tab" aria-label={t('panel.new.open')} aria-haspopup="menu" aria-expanded={menu === 'new'} onClick={() => setMenu(menu === 'new' ? null : 'new')}><IconPlus size="var(--icon-ui)" /></button>}>{(['shell.openFile', 'shell.quickOpen'] as const).map(label => <button type="button" role="menuitem" key={label} onClick={() => { open({ kind: 'files' }); requestAnimationFrame(() => panel.current?.querySelector<HTMLInputElement>('.work-panel-tabpane:not([hidden]) .file-tree input')?.focus()); }}><IconFolder size="var(--icon-meta)" />{t(label)}</button>)}</AnchoredMenu>
      <TooltipButton type="button" className="work-panel-maximize" tooltip={t(maximized ? 'panel.restore' : 'panel.maximize')} ariaLabel={t(maximized ? 'panel.restore' : 'panel.maximize')} aria-pressed={maximized} onClick={() => { if (panel.current) geometry.current = { maximized, rect: panel.current.getBoundingClientRect() }; setMaximized(value => !value); }}>{maximized ? <IconPanelRestore size="var(--icon-ui)" /> : <IconPanelMaximize size="var(--icon-ui)" />}</TooltipButton><TooltipButton type="button" className="work-panel-maximize" tooltip={t('omp.workspace.closePanel')} ariaLabel={t('omp.workspace.closePanel')} onClick={onClose}><IconClose size="var(--icon-meta)" /></TooltipButton></div></header>
    <div className={cx('work-panel-body', maximized && activeTab?.kind === 'subagent' && 'tasks-split')}>{tabs.map(tab => {
      const overview = maximized && activeTab?.kind === 'subagent' && tab.kind === 'tasks';
      const visible = (tab.id === active || overview) && !exiting;
      const agent = tab.savedSubagent ?? findSubagent(allAgents, tab.subagentId ?? '');
      const baseContext = resourceContext(agent);
      const context = tab.kind === 'resource' ? tab.context : resourceContexts[tab.id] ?? (baseContext?.kind === 'saved' ? { ...baseContext, ancestry: tab.savedAncestry } : baseContext);
      const tabObservedLive = observedLive && context?.kind === 'runtime' && context.runtimeId === runtimeId;
      const openResource = context ? (reference: string) => open({ kind: 'resource', context, reference, originTabId: tab.id, originTurnId: tab.originTurnId }, tab.scope) : undefined;
      const revealOrigin = (origin: ChangeOrigin) => {
        const entryId = origin.resultEntryId ?? origin.entryId;
        if (!origin.context || !entryId) return;
        const encoded = btoa(Array.from(new TextEncoder().encode(entryId), byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        open({ kind: 'resource', context: origin.context, reference: `desktop-entry:${encoded}`, originTabId: tab.id, originTurnId: tab.originTurnId }, tab.scope);
      };
      return <div key={tab.id} id={`work-panel-surface-${tab.id}`} className={cx('work-panel-tabpane', overview && 'task-overview-pane')} role="tabpanel" aria-labelledby={documents.includes(tab) ? `work-panel-tab-${tab.id}` : `work-panel-activity-${destinationOf(tab)}`} hidden={tab.id !== active && !overview}>
        {(tab.kind === 'resource' || tab.kind === 'changes') && (tab.originTabId || tab.originTurnId) && <button type="button" className="work-panel-return" onClick={() => back(tab)}>{t('omp.panel.back')}</button>}
        {tab.kind === 'file' || tab.kind === 'files' ? <FilesTab cwd={cwd} initialPath={tab.path} line={tab.line} endLine={tab.endLine} originTurnId={tab.originTurnId} initialPathRevision={tab.revision} visible={visible} onOpenFile={path => openFile(path, tab.scope, true)} onBack={() => back(tab)} maximized={maximized} changedFiles={fileChanges} referencedPaths={referencedPaths} onPinFile={path => openFile(path, tab.scope)} /> : tab.kind === 'changes' ? <ReviewTab key={`${tab.id}:${tab.revision ?? 0}`} cwd={cwd} path={tab.path} onOpenFile={path => openFile(path, tab.scope)} turnChanges={tab.turnChanges} turnChangeQuery={tab.turnChangeQuery} onRevealTool={tab.onRevealTool} onRevealOrigin={revealOrigin} referencedPaths={referencedPaths} /> : tab.kind === 'resource' ? <SavedResourcePanel resourceId={tab.id} context={context} reference={tab.reference} visible={visible} onName={(id, name) => { if (sourceScope.active && tab.scope.active) nameResource(id, name); }} onOpenSessionResource={openResource} /> : tab.kind === 'tasks' ? <div className="work-panel-agents"><TaskOverview agents={subagents} selectedAgentId={activeSubagentId ?? selectedAgentId} onOpenAgent={agent => openSubagent(agent.id, tab.scope)} visible={visible} observedLive={observedLive && !!runtimeId} /></div> : tab.kind === 'session' ? inspector ? <SessionInspector {...inspector} /> : <div className="work-tab-empty"><p>{t('omp.panel.sessionUnavailable')}</p></div> : <ScopedSubagentTranscript scope={tab.scope} ownerScope={sourceScope} cwd={cwd} runtimeId={runtimeId} parentHistoryFollowing={historyFollowing} observedLive={tabObservedLive && !tab.savedSubagent && !tab.savedAncestry?.length} parentSessionPath={parentSessionPath} historyLeafId={historyLeafId} savedAncestry={tab.savedAncestry} savedRecovery={tab.savedRecovery} subagentId={tab.subagentId ?? ''} subagent={agent} agents={allAgents} ancestors={ancestry(agent?.id ?? tab.subagentId ?? '') ?? []} visible={visible} onSavedNavigation={onSavedNavigation} onTitleChange={title => { if (sourceScope.active && tab.scope.active) nameSubagent(tab.id, tab.revision, title); }} onBack={() => back(tab)} onOpenChanges={request => open({ ...request, originTabId: tab.id, originTurnId: tab.originTurnId }, tab.scope)} onOpenSubagent={id => openSubagent(id, tab.scope)} onOpenSavedSubagent={(agent, ancestry) => openSavedSubagent(agent, ancestry, tab.scope)} onOpenFile={path => openFile(path, tab.scope)} onResourceContextChange={next => setResourceContexts(old => !sourceScope.active || !tab.scope.active || JSON.stringify(old[tab.id]) === JSON.stringify(next) ? old : { ...old, [tab.id]: next })} onOpenSessionResource={openResource} />}
      </div>;
    })}
    </div></div></aside>;
}

