const assert = require('assert');
const {
  normalizeCharacterHandle,
  normalizeBackupRequestSettings,
  buildBackupFilename,
  buildCharacterFeedPathCandidates,
  createBackupRunRecord,
  buildBackupBucketProgressSnapshot,
  recordBackupItemsInBucketCatalog,
  buildBackupHistoricalBucketCounts,
  getSelectedBackupBuckets,
} = require('../desktop/core/helpers.js');

function testNormalizeCharacterHandle() {
  assert.strictEqual(normalizeCharacterHandle('@@TeSt-Handle!!'), 'test-handle');
}

function testCharacterFeedCandidatesIncludeCanonicalFirstPath() {
  const candidates = buildCharacterFeedPathCandidates('@creator_handle');
  assert.strictEqual(candidates[0], '/backend/project_y/profile_feed/creator_handle');
  assert.ok(candidates.includes('/backend/project_y/profile/creator_handle/feed'));
}

function testCharacterBucketUsesAppearancesCut() {
  const run = createBackupRunRecord(
    { characterPosts: true },
    { profile: 'balanced', character_handle: '@vhscamera' },
    '/tmp/sora-downloads'
  );
  const bucket = getSelectedBackupBuckets(run.scopes, run.settings).find((entry) => entry.key === 'characterPosts');
  assert.strictEqual(bucket.extraParams.cut, 'appearances');
  assert.strictEqual(bucket.limit, 100);
}

function testCastInBucketsUseIncrementalBatchLimit() {
  const run = createBackupRunRecord(
    { castInPosts: true, castInDrafts: true },
    { profile: 'balanced' },
    '/tmp/sora-downloads'
  );
  const buckets = getSelectedBackupBuckets(run.scopes, run.settings);
  assert.strictEqual(buckets.find((entry) => entry.key === 'castInPosts').limit, 100);
  assert.strictEqual(buckets.find((entry) => entry.key === 'castInDrafts').limit, 100);
}

function testCreateBackupRunRecordKeepsDownloadDirectory() {
  const run = createBackupRunRecord({ ownPosts: true }, { profile: 'balanced' }, '/tmp/sora-downloads');
  assert.strictEqual(run.download_dir, '/tmp/sora-downloads');
  assert.strictEqual(run.status, 'discovering');
}

function testNormalizeBackupRequestSettingsDefaultsAudioMode() {
  const settings = normalizeBackupRequestSettings({});
  assert.strictEqual(settings.audio_mode, 'with_audiomark');
}

function testNoAudiomarkUsesMovOutputExtension() {
  const run = createBackupRunRecord(
    { ownPosts: true },
    { profile: 'balanced', audio_mode: 'no_audiomark' },
    '/tmp/sora-downloads'
  );
  const filename = buildBackupFilename(run, 'ownPosts', 'abc123', 'mp4');
  assert.strictEqual(filename.endsWith('/abc123.mov'), true);
  assert.strictEqual(filename.includes('Sora Video Downloader/My Sora Posts - No Watermark, No Audiomark/'), true);
}

function testFilenameSeparatesFolderBySettingsCombo() {
  const run = createBackupRunRecord(
    { characterPosts: true },
    { profile: 'balanced', published_download_mode: 'smart', audio_mode: 'with_audiomark', character_handle: '@ringcamera' },
    '/tmp/sora-downloads'
  );
  const filename = buildBackupFilename(run, 'characterPosts', 'abc123', 'mp4');
  assert.strictEqual(
    filename.includes('Sora Video Downloader/@ringcamera Sora Posts - No Watermark, Yes Audiomark/abc123.mp4'),
    true
  );
}

function testBucketProgressCountsCompletedItems() {
  const run = createBackupRunRecord({ ownPosts: true }, { profile: 'balanced' }, '/tmp/sora-downloads');
  run.bucket_counts.ownPosts = 3;
  const progress = buildBackupBucketProgressSnapshot(run, [
    { bucket: 'ownPosts', status: 'done' },
    { bucket: 'ownPosts', status: 'failed' },
    { bucket: 'ownPosts', status: 'done' },
  ]);
  assert.strictEqual(progress.has_scan_data, true);
  assert.strictEqual(progress.buckets.ownPosts.total, 3);
  assert.strictEqual(progress.buckets.ownPosts.completed, 2);
}

function testBucketProgressUsesHistoricalTotals() {
  const run = createBackupRunRecord({ ownPosts: true }, { profile: 'balanced' }, '/tmp/sora-downloads');
  run.bucket_counts.ownPosts = 30;
  const progress = buildBackupBucketProgressSnapshot(
    run,
    [{ bucket: 'ownPosts', status: 'done' }],
    { ownPosts: 307 }
  );
  assert.strictEqual(progress.buckets.ownPosts.total, 307);
  assert.strictEqual(progress.buckets.ownPosts.completed, 1);
}

function testHistoricalBucketCatalogTracksUniqueIds() {
  const run = createBackupRunRecord({ ownPosts: true }, { profile: 'balanced' }, '/tmp/sora-downloads');
  const catalog = recordBackupItemsInBucketCatalog(null, run, [
    { bucket: 'ownPosts', id: 'post-1' },
    { bucket: 'ownPosts', id: 'post-1' },
    { bucket: 'ownPosts', id: 'post-2' },
  ]);
  const counts = buildBackupHistoricalBucketCounts(catalog, {});
  assert.strictEqual(counts.ownPosts, 2);
}

function testHistoricalBucketCatalogSeparatesCharacterHandles() {
  const alphaRun = createBackupRunRecord(
    { characterPosts: true },
    { profile: 'balanced', character_handle: '@alpha' },
    '/tmp/sora-downloads'
  );
  const alphaCatalog = recordBackupItemsInBucketCatalog(null, alphaRun, [
    { bucket: 'characterPosts', id: 'post-1' },
    { bucket: 'characterPosts', id: 'post-2' },
  ]);
  const betaRun = createBackupRunRecord(
    { characterPosts: true },
    { profile: 'balanced', character_handle: '@beta' },
    '/tmp/sora-downloads'
  );
  const mergedCatalog = recordBackupItemsInBucketCatalog(alphaCatalog, betaRun, [
    { bucket: 'characterPosts', id: 'post-9' },
  ]);
  assert.strictEqual(buildBackupHistoricalBucketCounts(mergedCatalog, { character_handle: '@alpha' }).characterPosts, 2);
  assert.strictEqual(buildBackupHistoricalBucketCounts(mergedCatalog, { character_handle: '@beta' }).characterPosts, 1);
}

function run() {
  testNormalizeCharacterHandle();
  testNormalizeBackupRequestSettingsDefaultsAudioMode();
  testCharacterFeedCandidatesIncludeCanonicalFirstPath();
  testCharacterBucketUsesAppearancesCut();
  testCastInBucketsUseIncrementalBatchLimit();
  testCreateBackupRunRecordKeepsDownloadDirectory();
  testNoAudiomarkUsesMovOutputExtension();
  testFilenameSeparatesFolderBySettingsCombo();
  testBucketProgressCountsCompletedItems();
  testBucketProgressUsesHistoricalTotals();
  testHistoricalBucketCatalogTracksUniqueIds();
  testHistoricalBucketCatalogSeparatesCharacterHandles();
}

run();
