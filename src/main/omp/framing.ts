// Chunk ordering/base64 algorithm adapted from pi-desktop-master/src/main/pi-rpc-manager.ts.
// Copyright 2026 HighlandJewls, PikkonMG, FaqFirebase (Apache-2.0).
// Modified: byte-bounded JSONL, fatal UTF-8, negotiated-only chunks, strict EOF and native limits.
import type { NativeFrame } from '../../shared/contracts';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_LOGICAL_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFrame(bytes: Uint8Array): NativeFrame {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Native RPC emitted invalid UTF-8 or JSON'); }
  if (!record(value) || typeof value.type !== 'string' || value.type.length === 0) throw new Error('Native RPC frame must be an object with a type');
  return value as NativeFrame;
}

interface ChunkSequence { id: string; count: number; length: number; next: number; received: number; chunks: Buffer[] }

export class NativeFrameDecoder {
  private parts: Buffer[] = [];
  private lineBytes = 0;
  private sequence?: ChunkSequence;
  private version: 1 | 2 = 1;
  private frameLimit = MAX_FRAME_BYTES;
  private logicalLimit = MAX_LOGICAL_BYTES;

  configure(ready: NativeFrame): void {
    if (ready.protocolVersion !== 1 || !Array.isArray(ready.supportedProtocolVersions) || !ready.supportedProtocolVersions.includes(2)) throw new Error('Installed omp does not support native RPC protocol v2');
    const physical = ready.maxFrameBytes;
    const logical = ready.maxReassembledFrameBytes;
    if (typeof physical !== 'number' || !Number.isSafeInteger(physical) || physical < 2 || typeof logical !== 'number' || !Number.isSafeInteger(logical) || logical < physical) throw new Error('Invalid native RPC ready limits');
    this.frameLimit = Math.min(physical, MAX_FRAME_BYTES);
    this.logicalLimit = Math.min(logical, MAX_LOGICAL_BYTES);
  }

  enableV2(): void { this.version = 2; }

  push(data: Buffer, accept: (frame: NativeFrame) => void): void {
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(10, offset);
      const end = newline < 0 ? data.length : newline;
      const part = data.subarray(offset, end);
      this.lineBytes += part.length;
      if (this.lineBytes + 1 > this.frameLimit) throw new Error('Native RPC physical frame exceeded its byte limit');
      if (part.length) this.parts.push(part);
      if (newline < 0) return;
      if (this.lineBytes === 0) throw new Error('Native RPC emitted an empty frame');
      const bytes = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.lineBytes);
      this.parts = [];
      this.lineBytes = 0;
      const frame = this.decode(parseFrame(bytes));
      if (frame) accept(frame);
      offset = newline + 1;
    }
  }

  finish(): void {
    if (this.lineBytes || this.sequence) throw new Error('Native RPC ended with an incomplete frame');
  }

  reset(): void { this.parts = []; this.lineBytes = 0; this.sequence = undefined; }

  private decode(frame: NativeFrame): NativeFrame | undefined {
    if (frame.type !== 'rpc_chunk') {
      if (this.sequence) throw new Error('Native RPC chunk sequence was interrupted');
      return frame;
    }
    if (this.version !== 2) throw new Error('Native RPC sent chunks before v2 negotiation');
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== 'string' || !chunkId.length || chunkId.length > 128 || typeof index !== 'number' || !Number.isSafeInteger(index) || typeof count !== 'number' || !Number.isSafeInteger(count) || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || index < 0 || count < 2 || count > 256 || index >= count || byteLength < this.frameLimit || byteLength > this.logicalLimit || typeof data !== 'string' || !data.length || data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4) throw new Error('Invalid native RPC chunk metadata');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== data || bytes.length === 0) throw new Error('Invalid native RPC chunk base64 payload');
    if (!this.sequence) {
      if (index !== 0) throw new Error('Native RPC chunk sequence did not start at zero');
      this.sequence = { id: chunkId, count, length: byteLength, next: 0, received: 0, chunks: [] };
    }
    const sequence = this.sequence;
    if (sequence.id !== chunkId || sequence.count !== count || sequence.length !== byteLength || sequence.next !== index) throw new Error('Native RPC chunk sequence mismatch');
    sequence.chunks.push(bytes);
    sequence.received += bytes.length;
    sequence.next++;
    if (sequence.received > sequence.length) throw new Error('Native RPC chunks exceeded declared length');
    if (sequence.next < sequence.count) return undefined;
    if (sequence.received !== sequence.length) throw new Error('Native RPC chunk length mismatch');
    this.sequence = undefined;
    const result = parseFrame(Buffer.concat(sequence.chunks, sequence.length));
    if (result.type === 'rpc_chunk') throw new Error('Nested native RPC chunks are not supported');
    return result;
  }
}
