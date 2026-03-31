const assert = require('assert');
const { BackupService } = require('../desktop/core/backup-service.js');
const {
  normalizeCharacterHandle,
  normalizeBackupScopes,
  normalizeBackupRequestSettings,
  buildBackupFilename,
  buildCharacterFeedPathCandidates,
  createBackupRunRecord,
  buildBackupBucketProgressSnapshot,
  recordBackupItemsInBucketCatalog,
  buildBackupHistoricalBucketCounts,
  getSelectedBackupBuckets,
  buildBackupManifestItem,
  getBackupItemId,
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
    { character_handle: '@vhscamera' },
    '/tmp/sora-downloads'
  );
  const bucket = getSelectedBackupBuckets(run.scopes, run.settings).find((entry) => entry.key === 'characterPosts');
  assert.strictEqual(bucket.extraParams.cut, 'appearances');
  assert.strictEqual(bucket.limit, 25);
}

function testCastInBucketsUseIncrementalBatchLimit() {
  const run = createBackupRunRecord(
    { castInPosts: true, castInDrafts: true },
    {},
    '/tmp/sora-downloads'
  );
  const buckets = getSelectedBackupBuckets(run.scopes, run.settings);
  assert.strictEqual(buckets.find((entry) => entry.key === 'castInPosts').limit, 25);
  assert.strictEqual(buckets.find((entry) => entry.key === 'castInDrafts').limit, 25);
}

function testOwnBucketsUseFiftyLimit() {
  const run = createBackupRunRecord(
    { ownPosts: true, ownDrafts: true },
    {},
    '/tmp/sora-downloads'
  );
  const buckets = getSelectedBackupBuckets(run.scopes, run.settings);
  assert.strictEqual(buckets.find((entry) => entry.key === 'ownPosts').limit, 50);
  assert.strictEqual(buckets.find((entry) => entry.key === 'ownDrafts').limit, 50);
}

function testCreateBackupRunRecordKeepsDownloadDirectory() {
  const run = createBackupRunRecord({ ownPosts: true }, {}, '/tmp/sora-downloads');
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
    { audio_mode: 'no_audiomark' },
    '/tmp/sora-downloads'
  );
  const filename = buildBackupFilename(run, 'ownPosts', 'abc123', 'mp4');
  assert.strictEqual(filename.endsWith('/abc123.mov'), true);
  assert.strictEqual(filename.includes('Sora Video Downloader/My Sora Posts - No Watermark, No Audiomark/'), true);
}

function testFilenameSeparatesFolderBySettingsCombo() {
  const run = createBackupRunRecord(
    { characterPosts: true },
    { published_download_mode: 'smart', audio_mode: 'with_audiomark', character_handle: '@ringcamera' },
    '/tmp/sora-downloads'
  );
  const filename = buildBackupFilename(run, 'characterPosts', 'abc123', 'mp4');
  assert.strictEqual(
    filename.includes('Sora Video Downloader/@ringcamera Sora Posts - No Watermark, Yes Audiomark/abc123.mp4'),
    true
  );
}

function testBucketProgressCountsCompletedItems() {
  const run = createBackupRunRecord({ ownPosts: true }, {}, '/tmp/sora-downloads');
  run.bucket_counts.ownPosts = 3;
  const progress = buildBackupBucketProgressSnapshot(run, [
    { bucket: 'ownPosts', status: 'done' },
    { bucket: 'ownPosts', status: 'failed' },
    { bucket: 'ownPosts', status: 'skipped' },
  ]);
  assert.strictEqual(progress.has_scan_data, true);
  assert.strictEqual(progress.buckets.ownPosts.total, 3);
  assert.strictEqual(progress.buckets.ownPosts.completed, 3);
}

function testBucketProgressUsesHistoricalTotals() {
  const run = createBackupRunRecord({ ownPosts: true }, {}, '/tmp/sora-downloads');
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
  const run = createBackupRunRecord({ ownPosts: true }, {}, '/tmp/sora-downloads');
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
    { character_handle: '@alpha' },
    '/tmp/sora-downloads'
  );
  const alphaCatalog = recordBackupItemsInBucketCatalog(null, alphaRun, [
    { bucket: 'characterPosts', id: 'post-1' },
    { bucket: 'characterPosts', id: 'post-2' },
  ]);
  const betaRun = createBackupRunRecord(
    { characterPosts: true },
    { character_handle: '@beta' },
    '/tmp/sora-downloads'
  );
  const mergedCatalog = recordBackupItemsInBucketCatalog(alphaCatalog, betaRun, [
    { bucket: 'characterPosts', id: 'post-9' },
  ]);
  assert.strictEqual(buildBackupHistoricalBucketCounts(mergedCatalog, { character_handle: '@alpha' }).characterPosts, 2);
  assert.strictEqual(buildBackupHistoricalBucketCounts(mergedCatalog, { character_handle: '@beta' }).characterPosts, 1);
}

