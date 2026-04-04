const path = require('path');
const backupLogic = require('../../uv-backup-logic.js');

const {
  DEFAULT_BACKUP_SCOPES,
  normalizeBackupScopes,
  normalizeBackupHeaders,
  buildBackupRunId,
  buildBackupRunStamp,
  makeBackupItemKey,
  normalizeCurrentUser,
  extractOwnerIdentity,
  sameOwnerIdentity,
  shouldExcludeAppearanceOwner,
  parseTimestampMs,
  inferFileExtension,
  isSignedUrlFresh,
  pickBackupMediaSource,
  normalizeRunStatus,
  normalizeItemStatus,
  isTerminalRunStatus,
  applyBackupStatusTransition,
  createEmptyBackupCounts,
  cloneBackupCounts,
} = backupLogic;

const BACKUP_ORIGIN = 'https://sora.chatgpt.com';
const BACKUP_DEFAULT_FEED_LIMIT = 50;
const BACKUP_DEFAULT_DRAFT_LIMIT = 50;
const BACKUP_DRAFT_DOWNLOAD_PAGE_LIMIT = 100;
const BACKUP_DOWNLOAD_FOLDER = 'Sora Video Downloader';
const BACKUP_FETCH_MAX_ATTEMPTS = 4;
const BACKUP_FETCH_RETRY_BASE_MS = 1500;
const BACKUP_FETCH_RETRY_MAX_MS = 15000;
const BACKUP_URL_REFRESH_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_HARVEST_CAST_NAMES = 32;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value, maxLen) {
  const limit = Number(maxLen) || 4096;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function sanitizeNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (Number.isFinite(min) && numeric < min) return min;
  if (Number.isFinite(max) && numeric > max) return max;
  return numeric;
}

function sanitizeIdToken(value, maxLen) {
  const token = sanitizeString(value, maxLen || 128);
  if (!token) return null;
  return /^[A-Za-z0-9:_.-]+$/.test(token) ? token : null;
}

function normalizeBackupBucketKey(value) {
  const raw = sanitizeString(value, 64) || '';
  if (
    raw === 'ownDrafts' ||
    raw === 'ownPosts' ||
    raw === 'castInPosts' ||
    raw === 'castInDrafts' ||
    raw === 'characterPosts' ||
    raw === 'ownPrompts' ||
    raw === 'characterDrafts'
  ) {
    return raw;
  }
  return '';
}

function cloneBackupBucketCounts(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    ownDrafts: Number(source.ownDrafts) || 0,
    ownPosts: Number(source.ownPosts) || 0,
    castInPosts: Number(source.castInPosts) || 0,
    castInDrafts: Number(source.castInDrafts) || 0,
    characterPosts: Number(source.characterPosts) || 0,
    ownPrompts: Number(source.ownPrompts) || 0,
    characterDrafts: Number(source.characterDrafts) || 0,
  };
}

function createEmptyBackupBucketCatalog() {
  return {
    ownDrafts: [],
    ownPosts: [],
    castInPosts: [],
    castInDrafts: [],
    characterPosts: {},
    ownPrompts: [],
    characterDrafts: {},
  };
}

function normalizeBackupBucketCatalog(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const normalized = createEmptyBackupBucketCatalog();
  normalized.ownDrafts = Array.isArray(source.ownDrafts)
    ? source.ownDrafts.map((value) => sanitizeIdToken(value, 256)).filter(Boolean)
    : [];
  normalized.ownPosts = Array.isArray(source.ownPosts)
    ? source.ownPosts.map((value) => sanitizeIdToken(value, 256)).filter(Boolean)
    : [];
  normalized.castInPosts = Array.isArray(source.castInPosts)
    ? source.castInPosts.map((value) => sanitizeIdToken(value, 256)).filter(Boolean)
    : [];
  normalized.castInDrafts = Array.isArray(source.castInDrafts)
    ? source.castInDrafts.map((value) => sanitizeIdToken(value, 256)).filter(Boolean)
    : [];
  normalized.ownPrompts = Array.isArray(source.ownPrompts)
    ? source.ownPrompts.map((value) => sanitizeIdToken(value, 256)).filter(Boolean)
    : [];
  if (isPlainObject(source.characterPosts)) {
    Object.keys(source.characterPosts).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      normalized.characterPosts[normalizedHandle] = Array.isArray(source.characterPosts[handle])
        ? source.characterPosts[handle].map((value) => sanitizeIdToken(value, 256)).filter(Boolean)
        : [];
    });
  }
  if (isPlainObject(source.characterDrafts)) {
    Object.keys(source.characterDrafts).forEach((handle) => {
      const normalizedHandle = normalizeCharacterHandle(handle);
      if (!normalizedHandle) return;
      normalized.characterDrafts[normalizedHandle] = Array.isArray(source.characterDrafts[handle])
        ? source.characterDrafts[handle].map((value) => sanitizeIdToken(value, 256)).filter(Boolean)
        : [];
    });
  }
  return normalized;
}

