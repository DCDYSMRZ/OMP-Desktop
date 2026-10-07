import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelDisplayNames } from './model-display-name';

test('model labels prefer live catalog, then persisted names, then unchanged ids', () => {
  const names = new ModelDisplayNames();
  assert.equal(names.displayName('p', 'm'), 'm');
  names.capture([{ provider: 'p', id: 'm', name: 'Cached model' }], 'cached');
  assert.equal(names.displayName('p', 'm'), 'Cached model');
  names.capture([{ provider: 'p', id: 'm', name: 'Native model' }], 'catalog');
  names.capture([{ provider: 'p', id: 'm', name: 'Older name' }], 'cached');
  assert.equal(names.displayName('p', 'm'), 'Native model');
  names.capture([{ provider: 'p', id: 'm', name: '' }], 'catalog');
  assert.equal(names.displayName('p', 'm'), 'Native model');
  assert.equal(names.displayName('other', 'm'), 'm');
});
test('provider-qualified ids keep providers and nested model ids distinct', () => {
  const names = new ModelDisplayNames();
  names.capture([{ provider: 'p', id: 'm', name: 'First' }, { provider: 'q', id: 'm', name: 'Second' }, { provider: 'router', id: 'vendor/model', name: 'Routed model' }], 'cached');
  assert.equal(names.displayName(undefined, 'p/m'), 'First');
  assert.equal(names.displayName('p', 'p/m'), 'First');
  assert.equal(names.displayName(undefined, 'q/m'), 'Second');
  assert.equal(names.displayName('router', 'vendor/model'), 'Routed model');
  assert.equal(names.displayName(undefined, 'router/vendor/model'), 'Routed model');
  assert.equal(names.displayName(undefined, 'unknown/id'), 'unknown/id');
});
