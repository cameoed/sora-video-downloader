const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { FileStore } = require('./file-store');
const { PlaywrightSession } = require('./playwright-session');
const { downloadToFile, getSmartDownloadProviders, resolveSmartDownloadRequest } = require('./http-download');
const { resolveFfmpegBinary, processVideo, buildIntermediateDownloadPath } = require('./media-processing');
const {
  BACKUP_ORIGIN,
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
  buildPromptExportFilename,
  buildBackupFilename,
  buildBackupManifestItem,
  buildBackupDetailPath,
  buildBackupPermalink,
  extractBackupPostIdFromPermalink,
  isBackupPublishedPostPermalink,
  extractBackupPublishedPostReference,
  pickPrompt,
  pickPromptSource,
  pickTitle,
  sanitizeString,
  sanitizeIdToken,
  getBackupRetryDelayMs,
} = require('./helpers');
const WATERMARK_DOWNLOAD_THROTTLE_MS = 3000;
const DOWNLOAD_VALIDATION_MIN_VIDEO_BYTES = 500 * 1024;
const DOWNLOAD_VALIDATION_SNIFF_BYTES = 4096;
const SCAN_PROGRESS_STALL_TIMEOUT_MS = 60 * 1000;
const SCAN_PROGRESS_STALL_MAX_ATTEMPTS = 3;
const SCAN_PROGRESS_STALL_RETRY_DELAY_MS = 2000;
const DRAFT_LINK_PUBLISH_DAILY_LIMIT = 500;
const DRAFT_LINK_PUBLISH_THROTTLE_MS = 2000;
const DRAFT_LINK_PUBLISH_SETTLE_MS = 1000;
const DRAFT_LINK_PUBLISH_MAX_ATTEMPTS = 3;
const MAX_DRAFT_LINK_POST_TEXT = 1999;
const OWN_DRAFTS_DOWNLOAD_CONCURRENCY = 2;
const SCAN_RESUME_BUCKET_KEYS = ['ownPosts', 'ownDrafts', 'castInPosts', 'castInDrafts', 'ownPrompts', 'characterPosts', 'characterDrafts'];
const PROMPT_SIMILARITY_THRESHOLD = 0.95;
const DEFAULT_ACCOUNT_STATE_KEY = '__default__';
const DRAFT_SHARED_LINK_CATALOG_VERSION = 1;
const SAVED_CATALOG_VERSION = 2;

function formatLocalDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function createEmptyDraftPublishUsage() {
  return {
    date: '',
    count: 0,
    last_published_at: 0,
  };
}

function normalizeDraftPublishUsage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const normalized = createEmptyDraftPublishUsage();
  normalized.date = sanitizeString(source.date, 32) || '';
  normalized.count = Math.max(0, Math.floor(Number(source.count) || 0));
  normalized.last_published_at = Math.max(0, Math.floor(Number(source.last_published_at) || 0));
  return normalized;
}

function ensureCurrentDraftPublishUsage(raw) {
  const normalized = normalizeDraftPublishUsage(raw);
  const today = formatLocalDateKey();
  if (normalized.date === today) return normalized;
  return {
    date: today,
    count: 0,
    last_published_at: 0,
  };
}

function buildDraftPublishUsageSnapshot(raw) {
  const usage = ensureCurrentDraftPublishUsage(raw);
  return {
    date: usage.date,
    count: usage.count,
    limit: DRAFT_LINK_PUBLISH_DAILY_LIMIT,
    remaining: Math.max(0, DRAFT_LINK_PUBLISH_DAILY_LIMIT - usage.count),
  };
}

function truncateDraftLinkPostText(value) {
  const text = sanitizeString(value, 8192) || '';
  if (!text || text.length <= MAX_DRAFT_LINK_POST_TEXT) return text;
  const suffix = '...';
  const limit = MAX_DRAFT_LINK_POST_TEXT - suffix.length;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > Math.floor(limit * 0.6) ? cut.slice(0, lastSpace) : cut;
  return trimmed.trimEnd() + suffix;
}

function buildDirectDraftSharedLinkPostBody(detail, item) {
  const draft = detail && typeof detail.draft === 'object' ? detail.draft : detail;
  if (!draft || typeof draft !== 'object') return null;
  const draftId = sanitizeString(draft.id, 256) || sanitizeString(item && item.id, 256) || '';
  const itemKind = sanitizeString(item && item.draft_source_kind, 64) || '';
  const kind = itemKind || sanitizeString(draft.kind, 64) || '';
  const isEditDraft = kind === 'sora_edit' || (!kind && Array.isArray(draft.assets) && draft.assets.length > 0);
  const itemGenerationId = sanitizeString(item && item.draft_generation_id, 256) || '';

  let generationId = '';
  let attachmentKind = '';
  let postText = '';
  if (kind === 'sora_draft') {
    generationId = itemGenerationId || sanitizeString(draft.generation_id, 256) || draftId;
    attachmentKind = 'sora';
    postText =
      sanitizeString(draft.prompt, 8192) ||
      sanitizeString(draft.title, 512) ||
      sanitizeString(item && item.prompt, 8192) ||
      '';
  } else if (isEditDraft) {
    generationId = itemGenerationId || draftId;
    attachmentKind = 'sora_edit';
    postText =
      sanitizeString(draft.caption, 8192) ||
      sanitizeString(draft.prompt, 8192) ||
      sanitizeString(item && item.prompt, 8192) ||
      '';
  } else {
    return null;
  }

  if (!generationId || !attachmentKind) return null;
  return {
    attachments_to_create: [{ generation_id: generationId, kind: attachmentKind }],
    post_text: truncateDraftLinkPostText(postText || 'Downloaded!'),
    destinations: [{ type: 'shared_link_unlisted' }],
  };
}

function buildDraftPublishFallbackDetail(item) {
  if (!item || typeof item !== 'object') return null;
  const draftId = sanitizeIdToken(item.id, 256) || '';
  const generationId = sanitizeIdToken(item.draft_generation_id, 256) || draftId;
  const kind = sanitizeString(item.draft_source_kind, 64) || 'sora_draft';
  const nFrames = Math.max(0, Math.floor(Number(item.draft_n_frames) || 0));
  if (!draftId || !generationId) return null;
  return {
    draft: {
      id: draftId,
      kind,
      generation_id: generationId,
      prompt: sanitizeString(item.prompt, 8192) || '',
      title: sanitizeString(item.title, 512) || '',
      caption: '',
      duration_s: Number(item.duration_s) || 0,
      creation_config: nFrames > 0 ? { n_frames: nFrames } : {},
      n_frames: nFrames,
    },
  };
}

function isTemporaryEditorDraftArtifact(value) {
  const item = value && typeof value === 'object' ? value : {};
  if (
    Array.isArray(item.assets) &&
    Array.isArray(item.timeline) &&
    item.preview_asset &&
    typeof item.preview_asset === 'object'
  ) {
    return true;
  }
  const kind = sanitizeString(item.kind, 64) || '';
  const generationType = sanitizeString(item.generation_type, 128) || '';
  const title = sanitizeString(item.title, 512) || '';
  const prompt = sanitizeString(item.prompt, 8192) || '';
  return (
    kind === 'sora_draft' &&
    generationType === 'editor_stitch' &&
    title === 'Your new editor export' &&
    !prompt
  );
}

function normalizeManualBearerToken(value) {
  const raw = sanitizeString(value, 16384) || '';
  if (!raw) return '';
  const token = raw.replace(/^Authorization\s*:\s*/i, '').replace(/^Bearer\s+/i, '').trim();
  return token ? ('Bearer ' + token) : '';
}

function normalizeManualCookieHeader(value) {
  const raw = sanitizeString(value, 65535) || '';
  if (!raw) return '';
  return raw.replace(/^Cookie\s*:\s*/i, '').trim() || '';
}

function summarizeCookieHeader(value) {
  const raw = sanitizeString(value, 65535) || '';
  if (!raw) return { present: false, count: 0, names: [] };
  const names = raw
    .split(';')
    .map((part) => {
      const chunk = String(part || '').trim();
      if (!chunk) return '';
      const eqIndex = chunk.indexOf('=');
      return eqIndex > 0 ? chunk.slice(0, eqIndex).trim() : '';
    })
    .filter(Boolean);
  return {
    present: names.length > 0,
    count: names.length,
    names: names.slice(0, 64),
  };
}

function hasReadyDraftSharedLink(item) {
  if (!item || item.kind !== 'draft') return false;
  return isBackupPublishedPostPermalink(item.post_permalink);
}

function backupRequiresManualDraftCookie(scopes, settings) {
  const normalizedScopes = normalizeBackupScopes(scopes || DEFAULT_BACKUP_SCOPES);
  const normalizedSettings = normalizeBackupRequestSettings(settings || {});
  return normalizedScopes.ownDrafts === true && normalizedSettings.published_download_mode === 'smart';
}

function hasRequiredManualDraftAuth(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return (
    !!normalizeManualCookieHeader(source.manual_cookie_header) &&
    !!normalizeManualBearerToken(source.manual_bearer_token)
  );
}

function buildPublicSettings(settings) {
  const next = Object.assign({}, settings || {});
  next.has_manual_bearer_token = !!normalizeManualBearerToken(next.manual_bearer_token);
  next.has_manual_cookie_header = !!normalizeManualCookieHeader(next.manual_cookie_header);
  delete next.download_dir_mode;
  delete next.profile;
  delete next.manual_bearer_token;
  delete next.manual_cookie_header;
  return next;
}

function migrateDownloadDirToRoot(downloadDir) {
  const normalized = sanitizeString(downloadDir, 4096) || '';
  if (!normalized) return '';
  if (path.basename(normalized).toLowerCase() === BACKUP_DOWNLOAD_FOLDER.toLowerCase()) {
    return normalized;
  }
  return path.join(normalized, BACKUP_DOWNLOAD_FOLDER);
}

function sanitizeAccountKeyPart(value) {
  const raw = sanitizeString(value, 256) || '';
  return raw.replace(/[^a-z0-9_.:-]/gi, '_');
}

function buildAccountStateKey(user) {
  const normalizedUser = normalizeCurrentUser(user || {});
  if (normalizedUser.id) return 'id:' + sanitizeAccountKeyPart(normalizedUser.id);
  if (normalizedUser.handle) return 'handle:' + sanitizeAccountKeyPart(String(normalizedUser.handle).toLowerCase());
  return DEFAULT_ACCOUNT_STATE_KEY;
}

function sameNormalizedBearerToken(left, right) {
  return normalizeManualBearerToken(left) === normalizeManualBearerToken(right);
}

function isCatalogObject(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function buildSavedCatalogVariantKey(settings) {
  const normalized = normalizeBackupRequestSettings(settings);
  return [
    normalized.published_download_mode,
    normalized.audio_mode,
    normalized.framing_mode,
  ].join('__');
}

function normalizeSavedCatalogVariantKey(value) {
  const raw = sanitizeString(value, 128) || '';
  if (!raw) return '';
  const parts = raw.split('__');
  if (parts.length !== 3) return '';
  if (parts[0] !== 'smart' && parts[0] !== 'direct_sora') return '';
  if (parts[1] !== 'no_audiomark' && parts[1] !== 'with_audiomark') return '';
  if (parts[2] !== 'sora_default' && parts[2] !== 'social_16_9') return '';
  return buildSavedCatalogVariantKey({
    published_download_mode: parts[0],
    audio_mode: parts[1],
    framing_mode: parts[2],
  });
}

function normalizeSavedCatalogIdList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < list.length; index += 1) {
    const itemId = sanitizeIdToken(list[index], 256);
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    normalized.push(itemId);
  }
  return normalized;
}

function createEmptySavedBackupCatalog() {
  return {
    ownDrafts: {},
    ownPosts: {},
    castInPosts: {},
    castInDrafts: {},
    characterPosts: {},
    ownPrompts: [],
    characterDrafts: {},
  };
}

function normalizeSavedCatalogVariantEntry(raw) {
  const normalized = {};
  if (Array.isArray(raw)) {
    const legacyIds = normalizeSavedCatalogIdList(raw);
    if (legacyIds.length) {
      normalized[buildSavedCatalogVariantKey({})] = legacyIds;
    }
    return normalized;
  }
  const source = isCatalogObject(raw) ? raw : {};
  Object.keys(source).forEach((variantKey) => {
    const normalizedVariantKey = normalizeSavedCatalogVariantKey(variantKey);
    if (!normalizedVariantKey) return;
    normalized[normalizedVariantKey] = normalizeSavedCatalogIdList(source[variantKey]);
  });
  return normalized;
}

function normalizeSavedCharacterCatalog(raw) {
  const source = isCatalogObject(raw) ? raw : {};
  const normalized = {};
  Object.keys(source).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) return;
    normalized[normalizedHandle] = normalizeSavedCatalogVariantEntry(source[handle]);
  });
  return normalized;
}

function normalizeSavedBackupCatalog(raw) {
  const source = isCatalogObject(raw) ? raw : {};
  return {
    ownDrafts: normalizeSavedCatalogVariantEntry(source.ownDrafts),
    ownPosts: normalizeSavedCatalogVariantEntry(source.ownPosts),
    castInPosts: normalizeSavedCatalogVariantEntry(source.castInPosts),
    castInDrafts: normalizeSavedCatalogVariantEntry(source.castInDrafts),
    characterPosts: normalizeSavedCharacterCatalog(source.characterPosts),
    ownPrompts: normalizeSavedCatalogIdList(source.ownPrompts),
    characterDrafts: normalizeSavedCharacterCatalog(source.characterDrafts),
  };
}

function cloneSavedCatalogVariantSetMap(raw) {
  const normalized = normalizeSavedCatalogVariantEntry(raw);
  const setMap = {};
  Object.keys(normalized).forEach((variantKey) => {
    setMap[variantKey] = new Set(normalized[variantKey]);
  });
  return setMap;
}

function cloneSavedCharacterVariantSetMap(raw) {
  const normalized = normalizeSavedCharacterCatalog(raw);
  const setMap = {};
  Object.keys(normalized).forEach((handle) => {
    setMap[handle] = cloneSavedCatalogVariantSetMap(normalized[handle]);
  });
  return setMap;
}

function convertSavedVariantSetMapToCatalog(setMap) {
  const normalized = {};
  Object.keys(setMap || {}).forEach((variantKey) => {
    const normalizedVariantKey = normalizeSavedCatalogVariantKey(variantKey);
    if (!normalizedVariantKey) return;
    normalized[normalizedVariantKey] = Array.from(setMap[variantKey] || []);
  });
  return normalized;
}

function convertSavedCharacterVariantSetMapToCatalog(setMap) {
  const normalized = {};
  Object.keys(setMap || {}).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) return;
    normalized[normalizedHandle] = convertSavedVariantSetMapToCatalog(setMap[handle]);
  });
  return normalized;
}

function recordSavedBackupItemsInCatalog(catalog, run, items) {
  const nextCatalog = normalizeSavedBackupCatalog(catalog);
  const variantKey = buildSavedCatalogVariantKey(run && run.settings);
  const characterHandle = normalizeCharacterHandle(run && run.settings && run.settings.character_handle);
  const characterDraftsHandle = normalizeCharacterHandle(run && run.settings && run.settings.character_drafts_handle);
  const bucketSets = {
    ownDrafts: cloneSavedCatalogVariantSetMap(nextCatalog.ownDrafts),
    ownPosts: cloneSavedCatalogVariantSetMap(nextCatalog.ownPosts),
    castInPosts: cloneSavedCatalogVariantSetMap(nextCatalog.castInPosts),
    castInDrafts: cloneSavedCatalogVariantSetMap(nextCatalog.castInDrafts),
    ownPrompts: new Set(nextCatalog.ownPrompts),
  };
  const characterSets = cloneSavedCharacterVariantSetMap(nextCatalog.characterPosts);
  const characterDraftsSets = cloneSavedCharacterVariantSetMap(nextCatalog.characterDrafts);

  if (!bucketSets.ownDrafts[variantKey]) bucketSets.ownDrafts[variantKey] = new Set();
  if (!bucketSets.ownPosts[variantKey]) bucketSets.ownPosts[variantKey] = new Set();
  if (!bucketSets.castInPosts[variantKey]) bucketSets.castInPosts[variantKey] = new Set();
  if (!bucketSets.castInDrafts[variantKey]) bucketSets.castInDrafts[variantKey] = new Set();

  const list = Array.isArray(items) ? items : [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const bucketKey = sanitizeString(item && item.bucket, 64) || '';
    const itemId = sanitizeIdToken(item && item.id, 256);
    if (!bucketKey || !itemId) continue;
    if (bucketKey === 'characterPosts') {
      if (!characterHandle) continue;
      if (!characterSets[characterHandle]) characterSets[characterHandle] = {};
      if (!characterSets[characterHandle][variantKey]) characterSets[characterHandle][variantKey] = new Set();
      characterSets[characterHandle][variantKey].add(itemId);
      continue;
    }
    if (bucketKey === 'characterDrafts') {
      if (!characterDraftsHandle) continue;
      if (!characterDraftsSets[characterDraftsHandle]) characterDraftsSets[characterDraftsHandle] = {};
      if (!characterDraftsSets[characterDraftsHandle][variantKey]) characterDraftsSets[characterDraftsHandle][variantKey] = new Set();
      characterDraftsSets[characterDraftsHandle][variantKey].add(itemId);
      continue;
    }
    if (bucketKey === 'ownPrompts') {
      bucketSets.ownPrompts.add(itemId);
      continue;
    }
    if (!bucketSets[bucketKey]) continue;
    bucketSets[bucketKey][variantKey].add(itemId);
  }

  return {
    ownDrafts: convertSavedVariantSetMapToCatalog(bucketSets.ownDrafts),
    ownPosts: convertSavedVariantSetMapToCatalog(bucketSets.ownPosts),
    castInPosts: convertSavedVariantSetMapToCatalog(bucketSets.castInPosts),
    castInDrafts: convertSavedVariantSetMapToCatalog(bucketSets.castInDrafts),
    characterPosts: convertSavedCharacterVariantSetMapToCatalog(characterSets),
    ownPrompts: Array.from(bucketSets.ownPrompts),
    characterDrafts: convertSavedCharacterVariantSetMapToCatalog(characterDraftsSets),
  };
}

