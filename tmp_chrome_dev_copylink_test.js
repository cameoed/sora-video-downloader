const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const cookieHeader = fs.readFileSync('/tmp/sora_cookie_manual.txt', 'utf8').trim();
const draftId = process.argv[2];
if (!draftId) throw new Error('missing draft id');

function parseCookieHeader(raw) {
  const byName = new Map();
  String(raw || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name) return;
      byName.set(name, { name, value });
    });
  return Array.from(byName.values());
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-chrome-dev-'));
  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    viewport: { width: 1440, height: 1100 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    const cookies = parseCookieHeader(cookieHeader);
    const cookieObjects = [];
    for (const c of cookies) {
      cookieObjects.push({ name: c.name, value: c.value, url: 'https://sora.chatgpt.com' });
      cookieObjects.push({ name: c.name, value: c.value, url: 'https://chatgpt.com' });
    }
    await browser.addCookies(cookieObjects);
    const page = browser.pages()[0] || await browser.newPage();
    const events = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/project_y\/post|api\/auth\/session|backend-api\/sentinel\/req/.test(url)) {
        events.push({ type: 'request', url, method: req.method(), headers: req.headers(), postData: req.postData() });
      }
    });
    page.on('response', async (res) => {
      const url = res.url();
      if (/project_y\/post|api\/auth\/session|backend-api\/sentinel\/req/.test(url)) {
        let text = '';
        try { text = await res.text(); } catch {}
        events.push({ type: 'response', url, status: res.status(), headers: await res.allHeaders(), text: text.slice(0, 4000) });
      }
    });

    await page.goto(`https://sora.chatgpt.com/d/${draftId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const url1 = page.url();
    const title = await page.title();
    const bodyText = await page.locator('body').innerText().catch(() => '');

    let menuClicked = false;
    const menuButtons = await page.locator('button[aria-haspopup="menu"]').all();
    for (let i = 0; i < menuButtons.length; i++) {
      const btn = menuButtons[i];
      const box = await btn.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.x < 900 || box.y > 300) continue;
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      const copyItem = page.getByRole('menuitem', { name: /copy link/i }).first();
      if (await copyItem.isVisible().catch(() => false)) {
        await copyItem.click({ force: true });
        menuClicked = true;
        break;
      }
    }

    let confirmClicked = false;
    if (menuClicked) {
      const confirm = page.getByRole('dialog').getByRole('button', { name: /^copy link$/i }).last();
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click({ force: true });
        confirmClicked = true;
      }
    }

    await page.waitForTimeout(10000);
    const out = {
      ok: true,
      url: url1,
      title,
      bodyText: bodyText.slice(0, 4000),
      menuButtonCount: menuButtons.length,
      menuClicked,
      confirmClicked,
      clipboardText: await page.evaluate(async () => {
        try { return await navigator.clipboard.readText(); } catch { return ''; }
      }),
      events,
    };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
