const { _electron: electron } = require('playwright');

async function main() {
  const promptNeedle = String(process.argv[2] || '').trim().toLowerCase();
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
    const result = await app.evaluate(async ({ BrowserWindow }, inputPromptNeedle) => {
      const service = global.__SORA_BACKUP_DEBUG__ && global.__SORA_BACKUP_DEBUG__.backupService;
      if (!service) return { ok: false, error: 'missing_debug_backup_service' };

      const prepared = await service.session._prepareBackgroundWindow(
        'https://sora.chatgpt.com/drafts',
        30000,
        { allowSameOriginFallback: true }
      );
      const targetWindow = prepared.window;
      const targetContents = targetWindow.webContents;

      const snapshot = await targetContents.executeJavaScript(
        '(' + String(async function inspectDraftGrid(serialized) {
          const input = JSON.parse(serialized);
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
          const promptNeedle = String(input.promptNeedle || '').trim().toLowerCase();

          function safeText(value, maxLen) {
            const raw = String(value || '').replace(/\s+/g, ' ').trim();
            const limit = Math.max(0, Number(maxLen) || 0);
            if (!raw) return '';
            return limit > 0 && raw.length > limit ? raw.slice(0, limit) : raw;
          }

          function normalizeText(value) {
            return safeText(value, 4096).toLowerCase();
          }

          function isVisible(element) {
            if (!element || typeof element.getBoundingClientRect !== 'function') return false;
            const rect = element.getBoundingClientRect();
            if (!rect || rect.width < 1 || rect.height < 1) return false;
            const style = window.getComputedStyle(element);
            if (!style) return false;
            return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          }

          function describeElement(element) {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              tag: safeText(element.tagName, 32).toLowerCase(),
              text: safeText(element.innerText || element.textContent || '', 500),
              ariaLabel: safeText(element.getAttribute && element.getAttribute('aria-label'), 256),
              title: safeText(element.getAttribute && element.getAttribute('title'), 256),
              role: safeText(element.getAttribute && element.getAttribute('role'), 128),
              testId: safeText(element.getAttribute && (element.getAttribute('data-testid') || element.getAttribute('data-test-id')), 128),
              className: safeText(element.className, 512),
              href: safeText(element.href, 1024),
              bounds: {
                left: Math.round(Number(rect.left) || 0),
                top: Math.round(Number(rect.top) || 0),
                width: Math.round(Number(rect.width) || 0),
                height: Math.round(Number(rect.height) || 0),
              },
            };
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

          function interactiveWithin(root) {
            if (!root || typeof root.querySelectorAll !== 'function') return [];
            return Array.from(root.querySelectorAll('button, [role="button"], a, [aria-haspopup], [data-testid], [data-test-id]'))
              .filter((element) => isVisible(element))
              .map((element) => describeElement(element))
              .filter(Boolean)
              .slice(0, 80);
          }

          function findCardRoot(start) {
            let node = start;
            while (node && node !== document.body) {
              if (node.matches && node.matches('a[href*="/d/"], article, li, [data-testid], [data-test-id]')) {
                const buttons = Array.from(node.querySelectorAll ? node.querySelectorAll('button, [role="button"], [aria-haspopup], a') : [])
                  .filter((entry) => isVisible(entry));
                const text = safeText(node.innerText || node.textContent || '', 1200);
                if (buttons.length || text) return node;
              }
              node = node.parentElement;
            }
            return start && start.parentElement ? start.parentElement : start;
          }

          function collectMenuCandidates(cardRoot) {
            if (!cardRoot || typeof cardRoot.querySelectorAll !== 'function') return [];
            return Array.from(cardRoot.querySelectorAll('button, [role="button"], [aria-haspopup]'))
              .filter((element) => isVisible(element))
              .map((element) => ({ node: element, label: labelBundle(element), rect: element.getBoundingClientRect() }))
              .filter((entry) => {
                const popup = normalizeText(entry.node.getAttribute && entry.node.getAttribute('aria-haspopup'));
                const iconLike = (Number(entry.rect.width) || 0) <= 48 && (Number(entry.rect.height) || 0) <= 48;
                return popup === 'menu' || !entry.label || iconLike || entry.label.indexOf('more') >= 0 || entry.label.indexOf('option') >= 0;
              })
              .sort((a, b) => {
                const ay = Number(a.rect.top) || 0;
                const by = Number(b.rect.top) || 0;
                if (ay !== by) return ay - by;
                return (Number(b.rect.left) || 0) - (Number(a.rect.left) || 0);
              });
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
              element.click();
              return true;
            } catch (_error) {
              return false;
            }
          }

          try {
            if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && !window.__draftGridClipboardPatched) {
              window.__draftGridClipboardEntries = [];
              const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
              navigator.clipboard.writeText = async function patchedWriteText(value) {
                window.__draftGridClipboardEntries.push({
                  text: safeText(value, 4096),
                  createdAt: Date.now(),
                });
                return originalWriteText(value);
              };
              window.__draftGridClipboardPatched = true;
            }
          } catch (_error) {}

          for (let step = 0; step < 6; step += 1) {
            window.scrollTo(0, (document.body.scrollHeight * step) / 6);
            await wait(500);
          }
          window.scrollTo(0, 0);
          await wait(800);

          const allVisible = Array.from(document.querySelectorAll('a, article, li, div, section'))
            .filter((element) => isVisible(element))
            .map((element) => ({
              node: element,
              label: normalizeText(element.innerText || element.textContent || ''),
            }));

          const matches = allVisible
            .filter((entry) => promptNeedle && entry.label.indexOf(promptNeedle) >= 0)
            .slice(0, 8)
            .map((entry) => {
              const root = findCardRoot(entry.node);
              return {
                match: describeElement(entry.node),
                root: describeElement(root),
                rootText: safeText(root && (root.innerText || root.textContent || ''), 1400),
                interactive: interactiveWithin(root),
              };
            });

          let menuProbe = null;
          if (matches.length) {
            const rootNode = findCardRoot(allVisible.find((entry) => promptNeedle && entry.label.indexOf(promptNeedle) >= 0).node);
            const candidates = collectMenuCandidates(rootNode);
            for (let index = 0; index < candidates.length; index += 1) {
              const candidate = candidates[index];
              if (!candidate || !candidate.node) continue;
              clickElement(candidate.node);
              await wait(400);
              const menuItems = Array.from(document.querySelectorAll('[role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'))
                .filter((element) => isVisible(element))
                .map((element) => describeElement(element))
                .filter(Boolean)
                .slice(0, 80);
              if (menuItems.length) {
                menuProbe = {
                  candidate: describeElement(candidate.node),
                  menuItems,
                  clipboard: Array.isArray(window.__draftGridClipboardEntries) ? window.__draftGridClipboardEntries.slice(-10) : [],
                };
                break;
              }
            }
          }

          return {
            href: safeText(window.location.href, 2048),
            title: safeText(document.title, 512),
            body: safeText(document.body && document.body.innerText, 12000),
            matches,
            menuProbe,
          };
        }) + ')(' + JSON.stringify(JSON.stringify({ promptNeedle: inputPromptNeedle })) + ')',
        true
      );

      return { ok: true, snapshot };
    }, promptNeedle);

    process.stdout.write(JSON.stringify(result, null, 2) + '\\n');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error || 'playwright_drafts_grid_debug_failed') + '\\n');
  process.exit(1);
});
