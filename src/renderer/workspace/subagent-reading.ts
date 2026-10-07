import type { ChildHistoryRead, HistoryMessage, SavedSubagentEdge, SessionResourceContext } from '../../shared/contracts';
import { reconcilePresentation, type ChatMessage } from '../chat/model';
import { readingAnchorAdjustment, type ReadingAnchor } from '../lib/transcript-reading-position';

export interface ChildReadingState {
  top: number; follow: boolean; before?: ChildHistoryRead; anchors?: (ReadingAnchor | { id: string; top: number; attribute?: undefined })[];
  context?: SessionResourceContext; childLeafId?: string | null; childRevision?: string;
}

/** A native latest leaf is source authority, not an instruction to read historical content. */
export function childTranscriptReadingKey(source: { runtimeId: string | null; parentSessionPath?: string; parentHistoryFollowing: boolean; historyLeafId?: string | null; savedAncestry?: SavedSubagentEdge[]; parentToolCallId?: string; nativeId?: string; subagentId: string; historical?: boolean }): string {
  const parentSelection = source.runtimeId && source.parentHistoryFollowing && !source.historical ? ['native-latest'] : ['parent-history', source.historyLeafId];
  return JSON.stringify([source.runtimeId, source.parentSessionPath, parentSelection, source.savedAncestry, source.parentToolCallId, source.nativeId ?? source.subagentId]);
}

export function childLiveOverlayAllowed(reading: { runtimeId: string | null; observedLive: boolean; parentHistoryFollowing: boolean; historical: boolean; historyMode: boolean; before?: ChildHistoryRead }): boolean {
  return !!reading.runtimeId && reading.observedLive && reading.parentHistoryFollowing && !reading.historical && !reading.historyMode && !reading.before;
}

/** Reuse the parent's native discriminators; projected content is never identity. */
export function reconcileChildMessages(messages: readonly HistoryMessage[], live: readonly ChatMessage[], sourceKey: string, latest: boolean, previous: readonly ChatMessage[] = []): ChatMessage[] {
  const saved: ChatMessage[] = messages.map(row => ({ ...row, source: 'history', streaming: false }));
  const ids = messages.map(row => row.id);
  const currentLive = latest ? live.filter(row => row.presentation?.sessionId === sourceKey) : [];
  const matched = reconcilePresentation(currentLive, saved, sourceKey, true, ids);
  const persisted = new Set(matched.flatMap(row => row.presentation ? [row.presentation.id] : []));
  const reconciled = reconcilePresentation(previous.filter(row => row.source === 'history'), matched, sourceKey, false, ids);
  return [...reconciled, ...currentLive.filter(row => !persisted.has(row.presentation?.id ?? row.id))];
}

/** Older pane snapshots contain only row IDs; prefer their visible fragment over the enclosing turn. */
export function childReadingAnchorAdjustment(saved: NonNullable<ChildReadingState['anchors']>, current: readonly ReadingAnchor[]): number | undefined {
  for (const anchor of saved) {
    if (anchor.attribute) {
      const adjustment = readingAnchorAdjustment([anchor], current);
      if (adjustment !== undefined) return adjustment;
      continue;
    }
    const match = current.find(candidate => candidate.attribute === 'data-presentation-key' && candidate.messageId === anchor.id)
      ?? current.find(candidate => candidate.attribute === 'data-message-id' && candidate.id === anchor.id)
      ?? current.find(candidate => candidate.attribute === 'data-minimap-id' && (candidate.id === anchor.id || candidate.messageId === anchor.id));
    if (match) return match.top - anchor.top;
  }
  return undefined;
}

/** Native travel changes the desired viewport offset, not the layout correction. */
export function rebaseChildReadingAnchors(reading: ChildReadingState, textAnchors: readonly { top: number }[], delta: number): void {
  for (const anchor of reading.anchors ?? []) anchor.top -= delta;
  for (const anchor of textAnchors) anchor.top -= delta;
}

