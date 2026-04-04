const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const cookieHeader = fs.readFileSync('/tmp/sora_cookie_manual.txt', 'utf8').trim();
const draftId = process.argv[2];
const postText = process.argv.slice(3).join(' ').trim();

if (!draftId) {
  throw new Error('missing draft id');
}

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
      // Raw copied Cookie headers can contain duplicate names; browsers keep the latest value.
      byName.set(name, { name, value });
    });
  return Array.from(byName.values());
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-chrome-dev-post-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
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
    await context.addCookies(cookieObjects);

    const page = context.pages()[0] || await context.newPage();
    const events = [];

    page.on('request', (req) => {
      const url = req.url();
      if (/api\/auth\/session|project_y\/post|backend-api\/sentinel\/req/.test(url)) {
        events.push({
          type: 'request',
          url,
          method: req.method(),
          headers: req.headers(),
          postData: req.postData(),
        });
      }
    });

    page.on('response', async (res) => {
      const url = res.url();
      if (/api\/auth\/session|project_y\/post|backend-api\/sentinel\/req/.test(url)) {
        let text = '';
        try {
          text = await res.text();
        } catch {}
        events.push({
          type: 'response',
          url,
          status: res.status(),
          headers: await res.allHeaders(),
          text: text.slice(0, 5000),
        });
      }
    });

    const authSessionPromise = page.waitForResponse(
      (res) => /https:\/\/sora\.chatgpt\.com\/api\/auth\/session/.test(res.url()),
      { timeout: 60000 }
    );

    await page.goto(`https://sora.chatgpt.com/d/${draftId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    const authSessionRes = await authSessionPromise;
    let authSession = {};
    try {
      authSession = JSON.parse(await authSessionRes.text());
    } catch {}
    const accessToken = authSession && authSession.accessToken;

    await page.waitForTimeout(5000);

    const result = await page.evaluate(
      async ({ targetDraftId, text, token, email }) => {
        const body = {
          attachments_to_create: [{ generation_id: targetDraftId, kind: 'sora' }],
          post_text: text || '',
          destinations: [{ type: 'shared_link_unlisted' }],
        };
        const res = await fetch('https://sora.chatgpt.com/backend/project_y/post', {
          method: 'POST',
          mode: 'cors',
          credentials: 'include',
          headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        let json = null;
        let textBody = '';
        try {
          json = await res.clone().json();
        } catch {}
        if (!json) {
          try {
            textBody = await res.text();
          } catch {}
        }
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          accessTokenPresent: Boolean(token),
          sessionEmail: email || '',
          body,
          responseJson: json,
          responseText: textBody.slice(0, 5000),
        };
      },
      {
        targetDraftId: draftId,
        text: postText,
        token: accessToken || '',
        email: (authSession && authSession.user && authSession.user.email) || '',
      }
    );

    console.log(
      JSON.stringify(
        {
          url: page.url(),
          title: await page.title(),
          result,
          events,
        },
        null,
        2
      )
    );
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
