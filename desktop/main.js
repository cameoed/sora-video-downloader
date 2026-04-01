const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  screen,
} = require('electron');
const { BackupService } = require('./core/backup-service');

let mainWindow = null;
let backupService = null;
let isQuitting = false;
const MIN_WINDOW_HEIGHT = 640;

app.userAgentFallback = (function () {
  const chromeVersion = String(process.versions.chrome || '134.0.0.0');
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
  }
  if (process.platform === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
  }
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
}());

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function broadcastStatus(payload) {
  const windows = BrowserWindow.getAllWindows();
  for (let index = 0; index < windows.length; index += 1) {
    windows[index].webContents.send('backup:status', payload);
  }
}

function getMainWindow() {
  if (mainWindow && mainWindow.isDestroyed()) {
    mainWindow = null;
  }
  if (!mainWindow) {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    mainWindow = windows.length ? windows[0] : null;
  }
  return mainWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 1040,
    minHeight: MIN_WINDOW_HEIGHT,
    useContentSize: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('closed', () => {
    if (mainWindow && mainWindow.isDestroyed()) {
      mainWindow = null;
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url || url.indexOf('file://') === 0) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return mainWindow;
}

async function setupIpc() {
  ipcMain.handle('app:get-bootstrap', async () => backupService.getBootstrap());
  ipcMain.handle('app:resize-to-content', async (event, contentHeight) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return { ok: false };
    const parsedHeight = Math.ceil(Number(contentHeight) || 0);
    if (!parsedHeight) return { ok: false };
    const display = screen.getDisplayMatching(window.getBounds());
    const maxHeight = Math.max(
      MIN_WINDOW_HEIGHT,
      Math.floor((display && display.workArea && display.workArea.height ? display.workArea.height : parsedHeight) - 80)
    );
    const targetHeight = Math.max(MIN_WINDOW_HEIGHT, Math.min(parsedHeight, maxHeight));
    const bounds = window.getContentBounds();
    if (Math.abs(bounds.height - targetHeight) < 2) return { ok: true, height: bounds.height };
    window.setContentSize(bounds.width, targetHeight, true);
    return { ok: true, height: targetHeight };
  });
  ipcMain.handle('session:open', async () => backupService.openLoginWindow());
  ipcMain.handle('session:check', async () => backupService.checkSession());
  ipcMain.handle('settings:update', async (_event, payload) => ({ ok: true, settings: await backupService.updateSettings(payload || {}) }));
  ipcMain.handle('backup:start', async (_event, payload) => backupService.startBackup(payload || {}));
  ipcMain.handle('backup:cancel', async () => backupService.cancelBackup());
  ipcMain.handle('backup:get-clear-cache-targets', async () => backupService.getClearCacheTargets());
  ipcMain.handle('backup:clear-selected-caches', async (_event, payload) => backupService.clearSelectedCaches(payload || {}));
  ipcMain.handle('backup:choose-download-folder', async (_event, currentPath) => {
    const parentWindow = getMainWindow();
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentPath || app.getPath('downloads'),
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    await backupService.updateSettings({ downloadDir: result.filePaths[0] });
    return { ok: true, path: result.filePaths[0] };
  });
  ipcMain.handle('backup:open-run-folder', async (_event, runId) => {
    const folderPath = await backupService.getRunFolder(runId);
    if (!folderPath) return { ok: false, error: 'backup_run_not_found' };
    const parentFolderPath = path.dirname(folderPath);
    await fs.promises.mkdir(parentFolderPath, { recursive: true });
    const status = await shell.openPath(parentFolderPath);
    if (status) return { ok: false, error: status };
    return { ok: true, path: parentFolderPath };
  });
}

async function boot() {
  backupService = new BackupService({
    baseDir: path.join(app.getPath('userData'), 'sora-backup-app'),
    defaultDownloadDir: app.getPath('downloads'),
  });
  await backupService.initialize();
  backupService.on('status', broadcastStatus);
  await setupIpc();
  createWindow();
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    const window = getMainWindow() || createWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox(
      'Sora Backup App Failed To Start',
      String((error && error.stack) || (error && error.message) || error || 'Unknown startup error.')
    );
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  const window = getMainWindow();
  if (window) {
    window.show();
    return;
  }
  createWindow();
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  Promise.resolve()
    .then(() => backupService && backupService.shutdown ? backupService.shutdown() : null)
    .catch(() => {})
    .finally(() => {
      app.exit(0);
    });
});
