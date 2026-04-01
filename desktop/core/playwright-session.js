const { BrowserWindow, session: electronSession } = require('electron');
const {
  BACKUP_ORIGIN,
  normalizeCharacterHandle,
  normalizeBackupHeaders,
  normalizeCurrentUser,
  sanitizeIdToken,
  sanitizeString,
  shouldRetryBackupStatus,
  getBackupRetryDelayMs,
  BACKUP_FETCH_MAX_ATTEMPTS,
} = require('./helpers');

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

const CHATGPT_SESSION_URL = 'https://chatgpt.com/api/auth/session';

function buildChromeLikeUserAgent() {
  const chromeVersion = String(process.versions.chrome || '134.0.0.0');
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
  }
  if (process.platform === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
  }
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
}

class PlaywrightSession {
  constructor(options) {
    const suffix = sanitizeString(options && options.partitionSuffix, 64) || 'main';
    this.partition = 'persist:sora-backup-auth-' + suffix;
    this.loginWindow = null;
    this.userAgent = buildChromeLikeUserAgent();
    this.acceptLanguages = 'en-US,en';
    this.electronSession = null;
    this.capturedHeaders = {};
    this.lastCapturedHeadersAt = 0;
    this.headerCaptureInstalled = false;
    this.characterProfileCache = {};
    this.activeFetchController = null;
  }

  getSession() {
    if (this.electronSession) return this.electronSession;
    this.electronSession = electronSession.fromPartition(this.partition, { cache: true });
    this.electronSession.setUserAgent(this.userAgent, this.acceptLanguages);
    this.installHeaderCapture(this.electronSession);
    return this.electronSession;
  }

