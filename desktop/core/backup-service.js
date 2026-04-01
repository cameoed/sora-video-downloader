const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { randomInt } = require('crypto');
const { FileStore } = require('./file-store');
const { PlaywrightSession } = require('./playwright-session');
const { downloadToFile, getSmartDownloadProviders, resolveSmartDownloadRequest } = require('./http-download');
const { resolveFfmpegBinary, processVideo, buildIntermediateDownloadPath } = require('./media-processing');
const {
  BACKUP_URL_REFRESH_MAX_AGE_MS,
  BACKUP_DOWNLOAD_FOLDER,
  DEFAULT_BACKUP_SCOPES,
  normalizeBackupScopes,
  normalizeBackupRequestSettings,
  normalizeBackupAudioMode,
  normalizeBackupFramingMode,
  normalizeCharacterHandle,
  normalizeCurrentUser,
  extractOwnerIdentity,
  pickBackupMediaSource,
  inferFileExtension,
  isSignedUrlFresh,
  normalizeRunStatus,
  normalizeItemStatus,
  isTerminalRunStatus,
  applyBackupStatusTransition,
  createBackupRunRecord,
  summarizeBackupRun,
  buildBackupBucketProgressSnapshot,
  createEmptyBackupBucketCatalog,
  normalizeBackupBucketCatalog,
  recordBackupItemsInBucketCatalog,
  buildBackupHistoricalBucketCounts,
  getSelectedBackupBuckets,
  extractItemsFromPayload,
  extractCursorFromPayload,
  getBackupItemId,
  makeBackupItemKey,
  buildBackupFolderName,
  buildBackupFilename,
  buildBackupManifestItem,
  buildBackupDetailPath,
  pickPrompt,
  pickPromptSource,
  pickTitle,
  sanitizeString,
} = require('./helpers');
const WATERMARK_DOWNLOAD_THROTTLE_MS = 3000;
const COMPLETE_SCAN_BUCKETS = ['ownPosts', 'ownDrafts'];
const PROMPT_SIMILARITY_THRESHOLD = 0.95;

function normalizePromptForDisplay(value) {
  return sanitizeString(String(value || '').replace(/\s+/g, ' '), 8192) || '';
}

function normalizePromptForSimilarity(value) {
  const base = normalizePromptForDisplay(value);
  if (!base) return '';
  return base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computePromptSimilarity(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  if (!maxLen) return 1;
  if ((maxLen - minLen) / maxLen > (1 - PROMPT_SIMILARITY_THRESHOLD)) {
    return minLen / maxLen;
  }
  const previous = new Array(b.length + 1);
  const current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin / maxLen > (1 - PROMPT_SIMILARITY_THRESHOLD)) {
      return 1 - (rowMin / maxLen);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return Math.max(0, 1 - (previous[b.length] / maxLen));
}

function formatPromptCsvDuration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  if (numeric < 60) return numeric.toFixed(1).replace(/\.0$/, '') + ' sec';
  const totalSeconds = Math.round(numeric);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function formatPromptCsvDate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
}

function escapeCsvValue(value) {
  const text = String(value == null ? '' : value);
  if (!/[",\n]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function buildPromptCsv(rows) {
  const lines = [
    '"All draft prompts with similar prompts de-duplicated!"',
    'Prompt,Duration,Creation Date',
  ];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    lines.push([
      escapeCsvValue(row.prompt),
      escapeCsvValue(row.duration),
      escapeCsvValue(row.createdAt),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function createEmptyCompleteScanCatalog() {
  return { ownPosts: null, ownDrafts: null };
}

function normalizeCompleteScanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const runId = typeof raw.runId === 'string' && raw.runId ? raw.runId : null;
  const completedAt = Number.isFinite(Number(raw.completedAt)) && Number(raw.completedAt) > 0
    ? Math.floor(Number(raw.completedAt))
    : 0;
  if (!runId || !completedAt) return null;
  return { runId, completedAt };
}

function normalizeCompleteScanCatalog(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    ownPosts: normalizeCompleteScanEntry(source.ownPosts),
    ownDrafts: normalizeCompleteScanEntry(source.ownDrafts),
  };
}
const VIDEO_PROCESS_RETRY_COUNT = 2;
const CLEARABLE_CACHE_BUCKETS = ['ownPosts', 'ownDrafts', 'castInPosts', 'castInDrafts'];
const CLEARABLE_CACHE_LABELS = {
  ownPosts: 'My posts',
  ownDrafts: 'My drafts',
  castInPosts: 'Cast-in posts',
  castInDrafts: 'Drafts of me',
};

function createEmptyCacheResetCatalog() {
  return {
    ownDrafts: 0,
    ownPosts: 0,
    castInPosts: 0,
    castInDrafts: 0,
    characterPosts: {},
    ownPrompts: 0,
  };
}

function normalizeCacheResetTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizeCacheResetCatalog(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const normalized = createEmptyCacheResetCatalog();
  normalized.ownDrafts = normalizeCacheResetTimestamp(source.ownDrafts);
  normalized.ownPosts = normalizeCacheResetTimestamp(source.ownPosts);
  normalized.castInPosts = normalizeCacheResetTimestamp(source.castInPosts);
  normalized.castInDrafts = normalizeCacheResetTimestamp(source.castInDrafts);
  normalized.ownPrompts = normalizeCacheResetTimestamp(source.ownPrompts);
  const rawCharacters = source.characterPosts && typeof source.characterPosts === 'object' && !Array.isArray(source.characterPosts)
    ? source.characterPosts
    : {};
  Object.keys(rawCharacters).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) return;
    normalized.characterPosts[normalizedHandle] = normalizeCacheResetTimestamp(rawCharacters[handle]);
  });
  return normalized;
}

class BackupCancelledError extends Error {
  constructor() {
    super('backup_cancelled');
    this.name = 'BackupCancelledError';
  }
}

const SMART_DOWNLOAD_OVERLOADED_MESSAGE = 'All watermark removers are overloaded right now. Please try again later.';

class BackupService extends EventEmitter {
  constructor(options) {
    super();
    this.baseDir = options.baseDir;
    this.defaultDownloadDir = options.defaultDownloadDir;
    this.store = new FileStore(path.join(options.baseDir, 'runtime'));
    this.session = new PlaywrightSession({ baseDir: options.baseDir });
    this.state = null;
    this.currentJob = null;
    this.currentJobPromise = null;
    this.ffmpegPath = '';
    this.ffmpegPathPromise = null;
    this.activeAbortController = null;
  }

  async initialize() {
    await this.store.initialize();
    this.state = await this.store.getState();
    const settings = this.state.settings || {};
    if (!settings.downloadDir) settings.downloadDir = this.defaultDownloadDir;
    if (!settings.published_download_mode) settings.published_download_mode = 'smart';
    settings.audio_mode = normalizeBackupAudioMode(settings.audio_mode);
    settings.framing_mode = normalizeBackupFramingMode(settings.framing_mode);
    if (!settings.selectedScope) settings.selectedScope = 'ownPosts';
    if (!settings.character_handle) settings.character_handle = '';
    delete settings.profile;
    settings.theme = 'dark';
    this.state.settings = settings;
    this.state.bucketCatalog = normalizeBackupBucketCatalog(this.state.bucketCatalog || createEmptyBackupBucketCatalog());
    this.state.savedCatalog = normalizeBackupBucketCatalog(this.state.savedCatalog || createEmptyBackupBucketCatalog());
    this.state.cacheResetCatalog = normalizeCacheResetCatalog(this.state.cacheResetCatalog);
    this.state.completeScanCatalog = normalizeCompleteScanCatalog(this.state.completeScanCatalog);
    await this._hydrateSavedCatalogFromRuns();
    await this.store.saveState(this.state);
  }

