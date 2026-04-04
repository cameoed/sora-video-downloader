const { _electron: electron } = require('playwright');

function listCookieNames(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .map((part) => part.split('=')[0])
    .slice(0, 64);
}

async function main() {
  const draftId = String(process.argv[2] || '').trim();
  if (!draftId) {
    throw new Error('missing_draft_id');
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
    const result = await app.evaluate(async (_ignored, inputDraftId) => {
      const service = global.__SORA_BACKUP_DEBUG__ && global.__SORA_BACKUP_DEBUG__.backupService;
      if (!service) {
        return { ok: false, error: 'missing_debug_backup_service' };
      }
      const toCookieNames = (cookieHeader) => String(cookieHeader || '')
        .split(';')
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .map((part) => part.split('=')[0])
        .slice(0, 64);

      const referer = 'https://sora.chatgpt.com/d/' + encodeURIComponent(inputDraftId);
      const body = {
        attachments_to_create: [{ generation_id: inputDraftId, kind: 'sora' }],
        post_text: 'Downloaded!',
        destinations: [{ type: 'shared_link_unlisted' }],
      };

      const beforeManualHeaders = Object.assign({}, service.session.manualHeaders || {});
      const beforeCapturedHeaders = Object.assign({}, service.session.capturedHeaders || {});
      const beforeSoraCookieHeader = await service.session.getCookieHeader(referer);
      const beforeChatCookieHeader = await service.session.getCookieHeader('https://chatgpt.com/');

      service.session.manualHeaders = {};
      service.session.capturedHeaders = {};

      const refreshed = await service.session.refreshAuthHeadersFromSession();
      const refreshedHeaders = service.session.getCapturedHeaders();
      const afterSoraCookieHeader = await service.session.getCookieHeader(referer);
      const afterChatCookieHeader = await service.session.getCookieHeader('https://chatgpt.com/');

      let publish = null;
      try {
        publish = await service.session.postDraftSharedLinkViaConsole(inputDraftId, body, {
          referer,
          readyTimeoutMs: 15000,
        });
      } catch (error) {
        publish = {
          ok: false,
          status: 0,
          error: String((error && error.message) || error || 'publish_failed'),
        };
      }

      service.session.manualHeaders = beforeManualHeaders;
      service.session.capturedHeaders = beforeCapturedHeaders;

        return {
          ok: true,
          refreshed,
          before: {
          soraCookieNames: toCookieNames(beforeSoraCookieHeader),
          chatCookieNames: toCookieNames(beforeChatCookieHeader),
          manualAuthorizationPresent: !!beforeManualHeaders.Authorization,
          manualAuthorizationLength: String(beforeManualHeaders.Authorization || '').length,
        },
        after: {
          soraCookieNames: toCookieNames(afterSoraCookieHeader),
          chatCookieNames: toCookieNames(afterChatCookieHeader),
          authorizationPresent: !!(refreshedHeaders && refreshedHeaders.Authorization),
          authorizationLength: String(refreshedHeaders && refreshedHeaders.Authorization || '').length,
          deviceId: String(refreshedHeaders && refreshedHeaders['OAI-Device-Id'] || ''),
          language: String(refreshedHeaders && refreshedHeaders['OAI-Language'] || ''),
        },
        publish,
      };
    }, draftId);

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error || 'playwright_session_token_debug_failed') + '\n');
  process.exit(1);
});