function createEmptyScopedAccountState() {
  return {
    lastRunId: '',
    bucketCatalog: createEmptyBackupBucketCatalog(),
    savedCatalog: createEmptySavedBackupCatalog(),
    cacheResetCatalog: createEmptyCacheResetCatalog(),
    completeScanCatalog: createEmptyCompleteScanCatalog(),
    draftPublishUsage: createEmptyDraftPublishUsage(),
    draftSharedLinkCatalog: createEmptyDraftSharedLinkCatalog(),
    draftSharedLinkCatalogVersion: 0,
    scanResumeCatalog: createEmptyScanResumeCatalog(),
    savedCatalogVersion: SAVED_CATALOG_VERSION,
    savedCatalogHydrated: false,
  };
}

function normalizeScopedAccountState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const scanResumeCatalog = mergeLegacyDraftResumeCatalog(
    normalizeScanResumeCatalog(source.scanResumeCatalog || createEmptyScanResumeCatalog()),
    source.draftResumeCatalog
  );
  const savedCatalogVersion = Math.max(0, Math.floor(Number(source.savedCatalogVersion) || 0));
  return {
    lastRunId: sanitizeString(source.lastRunId, 128) || '',
    bucketCatalog: normalizeBackupBucketCatalog(source.bucketCatalog || createEmptyBackupBucketCatalog()),
    savedCatalog: normalizeSavedBackupCatalog(source.savedCatalog || createEmptySavedBackupCatalog()),
    cacheResetCatalog: normalizeCacheResetCatalog(source.cacheResetCatalog),
    completeScanCatalog: normalizeCompleteScanCatalog(source.completeScanCatalog),
    draftPublishUsage: ensureCurrentDraftPublishUsage(source.draftPublishUsage),
    draftSharedLinkCatalog: normalizeDraftSharedLinkCatalog(source.draftSharedLinkCatalog || createEmptyDraftSharedLinkCatalog()),
    draftSharedLinkCatalogVersion: Math.max(0, Math.floor(Number(source.draftSharedLinkCatalogVersion) || 0)),
    scanResumeCatalog: scanResumeCatalog,
    savedCatalogVersion: savedCatalogVersion >= SAVED_CATALOG_VERSION ? savedCatalogVersion : 0,
    savedCatalogHydrated: source.savedCatalogHydrated === true && savedCatalogVersion >= SAVED_CATALOG_VERSION,
  };
}

function normalizeAccountStatesCatalog(raw, legacyState, legacyAccountKey) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const normalized = {};
  Object.keys(source).forEach((key) => {
    const normalizedKey = sanitizeString(key, 256) || '';
    if (!normalizedKey) return;
    normalized[normalizedKey] = normalizeScopedAccountState(source[key]);
  });

  const hasLegacyState =
    !!sanitizeString(legacyState && legacyState.lastRunId, 128) ||
    !!(legacyState && legacyState.bucketCatalog) ||
    !!(legacyState && legacyState.savedCatalog) ||
    !!(legacyState && legacyState.cacheResetCatalog) ||
    !!(legacyState && legacyState.completeScanCatalog) ||
    !!(legacyState && legacyState.draftPublishUsage) ||
    !!(legacyState && legacyState.draftSharedLinkCatalog) ||
    !!(legacyState && (legacyState.scanResumeCatalog || legacyState.draftResumeCatalog));

  if (hasLegacyState && !Object.keys(normalized).length) {
    const targetKey = sanitizeString(legacyAccountKey, 256) || DEFAULT_ACCOUNT_STATE_KEY;
    normalized[targetKey] = normalizeScopedAccountState({
      lastRunId: legacyState.lastRunId,
      bucketCatalog: legacyState.bucketCatalog,
      savedCatalog: legacyState.savedCatalog,
      cacheResetCatalog: legacyState.cacheResetCatalog,
      completeScanCatalog: legacyState.completeScanCatalog,
      draftPublishUsage: legacyState.draftPublishUsage,
      draftSharedLinkCatalog: legacyState.draftSharedLinkCatalog,
      scanResumeCatalog: legacyState.scanResumeCatalog,
      draftResumeCatalog: legacyState.draftResumeCatalog,
      savedCatalogVersion: legacyState.savedCatalogVersion,
      savedCatalogHydrated: legacyState.savedCatalogHydrated === true,
    });
  }

  if (!Object.keys(normalized).length) {
    normalized[DEFAULT_ACCOUNT_STATE_KEY] = createEmptyScopedAccountState();
  }

  return normalized;
}

function normalizeStoredSession(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    authenticated: source.authenticated === true,
    checkedAt: Math.max(0, Math.floor(Number(source.checkedAt) || 0)),
    user: source.user ? normalizeCurrentUser(source.user) : null,
    status: Math.max(0, Math.floor(Number(source.status) || 0)),
    error: sanitizeString(source.error, 1024) || '',
  };
}

function createEmptyScanResumeCatalog() {
  return {
    ownPosts: null,
    ownDrafts: null,
    castInPosts: null,
    castInDrafts: null,
    ownPrompts: null,
    characterPosts: {},
    characterDrafts: {},
  };
}

function createEmptyDraftSharedLinkCatalog() {
  return {};
}

function normalizeDraftSharedLinkEntry(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const permalink = isBackupPublishedPostPermalink(source.permalink)
    ? source.permalink
    : '';
  const postId = sanitizeIdToken(
    source.postId || extractBackupPostIdFromPermalink(permalink),
    256
  ) || '';
  const normalizedPermalink = permalink || (
    /^s_[A-Za-z0-9]+$/i.test(postId)
      ? buildBackupPermalink('published', postId)
      : ''
  );
  if (!normalizedPermalink) return null;
  return {
    permalink: normalizedPermalink,
    postId: postId || extractBackupPostIdFromPermalink(normalizedPermalink),
    updatedAt: Math.max(0, Math.floor(Number(source.updatedAt) || 0)),
  };
}

function normalizeDraftSharedLinkCatalog(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const normalized = createEmptyDraftSharedLinkCatalog();
  Object.keys(source).forEach((draftId) => {
    const normalizedDraftId = sanitizeIdToken(draftId, 256) || '';
    const entry = normalizeDraftSharedLinkEntry(source[draftId]);
    if (!normalizedDraftId || !entry) return;
    normalized[normalizedDraftId] = entry;
  });
  return normalized;
}

function normalizeScanResumeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const runId = sanitizeString(raw.runId, 64) || '';
  if (!runId) return null;
  const nextCursor = raw.nextCursor == null ? null : String(raw.nextCursor);
  const updatedAt = Math.max(0, Math.floor(Number(raw.updatedAt) || 0));
  return {
    runId: runId,
    nextCursor: nextCursor && nextCursor.trim() ? nextCursor : null,
    updatedAt: updatedAt,
  };
}

function normalizeScanResumeCatalog(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const normalized = createEmptyScanResumeCatalog();
  normalized.ownPosts = normalizeScanResumeEntry(source.ownPosts);
  normalized.ownDrafts = normalizeScanResumeEntry(source.ownDrafts);
  normalized.castInPosts = normalizeScanResumeEntry(source.castInPosts);
  normalized.castInDrafts = normalizeScanResumeEntry(source.castInDrafts);
  normalized.ownPrompts = normalizeScanResumeEntry(source.ownPrompts);
  const rawCharacters = source.characterPosts && typeof source.characterPosts === 'object' && !Array.isArray(source.characterPosts)
    ? source.characterPosts
    : {};
  Object.keys(rawCharacters).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    const entry = normalizeScanResumeEntry(rawCharacters[handle]);
    if (!normalizedHandle || !entry) return;
    normalized.characterPosts[normalizedHandle] = entry;
  });
  const rawCharDrafts = source.characterDrafts && typeof source.characterDrafts === 'object' && !Array.isArray(source.characterDrafts)
    ? source.characterDrafts
    : {};
  Object.keys(rawCharDrafts).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    const entry = normalizeScanResumeEntry(rawCharDrafts[handle]);
    if (!normalizedHandle || !entry) return;
    normalized.characterDrafts[normalizedHandle] = entry;
  });
  return normalized;
}

function mergeLegacyDraftResumeCatalog(targetCatalog, rawLegacyCatalog) {
  const target = normalizeScanResumeCatalog(targetCatalog || createEmptyScanResumeCatalog());
  const source = rawLegacyCatalog && typeof rawLegacyCatalog === 'object' && !Array.isArray(rawLegacyCatalog)
    ? rawLegacyCatalog
    : {};
  if (!target.ownDrafts) target.ownDrafts = normalizeScanResumeEntry(source.ownDrafts);
  if (!target.castInDrafts) target.castInDrafts = normalizeScanResumeEntry(source.castInDrafts);
  return target;
}

function isScanResumeBucketKey(value) {
  return SCAN_RESUME_BUCKET_KEYS.indexOf(String(value || '')) >= 0;
}

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
    'Video,Prompt,Duration,Creation Date',
  ];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    lines.push([
      escapeCsvValue(row.fileName),
      escapeCsvValue(row.prompt),
      escapeCsvValue(row.duration),
      escapeCsvValue(row.createdAt),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function createEmptyCompleteScanCatalog() {
  return {
    ownPosts: null,
    ownDrafts: null,
    castInPosts: null,
    castInDrafts: null,
    characterPosts: {},
    characterDrafts: {},
  };
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
  const normalized = createEmptyCompleteScanCatalog();
  normalized.ownPosts = normalizeCompleteScanEntry(source.ownPosts);
  normalized.ownDrafts = normalizeCompleteScanEntry(source.ownDrafts);
  normalized.castInPosts = normalizeCompleteScanEntry(source.castInPosts);
  normalized.castInDrafts = normalizeCompleteScanEntry(source.castInDrafts);
  const rawCharacters = source.characterPosts && typeof source.characterPosts === 'object' && !Array.isArray(source.characterPosts)
    ? source.characterPosts
    : {};
  Object.keys(rawCharacters).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    const entry = normalizeCompleteScanEntry(rawCharacters[handle]);
    if (!normalizedHandle || !entry) return;
    normalized.characterPosts[normalizedHandle] = entry;
  });
  const rawCharDrafts = source.characterDrafts && typeof source.characterDrafts === 'object' && !Array.isArray(source.characterDrafts)
    ? source.characterDrafts
    : {};
  Object.keys(rawCharDrafts).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    const entry = normalizeCompleteScanEntry(rawCharDrafts[handle]);
    if (!normalizedHandle || !entry) return;
    normalized.characterDrafts[normalizedHandle] = entry;
  });
  return normalized;
}
const VIDEO_PROCESS_RETRY_COUNT = 2;
const CLEARABLE_CACHE_MODE_KEYS = ['ownPosts', 'ownDrafts', 'ownPrompts', 'castInPosts', 'castInDrafts', 'postStats'];
const CLEARABLE_CACHE_BUCKET_KEYS = ['ownPosts', 'ownDrafts', 'ownPrompts', 'castInPosts', 'castInDrafts'];
const CLEARABLE_CACHE_LABELS = {
  ownPosts: 'My posts',
  ownDrafts: 'My drafts',
  ownPrompts: 'My draft prompts',
  castInPosts: 'Cast-in posts',
  castInDrafts: 'Drafts of me',
  postStats: 'My post stats',
};

function createEmptyCacheResetCatalog() {
  return {
    ownDrafts: 0,
    ownPosts: 0,
    castInPosts: 0,
    castInDrafts: 0,
    characterPosts: {},
    characterDrafts: {},
    ownPrompts: 0,
    postStats: 0,
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
  normalized.postStats = normalizeCacheResetTimestamp(source.postStats);
  const rawCharacters = source.characterPosts && typeof source.characterPosts === 'object' && !Array.isArray(source.characterPosts)
    ? source.characterPosts
    : {};
  Object.keys(rawCharacters).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) return;
    normalized.characterPosts[normalizedHandle] = normalizeCacheResetTimestamp(rawCharacters[handle]);
  });
  const rawCharacterDrafts = source.characterDrafts && typeof source.characterDrafts === 'object' && !Array.isArray(source.characterDrafts)
    ? source.characterDrafts
    : {};
  Object.keys(rawCharacterDrafts).forEach((handle) => {
    const normalizedHandle = normalizeCharacterHandle(handle);
    if (!normalizedHandle) return;
    normalized.characterDrafts[normalizedHandle] = normalizeCacheResetTimestamp(rawCharacterDrafts[handle]);
  });
  return normalized;
}

class BackupCancelledError extends Error {
  constructor() {
    super('backup_cancelled');
    this.name = 'BackupCancelledError';
  }
}

const SMART_DOWNLOAD_OVERLOADED_MESSAGE = "All watermark removers are overloaded right now. Retrying every 3 mins until one comes online!";
const SMART_DOWNLOAD_OVERLOAD_RETRY_MS = 3 * 60 * 1000;

