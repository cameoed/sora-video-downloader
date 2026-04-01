(function initializeRenderer() {
  const appApi = window.soraBackupApp;
  const SCOPE_KEYS = ['ownPosts', 'ownDrafts', 'castInPosts', 'castInDrafts', 'characterPosts', 'ownPrompts'];
  const CLEARABLE_MODE_TARGETS = [
    { key: 'ownPosts', label: 'My posts' },
    { key: 'ownDrafts', label: 'My drafts' },
    { key: 'castInPosts', label: 'Cast-in posts' },
    { key: 'castInDrafts', label: 'Drafts of me' },
  ];
  const DEFAULT_PUBLISHED_DOWNLOAD_MODE = 'smart';
  const SMART_DOWNLOAD_OVERLOADED_MESSAGE = 'All watermark removers are overloaded right now. Please try again later.';
  function normalizePublishedDownloadMode(value) {
    return value === 'direct_sora' ? 'direct_sora' : DEFAULT_PUBLISHED_DOWNLOAD_MODE;
  }
  const state = {
    settings: {
      downloadDir: '',
      published_download_mode: DEFAULT_PUBLISHED_DOWNLOAD_MODE,
      audio_mode: 'no_audiomark',
      framing_mode: 'sora_default',
      selectedScope: 'ownPosts',
      character_handle: '',
    },
    session: null,
    sessionPrompt: '',
    run: null,
    bucketProgress: null,
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
    workingDots: '',
  };

  const ui = {
    openLoginBtn: document.getElementById('openLoginBtn'),
    heroSubtitle: document.getElementById('heroSubtitle'),
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

  function buildScopes() {
    const selected = getSelectedScope();
    return {
      ownPosts: selected === 'ownPosts',
      ownDrafts: selected === 'ownDrafts',
      castInPosts: selected === 'castInPosts',
      castInDrafts: selected === 'castInDrafts',
      characterPosts: selected === 'characterPosts',
      ownPrompts: selected === 'ownPrompts',
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
    if (scopeKey === 'ownPosts') return 'No posts found';
    if (scopeKey === 'ownDrafts') return 'No drafts found';
    if (scopeKey === 'castInPosts') return 'No cast-in posts found';
    if (scopeKey === 'castInDrafts') return 'No drafts of me found';
    if (scopeKey === 'ownPrompts') return 'No prompts found';
    if (scopeKey === 'characterPosts') {
      const handle = formatCharacterHandleLabel(settings && settings.character_handle);
      return handle ? 'No posts from ' + handle + ' found' : 'No character posts found';
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
    return 'Scanning videos';
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

  function getWorkingSuffix(run) {
    const summaryText = String(run && run.summary_text || '');
    const pageMatch = run && run.status === 'discovering' ? summaryText.match(/\bpage\s+(\d+)\b/i) : null;
    const workingLabel = pageMatch ? ('working on page ' + pageMatch[1]) : 'working';
    return ' · ' + workingLabel + (state.workingDots || '');
  }

  function getDiscoveryPageNumber(run) {
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
    const session = state.session;
    const authenticated = !!(session && session.authenticated);
    const checking = state.authPollInFlight;
    button.disabled = false;
    if (checking) {
      button.dataset.tone = 'working';
      setText(button, 'Checking…');
      return;
    }
    if (authenticated) {
      button.dataset.tone = 'ok';
      setText(button, 'Connected');
      return;
    }
    if (session && session.error) {
      button.dataset.tone = 'error';
      setText(button, 'Open Sora');
      return;
    }
    button.dataset.tone = 'warn';
    setText(button, 'Open Sora');
  }

  function renderHeader() {
    const run = state.run;
    const metrics = getProgressMetrics();
    const authenticated = !!(state.session && state.session.authenticated);
    const runActive = isRunProcessing(run);
    const overloadNotice = run && run.last_error === SMART_DOWNLOAD_OVERLOADED_MESSAGE
      ? SMART_DOWNLOAD_OVERLOADED_MESSAGE
      : '';
    if (!run) {
      setText(
        ui.heroSubtitle,
        state.headerNotice || state.sessionPrompt || (authenticated
          ? 'Ready to go!'
          : state.authPollInFlight
          ? 'Checking Sora session…'
          : 'Sign in to get started')
      );
      setText(ui.progressBadge, '0% complete');
      ui.progressFill.style.width = '0%';
      ui.openRunFolderBtn.hidden = true;
      return;
    }

    if (!runActive && !state.authPollInFlight && !authenticated) {
      setText(ui.heroSubtitle, state.headerNotice || overloadNotice || state.sessionPrompt || 'Sign in to get started');
      setText(ui.progressBadge, '0% complete');
      ui.progressFill.style.width = '0%';
      ui.openRunFolderBtn.hidden = !run.id;
      return;
    }

    const totalLabel = formatCount(metrics.total);
    const completeLabel = formatCount(metrics.complete);
    const actionLabel = run.status === 'discovering' ? getRunDiscoveryLabel(run) : 'Processing videos';
    const stoppedLabel = getSelectedScopeProcessedLabel();
    const noResultsLabel = run.status === 'completed' && metrics.total === 0
      ? getNoResultsLabel(getSelectedScope(), state.settings)
      : '';
    setText(
      ui.heroSubtitle,
      state.headerNotice || overloadNotice || noResultsLabel || (run.status === 'cancelled' ? stoppedLabel : (actionLabel + ' · ' + completeLabel + ' of ' + totalLabel + getWorkingSuffix(run)))
    );
    const pageNumber = getDiscoveryPageNumber(run);
    setText(ui.progressBadge, pageNumber ? ('Page ' + pageNumber + ' ' + metrics.percent + '% complete') : (metrics.percent + '% complete'));
    ui.progressFill.style.width = metrics.percent + '%';
    ui.openRunFolderBtn.hidden = !run.id;
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
    };
    SCOPE_KEYS.forEach((key) => {
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
    const promptExport = selectedScope === 'ownPrompts';
    const hasCharacter = String(ui.characterHandle.value || '').trim().length > 0;
    ui.startBackupBtn.disabled = runActive || (needsCharacter && !hasCharacter);
    ui.startBackupBtn.textContent = authenticated ? (promptExport ? 'Save prompts' : 'Start backup') : 'Sign in to start';
    ui.cancelBackupBtn.disabled = !runActive || state.cancelPending;
    ui.cancelBackupBtn.dataset.tone = runActive ? 'active' : 'idle';
    ui.cancelBackupBtn.textContent = state.cancelPending ? 'Stopping...' : (runActive ? 'Stop' : 'Stopped');
    ui.clearCacheBtn.disabled = runActive || state.clearCacheLoading || state.clearCacheSubmitting;
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

  function closeClearCacheModal() {
    if (state.clearCacheSubmitting) return;
    state.clearCacheModalOpen = false;
    state.clearCacheLoading = false;
    renderClearCacheModal();
    queueWindowResize();
  }

  function renderSettings() {
    ui.downloadDir.value = state.settings.downloadDir || '';
    ui.modeSelect.value = normalizePublishedDownloadMode(state.settings.published_download_mode);
    ui.audioModeSelect.value = state.settings.audio_mode || 'no_audiomark';
    ui.framingModeSelect.value = state.settings.framing_mode || 'sora_default';
    ui.characterHandle.value = state.settings.character_handle || '';
    setSelectedScope(state.settings.selectedScope || 'ownPosts');
    renderScopeProgress();
    renderControls();
  }

  function renderAll() {
    updateWorkingDotsTimer();
    renderSession();
    renderHeader();
    renderScopeProgress();
    renderControls();
    renderClearCacheModal();
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
      state.session = response.session || null;
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
    state.settings = Object.assign({}, state.settings, data.settings || {});
    state.settings.published_download_mode = normalizePublishedDownloadMode(state.settings.published_download_mode);
    state.session = data.session || null;
    state.run = data.run || null;
    state.bucketProgress = data.bucket_progress || null;
    state.authPollInFlight = true;
    renderSettings();
    renderAll();
    await refreshSessionStatus('bootstrap', { force: true });
  }

  async function handleOpenLogin() {
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
    const settingsPatch = {
      published_download_mode: ui.modeSelect.value,
      audio_mode: ui.audioModeSelect.value,
      framing_mode: ui.framingModeSelect.value,
      selectedScope: selectedScope,
      character_handle: characterHandle,
    };
    state.settings = Object.assign({}, state.settings, settingsPatch);
    renderSettings();
    renderHeader();
    const response = await appApi.startBackup({
      scopes: buildScopes(),
      settings: {
        published_download_mode: state.settings.published_download_mode,
        audio_mode: state.settings.audio_mode,
        framing_mode: state.settings.framing_mode,
        character_handle: state.settings.character_handle,
      },
      downloadDir: state.settings.downloadDir,
    });
    if (!response.ok) {
      if (response.error === 'backup_missing_auth_session') {
        state.sessionPrompt = 'Sign in to Sora before starting the backup.';
        state.headerNotice = '';
        renderHeader();
        startLoginFlow('backup').catch(() => {});
      } else {
        state.headerNotice = response.error || 'Could not start backup.';
        renderHeader();
      }
      return;
    }
    await persistSettings(settingsPatch);
    state.headerNotice = '';
    state.cancelPending = false;
    state.run = response.run || null;
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
    state.run = response.run || null;
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
      state.run = bootstrap.run || state.run;
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

  ui.openLoginBtn.addEventListener('click', handleOpenLogin);
  ui.chooseDirBtn.addEventListener('click', handleChooseDir);
  ui.startBackupBtn.addEventListener('click', handleStartBackup);
  ui.cancelBackupBtn.addEventListener('click', handleCancelBackup);
  ui.openRunFolderBtn.addEventListener('click', handleOpenRunFolder);
  ui.clearCacheBtn.addEventListener('click', handleOpenClearCache);
  ui.clearCacheCancelBtn.addEventListener('click', closeClearCacheModal);
  ui.clearCacheConfirmBtn.addEventListener('click', handleConfirmClearCache);
  ui.clearCacheBackdrop.addEventListener('click', closeClearCacheModal);
  ui.clearCacheModal.addEventListener('change', (event) => {
    if (!event.target || !event.target.matches('input[data-clear-cache-type]')) return;
    ui.clearCacheConfirmBtn.disabled = state.clearCacheSubmitting || !hasSelectedClearCachePayload();
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
  ui.characterHandle.addEventListener('focus', selectCharacterScope);
  ui.characterHandle.addEventListener('click', selectCharacterScope);
  ui.characterHandle.addEventListener('input', () => {
    state.settings.character_handle = ui.characterHandle.value.trim();
    renderScopeProgress();
    renderControls();
  });
  ui.characterHandle.addEventListener('blur', () => {
    persistSettings({ character_handle: ui.characterHandle.value.trim() }).catch(() => {});
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
    state.run = payload.run || null;
    state.bucketProgress = payload.bucket_progress || null;
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
    if (event.key !== 'Escape' || !state.clearCacheModalOpen) return;
    closeClearCacheModal();
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
