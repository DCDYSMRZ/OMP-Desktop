import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workPanelLayout } from './work-panel-resize';

test('a retained collapsed sidebar does not consume the narrow panel budget', () => {
  const layout = { containerWidth: 1100, sidebarWidth: 260, requestedPanelWidth: 420 };
  const expanded = workPanelLayout({ ...layout, sidebarCollapsed: false });
  assert.equal(expanded.panelWidth, 280);
  assert.equal(expanded.mainWidth, 560);
  assert.equal(expanded.shouldCollapseSidebar, true);
  const collapsed = workPanelLayout({ ...layout, sidebarCollapsed: true });
  assert.equal(collapsed.panelWidth, 420);
  assert.equal(collapsed.mainWidth, 680);
  assert.equal(collapsed.maxPanelWidth, 440);
});
