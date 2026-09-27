export type ReadingAnchor = {
  id: string;
  attribute: 'data-presentation-key' | 'data-message-id' | 'data-minimap-id';
  top: number;
  messageId?: string;
  turnId?: string;
};

export type TranscriptReadingPosition = {
  scrollTop: number;
  following: boolean;
  anchors: ReadingAnchor[];
};

// Session panes unmount on navigation; retain only small geometry snapshots.
const positions = new Map<string, TranscriptReadingPosition>();
const MAX_READING_POSITIONS = 64;

export function recallReadingPosition(key: string): TranscriptReadingPosition | undefined {
  const position = positions.get(key);
  if (position) {
    positions.delete(key);
    positions.set(key, position);
  }
  return position;
}

export function rememberReadingPosition(key: string, position: TranscriptReadingPosition): void {
  positions.delete(key);
  positions.set(key, position);
  if (positions.size > MAX_READING_POSITIONS) positions.delete(positions.keys().next().value!);
}

/** Rebuild both the visible fragment's row and its enclosing turn before layout. */
export function readingAnchorMessageIds(position: TranscriptReadingPosition | undefined): string[] {
  if (!position || position.following) return [];
  return [...new Set(position.anchors.flatMap(anchor => [anchor.messageId, anchor.turnId, anchor.attribute !== 'data-presentation-key' ? anchor.id : undefined]).filter((id): id is string => Boolean(id)))];
}

/** One canonical identity per element: a turn and its final row can share a journal ID. */
export function createReadingAnchor(identity: { presentationKey?: string; messageId?: string; minimapId?: string; turnId?: string }, top: number): ReadingAnchor | undefined {
  const id = identity.presentationKey || identity.minimapId || identity.messageId;
  if (!id) return undefined;
  const attribute = identity.presentationKey ? 'data-presentation-key' : identity.minimapId ? 'data-minimap-id' : 'data-message-id';
  return { id, attribute, top, messageId: identity.messageId, turnId: identity.turnId };
}

/** The saved offset must resolve against the same element, never another row-ID alias. */
export function readingAnchorAdjustment(saved: readonly ReadingAnchor[], current: readonly ReadingAnchor[]): number | undefined {
  for (const anchor of saved) {
    const match = current.find(candidate => candidate.attribute === anchor.attribute && candidate.id === anchor.id);
    if (match) return match.top - anchor.top;
  }
  return undefined;
}