function recordBackupItemsInBucketCatalog(catalog, run, items) {
  const nextCatalog = normalizeBackupBucketCatalog(catalog);
  const characterHandle = normalizeCharacterHandle(run && run.settings && run.settings.character_handle);
  const characterDraftsHandle = normalizeCharacterHandle(run && run.settings && run.settings.character_drafts_handle);
  const bucketSets = {
    ownDrafts: new Set(nextCatalog.ownDrafts),
    ownPosts: new Set(nextCatalog.ownPosts),
    castInPosts: new Set(nextCatalog.castInPosts),
    castInDrafts: new Set(nextCatalog.castInDrafts),
    ownPrompts: new Set(nextCatalog.ownPrompts),
  };
  const characterSets = {};
  Object.keys(nextCatalog.characterPosts).forEach((handle) => {
    characterSets[handle] = new Set(nextCatalog.characterPosts[handle]);
  });
  const characterDraftsSets = {};
  Object.keys(nextCatalog.characterDrafts).forEach((handle) => {
    characterDraftsSets[handle] = new Set(nextCatalog.characterDrafts[handle]);
  });

  const list = Array.isArray(items) ? items : [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const bucketKey = normalizeBackupBucketKey(item && item.bucket);
    const itemId = sanitizeIdToken(item && item.id, 256);
    if (!bucketKey || !itemId) continue;
    if (bucketKey === 'characterPosts') {
      if (!characterHandle) continue;
      if (!characterSets[characterHandle]) characterSets[characterHandle] = new Set();
      characterSets[characterHandle].add(itemId);
      continue;
    }
    if (bucketKey === 'characterDrafts') {
      if (!characterDraftsHandle) continue;
      if (!characterDraftsSets[characterDraftsHandle]) characterDraftsSets[characterDraftsHandle] = new Set();
      characterDraftsSets[characterDraftsHandle].add(itemId);
      continue;
    }
    bucketSets[bucketKey].add(itemId);
  }

  return {
    ownDrafts: Array.from(bucketSets.ownDrafts),
    ownPosts: Array.from(bucketSets.ownPosts),
    castInPosts: Array.from(bucketSets.castInPosts),
    castInDrafts: Array.from(bucketSets.castInDrafts),
    ownPrompts: Array.from(bucketSets.ownPrompts),
    characterPosts: Object.keys(characterSets).reduce((acc, handle) => {
      acc[handle] = Array.from(characterSets[handle]);
      return acc;
    }, {}),
    characterDrafts: Object.keys(characterDraftsSets).reduce((acc, handle) => {
      acc[handle] = Array.from(characterDraftsSets[handle]);
      return acc;
    }, {}),
  };
}

function buildBackupHistoricalBucketCounts(catalog, settings) {
  const normalizedCatalog = normalizeBackupBucketCatalog(catalog);
  const characterHandle = normalizeCharacterHandle(settings && settings.character_handle);
  const characterDraftsHandle = normalizeCharacterHandle(settings && settings.character_drafts_handle);
  return {
    ownDrafts: normalizedCatalog.ownDrafts.length,
    ownPosts: normalizedCatalog.ownPosts.length,
    castInPosts: normalizedCatalog.castInPosts.length,
    castInDrafts: normalizedCatalog.castInDrafts.length,
    ownPrompts: normalizedCatalog.ownPrompts.length,
    characterPosts: characterHandle && Array.isArray(normalizedCatalog.characterPosts[characterHandle])
      ? normalizedCatalog.characterPosts[characterHandle].length
      : 0,
    characterDrafts: characterDraftsHandle && Array.isArray(normalizedCatalog.characterDrafts[characterDraftsHandle])
      ? normalizedCatalog.characterDrafts[characterDraftsHandle].length
      : 0,
  };
}

function normalizeBackupPublishedMode(value) {
  return value === 'direct_sora' ? 'direct_sora' : 'smart';
}

function normalizeBackupAudioMode(value) {
  return value === 'with_audiomark' ? 'with_audiomark' : 'no_audiomark';
}

function normalizeBackupFramingMode(value) {
  return value === 'social_16_9' ? 'social_16_9' : 'sora_default';
}

function normalizeCharacterHandle(value) {
  const raw = sanitizeString(value, 80) || '';
  if (!raw) return '';
  const lowered = raw.toLowerCase().replace(/\s+/g, '');
  if (/^@?togyl$/.test(lowered)) return '@togyl';
  return raw.replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
}

function normalizeBackupRequestSettings(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    published_download_mode: normalizeBackupPublishedMode(raw.published_download_mode),
    audio_mode: normalizeBackupAudioMode(raw.audio_mode),
    framing_mode: normalizeBackupFramingMode(raw.framing_mode),
    character_handle: normalizeCharacterHandle(raw.character_handle),
    character_drafts_handle: normalizeCharacterHandle(raw.character_drafts_handle),
  };
}

function getBackupFeedLimitForSettings(settings) {
  void settings;
  return BACKUP_DEFAULT_FEED_LIMIT;
}

function getBackupDraftLimitForSettings(settings) {
  void settings;
  return BACKUP_DEFAULT_DRAFT_LIMIT;
}

