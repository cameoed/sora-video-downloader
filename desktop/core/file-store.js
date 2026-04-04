const fs = require('fs');
const path = require('path');
const {
  summarizeBackupRun,
  buildBackupManifestLine,
  sanitizeString,
} = require('./helpers');

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallbackValue) {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallbackValue;
    return fallbackValue;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = filePath + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp';
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2));
  await fs.promises.rename(tempPath, filePath);
}

class FileStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.statePath = path.join(baseDir, 'state.json');
    this.runsDir = path.join(baseDir, 'runs');
    this.pendingWrites = new Map();
  }

  _queueWrite(filePath, writer) {
    const previous = this.pendingWrites.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => writer());
    const tracked = next.finally(() => {
      if (this.pendingWrites.get(filePath) === tracked) {
        this.pendingWrites.delete(filePath);
      }
    });
    this.pendingWrites.set(filePath, tracked);
    return tracked;
  }

  async _writeJson(filePath, value) {
    await this._queueWrite(filePath, () => writeJson(filePath, value));
  }

  async initialize() {
    await ensureDir(this.baseDir);
    await ensureDir(this.runsDir);
  }

  async getState() {
    return readJson(this.statePath, {
      settings: {},
      activeAccountKey: '',
      accountStates: {},
      lastRunId: '',
      session: { authenticated: false, checkedAt: 0, user: null },
      bucketCatalog: {
        ownDrafts: [],
        ownPosts: [],
        castInPosts: [],
        castInDrafts: [],
        characterPosts: {},
        ownPrompts: [],
      },
      cacheResetCatalog: {
        ownDrafts: 0,
        ownPosts: 0,
        castInPosts: 0,
        castInDrafts: 0,
        characterPosts: {},
        ownPrompts: 0,
      },
      savedCatalog: {
        ownDrafts: [],
        ownPosts: [],
        castInPosts: [],
        castInDrafts: [],
        characterPosts: {},
        ownPrompts: [],
      },
      completeScanCatalog: {
        ownPosts: null,
        ownDrafts: null,
        castInPosts: null,
        castInDrafts: null,
        characterPosts: {},
      },
      draftPublishUsage: {
        date: '',
        count: 0,
        last_published_at: 0,
      },
      draftSharedLinkCatalog: {},
      draftSharedLinkCatalogVersion: 0,
      scanResumeCatalog: {
        ownPosts: null,
        ownDrafts: null,
        castInPosts: null,
        castInDrafts: null,
        ownPrompts: null,
        characterPosts: {},
      },
    });
  }

  async saveState(nextState) {
    await this._writeJson(this.statePath, nextState);
    return nextState;
  }

  getRunDir(runId) {
    return path.join(this.runsDir, String(runId || ''));
  }

  async listRunIds() {
    try {
      const entries = await fs.promises.readdir(this.runsDir, { withFileTypes: true });
      return entries.filter((entry) => entry && entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      return [];
    }
  }

  async saveRun(run) {
    const runDir = this.getRunDir(run.id);
    await ensureDir(runDir);
    await this._writeJson(path.join(runDir, 'run.json'), summarizeBackupRun(run));
    return run;
  }

  async getRun(runId) {
    if (!runId) return null;
    return readJson(path.join(this.getRunDir(runId), 'run.json'), null);
  }

  async saveItems(runId, items) {
    if (!runId) return;
    const runDir = this.getRunDir(runId);
    await ensureDir(runDir);
    await this._writeJson(path.join(runDir, 'items.json'), Array.isArray(items) ? items : []);
  }

  async getItems(runId) {
    if (!runId) return [];
    return readJson(path.join(this.getRunDir(runId), 'items.json'), []);
  }

  async exportManifest(run, items, format) {
    const targetFormat = sanitizeString(format, 24) || 'manifest';
    const runDir = this.getRunDir(run && run.id);
    await ensureDir(runDir);
    if (targetFormat === 'summary') {
      const summaryPath = path.join(runDir, 'summary.json');
      const payload = {
        run: summarizeBackupRun(run),
        items_total: Array.isArray(items) ? items.length : 0,
      };
      await this._writeJson(summaryPath, payload);
      return { path: summaryPath, filename: path.basename(summaryPath) };
    }
    const targetItems = targetFormat === 'failures'
      ? (items || []).filter((item) => item.status === 'failed' || item.status === 'skipped')
      : (items || []);
    const filename = targetFormat === 'failures' ? 'failures.jsonl' : 'manifest.jsonl';
    const filePath = path.join(runDir, filename);
    const lines = targetItems.map((item) => JSON.stringify(buildBackupManifestLine(item))).join('\n');
    await fs.promises.writeFile(filePath, lines ? lines + '\n' : '', 'utf8');
    return { path: filePath, filename: path.basename(filePath) };
  }

  async writeFile(filePath, contents) {
    await ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, contents, 'utf8');
    return { path: filePath, filename: path.basename(filePath) };
  }
}

module.exports = {
  FileStore,
};
