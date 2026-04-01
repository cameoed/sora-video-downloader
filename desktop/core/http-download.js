const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const KONTEN_SMART_DOWNLOAD_API_BASE = 'https://api.dyysy.com/links20260207/';
const KONTEN_SMART_DOWNLOAD_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://kontenai.net',
  referer: 'https://kontenai.net/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};
const SORAVDL_PROXY_BASE = 'https://soravdl.com/api/proxy/video/';
const DEFAULT_DOWNLOAD_HEADERS = {
  'user-agent': 'Sora Video Downloader',
};
const REQUEST_BUFFER_TIMEOUT_MS = 15000;
const DOWNLOAD_SOCKET_TIMEOUT_MS = 20000;

const SMART_DOWNLOAD_PROVIDERS = [
  {
    id: 'konten',
    async resolve(item, options) {
      const postUrl = String(item && item.post_permalink || '').trim();
      if (!postUrl) throw new Error('smart_download_missing_post_permalink');

      const apiUrl = KONTEN_SMART_DOWNLOAD_API_BASE + encodeURIComponent(postUrl.replace(/\\/g, ''));
      const raw = await requestBuffer(apiUrl, { headers: KONTEN_SMART_DOWNLOAD_HEADERS }, 0, options || {});
      let payload = null;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch (_error) {
        throw new Error('smart_download_invalid_json');
      }

      const links = payload && typeof payload === 'object' ? payload.links || {} : {};
      const downloadUrl = links.mp4 || links.mp4_source || '';
      if (!downloadUrl) throw new Error('smart_download_missing_mp4_url');
      return {
        url: String(downloadUrl),
        headers: {},
      };
    },
  },
  {
    id: 'soravdl',
    async resolve(item) {
      const itemId = String(item && item.id || '').trim();
      if (!itemId) throw new Error('smart_download_missing_item_id');
      return {
        url: SORAVDL_PROXY_BASE + encodeURIComponent(itemId),
        headers: {
          accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
          referer: 'https://jsonpromptgenerator.net/bulk-sora-video-downloader',
          origin: 'https://jsonpromptgenerator.net',
        },
        acceptVideoOnErrorStatus: true,
      };
    },
  },
];

function ensureDir(dirPath) {
  return fs.promises.mkdir(dirPath, { recursive: true });
}

function readResponseBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

function requestBuffer(sourceUrl, options, redirectCount, requestOptions) {
  const redirects = Number(redirectCount) || 0;
  const extraOptions = requestOptions || {};
  if (redirects > 5) {
    return Promise.reject(new Error('download_redirect_limit_exceeded'));
  }

  return new Promise((resolve, reject) => {
    const url = new URL(sourceUrl);
    const client = url.protocol === 'http:' ? http : https;
    const request = client.get(
      sourceUrl,
      options || {},
      async (response) => {
        const status = Number(response.statusCode) || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          try {
            const redirected = new URL(response.headers.location, sourceUrl).toString();
            resolve(await requestBuffer(redirected, options, redirects + 1, extraOptions));
          } catch (error) {
            reject(error);
          }
          return;
        }

        if (status < 200 || status >= 300) {
          const body = await readResponseBody(response).catch(() => Buffer.from(''));
          const message = body.length ? body.toString('utf8').slice(0, 512) : '';
          reject(new Error(message || ('download_http_' + status)));
          return;
        }

        try {
          resolve(await readResponseBody(response));
        } catch (error) {
          reject(error);
        }
      }
    );

    request.on('error', reject);
    request.setTimeout(REQUEST_BUFFER_TIMEOUT_MS, () => request.destroy(new Error('download_timeout')));
    if (extraOptions.signal) {
      if (extraOptions.signal.aborted) request.destroy(new Error('download_cancelled'));
      extraOptions.signal.addEventListener('abort', () => request.destroy(new Error('download_cancelled')), { once: true });
    }
  });
}

function isAcceptableVideoResponse(status, headers, requestOptions) {
  if (!requestOptions || requestOptions.acceptVideoOnErrorStatus !== true) return false;
  const contentType = String(headers && headers['content-type'] || '').toLowerCase();
  return status > 0 && contentType.startsWith('video/');
}