function normalizeDownloadMediaExt(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function hasIsoBmffSignature(buffer) {
  return !!(buffer && buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp');
}

function hasWebmSignature(buffer) {
  return !!(
    buffer &&
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}

function hasKnownVideoSignature(buffer, mediaExt) {
  const normalizedExt = normalizeDownloadMediaExt(mediaExt);
  if (normalizedExt === 'webm') return hasWebmSignature(buffer);
  if (normalizedExt === 'mp4' || normalizedExt === 'm4v' || normalizedExt === 'mov') {
    return hasIsoBmffSignature(buffer);
  }
  return hasIsoBmffSignature(buffer) || hasWebmSignature(buffer);
}

function looksLikeHtmlDocument(buffer) {
  if (!buffer || !buffer.length) return false;
  const prefix = buffer
    .toString('utf8', 0, Math.min(buffer.length, DOWNLOAD_VALIDATION_SNIFF_BYTES))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 512)
    .toLowerCase();
  if (!prefix.startsWith('<')) return false;
  if (/^<(?:!doctype\s+html|html|head|body)\b/.test(prefix)) return true;
  return prefix.includes('<html') && (prefix.includes('<head') || prefix.includes('<body'));
}

function formatDownloadSizeLabel(size) {
  const sizeKb = Math.max(0, Math.round((Number(size) || 0) / 1024));
  return sizeKb + ' KB';
}

async function readFileHeader(filePath, byteCount) {
  const targetBytes = Math.max(0, Math.floor(Number(byteCount) || 0));
  if (!targetBytes) return Buffer.alloc(0);
  const file = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(targetBytes);
    const { bytesRead } = await file.read(buffer, 0, targetBytes, 0);
    return bytesRead < targetBytes ? buffer.slice(0, bytesRead) : buffer;
  } finally {
    await file.close().catch(() => {});
  }
}

function formatSmartDownloadOverloadedMessage(value) {
  const timestamp = new Date(value || Date.now()).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return '[' + timestamp + '] ' + SMART_DOWNLOAD_OVERLOADED_MESSAGE;
}

function isSmartDownloadOverloadedMessage(value) {
  const message = sanitizeString(String(value || ''), 2048) || '';
  return message.replace(/^\[[^\]]+\]\s*/, '') === SMART_DOWNLOAD_OVERLOADED_MESSAGE;
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
    this.activeAbortControllers = new Set();
    this.activeForegroundOperation = null;
    this.sessionManualBearerToken = '';
    this.draftPublishLock = Promise.resolve();
  }

  async initialize() {
    await this.store.initialize();
    this.state = await this.store.getState();
    this.state.session = normalizeStoredSession(this.state.session);
    const settings = this.state.settings || {};
    if (!settings.downloadDir) {
      settings.downloadDir = this.defaultDownloadDir;
      settings.download_dir_mode = 'root';
    } else if (settings.download_dir_mode !== 'root') {
      settings.downloadDir = migrateDownloadDirToRoot(settings.downloadDir);
      settings.download_dir_mode = 'root';
    }
    if (!settings.published_download_mode) settings.published_download_mode = 'smart';
    settings.audio_mode = normalizeBackupAudioMode(settings.audio_mode);
    settings.framing_mode = normalizeBackupFramingMode(settings.framing_mode);
    if (!settings.selectedScope) settings.selectedScope = 'ownPosts';
    if (!settings.character_handle) settings.character_handle = '';
    if (!settings.character_drafts_handle) settings.character_drafts_handle = '';
    settings.manual_bearer_token = '';
    settings.manual_cookie_header = normalizeManualCookieHeader(settings.manual_cookie_header);
    delete settings.profile;
    settings.theme = 'dark';
    this.state.settings = settings;
    this._setSessionManualBearerToken('');
    await this.session.setManualAuth(this._getSessionManualBearerToken(), settings.manual_cookie_header);
    const legacyAccountKey = buildAccountStateKey(this.state.session && this.state.session.authenticated ? this.state.session.user : null);
    this.state.accountStates = normalizeAccountStatesCatalog(this.state.accountStates, this.state, legacyAccountKey);
    const initialAccountKey = this.state.session && this.state.session.authenticated
      ? (sanitizeString(this.state.activeAccountKey, 256) || legacyAccountKey)
      : DEFAULT_ACCOUNT_STATE_KEY;
    this._activateAccountState(initialAccountKey, { persistCurrent: false });
    await this._hydrateSavedCatalogFromRuns(this._getActiveAccountKey());
    await this._saveState();
  }

  _getSessionManualBearerToken() {
    return normalizeManualBearerToken(this.sessionManualBearerToken);
  }

  _setSessionManualBearerToken(value) {
    this.sessionManualBearerToken = normalizeManualBearerToken(value);
    return this.sessionManualBearerToken;
  }

  _buildPublicSettings() {
    return buildPublicSettings(Object.assign({}, this.state.settings, {
      manual_bearer_token: this._getSessionManualBearerToken(),
    }));
  }

  _getActiveManualDraftAuth() {
    return {
      manualBearerToken: this._getSessionManualBearerToken(),
      manualCookieHeader: normalizeManualCookieHeader(
        this.state && this.state.settings && this.state.settings.manual_cookie_header
      ),
    };
  }

  _getActiveAccountKey() {
    return sanitizeString(this.state && this.state.activeAccountKey, 256) || DEFAULT_ACCOUNT_STATE_KEY;
  }

  _ensureAccountStatesCatalog() {
    if (!this.state) return {};
    const legacyAccountKey = buildAccountStateKey(this.state.session && this.state.session.authenticated ? this.state.session.user : null);
    this.state.accountStates = normalizeAccountStatesCatalog(this.state.accountStates, this.state, legacyAccountKey);
    return this.state.accountStates;
  }

  _ensureScopedAccountState(accountKey) {
    const key = sanitizeString(accountKey, 256) || DEFAULT_ACCOUNT_STATE_KEY;
    const catalog = this._ensureAccountStatesCatalog();
    catalog[key] = normalizeScopedAccountState(catalog[key] || createEmptyScopedAccountState());
    return catalog[key];
  }

  _persistCurrentAccountState() {
    if (!this.state) return;
    const key = this._getActiveAccountKey();
    const scoped = this._ensureScopedAccountState(key);
    scoped.lastRunId = sanitizeString(this.state.lastRunId, 128) || '';
    scoped.bucketCatalog = normalizeBackupBucketCatalog(this.state.bucketCatalog || createEmptyBackupBucketCatalog());
    scoped.savedCatalog = normalizeSavedBackupCatalog(this.state.savedCatalog || createEmptySavedBackupCatalog());
    scoped.cacheResetCatalog = normalizeCacheResetCatalog(this.state.cacheResetCatalog);
    scoped.completeScanCatalog = normalizeCompleteScanCatalog(this.state.completeScanCatalog);
    scoped.draftPublishUsage = ensureCurrentDraftPublishUsage(this.state.draftPublishUsage);
    scoped.draftSharedLinkCatalog = normalizeDraftSharedLinkCatalog(this.state.draftSharedLinkCatalog || createEmptyDraftSharedLinkCatalog());
    scoped.draftSharedLinkCatalogVersion = Math.max(0, Math.floor(Number(this.state.draftSharedLinkCatalogVersion) || 0));
    scoped.scanResumeCatalog = normalizeScanResumeCatalog(this.state.scanResumeCatalog || createEmptyScanResumeCatalog());
    scoped.savedCatalogVersion = SAVED_CATALOG_VERSION;
    scoped.savedCatalogHydrated = scoped.savedCatalogHydrated === true;
  }

  _loadAccountStateToRoot(accountKey) {
    const key = sanitizeString(accountKey, 256) || DEFAULT_ACCOUNT_STATE_KEY;
    const scoped = this._ensureScopedAccountState(key);
    this.state.activeAccountKey = key;
    this.state.lastRunId = scoped.lastRunId || '';
    this.state.bucketCatalog = normalizeBackupBucketCatalog(scoped.bucketCatalog || createEmptyBackupBucketCatalog());
    this.state.savedCatalog = normalizeSavedBackupCatalog(scoped.savedCatalog || createEmptySavedBackupCatalog());
    this.state.cacheResetCatalog = normalizeCacheResetCatalog(scoped.cacheResetCatalog);
    this.state.completeScanCatalog = normalizeCompleteScanCatalog(scoped.completeScanCatalog);
    this.state.draftPublishUsage = ensureCurrentDraftPublishUsage(scoped.draftPublishUsage);
    this.state.draftSharedLinkCatalog = normalizeDraftSharedLinkCatalog(scoped.draftSharedLinkCatalog || createEmptyDraftSharedLinkCatalog());
    this.state.draftSharedLinkCatalogVersion = Math.max(0, Math.floor(Number(scoped.draftSharedLinkCatalogVersion) || 0));
    this.state.scanResumeCatalog = normalizeScanResumeCatalog(scoped.scanResumeCatalog || createEmptyScanResumeCatalog());
    this.state.savedCatalogVersion = Math.max(0, Math.floor(Number(scoped.savedCatalogVersion) || 0));
    this.state.savedCatalogHydrated = scoped.savedCatalogHydrated === true;
  }

  _activateAccountState(accountKey, options) {
    const settings = options && typeof options === 'object' ? options : {};
    if (settings.persistCurrent !== false) {
      this._persistCurrentAccountState();
    }
    this._loadAccountStateToRoot(accountKey);
  }

  async _saveState() {
    this._persistCurrentAccountState();
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
      settings: this._buildPublicSettings(),
      session: Object.assign({ authenticated: false, checkedAt: 0, user: null }, this.state.session || {}),
      run: run,
      bucket_progress: this._buildBucketProgressSnapshot(run, items || [], this.state.settings),
      draft_publish_usage: buildDraftPublishUsageSnapshot(this.state.draftPublishUsage),
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
    const staleItems = await this.store.getItems(runRecord.id);
    let itemsChanged = false;
    const normalizedItems = Array.isArray(staleItems)
      ? staleItems.map((item) => {
        if (normalizeItemStatus(item && item.status) !== 'downloading') return item;
        itemsChanged = true;
        return Object.assign({}, item, {
          status: 'queued',
        });
      })
      : [];
    runRecord.status = 'cancelled';
    runRecord.cancelled_at = now;
    runRecord.updated_at = now;
    runRecord.active_item_key = '';
    runRecord.summary_text = 'Backup cancelled.';
    await this.store.saveRun(runRecord);
    if (itemsChanged) {
      await this.store.saveItems(runRecord.id, normalizedItems);
    }
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
          .filter((value) => CLEARABLE_CACHE_MODE_KEYS.indexOf(value) >= 0)
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
    const nextSavedCatalog = normalizeSavedBackupCatalog(this.state.savedCatalog || createEmptySavedBackupCatalog());
    const nextResetCatalog = normalizeCacheResetCatalog(this.state.cacheResetCatalog);
    const nextCompleteScanCatalog = normalizeCompleteScanCatalog(this.state.completeScanCatalog);
    const nextScanResumeCatalog = normalizeScanResumeCatalog(this.state.scanResumeCatalog || createEmptyScanResumeCatalog());
    const resetAt = Date.now();

    for (let index = 0; index < modes.length; index += 1) {
      const bucketKey = modes[index];
      if (CLEARABLE_CACHE_BUCKET_KEYS.indexOf(bucketKey) >= 0) {
        nextBucketCatalog[bucketKey] = [];
        nextSavedCatalog[bucketKey] = bucketKey === 'ownPrompts' ? [] : {};
        nextResetCatalog[bucketKey] = resetAt;
        if (Object.prototype.hasOwnProperty.call(nextCompleteScanCatalog, bucketKey)) {
          nextCompleteScanCatalog[bucketKey] = null;
        }
        if (Object.prototype.hasOwnProperty.call(nextScanResumeCatalog, bucketKey)) {
          nextScanResumeCatalog[bucketKey] = null;
        }
      } else if (bucketKey === 'postStats') {
        nextResetCatalog.postStats = resetAt;
      }
    }

    for (let index = 0; index < characters.length; index += 1) {
      const handle = characters[index];
      delete nextBucketCatalog.characterPosts[handle];
      delete nextBucketCatalog.characterDrafts[handle];
      delete nextSavedCatalog.characterPosts[handle];
      delete nextSavedCatalog.characterDrafts[handle];
      delete nextCompleteScanCatalog.characterPosts[handle];
      delete nextCompleteScanCatalog.characterDrafts[handle];
      delete nextScanResumeCatalog.characterPosts[handle];
      delete nextScanResumeCatalog.characterDrafts[handle];
      nextResetCatalog.characterPosts[handle] = resetAt;
      nextResetCatalog.characterDrafts[handle] = resetAt;
    }

    this.state.bucketCatalog = nextBucketCatalog;
    this.state.savedCatalog = nextSavedCatalog;
    this.state.cacheResetCatalog = nextResetCatalog;
    this.state.completeScanCatalog = nextCompleteScanCatalog;
    this.state.scanResumeCatalog = nextScanResumeCatalog;
    await this._saveState();
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
    nextSettings.download_dir_mode = 'root';
    const nextManualBearerToken = normalizeManualBearerToken(
      Object.prototype.hasOwnProperty.call(partial || {}, 'manual_bearer_token')
        ? (partial || {}).manual_bearer_token
        : this._getSessionManualBearerToken()
    );
    nextSettings.manual_cookie_header = normalizeManualCookieHeader(
      Object.prototype.hasOwnProperty.call(nextSettings, 'manual_cookie_header')
        ? nextSettings.manual_cookie_header
        : this.state.settings.manual_cookie_header
    );
    nextSettings.manual_bearer_token = '';
    delete nextSettings.profile;
    this.state.settings = nextSettings;
    this._setSessionManualBearerToken(nextManualBearerToken);
    await this.session.setManualAuth(this._getSessionManualBearerToken(), nextSettings.manual_cookie_header);
    await this._saveState();
    return this._buildPublicSettings();
  }

  async openLoginWindow() {
    const result = await this.session.openLoginWindow();
    return Object.assign({ ok: true }, result);
  }

  async checkSession() {
    let sessionStatus = await this.session.checkAuth();
    const revokedManualBearer =
      !!this._getSessionManualBearerToken() &&
      Number(sessionStatus && sessionStatus.status) === 401 &&
      /token_revoked|invalidated oauth token/i.test(String(sessionStatus && sessionStatus.error || ''));
    if (revokedManualBearer) {
      this.state.settings = Object.assign({}, this.state.settings, {
        manual_bearer_token: '',
        manual_cookie_header: '',
      });
      this._setSessionManualBearerToken('');
      await this.session.setManualAuth('', '');
      sessionStatus = await this.session.checkAuth();
    }
    if (sessionStatus && sessionStatus.authenticated) {
      const nextAccountKey = buildAccountStateKey(sessionStatus.user || {});
      if (nextAccountKey !== this._getActiveAccountKey()) {
        this._activateAccountState(nextAccountKey);
      }
      await this._hydrateSavedCatalogFromRuns(this._getActiveAccountKey());
      await this.session.close().catch(() => {});
    } else if (this._getActiveAccountKey() !== DEFAULT_ACCOUNT_STATE_KEY) {
      this._activateAccountState(DEFAULT_ACCOUNT_STATE_KEY);
    }
    this.state.session = {
      authenticated: sessionStatus.authenticated === true,
      checkedAt: Date.now(),
      user: sessionStatus.user || null,
      status: sessionStatus.status || 0,
      error: sessionStatus.error || '',
    };
    await this._saveState();
    return { ok: true, session: this.state.session, bootstrap: await this.getBootstrap() };
  }

  async connectWithBearerToken(value) {
    const payload = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { token: value, cookie: '' };
    const token = normalizeManualBearerToken(payload.token);
    const cookieHeader = normalizeManualCookieHeader(payload.cookie);
    if (!token) {
      return { ok: false, error: 'backup_manual_bearer_missing' };
    }

    const previousAuthToken = normalizeManualBearerToken(
      (this.session.getCapturedHeaders && this.session.getCapturedHeaders().Authorization) ||
      this._getSessionManualBearerToken() ||
      ''
    );
    const wasAuthenticated = !!(this.state && this.state.session && this.state.session.authenticated);
    const changedAccountToken = wasAuthenticated && previousAuthToken && !sameNormalizedBearerToken(previousAuthToken, token);

    this.state.settings = Object.assign({}, this.state.settings, {
      manual_bearer_token: '',
      manual_cookie_header: cookieHeader,
    });
    this._setSessionManualBearerToken(token);
    await this.session.setManualAuth(this._getSessionManualBearerToken(), cookieHeader);
    await this._saveState();

    const sessionCheck = await this.checkSession();
    if (sessionCheck && sessionCheck.session && sessionCheck.session.authenticated) {
      const successMessageParts = [];
      if (changedAccountToken) {
        successMessageParts.push('Bearer token accepted! You are now connected to a new account.');
      }
      return {
        ok: true,
        session: sessionCheck.session,
        settings: this._buildPublicSettings(),
        message: successMessageParts.join(' '),
        bootstrap: sessionCheck.bootstrap || null,
      };
    }

    this.state.settings = Object.assign({}, this.state.settings, {
      manual_bearer_token: '',
      manual_cookie_header: '',
    });
    this._setSessionManualBearerToken('');
    await this.session.setManualAuth('', '');
    await this._saveState();

    return {
      ok: false,
      error: 'backup_manual_bearer_invalid',
      session: sessionCheck && sessionCheck.session ? sessionCheck.session : null,
    };
  }

  async logoutSession() {
    if (this.currentJob && !isTerminalRunStatus(this.currentJob.run && this.currentJob.run.status)) {
      return { ok: false, error: 'backup_run_in_progress', bootstrap: await this.getBootstrap() };
    }
    this._activateAccountState(DEFAULT_ACCOUNT_STATE_KEY);
    this.state.settings = Object.assign({}, this.state.settings, {
      manual_bearer_token: '',
      manual_cookie_header: '',
    });
    this._setSessionManualBearerToken('');
    await this.session.clearAuthState();
    this.state.session = {
      authenticated: false,
      checkedAt: Date.now(),
      user: null,
      status: 0,
      error: '',
    };
    await this._saveState();
    return {
      ok: true,
      session: this.state.session,
      settings: this._buildPublicSettings(),
      bootstrap: await this.getBootstrap(),
    };
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
    if ((scopes.castInDrafts || scopes.characterDrafts) && settings.published_download_mode === 'smart') {
      settings.published_download_mode = 'direct_sora';
    }
    settings.downloadDir = payload && payload.downloadDir ? payload.downloadDir : this.state.settings.downloadDir;
    await this.updateSettings({
      downloadDir: settings.downloadDir,
      published_download_mode: settings.published_download_mode,
      audio_mode: settings.audio_mode,
      framing_mode: settings.framing_mode,
      character_handle: settings.character_handle,
      character_drafts_handle: settings.character_drafts_handle,
      selectedScope: Object.keys(scopes).find((key) => scopes[key] === true) || 'ownPosts',
    });

    const sessionCheck = await this.checkSession();
    if (!sessionCheck.session || !sessionCheck.session.authenticated) {
      return { ok: false, error: 'backup_missing_auth_session' };
    }
    if (backupRequiresManualDraftCookie(scopes, settings)) {
      const activeAuth = this._getActiveManualDraftAuth();
      if (!hasRequiredManualDraftAuth(Object.assign({}, this.state && this.state.settings, {
        manual_bearer_token: activeAuth.manualBearerToken,
        manual_cookie_header: activeAuth.manualCookieHeader,
      }))) {
        return { ok: false, error: 'backup_draft_manual_auth_required' };
      }
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
      draftPublishCount: 0,
      lastDraftPublishStartedAt: 0,
    };

    this.currentJob = job;
    this.state.lastRunId = run.id;
    await this._saveState();
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
    if (this.activeForegroundOperation) {
      this.activeForegroundOperation.cancelRequested = true;
    }
    if (!this.currentJob || isTerminalRunStatus(this.currentJob.run.status)) {
      if (this.activeForegroundOperation) {
        this._abortActiveWork();
      }
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

  async _runCancelableForegroundOperation(kind, executor) {
    if (this.activeForegroundOperation) {
      throw new Error('foreground_operation_in_progress');
    }
    const operation = {
      kind: sanitizeString(kind, 64) || 'foreground_operation',
      cancelRequested: false,
    };
    this.activeForegroundOperation = operation;
    try {
      return await executor(operation);
    } catch (error) {
      if (operation.cancelRequested && !(error instanceof BackupCancelledError)) {
        throw new BackupCancelledError();
      }
      throw error;
    } finally {
      if (this.activeForegroundOperation === operation) {
        this.activeForegroundOperation = null;
      }
    }
  }

  _throwIfForegroundOperationCancelled(operation) {
    if (operation && operation.cancelRequested) {
      throw new BackupCancelledError();
    }
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
    if (!targetRunId) {
      return path.join(this.state.settings.downloadDir || this.defaultDownloadDir, '__placeholder__');
    }
    const run = this.currentJob && this.currentJob.run.id === targetRunId
      ? this.currentJob.run
      : await this.store.getRun(targetRunId);
    if (!run) {
      return path.join(this.state.settings.downloadDir || this.defaultDownloadDir, '__placeholder__');
    }
    const scopes = normalizeBackupScopes(run.scopes);
    const bucketKey = Object.keys(scopes).find((key) => scopes[key] === true) || 'ownPosts';
    return path.join(run.download_dir || this.state.settings.downloadDir, buildBackupFolderName(run, bucketKey));
  }

  _isPromptExportRun(run) {
    const scopes = normalizeBackupScopes(run && run.scopes);
    return scopes.ownPrompts === true;
  }

  async _runBackup(job) {
    try {
      await this._discover(job);
      if (job.cancelRequested) throw new BackupCancelledError();
      if (job.draftPublishLimitReached) {
        await this._finalizeDraftPublishLimitedRun(job);
        return;
      }

      await this.store.saveItems(job.run.id, job.items);

      if (this._isPromptExportRun(job.run)) {
        this._setRunDiagnostic(job, { phase: 'exporting_prompts', reason: 'Building prompts CSV.' });
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
        job.run.summary_text =
          'Prompt export complete. ' +
          promptExport.uniqueCount +
          ' unique prompts saved, ' +
          promptExport.skippedCount +
          ' skipped.' +
          this._buildDraftPublishSummarySuffix(job);
        await this._persistJob(job, true);
        await this.store.exportManifest(job.run, job.items, 'manifest');
        await this.store.exportManifest(job.run, job.items, 'failures');
        await this.store.exportManifest(job.run, job.items, 'summary');
        this._emitStatus(job);
        return;
      }

      if ((Number(job.run.counts.queued) || 0) > 0) {
        this._setRunDiagnostic(job, { phase: 'downloading_batch', reason: 'Discovery finished. Starting queued downloads.' });
        job.run.status = 'running';
        job.run.summary_text = 'Discovery complete. ' + job.run.counts.queued + ' files queued.';
        job.run.updated_at = Date.now();
        await this._downloadQueuedItems(job);
      }

      if (job.cancelRequested) throw new BackupCancelledError();
      if (job.draftPublishLimitReached) {
        await this._finalizeDraftPublishLimitedRun(job);
        return;
      }

      job.run.status = 'completed';
      this._setRunDiagnostic(job, { phase: 'completed', reason: '' });
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
        ' skipped.' +
        this._buildDraftPublishSummarySuffix(job);
      await this._persistJob(job, true);
      await this.store.exportManifest(job.run, job.items, 'manifest');
      await this.store.exportManifest(job.run, job.items, 'failures');
      await this.store.exportManifest(job.run, job.items, 'summary');
      this._emitStatus(job);
    } catch (error) {
      if (error instanceof BackupCancelledError) {
        job.run.status = 'cancelled';
        this._setRunDiagnostic(job, { phase: 'cancelled', reason: '' });
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
      this._setRunDiagnostic(job, {
        phase: 'scanning',
        bucket: bucket.key,
        reason: 'Scanning ' + bucket.key + ' for new items.',
      });
      job.run.summary_text = 'Discovering ' + bucket.key + '…';
      job.run.updated_at = Date.now();
      await this.store.saveRun(job.run);
      this._emitStatus(job);

      const resumeEntry = this._supportsCrossRunScanResumeCache(bucket.key)
        ? this._getScanResumeEntry(job.run, bucket.key)
        : null;
      if (resumeEntry && resumeEntry.runId && resumeEntry.runId !== job.run.id) {
        this._setRunDiagnostic(job, {
          phase: 'resuming',
          bucket: bucket.key,
          reason: 'Resuming from the last unfinished page.',
        });
        job.run.summary_text = 'Resuming ' + bucket.key + ' from the last unfinished page…';
        job.run.updated_at = Date.now();
        await this.store.saveRun(job.run);
        this._emitStatus(job);
        const loaded = await this._loadCachedBucketItems(job, bucket, resumeEntry.runId, order, { preserveStatus: true });
        if (loaded > 0) {
          order += loaded;
          await this._refreshBucketCatalog(job);
          await this.store.saveItems(job.run.id, job.items);
          if (this._shouldDownloadIncrementalBatch(bucket.key)) {
            await this._downloadIncrementalBatch(job, bucket);
            if (job.cancelRequested || job.draftPublishLimitReached) return;
          }
        }
      }

      const completeScanEntry = this._supportsCompleteScanCache(bucket.key)
        ? this._getCompleteScanEntry(job.run, bucket.key)
        : null;
      if (
        completeScanEntry &&
        completeScanEntry.runId &&
        completeScanEntry.runId !== job.run.id &&
        !(resumeEntry && resumeEntry.runId && resumeEntry.runId !== job.run.id)
      ) {
        this._setRunDiagnostic(job, {
          phase: 'loading_cached',
          bucket: bucket.key,
          reason: 'Using locally cached scan results.',
        });
        job.run.summary_text = 'Loading cached ' + bucket.key + ' from previous scan…';
        job.run.updated_at = Date.now();
        await this.store.saveRun(job.run);
        this._emitStatus(job);
        const loaded = await this._loadCachedBucketItems(job, bucket, completeScanEntry.runId, order);
        if (loaded > 0) {
          order += loaded;
          await this._refreshBucketCatalog(job);
          await this.store.saveItems(job.run.id, job.items);
          if (this._shouldDownloadIncrementalBatch(bucket.key)) {
            await this._downloadIncrementalBatch(job, bucket);
            if (job.cancelRequested || job.draftPublishLimitReached) return;
          }
          job.run.summary_text = 'Loaded ' + loaded + ' cached ' + bucket.key + ' items (skipped re-scan).';
          job.run.updated_at = Date.now();
          await this.store.saveRun(job.run);
          this._emitStatus(job);
          continue;
        }
      }

      let cursor = (resumeEntry || {}).nextCursor || null;
      let pageNumber = 0;
      const seenCursors = new Set();
      if (cursor) seenCursors.add(cursor);

      do {
        let json = null;
        let discoveredInPage = 0;
        await this._runScanPageWithSafeguard(job, bucket, pageNumber + 1, async () => {
          this._throwIfCancelled(job);
          const params = Object.assign({ limit: bucket.limit, cursor: cursor }, bucket.extraParams || {});
          if (bucket.key === 'characterPosts') {
            json = await this.session.fetchCharacterPostsJson(bucket.character_handle, params, { signal: this._createActiveAbortSignal() });
          } else if (bucket.key === 'characterDrafts') {
            json = await this.session.fetchCharacterDraftsJson(bucket.character_drafts_handle, params, { signal: this._createActiveAbortSignal() });
          } else {
            if (!bucket.pathname) throw new Error('backup_bucket_missing_pathname');
            const response = await this.session.fetchJson(bucket.pathname, params, { signal: this._createActiveAbortSignal() });
            json = response.json || {};
          }

          if (!ownPostsFirstPage && bucket.key === 'ownPosts') ownPostsFirstPage = json;
          if (!(job.run.current_user && (job.run.current_user.handle || job.run.current_user.id))) {
            job.run.current_user = await this._resolveCurrentUser(ownPostsFirstPage);
          }

          const items = extractItemsFromPayload(json);
          for (let index = 0; index < items.length; index += 1) {
            this._throwIfCancelled(job);
            const listItem = items[index];
            if (bucket.kind === 'draft' && isTemporaryEditorDraftArtifact(listItem)) {
              continue;
            }
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
        });

        pageNumber += 1;
        await this._refreshBucketCatalog(job);
        this._setRunDiagnostic(job, {
          phase: 'scanning',
          bucket: bucket.key,
          reason: 'Page ' + pageNumber + ' scanned. ' + job.run.counts.discovered + ' accepted in this run so far.',
        });
        job.run.summary_text = 'Discovering ' + bucket.key + ': page ' + pageNumber + ', accepted ' + job.run.counts.discovered;
        job.run.updated_at = Date.now();
        await this.store.saveRun(job.run);
        this._emitStatus(job);

        const nextCursor = extractCursorFromPayload(json);
        await this.store.saveItems(job.run.id, job.items);
        if (nextCursor && this._supportsCrossRunScanResumeCache(bucket.key)) {
          await this._setScanResumeEntry(job.run, bucket.key, {
            runId: job.run.id,
            nextCursor: nextCursor,
            updatedAt: Date.now(),
          });
        } else {
          await this._setScanResumeEntry(job.run, bucket.key, null);
          if (this._supportsCompleteScanCache(bucket.key)) {
            await this._setCompleteScanEntry(job.run, bucket.key, {
              runId: job.run.id,
              completedAt: Date.now(),
            });
          }
        }

        if (this._shouldDownloadIncrementalBatch(bucket.key) && discoveredInPage > 0) {
          await this._downloadIncrementalBatch(job, bucket);
          if (job.cancelRequested || job.draftPublishLimitReached) return;
        }

        if (nextCursor && !seenCursors.has(nextCursor)) {
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        } else {
          cursor = null;
        }
      } while (cursor);
    }
  }

  async _loadCachedBucketItems(job, bucket, runId, startOrder, options) {
    try {
      const settings = options && typeof options === 'object' ? options : {};
      const preserveStatus = settings.preserveStatus === true;
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
        const previousStatus = normalizeItemStatus(source.status);
        const nextStatus = preserveStatus && (previousStatus === 'done' || previousStatus === 'failed' || previousStatus === 'skipped')
          ? previousStatus
          : 'queued';
        const item = Object.assign({}, source, {
          item_key: makeBackupItemKey(job.run.id, source.kind, source.id),
          run_id: job.run.id,
          order: startOrder + count,
          status: nextStatus,
          attempts: nextStatus === 'queued' ? 0 : (Number(source.attempts) || 0),
          last_error: nextStatus === 'queued' ? '' : (source.last_error || ''),
          filename: buildBackupFilename(job.run, source.bucket, source.id, source.media_ext),
        });
        job.items.push(item);
        job.run.counts.discovered += 1;
        job.run.bucket_counts[bucket.key] = (Number(job.run.bucket_counts[bucket.key]) || 0) + 1;
        job.run.counts = applyBackupStatusTransition(job.run.counts, null, nextStatus);
        count += 1;
      }
      return count;
    } catch (_err) {
      return 0;
    }
  }

  async _runScanPageWithSafeguard(job, bucket, pageNumber, worker) {
    const targetPage = Math.max(1, Math.floor(Number(pageNumber) || 1));
    const bucketKey = sanitizeString(bucket && bucket.key, 64) || 'unknown';
    const task = typeof worker === 'function' ? worker : async () => {};

    for (let attempt = 1; attempt <= SCAN_PROGRESS_STALL_MAX_ATTEMPTS; attempt += 1) {
      let timeoutId = null;
      let timedOut = false;
      try {
        await Promise.race([
          Promise.resolve().then(() => task()),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              this._abortActiveWork();
              reject(new Error('backup_scan_stalled'));
            }, SCAN_PROGRESS_STALL_TIMEOUT_MS);
          }),
        ]);
        return;
      } catch (error) {
        const isCancelled = job && job.cancelRequested;
        if (isCancelled) throw new BackupCancelledError();
        if (timedOut && attempt >= SCAN_PROGRESS_STALL_MAX_ATTEMPTS) {
          throw new Error('backup_scan_stalled');
        }
        if (!timedOut) {
          throw error;
        }
        await this._refreshBucketCatalog(job);
        await this.store.saveItems(job.run.id, job.items);
        const attemptNumber = attempt + 1;
        const stallMessage =
          'No scan progress for 60s on ' +
          bucketKey +
          ' page ' +
          targetPage +
          '. Retrying the same page (' +
          attemptNumber +
          '/' +
          SCAN_PROGRESS_STALL_MAX_ATTEMPTS +
          ')…';
        this._setRunDiagnostic(job, {
          phase: 'retrying_scan_page',
          bucket: bucketKey,
          reason: stallMessage,
        });
        job.run.summary_text = stallMessage;
        job.run.updated_at = Date.now();
        await this.store.saveRun(job.run);
        this._emitStatus(job);
        await this._waitForDelay(SCAN_PROGRESS_STALL_RETRY_DELAY_MS);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
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
        fileName: sanitizeString(item && item.id, 256) || '',
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
      buildBackupFolderName(job.run, bucketKey)
    );
    await fs.promises.mkdir(folderPath, { recursive: true });
    const csvPath = path.join(folderPath, buildPromptExportFilename(job.run));
    await this.store.writeFile(csvPath, buildPromptCsv(uniqueRows));

    return {
      path: csvPath,
      uniqueCount: uniqueRows.length,
      skippedCount: Math.max(0, job.items.length - uniqueRows.length),
    };
  }

  async _downloadQueuedItems(job) {
    const concurrency = this._getDownloadConcurrency(job);
    if (concurrency > 1) {
      await this._downloadQueuedItemsConcurrently(job, concurrency);
      return;
    }
    await this._downloadQueuedItemsSequential(job);
  }

  _getDownloadConcurrency(job) {
    const selectedScope = sanitizeString(job && job.run && job.run.settings && job.run.settings.selectedScope, 64) || '';
    const publishedDownloadMode = sanitizeString(job && job.run && job.run.settings && job.run.settings.published_download_mode, 64) || '';
    return selectedScope === 'ownDrafts' && publishedDownloadMode === 'smart'
      ? OWN_DRAFTS_DOWNLOAD_CONCURRENCY
      : 1;
  }

  async _downloadQueuedItemsConcurrently(job, concurrency) {
    const workerCount = Math.max(1, Math.floor(Number(concurrency) || 1));
    let cursor = 0;
    const nextEntry = () => {
      const entry = this._takeNextQueuedItem(job, cursor);
      if (!entry) return null;
      cursor = entry.nextIndex;
      return entry;
    };
    const workers = [];
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      workers.push((async () => {
        while (true) {
          if (job.cancelRequested || job.draftPublishLimitReached) return;
          const entry = nextEntry();
          if (!entry) return;
          await this._processQueuedDownloadEntry(job, entry);
        }
      })());
    }
    await Promise.all(workers);
  }

  async _downloadQueuedItemsSequential(job) {
    const audioMode = normalizeBackupAudioMode(job && job.run && job.run.settings && job.run.settings.audio_mode);
    const framingMode = normalizeBackupFramingMode(job && job.run && job.run.settings && job.run.settings.framing_mode);
    const publishedDownloadMode = job && job.run && job.run.settings && job.run.settings.published_download_mode;
    const shouldProcessVideo = audioMode === 'no_audiomark' || framingMode === 'social_16_9';
    let index = 0;
    while (true) {
      const nextEntry = this._takeNextQueuedItem(job, index);
      if (!nextEntry) break;
      index = nextEntry.nextIndex;
      await this._processQueuedDownloadEntry(job, nextEntry);
    }
  }

  async _processQueuedDownloadEntry(job, nextEntry) {
    const audioMode = normalizeBackupAudioMode(job && job.run && job.run.settings && job.run.settings.audio_mode);
    const framingMode = normalizeBackupFramingMode(job && job.run && job.run.settings && job.run.settings.framing_mode);
    const publishedDownloadMode = job && job.run && job.run.settings && job.run.settings.published_download_mode;
    const shouldProcessVideo = audioMode === 'no_audiomark' || framingMode === 'social_16_9';
    const item = nextEntry && nextEntry.item;
    if (!item || normalizeItemStatus(item.status) !== 'queued') return;
    this._throwIfCancelled(job);

    const preparedItem = await this._refreshBackupItemMedia(job.run, item);
    const canUseSmartProviders =
      publishedDownloadMode === 'smart' &&
      preparedItem &&
      (preparedItem.kind === 'draft' || preparedItem.kind === 'published');
    const requiresSmartDownloadProvider =
      this._requiresSmartDownloadProvider(preparedItem, publishedDownloadMode) ||
      this._shouldForceSmartDownloadProvider(job, preparedItem);
    if (!preparedItem.media_url && !canUseSmartProviders) {
      this._clearSmartDownloadRetryState(job, preparedItem);
      this._clearSmartDownloadProviderFallback(job, preparedItem);
      this._transitionItem(job, preparedItem, 'failed', {
        last_error: preparedItem.last_error || 'missing_media_url',
      });
      await this._persistJob(job, false);
      this._emitStatus(job);
      return;
    }

    const overloadWaitMs = requiresSmartDownloadProvider
      ? this._getSmartDownloadOverloadWaitMs(job)
      : 0;
    if (overloadWaitMs > 0) {
      if (nextEntry.source === 'items') {
        this._queueDeferredSmartDownloadItem(job, preparedItem);
        return;
      }
      await this._waitForSmartDownloadRecovery(job);
    }

    this._transitionItem(job, preparedItem, 'downloading', {
      attempts: (Number(preparedItem.attempts) || 0) + 1,
      last_error: '',
    });
    this._setRunDiagnostic(job, {
      phase: 'downloading',
      bucket: preparedItem.bucket,
      reason: 'Downloading ' + preparedItem.id + '.',
    });
    job.run.summary_text = 'Downloading ' + preparedItem.id + '…';
    await this._persistJob(job, false);
    this._emitStatus(job);

    const destinationPath = path.join(job.run.download_dir || this.state.settings.downloadDir, preparedItem.filename);
    const tempDownloadPath = shouldProcessVideo
      ? buildIntermediateDownloadPath(destinationPath, preparedItem.media_ext)
      : destinationPath;
    const existingOutputBackupPath = await this._stageExistingOutputFile(destinationPath);
    let downloadRequest = null;
    let doneOverrides = { last_error: '' };
    try {
      downloadRequest = await this._resolveDownloadRequest(job, preparedItem, publishedDownloadMode);
      await this._applyWatermarkDownloadThrottle(job, publishedDownloadMode);
      await downloadToFile(downloadRequest.url, tempDownloadPath, {
        acceptVideoOnErrorStatus: downloadRequest.acceptVideoOnErrorStatus,
        headers: downloadRequest.headers,
        requireVideoContentType: downloadRequest.requireVideoContentType,
        signal: this._createActiveAbortSignal(),
      });
      await this._assertDownloadLooksUsable(job, preparedItem, downloadRequest, tempDownloadPath, publishedDownloadMode);
      if (shouldProcessVideo) {
        this._setRunDiagnostic(job, {
          phase: 'processing_video',
          bucket: preparedItem.bucket,
          reason: this._buildVideoProcessingSummary(preparedItem, audioMode, framingMode),
        });
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
      await this._cleanupDraftPublishedPost(job, preparedItem);
      await this._discardStagedOutputFile(existingOutputBackupPath);
      this._resetSmartDownloadFailures(job, preparedItem);
      this._transitionItem(job, preparedItem, 'done', doneOverrides);
    } catch (error) {
      if (job.cancelRequested && String((error && error.message) || error || '') === 'download_cancelled') {
        await this._restoreStagedOutputFile(existingOutputBackupPath, destinationPath);
        throw new BackupCancelledError();
      }
      if (error && error.draftPublishLimitReached) {
        await this._restoreStagedOutputFile(existingOutputBackupPath, destinationPath);
        this._clearSmartDownloadRetryState(job, preparedItem);
        this._clearSmartDownloadProviderFallback(job, preparedItem);
        this._transitionItem(job, preparedItem, 'queued', {
          last_error: sanitizeString(String(error.userMessage || error.message || ''), 1024) || '',
        });
        job.draftPublishLimitReached = true;
        this._setRunDiagnostic(job, {
          phase: 'draft_limit_reached',
          bucket: preparedItem.bucket,
          reason: sanitizeString(String(error.userMessage || error.message || ''), 1024) || 'Draft copy-link limit reached.',
        });
        job.run.last_error = sanitizeString(String(error.userMessage || error.message || ''), 1024) || '';
        job.run.summary_text = job.run.last_error || 'Draft copy-link limit reached. Resume tomorrow.';
        await this._persistJob(job, false);
        this._emitStatus(job);
        return;
      }
      await this._removeFileIfPresent(tempDownloadPath);
      if (shouldProcessVideo && destinationPath !== tempDownloadPath) {
        await this._removeFileIfPresent(destinationPath);
      }
      await this._restoreStagedOutputFile(existingOutputBackupPath, destinationPath);
      const handledSmartFailure = await this._handleSmartDownloadFailure(job, preparedItem, error, downloadRequest, publishedDownloadMode);
      if (handledSmartFailure) {
        await this._persistJob(job, false);
        this._emitStatus(job);
        return;
      }
      this._clearSmartDownloadRetryState(job, preparedItem);
      this._clearSmartDownloadProviderFallback(job, preparedItem);
      this._transitionItem(job, preparedItem, 'failed', {
        last_error: sanitizeString(String((error && (error.userMessage || error.message)) || error || 'download_failed'), 1024) || 'download_failed',
      });
    }

    await this._persistJob(job, false);
    this._emitStatus(job);
  }

  async _resolveDownloadRequest(job, item, publishedDownloadMode) {
    if (!item) {
      throw new Error('missing_media_url');
    }

    if (publishedDownloadMode !== 'smart') {
      if (!item.media_url) throw new Error('missing_media_url');
      return {
        providerId: '',
        url: item.media_url,
        headers: {},
      };
    }

    const forceSmartProvider = this._shouldForceSmartDownloadProvider(job, item);

    if (item.kind === 'draft') {
      await this._ensureDraftSharedLink(job, item);
    } else if (item.kind === 'published' && item.media_variant === 'no_watermark' && !forceSmartProvider) {
      if (!item.media_url) throw new Error('missing_media_url');
      return {
        providerId: '',
        url: item.media_url,
        headers: {},
      };
    }

    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !smartDownload.providers.length) {
      if (item.media_url) {
        return {
          providerId: '',
          url: item.media_url,
          headers: {},
        };
      }
      throw new Error('smart_download_no_providers');
    }
    const activeProvider = smartDownload.providers[smartDownload.activeProviderIndex];
    if (item.kind !== 'draft' && item.kind !== 'published') {
      if (!item.media_url) throw new Error('missing_media_url');
      return {
        providerId: '',
        url: item.media_url,
        headers: {},
      };
    }

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

  async _getDraftPublishUsage(persistReset) {
    const nextUsage = ensureCurrentDraftPublishUsage(this.state.draftPublishUsage);
    const currentUsage = normalizeDraftPublishUsage(this.state.draftPublishUsage);
    const changed =
      nextUsage.date !== currentUsage.date ||
      nextUsage.count !== currentUsage.count ||
      nextUsage.last_published_at !== currentUsage.last_published_at;
    this.state.draftPublishUsage = nextUsage;
    if (changed && persistReset) {
      await this._saveState();
    }
    return nextUsage;
  }

  _resolveScanCatalogCharacterHandle(runOrSettings) {
    const source = runOrSettings && typeof runOrSettings === 'object'
      ? (runOrSettings.settings && typeof runOrSettings.settings === 'object'
          ? runOrSettings.settings
          : runOrSettings)
      : {};
    return normalizeCharacterHandle(source.character_handle);
  }

  _resolveScanCatalogCharacterDraftsHandle(runOrSettings) {
    const source = runOrSettings && typeof runOrSettings === 'object'
      ? (runOrSettings.settings && typeof runOrSettings.settings === 'object'
          ? runOrSettings.settings
          : runOrSettings)
      : {};
    return normalizeCharacterHandle(source.character_drafts_handle);
  }

  _getScanResumeEntry(runOrSettings, bucketKey) {
    if (!isScanResumeBucketKey(bucketKey)) return null;
    const catalog = normalizeScanResumeCatalog(this.state.scanResumeCatalog || createEmptyScanResumeCatalog());
    if (bucketKey === 'characterPosts') {
      const handle = this._resolveScanCatalogCharacterHandle(runOrSettings);
      return handle ? (catalog.characterPosts[handle] || null) : null;
    }
    if (bucketKey === 'characterDrafts') {
      const handle = this._resolveScanCatalogCharacterDraftsHandle(runOrSettings);
      return handle ? (catalog.characterDrafts[handle] || null) : null;
    }
    return catalog[bucketKey] || null;
  }

  async _setScanResumeEntry(runOrSettings, bucketKey, entry) {
    if (!isScanResumeBucketKey(bucketKey)) return;
    const catalog = normalizeScanResumeCatalog(this.state.scanResumeCatalog || createEmptyScanResumeCatalog());
    if (bucketKey === 'characterPosts') {
      const handle = this._resolveScanCatalogCharacterHandle(runOrSettings);
      if (!handle) return;
      if (entry) {
        catalog.characterPosts[handle] = normalizeScanResumeEntry(entry);
      } else {
        delete catalog.characterPosts[handle];
      }
    } else if (bucketKey === 'characterDrafts') {
      const handle = this._resolveScanCatalogCharacterDraftsHandle(runOrSettings);
      if (!handle) return;
      if (entry) {
        catalog.characterDrafts[handle] = normalizeScanResumeEntry(entry);
      } else {
        delete catalog.characterDrafts[handle];
      }
    } else {
      catalog[bucketKey] = entry ? normalizeScanResumeEntry(entry) : null;
    }
    this.state.scanResumeCatalog = catalog;
    await this._saveState();
  }

  _getCompleteScanEntry(runOrSettings, bucketKey) {
    if (!this._supportsCompleteScanCache(bucketKey)) return null;
    const catalog = normalizeCompleteScanCatalog(this.state.completeScanCatalog || createEmptyCompleteScanCatalog());
    if (bucketKey === 'characterPosts') {
      const handle = this._resolveScanCatalogCharacterHandle(runOrSettings);
      return handle ? (catalog.characterPosts[handle] || null) : null;
    }
    if (bucketKey === 'characterDrafts') {
      const handle = this._resolveScanCatalogCharacterDraftsHandle(runOrSettings);
      return handle ? (catalog.characterDrafts[handle] || null) : null;
    }
    return catalog[bucketKey] || null;
  }

  async _setCompleteScanEntry(runOrSettings, bucketKey, entry) {
    if (!this._supportsCompleteScanCache(bucketKey)) return;
    const catalog = normalizeCompleteScanCatalog(this.state.completeScanCatalog || createEmptyCompleteScanCatalog());
    if (bucketKey === 'characterPosts') {
      const handle = this._resolveScanCatalogCharacterHandle(runOrSettings);
      if (!handle) return;
      if (entry) {
        catalog.characterPosts[handle] = normalizeCompleteScanEntry(entry);
      } else {
        delete catalog.characterPosts[handle];
      }
    } else if (bucketKey === 'characterDrafts') {
      const handle = this._resolveScanCatalogCharacterDraftsHandle(runOrSettings);
      if (!handle) return;
      if (entry) {
        catalog.characterDrafts[handle] = normalizeCompleteScanEntry(entry);
      } else {
        delete catalog.characterDrafts[handle];
      }
    } else {
      catalog[bucketKey] = entry ? normalizeCompleteScanEntry(entry) : null;
    }
    this.state.completeScanCatalog = catalog;
    await this._saveState();
  }

  _getDraftSharedLinkEntry(draftId) {
    const key = sanitizeIdToken(draftId, 256) || '';
    if (!key) return null;
    const catalog = normalizeDraftSharedLinkCatalog(this.state.draftSharedLinkCatalog || createEmptyDraftSharedLinkCatalog());
    return catalog[key] || null;
  }

  _applyStoredDraftSharedLink(item) {
    if (!item || item.kind !== 'draft' || hasReadyDraftSharedLink(item)) return false;
    const candidateIds = [
      sanitizeIdToken(item.id, 256) || '',
      sanitizeIdToken(item.draft_generation_id, 256) || '',
    ].filter(Boolean);
    for (let index = 0; index < candidateIds.length; index += 1) {
      const entry = this._getDraftSharedLinkEntry(candidateIds[index]);
      if (!entry) continue;
      item.post_permalink = item.post_permalink || entry.permalink;
      item.public_post_id = item.public_post_id || entry.postId;
      return hasReadyDraftSharedLink(item);
    }
    return false;
  }

  async _rememberDraftSharedLink(item) {
    if (!item || item.kind !== 'draft' || !hasReadyDraftSharedLink(item)) return false;
    if (item.temp_public_post_id || item.temp_public_post_permalink) return false;
    const permalink = sanitizeString(item.post_permalink, 4096) || '';
    const postId = sanitizeIdToken(
      item.public_post_id || extractBackupPostIdFromPermalink(permalink),
      256
    ) || '';
    if (!permalink || !postId) return false;

    const catalog = normalizeDraftSharedLinkCatalog(this.state.draftSharedLinkCatalog || createEmptyDraftSharedLinkCatalog());
    let changed = false;
    const candidateIds = [
      sanitizeIdToken(item.id, 256) || '',
      sanitizeIdToken(item.draft_generation_id, 256) || '',
    ].filter(Boolean);
    for (let index = 0; index < candidateIds.length; index += 1) {
      const draftId = candidateIds[index];
      const current = normalizeDraftSharedLinkEntry(catalog[draftId]);
      if (current && current.permalink === permalink && current.postId === postId) continue;
      catalog[draftId] = {
        permalink,
        postId,
        updatedAt: Date.now(),
      };
      changed = true;
    }
    if (!changed) return false;
    this.state.draftSharedLinkCatalog = catalog;
    await this._saveState();
    return true;
  }

  async _forgetDraftSharedLink(item) {
    if (!item || item.kind !== 'draft') return false;
    const catalog = normalizeDraftSharedLinkCatalog(this.state.draftSharedLinkCatalog || createEmptyDraftSharedLinkCatalog());
    let changed = false;
    const candidateIds = [
      sanitizeIdToken(item.id, 256) || '',
      sanitizeIdToken(item.draft_generation_id, 256) || '',
    ].filter(Boolean);
    for (let index = 0; index < candidateIds.length; index += 1) {
      const draftId = candidateIds[index];
      if (!catalog[draftId]) continue;
      delete catalog[draftId];
      changed = true;
    }
    const hadSharedLink = !!(item.post_permalink || item.public_post_id);
    item.post_permalink = '';
    item.public_post_id = '';
    if (!changed && !hadSharedLink) return false;
    this.state.draftSharedLinkCatalog = catalog;
    await this._saveState();
    return true;
  }

  async _draftSharedLinkResolvesWithProvider(item, providerId = 'konten') {
    if (!item || item.kind !== 'draft' || !hasReadyDraftSharedLink(item)) return false;
    try {
      await resolveSmartDownloadRequest(providerId, item, { signal: this._createActiveAbortSignal() });
      return true;
    } catch (error) {
      const message = sanitizeString(String((error && error.message) || error || ''), 1024) || '';
      if (
        /视频不存在/i.test(message) ||
        /^download_http_404$/i.test(message) ||
        /^smart_download_missing_mp4_url$/i.test(message) ||
        /^smart_download_invalid_json$/i.test(message)
      ) {
        return false;
      }
      return true;
    }
  }

  _supportsCompleteScanCache(bucketKey) {
    const key = sanitizeString(bucketKey, 64) || '';
    return key === 'ownDrafts' || key === 'castInDrafts' || key === 'characterDrafts' || key === 'ownPrompts';
  }

  _supportsCrossRunScanResumeCache(bucketKey) {
    const key = sanitizeString(bucketKey, 64) || '';
    return key === 'ownDrafts' || key === 'castInDrafts' || key === 'characterDrafts' || key === 'ownPrompts';
  }

  _buildDraftPublishLimitMessage(usage) {
    const snapshot = buildDraftPublishUsageSnapshot(usage || this.state.draftPublishUsage);
    return 'Draft copy-link limit reached for ' + snapshot.date + ' (' + snapshot.count + '/' + snapshot.limit + '). Try again tomorrow.';
  }

  async _recordDraftPublishSuccess(job) {
    const usage = await this._getDraftPublishUsage(false);
    usage.count += 1;
    usage.last_published_at = Date.now();
    this.state.draftPublishUsage = usage;
    if (job) job.draftPublishCount = (Number(job.draftPublishCount) || 0) + 1;
    await this._saveState();
    return usage;
  }

  async _applyDraftPublishThrottle(job) {
    const lastStartedAt = Number(job && job.lastDraftPublishStartedAt) || 0;
    const waitMs = Math.max(0, DRAFT_LINK_PUBLISH_THROTTLE_MS - (Date.now() - lastStartedAt));
    if (waitMs > 0) {
      await this._waitForDelay(waitMs);
    }
    if (job) job.lastDraftPublishStartedAt = Date.now();
  }

  _applyPublishedPostReference(item, payload) {
    if (!item) return item;
    if (!item.source_permalink) item.source_permalink = buildBackupPermalink(item.kind, item.id);
    if (item.kind === 'draft') {
      const publishedPost = extractBackupPublishedPostReference(item.kind, payload);
      const publishedPostId = sanitizeString(
        publishedPost && (
          publishedPost.id ||
          (isBackupPublishedPostPermalink(publishedPost.permalink) ? String(publishedPost.permalink).split('/').filter(Boolean).pop() : '')
        ),
        256
      ) || '';
      const publishedPermalink = isBackupPublishedPostPermalink(publishedPost && publishedPost.permalink)
        ? publishedPost.permalink
        : (/^s_[A-Za-z0-9]+$/i.test(publishedPostId) ? buildBackupPermalink('published', publishedPostId) : '');
      if (publishedPermalink) item.post_permalink = publishedPermalink;
      if (publishedPostId) item.public_post_id = publishedPostId;
      return item;
    }
    item.post_permalink = item.post_permalink || item.source_permalink;
    item.public_post_id = item.public_post_id || item.id;
    return item;
  }

  _applyPostResponseMedia(item, responseJson) {
    if (!item || !responseJson) return;
    const media = pickBackupMediaSource('published', responseJson);
    if (!media || !media.url) return;
    if (media.variant === 'no_watermark' || media.variant === 'unknown_fallback' || !item.media_url) {
      item.media_url = media.url;
      item.media_variant = media.variant || '';
      item.media_ext = media.ext || inferFileExtension(media.url, media.mimeType) || item.media_ext || 'mp4';
      item.media_key_path = media.keyPath || item.media_key_path || '';
      item.url_refreshed_at = Date.now();
      item.last_error = '';
    }
  }

  _applyDetailToBackupItem(run, item, detail) {
    const media = pickBackupMediaSource(item.kind, detail);
    const owner = extractOwnerIdentity(detail);
    item.owner_handle = item.owner_handle || owner.handle || '';
    item.owner_id = item.owner_id || owner.id || '';
    item.prompt = item.prompt || pickPrompt(detail, null);
    item.prompt_source = item.prompt_source || pickPromptSource(detail, null);
    item.title = item.title || pickTitle(detail, null);
    this._applyPublishedPostReference(item, detail);

    if (!media || !media.url) {
      item.media_url = '';
      item.media_variant = '';
      item.media_ext = 'mp4';
      item.url_refreshed_at = 0;
      item.last_error = 'refresh_missing_media_url';
      return item;
    }

    item.media_url = media.url;
    item.media_variant = media.variant;
    item.media_ext = media.ext || inferFileExtension(media.url, media.mimeType);
    item.media_key_path = media.keyPath || '';
    item.filename = buildBackupFilename(run, item.bucket, item.id, item.media_ext);
    item.url_refreshed_at = Date.now();
    item.last_error = '';
    return item;
  }

  async _publishDraftSharedLink(job, item) {
    this._applyStoredDraftSharedLink(item);
    if (hasReadyDraftSharedLink(item)) {
      if (await this._draftSharedLinkResolvesWithProvider(item)) {
        await this._rememberDraftSharedLink(item);
        return item;
      }
      await this._forgetDraftSharedLink(item);
    }

    const usage = await this._getDraftPublishUsage(true);
    if (usage.count >= DRAFT_LINK_PUBLISH_DAILY_LIMIT) {
      const error = new Error(this._buildDraftPublishLimitMessage(usage));
      error.draftPublishLimitReached = true;
      error.userMessage = error.message;
      throw error;
    }

    let detail = null;
    try {
      detail = await this._fetchBackupDetail('draft', item.id);
    } catch (error) {
      detail = buildDraftPublishFallbackDetail(item);
      if (!detail) throw error;
    }
    this._applyDetailToBackupItem(job.run, item, detail);
    this._applyStoredDraftSharedLink(item);
    if (hasReadyDraftSharedLink(item)) {
      if (await this._draftSharedLinkResolvesWithProvider(item)) {
        await this._rememberDraftSharedLink(item);
        return item;
      }
      await this._forgetDraftSharedLink(item);
    }

    const directConsoleBody = buildDirectDraftSharedLinkPostBody(detail, item);
    if (!directConsoleBody) {
      throw new Error('draft_publish_unsupported_kind');
    }
    item.temp_public_post_id = '';
    item.temp_public_post_permalink = '';
    item.temp_public_post_cleanup_error = '';
    const { manualBearerToken, manualCookieHeader } = this._getActiveManualDraftAuth();
    if (!manualBearerToken || !manualCookieHeader) {
      throw new Error('backup_draft_manual_auth_required');
    }

    let lastErrorMessage = 'draft_publish_failed';
    for (let attempt = 1; attempt <= DRAFT_LINK_PUBLISH_MAX_ATTEMPTS; attempt += 1) {
      this._throwIfCancelled(job);
      const usageSnapshot = buildDraftPublishUsageSnapshot(this.state.draftPublishUsage);
      this._setRunDiagnostic(job, {
        phase: 'publishing_shared_link',
        bucket: item && item.bucket,
        reason:
          'Publishing draft shared link ' +
          Math.min(usageSnapshot.count + 1, usageSnapshot.limit) +
          '/' + usageSnapshot.limit +
          ' for ' + usageSnapshot.date + '.',
      });
      job.run.summary_text =
        'Publishing draft shared link ' +
        Math.min(usageSnapshot.count + 1, usageSnapshot.limit) +
        '/' + usageSnapshot.limit +
        ' for ' + usageSnapshot.date + '…';
      await this._persistJob(job, false);
      this._emitStatus(job);

      await this._applyDraftPublishThrottle(job);
      const requestReferer = buildBackupPermalink('draft', item.id);
      const directConsoleResult = await this.session.postDraftSharedLinkViaConsole(item.id, directConsoleBody, {
        pageUrl: requestReferer,
        requestReferer,
        readyTimeoutMs: 20000,
        useSentinel: true,
        warmSoraAuthSession: false,
      });
      const response = {
        ok: directConsoleResult && directConsoleResult.ok === true,
        status: Number(directConsoleResult && directConsoleResult.status) || 0,
        json: directConsoleResult && directConsoleResult.json ? directConsoleResult.json : null,
        text: sanitizeString(directConsoleResult && directConsoleResult.text, 16384) || '',
        error: sanitizeString(directConsoleResult && directConsoleResult.error, 2048) || '',
        retryAfter: sanitizeString(directConsoleResult && directConsoleResult.retryAfter, 256) || '',
        contentType: sanitizeString(directConsoleResult && directConsoleResult.contentType, 256) || '',
        request: directConsoleResult && directConsoleResult.request ? directConsoleResult.request : null,
      };

      this._applyPublishedPostReference(item, response.json || {});
      this._applyPostResponseMedia(item, response.json || {});
      const cookieSummary = summarizeCookieHeader(manualCookieHeader);
      await this._appendRunTrace(job, 'draft-publish-trace.jsonl', {
        ts: new Date().toISOString(),
        phase: 'draft_publish_attempt',
        attempt,
        item_id: item.id,
        item_key: item.item_key || '',
        source_permalink: item.source_permalink || '',
        detail_url: item.detail_url || '',
        result_source: 'manual_cookie_direct_console',
        direct_post_action: {
          ok: !!(directConsoleResult && directConsoleResult.ok),
          status: Number(directConsoleResult && directConsoleResult.status) || 0,
          error: sanitizeString(directConsoleResult && directConsoleResult.error, 2048) || '',
          pipeline: null,
        },
        console_action: {
          ok: !!(directConsoleResult && directConsoleResult.ok),
          status: Number(directConsoleResult && directConsoleResult.status) || 0,
          error: sanitizeString(directConsoleResult && directConsoleResult.error, 2048) || '',
        },
        request: {
          url: sanitizeString(response && response.request && response.request.url, 4096)
            || BACKUP_ORIGIN + '/backend/project_y/post',
          referer: requestReferer,
          body:
            response && response.request && Object.prototype.hasOwnProperty.call(response.request, 'body')
              ? response.request.body
              : directConsoleBody,
          headers: {
            accept: '*/*',
            authorization_present: !!manualBearerToken,
            content_type: 'application/json',
            referer: requestReferer,
            bearer_present: !!manualBearerToken,
            cookie_present: cookieSummary.present,
            cookie_count: cookieSummary.count,
            cookie_names: cookieSummary.names,
            cookie_source: manualCookieHeader ? 'manual_cookie_header' : 'missing',
          },
        },
        response: {
          ok: response && response.ok === true,
          status: Number(response && response.status) || 0,
          content_type: sanitizeString(response && response.contentType, 256) || '',
          json: response && response.json ? response.json : null,
          text: sanitizeString(response && response.text, 16384) || '',
          error: sanitizeString(response && response.error, 2048) || '',
        },
        network_events: Array.isArray(directConsoleResult && directConsoleResult.networkEvents)
          ? directConsoleResult.networkEvents
          : [],
        pipeline: null,
      });

      this._applyPublishedPostReference(item, response.json || {});
      this._applyPostResponseMedia(item, response.json || {});
      if (!item.post_permalink) {
        try {
          const refreshedDetail = await this._fetchBackupDetail('draft', item.id);
          this._applyDetailToBackupItem(job.run, item, refreshedDetail);
        } catch (_error) {}
      }
      this._applyStoredDraftSharedLink(item);
      if (hasReadyDraftSharedLink(item)) {
        item.temp_public_post_permalink = sanitizeString(item.post_permalink, 4096) || '';
        item.temp_public_post_id = sanitizeIdToken(
          item.public_post_id || extractBackupPostIdFromPermalink(item.post_permalink),
          256
        ) || '';
        item.temp_public_post_cleanup_error = '';
        await this._recordDraftPublishSuccess(job);
        return item;
      }

      lastErrorMessage = sanitizeString(
        response.error || (
          response.ok
            ? 'draft_shared_link_not_ready'
            : ((response.status > 0) ? ('backup_http_' + response.status) : 'draft_publish_failed')
        ),
        1024
      ) || 'draft_publish_failed';
      const retryableStatus =
        response.ok === true ||
        Number(response.status) === 0 ||
        (Number(response.status) === 403 && /just a moment/i.test(String(response.text || '')));
      if (attempt >= DRAFT_LINK_PUBLISH_MAX_ATTEMPTS || !retryableStatus) break;
      await this._waitForDelay(getBackupRetryDelayMs(response.retryAfter, attempt));
    }

    const error = new Error(lastErrorMessage);
    if (/copy-link limit reached|draft copy-link limit reached/i.test(lastErrorMessage)) {
      error.draftPublishLimitReached = true;
    }
    error.userMessage = sanitizeString(lastErrorMessage, 1024) || 'draft_publish_failed';
    throw error;
  }

  async _ensureDraftSharedLink(job, item) {
    if (!item || item.kind !== 'draft') return item;
    if (hasReadyDraftSharedLink(item)) {
      if (await this._draftSharedLinkResolvesWithProvider(item)) {
        return item;
      }
      await this._forgetDraftSharedLink(item);
    }
    const publishedItem = await this._runWithDraftPublishLock(() => this._publishDraftSharedLink(job, item));
    if (publishedItem && publishedItem.temp_public_post_id) {
      await this._waitForDelay(DRAFT_LINK_PUBLISH_SETTLE_MS);
    }
    return publishedItem;
  }

  async _runWithDraftPublishLock(worker) {
    const task = typeof worker === 'function' ? worker : async () => {};
    const previous = this.draftPublishLock || Promise.resolve();
    let release;
    this.draftPublishLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
    }
  }

  async _cleanupDraftPublishedPost(job, item) {
    const postId = sanitizeIdToken(item && item.temp_public_post_id, 256) || '';
    if (!postId) return;

    const permalink = sanitizeString(item && item.temp_public_post_permalink, 4096)
      || buildBackupPermalink('published', postId);
    const response = await this.session.deletePublishedPost(postId, {
      pageUrl: permalink,
      requestReferer: permalink,
      readyTimeoutMs: 15000,
    });

    await this._appendRunTrace(job, 'draft-publish-trace.jsonl', {
      ts: new Date().toISOString(),
      phase: 'draft_public_post_cleanup',
      item_id: item && item.id || '',
      item_key: item && item.item_key || '',
      post_id: postId,
      request: {
        url: BACKUP_ORIGIN + '/backend/project_y/post/' + encodeURIComponent(postId),
        referer: permalink,
      },
      response: {
        ok: response && response.ok === true,
        status: Number(response && response.status) || 0,
        content_type: sanitizeString(response && response.contentType, 256) || '',
        json: response && response.json ? response.json : null,
        text: sanitizeString(response && response.text, 16384) || '',
        error: sanitizeString(response && response.error, 2048) || '',
      },
      network_events: Array.isArray(response && response.networkEvents) ? response.networkEvents : [],
    });

    if (response && response.ok === true) {
      item.download_post_permalink = sanitizeString(item.post_permalink || permalink, 4096) || '';
      item.download_public_post_id = sanitizeIdToken(item.public_post_id || postId, 256) || '';
      if ((sanitizeIdToken(item.public_post_id, 256) || '') === postId) {
        item.post_permalink = '';
        item.public_post_id = '';
      }
      item.temp_public_post_id = '';
      item.temp_public_post_permalink = '';
      item.temp_public_post_cleanup_error = '';
      await this._forgetDraftSharedLink(item).catch(() => {});
      return;
    }

    item.temp_public_post_cleanup_error = sanitizeString(
      response && (response.error || response.text),
      1024
    ) || 'backup_public_post_cleanup_failed';
  }

  _shouldFetchDiscoveryDetail(bucket, owner) {
    if (!bucket || !bucket.key) return false;
    if (bucket.key === 'castInDrafts' || bucket.key === 'castInPosts') {
      return !(owner && (owner.handle || owner.id));
    }
    return false;
  }

  async _refreshBackupItemMedia(run, item) {
    this._applyStoredDraftSharedLink(item);
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
      const refreshedItem = this._applyDetailToBackupItem(run, item, detail);
      this._applyStoredDraftSharedLink(refreshedItem);
      await this._rememberDraftSharedLink(refreshedItem);
      return refreshedItem;
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

  _buildInvalidDownloadedFileError(item, inspection, downloadRequest) {
    const extLabel = (normalizeDownloadMediaExt(item && item.media_ext) || 'video').toUpperCase();
    const sizeLabel = formatDownloadSizeLabel(inspection && inspection.size);
    const isThirdPartyProviderDownload = !!(downloadRequest && downloadRequest.providerId);
    if (!inspection || inspection.size <= 0) {
      return new Error('Downloaded file was empty instead of a video.');
    }
    if (inspection.looksLikeHtml) {
      return new Error('Downloaded HTML instead of a final video file.');
    }
    if (isThirdPartyProviderDownload && !inspection.hasKnownVideoSignature) {
      return new Error('Third-party provider returned a file without a valid ' + extLabel + ' header.');
    }
    if (isThirdPartyProviderDownload && inspection.isSuspiciouslySmall) {
      return new Error(
        'Third-party provider returned a file only ' +
        sizeLabel +
        ', below the 500 KB minimum size check.'
      );
    }
    if (inspection.isSuspiciouslySmall && !inspection.hasKnownVideoSignature) {
      return new Error(
        'Downloaded file was only ' +
        sizeLabel +
        ', under the 500 KB safety threshold, and did not contain a valid ' +
        extLabel +
        ' header.'
      );
    }
    return null;
  }

  async _assertDownloadLooksUsable(job, item, downloadRequest, filePath, publishedDownloadMode) {
    if (!filePath) return;
    let stats = null;
    try {
      stats = await fs.promises.stat(filePath);
    } catch (error) {
      if (downloadRequest && downloadRequest.providerId) {
        throw this._createSmartProviderError(downloadRequest.providerId, 'download', error);
      }
      throw error;
    }
    const size = Number(stats && stats.size) || 0;
    let header = Buffer.alloc(0);
    try {
      header = await readFileHeader(filePath, Math.min(size, DOWNLOAD_VALIDATION_SNIFF_BYTES));
    } catch (error) {
      if (downloadRequest && downloadRequest.providerId) {
        throw this._createSmartProviderError(downloadRequest.providerId, 'download', error);
      }
      throw error;
    }
    const inspection = {
      size,
      looksLikeHtml: looksLikeHtmlDocument(header),
      hasKnownVideoSignature: hasKnownVideoSignature(header, item && item.media_ext),
      isSuspiciouslySmall: size > 0 && size < DOWNLOAD_VALIDATION_MIN_VIDEO_BYTES,
    };
    const validationError = this._buildInvalidDownloadedFileError(item, inspection, downloadRequest);
    if (!validationError) return;

    const canRetryViaSmartProvider = this._canRetryViaSmartProvider(job, item, publishedDownloadMode);
    if (canRetryViaSmartProvider) {
      const wrapped = this._createSmartProviderError(
        downloadRequest && downloadRequest.providerId ? downloadRequest.providerId : 'direct_media',
        'download',
        validationError
      );
      if (downloadRequest && downloadRequest.providerId) {
        wrapped.smartProviderShouldSwitch = true;
      } else {
        wrapped.smartFallbackToProvider = true;
      }
      throw wrapped;
    }

    if (downloadRequest && downloadRequest.providerId) {
      const wrapped = this._createSmartProviderError(downloadRequest.providerId, 'download', validationError);
      wrapped.smartProviderShouldSwitch = true;
      throw wrapped;
    }

    throw validationError;
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
    const { controller, signal } = this._createActiveAbortHandle();
    await new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        this._clearActiveAbortController(controller);
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

  async _stageExistingOutputFile(targetPath) {
    if (!targetPath) return '';
    try {
      const stats = await fs.promises.stat(targetPath);
      if (!stats || (typeof stats.isFile === 'function' && !stats.isFile())) return '';
    } catch (_error) {
      return '';
    }

    const backupPath = targetPath + '.svd-prev-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    try {
      await fs.promises.rename(targetPath, backupPath);
      return backupPath;
    } catch (_error) {
      return '';
    }
  }

  async _restoreStagedOutputFile(backupPath, targetPath) {
    if (!backupPath || !targetPath) return;
    try {
      await fs.promises.stat(backupPath);
    } catch (_error) {
      return;
    }
    try {
      await this._removeFileIfPresent(targetPath);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.rename(backupPath, targetPath);
    } catch (_error) {
      await this._removeFileIfPresent(backupPath);
    }
  }

  async _discardStagedOutputFile(backupPath) {
    if (!backupPath) return;
    await this._removeFileIfPresent(backupPath);
  }

  _createActiveAbortHandle() {
    const controller = new AbortController();
    this.activeAbortControllers.add(controller);
    return { controller, signal: controller.signal };
  }

  _createActiveAbortSignal() {
    return this._createActiveAbortHandle().signal;
  }

  _clearActiveAbortController(controller) {
    if (!controller || !this.activeAbortControllers) return;
    this.activeAbortControllers.delete(controller);
  }

  _abortActiveWork() {
    if (this.activeAbortControllers && this.activeAbortControllers.size) {
      const controllers = Array.from(this.activeAbortControllers);
      this.activeAbortControllers.clear();
      for (let index = 0; index < controllers.length; index += 1) {
        try {
          controllers[index].abort();
        } catch (_error) {}
      }
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
      activeProviderIndex: 0,
      consecutiveFailures: 0,
      deferredItems: [],
      deferredItemKeys: new Set(),
      forceProviderItemKeys: new Set(),
      itemAttemptedProviderIds: new Map(),
      itemRetryCounts: new Map(),
      maxRetriesPerItem: Math.max(2, providers.length * 2),
      flushDeferredNow: false,
      overloadedUntil: 0,
      overloadedMessage: '',
    };
  }

  _requiresSmartDownloadProvider(item, publishedDownloadMode) {
    return publishedDownloadMode === 'smart' && !!item && (
      item.kind === 'draft' ||
      (item.kind === 'published' && item.media_variant !== 'no_watermark')
    );
  }

  _canRetryViaSmartProvider(job, item, publishedDownloadMode) {
    if (publishedDownloadMode !== 'smart' || !item) return false;
    if (item.kind !== 'draft' && item.kind !== 'published') return false;
    return !!this._getSmartDownloadState(job);
  }

  _getSmartDownloadState(job) {
    return job && job.smartDownload && Array.isArray(job.smartDownload.providers) && job.smartDownload.providers.length
      ? job.smartDownload
      : null;
  }

  _shouldForceSmartDownloadProvider(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    return !!(
      smartDownload &&
      item &&
      item.item_key &&
      smartDownload.forceProviderItemKeys &&
      smartDownload.forceProviderItemKeys.has(item.item_key)
    );
  }

  _markItemForSmartProviderFallback(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !item || !item.item_key) return;
    smartDownload.forceProviderItemKeys.add(item.item_key);
  }

  _getSmartDownloadOverloadWaitMs(job) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload) return 0;
    return Math.max(0, Number(smartDownload.overloadedUntil) - Date.now());
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
        source: 'deferred',
      };
    }

    if (nextIndex < job.items.length) {
      return {
        item: job.items[nextIndex],
        nextIndex: nextIndex + 1,
        source: 'items',
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

  _recordSmartDownloadProviderAttempt(job, item, providerId) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !item || !item.item_key) return 0;
    const normalizedProviderId = sanitizeString(String(providerId || ''), 64) || '';
    if (!normalizedProviderId) return 0;
    let attemptedProviderIds = smartDownload.itemAttemptedProviderIds.get(item.item_key);
    if (!(attemptedProviderIds instanceof Set)) {
      attemptedProviderIds = new Set();
      smartDownload.itemAttemptedProviderIds.set(item.item_key, attemptedProviderIds);
    }
    attemptedProviderIds.add(normalizedProviderId);
    return attemptedProviderIds.size;
  }

  _hasTriedAllSmartDownloadProviders(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !item || !item.item_key) return false;
    const attemptedProviderIds = smartDownload.itemAttemptedProviderIds.get(item.item_key);
    if (!(attemptedProviderIds instanceof Set) || !attemptedProviderIds.size) return false;
    return attemptedProviderIds.size >= smartDownload.providers.length;
  }

  _clearSmartDownloadRetryState(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !item || !item.item_key) return;
    smartDownload.itemRetryCounts.delete(item.item_key);
    smartDownload.itemAttemptedProviderIds.delete(item.item_key);
  }

  _clearSmartDownloadProviderFallback(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || !item || !item.item_key) return;
    smartDownload.forceProviderItemKeys.delete(item.item_key);
  }

  _resetSmartDownloadFailures(job, item) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload) return;
    smartDownload.consecutiveFailures = 0;
    smartDownload.overloadedUntil = 0;
    smartDownload.overloadedMessage = '';
    this._clearSmartDownloadRetryState(job, item);
    this._clearSmartDownloadProviderFallback(job, item);
    if (smartDownload.deferredItems.length) {
      smartDownload.flushDeferredNow = true;
    }
  }

  async _waitForSmartDownloadRecovery(job) {
    const waitMs = this._getSmartDownloadOverloadWaitMs(job);
    if (!(waitMs > 0)) return;
    const smartDownload = this._getSmartDownloadState(job);
    const overloadedMessage = (smartDownload && smartDownload.overloadedMessage) || formatSmartDownloadOverloadedMessage();
    if (smartDownload && !smartDownload.overloadedMessage) {
      smartDownload.overloadedMessage = overloadedMessage;
    }
    this._setRunDiagnostic(job, {
      phase: 'waiting_on_provider',
      reason: overloadedMessage,
    });
    if (job && job.run && !isSmartDownloadOverloadedMessage(job.run.summary_text)) {
      job.run.summary_text = overloadedMessage;
      job.run.updated_at = Date.now();
      await this._persistJob(job, false);
      this._emitStatus(job);
    }
    await this._waitForDelay(waitMs);
    if (smartDownload) smartDownload.overloadedUntil = 0;
  }

  _switchSmartDownloadProvider(job) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || smartDownload.providers.length < 2) return false;
    smartDownload.activeProviderIndex = (smartDownload.activeProviderIndex + 1) % smartDownload.providers.length;
    smartDownload.consecutiveFailures = 0;
    smartDownload.flushDeferredNow = true;
    return true;
  }

  _shouldSwitchSmartDownloadProviderImmediately(job, error, downloadRequest) {
    const smartDownload = this._getSmartDownloadState(job);
    if (!smartDownload || smartDownload.providers.length < 2) return false;
    const failedProviderId =
      sanitizeString(
        String(
          (error && error.smartProviderId) ||
          (downloadRequest && downloadRequest.providerId) ||
          ''
        ),
        64
      ) || '';
    if (!failedProviderId) return false;
    const activeProvider = smartDownload.providers[smartDownload.activeProviderIndex];
    if (!activeProvider || activeProvider.id !== failedProviderId) return false;
    return smartDownload.activeProviderIndex < (smartDownload.providers.length - 1);
  }

  async _handleSmartDownloadFailure(job, item, error, downloadRequest, publishedDownloadMode) {
    const eligibleSmartItem = this._canRetryViaSmartProvider(job, item, publishedDownloadMode);
    if (publishedDownloadMode !== 'smart' || !eligibleSmartItem) {
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
    this._recordSmartDownloadProviderAttempt(
      job,
      item,
      (error && error.smartProviderId) || (downloadRequest && downloadRequest.providerId) || ''
    );
    if (error && error.smartFallbackToProvider) {
      this._markItemForSmartProviderFallback(job, item);
      smartDownload.consecutiveFailures = 0;
    } else {
      smartDownload.consecutiveFailures += 1;
    }
    const shouldRetryItem =
      retryCount < smartDownload.maxRetriesPerItem &&
      !this._hasTriedAllSmartDownloadProviders(job, item);
    const shouldSwitchProvider =
      !(error && error.smartFallbackToProvider) &&
      (
        this._shouldSwitchSmartDownloadProviderImmediately(job, error, downloadRequest) ||
        !!(error && error.smartProviderShouldSwitch) ||
        smartDownload.consecutiveFailures >= 2
      );
    const switchedProvider = shouldSwitchProvider && this._switchSmartDownloadProvider(job);
    const lastError = sanitizeString(String((error && error.message) || error || 'smart_download_failed'), 1024) || 'smart_download_failed';
    if (
      item &&
      item.kind === 'draft' &&
      hasReadyDraftSharedLink(item) &&
      (
        /视频不存在/i.test(lastError) ||
        /^download_http_404$/i.test(lastError) ||
        /^smart_download_missing_mp4_url$/i.test(lastError) ||
        /^smart_download_invalid_json$/i.test(lastError)
      )
    ) {
      await this._forgetDraftSharedLink(item);
    }
    if (!shouldRetryItem) {
      const overloadedMessage = smartDownload.overloadedMessage || formatSmartDownloadOverloadedMessage();
      smartDownload.overloadedMessage = overloadedMessage;
      this._clearSmartDownloadRetryState(job, item);
      smartDownload.consecutiveFailures = 0;
      smartDownload.overloadedUntil = Date.now() + SMART_DOWNLOAD_OVERLOAD_RETRY_MS;
      this._setRunDiagnostic(job, {
        phase: 'waiting_on_provider',
        bucket: item && item.bucket,
        reason: 'Re-queued ' + item.id + ' after provider failure: ' + lastError,
      });
      this._transitionItem(job, item, 'queued', {
        last_error: overloadedMessage,
      });
      job.run.active_item_key = '';
      job.run.summary_text = overloadedMessage;
      this._queueDeferredSmartDownloadItem(job, item);
      return true;
    }

    this._setRunDiagnostic(job, {
      phase: switchedProvider ? 'switching_provider' : 'requeued_provider',
      bucket: item && item.bucket,
      reason: 'Re-queued ' + item.id + ' after provider failure: ' + lastError,
    });
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
    if (previousStatus === 'downloading' && targetStatus !== 'downloading' && job.run.active_item_key === item.item_key) {
      job.run.active_item_key = '';
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
      draft_publish_usage: buildDraftPublishUsageSnapshot(this.state.draftPublishUsage),
    });
  }

  _buildDraftPublishSummarySuffix(job) {
    const publishedCount = Math.max(0, Number(job && job.draftPublishCount) || 0);
    if (!publishedCount) return '';
    const usage = buildDraftPublishUsageSnapshot(this.state.draftPublishUsage);
    return ' ' + publishedCount + ' draft shared links published (' + usage.count + '/' + usage.limit + ' used today).';
  }

  async _finalizeDraftPublishLimitedRun(job) {
    const queuedCount = Math.max(0, Number(job && job.run && job.run.counts && job.run.counts.queued) || 0);
    const usage = buildDraftPublishUsageSnapshot(this.state.draftPublishUsage);
    job.run.status = 'completed';
    job.run.completed_at = Date.now();
    job.run.updated_at = Date.now();
    job.run.active_item_key = '';
    job.run.summary_text =
      'Stopped at the draft copy-link daily limit. ' +
      (Number(job.run.counts.done) || 0) +
      ' downloaded so far, ' +
      queuedCount +
      ' still queued for the next run. ' +
      usage.count + '/' + usage.limit + ' used today.';
    await this._persistJob(job, true);
    await this.store.exportManifest(job.run, job.items, 'manifest');
    await this.store.exportManifest(job.run, job.items, 'failures');
    await this.store.exportManifest(job.run, job.items, 'summary');
    this._emitStatus(job);
  }

  _buildBucketProgressSnapshot(run, items, settings) {
    const historicalCounts = buildBackupHistoricalBucketCounts(this.state.bucketCatalog, settings || this.state.settings);
    return buildBackupBucketProgressSnapshot(run, items, historicalCounts);
  }

  async _appendRunTrace(job, filename, payload) {
    if (!job || !job.run || !job.run.id || !filename) return;
    try {
      const runDir = this.store.getRunDir(job.run.id);
      await fs.promises.mkdir(runDir, { recursive: true });
      await fs.promises.appendFile(
        path.join(runDir, filename),
        JSON.stringify(payload) + '\n',
        'utf8'
      );
    } catch (_error) {}
  }

  _setRunDiagnostic(job, updates) {
    if (!job || !job.run) return;
    const current = job.run.diagnostic && typeof job.run.diagnostic === 'object'
      ? job.run.diagnostic
      : { phase: '', bucket: '', reason: '' };
    const next = updates && typeof updates === 'object' ? updates : {};
    job.run.diagnostic = {
      phase: sanitizeString(next.phase, 64) || current.phase || '',
      bucket: sanitizeString(next.bucket, 64) || current.bucket || '',
      reason: Object.prototype.hasOwnProperty.call(next, 'reason')
        ? (sanitizeString(next.reason, 1024) || '')
        : (current.reason || ''),
    };
  }

  async _refreshBucketCatalog(job) {
    const nextCatalog = recordBackupItemsInBucketCatalog(this.state.bucketCatalog, job.run, job.items);
    const previousSerialized = JSON.stringify(this.state.bucketCatalog || {});
    const nextSerialized = JSON.stringify(nextCatalog);
    if (previousSerialized === nextSerialized) return;
    this.state.bucketCatalog = nextCatalog;
    await this._saveState();
  }

  _buildSavedIdSetsForRun(run) {
    const savedCatalog = normalizeSavedBackupCatalog(this.state.savedCatalog || createEmptySavedBackupCatalog());
    const variantKey = buildSavedCatalogVariantKey(run && run.settings);
    const characterHandle = normalizeCharacterHandle(run && run.settings && run.settings.character_handle);
    const characterDraftsHandle = normalizeCharacterHandle(run && run.settings && run.settings.character_drafts_handle);
    return {
      ownDrafts: new Set(savedCatalog.ownDrafts[variantKey] || []),
      ownPosts: new Set(savedCatalog.ownPosts[variantKey] || []),
      castInPosts: new Set(savedCatalog.castInPosts[variantKey] || []),
      castInDrafts: new Set(savedCatalog.castInDrafts[variantKey] || []),
      ownPrompts: new Set(savedCatalog.ownPrompts),
      characterPosts: new Set(
        characterHandle &&
        savedCatalog.characterPosts[characterHandle] &&
        savedCatalog.characterPosts[characterHandle][variantKey]
          ? savedCatalog.characterPosts[characterHandle][variantKey]
          : []
      ),
      characterDrafts: new Set(
        characterDraftsHandle &&
        savedCatalog.characterDrafts[characterDraftsHandle] &&
        savedCatalog.characterDrafts[characterDraftsHandle][variantKey]
          ? savedCatalog.characterDrafts[characterDraftsHandle][variantKey]
          : []
      ),
    };
  }

  _shouldTrackSavedItem(bucketKey) {
    const key = sanitizeString(bucketKey, 64) || '';
    return (
      key === 'ownPosts' ||
      key === 'ownDrafts' ||
      key === 'castInPosts' ||
      key === 'castInDrafts' ||
      key === 'characterPosts' ||
      key === 'characterDrafts'
    );
  }

  _isAlreadySaved(job, bucketKey, itemId) {
    const key = sanitizeString(bucketKey, 64) || '';
    if (!this._shouldTrackSavedItem(key)) return false;
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
    const nextCatalog = recordSavedBackupItemsInCatalog(this.state.savedCatalog, job.run, doneItems);
    const previousSerialized = JSON.stringify(this.state.savedCatalog || {});
    const nextSerialized = JSON.stringify(nextCatalog);
    if (previousSerialized === nextSerialized) return;
    this.state.savedCatalog = nextCatalog;
    await this._saveState();
  }

  _shouldDownloadIncrementalBatch(bucketKey) {
    return this._getIncrementalBatchThreshold(bucketKey) > 0;
  }

  _getIncrementalBatchThreshold(bucketKey) {
    const key = sanitizeString(bucketKey, 64) || '';
    if (key === 'characterPosts' || key === 'characterDrafts') return 1000;
    if (key === 'ownDrafts' || key === 'castInDrafts' || key === 'castInPosts') return 100;
    return 0;
  }

  async _downloadIncrementalBatch(job, bucket) {
    const batchThreshold = this._getIncrementalBatchThreshold(bucket && bucket.key);
    if (!batchThreshold) return;
    const queuedCount = (job.items || []).filter((item) => item.bucket === bucket.key && normalizeItemStatus(item.status) === 'queued').length;
    if (queuedCount < batchThreshold) return;
    await this.store.saveItems(job.run.id, job.items);
    this._setRunDiagnostic(job, {
      phase: 'downloading_batch',
      bucket: bucket.key,
      reason: 'Starting downloads for batch ' + Math.max(1, Math.ceil(queuedCount / batchThreshold)) + ' of ' + bucket.key + ' after ' + queuedCount + ' queued items reached the ' + batchThreshold + ' item threshold.',
    });
    job.run.status = 'running';
    job.run.summary_text = 'Downloading batch of ' + queuedCount + ' ' + bucket.key + ' videos…';
    job.run.updated_at = Date.now();
    await this._downloadQueuedItems(job);
    if (job.cancelRequested || job.draftPublishLimitReached) return;
    this._setRunDiagnostic(job, {
      phase: 'scanning',
      bucket: bucket.key,
      reason: 'Continuing ' + bucket.key + ' scan after incremental downloads.',
    });
    job.run.status = 'discovering';
    job.run.summary_text = 'Continuing ' + bucket.key + ' scan…';
    job.run.updated_at = Date.now();
    await this.store.saveRun(job.run);
    this._emitStatus(job);
  }

  async _hydrateSavedCatalogFromRuns(accountKey, force) {
    const targetAccountKey = sanitizeString(accountKey, 256) || this._getActiveAccountKey();
    const scoped = this._ensureScopedAccountState(targetAccountKey);
    const existingDraftSharedLinkCatalog = normalizeDraftSharedLinkCatalog(
      scoped.draftSharedLinkCatalog || createEmptyDraftSharedLinkCatalog()
    );
    const hasHydratedDraftSharedLinks = Object.keys(existingDraftSharedLinkCatalog).length > 0;
    const draftSharedLinkCatalogVersion = Math.max(0, Math.floor(Number(scoped.draftSharedLinkCatalogVersion) || 0));
    if (
      scoped.savedCatalogHydrated === true &&
      Math.max(0, Math.floor(Number(scoped.savedCatalogVersion) || 0)) >= SAVED_CATALOG_VERSION &&
      force !== true &&
      hasHydratedDraftSharedLinks &&
      draftSharedLinkCatalogVersion >= DRAFT_SHARED_LINK_CATALOG_VERSION
    ) {
      if (targetAccountKey === this._getActiveAccountKey()) {
        this.state.savedCatalog = normalizeSavedBackupCatalog(scoped.savedCatalog || createEmptySavedBackupCatalog());
        this.state.draftSharedLinkCatalog = existingDraftSharedLinkCatalog;
        this.state.draftSharedLinkCatalogVersion = draftSharedLinkCatalogVersion;
      }
      return;
    }
    const runIds = await this.store.listRunIds();
    let nextCatalog = createEmptySavedBackupCatalog();
    let nextDraftSharedLinkCatalog = createEmptyDraftSharedLinkCatalog();
    const resetCatalog = targetAccountKey === this._getActiveAccountKey()
      ? normalizeCacheResetCatalog(this.state.cacheResetCatalog)
      : normalizeCacheResetCatalog(scoped.cacheResetCatalog);
    for (let index = 0; index < runIds.length; index += 1) {
      const runId = runIds[index];
      const run = await this.store.getRun(runId);
      if (!run) continue;
      if (buildAccountStateKey(run.current_user || {}) !== targetAccountKey) continue;
      const items = await this.store.getItems(runId);
      const allDoneItems = (items || []).filter((item) => normalizeItemStatus(item && item.status) === 'done');
      const doneItems = allDoneItems.filter((item) => {
        if (normalizeItemStatus(item && item.status) !== 'done') return false;
        return this._shouldKeepSavedItemAfterCacheReset(run, item, resetCatalog);
      });
      if (doneItems.length) {
        nextCatalog = recordSavedBackupItemsInCatalog(nextCatalog, run, doneItems);
      }
      for (let itemIndex = 0; itemIndex < allDoneItems.length; itemIndex += 1) {
        const item = allDoneItems[itemIndex];
        if (!item || item.kind !== 'draft' || !hasReadyDraftSharedLink(item)) continue;
        const permalink = sanitizeString(item.post_permalink, 4096) || '';
        const postId = sanitizeIdToken(
          item.public_post_id || extractBackupPostIdFromPermalink(permalink),
          256
        ) || '';
        if (!permalink || !postId) continue;
        const candidateIds = [
          sanitizeIdToken(item.id, 256) || '',
          sanitizeIdToken(item.draft_generation_id, 256) || '',
        ].filter(Boolean);
        for (let candidateIndex = 0; candidateIndex < candidateIds.length; candidateIndex += 1) {
          const draftId = candidateIds[candidateIndex];
          const existingEntry = normalizeDraftSharedLinkEntry(nextDraftSharedLinkCatalog[draftId]);
          const nextUpdatedAt = Math.max(0, Math.floor(Number(run.completed_at || run.updated_at || Date.now()) || 0));
          if (existingEntry && Number(existingEntry.updatedAt || 0) > nextUpdatedAt) continue;
          nextDraftSharedLinkCatalog[draftId] = {
            permalink,
            postId,
            updatedAt: nextUpdatedAt,
          };
        }
      }
    }
    scoped.savedCatalog = nextCatalog;
    scoped.draftSharedLinkCatalog = normalizeDraftSharedLinkCatalog(nextDraftSharedLinkCatalog);
    scoped.draftSharedLinkCatalogVersion = DRAFT_SHARED_LINK_CATALOG_VERSION;
    scoped.savedCatalogVersion = SAVED_CATALOG_VERSION;
    scoped.savedCatalogHydrated = true;
    if (targetAccountKey === this._getActiveAccountKey()) {
      this.state.savedCatalog = normalizeSavedBackupCatalog(nextCatalog);
      this.state.draftSharedLinkCatalog = normalizeDraftSharedLinkCatalog(nextDraftSharedLinkCatalog);
      this.state.draftSharedLinkCatalogVersion = DRAFT_SHARED_LINK_CATALOG_VERSION;
      this.state.savedCatalogVersion = SAVED_CATALOG_VERSION;
      this.state.savedCatalogHydrated = true;
    }
  }

  _buildClearCacheTargets() {
    const modeTargets = CLEARABLE_CACHE_MODE_KEYS.map((key) => ({
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
    const savedCatalog = normalizeSavedBackupCatalog(this.state.savedCatalog || createEmptySavedBackupCatalog());
    const resetCatalog = normalizeCacheResetCatalog(this.state.cacheResetCatalog);
    const bucketPostHandles = new Set();
    const bucketDraftHandles = new Set();
    const savedPostHandles = new Set();
    const savedDraftHandles = new Set();
    const handles = new Set();
    Object.keys(bucketCatalog.characterPosts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      handles.add(normalizedHandle);
      bucketPostHandles.add(normalizedHandle);
    });
    Object.keys(bucketCatalog.characterDrafts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      handles.add(normalizedHandle);
      bucketDraftHandles.add(normalizedHandle);
    });
    Object.keys(savedCatalog.characterPosts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      handles.add(normalizedHandle);
      savedPostHandles.add(normalizedHandle);
    });
    Object.keys(savedCatalog.characterDrafts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      handles.add(normalizedHandle);
      savedDraftHandles.add(normalizedHandle);
    });
    Object.keys(resetCatalog.characterPosts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      if (!bucketPostHandles.has(normalizedHandle) && !savedPostHandles.has(normalizedHandle)) return;
      if (!handles.has(normalizedHandle)) handles.add(normalizedHandle);
    });
    Object.keys(resetCatalog.characterDrafts || {}).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      if (!bucketDraftHandles.has(normalizedHandle) && !savedDraftHandles.has(normalizedHandle)) return;
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
    if (bucketKey === 'characterDrafts') {
      const handle = normalizeCharacterHandle(run && run.settings && run.settings.character_drafts_handle);
      return handle ? normalizeCacheResetTimestamp(resetCatalog && resetCatalog.characterDrafts && resetCatalog.characterDrafts[handle]) : 0;
    }
    if (CLEARABLE_CACHE_BUCKET_KEYS.indexOf(bucketKey) >= 0) {
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
    this._setRunDiagnostic(job, {
      phase: 'failed',
      reason: sanitizeString(String((error && error.message) || error || 'backup_failed'), 1024) || 'backup_failed',
    });
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

  async scanPostStats(progressCallback) {
    return this._runCancelableForegroundOperation('post_stats_scan', async (operation) => {
      await this.session.ensureAuthHeaders();
      this._throwIfForegroundOperationCancelled(operation);
      const allPosts = [];
      let cursor = null;
      let page = 0;
      const seenCursors = new Set();
      const emitProgress = typeof progressCallback === 'function' ? progressCallback : () => {};

      do {
        this._throwIfForegroundOperationCancelled(operation);
        page += 1;
        let pageJson = null;
        let fetchSucceeded = false;

        for (let attempt = 1; attempt <= SCAN_PROGRESS_STALL_MAX_ATTEMPTS; attempt += 1) {
          let timeoutId = null;
          let timedOut = false;
          try {
            await Promise.race([
              (async () => {
                const params = { limit: 50, cut: 'nf2' };
                if (cursor) params.cursor = cursor;
                const response = await this.session.fetchJson('/backend/project_y/profile_feed/me', params, {
                  signal: this._createActiveAbortSignal(),
                });
                pageJson = response.json || {};
                fetchSucceeded = true;
              })(),
              new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                  timedOut = true;
                  this._abortActiveWork();
                  reject(new Error('post_stats_scan_stalled'));
                }, SCAN_PROGRESS_STALL_TIMEOUT_MS);
              }),
            ]);
            break;
          } catch (error) {
            this._throwIfForegroundOperationCancelled(operation);
            if (timedOut && attempt >= SCAN_PROGRESS_STALL_MAX_ATTEMPTS) {
              throw new Error('Post stats scan stalled on page ' + page + ' after ' + SCAN_PROGRESS_STALL_MAX_ATTEMPTS + ' attempts.');
            }
            if (!timedOut) {
              throw error;
            }
            emitProgress({
              page,
              count: allPosts.length,
              done: false,
              retrying: true,
              attempt: attempt + 1,
              maxAttempts: SCAN_PROGRESS_STALL_MAX_ATTEMPTS,
            });
            await this._waitForDelay(SCAN_PROGRESS_STALL_RETRY_DELAY_MS);
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }
        }

        this._throwIfForegroundOperationCancelled(operation);
        if (!fetchSucceeded || !pageJson) break;

        const items = extractItemsFromPayload(pageJson);
        if (!items.length) break;
        for (let i = 0; i < items.length; i += 1) {
          const entry = items[i];
          const post = entry && entry.post ? entry.post : entry;
          if (!post || !post.is_owner) continue;
          const attachment = post.attachments && post.attachments.length ? post.attachments[0] : {};
          const thumbnailEncoding = attachment.encodings && attachment.encodings.thumbnail;
          allPosts.push({
            post_id: post.id || '',
            timestamp: post.posted_at || 0,
            caption: post.text || post.caption || '',
            permalink: post.permalink || '',
            view_count: post.view_count || 0,
            unique_view_count: post.unique_view_count || 0,
            like_count: post.like_count || 0,
            reply_count: post.reply_count || 0,
            recursive_reply_count: post.recursive_reply_count || 0,
            share_count: post.share_count || 0,
            repost_count: post.repost_count || 0,
            remix_count: post.remix_count || 0,
            duration_s: attachment.duration_s || 0,
            width: attachment.width || 0,
            height: attachment.height || 0,
            thumbnail_url: (thumbnailEncoding && thumbnailEncoding.path) || '',
          });
        }

        const nextCursor = extractCursorFromPayload(pageJson);
        if (nextCursor && !seenCursors.has(nextCursor)) {
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        } else {
          cursor = null;
        }

        emitProgress({ page, count: allPosts.length, done: !cursor });
      } while (cursor);

      this._throwIfForegroundOperationCancelled(operation);
      let savedPath = null;
      if (allPosts.length > 0) {
        try {
          const downloadDir = (this.state.settings && this.state.settings.downloadDir) || this.defaultDownloadDir || '';
          if (downloadDir) {
            const sessionUserHandle = normalizeCharacterHandle(this.state && this.state.session && this.state.session.user && this.state.session.user.handle);
            const filename = sessionUserHandle
              ? ('@' + sessionUserHandle.replace(/^@+/, '') + ' post stats.csv')
              : 'my post stats.csv';
            const filePath = path.join(downloadDir, 'Stats', filename);
            const csvContent = this._buildPostStatsCsv(allPosts);
            const saved = await this.store.writeFile(filePath, csvContent);
            savedPath = saved.path;
          }
        } catch (_saveErr) {}
      }

      this._throwIfForegroundOperationCancelled(operation);
      return { posts: allPosts, savedPath };
    });
  }

  _buildPostStatsCsv(posts) {
    const headers = ['Video', 'Post Date', 'Caption', 'Post URL', 'Total Views', 'Unique Views', 'Likes', 'Replies', 'Total Replies', 'Shares', 'Reposts', 'Remixes', 'Video Duration (s)', 'Video Width', 'Video Height', 'Thumbnail URL'];
    const rows = [headers.join(',')];
    for (let i = 0; i < posts.length; i += 1) {
      const p = posts[i];
      const postDate = p.timestamp ? new Date(p.timestamp * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : '';
      rows.push([
        p.post_id,
        postDate,
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
        '"' + String(p.thumbnail_url || '').replace(/"/g, '""') + '"',
      ].join(','));
    }
    return rows.join('\n') + '\n';
  }

  async fetchCharacterStats(handle) {
    return this._runCancelableForegroundOperation('character_stats_fetch', async (operation) => {
      await this.session.ensureAuthHeaders();
      this._throwIfForegroundOperationCancelled(operation);
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) throw new Error('No character handle provided.');
      const response = await this.session.fetchJson(
        '/backend/project_y/profile/username/' + encodeURIComponent(normalizedHandle),
        {},
        { maxAttempts: 2, signal: this._createActiveAbortSignal() }
      );
      this._throwIfForegroundOperationCancelled(operation);
      const profile = response && response.json && typeof response.json === 'object' ? response.json : {};
      const downloadDir = (this.state.settings && this.state.settings.downloadDir) || this.defaultDownloadDir || '';
      if (!downloadDir) throw new Error('No download folder configured.');
      const filePath = path.join(downloadDir, 'Stats', '@' + normalizedHandle.replace(/^@+/, '') + ' stats.csv');
      const saved = await this.store.writeFile(filePath, this._buildCharacterStatsCsv(profile));
      this._throwIfForegroundOperationCancelled(operation);
      return { profile, savedPath: saved.path };
    });
  }

  _buildCharacterStatsCsv(profile) {
    const source = profile && typeof profile === 'object' ? profile : {};
    const formatTs = (ts) => ts ? new Date(Number(ts) * 1000).toISOString() : '';
    const fields = [
      ['Username', source.username],
      ['Display Name', source.display_name],
      ['Likes Received', source.likes_received_count],
      ['Posts', source.cameo_count],
      ['Created At', formatTs(source.created_at)],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '');
    const headers = fields.map(([key]) => key).join(',');
    const values = fields.map(([, value]) => {
      const stringValue = String(value);
      return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
        ? '"' + stringValue.replace(/"/g, '""') + '"'
        : stringValue;
    }).join(',');
    return headers + '\n' + values + '\n';
  }
}

module.exports = {
  BackupService,
};