  async getBootstrap() {
    const lastRunId = this.state && this.state.lastRunId;
    const runRecord = this.currentJob
      ? this.currentJob.run
      : await this.store.getRun(lastRunId);
    if (!this.currentJob && runRecord && !isTerminalRunStatus(runRecord.status)) {
      await this._resetStaleRunForBootstrap(runRecord);
    }
    const run = this.currentJob
      ? summarizeBackupRun(this.currentJob.run)
      : (!runRecord || isTerminalRunStatus(runRecord.status))
        ? null
        : summarizeBackupRun(runRecord);
    const items = this.currentJob
      ? this.currentJob.items
      : run
        ? await this.store.getItems(lastRunId)
        : [];
    return {
      settings: Object.assign({}, this.state.settings),
      session: Object.assign({ authenticated: false, checkedAt: 0, user: null }, this.state.session || {}),
      run: run,
      bucket_progress: this._buildBucketProgressSnapshot(run, items || [], this.state.settings),
    };
  }

  async getClearCacheTargets() {
    return {
      ok: true,
      targets: this._buildClearCacheTargets(),
    };
  }

  async _resetStaleRunForBootstrap(runRecord) {
    if (!runRecord || isTerminalRunStatus(runRecord.status)) return;
    const now = Date.now();
    runRecord.status = 'cancelled';
    runRecord.cancelled_at = now;
    runRecord.updated_at = now;
    runRecord.active_item_key = '';
    runRecord.summary_text = 'Backup cancelled.';
    await this.store.saveRun(runRecord);
  }

  async clearSelectedCaches(payload) {
    if (this.currentJob && !isTerminalRunStatus(this.currentJob.run && this.currentJob.run.status)) {
      return { ok: false, error: 'backup_run_in_progress' };
    }

    const rawModes = Array.isArray(payload && payload.modes) ? payload.modes : [];
    const rawCharacters = Array.isArray(payload && payload.characters) ? payload.characters : [];
    const modes = Array.from(
      new Set(
        rawModes
          .map((value) => sanitizeString(String(value || ''), 64) || '')
          .filter((value) => CLEARABLE_CACHE_BUCKETS.indexOf(value) >= 0)
      )
    );
    const characters = Array.from(
      new Set(
        rawCharacters
          .map((value) => normalizeCharacterHandle(value))
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right));

    if (!modes.length && !characters.length) {
      return { ok: false, error: 'backup_cache_clear_empty_selection' };
    }

    const nextBucketCatalog = normalizeBackupBucketCatalog(this.state.bucketCatalog || createEmptyBackupBucketCatalog());
    const nextSavedCatalog = normalizeBackupBucketCatalog(this.state.savedCatalog || createEmptyBackupBucketCatalog());
    const nextResetCatalog = normalizeCacheResetCatalog(this.state.cacheResetCatalog);
    const nextCompleteScanCatalog = normalizeCompleteScanCatalog(this.state.completeScanCatalog);
    const resetAt = Date.now();

    for (let index = 0; index < modes.length; index += 1) {
      const bucketKey = modes[index];
      nextBucketCatalog[bucketKey] = [];
      nextSavedCatalog[bucketKey] = [];
      nextResetCatalog[bucketKey] = resetAt;
      if (Object.prototype.hasOwnProperty.call(nextCompleteScanCatalog, bucketKey)) {
        nextCompleteScanCatalog[bucketKey] = null;
      }
    }

    for (let index = 0; index < characters.length; index += 1) {
      const handle = characters[index];
      delete nextBucketCatalog.characterPosts[handle];
      delete nextSavedCatalog.characterPosts[handle];
      nextResetCatalog.characterPosts[handle] = resetAt;
    }

    this.state.bucketCatalog = nextBucketCatalog;
    this.state.savedCatalog = nextSavedCatalog;
    this.state.cacheResetCatalog = nextResetCatalog;
    this.state.completeScanCatalog = nextCompleteScanCatalog;
    await this.store.saveState(this.state);
    const bootstrap = await this.getBootstrap();
    bootstrap.bucket_progress = this._buildBucketProgressSnapshot(null, [], this.state.settings);

    return {
      ok: true,
      cleared: {
        modes: modes,
        characters: characters,
      },
      targets: this._buildClearCacheTargets(),
      bootstrap: bootstrap,
    };
  }

  async updateSettings(partial) {
    const nextSettings = Object.assign({}, this.state.settings, partial || {});
    nextSettings.audio_mode = normalizeBackupAudioMode(nextSettings.audio_mode);
    nextSettings.framing_mode = normalizeBackupFramingMode(nextSettings.framing_mode);
    delete nextSettings.profile;
    this.state.settings = nextSettings;
    await this.store.saveState(this.state);
    return this.state.settings;
  }

  async openLoginWindow() {
    const result = await this.session.openLoginWindow();
    return Object.assign({ ok: true }, result);
  }

  async checkSession() {
    const sessionStatus = await this.session.checkAuth();
    this.state.session = {
      authenticated: sessionStatus.authenticated === true,
      checkedAt: Date.now(),
      user: sessionStatus.user || null,
      status: sessionStatus.status || 0,
      error: sessionStatus.error || '',
    };
    await this.store.saveState(this.state);
    return { ok: true, session: this.state.session };
  }

  async shutdown() {
    await this.cancelBackup().catch(() => {});
    if (this.currentJobPromise) {
      await this.currentJobPromise.catch(() => {});
    }
    await this.session.close();
  }

  async startBackup(payload) {
    if (this.currentJob && !isTerminalRunStatus(this.currentJob.run.status)) {
      return { ok: false, error: 'backup_run_in_progress', run: summarizeBackupRun(this.currentJob.run) };
    }

    const scopes = normalizeBackupScopes(payload && payload.scopes ? payload.scopes : DEFAULT_BACKUP_SCOPES);
    const settings = normalizeBackupRequestSettings(payload && payload.settings ? payload.settings : this.state.settings);
    settings.downloadDir = payload && payload.downloadDir ? payload.downloadDir : this.state.settings.downloadDir;
    await this.updateSettings({
      downloadDir: settings.downloadDir,
      published_download_mode: settings.published_download_mode,
      audio_mode: settings.audio_mode,
      framing_mode: settings.framing_mode,
      character_handle: settings.character_handle,
      selectedScope: Object.keys(scopes).find((key) => scopes[key] === true) || 'ownPosts',
    });

    const sessionCheck = await this.checkSession();
    if (!sessionCheck.session || !sessionCheck.session.authenticated) {
      return { ok: false, error: 'backup_missing_auth_session' };
    }

    const run = createBackupRunRecord(scopes, settings, settings.downloadDir);
    run.current_user = normalizeCurrentUser(sessionCheck.session.user || {});

    const job = {
      run: run,
      items: [],
      seenKeys: new Set(),
      savedIds: this._buildSavedIdSetsForRun(run),
      smartDownload: this._createSmartDownloadState(settings.published_download_mode),
      cancelRequested: false,
      dirtyItemWrites: 0,
    };

    this.currentJob = job;
    this.state.lastRunId = run.id;
    await this.store.saveState(this.state);
    await this.store.saveRun(run);
    this._emitStatus(job);

    this.currentJobPromise = this._runBackup(job)
      .catch((error) => {
        return this._failJob(job, error).catch(() => {});
      })
      .finally(() => {
        if (this.currentJob === job) this.currentJob = null;
        if (this.currentJobPromise) this.currentJobPromise = null;
      });

    return { ok: true, run: summarizeBackupRun(run) };
  }

