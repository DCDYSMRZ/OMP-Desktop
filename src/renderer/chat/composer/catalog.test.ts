import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveThinking, rankedCommands, modelGroups, visibleFileReference } from './catalog';

test('command ranking keeps aliases searchable and sources contiguous', () => {
  const commands = [{ name: 'deployment', source: 'skill' }, { name: 'model', aliases: ['models'], source: 'builtin' }, { name: 'mode', source: 'builtin' }, { name: 'module', source: 'extension' }];
  assert.deepEqual(rankedCommands(commands, 'mdl').map(command => command.name), ['model', 'module']);
  assert.deepEqual(rankedCommands(commands, 'md').map(command => command.source), ['builtin', 'builtin', 'extension']);
  assert.equal(rankedCommands(commands, 'models')[0].name, 'model');
  assert.deepEqual(rankedCommands(commands, 'zzzz'), []);
});

test('effective thinking distinguishes unsupported, off-only and unknown custom levels', () => {
  assert.equal(effectiveThinking(['off']), 'off');
  assert.equal(effectiveThinking([], undefined, false), null);
  assert.equal(effectiveThinking(['off', 'high'], 'high'), 'high');
  assert.equal(effectiveThinking(['off', 'adaptive'], 'adaptive'), 'adaptive');
  assert.equal(effectiveThinking(['off', 'high']), null);
});

test('current model and provider lead without changing catalog input order', () => {
  const other = { provider: 'a', id: 'same' };
  const previous = { provider: 'b', id: 'old' };
  const selected = { provider: 'b', id: 'same' };
  const catalog = [other, previous, selected];
  assert.deepEqual(modelGroups(catalog, selected), [['b', [selected, previous]], ['a', [other]]]);
  assert.deepEqual(catalog, [other, previous, selected]);
});

test('infrastructure references are hidden until explicitly requested', () => {
  assert.equal(visibleFileReference('.git', ''), false);
  assert.equal(visibleFileReference('node_modules/package/index.js', 'index'), false);
  assert.equal(visibleFileReference('.DS_Store', ''), false);
  assert.equal(visibleFileReference('node_modules', 'node_'), true);
  assert.equal(visibleFileReference('.git/config', '.git/'), true);
  assert.equal(visibleFileReference('src/constructor', ''), true);
  assert.equal(visibleFileReference('out/result.txt', ''), true);
});
