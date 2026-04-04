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
const { BACKUP_DOWNLOAD_FOLDER } = require('./core/helpers');

let mainWindow = null;
let backupService = null;
let isQuitting = false;
const AUTOMATION_TASK = String(process.env.SVD_AUTOMATION_TASK || '').trim();
const MIN_WINDOW_HEIGHT = 640;
const CONTENT_SIZE_BUFFER_PX = 2;
const DEFAULT_DOWNLOAD_FOLDER = path.join(app.getPath('downloads'), BACKUP_DOWNLOAD_FOLDER);

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

const gotSingleInstanceLock = AUTOMATION_TASK ? true : app.requestSingleInstanceLock();

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
    width: 1262,
    height: 822,
    minWidth: 1122,
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

function writeAutomationOutput(payload) {
  try {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } catch (_error) {}
}

async function readWindowSnapshot(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return null;
  try {
    return await targetWindow.webContents.executeJavaScript(
      '({ href: String(window.location.href || ""), title: String(document.title || ""), readyState: String(document.readyState || "") })',
      true
    );
  } catch (error) {
    return {
      href: String(targetWindow.webContents.getURL() || ''),
      title: '',
      readyState: '',
      error: String((error && error.message) || error || 'window_snapshot_failed'),
    };
  }
}

async function maybeRunAutomationTask() {
  if (!AUTOMATION_TASK) return false;
  const draftId = String(process.env.SVD_AUTOMATION_DRAFT_ID || '').trim();
  const referer = String(process.env.SVD_AUTOMATION_REFERER || '').trim() || (
    draftId ? ('https://sora.chatgpt.com/d/' + encodeURIComponent(draftId)) : 'https://sora.chatgpt.com/drafts'
  );

  try {
    if (AUTOMATION_TASK === 'check-auth') {
      writeAutomationOutput(await backupService.checkSession());
      return true;
    }

    if (AUTOMATION_TASK === 'dump-auth') {
      const targetUrl = String(process.env.SVD_AUTOMATION_REFERER || '').trim() || 'https://sora.chatgpt.com/drafts';
      const headers = await backupService.session.ensureAuthHeaders(0);
      const cookieHeader = await backupService.session.getCookieHeader(targetUrl);
      writeAutomationOutput({
        ok: true,
        task: AUTOMATION_TASK,
        targetUrl,
        authorization: String(headers && headers.Authorization || ''),
        cookieHeader,
        userAgent: backupService.session.userAgent,
        deviceId: await backupService.session.getDeviceId(targetUrl),
      });
      return true;
    }

    if (AUTOMATION_TASK === 'bootstrap-auth-session') {
      const targetUrl = String(process.env.SVD_AUTOMATION_REFERER || '').trim() || 'https://sora.chatgpt.com/explore?gather=1';
      const cookieHeaderBefore = await backupService.session.getCookieHeader(targetUrl);
      const authResponse = await backupService.session.fetchJson('/backend/authenticate', {}, {
        maxAttempts: 1,
        throwOnError: false,
      });
      const meResponse = await backupService.session.fetchJson('/backend/project_y/v2/me', {}, {
        maxAttempts: 1,
        throwOnError: false,
      });
      const loginWindow = await backupService.session.ensureLoginWindow().catch(() => null);
      const loginWindowSnapshotBefore = await readWindowSnapshot(loginWindow);
      if (loginWindow && !loginWindow.isDestroyed()) {
        await loginWindow.loadURL(targetUrl, {
          userAgent: backupService.session.userAgent,
          httpReferrer: 'https://sora.chatgpt.com/',
        }).catch(() => {});
      }
      const loginWindowSnapshotAfter = await readWindowSnapshot(loginWindow);
      const cookieHeaderAfter = await backupService.session.getCookieHeader(targetUrl);
      writeAutomationOutput({
        ok: authResponse && authResponse.ok === true,
        task: AUTOMATION_TASK,
        targetUrl,
        authResponse,
        meResponse,
        loginWindowSnapshotBefore,
        loginWindowSnapshotAfter,
        cookieNamesBefore: String(cookieHeaderBefore || '')
          .split(';')
          .map((part) => String(part || '').trim())
          .filter(Boolean)
          .map((part) => part.split('=')[0])
          .slice(0, 64),
        cookieNamesAfter: String(cookieHeaderAfter || '')
          .split(';')
          .map((part) => String(part || '').trim())
          .filter(Boolean)
          .map((part) => part.split('=')[0])
          .slice(0, 64),
      });
      process.exitCode = authResponse && authResponse.ok === true ? 0 : 1;
      return true;
    }

    if (AUTOMATION_TASK === 'fetch-draft-detail') {
      if (!draftId) throw new Error('missing_automation_draft_id');
      const detail = await backupService._fetchBackupDetail('draft', draftId);
      writeAutomationOutput({ ok: true, task: AUTOMATION_TASK, draftId, detail });
      return true;
    }

    if (AUTOMATION_TASK === 'fetch-json') {
      const pathname = String(process.env.SVD_AUTOMATION_PATHNAME || '').trim();
      if (!pathname) throw new Error('missing_automation_pathname');
      let params = {};
      const paramsJson = String(process.env.SVD_AUTOMATION_PARAMS_JSON || '').trim();
      if (paramsJson) params = JSON.parse(paramsJson);
      const response = await backupService.session.fetchJson(pathname, params, {
        signal: backupService._createActiveAbortSignal(),
        maxAttempts: 1,
        throwOnError: false,
      });
      writeAutomationOutput({
        ok: response && response.ok === true,
        task: AUTOMATION_TASK,
        pathname,
        params,
        response: {
          status: Number(response && response.status) || 0,
          ok: response && response.ok === true,
          json: response && response.json ? response.json : null,
          text: String(response && response.text || '').slice(0, 20000),
        },
      });
      process.exitCode = response && response.ok === true ? 0 : 1;
      return true;
    }

    if (AUTOMATION_TASK === 'list-drafts') {
      const limit = Math.max(1, Math.min(100, Number(process.env.SVD_AUTOMATION_LIMIT || 20) || 20));
      const cursor = String(process.env.SVD_AUTOMATION_CURSOR || '').trim() || null;
      const response = await backupService.session.fetchJson('/backend/project_y/profile/drafts/v2', {
        limit,
        ...(cursor ? { cursor } : {}),
      }, {
        signal: backupService._createActiveAbortSignal(),
        maxAttempts: 1,
        throwOnError: false,
      });
      const json = response && response.json && typeof response.json === 'object' ? response.json : {};
      const items = Array.isArray(json.items) ? json.items : [];
      writeAutomationOutput({
        ok: response && response.ok === true,
        task: AUTOMATION_TASK,
        request: {
          limit,
          cursor,
        },
        response: {
          status: Number(response && response.status) || 0,
          error: String(response && response.error || ''),
        },
        cursor: json && json.cursor ? String(json.cursor) : '',
        itemCount: items.length,
        items,
      });
      return true;
    }

    if (AUTOMATION_TASK === 'inspect-draft-ui') {
      if (!draftId) throw new Error('missing_automation_draft_id');
      const prepared = await backupService.session._prepareBackgroundWindow(
        referer,
        15000,
        { allowSameOriginFallback: true }
      );
      const snapshot = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function inspectDraftUi(serialized) {
          const input = JSON.parse(serialized);

          function safeText(value, maxLen) {
            const raw = String(value || '').replace(/\s+/g, ' ').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function isVisible(element) {
            if (!element || typeof element.getBoundingClientRect !== 'function') return false;
            const rect = element.getBoundingClientRect();
            if (!rect || rect.width < 1 || rect.height < 1) return false;
            const style = window.getComputedStyle(element);
            if (!style) return false;
            return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          }

          function describeElement(element) {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              tag: safeText(element.tagName, 32).toLowerCase(),
              text: safeText(element.innerText || element.textContent || '', 256),
              ariaLabel: safeText(element.getAttribute && element.getAttribute('aria-label'), 256),
              title: safeText(element.getAttribute && element.getAttribute('title'), 256),
              role: safeText(element.getAttribute && element.getAttribute('role'), 128),
              testId: safeText(element.getAttribute && (element.getAttribute('data-testid') || element.getAttribute('data-test-id')), 128),
              className: safeText(element.className, 512),
              href: safeText(element.href, 1024),
              bounds: {
                left: Math.round(rect.left || 0),
                top: Math.round(rect.top || 0),
                width: Math.round(rect.width || 0),
                height: Math.round(rect.height || 0),
              },
            };
          }

          const interactive = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-haspopup], [data-testid], [data-test-id]'))
            .filter((element) => isVisible(element))
            .map((element) => describeElement(element))
            .filter(Boolean)
            .slice(0, 200);

          const textNodes = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], p, span, div'))
            .map((element) => safeText(element.innerText || element.textContent || '', 256))
            .filter(Boolean)
            .filter((value, index, array) => array.indexOf(value) === index)
            .slice(0, 120);

          const scripts = Array.from(document.querySelectorAll('script[src]'))
            .map((element) => safeText(element.src, 2048))
            .filter(Boolean)
            .slice(0, 100);

          return {
            href: safeText(window.location.href, 2048),
            title: safeText(document.title, 512),
            readyState: safeText(document.readyState, 64),
            bodyText: safeText(document.body && document.body.innerText, 4000),
            interactive,
            textNodes,
            scripts,
          };
        }) + ')(' + JSON.stringify(JSON.stringify({ draftId })) + ')',
        true
      );
      writeAutomationOutput({
        ok: true,
        task: AUTOMATION_TASK,
        draftId,
        referer,
        snapshot,
      });
      return true;
    }

    if (AUTOMATION_TASK === 'probe-share-menu') {
      const prepared = await backupService.session._prepareExactBackgroundWindow(referer, 15000);
      const initial = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function probeShareMenuUi(serialized) {
          const input = JSON.parse(serialized);
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

          function safeText(value, maxLen) {
            const raw = String(value || '').replace(/\s+/g, ' ').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function normalizeText(value) {
            return safeText(value, 4096).toLowerCase();
          }

          function headerObjectToMap(value) {
            const mapped = {};
            try {
              const headers = new Headers(value || {});
              headers.forEach((headerValue, headerName) => {
                mapped[String(headerName || '').toLowerCase()] = String(headerValue || '');
              });
            } catch (_error) {}
            return mapped;
          }

          function bodyToString(value) {
            if (value == null) return '';
            if (typeof value === 'string') return value;
            if (value instanceof URLSearchParams) return value.toString();
            return '';
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function isVisible(element) {
            if (!element || typeof element.getBoundingClientRect !== 'function') return false;
            const rect = element.getBoundingClientRect();
            if (!rect || rect.width < 1 || rect.height < 1) return false;
            const style = window.getComputedStyle(element);
            if (!style) return false;
            return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          }

          function describeElement(element) {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              tag: safeText(element.tagName, 32).toLowerCase(),
              text: safeText(element.innerText || element.textContent || '', 256),
              ariaLabel: safeText(element.getAttribute && element.getAttribute('aria-label'), 256),
              title: safeText(element.getAttribute && element.getAttribute('title'), 256),
              role: safeText(element.getAttribute && element.getAttribute('role'), 128),
              testId: safeText(element.getAttribute && (element.getAttribute('data-testid') || element.getAttribute('data-test-id')), 128),
              ariaHasPopup: safeText(element.getAttribute && element.getAttribute('aria-haspopup'), 64),
              className: safeText(element.className, 256),
              bounds: {
                left: Math.round(Number(rect.left) || 0),
                top: Math.round(Number(rect.top) || 0),
                width: Math.round(Number(rect.width) || 0),
                height: Math.round(Number(rect.height) || 0),
              },
            };
          }

          try {
            if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && !window.__probeClipboardPatched) {
              window.__probeClipboardEntries = [];
              const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
              navigator.clipboard.writeText = async function patchedWriteText(value) {
                const text = safeText(value, 4096);
                window.__probeClipboardEntries.push({ text, createdAt: Date.now(), error: '' });
                try {
                  return await originalWriteText(value);
                } catch (error) {
                  window.__probeClipboardEntries.push({
                    text,
                    createdAt: Date.now(),
                    error: safeText((error && error.message) || error || 'clipboard_write_failed', 512),
                  });
                  throw error;
                }
              };
              window.__probeClipboardPatched = true;
            }
          } catch (_error) {}

          try {
            if (typeof window.fetch === 'function' && !window.__probeFetchPatched) {
              window.__probeFetchEvents = [];
              const originalFetch = window.fetch.bind(window);
              window.fetch = async function patchedFetch(resource, init) {
                const requestUrl =
                  typeof resource === 'string'
                    ? resource
                    : (resource && typeof resource.url === 'string' ? resource.url : '');
                const urlText = safeText(requestUrl, 2048);
                const isRelevant =
                  urlText.indexOf('/backend/editor/projects/') >= 0 ||
                  urlText.indexOf('/backend/project_y/post') >= 0 ||
                  urlText.indexOf('/backend/nf/') >= 0;
                if (!isRelevant) return originalFetch(resource, init);
                const requestHeaders = Object.assign(
                  {},
                  headerObjectToMap(resource && resource.headers),
                  headerObjectToMap(init && init.headers)
                );
                const requestBody = bodyToString(init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : null);
                const event = {
                  url: urlText,
                  method: safeText(((init && init.method) || (resource && resource.method) || 'GET'), 16).toUpperCase(),
                  request: {
                    headers: requestHeaders,
                    body: safeText(requestBody, 16384),
                    json: parseJson(requestBody),
                  },
                  response: null,
                  createdAt: Date.now(),
                };
                window.__probeFetchEvents.push(event);
                try {
                  const response = await originalFetch(resource, init);
                  const responseText = await response.clone().text();
                  event.response = {
                    ok: response.ok === true,
                    status: Number(response.status) || 0,
                    contentType: safeText(response.headers.get('content-type') || '', 256),
                    text: safeText(responseText, 16384),
                    json: parseJson(responseText),
                  };
                  return response;
                } catch (error) {
                  event.response = {
                    ok: false,
                    status: 0,
                    contentType: '',
                    text: '',
                    json: null,
                    error: safeText((error && error.message) || error || 'fetch_failed', 512),
                  };
                  throw error;
                }
              };
              window.__probeFetchPatched = true;
            }
          } catch (_error) {}

          function labelBundle(element) {
            if (!element) return '';
            return normalizeText([
              element.innerText,
              element.textContent,
              element.getAttribute && element.getAttribute('aria-label'),
              element.getAttribute && element.getAttribute('title'),
              element.getAttribute && element.getAttribute('data-testid'),
            ].join(' '));
          }

          function listVisibleElements() {
            return Array.from(document.querySelectorAll('button, [role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], a, [aria-haspopup], [tabindex]'))
              .filter((element) => isVisible(element))
              .map((element) => describeElement(element))
              .filter((entry) => entry && (entry.text || entry.ariaLabel || entry.title || entry.testId || entry.tag === 'button'))
              .slice(0, 200);
          }

          function clickElement(element) {
            if (!element) return false;
            try {
              element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            } catch (_error) {}
            try {
              element.focus({ preventScroll: true });
            } catch (_error) {}
            try {
              element.click();
              return true;
            } catch (_error) {
              return false;
            }
          }

          function collectCandidates() {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
              .filter((dialog) => isVisible(dialog))
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (bRect.width * bRect.height) - (aRect.width * aRect.height);
              });
            const scope = dialogs.length ? dialogs[0] : document;
            const settingsCandidates = Array.from(scope.querySelectorAll('button, [role="button"], [aria-haspopup]'))
              .filter((candidate) => isVisible(candidate))
              .filter((candidate) => {
                const label = labelBundle(candidate);
                const popup = normalizeText(candidate.getAttribute && candidate.getAttribute('aria-haspopup'));
                return label.indexOf('settings') >= 0 && popup === 'menu';
              })
              .filter((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return (Number(rect.left) || 0) > 200;
              })
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                if ((bRect.left || 0) !== (aRect.left || 0)) return (bRect.left || 0) - (aRect.left || 0);
                return (bRect.top || 0) - (aRect.top || 0);
              });

            const topMenuCandidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup]'))
              .filter((candidate) => isVisible(candidate))
              .filter((candidate) => {
                const popup = normalizeText(candidate.getAttribute && candidate.getAttribute('aria-haspopup'));
                const label = labelBundle(candidate);
                const rect = candidate.getBoundingClientRect();
                if (popup !== 'menu') return false;
                if ((rect.left || 0) < 700 || (rect.top || 0) > 260) return false;
                return !label || label.indexOf('settings') < 0;
              })
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                if ((aRect.top || 0) !== (bRect.top || 0)) return (aRect.top || 0) - (bRect.top || 0);
                return (bRect.left || 0) - (aRect.left || 0);
              });

            return { settingsCandidates, topMenuCandidates };
          }

          const before = listVisibleElements();
          let settingsCandidates = [];
          let topMenuCandidates = [];
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const collected = collectCandidates();
            settingsCandidates = collected.settingsCandidates;
            topMenuCandidates = collected.topMenuCandidates;
            if (settingsCandidates.length || topMenuCandidates.length) break;
            await wait(300);
          }
          const requestedIndex = Math.max(0, Number(input && input.actionIndex || 0) || 0);
          const chosen = settingsCandidates.length
            ? settingsCandidates[Math.min(requestedIndex, settingsCandidates.length - 1)]
            : (topMenuCandidates[Math.min(requestedIndex, Math.max(0, topMenuCandidates.length - 1))] || null);

          return {
            href: safeText(window.location.href, 2048),
            title: safeText(document.title, 512),
            chosen: describeElement(chosen),
            before,
          };
        }) + ')(' + JSON.stringify(JSON.stringify({
          referer,
          actionIndex: Math.max(0, Number(process.env.SVD_AUTOMATION_ACTION_INDEX || 0) || 0),
        })) + ')',
        true
      );
      let nativeClick = { attempted: false, sent: false, x: 0, y: 0 };
      const chosenBounds = initial && initial.chosen && initial.chosen.bounds ? initial.chosen.bounds : null;
      const manualNativeX = Number(process.env.SVD_AUTOMATION_NATIVE_CLICK_X || 0) || 0;
      const manualNativeY = Number(process.env.SVD_AUTOMATION_NATIVE_CLICK_Y || 0) || 0;
      if (chosenBounds && Number(chosenBounds.width) > 0 && Number(chosenBounds.height) > 0) {
        nativeClick.attempted = true;
        const x = Math.round(Number(chosenBounds.left) + (Number(chosenBounds.width) / 2));
        const y = Math.round(Number(chosenBounds.top) + (Number(chosenBounds.height) / 2));
        try {
          prepared.window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          prepared.window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          prepared.window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          nativeClick.sent = true;
          nativeClick.x = x;
          nativeClick.y = y;
        } catch (_error) {}
      } else if (manualNativeX > 0 && manualNativeY > 0) {
        nativeClick.attempted = true;
        try {
          prepared.window.webContents.sendInputEvent({ type: 'mouseMove', x: manualNativeX, y: manualNativeY });
          prepared.window.webContents.sendInputEvent({ type: 'mouseDown', x: manualNativeX, y: manualNativeY, button: 'left', clickCount: 1 });
          prepared.window.webContents.sendInputEvent({ type: 'mouseUp', x: manualNativeX, y: manualNativeY, button: 'left', clickCount: 1 });
          nativeClick.sent = true;
          nativeClick.x = manualNativeX;
          nativeClick.y = manualNativeY;
        } catch (_error) {}
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const after = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function collectAfterShareMenu(serialized) {
          const input = JSON.parse(serialized);
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
          function safeText(value, maxLen) {
            const raw = String(value || '').replace(/\s+/g, ' ').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }
          function normalizeText(value) {
            return safeText(value, 4096).toLowerCase();
          }
          function isVisible(element) {
            if (!element || typeof element.getBoundingClientRect !== 'function') return false;
            const rect = element.getBoundingClientRect();
            if (!rect || rect.width < 1 || rect.height < 1) return false;
            const style = window.getComputedStyle(element);
            if (!style) return false;
            return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          }
          function describeElement(element) {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              tag: safeText(element.tagName, 32).toLowerCase(),
              text: safeText(element.innerText || element.textContent || '', 256),
              ariaLabel: safeText(element.getAttribute && element.getAttribute('aria-label'), 256),
              title: safeText(element.getAttribute && element.getAttribute('title'), 256),
              role: safeText(element.getAttribute && element.getAttribute('role'), 128),
              testId: safeText(element.getAttribute && (element.getAttribute('data-testid') || element.getAttribute('data-test-id')), 128),
              ariaHasPopup: safeText(element.getAttribute && element.getAttribute('aria-haspopup'), 64),
              className: safeText(element.className, 256),
              bounds: {
                left: Math.round(Number(rect.left) || 0),
                top: Math.round(Number(rect.top) || 0),
                width: Math.round(Number(rect.width) || 0),
                height: Math.round(Number(rect.height) || 0),
              },
            };
          }
          function clickElement(element) {
            if (!element) return false;
            try {
              element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            } catch (_error) {}
            try {
              element.focus({ preventScroll: true });
            } catch (_error) {}
            try {
              element.click();
              return true;
            } catch (_error) {
              return false;
            }
          }
          let clickedCopy = null;
          let clickedConfirmCopy = null;
          const postConfirmWaitMs = Math.max(1800, Number(input && input.postConfirmWaitMs) || 1800);
          if (input && input.clickCopyLink) {
            const copyCandidate = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], button, div, a'))
              .filter((element) => isVisible(element))
              .map((element) => ({
                node: element,
                label: normalizeText([
                  element.innerText,
                  element.textContent,
                  element.getAttribute && element.getAttribute('aria-label'),
                  element.getAttribute && element.getAttribute('title'),
                ].join(' ')),
                role: normalizeText(element.getAttribute && element.getAttribute('role')),
              }))
              .sort((a, b) => {
                const aScore =
                  (a.label === 'copy link' ? -100 : 0) +
                  (a.role === 'menuitem' ? -50 : 0) +
                  (a.label.indexOf('download') >= 0 || a.label.indexOf('delete') >= 0 ? 50 : 0) +
                  (a.label.length || 0);
                const bScore =
                  (b.label === 'copy link' ? -100 : 0) +
                  (b.role === 'menuitem' ? -50 : 0) +
                  (b.label.indexOf('download') >= 0 || b.label.indexOf('delete') >= 0 ? 50 : 0) +
                  (b.label.length || 0);
                return aScore - bScore;
              })
              .find((entry) => entry.label === 'copy link' || entry.label.indexOf('copy link') >= 0);
            if (copyCandidate && copyCandidate.node && clickElement(copyCandidate.node)) {
              clickedCopy = describeElement(copyCandidate.node);
              await wait(800);
              const confirmCopy = Array.from(document.querySelectorAll('button, [role="button"]'))
                .filter((element) => isVisible(element))
                .map((element) => ({ node: element, label: normalizeText(element.innerText || element.textContent || '') }))
                .find((entry) => entry.label === 'copy link');
              if (confirmCopy && confirmCopy.node && clickElement(confirmCopy.node)) {
                clickedConfirmCopy = describeElement(confirmCopy.node);
                await wait(postConfirmWaitMs);
              }
            }
          }
          return {
            href: safeText(window.location.href, 2048),
            title: safeText(document.title, 512),
            bodyText: safeText(document.body && document.body.innerText, 4000),
            clickedCopy,
            clickedConfirmCopy,
            clipboard: Array.isArray(window.__probeClipboardEntries) ? window.__probeClipboardEntries.slice() : [],
            fetchEvents: Array.isArray(window.__probeFetchEvents) ? window.__probeFetchEvents.slice() : [],
            after: Array.from(document.querySelectorAll('button, [role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], a, [aria-haspopup], [tabindex]'))
              .filter((element) => isVisible(element))
              .map((element) => describeElement(element))
              .filter((entry) => entry && (entry.text || entry.ariaLabel || entry.title || entry.testId || entry.tag === 'button'))
              .slice(0, 200),
          };
        }) + ')(' + JSON.stringify(JSON.stringify({
          clickCopyLink: String(process.env.SVD_AUTOMATION_CLICK_COPY_LINK || '').trim() === '1',
          postConfirmWaitMs: Math.max(1800, Number(process.env.SVD_AUTOMATION_POST_CONFIRM_WAIT_MS || 0) || 0),
        })) + ')',
        true
      );
      writeAutomationOutput({
        ok: true,
        task: AUTOMATION_TASK,
        referer,
        snapshot: {
          href: initial && initial.href || '',
          title: initial && initial.title || '',
          chosen: initial && initial.chosen ? initial.chosen : null,
          before: initial && Array.isArray(initial.before) ? initial.before : [],
          bodyText: after && after.bodyText ? after.bodyText : '',
          clickedCopy: after && after.clickedCopy ? after.clickedCopy : null,
          clickedConfirmCopy: after && after.clickedConfirmCopy ? after.clickedConfirmCopy : null,
          clipboard: after && Array.isArray(after.clipboard) ? after.clipboard : [],
          fetchEvents: after && Array.isArray(after.fetchEvents) ? after.fetchEvents : [],
          after: after && Array.isArray(after.after) ? after.after : [],
          nativeClick,
        },
      });
      return true;
    }

    if (AUTOMATION_TASK === 'probe-drafts-grid') {
      const promptNeedle = String(process.env.SVD_AUTOMATION_PROMPT_NEEDLE || '').trim().toLowerCase();
      const prepared = await backupService.session._prepareExactBackgroundWindow('https://sora.chatgpt.com/drafts', 15000);
      const snapshot = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function probeDraftsGridUi(serialized) {
          const input = JSON.parse(serialized);
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
          const promptNeedle = String(input.promptNeedle || '').trim().toLowerCase();

          function safeText(value, maxLen) {
            const raw = String(value || '').replace(/\s+/g, ' ').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function normalizeText(value) {
            return safeText(value, 4096).toLowerCase();
          }

          function isVisible(element) {
            if (!element || typeof element.getBoundingClientRect !== 'function') return false;
            const rect = element.getBoundingClientRect();
            if (!rect || rect.width < 1 || rect.height < 1) return false;
            const style = window.getComputedStyle(element);
            if (!style) return false;
            return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          }

          function describeElement(element) {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              tag: safeText(element.tagName, 32).toLowerCase(),
              text: safeText(element.innerText || element.textContent || '', 500),
              ariaLabel: safeText(element.getAttribute && element.getAttribute('aria-label'), 256),
              title: safeText(element.getAttribute && element.getAttribute('title'), 256),
              role: safeText(element.getAttribute && element.getAttribute('role'), 128),
              testId: safeText(element.getAttribute && (element.getAttribute('data-testid') || element.getAttribute('data-test-id')), 128),
              ariaHasPopup: safeText(element.getAttribute && element.getAttribute('aria-haspopup'), 64),
              className: safeText(element.className, 512),
              href: safeText(element.href, 1024),
              bounds: {
                left: Math.round(Number(rect.left) || 0),
                top: Math.round(Number(rect.top) || 0),
                width: Math.round(Number(rect.width) || 0),
                height: Math.round(Number(rect.height) || 0),
              },
            };
          }

          function interactiveWithin(root) {
            if (!root || typeof root.querySelectorAll !== 'function') return [];
            return Array.from(root.querySelectorAll('button, [role="button"], a, [aria-haspopup], [data-testid], [data-test-id]'))
              .filter((element) => isVisible(element))
              .map((element) => describeElement(element))
              .filter(Boolean)
              .slice(0, 80);
          }

          function findCardRoot(start) {
            let node = start;
            while (node && node !== document.body) {
              if (node.matches && node.matches('a[href*="/d/"], article, li, section, [data-testid], [data-test-id]')) {
                return node;
              }
              if (node.querySelectorAll) {
                const buttons = Array.from(node.querySelectorAll('button, [role="button"], [aria-haspopup]'))
                  .filter((element) => isVisible(element));
                if (buttons.length >= 1) return node;
              }
              node = node.parentElement;
            }
            return start && start.parentElement ? start.parentElement : start;
          }

          function labelBundle(element) {
            if (!element) return '';
            return normalizeText([
              element.innerText,
              element.textContent,
              element.getAttribute && element.getAttribute('aria-label'),
              element.getAttribute && element.getAttribute('title'),
              element.getAttribute && element.getAttribute('data-testid'),
            ].join(' '));
          }

          function clickElement(element) {
            if (!element) return false;
            try {
              element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            } catch (_error) {}
            try {
              element.focus({ preventScroll: true });
            } catch (_error) {}
            try {
              element.click();
              return true;
            } catch (_error) {
              return false;
            }
          }

          try {
            if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && !window.__draftGridClipboardPatched) {
              window.__draftGridClipboardEntries = [];
              const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
              navigator.clipboard.writeText = async function patchedWriteText(value) {
                window.__draftGridClipboardEntries.push({
                  text: safeText(value, 4096),
                  createdAt: Date.now(),
                });
                return originalWriteText(value);
              };
              window.__draftGridClipboardPatched = true;
            }
          } catch (_error) {}

          await wait(4000);
          for (let index = 0; index < 8; index += 1) {
            window.scrollTo(0, Math.round((document.body.scrollHeight * index) / 8));
            await wait(500);
          }
          window.scrollTo(0, 0);
          await wait(1000);

          const draftLinks = Array.from(document.querySelectorAll('a[href*="/d/"]'))
            .filter((element) => isVisible(element))
            .map((element) => describeElement(element))
            .filter(Boolean)
            .slice(0, 60);

          const midPageInteractives = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-haspopup]'))
            .filter((element) => isVisible(element))
            .map((element) => describeElement(element))
            .filter((entry) => entry && entry.bounds && entry.bounds.top >= 80 && entry.bounds.top <= 760 && entry.bounds.left >= 80)
            .slice(0, 160);

          const visibleBlocks = Array.from(document.querySelectorAll('a, article, li, section, div'))
            .filter((element) => isVisible(element))
            .map((element) => ({
              node: element,
              label: normalizeText(element.innerText || element.textContent || ''),
            }));

          const matches = visibleBlocks
            .filter((entry) => promptNeedle && entry.label.indexOf(promptNeedle) >= 0)
            .slice(0, 6)
            .map((entry) => {
              const root = findCardRoot(entry.node);
              return {
                match: describeElement(entry.node),
                root: describeElement(root),
                rootText: safeText(root && (root.innerText || root.textContent || ''), 1600),
                interactive: interactiveWithin(root),
              };
            });

          let menuProbe = null;
          if (matches.length) {
            const root = findCardRoot(visibleBlocks.find((entry) => promptNeedle && entry.label.indexOf(promptNeedle) >= 0).node);
            const candidates = Array.from(root.querySelectorAll('button, [role="button"], [aria-haspopup]'))
              .filter((element) => isVisible(element))
              .map((element) => ({ node: element, label: labelBundle(element), rect: element.getBoundingClientRect() }))
              .sort((a, b) => {
                const aTop = Number(a.rect.top) || 0;
                const bTop = Number(b.rect.top) || 0;
                if (aTop !== bTop) return aTop - bTop;
                return (Number(b.rect.left) || 0) - (Number(a.rect.left) || 0);
              });

            for (let index = 0; index < candidates.length; index += 1) {
              const candidate = candidates[index];
              if (!candidate || !candidate.node) continue;
              if (!clickElement(candidate.node)) continue;
              await wait(400);
              const menuItems = Array.from(document.querySelectorAll('[role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'))
                .filter((element) => isVisible(element))
                .map((element) => describeElement(element))
                .filter(Boolean)
                .slice(0, 120);
              if (menuItems.length) {
                menuProbe = {
                  candidate: describeElement(candidate.node),
                  menuItems,
                  clipboard: Array.isArray(window.__draftGridClipboardEntries) ? window.__draftGridClipboardEntries.slice(-10) : [],
                };
                break;
              }
            }
          }

          return {
            href: safeText(window.location.href, 2048),
            title: safeText(document.title, 512),
            body: safeText(document.body && document.body.innerText, 12000),
            draftLinks,
            midPageInteractives,
            matches,
            menuProbe,
          };
        }) + ')(' + JSON.stringify(JSON.stringify({ promptNeedle })) + ')',
        true
      );
      writeAutomationOutput({
        ok: true,
        task: AUTOMATION_TASK,
        promptNeedle,
        snapshot,
      });
      return true;
    }

    if (AUTOMATION_TASK === 'publish-draft') {
      if (!draftId) throw new Error('missing_automation_draft_id');
      const transport = String(process.env.SVD_AUTOMATION_TRANSPORT || 'page').trim() || 'page';
      const bootstrapAuth = String(process.env.SVD_AUTOMATION_BOOTSTRAP_AUTH || '').trim() === '1';
      let body = null;
      const bodyJson = String(process.env.SVD_AUTOMATION_BODY_JSON || '').trim();
      if (bodyJson) {
        body = JSON.parse(bodyJson);
      } else {
        body = {
          attachments_to_create: [{ generation_id: draftId, kind: String(process.env.SVD_AUTOMATION_ATTACHMENT_KIND || 'sora').trim() || 'sora' }],
          post_text: String(process.env.SVD_AUTOMATION_POST_TEXT || 'Downloaded!').trim() || 'Downloaded!',
          destinations: [{ type: 'shared_link_unlisted' }],
        };
      }

      const capturedHeaders = backupService.session.getCapturedHeaders();
      const capturedDeviceId = String(capturedHeaders && capturedHeaders['OAI-Device-Id'] || '').trim();
      const cookieDeviceId = await backupService.session.getCookieValue('oai-did', referer);
      const cookieHeader = await backupService.session.getCookieHeader(referer);
      const cookieNames = String(cookieHeader || '')
        .split(';')
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .map((part) => part.split('=')[0])
        .slice(0, 64);
      let bootstrapResponse = null;
      let cookieNamesAfterBootstrap = cookieNames.slice();
      if (bootstrapAuth) {
        bootstrapResponse = await backupService.session.fetchJson('/backend/authenticate', {}, {
          maxAttempts: 1,
          throwOnError: false,
        });
        const cookieHeaderAfterBootstrap = await backupService.session.getCookieHeader(referer);
        cookieNamesAfterBootstrap = String(cookieHeaderAfterBootstrap || '')
          .split(';')
          .map((part) => String(part || '').trim())
          .filter(Boolean)
          .map((part) => part.split('=')[0])
          .slice(0, 64);
      }
      const deviceMode = String(process.env.SVD_AUTOMATION_DEVICE_ID || 'cookie').trim() || 'cookie';
      const manualDeviceId =
        deviceMode === 'captured'
          ? capturedDeviceId
          : deviceMode === 'omit'
            ? ''
            : deviceMode === 'cookie'
              ? cookieDeviceId
              : deviceMode;
      let response = null;
      let loginWindowSnapshotBefore = null;
      let loginWindowSnapshotAfter = null;
      if (transport === 'http') {
        const scriptShape = String(process.env.SVD_AUTOMATION_SCRIPT_SHAPE || '').trim() === '1';
        response = await backupService.session.postJsonViaHttp('/backend/project_y/post', body, {
          referer,
          origin: 'https://sora.chatgpt.com',
          maxAttempts: 1,
          throwOnError: false,
          omitDeviceId: scriptShape,
          userAgent: scriptShape
            ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
            : undefined,
          headers: {
            Accept: '*/*',
            ...(!scriptShape && manualDeviceId ? { 'OAI-Device-Id': manualDeviceId } : {}),
            ...(!scriptShape ? { 'OAI-Language': String(process.env.SVD_AUTOMATION_OAI_LANGUAGE || 'en-US').trim() || 'en-US' } : {}),
          },
        });
      } else if (transport === 'session') {
        response = await backupService.session.postJson('/backend/project_y/post', body, {
          referer,
          origin: 'https://sora.chatgpt.com',
          maxAttempts: 1,
          throwOnError: false,
          headers: {
            Accept: '*/*',
            ...(manualDeviceId ? { 'OAI-Device-Id': manualDeviceId } : {}),
            'OAI-Language': String(process.env.SVD_AUTOMATION_OAI_LANGUAGE || 'en-US').trim() || 'en-US',
          },
        });
      } else if (transport === 'module') {
        response = await backupService.session.postDraftSharedLinkViaAppModule(draftId, body, {
          referer,
          readyTimeoutMs: 10000,
          useSentinel: String(process.env.SVD_AUTOMATION_USE_SENTINEL || '').trim() === '1',
        });
      } else if (transport === 'editor') {
        const detailForEditor = await backupService._fetchBackupDetail('draft', draftId);
        const editorProjectBody = backupService._buildDraftEditorProjectBody(detailForEditor, {
          id: draftId,
          draft_generation_id: draftId,
        });
        response = await backupService.session.publishDraftSharedLinkViaEditorPipeline(draftId, {
          editorProjectBody,
          postText: String(body && body.post_text || 'Downloaded!').trim() || 'Downloaded!',
        }, {
          pageUrl: referer,
          requestReferer: referer,
          readyTimeoutMs: 15000,
        });
      } else if (transport === 'editor-auto-post') {
        const detailForEditor = await backupService._fetchBackupDetail('draft', draftId);
        const editorProjectBody = backupService._buildDraftEditorProjectBody(detailForEditor, {
          id: draftId,
          draft_generation_id: draftId,
        });
        response = await backupService.session.publishDraftSharedLinkViaEditorAutoPost(draftId, {
          editorProjectBody,
          postText: String(body && body.post_text || 'Downloaded!').trim() || 'Downloaded!',
        }, {
          pageUrl: referer,
          requestReferer: referer,
          readyTimeoutMs: 15000,
        });
      } else if (transport === 'ui') {
        response = await backupService.session.triggerDraftCopyLinkViaUi(draftId, {
          readyTimeoutMs: 10000,
          waitMs: 20000,
        });
      } else {
        const loginWindow = await backupService.session.ensureLoginWindow().catch(() => null);
        loginWindowSnapshotBefore = await readWindowSnapshot(loginWindow);
        response = await backupService.session.postDraftSharedLinkViaConsole(draftId, body, {
          referer,
          readyTimeoutMs: 10000,
          warmSoraAuthSession: String(process.env.SVD_AUTOMATION_WARM_SORA_SESSION || '').trim() === '1',
        });
        loginWindowSnapshotAfter = await readWindowSnapshot(loginWindow);
      }
      const observed = backupService.session.getLastObservedRequest('https://sora.chatgpt.com/backend/project_y/post', 'POST');
      let detail = null;
      if (process.env.SVD_AUTOMATION_FETCH_DETAIL_AFTER !== '0') {
        try {
          detail = await backupService._fetchBackupDetail('draft', draftId);
        } catch (error) {
          detail = { error: String((error && error.message) || error || 'fetch_detail_failed') };
        }
      }
      writeAutomationOutput({
        ok: response && response.ok === true,
        task: AUTOMATION_TASK,
        draftId,
        transport,
        referer,
        bootstrapAuth,
        bootstrapResponse,
        capturedDeviceId,
        cookieDeviceId,
        cookieNames,
        cookieNamesAfterBootstrap,
        requestDeviceId: manualDeviceId,
        body,
        loginWindowSnapshotBefore,
        loginWindowSnapshotAfter,
        response,
        observed,
        detail,
      });
      process.exitCode = response && response.ok === true ? 0 : 1;
      return true;
    }

    if (AUTOMATION_TASK === 'inspect-webpack') {
      const needle = String(process.env.SVD_AUTOMATION_NEEDLE || '').trim();
      if (!needle) throw new Error('missing_automation_needle');
      const prepared = await backupService.session._prepareBackgroundWindow(referer, 15000, {
        allowSameOriginFallback: true,
      });
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function inspectWebpack(serialized) {
          const input = JSON.parse(serialized);

          function safeText(value, maxLen) {
            const raw = String(value || '');
            const limit = Math.max(0, Number(maxLen) || 0);
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function getWebpackRequire() {
            let req = null;
            try {
              const chunk = self.webpackChunk_N_E = self.webpackChunk_N_E || [];
              chunk.push([[Symbol('svd-inspect-webpack')], {}, function captureRequire(candidate) {
                req = candidate;
              }]);
            } catch (_error) {}
            return req;
          }

          const req = getWebpackRequire();
          if (!req || !req.m) {
            return {
              ok: false,
              error: 'backup_missing_webpack_runtime',
              matches: [],
            };
          }

          const needle = safeText(input.needle, 512);
          const matcher = needle.toLowerCase();
          const matches = [];
          Object.keys(req.m).forEach((moduleId) => {
            try {
              const factory = req.m[moduleId];
              const source = safeText(factory && factory.toString ? factory.toString() : '', 400000);
              if (!source) return;
              if (source.toLowerCase().indexOf(matcher) === -1) return;
              matches.push({
                moduleId: safeText(moduleId, 64),
                source: safeText(source, 12000),
              });
            } catch (_error) {}
          });

          return {
            ok: true,
            error: '',
            href: safeText(window.location.href, 2048),
            title: safeText(document.title, 512),
            needle,
            matches: matches.slice(0, 25),
          };
        }) + ')(' + JSON.stringify(JSON.stringify({ needle })) + ')',
        true
      );
      writeAutomationOutput({
        ok: result && result.ok === true,
        task: AUTOMATION_TASK,
        referer,
        needle,
        result,
      });
      process.exitCode = result && result.ok === true ? 0 : 1;
      return true;
    }

    if (AUTOMATION_TASK === 'copy-link-draft') {
      if (!draftId) throw new Error('missing_automation_draft_id');
      const loginWindow = await backupService.session.ensureLoginWindow().catch(() => null);
      const loginWindowSnapshotBefore = await readWindowSnapshot(loginWindow);
      const response = await backupService.session.triggerDraftCopyLinkViaUi(draftId, {
        referer,
        readyTimeoutMs: 15000,
        waitMs: 20000,
      });
      const loginWindowSnapshotAfter = await readWindowSnapshot(loginWindow);
      writeAutomationOutput({
        ok: response && response.ok === true,
        task: AUTOMATION_TASK,
        draftId,
        referer,
        loginWindowSnapshotBefore,
        loginWindowSnapshotAfter,
        response,
      });
      process.exitCode = response && response.ok === true ? 0 : 1;
      return true;
    }

    if (AUTOMATION_TASK === 'delete-post') {
      const postId = String(process.env.SVD_AUTOMATION_POST_ID || '').trim();
      const postPermalink = String(process.env.SVD_AUTOMATION_POST_PERMALINK || '').trim();
      if (!postId && !postPermalink) throw new Error('missing_automation_post_target');
      const resolvedPostId = postId || postPermalink.split('/').filter(Boolean).pop();
      const referer = postPermalink || ('https://sora.chatgpt.com/p/' + resolvedPostId);
      const response = await backupService.session.deletePublishedPost(resolvedPostId, {
        pageUrl: referer,
        requestReferer: referer,
        readyTimeoutMs: 15000,
      });
      writeAutomationOutput({
        ok: response && response.ok === true,
        task: AUTOMATION_TASK,
        postId: resolvedPostId,
        referer,
        response,
      });
      process.exitCode = response && response.ok === true ? 0 : 1;
      return true;
    }

    if (AUTOMATION_TASK === 'run-backup') {
      const result = await backupService.startBackup({
        scopes: {
          ownDrafts: true,
          ownPosts: false,
          castInPosts: false,
          castInDrafts: false,
          characterPosts: false,
          ownPrompts: false,
        },
        settings: {
          published_download_mode: String(process.env.SVD_AUTOMATION_PUBLISHED_MODE || 'smart').trim() || 'smart',
          audio_mode: String(process.env.SVD_AUTOMATION_AUDIO_MODE || 'no_audiomark').trim() || 'no_audiomark',
          framing_mode: String(process.env.SVD_AUTOMATION_FRAMING_MODE || 'sora_default').trim() || 'sora_default',
          character_handle: '',
        },
        downloadDir: String(process.env.SVD_AUTOMATION_DOWNLOAD_DIR || '').trim() || undefined,
      });
      if (!result || result.ok !== true) {
        writeAutomationOutput({
          ok: false,
          task: AUTOMATION_TASK,
          start: result || null,
        });
        process.exitCode = 1;
        return true;
      }
      if (backupService.currentJobPromise) {
        await backupService.currentJobPromise.catch(() => {});
      }
      const runId = String(backupService.state && backupService.state.lastRunId || '').trim();
      const run = runId ? await backupService.store.getRun(runId) : null;
      const items = runId ? await backupService.store.getItems(runId) : [];
      writeAutomationOutput({
        ok: !!(run && run.status === 'completed' && Number(run.failed || 0) === 0),
        task: AUTOMATION_TASK,
        start: result,
        run,
        items,
      });
      process.exitCode = run && run.status === 'completed' && Number(run.failed || 0) === 0 ? 0 : 1;
      return true;
    }

    throw new Error('unknown_automation_task');
  } catch (error) {
    writeAutomationOutput({
      ok: false,
      task: AUTOMATION_TASK,
      error: String((error && error.message) || error || 'automation_task_failed'),
      stack: error && error.stack ? String(error.stack) : '',
    });
    process.exitCode = 1;
    return true;
  }
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
    const targetHeight = Math.max(MIN_WINDOW_HEIGHT, Math.min(parsedHeight + CONTENT_SIZE_BUFFER_PX, maxHeight));
    const bounds = window.getContentBounds();
    if (Math.abs(bounds.height - targetHeight) < 2) return { ok: true, height: bounds.height };
    window.setContentSize(bounds.width, targetHeight, true);
    return { ok: true, height: targetHeight };
  });
  ipcMain.handle('session:open', async () => backupService.openLoginWindow());
  ipcMain.handle('session:check', async () => backupService.checkSession());
  ipcMain.handle('session:connect-with-bearer', async (_event, token) => backupService.connectWithBearerToken(token));
  ipcMain.handle('session:logout', async () => backupService.logoutSession());
  ipcMain.handle('settings:update', async (_event, payload) => ({ ok: true, settings: await backupService.updateSettings(payload || {}) }));
  ipcMain.handle('backup:start', async (_event, payload) => backupService.startBackup(payload || {}));
  ipcMain.handle('backup:cancel', async () => backupService.cancelBackup());
  ipcMain.handle('backup:get-clear-cache-targets', async () => backupService.getClearCacheTargets());
  ipcMain.handle('backup:clear-selected-caches', async (_event, payload) => backupService.clearSelectedCaches(payload || {}));
  ipcMain.handle('backup:choose-download-folder', async (_event, currentPath) => {
    const parentWindow = getMainWindow();
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentPath || DEFAULT_DOWNLOAD_FOLDER,
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    await backupService.updateSettings({ downloadDir: result.filePaths[0] });
    return { ok: true, path: result.filePaths[0] };
  });
  ipcMain.handle('post-stats:scan', async () => {
    try {
      const result = await backupService.scanPostStats((progress) => {
        const windows = BrowserWindow.getAllWindows();
        for (let i = 0; i < windows.length; i += 1) {
          windows[i].webContents.send('post-stats:progress', progress);
        }
      });
      return { ok: true, posts: result.posts, savedPath: result.savedPath || null };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error || 'Post stats scan failed.') };
    }
  });
  ipcMain.handle('character-stats:fetch', async (_event, handle) => {
    try {
      const profile = await backupService.fetchCharacterStats(handle);
      return { ok: true, profile };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error || 'Character stats fetch failed.') };
    }
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
    baseDir: path.join(app.getPath('userData'), 'sora-video-downloader'),
    defaultDownloadDir: DEFAULT_DOWNLOAD_FOLDER,
  });
  await backupService.initialize();
  if (process.env.SVD_DEBUG_EXPORT_BACKUP_SERVICE === '1') {
    global.__SORA_BACKUP_DEBUG__ = { backupService };
  }
  if (AUTOMATION_TASK === 'publish-draft' && String(process.env.SVD_AUTOMATION_TRANSPORT || 'page').trim() !== 'session') {
    createWindow();
  }
  if (await maybeRunAutomationTask()) {
    await backupService.shutdown().catch(() => {});
    app.exit(process.exitCode || 0);
    return;
  }
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
      'Sora Video Downloader Failed To Start',
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
  if (global.__SORA_BACKUP_DEBUG__) delete global.__SORA_BACKUP_DEBUG__;
  event.preventDefault();
  Promise.resolve()
    .then(() => backupService && backupService.shutdown ? backupService.shutdown() : null)
    .catch(() => {})
    .finally(() => {
      app.exit(0);
    });
});