  async cancelBackup() {
    if (!this.currentJob || isTerminalRunStatus(this.currentJob.run.status)) {
      const lastRunId = this.state && this.state.lastRunId;
      const lastRun = lastRunId ? await this.store.getRun(lastRunId) : null;
      if (lastRun && !isTerminalRunStatus(lastRun.status)) {
        lastRun.status = 'cancelled';
        lastRun.cancelled_at = Date.now();
        lastRun.updated_at = Date.now();
        lastRun.active_item_key = '';
        lastRun.summary_text = 'Backup cancelled.';
        await this.store.saveRun(lastRun);
        return { ok: true, run: summarizeBackupRun(lastRun) };
      }
      return { ok: true, run: summarizeBackupRun(lastRun) };
    }
    this.currentJob.cancelRequested = true;
    this._abortActiveWork();
    this.currentJob.run.summary_text = 'Cancel requested. The current step will stop safely.';
    this.currentJob.run.updated_at = Date.now();
    await this.store.saveRun(this.currentJob.run);
    this._emitStatus(this.currentJob);
    return { ok: true, run: summarizeBackupRun(this.currentJob.run) };
  }

  async exportManifest(runId, format) {
    const targetRunId = runId || (this.currentJob && this.currentJob.run && this.currentJob.run.id) || this.state.lastRunId;
    if (!targetRunId) return { ok: false, error: 'backup_run_not_found' };
    const run = this.currentJob && this.currentJob.run.id === targetRunId
      ? this.currentJob.run
      : await this.store.getRun(targetRunId);
    if (!run) return { ok: false, error: 'backup_run_not_found' };
    const items = this.currentJob && this.currentJob.run.id === targetRunId
      ? this.currentJob.items
      : await this.store.getItems(targetRunId);
    const exported = await this.store.exportManifest(run, items, format);
    return { ok: true, path: exported.path, filename: exported.filename };
  }

  async getRunFolder(runId) {
    const targetRunId = runId || (this.currentJob && this.currentJob.run.id) || this.state.lastRunId;
    if (!targetRunId) return '';
    const run = this.currentJob && this.currentJob.run.id === targetRunId
      ? this.currentJob.run
      : await this.store.getRun(targetRunId);
    if (!run) return '';
    const scopes = normalizeBackupScopes(run.scopes);
    const bucketKey = Object.keys(scopes).find((key) => scopes[key] === true) || 'ownPosts';
    return path.join(run.download_dir || this.state.settings.downloadDir, BACKUP_DOWNLOAD_FOLDER, buildBackupFolderName(run, bucketKey));
  }

  _isPromptExportRun(run) {
    const scopes = normalizeBackupScopes(run && run.scopes);
    return scopes.ownPrompts === true;
  }

  async _runBackup(job) {
    try {
      await this._discover(job);
      if (job.cancelRequested) throw new BackupCancelledError();

      await this.store.saveItems(job.run.id, job.items);

      if (this._isPromptExportRun(job.run)) {
        job.run.status = 'running';
        job.run.summary_text = 'Discovery complete. Preparing prompts CSV...';
        job.run.updated_at = Date.now();
        await this.store.saveRun(job.run);
        this._emitStatus(job);
        const promptExport = await this._exportPromptCsv(job);
        if (job.cancelRequested) throw new BackupCancelledError();
        job.run.status = 'completed';
        job.run.completed_at = Date.now();
        job.run.updated_at = Date.now();
        job.run.active_item_key = '';
        job.run.summary_text = 'Prompt export complete. ' + promptExport.uniqueCount + ' unique prompts saved, ' + promptExport.skippedCount + ' skipped.';
        await this._persistJob(job, true);
        await this.store.exportManifest(job.run, job.items, 'manifest');
        await this.store.exportManifest(job.run, job.items, 'failures');
        await this.store.exportManifest(job.run, job.items, 'summary');
        this._emitStatus(job);
        return;
      }

      if ((Number(job.run.counts.queued) || 0) > 0) {
        job.run.status = 'running';
        job.run.summary_text = 'Discovery complete. ' + job.run.counts.queued + ' files queued.';
        job.run.updated_at = Date.now();
        await this.store.saveRun(job.run);
        this._emitStatus(job);
        await this._downloadQueuedItems(job);
      }

      if (job.cancelRequested) throw new BackupCancelledError();

      job.run.status = 'completed';
      job.run.completed_at = Date.now();
      job.run.updated_at = Date.now();
      job.run.active_item_key = '';
      job.run.summary_text =
        'Backup complete. ' +
        (Number(job.run.counts.done) || 0) +
        ' downloaded, ' +
        (Number(job.run.counts.failed) || 0) +
        ' failed, ' +
        (Number(job.run.counts.skipped) || 0) +
        ' skipped.';
      await this._persistJob(job, true);
      await this.store.exportManifest(job.run, job.items, 'manifest');
      await this.store.exportManifest(job.run, job.items, 'failures');
      await this.store.exportManifest(job.run, job.items, 'summary');
      this._emitStatus(job);
    } catch (error) {
      if (error instanceof BackupCancelledError) {
        job.run.status = 'cancelled';
        job.run.cancelled_at = Date.now();
        job.run.updated_at = Date.now();
        job.run.active_item_key = '';
        job.run.summary_text = 'Backup cancelled.';
        await this._persistJob(job, true);
        await this.store.exportManifest(job.run, job.items, 'manifest');
        await this.store.exportManifest(job.run, job.items, 'failures');
        await this.store.exportManifest(job.run, job.items, 'summary');
        this._emitStatus(job);
      } else {
        throw error;
      }
    } finally {}
  }

