import { parseFileTarget } from '../lib/file-target';
import type { RecordedChangeStep } from '../../shared/contracts';

/** Display identity only, not authorization: macOS exposes these roots through /private. */
export function reviewRelativePath(cwd: string, target: string): string {
  const source = parseFileTarget(target).path.replaceAll('\\', '/').replace(/^\/private\/(?=(?:tmp|var|etc)(?:\/|$))/, '/');
  const segments: string[] = [];
  for (const segment of source.split('/')) {
    if (segment === '.') continue;
    if (segment === '..' && segments.length && segments.at(-1) !== '..' && segments.at(-1) !== '') segments.pop();
    else segments.push(segment);
  }
  const file = segments.join('/');
  const root = cwd.replaceAll('\\', '/').replace(/^\/private\/(?=(?:tmp|var|etc)(?:\/|$))/, '/').replace(/\/+$/, '');
  const prefix = root + '/';
  return root && file.startsWith(prefix) ? file.slice(prefix.length) : file.replace(/^\.\//, '');
}

export function recordedChangeLabel(step: RecordedChangeStep): string | undefined {
  if (step.operation === 'delete') return step.binary ? 'review.deletedBinary' : 'review.deleted';
  if (!step.countsKnown) return step.command ? 'review.commandChanged' : `review.unknown.${step.unknownReason ?? 'missingBefore'}`;
  return undefined;
}

