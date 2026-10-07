import type { RecordedFileChange, SessionResourceContext } from './contracts';

/** A locator inside an already authorized session/branch, never filesystem authority. */
export interface TurnChangeQuery { context: SessionResourceContext; anchorId: string; toolCallIds?: string[] }
export interface ChangeOrigin { sessionId: string; sourcePath?: string; entryId?: string; resultEntryId?: string; toolId: string; context?: SessionResourceContext; label?: string; parentToolCallId?: string }
/** Actual tool evidence; candidate command targets never prove a mutation by themselves. */
export interface FileChangeEvidence {
  id: string; path: string; sourcePath?: string; operation: 'read' | 'create' | 'update' | 'delete' | 'move';
  origin: ChangeOrigin; sequence: number; timestamp?: number; applied: 'confirmed' | 'candidate';
  before?: string; after?: string; patch?: string; patchComplete?: boolean; binary?: boolean; reason?: string;
}
/** An omitted endpoint means unknown; it never means the file did not exist. */
export interface ChangeFileEndpoint { exists: boolean; hash?: string; text?: string; binary?: boolean; mode?: number; size?: number }
export interface ChangeEndpointPair { path: string; before?: ChangeFileEndpoint; after?: ChangeFileEndpoint }
export interface CollectedTurnEvidence {
  id: string; sessionId: string; cwd: string; operations: FileChangeEvidence[]; toolCallIds: string[];
  sourcePath?: string; startEntryId?: string; startMessageId?: string; startMessageIds?: string[]; beforeEntryId?: string | null; exactInterval?: boolean;
  startedAt?: number; endedAt?: number; complete: boolean; reasons: string[]; pending: boolean;
}
export interface TurnChangeCoverage { snapshot: 'complete' | 'partial' | 'unavailable'; evidence: 'complete' | 'partial'; reasons: string[]; excluded: string[] }
export interface TurnChangeResult {
  id: string; revision: string; state: 'collecting' | 'complete' | 'partial'; files: RecordedFileChange[];
  coverage: TurnChangeCoverage; observedAt?: number;
}
export interface TurnChangeEvent { runtimeId?: string; sessionId?: string; sourcePath?: string }
