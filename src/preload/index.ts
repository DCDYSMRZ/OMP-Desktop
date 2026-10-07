import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, HistoryEvent, RuntimeEvent } from '../shared/contracts';
import type { TurnChangeEvent } from '../shared/turn-change-types';
import { unwrapNativeFailure } from '../shared/native-error';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return unwrapNativeFailure<T>(await ipcRenderer.invoke(channel, ...args));
}

const api: DesktopApi = {
  bootstrap: () => invoke('desktop:bootstrap'),
  getWindowChrome: () => invoke('desktop:getWindowChrome'),
  onWindowChrome(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: { fullscreen: boolean }) => listener(state);
    ipcRenderer.on('desktop:windowChrome', handler);
    return () => ipcRenderer.removeListener('desktop:windowChrome', handler);
  },
  setPreferences: (patch) => invoke('desktop:setPreferences', patch),
  getPresenceSettings: () => invoke('desktop:getPresenceSettings'),
  getDesktopDiagnostics: () => invoke('desktop:getDesktopDiagnostics'),
  openLogsFolder: () => invoke('desktop:openLogsFolder'),
  chooseWorkspace: () => invoke('desktop:chooseWorkspace'),
  chooseExecutable: () => invoke('desktop:chooseExecutable'),
  chooseSessionFile: () => invoke('desktop:chooseSessionFile'),
  checkRuntime: () => invoke('desktop:checkRuntime'),
  openNativeLogin: () => invoke('desktop:openNativeLogin'),
  listHistory: (options) => invoke('desktop:listHistory', options),
  getSessionUsage: (path, leafId) => invoke('desktop:getSessionUsage', path, leafId),
  getModelCapacity: (provider, id) => invoke('desktop:getModelCapacity', provider, id),
  searchMessages: (request) => invoke('desktop:searchMessages', request),
  onMenuCommand(listener) {
    if (typeof listener !== 'function') throw new TypeError('A menu command listener is required');
    const handler = (_event: Electron.IpcRendererEvent, command: string) => listener(command);
    ipcRenderer.on('desktop:menuCommand', handler);
    return () => ipcRenderer.removeListener('desktop:menuCommand', handler);
  },
  readHistory: (options) => invoke('desktop:readHistory', options),
  readHistoryTree: (path, before) => invoke('desktop:readHistoryTree', path, before),
  listHistorySubagents: (options) => invoke('desktop:listHistorySubagents', options),
  readHistorySubagent: (options) => invoke('desktop:readHistorySubagent', options),
  readRuntimeSubagent: (options) => invoke('desktop:readRuntimeSubagent', options),
  getTurnChanges: (query) => invoke('desktop:getTurnChanges', query),
  onTurnChanges(listener) {
    if (typeof listener !== 'function') throw new TypeError('A turn change listener is required');
    const handler = (_event: Electron.IpcRendererEvent, event: TurnChangeEvent) => listener(event);
    ipcRenderer.on('desktop:turnChanges', handler);
    return () => ipcRenderer.removeListener('desktop:turnChanges', handler);
  },
  resolveHistoryParent: (path) => invoke('desktop:resolveHistoryParent', path),
  readSessionArtifact: (options) => invoke('desktop:readSessionArtifact', options),
  readSessionEntry: (options) => invoke('desktop:readSessionEntry', options),
  watchHistory: (options) => invoke('desktop:watchHistory', options),
  unwatchHistory: () => invoke('desktop:unwatchHistory'),
  readRuntimeHistory: (runtimeId, options) => invoke('desktop:readRuntimeHistory', runtimeId, options),
  getRuntimeAccess: (runtimeId) => invoke('desktop:getRuntimeAccess', runtimeId),
  onHistoryEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('A history event listener is required');
    const handler = (_event: Electron.IpcRendererEvent, event: HistoryEvent) => listener(event);
    ipcRenderer.on('desktop:historyEvent', handler);
    return () => ipcRenderer.removeListener('desktop:historyEvent', handler);
  },
  startSession: (options) => invoke('desktop:startSession', options),
  closeSession: (runtimeId) => invoke('desktop:closeSession', runtimeId),
  removeSession: (target) => invoke('desktop:removeSession', target),
  request: (runtimeId, command) => invoke('desktop:request', runtimeId, command),
  sendPrompt: (runtimeId, input) => invoke('desktop:sendPrompt', runtimeId, input),
  respond: (runtimeId, response) => invoke('desktop:respond', runtimeId, response),
  onRuntimeEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('A runtime event listener is required');
    const handler = (_event: Electron.IpcRendererEvent, event: RuntimeEvent) => listener(event);
    ipcRenderer.on('desktop:runtimeEvent', handler);
    return () => ipcRenderer.removeListener('desktop:runtimeEvent', handler);
  },
  listSettings: (cwd) => invoke('desktop:listSettings', cwd),
  setSetting: (cwd, key, value) => invoke('desktop:setSetting', cwd, key, value),
  resetSetting: (cwd, key) => invoke('desktop:resetSetting', cwd, key),
  chooseAttachments: (cwd) => invoke('desktop:chooseAttachments', cwd),
  addDroppedFiles(cwd, files) {
    if (!Array.isArray(files) || files.length > 32) throw new TypeError('Drop at most 32 files');
    const paths = files.map((file) => {
      // Electron resolves genuine browser File objects. Renderer strings never grant access.
      const path = webUtils.getPathForFile(file);
      if (!path) throw new TypeError('Only local dropped files can be attached');
      return path;
    });
    return invoke('desktop:addDroppedFiles', cwd, paths);
  },
  addImageAttachment: (cwd, input) => invoke('desktop:addImageAttachment', cwd, input),
  removeAttachment: (id) => invoke('desktop:removeAttachment', id),
  listFiles: (cwd, relativePath) => invoke('desktop:listFiles', cwd, relativePath),
  searchFiles: (cwd, query) => invoke('desktop:searchFiles', cwd, query),
  readFile: (cwd, path) => invoke('desktop:readFile', cwd, path),
  gitDiff: (cwd, path, referencedPaths) => invoke('desktop:gitDiff', cwd, path, referencedPaths),
  revealFile: (cwd, path) => invoke('desktop:revealFile', cwd, path),
  openInEditor: (request) => invoke('desktop:openInEditor', request),
  quickLook: (request) => invoke('desktop:quickLook', request),
  startFileDrag: (request) => ipcRenderer.send('desktop:startFileDrag', request),
  openExternal: (url) => invoke('desktop:openExternal', url),
  copyText: (text) => invoke('desktop:copyText', text),
  windowAction: (action) => invoke('desktop:windowAction', action),
  setAttention: (options) => invoke('desktop:setAttention', options),
  notify: (options) => invoke('desktop:notify', options),
  setWindowTitle: (title) => invoke('desktop:setWindowTitle', title),
  onNotificationClick(listener) {
    if (typeof listener !== 'function') throw new TypeError('A notification listener is required');
    const handler = (_event: Electron.IpcRendererEvent, runtimeId: string) => listener(runtimeId);
    ipcRenderer.on('desktop:notificationClick', handler);
    return () => ipcRenderer.removeListener('desktop:notificationClick', handler);
  },
};
contextBridge.exposeInMainWorld('ompDesktop', api);
