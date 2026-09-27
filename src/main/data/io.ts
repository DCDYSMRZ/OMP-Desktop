import { open } from 'node:fs/promises';

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Read exactly a bounded regular file; never accept devices or unbounded configuration. */
export async function readSmallFile(path: string, limit: number): Promise<string | undefined> {
  let file;
  try { file = await open(path, 'r'); } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    if (stat.size > limit) throw new Error(`File exceeds the ${limit}-byte limit: ${path}`);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error(`File exceeds the ${limit}-byte limit: ${path}`);
    return bytes.toString('utf8', 0, length);
  } finally { await file.close(); }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
