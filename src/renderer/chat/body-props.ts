/**
 * Callbacks every transcript body receives. `onOpenFile` accepts an optional
 * line selector suffix (`path:12`, `path:12-40`, `path:12+5`); the work panel
 * parses it with `parseFileTarget` and reveals the range.
 */
export type BodyProps = {
  cwd: string;
  onOpenFile: (path: string, originTurnId?: string) => void;
  onOpenSessionResource?: (reference: string, originTurnId?: string) => void;
};
