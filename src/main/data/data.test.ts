import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryIndex, parseSessionPrefix } from './history';
import { PreferenceStore, validatePreferences } from './preferences';
import { resolveHistoryRoots } from './roots';
import { redactSettings, serializeSetting } from './settings';

const jsonl = (...values: unknown[]) => `${values.map(value => JSON.stringify(value)).join('\n')}\n`;

test('native title slot and authoritative header cwd survive colliding bucket names and partial append', () => {
  const header = { type: 'session', id: 'native-id', cwd: '/actual/workspace', timestamp: '2026-01-01T00:00:00Z', title: 'Header title' };
  const content = jsonl({ type: 'title', v: 1, title: 'Renamed title' }, header, { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'excluded' }, { type: 'text', text: 'Find  the\n bug' }] } }) + '{"type":"message"';
  const summary = parseSessionPrefix(content, '/sessions/misleading-bucket/session.jsonl', '2026-02-01T00:00:00Z');
  assert.equal(summary?.cwd, '/actual/workspace');
  assert.equal(summary?.title, 'Renamed title');
  assert.equal(summary?.preview, 'Find the bug');
  assert.equal(parseSessionPrefix(jsonl(header), '/session.jsonl', '')?.title, 'Header title');
  assert.throws(() => parseSessionPrefix(jsonl({ ...header, cwd: 'relative' }), '/bad.jsonl', ''), /header/);
});

