import { isAbsolute } from 'node:path';
import type { ConfigEntry, JsonValue, SettingsSnapshot, SettingsWriteResult } from '../../shared/contracts';
import { runNativeCommand, type ExecutionContext } from '../omp/cli';
import { record } from './io';

// Native 18.3.2 register({credential:true}) definitions; not name heuristics.
// config/model-settings.ts, blob-broker/settings.ts, hindsight/settings.ts,
// mnemopi/settings.ts, tools/settings.ts, web/settings.ts. Native ui.secret is
// also a credential marker; this version has no additional ui.secret settings.
const CREDENTIALS: Record<string, { type: string; description: string }> = {
  'auth.broker.token': { type: 'string', description: 'Native auth broker token' },
  'images.urls.credentials': { type: 'record', description: 'Native image URL destination credentials' },
  'hindsight.apiToken': { type: 'string', description: 'Native Hindsight API token' },
  'mnemopi.embeddingApiKey': { type: 'string', description: 'Native Mnemopi embedding API key' },
  'mnemopi.llmApiKey': { type: 'string', description: 'Native Mnemopi LLM API key' },
  'dev.autoqaPush.token': { type: 'string', description: 'Native Auto QA push token' },
  'searxng.token': { type: 'string', description: 'Native SearXNG token' },
  'searxng.basicPassword': { type: 'string', description: 'Native SearXNG basic password' },
};

function parseJson(text: string, operation: string): Record<string, unknown> {
  let result: unknown;
  try { result = JSON.parse(text); } catch { throw new Error(`Native ${operation} returned invalid JSON`); }
  if (!record(result)) throw new Error(`Native ${operation} returned an invalid object`);
  return result;
}

function validateJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 32) throw new Error('Setting value nesting exceeds 32 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const child of value) validateJson(child, depth + 1); return; }
  if (record(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Setting value must be finite JSON');
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('Unsafe setting key');
      validateJson(child, depth + 1);
    }
    return;
  }
  throw new Error('Setting value must be finite JSON');
}

export function redactSettings(raw: unknown): ConfigEntry[] {
  if (!record(raw)) throw new Error('Native config list returned an invalid object');
  const entries: ConfigEntry[] = [];
  for (const [key, item] of Object.entries(raw)) {
    if (!record(item) || typeof item.type !== 'string' || typeof item.description !== 'string') throw new Error(`Invalid native config metadata for ${key}`);
    const credential = Object.hasOwn(CREDENTIALS, key) || item.redacted === true;
    const entry: ConfigEntry = { key, type: item.type, description: item.description };
    if (credential) {
      entry.credential = true;
      entry.redacted = item.redacted === true || (item.value !== undefined && item.value !== null && item.value !== '' && (typeof item.value !== 'object' || Object.keys(item.value).length > 0));
    } else if (item.value !== undefined) { validateJson(item.value); entry.value = item.value; }
    entries.push(entry);
  }
  // Omitted/unset credentials must still be classified, never exposed as ordinary fields.
  for (const [key, metadata] of Object.entries(CREDENTIALS)) {
    if (!Object.hasOwn(raw, key)) entries.push({ key, ...metadata, credential: true, redacted: false });
  }
  return entries;
}

export function serializeSetting(entry: ConfigEntry, value: JsonValue): string {
  if (entry.credential || entry.redacted || Object.hasOwn(CREDENTIALS, entry.key)) throw new Error('Manage credentials with the native omp CLI; desktop does not read or save credential values');
  validateJson(value);
  const valid = entry.type === 'boolean' ? typeof value === 'boolean'
    : entry.type === 'number' ? typeof value === 'number'
    : entry.type === 'array' ? Array.isArray(value)
    : entry.type === 'record' ? record(value)
    : entry.type === 'string' || entry.type === 'enum' ? typeof value === 'string'
    : false;
  if (!valid) throw new Error(`Invalid value type for ${entry.key}: expected ${entry.type}`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Setting value exceeds 128 KiB');
  // Native config argv parsing drops dash-prefixed positionals; its number parser trims.
  // Keep the space inside this one argv value, never introduce shell quoting.
  return typeof value === 'number' ? ` ${Object.is(value, -0) ? '-0' : serialized}` : serialized;
}

export async function listNativeSettings(context: ExecutionContext): Promise<SettingsSnapshot> {
  const listed = await runNativeCommand(context, ['config', 'list', '--json']);
  const entries = redactSettings(parseJson(listed.stdout, 'config list'));
  const located = await runNativeCommand(context, ['config', 'path']);
  const directory = located.stdout.trim();
  if (!isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error('Native config path did not return one absolute directory');
  return { entries, directory };
}

export async function writeNativeSetting(context: ExecutionContext, key: string, value?: JsonValue): Promise<SettingsWriteResult> {
  if (typeof key !== 'string' || key.length > 256) throw new Error('Invalid native setting key');
  const before = await listNativeSettings(context);
  const entry = before.entries.find(item => item.key === key);
  if (!entry) throw new Error(`Unknown native setting: ${key}`);
  if (entry.credential || entry.redacted) throw new Error('Manage credentials with the native omp CLI; desktop does not read or save credential values');
  const args = value === undefined ? ['config', 'reset', key, '--json'] : ['config', 'set', key, serializeSetting(entry, value), '--json'];
  const written = await runNativeCommand(context, args);
  const result = parseJson(written.stdout, value === undefined ? 'config reset' : 'config set');
  if (result.key !== key) throw new Error('Native config write returned a different setting key');
  if (result.overriddenBy !== undefined && typeof result.overriddenBy !== 'string') throw new Error('Invalid native config override metadata');
  if (result.fallbackEnv !== undefined && typeof result.fallbackEnv !== 'string') throw new Error('Invalid native config fallback metadata');
  return { snapshot: await listNativeSettings(context), ...(typeof result.overriddenBy === 'string' ? { overriddenBy: result.overriddenBy } : {}), ...(typeof result.fallbackEnv === 'string' ? { fallbackEnv: result.fallbackEnv } : {}) };
}
