import type { StreamingTailRange } from './streaming-tail';

/** Only this bounded live tail has animation state; the settled prefix is plain text. */
export const REVEAL_DURATION = 220;
export const MAX_REVEAL_GLYPHS = 128;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type RevealGlyph = { offset: number; end: number; at: number };

export class StreamingReveal {
  source: string;
  released: number;
  readonly glyphs = new Map<number, RevealGlyph>();
  private streaming: boolean;
  private frameAt: number;
  private endedAt: number | undefined;
  private arrivals: { end: number; at: number }[] = [];
  private queue: { offset: number; end: number; arrivedAt: number }[] = [];
  private head = 0;
  private tailStart: number;

  constructor(source: string, streaming: boolean, now = performance.now()) {
    this.source = source;
    this.released = source.length;
    this.streaming = streaming;
    this.frameAt = now;
    this.tailStart = source.length;
  }

  update(source: string, streaming: boolean, instant: boolean, now = performance.now()) {
    const replacement = !source.startsWith(this.source);
    if (instant || replacement || (!this.streaming && (streaming || this.endedAt === undefined || source !== this.source))) {
      this.released = source.length;
      this.glyphs.clear();
      this.arrivals = [];
      this.queue = [];
      this.head = 0;
      this.tailStart = source.length;
      this.endedAt = undefined;
      this.frameAt = now;
    } else {
      if (source.length > this.source.length) {
        if (this.released === this.source.length) this.frameAt = now;
        this.arrivals.push({ end: source.length, at: now });
        // Re-segment the last cluster too: a transport chunk may extend it
        // with a combining mark, ZWJ sequence, or the low half of a surrogate.
        const start = this.tailStart;
        this.queue = this.queue.slice(this.head).filter(glyph => glyph.offset < start);
        this.head = 0;
        let range = 0;
        for (const part of segmenter.segment(source.slice(start))) {
          const offset = start + part.index;
          const end = offset + part.segment.length;
          this.tailStart = offset;
          while (range < this.arrivals.length - 1 && this.arrivals[range].end <= offset) range++;
          if (end <= this.released) continue;
          if (offset < this.released) {
            // An already painted cluster is extended atomically, without
            // restarting its fade or exposing a detached combining mark.
            this.released = end;
            const glyph = this.glyphs.get(offset);
            if (glyph) glyph.end = end;
          } else {
            this.queue.push({ offset, end, arrivedAt: this.arrivals[range].at });
          }
        }
        // Retain the tail's arrival even when it has already been painted.
        while (this.arrivals.length > 1 && this.arrivals[0].end <= this.tailStart) this.arrivals.shift();
      }
      if (this.streaming && !streaming) this.endedAt = now;
    }
    this.source = source;
    this.streaming = streaming;
  }

  tick(now: number): boolean {
    let changed = false;
    for (const [offset, glyph] of this.glyphs) {
      if (now >= glyph.at + REVEAL_DURATION) { this.glyphs.delete(offset); changed = true; }
    }
    const dt = Math.max(0, now - this.frameAt);
    this.frameAt = now;
    const backlog = this.queue.length - this.head;
    if (!backlog) return changed;
    const draining = this.endedAt !== undefined;
    const count = draining && now >= this.endedAt! + 120
      ? backlog
      : Math.max(1, Math.ceil(backlog * (1 - Math.exp(-dt / (draining ? 30 : 60)))));
    const start = this.released;
    const stop = this.head + count;
    while (this.head < this.queue.length) {
      const glyph = this.queue[this.head];
      if (this.head >= stop && now - glyph.arrivedAt < 250) break;
      if (glyph.end === this.source.length && /[\uD800-\uDBFF]$/.test(this.source)) break;
      this.glyphs.set(glyph.offset, { offset: glyph.offset, end: glyph.end, at: now });
      this.released = glyph.end;
      this.head++;
    }
    while (this.glyphs.size > MAX_REVEAL_GLYPHS) this.glyphs.delete(this.glyphs.keys().next().value!);
    return changed || this.released !== start;
  }

  get pending() { return this.released < this.source.length || this.glyphs.size > 0; }
  get text() { return this.source.slice(0, this.released); }
}

export type RevealPiece = { text: string; offset: number; at?: number };

/** Map rendered text back to parser source offsets (Markdown escapes/entities
 * consume more source units than their rendered character). Entities themselves
 * settle immediately; subsequent literal glyphs retain their exact identity. */
export function revealPieces(text: string, raw: string, offset: number, reveal: StreamingReveal | undefined, now: number, hidden: readonly StreamingTailRange[] = []): RevealPiece[] {
  const first = reveal?.glyphs.keys().next().value;
  if (!hidden.length && (first === undefined || offset + raw.length <= first)) return [{ text, offset }];
  const pieces: RevealPiece[] = [];
  let cursor = 0;
  let plain = '';
  let plainOffset = offset;
  let hiddenIndex = 0;
  for (const part of segmenter.segment(text)) {
    const glyph = part.segment;
    const entity = raw[cursor] === '&' ? /^&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/i.exec(raw.slice(cursor))?.[0] : undefined;
    if (raw[cursor] === '\\' && raw.slice(cursor + 1, cursor + 1 + glyph.length) === glyph) cursor++;
    const sourceOffset = offset + cursor;
    const exact = raw.slice(cursor, cursor + glyph.length) === glyph;
    while (hiddenIndex < hidden.length && hidden[hiddenIndex].end <= sourceOffset) hiddenIndex++;
    if (hidden[hiddenIndex] && hidden[hiddenIndex].start <= sourceOffset) { cursor += entity ? entity.length : glyph.length; continue; }
    const live = exact && !entity ? reveal?.glyphs.get(sourceOffset) : undefined;
    if (live && now < live.at + REVEAL_DURATION) {
      if (plain) { pieces.push({ text: plain, offset: plainOffset }); plain = ''; }
      pieces.push({ text: glyph, offset: sourceOffset, at: live.at });
    } else {
      if (!plain) plainOffset = sourceOffset;
      plain += glyph;
    }
    cursor += entity ? entity.length : glyph.length;
  }
  if (plain) pieces.push({ text: plain, offset: plainOffset });
  return pieces;
}