function getSelectedBackupBuckets(scopes, settings) {
  const normalized = normalizeBackupScopes(scopes);
  const normalizedSettings = normalizeBackupRequestSettings(settings);
  const draftLimit = getBackupDraftLimitForSettings(normalizedSettings);
  const feedLimit = getBackupFeedLimitForSettings(normalizedSettings);
  const incrementalBatchLimit = 25;
  const draftDownloadPageLimit = BACKUP_DRAFT_DOWNLOAD_PAGE_LIMIT;
  const buckets = [];
  if (normalized.ownDrafts) {
    buckets.push({ key: 'ownDrafts', kind: 'draft', pathname: '/backend/project_y/profile/drafts/v2', limit: draftDownloadPageLimit });
  }
  if (normalized.ownPosts) {
    buckets.push({ key: 'ownPosts', kind: 'published', pathname: '/backend/project_y/profile_feed/me', limit: feedLimit, extraParams: { cut: 'nf2' } });
  }
  if (normalized.castInPosts) {
    buckets.push({ key: 'castInPosts', kind: 'published', pathname: '/backend/project_y/profile_feed/me', limit: incrementalBatchLimit, extraParams: { cut: 'appearances' } });
  }
  if (normalized.castInDrafts) {
    buckets.push({ key: 'castInDrafts', kind: 'draft', pathname: '/backend/project_y/profile/drafts/cameos', limit: draftDownloadPageLimit });
  }
  if (normalized.ownPrompts) {
    buckets.push({ key: 'ownPrompts', kind: 'draft', pathname: '/backend/project_y/profile/drafts/v2', limit: draftLimit });
  }
  if (normalized.characterPosts && normalizedSettings.character_handle) {
    buckets.push({
      key: 'characterPosts',
      kind: 'published',
      pathname: '',
      limit: incrementalBatchLimit,
      character_handle: normalizedSettings.character_handle,
      extraParams: { cut: 'appearances' },
    });
  }
  if (normalized.characterDrafts && normalizedSettings.character_drafts_handle) {
    buckets.push({
      key: 'characterDrafts',
      kind: 'draft',
      pathname: '',
      limit: draftDownloadPageLimit,
      character_drafts_handle: normalizedSettings.character_drafts_handle,
    });
  }
  return buckets;
}

function buildCharacterFeedPathCandidates(handle) {
  const normalizedHandle = normalizeCharacterHandle(handle);
  if (!normalizedHandle) return [];
  const encoded = encodeURIComponent(normalizedHandle);
  return [
    `/backend/project_y/profile_feed/${encoded}`,
    `/backend/project_y/profile_feed/${encoded}/posts`,
    `/backend/project_y/profile_feed/user/${encoded}`,
    `/backend/project_y/profile/${encoded}/feed`,
  ];
}

function extractItemsFromPayload(payload) {
  if (Array.isArray(payload && payload.items)) return payload.items;
  if (Array.isArray(payload && payload.data && payload.data.items)) return payload.data.items;
  if (Array.isArray(payload && payload.posts)) return payload.posts;
  if (Array.isArray(payload && payload.data && payload.data.posts)) return payload.data.posts;
  if (Array.isArray(payload && payload.drafts)) return payload.drafts;
  if (Array.isArray(payload && payload.data && payload.data.drafts)) return payload.data.drafts;
  return [];
}

function extractCursorFromPayload(payload) {
  const cursor =
    (payload && payload.next_cursor) ||
    (payload && payload.cursor) ||
    (payload && payload.data && payload.data.next_cursor) ||
    (payload && payload.data && payload.data.cursor) ||
    null;
  return cursor == null || cursor === '' ? null : String(cursor);
}

function resolveBackupPayloadEntity(kind, payload) {
  if (!isPlainObject(payload)) return null;
  if (String(kind) === 'draft') {
    return isPlainObject(payload.draft) ? payload.draft : payload;
  }
  return isPlainObject(payload.post) ? payload.post : payload;
}

function getBackupItemId(kind, item) {
  if (!isPlainObject(item)) return '';
  if (String(kind) === 'draft') {
    const draft = resolveBackupPayloadEntity(kind, item) || item;
    return sanitizeIdToken(draft.id || draft.generation_id || draft.draft_id || item.id || item.generation_id || item.draft_id, 256) || '';
  }
  const post = item.post && typeof item.post === 'object' ? item.post : item;
  return sanitizeIdToken(post.id || item.id || post.post_id, 256) || '';
}

function pickPrompt(detail, item) {
  const detailPost = resolveBackupPayloadEntity('published', detail) || detail;
  const listPost = resolveBackupPayloadEntity('published', item) || item;
  const detailDraft = resolveBackupPayloadEntity('draft', detail) || detail;
  const listDraft = resolveBackupPayloadEntity('draft', item) || item;
  const values = [
    detailPost && detailPost.creation_config && detailPost.creation_config.prompt,
    detailPost && detailPost.prompt,
    detailPost && detailPost.caption,
    detailPost && detailPost.text,
    detailDraft && detailDraft.creation_config && detailDraft.creation_config.prompt,
    detailDraft && detailDraft.prompt,
    detail && detail.creation_config && detail.creation_config.prompt,
    listDraft && listDraft.creation_config && listDraft.creation_config.prompt,
    listDraft && listDraft.prompt,
    listPost && listPost.prompt,
    listPost && listPost.caption,
    listPost && listPost.text,
    item && item.prompt,
  ];
  for (let index = 0; index < values.length; index += 1) {
    const next = sanitizeString(values[index], 4096);
    if (next) return next;
  }
  return '';
}

