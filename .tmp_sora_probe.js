const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
  const cookie = fs.readFileSync('/tmp/sora_cookie_manual.txt', 'utf8').trim();
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 1000 },
  });
  await context.route('**/*', async (route, request) => {
    const headers = { ...request.headers(), cookie };
    await route.continue({ headers });
  });
  const page = await context.newPage();
  await page.goto('https://sora.chatgpt.com/drafts', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(10000);
  const result = await page.evaluate(async () => {
    const state = {
      href: location.href,
      title: document.title,
      bodyPrefix: document.body ? document.body.innerText.slice(0, 200) : '',
    };
    try {
      const r = await fetch('https://sora.chatgpt.com/api/auth/session', {
        method: 'GET',
        credentials: 'include',
        headers: { accept: '*/*' },
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {
        state,
        status: r.status,
        contentType: r.headers.get('content-type') || '',
        hasJson: !!json,
        hasAccessToken: !!(json && json.accessToken),
        tokenLen: json && json.accessToken ? json.accessToken.length : 0,
        rawPrefix: json ? '' : text.slice(0, 160),
      };
    } catch (error) {
      return { state, error: String(error) };
    }
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
