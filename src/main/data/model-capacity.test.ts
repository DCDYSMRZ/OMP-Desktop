import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCapacityResolver, capacityModels, remoteCompactionCapabilities } from './model-capacity';

test('runtime wins over persisted catalog and read-only config; credentials never persist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-capacity-'));
  try {
    const cache = join(directory, 'catalog.json');
    const config = 'providers:\n  p:\n    apiKey: secret\n    headers: { Authorization: secret }\n    models:\n      - id: m\n        name: Config model\n        contextWindow: 1000000\n        apiKey: secret\n';
    await writeFile(join(directory, 'models.yml'), config);
    const resolver = new ModelCapacityResolver(cache, directory);
    assert.deepEqual(await resolver.resolve('p', 'm'), { provider: 'p', id: 'm', name: 'Config model', contextWindow: 1000000, windowSource: 'config' });
    assert.equal(await resolver.resolve('p', 'unknown'), undefined);
    await resolver.capture([{ provider: 'p', id: 'm', name: 'Runtime model', contextWindow: 200000, apiKey: 'secret', headers: { Authorization: 'secret' } }]);
    assert.equal((await resolver.resolve('p', 'm'))?.windowSource, 'runtime');
    const persisted = new ModelCapacityResolver(cache, directory);
    assert.equal((await persisted.resolve('p', 'm'))?.windowSource, 'catalog');
    assert.equal((await persisted.resolve('p', 'm'))?.contextWindow, 200000);
    const saved = await readFile(cache, 'utf8');
    assert.equal(saved.includes('secret'), false); assert.equal(saved.includes('apiKey'), false); assert.equal(saved.includes('headers'), false);
    assert.equal(await readFile(join(directory, 'models.yml'), 'utf8'), config);
    assert.deepEqual(capacityModels([{ provider: 'p', id: 'zero', contextWindow: 0 }]), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('config precedence is yml then yaml then json without migration or guessed windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-capacity-'));
  try {
    const resolver = new ModelCapacityResolver(join(directory, 'catalog.json'), directory);
    const config = (window: number) => JSON.stringify({ providers: { p: { modelOverrides: { m: { contextWindow: window, name: 'Override' } } } } });
    await writeFile(join(directory, 'models.json'), config(100));
    assert.equal((await resolver.resolve('p', 'm'))?.contextWindow, 100);
    await writeFile(join(directory, 'models.yaml'), config(200));
    assert.equal((await resolver.resolve('p', 'm'))?.contextWindow, 200);
    await writeFile(join(directory, 'models.yml'), config(300));
    assert.equal((await resolver.resolve('p', 'm'))?.contextWindow, 300);
    await writeFile(join(directory, 'models.yml'), config(0));
    assert.equal(await resolver.resolve('p', 'm'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('capability changes update same-model cache without persisting secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-capability-'));
  try {
    const cache = join(directory, 'catalog.json');
    const resolver = new ModelCapacityResolver(cache, directory);
    await resolver.capture([{ provider: 'p', id: 'm', contextWindow: 1000000, input: ['text'], remoteCompaction: false }]);
    await resolver.capture([{ provider: 'p', id: 'm', contextWindow: 1000000, input: ['text', 'image'], remoteCompaction: true, apiKey: 'secret' }]);
    const restored = await new ModelCapacityResolver(cache, directory).resolve('p', 'm');
    assert.deepEqual(restored?.input, ['text', 'image']);
    assert.equal(restored?.remoteCompaction, true);
    assert.equal((await readFile(cache, 'utf8')).includes('secret'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('native remote routes distinguish opt-in, vision and streaming transport', () => {
  assert.equal(remoteCompactionCapabilities({ provider: 'openai', api: 'openai-responses' }).remoteCompaction, true);
  assert.equal(remoteCompactionCapabilities({ provider: 'gateway', api: 'openai-responses' }).remoteCompaction, false);
  assert.equal(remoteCompactionCapabilities({ provider: 'gateway', api: 'openai-responses', remoteCompaction: { enabled: true } }).remoteCompaction, true);
  assert.deepEqual(remoteCompactionCapabilities({ provider: 'openai-codex', api: 'openai-codex-responses', remoteCompaction: { v2StreamingEnabled: true } }), { remoteCompaction: false, remoteCompactionV2: true });
  assert.equal(remoteCompactionCapabilities({ provider: 'gateway', api: 'anthropic-messages', compat: { supportsServerCompaction: true }, remoteCompaction: { enabled: true }, baseUrl: 'https://not-anthropic.example' }).remoteCompaction, false);
  assert.equal(remoteCompactionCapabilities({ provider: 'anthropic', api: 'anthropic-messages', compat: { supportsServerCompaction: true, firstPartyProvider: true }, transport: 'pi-native' }).remoteCompaction, true);
  assert.equal(remoteCompactionCapabilities({ provider: 'p', id: 'm' }).remoteCompaction, undefined);
});
test('catalog names survive cold starts without inventing missing capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-names-'));
  try {
    const path = join(directory, 'catalog.json');
    const resolver = new ModelCapacityResolver(path, directory);
    await resolver.capture([{ provider: 'p', id: 'm', name: 'Friendly model', apiKey: 'never-persist' }, { provider: 'q', id: 'm', name: 'Other provider', contextWindow: 1000 }]);
    const cold = new ModelCapacityResolver(path, directory);
    assert.deepEqual(await cold.names(), [{ provider: 'p', id: 'm', name: 'Friendly model' }, { provider: 'q', id: 'm', name: 'Other provider' }]);
    assert.equal(await cold.resolve('p', 'm'), undefined);
    assert.equal((await cold.resolve('q', 'm'))?.contextWindow, 1000);
    assert.equal((await readFile(path, 'utf8')).includes('never-persist'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
