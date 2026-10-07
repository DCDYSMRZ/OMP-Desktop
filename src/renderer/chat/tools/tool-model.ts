import type { ToolActivity } from '../model';
import { parseFileTarget, formatFileTarget, type FileTarget } from '../../lib/file-target';
import { isVisibleImage } from '../message-details';
import type { TFunction } from 'i18next';
import { parseNativeAsyncDelivery, type NativeAsyncDelivery } from '../../../shared/native-task-results';

export type ToolFamily = 'read'|'write'|'edit'|'command'|'eval'|'search'|'find'|'web'|'task'|'wait'|'todo'|'ask'|'message'|'lsp'|'browser'|'computer'|'other';
export interface ToolChip { kind: 'lines'|'added'|'removed'|'matches'|'files'|'exit'|'sources'|'todo'|'jobs'|'bytes'|'duration'|'background'|'outcome'|'images'|'diagnostics'; value: number | string; tone?: 'success'|'error'|'warning' }
export interface ToolSummary { family: ToolFamily; verbKey: string; target?: string; targetTitle?: string; file?: FileTarget; intent?: string; chips: ToolChip[]; peer?: string }
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const basename = (path: string): string => path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path;
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
export function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const result = object(value);
  return list(result.content).map(block => string(object(block).text)).filter(Boolean).join('\n') || string(result.content) || string(result.text) || string(result.output);
}
/** Count explicit visible carriers only; screenshot metadata never grants file access. */
export function resultImages(result: unknown): unknown[] {
  return object(result).historyResourceDeferred === true ? [] : list(object(result).content).filter(isVisibleImage);
}
export interface FileDiagnostics { summary: string; errored: boolean; messages: string[] }
export function diagnosticSeverity(message: string): 'error' | 'warning' | 'info' {
  const label = /\[(error|warning|warn|info|hint)\]/i.exec(message)?.[1].toLowerCase();
  if (label) return label === 'error' ? 'error' : label === 'warning' || label === 'warn' ? 'warning' : 'info';
  if (/(?:\[error\]|\berror\b|错误)/i.test(message)) return 'error';
  if (/(?:\[warn(?:ing)?\]|\bwarn(?:ing)?\b|警告)/i.test(message)) return 'warning';
  return 'info';
}
export function diagnosticTarget(message: string): string | undefined {
  const match = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)?[^\s<>"'():]+(?:[\\/][^\s<>"'():]+)*):([1-9]\d*)(?::[1-9]\d*)?(?=\s|$|:)/.exec(stripAnsi(message));
  return match ? formatFileTarget({ path: match[1], line: Number(match[2]) }) : undefined;
}
export function parseDiagnostics(value: unknown): FileDiagnostics {
  const native = object(value);
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : list(native.messages);
  const messages = entries.map(entry => {
    if (typeof entry === 'string') return stripAnsi(entry);
    const item = object(entry), severity = typeof item.severity === 'number' ? ({ 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' } as Record<number, string>)[item.severity] : string(item.severity);
    const path = string(item.path) || string(item.file);
    return [path && `${path}${positive(item.line) ? `:${item.line}${positive(item.column) ? `:${item.column}` : ''}` : ''}`, severity && `[${severity}]`, string(item.message) || string(item.text)].filter(Boolean).join(' ');
  }).filter(message => message.trim());
  const rank = { error: 0, warning: 1, info: 2 };
  messages.sort((a, b) => rank[diagnosticSeverity(a)] - rank[diagnosticSeverity(b)]);
  return { summary: string(native.summary), errored: native.errored === true || messages.some(message => diagnosticSeverity(message) === 'error'), messages };
}
export function stripAnsi(value: string): string {
  return value.replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, '').replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '');
}
export function splitOutputTail(value: string, limit = 40): { text: string; totalLines: number; hiddenLines: number } {
  const lines = stripAnsi(value).replace(/\n$/, '').split('\n');
  return { text: lines.slice(-limit).join('\n'), totalLines: value ? lines.length : 0, hiddenLines: Math.max(0, lines.length - limit) };
}
/** Only remove a trailing native notice when the same fact has a typed display carrier. */
export function stripExecutionNotices(source: string, metrics: { durationMs?: unknown; exitCode?: unknown }): string {
  const clean = stripAnsi(source), lines = clean.split('\n');
  let end = lines.length, removed = false;
  while (end > 0) {
    let index = end - 1;
    while (index >= 0 && !lines[index].trim()) index--;
    if (index < 0) break;
    const line = lines[index].trim();
    const duration = /^Wall time: ([\d.]+) seconds?\.?$/i.exec(line);
    const exit = /^(?:Command|Process) exited with code (-?\d+)\.?$/i.exec(line);
    const knownDuration = duration && typeof metrics.durationMs === 'number' && Math.abs(Number(duration[1]) * 1000 - metrics.durationMs) < 11;
    const knownExit = exit && typeof metrics.exitCode === 'number' && Number(exit[1]) === metrics.exitCode;
    if (!knownDuration && !knownExit) break;
    removed = true; end = index;
  }
  if (!removed) return clean;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end).join('\n');
}
export function toolFamily(tool: ToolActivity): ToolFamily {
  const name = tool.name.toLowerCase().split('/').at(-1)!.split('.').at(-1)!;
  if (name === 'hub') return string(object(tool.args).op) === 'send' ? 'message' : string(object(tool.args).op) === 'wait' ? 'wait' : 'other';
  if (name === 'write') {
    const path = string(object(tool.args).path);
    if (path.startsWith('agent://')) return 'message';
    if (path.startsWith('xd://')) return path.slice(5).split('/')[0] === 'lsp' ? 'lsp' : 'other';
    return 'write';
  }
  const families: Record<string, ToolFamily> = { read: 'read', read_file: 'read', edit: 'edit', hashline: 'edit', hashline_edit: 'edit', apply_patch: 'edit', 'apply-patch': 'edit', delete: 'edit', move: 'edit', ast_edit: 'edit', bash: 'command', shell: 'command', exec: 'command', eval: 'eval', python: 'eval', grep: 'search', search: 'search', glob: 'find', find: 'find', ls: 'find', web_search: 'web', fetch: 'web', web: 'web', task: 'task', subagent: 'task', wait: 'wait', await: 'wait', jobs: 'wait', todo: 'todo', ask: 'ask', lsp: 'lsp', browser: 'browser', computer: 'computer' };
  return families[name] ?? 'other';
}
export interface ReadDisplay { text: string; startLine?: number; lineNumbers?: (number | null)[]; image?: { dimensions?: string } }
/** Prefer the native, prefix-free display carrier; legacy hashlines are decoded only at the boundary. */
export function readDisplay(result: unknown): ReadDisplay {
  const details = object(object(result).details);
  const display = object(details.displayContent);
  if (resultImages(result).length) {
    const source = stripAnsi(typeof display.text === 'string' ? display.text : typeof details.displayContent === 'string' ? details.displayContent : resultText(result));
    const dimensions = /^\[Image: original (\d+)[x×](\d+)(?:,|\])/m.exec(source);
    const text = source.split('\n').filter(line => !/^Read image file \[image\/[^\]]+\]\s*$/.test(line) && !/^\[Image: original \d+[x×]\d+.*\]\s*$/.test(line)).join('\n').trim();
    return { text, image: { ...(dimensions ? { dimensions: `${dimensions[1]}×${dimensions[2]}` } : {}) } };
  }
  if (typeof display.text === 'string') return { text: display.text, startLine: positive(display.startLine), lineNumbers: Array.isArray(display.lineNumbers) ? display.lineNumbers.map(n => positive(n) ?? null) : undefined };
  if (typeof details.displayContent === 'string') return { text: details.displayContent };
  const source = stripAnsi(resultText(result));
  const lines = source.split('\n');
  const anchored = /^\[.+#[a-f\d]{4}\]$/i.test(lines[0] ?? '');
  if (anchored) lines.shift();
  if (!anchored && !lines.some(line => /^\d+:/.test(line))) return { text: source };
  const lineNumbers: (number | null)[] = [];
  const clean = lines.map(line => {
    const match = /^(\d+)(?:-[\d]+)?:(.*)$/.exec(line);
    lineNumbers.push(match ? Number(match[1]) : null);
    return match ? match[2] : line;
  });
  return { text: clean.join('\n'), lineNumbers, startLine: lineNumbers.find(n => n !== null) ?? undefined };
}
export interface DiffRow { sign: '+' | '-' | ' ' | '...'; oldNo?: number; newNo?: number; text: string }
export function parseNumberedDiff(source: string): { rows: DiffRow[]; added: number; removed: number } {
  let added = 0, removed = 0, offset = 0, oldNo = 0, newNo = 0, unified = false;
  const rows: DiffRow[] = [];
  for (const line of stripAnsi(source).split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); unified = true; rows.push({ sign: '...', text: line }); continue; }
    if (unified && /^[+ -]/.test(line)) {
      const sign = line[0] as '+' | '-' | ' ';
      rows.push({ sign, text: line.slice(1), ...(sign !== '+' ? { oldNo: oldNo++ } : {}), ...(sign !== '-' ? { newNo: newNo++ } : {}) });
      if (sign === '+') added++; else if (sign === '-') removed++;
      continue;
    }
    if (/^\s*(?:\.{3}|…)\s*$/.test(line)) { rows.push({ sign: '...', text: '…' }); continue; }
    const match = /^([+ -])\s*(\d+)\|(.*)$/.exec(line);
    if (!match) { rows.push({ sign: ' ', text: line }); continue; }
    const sign = match[1] as '+' | '-' | ' ', number = Number(match[2]);
    if (sign === '+') { added++; offset++; rows.push({ sign, newNo: number, text: match[3] }); }
    else if (sign === '-') { removed++; offset--; rows.push({ sign, oldNo: number, text: match[3] }); }
    else rows.push({ sign, oldNo: number - offset, newNo: number, text: match[3] });
  }
  return { rows, added, removed };
}
export interface FileDiff { path: string; sourcePath?: string; firstChangedLine?: number; diff: string; hasDiff?: boolean; op?: string; move?: string; oldText?: string; newText?: string; isError?: boolean; errorText?: string; diagnostics?: FileDiagnostics }
export function editFiles(tool: ToolActivity): FileDiff[] {
  const args = object(tool.args), details = object(object(tool.result).details);
  const patchPath = /^\[([^\n]+)#[a-f\d]{4}\]/i.exec(string(args.input).trimStart())?.[1];
  const fallback = string(args.path) || string(details.path) || string(details.resolvedPath) || patchPath || '';
  const perFile = list(details.perFileResults);
  const output = resultText(tool.result);
  const unified = string(details.diff) || string(details.patch) || output;
  if (!perFile.length && /^diff --git /m.test(unified)) {
    return unified.split(/(?=^diff --git )/m).filter(section => /^diff --git /m.test(section)).flatMap(diff => {
      const target = /^\+\+\+ (.+)$/m.exec(diff)?.[1], source = /^--- (.+)$/m.exec(diff)?.[1];
      const decode = (value: string) => { try { return value.startsWith('\"') ? JSON.parse(value) as string : value; } catch { return value; } };
      const path = target === '/dev/null' ? source : target;
      return path ? [{ path: decode(path).replace(/^[ab]\//, ''), diff, hasDiff: true, op: target === '/dev/null' ? 'delete' : source === '/dev/null' ? 'create' : 'update' }] : [];
    });
  }
  const input = string(args.patch) || string(args.input);
  if (!perFile.length && details.diff === undefined && /^(?:\*\*\* (?:Add|Update|Delete) File:)/m.test(input)) {
    return input.split(/(?=^\*\*\* (?:Add|Update|Delete) File:)/m).flatMap(section => {
      const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/m.exec(section);
      if (!header) return [];
      const body = section.split('\n').filter(line => /^[+ -]/.test(line));
      const removed = body.filter(line => line[0] !== '+').length, added = body.filter(line => line[0] !== '-').length;
      const diff = body.length ? `@@ -${removed ? 1 : 0},${removed} +${added ? 1 : 0},${added} @@\n${body.join('\n')}` : '';
      return [{ path: header[2], diff, hasDiff: header[1] !== 'Delete' || body.length > 0, op: header[1] === 'Add' ? 'create' : header[1] === 'Delete' ? 'delete' : 'update', move: /^\*\*\* Move to: (.+)$/m.exec(section)?.[1] }];
    });
  }
  // Only literal shell targets are attributable. Never expand globs, variables or arbitrary scripts.
  if (toolFamily(tool) === 'command' && details.diff === undefined && details.patch === undefined) {
    const files: FileDiff[] = []; let cwd = string(args.cwd);
    const tokens = string(args.command).match(/'(?:[^']*)'|"(?:[^"\\]|\\.)*"|&&|;|[^\s;]+/g) ?? [];
    let command: string[] = [];
    const consume = () => {
      const words = command.map(word => word.replace(/^(['"])(.*)\1$/, '$2')); command = [];
      const name = words[0];
      const target = (value: string) => value.startsWith('/') || !cwd ? value : `${cwd.replace(/\/$/, '')}/${value}`;
      if (name === 'cd' && words.length === 2 && !/[$*?`]/.test(words[1])) { cwd = target(words[1]); return; }
      if (name === 'rm' && !words.some(word => /^-[^-]*r/.test(word) || word === '--recursive')) {
        for (const value of words.slice(1).filter(value => !value.startsWith('-') && !/[$*?`]/.test(value))) files.push({ path: target(value), op: 'delete', diff: '', hasDiff: false });
      } else if (name === 'mv' && words.length === 3 && words.slice(1).every(value => !value.startsWith('-') && !/[$*?`]/.test(value))) files.push({ path: target(words[1]), move: target(words[2]), diff: '', hasDiff: true });
      else if (name === 'sed' && words.includes('-i')) {
        const at = words.indexOf('-i'), rest = words.slice(at + 1);
        if (rest[0] === '') rest.shift();
        if (rest.length >= 2 && /^[sy]([^a-zA-Z0-9\s]).+/.test(rest[0])) for (const value of rest.slice(1).filter(value => !value.startsWith('-') && !/[$*?`]/.test(value))) files.push({ path: target(value), op: 'update', diff: '', hasDiff: false });
      }
    };
    for (const token of tokens) { if (token === '&&' || token === ';') consume(); else command.push(token); } consume();
    if (files.length) return files;
  }
  const carriers = perFile.length ? perFile : Array.isArray(details.files) ? details.files : [details];
  return carriers.map(value => {
    const file = object(value);
    const recorded = [file.diff, file.patch, object(file.details).diff].find(value => typeof value === 'string');
    const outputDiff = /^(?:@@ -\d+|[+-]\s*\d+\|)/m.test(output) ? output : undefined;
    const diff = typeof recorded === 'string' ? recorded : outputDiff ?? '';
    const first = parseNumberedDiff(diff).rows.find(row => row.sign === '+' || row.sign === '-');
    const diagnostics = file.diagnostics ?? (carriers.length === 1 || string(file.path) === fallback ? details.diagnostics : undefined);
    return { path: string(file.path) || fallback, sourcePath: string(file.sourcePath), diff, hasDiff: recorded !== undefined || outputDiff !== undefined, op: string(file.op) || (tool.name === 'delete' ? 'delete' : ''), move: string(file.move) || (tool.name === 'move' ? string(args.destination) : ''), oldText: typeof file.oldText === 'string' ? file.oldText : undefined, newText: typeof file.newText === 'string' ? file.newText : undefined, firstChangedLine: positive(file.firstChangedLine) ?? first?.newNo ?? first?.oldNo, isError: file.isError === true, errorText: string(file.errorText), ...(diagnostics !== undefined ? { diagnostics: parseDiagnostics(diagnostics) } : {}) };
  });
}

export interface GrepGroup { path: string; lines: { number: number | null; text: string; match: boolean }[] }
export function parseGrepDisplay(source: string, fallbackPath = ''): GrepGroup[] {
  const groups: GrepGroup[] = [];
  let directory = '', current: GrepGroup | undefined;
  const start = (path: string) => { current = { path: path.replace(/#[a-f\d]{4}$/i, ''), lines: [] }; groups.push(current); };
  for (const line of source.split('\n')) {
    if (line.startsWith('# ')) { directory = line.slice(2).trim(); current = undefined; continue; }
    if (line.startsWith('## ')) { const name = line.slice(3).trim(); start(directory ? `${directory.replace(/\/$/, '')}/${name}` : name); continue; }
    const header = /^\[(.+)#[a-f\d]{4}\]$/i.exec(line);
    if (header) { start(header[1]); continue; }
    const row = /^([* ])?\s*(\d+)\s*[│:](.*)$/.exec(line);
    if (row) { if (!current) start(fallbackPath || directory); current!.lines.push({ number: Number(row[2]), text: row[3], match: row[1] === '*' }); }
    else if (/^\s*│\s*\.{3}/.test(line) && current) current.lines.push({ number: null, text: '…', match: false });
  }
  return groups.filter(group => group.lines.length);
}
const descriptions = new WeakMap<ToolActivity, ToolSummary>();
export function describeTool(tool: ToolActivity): ToolSummary {
  const cached = descriptions.get(tool);
  if (cached) return cached;
  const args = object(tool.args), result = object(tool.result), details = object(result.details), family = toolFamily(tool);
  const summary: ToolSummary = { family, verbKey: `tools.verb.${family}`, intent: string(args.i).trim() || undefined, chips: [] };
  const add = (kind: ToolChip['kind'], value: unknown, tone?: ToolChip['tone']) => { if ((typeof value === 'number' && Number.isFinite(value) && value !== 0) || (typeof value === 'string' && value.trim() && value !== '0')) summary.chips.push({ kind, value: value as number | string, ...(tone ? { tone } : {}) }); };
  const path = string(args.path) || string(details.path) || string(object(object(details.meta).source).value) || string(details.resolvedPath);
  if (family === 'read' || family === 'write' || family === 'edit') {
    const edited = family === 'edit' ? editFiles(tool)[0] : undefined;
    const target = edited?.path || path;
    if (target) { summary.file = parseFileTarget(target); if (edited?.firstChangedLine) { summary.file.line = edited.firstChangedLine; summary.file.endLine = undefined; } summary.target = formatFileTarget({ ...summary.file, path: basename(summary.file.path) }); summary.targetTitle = target; }
  }
  switch (family) {
    case 'read': { const display = readDisplay(result); if (!display.image) add('lines', display.lineNumbers ? display.lineNumbers.filter(n => n !== null).length : details.displayContent !== undefined ? (display.text ? display.text.replace(/\n$/, '').split('\n').length : 0) : details.totalLines); break; }
    case 'edit': { let added = 0, removed = 0, issues = 0, errored = false; for (const file of editFiles(tool)) { const parsed = parseNumberedDiff(file.diff); added += parsed.added; removed += parsed.removed; issues += file.diagnostics?.messages.length ?? 0; errored ||= file.diagnostics?.errored === true; } add('added', added, 'success'); add('removed', removed, 'error'); add('diagnostics', issues, errored ? 'error' : 'warning'); break; }
    case 'write': { const content = string(args.content); if (content) add('lines', content.replace(/\n$/, '').split('\n').length); else add('bytes', details.bytes ?? /Successfully wrote (\d+) bytes/.exec(resultText(result))?.[1]); break; }
    case 'command': { const command = string(args.command) || string(details.command); summary.target = command.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 120); summary.targetTitle = command; if (args.async === true || details.async) add('background', 'background'); break; }
    case 'eval': { const cell = object(list(details.cells)[0]); summary.target = string(args.title) || string(args.code).split('\n').find(line => line.trim())?.trim().slice(0, 120) || string(cell.code).split('\n').find(line => line.trim())?.trim().slice(0, 120) || string(cell.title); break; }
    case 'search': summary.target = string(args.pattern); if (path) summary.target += `${summary.target ? ' · ' : ''}${basename(path)}`; add('matches', details.matchCount); add('files', details.fileCount); break;
    case 'find': summary.target = string(args.pattern) || path; add('files', details.fileCount ?? (Array.isArray(details.files) ? details.files.length : undefined)); break;
    case 'web': summary.target = string(args.query) || string(args.url) || path; add('sources', list(object(details.response).sources).length); break;
    case 'message': { summary.peer = path.slice(8); summary.target = summary.peer; for (const receipt of list(object(details.message).receipts)) add('outcome', string(object(receipt).outcome)); break; }
    case 'lsp': {
      let deviceArgs = object(object(details.xdev).args);
      if (!Object.keys(deviceArgs).length && path.startsWith('xd://')) {
        try { deviceArgs = object(JSON.parse(string(args.content))); } catch { /* Malformed device input remains available in raw data. */ }
      }
      summary.target = [string(args.action) || string(deviceArgs.action) || string(args.method) || string(deviceArgs.method), basename(string(args.file) || string(deviceArgs.file) || string(deviceArgs.path))].filter(Boolean).join(' · ');
      break;
    }
    case 'wait': { summary.target = summary.intent; const jobs = list(details.jobs).map(object); add('jobs', jobs.filter(job => job.status === 'completed').length, 'success'); add('jobs', jobs.filter(job => job.status === 'failed').length, 'error'); break; }
    case 'todo': { summary.target = [string(args.op) || string(details.op), string(args.task) || string(args.content)].filter(Boolean).join(' · '); const tasks = list(details.phases).flatMap(phase => list(object(phase).tasks)).map(object); if (tasks.length) add('todo', `${tasks.filter(task => task.status === 'completed').length}/${tasks.length}`); break; }
    case 'task': summary.target = list(args.tasks).length ? String(list(args.tasks).length) : string(args.agent) || string(args.name); break;
    case 'ask': summary.target = string(args.question) || string(object(list(args.questions)[0]).question); break;
    case 'browser': case 'computer': summary.target = [string(args.action), string(args.url) || string(details.url) || string(args.name) || string(details.name)].filter(Boolean).join(' · '); break;
    case 'other': summary.target = path.startsWith('xd://') ? path.slice(5) : tool.name; break;
  }
  if (family === 'command' || family === 'eval') {
    add('exit', details.exitCode, 'error');
    const cells = list(details.cells).map(object);
    if (details.exitCode === undefined) for (const cell of cells) add('exit', cell.exitCode, 'error');
    const duration = positive(details.wallTimeMs) ?? (cells.length ? cells.reduce((sum, cell) => sum + (positive(cell.durationMs) ?? 0), 0) : undefined);
    if (duration && duration >= 1000) add('duration', duration);
  }
  add('images', resultImages(result).length);
  descriptions.set(tool, summary);
  return summary;
}

/** Native coordination carriers, not tool success, determine delivery and settlement. */
export function messageReceipts(tool: ToolActivity): Record<string, unknown>[] {
  const details = object(object(tool.result).details);
  return list(object(details.message).receipts ?? details.receipts).map(object);
}
export function firstLine(value: unknown): string {
  const line = string(value).split('\n').find(line => line.trim())?.trim() || '';
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}
export function receiptOutcome(receipt: Record<string, unknown>, t: TFunction): string {
  const outcome = string(receipt.outcome), reason = string(receipt.error) || string(receipt.reason);
  return [t(`tools.outcome.${outcome}`, { defaultValue: outcome }), reason].filter(Boolean).join('：');
}
function namedStatus(value: Record<string, unknown>, t: TFunction): string {
  const name = string(value.label) || string(value.name) || string(value.id) || string(value.jobId);
  const state = string(value.status) || string(value.state);
  return [name, state && t(`tools.status.${state}`, { defaultValue: state })].filter(Boolean).join(' ');
}
function waitOutcome(tool: ToolActivity, t: TFunction): string {
  const details = object(object(tool.result).details), waited = object(details.waited);
  if (string(waited.from)) return t('tools.step.received', { name: string(waited.from), preview: firstLine(waited.body) });
  const jobs = list(details.jobs).map(object);
  if (jobs.length) return jobs.map(job => job.status === 'running' ? `${string(job.label) || string(job.id)} ${t('tools.step.stillRunning')}` : namedStatus(job, t)).join(' · ');
  const output = resultText(tool.result);
  if (details.timedOut === true || /^(?:Timed out|Timeout|Wait timed out|Wait limit reached)/i.test(output)) return t('tools.step.waitTimeout');
  if (tool.status === 'interrupted' || details.interrupted === true || /^Interrupted/i.test(output)) return t('tools.step.waitInterrupted');
  if (/^A service finished\./.test(output)) return t('tools.step.serviceFinished');
  return '';
}
/** Compact subject/object wording shared by rows and the live current-step control. */
export function semanticToolLabel(tool: ToolActivity, t: TFunction): string | undefined {
  const args = object(tool.args), details = object(object(tool.result).details), path = string(args.path) || string(object(object(details.meta).source).value) || string(details.resolvedPath);
  const name = tool.name.split('/').at(-1)!.split('.').at(-1)!, op = string(args.op);
  const outcome = (title: string, value: string) => [title, value].filter(Boolean).join(' · ');
  if (name === 'write' && path.startsWith('agent://') || name === 'hub' && op === 'send') {
    const peer = path.startsWith('agent://') ? path.slice(8) : string(args.to);
    const receipts = messageReceipts(tool), preview = firstLine(args.content ?? args.message);
    const parent = peer === 'parent' || peer === 'main' || peer === 'Main' || peer === string(details.parentId) || receipts.some(receipt => receipt.recipientRole === 'parent');
    const title = t(peer === 'all' ? receipts.length ? 'tools.step.broadcast' : 'tools.step.broadcastUnknown' : parent ? 'tools.step.sendParent' : 'tools.step.send', { name: peer, count: receipts.length, preview });
    return outcome(title, peer === 'all' ? '' : receipts.map(receipt => receiptOutcome(receipt, t)).join(' · '));
  }
  if (name === 'wait' || name === 'hub' && op === 'wait') return outcome(t('tools.step.wait'), waitOutcome(tool, t));
  if (path.startsWith('proc://') || name === 'hub' && ['start', 'stop', 'restart', 'cancel', 'logs', 'describe', 'ps', 'jobs'].includes(op)) {
    const proc = object(details.proc), carrier = Object.keys(proc).length ? proc : details;
    const [id, action] = path.slice(7).split('/'), control = name === 'hub' ? op : name === 'read' ? 'describe' : action || 'input';
    const target = name === 'hub' ? string(args.name) || list(args.ids).map(string).join('、') : id;
    const key = control === 'kill' || control === 'stop' ? 'stop' : control === 'cancel' ? 'cancel' : control === 'logs' ? 'logs' : ['start', 'restart', 'input', 'mode'].includes(control) ? control : 'inspect';
    const daemon = object(carrier.daemon), job = object(carrier.job);
    const state = string(daemon.state) || string(job.status);
    const stopped = key === 'stop' && ['exited', 'stopped', 'failed'].includes(state) && tool.status === 'complete';
    const status = stopped ? t('tools.status.stopped') : state ? t(`tools.status.${state}`, { defaultValue: state }) : list(carrier.jobs).map(object).map(job => namedStatus(job, t)).join(' · ');
    return outcome(target ? t(`tools.step.proc.${key}`, { name: target }) : t('tools.step.proc.list'), status || list(carrier.daemons).map(object).map(daemon => namedStatus(daemon, t)).join(' · '));
  }
  if (name === 'read' && /\.(?:db|sqlite|sqlite3)(?:[:?]|$)/i.test(path)) {
    const query = path.split('?q=')[1];
    if (query) {
      let decoded = query;
      try { decoded = decodeURIComponent(query); } catch { /* Keep malformed native selectors literal. */ }
      return t('tools.step.query', { name: basename(path.split('?')[0]), query: firstLine(decoded).slice(0, 72) });
    }
  }
  if (name === 'read' && path.includes('://')) {
    const [scheme, target] = path.split('://');
    if (['agent', 'artifact', 'local', 'history', 'skill', 'xd'].includes(scheme)) return t(`tools.step.read.${scheme}`, { name: target });
  }
  if (name === 'todo') {
    const phases = list(details.phases), tasks = phases.flatMap(phase => list(object(phase).tasks)).map(object);
    const planned = list(args.list);
    const title = op === 'init' ? t('tools.step.todoInit', { phases: phases.length || planned.length, count: phases.length ? tasks.length : planned.flatMap(phase => list(object(phase).items)).length }) : t(`tools.step.todo.${op}`, { defaultValue: t('tools.verb.todo'), item: string(args.task) || string(args.content) });
    return outcome(title, tasks.length ? t('tools.todoProgress', { done: tasks.filter(task => task.status === 'completed').length, total: tasks.length }) : '');
  }
  if (name === 'task') {
    const tasks = list(args.tasks).map(object);
    return t('tools.step.task', { count: tasks.length, names: tasks.map(task => string(task.id) || string(task.name) || string(task.agent)).filter(Boolean).join('、') });
  }
  if (name === 'yield') return t('tools.step.yield');
  if (name === 'advise') return outcome(t('tools.step.advise'), firstLine(args.question ?? args.prompt));
  if (name === 'goal') return t(`tools.step.goal.${op || 'set'}`, { defaultValue: t('tools.step.goal.set', { preview: firstLine(args.objective ?? args.goal) }), preview: firstLine(args.objective ?? args.goal ?? object(details.goal).objective) });
  if (name === 'ask') {
    const answers = list(details.results).map(object);
    const selected = answers.flatMap(answer => list(answer.selectedOptions).map(value => typeof value === 'number' ? string(list(answer.options)[value]) : string(value))).filter(Boolean);
    if (selected.length) return t('tools.step.selected', { options: selected.join('、') });
    const custom = answers.map(answer => string(answer.customInput)).filter(Boolean);
    if (custom.length) return t('tools.step.answered', { preview: firstLine(custom.join('；')) });
    const receipt = resultText(tool.result);
    const selectedReceipt = /^User selected:\s*(.+)$/m.exec(receipt)?.[1];
    if (selectedReceipt) return t('tools.step.selected', { options: selectedReceipt });
    const customReceipt = /^User provided custom input:\s*(.+)$/m.exec(receipt)?.[1];
    if (customReceipt) return t('tools.step.answered', { preview: firstLine(customReceipt) });
    return t('tools.step.ask', { question: string(args.question) || list(args.questions).map(value => string(object(value).question)).join('；') });
  }
  if (name === 'write' && path.startsWith('xd://')) {
    const device = path.slice(5).split('/')[0];
    let input = object(object(details.xdev).args);
    if (!Object.keys(input).length) try { input = object(JSON.parse(string(args.content))); } catch { /* Literal malformed input remains in details. */ }
    const action = string(input.action) || string(input.op) || string(input.method);
    return [t(`tools.device.${device}`, { defaultValue: device }), action && t(`tools.operation.${action}`, { defaultValue: action })].filter(Boolean).join('：');
  }
  if (tool.name.startsWith('mcp__')) return ['MCP', ...tool.name.slice(5).split('__')].join(' · ');
  if (name === 'hub') return t(`tools.step.hub.${op}`, { defaultValue: t('tools.step.proc.manage', { name: string(args.name) }) });
  return undefined;
}
export function toolStepLabel(tool: ToolActivity, t: TFunction): string {
  const summary = describeTool(tool);
  return semanticToolLabel(tool, t) ?? [t(summary.verbKey), summary.target || `· ${t(tool.status === 'pending' ? 'tools.argumentsPending' : tool.args === undefined ? 'tools.argumentsUnloaded' : 'tools.argumentsMissing')}`].join(' ');
}
export function nativeActivityLabel(raw: Record<string, unknown>, t: TFunction, supplied?: NativeAsyncDelivery): string | undefined {
  const details = object(raw.details);
  if (raw.customType === 'irc:incoming') return t('tools.step.incoming', { name: string(details.from) || string(raw.from), preview: firstLine(details.message ?? details.body) });
  if (raw.customType === 'launch-completion') return list(details.daemons).map(object).map(daemon => typeof daemon.exitCode === 'number' ? t('tools.step.processExit', { name: string(daemon.name) || string(daemon.id), code: daemon.exitCode }) : t('tools.step.processState', { name: string(daemon.name) || string(daemon.id), state: t(`tools.status.${string(daemon.state)}`, { defaultValue: string(daemon.state) }) })).join(' · ');
  const delivery = supplied ?? parseNativeAsyncDelivery(raw);
  if (delivery?.jobs.length) return t('tools.step.async', { count: delivery.jobs.length, jobs: delivery.jobs.map(job => { const native = object(job.raw); const state = job.status !== 'unknown' ? job.status : !job.ambiguous && typeof native.exitCode === 'number' ? native.exitCode === 0 ? 'completed' : 'failed' : 'unknown'; return namedStatus({ id: job.id, label: job.label, status: state }, t); }).join('、') });
  return undefined;
}
