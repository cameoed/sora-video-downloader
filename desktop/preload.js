const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soraBackupApp', {
  platform: process.platform,
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  resizeToContent: (height) => ipcRenderer.invoke('app:resize-to-content', height),
  openLoginWindow: () => ipcRenderer.invoke('session:open'),
  checkSession: () => ipcRenderer.invoke('session:check'),
  connectWithBearerToken: (token) => ipcRenderer.invoke('session:connect-with-bearer', token),
  logoutSession: () => ipcRenderer.invoke('session:logout'),
  updateSettings: (payload) => ipcRenderer.invoke('settings:update', payload),
  startBackup: (payload) => ipcRenderer.invoke('backup:start', payload),
  cancelBackup: () => ipcRenderer.invoke('backup:cancel'),
  getClearCacheTargets: () => ipcRenderer.invoke('backup:get-clear-cache-targets'),
  clearSelectedCaches: (payload) => ipcRenderer.invoke('backup:clear-selected-caches', payload),
  chooseDownloadFolder: (currentPath) => ipcRenderer.invoke('backup:choose-download-folder', currentPath),
  openRunFolder: (runId) => ipcRenderer.invoke('backup:open-run-folder', runId),
  scanPostStats: () => ipcRenderer.invoke('post-stats:scan'),
  fetchCharacterStats: (handle) => ipcRenderer.invoke('character-stats:fetch', handle),
  onPostStatsProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('post-stats:progress', handler);
    return () => ipcRenderer.removeListener('post-stats:progress', handler);
  },
  onBackupStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('backup:status', handler);
    return () => ipcRenderer.removeListener('backup:status', handler);
  },
});
