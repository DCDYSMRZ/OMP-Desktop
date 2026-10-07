import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolActivity } from '../model';
import { describeTool, toolFamily, readDisplay, parseNumberedDiff, editFiles, parseGrepDisplay, splitOutputTail, stripAnsi, stripExecutionNotices, parseDiagnostics, diagnosticTarget } from './tool-model';
import { toolStepLabel, nativeActivityLabel } from './tool-model';
import i18next from 'i18next';
import { toolsMessages } from '../../locales/messages/tools';
const tool = (name: string, args: unknown = {}, details: unknown = {}, content = ''): ToolActivity => ({ id: 'fixture', name, args, status: 'complete', result: { details, content: [{ type: 'text', text: content }] } });
test('replaced live tool objects expose updated descriptions without changing earlier summaries', () => {
  const initial = tool('bash', { command: 'echo before' });
  const before = describeTool(initial);
  const updated: ToolActivity = { ...initial, args: { command: 'echo after' }, status: 'error', result: { details: { exitCode: 7 }, content: [] } };
  const after = describeTool(updated);
  assert.equal(before.target, 'echo before');
  assert.equal(after.target, 'echo after');
  assert.deepEqual(after.chips, [{ kind: 'exit', value: 7, tone: 'error' }]);
  assert.deepEqual(describeTool(initial).chips, []);
});
// Trimmed native JSONL carriers; paths/content redacted, formatting retained.
test('classifies namespaced tools and write devices without treating messages as files', () => {
  for (const [name, family] of [['mcp.x/read_file','read'], ['apply_patch','edit'], ['ast_edit','edit'], ['shell','command'], ['python','eval'], ['grep','search'], ['ls','find'], ['fetch','web'], ['subagent','task'], ['await','wait'], ['todo','todo'], ['ask','ask'], ['lsp','lsp'], ['browser','browser']]) assert.equal(toolFamily(tool(name)), family);
  assert.equal(toolFamily(tool('write', { path: 'agent://Worker' })), 'message');
  assert.equal(toolFamily(tool('write', { path: 'xd://lsp' })), 'lsp');
  assert.equal(describeTool(tool('write', { path: 'xd://debug' })).target, 'debug');
  assert.equal(describeTool(tool('write', { path: 'agent://Worker' })).file, undefined);
});
test('decodes hashline fallback and preserves source indentation', () => {
  assert.deepEqual(readDisplay(tool('read', {}, {}, '[src/a.ts#AB12]\n19:  const x = 1;\n20:run();').result), { text: '  const x = 1;\nrun();', startLine: 19, lineNumbers: [19,20] });
  assert.equal(readDisplay(tool('read', {}, {}, 'ordinary directory listing').result).text, 'ordinary directory listing');
});
test('native display content wins, including intentionally empty text and elisions', () => {
  assert.deepEqual(readDisplay(tool('read', {}, { displayContent: { text: 'clean\n…\nlast', startLine: 19, lineNumbers: [19,null,40] } }, '[src/a.ts#AB12]\n19:old').result), { text: 'clean\n…\nlast', startLine: 19, lineNumbers: [19,null,40] });
  assert.equal(readDisplay(tool('read', {}, { displayContent: { text: '' } }, 'old').result).text, '');
});
test('numbered diffs count changes, preserve separators and aggregate files once', () => {
  const parsed = parseNumberedDiff(' 18|before\n-19|old\n+19|new\n+20|extra\n 21|after\n...');
  assert.equal(parsed.added, 2); assert.equal(parsed.removed, 1);
  assert.deepEqual(parsed.rows[4], { sign: ' ', oldNo: 20, newNo: 21, text: 'after' });
  assert.deepEqual(parsed.rows[5], { sign: '...', text: '…' });
  const activity = tool('edit', { input: '[src/a.ts#AB12]\nPUT 19.=19:\n+new' }, { diff: '+1|duplicate', perFileResults: [{ path: 'src/a.ts', diff: '-19|old\n+19|new' }, { path: 'src/b.ts', diff: '+2|added' }] });
  assert.deepEqual(describeTool(activity).chips.map(({kind,value}) => [kind,value]), [['added',2],['removed',1]]);
  assert.equal(describeTool(activity).target, 'a.ts:19');
  assert.equal(editFiles(tool('edit', { input: '[src/c.ts#A1B2]\nPUT 4.=4:\n+x' }))[0].path, 'src/c.ts');
});
test('grep display groups heading and single-file carriers without hash anchors', () => {
  assert.deepEqual(parseGrepDisplay('# src/\n## a.ts#78EF\n 18│context\n*19│match\n   │...\n## b.ts#AABB\n*2│other'), [{ path: 'src/a.ts', lines: [{ number: 18, text: 'context', match: false }, { number: 19, text: 'match', match: true }, { number: null, text: '…', match: false }] }, { path: 'src/b.ts', lines: [{ number: 2, text: 'other', match: true }] }]);
  assert.equal(parseGrepDisplay('*407│match', 'local://notes.md')[0].path, 'local://notes.md');
});
test('chips omit zero and unknown metrics, exit appears only for failure', () => {
  assert.deepEqual(describeTool(tool('bash', {}, { exitCode: 0, wallTimeMs: 999 })).chips, []);
  assert.deepEqual(describeTool(tool('bash')).chips, []);
  assert.deepEqual(describeTool(tool('bash', {}, { exitCode: 2, wallTimeMs: 1000 })).chips, [{ kind: 'exit', value: 2, tone: 'error' }, { kind: 'duration', value: 1000 }]);
  assert.deepEqual(describeTool(tool('grep', {}, { matchCount: 0, fileCount: 0 })).chips, []);
  assert.deepEqual(describeTool(tool('read')).chips, []);
  assert.deepEqual(describeTool(tool('read', {}, { displayContent: { text: '' }, totalLines: 500 })).chips, []);
  assert.equal(describeTool(tool('read', { path: 'src/a.ts:139+42' })).target, 'a.ts:139-180');
});
test('terminal text remains literal and tail keeps bounded output', () => {
  assert.equal(stripAnsi('\u001b[31m/$bunfs/root/omp\u001b[0m'), '/$bunfs/root/omp');
  assert.equal(stripAnsi('\u001b]8;;https://example.com\u001b\\label\u001b]8;;\u001b\\ after'), 'label after');
  assert.deepEqual(splitOutputTail('one\ntwo\nthree\n', 2), { text: 'two\nthree', totalLines: 3, hiddenLines: 1 });
});
test('LSP write devices show their action before a result arrives', () => {
  assert.equal(describeTool(tool('write', { path: 'xd://lsp', content: '{"action":"diagnostics","path":"src/main.ts"}' })).target, 'diagnostics · main.ts');
  assert.equal(describeTool(tool('write', { path: 'xd://lsp', content: '{invalid' })).target, '');
});
test('trailing execution notices are removed only when the matching metric remains visible', () => {
  const output = 'Error: missing file\n    at /$bunfs/root/omp\n\nWall time: 0.04 seconds\n\nCommand exited with code 2\n';
  assert.equal(stripExecutionNotices(output, { durationMs: 40, exitCode: 2 }), 'Error: missing file\n    at /$bunfs/root/omp');
  assert.equal(stripExecutionNotices(output, {}), output);
  assert.equal(stripExecutionNotices(output, { exitCode: 3, durationMs: 40 }), output);
  assert.equal(stripExecutionNotices('Wall time: 1 seconds\nreal user output', { durationMs: 1000 }), 'Wall time: 1 seconds\nreal user output');
  assert.equal(stripExecutionNotices('Command exited with code 0', { exitCode: 0 }), '');
});
test('counts only visible result image carriers across tool families, including deferred images', () => {
  for (const name of ['browser', 'computer', 'read', 'eval', 'bash', 'custom']) {
    const activity = tool(name);
    activity.result = { content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'image', deferred: true, resourceReference: 'artifact://image' }], details: { screenshots: [{ path: '/private/screenshot.png' }] }, providerReplay: [{ type: 'image', data: 'AAAA' }] };
    assert.deepEqual(describeTool(activity).chips.filter(chip => chip.kind === 'images'), [{ kind: 'images', value: 2 }]);
  }
  const deferred = tool('browser');
  deferred.result = { historyResourceDeferred: true, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
  assert.deepEqual(describeTool(deferred).chips, []);
});
test('normalizes native diagnostics without dropping status or multiline messages', () => {
  assert.deepEqual(parseDiagnostics({ summary: '1 error(s)', errored: true, messages: ['src/a.ts:12:4 [error] Missing name\n  detail'] }), { summary: '1 error(s)', errored: true, messages: ['src/a.ts:12:4 [error] Missing name\n  detail'] });
  assert.deepEqual(parseDiagnostics({ summary: 'No diagnostics', errored: false, messages: [] }), { summary: 'No diagnostics', errored: false, messages: [] });
  assert.equal(parseDiagnostics({ messages: ['src/a.ts:2 [warning] Handle the error case'] }).errored, false);
  assert.equal(editFiles(tool('edit', { path: 'src/a.ts' }, { diagnostics: { summary: '1 error(s)', errored: true, messages: ['src/a.ts:4 [error] Missing'] } }))[0].diagnostics?.messages[0], 'src/a.ts:4 [error] Missing');
});
test('retains per-file diagnostics and does not double count the aggregate carrier', () => {
  const diagnostics = { summary: '1 error(s)', errored: true, messages: ['src/a.ts:12:4 [error] Missing name'] };
  const activity = tool('edit', {}, { path: 'src/a.ts', diagnostics, perFileResults: [{ path: 'src/a.ts', diagnostics }, { path: 'src/b.ts', diagnostics: { summary: '1 warning(s)', errored: false, messages: ['src/b.ts:8 [warning] Unused'] } }] });
  assert.equal(editFiles(activity)[0].diagnostics?.messages[0], diagnostics.messages[0]);
  assert.equal(editFiles(activity)[1].diagnostics?.errored, false);
  assert.deepEqual(describeTool(activity).chips.filter(chip => chip.kind === 'diagnostics'), [{ kind: 'diagnostics', value: 2, tone: 'error' }]);
});
test('legacy diagnostics remain navigable and sort errors ahead of warnings', () => {
  const parsed = parseDiagnostics([{ path: 'src/a.ts', line: 2, severity: 'warning', message: 'Unused' }, { path: 'src/b.ts', line: 8, column: 3, severity: 1, message: 'Missing' }]);
  assert.equal(parsed.errored, true);
  assert.equal(diagnosticTarget(parsed.messages[0]), 'src/b.ts:8');
  assert.equal(diagnosticTarget('src/a.ts:2:9 [error] Missing'), 'src/a.ts:2');
  assert.equal(diagnosticTarget('C:\\work\\a.ts:12:3 [error] Missing'), 'C:\\work\\a.ts:12');
  assert.equal(diagnosticTarget('No location here'), undefined);
  assert.deepEqual(parseDiagnostics('src/a.ts:2 [warning] Unused').messages, ['src/a.ts:2 [warning] Unused']);
});
test('image reads present dimensions without transport boilerplate and retain substantive text', () => {
  const text = 'Read image file [image/webp]\n[Image: original 1024x599, displayed at 1024x599. Multiply coordinates by 1 to map to original image.]';
  const result = { content: [{ type: 'text', text }, { type: 'image', mimeType: 'image/webp', data: 'blob:unavailable' }] };
  assert.deepEqual(readDisplay(result), { text: '', image: { dimensions: '1024×599' } });
  assert.equal(readDisplay({ ...result, content: [...result.content, { type: 'text', text: 'Image orientation could not be detected.' }] }).text, 'Image orientation could not be detected.');
  assert.equal(readDisplay({ content: [{ type: 'text', text }] }).text, text);
  assert.deepEqual(readDisplay({ content: [{ type: 'image', deferred: true, resourceReference: 'artifact://image' }] }), { text: '', image: {} });
});
test('counts unified and numbered diff carriers without confusing source text for metadata', () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n--- source\n+++ source\n+extra\n context';
  const parsed = parseNumberedDiff(diff);
  assert.deepEqual([parsed.added, parsed.removed], [2, 1]);
  assert.equal(editFiles(tool('edit', { path: 'a.ts' }, {}, diff))[0].hasDiff, true);
});
test('splits multi-file unified and apply-patch results without aggregate duplication', () => {
  const unified = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b b/b\n--- /dev/null\n+++ b/b\n@@ -0,0 +1 @@\n+added';
  assert.deepEqual(editFiles(tool('bash', {}, {}, unified)).map(file => [file.path, parseNumberedDiff(file.diff).added]), [['a', 1], ['b', 1]]);
  const patch = '*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** Add File: b\n+added\n*** End Patch';
  assert.deepEqual(editFiles(tool('apply_patch', { input: patch })).map(file => [file.path, parseNumberedDiff(file.diff).added]), [['a', 1], ['b', 1]]);
});
test('attributes only literal shell mutations and never expands globs or read-only sed', () => {
  assert.deepEqual(editFiles(tool('bash', { command: "cd project && sed -i '' 's/a/b/g' src/a.ts && rm old.ts" })).map(file => [file.path, file.op]), [['project/src/a.ts', 'update'], ['project/old.ts', 'delete']]);
  assert.equal(editFiles(tool('bash', { command: 'sed -n 1,20p src/a.ts' }))[0].op, '');
  assert.equal(editFiles(tool('bash', { command: 'rm *.ts' }))[0].path, '');
});