function downloadToFile(sourceUrl, destinationPath, options, redirectCount) {
  const requestOptions = typeof options === 'object' && options ? options : {};
  const redirects = typeof options === 'number' ? Number(options) || 0 : (Number(redirectCount) || 0);
  if (redirects > 5) {
    return Promise.reject(new Error('download_redirect_limit_exceeded'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortListener = null;
    let file = null;
    let responseRef = null;
    const settleFailure = (error) => {
      if (settled) return;
      settled = true;
      if (requestOptions.signal && abortListener) {
        requestOptions.signal.removeEventListener('abort', abortListener);
      }
      if (responseRef) responseRef.resume();
      if (file) file.destroy();
      fs.promises.rm(destinationPath, { force: true }).catch(() => {}).finally(() => reject(error));
    };
    const settleSuccess = (result) => {
      if (settled) return;
      settled = true;
      if (requestOptions.signal && abortListener) {
        requestOptions.signal.removeEventListener('abort', abortListener);
      }
      resolve(result || { path: destinationPath });
    };
    const url = new URL(sourceUrl);
    const client = url.protocol === 'http:' ? http : https;
    const request = client.get(
      sourceUrl,
      {
        headers: {
          ...DEFAULT_DOWNLOAD_HEADERS,
          ...(requestOptions.headers || {}),
        },
      },
      async (response) => {
        responseRef = response;
        const status = Number(response.statusCode) || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          try {
            const redirected = new URL(response.headers.location, sourceUrl).toString();
            settleSuccess(await downloadToFile(redirected, destinationPath, requestOptions, redirects + 1));
          } catch (error) {
            settleFailure(error);
          }
          return;
        }

        if (status < 200 || status >= 300) {
          if (isAcceptableVideoResponse(status, response.headers, requestOptions)) {
            file = null;
          } else {
            response.resume();
            settleFailure(new Error('download_http_' + status));
            return;
          }
        }

        try {
          await ensureDir(path.dirname(destinationPath));
        } catch (error) {
          response.resume();
          settleFailure(error);
          return;
        }

        file = fs.createWriteStream(destinationPath);
        file.on('error', settleFailure);
        response.on('error', settleFailure);
        file.on('finish', () => {
          file.close((error) => {
            if (error) settleFailure(error);
            else settleSuccess();
          });
        });
        response.pipe(file);
      }
    );

    request.on('error', settleFailure);
    request.setTimeout(DOWNLOAD_SOCKET_TIMEOUT_MS, () => request.destroy(new Error('download_timeout')));
    if (requestOptions.signal) {
      abortListener = () => {
        if (responseRef) responseRef.destroy(new Error('download_cancelled'));
        if (file) file.destroy(new Error('download_cancelled'));
        request.destroy(new Error('download_cancelled'));
      };
      if (requestOptions.signal.aborted) abortListener();
      else requestOptions.signal.addEventListener('abort', abortListener, { once: true });
    }
  });
}

function getSmartDownloadProviders() {
  return SMART_DOWNLOAD_PROVIDERS.map((provider) => ({ id: provider.id }));
}

async function resolveSmartDownloadRequest(providerId, item, options) {
  const selectedProvider = SMART_DOWNLOAD_PROVIDERS.find((provider) => provider.id === providerId);
  if (!selectedProvider) throw new Error('smart_download_unknown_provider');
  const resolved = await selectedProvider.resolve(item, options || {});
  const url = String(resolved && resolved.url || '').trim();
  if (!url) throw new Error('smart_download_missing_download_url');
  return {
    providerId: selectedProvider.id,
    url: url,
    headers: resolved && resolved.headers && typeof resolved.headers === 'object' ? resolved.headers : {},
    acceptVideoOnErrorStatus: !!(resolved && resolved.acceptVideoOnErrorStatus),
  };
}

module.exports = {
  downloadToFile,
  getSmartDownloadProviders,
  resolveSmartDownloadRequest,
};
