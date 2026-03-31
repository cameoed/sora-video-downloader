const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { FileStore } = require('./file-store');
const { PlaywrightSession } = require('./playwright-session');
const { downloadToFile, resolveSmartDownloadUrl } = require('./http-download');
const { resolveFfmpegBinary, removeAudiomark, buildIntermediateDownloadPath } = require('./media-processing');
const {
  BACKUP_URL_REFRESH_MAX_AGE_MS,
  BACKUP_DOWNLOAD_FOLDER,
  DEFAULT_BACKUP_SCOPES,
  normalizeBackupScopes,
  normalizeBackupRequestSettings,
  normalizeBackupAudioMode,
  normalizeCharacterHandle,
  normalizeCurrentUser,
  extractOwnerIdentity,
  shouldExcludeAppearanceOwner,
  sameOwnerIdentity,
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
  buildBackupFolderName,
  buildBackupManifestItem,
  buildBackupDetailPath,
  pickPrompt,
  pickPromptSource,
  pickTitle,
  sanitizeString,
  cloneBackupBucketCounts,
} = require('./helpers');

class BackupCancelledError extends Error {
  constructor() {
    super('backup_cancelled');
    this.name = 'BackupCancelledError';
  }
}

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
    if (!settings.profile) settings.profile = 'conservative';
    if (!settings.published_download_mode) settings.published_download_mode = 'smart';
    settings.audio_mode = normalizeBackupAudioMode(settings.audio_mode);
    if (!settings.selectedScope) settings.selectedScope = 'ownPosts';
    if (!settings.character_handle) settings.character_handle = '';
    settings.theme = 'dark';
    this.state.settings = settings;
    this.state.bucketCatalog = normalizeBackupBucketCatalog(this.state.bucketCatalog || createEmptyBackupBucketCatalog());
    this.state.savedCatalog = normalizeBackupBucketCatalog(this.state.savedCatalog || createEmptyBackupBucketCatalog());
    await this._hydrateSavedCatalogFromRuns();
    await this.store.saveState(this.state);
  }

  async getBootstrap() {
    const lastRunId = this.state && this.state.lastRunId;
    const run = this.currentJob
      ? summarizeBackupRun(this.currentJob.run)
      : await this.store.getRun(lastRunId);
    const items = this.currentJob
      ? this.currentJob.items
      : await this.store.getItems(lastRunId);
    return {
      settings: Object.assign({}, this.state.settings),
      session: Object.assign({ authenticated: false, checkedAt: 0, user: null }, this.state.session || {}),
      run: run,
      bucket_progress: this._buildBucketProgressSnapshot(run, items || [], this.state.settings),
    };
  }

  async updateSettings(partial) {
    const nextSettings = Object.assign({}, this.state.settings, partial || {});
    nextSettings.audio_mode = normalizeBackupAudioMode(nextSettings.audio_mode);
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
    if (this.currentJob && !isTerminalRunStatus(this.currentJob.run.status)) {
      await this.cancelBackup().catch(() => {});
      if (this.currentJobPromise) {
        await this.currentJobPromise.catch(() => {});
      }
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
      profile: settings.profile,
      published_download_mode: settings.published_download_mode,
      audio_mode: settings.audio_mode,
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

  async _runBackup(job) {
    try {
      await this._discover(job);
      if (job.cancelRequested) throw new BackupCancelledError();

      await this.store.saveItems(job.run.id, job.items);

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

      let cursor = null;
      let pageNumber = 0;

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
          if (
            (bucket.key === 'castInPosts' || bucket.key === 'castInDrafts') &&
            shouldExcludeAppearanceOwner(owner, job.run.current_user)
          ) {
            continue;
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
        cursor = nextCursor && items.length ? nextCursor : null;
      } while (cursor);
    }
  }

  async _downloadQueuedItems(job) {
    const audioMode = normalizeBackupAudioMode(job && job.run && job.run.settings && job.run.settings.audio_mode);
    const publishedDownloadMode = job && job.run && job.run.settings && job.run.settings.published_download_mode;
    for (let index = 0; index < job.items.length; index += 1) {
      const item = job.items[index];
      if (normalizeItemStatus(item.status) !== 'queued') continue;
      this._throwIfCancelled(job);

      const preparedItem = await this._refreshBackupItemMedia(item);
      if (!preparedItem.media_url) {
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
      const tempDownloadPath =
        audioMode === 'no_audiomark'
          ? buildIntermediateDownloadPath(destinationPath, preparedItem.media_ext)
          : destinationPath;
      try {
        const downloadUrl =
          publishedDownloadMode === 'smart' && preparedItem.kind === 'published'
            ? await resolveSmartDownloadUrl(preparedItem.post_permalink || '', { signal: this._createActiveAbortSignal() })
            : preparedItem.media_url;
        await downloadToFile(downloadUrl, tempDownloadPath, { signal: this._createActiveAbortSignal() });
        if (audioMode === 'no_audiomark') {
          job.run.summary_text = 'Removing audiomark from ' + preparedItem.id + '...';
          await this._persistJob(job, false);
          this._emitStatus(job);
          await this._removeAudiomark(job, tempDownloadPath, destinationPath);
          await this._removeFileIfPresent(tempDownloadPath);
        }
        this._transitionItem(job, preparedItem, 'done', { last_error: '' });
      } catch (error) {
        if (audioMode === 'no_audiomark') {
          await this._removeFileIfPresent(tempDownloadPath);
          await this._removeFileIfPresent(destinationPath);
        }
        this._transitionItem(job, preparedItem, 'failed', {
          last_error: sanitizeString(String((error && error.message) || error || 'download_failed'), 1024) || 'download_failed',
        });
      }

      await this._persistJob(job, false);
      this._emitStatus(job);
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

  async _refreshBackupItemMedia(item) {
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

  async _removeAudiomark(job, inputPath, outputPath) {
    const ffmpegPath = await this._getFfmpegPath(job);
    await removeAudiomark({
      ffmpegPath: ffmpegPath,
      inputPath: inputPath,
      outputPath: outputPath,
      signal: this._createActiveAbortSignal(),
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
    for (let index = 0; index < runIds.length; index += 1) {
      const runId = runIds[index];
      const run = await this.store.getRun(runId);
      if (!run) continue;
      const items = await this.store.getItems(runId);
      const doneItems = (items || []).filter((item) => normalizeItemStatus(item && item.status) === 'done');
      if (!doneItems.length) continue;
      nextCatalog = recordBackupItemsInBucketCatalog(nextCatalog, run, doneItems);
    }
    this.state.savedCatalog = nextCatalog;
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
