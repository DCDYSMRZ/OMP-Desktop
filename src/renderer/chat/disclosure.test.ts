import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisclosureChoices } from './disclosure-choices';

const scope = 'tool-part';
const tool = JSON.stringify([scope, 'tool:command']);
const nested = JSON.stringify([scope, 'command-output:command']);
const raw = JSON.stringify([scope, 'tool-raw:command']);

test('exact tool reveal leaves nested output and raw data closed', () => {
  const state = new DisclosureChoices();
  state.reveal(tool);
  assert.equal(state.get(tool), true);
  assert.equal(state.get(nested), undefined);
  assert.equal(state.get(raw), undefined);
});
test('typed scope reveal excludes raw data even when it mounts later', () => {
  const state = new DisclosureChoices();
  state.set(tool, false);
  state.set(nested, false);
  state.reveal(scope, { exclude: [raw] });
  assert.equal(state.get(tool), true);
  assert.equal(state.get(nested), true);
  assert.equal(state.get(raw), undefined);
  assert.equal(state.get(JSON.stringify(['another-part', 'tool:another'])), undefined);
  state.set(raw, false);
  state.reveal(scope, { exclude: [raw] });
  assert.equal(state.get(raw), false);
  state.reveal(raw);
  assert.equal(state.get(raw), true);
});
test('excluded disclosures retain explicit reader choices across reveals', () => {
  const state = new DisclosureChoices();
  state.set(raw, true);
  state.reveal(scope, { exclude: [raw] });
  assert.equal(state.get(raw), true);
  state.set(raw, false);
  state.reveal(tool);
  assert.equal(state.get(raw), false);
});
test('a batched nested reveal is atomic to subscribers and retains unrelated choices', () => {
  const state = new DisclosureChoices();
  state.set(tool, false);
  state.set(nested, false);
  state.set(raw, false);
  const observed: unknown[] = [];
  const unsubscribe = state.subscribe(tool, () => observed.push([state.get(tool), state.get(nested)]));
  state.revealMany([tool, nested]);
  assert.deepEqual(observed, [[true, true]]);
  assert.equal(state.get(raw), false);
  unsubscribe();
});
