(function initializeRenderer() {
  const appApi = window.soraBackupApp;
  const SCOPE_KEYS = ['ownPosts', 'ownDrafts', 'castInPosts', 'castInDrafts', 'characterPosts'];
  const SMART_DOWNLOAD_OVERLOADED_MESSAGE = 'All watermark removers are overloaded right now. Please try again later.';
  const state = {
    settings: {
      downloadDir: '',
      published_download_mode: 'smart',
      audio_mode: 'with_audiomark',
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
    scopeProgressOwnPosts: document.getElementById('scopeProgressOwnPosts'),
    scopeProgressOwnDrafts: document.getElementById('scopeProgressOwnDrafts'),
    scopeProgressCastInPosts: document.getElementById('scopeProgressCastInPosts'),
    scopeProgressCastInDrafts: document.getElementById('scopeProgressCastInDrafts'),
    scopeProgressCharacterPosts: document.getElementById('scopeProgressCharacterPosts'),
  };
  let resizeFrame = 0;
  let lastSentHeight = 0;

  function setText(element, value) {
    if (!element) return;
    element.textContent = value;
  }

  function formatCount(value) {
    return new Intl.NumberFormat().format(Math.max(0, Number(value) || 0));
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
    };
  }

  function getCharacterLabel() {
    const handle = String(state.settings.character_handle || '').trim().replace(/^@+/, '');
    return handle ? '@' + handle : 'Select a character';
  }

  function getRunScopeLabel(run) {
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPosts) return 'my posts';
    if (scopes.ownDrafts) return 'my drafts';
    if (scopes.castInPosts) return 'cast-in posts';
    if (scopes.castInDrafts) return 'drafts of me';
    if (scopes.characterPosts) {
      const handle = String(run && run.settings && run.settings.character_handle || '').trim().replace(/^@+/, '');
      return handle ? '@' + handle + ' posts' : 'character posts';
    }
    return 'videos';
  }

  function getRunCountLabel(run, totalLabel) {
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPosts) return 'my ' + totalLabel + ' posts';
    if (scopes.ownDrafts) return 'my ' + totalLabel + ' drafts';
    if (scopes.castInPosts) return totalLabel + ' cast-in posts';
    if (scopes.castInDrafts) return totalLabel + ' drafts of me';
    if (scopes.characterPosts) {
      const handle = String(run && run.settings && run.settings.character_handle || '').trim().replace(/^@+/, '');
      return handle ? totalLabel + ' posts from @' + handle : totalLabel + ' character posts';
    }
    return totalLabel + ' videos';
  }

  function getScopeCountLabel(scopeKey, totalLabel, settings) {
    if (scopeKey === 'ownPosts') return 'my ' + totalLabel + ' posts';
    if (scopeKey === 'ownDrafts') return 'my ' + totalLabel + ' drafts';
    if (scopeKey === 'castInPosts') return totalLabel + ' cast-in posts';
    if (scopeKey === 'castInDrafts') return totalLabel + ' drafts of me';
    if (scopeKey === 'characterPosts') {
      const handle = String(settings && settings.character_handle || '').trim().replace(/^@+/, '');
      return handle ? totalLabel + ' posts from @' + handle : totalLabel + ' character posts';
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
    if (scopeKey === 'characterPosts') {
      const handle = String(settings && settings.character_handle || '').trim().replace(/^@+/, '');
      return handle ? 'No posts from @' + handle + ' found' : 'No character posts found';
    }
    return 'No videos found';
  }

  function getRunDiscoveryLabel(run) {
    const scopes = run && run.scopes ? run.scopes : {};
    if (scopes.ownPosts) return 'Scanning posts';
    if (scopes.ownDrafts) return 'Scanning drafts';
    if (scopes.castInPosts) return 'Scanning cast-in posts';
    if (scopes.castInDrafts) return 'Scanning drafts of me';
    if (scopes.characterPosts) {
      const handle = String(run && run.settings && run.settings.character_handle || '').trim().replace(/^@+/, '');
      return handle ? 'Scanning @' + handle : 'Scanning character posts';
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
    const runActive = !!(run && (run.status === 'discovering' || run.status === 'running'));
    const overloadNotice = run && run.last_error === SMART_DOWNLOAD_OVERLOADED_MESSAGE
      ? SMART_DOWNLOAD_OVERLOADED_MESSAGE
      : '';
    if (!run) {
      setText(
        ui.heroSubtitle,
        state.headerNotice || state.sessionPrompt || (state.authPollInFlight
          ? 'Checking Sora session…'
          : authenticated
          ? 'Ready to begin!'
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
      state.headerNotice || overloadNotice || noResultsLabel || (run.status === 'cancelled' ? stoppedLabel : (actionLabel + ' · ' + completeLabel + ' of ' + totalLabel))
    );
    setText(ui.progressBadge, metrics.percent + '% complete');
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
    const runActive = !!(state.run && (state.run.status === 'discovering' || state.run.status === 'running'));
    const selectedScope = getSelectedScope();
    const needsCharacter = selectedScope === 'characterPosts';
    const hasCharacter = String(ui.characterHandle.value || '').trim().length > 0;
    ui.startBackupBtn.disabled = runActive || (needsCharacter && !hasCharacter);
    ui.startBackupBtn.textContent = authenticated ? 'Start backup' : 'Sign in to start';
    ui.cancelBackupBtn.disabled = !runActive || state.cancelPending;
    ui.cancelBackupBtn.dataset.tone = runActive ? 'active' : 'idle';
    ui.cancelBackupBtn.textContent = state.cancelPending ? 'Stopping...' : 'Stop';
  }

  function renderSettings() {
    ui.downloadDir.value = state.settings.downloadDir || '';
    ui.modeSelect.value = state.settings.published_download_mode || 'smart';
    ui.audioModeSelect.value = state.settings.audio_mode || 'with_audiomark';
    ui.framingModeSelect.value = state.settings.framing_mode || 'sora_default';
    ui.characterHandle.value = state.settings.character_handle || '';
    setSelectedScope(state.settings.selectedScope || 'ownPosts');
    renderScopeProgress();
    renderControls();
  }

  function renderAll() {
    renderSession();
    renderHeader();
    renderScopeProgress();
    renderControls();
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
        state.sessionPrompt = 'Sora opened, but the app is still waiting for authenticated session headers. Leave the Sora home page open for a moment, then return here.';
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

  ui.openLoginBtn.addEventListener('click', handleOpenLogin);
  ui.chooseDirBtn.addEventListener('click', handleChooseDir);
  ui.startBackupBtn.addEventListener('click', handleStartBackup);
  ui.cancelBackupBtn.addEventListener('click', handleCancelBackup);
  ui.openRunFolderBtn.addEventListener('click', handleOpenRunFolder);

  ui.modeSelect.addEventListener('change', () => {
    persistSettings({ published_download_mode: ui.modeSelect.value }).catch(() => {});
  });
  ui.audioModeSelect.addEventListener('change', () => {
    persistSettings({ audio_mode: ui.audioModeSelect.value }).catch(() => {});
  });
  ui.framingModeSelect.addEventListener('change', () => {
    persistSettings({ framing_mode: ui.framingModeSelect.value }).catch(() => {});
  });
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
