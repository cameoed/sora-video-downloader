const { app } = require('electron');
const { PlaywrightSession } = require('../core/playwright-session');

async function main() {
  const draftId = String(process.argv[2] || '').trim();
  const targetUrl = draftId
    ? 'https://sora.chatgpt.com/d/' + encodeURIComponent(draftId)
    : 'https://sora.chatgpt.com/drafts';

  const session = new PlaywrightSession({ partitionSuffix: 'main' });
  const prepared = await session._prepareExactBackgroundWindow(targetUrl, 20000);
  const result = await prepared.window.webContents.executeJavaScript(
    `(() => {
      function safe(value, limit = 300) {
        const text = String(value || '').trim();
        return text.length > limit ? text.slice(0, limit) : text;
      }
      function isVisible(element) {
        if (!element || typeof element.getBoundingClientRect !== 'function') return false;
        const style = window.getComputedStyle(element);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      function describe(element) {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          tag: safe(element.tagName, 32).toLowerCase(),
          text: safe(element.innerText || element.textContent || '', 200),
          ariaLabel: safe(element.getAttribute && element.getAttribute('aria-label'), 200),
          title: safe(element.getAttribute && element.getAttribute('title'), 200),
          role: safe(element.getAttribute && element.getAttribute('role'), 64),
          href: safe(element.getAttribute && element.getAttribute('href'), 400),
          testId: safe(element.getAttribute && element.getAttribute('data-testid'), 200),
          ariaHasPopup: safe(element.getAttribute && element.getAttribute('aria-haspopup'), 64),
          className: safe(element.className, 300),
          bounds: {
            left: Math.round(rect.left || 0),
            top: Math.round(rect.top || 0),
            width: Math.round(rect.width || 0),
            height: Math.round(rect.height || 0),
          },
        };
      }
      const selectors = [
        'button',
        '[role="button"]',
        '[role="menuitem"]',
        '[role="dialog"]',
        'a[href]',
        '[aria-haspopup]',
        '[data-testid]',
      ];
      const nodes = Array.from(document.querySelectorAll(selectors.join(',')))
        .filter((element) => isVisible(element))
        .map((element) => describe(element))
        .filter(Boolean)
        .slice(0, 250);
      return {
        href: window.location.href,
        title: document.title,
        nodes,
      };
    })()`,
    true
  );

  console.log(JSON.stringify(result, null, 2));
}

app.whenReady()
  .then(async () => {
    try {
      await main();
    } catch (error) {
      console.error(error && error.stack ? error.stack : String(error));
      process.exitCode = 1;
    } finally {
      app.exit(process.exitCode || 0);
    }
  });
