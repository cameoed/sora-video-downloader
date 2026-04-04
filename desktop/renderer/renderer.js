(function initializeRenderer() {
  const appApi = window.soraBackupApp;
  const SCOPE_KEYS = ['ownPosts', 'ownDrafts', 'castInPosts', 'castInDrafts', 'characterPosts', 'ownPrompts', 'postStats', 'characterDrafts'];
  const CLEARABLE_MODE_TARGETS = [
    { key: 'ownPosts', label: 'My posts' },
    { key: 'ownDrafts', label: 'My drafts' },
    { key: 'castInPosts', label: 'Cast-in posts' },
    { key: 'castInDrafts', label: 'Drafts of me' },
  ];
  const DEFAULT_PUBLISHED_DOWNLOAD_MODE = 'smart';
  const SMART_DOWNLOAD_OVERLOADED_MESSAGE = "All watermark removers are overloaded right now. Retrying every 3 mins until one comes online!";
  function normalizePublishedDownloadMode(value) {
    return value === 'direct_sora' ? 'direct_sora' : DEFAULT_PUBLISHED_DOWNLOAD_MODE;
  }

  function isSmartDownloadOverloadedMessage(value) {
    return String(value || '').trim().replace(/^\[[^\]]+\]\s*/, '') === SMART_DOWNLOAD_OVERLOADED_MESSAGE;
  }

  const state = {
    platform: String(appApi && appApi.platform || ''),
    settings: {
      downloadDir: '',
      published_download_mode: DEFAULT_PUBLISHED_DOWNLOAD_MODE,
      audio_mode: 'no_audiomark',
      framing_mode: 'sora_default',
      selectedScope: 'ownPosts',
      character_handle: '',
      character_drafts_handle: '',
      character_stats_handle: '',
      has_manual_bearer_token: false,
      has_manual_cookie_header: false,
    },
    session: null,
    sessionPrompt: '',
    run: null,
    bucketProgress: null,
    draftPublishUsage: { date: '', count: 0, limit: 500, remaining: 500 },
    authPollInFlight: false,
    loginFlowPromise: null,
    awaitingLoginCompletion: false,
    lastSessionRefreshAt: 0,
    headerNotice: '',
    cancelPending: false,
    clearCacheTargets: null,
    clearCacheModalOpen: false,
    clearCacheLoading: false,
    clearCacheSubmitting: false,
    macLoginNoteModalOpen: false,
    logoutModalOpen: false,
    logoutSubmitting: false,
    logoutStatus: '',
    manualBearerModalOpen: false,
    manualBearerSubmitting: false,
    manualBearerStatus: '',
    draftCookieModalOpen: false,
    draftCookieSubmitting: false,
    draftCookieStatus: '',
    pendingDraftCookieBackupRequest: null,
    workingDots: '',
    openRunFolderHighlighted: false,
    openRunFolderTrackedRunId: '',
    openRunFolderAcknowledgedDoneCount: 0,
    postStatsScanning: false,
    postStatsPage: 0,
    postStatsProgressCount: 0,
    postStatsData: [],
    characterStatsFetching: false,
  };

  const ui = {
    openLoginBtn: document.getElementById('openLoginBtn'),
    manualBearerBtn: document.getElementById('manualBearerBtn'),
    heroSubtitle: document.getElementById('heroSubtitle'),
    heroDetail: document.getElementById('heroDetail'),
    progressBadge: document.getElementById('progressBadge'),
    progressFill: document.getElementById('progressFill'),
    downloadDir: document.getElementById('downloadDir'),
    chooseDirBtn: document.getElementById('chooseDirBtn'),
    modeSelect: document.getElementById('modeSelect'),
    audioModeSelect: document.getElementById('audioModeSelect'),
    framingModeSelect: document.getElementById('framingModeSelect'),
    characterHandle: document.getElementById('characterHandle'),
    characterScopeName: document.getElementById('characterScopeName'),
    startBackupBtn: document.getElementById('startBackupBtn'),
    cancelBackupBtn: document.getElementById('cancelBackupBtn'),
    openRunFolderBtn: document.getElementById('openRunFolderBtn'),
    clearCacheBtn: document.getElementById('clearCacheBtn'),
    scopeProgressOwnPosts: document.getElementById('scopeProgressOwnPosts'),
    scopeProgressOwnDrafts: document.getElementById('scopeProgressOwnDrafts'),
    scopeProgressCastInPosts: document.getElementById('scopeProgressCastInPosts'),
    scopeProgressCastInDrafts: document.getElementById('scopeProgressCastInDrafts'),
    scopeProgressCharacterPosts: document.getElementById('scopeProgressCharacterPosts'),
    scopeProgressOwnPrompts: document.getElementById('scopeProgressOwnPrompts'),
    clearCacheModal: document.getElementById('clearCacheModal'),
    clearCacheBackdrop: document.getElementById('clearCacheBackdrop'),
    clearCacheLoading: document.getElementById('clearCacheLoading'),
    clearCacheContent: document.getElementById('clearCacheContent'),
    clearCacheModesList: document.getElementById('clearCacheModesList'),
    clearCacheCharactersSection: document.getElementById('clearCacheCharactersSection'),
    clearCacheCharactersList: document.getElementById('clearCacheCharactersList'),
    clearCacheCancelBtn: document.getElementById('clearCacheCancelBtn'),
    clearCacheConfirmBtn: document.getElementById('clearCacheConfirmBtn'),
    macLoginNoteModal: document.getElementById('macLoginNoteModal'),
    macLoginNoteBackdrop: document.getElementById('macLoginNoteBackdrop'),
    macLoginNoteConfirmBtn: document.getElementById('macLoginNoteConfirmBtn'),
    logoutModal: document.getElementById('logoutModal'),
    logoutBackdrop: document.getElementById('logoutBackdrop'),
    logoutStatus: document.getElementById('logoutStatus'),
    logoutCancelBtn: document.getElementById('logoutCancelBtn'),
    logoutConfirmBtn: document.getElementById('logoutConfirmBtn'),
    manualBearerModal: document.getElementById('manualBearerModal'),
    manualBearerBackdrop: document.getElementById('manualBearerBackdrop'),
    manualBearerInput: document.getElementById('manualBearerInput'),
    manualBearerStatus: document.getElementById('manualBearerStatus'),
    manualBearerCancelBtn: document.getElementById('manualBearerCancelBtn'),
    manualBearerConfirmBtn: document.getElementById('manualBearerConfirmBtn'),
    draftCookieModal: document.getElementById('draftCookieModal'),
    draftCookieBackdrop: document.getElementById('draftCookieBackdrop'),
    draftCookieTitle: document.getElementById('draftCookieTitle'),
    draftCookieHelp: document.getElementById('draftCookieHelp'),
    draftCookieInput: document.getElementById('draftCookieInput'),
    draftBearerField: document.getElementById('draftBearerField'),
    draftBearerInput: document.getElementById('draftBearerInput'),
    draftCookieStatus: document.getElementById('draftCookieStatus'),
    draftCookieCancelBtn: document.getElementById('draftCookieCancelBtn'),
    draftCookieConfirmBtn: document.getElementById('draftCookieConfirmBtn'),
    scopeProgressPostStats: document.getElementById('scopeProgressPostStats'),
    scopeProgressCharacterDrafts: document.getElementById('scopeProgressCharacterDrafts'),
    characterDraftsHandle: document.getElementById('characterDraftsHandle'),
    scopeProgressCharacterStats: document.getElementById('scopeProgressCharacterStats'),
    characterStatsHandle: document.getElementById('characterStatsHandle'),
    postStatsSection: document.getElementById('postStatsSection'),
    postStatsTable: document.getElementById('postStatsTable'),
    postStatsBody: document.getElementById('postStatsBody'),
    postStatsCount: document.getElementById('postStatsCount'),
    postStatsExportBtn: document.getElementById('postStatsExportBtn'),
  };
  let resizeFrame = 0;
  let lastSentHeight = 0;
  let workingDotsTimer = 0;

  function setText(element, value) {
    if (!element) return;
    element.textContent = value;
  }

  function formatCount(value) {
    return new Intl.NumberFormat().format(Math.max(0, Number(value) || 0));
  }

  function getRunId(run) {
    return run && run.id ? String(run.id) : '';
  }

  function getCompletedDownloadCount(run) {
    return Math.max(0, Number(run && run.counts && run.counts.done) || 0);
  }

  function syncOpenRunFolderAttention(run, options) {
    const initialize = !!(options && options.initialize);
    const runId = getRunId(run);
    if (!runId) {
      state.openRunFolderHighlighted = false;
      state.openRunFolderTrackedRunId = '';
      state.openRunFolderAcknowledgedDoneCount = 0;
      return;
    }

    const completedDownloadCount = getCompletedDownloadCount(run);
    if (state.openRunFolderTrackedRunId !== runId) {
      state.openRunFolderTrackedRunId = runId;
      state.openRunFolderHighlighted = false;
      state.openRunFolderAcknowledgedDoneCount = initialize ? completedDownloadCount : 0;
      if (!initialize && run.status === 'completed') {
        state.openRunFolderHighlighted = true;
      }
      return;
    }

    if (!initialize && run.status === 'completed' && !state.openRunFolderHighlighted) {
      state.openRunFolderHighlighted = true;
    }
  }

  function setRun(nextRun, options) {
    state.run = nextRun || null;
    syncOpenRunFolderAttention(state.run, options);
  }

  function acknowledgeOpenRunFolderAttention() {
    state.openRunFolderHighlighted = false;
    state.openRunFolderTrackedRunId = getRunId(state.run);
    state.openRunFolderAcknowledgedDoneCount = getCompletedDownloadCount(state.run);
  }

  function renderOpenRunFolderButton() {
    if (!ui.openRunFolderBtn) return;
    if (state.openRunFolderHighlighted) {
      ui.openRunFolderBtn.dataset.tone = 'attention';
      return;
    }
    delete ui.openRunFolderBtn.dataset.tone;
  }

  function normalizeDraftPublishUsage(value) {
    const source = value && typeof value === 'object' ? value : {};
    const count = Math.max(0, Number(source.count) || 0);
    const limit = Math.max(count, Number(source.limit) || 500);
    return {
      date: String(source.date || ''),
      count: count,
      limit: limit,
      remaining: Math.max(0, Number(source.remaining != null ? source.remaining : (limit - count)) || 0),
    };
  }

  function isDraftScope(scopeKey) {
    return scopeKey === 'ownDrafts' || scopeKey === 'castInDrafts' || scopeKey === 'characterDrafts';
  }

  function getDraftPublishResetTimestamp(usage) {
    const value = usage && usage.date ? String(usage.date) : '';
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let year;
    let monthIndex;
    let day;
    if (match) {
      year = Number(match[1]);
      monthIndex = Number(match[2]) - 1;
      day = Number(match[3]);
    } else {
      const now = new Date();
      year = now.getFullYear();
      monthIndex = now.getMonth();
      day = now.getDate();
    }
    return new Date(year, monthIndex, day + 1, 0, 0, 0, 0);
  }

  function formatDraftPublishResetTimestamp(usage) {
    const timestamp = getDraftPublishResetTimestamp(usage);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(timestamp);
  }

  function isDraftWatermarkFreeBlocked() {
    const usage = normalizeDraftPublishUsage(state.draftPublishUsage);
    return isDraftScope(getSelectedScope()) &&
      normalizePublishedDownloadMode(state.settings.published_download_mode) === 'smart' &&
      usage.count >= usage.limit;
  }

  function getDraftWatermarkFreeBlockedNotice() {
    if (!isDraftWatermarkFreeBlocked()) return '';
    return 'Come back tomorrow at ' + formatDraftPublishResetTimestamp(state.draftPublishUsage) + ' to keep downloading drafts watermark-free! Sora only allows 500 per day.';
  }

  function formatClearCacheError(error) {
    const normalized = String(error || '').trim();
    if (normalized === 'backup_run_in_progress') {
      return 'Finish or stop the current backup before clearing cache.';
    }
    if (normalized === 'backup_cache_clear_empty_selection') {
      return 'Select at least one cache to clear.';
    }
    return normalized || 'Could not clear the selected cache.';
  }

  function formatManualBearerError(error) {
    const normalized = String(error || '').trim();
    if (normalized === 'backup_manual_bearer_missing') return 'Paste a bearer token to connect.';
    if (normalized === 'backup_manual_bearer_invalid') return 'Could not connect with that bearer token.';
    return normalized || 'Could not connect with that bearer token.';
  }

  function formatDraftCookieError(error) {
    const normalized = String(error || '').trim();
    if (normalized === 'backup_draft_manual_auth_required') {
      return draftCookieModalNeedsBearer()
        ? 'Paste both the Cookie header and matching Bearer Authorization to continue.'
        : 'Paste a Cookie header to continue.';
    }
    return normalized || 'Could not save that draft auth.';
  }

  function draftCookieModalNeedsBearer() {
    return !state.settings.has_manual_bearer_token;
  }

  function getClearCacheTargets() {
    const targets = state.clearCacheTargets || {};
    const modes = Array.isArray(targets.modes) && targets.modes.length
      ? targets.modes
      : CLEARABLE_MODE_TARGETS;
    const characters = Array.isArray(targets.characters) ? targets.characters : [];
    return { modes, characters };
  }

  function getSelectedClearCachePayload() {
    const payload = { modes: [], characters: [] };
    if (!ui.clearCacheModal) return payload;
    ui.clearCacheModal.querySelectorAll('input[data-clear-cache-type]:checked').forEach((input) => {
      const type = String(input.getAttribute('data-clear-cache-type') || '');
      const value = String(input.value || '').trim();
      if (!value) return;
      if (type === 'mode') payload.modes.push(value);
      if (type === 'character') payload.characters.push(value);
    });
    return payload;
  }

  function hasSelectedClearCachePayload() {
    const payload = getSelectedClearCachePayload();
    return payload.modes.length > 0 || payload.characters.length > 0;
  }

  function createClearCacheOption(type, value, label) {
    const row = document.createElement('label');
    row.className = 'cache-option';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    input.setAttribute('data-clear-cache-type', type);

    const text = document.createElement('span');
    text.className = 'cache-option-text';
    text.textContent = label;

    row.appendChild(input);
    row.appendChild(text);
    return row;
  }

  function getSelectedScope() {
    const selected = document.querySelector('input[name="scope"]:checked');
    return selected ? selected.value : 'ownPosts';
  }

  function setSelectedScope(scope) {
    const target = document.querySelector('input[name="scope"][value="' + scope + '"]');
    if (target) target.checked = true;
  }

  function isPostStatsScope() {
    return getSelectedScope() === 'postStats';
  }

  function buildScopes() {
    const selected = getSelectedScope();
    return {
      ownPosts: selected === 'ownPosts',
      ownDrafts: selected === 'ownDrafts',
      castInPosts: selected === 'castInPosts',
      castInDrafts: selected === 'castInDrafts',
      characterPosts: selected === 'characterPosts',
      ownPrompts: selected === 'ownPrompts',
      characterDrafts: selected === 'characterDrafts',
    };
  }

  function formatCharacterHandleLabel(value) {
    const handle = String(value || '').trim();
    if (!handle) return '';
    return handle.charAt(0) === '@' ? handle : ('@' + handle);
  }

  function getCharacterLabel() {
    const handle = formatCharacterHandleLabel(state.settings.character_handle);
    return handle || 'Select a character';
  }

  function getRunScopeLabel(run) {
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPosts) return 'my posts';
    if (scopes.ownDrafts) return 'my drafts';
    if (scopes.castInPosts) return 'cast-in posts';
    if (scopes.castInDrafts) return 'drafts of me';
    if (scopes.ownPrompts) return 'my prompts';
    if (scopes.characterPosts) {
      const handle = formatCharacterHandleLabel(run && run.settings && run.settings.character_handle);
      return handle ? handle + ' posts' : 'character posts';
    }
    if (scopes.characterDrafts) {
      const handle = formatCharacterHandleLabel(run && run.settings && run.settings.character_drafts_handle);
      return handle ? handle + ' drafts' : 'character drafts';
    }
    return 'videos';
  }

  function getRunCountLabel(run, totalLabel) {
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPosts) return 'my ' + totalLabel + ' posts';
    if (scopes.ownDrafts) return 'my ' + totalLabel + ' drafts';
    if (scopes.castInPosts) return totalLabel + ' cast-in posts';
    if (scopes.castInDrafts) return totalLabel + ' drafts of me';
    if (scopes.ownPrompts) return totalLabel + ' prompts';
    if (scopes.characterPosts) {
      const handle = formatCharacterHandleLabel(run && run.settings && run.settings.character_handle);
      return handle ? totalLabel + ' posts from ' + handle : totalLabel + ' character posts';
    }
    if (scopes.characterDrafts) {
      const handle = formatCharacterHandleLabel(run && run.settings && run.settings.character_drafts_handle);
      return handle ? totalLabel + ' drafts from ' + handle : totalLabel + ' character drafts';
    }
    return totalLabel + ' videos';
  }

  function getScopeCountLabel(scopeKey, totalLabel, settings) {
    if (scopeKey === 'ownPosts') return 'my ' + totalLabel + ' posts';
    if (scopeKey === 'ownDrafts') return 'my ' + totalLabel + ' drafts';
    if (scopeKey === 'castInPosts') return totalLabel + ' cast-in posts';
    if (scopeKey === 'castInDrafts') return totalLabel + ' drafts of me';
    if (scopeKey === 'ownPrompts') return totalLabel + ' prompts';
    if (scopeKey === 'characterPosts') {
      const handle = formatCharacterHandleLabel(settings && settings.character_handle);
      return handle ? totalLabel + ' posts from ' + handle : totalLabel + ' character posts';
    }
    if (scopeKey === 'characterDrafts') {
      const handle = formatCharacterHandleLabel(settings && settings.character_drafts_handle);
      return handle ? totalLabel + ' drafts from ' + handle : totalLabel + ' character drafts';
    }
    return totalLabel + ' videos';
  }

  function getSelectedScopeProcessedLabel() {
    const progress = state.bucketProgress && state.bucketProgress.buckets ? state.bucketProgress.buckets : {};
    const scopeKey = getSelectedScope();
    const entry = progress[scopeKey] || {};
    const totalLabel = formatCount(entry.total);
    const completedLabel = formatCount(entry.completed);
    return completedLabel + ' of ' + getScopeCountLabel(scopeKey, totalLabel, state.settings) + ' processed';
  }

  function getNoResultsLabel(scopeKey, settings) {
    if (scopeKey === 'postStats') return 'No posts found';
    if (scopeKey === 'ownPosts') return 'No posts found';
    if (scopeKey === 'ownDrafts') return 'No drafts found';
    if (scopeKey === 'castInPosts') return 'No cast-in posts found';
    if (scopeKey === 'castInDrafts') return 'No drafts of me found';
    if (scopeKey === 'ownPrompts') return 'No prompts found';
    if (scopeKey === 'characterPosts') {
      const handle = formatCharacterHandleLabel(settings && settings.character_handle);
      return handle ? 'No posts from ' + handle + ' found' : 'No character posts found';
    }
    if (scopeKey === 'characterDrafts') {
      const handle = formatCharacterHandleLabel(settings && settings.character_drafts_handle);
      return handle ? 'You either typed the wrong character or you don\'t have the rights to this character.' : 'No character drafts found';
    }
    return 'No videos found';
  }

  function getRunDiscoveryLabel(run) {
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPosts) return 'Scanning posts';
    if (scopes.ownDrafts) return 'Scanning drafts';
    if (scopes.castInPosts) return 'Scanning cast-in posts';
    if (scopes.castInDrafts) return 'Scanning drafts of me';
    if (scopes.ownPrompts) return 'Scanning prompts';
    if (scopes.characterPosts) {
      const handle = formatCharacterHandleLabel(run && run.settings && run.settings.character_handle);
      return handle ? 'Scanning ' + handle : 'Scanning character posts';
    }
    if (scopes.characterDrafts) {
      const handle = formatCharacterHandleLabel(run && run.settings && run.settings.character_drafts_handle);
      return handle ? 'Scanning ' + handle + ' drafts' : 'Scanning character drafts';
    }
    return 'Scanning videos';
  }

  function getCompletedRunLabel(run) {
    const summaryText = String(run && run.summary_text || '').trim();
    if (/^Stopped at the draft copy-link daily limit\./i.test(summaryText)) return summaryText;
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPrompts) return 'Prompt export complete!';
    return 'Download complete!';
  }

  function getRunBucketKey(run) {
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPosts) return 'ownPosts';
    if (scopes.ownDrafts) return 'ownDrafts';
    if (scopes.castInPosts) return 'castInPosts';
    if (scopes.castInDrafts) return 'castInDrafts';
    if (scopes.characterPosts) return 'characterPosts';
    if (scopes.ownPrompts) return 'ownPrompts';
    if (scopes.characterDrafts) return 'characterDrafts';
    return '';
  }

  function renderHeroDetail(text) {
    if (!ui.heroDetail) return;
    const value = String(text || '').trim();
    ui.heroDetail.hidden = !value;
    setText(ui.heroDetail, value);
  }

  function getProgressMetrics() {
    const run = state.run;
    if (!run || !run.counts) return { total: 0, complete: 0, percent: 0 };
    const counts = run.counts;
    const total = Math.max(
      0,
      Number(counts.queued) || 0,
      0
    ) + Math.max(0, Number(counts.downloading) || 0) + Math.max(0, Number(counts.done) || 0) + Math.max(0, Number(counts.failed) || 0) + Math.max(0, Number(counts.skipped) || 0);
    const fallbackTotal = Math.max(0, Number(counts.discovered) || 0);
    const stableTotal = total || fallbackTotal;
    const complete = Math.max(0, Number(counts.done) || 0) + Math.max(0, Number(counts.failed) || 0) + Math.max(0, Number(counts.skipped) || 0);
    const percent = stableTotal > 0 ? Math.min(100, Math.round((complete / stableTotal) * 100)) : 0;
    return { total: stableTotal, complete: Math.min(complete, stableTotal), percent };
  }

  function isRunProcessing(run) {
    return !!(run && (run.status === 'discovering' || run.status === 'running' || run.status === 'queued' || run.status === 'paused'));
  }

  function shouldHideDiscoveryPagination(run) {
    const scopes = run && run.scopes ? run.scopes : {};
    return scopes.ownPrompts === true;
  }

  function getDiscoveryPageNumber(run) {
    if (shouldHideDiscoveryPagination(run)) return '';
    const summaryText = String(run && run.summary_text || '');
    const pageMatch = run && run.status === 'discovering' ? summaryText.match(/\bpage\s+(\d+)\b/i) : null;
    return pageMatch ? String(pageMatch[1]) : '';
  }

  function updateWorkingDotsTimer() {
    const run = state.run;
    const runActive = !!(run && (run.status === 'discovering' || run.status === 'running'));
    if (!runActive) {
      state.workingDots = '';
      if (workingDotsTimer) {
        window.clearInterval(workingDotsTimer);
        workingDotsTimer = 0;
      }
      return;
    }
    if (workingDotsTimer) return;
    workingDotsTimer = window.setInterval(() => {
      const nextLength = ((state.workingDots || '').length + 1) % 4;
      state.workingDots = '.'.repeat(nextLength);
      renderHeader();
    }, 1000);
  }

  function renderSession() {
    const button = ui.openLoginBtn;
    const lockButton = ui.manualBearerBtn;
    const session = state.session;
    const authenticated = !!(session && session.authenticated);
    const checking = state.authPollInFlight;
    button.disabled = false;
    if (checking) {
      button.dataset.tone = 'working';
      if (lockButton) lockButton.dataset.tone = 'working';
      setText(button, 'Checking…');
      return;
    }
    if (authenticated) {
      button.dataset.tone = 'ok';
      if (lockButton) lockButton.dataset.tone = 'ok';
      setText(button, 'Connected');
      return;
    }
    if (session && session.error) {
      button.dataset.tone = 'error';
      if (lockButton) lockButton.dataset.tone = 'error';
      setText(button, 'Open Sora');
      return;
    }
    button.dataset.tone = 'warn';
    if (lockButton) lockButton.dataset.tone = 'warn';
    setText(button, 'Open Sora');
  }

  function renderHeader() {
    const run = state.run;
    const metrics = getProgressMetrics();
    const authenticated = !!(state.session && state.session.authenticated);
    const runActive = isRunProcessing(run);
    const draftLimitNotice = getDraftWatermarkFreeBlockedNotice();
    const overloadNotice = run && (
      isSmartDownloadOverloadedMessage(run.summary_text) ||
      isSmartDownloadOverloadedMessage(run.last_error)
    )
      ? String(run.summary_text || run.last_error || '')
      : '';
    if (!run) {
      renderHeroDetail('');
      const postStatsLabel = state.postStatsScanning
        ? 'Scanning post stats · page ' + (state.postStatsPage || 1) + ' · ' + formatCount(state.postStatsProgressCount) + ' posts found...'
        : '';
      setText(
        ui.heroSubtitle,
        state.headerNotice || draftLimitNotice || postStatsLabel || state.sessionPrompt || (authenticated
          ? 'Ready to go!'
          : state.authPollInFlight
          ? 'Checking Sora session…'
          : 'Sign in to get started')
      );
      setText(ui.progressBadge, '0% complete');
      ui.progressFill.style.width = '0%';
      ui.openRunFolderBtn.disabled = false;
      renderOpenRunFolderButton();
      return;
    }

    if (!runActive && !state.authPollInFlight && !authenticated) {
      renderHeroDetail('');
      setText(ui.heroSubtitle, state.headerNotice || draftLimitNotice || overloadNotice || state.sessionPrompt || 'Sign in to get started');
      setText(ui.progressBadge, '0% complete');
      ui.progressFill.style.width = '0%';
      ui.openRunFolderBtn.disabled = false;
      renderOpenRunFolderButton();
      return;
    }

    const totalLabel = formatCount(metrics.total);
    const completeLabel = formatCount(metrics.complete);
    const actionLabel = run.status === 'discovering' ? getRunDiscoveryLabel(run) : 'Processing videos';
    const stoppedLabel = getSelectedScopeProcessedLabel();
    const noResultsLabel = run.status === 'completed' && metrics.total === 0
      ? getNoResultsLabel(getSelectedScope(), state.settings)
      : '';
    const completedRunLabel = run.status === 'completed' && metrics.total > 0
      ? getCompletedRunLabel(run)
      : '';
    renderHeroDetail('');
    setText(
      ui.heroSubtitle,
      state.headerNotice || draftLimitNotice || overloadNotice || noResultsLabel || completedRunLabel || (run.status === 'cancelled' ? stoppedLabel : (actionLabel + ' · ' + completeLabel + ' of ' + totalLabel))
    );
    const pageNumber = getDiscoveryPageNumber(run);
    setText(ui.progressBadge, pageNumber ? (metrics.percent + '% of page ' + pageNumber + ' complete') : (metrics.percent + '% complete'));
    ui.progressFill.style.width = metrics.percent + '%';
    ui.openRunFolderBtn.disabled = false;
    renderOpenRunFolderButton();
  }

  function renderScopeProgress() {
    const progress = state.bucketProgress && state.bucketProgress.buckets ? state.bucketProgress.buckets : {};
    const rowProgressMap = {
      ownPosts: ui.scopeProgressOwnPosts,
      ownDrafts: ui.scopeProgressOwnDrafts,
      castInPosts: ui.scopeProgressCastInPosts,
      castInDrafts: ui.scopeProgressCastInDrafts,
      characterPosts: ui.scopeProgressCharacterPosts,
      ownPrompts: ui.scopeProgressOwnPrompts,
      postStats: ui.scopeProgressPostStats,
      characterDrafts: ui.scopeProgressCharacterDrafts,
    };
    SCOPE_KEYS.forEach((key) => {
      if (key === 'postStats') {
        setText(rowProgressMap[key], state.postStatsData.length ? formatCount(state.postStatsData.length) : '?');
        return;
      }
      const entry = progress[key] || {};
      const hasScanData = entry.has_scan_data === true;
      const total = Math.max(0, Number(entry.total) || 0);
      const completed = Math.max(0, Number(entry.completed) || 0);
      setText(rowProgressMap[key], hasScanData ? formatCount(completed) + '/' + formatCount(total) : '?');
    });
    setText(ui.characterScopeName, getCharacterLabel());
  }

  function renderControls() {
    const authenticated = !!(state.session && state.session.authenticated);
    const runActive = isRunProcessing(state.run);
    const selectedScope = getSelectedScope();
    const needsCharacter = selectedScope === 'characterPosts';
    const needsCharacterDrafts = selectedScope === 'characterDrafts';
    const needsCharacterStats = selectedScope === 'characterStats';
    const promptExport = selectedScope === 'ownPrompts';
    const postStats = selectedScope === 'postStats';
    const hasCharacter = String(ui.characterHandle.value || '').trim().length > 0;
    const hasCharacterDrafts = String(ui.characterDraftsHandle.value || '').trim().length > 0;
    const hasCharacterStats = String(ui.characterStatsHandle.value || '').trim().length > 0;
    const draftFlowBlocked = isDraftWatermarkFreeBlocked();
    const specialScope = postStats || needsCharacterStats;
    ui.startBackupBtn.disabled = (postStats ? state.postStatsScanning : needsCharacterStats ? state.characterStatsFetching : runActive) || draftFlowBlocked || (needsCharacter && !hasCharacter) || (needsCharacterDrafts && !hasCharacterDrafts) || (needsCharacterStats && !hasCharacterStats);
    if (draftFlowBlocked) {
      ui.startBackupBtn.textContent = 'Come back tomorrow';
    } else if (postStats) {
      ui.startBackupBtn.textContent = authenticated ? (state.postStatsScanning ? 'Scanning...' : 'scan post stats') : 'Sign in to start';
    } else if (needsCharacterStats) {
      ui.startBackupBtn.textContent = authenticated ? (state.characterStatsFetching ? 'Fetching...' : 'Get character stats') : 'Sign in to start';
    } else {
      ui.startBackupBtn.textContent = authenticated ? (promptExport ? 'Save prompts' : 'Start backup') : 'Sign in to start';
    }
    ui.cancelBackupBtn.disabled = specialScope ? true : (!runActive || state.cancelPending);
    ui.cancelBackupBtn.dataset.tone = runActive && !specialScope ? 'active' : 'idle';
    ui.cancelBackupBtn.textContent = state.cancelPending ? 'Stopping...' : (runActive && !specialScope ? 'Stop' : 'Stopped');
    ui.clearCacheBtn.disabled = runActive || state.clearCacheLoading || state.clearCacheSubmitting;
    renderPostStatsSection();
  }

  function renderClearCacheModal() {
    if (!ui.clearCacheModal) return;
    ui.clearCacheModal.hidden = !state.clearCacheModalOpen;
    if (!state.clearCacheModalOpen) return;

    ui.clearCacheLoading.hidden = !state.clearCacheLoading;
    ui.clearCacheContent.hidden = state.clearCacheLoading;
    ui.clearCacheCancelBtn.disabled = state.clearCacheSubmitting;
    ui.clearCacheConfirmBtn.disabled = state.clearCacheLoading || state.clearCacheSubmitting || !hasSelectedClearCachePayload();
    ui.clearCacheConfirmBtn.textContent = state.clearCacheSubmitting ? 'Clearing…' : 'Clear selected cache';

    if (state.clearCacheLoading) return;

    const targets = getClearCacheTargets();
    ui.clearCacheModesList.replaceChildren();
    for (let index = 0; index < targets.modes.length; index += 1) {
      const target = targets.modes[index];
      ui.clearCacheModesList.appendChild(createClearCacheOption('mode', target.key, target.label));
    }

    ui.clearCacheCharactersList.replaceChildren();
    ui.clearCacheCharactersSection.hidden = targets.characters.length === 0;
    for (let index = 0; index < targets.characters.length; index += 1) {
      const target = targets.characters[index];
      ui.clearCacheCharactersList.appendChild(createClearCacheOption('character', target.key, target.label));
    }

    ui.clearCacheConfirmBtn.disabled = state.clearCacheSubmitting || !hasSelectedClearCachePayload();
  }

  function renderManualBearerModal() {
    if (!ui.manualBearerModal) return;
    ui.manualBearerModal.hidden = !state.manualBearerModalOpen;
    if (!state.manualBearerModalOpen) return;
    ui.manualBearerInput.disabled = state.manualBearerSubmitting;
    ui.manualBearerCancelBtn.disabled = state.manualBearerSubmitting;
    ui.manualBearerConfirmBtn.disabled = state.manualBearerSubmitting || !String(ui.manualBearerInput.value || '').trim();
    ui.manualBearerConfirmBtn.textContent = state.manualBearerSubmitting ? 'Connecting…' : 'Connect';
    ui.manualBearerStatus.hidden = !state.manualBearerStatus;
    setText(ui.manualBearerStatus, state.manualBearerStatus);
  }

  function renderDraftCookieModal() {
    if (!ui.draftCookieModal) return;
    ui.draftCookieModal.hidden = !state.draftCookieModalOpen;
    if (!state.draftCookieModalOpen) return;
    const needsBearer = draftCookieModalNeedsBearer();
    setText(ui.draftCookieTitle, needsBearer ? 'Cookie + bearer needed!' : 'Cookie needed!');
    setText(
      ui.draftCookieHelp,
      needsBearer
        ? 'In order to save your drafts watermark free, you need to visit Sora in your browser and copy both the raw Cookie header and the matching Bearer Authorization from the same network request, pasting them below.'
        : 'In order to save your drafts watermark free, you need to visit Sora in your browser and copy the raw Cookie header from the same browser session. Your saved bearer token will be reused for this run.'
    );
    if (ui.draftBearerField) ui.draftBearerField.hidden = !needsBearer;
    ui.draftCookieInput.disabled = state.draftCookieSubmitting;
    ui.draftBearerInput.disabled = state.draftCookieSubmitting;
    ui.draftCookieCancelBtn.disabled = state.draftCookieSubmitting;
    ui.draftCookieConfirmBtn.disabled =
      state.draftCookieSubmitting ||
      !String(ui.draftCookieInput.value || '').trim() ||
      (needsBearer && !String(ui.draftBearerInput.value || '').trim());
    ui.draftCookieConfirmBtn.textContent = state.draftCookieSubmitting ? 'Starting…' : 'Continue';
    ui.draftCookieStatus.hidden = !state.draftCookieStatus;
    setText(ui.draftCookieStatus, state.draftCookieStatus);
  }

  function renderMacLoginNoteModal() {
    if (!ui.macLoginNoteModal) return;
    ui.macLoginNoteModal.hidden = !state.macLoginNoteModalOpen;
  }

  function renderLogoutModal() {
    if (!ui.logoutModal) return;
    ui.logoutModal.hidden = !state.logoutModalOpen;
    if (!state.logoutModalOpen) return;
    ui.logoutCancelBtn.disabled = state.logoutSubmitting;
    ui.logoutConfirmBtn.disabled = state.logoutSubmitting;
    ui.logoutCancelBtn.textContent = 'No';
    ui.logoutConfirmBtn.textContent = state.logoutSubmitting ? 'Logging out…' : 'Yes';
    ui.logoutStatus.hidden = !state.logoutStatus;
    setText(ui.logoutStatus, state.logoutStatus);
  }

  function closeClearCacheModal() {
    if (state.clearCacheSubmitting) return;
    state.clearCacheModalOpen = false;
    state.clearCacheLoading = false;
    renderClearCacheModal();
    queueWindowResize();
  }

  function closeManualBearerModal() {
    if (state.manualBearerSubmitting) return;
    state.manualBearerModalOpen = false;
    state.manualBearerStatus = '';
    renderManualBearerModal();
    queueWindowResize();
  }

  function closeDraftCookieModal() {
    if (state.draftCookieSubmitting) return;
    state.draftCookieModalOpen = false;
    state.draftCookieStatus = '';
    state.pendingDraftCookieBackupRequest = null;
    renderDraftCookieModal();
    queueWindowResize();
  }

  async function openDraftCookieModal(pendingRequest) {
    state.pendingDraftCookieBackupRequest = pendingRequest || null;
    state.draftCookieModalOpen = true;
    state.draftCookieStatus = '';
    if (ui.draftCookieInput) ui.draftCookieInput.value = '';
    if (ui.draftBearerInput) ui.draftBearerInput.value = '';
    renderDraftCookieModal();
    queueWindowResize();
    window.requestAnimationFrame(() => {
      if (!ui.draftCookieInput) return;
      ui.draftCookieInput.focus();
      ui.draftCookieInput.select();
    });
  }

  function closeMacLoginNoteModal() {
    state.macLoginNoteModalOpen = false;
    renderMacLoginNoteModal();
    queueWindowResize();
  }

  function closeLogoutModal() {
    if (state.logoutSubmitting) return;
    state.logoutModalOpen = false;
    state.logoutStatus = '';
    renderLogoutModal();
    queueWindowResize();
  }

  function renderSettings() {
    ui.downloadDir.value = state.settings.downloadDir || '';
    ui.modeSelect.value = normalizePublishedDownloadMode(state.settings.published_download_mode);
    ui.audioModeSelect.value = state.settings.audio_mode || 'no_audiomark';
    ui.framingModeSelect.value = state.settings.framing_mode || 'sora_default';
    ui.characterHandle.value = state.settings.character_handle || '';
    ui.characterDraftsHandle.value = state.settings.character_drafts_handle || '';
    ui.characterStatsHandle.value = state.settings.character_stats_handle || '';
    updateSuffix(ui.characterHandle);
    updateSuffix(ui.characterDraftsHandle);
    updateSuffix(ui.characterStatsHandle);
    setSelectedScope(state.settings.selectedScope || 'ownPosts');
    renderScopeProgress();
    renderControls();
  }

  function formatPostTimestamp(epoch) {
    if (!epoch) return '';
    return new Date(epoch * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }

  function renderPostStatsSection() {
    if (!ui.postStatsSection) return;
    const show = isPostStatsScope() && state.postStatsData.length > 0;
    ui.postStatsSection.hidden = !show;
    if (!show) return;
    setText(ui.postStatsCount, state.postStatsData.length + ' posts');
    ui.postStatsExportBtn.disabled = state.postStatsData.length === 0;
  }

  function renderPostStatsTable() {
    if (!ui.postStatsBody) return;
    ui.postStatsBody.replaceChildren();
    for (let i = 0; i < state.postStatsData.length; i += 1) {
      const p = state.postStatsData[i];
      const tr = document.createElement('tr');
      const cells = [
        p.post_id,
        formatPostTimestamp(p.timestamp),
        { value: p.caption, className: 'caption-cell' },
        { value: p.permalink, link: true },
        formatCount(p.view_count),
        formatCount(p.unique_view_count),
        formatCount(p.like_count),
        formatCount(p.reply_count),
        formatCount(p.recursive_reply_count),
        formatCount(p.share_count),
        formatCount(p.repost_count),
        formatCount(p.remix_count),
        p.duration_s || '',
        p.width || '',
        p.height || '',
        { value: p.thumbnail_url, link: true, linkText: p.thumbnail_url ? 'View' : '' },
      ];
      for (let j = 0; j < cells.length; j += 1) {
        const td = document.createElement('td');
        const cell = cells[j];
        if (cell && typeof cell === 'object') {
          if (cell.className) td.className = cell.className;
          if (cell.link && cell.value) {
            const a = document.createElement('a');
            a.href = cell.value;
            a.target = '_blank';
            a.rel = 'noreferrer noopener';
            a.textContent = cell.linkText != null ? cell.linkText : cell.value;
            td.appendChild(a);
          } else {
            td.textContent = cell.value || '';
          }
        } else {
          td.textContent = cell != null ? String(cell) : '';
        }
        tr.appendChild(td);
      }
      ui.postStatsBody.appendChild(tr);
    }
    renderPostStatsSection();
    queueWindowResize();
  }

  function exportPostStatsCsv() {
    if (!state.postStatsData.length) return;
    const headers = ['Post ID', 'Post Date', 'Caption', 'Post URL', 'Total Views', 'Unique Views', 'Likes', 'Replies', 'Total Replies', 'Shares', 'Reposts', 'Remixes', 'Video Duration (s)', 'Video Width', 'Video Height', 'Thumbnail URL'];
    const rows = [headers.join(',')];
    for (let i = 0; i < state.postStatsData.length; i += 1) {
      const p = state.postStatsData[i];
      const row = [
        p.post_id,
        formatPostTimestamp(p.timestamp),
        '"' + String(p.caption || '').replace(/"/g, '""') + '"',
        p.permalink,
        p.view_count,
        p.unique_view_count,
        p.like_count,
        p.reply_count,
        p.recursive_reply_count,
        p.share_count,
        p.repost_count,
        p.remix_count,
        p.duration_s,
        p.width,
        p.height,
        p.thumbnail_url,
      ];
      rows.push(row.join(','));
    }
    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sora_post_stats_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleScanPostStats() {
    if (state.postStatsScanning) return;
    if (!(state.session && state.session.authenticated)) {
      state.sessionPrompt = 'Sign in to Sora before scanning post stats.';
      state.headerNotice = '';
      renderHeader();
      renderControls();
      startLoginFlow('backup').catch(() => {});
      return;
    }
    state.postStatsScanning = true;
    state.postStatsData = [];
    state.postStatsPage = 0;
    state.headerNotice = '';
    renderAll();
    renderPostStatsTable();
    try {
      const response = await appApi.scanPostStats();
      if (!response || !response.ok) {
        state.headerNotice = response && response.error ? response.error : 'Post stats scan failed.';
        state.postStatsScanning = false;
        renderAll();
        return;
      }
      state.postStatsData = response.posts || [];
      state.postStatsScanning = false;
      const savedFilename = response.savedPath ? response.savedPath.split(/[\\/]/).pop() : null;
      state.headerNotice = state.postStatsData.length + ' posts scanned!' + (savedFilename ? ' Saved to ' + savedFilename + '.' : '');
      renderAll();
      renderPostStatsTable();
    } catch (error) {
      state.postStatsScanning = false;
      state.headerNotice = String((error && error.message) || error || 'Post stats scan failed.');
      renderHeader();
      renderControls();
    }
  }

  async function handleFetchCharacterStats() {
    if (state.characterStatsFetching) return;
    if (!(state.session && state.session.authenticated)) {
      state.sessionPrompt = 'Sign in to Sora before fetching character stats.';
      state.headerNotice = '';
      renderHeader();
      renderControls();
      startLoginFlow('backup').catch(() => {});
      return;
    }
    const handle = String(ui.characterStatsHandle.value || '').trim().replace(/^@/, '');
    if (!handle) return;
    state.characterStatsFetching = true;
    state.headerNotice = '';
    renderControls();
    try {
      const response = await appApi.fetchCharacterStats(handle);
      state.characterStatsFetching = false;
      if (!response.ok) {
        state.headerNotice = response.error || 'Failed to fetch character stats.';
        renderHeader();
        renderControls();
        return;
      }
      exportCharacterStatsCsv(response.profile, handle);
      state.headerNotice = 'Character stats downloaded!';
      renderHeader();
      renderControls();
    } catch (error) {
      state.characterStatsFetching = false;
      state.headerNotice = String((error && error.message) || error || 'Character stats fetch failed.');
      renderHeader();
      renderControls();
    }
  }

  function exportCharacterStatsCsv(profile, handle) {
    if (!profile) return;
    const formatTs = (ts) => ts ? new Date(Number(ts) * 1000).toISOString() : '';
    const fields = [
      ['Username', profile.username],
      ['Display Name', profile.display_name],
      ['User ID', profile.user_id],
      ['Permalink', profile.permalink],
      ['Followers', profile.follower_count],
      ['Following', profile.following_count],
      ['Posts', profile.post_count],
      ['Replies', profile.reply_count],
      ['Likes Received', profile.likes_received_count],
      ['Remixes', profile.remix_count],
      ['Cameos', profile.cameo_count],
      ['Characters', profile.character_count],
      ['Verified', profile.verified],
      ['Can Cameo', profile.can_cameo],
      ['Created At', formatTs(profile.created_at)],
      ['Updated At', formatTs(profile.updated_at)],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');
    const headers = fields.map(([k]) => k).join(',');
    const values = fields.map(([, v]) => {
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
    const csv = headers + '\n' + values;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sora_character_stats_' + (handle || 'unknown') + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function renderAll() {
    updateWorkingDotsTimer();
    renderSession();
    renderHeader();
    renderScopeProgress();
    renderControls();
    renderPostStatsSection();
    renderClearCacheModal();
    renderLogoutModal();
    renderManualBearerModal();
    renderDraftCookieModal();
    renderMacLoginNoteModal();
    queueWindowResize();
  }

  function measureContentHeight() {
    const bodyHeight = document.body ? document.body.scrollHeight : 0;
    const documentHeight = document.documentElement ? document.documentElement.scrollHeight : 0;
    return Math.ceil(Math.max(bodyHeight, documentHeight));
  }

  function queueWindowResize() {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      const nextHeight = measureContentHeight();
      if (!nextHeight || Math.abs(nextHeight - lastSentHeight) < 2) return;
      lastSentHeight = nextHeight;
      appApi.resizeToContent(nextHeight).catch(() => {});
    });
  }

  async function persistSettings(partial) {
    const response = await appApi.updateSettings(partial || {});
    if (response && response.ok && response.settings) {
      state.settings = Object.assign({}, state.settings, response.settings);
    } else {
      state.settings = Object.assign({}, state.settings, partial || {});
    }
    renderSettings();
  }

  function applyBootstrapSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    if (data.settings) {
      state.settings = Object.assign({}, state.settings, data.settings);
      state.settings.published_download_mode = normalizePublishedDownloadMode(state.settings.published_download_mode);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'session')) {
      state.session = data.session || null;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'run')) {
      setRun(data.run || null, { initialize: true });
    }
    if (Object.prototype.hasOwnProperty.call(data, 'bucket_progress')) {
      state.bucketProgress = data.bucket_progress || null;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'draft_publish_usage')) {
      state.draftPublishUsage = normalizeDraftPublishUsage(data.draft_publish_usage);
    }
  }

  async function refreshSessionStatus(reason, options) {
    const force = !!(options && options.force);
    if (state.authPollInFlight && !force) return;
    const now = Date.now();
    if (!force && now - state.lastSessionRefreshAt < 1200) return;
    state.lastSessionRefreshAt = now;
    state.authPollInFlight = true;
    renderSession();
    try {
      const response = await appApi.checkSession();
      applyBootstrapSnapshot(response && response.bootstrap ? response.bootstrap : { session: response.session || null });
      if (state.session && state.session.authenticated) {
        state.awaitingLoginCompletion = false;
        state.sessionPrompt = '';
        state.headerNotice = '';
        renderAll();
        return;
      }
      if (state.session && state.session.error === 'backup_login_window_closed') {
        state.awaitingLoginCompletion = false;
        state.sessionPrompt = 'The Sora browser window closed before sign-in finished. Click Open Sora to try again.';
        renderAll();
        return;
      }
      if (state.awaitingLoginCompletion && state.session && state.session.error === 'backup_missing_auth_header') {
        state.sessionPrompt = 'Sora opened, but the app is still waiting for authenticated session headers. If you don\'t see "Connected" after a while, try logging out then logging back in again.';
        renderAll();
        return;
      }
      if (state.awaitingLoginCompletion && reason === 'return') {
        state.sessionPrompt = 'Still waiting for Sora sign-in. Finish it in the Sora browser, then return here.';
      }
      renderAll();
    } finally {
      state.authPollInFlight = false;
      renderSession();
    }
  }

  async function startLoginFlow(source) {
    if (state.session && state.session.authenticated) {
      renderAll();
      return;
    }
    if (state.loginFlowPromise) return state.loginFlowPromise;
    state.loginFlowPromise = (async () => {
      state.authPollInFlight = false;
      state.awaitingLoginCompletion = true;
      renderSession();
      await appApi.openLoginWindow();
      state.sessionPrompt = source === 'backup'
        ? 'Browser opened. Finish signing in inside Sora, then return here and press Start backup again.'
        : 'Browser opened. Finish signing in inside Sora, then return to this app.';
      renderHeader();
    })().finally(() => {
      state.loginFlowPromise = null;
    });
    return state.loginFlowPromise;
  }

  async function loadBootstrap() {
    const data = await appApi.getBootstrap();
    applyBootstrapSnapshot(data);
    state.authPollInFlight = true;
    renderSettings();
    renderAll();
    await refreshSessionStatus('bootstrap', { force: true });
  }

  async function handleOpenLogin() {
    if (state.session && state.session.authenticated) {
      state.logoutModalOpen = true;
      state.logoutStatus = '';
      renderLogoutModal();
      queueWindowResize();
      return;
    }
    if (state.platform === 'darwin') {
      state.macLoginNoteModalOpen = true;
      renderMacLoginNoteModal();
      queueWindowResize();
      return;
    }
    startLoginFlow('button').catch((error) => {
      state.awaitingLoginCompletion = false;
      state.sessionPrompt = String((error && error.message) || error || 'Could not open Sora.');
      renderHeader();
      renderSession();
    });
  }

  async function handleConfirmMacLoginNote() {
    closeMacLoginNoteModal();
    startLoginFlow('button').catch((error) => {
      state.awaitingLoginCompletion = false;
      state.sessionPrompt = String((error && error.message) || error || 'Could not open Sora.');
      renderHeader();
      renderSession();
    });
  }

  async function handleChooseDir() {
    const response = await appApi.chooseDownloadFolder(ui.downloadDir.value);
    if (response && response.ok) {
      state.settings.downloadDir = response.path;
      await persistSettings({ downloadDir: response.path });
    }
  }

  async function handleStartBackup() {
    if (isPostStatsScope()) {
      handleScanPostStats().catch(() => {});
      return;
    }
    if (getSelectedScope() === 'characterStats') {
      handleFetchCharacterStats().catch(() => {});
      return;
    }
    if (!(state.session && state.session.authenticated)) {
      state.sessionPrompt = 'Sign in to Sora before starting the backup.';
      state.headerNotice = '';
      renderHeader();
      renderControls();
      startLoginFlow('backup').catch(() => {});
      return;
    }

    const selectedScope = getSelectedScope();
    const characterHandle = ui.characterHandle.value.trim();
    const characterDraftsHandle = ui.characterDraftsHandle.value.trim();
    const settingsPatch = {
      published_download_mode: ui.modeSelect.value,
      audio_mode: ui.audioModeSelect.value,
      framing_mode: ui.framingModeSelect.value,
      selectedScope: selectedScope,
      character_handle: characterHandle,
      character_drafts_handle: characterDraftsHandle,
    };
    state.settings = Object.assign({}, state.settings, settingsPatch);
    renderSettings();
    renderHeader();
    const request = {
      scopes: buildScopes(),
      settings: {
        published_download_mode: state.settings.published_download_mode,
        audio_mode: state.settings.audio_mode,
        framing_mode: state.settings.framing_mode,
        character_handle: state.settings.character_handle,
        character_drafts_handle: state.settings.character_drafts_handle,
      },
      downloadDir: state.settings.downloadDir,
    };
    const response = await appApi.startBackup(request);
    if (!response.ok) {
      if (response.error === 'backup_missing_auth_session') {
        state.sessionPrompt = 'Sign in to Sora before starting the backup.';
        state.headerNotice = '';
        renderHeader();
        startLoginFlow('backup').catch(() => {});
      } else if (response.error === 'backup_draft_manual_auth_required') {
        openDraftCookieModal({
          request,
          settingsPatch,
        }).catch(() => {});
      } else {
        state.headerNotice = response.error || 'Could not start backup.';
        renderHeader();
      }
      return;
    }
    await persistSettings(settingsPatch);
    state.headerNotice = '';
    state.cancelPending = false;
    setRun(response.run || null);
    renderAll();
  }

  async function handleCancelBackup() {
    if (state.cancelPending) return;
    state.cancelPending = true;
    renderAll();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    const response = await appApi.cancelBackup();
    if (!response.ok) {
      state.cancelPending = false;
      state.headerNotice = response.error || 'Could not stop backup.';
      renderHeader();
      renderControls();
      return;
    }
    state.headerNotice = '';
    setRun(response.run || null);
    renderAll();
  }

  async function handleOpenRunFolder() {
    const runId = state.run && state.run.id;
    if (!runId) return;
    const response = await appApi.openRunFolder(runId);
    if (!response.ok) {
      state.headerNotice = response.error || 'Could not open the download folder.';
      renderHeader();
      return;
    }
    acknowledgeOpenRunFolderAttention();
    renderOpenRunFolderButton();
  }

  async function handleConfirmDraftCookie() {
    if (state.draftCookieSubmitting) return;
    const needsBearer = draftCookieModalNeedsBearer();
    const cookie = String(ui.draftCookieInput.value || '').trim();
    const bearer = String(ui.draftBearerInput.value || '').trim();
    if (!cookie || (needsBearer && !bearer)) {
      state.draftCookieStatus = formatDraftCookieError('backup_draft_manual_auth_required');
      renderDraftCookieModal();
      return;
    }

    state.draftCookieSubmitting = true;
    state.draftCookieStatus = '';
    renderDraftCookieModal();
    try {
      const response = await appApi.updateSettings(
        needsBearer
          ? {
              manual_cookie_header: cookie,
              manual_bearer_token: bearer,
            }
          : {
              manual_cookie_header: cookie,
            }
      );
      if (response && response.ok && response.settings) {
        state.settings = Object.assign({}, state.settings, response.settings);
      } else {
        state.settings = Object.assign({}, state.settings, {
          has_manual_cookie_header: true,
          has_manual_bearer_token: needsBearer ? true : state.settings.has_manual_bearer_token,
        });
      }
      const pending = state.pendingDraftCookieBackupRequest;
      state.draftCookieSubmitting = false;
      state.draftCookieModalOpen = false;
      state.draftCookieStatus = '';
      state.pendingDraftCookieBackupRequest = null;
      ui.draftCookieInput.value = '';
      ui.draftBearerInput.value = '';
      renderAll();
      if (!pending) return;
      const backupResponse = await appApi.startBackup(pending.request);
      if (!backupResponse || !backupResponse.ok) {
        if (backupResponse && backupResponse.error === 'backup_draft_manual_auth_required') {
          state.pendingDraftCookieBackupRequest = pending;
          state.draftCookieModalOpen = true;
          state.draftCookieStatus = formatDraftCookieError(backupResponse.error);
          renderDraftCookieModal();
          queueWindowResize();
          return;
        }
        if (backupResponse && backupResponse.error === 'backup_missing_auth_session') {
          state.sessionPrompt = 'Sign in to Sora before starting the backup.';
          state.headerNotice = '';
          renderHeader();
          startLoginFlow('backup').catch(() => {});
          return;
        }
        state.headerNotice = (backupResponse && backupResponse.error) || 'Could not start backup.';
        renderHeader();
        return;
      }
      await persistSettings(pending.settingsPatch);
      state.headerNotice = '';
      state.cancelPending = false;
      setRun(backupResponse.run || null);
      renderAll();
    } catch (error) {
      state.draftCookieSubmitting = false;
      state.draftCookieStatus = formatDraftCookieError((error && error.message) || error);
      renderDraftCookieModal();
    }
  }

  async function handleOpenClearCache() {
    if (state.clearCacheLoading || state.clearCacheSubmitting) return;
    state.clearCacheModalOpen = true;
    state.clearCacheLoading = true;
    renderClearCacheModal();
    queueWindowResize();
    try {
      const response = await appApi.getClearCacheTargets();
      if (!response || !response.ok) {
        state.headerNotice = formatClearCacheError(response && response.error);
        closeClearCacheModal();
        renderHeader();
        return;
      }
      state.clearCacheTargets = response.targets || null;
      state.clearCacheLoading = false;
      renderClearCacheModal();
    } catch (error) {
      state.clearCacheLoading = false;
      state.headerNotice = formatClearCacheError((error && error.message) || error);
      closeClearCacheModal();
      renderHeader();
    }
  }

  function handleOpenManualBearerModal() {
    state.manualBearerModalOpen = true;
    state.manualBearerStatus = '';
    renderManualBearerModal();
    queueWindowResize();
    window.requestAnimationFrame(() => {
      if (!ui.manualBearerInput) return;
      ui.manualBearerInput.focus();
      ui.manualBearerInput.select();
    });
  }

  async function handleConfirmManualBearer() {
    if (state.manualBearerSubmitting) return;
    const token = String(ui.manualBearerInput.value || '').trim();
    if (!token) {
      state.manualBearerStatus = formatManualBearerError('backup_manual_bearer_missing');
      renderManualBearerModal();
      return;
    }

    state.manualBearerSubmitting = true;
    state.manualBearerStatus = '';
    renderManualBearerModal();
    try {
      const response = await appApi.connectWithBearerToken(token);
      if (!response || !response.ok) {
        state.session = response && response.session ? response.session : state.session;
        state.manualBearerStatus = formatManualBearerError(response && response.error);
        state.manualBearerSubmitting = false;
        renderManualBearerModal();
        renderSession();
        return;
      }

      applyBootstrapSnapshot(response && response.bootstrap ? response.bootstrap : {
        session: response.session || state.session,
        settings: response.settings || state.settings,
      });
      state.awaitingLoginCompletion = false;
      state.sessionPrompt = '';
      state.headerNotice = response.message || '';
      state.manualBearerSubmitting = false;
      state.manualBearerModalOpen = false;
      state.manualBearerStatus = '';
      ui.manualBearerInput.value = '';
      renderAll();
    } catch (error) {
      state.manualBearerSubmitting = false;
      state.manualBearerStatus = formatManualBearerError((error && error.message) || error);
      renderManualBearerModal();
    }
  }

  async function handleConfirmClearCache() {
    if (state.clearCacheSubmitting || state.clearCacheLoading) return;
    const payload = getSelectedClearCachePayload();
    if (!payload.modes.length && !payload.characters.length) return;
    const confirmed = window.confirm(
      'Are you sure? You are clearing the log of what you have or have not downloaded. This means you will start from the start next time you begin downloading.'
    );
    if (!confirmed) return;

    state.clearCacheSubmitting = true;
    renderClearCacheModal();
    renderControls();
    try {
      const response = await appApi.clearSelectedCaches(payload);
      if (!response || !response.ok) {
        state.headerNotice = formatClearCacheError(response && response.error);
        state.clearCacheSubmitting = false;
        renderHeader();
        renderClearCacheModal();
        renderControls();
        return;
      }

      const bootstrap = response.bootstrap || {};
      state.settings = Object.assign({}, state.settings, bootstrap.settings || {});
      state.session = bootstrap.session || state.session;
      setRun(Object.prototype.hasOwnProperty.call(bootstrap, 'run') ? (bootstrap.run || null) : state.run, { initialize: true });
      state.bucketProgress = bootstrap.bucket_progress || state.bucketProgress;
      state.clearCacheTargets = response.targets || state.clearCacheTargets;
      state.headerNotice = 'Cache cleared.';
      state.clearCacheSubmitting = false;
      state.clearCacheModalOpen = false;
      renderAll();
    } catch (error) {
      state.clearCacheSubmitting = false;
      state.headerNotice = formatClearCacheError((error && error.message) || error);
      renderHeader();
      renderClearCacheModal();
      renderControls();
    }
  }

  function formatLogoutError(error) {
    if (error === 'backup_run_in_progress') {
      return 'Stop the current backup before logging out.';
    }
    return 'Could not log out.';
  }

  async function handleConfirmLogout() {
    if (state.logoutSubmitting) return;
    state.logoutSubmitting = true;
    state.logoutStatus = '';
    renderLogoutModal();
    try {
      const response = await appApi.logoutSession();
      if (!response || !response.ok) {
        state.logoutSubmitting = false;
        state.logoutStatus = formatLogoutError(response && response.error);
        renderLogoutModal();
        return;
      }
      applyBootstrapSnapshot(response && response.bootstrap ? response.bootstrap : {
        session: response.session || null,
        settings: response.settings || state.settings,
      });
      state.awaitingLoginCompletion = false;
      state.sessionPrompt = '';
      state.headerNotice = 'Logged out.';
      state.logoutSubmitting = false;
      state.logoutModalOpen = false;
      state.logoutStatus = '';
      renderAll();
    } catch (error) {
      state.logoutSubmitting = false;
      state.logoutStatus = formatLogoutError((error && error.message) || error);
      renderLogoutModal();
    }
  }

  ui.openLoginBtn.addEventListener('click', handleOpenLogin);
  ui.manualBearerBtn.addEventListener('click', handleOpenManualBearerModal);
  ui.chooseDirBtn.addEventListener('click', handleChooseDir);
  ui.startBackupBtn.addEventListener('click', handleStartBackup);
  ui.cancelBackupBtn.addEventListener('click', handleCancelBackup);
  ui.openRunFolderBtn.addEventListener('click', handleOpenRunFolder);
  ui.clearCacheBtn.addEventListener('click', handleOpenClearCache);
  ui.clearCacheCancelBtn.addEventListener('click', closeClearCacheModal);
  ui.clearCacheConfirmBtn.addEventListener('click', handleConfirmClearCache);
  ui.clearCacheBackdrop.addEventListener('click', closeClearCacheModal);
  ui.macLoginNoteConfirmBtn.addEventListener('click', () => {
    handleConfirmMacLoginNote().catch(() => {});
  });
  ui.macLoginNoteBackdrop.addEventListener('click', closeMacLoginNoteModal);
  ui.logoutCancelBtn.addEventListener('click', closeLogoutModal);
  ui.logoutConfirmBtn.addEventListener('click', handleConfirmLogout);
  ui.logoutBackdrop.addEventListener('click', closeLogoutModal);
  ui.manualBearerCancelBtn.addEventListener('click', closeManualBearerModal);
  ui.manualBearerConfirmBtn.addEventListener('click', handleConfirmManualBearer);
  ui.manualBearerBackdrop.addEventListener('click', closeManualBearerModal);
  ui.draftCookieCancelBtn.addEventListener('click', closeDraftCookieModal);
  ui.draftCookieConfirmBtn.addEventListener('click', handleConfirmDraftCookie);
  ui.draftCookieBackdrop.addEventListener('click', closeDraftCookieModal);
  ui.clearCacheModal.addEventListener('change', (event) => {
    if (!event.target || !event.target.matches('input[data-clear-cache-type]')) return;
    ui.clearCacheConfirmBtn.disabled = state.clearCacheSubmitting || !hasSelectedClearCachePayload();
  });
  ui.manualBearerInput.addEventListener('input', () => {
    if (state.manualBearerStatus) {
      state.manualBearerStatus = '';
    }
    ui.manualBearerConfirmBtn.disabled = state.manualBearerSubmitting || !String(ui.manualBearerInput.value || '').trim();
    renderManualBearerModal();
  });
  ui.manualBearerInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleConfirmManualBearer().catch(() => {});
  });
  ui.draftCookieInput.addEventListener('input', () => {
    if (state.draftCookieStatus) {
      state.draftCookieStatus = '';
    }
    const needsBearer = draftCookieModalNeedsBearer();
    ui.draftCookieConfirmBtn.disabled =
      state.draftCookieSubmitting ||
      !String(ui.draftCookieInput.value || '').trim() ||
      (needsBearer && !String(ui.draftBearerInput.value || '').trim());
    renderDraftCookieModal();
  });
  ui.draftBearerInput.addEventListener('input', () => {
    if (state.draftCookieStatus) {
      state.draftCookieStatus = '';
    }
    const needsBearer = draftCookieModalNeedsBearer();
    ui.draftCookieConfirmBtn.disabled =
      state.draftCookieSubmitting ||
      !String(ui.draftCookieInput.value || '').trim() ||
      (needsBearer && !String(ui.draftBearerInput.value || '').trim());
    renderDraftCookieModal();
  });
  ui.draftCookieInput.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'enter') return;
    event.preventDefault();
    handleConfirmDraftCookie().catch(() => {});
  });
  ui.draftBearerInput.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'enter') return;
    event.preventDefault();
    handleConfirmDraftCookie().catch(() => {});
  });

  if (ui.postStatsExportBtn) {
    ui.postStatsExportBtn.addEventListener('click', exportPostStatsCsv);
  }

  appApi.onPostStatsProgress((progress) => {
    if (!progress) return;
    state.postStatsPage = progress.page || 0;
    state.postStatsProgressCount = progress.count || 0;
    if (progress.retrying) {
      state.headerNotice = 'Scanning page ' + progress.page + '… (retry ' + progress.attempt + '/' + progress.maxAttempts + ')';
    } else {
      state.headerNotice = 'Scanning page ' + progress.page + '… (' + progress.count + ' posts found)';
    }
    renderHeader();
    setText(ui.scopeProgressPostStats, String(state.postStatsProgressCount));
  });

  ui.modeSelect.addEventListener('change', () => {
    persistSettings({ published_download_mode: ui.modeSelect.value }).catch(() => {});
  });
  ui.audioModeSelect.addEventListener('change', () => {
    persistSettings({ audio_mode: ui.audioModeSelect.value }).catch(() => {});
  });
  ui.framingModeSelect.addEventListener('change', () => {
    persistSettings({ framing_mode: ui.framingModeSelect.value }).catch(() => {});
  });
  function selectCharacterScope() {
    const radio = document.querySelector('input[name="scope"][value="characterPosts"]');
    if (!radio || radio.checked) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function updateSuffix(inputEl) {
    const wrap = inputEl.closest('.route-input-wrap');
    if (!wrap) return;
    const suffix = wrap.querySelector('.input-suffix');
    if (!suffix) return;
    const val = inputEl.value;
    if (!val) {
      suffix.style.display = 'none';
      return;
    }
    suffix.style.display = '';
    const style = window.getComputedStyle(inputEl);
    const font = [style.fontStyle, style.fontVariant, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
    const paddingLeft = parseFloat(style.paddingLeft) || 14;
    const canvas = updateSuffix._canvas || (updateSuffix._canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    suffix.style.left = (paddingLeft + ctx.measureText(val).width + 5) + 'px';
  }

  ui.characterHandle.addEventListener('focus', selectCharacterScope);
  ui.characterHandle.addEventListener('click', selectCharacterScope);
  ui.characterHandle.addEventListener('input', () => {
    const val = ui.characterHandle.value;
    state.settings.character_handle = val.trim();
    ui.characterDraftsHandle.value = val;
    state.settings.character_drafts_handle = val.trim();
    ui.characterStatsHandle.value = val;
    state.settings.character_stats_handle = val.trim();
    updateSuffix(ui.characterHandle);
    updateSuffix(ui.characterDraftsHandle);
    updateSuffix(ui.characterStatsHandle);
    renderScopeProgress();
    renderControls();
  });
  ui.characterHandle.addEventListener('blur', () => {
    persistSettings({ character_handle: ui.characterHandle.value.trim(), character_drafts_handle: ui.characterHandle.value.trim(), character_stats_handle: ui.characterHandle.value.trim() }).catch(() => {});
  });
  function selectCharacterDraftsScope() {
    const radio = document.querySelector('input[name="scope"][value="characterDrafts"]');
    if (!radio || radio.checked) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
  ui.characterDraftsHandle.addEventListener('focus', selectCharacterDraftsScope);
  ui.characterDraftsHandle.addEventListener('click', selectCharacterDraftsScope);
  ui.characterDraftsHandle.addEventListener('input', () => {
    const val = ui.characterDraftsHandle.value;
    state.settings.character_drafts_handle = val.trim();
    ui.characterHandle.value = val;
    state.settings.character_handle = val.trim();
    ui.characterStatsHandle.value = val;
    state.settings.character_stats_handle = val.trim();
    updateSuffix(ui.characterDraftsHandle);
    updateSuffix(ui.characterHandle);
    updateSuffix(ui.characterStatsHandle);
    renderScopeProgress();
    renderControls();
  });
  ui.characterDraftsHandle.addEventListener('blur', () => {
    persistSettings({ character_drafts_handle: ui.characterDraftsHandle.value.trim(), character_handle: ui.characterDraftsHandle.value.trim(), character_stats_handle: ui.characterDraftsHandle.value.trim() }).catch(() => {});
  });
  function selectCharacterStatsScope() {
    const radio = document.querySelector('input[name="scope"][value="characterStats"]');
    if (!radio || radio.checked) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
  ui.characterStatsHandle.addEventListener('focus', selectCharacterStatsScope);
  ui.characterStatsHandle.addEventListener('click', selectCharacterStatsScope);
  ui.characterStatsHandle.addEventListener('input', () => {
    const val = ui.characterStatsHandle.value;
    state.settings.character_stats_handle = val.trim();
    ui.characterHandle.value = val;
    state.settings.character_handle = val.trim();
    ui.characterDraftsHandle.value = val;
    state.settings.character_drafts_handle = val.trim();
    updateSuffix(ui.characterStatsHandle);
    updateSuffix(ui.characterHandle);
    updateSuffix(ui.characterDraftsHandle);
    renderScopeProgress();
    renderControls();
  });
  ui.characterStatsHandle.addEventListener('blur', () => {
    persistSettings({ character_stats_handle: ui.characterStatsHandle.value.trim(), character_handle: ui.characterStatsHandle.value.trim(), character_drafts_handle: ui.characterStatsHandle.value.trim() }).catch(() => {});
  });
  document.querySelectorAll('input[name="scope"]').forEach((input) => {
    input.addEventListener('change', () => {
      state.settings.selectedScope = getSelectedScope();
      renderHeader();
      renderScopeProgress();
      renderControls();
      persistSettings({ selectedScope: state.settings.selectedScope }).catch(() => {});
    });
  });
  document.querySelectorAll('.route-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('.route-input')) return;
      const radio = row.querySelector('input[name="scope"]');
      if (!radio || radio.checked) return;
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  appApi.onBackupStatus((payload) => {
    if (!payload) return;
    state.headerNotice = '';
    setRun(payload.run || null);
    state.bucketProgress = payload.bucket_progress || null;
    state.draftPublishUsage = normalizeDraftPublishUsage(payload.draft_publish_usage);
    if (!state.run || state.run.status === 'cancelled' || state.run.status === 'completed' || state.run.status === 'failed') {
      state.cancelPending = false;
    }
    renderAll();
  });

  window.addEventListener('focus', () => {
    if (!state.awaitingLoginCompletion || (state.session && state.session.authenticated)) return;
    refreshSessionStatus('return').catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.awaitingLoginCompletion || (state.session && state.session.authenticated)) return;
    refreshSessionStatus('return').catch(() => {});
  });
  window.addEventListener('beforeunload', () => {
    state.awaitingLoginCompletion = false;
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.manualBearerModalOpen) {
      closeManualBearerModal();
      return;
    }
    if (state.draftCookieModalOpen) {
      closeDraftCookieModal();
      return;
    }
    if (state.macLoginNoteModalOpen) {
      closeMacLoginNoteModal();
      return;
    }
    if (state.logoutModalOpen) {
      closeLogoutModal();
      return;
    }
    if (state.clearCacheModalOpen) {
      closeClearCacheModal();
    }
  });
  window.addEventListener('load', queueWindowResize);

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      queueWindowResize();
    });
    observer.observe(document.body);
  }

  document.documentElement.dataset.theme = 'dark';

  loadBootstrap().catch((error) => {
    state.headerNotice = String((error && error.message) || error || 'Failed to load app.');
    renderHeader();
  });
})();
