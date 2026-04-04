const https = require('https');
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
const RAW_HTTP_TIMEOUT_MS = 30000;

function getChromeIdentityVersion() {
  const override = sanitizeString(process.env.SVD_CHROME_VERSION, 64) || '148.0.7753.0';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(override)) return override;
  const runtimeVersion = String(process.versions.chrome || '').trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(runtimeVersion)) return runtimeVersion;
  return '148.0.7753.0';
}

function buildChromeLikeUserAgent() {
  const chromeVersion = getChromeIdentityVersion();
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
  }
  if (process.platform === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
  }
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
}

function buildChromeClientHints() {
  const fullVersion = getChromeIdentityVersion();
  const majorVersion = String(fullVersion.split('.')[0] || '134');
  const arch = process.arch === 'arm64' ? '"arm"' : process.arch === 'x64' ? '"x86"' : '""';
  const platform = process.platform === 'win32'
    ? '"Windows"'
    : process.platform === 'linux'
      ? '"Linux"'
      : '"macOS"';
  const platformVersion = typeof process.getSystemVersion === 'function'
    ? String(process.getSystemVersion() || '').trim()
    : '';
  return {
    'sec-ch-ua': `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not/A)Brand";v="99"`,
    'sec-ch-ua-arch': arch,
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-full-version': `"${fullVersion}"`,
    'sec-ch-ua-full-version-list': `"Chromium";v="${fullVersion}", "Google Chrome";v="${fullVersion}", "Not/A)Brand";v="99.0.0.0"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-platform': platform,
    ...(platformVersion ? { 'sec-ch-ua-platform-version': `"${platformVersion}"` } : {}),
  };
}

function redactRequestHeaders(rawHeaders) {
  const source = rawHeaders && typeof rawHeaders === 'object' ? rawHeaders : {};
  const next = {};
  Object.keys(source).forEach((headerName) => {
    const key = String(headerName || '').toLowerCase();
    const value = String(source[headerName] || '');
    if (!key) return;
    if (key === 'authorization' || key === 'openai-sentinel-token') {
      next[key] = value ? '<redacted:' + value.length + '>' : '';
      return;
    }
    if (key === 'cookie') {
      next[key] = value ? '<redacted>' : '';
      return;
    }
    next[key] = value.length > 4096 ? value.slice(0, 4096) : value;
  });
  return next;
}

class PlaywrightSession {
  constructor(options) {
    const suffix = sanitizeString(options && options.partitionSuffix, 64) || 'main';
    this.partition = 'persist:sora-backup-auth-' + suffix;
    this.loginWindow = null;
    this.backgroundWindow = null;
    this.userAgent = buildChromeLikeUserAgent();
    this.acceptLanguages = 'en-US,en';
    this.electronSession = null;
    this.capturedHeaders = {};
    this.manualHeaders = {};
    this.manualCookieNames = [];
    this.lastCapturedHeadersAt = 0;
    this.headerCaptureInstalled = false;
    this.characterProfileCache = {};
    this.activeFetchController = null;
    this.lastObservedRequests = [];
    this.lastKnownDeviceId = '';
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
    const chromeHints = buildChromeClientHints();
    ses.webRequest.onBeforeSendHeaders({ urls: [BACKUP_ORIGIN + '/*', 'https://chatgpt.com/backend-api/sentinel/*', CHATGPT_SESSION_URL] }, (details, callback) => {
      try {
        const headers = Object.assign({}, details && details.requestHeaders ? details.requestHeaders : {});
        const requestUrl = String(details && details.url || '');
        const normalizedUrl = requestUrl.split('?')[0];
        const authHeaders = this.getCapturedHeaders();
        const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
        const manualCookieHeader = sanitizeString(authHeaders && authHeaders.Cookie, 65535) || '';
        const oaiLanguage = sanitizeString(authHeaders && authHeaders['OAI-Language'], 128) || String(this.acceptLanguages || 'en-US').split(',')[0].trim() || 'en-US';
        const deviceId = sanitizeString(
          (authHeaders && authHeaders['OAI-Device-Id']) || this.lastKnownDeviceId,
          1024
        ) || '';

        if (requestUrl.indexOf(BACKUP_ORIGIN + '/') === 0) {
          if (authorization && !headers.Authorization && !headers.authorization) {
            headers.Authorization = authorization;
          }
          if (manualCookieHeader) {
            headers.Cookie = manualCookieHeader;
          }
          if (oaiLanguage && !headers['OAI-Language'] && !headers['oai-language']) {
            headers['OAI-Language'] = oaiLanguage;
          }
          if (deviceId && !headers['OAI-Device-Id'] && !headers['oai-device-id']) {
            headers['OAI-Device-Id'] = deviceId;
          }
        }
        if ((requestUrl.indexOf('https://chatgpt.com/backend-api/sentinel/') === 0 || requestUrl === CHATGPT_SESSION_URL) && manualCookieHeader) {
          headers.Cookie = manualCookieHeader;
        }

        if (
          normalizedUrl === (BACKUP_ORIGIN + '/backend/project_y/post') &&
          String(details && details.method || '').toUpperCase() === 'POST'
        ) {
          Object.assign(headers, chromeHints, {
            priority: headers.priority || 'u=1, i',
            'sec-fetch-dest': headers['sec-fetch-dest'] || 'empty',
            'sec-fetch-mode': headers['sec-fetch-mode'] || 'cors',
            'sec-fetch-site': headers['sec-fetch-site'] || 'same-origin',
          });
        }
        this.captureAuthHeaders(headers);
        const requestHeaders = redactRequestHeaders(headers);
        this.lastObservedRequests.push({
          ts: Date.now(),
          url: String(details && details.url || ''),
          method: String(details && details.method || ''),
          headers: requestHeaders,
        });
        if (this.lastObservedRequests.length > 50) {
          this.lastObservedRequests = this.lastObservedRequests.slice(-50);
        }
      } catch {}
      const nextHeaders = Object.assign({}, details.requestHeaders);
      const requestUrl = String(details && details.url || '');
      const authHeaders = this.getCapturedHeaders();
      const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
      const manualCookieHeader = sanitizeString(authHeaders && authHeaders.Cookie, 65535) || '';
      const oaiLanguage = sanitizeString(authHeaders && authHeaders['OAI-Language'], 128) || String(this.acceptLanguages || 'en-US').split(',')[0].trim() || 'en-US';
      const deviceId = sanitizeString(
        (authHeaders && authHeaders['OAI-Device-Id']) || this.lastKnownDeviceId,
        1024
      ) || '';
      if (requestUrl.indexOf(BACKUP_ORIGIN + '/') === 0) {
        if (authorization && !nextHeaders.Authorization && !nextHeaders.authorization) {
          nextHeaders.Authorization = authorization;
        }
        if (manualCookieHeader) {
          nextHeaders.Cookie = manualCookieHeader;
        }
        if (oaiLanguage && !nextHeaders['OAI-Language'] && !nextHeaders['oai-language']) {
          nextHeaders['OAI-Language'] = oaiLanguage;
        }
        if (deviceId && !nextHeaders['OAI-Device-Id'] && !nextHeaders['oai-device-id']) {
          nextHeaders['OAI-Device-Id'] = deviceId;
        }
      }
      if ((requestUrl.indexOf('https://chatgpt.com/backend-api/sentinel/') === 0 || requestUrl === CHATGPT_SESSION_URL) && manualCookieHeader) {
        nextHeaders.Cookie = manualCookieHeader;
      }
      if ((details && details.url || '').split('?')[0] === (BACKUP_ORIGIN + '/backend/project_y/post')) {
        Object.assign(nextHeaders, {
          ...chromeHints,
          priority: (details.requestHeaders && details.requestHeaders.priority) || 'u=1, i',
          'sec-fetch-dest': (details.requestHeaders && details.requestHeaders['sec-fetch-dest']) || 'empty',
          'sec-fetch-mode': (details.requestHeaders && details.requestHeaders['sec-fetch-mode']) || 'cors',
          'sec-fetch-site': (details.requestHeaders && details.requestHeaders['sec-fetch-site']) || 'same-origin',
        });
      }
      callback({ cancel: false, requestHeaders: nextHeaders });
    });
    const chromeVersion = String(getChromeIdentityVersion()).split('.')[0];
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
    if (nextHeaders.Cookie) delete nextHeaders.Cookie;
    if (!nextHeaders.Authorization && !nextHeaders['OpenAI-Sentinel-Token']) return false;
    if (nextHeaders['OAI-Device-Id']) {
      this.lastKnownDeviceId = sanitizeString(nextHeaders['OAI-Device-Id'], 1024) || this.lastKnownDeviceId;
    }
    this.capturedHeaders = Object.assign({}, this.capturedHeaders, nextHeaders);
    this.lastCapturedHeadersAt = Date.now();
    return true;
  }

  getCapturedHeaders() {
    return Object.assign({}, this.capturedHeaders, this.manualHeaders);
  }

  hasAuthHeaders() {
    return !!(this.getCapturedHeaders().Authorization);
  }

  getLastObservedRequest(url, method) {
    const targetUrl = sanitizeString(url, 4096) || '';
    const targetMethod = sanitizeString(method, 32) || '';
    for (let index = this.lastObservedRequests.length - 1; index >= 0; index -= 1) {
      const entry = this.lastObservedRequests[index];
      if (!entry) continue;
      if (targetUrl && entry.url !== targetUrl) continue;
      if (targetMethod && entry.method !== targetMethod) continue;
      return Object.assign({}, entry);
    }
    return null;
  }

  async _getCookiesForTarget(targetUrl) {
    const target = String(targetUrl || BACKUP_ORIGIN || '').trim() || BACKUP_ORIGIN;
    let parsedUrl = null;
    try {
      parsedUrl = new URL(target);
    } catch (_error) {
      parsedUrl = new URL(BACKUP_ORIGIN);
    }
    const hostname = String(parsedUrl.hostname || '').toLowerCase();
    const pathname = String(parsedUrl.pathname || '/') || '/';
    const isHttps = String(parsedUrl.protocol || '').toLowerCase() === 'https:';
    const ses = this.getSession();

    try {
      const cookies = await ses.cookies.get({});
      return cookies.filter((entry) => {
        const domain = String(entry && entry.domain || entry && entry.host || '')
          .replace(/^\./, '')
          .toLowerCase();
        if (!domain) return false;
        if (!(hostname === domain || hostname.endsWith('.' + domain))) return false;
        const cookiePath = String(entry && entry.path || '/') || '/';
        if (!(pathname === cookiePath || pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : (cookiePath + '/')) || cookiePath === '/')) {
          return false;
        }
        if (entry && entry.secure && !isHttps) return false;
        return true;
      });
    } catch (_error) {
      return [];
    }
  }

  _parseCookieHeader(value) {
    const raw = sanitizeString(value, 65535) || '';
    const parsed = [];
    if (!raw) return parsed;
    const byName = new Map();
    raw.split(';').forEach((part) => {
      const chunk = String(part || '').trim();
      if (!chunk) return;
      const eqIndex = chunk.indexOf('=');
      if (eqIndex <= 0) return;
      const name = chunk.slice(0, eqIndex).trim();
      const cookieValue = chunk.slice(eqIndex + 1).trim();
      if (!name) return;
      // Browsers keep the latest value when copied Cookie headers contain duplicates.
      byName.set(name, { name, value: cookieValue });
    });
    byName.forEach((entry) => parsed.push(entry));
    return parsed;
  }

  async _applyManualCookies(value) {
    const ses = this.getSession();
    const previousNames = Array.isArray(this.manualCookieNames) ? this.manualCookieNames : [];
    const nextCookies = this._parseCookieHeader(value);
    const removalTargets = [BACKUP_ORIGIN, 'https://chatgpt.com'];
    for (let index = 0; index < previousNames.length; index += 1) {
      const name = previousNames[index];
      if (!name) continue;
      for (let targetIndex = 0; targetIndex < removalTargets.length; targetIndex += 1) {
        await ses.cookies.remove(removalTargets[targetIndex], name).catch(() => {});
      }
    }
    if (!nextCookies.length) {
      this.manualCookieNames = [];
      return;
    }
    const deviceCookie = nextCookies.find((entry) => String(entry && entry.name || '').toLowerCase() === 'oai-did');
    if (deviceCookie && deviceCookie.value) {
      this.lastKnownDeviceId = sanitizeString(deviceCookie.value, 1024) || this.lastKnownDeviceId;
    }
    const nextNames = new Set(nextCookies.map((entry) => entry.name));
    for (let index = 0; index < nextCookies.length; index += 1) {
      const entry = nextCookies[index];
      const targets = entry.name.startsWith('__Host-')
        ? [BACKUP_ORIGIN, 'https://chatgpt.com']
        : [BACKUP_ORIGIN, 'https://chatgpt.com'];
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        await ses.cookies.set({
          url: targets[targetIndex],
          name: entry.name,
          value: entry.value,
          path: '/',
          secure: true,
        }).catch(() => {});
      }
    }
    this.manualCookieNames = Array.from(nextNames);
  }

  async setManualAuth(tokenValue, cookieValue) {
    const rawToken = sanitizeString(tokenValue, 16384) || '';
    const rawCookie = sanitizeString(cookieValue, 65535) || '';
    const token = rawToken.replace(/^Bearer\s+/i, '').trim();
    const normalized = token ? ('Bearer ' + token) : '';
    await this._applyManualCookies(rawCookie);
    if (!normalized) {
      this.manualHeaders = rawCookie
        ? { Cookie: rawCookie }
        : {};
      return { ok: true, headers: this.getCapturedHeaders() };
    }
    this.manualHeaders = {
      Authorization: normalized,
      'OAI-Language': this.acceptLanguages,
    };
    if (this.lastKnownDeviceId) this.manualHeaders['OAI-Device-Id'] = this.lastKnownDeviceId;
    if (rawCookie) this.manualHeaders.Cookie = rawCookie;
    this.lastCapturedHeadersAt = Date.now();
    return { ok: true, headers: this.getCapturedHeaders() };
  }

  async setManualBearerToken(value) {
    return this.setManualAuth(value, '');
  }

  async clearAuthState() {
    const ses = this.getSession();
    this.abortActiveRequest();
    await this.close().catch(() => {});
    this.capturedHeaders = {};
    this.manualHeaders = {};
    this.manualCookieNames = [];
    this.lastCapturedHeadersAt = 0;
    this.characterProfileCache = {};
    await ses.clearStorageData().catch(() => {});
    return { ok: true };
  }

  async refreshAuthHeadersFromSession() {
    const ses = this.getSession();
    try {
      const manualCookieHeader = sanitizeString(
        this.manualHeaders && this.manualHeaders.Cookie,
        65535
      ) || '';
      const deviceId = sanitizeString(
        (this.manualHeaders && this.manualHeaders['OAI-Device-Id']) || this.lastKnownDeviceId,
        1024
      ) || '';
      const response = await ses.fetch(CHATGPT_SESSION_URL, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          ...(manualCookieHeader ? { Cookie: manualCookieHeader } : {}),
          ...(deviceId ? { 'OAI-Device-Id': deviceId } : {}),
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
    while (!this.hasAuthHeaders() && (Date.now() - startedAt) < timeout) {
      await waitMs(120);
    }
    return this.getCapturedHeaders();
  }

  async ensureAuthHeaders(timeoutMs) {
    if (this.hasAuthHeaders()) return this.getCapturedHeaders();
    if (timeoutMs > 0) await this.waitForAuthHeaders(timeoutMs);
    if (this.hasAuthHeaders()) return this.getCapturedHeaders();
    await this.refreshAuthHeadersFromSession();
    return this.getCapturedHeaders();
  }

  async getCookieHeader(targetUrl) {
    const exactCookieHeader = sanitizeString(
      this.manualHeaders && this.manualHeaders.Cookie,
      65535
    ) || '';
    if (exactCookieHeader) return exactCookieHeader;

    const merged = new Map();
    const cookies = await this._getCookiesForTarget(targetUrl);
    cookies.forEach((entry) => {
      const name = sanitizeString(entry && entry.name, 256) || '';
      if (!name) return;
      merged.set(name, String(entry && entry.value || ''));
    });
    return Array.from(merged.entries())
      .map(([name, value]) => name + '=' + value)
      .join('; ');
  }

  async getCookieValue(name, targetUrl) {
    const cookieName = sanitizeString(name, 256) || '';
    if (!cookieName) return '';

    const exactCookieHeader = sanitizeString(
      this.manualHeaders && this.manualHeaders.Cookie,
      65535
    ) || '';
    if (exactCookieHeader) {
      const matched = exactCookieHeader
        .split(';')
        .map((part) => String(part || '').trim())
        .find((part) => part.toLowerCase().startsWith(cookieName.toLowerCase() + '='));
      if (matched) {
        const eqIndex = matched.indexOf('=');
        return eqIndex >= 0 ? matched.slice(eqIndex + 1).trim() : '';
      }
    }

    const cookies = await this._getCookiesForTarget(targetUrl);
    const found = cookies.find((entry) => {
      const entryName = sanitizeString(entry && entry.name, 256) || '';
      return entryName.toLowerCase() === cookieName.toLowerCase();
    });
    if (cookieName.toLowerCase() === 'oai-did' && found && found.value) {
      this.lastKnownDeviceId = sanitizeString(found.value, 1024) || this.lastKnownDeviceId;
    }
    return sanitizeString(found && found.value, 1024) || '';
  }

  async getDeviceId(targetUrl) {
    const captured = sanitizeString(
      (this.manualHeaders && this.manualHeaders['OAI-Device-Id']) ||
      (this.capturedHeaders && this.capturedHeaders['OAI-Device-Id']),
      1024
    ) || '';
    if (captured) return captured;
    return await this.getCookieValue('oai-did', targetUrl);
  }

  _requestJsonWithNode(requestUrl, settings) {
    const options = settings || {};
    const url = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl || ''), BACKUP_ORIGIN);
    const method = String(options.method || 'GET').toUpperCase();
    const bodyText = typeof options.body === 'string' ? options.body : '';
    const headers = Object.assign({}, options.headers || {});
    if (bodyText) headers['Content-Length'] = Buffer.byteLength(bodyText);

    return new Promise((resolve, reject) => {
      let settled = false;
      let abortListener = null;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        if (options.signal && abortListener) {
          options.signal.removeEventListener('abort', abortListener);
        }
        handler(value);
      };

      const request = https.request(url, { method, headers }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_error) {}
          finish(resolve, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: Number(response.statusCode) || 0,
            json: json,
            text: text,
            retryAfter: response.headers['retry-after'] || '',
            contentType: response.headers['content-type'] || '',
            headers: response.headers || {},
          });
        });
        response.on('error', (error) => finish(reject, error));
      });

      request.on('error', (error) => finish(reject, error));
      request.setTimeout(RAW_HTTP_TIMEOUT_MS, () => request.destroy(new Error('backup_page_fetch_failed')));

      abortListener = () => request.destroy(new Error('backup_page_fetch_failed'));
      if (options.signal) {
        if (options.signal.aborted) abortListener();
        else options.signal.addEventListener('abort', abortListener, { once: true });
      }

      if (bodyText) request.write(bodyText);
      request.end();
    });
  }

  async requestJsonViaHttp(method, pathname, params, body, options) {
    const requestMethod = String(method || 'GET').toUpperCase();
    const requestPath = String(pathname || '');
    const queryParams = params || {};
    const requestBody = body == null ? null : body;
    const settings = options || {};
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const maxAttempts = Math.max(1, Number(settings.maxAttempts) || BACKUP_FETCH_MAX_ATTEMPTS);
    let lastResponse = { ok: false, status: 0, error: 'backup_page_fetch_failed', retryAfter: '', contentType: '', text: '', request: null };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const url = new URL(requestPath, BACKUP_ORIGIN);
        Object.keys(queryParams).forEach((key) => {
          const value = queryParams[key];
          if (value == null || value === '') return;
          url.searchParams.set(String(key), String(value));
        });
        const cookieHeader =
          sanitizeString(settings.cookieHeader, 65535)
          || sanitizeString(authHeaders && authHeaders.Cookie, 65535)
          || await this.getCookieHeader(url.toString());
        const deviceId = settings.omitDeviceId === true
          ? ''
          : (
              sanitizeString(settings.deviceId, 1024)
              || sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024)
              || await this.getDeviceId(url.toString())
            );
        const requestUserAgent = sanitizeString(settings.userAgent, 1024) || this.userAgent;
        const requestAuthorization =
          sanitizeString(settings.authorization, 16384)
          || authorization;
        const requestHeaders = {
          Accept: settings.accept || '*/*',
          'Accept-Language': this.acceptLanguages + ';q=0.9',
          'User-Agent': requestUserAgent,
          ...(requestAuthorization ? { Authorization: requestAuthorization } : {}),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(deviceId ? { 'OAI-Device-Id': deviceId } : {}),
          ...(settings.headers || {}),
        };
        if (requestBody != null) {
          requestHeaders['Content-Type'] = 'application/json';
          requestHeaders.Origin = settings.origin || requestHeaders.Origin || BACKUP_ORIGIN;
          requestHeaders.Referer = settings.referer || requestHeaders.Referer || (BACKUP_ORIGIN + '/drafts');
        }
        const response = await this._requestJsonWithNode(url, {
          method: requestMethod,
          headers: requestHeaders,
          body: requestBody != null ? JSON.stringify(requestBody) : '',
          signal: settings.signal,
        });
        lastResponse = {
          ok: response.ok,
          status: response.status,
          json: response.json,
          text: typeof response.text === 'string' ? response.text : '',
          error: response.ok ? '' : (typeof response.text === 'string' ? response.text.slice(0, 512) : ''),
          retryAfter: response.retryAfter || '',
          contentType: response.contentType || '',
          request: {
            url: url.toString(),
            headers: redactRequestHeaders(requestHeaders),
            body: requestBody,
          },
        };
      } catch (error) {
        lastResponse = {
          ok: false,
          status: 0,
          json: null,
          text: '',
          error: String((error && error.message) || error || 'backup_page_fetch_failed'),
          retryAfter: '',
          contentType: '',
          request: null,
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

  createBackgroundWindow() {
    const ses = this.getSession();
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#111827',
      title: 'Sora Session',
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    window.on('closed', () => {
      if (this.backgroundWindow === window) {
        this.backgroundWindow = null;
      }
    });

    window.webContents.setUserAgent(this.userAgent, this.acceptLanguages);
    this.backgroundWindow = window;
    return { ses, window };
  }

  async ensureBackgroundWindow() {
    if (this.backgroundWindow && !this.backgroundWindow.isDestroyed()) return this.backgroundWindow;
    return this.createBackgroundWindow().window;
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
    if (this.backgroundWindow && !this.backgroundWindow.isDestroyed()) {
      const closingWindow = this.backgroundWindow;
      this.backgroundWindow = null;
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

  async fetchCharacterDraftsJson(handle, params, options) {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) throw new Error('backup_character_missing_handle');
    const characterId = await this.resolveCharacterUserId(normalizedHandle, options);
    const response = await this.fetchJson(
      '/backend/project_y/profile/' + encodeURIComponent(characterId) + '/drafts/cameos',
      params,
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

  async requestJson(method, pathname, params, body, options) {
    const requestMethod = String(method || 'GET').toUpperCase();
    const requestPath = String(pathname || '');
    const queryParams = params || {};
    const requestBody = body == null ? null : body;
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
        const cookieHeader = sanitizeString(authHeaders && authHeaders.Cookie, 65535) || await this.getCookieHeader(url.toString());
        const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(url.toString());
        const requestHeaders = {
          Accept: settings.accept || 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Accept-Language': this.acceptLanguages + ';q=0.9',
          ...authHeaders,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(deviceId ? { 'OAI-Device-Id': deviceId } : {}),
          ...(settings.headers || {}),
        };
        const fetchOptions = {
          method: requestMethod,
          credentials: 'include',
          cache: 'no-store',
          headers: requestHeaders,
          signal: controller.signal,
        };
        if (requestBody != null) {
          requestHeaders['Content-Type'] = 'application/json';
          requestHeaders.Origin = settings.origin || requestHeaders.Origin || BACKUP_ORIGIN;
          requestHeaders.Referer = settings.referer || requestHeaders.Referer || (BACKUP_ORIGIN + '/drafts');
          fetchOptions.body = JSON.stringify(requestBody);
        }
        const response = await ses.fetch(url.toString(), fetchOptions);
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

  async fetchJson(pathname, params, options) {
    return this.requestJson('GET', pathname, params, null, options);
  }

  async postJson(pathname, body, options) {
    return this.requestJson('POST', pathname, {}, body, options);
  }

  async _ensurePageReady(window, targetUrl, timeoutMs, options) {
    const startedAt = Date.now();
    const timeout = Math.max(1000, Number(timeoutMs) || 30000);
    const settings = options || {};
    const allowSameOriginFallback = settings.allowSameOriginFallback === true;
    let targetOrigin = BACKUP_ORIGIN;
    try {
      targetOrigin = new URL(String(targetUrl || BACKUP_ORIGIN)).origin || BACKUP_ORIGIN;
    } catch (_error) {}
    while ((Date.now() - startedAt) < timeout) {
      try {
        const snapshot = await window.webContents.executeJavaScript(
          '({ href: String(window.location.href || ""), pathname: String(window.location.pathname || ""), title: String(document.title || ""), readyState: String(document.readyState || "") })',
          true
        );
        const href = sanitizeString(snapshot && snapshot.href, 2048) || '';
        const pathname = sanitizeString(snapshot && snapshot.pathname, 512) || '';
        const title = sanitizeString(snapshot && snapshot.title, 512) || '';
        const readyState = sanitizeString(snapshot && snapshot.readyState, 64) || '';
        const challengeTitle = /just a moment/i.test(title);
        const sameOrigin = href.indexOf(targetOrigin + '/') === 0 || href === targetOrigin;
        const onDraftsPage =
          href.indexOf(targetUrl) === 0 ||
          pathname === '/drafts' ||
          pathname.indexOf('/drafts/') === 0;
        if (readyState === 'complete' && !challengeTitle && (onDraftsPage || (allowSameOriginFallback && sameOrigin))) {
          return true;
        }
      } catch (_error) {}
      await waitMs(250);
    }
    return false;
  }

  async _prepareBackgroundWindow(referer, timeoutMs, options) {
    const targetReferer = sanitizeString(referer, 2048) || (BACKUP_ORIGIN + '/drafts');
    const window = await this.ensureBackgroundWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('backup_page_fetch_failed');
    }
    if (!window.webContents.getURL() || window.webContents.getURL().indexOf(targetReferer) !== 0) {
      await window.loadURL(targetReferer, {
        userAgent: this.userAgent,
        httpReferrer: BACKUP_ORIGIN + '/',
      });
    }
    const ready = await this._ensurePageReady(window, targetReferer, timeoutMs, options);
    if (!ready) {
      throw new Error('backup_page_fetch_failed');
    }
    return { window, referer: targetReferer };
  }

  async _prepareExactBackgroundWindow(targetUrl, timeoutMs) {
    const prepared = await this._prepareBackgroundWindow(targetUrl, timeoutMs, { allowSameOriginFallback: false });
    const window = prepared.window;
    const expectedUrl = sanitizeString(targetUrl, 2048) || '';
    if (!expectedUrl) return prepared;

    const startedAt = Date.now();
    const timeout = Math.max(1000, Number(timeoutMs) || 30000);
    while ((Date.now() - startedAt) < timeout) {
      try {
        const snapshot = await window.webContents.executeJavaScript(
          '({ href: String(window.location.href || ""), pathname: String(window.location.pathname || ""), readyState: String(document.readyState || "") })',
          true
        );
        const href = sanitizeString(snapshot && snapshot.href, 2048) || '';
        const readyState = sanitizeString(snapshot && snapshot.readyState, 64) || '';
        if (readyState === 'complete' && href.indexOf(expectedUrl) === 0) {
          return { window, referer: expectedUrl };
        }
      } catch (_error) {}
      await waitMs(250);
    }
    throw new Error('backup_page_fetch_failed');
  }

  async primeAuthHeadersFromPage(referer, timeoutMs) {
    const targetReferer = sanitizeString(referer, 2048) || (BACKUP_ORIGIN + '/drafts');
    const previousCaptureAt = Number(this.lastCapturedHeadersAt) || 0;
    await this._prepareBackgroundWindow(targetReferer, timeoutMs, { allowSameOriginFallback: true });
    const startedAt = Date.now();
    const timeout = Math.max(1000, Number(timeoutMs) || 5000);

    while ((Date.now() - startedAt) < timeout) {
      if ((Number(this.lastCapturedHeadersAt) || 0) > previousCaptureAt && this.hasAuthHeaders()) {
        return this.getCapturedHeaders();
      }
      await waitMs(150);
    }

    return this.getCapturedHeaders();
  }

  async getSentinelToken(flow, referer, options) {
    const targetFlow = sanitizeString(flow, 128) || '';
    if (!targetFlow) {
      return { token: '', source: 'missing', error: 'backup_missing_sentinel_flow' };
    }

    try {
      const prepared = await this._prepareBackgroundWindow(referer, options && options.readyTimeoutMs);
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runSentinelToken(serialized) {
          const input = JSON.parse(serialized);
          async function ensureSentinelSdk() {
            if (window.SentinelSDK && typeof window.SentinelSDK.token === 'function') return true;
            const scriptSrc = Array.from(document.scripts || [])
              .map((script) => String((script && script.src) || ''))
              .find((src) => /\/sentinel\/[^/]+\/sdk\.js(?:$|\?)/.test(src));
            if (!scriptSrc) return false;
            await new Promise((resolve, reject) => {
              const script = document.createElement('script');
              script.src = scriptSrc;
              script.async = true;
              script.onload = () => resolve();
              script.onerror = () => reject(new Error('backup_missing_sentinel_sdk'));
              document.head.appendChild(script);
            });
            return !!(window.SentinelSDK && typeof window.SentinelSDK.token === 'function');
          }

          try {
            const hasSdk = await ensureSentinelSdk();
            if (!hasSdk) {
              return { ok: false, token: '', error: 'backup_missing_sentinel_sdk' };
            }
            if (typeof window.SentinelSDK.init === 'function') {
              try {
                await window.SentinelSDK.init(input.flow);
              } catch (_error) {}
            }
            const token = await window.SentinelSDK.token(input.flow);
            return {
              ok: typeof token === 'string' && token.length > 0,
              token: typeof token === 'string' ? token : '',
              error: '',
            };
          } catch (error) {
            return {
              ok: false,
              token: '',
              error: String((error && error.message) || error || 'backup_missing_sentinel_token'),
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({ flow: targetFlow })) + ')',
        true
      );

      const token = sanitizeString(result && result.token, 65535) || '';
      const error = sanitizeString(result && result.error, 1024) || '';
      if (token) {
        this.captureAuthHeaders({ 'OpenAI-Sentinel-Token': token });
        return { token, source: 'sdk_token', error };
      }
      return { token: '', source: 'missing', error: error || 'backup_missing_sentinel_token' };
    } catch (error) {
      return {
        token: '',
        source: 'missing',
        error: String((error && error.message) || error || 'backup_missing_sentinel_token'),
      };
    }
  }

  async postDraftSharedLinkViaConsole(draftId, body, options) {
    const normalizedDraftId = sanitizeString(draftId, 256) || '';
    if (!normalizedDraftId || !body || typeof body !== 'object') {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_draft_publish_input',
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(settings.pageUrl || settings.navigationUrl, 2048) || (BACKUP_ORIGIN + '/drafts');
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(pageUrl);
    const acceptLanguage = this.acceptLanguages + ';q=0.9';
    const oaiLanguage = String(this.acceptLanguages || 'en-US').split(',')[0].trim() || 'en-US';
    let sentinelToken = '';
    if (settings.useSentinel === true) {
      const sentinel = await this.getSentinelToken('sora_2_create_post', requestReferer, {
        readyTimeoutMs: settings.readyTimeoutMs,
      }).catch(() => ({ token: '' }));
      sentinelToken = sanitizeString(sentinel && sentinel.token, 16384) || '';
    }
    const requestUrl = BACKUP_ORIGIN + '/backend/project_y/post';

    try {
      const prepared = await this._prepareBackgroundWindow(pageUrl, settings.readyTimeoutMs, { allowSameOriginFallback: true });
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runDraftPublishFromConsole(serialized) {
          const input = JSON.parse(serialized);
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
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

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          const networkEvents = [];

          try {
            if (input.warmSoraAuthSession === true) {
              try {
                const authResponse = await window.fetch(window.location.origin + '/api/auth/session', {
                  method: 'GET',
                  mode: 'cors',
                  credentials: 'include',
                  cache: 'no-store',
                  referrer: input.requestReferer,
                  referrerPolicy: 'strict-origin-when-cross-origin',
                  headers: {
                    accept: '*/*',
                    'accept-language': input.acceptLanguage,
                  },
                });
                const authText = await authResponse.text();
                networkEvents.push({
                  id: 0,
                  type: 'auth_session',
                  url: window.location.origin + '/api/auth/session',
                  method: 'GET',
                  request: {
                    headers: {
                      accept: '*/*',
                      'accept-language': input.acceptLanguage,
                    },
                    body: '',
                    json: null,
                  },
                  response: {
                    ok: authResponse.ok === true,
                    status: Number(authResponse.status) || 0,
                    contentType: safeText(authResponse.headers.get('content-type') || '', 256),
                    text: safeText(authText, 16384),
                    json: parseJson(authText),
                    error: authResponse.ok ? '' : safeText(authText, 2048),
                  },
                  createdAt: Date.now(),
                });
                await wait(400);
              } catch (error) {
                networkEvents.push({
                  id: 0,
                  type: 'auth_session',
                  url: window.location.origin + '/api/auth/session',
                  method: 'GET',
                  request: {
                    headers: {
                      accept: '*/*',
                      'accept-language': input.acceptLanguage,
                    },
                    body: '',
                    json: null,
                  },
                  response: {
                    ok: false,
                    status: 0,
                    contentType: '',
                    text: '',
                    json: null,
                    error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
                  },
                  createdAt: Date.now(),
                });
              }
            }
            const requestHeaders = {
              accept: '*/*',
              'accept-language': input.acceptLanguage,
              ...(input.authorization ? { authorization: input.authorization } : {}),
              'content-type': 'application/json',
              ...(input.deviceId ? { 'oai-device-id': input.deviceId } : {}),
              ...(input.oaiLanguage ? { 'oai-language': input.oaiLanguage } : {}),
              ...(input.sentinelToken ? { 'openai-sentinel-token': input.sentinelToken } : {}),
            };
            const requestBody = JSON.stringify(input.body);
            const response = await window.fetch(input.url, {
              method: 'POST',
              mode: 'cors',
              credentials: 'include',
              cache: 'no-store',
              referrer: input.requestReferer,
              referrerPolicy: 'strict-origin-when-cross-origin',
              headers: requestHeaders,
              body: requestBody,
            });
            const responseText = await response.text();
            return {
              ok: response.ok === true,
              status: Number(response.status) || 0,
              json: parseJson(responseText),
              text: safeText(responseText, 16384),
              error: response.ok ? '' : safeText(responseText, 2048),
              contentType: safeText(response.headers.get('content-type') || '', 256),
              request: {
                url: input.url,
                referer: input.requestReferer,
                headers: redactHeaders(requestHeaders),
                body: input.body,
              },
              networkEvents: [{
                id: 1,
                type: 'post',
                url: input.url,
                method: 'POST',
                request: {
                  headers: input.observedRequestHeaders || redactHeaders(requestHeaders),
                  body: requestBody,
                  json: input.body,
                },
                response: {
                  ok: response.ok === true,
                  status: Number(response.status) || 0,
                  contentType: safeText(response.headers.get('content-type') || '', 256),
                  text: safeText(responseText, 16384),
                  json: parseJson(responseText),
                  error: response.ok ? '' : safeText(responseText, 2048),
                },
                createdAt: Date.now(),
              }],
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              json: null,
              text: '',
              error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
              contentType: '',
              request: null,
              networkEvents,
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({
          url: requestUrl,
          requestReferer,
          authorization,
          deviceId,
          acceptLanguage,
          oaiLanguage,
          sentinelToken,
          warmSoraAuthSession: settings.warmSoraAuthSession === true,
          body,
        })) + ')',
        true
      );
      const observedRequest = this.getLastObservedRequest(requestUrl, 'POST');
      const networkEvents = Array.isArray(result && result.networkEvents) ? result.networkEvents : [];
      if (observedRequest && networkEvents.length && networkEvents[0] && networkEvents[0].request) {
        networkEvents[0].request.headers = observedRequest.headers || networkEvents[0].request.headers;
      }

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }
  }

  async trimDraftViaPage(draftId, payload, options) {
    const normalizedDraftId = sanitizeString(draftId, 256) || '';
    const body = payload && typeof payload === 'object' ? payload : null;
    if (!normalizedDraftId || !body) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_draft_trim_input',
        retryAfter: '',
        contentType: '',
        request: null,
        networkEvents: [],
        pipeline: null,
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(settings.pageUrl || settings.navigationUrl, 2048) || (BACKUP_ORIGIN + '/d/' + encodeURIComponent(normalizedDraftId));
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(pageUrl);
    const acceptLanguage = this.acceptLanguages + ';q=0.9';
    const oaiLanguage = String(this.acceptLanguages || 'en-US').split(',')[0].trim() || 'en-US';
    const requestUrl = BACKUP_ORIGIN + '/backend/editor/drafts/' + encodeURIComponent(normalizedDraftId) + '/trim';

    try {
      const prepared = await this._prepareBackgroundWindow(pageUrl, settings.readyTimeoutMs, { allowSameOriginFallback: true });
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runDraftTrimFromConsole(serialized) {
          const input = JSON.parse(serialized);

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          try {
            const requestHeaders = {
              accept: '*/*',
              'accept-language': input.acceptLanguage,
              ...(input.authorization ? { authorization: input.authorization } : {}),
              'content-type': 'application/json',
              ...(input.deviceId ? { 'oai-device-id': input.deviceId } : {}),
              ...(input.oaiLanguage ? { 'oai-language': input.oaiLanguage } : {}),
            };
            const requestBody = JSON.stringify(input.body);
            const response = await window.fetch(input.url, {
              method: 'POST',
              mode: 'cors',
              credentials: 'include',
              cache: 'no-store',
              referrer: input.requestReferer,
              referrerPolicy: 'strict-origin-when-cross-origin',
              headers: requestHeaders,
              body: requestBody,
            });
            const responseText = await response.text();
            return {
              ok: response.ok === true,
              status: Number(response.status) || 0,
              json: parseJson(responseText),
              text: safeText(responseText, 16384),
              error: response.ok ? '' : safeText(responseText, 2048),
              contentType: safeText(response.headers.get('content-type') || '', 256),
              request: {
                url: input.url,
                referer: input.requestReferer,
                headers: redactHeaders(requestHeaders),
                body: input.body,
              },
              networkEvents: [{
                id: 1,
                type: 'trim',
                url: input.url,
                method: 'POST',
                request: {
                  headers: redactHeaders(requestHeaders),
                  body: requestBody,
                  json: input.body,
                },
                response: {
                  ok: response.ok === true,
                  status: Number(response.status) || 0,
                  contentType: safeText(response.headers.get('content-type') || '', 256),
                  text: safeText(responseText, 16384),
                  json: parseJson(responseText),
                  error: response.ok ? '' : safeText(responseText, 2048),
                },
                createdAt: Date.now(),
              }],
              pipeline: {
                trimmedDraftId: safeText(
                  (parseJson(responseText) && (parseJson(responseText).id || parseJson(responseText).generation_id)) || '',
                  256
                ),
                trimmedGenerationId: safeText(
                  (parseJson(responseText) && (parseJson(responseText).generation_id || parseJson(responseText).id)) || '',
                  256
                ),
              },
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              json: null,
              text: '',
              error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
              contentType: '',
              request: null,
              networkEvents: [],
              pipeline: null,
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({
          url: requestUrl,
          requestReferer,
          authorization,
          deviceId,
          acceptLanguage,
          oaiLanguage,
          body,
        })) + ')',
        true
      );

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents: Array.isArray(result && result.networkEvents) ? result.networkEvents : [],
        pipeline: result && result.pipeline ? result.pipeline : null,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        contentType: '',
        request: null,
        networkEvents: [],
        pipeline: null,
      };
    }
  }

  async postDraftSharedLinkViaAppModule(draftId, body, options) {
    const normalizedDraftId = sanitizeString(draftId, 256) || '';
    if (!normalizedDraftId || !body || typeof body !== 'object') {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_draft_publish_input',
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(settings.pageUrl || settings.navigationUrl, 2048) || (BACKUP_ORIGIN + '/drafts');
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const accessToken = authorization.replace(/^Bearer\s+/i, '').trim();
    const requestUrl = BACKUP_ORIGIN + '/backend/project_y/post';

    try {
      const prepared = await this._prepareBackgroundWindow(pageUrl, settings.readyTimeoutMs, { allowSameOriginFallback: true });
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runDraftPublishViaAppModule(serialized) {
          const input = JSON.parse(serialized);

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          function getWebpackRequire() {
            let req = null;
            try {
              const chunk = self.webpackChunk_N_E = self.webpackChunk_N_E || [];
              chunk.push([[Symbol('svd-draft-publish')], {}, function captureRequire(candidate) {
                req = candidate;
              }]);
            } catch (_error) {}
            return req;
          }

          try {
            const req = getWebpackRequire();
            if (!req) {
              return {
                ok: false,
                status: 0,
                json: null,
                text: '',
                error: 'backup_missing_webpack_runtime',
                contentType: '',
                request: null,
                networkEvents: [],
              };
            }

            const backendModule = req(52839);
            const backendClient = backendModule && backendModule.ZP;
            if (!backendClient || typeof backendClient.fetch !== 'function') {
              return {
                ok: false,
                status: 0,
                json: null,
                text: '',
                error: 'backup_missing_backend_module',
                contentType: '',
                request: null,
                networkEvents: [],
              };
            }

            const observedRequestsBefore = Array.isArray(window.__SVDObservedRequests) ? window.__SVDObservedRequests.length : 0;
            const fetchOptions = {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(input.body),
            };
            const backendOptions = {
              accessToken: input.accessToken || undefined,
            };
            if (input.useSentinel === true) backendOptions.sentinelFlow = 'sora_2_create_post';

            try {
              const json = await backendClient.fetch({
                url: '/project_y/post',
                fetchOptions,
                options: backendOptions,
              });
              return {
                ok: true,
                status: 200,
                json: json || null,
                text: safeText(JSON.stringify(json || {}), 16384),
                error: '',
                contentType: 'application/json',
                request: {
                  url: input.requestUrl,
                  referer: input.requestReferer,
                  headers: redactHeaders(fetchOptions.headers || {}),
                  body: input.body,
                },
                networkEvents: [],
                observedRequestsBefore,
              };
            } catch (error) {
              const status = Number(error && error.status) || 0;
              const response = error && error.response ? error.response : null;
              const json = response && typeof response === 'object' ? response : null;
              const text = response
                ? safeText(typeof response === 'string' ? response : JSON.stringify(response), 16384)
                : '';
              return {
                ok: false,
                status,
                json,
                text,
                error: safeText(
                  (error && (error.userMessage || error.message || error.code)) || 'backup_page_fetch_failed',
                  2048
                ),
                contentType: 'application/json',
                request: {
                  url: input.requestUrl,
                  referer: input.requestReferer,
                  headers: redactHeaders(fetchOptions.headers || {}),
                  body: input.body,
                },
                networkEvents: [],
                observedRequestsBefore,
              };
            }
          } catch (error) {
            return {
              ok: false,
              status: 0,
              json: null,
              text: '',
              error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
              contentType: '',
              request: null,
              networkEvents: [],
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({
          accessToken,
          body,
          requestUrl,
          requestReferer,
          useSentinel: settings.useSentinel === true,
        })) + ')',
        true
      );
      const observedRequest = this.getLastObservedRequest(requestUrl, 'POST');

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents: observedRequest ? [{
          id: 1,
          type: 'post',
          url: requestUrl,
          method: 'POST',
          request: {
            headers: observedRequest.headers || {},
            body: JSON.stringify(body),
            json: body,
          },
          response: {
            ok: result && result.ok === true,
            status: Number(result && result.status) || 0,
            contentType: sanitizeString(result && result.contentType, 256) || '',
            text: sanitizeString(result && result.text, 16384) || '',
            json: result && result.json ? result.json : null,
            error: sanitizeString(result && result.error, 2048) || '',
          },
          createdAt: Date.now(),
        }] : [],
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }
  }

  async publishDraftSharedLinkViaEditorPipeline(draftId, payload, options) {
    const normalizedDraftId = sanitizeString(draftId, 256) || '';
    const inputPayload = payload && typeof payload === 'object' ? payload : {};
    const editorProjectBody = inputPayload.editorProjectBody && typeof inputPayload.editorProjectBody === 'object'
      ? inputPayload.editorProjectBody
      : null;
    const postText = sanitizeString(inputPayload.postText, 4096) || 'Downloaded!';
    if (!normalizedDraftId || !editorProjectBody) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_draft_publish_input',
        retryAfter: '',
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(
      settings.pageUrl || settings.navigationUrl,
      2048
    ) || (BACKUP_ORIGIN + '/d/' + encodeURIComponent(normalizedDraftId));
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(pageUrl);
    const oaiLanguage = String(
      sanitizeString(
        authHeaders && authHeaders['OAI-Language'],
        128
      ) || String(this.acceptLanguages || 'en-US').split(',')[0].trim() || 'en-US'
    ).split(',')[0].trim() || 'en-US';

    try {
      const prepared = await this._prepareBackgroundWindow(
        pageUrl,
        settings.readyTimeoutMs || 15000,
        { allowSameOriginFallback: true }
      );
      const observedRequestsBefore = this.lastObservedRequests.length;
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runEditorPublishPipeline(serialized) {
          const input = JSON.parse(serialized);
          const networkEvents = [];
          let pipelineProjectId = '';
          let pipelineTaskId = '';
          let pipelineExportedDraftId = '';
          let pipelineExportedGenerationId = '';

          function wait(ms) {
            return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
          }

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          function extractErrorMessage(json, text, fallback) {
            const errorObject = json && typeof json === 'object' ? json.error : null;
            const candidate =
              (errorObject && (errorObject.message || errorObject.code || errorObject.type)) ||
              (json && typeof json === 'object' && (json.message || json.error_reason || json.reason_str)) ||
              text ||
              fallback;
            return safeText(candidate, 2048);
          }

          function buildHeaders(extraHeaders, includeJsonContentType) {
            return Object.assign(
              {
                accept: '*/*',
                ...(input.authorization ? { authorization: input.authorization } : {}),
                ...(input.deviceId ? { 'oai-device-id': input.deviceId } : {}),
                ...(input.oaiLanguage ? { 'oai-language': input.oaiLanguage } : {}),
              },
              includeJsonContentType ? { 'content-type': 'application/json' } : {},
              extraHeaders || {}
            );
          }

          async function doFetch(step, url, init) {
            const options = init && typeof init === 'object' ? init : {};
            const method = safeText(options.method || 'GET', 16).toUpperCase() || 'GET';
            const fullUrl = new URL(String(url || ''), window.location.origin).toString();
            const bodyText = Object.prototype.hasOwnProperty.call(options, 'body')
              ? options.body
              : (Object.prototype.hasOwnProperty.call(options, 'json') ? JSON.stringify(options.json) : undefined);
            const headers = buildHeaders(
              options.headers,
              bodyText !== undefined || options.forceJsonContentType === true
            );
            const fetchOptions = {
              method,
              mode: 'cors',
              credentials: 'include',
              cache: 'no-store',
              referrer: input.requestReferer,
              referrerPolicy: 'strict-origin-when-cross-origin',
              headers,
            };
            if (bodyText !== undefined) fetchOptions.body = bodyText;

            const response = await window.fetch(fullUrl, fetchOptions);
            const text = await response.text();
            const json = parseJson(text);
            const event = {
              step,
              url: fullUrl,
              method,
              request: {
                headers: redactHeaders(headers),
                body: bodyText === undefined ? '' : safeText(bodyText, 16384),
                json: Object.prototype.hasOwnProperty.call(options, 'json') ? options.json : null,
              },
              response: {
                ok: response.ok === true,
                status: Number(response.status) || 0,
                contentType: safeText(response.headers.get('content-type') || '', 256),
                text: safeText(text, 16384),
                json,
                error: response.ok ? '' : extractErrorMessage(json, text, 'backup_page_fetch_failed'),
              },
              createdAt: Date.now(),
            };
            networkEvents.push(event);
            if (!response.ok) {
              const error = new Error(event.response.error || ('backup_http_' + event.response.status));
              error.status = event.response.status;
              error.json = json;
              error.text = event.response.text;
              error.contentType = event.response.contentType;
              error.request = event.request;
              error.url = fullUrl;
              throw error;
            }
            return {
              ok: true,
              status: event.response.status,
              json,
              text: event.response.text,
              contentType: event.response.contentType,
              request: event.request,
              url: fullUrl,
            };
          }

          function getFirstTaskGeneration(task) {
            const generations = task && Array.isArray(task.generations) ? task.generations : [];
            return generations.length ? generations[0] : null;
          }

          function isTerminalTask(task) {
            const status = safeText(task && task.status, 64).toLowerCase();
            return status === 'succeeded' || status === 'failed' || status === 'cancelled';
          }

          function buildTaskFailureMessage(task, draft) {
            const taskStatus = safeText(task && task.status, 64).toLowerCase();
            const failureReason = safeText(task && task.failure_reason, 256).toLowerCase();
            if (taskStatus === 'cancelled' || failureReason === 'task_cancelled') {
              return 'backup_editor_export_cancelled';
            }
            if (draft && draft.kind === 'sora_content_violation') {
              return safeText(draft.reason_str || draft.markdown_reason_str, 2048) || 'backup_editor_export_failed';
            }
            if (draft && draft.kind === 'sora_error') {
              return safeText(draft.error_reason, 2048) || 'backup_editor_export_failed';
            }
            return safeText(
              (task && (task.message || task.error_reason || task.failure_reason)) || '',
              2048
            ) || 'backup_editor_export_failed';
          }

          try {
            const createProjectResponse = await doFetch('createEditorProject', '/backend/editor/projects', {
              method: 'POST',
              json: input.editorProjectBody,
            });
            const project = createProjectResponse.json && typeof createProjectResponse.json === 'object'
              ? createProjectResponse.json
              : null;
            const projectId = safeText(project && project.id, 256);
            pipelineProjectId = projectId;
            if (!projectId) {
              return {
                ok: false,
                status: Number(createProjectResponse.status) || 0,
                json: project,
                text: safeText(JSON.stringify(project || {}), 16384),
                error: 'backup_missing_editor_project_id',
                retryAfter: '',
                contentType: createProjectResponse.contentType || 'application/json',
                request: createProjectResponse.request,
                networkEvents,
              };
            }

            const exportResponse = await doFetch('exportEditorProject', '/backend/editor/projects/' + encodeURIComponent(projectId) + '/export', {
              method: 'POST',
              forceJsonContentType: true,
            });
            const exportTask = exportResponse.json && typeof exportResponse.json === 'object'
              ? exportResponse.json
              : null;
            const taskId = safeText(
              exportTask && (exportTask.id || exportTask.task_id),
              256
            );
            pipelineTaskId = taskId;
            if (!taskId) {
              return {
                ok: false,
                status: Number(exportResponse.status) || 0,
                json: exportTask,
                text: safeText(JSON.stringify(exportTask || {}), 16384),
                error: 'backup_missing_editor_export_task_id',
                retryAfter: '',
                contentType: exportResponse.contentType || 'application/json',
                request: exportResponse.request,
                networkEvents,
              };
            }

            const timeoutMs = Math.max(1000, Number(input.timeoutMs) || 300000);
            const pollIntervalMs = Math.max(250, Number(input.pollIntervalMs) || 3000);
            const startedAt = Date.now();
            let finalTask = null;
            while ((Date.now() - startedAt) < timeoutMs) {
              const taskResponse = await doFetch('pollEditorExportTask', '/backend/nf/tasks/' + encodeURIComponent(taskId) + '/v2', {
                method: 'GET',
              });
              finalTask = taskResponse.json && typeof taskResponse.json === 'object' ? taskResponse.json : null;
              if (isTerminalTask(finalTask)) break;
              await wait(pollIntervalMs);
            }

            if (!finalTask || !isTerminalTask(finalTask)) {
              return {
                ok: false,
                status: 0,
                json: finalTask,
                text: safeText(JSON.stringify(finalTask || {}), 16384),
                error: 'backup_editor_export_timeout',
                retryAfter: '',
                contentType: 'application/json',
                request: networkEvents.length ? networkEvents[networkEvents.length - 1].request : null,
                networkEvents,
              };
            }

            const exportedDraft = getFirstTaskGeneration(finalTask);
            if (safeText(finalTask.status, 64).toLowerCase() !== 'succeeded' || !exportedDraft || exportedDraft.kind !== 'sora_draft') {
              return {
                ok: false,
                status: 0,
                json: finalTask,
                text: safeText(JSON.stringify(finalTask || {}), 16384),
                error: buildTaskFailureMessage(finalTask, exportedDraft),
                retryAfter: '',
                contentType: 'application/json',
                request: networkEvents.length ? networkEvents[networkEvents.length - 1].request : null,
                networkEvents,
              };
            }

            const exportedGenerationId = safeText(
              exportedDraft.generation_id || exportedDraft.id,
              256
            );
            pipelineExportedDraftId = safeText(exportedDraft.id, 256);
            pipelineExportedGenerationId = exportedGenerationId;
            if (!exportedGenerationId) {
              return {
                ok: false,
                status: 0,
                json: finalTask,
                text: safeText(JSON.stringify(finalTask || {}), 16384),
                error: 'backup_missing_exported_generation_id',
                retryAfter: '',
                contentType: 'application/json',
                request: networkEvents.length ? networkEvents[networkEvents.length - 1].request : null,
                networkEvents,
              };
            }

            const postBody = {
              // Historical fresh-link successes posted the exported editor_stitch
              // generation, not the original draft id, while keeping the fixed
              // caption text.
              attachments_to_create: [{ generation_id: exportedGenerationId, kind: 'sora' }],
              post_text: input.postText || 'Downloaded!',
              destinations: [{ type: 'shared_link_unlisted' }],
            };
            const postResponse = await doFetch('createSharedLinkPost', '/backend/project_y/post', {
              method: 'POST',
              json: postBody,
            });

            return {
              ok: true,
              status: Number(postResponse.status) || 200,
              json: postResponse.json || null,
              text: safeText(JSON.stringify(postResponse.json || {}), 16384),
              error: '',
              retryAfter: '',
              contentType: postResponse.contentType || 'application/json',
              request: {
                url: postResponse.url,
                referer: input.requestReferer,
                headers: postResponse.request && postResponse.request.headers ? postResponse.request.headers : {},
                body: postBody,
              },
              networkEvents,
              pipeline: {
                projectId,
                taskId,
                exportedDraftId: pipelineExportedDraftId,
                exportedGenerationId,
              },
            };
          } catch (error) {
            const pipeline =
              pipelineProjectId || pipelineTaskId || pipelineExportedDraftId || pipelineExportedGenerationId
                ? {
                    projectId: pipelineProjectId,
                    taskId: pipelineTaskId,
                    exportedDraftId: pipelineExportedDraftId,
                    exportedGenerationId: pipelineExportedGenerationId,
                  }
                : null;
            return {
              ok: false,
              status: Number(error && error.status) || 0,
              json: error && error.json ? error.json : null,
              text: safeText(error && error.text, 16384),
              error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
              retryAfter: '',
              contentType: safeText(error && error.contentType, 256),
              request: error && error.request ? error.request : (networkEvents.length ? networkEvents[networkEvents.length - 1].request : null),
              networkEvents,
              pipeline,
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({
          authorization,
          deviceId,
          draftId: normalizedDraftId,
          editorProjectBody,
          oaiLanguage,
          pageUrl,
          pollIntervalMs: Math.max(250, Number(settings.pollIntervalMs) || 3000),
          postText,
          requestReferer,
          timeoutMs: Math.max(1000, Number(settings.timeoutMs) || 300000),
        })) + ')',
        true
      );

      const observedRequests = this.lastObservedRequests.slice(observedRequestsBefore);
      const networkEvents = Array.isArray(result && result.networkEvents) ? result.networkEvents : [];
      networkEvents.forEach((event) => {
        if (!event || !event.url || !event.method || !event.request) return;
        const observed = observedRequests.find((entry) => entry && entry.url === event.url && entry.method === event.method);
        if (observed && observed.headers) {
          event.request.headers = observed.headers;
        }
      });

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        retryAfter: '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents,
        pipeline: result && result.pipeline ? result.pipeline : null,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        retryAfter: '',
        contentType: '',
        request: null,
        networkEvents: [],
        pipeline: null,
      };
    }
  }

  async publishDraftSharedLinkViaEditorAutoPost(draftId, payload, options) {
    const normalizedDraftId = sanitizeString(draftId, 256) || '';
    const inputPayload = payload && typeof payload === 'object' ? payload : {};
    const editorProjectBody = inputPayload.editorProjectBody && typeof inputPayload.editorProjectBody === 'object'
      ? inputPayload.editorProjectBody
      : null;
    const postText = sanitizeString(inputPayload.postText, 4096) || 'Downloaded!';
    if (!normalizedDraftId || !editorProjectBody) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_draft_publish_input',
        retryAfter: '',
        contentType: '',
        request: null,
        networkEvents: [],
        pipeline: null,
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(
      settings.pageUrl || settings.navigationUrl,
      2048
    ) || (BACKUP_ORIGIN + '/d/' + encodeURIComponent(normalizedDraftId));
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(pageUrl);
    const oaiLanguage = String(
      sanitizeString(
        authHeaders && authHeaders['OAI-Language'],
        128
      ) || String(this.acceptLanguages || 'en-US').split(',')[0].trim() || 'en-US'
    ).split(',')[0].trim() || 'en-US';

    try {
      const prepared = await this._prepareBackgroundWindow(
        pageUrl,
        settings.readyTimeoutMs || 15000,
        { allowSameOriginFallback: true }
      );
      const observedRequestsBefore = this.lastObservedRequests.length;
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runEditorAutoPostPipeline(serialized) {
          const input = JSON.parse(serialized);
          const networkEvents = [];
          let pipelineProjectId = '';
          let pipelineTaskId = '';
          let pipelineExportedDraftId = '';
          let pipelineExportedGenerationId = '';

          function wait(ms) {
            return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
          }

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          function extractErrorMessage(json, text, fallback) {
            const errorObject = json && typeof json === 'object' ? json.error : null;
            const candidate =
              (errorObject && (errorObject.message || errorObject.code || errorObject.type)) ||
              (json && typeof json === 'object' && (json.message || json.error_reason || json.reason_str)) ||
              text ||
              fallback;
            return safeText(candidate, 2048);
          }

          function buildHeaders(extraHeaders, includeJsonContentType) {
            return Object.assign(
              {
                accept: '*/*',
                ...(input.authorization ? { authorization: input.authorization } : {}),
                ...(input.deviceId ? { 'oai-device-id': input.deviceId } : {}),
                ...(input.oaiLanguage ? { 'oai-language': input.oaiLanguage } : {}),
              },
              includeJsonContentType ? { 'content-type': 'application/json' } : {},
              extraHeaders || {}
            );
          }

          async function doFetch(step, url, init) {
            const options = init && typeof init === 'object' ? init : {};
            const method = safeText(options.method || 'GET', 16).toUpperCase() || 'GET';
            const fullUrl = new URL(String(url || ''), window.location.origin).toString();
            const bodyText = Object.prototype.hasOwnProperty.call(options, 'body')
              ? options.body
              : (Object.prototype.hasOwnProperty.call(options, 'json') ? JSON.stringify(options.json) : undefined);
            const headers = buildHeaders(
              options.headers,
              bodyText !== undefined || options.forceJsonContentType === true
            );
            const fetchOptions = {
              method,
              mode: 'cors',
              credentials: 'include',
              cache: 'no-store',
              referrer: input.requestReferer,
              referrerPolicy: 'strict-origin-when-cross-origin',
              headers,
            };
            if (bodyText !== undefined) fetchOptions.body = bodyText;

            const response = await window.fetch(fullUrl, fetchOptions);
            const text = await response.text();
            const json = parseJson(text);
            const event = {
              step,
              url: fullUrl,
              method,
              request: {
                headers: redactHeaders(headers),
                body: bodyText === undefined ? '' : safeText(bodyText, 16384),
                json: Object.prototype.hasOwnProperty.call(options, 'json') ? options.json : null,
              },
              response: {
                ok: response.ok === true,
                status: Number(response.status) || 0,
                contentType: safeText(response.headers.get('content-type') || '', 256),
                text: safeText(text, 16384),
                json,
                error: response.ok ? '' : extractErrorMessage(json, text, 'backup_page_fetch_failed'),
              },
              createdAt: Date.now(),
            };
            networkEvents.push(event);
            if (!response.ok) {
              const error = new Error(event.response.error || ('backup_http_' + event.response.status));
              error.status = event.response.status;
              error.json = json;
              error.text = event.response.text;
              error.contentType = event.response.contentType;
              error.request = event.request;
              error.url = fullUrl;
              throw error;
            }
            return {
              ok: true,
              status: event.response.status,
              json,
              text: event.response.text,
              contentType: event.response.contentType,
              request: event.request,
              url: fullUrl,
            };
          }

          function getFirstTaskGeneration(task) {
            const generations = task && Array.isArray(task.generations) ? task.generations : [];
            return generations.length ? generations[0] : null;
          }

          function isTerminalTask(task) {
            const status = safeText(task && task.status, 64).toLowerCase();
            return status === 'succeeded' || status === 'failed' || status === 'cancelled';
          }

          function buildTaskFailureMessage(task, draft) {
            const taskStatus = safeText(task && task.status, 64).toLowerCase();
            const failureReason = safeText(task && task.failure_reason, 256).toLowerCase();
            if (taskStatus === 'cancelled' || failureReason === 'task_cancelled') {
              return 'backup_editor_export_cancelled';
            }
            if (draft && draft.kind === 'sora_content_violation') {
              return safeText(draft.reason_str || draft.markdown_reason_str, 2048) || 'backup_editor_export_failed';
            }
            if (draft && draft.kind === 'sora_error') {
              return safeText(draft.error_reason, 2048) || 'backup_editor_export_failed';
            }
            return safeText(
              (task && (task.message || task.error_reason || task.failure_reason)) || '',
              2048
            ) || 'backup_editor_export_failed';
          }

          try {
            const createProjectResponse = await doFetch('createEditorProject', '/backend/editor/projects', {
              method: 'POST',
              json: input.editorProjectBody,
            });
            const project = createProjectResponse.json && typeof createProjectResponse.json === 'object'
              ? createProjectResponse.json
              : null;
            const projectId = safeText(project && project.id, 256);
            pipelineProjectId = projectId;
            if (!projectId) {
              return {
                ok: false,
                status: Number(createProjectResponse.status) || 0,
                json: project,
                text: safeText(JSON.stringify(project || {}), 16384),
                error: 'backup_missing_editor_project_id',
                retryAfter: '',
                contentType: createProjectResponse.contentType || 'application/json',
                request: createProjectResponse.request,
                networkEvents,
                pipeline: null,
              };
            }

            const exportBody = {
              should_post: true,
              post_text: input.postText || 'Downloaded!',
            };
            const exportResponse = await doFetch('exportEditorProjectAutoPost', '/backend/editor/projects/' + encodeURIComponent(projectId) + '/export', {
              method: 'POST',
              json: exportBody,
            });
            const exportTask = exportResponse.json && typeof exportResponse.json === 'object'
              ? exportResponse.json
              : null;
            const taskId = safeText(
              exportTask && (exportTask.id || exportTask.task_id),
              256
            );
            pipelineTaskId = taskId;
            if (!taskId) {
              return {
                ok: false,
                status: Number(exportResponse.status) || 0,
                json: exportTask,
                text: safeText(JSON.stringify(exportTask || {}), 16384),
                error: 'backup_missing_editor_export_task_id',
                retryAfter: '',
                contentType: exportResponse.contentType || 'application/json',
                request: exportResponse.request,
                networkEvents,
                pipeline: null,
              };
            }

            const timeoutMs = Math.max(1000, Number(input.timeoutMs) || 300000);
            const pollIntervalMs = Math.max(250, Number(input.pollIntervalMs) || 3000);
            const startedAt = Date.now();
            let finalTask = null;
            while ((Date.now() - startedAt) < timeoutMs) {
              const taskResponse = await doFetch('pollEditorExportTask', '/backend/nf/tasks/' + encodeURIComponent(taskId) + '/v2', {
                method: 'GET',
              });
              finalTask = taskResponse.json && typeof taskResponse.json === 'object' ? taskResponse.json : null;
              if (isTerminalTask(finalTask)) break;
              await wait(pollIntervalMs);
            }

            if (!finalTask || !isTerminalTask(finalTask)) {
              return {
                ok: false,
                status: 0,
                json: finalTask,
                text: safeText(JSON.stringify(finalTask || {}), 16384),
                error: 'backup_editor_export_timeout',
                retryAfter: '',
                contentType: 'application/json',
                request: networkEvents.length ? networkEvents[networkEvents.length - 1].request : null,
                networkEvents,
                pipeline: null,
              };
            }

            const exportedDraft = getFirstTaskGeneration(finalTask);
            if (safeText(finalTask.status, 64).toLowerCase() !== 'succeeded' || !exportedDraft || exportedDraft.kind !== 'sora_draft') {
              return {
                ok: false,
                status: 0,
                json: finalTask,
                text: safeText(JSON.stringify(finalTask || {}), 16384),
                error: buildTaskFailureMessage(finalTask, exportedDraft),
                retryAfter: '',
                contentType: 'application/json',
                request: networkEvents.length ? networkEvents[networkEvents.length - 1].request : null,
                networkEvents,
                pipeline: null,
              };
            }

            const exportedGenerationId = safeText(
              exportedDraft.generation_id || exportedDraft.id,
              256
            );
            pipelineExportedDraftId = safeText(exportedDraft.id, 256);
            pipelineExportedGenerationId = exportedGenerationId;
            if (!pipelineExportedDraftId || !exportedGenerationId) {
              return {
                ok: false,
                status: 0,
                json: finalTask,
                text: safeText(JSON.stringify(finalTask || {}), 16384),
                error: 'backup_missing_exported_generation_id',
                retryAfter: '',
                contentType: 'application/json',
                request: networkEvents.length ? networkEvents[networkEvents.length - 1].request : null,
                networkEvents,
                pipeline: null,
              };
            }

            return {
              ok: true,
              status: Number(exportResponse.status) || 200,
              json: finalTask,
              text: safeText(JSON.stringify(finalTask || {}), 16384),
              error: '',
              retryAfter: '',
              contentType: 'application/json',
              request: {
                url: exportResponse.url,
                referer: input.requestReferer,
                headers: exportResponse.request && exportResponse.request.headers ? exportResponse.request.headers : {},
                body: exportBody,
              },
              networkEvents,
              pipeline: {
                projectId,
                taskId,
                exportedDraftId: pipelineExportedDraftId,
                exportedGenerationId,
              },
            };
          } catch (error) {
            const pipeline =
              pipelineProjectId || pipelineTaskId || pipelineExportedDraftId || pipelineExportedGenerationId
                ? {
                    projectId: pipelineProjectId,
                    taskId: pipelineTaskId,
                    exportedDraftId: pipelineExportedDraftId,
                    exportedGenerationId: pipelineExportedGenerationId,
                  }
                : null;
            return {
              ok: false,
              status: Number(error && error.status) || 0,
              json: error && error.json ? error.json : null,
              text: safeText(error && error.text, 16384),
              error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
              retryAfter: '',
              contentType: safeText(error && error.contentType, 256),
              request: error && error.request ? error.request : (networkEvents.length ? networkEvents[networkEvents.length - 1].request : null),
              networkEvents,
              pipeline,
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({
          authorization,
          deviceId,
          draftId: normalizedDraftId,
          editorProjectBody,
          oaiLanguage,
          pageUrl,
          pollIntervalMs: Math.max(250, Number(settings.pollIntervalMs) || 3000),
          postText,
          requestReferer,
          timeoutMs: Math.max(1000, Number(settings.timeoutMs) || 300000),
        })) + ')',
        true
      );

      const observedRequests = this.lastObservedRequests.slice(observedRequestsBefore);
      const networkEvents = Array.isArray(result && result.networkEvents) ? result.networkEvents : [];
      networkEvents.forEach((event) => {
        if (!event || !event.url || !event.method || !event.request) return;
        const observed = observedRequests.find((entry) => entry && entry.url === event.url && entry.method === event.method);
        if (observed && observed.headers) {
          event.request.headers = observed.headers;
        }
      });

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        retryAfter: '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents,
        pipeline: result && result.pipeline ? result.pipeline : null,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        retryAfter: '',
        contentType: '',
        request: null,
        networkEvents: [],
        pipeline: null,
      };
    }
  }

  async deleteEditorProject(projectId, options) {
    const normalizedProjectId = sanitizeString(projectId, 256) || '';
    if (!normalizedProjectId) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_editor_project_id',
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(settings.pageUrl || settings.navigationUrl, 2048)
      || (BACKUP_ORIGIN + '/de/' + encodeURIComponent(normalizedProjectId));
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(pageUrl);
    const oaiLanguage = String(
      sanitizeString(authHeaders && authHeaders['OAI-Language'], 128)
      || String(this.acceptLanguages || 'en-US').split(',')[0].trim()
      || 'en-US'
    ).split(',')[0].trim() || 'en-US';
    const acceptLanguage = this.acceptLanguages + ';q=0.9';
    const requestUrl = BACKUP_ORIGIN + '/backend/editor/projects/' + encodeURIComponent(normalizedProjectId);

    try {
      const prepared = await this._prepareBackgroundWindow(pageUrl, settings.readyTimeoutMs, { allowSameOriginFallback: true });
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runDeleteEditorProject(serialized) {
          const input = JSON.parse(serialized);

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          try {
            const requestHeaders = {
              accept: '*/*',
              'accept-language': input.acceptLanguage,
              ...(input.authorization ? { authorization: input.authorization } : {}),
              ...(input.deviceId ? { 'oai-device-id': input.deviceId } : {}),
              ...(input.oaiLanguage ? { 'oai-language': input.oaiLanguage } : {}),
            };
            const response = await window.fetch(input.url, {
              method: 'DELETE',
              mode: 'cors',
              credentials: 'include',
              cache: 'no-store',
              referrer: input.requestReferer,
              referrerPolicy: 'strict-origin-when-cross-origin',
              headers: requestHeaders,
            });
            const responseText = await response.text();
            return {
              ok: response.ok === true,
              status: Number(response.status) || 0,
              json: parseJson(responseText),
              text: safeText(responseText, 16384),
              error: response.ok ? '' : safeText(responseText, 2048),
              contentType: safeText(response.headers.get('content-type') || '', 256),
              request: {
                url: input.url,
                referer: input.requestReferer,
                headers: redactHeaders(requestHeaders),
              },
              networkEvents: [{
                id: 1,
                type: 'delete',
                url: input.url,
                method: 'DELETE',
                request: {
                  headers: redactHeaders(requestHeaders),
                  body: '',
                  json: null,
                },
                response: {
                  ok: response.ok === true,
                  status: Number(response.status) || 0,
                  contentType: safeText(response.headers.get('content-type') || '', 256),
                  text: safeText(responseText, 16384),
                  json: parseJson(responseText),
                  error: response.ok ? '' : safeText(responseText, 2048),
                },
                createdAt: Date.now(),
              }],
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              json: null,
              text: '',
              error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
              contentType: '',
              request: null,
              networkEvents: [],
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({
          url: requestUrl,
          requestReferer,
          authorization,
          deviceId,
          acceptLanguage,
          oaiLanguage,
        })) + ')',
        true
      );
      const observedRequest = this.getLastObservedRequest(requestUrl, 'DELETE');
      const networkEvents = Array.isArray(result && result.networkEvents) ? result.networkEvents : [];
      if (observedRequest && networkEvents.length && networkEvents[0] && networkEvents[0].request) {
        networkEvents[0].request.headers = observedRequest.headers || networkEvents[0].request.headers;
      }

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }
  }

  async deletePublishedPost(postId, options) {
    const normalizedPostId = sanitizeString(postId, 256) || '';
    if (!normalizedPostId) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_post_id',
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(settings.pageUrl || settings.navigationUrl, 2048)
      || (BACKUP_ORIGIN + '/p/' + encodeURIComponent(normalizedPostId));
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(pageUrl);
    const oaiLanguage = String(
      sanitizeString(authHeaders && authHeaders['OAI-Language'], 128)
      || String(this.acceptLanguages || 'en-US').split(',')[0].trim()
      || 'en-US'
    ).split(',')[0].trim() || 'en-US';
    const acceptLanguage = this.acceptLanguages + ';q=0.9';
    const requestUrl = BACKUP_ORIGIN + '/backend/project_y/post/' + encodeURIComponent(normalizedPostId);

    try {
      const prepared = await this._prepareBackgroundWindow(pageUrl, settings.readyTimeoutMs, { allowSameOriginFallback: true });
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runDeletePublishedPost(serialized) {
          const input = JSON.parse(serialized);

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          try {
            const requestHeaders = {
              accept: '*/*',
              'accept-language': input.acceptLanguage,
              ...(input.authorization ? { authorization: input.authorization } : {}),
              ...(input.deviceId ? { 'oai-device-id': input.deviceId } : {}),
              ...(input.oaiLanguage ? { 'oai-language': input.oaiLanguage } : {}),
            };
            const response = await window.fetch(input.url, {
              method: 'DELETE',
              mode: 'cors',
              credentials: 'include',
              cache: 'no-store',
              referrer: input.requestReferer,
              referrerPolicy: 'strict-origin-when-cross-origin',
              headers: requestHeaders,
            });
            const responseText = await response.text();
            return {
              ok: response.ok === true,
              status: Number(response.status) || 0,
              json: parseJson(responseText),
              text: safeText(responseText, 16384),
              error: response.ok ? '' : safeText(responseText, 2048),
              contentType: safeText(response.headers.get('content-type') || '', 256),
              request: {
                url: input.url,
                referer: input.requestReferer,
                headers: redactHeaders(requestHeaders),
              },
              networkEvents: [{
                id: 1,
                type: 'delete',
                url: input.url,
                method: 'DELETE',
                request: {
                  headers: redactHeaders(requestHeaders),
                  body: '',
                  json: null,
                },
                response: {
                  ok: response.ok === true,
                  status: Number(response.status) || 0,
                  contentType: safeText(response.headers.get('content-type') || '', 256),
                  text: safeText(responseText, 16384),
                  json: parseJson(responseText),
                  error: response.ok ? '' : safeText(responseText, 2048),
                },
                createdAt: Date.now(),
              }],
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              json: null,
              text: '',
              error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
              contentType: '',
              request: null,
              networkEvents: [],
            };
          }
        }) + ')(' + JSON.stringify(JSON.stringify({
          url: requestUrl,
          requestReferer,
          authorization,
          deviceId,
          acceptLanguage,
          oaiLanguage,
        })) + ')',
        true
      );
      const observedRequest = this.getLastObservedRequest(requestUrl, 'DELETE');
      const networkEvents = Array.isArray(result && result.networkEvents) ? result.networkEvents : [];
      if (observedRequest && networkEvents.length && networkEvents[0] && networkEvents[0].request) {
        networkEvents[0].request.headers = observedRequest.headers || networkEvents[0].request.headers;
      }

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }
  }

  async deleteDraft(draftId, options) {
    const normalizedDraftId = sanitizeString(draftId, 256) || '';
    if (!normalizedDraftId) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: 'backup_missing_draft_id',
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }

    const settings = options || {};
    const pageUrl = sanitizeString(settings.pageUrl || settings.navigationUrl, 2048)
      || (BACKUP_ORIGIN + '/d/' + encodeURIComponent(normalizedDraftId));
    const requestReferer = sanitizeString(settings.requestReferer || settings.referer, 2048) || pageUrl;
    await this.primeAuthHeadersFromPage(pageUrl, settings.readyTimeoutMs).catch(() => {});
    const authHeaders = await this.ensureAuthHeaders(0);
    const authorization = sanitizeString(authHeaders && authHeaders.Authorization, 16384) || '';
    const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(pageUrl);
    const oaiLanguage = String(
      sanitizeString(authHeaders && authHeaders['OAI-Language'], 128)
      || String(this.acceptLanguages || 'en-US').split(',')[0].trim()
      || 'en-US'
    ).split(',')[0].trim() || 'en-US';
    const acceptLanguage = this.acceptLanguages + ';q=0.9';
    const requestUrls = [
      BACKUP_ORIGIN + '/backend/editor/drafts/' + encodeURIComponent(normalizedDraftId),
      BACKUP_ORIGIN + '/backend/project_y/profile/drafts/v2/' + encodeURIComponent(normalizedDraftId),
    ];

    try {
      const prepared = await this._prepareBackgroundWindow(pageUrl, settings.readyTimeoutMs, { allowSameOriginFallback: true });
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runDeleteDraft(serialized) {
          const input = JSON.parse(serialized);

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization' || key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value ? '<redacted>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          const requestHeaders = {
            accept: '*/*',
            'accept-language': input.acceptLanguage,
            ...(input.authorization ? { authorization: input.authorization } : {}),
            ...(input.deviceId ? { 'oai-device-id': input.deviceId } : {}),
            ...(input.oaiLanguage ? { 'oai-language': input.oaiLanguage } : {}),
          };
          const networkEvents = [];
          let last = null;

          for (let index = 0; index < input.urls.length; index += 1) {
            const url = String(input.urls[index] || '');
            if (!url) continue;
            try {
              const response = await window.fetch(url, {
                method: 'DELETE',
                mode: 'cors',
                credentials: 'include',
                cache: 'no-store',
                referrer: input.requestReferer,
                referrerPolicy: 'strict-origin-when-cross-origin',
                headers: requestHeaders,
              });
              const responseText = await response.text();
              last = {
                ok: response.ok === true,
                status: Number(response.status) || 0,
                json: parseJson(responseText),
                text: safeText(responseText, 16384),
                error: response.ok ? '' : safeText(responseText, 2048),
                contentType: safeText(response.headers.get('content-type') || '', 256),
                request: {
                  url,
                  referer: input.requestReferer,
                  headers: redactHeaders(requestHeaders),
                },
              };
              networkEvents.push({
                id: index + 1,
                type: 'delete',
                url,
                method: 'DELETE',
                request: {
                  headers: redactHeaders(requestHeaders),
                  body: '',
                  json: null,
                },
                response: {
                  ok: last.ok,
                  status: last.status,
                  contentType: last.contentType,
                  text: last.text,
                  json: last.json,
                  error: last.error,
                },
                createdAt: Date.now(),
              });
              if (response.ok) {
                return Object.assign({}, last, { networkEvents });
              }
            } catch (error) {
              last = {
                ok: false,
                status: 0,
                json: null,
                text: '',
                error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
                contentType: '',
                request: {
                  url,
                  referer: input.requestReferer,
                  headers: redactHeaders(requestHeaders),
                },
              };
            }
          }

          return Object.assign({}, last || {
            ok: false,
            status: 0,
            json: null,
            text: '',
            error: 'backup_draft_delete_failed',
            contentType: '',
            request: null,
          }, { networkEvents });
        }) + ')(' + JSON.stringify(JSON.stringify({
          urls: requestUrls,
          requestReferer,
          authorization,
          deviceId,
          acceptLanguage,
          oaiLanguage,
        })) + ')',
        true
      );

      return {
        ok: result && result.ok === true,
        status: Number(result && result.status) || 0,
        json: result && result.json ? result.json : null,
        text: sanitizeString(result && result.text, 16384) || '',
        error: sanitizeString(result && result.error, 2048) || '',
        contentType: sanitizeString(result && result.contentType, 256) || '',
        request: result && result.request ? result.request : null,
        networkEvents: Array.isArray(result && result.networkEvents) ? result.networkEvents : [],
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
        error: String((error && error.message) || error || 'backup_page_fetch_failed'),
        contentType: '',
        request: null,
        networkEvents: [],
      };
    }
  }

  async triggerDraftCopyLinkViaUi(draftId, options) {
    const normalizedDraftId = sanitizeString(draftId, 256) || '';
    if (!normalizedDraftId) {
      return {
        ok: false,
        error: 'backup_missing_draft_id',
        strategy: '',
        target: null,
        copiedPermalink: '',
        events: [],
        clipboard: [],
        ui: { availableActions: [] },
      };
    }

    const settings = options || {};
    const detailUrl = BACKUP_ORIGIN + '/d/' + encodeURIComponent(normalizedDraftId);
    const referer = detailUrl;
    const waitMsAfterClick = Math.max(5000, Number(settings.waitMs) || 45000);

    try {
      const prepared = await this._prepareExactBackgroundWindow(referer, settings.readyTimeoutMs);
      const result = await prepared.window.webContents.executeJavaScript(
        '(' + String(async function runDraftCopyLinkUi(serialized) {
          const input = JSON.parse(serialized);
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

          function normalizeText(value) {
            return String(value || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
          }

          function safeText(value, maxLen) {
            const raw = String(value || '').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function isVisible(element) {
            if (!element || typeof element.getBoundingClientRect !== 'function') return false;
            const style = window.getComputedStyle(element);
            if (!style) return false;
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }

          function describeElement(element) {
            if (!element) return null;
            const rect = typeof element.getBoundingClientRect === 'function'
              ? element.getBoundingClientRect()
              : { left: 0, top: 0, width: 0, height: 0 };
            return {
              tag: safeText(element.tagName, 32).toLowerCase(),
              text: safeText(element.innerText || element.textContent || '', 256),
              ariaLabel: safeText(element.getAttribute && element.getAttribute('aria-label'), 256),
              title: safeText(element.getAttribute && element.getAttribute('title'), 256),
              role: safeText(element.getAttribute && element.getAttribute('role'), 64),
              testId: safeText(element.getAttribute && element.getAttribute('data-testid'), 128),
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

          function listVisibleActions() {
            return Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], a, [aria-haspopup], [tabindex]'))
              .filter((element) => isVisible(element))
              .map((element) => describeElement(element))
              .filter((entry) => entry && (entry.text || entry.ariaLabel || entry.title || entry.testId || entry.tag === 'button'))
              .slice(0, 60);
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

          function redactHeaders(headers) {
            const next = {};
            Object.keys(headers || {}).forEach((headerName) => {
              const key = String(headerName || '').toLowerCase();
              const value = String(headers[headerName] || '');
              if (!key) return;
              if (key === 'authorization') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              if (key === 'cookie') {
                next[key] = value
                  ? '<redacted:' + value.split(';').filter(Boolean).length + '_cookies>'
                  : '';
                return;
              }
              if (key === 'openai-sentinel-token') {
                next[key] = value ? '<redacted:' + value.length + '>' : '';
                return;
              }
              next[key] = safeText(value, 4096);
            });
            return next;
          }

          function parseJson(text) {
            try {
              return text ? JSON.parse(text) : null;
            } catch (_error) {
              return null;
            }
          }

          function classifyNetworkUrl(value) {
            const url = String(value || '');
            if (/\/backend-api\/sentinel\/req(?:[?#]|$)/.test(url)) return 'sentinel';
            if (/\/backend\/project_y\/post(?:[?#]|$)/.test(url)) return 'post';
            if (/\/backend\/editor\/projects(?:[/?#]|$)/.test(url)) return 'editor_project';
            if (/\/backend\/nf\/tasks\/.+\/v2(?:[?#]|$)/.test(url)) return 'editor_task';
            if (/\/backend\/project_y\//.test(url) || /\/backend\//.test(url)) return 'backend';
            return '';
          }

          function ensureHarness() {
            const existing = window.__soraCopyLinkHarness;
            if (existing && existing.installed) return existing;

            const store = existing || {
              installed: false,
              seq: 0,
              events: [],
              clipboard: [],
            };

            if (typeof window.fetch === 'function') {
              const originalFetch = window.fetch.bind(window);
              window.fetch = async function patchedFetch(resource, init) {
                const requestUrl =
                  typeof resource === 'string'
                    ? resource
                    : (resource && typeof resource.url === 'string' ? resource.url : '');
                const type = classifyNetworkUrl(requestUrl);
                if (!type) return originalFetch(resource, init);

                const requestHeaders = Object.assign(
                  {},
                  headerObjectToMap(resource && resource.headers),
                  headerObjectToMap(init && init.headers)
                );
                const requestBody = bodyToString(init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : null);
                const event = {
                  id: ++store.seq,
                  type,
                  url: safeText(requestUrl, 2048),
                  method: safeText(((init && init.method) || (resource && resource.method) || 'GET'), 16).toUpperCase(),
                  request: {
                    headers: redactHeaders(requestHeaders),
                    body: safeText(requestBody, 16384),
                    json: parseJson(requestBody),
                  },
                  response: null,
                  createdAt: Date.now(),
                };
                store.events.push(event);

                try {
                  const response = await originalFetch(resource, init);
                  const responseText = await response.clone().text();
                  event.response = {
                    ok: response.ok === true,
                    status: Number(response.status) || 0,
                    contentType: safeText(response.headers.get('content-type') || '', 256),
                    text: safeText(responseText, 16384),
                    json: parseJson(responseText),
                    error: response.ok ? '' : safeText(responseText, 2048),
                  };
                  return response;
                } catch (error) {
                  event.response = {
                    ok: false,
                    status: 0,
                    contentType: '',
                    text: '',
                    json: null,
                    error: safeText((error && error.message) || error || 'backup_page_fetch_failed', 2048),
                  };
                  throw error;
                }
              };
            }

            try {
              if (
                navigator &&
                navigator.clipboard &&
                typeof navigator.clipboard.writeText === 'function' &&
                !store.clipboardPatched
              ) {
                const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
                navigator.clipboard.writeText = async function patchedWriteText(value) {
                  const text = safeText(value, 4096);
                  store.clipboard.push({
                    text,
                    createdAt: Date.now(),
                    error: '',
                  });
                  try {
                    return await originalWriteText(value);
                  } catch (error) {
                    store.clipboard.push({
                      text,
                      createdAt: Date.now(),
                      error: safeText((error && error.message) || error || 'clipboard_write_failed', 512),
                    });
                    throw error;
                  }
                };
                store.clipboardPatched = true;
              }
            } catch (_error) {}

            store.installed = true;
            window.__soraCopyLinkHarness = store;
            return store;
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
              const rect = element.getBoundingClientRect();
              const clientX = rect.left + Math.max(1, Math.min(rect.width / 2, rect.width - 1));
              const clientY = rect.top + Math.max(1, Math.min(rect.height / 2, rect.height - 1));
              ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
                element.dispatchEvent(new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: window,
                  clientX,
                  clientY,
                }));
              });
            } catch (_error) {}
            try {
              element.click();
              return true;
            } catch (_error) {
              return false;
            }
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

          function findVisibleElement(matchers) {
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], a, [data-testid]'));
            for (let index = 0; index < candidates.length; index += 1) {
              const candidate = candidates[index];
              if (!isVisible(candidate)) continue;
              const label = labelBundle(candidate);
              if (!label) continue;
              if (matchers.some((matcher) => matcher(label, candidate))) {
                return candidate;
              }
            }
            return null;
          }

          async function waitForVisibleElement(matchers, timeoutMs) {
            const timeout = Math.max(250, Number(timeoutMs) || 0);
            const startedAt = Date.now();
            while ((Date.now() - startedAt) < timeout) {
              const found = findVisibleElement(matchers);
              if (found) return found;
              await wait(200);
            }
            return null;
          }

          function hasVisibleElement(matchers) {
            return !!findVisibleElement(matchers);
          }

          function matchesDraftHref(value, draftId) {
            const text = safeText(value, 4096);
            const targetDraftId = safeText(draftId, 256);
            if (!text || !targetDraftId) return false;
            try {
              const parsed = new URL(text, window.location.origin);
              const segments = String(parsed.pathname || '').split('/').filter(Boolean);
              return segments.length >= 2 && segments[0] === 'd' && segments[1] === targetDraftId;
            } catch (_error) {
              return false;
            }
          }

          function hoverElement(element) {
            if (!element) return;
            try {
              const rect = element.getBoundingClientRect();
              const clientX = rect.left + Math.max(1, Math.min(rect.width / 2, rect.width - 1));
              const clientY = rect.top + Math.max(1, Math.min(rect.height / 2, rect.height - 1));
              ['pointerenter', 'mouseenter', 'pointerover', 'mouseover', 'mousemove'].forEach((type) => {
                element.dispatchEvent(new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: window,
                  clientX,
                  clientY,
                }));
              });
            } catch (_error) {}
          }

          function findDraftCardAnchor(draftId) {
            const targetDraftId = safeText(draftId, 256);
            if (!targetDraftId) return null;
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (let index = 0; index < anchors.length; index += 1) {
              const anchor = anchors[index];
              if (!isVisible(anchor)) continue;
              if (matchesDraftHref(anchor.getAttribute('href') || anchor.href || '', targetDraftId)) {
                return anchor;
              }
            }
            return null;
          }

          async function waitForDraftCardAnchor(draftId, timeoutMs) {
            const timeout = Math.max(250, Number(timeoutMs) || 0);
            const startedAt = Date.now();
            while ((Date.now() - startedAt) < timeout) {
              const found = findDraftCardAnchor(draftId);
              if (found) return found;
              await wait(200);
            }
            return null;
          }

          function findDraftCardContainer(anchor) {
            if (!anchor) return null;
            let node = anchor;
            while (node && node !== document.body) {
              if (typeof node.getBoundingClientRect === 'function' && isVisible(node)) {
                const rect = node.getBoundingClientRect();
                if (rect.width >= 120 && rect.height >= 120) {
                  const menuCandidates = Array.from(node.querySelectorAll('button, [role="button"], [aria-haspopup="menu"], [aria-haspopup="true"]'))
                    .filter((candidate) => isVisible(candidate));
                  if (menuCandidates.length > 0) {
                    return node;
                  }
                }
              }
              node = node.parentElement;
            }
            return anchor.parentElement || null;
          }

          function pickDraftCardMenuButton(card, anchor) {
            if (!card) return null;
            const cardRect = card.getBoundingClientRect();
            const candidates = Array.from(card.querySelectorAll('button, [role="button"], [aria-haspopup], a'))
              .filter((candidate) => candidate !== anchor)
              .filter((candidate) => isInteractiveCandidate(candidate) && isVisible(candidate));
            let best = null;
            let bestScore = Number.POSITIVE_INFINITY;
            candidates.forEach((candidate) => {
              const rect = candidate.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return;
              const label = labelBundle(candidate);
              const popup = normalizeText(candidate.getAttribute && candidate.getAttribute('aria-haspopup'));
              const iconSized = rect.width <= 56 && rect.height <= 56;
              const distanceRight = Math.abs((cardRect.right || 0) - (rect.right || 0));
              const distanceTop = Math.abs((rect.top || 0) - (cardRect.top || 0));
              const distanceBottom = Math.abs((cardRect.bottom || 0) - (rect.bottom || 0));
              const looksMenu =
                popup === 'menu' ||
                popup === 'true' ||
                !label ||
                moreMatchers.some((matcher) => matcher(label, candidate));
              if (!looksMenu && !(iconSized && distanceRight < (cardRect.width * 0.35))) return;
              if (label.indexOf('copy link') >= 0 || label.indexOf('download') >= 0 || label.indexOf('delete') >= 0) return;
              const score =
                (popup === 'menu' ? -800 : 0) +
                (!label ? -220 : 0) +
                (iconSized ? -120 : 0) +
                (moreMatchers.some((matcher) => matcher(label, candidate)) ? -80 : 0) +
                (distanceRight * 2) +
                distanceTop +
                Math.min(distanceBottom, 80) +
                (label ? 80 : 0);
              if (score < bestScore) {
                best = candidate;
                bestScore = score;
              }
            });
            return best;
          }

          function findVisibleDialogElement(matchers) {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
              .filter((dialog) => isVisible(dialog))
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (bRect.width * bRect.height) - (aRect.width * aRect.height);
              });
            for (let index = 0; index < dialogs.length; index += 1) {
              const dialog = dialogs[index];
              const candidates = Array.from(dialog.querySelectorAll('button, [role="button"], [role="menuitem"], a, [data-testid]'));
              for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
                const candidate = candidates[candidateIndex];
                if (!isVisible(candidate)) continue;
                const label = labelBundle(candidate);
                if (!label) continue;
                if (matchers.some((matcher) => matcher(label, candidate))) {
                  return candidate;
                }
              }
            }
            return null;
          }

          async function waitForVisibleDialogElement(matchers, timeoutMs) {
            const timeout = Math.max(250, Number(timeoutMs) || 0);
            const startedAt = Date.now();
            while ((Date.now() - startedAt) < timeout) {
              const found = findVisibleDialogElement(matchers);
              if (found) return found;
              await wait(200);
            }
            return null;
          }

          function extractPostIdFromPermalink(value) {
            const text = safeText(value, 4096);
            if (!text) return '';
            try {
              const parsed = new URL(text, window.location.origin);
              const segments = String(parsed.pathname || '').split('/').filter(Boolean);
              if (
                parsed.origin === window.location.origin &&
                segments.length === 2 &&
                segments[0] === 'p' &&
                /^s_[A-Za-z0-9]+$/i.test(segments[1])
              ) {
                return safeText(segments[1], 256);
              }
            } catch (_error) {}
            return '';
          }

          function normalizeCopiedPermalink(value) {
            const text = safeText(value, 4096);
            if (!text) return '';
            try {
              const parsed = new URL(text, window.location.origin);
              const segments = String(parsed.pathname || '').split('/').filter(Boolean);
              if (
                parsed.origin === window.location.origin &&
                segments.length === 2 &&
                segments[0] === 'p' &&
                /^s_[A-Za-z0-9]+$/i.test(segments[1])
              ) {
                return parsed.origin + parsed.pathname + parsed.search;
              }
            } catch (_error) {}
            return '';
          }

          function findCopiedPermalink(entries, startIndex) {
            const nextEntries = Array.isArray(entries) ? entries.slice(startIndex) : [];
            for (let index = nextEntries.length - 1; index >= 0; index -= 1) {
              const text = normalizeCopiedPermalink(nextEntries[index] && nextEntries[index].text);
              if (text) return text;
            }
            return '';
          }

          function isSharedLinkUnlistedRequest(event) {
            const json = event && event.request && event.request.json;
            const destinations = json && Array.isArray(json.destinations) ? json.destinations : [];
            return destinations.some((entry) => {
              const type = normalizeText(entry && entry.type);
              return type === 'shared_link_unlisted';
            });
          }

          const harness = ensureHarness();
          const startEventIndex = harness.events.length;
          const startClipboardIndex = harness.clipboard.length;

          const copyMatchers = [
            (label) => label === 'copy link',
            (label) => label.indexOf('copy link') >= 0,
          ];
          const copyLinkConfirmMatchers = [
            (label, element) => {
              const role = normalizeText(element && element.getAttribute && element.getAttribute('role'));
              return role !== 'menuitem' && label === 'copy link';
            },
            (label, element) => {
              const role = normalizeText(element && element.getAttribute && element.getAttribute('role'));
              return role !== 'menuitem' && label.indexOf('copy link') >= 0;
            },
          ];
          const settingsMatchers = [
            (label, element) => label === 'settings',
            (label, element) => label.indexOf('settings') >= 0 && normalizeText(element && element.getAttribute && element.getAttribute('aria-haspopup')) === 'menu',
          ];
          const editMatchers = [
            (label) => label === 'edit',
            (label) => label.indexOf(' edit') >= 0 || label.startsWith('edit '),
          ];
          const shareMatchers = [
            (label) => label === 'share',
            (label) => label.indexOf('share') >= 0,
          ];
          const moreMatchers = [
            (label, element) => label.indexOf('more') >= 0,
            (label, element) => label.indexOf('options') >= 0,
            (label, element) => label.indexOf('actions') >= 0,
          ];
          const postMatchers = [
            (label) => label === 'post',
            (label) => label.indexOf(' post') >= 0 || label.startsWith('post '),
          ];
          const copyLinkFromHereMatchers = [
            (label) => label === 'copy link from here',
            (label) => label.indexOf('copy link from here') >= 0,
            (label) => label.indexOf('from here') >= 0 && label.indexOf('copy link') >= 0,
          ];
          const closeEditorMatchers = [
            (label) => label === 'close editor',
            (label) => label.indexOf('close editor') >= 0,
          ];
          const saveEditorMatchers = [
            (label) => label === 'save and open editor project',
            (label) => label.indexOf('save and open editor project') >= 0,
          ];

          function findActionAnchors() {
            const editButton = findVisibleElement(editMatchers);
            const postButton = findVisibleElement(postMatchers);
            return { editButton, postButton };
          }

          function buildActionRowBounds(anchors) {
            const nodes = [anchors && anchors.editButton, anchors && anchors.postButton].filter(Boolean);
            if (!nodes.length) return null;
            const rects = nodes.map((node) => node.getBoundingClientRect());
            const left = Math.min.apply(null, rects.map((rect) => Number(rect.left) || 0)) - 140;
            const right = Math.max.apply(null, rects.map((rect) => Number(rect.right) || 0)) + 180;
            const top = Math.min.apply(null, rects.map((rect) => Number(rect.top) || 0)) - 24;
            const bottom = Math.max.apply(null, rects.map((rect) => Number(rect.bottom) || 0)) + 24;
            const centerY = (top + bottom) / 2;
            return { left, right, top, bottom, centerY };
          }

          function isInteractiveCandidate(element) {
            if (!element || !isVisible(element)) return false;
            const tag = safeText(element.tagName, 16).toLowerCase();
            const role = normalizeText(element.getAttribute && element.getAttribute('role'));
            const popup = normalizeText(element.getAttribute && element.getAttribute('aria-haspopup'));
            const tabIndex = Number(element.tabIndex);
            const style = window.getComputedStyle(element);
            const cursor = normalizeText(style && style.cursor);
            return (
              tag === 'button' ||
              tag === 'a' ||
              role === 'button' ||
              role === 'menuitem' ||
              popup === 'menu' ||
              popup === 'true' ||
              Number.isFinite(tabIndex) && tabIndex >= 0 ||
              cursor === 'pointer' ||
              typeof element.onclick === 'function'
            );
          }

          function overlapsActionRow(element, rowBounds) {
            if (!element || !rowBounds) return false;
            const rect = element.getBoundingClientRect();
            return !(
              rect.right < rowBounds.left ||
              rect.left > rowBounds.right ||
              rect.bottom < rowBounds.top ||
              rect.top > rowBounds.bottom
            );
          }

          function collectActionRowCandidates(anchors) {
            const rowBounds = buildActionRowBounds(anchors);
            if (!rowBounds) return [];
            const seen = new Set();
            const collected = [];

            function pushCandidate(element) {
              if (!element || seen.has(element)) return;
              seen.add(element);
              if (!isInteractiveCandidate(element) || !overlapsActionRow(element, rowBounds)) return;
              collected.push(element);
            }

            Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], [tabindex], a, div, span'))
              .forEach((element) => pushCandidate(element));

            const sampleYs = [
              rowBounds.centerY,
              rowBounds.top + ((rowBounds.bottom - rowBounds.top) * 0.35),
              rowBounds.bottom - ((rowBounds.bottom - rowBounds.top) * 0.35),
            ];
            const width = Math.max(1, rowBounds.right - rowBounds.left);
            sampleYs.forEach((sampleY) => {
              for (let index = 0; index <= 18; index += 1) {
                const sampleX = rowBounds.left + ((width * index) / 18);
                let node = document.elementFromPoint(sampleX, sampleY);
                for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
                  pushCandidate(node);
                }
              }
            });

            return collected;
          }

          function collectGlobalMenuCandidates() {
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup]'));
            return candidates
              .filter((candidate) => isInteractiveCandidate(candidate) && isVisible(candidate))
              .map((candidate) => {
                const label = labelBundle(candidate);
                const rect = candidate.getBoundingClientRect();
                const popup = normalizeText(candidate.getAttribute && candidate.getAttribute('aria-haspopup'));
                return {
                  node: candidate,
                  label,
                  popup,
                  rect,
                };
              })
              .filter((entry) => {
                if (!entry || !entry.node) return false;
                const width = Number(entry.rect && entry.rect.width) || 0;
                const height = Number(entry.rect && entry.rect.height) || 0;
                const top = Number(entry.rect && entry.rect.top) || 0;
                const left = Number(entry.rect && entry.rect.left) || 0;
                const iconSized = width <= 48 && height <= 48;
                const looksLikeMenu = entry.popup === 'menu' || entry.popup === 'true';
                const unlabeled = !entry.label;
                if (!(looksLikeMenu || unlabeled || moreMatchers.some((matcher) => matcher(entry.label, entry.node)))) {
                  return false;
                }
                if (top > 260) return false;
                if (left < 700 && !looksLikeMenu) return false;
                return true;
              })
              .sort((a, b) => {
                const aScore =
                  (a.popup === 'menu' ? -1000 : 0) +
                  (!a.label ? -300 : 0) +
                  ((Number(a.rect && a.rect.top) || 0) * 2) -
                  (Number(a.rect && a.rect.left) || 0);
                const bScore =
                  (b.popup === 'menu' ? -1000 : 0) +
                  (!b.label ? -300 : 0) +
                  ((Number(b.rect && b.rect.top) || 0) * 2) -
                  (Number(b.rect && b.rect.left) || 0);
                return aScore - bScore;
              })
              .map((entry) => entry.node)
              .slice(0, 8);
          }

          function collectDialogSettingsMenuCandidates() {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
              .filter((dialog) => isVisible(dialog))
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (bRect.width * bRect.height) - (aRect.width * aRect.height);
              });
            const scope = dialogs.length ? dialogs[0] : document;
            return Array.from(scope.querySelectorAll('button, [role="button"], [aria-haspopup]'))
              .filter((candidate) => isInteractiveCandidate(candidate) && isVisible(candidate))
              .filter((candidate) => settingsMatchers.some((matcher) => matcher(labelBundle(candidate), candidate)))
              .filter((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return (Number(rect.left) || 0) > 200;
              })
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                if ((bRect.left || 0) !== (aRect.left || 0)) return (bRect.left || 0) - (aRect.left || 0);
                return (bRect.top || 0) - (aRect.top || 0);
              })
              .slice(0, 6);
          }

          function collectDialogMenuCandidates() {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
              .filter((dialog) => isVisible(dialog))
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (bRect.width * bRect.height) - (aRect.width * aRect.height);
              });
            const collected = [];
            dialogs.forEach((dialog) => {
              const dialogLabel = normalizeText(dialog.innerText || dialog.textContent || '');
              const buttons = Array.from(dialog.querySelectorAll('button, [role="button"], [aria-haspopup]'))
                .filter((candidate) => isInteractiveCandidate(candidate) && isVisible(candidate))
                .map((candidate) => {
                  const rect = candidate.getBoundingClientRect();
                  const label = labelBundle(candidate);
                  const popup = normalizeText(candidate.getAttribute && candidate.getAttribute('aria-haspopup'));
                  return { dialog, dialogLabel, candidate, rect, label, popup };
                })
                .filter((entry) => {
                  const width = Number(entry.rect && entry.rect.width) || 0;
                  const height = Number(entry.rect && entry.rect.height) || 0;
                  const iconSized = width <= 56 && height <= 56;
                  const unlabeled = !entry.label;
                  const isMenu = entry.popup === 'menu' || entry.popup === 'true';
                  if (!(isMenu || unlabeled || moreMatchers.some((matcher) => matcher(entry.label, entry.candidate)))) {
                    return false;
                  }
                  if (entry.label.indexOf('copy link') >= 0 || entry.label.indexOf('post') >= 0 || entry.label.indexOf('edit') >= 0) {
                    return false;
                  }
                  if (!(entry.dialogLabel.indexOf('edit') >= 0 || entry.dialogLabel.indexOf('post') >= 0)) {
                    return false;
                  }
                  return isMenu || unlabeled || iconSized;
                });
              collected.push.apply(collected, buttons);
            });
            return collected
              .sort((a, b) => {
                const aRect = a.rect || { top: 0, left: 0 };
                const bRect = b.rect || { top: 0, left: 0 };
                const aScore =
                  ((Number(aRect.top) || 0) * 2) -
                  (Number(aRect.left) || 0) +
                  (a.popup === 'menu' ? -1000 : 0) +
                  (!a.label ? -300 : 0);
                const bScore =
                  ((Number(bRect.top) || 0) * 2) -
                  (Number(bRect.left) || 0) +
                  (b.popup === 'menu' ? -1000 : 0) +
                  (!b.label ? -300 : 0);
                return aScore - bScore;
              })
              .map((entry) => entry.candidate)
              .slice(0, 8);
          }

          function findAncestorWithEditAndPost(element) {
            let node = element && element.parentElement;
            for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
              const buttons = Array.from(node.querySelectorAll('button, [role="button"]'))
                .filter((candidate) => isVisible(candidate))
                .map((candidate) => labelBundle(candidate));
              const hasEdit = buttons.some((label) => label === 'edit' || label.indexOf(' edit') >= 0 || label.startsWith('edit '));
              const hasPost = buttons.some((label) => label === 'post' || label.indexOf(' post') >= 0 || label.startsWith('post '));
              if (hasEdit && hasPost) return node;
            }
            return null;
          }

          function collectDetailPanelMenuCandidates() {
            return Array.from(document.querySelectorAll('button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]'))
              .filter((candidate) => isInteractiveCandidate(candidate) && isVisible(candidate))
              .map((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const label = labelBundle(candidate);
                const panel = findAncestorWithEditAndPost(candidate);
                return { candidate, rect, label, panel };
              })
              .filter((entry) => {
                if (!entry.panel) return false;
                const top = Number(entry.rect && entry.rect.top) || 0;
                const left = Number(entry.rect && entry.rect.left) || 0;
                const width = Number(entry.rect && entry.rect.width) || 0;
                const height = Number(entry.rect && entry.rect.height) || 0;
                const iconSized = width <= 48 && height <= 48;
                if (!iconSized) return false;
                if (top > 220) return false;
                if (left < 700) return false;
                if (entry.label.indexOf('settings') >= 0) return false;
                return true;
              })
              .sort((a, b) => {
                const aTop = Number(a.rect && a.rect.top) || 0;
                const bTop = Number(b.rect && b.rect.top) || 0;
                if (aTop !== bTop) return aTop - bTop;
                return (Number(b.rect && b.rect.left) || 0) - (Number(a.rect && a.rect.left) || 0);
              })
              .map((entry) => entry.candidate)
              .slice(0, 4);
          }

          function hasRelevantBackendEvent(events, startIndex) {
            const nextEvents = Array.isArray(events) ? events.slice(startIndex) : [];
            return nextEvents.some((entry) => {
              if (!entry || !entry.type) return false;
              return entry.type !== 'sentinel';
            });
          }

          function pickPostActionMenuButton(candidates, anchors) {
            const postButton = anchors && anchors.postButton;
            const postRect = postButton && typeof postButton.getBoundingClientRect === 'function'
              ? postButton.getBoundingClientRect()
              : { left: 0, right: 0, top: 0 };
            let best = null;
            let bestScore = Number.POSITIVE_INFINITY;
            (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
              if (candidate === (anchors && anchors.editButton) || candidate === postButton) return;
              if ((anchors && anchors.editButton) && anchors.editButton.contains(candidate)) return;
              if (postButton && postButton.contains(candidate)) return;
              const label = labelBundle(candidate);
              if (label.indexOf('post') >= 0 || label.indexOf('edit') >= 0) return;
              if (label.indexOf('search') >= 0 || label.indexOf('activity') >= 0 || label.indexOf('settings') >= 0) return;
              const popup = normalizeText(candidate.getAttribute && candidate.getAttribute('aria-haspopup'));
              const rect = candidate.getBoundingClientRect();
              const unlabeled = !label;
              const iconSized = rect.width <= 64 && rect.height <= 64;
              if (!(popup === 'menu' || unlabeled || iconSized || moreMatchers.some((matcher) => matcher(label, candidate)))) return;
              const score =
                Math.abs((rect.top || 0) - (postRect.top || 0)) * 4 +
                Math.abs((rect.left || 0) - ((postRect.right || postRect.left || 0) + 24)) +
                (popup === 'menu' ? -500 : 0) +
                (unlabeled ? -250 : 0) +
                (iconSized ? -120 : 0) +
                (label ? 100 : 0);
              if (score < bestScore) {
                best = candidate;
                bestScore = score;
              }
            });
            return best;
          }

          let strategy = '';
          let target = null;
          const isDraftsGridPage =
            input.allowDraftsGridFallback === true &&
            /^\/drafts(?:\/|$)?/.test(String(window.location.pathname || ''));

          async function waitForShareSurface(timeoutMs) {
            const timeout = Math.max(500, Number(timeoutMs) || 0);
            const startedAt = Date.now();
            while ((Date.now() - startedAt) < timeout) {
              if (
                hasVisibleElement(copyMatchers) ||
                hasVisibleElement(shareMatchers) ||
                hasVisibleElement(postMatchers)
              ) {
                return true;
              }
              await wait(250);
            }
            return false;
          }

          if (!strategy) {
            const detailPanelMenuCandidates = collectDetailPanelMenuCandidates();
            for (let index = 0; !strategy && index < detailPanelMenuCandidates.length; index += 1) {
              const candidate = detailPanelMenuCandidates[index];
              if (!candidate || !clickElement(candidate)) continue;
              await wait(350);
              const copyLink = await waitForVisibleElement(copyMatchers, 2500);
              if (!copyLink) continue;
              if (!clickElement(copyLink)) continue;
              await wait(350);
              const confirmCopyLink = await waitForVisibleDialogElement(copyLinkConfirmMatchers, 2500);
              if (confirmCopyLink) clickElement(confirmCopyLink);
              strategy = confirmCopyLink ? 'detail_panel_menu_then_confirm_copy_link' : 'detail_panel_menu_then_copy_link';
              target = describeElement(confirmCopyLink || copyLink || candidate);
            }
          }

          if (!strategy) {
            const detailDialogMenuCandidates = collectDialogMenuCandidates();
            for (let index = 0; !strategy && index < detailDialogMenuCandidates.length; index += 1) {
              const candidate = detailDialogMenuCandidates[index];
              if (!candidate || !clickElement(candidate)) continue;
              await wait(350);
              const copyLink = await waitForVisibleElement(copyMatchers, 1800);
              if (!copyLink) continue;
              if (!clickElement(copyLink)) continue;
              await wait(350);
              const confirmCopyLink = await waitForVisibleDialogElement(copyLinkConfirmMatchers, 2500);
              if (confirmCopyLink) clickElement(confirmCopyLink);
              strategy = confirmCopyLink ? 'detail_dialog_menu_then_confirm_copy_link' : 'detail_dialog_menu_then_copy_link';
              target = describeElement(confirmCopyLink || copyLink || candidate);
            }
          }

          if (!strategy && isDraftsGridPage) {
            const draftAnchor = await waitForDraftCardAnchor(input.draftId, 6000);
            if (draftAnchor) {
              try {
                draftAnchor.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              } catch (_error) {}
              await wait(250);
              const draftCard = findDraftCardContainer(draftAnchor);
              hoverElement(draftAnchor);
              hoverElement(draftCard);
              await wait(300);
              const menuButton = pickDraftCardMenuButton(draftCard, draftAnchor);
              if (menuButton && clickElement(menuButton)) {
                await wait(350);
                const copyLink = await waitForVisibleElement(copyMatchers, 2500);
                if (copyLink && clickElement(copyLink)) {
                  await wait(350);
                  const confirmCopyLink = await waitForVisibleDialogElement(copyLinkConfirmMatchers, 2500);
                  if (confirmCopyLink) clickElement(confirmCopyLink);
                  strategy = confirmCopyLink ? 'draft_grid_menu_then_confirm_copy_link' : 'draft_grid_menu_then_copy_link';
                  target = describeElement(confirmCopyLink || copyLink || menuButton);
                }
              }
            }
          }

          if (!strategy) {
            return {
              ok: false,
              error: 'backup_copy_link_button_not_found',
              strategy: '',
              target: null,
              copiedPermalink: '',
              events: harness.events.slice(startEventIndex),
              clipboard: harness.clipboard.slice(startClipboardIndex),
              ui: { availableActions: listVisibleActions() },
            };
          }

          const timeout = Math.max(2000, Number(input.waitMs) || 15000);
          const startedAt = Date.now();
          while ((Date.now() - startedAt) < timeout) {
            const nextEvents = harness.events.slice(startEventIndex);
            const postEvents = nextEvents.filter((entry) => entry && entry.type === 'post' && entry.response);
            const postEvent = postEvents.find((entry) => isSharedLinkUnlistedRequest(entry));
            const copiedPermalink = findCopiedPermalink(harness.clipboard, startClipboardIndex);
            if (postEvent) {
              return {
                ok: !!(postEvent.response && postEvent.response.ok),
                error: postEvent.response && postEvent.response.ok ? '' : safeText(postEvent.response && postEvent.response.error, 2048),
                strategy,
                target,
                copiedPermalink,
                events: nextEvents,
                clipboard: harness.clipboard.slice(startClipboardIndex),
                ui: { availableActions: listVisibleActions() },
              };
            }
            await wait(250);
          }

          const nextEvents = harness.events.slice(startEventIndex);
          const postEvents = nextEvents.filter((entry) => entry && entry.type === 'post' && entry.response);
          if (postEvents.length > 0) {
            return {
              ok: false,
              error: 'backup_copy_link_non_unlisted_destination',
              strategy,
              target,
              copiedPermalink: findCopiedPermalink(harness.clipboard, startClipboardIndex),
              events: nextEvents,
              clipboard: harness.clipboard.slice(startClipboardIndex),
              ui: { availableActions: listVisibleActions() },
            };
          }

          return {
            ok: false,
            error: 'backup_copy_link_post_timeout',
            strategy,
            target,
            copiedPermalink: findCopiedPermalink(harness.clipboard, startClipboardIndex),
            events: harness.events.slice(startEventIndex),
            clipboard: harness.clipboard.slice(startClipboardIndex),
            ui: { availableActions: listVisibleActions() },
          };
        }) + ')(' + JSON.stringify(JSON.stringify({
          draftId: normalizedDraftId,
          waitMs: waitMsAfterClick,
          allowDraftsGridFallback: false,
        })) + ')',
        true
      );

      return {
        ok: !!(result && result.ok),
        error: sanitizeString(result && result.error, 2048) || '',
        strategy: sanitizeString(result && result.strategy, 128) || '',
        target: result && typeof result.target === 'object' ? result.target : null,
        copiedPermalink: sanitizeString(result && result.copiedPermalink, 2048) || '',
        events: Array.isArray(result && result.events) ? result.events : [],
        clipboard: Array.isArray(result && result.clipboard) ? result.clipboard : [],
        ui: result && typeof result.ui === 'object' ? result.ui : { availableActions: [] },
      };
    } catch (error) {
      return {
        ok: false,
        error: String((error && error.message) || error || 'backup_copy_link_ui_failed'),
        strategy: '',
        target: null,
        copiedPermalink: '',
        events: [],
        clipboard: [],
        ui: { availableActions: [] },
      };
    }
  }

  async requestJsonViaPage(method, pathname, params, body, options) {
    const requestMethod = String(method || 'GET').toUpperCase();
    const requestPath = String(pathname || '');
    const queryParams = params || {};
    const requestBody = body == null ? null : body;
    const settings = options || {};
    const authHeaders = await this.ensureAuthHeaders(0);
    const maxAttempts = Math.max(1, Number(settings.maxAttempts) || BACKUP_FETCH_MAX_ATTEMPTS);
    let lastResponse = { ok: false, status: 0, error: 'backup_page_fetch_failed', retryAfter: '', contentType: '' };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const url = new URL(requestPath, BACKUP_ORIGIN);
        Object.keys(queryParams).forEach((key) => {
          const value = queryParams[key];
          if (value == null || value === '') return;
          url.searchParams.set(String(key), String(value));
        });

        const referer = settings.referer || (BACKUP_ORIGIN + '/drafts');
        const prepared = await this._prepareBackgroundWindow(referer, settings.readyTimeoutMs);
        const window = prepared.window;
        const deviceId = sanitizeString(authHeaders && authHeaders['OAI-Device-Id'], 1024) || await this.getDeviceId(referer);

        const pageHeaders = {
          Accept: settings.accept || '*/*',
          ...(authHeaders && authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
          ...(authHeaders && authHeaders['OpenAI-Sentinel-Token'] ? { 'OpenAI-Sentinel-Token': authHeaders['OpenAI-Sentinel-Token'] } : {}),
          ...(deviceId ? { 'OAI-Device-Id': deviceId } : {}),
          ...(authHeaders && authHeaders['OAI-Language'] ? { 'OAI-Language': authHeaders['OAI-Language'] } : {}),
          ...(settings.headers || {}),
        };
        if (requestBody != null) {
          pageHeaders['Content-Type'] = 'application/json';
        }

        const payload = {
          url: url.toString(),
          method: requestMethod,
          headers: pageHeaders,
          body: requestBody,
        };
        const response = await window.webContents.executeJavaScript(
          '(' + String(async function runPageRequest(serialized) {
            const input = JSON.parse(serialized);
            const headers = new Headers(input.headers || {});
            const response = await fetch(input.url, {
              method: String(input.method || 'GET').toUpperCase(),
              credentials: 'include',
              cache: 'no-store',
              headers,
              body: input.body == null ? undefined : JSON.stringify(input.body),
            });
            const text = await response.text();
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch (_error) {}
            return {
              ok: response.ok,
              status: Number(response.status) || 0,
              json,
              text,
              retryAfter: response.headers.get('retry-after') || '',
              contentType: response.headers.get('content-type') || '',
            };
          }) + ')(' + JSON.stringify(JSON.stringify(payload)) + ')',
          true
        );

        lastResponse = {
          ok: response && response.ok === true,
          status: Number(response && response.status) || 0,
          json: response && response.json ? response.json : null,
          text: typeof (response && response.text) === 'string' ? response.text : '',
          error: response && response.ok ? '' : (typeof (response && response.text) === 'string' ? response.text.slice(0, 512) : ''),
          retryAfter: response && response.retryAfter ? response.retryAfter : '',
          contentType: response && response.contentType ? response.contentType : '',
        };
      } catch (error) {
        lastResponse = {
          ok: false,
          status: 0,
          json: null,
          text: '',
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

  async postJsonViaHttp(pathname, body, options) {
    return this.requestJsonViaHttp('POST', pathname, {}, body, options);
  }

  async postJsonViaPage(pathname, body, options) {
    return this.requestJsonViaPage('POST', pathname, {}, body, options);
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
