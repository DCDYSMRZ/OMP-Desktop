import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { ChangeNetAccumulator, normalizeToolEvidence, resolveFinalChanges, withRecoveredEndpointText } from './change-net';
import type { ChangeEndpointPair, FileChangeEvidence } from './turn-change-types';

const operation = (id: string, values: Partial<FileChangeEvidence> = {}): FileChangeEvidence => ({ id, path: '/work/file.txt', operation: 'update', origin: { sessionId: 'parent', toolId: id }, sequence: Number(id) || 0, applied: 'confirmed', ...values });
const edit = (id: string, patch: string) => operation(id, { patch, patchComplete: true });

test('full-content edits produce the final net script and proven reversals disappear', () => {
  const first = operation('1', { before: 'one\ntwo\n', after: 'one\nthree\n' });
  const second = operation('2', { before: 'one\nthree\n', after: 'one\nfour\n' });
  const [file] = resolveFinalChanges([first, second], [], '/work');
  assert.deepEqual([file.path, file.added, file.removed, file.countsKnown], ['file.txt', 1, 1, true]);
  assert.match(file.patch, /-two\n\+four/);
  assert.doesNotMatch(file.patch, /three/);
  assert.equal(file.steps.length, 2);
  assert.deepEqual(resolveFinalChanges([first, operation('2', { before: first.after, after: first.before })]), []);
  assert.deepEqual(resolveFinalChanges([operation('1', { operation: 'create', after: 'new\n' }), operation('2', { operation: 'delete' })]), []);
});

test('sparse patch chains cancel intermediate churn without allocating untouched gaps', () => {
  const first = edit('1', '@@ -900000000,1 +900000000,1 @@\n-old\n+middle');
  const second = edit('2', '@@ -900000000,1 +900000000,1 @@\n-middle\n+final');
  const [file] = resolveFinalChanges([first, second]);
  assert.deepEqual([file.added, file.removed, file.countsKnown], [1, 1, true]);
  assert.match(file.patch, /@@ -900000000,1 \+900000000,1 @@\n-old\n\+final/);
  assert.deepEqual(resolveFinalChanges([first, edit('2', '@@ -900000000,1 +900000000,1 @@\n-middle\n+old')]), []);
  const insert = edit('1', '@@ -3,0 +4,1 @@\n+temporary');
  assert.deepEqual(resolveFinalChanges([insert, edit('2', '@@ -4,1 +3,0 @@\n-temporary')]), []);
});

test('hash endpoints dominate tool churn and preserve unrenderable observed changes', () => {
  const churn = operation('1', { before: 'old\n', after: 'new\n' });
  assert.deepEqual(resolveFinalChanges([churn], [{ path: churn.path, before: { exists: true, hash: 'same' }, after: { exists: true, hash: 'same' } }]), []);
  const [hashOnly] = resolveFinalChanges([], [{ path: churn.path, before: { exists: true, hash: 'old' }, after: { exists: true, hash: 'new' } }]);
  assert.deepEqual([hashOnly.op, hashOnly.countsKnown, hashOnly.evidence, hashOnly.content], ['update', false, 'snapshot', 'unavailable']);
  const [partial] = resolveFinalChanges([churn], [{ path: churn.path, before: { exists: true, hash: 'old' }, after: { exists: true, text: 'new\n', hash: 'new' } }]);
  assert.equal(partial.countsKnown, false);
  assert.equal(partial.steps[0].origin?.toolId, '1');
  const [mode] = resolveFinalChanges([], [{ path: churn.path, before: { exists: true, hash: 'same', mode: 420 }, after: { exists: true, hash: 'same', mode: 493 } }]);
  assert.equal(mode.op, 'update');
});

test('unknown writes are updates with unknown net counts, not creations', () => {
  const evidence = normalizeToolEvidence({ source: { sessionId: 'parent', cwd: '/work' }, toolId: 'write', name: 'write', args: { path: './file.txt', content: 'replacement\n' }, result: { details: {} }, status: 'complete', sequence: 1 });
  const [file] = resolveFinalChanges(evidence);
  assert.deepEqual([file.op, file.countsKnown, file.patch], ['update', false, '']);
  assert.deepEqual(resolveFinalChanges([operation('candidate', { applied: 'candidate' })]), []);
});