function pickPromptSource(detail, item) {
  const detailPost = resolveBackupPayloadEntity('published', detail) || detail;
  const detailDraft = resolveBackupPayloadEntity('draft', detail) || detail;
  if (sanitizeString(detailPost && detailPost.creation_config && detailPost.creation_config.prompt, 4096)) return 'creation_config';
  if (sanitizeString(detailPost && detailPost.prompt, 4096)) return 'detail';
  if (sanitizeString(detailDraft && detailDraft.creation_config && detailDraft.creation_config.prompt, 4096)) return 'creation_config';
  if (sanitizeString(detailDraft && detailDraft.prompt, 4096)) return 'detail';
  if (
    sanitizeString(detailPost && detailPost.caption, 4096) ||
    sanitizeString(detailPost && detailPost.text, 4096)
  ) {
    return 'inline';
  }
  const listPost = resolveBackupPayloadEntity('published', item) || item;
  const listDraft = resolveBackupPayloadEntity('draft', item) || item;
  if (sanitizeString(listDraft && listDraft.creation_config && listDraft.creation_config.prompt, 4096)) return 'creation_config';
  if (sanitizeString(listDraft && listDraft.prompt, 4096)) return 'detail';
  if (
    sanitizeString(listPost && listPost.caption, 4096) ||
    sanitizeString(listPost && listPost.text, 4096) ||
    sanitizeString(item && item.prompt, 4096)
  ) {
    return 'inline';
  }
  return '';
}

function pickTitle(detail, item) {
  const detailPost = resolveBackupPayloadEntity('published', detail) || detail;
  const listPost = resolveBackupPayloadEntity('published', item) || item;
  const detailDraft = resolveBackupPayloadEntity('draft', detail) || detail;
  const listDraft = resolveBackupPayloadEntity('draft', item) || item;
  return (
    sanitizeString(detailPost && detailPost.title, 512) ||
    sanitizeString(detailDraft && detailDraft.title, 512) ||
    sanitizeString(detail && detail.title, 512) ||
    sanitizeString(listPost && listPost.title, 512) ||
    sanitizeString(listDraft && listDraft.title, 512) ||
    sanitizeString(item && item.title, 512) ||
    ''
  );
}

function collectBackupCastNames(detail, item) {
  const candidates = [];

  function pushAll(values) {
    if (!Array.isArray(values)) return;
    for (let index = 0; index < values.length; index += 1) {
      if (candidates.length >= MAX_HARVEST_CAST_NAMES) break;
      const raw = values[index];
      const next = sanitizeString(
        typeof raw === 'string' ? raw : (raw && (raw.username || raw.handle || raw.name)),
        80
      );
      if (!next || candidates.indexOf(next) >= 0) continue;
      candidates.push(next);
    }
  }

  const detailPost = resolveBackupPayloadEntity('published', detail) || detail;
  const listPost = resolveBackupPayloadEntity('published', item) || item;
  const detailDraft = resolveBackupPayloadEntity('draft', detail) || detail;
  const listDraft = resolveBackupPayloadEntity('draft', item) || item;
  pushAll(detailPost && detailPost.cameo_usernames);
  pushAll(detailDraft && detailDraft.cameo_usernames);
  pushAll(detail && detail.cameos);
  pushAll(detail && detail.cameo_profiles);
  pushAll(listPost && listPost.cameo_usernames);
  pushAll(listDraft && listDraft.cameo_usernames);
  pushAll(item && item.cameos);
  pushAll(item && item.cameo_profiles);
  pushAll(detailDraft && detailDraft.creation_config && detailDraft.creation_config.cameo_profiles);
  pushAll(listDraft && listDraft.creation_config && listDraft.creation_config.cameo_profiles);
  return candidates;
}

function resolveBackupDimensionsAndDuration(detail, item) {
  const root =
    resolveBackupPayloadEntity('draft', detail) ||
    resolveBackupPayloadEntity('published', detail) ||
    detail;
  const fallback =
    resolveBackupPayloadEntity('draft', item) ||
    resolveBackupPayloadEntity('published', item) ||
    item;
  const cfg =
    root && root.creation_config && typeof root.creation_config === 'object'
      ? root.creation_config
      : ((fallback && fallback.creation_config && typeof fallback.creation_config === 'object') ? fallback.creation_config : {});
  const attachment =
    Array.isArray(root && root.attachments) && root.attachments.length
      ? root.attachments[0]
      : (Array.isArray(fallback && fallback.attachments) && fallback.attachments.length ? fallback.attachments[0] : null);
  const width = sanitizeNumber(cfg.width != null ? cfg.width : (root && root.width != null ? root.width : (attachment && attachment.width != null ? attachment.width : fallback && fallback.width)), 1, 20000);
  const height = sanitizeNumber(cfg.height != null ? cfg.height : (root && root.height != null ? root.height : (attachment && attachment.height != null ? attachment.height : fallback && fallback.height)), 1, 20000);
  let duration = sanitizeNumber(
    root && root.duration_s != null
      ? root.duration_s
      : (detail && detail.duration_s != null ? detail.duration_s : fallback && fallback.duration_s),
    0,
    60 * 60 * 10
  );
  if (duration == null) {
    const fps =
      sanitizeNumber(
        cfg.fps != null ? cfg.fps : (root && root.fps != null ? root.fps : fallback && fallback.fps),
        1,
        120
      ) || 30;
    const nFrames = sanitizeNumber(
      cfg.n_frames != null
        ? cfg.n_frames
        : (
            root && root.n_frames != null
              ? root.n_frames
              : (
                  root && root.video_metadata && root.video_metadata.n_frames != null
                    ? root.video_metadata.n_frames
                    : (attachment && attachment.n_frames != null ? attachment.n_frames : fallback && fallback.n_frames)
                )
          ),
      1,
      1000000
    );
    if (nFrames != null && fps > 0) duration = nFrames / fps;
  }
  return {
    width: width != null ? width : null,
    height: height != null ? height : null,
    duration_s: duration != null ? duration : null,
  };
}

