import type { NativeSubagent } from '../../shared/contracts';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { record, text } from './model';

const MAX_IMAGE_BASE64 = Math.ceil(10 * 1024 * 1024 / 3) * 4;
const mimePattern = /^image\/(png|jpeg|gif|webp|avif)$/;

export function isVisibleImage(value: unknown): boolean {
  const block = record(value);
  return ['image', 'image_generation_call', 'image_url', 'input_image'].includes(text(block.type)) || (!block.type && typeof block.mimeType === 'string' && 'data' in block);
}

/** Only explicit visible carriers are interpreted; provider replay is never traversed. */
export function visibleImage(value: unknown): { dataUrl?: string; reason?: string; deferred?: boolean } | undefined {
  const block = record(value);
  let data: string;
  let mime = text(block.mimeType);
  if (block.type === 'image') data = text(block.data);
  else if (block.type === 'image_generation_call') { data = text(block.result); mime ||= 'image/png'; }
  else if (block.type === 'image_url' || block.type === 'input_image') data = text(block.image_url) || text(record(block.image_url).url);
  else if (!block.type && mime && 'data' in block) data = text(block.data);
  else return undefined;
  if (text(block.unavailableReason)) return { reason: text(block.unavailableReason) };
  if (block.deferred === true && text(block.resourceReference)) return { deferred: true };
  if (!data) return { reason: text(block.unavailableReason) || 'Image data is missing.' };
  if (data.startsWith('blob:')) return { reason: 'Image source is unavailable or exceeds the inline image limit. Open the saved source for details.' };
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',');
    const header = data.slice(0, comma);
    if (!/^data:image\/(png|jpeg|gif|webp|avif);base64$/.test(header)) return { reason: 'Unsupported image data URL.' };
    mime = header.slice(5, -7);
    data = data.slice(comma + 1);
  }
  if (data.length > MAX_IMAGE_BASE64) return { reason: 'Image exceeds the 10 MiB inline limit. Open the saved source for details.' };
  if (!mimePattern.test(mime) || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return { reason: 'Image data is unavailable or invalid.' };
  return { dataUrl: `data:${mime};base64,${data}` };
}

/** Keep archive blocks ordered; images is the legacy fallback, not a second copy. */
export function compactionBlocks(raw: Record<string, unknown>): unknown[] {
  if (Array.isArray(raw.blocks) && raw.blocks.length) return raw.blocks;
  return Array.isArray(raw.images) ? raw.images : [];
}

/** Clean each line before flattening so headings and list markers never leak into the row. */
export function compactionPreview(shortSummary: string, summary: string): string {
  return (shortSummary.trim() || summary).split(/\r?\n/).map(plainMarkdownLine).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function sessionResourceReferences(source: string): string[] {
  // Native shake placeholders append a whitespace-separated region selector; it is part of the recovery identity.
  const matches = source.matchAll(/(?:artifact|agent):\/\/[^\s<>"'`()\[\]]+(?:\s*\(region \d+\))?/g);
  return [...new Set(Array.from(matches, ([value]) => /\(region \d+\)$/.test(value) ? value : value.replace(/[),.;]+$/, '')))];
}

/** Keep human markdown literal while offering its explicit file targets separately. */
export function literalFileReferences(source: string): string[] {
  const references = new Set<string>();
  for (const match of source.matchAll(/\[[^\]\r\n]*\]\(([^\s()]+)(?:\s+"[^"]*")?\)/g)) {
    const path = match[1]!;
    if (!path.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(path)) references.add(path);
  }
  return [...references];
}

const sourceInformation: Record<string, true> = {
  'Default view follows the last persisted entry, not a verified active native leaf.': true,
  'Archive is read-only. Explicit fork stages a bounded private source and artifact snapshot before native creation.': true,
  'Raw persisted source detail, not a reconstructed message; may include native replay metadata. No blob payloads are hydrated.': true,
};

/** Only known source context belongs in a disclosure; unknown diagnostics remain visible. */
export function partitionSourceDiagnostics(diagnostics: readonly string[]): { information: string[]; material: string[] } {
  const information: string[] = [];
  const material: string[] = [];
  for (const message of new Set(diagnostics)) (Object.hasOwn(sourceInformation, message) ? information : material).push(message);
  return { information, material };
}

/** Delivery IDs identify only children already authorized by the selected parent. */
export function nativeTaskChild(agents: readonly NativeSubagent[], id: string): NativeSubagent | undefined {
  let match: NativeSubagent | undefined;
  for (const agent of agents) {
    if ((agent.nativeId ?? (agent.historical ? undefined : agent.id)) !== id) continue;
    if (match) return undefined;
    match = agent;
  }
  return match;
}
