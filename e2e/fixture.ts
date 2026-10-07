import { appendFileSync, writeFileSync } from 'node:fs';
const root = process.env.FIXTURE_ROOT!;
if (!root) throw new Error('FIXTURE_ROOT required');
const port = Number(process.env.FIXTURE_PORT || 19750);
const maximum = 500;
let count = 0;
const counts: Record<string, number> = {};
const finished = new Set<string>();
const names = ['ScanFrontend', 'ScanBackend', 'ScanDocs'];
const files = ['src/frontend.ts', 'src/backend.ts', 'docs/guide.txt'];
const sleep = (ms: number) => Bun.sleep(ms);
function log(value: unknown) { appendFileSync(`${root}/fixture.log`, JSON.stringify({ at: new Date().toISOString(), ...value as object }) + '\n'); }
interface ChatRequest { model: string; stream?: boolean; tools?: { function?: { name: string }; name?: string }[]; messages: { role: string; content: unknown; tool_calls?: { function?: { name: string } }[] }[] }
function scenario(body: ChatRequest) {
  const tools = (body.tools || []).map(t => t.function?.name || t.name);
  const messages = body.messages || [];
  const users = messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n');
  const system = messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n');
  const child = names.find(n => users.includes(`FIXTURE_CHILD=${n}`));
  // Title/effort helper requests never advance the actual scenario.
  const latest = [...messages].reverse().find(m => m.role === 'user');
  const prompt = typeof latest?.content === 'string' ? latest.content : JSON.stringify(latest?.content);
  const actor = child && tools.length ? child : !tools.length ? 'Helper' : users.includes('LIVE_FIXTURE_ASK:') ? 'AskParent' : users.includes('LIVE_FIXTURE_SCENARIO:') ? 'Parent' : prompt.includes('E2E_ERROR') ? 'Error' : prompt.includes('E2E_SLOW') ? 'Slow' : 'Simple';
  const step = counts[actor] = (counts[actor] || 0) + 1;
  let text = ''; let calls: { name: string; arguments: object }[] = [];
  const call = (name: string, args: object) => calls.push({ name, arguments: args });
  if (actor === 'Helper') text = /effort|difficulty|classif/i.test(system) ? 'medium' : 'Workspace verification';
  else if (actor === 'Simple' || actor === 'Slow' || actor === 'Error') text = `# Local answer\n\n${actor === 'Slow' ? Array.from({length:24},(_,i)=>`## Check ${i+1}\n\nThe deterministic local response remains readable while new content arrives.\n\n`).join('') : 'The isolated workspace is ready.\n\n'}E2E_ANSWER_COMPLETE`;
  else if (actor === 'AskParent') {
    const answer = messages.filter(m => m.role === 'tool').at(-1);
    if (step === 1) {
      text = '请选择本次验证范围；我会等待你的回答再结束。';
      call('ask', { questions: [{ id: 'verification-scope', header: '验证范围', question: '这次优先验证哪个界面？', options: [{ label: '计划与子代理', description: '检查阶段进度和三个子代理的实时工具步骤' }, { label: '对话与收件箱', description: '检查需要回复、选项提交和最终答复' }] }] });
    } else text = `# 选择已确认\n\n收到原生 ask 工具返回的回答：\n\n${typeof answer?.content === 'string' ? answer.content : JSON.stringify(answer?.content)}\n\nLIVE_FIXTURE_ASK_COMPLETE`;
  }
  else if (actor !== 'Parent') {
    const index = names.indexOf(actor);
    if (step === 1) { text = `I’m inspecting ${files[index]} and checking the relevant behavior.`; call('read', { path: files[index], i: 'Reading assigned source' }); }
    else if (step === 2) call('grep', { pattern: 'export|fixture|guide', path: files[index], i: 'Finding implementation boundaries' });
    else if (step === 3) call('bash', { command: `sleep ${3 + index * 2} && echo '${actor}: deterministic check done'`, i: 'Running scoped verification' });
    else if (step === 4) {
      if (index === 1) call('bash', { command: "sleep 3 && echo 'Expected fixture failure: backend dependency unavailable' && exit 7", i: 'Exercising visible failure state' });
      else call('read', { path: 'README.md', i: 'Checking workspace documentation' });
    } else {
      text = `## ${actor} report\n\n- Inspected **${files[index]}**.\n- Search and paced shell verification completed.\n- ${index === 1 ? 'The deliberate exit-7 check was observed and reported; it does not prevent this report.' : 'The deterministic fixture checks passed.'}\n\n\`\`\`text\n${actor}: verification complete\n\`\`\``;
      call('yield', { data: { agent: actor, report: text, expectedFailure: index === 1 } });
      finished.add(actor);
    }
  } else if (step === 1) {
    text = '先建立两阶段计划，再逐项展示调研和验证进度。';
    call('todo', { op: 'init', list: [{ phase: '调研', items: ['阅读说明并定位入口', '并行调研三个模块'] }, { phase: '验证', items: ['记录调研结果', '运行最终验证'] }] });
  } else if (step === 2) call('todo', { op: 'start', task: '阅读说明并定位入口' });
  else if (step === 3) { text = 'I’ll inspect the workspace, then delegate three focused checks so you can watch their live tool steps.'; call('read', { path: 'README.md', i: 'Reading workspace overview' }); }
  else if (step === 4) call('grep', { pattern: 'export|fixture', path: 'src', i: 'Finding source entrypoints' });
  else if (step === 5) call('todo', { op: 'done', task: '阅读说明并定位入口' });
  else if (step === 6) call('todo', { op: 'start', task: '并行调研三个模块' });
  else if (step === 7) { text = 'Starting frontend, backend, and documentation scans in parallel.'; call('task', { context: 'Deterministic local live-verification workspace. Read only your assigned file, execute the scripted checks, and report findings.', tasks: names.map((name, index) => ({ name, agent: 'task', task: `# Target\nReview ${['frontend rendering behavior', 'backend request handling', 'documentation accuracy'][index]}.\n\nFIXTURE_CHILD=${name}\n\n# Scope\nInspect ${files[index]}, search relevant symbols, run paced shell verification, and return a markdown report. The backend negative check is intentional.` })) }); }
  else if (finished.size < 3) call('wait', { i: 'Waiting for delegated checks' });
  else if (step === 8) call('todo', { op: 'done', task: '并行调研三个模块' });
  else if (step === 9) call('todo', { op: 'start', task: '记录调研结果' });
  else if (step === 10) { text = 'All three scans have reported. I’m recording their findings and verifying the generated summary.'; call('write', { path: 'verification.txt', content: 'Frontend: passed\nBackend: expected exit-7 observed\nDocs: passed\n', i: 'Recording verification summary' }); }
  else if (step === 11) call('todo', { op: 'done', task: '记录调研结果' });
  else if (step === 12) call('todo', { op: 'start', task: '运行最终验证' });
  else if (step === 13) call('bash', { command: "sleep 3 && cat verification.txt && echo 'LIVE_FIXTURE_COMPLETE'", i: 'Verifying generated summary' });
  else if (step === 14) call('todo', { op: 'done', task: '运行最终验证' });
  else text = '# Live verification complete\n\n- **ScanFrontend** inspected the rendering source.\n- **ScanBackend** reported the deliberate failing command without losing its report.\n- **ScanDocs** checked the workspace guide.\n- **调研 / 验证**：四个计划项全部完成。\n\n```text\nLIVE_FIXTURE_COMPLETE\n```\n\n| Area | Result |\n| --- | --- |\n| Frontend | Passed |\n| Backend | Expected exit 7 observed |\n| Documentation | Passed |\n\nThe generated `verification.txt` records the results. All model output came from the localhost fixture.';
  if (actor === 'Parent' && !calls.length) text += '\n\n' + Array.from({length:28},(_,i)=>`## Report section ${i+1}\n\nA readable verification result with **evidence**, a clear outcome, and enough detail to exercise transcript following.\n\n- Frontend passed.\n- Backend exit 7 was expected.\n- Documentation passed.\n`).join('') + '\nE2E_REPORT_COMPLETE';
  return { actor, step, text, calls, delay: actor === 'Slow' ? prompt.includes('Terminal presence') ? 25000 : 6500 : actor === 'Parent' || actor === 'AskParent' ? 350 : actor === 'Helper' ? 0 : names.includes(actor) ? 800 : 200, tools };
}
Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 120, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/health') { log({ method: request.method, path, summary: 'Fixture health', count }); return Response.json({ ok: true, count, counts, finished: [...finished] }); }
  let body: ChatRequest; try { body = await request.json(); if (!body || !Array.isArray(body.messages) || typeof body.model !== 'string') throw new Error('Invalid chat request'); } catch { log({ method: request.method, path, invalid: true }); return new Response('Expected chat request JSON', { status: 400 }); }
  count++;
  if (count > maximum) { log({ method: request.method, path, capped: true, count }); return new Response('Fixture request cap exceeded', { status: 429 }); }
  if (path !== '/v1/chat/completions') { log({ method: request.method, path, unsupported: true }); return new Response('Only chat completions supported', { status: 404 }); }
  const plan = scenario(body);
  log({ method: request.method, path, count, actor: plan.actor, step: plan.step, model: body.model, stream: body.stream, messages: body.messages?.length, tools: plan.tools, calls: plan.calls.map(c => c.name), summary: plan.text.slice(0, 150) });
  if (plan.actor === 'Error') return Response.json({error:{message:'Local provider unavailable. Retry your request.',type:'server_error',code:'fixture_unavailable'}},{status:500});
  if (plan.step === 1) writeFileSync(`${root}/request-${plan.actor}.json`, JSON.stringify(body, null, 2));
  const requestId = count;
  const id = `chatcmpl-fixture-${requestId}`; const created = Math.floor(Date.now() / 1000);
  const tokens = { prompt_tokens: 1200 + plan.step * 170, completion_tokens: 110 + plan.calls.length * 45, total_tokens: 1310 + plan.step * 170 + plan.calls.length * 45 };
  if (!body.stream) return Response.json({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: plan.text }, finish_reason: 'stop' }], usage: tokens });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ async start(controller) {
    const emit = (delta: object, finish_reason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
    try {
      await sleep(plan.delay); emit({ role: 'assistant', content: '' });
      const answerParts = plan.text.match(/.{1,60}|\n/g) || [];
      let answerOffset = 0;
      if (plan.actor === 'Simple' && JSON.stringify(body.messages.at(-1)?.content).includes('E2E_THINKING')) {
        const long = JSON.stringify(body.messages.at(-1)?.content).includes('E2E_THINKING_LIVE');
        const reasoning = long ? '**核对推理依据**\n\n' + Array.from({ length: 28 }, (_, index) => `${index === 14 ? '**整理最终结论**\n\n' : ''}第${index + 1}项：先确认问题的范围，再按顺序核对依据，保留每一步推理，最后给出清晰的答复。\n\n`).join('') : '先确认问题的范围。\n\n再按顺序核对依据。\n\n最后给出清晰的答复。\n\n';
        for (const thinking of long ? reasoning.match(/.{1,8}|\n/g) || [] : reasoning.split(/(?<=\n\n)/)) { emit({ reasoning_content: thinking }); await sleep(long ? 55 : 1800); }
        if (long && answerParts.length) { emit({ content: answerParts[answerOffset++] }); await sleep(1400); }
      }
      for (; answerOffset < answerParts.length; answerOffset++) { emit({ content: answerParts[answerOffset] }); await sleep(35); }
      for (const [index, call] of plan.calls.entries()) {
        emit({ tool_calls: [{ index, id: `call_${requestId}_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] });
        const serialized = JSON.stringify(call.arguments);
        for (let offset = 0; offset < serialized.length; offset += 65) { emit({ tool_calls: [{ index, function: { arguments: serialized.slice(offset, offset + 65) } }] }); await sleep(65); }
      }
      emit({}, plan.calls.length ? 'tool_calls' : 'stop');
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: tokens })}\n\ndata: [DONE]\n\n`));
      controller.close();
      log({ event: 'response-complete', actor: plan.actor, step: plan.step, usage: tokens });
    } catch (error) { log({ event: 'stream-error', error: String(error) }); }
  }});
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}});
console.log(`Fixture listening on http://127.0.0.1:${port}`);
