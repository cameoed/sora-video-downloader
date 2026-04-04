const fs = require('fs');
const https = require('https');

const COOKIE_PATHS = ['/tmp/sora_cookie_manual.txt'];
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const TARGET_IDS = process.argv.slice(2);

function requestJson(url, options, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      target,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          resolve({
            status: Number(res.statusCode) || 0,
            headers: res.headers || {},
            text,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function trimCookie(raw) {
  return String(raw || '').trim();
}

function buildBaseHeaders(cookie) {
  return {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': USER_AGENT,
    Priority: 'u=1, i',
    'Sec-CH-UA': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'Sec-CH-UA-Arch': '"arm"',
    'Sec-CH-UA-Bitness': '"64"',
    'Sec-CH-UA-Full-Version': '"148.0.7753.0"',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="148.0.7753.0", "Google Chrome";v="148.0.7753.0", "Not/A)Brand";v="99.0.0.0"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Model': '""',
    'Sec-CH-UA-Platform': '"macOS"',
    'Sec-CH-UA-Platform-Version': '"26.3.1"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Cookie: cookie,
  };
}

async function main() {
  let cookie = '';
  for (const cookiePath of COOKIE_PATHS) {
    try {
      cookie = trimCookie(fs.readFileSync(cookiePath, 'utf8'));
    } catch {}
    if (cookie) break;
  }
  if (!cookie) throw new Error('missing cookie');

  const sessionRes = await requestJson(
    'https://sora.chatgpt.com/api/auth/session',
    {
      method: 'GET',
      headers: {
        ...buildBaseHeaders(cookie),
        Referer: 'https://sora.chatgpt.com/drafts',
      },
    }
  );
  const accessToken =
    (sessionRes.json && (sessionRes.json.accessToken || sessionRes.json.access_token)) || '';
  if (!accessToken) {
    console.log(JSON.stringify({ ok: false, phase: 'session', sessionRes }, null, 2));
    process.exit(1);
  }

  const authHeaders = {
    ...buildBaseHeaders(cookie),
    Authorization: /^Bearer /i.test(accessToken) ? accessToken : `Bearer ${accessToken}`,
  };

  const draftsRes = await requestJson(
    'https://sora.chatgpt.com/backend/project_y/profile/drafts/v2?limit=30',
    {
      method: 'GET',
      headers: authHeaders,
    }
  );
  const items = Array.isArray(draftsRes.json && draftsRes.json.items) ? draftsRes.json.items : [];
  const matches = items.filter((item) => TARGET_IDS.includes(String(item && item.id || '')));

  const results = [];
  for (const item of matches) {
    const body = {
      attachments_to_create: [
        {
          generation_id: item.generation_id || item.id,
          kind: 'sora',
        },
      ],
      post_text: item.prompt || item.title || '',
      destinations: [{ type: 'shared_link_unlisted' }],
    };
    const requestBody = JSON.stringify(body);
    const commonHeaders = {
      ...authHeaders,
      'Content-Type': 'application/json',
      'OAI-Device-Id': '6caee607-3355-48ae-983d-3b9d5388763d',
      'OAI-Language': 'en-US',
      Origin: 'https://sora.chatgpt.com',
      Referer: `https://sora.chatgpt.com/d/${encodeURIComponent(item.id)}`,
    };
    const detailRes = await requestJson(
      'https://sora.chatgpt.com/backend/project_y/post',
      {
        method: 'POST',
        headers: commonHeaders,
      },
      requestBody
    );
    const draftsRefererRes = await requestJson(
      'https://sora.chatgpt.com/backend/project_y/post',
      {
        method: 'POST',
        headers: {
          ...commonHeaders,
          Referer: 'https://sora.chatgpt.com/drafts',
        },
      },
      requestBody
    );
    results.push({
      id: item.id,
      prompt: item.prompt || '',
      detail: {
        status: detailRes.status,
        json: detailRes.json,
        text: detailRes.text.slice(0, 4096),
      },
      drafts: {
        status: draftsRefererRes.status,
        json: draftsRefererRes.json,
        text: draftsRefererRes.text.slice(0, 4096),
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        session: {
          status: sessionRes.status,
          user: sessionRes.json && sessionRes.json.user ? {
            email: sessionRes.json.user.email || '',
            name: sessionRes.json.user.name || '',
          } : null,
          accessTokenPresent: Boolean(accessToken),
        },
        draftsStatus: draftsRes.status,
        matched: matches.map((item) => ({
          id: item.id,
          generation_id: item.generation_id || '',
          prompt: item.prompt || '',
          title: item.title || '',
          kind: item.kind || '',
        })),
        results,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