function buildBackupFolderName(run, bucket) {
  const settings = normalizeBackupRequestSettings(run && run.settings);
  const accountPrefix = buildCurrentUserFolderAnchor(run) + "'s ";
  if (bucket === 'ownPrompts') return accountPrefix + 'Sora Prompts';
  const watermarkLabel = settings.published_download_mode === 'direct_sora' ? 'With Watermark' : 'No Watermark';
  const audiomarkLabel = settings.audio_mode === 'with_audiomark' ? 'With Label' : 'No Label';
  const framingLabel = settings.framing_mode === 'social_16_9' ? 'Cropped for Social Media' : 'Default Crop';
  let folderPrefix = accountPrefix + bucket;
  if (bucket === 'ownPosts') folderPrefix = accountPrefix + 'Sora Posts';
  else if (bucket === 'ownDrafts') folderPrefix = accountPrefix + 'Sora Drafts';
  else if (bucket === 'castInPosts') folderPrefix = accountPrefix + 'Cast-In Posts';
  else if (bucket === 'castInDrafts') folderPrefix = accountPrefix + 'Sora Drafts of Me';
  else if (bucket === 'characterPosts') {
    const handle = normalizeCharacterHandle(settings.character_handle);
    folderPrefix = handle
      ? (handle.charAt(0) === '@' ? handle : ('@' + handle)) + "'s Posts"
      : "Character's Posts";
  }
  else if (bucket === 'characterDrafts') {
    const handle = normalizeCharacterHandle(settings.character_drafts_handle);
    folderPrefix = handle
      ? (handle.charAt(0) === '@' ? handle : ('@' + handle)) + "'s Drafts"
      : "Character's Drafts";
  }
  return folderPrefix + ' - ' + watermarkLabel + ', ' + audiomarkLabel + ', ' + framingLabel;
}