test('native profiles select existing profile XDG roots and registry without indexing subagent artifacts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omp-desktop-history-'));
  try {
    const cwd = join(home, 'work');
    const data = join(home, 'data');
    const state = join(home, 'state');
    await mkdir(cwd);
    await mkdir(join(data, 'omp'), { recursive: true });
    const context = { executable: '/unused', cwd, profile: 'work', env: { HOME: home, XDG_DATA_HOME: data, XDG_STATE_HOME: state, PI_CODING_AGENT_DIR: '/ignored' } };
    assert.equal((await resolveHistoryRoots(context)).sessions, join(home, '.omp', 'profiles', 'work', 'agent', 'sessions'));
    const sessions = join(data, 'omp', 'profiles', 'work', 'sessions');
    const registry = join(state, 'omp', 'profiles', 'work', 'custom-session-files');
    await mkdir(join(sessions, 'bucket', 'artifact'), { recursive: true });
    await mkdir(registry, { recursive: true });
    const roots = await resolveHistoryRoots(context);
    assert.equal(roots.blobs, join(data, 'omp', 'profiles', 'work', 'blobs'));
    assert.equal(roots.terminals, join(state, 'omp', 'profiles', 'work', 'terminal-sessions'));
    const native = join(sessions, 'bucket', 'native.jsonl');
    const external = join(home, 'external-session');
    await writeFile(native, jsonl({ type: 'session', id: 'native', cwd }, { type: 'message', message: { role: 'user', content: 'needle in preview' } }));
    await writeFile(external, jsonl({ type: 'title', title: 'External title' }, { type: 'session', id: 'external', cwd }));
    await writeFile(join(sessions, 'bucket', 'artifact', 'child.jsonl'), jsonl({ type: 'session', id: 'child', cwd }));
    await writeFile(join(sessions, 'bucket', 'unregistered-extensionless'), jsonl({ type: 'session', id: 'unregistered', cwd }));
    await writeFile(join(registry, 'marker'), external);
    const index = new HistoryIndex();
    assert.deepEqual((await index.list(context)).sessions.map(item => item.id).sort(), ['external', 'native']);
    assert.deepEqual((await index.list(context, { query: 'needle' })).sessions.map(item => item.id), ['native']);
    assert.deepEqual((await index.list(context, { cwd: join(home, 'other') })).sessions, []);
    assert.equal(await readFile(join(registry, 'marker'), 'utf8'), external);
    await writeFile(join(registry, 'bad-marker'), '../not-native.jsonl');
    const damaged = await index.list(context);
    assert.deepEqual(damaged.sessions.map(item => item.id).sort(), ['external', 'native']);
    assert.equal(damaged.diagnostics[0]?.path, join(registry, 'bad-marker'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('history canonicalizes existing workspace aliases while retaining unavailable header cwd', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omp-desktop-workspace-identity-'));
  try {
    const cwd = join(home, 'workspace');
    const alias = join(home, 'workspace-alias');
    const missing = join(home, 'removed-workspace');
    const bucket = join(home, '.omp', 'agent', 'sessions', 'unrelated-bucket');
    await mkdir(cwd);
    await symlink(cwd, alias, 'dir');
    await mkdir(bucket, { recursive: true });
    const canonical = await realpath(cwd);
    await writeFile(join(bucket, 'alias.jsonl'), jsonl({ type: 'session', id: 'alias', cwd: alias }));
    await writeFile(join(bucket, 'canonical.jsonl'), jsonl({ type: 'session', id: 'canonical', cwd: canonical }));
    await writeFile(join(bucket, 'missing.jsonl'), jsonl({ type: 'session', id: 'missing', cwd: missing }));
    const context = { executable: '/unused', cwd, env: { HOME: home } };
    const index = new HistoryIndex();
    const { sessions: rows } = await index.list(context);
    assert.equal(rows.find(row => row.id === 'alias')?.cwd, canonical);
    assert.equal(rows.find(row => row.id === 'canonical')?.cwd, canonical);
    assert.equal(rows.find(row => row.id === 'missing')?.cwd, missing);
    assert.deepEqual((await index.list(context, { cwd: alias })).sessions.map(row => row.id).sort(), ['alias', 'canonical']);
    assert.deepEqual((await index.list(context, { cwd: missing })).sessions.map(row => row.id), ['missing']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('directory-only dotenv precedence and explicit empty canonical profile match native selection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omp-desktop-roots-'));
  try {
    const cwd = join(home, 'work');
    await mkdir(cwd);
    await writeFile(join(home, '.env'), 'PI_CODING_AGENT_DIR=home-root\n');
    await writeFile(join(cwd, '.env'), 'OMP_CODING_AGENT_DIR=project-root\n');
    const context = { executable: '/unused', cwd, env: { HOME: home, OMP_PROFILE: '', PI_PROFILE: 'other' } };
    assert.equal((await resolveHistoryRoots(context)).sessions, join(cwd, 'project-root', 'sessions'));
    assert.equal((await resolveHistoryRoots({ ...context, env: { ...context.env, PI_CODING_AGENT_DIR: 'shell-root' } })).sessions, join(cwd, 'shell-root', 'sessions'));
    await assert.rejects(resolveHistoryRoots({ ...context, profile: '../other' }), /profile/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('desktop theme preferences accept only native theme sources', () => {
  for (const theme of ['dark', 'light', 'system']) {
    assert.equal(validatePreferences({ theme }).theme, theme);
  }
  for (const theme of ['auto', 'Dark', '', ' dark ', null, undefined, true, 0, {}, ['dark']]) {
    assert.throws(() => validatePreferences({ theme }), /Invalid desktop preference: theme/);
  }
});

test('desktop preference saves merge concurrent patches and reject corrupt or out-of-bound input without replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-desktop-prefs-'));
  try {
    const store = new PreferenceStore(directory);
    await Promise.all([store.set({ theme: 'dark' }), store.set({ language: 'en' })]);
    assert.equal((await store.get()).theme, 'dark');
    assert.equal((await store.get()).language, 'en');
    await store.set({ panelWidth: 1 });
    assert.equal((await store.get()).panelWidth, 1);
    await store.set({ panelWidth: 244 });
    assert.equal((await store.get()).panelWidth, 244);
    await store.set({ panelWidth: 2048.5 });
    assert.equal((await store.get()).panelWidth, 2048.5);
    assert.equal(validatePreferences({ panelWidth: Number.MAX_SAFE_INTEGER }).panelWidth, Number.MAX_SAFE_INTEGER);
    assert.throws(() => validatePreferences({ panelWidth: 0 }), /Invalid/);
    assert.throws(() => validatePreferences({ panelWidth: Number.MAX_SAFE_INTEGER + 1 }), /Invalid/);
    assert.throws(() => validatePreferences({ panelWidth: Infinity }), /Invalid/);
    await store.set({ chatContentWidth: 1032.5 });
    assert.equal((await new PreferenceStore(directory).get()).chatContentWidth, 1032.5);
    assert.equal(validatePreferences({ chatContentWidth: 360 }).chatContentWidth, 360);
    assert.equal(validatePreferences({ chatContentWidth: 1600 }).chatContentWidth, 1600);
    for (const chatContentWidth of [359, 1601, Number.NaN, Infinity, '760']) {
      assert.throws(() => validatePreferences({ chatContentWidth }), /Invalid desktop preference: chatContentWidth/);
    }
    assert.throws(() => validatePreferences({ fontSize: Number.NaN }), /Invalid/);
    assert.throws(() => validatePreferences({ recentWorkspaces: Array.from({ length: 41 }, (_, index) => `/workspace/${index}`) }), /Invalid/);
    assert.throws(() => validatePreferences({ apiKey: 'not-a-desktop-preference' }), /Unknown/);
    const path = join(directory, 'desktop-preferences.json');
    await writeFile(path, '{invalid');
    await assert.rejects(store.set({ theme: 'light' }), /Invalid desktop preferences JSON/);
    assert.equal(await readFile(path, 'utf8'), '{invalid');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workspace preferences unify existing aliases without losing distinct or unavailable folders or rewriting reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-desktop-workspace-prefs-'));
  try {
    const workspace = join(directory, 'workspace');
    const distinct = join(directory, 'distinct');
    const alias = join(directory, 'alias');
    const offline = join(directory, 'offline', 'workspace');
    const broken = join(directory, 'broken');
    await mkdir(workspace);
    await mkdir(distinct);
    await symlink(workspace, alias, 'dir');
    await symlink(offline, broken, 'dir');
    const canonical = await realpath(workspace);
    const canonicalDistinct = await realpath(distinct);
    const path = join(directory, 'desktop-preferences.json');
    const original = JSON.stringify({ lastWorkspace: alias, recentWorkspaces: [alias, canonical, distinct, offline, broken] });
    await writeFile(path, original);
    const store = new PreferenceStore(directory);
    const loaded = await store.get();
    assert.equal(loaded.lastWorkspace, canonical);
    assert.deepEqual(loaded.recentWorkspaces, [canonical, canonicalDistinct, offline, broken]);
    assert.equal(await readFile(path, 'utf8'), original);
    const saved = await store.set({ lastWorkspace: alias, recentWorkspaces: [offline, alias, canonical, distinct, broken] });
    assert.equal(saved.lastWorkspace, canonical);
    assert.deepEqual(saved.recentWorkspaces, [offline, canonical, canonicalDistinct, broken]);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(persisted.lastWorkspace, canonical);
    assert.deepEqual(persisted.recentWorkspaces, saved.recentWorkspaces);
    await store.set({ lastWorkspace: offline });
    assert.equal((await store.get()).lastWorkspace, offline);
    await store.set({ lastWorkspace: '' });
    assert.equal((await store.get()).lastWorkspace, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('credential classification strips values even when unset, omitted, nested or native redaction is missing', () => {
  const entries = redactSettings({
    'auth.broker.token': { type: 'string', description: 'token', value: '' },
    'images.urls.credentials': { type: 'record', description: 'credentials', value: { destination: { secret: 'never-render' } } },
    'new.native.secret': { type: 'string', description: 'new', redacted: true },
    'ordinary': { type: 'number', description: 'ordinary', value: 3 },
  });
  assert.equal(entries.find(entry => entry.key === 'auth.broker.token')?.credential, true);
  assert.equal(entries.find(entry => entry.key === 'auth.broker.token')?.redacted, false);
  assert.equal(entries.find(entry => entry.key === 'searxng.token')?.credential, true);
  assert.equal(entries.find(entry => entry.key === 'images.urls.credentials')?.redacted, true);
  for (const entry of entries.filter(entry => entry.credential)) assert.equal(Object.hasOwn(entry, 'value'), false);
  assert.equal(JSON.stringify(entries).includes('never-render'), false);
  assert.equal(entries.find(entry => entry.key === 'ordinary')?.value, 3);
  assert.throws(() => serializeSetting(entries.find(entry => entry.key === 'auth.broker.token')!, 'secret'), /credentials/);
  assert.equal(serializeSetting({ key: 'ordinary', type: 'string', description: '' }, '  true  '), '"  true  "');
  assert.throws(() => serializeSetting({ key: 'ordinary', type: 'boolean', description: '' }, 'true'), /expected boolean/);
});

test('native record and array settings serialize sanitized null-prototype IPC objects', () => {
  const item: Record<string, string | number> = Object.create(null);
  item.provider = 'local';
  item.limit = 8;
  const entry = { key: 'ordinary', type: 'record', description: '' };
  assert.deepEqual(JSON.parse(serializeSetting(entry, { nested: item })), { nested: { provider: 'local', limit: 8 } });
  assert.deepEqual(JSON.parse(serializeSetting(entry, item)), { provider: 'local', limit: 8 });
  assert.deepEqual(JSON.parse(serializeSetting({ ...entry, type: 'array' }, [item])), [{ provider: 'local', limit: 8 }]);
  item.limit = Infinity;
  assert.throws(() => serializeSetting(entry, item), /finite JSON/);
  delete item.limit;
  Object.defineProperty(item, 'constructor', { value: 'unsafe', enumerable: true });
  assert.throws(() => serializeSetting(entry, item), /Unsafe setting key/);
  const customPrototype: Record<string, string> = Object.create({ inherited: true });
  customPrototype.provider = 'local';
  assert.throws(() => serializeSetting(entry, customPrototype), /finite JSON/);
});

test('negative numeric settings remain positional CLI arguments and preserve their values', () => {
  const entry = { key: 'ordinary', type: 'number', description: '' };
  const negative = serializeSetting(entry, -1);
  assert.equal(negative.startsWith('-'), false);
  assert.equal(Number(negative.trim()), -1);
  assert.equal(Object.is(Number(serializeSetting(entry, -0).trim()), -0), true);
});
