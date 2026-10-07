import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryReader } from './journal';
import { SessionResources } from './session-resources';
import { evidenceOf } from '../../shared/subagent-evidence';

const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function fixture(run: (resources: SessionResources, parent: string, directory: string, at: (offset: number) => string) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), 'omp-provisional-'));
 const parent = join(root, 'parent.jsonl'), directory = join(root, 'parent');
 const reader = new HistoryReader();
 const started = Date.now() - 10_000;
 const at = (offset: number) => new Date(started + offset).toISOString();
 await mkdir(directory);
 await writeFile(parent, lines({ type: 'session', version: 3, id: 'parent', cwd: '/workspace', timestamp: at(0) }));
 const resources = new SessionResources(reader, async () => join(root, 'blobs'), () => ({ state: 'running', source: 'journal', confidence: 'inferred', owner: 'external' }));
 try { await run(resources, parent, directory, at); } finally { reader.close(); await rm(root, { recursive: true, force: true }); }
}
function call(id: string, parentId: string | null, timestamp: string) {
 return { type: 'message', id, parentId, timestamp, message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'task', arguments: { tasks: [{ name: 'worker', task: 'Inspect the workspace' }] } }] } };
}
function start(id: string, timestamp: string) {
 return { type: 'custom', id: `${id}-start`, parentId: id, timestamp, customType: 'tool_execution_start', data: { toolCallId: id, toolName: 'task', startedAt: timestamp } };
}
async function child(directory: string, parent: string, timestamp: string) {
 await writeFile(join(directory, 'worker-2.jsonl'), lines({ type: 'session', version: 3, id: 'child-uuid', cwd: '/workspace', parentSession: parent, timestamp }, { type: 'message', id: 'request', parentId: null, timestamp, message: { role: 'user', content: 'Inspect workspace' } }));
}

test('open synchronous task declarations and child headers prove ownership before results, with stable settlement identity', async () => fixture(async (resources, parent, directory, at) => {
 await appendFile(parent, lines(call('task', null, at(1)), start('task', at(2))));
 await child(directory, parent, at(3));
 const first = (await resources.listHistorySubagents({ path: parent })).subagents[0];
 assert.equal(first.nativeId, 'worker-2');
 assert.equal(first.parentToolCallId, 'task');
 assert.equal(first.index, 0);
 assert.equal(first.status, 'running');
 assert.equal(evidenceOf(first).observation, 'inferred');
 await appendFile(parent, lines({ type: 'message', id: 'result', parentId: 'task-start', timestamp: at(4), message: { role: 'toolResult', toolCallId: 'task', toolName: 'task', details: { results: [{ id: 'worker-2', index: 0, exitCode: 0 }] } } }));
 const done = (await resources.listHistorySubagents({ path: parent })).subagents[0];
 assert.equal(done.id, first.id);
 assert.equal(done.status, 'completed');
}));

test('ambiguous open declarations retain parent-authorized unassigned children, without granting a guessed task owner', async () => fixture(async (resources, parent, directory, at) => {
 await appendFile(parent, lines(call('first', null, at(1)), start('first', at(2)), call('second', 'first-start', at(3)), start('second', at(4))));
 await child(directory, parent, at(5));
 const unassigned = (await resources.listHistorySubagents({ path: parent })).subagents[0];
 assert.equal(unassigned.parentToolCallId, undefined);
 assert.match(String(unassigned.ownershipReason), /multiple/);
 assert.equal(unassigned.status, 'running');
 await appendFile(parent, lines({ type: 'message', id: 'result', parentId: 'second-start', timestamp: at(6), message: { role: 'toolResult', toolCallId: 'second', toolName: 'task', details: { results: [{ id: 'worker-2', index: 0, exitCode: 0 }] } } }));
 const settled = (await resources.listHistorySubagents({ path: parent })).subagents[0];
 assert.equal(settled.id, unassigned.id);
 assert.equal(settled.parentToolCallId, 'second');
}));

test('child creation time excludes later task starts and foreign parent headers never establish children', async () => fixture(async (resources, parent, directory, at) => {
 await appendFile(parent, lines(call('first', null, at(1)), start('first', at(2)), call('second', 'first-start', at(4)), start('second', at(5))));
 await child(directory, parent, at(3));
 assert.equal((await resources.listHistorySubagents({ path: parent })).subagents[0].parentToolCallId, 'first');
 await child(directory, '/foreign/parent.jsonl', at(3));
 assert.deepEqual((await resources.listHistorySubagents({ path: parent })).subagents, []);
}));

test('canonical parent aliases preserve proven provisional ownership', async () => fixture(async (resources, parent, directory, at) => {
 await appendFile(parent, lines(call('task', null, at(1)), start('task', at(2))));
 const alias = join(directory, 'parent-alias.jsonl');
 await symlink(parent, alias);
 await child(directory, alias, at(3));
 const found = (await resources.listHistorySubagents({ path: parent })).subagents;
 assert.equal(found.length, 1);
 assert.equal(found[0].parentToolCallId, 'task');
 assert.equal(found[0].status, 'running');
}));
