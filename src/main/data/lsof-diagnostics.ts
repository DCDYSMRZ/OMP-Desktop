import { isAbsolute, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

/** Only a known diagnostic with a positively unrelated scope can be ignored. */
export function relevantLsofDiagnostics(stderr: string, target: string, candidateScan = false): boolean {
  const lines = stderr.trim().split('\n').filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    // Darwin lsof emits this pair when an unrelated mounted filesystem cannot be
    // statted. Its omitted files cannot match an exact target outside that mount.
    const mount = /^lsof: WARNING: can't stat\(\) \S+ file system (\/.*)$/.exec(lines[index]);
    if (mount && !candidateScan && lines[index + 1]?.trim() === 'Output information may be incomplete.') {
      let mountPath = resolve(mount[1]), targetPath = resolve(target);
      try { mountPath = realpathSync(mountPath); } catch { /* A missing unrelated mount still has a lexical scope. */ }
      try { targetPath = realpathSync(targetPath); } catch { /* The final removal snapshot separately binds existence. */ }
      const within = relative(mountPath, targetPath);
      if (within.startsWith('..') || isAbsolute(within)) {
        index++;
        // Observed on Darwin 25.6.0 / lsof 4.99: the warning pair can be
        // followed by `assuming "dev=100000e" from mount table`.
        if (/^\s+assuming "dev=[0-9a-fA-F]+" from mount table$/.test(lines[index + 1] ?? '')) index++;
        continue;
      }
    }
    return true;
  }
  return false;
}
