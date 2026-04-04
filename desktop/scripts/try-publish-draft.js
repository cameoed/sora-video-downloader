const path = require('path');
const os = require('os');
const { app } = require('electron');
const { BackupService } = require('../core/backup-service');
const { BACKUP_DOWNLOAD_FOLDER } = require('../core/helpers');

if (process.platform === 'darwin') {
  app.setPath('userData', path.join(os.homedir(), 'Library', 'Application Support', 'sora-video-downloader'));
}

function buildBody(draftId) {
  return {
    attachments_to_create: [{ generation_id: draftId, kind: 'sora' }],
    post_text: 'Downloaded!',
    destinations: [{ type: 'shared_link_unlisted' }],
  };
}

async function main() {
  const draftId = String(process.argv[2] || '').trim();
  if (!draftId) throw new Error('missing_draft_id');
  const backupService = new BackupService({
    baseDir: path.join(app.getPath('userData'), 'sora-video-downloader'),
    defaultDownloadDir: path.join(app.getPath('downloads'), BACKUP_DOWNLOAD_FOLDER),
  });
  try {
    await backupService.initialize();
    const pageUrl = 'https://sora.chatgpt.com/drafts';
    const requestReferer = 'https://sora.chatgpt.com/drafts';
    await backupService.session.primeAuthHeadersFromPage(pageUrl, 8000).catch(() => {});
    const result = await backupService.session.postDraftSharedLinkViaConsole(draftId, buildBody(draftId), {
      pageUrl,
      requestReferer,
      readyTimeoutMs: 8000,
    });
    const observed = backupService.session.getLastObservedRequest('https://sora.chatgpt.com/backend/project_y/post', 'POST');
    process.stdout.write(JSON.stringify({ result, observed }, null, 2) + '\n');
  } finally {
    await backupService.shutdown().catch(() => {});
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(String((error && error.stack) || error || 'try_publish_failed') + '\n');
    app.quit();
    process.exitCode = 1;
  });
