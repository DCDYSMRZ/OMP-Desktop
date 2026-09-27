import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeFrame } from '../../shared/contracts';
import { MAX_FRAME_BYTES, MAX_LOGICAL_BYTES, NativeFrameDecoder } from './framing';

const ready: NativeFrame = { type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: MAX_FRAME_BYTES, maxReassembledFrameBytes: MAX_LOGICAL_BYTES };
const encode = (frame: NativeFrame): Buffer => Buffer.from(`${JSON.stringify(frame)}\n`);

function chunks(frame: NativeFrame): Buffer[] {
  const bytes = Buffer.from(JSON.stringify(frame));
  const size = 256 * 1024;
  const count = Math.ceil(bytes.length / size);
  return Array.from({ length: count }, (_, index) => encode({ type: 'rpc_chunk', chunkId: 'chunk-1', index, count, byteLength: bytes.length, data: bytes.subarray(index * size, (index + 1) * size).toString('base64') }));
}

test('split UTF-8 and CRLF preserve the original native frame', () => {
  const decoder = new NativeFrameDecoder();
  const frame = { type: 'notice', message: '世界🙂' };
  const result: NativeFrame[] = [];
  const bytes = Buffer.from(`${JSON.stringify(frame)}\r\n`);
  for (const byte of bytes) decoder.push(Buffer.from([byte]), value => result.push(value));
  decoder.finish();
  assert.deepEqual(result, [frame]);
});

test('physical byte limits and malformed UTF-8 fail before JSON can be trusted', () => {
  const decoder = new NativeFrameDecoder();
  assert.throws(() => decoder.push(Buffer.alloc(MAX_FRAME_BYTES, 32), () => {}), /byte limit/);
  const invalid = Buffer.concat([Buffer.from('{"type":"notice","message":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]);
  assert.throws(() => new NativeFrameDecoder().push(invalid, () => {}), /UTF-8/);
});

test('negotiation takes effect between frames in one stdout callback', () => {
  const decoder = new NativeFrameDecoder();
  decoder.configure(ready);
  const large: NativeFrame = { type: 'notice', message: '🙂'.repeat(300000) };
  const response: NativeFrame = { type: 'response', id: 'init', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } };
  const result: NativeFrame[] = [];
  decoder.push(Buffer.concat([encode(response), ...chunks(large)]), frame => {
    if (frame.type === 'response') decoder.enableV2();
    else result.push(frame);
  });
  decoder.finish();
  assert.deepEqual(result, [large]);
});

test('chunks require negotiation, stable ordering and exact declared byte count', () => {
  const frames = chunks({ type: 'notice', message: 'a'.repeat(MAX_FRAME_BYTES) });
  assert.throws(() => new NativeFrameDecoder().push(frames[0]!, () => {}), /before v2/);
  const decoder = new NativeFrameDecoder();
  decoder.configure(ready);
  decoder.enableV2();
  decoder.push(frames[0]!, () => {});
  assert.throws(() => decoder.push(frames[2]!, () => {}), /sequence mismatch/);
  const interrupted = new NativeFrameDecoder();
  interrupted.enableV2();
  interrupted.push(frames[0]!, () => {});
  assert.throws(() => interrupted.push(encode({ type: 'notice' }), () => {}), /interrupted/);
  const mismatch = new NativeFrameDecoder();
  mismatch.enableV2();
  const changed = frames.map(bytes => { const value = JSON.parse(bytes.toString()); value.byteLength++; return encode(value); });
  assert.throws(() => mismatch.push(Buffer.concat(changed), () => {}), /length mismatch/);
});

test('EOF never accepts partial JSONL or an unfinished logical frame', () => {
  const partial = new NativeFrameDecoder();
  partial.push(Buffer.from('{"type":"notice"}'), () => {});
  assert.throws(() => partial.finish(), /incomplete frame/);
  const decoder = new NativeFrameDecoder();
  decoder.enableV2();
  decoder.push(chunks({ type: 'notice', message: 'x'.repeat(MAX_FRAME_BYTES) })[0]!, () => {});
  assert.throws(() => decoder.finish(), /incomplete frame/);
});

test('noncanonical base64 and non-object logical frames are rejected', () => {
  const decoder = new NativeFrameDecoder();
  decoder.enableV2();
  const frame = JSON.parse(chunks({ type: 'notice', message: 'x'.repeat(MAX_FRAME_BYTES) })[0]!.toString());
  frame.data = `${frame.data.slice(0, -1)}!`;
  assert.throws(() => decoder.push(encode(frame), () => {}), /base64/);
  assert.throws(() => new NativeFrameDecoder().push(Buffer.from('[]\n'), () => {}), /object/);
});
