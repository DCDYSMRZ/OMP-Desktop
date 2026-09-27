import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, HistoryEvent, RuntimeEvent } from '../shared/contracts';

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke('desktop:bootstrap'),
  setPreferences: (patch) => ipcRenderer.invoke('desktop:setPreferences', patch),
  chooseWorkspace: () => ipcRenderer.invoke('desktop:chooseWorkspace'),
  chooseExecutable: () => ipcRenderer.invoke('desktop:chooseExecutable'),
  chooseSessionFile: () => ipcRenderer.invoke('desktop:chooseSessionFile'),
  checkRuntime: () => ipcRenderer.invoke('desktop:checkRuntime'),
  listHistory: (options) => ipcRenderer.invoke('desktop:listHistory', options),
  readHistory: (options) => ipcRenderer.invoke('desktop:readHistory', options),
  readHistoryTree: (path, before) => ipcRenderer.invoke('desktop:readHistoryTree', path, before),
  listHistorySubagents: (options) => ipcRenderer.invoke('desktop:listHistorySubagents', options),
  readHistorySubagent: (options) => ipcRenderer.invoke('desktop:readHistorySubagent', options),
  readSessionArtifact: (options) => ipcRenderer.invoke('desktop:readSessionArtifact', options),
  readSessionEntry: (options) => ipcRenderer.invoke('desktop:readSessionEntry', options),
  watchHistory: (options) => ipcRenderer.invoke('desktop:watchHistory', options),
  unwatchHistory: () => ipcRenderer.invoke('desktop:unwatchHistory'),
  readRuntimeHistory: (runtimeId) => ipcRenderer.invoke('desktop:readRuntimeHistory', runtimeId),
  getRuntimeAccess: (runtimeId) => ipcRenderer.invoke('desktop:getRuntimeAccess', runtimeId),
  onHistoryEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('A history event listener is required');
    const handler = (_event: Electron.IpcRendererEvent, event: HistoryEvent) => listener(event);
    ipcRenderer.on('desktop:historyEvent', handler);
    return () => ipcRenderer.removeListener('desktop:historyEvent', handler);
  },
  startSession: (options) => ipcRenderer.invoke('desktop:startSession', options),
  closeSession: (runtimeId) => ipcRenderer.invoke('desktop:closeSession', runtimeId),
  request: (runtimeId, command) => ipcRenderer.invoke('desktop:request', runtimeId, command),
  sendPrompt: (runtimeId, input) => ipcRenderer.invoke('desktop:sendPrompt', runtimeId, input),
  respond: (runtimeId, response) => ipcRenderer.invoke('desktop:respond', runtimeId, response),
  onRuntimeEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('A runtime event listener is required');
    const handler = (_event: Electron.IpcRendererEvent, event: RuntimeEvent) => listener(event);
    ipcRenderer.on('desktop:runtimeEvent', handler);
    return () => ipcRenderer.removeListener('desktop:runtimeEvent', handler);
  },
  listSettings: (cwd) => ipcRenderer.invoke('desktop:listSettings', cwd),
  setSetting: (cwd, key, value) => ipcRenderer.invoke('desktop:setSetting', cwd, key, value),
  resetSetting: (cwd, key) => ipcRenderer.invoke('desktop:resetSetting', cwd, key),
  chooseAttachments: (cwd) => ipcRenderer.invoke('desktop:chooseAttachments', cwd),
  addDroppedFiles(cwd, files) {
    if (!Array.isArray(files) || files.length > 32) throw new TypeError('Drop at most 32 files');
    const paths = files.map((file) => {
      // Electron resolves genuine browser File objects. Renderer strings never grant access.
      const path = webUtils.getPathForFile(file);
      if (!path) throw new TypeError('Only local dropped files can be attached');
      return path;
    });
    return ipcRenderer.invoke('desktop:addDroppedFiles', cwd, paths);
  },
  addImageAttachment: (cwd, input) => ipcRenderer.invoke('desktop:addImageAttachment', cwd, input),
  removeAttachment: (id) => ipcRenderer.invoke('desktop:removeAttachment', id),
  listFiles: (cwd, relativePath) => ipcRenderer.invoke('desktop:listFiles', cwd, relativePath),
  searchFiles: (cwd, query) => ipcRenderer.invoke('desktop:searchFiles', cwd, query),
  readFile: (cwd, path) => ipcRenderer.invoke('desktop:readFile', cwd, path),
  gitDiff: (cwd, path) => ipcRenderer.invoke('desktop:gitDiff', cwd, path),
  revealFile: (cwd, path) => ipcRenderer.invoke('desktop:revealFile', cwd, path),
  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', url),
  copyText: (text) => ipcRenderer.invoke('desktop:copyText', text),
  windowAction: (action) => ipcRenderer.invoke('desktop:windowAction', action),
};
contextBridge.exposeInMainWorld('ompDesktop', api);
