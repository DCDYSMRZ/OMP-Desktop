import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferenceStore, validatePreferences } from './preferences';

test('notification preference defaults on for old stores and persists explicit opt-out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-notifications-'));
  try {
    await writeFile(join(directory, 'desktop-preferences.json'), JSON.stringify({ language: 'en' }));
    const store = new PreferenceStore(directory);
    assert.equal((await store.get()).notifications, true);
    await store.set({ notifications: false });
    assert.equal((await new PreferenceStore(directory).get()).notifications, false);
    await store.set({ fontSize: 18 });
    assert.equal((await store.get()).notifications, false);
    await store.set({ notifications: true });
    assert.equal((await new PreferenceStore(directory).get()).notifications, true);
    for (const notifications of [null, undefined, 0, 1, 'true', 'false', {}, []]) assert.throws(() => validatePreferences({ notifications }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preferred editor persists only supported choices and defaults old stores to system', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-editor-'));
  try {
    await writeFile(join(directory, 'desktop-preferences.json'), JSON.stringify({ language: 'en' }));
    const store = new PreferenceStore(directory);
    assert.equal((await store.get()).preferredEditor, 'system');
    for (const preferredEditor of ['vscode', 'cursor', 'zed', 'system'] as const) {
      await store.set({ preferredEditor });
      assert.equal((await new PreferenceStore(directory).get()).preferredEditor, preferredEditor);
    }
    for (const preferredEditor of [null, undefined, 0, true, 'code', 'VSCode', '', 'cursor ', {}, []]) assert.throws(() => validatePreferences({ preferredEditor }), /Invalid desktop preference/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('display preferences migrate old stores, validate choices and persist independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-display-'));
  try {
    await writeFile(join(directory, 'desktop-preferences.json'), JSON.stringify({ language: 'en' }));
    const store = new PreferenceStore(directory);
    assert.equal((await store.get()).messageMeta, 'always');
    assert.equal((await store.get()).durationStyle, 'units');
    await store.set({ messageMeta: 'hover', durationStyle: 'clock' });
    await store.set({ fontSize: 18 });
    const persisted = await new PreferenceStore(directory).get();
    assert.equal(persisted.messageMeta, 'hover');
    assert.equal(persisted.durationStyle, 'clock');
    for (const value of [null, undefined, false, 0, '', 'ALWAYS', {}, []]) {
      assert.throws(() => validatePreferences({ messageMeta: value }));
      assert.throws(() => validatePreferences({ durationStyle: value }));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