function sanitizeCurrentUserHandle(value) {
  const safeHandle = sanitizeString(value, 128);
  if (!safeHandle) return '';
  return String(safeHandle)
    .trim()
    .replace(/^@+/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

function sanitizeCurrentUserId(value) {
  const safeId = sanitizeIdToken(value, 128);
  if (!safeId) return '';
  return String(safeId)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildCurrentUserFolderAnchor(run) {
  const currentUser = normalizeCurrentUser(run && run.current_user);
  const safeHandle = sanitizeCurrentUserHandle(currentUser.handle);
  if (safeHandle) return '@' + safeHandle;
  return sanitizeCurrentUserId(currentUser.id) || 'Account';
}

function buildPromptExportFilename(run) {
  const currentUser = normalizeCurrentUser(run && run.current_user);
  const safeHandle = sanitizeCurrentUserHandle(currentUser.handle);
  if (safeHandle) return '@' + safeHandle + "'s Draft Prompts.csv";

  const safeId = sanitizeCurrentUserId(currentUser.id);
  return (safeId || 'Account') + ' Draft Prompts.csv';
}

function buildBackupFilename(run, bucket, id, ext) {
  const settings = normalizeBackupRequestSettings(run && run.settings);
  if (bucket === 'ownPrompts') {
    const folderName = buildBackupFolderName(run, bucket);
    return path.join(folderName, buildPromptExportFilename(run));
  }
  let safeExt = sanitizeString(ext, 16) || 'mp4';
  if (settings.audio_mode === 'no_audiomark') safeExt = 'mov';
  else if (settings.framing_mode === 'social_16_9') safeExt = 'mp4';
  const folderName = buildBackupFolderName(run, bucket);
  return path.join(folderName, id + '.' + safeExt);
}

function buildBackupDetailPath(kind, id) {
  if (kind === 'draft') return '/backend/project_y/profile/drafts/v2/' + encodeURIComponent(id);
  return '/backend/project_y/post/' + encodeURIComponent(id);
}

function buildBackupPermalink(kind, id) {
  return kind === 'draft'
    ? BACKUP_ORIGIN + '/d/' + encodeURIComponent(id)
    : BACKUP_ORIGIN + '/p/' + encodeURIComponent(id);
}

function extractBackupPostIdFromPermalink(permalink) {
  const value = sanitizeString(permalink, 4096);
  if (!value) return '';
  try {
    const parsed = new URL(value, BACKUP_ORIGIN);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return sanitizeIdToken(segments.length ? segments[segments.length - 1] : '', 256) || '';
  } catch (_error) {
    const segments = String(value).split('/').filter(Boolean);
    return sanitizeIdToken(segments.length ? segments[segments.length - 1] : '', 256) || '';
  }
}

function isBackupPublishedPostPermalink(permalink) {
  const value = sanitizeString(permalink, 4096);
  if (!value) return false;
  try {
    const parsed = new URL(value, BACKUP_ORIGIN);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return parsed.origin === BACKUP_ORIGIN && segments.length === 2 && segments[0] === 'p' && /^s_[A-Za-z0-9]+$/i.test(segments[1]);
  } catch (_error) {
    return false;
  }
}

function extractBackupPublishedPostReference(kind, payload) {
  const targetKind = String(kind || '');
  const source = isPlainObject(payload) ? payload : {};
  const candidates = [];

  function pushCandidate(value) {
    if (isPlainObject(value)) candidates.push(value);
  }

  if (targetKind === 'draft') {
    const draft = resolveBackupPayloadEntity('draft', source) || source;
    pushCandidate(draft && draft.post && draft.post.post);
    pushCandidate(draft && draft.post);
    pushCandidate(draft && draft.preview_asset && draft.preview_asset.post && draft.preview_asset.post.post);
    pushCandidate(draft && draft.preview_asset && draft.preview_asset.post);
  } else {
    const post = resolveBackupPayloadEntity('published', source) || source;
    pushCandidate(post && post.post);
    pushCandidate(post);
  }

  pushCandidate(source && source.post && source.post.post);
  pushCandidate(source && source.post);
  pushCandidate(source && source.preview_asset && source.preview_asset.post && source.preview_asset.post.post);
  pushCandidate(source && source.preview_asset && source.preview_asset.post);

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const permalink = sanitizeString(candidate && candidate.permalink, 4096) || '';
    const id = sanitizeIdToken(
      candidate && (candidate.id || candidate.post_id || candidate.slug),
      256
    ) || extractBackupPostIdFromPermalink(permalink);
    if (!permalink && !id) continue;
    return { id, permalink };
  }

  return { id: '', permalink: '' };
}

function buildBackupManifestItem(run, bucket, kind, listItem, detail, order) {
  const id = getBackupItemId(kind, detail) || getBackupItemId(kind, listItem);
  if (!id) return null;
  const owner = extractOwnerIdentity(detail || listItem);
  const prompt = pickPrompt(detail, listItem);
  const promptSource = pickPromptSource(detail, listItem);
  const title = pickTitle(detail, listItem);
  const detailEntity = resolveBackupPayloadEntity(kind, detail) || detail;
  const listEntity = resolveBackupPayloadEntity(kind, listItem) || listItem;
  const createdAt = (detailEntity && detailEntity.created_at) || (detail && detail.created_at) || (listEntity && listEntity.created_at) || (listItem && listItem.created_at) || null;
  const postedAt = (detailEntity && detailEntity.posted_at) || (detail && detail.posted_at) || (listEntity && listEntity.posted_at) || (listItem && listItem.posted_at) || null;
  const updatedAt = (detailEntity && detailEntity.updated_at) || (detail && detail.updated_at) || (listEntity && listEntity.updated_at) || (listItem && listItem.updated_at) || null;
  const dims = resolveBackupDimensionsAndDuration(detail, listItem);
  const castNames = collectBackupCastNames(detail, listItem);
  const media = pickBackupMediaSource(kind, detail || listItem);
  const mediaExt = (media && media.ext) || 'mp4';
  const isPromptBucket = bucket === 'ownPrompts';
  const draftEntity = kind === 'draft'
    ? (resolveBackupPayloadEntity('draft', detail) || resolveBackupPayloadEntity('draft', listItem) || detailEntity || listEntity)
    : null;
  const draftSourceKind = sanitizeString(draftEntity && draftEntity.kind, 64) || '';
  const draftGenerationId = sanitizeString(draftEntity && draftEntity.generation_id, 256) || '';
  const draftFrameCount = Math.max(
    0,
    Math.floor(
      Number(
        (draftEntity && draftEntity.creation_config && draftEntity.creation_config.n_frames) ||
        (draftEntity && draftEntity.n_frames) ||
        0
      ) || 0
    )
  );
  const sourcePermalink = buildBackupPermalink(kind, id);
  const publishedPost = kind === 'draft'
    ? extractBackupPublishedPostReference(kind, detail || listItem)
    : { id: id, permalink: sourcePermalink };
  const publishedPostId = sanitizeIdToken(
    (publishedPost && publishedPost.id) || extractBackupPostIdFromPermalink(publishedPost && publishedPost.permalink),
    256
  ) || '';
  const publishedPermalink = isBackupPublishedPostPermalink(publishedPost && publishedPost.permalink)
    ? publishedPost.permalink
    : (/^s_[A-Za-z0-9]+$/i.test(publishedPostId) ? buildBackupPermalink('published', publishedPostId) : '');
  return {
    item_key: makeBackupItemKey(run.id, kind, id),
    run_id: run.id,
    order: Number.isFinite(Number(order)) ? Math.floor(Number(order)) : 0,
    bucket: bucket,
    kind: kind,
    id: id,
    status: 'queued',
    attempts: 0,
    download_id: 0,
    owner_handle: owner.handle || '',
    owner_id: owner.id || '',
    prompt: prompt,
    prompt_source: promptSource,
    title: title,
    draft_source_kind: draftSourceKind,
    draft_generation_id: draftGenerationId,
    draft_n_frames: draftFrameCount,
    created_at: typeof createdAt === 'string' ? createdAt : (createdAt == null ? null : createdAt),
    posted_at: typeof postedAt === 'string' ? postedAt : (postedAt == null ? null : postedAt),
    updated_at: typeof updatedAt === 'string' ? updatedAt : (updatedAt == null ? null : updatedAt),
    width: dims.width,
    height: dims.height,
    duration_s: dims.duration_s,
    cast_names: castNames,
    cameos: castNames,
    detail_url: BACKUP_ORIGIN + buildBackupDetailPath(kind, id),
    source_permalink: sourcePermalink,
    post_permalink: publishedPermalink,
    public_post_id: publishedPostId,
    media_url: (media && media.url) || '',
    media_variant: (media && media.variant) || '',
    media_ext: mediaExt,
    media_key_path: (media && media.keyPath) || '',
    filename: isPromptBucket ? '' : buildBackupFilename(run, bucket, id, mediaExt),
    url_refreshed_at: media && media.url ? Date.now() : 0,
    last_error: '',
  };
}

function buildBackupManifestLine(item) {
  return {
    item_key: item.item_key,
    run_id: item.run_id,
    bucket: item.bucket,
    kind: item.kind,
    id: item.id,
    owner_handle: item.owner_handle || '',
    owner_id: item.owner_id || '',
    title: item.title || '',
    prompt: item.prompt || '',
    prompt_source: item.prompt_source || '',
    draft_source_kind: item.draft_source_kind || '',
    draft_generation_id: item.draft_generation_id || '',
    draft_n_frames: item.draft_n_frames == null ? '' : item.draft_n_frames,
    created_at: item.created_at || '',
    posted_at: item.posted_at || '',
    updated_at: item.updated_at || '',
    source_permalink: item.source_permalink || '',
    width: item.width == null ? '' : item.width,
    height: item.height == null ? '' : item.height,
    duration_s: item.duration_s == null ? '' : item.duration_s,
    post_permalink: item.post_permalink || '',
    public_post_id: item.public_post_id || '',
    detail_url: item.detail_url || '',
    cast_names: Array.isArray(item.cast_names) ? item.cast_names : [],
    cameos: Array.isArray(item.cameos) ? item.cameos : [],
    media_url: item.media_url || '',
    media_variant: item.media_variant || '',
    media_ext: item.media_ext || '',
    filename: item.filename || '',
    status: item.status || '',
    attempts: Number(item.attempts) || 0,
    url_refreshed_at: Number(item.url_refreshed_at) || 0,
    last_error: item.last_error || '',
  };
}

function hasResolvedBackupOwner(raw) {
  const owner = normalizeCurrentUser(raw);
  return !!(owner.handle || owner.id);
}

function shouldFetchDiscoveryDetail(bucket, owner) {
  if (!bucket || !bucket.key) return false;
  if (bucket.key === 'castInDrafts') return !hasResolvedBackupOwner(owner);
  if (bucket.key === 'castInPosts') return !hasResolvedBackupOwner(owner);
  return false;
}

function createBackupRunRecord(scopes, settings, downloadDir) {
  const createdAt = Date.now();
  return {
    id: buildBackupRunId(createdAt),
    status: 'discovering',
    interrupt_status: '',
    scopes: normalizeBackupScopes(scopes),
    headers: normalizeBackupHeaders({}),
    settings: normalizeBackupRequestSettings(settings),
    counts: createEmptyBackupCounts(),
    bucket_counts: cloneBackupBucketCounts(),
    created_at: createdAt,
    updated_at: createdAt,
    started_at: createdAt,
    completed_at: 0,
    paused_at: 0,
    cancelled_at: 0,
    current_user: { handle: '', id: '' },
    run_stamp: buildBackupRunStamp(createdAt),
    download_dir: sanitizeString(downloadDir, 4096) || '',
    active_download_id: 0,
    active_item_key: '',
    last_error: '',
    summary_text: 'Starting discovery…',
    diagnostic: {
      phase: 'starting',
      bucket: '',
      reason: '',
    },
  };
}

function summarizeBackupRun(run) {
  if (!isPlainObject(run)) return null;
  return {
    id: run.id || '',
    status: normalizeRunStatus(run.status),
    scopes: normalizeBackupScopes(run.scopes),
    settings: normalizeBackupRequestSettings(run.settings),
    counts: cloneBackupCounts(run.counts),
    bucket_counts: cloneBackupBucketCounts(run.bucket_counts),
    current_user: normalizeCurrentUser(run.current_user),
    run_stamp: sanitizeString(run.run_stamp, 64) || '',
    created_at: Number(run.created_at) || 0,
    updated_at: Number(run.updated_at) || 0,
    started_at: Number(run.started_at) || 0,
    completed_at: Number(run.completed_at) || 0,
    paused_at: Number(run.paused_at) || 0,
    cancelled_at: Number(run.cancelled_at) || 0,
    download_dir: sanitizeString(run.download_dir, 4096) || '',
    active_item_key: sanitizeString(run.active_item_key, 256) || '',
    last_error: sanitizeString(run.last_error, 1024) || '',
    summary_text: sanitizeString(run.summary_text, 1024) || '',
    diagnostic: {
      phase: sanitizeString(run && run.diagnostic && run.diagnostic.phase, 64) || '',
      bucket: sanitizeString(run && run.diagnostic && run.diagnostic.bucket, 64) || '',
      reason: sanitizeString(run && run.diagnostic && run.diagnostic.reason, 1024) || '',
    },
  };
}

function createEmptyBackupBucketProgressSnapshot() {
  return {
    has_scan_data: false,
    buckets: {
      ownDrafts: { completed: 0, total: 0, scanned_count: 0, has_scan_data: false },
      ownPosts: { completed: 0, total: 0, scanned_count: 0, has_scan_data: false },
      castInPosts: { completed: 0, total: 0, scanned_count: 0, has_scan_data: false },
      castInDrafts: { completed: 0, total: 0, scanned_count: 0, has_scan_data: false },
      characterPosts: { completed: 0, total: 0, scanned_count: 0, has_scan_data: false },
      ownPrompts: { completed: 0, total: 0, scanned_count: 0, has_scan_data: false },
      characterDrafts: { completed: 0, total: 0, scanned_count: 0, has_scan_data: false },
    },
  };
}

function buildBackupBucketProgressSnapshot(run, items, historicalCounts) {
  const progress = createEmptyBackupBucketProgressSnapshot();
  const countsByBucket = cloneBackupBucketCounts(run && run.bucket_counts);
  const persistedCounts = cloneBackupBucketCounts(historicalCounts);
  const completedByBucket = cloneBackupBucketCounts();
  const list = Array.isArray(items) ? items : [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const bucketKey = normalizeBackupBucketKey(item && item.bucket);
    if (!bucketKey) continue;
    const status = normalizeItemStatus(item && item.status);
    if (status === 'done' || status === 'failed' || status === 'skipped') {
      completedByBucket[bucketKey] = (Number(completedByBucket[bucketKey]) || 0) + 1;
    }
  }
  Object.keys(progress.buckets).forEach((bucketKey) => {
    const total = Math.max(0, Number(countsByBucket[bucketKey]) || 0, Number(persistedCounts[bucketKey]) || 0);
    const completed = Math.max(0, Number(completedByBucket[bucketKey]) || 0);
    progress.buckets[bucketKey] = {
      completed: completed,
      total: total,
      scanned_count: total,
      has_scan_data: total > 0,
    };
    if (total > 0) progress.has_scan_data = true;
  });
  return progress;
}

function parseRetryAfterMs(value) {
  const raw = sanitizeString(value, 128);
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, Math.floor(seconds * 1000));
  const dateMs = parseTimestampMs(raw);
  if (!dateMs) return 0;
  return Math.max(0, dateMs - Date.now());
}

function shouldRetryBackupStatus(status) {
  const numeric = Number(status) || 0;
  return numeric === 408 || numeric === 425 || numeric === 429 || numeric === 500 || numeric === 502 || numeric === 503 || numeric === 504;
}

function getBackupRetryDelayMs(retryAfterValue, attempt) {
  const retryAfterMs = parseRetryAfterMs(retryAfterValue);
  if (retryAfterMs > 0) return Math.min(BACKUP_FETCH_RETRY_MAX_MS, retryAfterMs);
  const backoffMs = BACKUP_FETCH_RETRY_BASE_MS * Math.pow(2, Math.max(0, Number(attempt) - 1));
  const jitterMs = Math.floor(Math.random() * 350);
  return Math.min(BACKUP_FETCH_RETRY_MAX_MS, backoffMs + jitterMs);
}

module.exports = {
  backupLogic,
  BACKUP_ORIGIN,
  BACKUP_DEFAULT_FEED_LIMIT,
  BACKUP_DEFAULT_DRAFT_LIMIT,
  BACKUP_DOWNLOAD_FOLDER,
  BACKUP_FETCH_MAX_ATTEMPTS,
  BACKUP_URL_REFRESH_MAX_AGE_MS,
  DEFAULT_BACKUP_SCOPES,
  normalizeBackupScopes,
  normalizeBackupHeaders,
  normalizeCurrentUser,
  extractOwnerIdentity,
  sameOwnerIdentity,
  shouldExcludeAppearanceOwner,
  inferFileExtension,
  isSignedUrlFresh,
  pickBackupMediaSource,
  normalizeRunStatus,
  normalizeItemStatus,
  isTerminalRunStatus,
  applyBackupStatusTransition,
  createEmptyBackupCounts,
  cloneBackupCounts,
  sanitizeString,
  sanitizeNumber,
  sanitizeIdToken,
  isPlainObject,
  normalizeBackupBucketKey,
  cloneBackupBucketCounts,
  createEmptyBackupBucketCatalog,
  normalizeBackupBucketCatalog,
  recordBackupItemsInBucketCatalog,
  buildBackupHistoricalBucketCounts,
  normalizeBackupRequestSettings,
  normalizeBackupAudioMode,
  normalizeBackupFramingMode,
  normalizeCharacterHandle,
  getBackupFeedLimitForSettings,
  getBackupDraftLimitForSettings,
  getSelectedBackupBuckets,
  buildCharacterFeedPathCandidates,
  extractItemsFromPayload,
  extractCursorFromPayload,
  getBackupItemId,
  pickPrompt,
  pickPromptSource,
  pickTitle,
  buildBackupFolderName,
  buildPromptExportFilename,
  buildBackupFilename,
  buildBackupDetailPath,
  buildBackupPermalink,
  extractBackupPostIdFromPermalink,
  isBackupPublishedPostPermalink,
  extractBackupPublishedPostReference,
  buildBackupManifestItem,
  buildBackupManifestLine,
  shouldFetchDiscoveryDetail,
  createBackupRunRecord,
  summarizeBackupRun,
  createEmptyBackupBucketProgressSnapshot,
  buildBackupBucketProgressSnapshot,
  parseRetryAfterMs,
  shouldRetryBackupStatus,
  getBackupRetryDelayMs,
};
