// Structural selectors are limited to layout geometry; actions use locale keys.
export const ui = {
  editor: '[role=\"textbox\"][contenteditable=\"true\"]',
  scroll: '.thread-scroll',
  model: '.composer-model-thinking-chip',
  modelName: '.composer-model-thinking-model',
  thinkingLabel: '.composer-model-thinking-level',
  live: '.live-status-row[data-state][aria-hidden="false"]',
  liveAction: '.live-status-row[data-state][aria-hidden="false"] > button.live-status-main',
  rows: '.project-group .thread-item',
  activeRow: '.project-group .thread-item:has(button[aria-current=\"page\"])',
};
export const attribute = (name, value) => `[${name}=${JSON.stringify(value)}]`;