const words = i18next.createInstance();
void words.init({ lng: 'zh-CN', initAsync: false, resources: { 'zh-CN': { translation: toolsMessages['zh-CN'] } } });
// Reduced native journal shapes: pi_workspeace 2026-09-26/27 and -Downloads-game hub journals.
test('message receipts distinguish delivery from waking and failed delivery; broadcast preserves recipient count', () => {
  for (const name of ['write', 'hub']) {
    const args = name === 'write' ? { path: 'agent://Worker', content: '检查入口\n完整详情', i: 'Checking entry' } : { op: 'send', to: 'Worker', message: '检查入口\n完整详情' };
    for (const [outcome, expected] of [['injected', '已送达'], ['woken', '已唤醒并送达'], ['revived', '已唤醒并送达'], ['failed', '未送达']]) {
      const message = { op: 'send', from: 'Main', to: 'Worker', receipts: [{ to: 'Worker', outcome }] };
      const label = toolStepLabel(tool(name, args, name === 'write' ? { message } : message), words.t);
      assert.equal(label, `给子代理 Worker 发消息：检查入口 · ${expected}`);
      assert.doesNotMatch(label, /Checking|完整详情|已完成/);
    }
  }
  assert.equal(toolStepLabel(tool('write', { path: 'agent://all', content: '停止编辑' }, { message: { receipts: [{ to: 'A', outcome: 'injected' }, { to: 'B', outcome: 'failed' }] } }), words.t), '给 2 个子代理群发：停止编辑');
});
test('wait reports the received sender rather than the consuming main agent and never collapses mixed jobs to all done', () => {
  assert.equal(toolStepLabel(tool('wait', { i: 'Waiting for handoffs' }, { op: 'wait', from: 'Main', waited: { from: 'ProjectDocs', to: 'Main', body: '文档已完成\n后续说明', id: 'message', ts: 1 } }), words.t), '等待子代理的结果或消息 · 收到 ProjectDocs 的消息：文档已完成');
  for (const name of ['wait', 'hub']) assert.equal(toolStepLabel(tool(name, { op: 'wait' }, { jobs: [{ id: 'A', type: 'task', status: 'completed' }, { id: 'B', type: 'task', status: 'running' }] }), words.t), '等待子代理的结果或消息 · A 已完成 · B 仍在运行');
  assert.match(toolStepLabel(tool('wait', {}, { interrupted: true, jobs: [] }), words.t), /等待被中断$/);
  assert.match(toolStepLabel(tool('wait', {}, { jobs: [] }, 'Wait limit reached; background work may still be running. Read proc:// for status.'), words.t), /超时，无新消息$/);
  assert.doesNotMatch(toolStepLabel(tool('wait'), words.t), /已完成|超时/);
});
test('process controls only report a stopped outcome after a terminal native result', () => {
  const args = { path: 'proc://desktop/kill' };
  assert.equal(toolStepLabel(tool('write', args), words.t), '停止后台任务 desktop');
  assert.equal(toolStepLabel(tool('write', args, { proc: { action: 'stop', daemon: { name: 'desktop', state: 'exited', exitCode: 1 } } }), words.t), '停止后台任务 desktop · 已停止');
  assert.equal(toolStepLabel(tool('read', { path: 'proc://scan' }, { proc: { job: { id: 'scan', status: 'running' } } }), words.t), '查看后台任务 scan · 运行中');
  assert.match(toolStepLabel(tool('hub', { op: 'cancel', ids: ['A'] }, { jobs: [{ id: 'A', status: 'cancelled' }] }), words.t), /A 已取消$/);
});
test('todo shows the changed item and counts only completed native tasks', () => {
  const phases = [{ name: '验证', tasks: [{ content: '验证入口', status: 'completed' }, { content: '验证输出', status: 'in_progress' }] }];
  assert.equal(toolStepLabel(tool('todo', { op: 'done', task: '验证入口' }, { op: 'done', phases }), words.t), '完成：验证入口 · 1/2 项完成');
  assert.equal(toolStepLabel(tool('todo', { op: 'init', list: [{ phase: '验证', items: ['入口', '输出'] }] }), words.t), '制定计划：1 个阶段、2 项');
  assert.match(toolStepLabel(tool('todo', { op: 'start', task: '验证输出' }, { phases }), words.t), /^开始：验证输出/);
});
test('native URI families, task names, devices and MCP tools identify the actual object', () => {
  for (const [scheme, noun] of [['agent', '子代理'], ['artifact', '生成的文件'], ['local', '本地记录'], ['history', '会话记录'], ['skill', '技能说明'], ['xd', '工具说明']]) assert.match(toolStepLabel(tool('read', { path: `${scheme}://record` }), words.t), new RegExp(`${noun} record`));
  assert.equal(toolStepLabel(tool('task', { tasks: [{ agent: 'task', name: 'A' }, { agent: 'task', name: 'B' }] }), words.t), '委派 2 个子代理：A、B');
  for (const [device, label] of [['lsp', '代码导航'], ['ast_edit', '结构化编辑'], ['debug', '调试器'], ['browser', '浏览器']]) assert.equal(toolStepLabel(tool('write', { path: `xd://${device}`, content: '{"action":"launch"}' }), words.t), `${label}：启动`);
  assert.equal(toolStepLabel(tool('mcp__server__tool'), words.t), 'MCP · server · tool');
  assert.equal(toolStepLabel(tool('yield', { data: { files: ['a'] } }, { status: 'success' }), words.t), '提交结果给主代理');
  assert.match(toolStepLabel(tool('advise', { note: '保留用户文件', severity: 'concern' }), words.t), /请教顾问/);
  assert.equal(toolStepLabel(tool('goal', { op: 'set', objective: '验证流程' }), words.t), '设定目标：验证流程');
});
test('database queries and parent messages identify their actual resource and direction', () => {
  assert.equal(toolStepLabel(tool('read', { path: '/tmp/history.db?q=SELECT%20title%20FROM%20sessions' }), words.t), '查询 history.db（SELECT title FROM sessions）');
  assert.equal(toolStepLabel(tool('write', { path: 'agent://parent', content: '检查完成' }), words.t), '给主代理发消息：检查完成');
  assert.equal(toolStepLabel(tool('hub', { op: 'send', to: 'parent', message: '检查完成' }), words.t), '给主代理发消息：检查完成');
});
test('ask distinguishes a question from the selected option and custom response', () => {
  const args = { questions: [{ id: 'scope', question: '修复哪个界面？', options: [{ label: '桌面' }] }] };
  assert.equal(toolStepLabel(tool('ask', args), words.t), '向你提问：修复哪个界面？');
  assert.equal(toolStepLabel(tool('ask', args, { results: [{ id: 'scope', options: ['桌面'], selectedOptions: ['桌面'] }] }), words.t), '你已选择：桌面');
  assert.equal(toolStepLabel(tool('ask', args, { results: [{ id: 'scope', selectedOptions: [], customInput: '先看历史' }] }), words.t), '你已回答：先看历史');
  assert.equal(toolStepLabel(tool('ask', args, {}, 'User selected: 桌面'), words.t), '你已选择：桌面');
  assert.equal(toolStepLabel(tool('ask', args, {}, 'User provided custom input: 先看历史'), words.t), '你已回答：先看历史');
});
test('incoming and async headers preserve all subjects and distinct outcomes without deriving success from arrival', () => {
  assert.equal(nativeActivityLabel({ customType: 'irc:incoming', details: { from: 'Docs', message: '文档已完成\n详细说明' } }, words.t), '子代理 Docs 发来消息：文档已完成');
  assert.equal(nativeActivityLabel({ customType: 'launch-completion', details: { daemons: [{ name: 'desktop', state: 'failed', exitCode: 65 }] } }, words.t), '后台进程 desktop 退出（代码 65）');
  const delivery = { jobs: [{ id: 'A', type: 'task' as const, status: 'completed' as const, raw: {}, ambiguous: false }, { id: 'B', type: 'task' as const, status: 'failed' as const, raw: {}, ambiguous: false }], diagnostics: [], content: '', residualContent: [] };
  assert.equal(nativeActivityLabel({ customType: 'async-result' }, words.t, delivery), '收到 2 个后台结果：A 已完成、B 失败');
  assert.doesNotMatch(nativeActivityLabel({ customType: 'async-result' }, words.t, { ...delivery, jobs: [{ ...delivery.jobs[0], status: 'unknown', ambiguous: true, schema: { status: 'completed' } }] })!, /已完成/);
});
test('native async envelopes carry mixed settlement while schema validity never means job success', () => {
  const raw = { role: 'custom', customType: 'async-result', details: { jobs: [{ jobId: 'A', type: 'task', label: 'A' }, { jobId: 'B', type: 'task', label: 'B' }] }, content: '<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job A (A) ──\n<task-result id="A" agent="task" status="completed" duration="1s">\n<output>\nDone\n</output>\n</task-result>\n── Job B (B) ──\n<task-result id="B" agent="task" status="failed (exit 7)" duration="2s">\n<output>\nFailed\n</output>\n</task-result>\n</system-notice>' };
  assert.equal(nativeActivityLabel(raw, words.t), '收到 2 个后台结果：A 已完成、B 失败');
  assert.equal(nativeActivityLabel({ role: 'custom', customType: 'async-result', content: '', details: { jobs: [{ jobId: 'A', type: 'task', schema: { status: 'valid' } }] } }, words.t), '收到 1 个后台结果：A 状态未知');
});
test('legacy hub operations name their process or message object without inventing terminal outcomes', () => {
  for (const [op, verb] of [['start', '启动'], ['restart', '重启'], ['stop', '停止'], ['logs', '查看'], ['describe', '查看']]) {
    const row = tool('hub', { op, name: 'phone-mirror' }, { op, daemon: { name: 'phone-mirror', state: 'starting' } });
    assert.match(toolStepLabel(row, words.t), new RegExp(`^${verb}后台任务 phone-mirror`));
    assert.doesNotMatch(toolStepLabel(row, words.t), /已完成|已停止/);
  }
  for (const op of ['jobs', 'ps']) assert.match(toolStepLabel(tool('hub', { op }, { jobs: [{ id: 'A', status: 'running' }] }), words.t), /A 运行中/);
  assert.equal(toolStepLabel(tool('hub', { op: 'inbox' }, { inbox: [] }), words.t), '查看子代理消息');
  assert.equal(toolStepLabel(tool('hub', { op: 'list' }, { peers: [] }), words.t), '查看子代理');
});
test('result-only saved rows recover native targets and distinguish unavailable arguments', () => {
  assert.equal(toolStepLabel(tool('read', {}, { meta: { source: { type: 'path', value: '/workspace/source.ts' } } }), words.t), '读取 source.ts');
  assert.equal(toolStepLabel(tool('read', {}, { resolvedPath: '/workspace/docs' }), words.t), '读取 docs');
  assert.equal(toolStepLabel(tool('eval', {}, { cells: [{ code: 'console.log(result)', title: 'Inspecting result' }] }), words.t), '运行代码 console.log(result)');
  assert.equal(toolStepLabel(tool('bash', {}), words.t), '执行 · 参数未记录');
  assert.equal(toolStepLabel({ ...tool('bash'), args: undefined }, words.t), '执行 · 参数未载入');
  assert.equal(toolStepLabel({ ...tool('read'), status: 'pending' }, words.t), '读取 · 正在接收参数…');
});