test('partial successes preserve explicit resolved paths and child identities', () => {
  const input = { source: { sessionId: 'child-one', cwd: '/work/nested', sourcePath: '/sessions/one' }, toolId: 'same-call', entryId: 'call-entry', resultEntryId: 'result-entry', name: 'edit', args: { path: 'wrong.txt' }, result: { isError: true, details: { perFileResults: [{ path: '../file.txt', oldText: 'old\n', newText: 'new\n' }, { path: 'failed.txt', isError: true }] } }, status: 'error', sequence: 1 };
  const first = normalizeToolEvidence(input);
  const second = normalizeToolEvidence({ ...input, source: { ...input.source, sessionId: 'child-two', sourcePath: '/sessions/two' } });
  assert.equal(first[0].path, '/work/file.txt');
  assert.equal(first.length, 1);
  assert.notEqual(first[0].id, second[0].id);
  const [file] = resolveFinalChanges([...first, ...second]);
  assert.deepEqual(file.steps.map(step => step.origin?.sessionId), ['child-one', 'child-two']);
  assert.equal(file.countsKnown, false);
  assert.equal(file.reason, 'conflictingEvidence');
});

test('result prose and requested patch or shell targets never establish applied file outcomes', () => {
  const base = { source: { sessionId: 's', cwd: '/work' }, toolId: 'tool', status: 'complete', sequence: 1 };
  assert.deepEqual(normalizeToolEvidence({ ...base, name: 'bash', args: { command: 'rm file.txt' }, result: { content: 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new' } }), []);
  assert.deepEqual(normalizeToolEvidence({ ...base, name: 'apply_patch', args: { input: '*** Add File: invented.txt\n+text' }, result: { content: 'No changes' } }), []);
  assert.deepEqual(normalizeToolEvidence({ ...base, name: 'task', result: { details: { files: [{ path: '/work/report.txt', op: 'create' }] } } }), []);
});

test('conflicting context, truncated patches and cross-source order stay unknown', () => {
  const first = edit('1', '@@ -1,2 +1,2 @@\n context\n-old\n+new');
  const conflict = edit('2', '@@ -1,2 +1,2 @@\n different\n-new\n+last');
  assert.equal(resolveFinalChanges([first, conflict])[0].countsKnown, false);
  assert.equal(resolveFinalChanges([operation('1', { before: 'actual\n', patch: '@@ -1,1 +1,1 @@\n-wrong\n+next', patchComplete: true })])[0].countsKnown, false);
  assert.equal(resolveFinalChanges([edit('1', '@@ -1,200000 +1,1 @@\n-old\n+next')])[0].countsKnown, false);
  assert.equal(resolveFinalChanges([operation('1', { patch: first.patch, patchComplete: false })])[0].countsKnown, false);
});

test('EOF-newline changes survive and complete patch application validates byte continuity', () => {
  const patch = '@@ -1,1 +1,1 @@\n-value\n+value\n\\ No newline at end of file';
  const [file] = resolveFinalChanges([operation('1', { before: 'value\n', patch, patchComplete: true })]);
  assert.equal(file.countsKnown, true);
  assert.deepEqual([file.added, file.removed], [1, 1]);
  assert.match(file.patch, /No newline at end of file/);
  assert.deepEqual(resolveFinalChanges([operation('1', { before: 'value\n', patch, patchComplete: true }), operation('2', { before: 'value', after: 'value\n' })]), []);
});

test('native write requests never substitute for transformed or unreported output bytes', () => {
  const first = operation('1', { before: 'const n = 0;\n', after: 'const n = 1;\n' });
  const input = { source: { sessionId: 'parent', cwd: '/work' }, toolId: 'write', name: 'write', args: { path: 'file.txt', content: 'const n=2\n' }, result: { details: { resolvedPath: '/work/file.txt' } }, status: 'complete', sequence: 2 };
  const writes = normalizeToolEvidence(input);
  const [unknown] = resolveFinalChanges([first, ...writes]);
  assert.deepEqual([unknown.path, unknown.op, unknown.countsKnown, unknown.patch], ['/work/file.txt', 'update', false, '']);
  assert.deepEqual(unknown.steps.map(step => step.toolId), ['1', 'write']);
  const actual = 'const n = 2;\n';
  const [captured] = resolveFinalChanges([first, ...writes], [{ path: first.path, before: { exists: true, text: first.before }, after: { exists: true, text: actual } }]);
  assert.equal(captured.countsKnown, true);
  assert.match(captured.patch, /\+const n = 2;/);
  assert.doesNotMatch(captured.patch, /\+const n=2/);
  const [reported] = resolveFinalChanges([first, ...normalizeToolEvidence({ ...input, result: { details: { resolvedPath: first.path, newText: actual } } })]);
  assert.equal(reported.patch, captured.patch);
});

test('literal snapshot and resolved names never collide with selector-like suffixes', () => {
  const names = ['report:1', 'report:raw', 'report#L1'];
  const endpoints = names.map(name => ({ path: `/work/${name}`, before: { exists: true, text: 'old\n', hash: 'old' }, after: { exists: true, text: `${name}\n`, hash: name } }));
  endpoints.push({ path: '/work/report', before: { exists: true, text: 'unchanged\n', hash: 'same' }, after: { exists: true, text: 'unchanged\n', hash: 'same' } });
  assert.deepEqual(resolveFinalChanges([], endpoints, '/work').map(file => file.path), names);
  const source = { sessionId: 'parent', cwd: '/work' };
  const writes = names.flatMap((name, sequence) => normalizeToolEvidence({ source, toolId: name, name: 'write', args: { path: 'report', content: 'request' }, result: { details: { resolvedPath: `/work/${name}`, oldText: 'old\n', newText: `${name}\n` } }, status: 'complete', sequence }));
  assert.deepEqual(resolveFinalChanges(writes, [], '/work').map(file => file.path), names);
  const read = { source, toolId: 'read', name: 'read', args: { path: 'report:1' }, result: { details: { totalLines: 1, displayContent: { text: 'old\n', startLine: 1 } } }, status: 'complete', sequence: 0 };
  assert.equal(normalizeToolEvidence(read)[0].path, '/work/report');
  assert.equal(normalizeToolEvidence({ ...read, result: { details: { resolvedPath: '/work/report:1' } } })[0].path, '/work/report:1');
});

test('full read displays cannot invent EOF or BOM endpoints before actual edits', () => {
  const read = normalizeToolEvidence({ source: { sessionId: 'parent', cwd: '/work' }, toolId: 'read', name: 'read', args: { path: 'file.txt' }, result: { details: { totalLines: 1, fileSize: 8, displayContent: { text: 'same', startLine: 1 } } }, status: 'complete', sequence: 0 });
  const bytes = '\ufeffsame\n';
  const [unknown] = resolveFinalChanges([...read, operation('1', { after: bytes })]);
  assert.equal(unknown.countsKnown, false);
  assert.equal(unknown.patch, '');
  const actualEdit = operation('1', { before: bytes, after: 'different\n' });
  const [actual] = resolveFinalChanges([...read, actualEdit]);
  assert.equal(actual.countsKnown, true);
  assert.match(actual.patch, /-\ufeffsame/);
  assert.deepEqual(resolveFinalChanges([...read, actualEdit, operation('2', { before: 'different\n', after: bytes })]), []);
  const [sparse] = resolveFinalChanges([...read, edit('1', '@@ -1,1 +1,1 @@\n-same\n+different')]);
  assert.deepEqual([sparse.countsKnown, sparse.added, sparse.removed], [true, 1, 1]);
});

test('hash-only captures recover exact final counts from matching native endpoint bytes', () => {
  const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
  const before = 'const value = 1;\n', after = 'const value = 2;\n';
  const evidence = normalizeToolEvidence({ source: { sessionId: 'child', cwd: '/work', parentToolCallId: 'task' }, toolId: 'edit', name: 'edit', args: { path: 'file.txt' }, result: { details: { oldText: before, newText: after } }, status: 'complete', sequence: 1 });
  const endpoints: ChangeEndpointPair[] = [{ path: '/work/file.txt', before: { exists: true, hash: hashText(before) }, after: { exists: true, hash: hashText(after) } }];
  const original = structuredClone(endpoints);
  const recovered = withRecoveredEndpointText(evidence, endpoints, hashText);
  const [file] = resolveFinalChanges(evidence, recovered);
  assert.deepEqual([file.countsKnown, file.added, file.removed, file.evidence], [true, 1, 1, 'snapshot']);
  assert.match(file.patch, /-const value = 1;/);
  assert.match(file.patch, /\+const value = 2;/);
  assert.equal(file.steps[0].origin?.sessionId, 'child');
  assert.deepEqual(endpoints, original);
  const mismatching = evidence.map(item => ({ ...item, before: 'wrong before\n', after: 'wrong after\n' }));
  const unmatched = withRecoveredEndpointText(mismatching, endpoints, hashText);
  assert.deepEqual(unmatched, original);
  assert.equal(resolveFinalChanges(mismatching, unmatched)[0].countsKnown, false);
});

test('endpoint recovery preserves binary, missing and already retained observations', () => {
  const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
  const text = 'native bytes\n', hash = hashText(text);
  const endpoints: ChangeEndpointPair[] = [
    { path: '/work/binary', before: { exists: true, binary: true, hash }, after: { exists: true, hash } },
    { path: '/work/missing', after: { exists: false, hash } },
    { path: '/work/retained', before: { exists: true, hash, text: 'retained bytes' } },
    { path: '/work/candidate', before: { exists: true, hash } },
  ];
  const operations = [
    operation('1', { path: '/work/binary', before: text, after: text, binary: true }),
    operation('2', { path: '/work/missing', before: text, after: text }),
    operation('3', { path: '/work/retained', before: text, after: text }),
    operation('4', { path: '/work/candidate', before: text, after: text, applied: 'candidate' }),
  ];
  assert.deepEqual(withRecoveredEndpointText(operations, endpoints, hashText), endpoints);
});

test('hash recovery respects captured creation and deletion without requested write bytes', () => {
  const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
  const actual = 'actual native bytes\n';
  const source = { sessionId: 'parent', cwd: '/work' };
  const created = normalizeToolEvidence({ source, toolId: 'create', name: 'write', args: { path: 'created', content: 'different requested bytes\n' }, result: { details: { op: 'create', newText: actual } }, status: 'complete', sequence: 1 });
  const deleted = normalizeToolEvidence({ source, toolId: 'delete', name: 'delete', args: { path: 'deleted' }, result: { details: { oldText: actual } }, status: 'complete', sequence: 2 });
  const endpoints: ChangeEndpointPair[] = [
    { path: '/work/created', before: { exists: false }, after: { exists: true, hash: hashText(actual) } },
    { path: '/work/deleted', before: { exists: true, hash: hashText(actual) }, after: { exists: false } },
  ];
  const evidence = [...created, ...deleted];
  const recovered = withRecoveredEndpointText(evidence, endpoints, hashText);
  const files = resolveFinalChanges(evidence, recovered, '/work');
  assert.deepEqual(files.map(file => [file.path, file.op, file.countsKnown, file.added, file.removed]), [['created', 'create', true, 1, 0], ['deleted', 'delete', true, 0, 1]]);
  assert.match(files[0].patch, /\+actual native bytes/);
  assert.doesNotMatch(files[0].patch, /requested/);
  assert.deepEqual(recovered[0].before, { exists: false });
  assert.deepEqual(recovered[1].after, { exists: false });
});

test('streamed full-content history exceeds count and aggregate byte limits without losing net or reversals', () => {
  const accumulator = new ChangeNetAccumulator({ cwd: '/work', maxProcessSteps: 2 });
  const prefix = 'x'.repeat(2048), baseline = `${prefix}baseline\n`;
  let current = baseline;
  for (let i = 1; i <= 20_001; i++) {
    const next = `${prefix}${i}\n`;
    accumulator.push(operation(String(i), { before: current, after: next }));
    current = next;
  }
  const [file] = accumulator.finish();
  const [direct] = resolveFinalChanges([operation('1', { before: baseline, after: current })], [], '/work');
  assert.deepEqual([file.path, file.patch, file.added, file.removed, file.countsKnown, file.content], [direct.path, direct.patch, 1, 1, true, 'complete']);
  assert.equal(file.processTruncated, true);
  assert.deepEqual(file.steps.map(step => step.toolId), ['1', '2']);
  accumulator.push(operation('20002', { before: current, after: baseline }));
  assert.deepEqual(accumulator.finish(), []);
});

test('sparse long chains bound work per update rather than across history', () => {
  const accumulator = new ChangeNetAccumulator({ maxProcessSteps: 0 });
  const lines = (version: number) => Array.from({ length: 100 }, (_, line) => `${version}:${line}`);
  const patch = (before: number, after: number) => `@@ -900000000,100 +900000000,100 @@\n${lines(before).map(line => `-${line}`).join('\n')}\n${lines(after).map(line => `+${line}`).join('\n')}`;
  for (let i = 1; i <= 20_001; i++) accumulator.push(edit(String(i), patch(i - 1, i)));
  const [file] = accumulator.finish();
  assert.deepEqual([file.countsKnown, file.added, file.removed, file.content], [true, 100, 100, 'complete']);
  assert.equal(file.patch, patch(0, 20_001));
  accumulator.push(edit('20002', patch(20_001, 0)));
  assert.deepEqual(accumulator.finish(), []);
});

test('streamed endpoint hash recovery retains matching intermediate bytes only', () => {
  const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
  const before = 'captured before\n', after = 'captured after\n';
  const endpoints: ChangeEndpointPair[] = [{ path: '/work/file.txt', before: { exists: true, hash: hashText(before) }, after: { exists: true, hash: hashText(after) } }];
  const accumulator = new ChangeNetAccumulator({ endpoints, hashText, maxProcessSteps: 0 });
  accumulator.push(operation('1', { before: 'earlier\n', after: before }));
  accumulator.push(operation('2', { before, after }));
  accumulator.push(operation('3', { before: after, after: 'later\n' }));
  const [file] = accumulator.finish(endpoints, '/work');
  assert.deepEqual([file.path, file.countsKnown, file.added, file.removed, file.evidence], ['file.txt', true, 1, 1, 'snapshot']);
  assert.match(file.patch, /-captured before\n\+captured after/);
  assert.doesNotMatch(file.patch, /earlier|later/);
  assert.equal(endpoints[0].before?.text, undefined);
  assert.equal(endpoints[0].after?.text, undefined);
});

test('process truncation preserves all changed paths and cross-source uncertainty', () => {
  const accumulator = new ChangeNetAccumulator({ maxProcessSteps: 1, maxProcessBytes: 1024 });
  accumulator.push(operation('1', { before: 'old\n', after: 'middle\n' }));
  accumulator.push(operation('2', { before: 'middle\n', after: 'new\n', origin: { sessionId: 'child', toolId: '2' } }));
  accumulator.push(operation('3', { path: '/work/other.txt', operation: 'create', after: 'created\n' }));
  const files = accumulator.finish();
  assert.deepEqual(files.map(file => [file.path, file.countsKnown, file.processTruncated]), [['/work/file.txt', false, true], ['/work/other.txt', true, true]]);
  assert.equal(files[0].reason, 'conflictingEvidence');
  assert.match(files[1].patch, /\+created/);
  assert.equal(files[1].op, 'create');
});

test('streaming creation deletion moves and sparse position shifts preserve final identities', () => {
  const accumulator = new ChangeNetAccumulator({ cwd: '/work', maxProcessSteps: 0 });
  accumulator.push(operation('1', { operation: 'create', after: 'created\n' }));
  accumulator.push(operation('2', { operation: 'move', path: '/work/moved.txt', sourcePath: '/work/file.txt' }));
  assert.deepEqual(accumulator.finish().map(file => [file.path, file.sourcePath, file.op, file.added, file.countsKnown]), [['moved.txt', 'file.txt', 'create', 1, true]]);
  accumulator.push(operation('3', { operation: 'delete', path: '/work/moved.txt' }));
  assert.deepEqual(accumulator.finish(), []);
  const sparse = new ChangeNetAccumulator({ maxProcessSteps: 0 });
  sparse.push(edit('1', '@@ -3,0 +4,1 @@\n+temporary'));
  sparse.push(edit('2', '@@ -6,1 +6,1 @@\n-old\n+new'));
  sparse.push(edit('3', '@@ -4,1 +3,0 @@\n-temporary'));
  const [file] = sparse.finish();
  assert.equal(file.patch, '@@ -5,1 +5,1 @@\n-old\n+new');
  assert.deepEqual([file.added, file.removed, file.countsKnown], [1, 1, true]);
});


