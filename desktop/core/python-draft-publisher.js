const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sanitizeString } = require('./helpers');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'sora-publish-drafts.py');
const PYTHON_COMMAND_CANDIDATES = Array.from(
  new Set(
    [
      sanitizeString(process.env.SVD_PYTHON, 1024) || '',
      'python3',
      'python',
    ].filter(Boolean)
  )
);

function normalizeBearerToken(value) {
  const raw = sanitizeString(value, 16384) || '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function normalizeCookieHeader(value) {
  return sanitizeString(value, 65535) || '';
}

function normalizeUserAgent(value) {
  return sanitizeString(value, 1024) || '';
}

function spawnPython(command, args, options) {
  return new Promise((resolve, reject) => {
    const settings = options && typeof options === 'object' ? options : {};
    const child = spawn(command, args, {
      cwd: settings.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, settings.env || {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let abortListener = null;

    const finalize = (error, result) => {
      if (settled) return;
      settled = true;
      if (settings.signal && abortListener) {
        settings.signal.removeEventListener('abort', abortListener);
      }
      if (error) reject(error);
      else resolve(result);
    };

    child.on('error', (error) => finalize(error));
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('close', (code) => {
      finalize(null, {
        code: Number(code) || 0,
        stdout,
        stderr,
      });
    });

    if (settings.signal) {
      abortListener = () => {
        try {
          child.kill('SIGTERM');
        } catch {}
      };
      if (settings.signal.aborted) abortListener();
      else settings.signal.addEventListener('abort', abortListener, { once: true });
    }
  });
}

function tryParseJsonLines(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runPythonPublisher(args, options) {
  let lastError = null;
  for (let index = 0; index < PYTHON_COMMAND_CANDIDATES.length; index += 1) {
    const command = PYTHON_COMMAND_CANDIDATES[index];
    try {
      const result = await spawnPython(command, args, options);
      return Object.assign({ command }, result);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  const error = new Error('python_runtime_not_found');
  if (lastError) error.cause = lastError;
  throw error;
}

async function publishDraftSharedLinkViaPython(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const token = normalizeBearerToken(settings.token);
  const cookieHeader = normalizeCookieHeader(settings.cookieHeader);
  const userAgent = normalizeUserAgent(settings.userAgent);
  const draft = settings.draft && typeof settings.draft === 'object' ? settings.draft : null;

  if (!token) throw new Error('python_draft_publisher_missing_token');
  if (!draft) throw new Error('python_draft_publisher_missing_draft');

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'svd-draft-publish-'));
  const draftJsonPath = path.join(tempDir, 'draft.json');
  try {
    await fs.promises.writeFile(draftJsonPath, JSON.stringify(draft), 'utf8');
    const args = [
      SCRIPT_PATH,
      '--token',
      token,
      '--single-draft-json',
      draftJsonPath,
      '--json-output',
      '--delay',
      String(Math.max(0, Number(settings.delaySeconds) || 0)),
    ];
    if (cookieHeader) {
      args.push('--cookie', cookieHeader);
    }
    if (userAgent) {
      args.push('--user-agent', userAgent);
    }

    const result = await runPythonPublisher(args, {
      cwd: settings.cwd || process.cwd(),
      signal: settings.signal || null,
    });
    const parsed = tryParseJsonLines(result.stdout) || tryParseJsonLines(result.stderr) || {};
    return {
      ok: parsed.ok === true && !!sanitizeString(parsed.permalink, 4096),
      error: sanitizeString(parsed.error, 4096) || sanitizeString(result.stderr, 4096) || '',
      permalink: sanitizeString(parsed.permalink, 4096) || '',
      response: parsed.response && typeof parsed.response === 'object' ? parsed.response : null,
      generationId: sanitizeString(parsed.generation_id, 256) || '',
      draftId: sanitizeString(parsed.draft_id, 256) || '',
      stdout: sanitizeString(result.stdout, 16384) || '',
      stderr: sanitizeString(result.stderr, 16384) || '',
      status: parsed.ok === true ? 200 : Number(parsed.status) || (result.code === 0 ? 0 : result.code),
      command: result.command,
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  publishDraftSharedLinkViaPython,
};