function testCastInDraftNestedDraftPayloadBuildsManifestItem() {
  const run = createBackupRunRecord({ castInDrafts: true }, {}, '/tmp/sora-downloads');
  const listItem = {
    draft: {
      id: 'gen_01km0zc41df3wvvx44mxrs54cy',
      created_at: 1773854425.838818,
      prompt: 'draft prompt',
      width: 512,
      height: 896,
      duration_s: 14.8,
      encodings: {
        source: {
          path: 'https://videos.openai.com/az/files/example/raw',
        },
      },
      creation_config: {
        prompt: 'draft prompt',
        cameo_profiles: [
          { username: 'topher' },
          { username: 'friend' },
        ],
      },
    },
    profile: {
      user_id: 'user-creator',
      username: 'topher',
    },
  };
  assert.strictEqual(getBackupItemId('draft', listItem), 'gen_01km0zc41df3wvvx44mxrs54cy');
  const item = buildBackupManifestItem(run, 'castInDrafts', 'draft', listItem, null, 0);
  assert.ok(item);
  assert.strictEqual(item.id, 'gen_01km0zc41df3wvvx44mxrs54cy');
  assert.strictEqual(item.owner_handle, 'topher');
  assert.strictEqual(item.prompt, 'draft prompt');
  assert.strictEqual(item.width, 512);
  assert.strictEqual(item.height, 896);
  assert.strictEqual(item.duration_s, 14.8);
  assert.strictEqual(item.media_url, 'https://videos.openai.com/az/files/example/raw');
  assert.deepStrictEqual(item.cameos, ['topher', 'friend']);
}

function testNormalizeBackupScopesKeepsOnlyExplicitSelections() {
  assert.deepStrictEqual(normalizeBackupScopes({ characterPosts: true }), {
    ownDrafts: false,
    ownPosts: false,
    castInPosts: false,
    castInDrafts: false,
    characterPosts: true,
  });
}

async function testRefreshBackupItemMediaUpdatesFilenameExtension() {
  const run = createBackupRunRecord({ ownPosts: true }, {}, '/tmp/sora-downloads');
  const item = buildBackupManifestItem(run, 'ownPosts', 'published', {
    post: {
      id: 's_post_123',
    },
  }, null, 0);
  assert.ok(item);
  assert.strictEqual(item.filename.endsWith('/s_post_123.mp4'), true);

  const service = new BackupService({
    baseDir: '/tmp/sora-video-downloader-tests',
    defaultDownloadDir: '/tmp/sora-downloads',
  });
  service.session.fetchJson = async () => ({
    json: {
      post: {
        id: 's_post_123',
        encodings: {
          source: {
            path: 'https://videos.openai.com/files/example.mov',
          },
        },
      },
    },
  });

  await service._refreshBackupItemMedia(run, item);

  assert.strictEqual(item.media_ext, 'mov');
  assert.strictEqual(item.filename.endsWith('/s_post_123.mov'), true);
}

async function run() {
  testNormalizeCharacterHandle();
  testNormalizeBackupRequestSettingsDefaultsAudioMode();
  testCharacterFeedCandidatesIncludeCanonicalFirstPath();
  testCharacterBucketUsesAppearancesCut();
  testCastInBucketsUseIncrementalBatchLimit();
  testOwnBucketsUseFiftyLimit();
  testCreateBackupRunRecordKeepsDownloadDirectory();
  testNoAudiomarkUsesMovOutputExtension();
  testFilenameSeparatesFolderBySettingsCombo();
  testBucketProgressCountsCompletedItems();
  testBucketProgressUsesHistoricalTotals();
  testHistoricalBucketCatalogTracksUniqueIds();
  testHistoricalBucketCatalogSeparatesCharacterHandles();
  testCastInDraftNestedDraftPayloadBuildsManifestItem();
  testNormalizeBackupScopesKeepsOnlyExplicitSelections();
  await testRefreshBackupItemMediaUpdatesFilenameExtension();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