  installHeaderCapture(ses) {
    if (!ses || this.headerCaptureInstalled) return;
    this.headerCaptureInstalled = true;
    ses.webRequest.onBeforeSendHeaders({ urls: [BACKUP_ORIGIN + '/*'] }, (details, callback) => {
      try {
        this.captureAuthHeaders(details && details.requestHeaders ? details.requestHeaders : {});
      } catch {}
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
    const chromeVersion = String(process.versions.chrome || '134.0.0.0').split('.')[0];
    const chUA = '"Google Chrome";v="' + chromeVersion + '", "Chromium";v="' + chromeVersion + '", "Not:A-Brand";v="99"';
    const chPlatform = process.platform === 'win32' ? '"Windows"' : '"macOS"';
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.google.com/*', 'https://google.com/*'] }, (details, callback) => {
      const headers = Object.assign({}, details.requestHeaders);
      headers['sec-ch-ua'] = chUA;
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = chPlatform;
      callback({ cancel: false, requestHeaders: headers });
    });
  }

  captureAuthHeaders(rawHeaders) {
    const nextHeaders = normalizeBackupHeaders(rawHeaders);
    if (!nextHeaders.Authorization) return false;
    this.capturedHeaders = Object.assign({}, this.capturedHeaders, nextHeaders);
    this.lastCapturedHeadersAt = Date.now();
    return true;
  }

  getCapturedHeaders() {
    return Object.assign({}, this.capturedHeaders);
  }

  async refreshAuthHeadersFromSession() {
    const ses = this.getSession();
    try {
      const response = await ses.fetch(CHATGPT_SESSION_URL, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_error) {}
      const accessToken = sanitizeString(
        json && typeof json === 'object'
          ? (json.accessToken || json.access_token || '')
          : '',
        16384
      );
      if (!response.ok || !accessToken) {
        return {
          ok: false,
          status: Number(response.status) || 0,
          error: !response.ok
            ? (typeof text === 'string' ? text.slice(0, 512) : '')
            : 'backup_missing_auth_header',
        };
      }
      this.captureAuthHeaders({
        Authorization: /^Bearer\s+/i.test(accessToken) ? accessToken : ('Bearer ' + accessToken),
        'OAI-Language': this.acceptLanguages,
      });
      return { ok: true, headers: this.getCapturedHeaders() };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: String((error && error.message) || error || 'backup_missing_auth_header'),
      };
    }
  }

  async waitForAuthHeaders(timeoutMs) {
    const timeout = Math.max(0, Number(timeoutMs) || 0);
    const startedAt = Date.now();
    while (!this.capturedHeaders.Authorization && (Date.now() - startedAt) < timeout) {
      await waitMs(120);
    }
    return this.getCapturedHeaders();
  }

  async ensureAuthHeaders(timeoutMs) {
    if (this.capturedHeaders.Authorization) return this.getCapturedHeaders();
    if (timeoutMs > 0) await this.waitForAuthHeaders(timeoutMs);
    if (this.capturedHeaders.Authorization) return this.getCapturedHeaders();
    await this.refreshAuthHeadersFromSession();
    return this.getCapturedHeaders();
  }

  createLoginWindow() {
    const ses = this.getSession();
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 960,
      minHeight: 720,
      autoHideMenuBar: true,
      backgroundColor: '#111827',
      show: false,
      title: 'Sora Sign In',
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.webContents.setUserAgent(this.userAgent, this.acceptLanguages);
    window.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        backgroundColor: '#111827',
        show: true,
        title: 'Sora Sign In',
        width: 1280,
        height: 900,
        minWidth: 960,
        minHeight: 720,
        webPreferences: {
          partition: this.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    }));

    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show();
    });

    window.on('closed', () => {
      if (this.loginWindow === window) {
        this.loginWindow = null;
      }
    });

    this.loginWindow = window;
    return { ses, window };
  }

  async ensureLoginWindow() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) return this.loginWindow;
    const created = this.createLoginWindow();
    const targetUrl = BACKUP_ORIGIN + '/explore?gather=1';
    await created.window.loadURL(targetUrl, {
      userAgent: this.userAgent,
      httpReferrer: BACKUP_ORIGIN + '/',
    });
    return created.window;
  }

  async openLoginWindow() {
    const window = await this.ensureLoginWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return { ok: true, url: window.webContents.getURL() || BACKUP_ORIGIN };
  }

  async close() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      const closingWindow = this.loginWindow;
      this.loginWindow = null;
      closingWindow.close();
    }
  }

  async checkAuth() {
    await this.ensureAuthHeaders(this.loginWindow && !this.loginWindow.isDestroyed() ? 2500 : 0);
    const response = await this.fetchJson('/backend/project_y/v2/me', {}, { maxAttempts: 1, throwOnError: false });
    const user = response.ok ? normalizeCurrentUser(response.json) : { handle: '', id: '' };
    return {
      authenticated: !!(response.ok && (user.handle || user.id)),
      user: response.ok ? user : null,
      status: response.status || 0,
      error: response.ok ? '' : response.error || '',
    };
  }

  async fetchCharacterPostsJson(handle, params, options) {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) throw new Error('backup_character_missing_handle');
    const characterId = await this.resolveCharacterUserId(normalizedHandle, options);
    const response = await this.fetchJson(
      '/backend/project_y/profile_feed/' + encodeURIComponent(characterId),
      Object.assign({}, params, { cut: 'appearances' }),
      Object.assign({}, options, { maxAttempts: 1, throwOnError: false })
    );
    const contentType = String(response.contentType || '').toLowerCase();
    if (response.ok && (contentType.indexOf('json') >= 0 || response.json)) {
      return response.json || {};
    }
    if ((Number(response.status) || 0) > 0) throw new Error('backup_http_' + response.status);
    throw new Error(sanitizeString(response.error, 512) || 'backup_character_lookup_failed');
  }

  async resolveCharacterUserId(handle, options) {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) throw new Error('backup_character_missing_handle');
    if (/^ch_[a-z0-9]+$/.test(normalizedHandle)) return normalizedHandle;
    if (this.characterProfileCache[normalizedHandle]) return this.characterProfileCache[normalizedHandle];

    const response = await this.fetchJson(
      '/backend/project_y/profile/username/' + encodeURIComponent(normalizedHandle),
      {},
      Object.assign({}, options, { maxAttempts: 1, throwOnError: false })
    );
    const profile = response.json && typeof response.json === 'object' ? response.json : {};
    const characterId = sanitizeIdToken(profile.user_id, 256);
    if (response.ok && characterId) {
      this.characterProfileCache[normalizedHandle] = characterId;
      return characterId;
    }
    if ((Number(response.status) || 0) > 0) throw new Error('backup_http_' + response.status);
    throw new Error(sanitizeString(response.error, 512) || 'backup_character_lookup_failed');
  }

  async fetchJson(pathname, params, options) {
    const requestPath = String(pathname || '');
    const queryParams = params || {};
    const settings = options || {};
    const ses = this.getSession();
    const authHeaders = await this.ensureAuthHeaders(0);
    const maxAttempts = Math.max(1, Number(settings.maxAttempts) || BACKUP_FETCH_MAX_ATTEMPTS);
    let lastResponse = { ok: false, status: 0, error: 'backup_page_fetch_failed' };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const controller = new AbortController();
        this.activeFetchController = controller;
        if (settings.signal) {
          if (settings.signal.aborted) controller.abort();
          else settings.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        const url = new URL(requestPath, BACKUP_ORIGIN);
        Object.keys(queryParams).forEach((key) => {
          const value = queryParams[key];
          if (value == null || value === '') return;
          url.searchParams.set(String(key), String(value));
        });
        const response = await ses.fetch(url.toString(), {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            ...authHeaders,
          },
          signal: controller.signal,
        });
        const text = await response.text();
        if (this.activeFetchController === controller) this.activeFetchController = null;
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_error) {}
        lastResponse = {
          ok: response.ok,
          status: Number(response.status) || 0,
          json: json,
          error: response.ok ? '' : (typeof text === 'string' ? text.slice(0, 512) : ''),
          retryAfter: response.headers.get('retry-after') || '',
          contentType: response.headers.get('content-type') || '',
        };
      } catch (error) {
        this.activeFetchController = null;
        lastResponse = {
          ok: false,
          status: 0,
          json: null,
          error: String((error && error.message) || error || 'backup_page_fetch_failed'),
          retryAfter: '',
          contentType: '',
        };
      }

      if (lastResponse.ok) return lastResponse;
      if (attempt >= maxAttempts || !shouldRetryBackupStatus(lastResponse.status)) break;
      await waitMs(getBackupRetryDelayMs(lastResponse.retryAfter, attempt));
    }

    if (settings.throwOnError === false) return lastResponse;
    if ((Number(lastResponse.status) || 0) > 0) {
      throw new Error('backup_http_' + lastResponse.status);
    }
    throw new Error(lastResponse.error || 'backup_page_fetch_failed');
  }

  abortActiveRequest() {
    if (!this.activeFetchController) return;
    try {
      this.activeFetchController.abort();
    } catch (_error) {}
    this.activeFetchController = null;
  }
}

module.exports = {
  PlaywrightSession,
};