  async _discover(job) {
    const buckets = getSelectedBackupBuckets(job.run.scopes, job.run.settings);
    let order = 0;
    let ownPostsFirstPage = null;

    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
      const bucket = buckets[bucketIndex];
      this._throwIfCancelled(job);
      job.run.summary_text = 'Discovering ' + bucket.key + '…';
      job.run.updated_at = Date.now();
      await this.store.saveRun(job.run);
      this._emitStatus(job);

      if (COMPLETE_SCAN_BUCKETS.indexOf(bucket.key) >= 0) {
        const cached = this.state.completeScanCatalog && this.state.completeScanCatalog[bucket.key];
        if (cached && cached.runId && cached.runId !== job.run.id) {
          job.run.summary_text = 'Loading cached ' + bucket.key + ' from previous scan…';
          job.run.updated_at = Date.now();
          await this.store.saveRun(job.run);
          this._emitStatus(job);
          const loaded = await this._loadCachedBucketItems(job, bucket, cached.runId, order);
          if (loaded > 0) {
            order += loaded;
            await this._refreshBucketCatalog(job);
            job.run.summary_text = 'Loaded ' + loaded + ' cached ' + bucket.key + ' items (skipped re-scan).';
            job.run.updated_at = Date.now();
            await this.store.saveRun(job.run);
            this._emitStatus(job);
            continue;
          }
        }
      }

      let cursor = null;
      let pageNumber = 0;
      const seenCursors = new Set();

      do {
        this._throwIfCancelled(job);
        const params = Object.assign({ limit: bucket.limit, cursor: cursor }, bucket.extraParams || {});
        let json;
        if (bucket.key === 'characterPosts') {
          json = await this.session.fetchCharacterPostsJson(bucket.character_handle, params, { signal: this._createActiveAbortSignal() });
        } else {
          const response = await this.session.fetchJson(bucket.pathname, params, { signal: this._createActiveAbortSignal() });
          json = response.json || {};
        }

        if (!ownPostsFirstPage && bucket.key === 'ownPosts') ownPostsFirstPage = json;
        if (!(job.run.current_user && (job.run.current_user.handle || job.run.current_user.id))) {
          job.run.current_user = await this._resolveCurrentUser(ownPostsFirstPage);
        }

        const items = extractItemsFromPayload(json);
        let discoveredInPage = 0;
        for (let index = 0; index < items.length; index += 1) {
          this._throwIfCancelled(job);
          const listItem = items[index];
          const id = getBackupItemId(bucket.kind, listItem);
          if (!id) continue;
          const dedupeKey = bucket.kind + ':' + id;
          if (job.seenKeys.has(dedupeKey)) continue;
          job.seenKeys.add(dedupeKey);

          let detail = null;
          let owner = extractOwnerIdentity(listItem);
          if (this._shouldFetchDiscoveryDetail(bucket, owner)) {
            detail = await this._fetchBackupDetail(bucket.kind, id);
            owner = extractOwnerIdentity(detail || listItem);
          }
          if (this._isAlreadySaved(job, bucket.key, id)) {
            continue;
          }
          const backupItem = buildBackupManifestItem(job.run, bucket.key, bucket.kind, listItem, detail, order);
          if (!backupItem) continue;
          order += 1;
          discoveredInPage += 1;
          job.items.push(backupItem);
          job.run.counts.discovered += 1;
          job.run.bucket_counts[bucket.key] = (Number(job.run.bucket_counts[bucket.key]) || 0) + 1;
          job.run.counts = applyBackupStatusTransition(job.run.counts, null, backupItem.status);
        }

        pageNumber += 1;
        await this._refreshBucketCatalog(job);
        job.run.summary_text = 'Discovering ' + bucket.key + ': page ' + pageNumber + ', accepted ' + job.run.counts.discovered;
        job.run.updated_at = Date.now();
        await this.store.saveRun(job.run);
        this._emitStatus(job);

        if (this._shouldDownloadIncrementalBatch(bucket.key) && discoveredInPage > 0) {
          await this._downloadIncrementalBatch(job, bucket);
        }

        const nextCursor = extractCursorFromPayload(json);
        if (nextCursor && !seenCursors.has(nextCursor)) {
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        } else {
          cursor = null;
        }
      } while (cursor);

      if (COMPLETE_SCAN_BUCKETS.indexOf(bucket.key) >= 0) {
        if (!this.state.completeScanCatalog) this.state.completeScanCatalog = createEmptyCompleteScanCatalog();
        this.state.completeScanCatalog[bucket.key] = { runId: job.run.id, completedAt: Date.now() };
        await this.store.saveState(this.state);
      }
    }
  }

  async _loadCachedBucketItems(job, bucket, runId, startOrder) {
    try {
      const cachedItems = await this.store.getItems(runId);
      const bucketItems = (cachedItems || []).filter((item) => item && item.bucket === bucket.key);
      if (!bucketItems.length) return 0;
      let count = 0;
      for (let i = 0; i < bucketItems.length; i += 1) {
        const source = bucketItems[i];
        const dedupeKey = source.kind + ':' + source.id;
        if (job.seenKeys.has(dedupeKey)) continue;
        job.seenKeys.add(dedupeKey);
        if (this._isAlreadySaved(job, bucket.key, source.id)) continue;
        const item = Object.assign({}, source, {
          item_key: makeBackupItemKey(job.run.id, source.kind, source.id),
          run_id: job.run.id,
          order: startOrder + count,
          status: 'queued',
          attempts: 0,
          last_error: '',
          filename: buildBackupFilename(job.run, source.bucket, source.id, source.media_ext),
        });
        job.items.push(item);
        job.run.counts.discovered += 1;
        job.run.bucket_counts[bucket.key] = (Number(job.run.bucket_counts[bucket.key]) || 0) + 1;
        job.run.counts = applyBackupStatusTransition(job.run.counts, null, item.status);
        count += 1;
      }
      return count;
    } catch (_err) {
      return 0;
    }
  }

  async _exportPromptCsv(job) {
    const uniqueRows = [];
    const accepted = [];

    for (let index = 0; index < job.items.length; index += 1) {
      this._throwIfCancelled(job);
      const item = job.items[index];
      const displayPrompt = normalizePromptForDisplay(item && item.prompt);
      if (!displayPrompt) {
        this._transitionItem(job, item, 'skipped', {
          last_error: 'missing_prompt',
        });
        continue;
      }

      const similarityPrompt = normalizePromptForSimilarity(displayPrompt);
      let duplicateMatch = null;
      for (let compareIndex = 0; compareIndex < accepted.length; compareIndex += 1) {
        const candidate = accepted[compareIndex];
        const similarity = computePromptSimilarity(similarityPrompt, candidate.similarityPrompt);
        if (similarity >= PROMPT_SIMILARITY_THRESHOLD) {
          duplicateMatch = {
            itemId: candidate.item.id,
            similarity: similarity,
          };
          break;
        }
      }

      if (duplicateMatch) {
        this._transitionItem(job, item, 'skipped', {
          last_error: 'duplicate_prompt_' + duplicateMatch.itemId + '_' + duplicateMatch.similarity.toFixed(2),
        });
        continue;
      }

      accepted.push({
        item: item,
        similarityPrompt: similarityPrompt,
      });
      uniqueRows.push({
        prompt: displayPrompt,
        duration: formatPromptCsvDuration(item.duration_s),
        createdAt: formatPromptCsvDate(item.created_at),
      });
      this._transitionItem(job, item, 'done', {
        last_error: '',
      });
    }

    const bucketKey = 'ownPrompts';
    const folderPath = path.join(
      job.run.download_dir || this.state.settings.downloadDir,
      BACKUP_DOWNLOAD_FOLDER,
      buildBackupFolderName(job.run, bucketKey)
    );
    await fs.promises.mkdir(folderPath, { recursive: true });
    const csvPath = path.join(folderPath, 'my-prompts.csv');
    await this.store.writeFile(csvPath, buildPromptCsv(uniqueRows));

    return {
      path: csvPath,
      uniqueCount: uniqueRows.length,
      skippedCount: Math.max(0, job.items.length - uniqueRows.length),
    };
  }

  async _downloadQueuedItems(job) {
    const audioMode = normalizeBackupAudioMode(job && job.run && job.run.settings && job.run.settings.audio_mode);
    const framingMode = normalizeBackupFramingMode(job && job.run && job.run.settings && job.run.settings.framing_mode);
    const publishedDownloadMode = job && job.run && job.run.settings && job.run.settings.published_download_mode;
    const shouldProcessVideo = audioMode === 'no_audiomark' || framingMode === 'social_16_9';
    let index = 0;
    while (true) {
      const nextEntry = this._takeNextQueuedItem(job, index);
      if (!nextEntry) break;
      const item = nextEntry.item;
      index = nextEntry.nextIndex;
      if (normalizeItemStatus(item.status) !== 'queued') continue;
      this._throwIfCancelled(job);

      const preparedItem = await this._refreshBackupItemMedia(job.run, item);
      if (!preparedItem.media_url) {
        this._clearSmartDownloadRetryState(job, preparedItem);
        this._transitionItem(job, preparedItem, 'failed', {
          last_error: preparedItem.last_error || 'missing_media_url',
        });
        await this._persistJob(job, false);
        this._emitStatus(job);
        continue;
      }

      this._transitionItem(job, preparedItem, 'downloading', {
        attempts: (Number(preparedItem.attempts) || 0) + 1,
        last_error: '',
      });
      job.run.summary_text = 'Downloading ' + preparedItem.id + '…';
      await this._persistJob(job, false);
      this._emitStatus(job);

      const destinationPath = path.join(job.run.download_dir || this.state.settings.downloadDir, preparedItem.filename);
      const tempDownloadPath = shouldProcessVideo
        ? buildIntermediateDownloadPath(destinationPath, preparedItem.media_ext)
        : destinationPath;
      let downloadRequest = null;
      let doneOverrides = { last_error: '' };
      try {
        downloadRequest = await this._resolveDownloadRequest(job, preparedItem, publishedDownloadMode);
        await this._applyWatermarkDownloadThrottle(job, publishedDownloadMode);
        await downloadToFile(downloadRequest.url, tempDownloadPath, {
          acceptVideoOnErrorStatus: downloadRequest.acceptVideoOnErrorStatus,
          headers: downloadRequest.headers,
          signal: this._createActiveAbortSignal(),
        });
        if (shouldProcessVideo) {
          job.run.summary_text = this._buildVideoProcessingSummary(preparedItem, audioMode, framingMode);
          await this._persistJob(job, false);
          this._emitStatus(job);
          const processingOutcome = await this._processVideoWithRecovery(job, preparedItem, tempDownloadPath, destinationPath, {
            audioMode: audioMode,
            framingMode: framingMode,
            width: preparedItem.width,
            height: preparedItem.height,
          });
          doneOverrides = processingOutcome && processingOutcome.itemOverrides
            ? processingOutcome.itemOverrides
            : doneOverrides;
        }
        this._resetSmartDownloadFailures(job, preparedItem);
        this._transitionItem(job, preparedItem, 'done', doneOverrides);
      } catch (error) {
        if (job.cancelRequested && String((error && error.message) || error || '') === 'download_cancelled') {
          throw new BackupCancelledError();
        }
        if (shouldProcessVideo) {
          await this._removeFileIfPresent(tempDownloadPath);
          await this._removeFileIfPresent(destinationPath);
        }
        const handledSmartFailure = this._handleSmartDownloadFailure(job, preparedItem, error, downloadRequest, publishedDownloadMode);
        if (handledSmartFailure) {
          await this._persistJob(job, false);
          this._emitStatus(job);
          continue;
        }
        this._clearSmartDownloadRetryState(job, preparedItem);
        this._transitionItem(job, preparedItem, 'failed', {
          last_error: sanitizeString(String((error && (error.userMessage || error.message)) || error || 'download_failed'), 1024) || 'download_failed',
        });
      }

      await this._persistJob(job, false);
      this._emitStatus(job);
    }
  }

  async _resolveDownloadRequest(job, item, publishedDownloadMode) {
    if (!item || !item.media_url) {
      throw new Error('missing_media_url');
    }

    if (publishedDownloadMode !== 'smart' || item.kind !== 'published') {
      return {
        providerId: '',
        url: item.media_url,
        headers: {},
      };
    }

    if (item.media_variant === 'no_watermark') {
      return {
        providerId: '',
        url: item.media_url,
        headers: {},
      };
    }

    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !smartDownload.providers.length) {
      throw new Error('smart_download_no_providers');
    }
    const activeProvider = smartDownload.providers[smartDownload.activeProviderIndex];
    try {
      return await resolveSmartDownloadRequest(activeProvider.id, item, { signal: this._createActiveAbortSignal() });
    } catch (error) {
      throw this._createSmartProviderError(activeProvider.id, 'resolve', error);
    }
  }

  async _fetchBackupDetail(kind, id) {
    const response = await this.session.fetchJson(buildBackupDetailPath(kind, id), {}, { signal: this._createActiveAbortSignal() });
    return response.json || {};
  }

  async _resolveCurrentUser(cachedOwnPostsPage) {
    try {
      const response = await this.session.fetchJson('/backend/project_y/v2/me', {}, { signal: this._createActiveAbortSignal() });
      const user = normalizeCurrentUser(response.json || {});
      if (user.handle || user.id) return user;
    } catch (_error) {}

    const items = extractItemsFromPayload(cachedOwnPostsPage || {});
    if (items.length) {
      const owner = extractOwnerIdentity(items[0]);
      if (owner.handle || owner.id) return owner;
    }
    return { handle: '', id: '' };
  }

  _shouldFetchDiscoveryDetail(bucket, owner) {
    if (!bucket || !bucket.key) return false;
    if (bucket.key === 'castInDrafts' || bucket.key === 'castInPosts') {
      return !(owner && (owner.handle || owner.id));
    }
    return false;
  }

  async _refreshBackupItemMedia(run, item) {
    const freshEnough =
      item.media_url &&
      isSignedUrlFresh(item.media_url, item.url_refreshed_at || 0, Date.now()) &&
      Date.now() - Number(item.url_refreshed_at || 0) < BACKUP_URL_REFRESH_MAX_AGE_MS;
    if (freshEnough) return item;

    const detailPath = item.detail_url.indexOf('https://sora.chatgpt.com') === 0
      ? item.detail_url.slice('https://sora.chatgpt.com'.length)
      : item.detail_url;

    try {
      const response = await this.session.fetchJson(detailPath, {}, { signal: this._createActiveAbortSignal() });
      const detail = response.json || {};
      const media = pickBackupMediaSource(item.kind, detail);
      if (!media || !media.url) {
        item.media_url = '';
        item.media_variant = '';
        item.media_ext = 'mp4';
        item.url_refreshed_at = 0;
        item.last_error = 'refresh_missing_media_url';
        return item;
      }
      const owner = extractOwnerIdentity(detail);
      item.owner_handle = item.owner_handle || owner.handle || '';
      item.owner_id = item.owner_id || owner.id || '';
      item.prompt = item.prompt || pickPrompt(detail, null);
      item.prompt_source = item.prompt_source || pickPromptSource(detail, null);
      item.title = item.title || pickTitle(detail, null);
      item.media_url = media.url;
      item.media_variant = media.variant;
      item.media_ext = media.ext || inferFileExtension(media.url, media.mimeType);
      item.media_key_path = media.keyPath || '';
      item.filename = buildBackupFilename(run, item.bucket, item.id, item.media_ext);
      item.url_refreshed_at = Date.now();
      item.last_error = '';
      return item;
    } catch (error) {
      item.last_error = sanitizeString(String((error && error.message) || error || 'refresh_failed'), 1024) || 'refresh_failed';
      return item;
    }
  }

  async _getFfmpegPath(job) {
    if (this.ffmpegPath) return this.ffmpegPath;
    if (!this.ffmpegPathPromise) {
      this.ffmpegPathPromise = resolveFfmpegBinary({
        baseDir: this.baseDir,
        onStatus: async (message) => {
          if (!job || !job.run) return;
          job.run.summary_text = message;
          job.run.updated_at = Date.now();
          await this.store.saveRun(job.run);
          this._emitStatus(job);
        },
      })
        .then((resolvedPath) => {
          this.ffmpegPath = resolvedPath;
          return resolvedPath;
        })
        .finally(() => {
          this.ffmpegPathPromise = null;
        });
    }
    return this.ffmpegPathPromise;
  }

  async _processVideo(job, inputPath, outputPath, options) {
    const ffmpegPath = await this._getFfmpegPath(job);
    await processVideo({
      ffmpegPath: ffmpegPath,
      inputPath: inputPath,
      outputPath: outputPath,
      audioMode: options && options.audioMode,
      framingMode: options && options.framingMode,
      width: options && options.width,
      height: options && options.height,
      signal: this._createActiveAbortSignal(),
    });
  }

  async _processVideoWithRecovery(job, item, inputPath, outputPath, options) {
    const requestedOptions = {
      audioMode: normalizeBackupAudioMode(options && options.audioMode),
      framingMode: normalizeBackupFramingMode(options && options.framingMode),
      width: options && options.width,
      height: options && options.height,
    };

    for (let attempt = 1; attempt <= VIDEO_PROCESS_RETRY_COUNT; attempt += 1) {
      if (attempt > 1) {
        job.run.summary_text = 'Retrying video processing for ' + item.id + '...';
        await this._persistJob(job, false);
        this._emitStatus(job);
      }
      await this._removeFileIfPresent(outputPath);
      try {
        await this._processVideo(job, inputPath, outputPath, requestedOptions);
        await this._removeFileIfPresent(inputPath);
        return {
          itemOverrides: { last_error: '' },
        };
      } catch (error) {
        await this._removeFileIfPresent(outputPath);
        if (job.cancelRequested && String((error && error.message) || error || '') === 'download_cancelled') {
          throw new BackupCancelledError();
        }
      }
    }

    const fallbackOptions = this._buildFallbackVideoProcessingOptions(requestedOptions);
    const fallbackOutputPath = this._buildOutputPathForProcessingOptions(outputPath, item.media_ext, fallbackOptions);
    job.run.summary_text = 'Retrying ' + item.id + ' with safer FFmpeg settings...';
    await this._persistJob(job, false);
    this._emitStatus(job);
    await this._removeFileIfPresent(fallbackOutputPath);
    try {
      await this._processVideo(job, inputPath, fallbackOutputPath, fallbackOptions);
      await this._removeFileIfPresent(inputPath);
      return {
        itemOverrides: Object.assign(
          { last_error: 'Requested processing failed twice. Saved with With Audiomark + Default Crop instead.' },
          this._buildFilenameOverride(job, item, fallbackOutputPath)
        ),
      };
    } catch (fallbackError) {
      await this._removeFileIfPresent(fallbackOutputPath);
      if (job.cancelRequested && String((fallbackError && fallbackError.message) || fallbackError || '') === 'download_cancelled') {
        throw new BackupCancelledError();
      }
    }

    const preservedSourcePath = this._buildOutputPathForProcessingOptions(outputPath, item.media_ext, {
      audioMode: 'with_audiomark',
      framingMode: 'sora_default',
    });
    await this._removeFileIfPresent(outputPath);
    await this._removeFileIfPresent(preservedSourcePath);
    await fs.promises.mkdir(path.dirname(preservedSourcePath), { recursive: true });
    await fs.promises.rename(inputPath, preservedSourcePath);
    return {
      itemOverrides: Object.assign(
        { last_error: 'FFmpeg failed. Saved the original downloaded video instead.' },
        this._buildFilenameOverride(job, item, preservedSourcePath)
      ),
    };
  }

  _buildVideoProcessingSummary(item, audioMode, framingMode) {
    const steps = [];
    if (normalizeBackupAudioMode(audioMode) === 'no_audiomark') {
      steps.push('removing audiomark and stripping C2PA manifest data');
    }
    if (normalizeBackupFramingMode(framingMode) === 'social_16_9') steps.push('cropping for social');
    if (!steps.length) return 'Processing ' + item.id + '...';
    return 'Processing ' + item.id + ': ' + steps.join(' and ') + '...';
  }

  _buildFallbackVideoProcessingOptions(options) {
    return {
      audioMode: 'with_audiomark',
      framingMode: 'sora_default',
      width: options && options.width,
      height: options && options.height,
    };
  }

  _buildOutputPathForProcessingOptions(outputPath, mediaExt, options) {
    const parsed = path.parse(outputPath);
    const audioMode = normalizeBackupAudioMode(options && options.audioMode);
    const framingMode = normalizeBackupFramingMode(options && options.framingMode);
    let safeExt = sanitizeString(mediaExt, 16) || 'mp4';
    if (audioMode === 'no_audiomark') safeExt = 'mov';
    else if (framingMode === 'social_16_9') safeExt = 'mp4';
    return path.join(parsed.dir, parsed.name + '.' + safeExt);
  }

  _buildFilenameOverride(job, item, absolutePath) {
    const baseDownloadDir = job && job.run && job.run.download_dir
      ? job.run.download_dir
      : (this.state && this.state.settings && this.state.settings.downloadDir) || '';
    const relativePath = baseDownloadDir ? path.relative(baseDownloadDir, absolutePath) : absolutePath;
    if (!relativePath || relativePath === item.filename) return {};
    return { filename: relativePath };
  }

  async _applyWatermarkDownloadThrottle(job, publishedDownloadMode) {
    if (publishedDownloadMode !== 'direct_sora') return;
    const lastStartedAt = Number(job && job.lastWatermarkDownloadStartedAt) || 0;
    const waitMs = Math.max(0, WATERMARK_DOWNLOAD_THROTTLE_MS - (Date.now() - lastStartedAt));
    if (waitMs > 0) {
      await this._waitForDelay(waitMs);
    }
    if (job) job.lastWatermarkDownloadStartedAt = Date.now();
  }

  async _waitForDelay(waitMs) {
    if (!(waitMs > 0)) return;
    const signal = this._createActiveAbortSignal();
    await new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        if (this.activeAbortController && this.activeAbortController.signal === signal) {
          this.activeAbortController = null;
        }
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('download_cancelled'));
      };
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, waitMs);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async _removeFileIfPresent(targetPath) {
    if (!targetPath) return;
    await fs.promises.rm(targetPath, { force: true }).catch(() => {});
  }

  _createActiveAbortSignal() {
    const controller = new AbortController();
    this.activeAbortController = controller;
    return controller.signal;
  }

  _abortActiveWork() {
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch (_error) {}
      this.activeAbortController = null;
    }
    if (this.session && this.session.abortActiveRequest) {
      this.session.abortActiveRequest();
    }
  }

  _createSmartDownloadState(publishedDownloadMode) {
    if (publishedDownloadMode !== 'smart') return null;
    const providers = getSmartDownloadProviders();
    if (!providers.length) return null;
    return {
      providers: providers,
      activeProviderIndex: providers.length === 1 ? 0 : randomInt(providers.length),
      consecutiveFailures: 0,
      deferredItems: [],
      deferredItemKeys: new Set(),
      itemRetryCounts: new Map(),
      maxRetriesPerItem: Math.max(2, providers.length * 2),
      flushDeferredNow: false,
    };
  }

  _getSmartDownloadState(job) {
    return job && job.smartDownload && Array.isArray(job.smartDownload.providers) && job.smartDownload.providers.length
      ? job.smartDownload
      : null;
  }

  _takeNextQueuedItem(job, nextIndex) {
    const smartDownload = this._getSmartDownloadState(job);
    if (smartDownload && smartDownload.flushDeferredNow && smartDownload.deferredItems.length) {
      const deferred = smartDownload.deferredItems.shift();
      smartDownload.deferredItemKeys.delete(deferred.item_key);
      if (!smartDownload.deferredItems.length) smartDownload.flushDeferredNow = false;
      return {
        item: deferred,
        nextIndex: nextIndex,
      };
    }

    if (nextIndex < job.items.length) {
      return {
        item: job.items[nextIndex],
        nextIndex: nextIndex + 1,
      };
    }

    if (smartDownload && smartDownload.deferredItems.length) {
      smartDownload.flushDeferredNow = true;
      return this._takeNextQueuedItem(job, nextIndex);
    }

    return null;
  }

  _createSmartProviderError(providerId, stage, error) {
    const message = sanitizeString(String((error && error.message) || error || 'smart_download_failed'), 1024) || 'smart_download_failed';
    const wrapped = new Error(message);
    wrapped.smartProviderFailure = true;
    wrapped.smartProviderId = sanitizeString(providerId, 64) || '';
    wrapped.smartProviderStage = sanitizeString(stage, 32) || '';
    wrapped.cause = error;
    return wrapped;
  }

  _isSmartProviderDownloadError(error, downloadRequest) {
    if (!downloadRequest || !downloadRequest.providerId) return false;
    const message = String((error && error.message) || error || '').trim();
    if (!message || message === 'download_cancelled') return false;
    return (
      /^download_http_/i.test(message) ||
      /^download_timeout$/i.test(message) ||
      /^smart_download_/i.test(message) ||
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|aborted/i.test(message)
    );
  }

  _queueDeferredSmartDownloadItem(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !item || !item.item_key) return;
    if (smartDownload.deferredItemKeys.has(item.item_key)) return;
    smartDownload.deferredItemKeys.add(item.item_key);
    smartDownload.deferredItems.push(item);
  }

  _clearSmartDownloadRetryState(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !item || !item.item_key) return;
    smartDownload.itemRetryCounts.delete(item.item_key);
  }

  _resetSmartDownloadFailures(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload) return;
    smartDownload.consecutiveFailures = 0;
    this._clearSmartDownloadRetryState(job, item);
    if (smartDownload.deferredItems.length) {
      smartDownload.flushDeferredNow = true;
    }
  }

  _switchSmartDownloadProvider(job) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || smartDownload.providers.length < 2) return false;
    smartDownload.activeProviderIndex = (smartDownload.activeProviderIndex + 1) % smartDownload.providers.length;
    smartDownload.consecutiveFailures = 0;
    smartDownload.flushDeferredNow = true;
    return true;
  }

  _handleSmartDownloadFailure(job, item, error, downloadRequest, publishedDownloadMode) {
    if (publishedDownloadMode !== 'smart' || !item || item.kind !== 'published' || item.media_variant === 'no_watermark') {
      return false;
    }

    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload) return false;

    const isProviderFailure =
      !!(error && error.smartProviderFailure) ||
      this._isSmartProviderDownloadError(error, downloadRequest);
    if (!isProviderFailure) return false;

    const retryCount = (smartDownload.itemRetryCounts.get(item.item_key) || 0) + 1;
    smartDownload.itemRetryCounts.set(item.item_key, retryCount);
    smartDownload.consecutiveFailures += 1;
    const shouldRetryItem = retryCount < smartDownload.maxRetriesPerItem;
    const switchedProvider = smartDownload.consecutiveFailures >= 2 && this._switchSmartDownloadProvider(job);
    if (!shouldRetryItem) {
      this._clearSmartDownloadRetryState(job, item);
      error.userMessage = SMART_DOWNLOAD_OVERLOADED_MESSAGE;
      job.run.summary_text = SMART_DOWNLOAD_OVERLOADED_MESSAGE;
      return false;
    }

    const lastError = sanitizeString(String((error && error.message) || error || 'smart_download_failed'), 1024) || 'smart_download_failed';
    this._transitionItem(job, item, 'queued', { last_error: lastError });
    this._queueDeferredSmartDownloadItem(job, item);

    if (switchedProvider) {
      job.run.summary_text = 'Retrying failed downloads with backup no-watermark provider…';
    }
    return true;
  }

  _transitionItem(job, item, nextStatus, overrides) {
    const previousStatus = normalizeItemStatus(item.status);
    const targetStatus = normalizeItemStatus(nextStatus);
    Object.assign(item, overrides || {}, { status: targetStatus });
    job.run.counts = applyBackupStatusTransition(job.run.counts, previousStatus, targetStatus);
    if (targetStatus === 'downloading') {
      job.run.active_item_key = item.item_key;
    }
    if (targetStatus === 'done' || targetStatus === 'failed' || targetStatus === 'skipped') {
      if (job.run.active_item_key === item.item_key) job.run.active_item_key = '';
    }
    if (targetStatus === 'done') {
      this._rememberSavedId(job, item.bucket, item.id);
    }
    if (targetStatus === 'failed' && item.last_error) {
      job.run.last_error = item.last_error;
    }
    job.run.updated_at = Date.now();
    job.dirtyItemWrites += 1;
  }

  async _persistJob(job, forceItems) {
    job.run.updated_at = Date.now();
    await this.store.saveRun(job.run);
    await this._refreshSavedCatalog(job);
    const shouldSaveItems = forceItems === true || job.dirtyItemWrites >= 25;
    if (shouldSaveItems) {
      await this.store.saveItems(job.run.id, job.items);
      job.dirtyItemWrites = 0;
    }
  }

  _emitStatus(job) {
    this.emit('status', {
      run: summarizeBackupRun(job.run),
      bucket_progress: this._buildBucketProgressSnapshot(job.run, job.items, job.run.settings),
    });
  }

  _buildBucketProgressSnapshot(run, items, settings) {
    const historicalCounts = buildBackupHistoricalBucketCounts(this.state.bucketCatalog, settings || this.state.settings);
    return buildBackupBucketProgressSnapshot(run, items, historicalCounts);
  }

  async _refreshBucketCatalog(job) {
    const nextCatalog = recordBackupItemsInBucketCatalog(this.state.bucketCatalog, job.run, job.items);
    const previousSerialized = JSON.stringify(this.state.bucketCatalog || {});
    const nextSerialized = JSON.stringify(nextCatalog);
    if (previousSerialized === nextSerialized) return;
    this.state.bucketCatalog = nextCatalog;
    await this.store.saveState(this.state);
  }

  _buildSavedIdSetsForRun(run) {
    const savedCatalog = normalizeBackupBucketCatalog(this.state.savedCatalog || createEmptyBackupBucketCatalog());
    const characterHandle = normalizeCharacterHandle(run && run.settings && run.settings.character_handle);
    return {
      ownDrafts: new Set(savedCatalog.ownDrafts),
      ownPosts: new Set(savedCatalog.ownPosts),
      castInPosts: new Set(savedCatalog.castInPosts),
      castInDrafts: new Set(savedCatalog.castInDrafts),
      ownPrompts: new Set(savedCatalog.ownPrompts),
      characterPosts: new Set(characterHandle ? (savedCatalog.characterPosts[characterHandle] || []) : []),
    };
  }

  _isAlreadySaved(job, bucketKey, itemId) {
    const key = sanitizeString(bucketKey, 64) || '';
    if (key !== 'castInPosts' && key !== 'castInDrafts' && key !== 'characterPosts') return false;
    return !!(job && job.savedIds && job.savedIds[key] && job.savedIds[key].has(itemId));
  }

  _rememberSavedId(job, bucketKey, itemId) {
    const key = sanitizeString(bucketKey, 64) || '';
    if (!key || !itemId) return;
    if (!job.savedIds) job.savedIds = {};
    if (!job.savedIds[key]) job.savedIds[key] = new Set();
    job.savedIds[key].add(itemId);
  }

  async _refreshSavedCatalog(job) {
    const doneItems = (job.items || []).filter((item) => normalizeItemStatus(item && item.status) === 'done');
    const nextCatalog = recordBackupItemsInBucketCatalog(this.state.savedCatalog, job.run, doneItems);
    const previousSerialized = JSON.stringify(this.state.savedCatalog || {});
    const nextSerialized = JSON.stringify(nextCatalog);
    if (previousSerialized === nextSerialized) return;
    this.state.savedCatalog = nextCatalog;
    await this.store.saveState(this.state);
  }

  _shouldDownloadIncrementalBatch(bucketKey) {
    const key = sanitizeString(bucketKey, 64) || '';
    return key === 'castInPosts' || key === 'castInDrafts' || key === 'characterPosts';
  }

  async _downloadIncrementalBatch(job, bucket) {
    const queuedCount = (job.items || []).filter((item) => item.bucket === bucket.key && normalizeItemStatus(item.status) === 'queued').length;
    if (!queuedCount) return;
    await this.store.saveItems(job.run.id, job.items);
    job.run.status = 'running';
    job.run.summary_text = 'Downloading ' + queuedCount + ' newly found ' + bucket.key + ' videos…';
    job.run.updated_at = Date.now();
    await this.store.saveRun(job.run);
    this._emitStatus(job);
    await this._downloadQueuedItems(job);
    if (job.cancelRequested) return;
    job.run.status = 'discovering';
    job.run.summary_text = 'Continuing ' + bucket.key + ' scan…';
    job.run.updated_at = Date.now();
    await this.store.saveRun(job.run);
    this._emitStatus(job);
  }

  async _hydrateSavedCatalogFromRuns() {
    const runIds = await this.store.listRunIds();
    let nextCatalog = normalizeBackupBucketCatalog(this.state.savedCatalog || createEmptyBackupBucketCatalog());
    const resetCatalog = normalizeCacheResetCatalog(this.state.cacheResetCatalog);
    for (let index = 0; index < runIds.length; index += 1) {
      const runId = runIds[index];
      const run = await this.store.getRun(runId);
      if (!run) continue;
      const items = await this.store.getItems(runId);
      const doneItems = (items || []).filter((item) => {
        if (normalizeItemStatus(item && item.status) !== 'done') return false;
        return this._shouldKeepSavedItemAfterCacheReset(run, item, resetCatalog);
      });
      if (!doneItems.length) continue;
      nextCatalog = recordBackupItemsInBucketCatalog(nextCatalog, run, doneItems);
    }
    this.state.savedCatalog = nextCatalog;
  }

  _buildClearCacheTargets() {
    const modeTargets = CLEARABLE_CACHE_BUCKETS.map((key) => ({
      key: key,
      label: CLEARABLE_CACHE_LABELS[key] || key,
    }));
    const characterTargets = this._collectHistoricalCharacterHandles().map((handle) => ({
      key: handle,
      label: handle && handle.charAt(0) === '@' ? handle : ('@' + handle),
    }));
    return {
      modes: modeTargets,
      characters: characterTargets,
    };
  }

  _collectHistoricalCharacterHandles() {
    const bucketCatalog = normalizeBackupBucketCatalog(this.state.bucketCatalog || createEmptyBackupBucketCatalog());
    const savedCatalog = normalizeBackupBucketCatalog(this.state.savedCatalog || createEmptyBackupBucketCatalog());
    const resetCatalog = normalizeCacheResetCatalog(this.state.cacheResetCatalog);
    const bucketHandles = new Set();
    const savedHandles = new Set();
    const handles = new Set();
    Object.keys(bucketCatalog.characterPosts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      handles.add(normalizedHandle);
      bucketHandles.add(normalizedHandle);
    });
    Object.keys(savedCatalog.characterPosts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      handles.add(normalizedHandle);
      savedHandles.add(normalizedHandle);
    });
    Object.keys(resetCatalog.characterPosts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      if (!bucketHandles.has(normalizedHandle) && !savedHandles.has(normalizedHandle)) return;
      if (!handles.has(normalizedHandle)) handles.add(normalizedHandle);
    });
    return Array.from(handles).sort((left, right) => left.localeCompare(right));
  }

  _getRunTerminalTimestamp(run) {
    return Math.max(
      0,
      Number(run && run.completed_at) || 0,
      Number(run && run.cancelled_at) || 0,
      Number(run && run.updated_at) || 0,
      Number(run && run.started_at) || 0,
      Number(run && run.created_at) || 0
    );
  }

  _getCacheResetTimestampForItem(run, item, resetCatalog) {
    const bucketKey = sanitizeString(String(item && item.bucket || ''), 64) || '';
    if (bucketKey === 'characterPosts') {
      const handle = normalizeCharacterHandle(run && run.settings && run.settings.character_handle);
      return handle ? normalizeCacheResetTimestamp(resetCatalog && resetCatalog.characterPosts && resetCatalog.characterPosts[handle]) : 0;
    }
    if (CLEARABLE_CACHE_BUCKETS.indexOf(bucketKey) >= 0) {
      return normalizeCacheResetTimestamp(resetCatalog && resetCatalog[bucketKey]);
    }
    return 0;
  }

  _shouldKeepSavedItemAfterCacheReset(run, item, resetCatalog) {
    const resetAt = this._getCacheResetTimestampForItem(run, item, resetCatalog);
    if (!resetAt) return true;
    return this._getRunTerminalTimestamp(run) > resetAt;
  }

  _throwIfCancelled(job) {
    if (job.cancelRequested) {
      throw new BackupCancelledError();
    }
  }

  async _failJob(job, error) {
    if (!job || !job.run) return;
    job.run.status = 'failed';
    job.run.completed_at = Date.now();
    job.run.updated_at = Date.now();
    job.run.active_item_key = '';
    job.run.last_error = sanitizeString(String((error && error.message) || error || 'backup_failed'), 1024) || 'backup_failed';
    job.run.summary_text = 'Backup failed.';
    await this._persistJob(job, true);
    await this.store.exportManifest(job.run, job.items, 'manifest');
    await this.store.exportManifest(job.run, job.items, 'failures');
    await this.store.exportManifest(job.run, job.items, 'summary');
    this._emitStatus(job);
    if (this.currentJob === job) this.currentJob = null;
  }
}

module.exports = {
  BackupService,
};
