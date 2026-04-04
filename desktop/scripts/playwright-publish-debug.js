const { _electron: electron } = require('playwright');

async function main() {
  const draftIds = process.argv.slice(2).filter(Boolean);
  if (!draftIds.length) {
    throw new Error('missing_draft_ids');
  }

  const env = { ...process.env, SVD_DEBUG_EXPORT_BACKUP_SERVICE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: ['.'],
    env,
    cwd: process.cwd(),
    timeout: 120000,
  });

  try {
    await app.firstWindow({ timeout: 120000 });
    const result = await app.evaluate(async ({ BrowserWindow }, inputDraftIds) => {
      const service = global.__SORA_BACKUP_DEBUG__ && global.__SORA_BACKUP_DEBUG__.backupService;
      if (!service) {
        return { ok: false, error: 'missing_debug_backup_service' };
      }

      async function loadWindowSnapshot(targetWindow, targetUrl) {
        await targetWindow.loadURL(targetUrl, {
          userAgent: service.session.userAgent,
          httpReferrer: 'https://sora.chatgpt.com/',
        });
        await new Promise((resolve) => setTimeout(resolve, 15000));
        return await targetWindow.webContents.executeJavaScript(
          '({ href: String(window.location.href || ""), title: String(document.title || ""), readyState: String(document.readyState || "") })',
          true
        );
      }

      async function executePublishFetch(targetWindow, input) {
        return await targetWindow.webContents.executeJavaScript(
          '(' + String(async function runDraftPublish(serialized) {
            const payload = JSON.parse(serialized);
            function parseJson(text) {
              try {
                return text ? JSON.parse(text) : null;
              } catch (_error) {
                return null;
              }
            }
            try {
              const response = await window.fetch(payload.url, {
                method: 'POST',
                mode: 'cors',
                credentials: 'include',
                referrer: payload.referer,
                headers: payload.headers,
                body: JSON.stringify(payload.body),
              });
              const text = await response.text();
              return {
                ok: response.ok === true,
                status: Number(response.status) || 0,
                text,
                json: parseJson(text),
                contentType: String(response.headers.get('content-type') || ''),
              };
            } catch (error) {
              return {
                ok: false,
                status: 0,
                text: '',
                json: null,
                contentType: '',
                error: String((error && error.message) || error || 'window_fetch_failed'),
              };
            }
          }) + ')(' + JSON.stringify(JSON.stringify(input)) + ')',
          true
        );
      }

      const windows = BrowserWindow.getAllWindows().filter((window) => window && !window.isDestroyed());
      const sessionCheck = await service.checkSession();
      const outputs = [];

      for (const draftId of inputDraftIds) {
        const pageUrl = 'https://sora.chatgpt.com/drafts';
        const requestReferer = 'https://sora.chatgpt.com/drafts';
        const body = {
          attachments_to_create: [{ generation_id: String(draftId || '').trim(), kind: 'sora' }],
          post_text: 'Downloaded!',
          destinations: [{ type: 'shared_link_unlisted' }],
        };

        let prepare = null;
        try {
          const prepared = await service.session._prepareBackgroundWindow(pageUrl, 30000);
          const snapshot = await prepared.window.webContents.executeJavaScript(
            '({ href: String(window.location.href || ""), title: String(document.title || ""), readyState: String(document.readyState || "") })',
            true
          );
          prepare = { ok: true, referer: prepared.referer, snapshot };
        } catch (error) {
          prepare = {
            ok: false,
            error: String((error && error.message) || error || 'prepare_failed'),
          };
        }

        const cookieHeader = await service.session.getCookieHeader(pageUrl);
        const deviceId = await service.session.getDeviceId(pageUrl);
        const authHeaders = await service.session.ensureAuthHeaders(0);
        let result = null;
        try {
          result = await service.session.postDraftSharedLinkViaConsole(draftId, body, {
            pageUrl,
            requestReferer,
            readyTimeoutMs: 30000,
          });
        } catch (error) {
          result = {
            ok: false,
            status: 0,
            error: String((error && error.message) || error || 'publish_failed'),
          };
        }

        let loginWindowSnapshot = null;
        let loginWindowFetch = null;
        try {
          const loginWindow = await service.session.ensureLoginWindow();
          loginWindowSnapshot = await loadWindowSnapshot(loginWindow, pageUrl);
          loginWindowFetch = await executePublishFetch(loginWindow, {
            url: 'https://sora.chatgpt.com/backend/project_y/post',
            referer: requestReferer,
            body,
            headers: {
              accept: '*/*',
              ...(authHeaders && authHeaders.Authorization ? { authorization: authHeaders.Authorization } : {}),
              'content-type': 'application/json',
              ...(deviceId ? { 'oai-device-id': deviceId } : {}),
              'oai-language': 'en-US',
            },
          });
        } catch (error) {
          loginWindowFetch = {
            ok: false,
            status: 0,
            error: String((error && error.message) || error || 'login_window_failed'),
          };
        }

        outputs.push({
          draftId,
          referer: requestReferer,
          pageUrl,
          cookiePresent: !!cookieHeader,
          cookieNames: String(cookieHeader || '')
            .split(';')
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .map((part) => part.split('=')[0])
            .slice(0, 32),
          deviceId,
          prepare,
          result,
          loginWindowSnapshot,
          loginWindowFetch,
          observed: service.session.getLastObservedRequest('https://sora.chatgpt.com/backend/project_y/post', 'POST'),
        });
      }

      return {
        ok: true,
        sessionCheck,
        windowCount: windows.length,
        outputs,
      };
    }, draftIds);

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error || 'playwright_publish_debug_failed') + '\n');
  process.exit(1);
});
