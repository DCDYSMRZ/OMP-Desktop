import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSidebarPreferences, migrateSidebarPreferences, type SidebarPreferences } from './sidebar-preferences';

const current: SidebarPreferences = { hiddenProjects: ['/current'], collapsedProjects: { '/current': false }, sidebarStateMigrated: false };
test('legacy sidebar merge preserves current choices and bounds untrusted storage', () => {
  const merged = mergeSidebarPreferences(current, JSON.stringify(['/legacy', '/current', 'relative', 7]), JSON.stringify({ '/current': true, '/legacy': true, relative: false, '/bad': 'true' }));
  assert.deepEqual(merged, { hiddenProjects: ['/current', '/legacy'], collapsedProjects: { '/current': false, '/legacy': true }, sidebarStateMigrated: true });
  assert.deepEqual(mergeSidebarPreferences(current, '{invalid', 'null'), { ...current, sidebarStateMigrated: true });
  const bounded = mergeSidebarPreferences(current, JSON.stringify(Array.from({ length: 250 }, (_, i) => '/path-' + i)), '{}');
  assert.equal(bounded.hiddenProjects.length, 200);
  assert.equal(bounded.hiddenProjects[0], '/current');
});
test('migration removes legacy keys only after durable save and never reads storage after migration', async () => {
  const keys = new Map([['omp.sidebar.hiddenProjects', JSON.stringify(['/legacy'])], ['omp.sidebar.collapsed', JSON.stringify({ '/legacy': true })]]);
  const storage = { getItem: (key: string) => keys.get(key) ?? null, removeItem: (key: string) => { keys.delete(key); } };
  await assert.rejects(migrateSidebarPreferences(() => current, async () => { throw new Error('Disk unavailable'); }, () => storage), /Disk unavailable/);
  assert.equal(keys.size, 2);
  let saved = current;
  await migrateSidebarPreferences(() => saved, async patch => { saved = patch; }, () => storage);
  assert.deepEqual(saved.hiddenProjects, ['/current', '/legacy']);
  assert.equal(saved.collapsedProjects['/legacy'], true);
  assert.equal(keys.size, 0);
  await migrateSidebarPreferences(() => saved, async () => { assert.fail('Already migrated'); }, () => { throw new Error('Storage must not be touched'); });
});
