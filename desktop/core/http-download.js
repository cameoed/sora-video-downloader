const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const SMART_DOWNLOAD_API_BASE = 'https://api.dyysy.com/links20260207/';
const SMART_DOWNLOAD_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://kontenai.net',
  referer: 'https://kontenai.net/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

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
    if (extraOptions.signal) {
      if (extraOptions.signal.aborted) request.destroy(new Error('download_cancelled'));
      extraOptions.signal.addEventListener('abort', () => request.destroy(new Error('download_cancelled')), { once: true });
    }
  });
}

function downloadToFile(sourceUrl, destinationPath, options, redirectCount) {
  const requestOptions = typeof options === 'object' && options ? options : {};
  const redirects = typeof options === 'number' ? Number(options) || 0 : (Number(redirectCount) || 0);
  if (redirects > 5) {
    return Promise.reject(new Error('download_redirect_limit_exceeded'));
  }

  return new Promise((resolve, reject) => {
    const url = new URL(sourceUrl);
    const client = url.protocol === 'http:' ? http : https;
    const request = client.get(
      sourceUrl,
      {
        headers: {
          'user-agent': 'Sora Backup App',
        },
      },
      async (response) => {
        const status = Number(response.statusCode) || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          try {
            const redirected = new URL(response.headers.location, sourceUrl).toString();
            resolve(await downloadToFile(redirected, destinationPath, requestOptions, redirects + 1));
          } catch (error) {
            reject(error);
          }
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error('download_http_' + status));
          return;
        }

        try {
          await ensureDir(path.dirname(destinationPath));
        } catch (error) {
          response.resume();
          reject(error);
          return;
        }

        const file = fs.createWriteStream(destinationPath);
        file.on('error', reject);
        response.on('error', reject);
        file.on('finish', () => {
          file.close(() => resolve({ path: destinationPath }));
        });
        response.pipe(file);

        if (requestOptions.signal) {
          const abort = () => {
            response.destroy(new Error('download_cancelled'));
            file.destroy(new Error('download_cancelled'));
            fs.promises.rm(destinationPath, { force: true }).catch(() => {});
          };
          if (requestOptions.signal.aborted) abort();
          else requestOptions.signal.addEventListener('abort', abort, { once: true });
        }
      }
    );

    request.on('error', reject);
    if (requestOptions.signal) {
      if (requestOptions.signal.aborted) request.destroy(new Error('download_cancelled'));
      requestOptions.signal.addEventListener('abort', () => request.destroy(new Error('download_cancelled')), { once: true });
    }
  });
}

async function resolveSmartDownloadUrl(postPermalink, options) {
  const postUrl = String(postPermalink || '').trim();
  if (!postUrl) throw new Error('smart_download_missing_post_permalink');

  const apiUrl = SMART_DOWNLOAD_API_BASE + encodeURIComponent(postUrl.replace(/\\/g, ''));
  const raw = await requestBuffer(apiUrl, { headers: SMART_DOWNLOAD_HEADERS }, 0, options || {});
  let payload = null;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (_error) {
    throw new Error('smart_download_invalid_json');
  }

  const links = payload && typeof payload === 'object' ? payload.links || {} : {};
  const downloadUrl = links.mp4 || links.mp4_source || '';
  if (!downloadUrl) throw new Error('smart_download_missing_mp4_url');
  return String(downloadUrl);
}

module.exports = {
  downloadToFile,
  resolveSmartDownloadUrl,
};
