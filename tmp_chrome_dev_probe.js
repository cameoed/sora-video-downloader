const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const cookieHeader = fs.readFileSync('/tmp/sora_cookie_manual.txt', 'utf8').trim();
const draftId = process.argv[2];
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-chrome-dev-probe-'));
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
    await page.goto(`https://sora.chatgpt.com/d/${draftId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    const snapshot = await page.evaluate(() => {
      const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity || '1') === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [aria-haspopup]'))
        .filter((el) => visible(el))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            text: norm(el.innerText || el.textContent),
            ariaLabel: norm(el.getAttribute('aria-label')),
            role: norm(el.getAttribute('role')),
            popup: norm(el.getAttribute('aria-haspopup')),
            left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height)
          };
        })
        .slice(0, 120);
      return {
        href: location.href,
        title: document.title,
        body: norm(document.body && document.body.innerText).slice(0, 4000),
        buttons,
      };
    });
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
