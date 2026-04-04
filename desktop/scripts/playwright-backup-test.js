const { _electron: electron } = require('playwright');

async function main() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: ['.'],
    env,
    cwd: process.cwd(),
    timeout: 120000,
  });

  try {
    const window = await app.firstWindow({ timeout: 120000 });
    await window.waitForFunction(() => !!window.soraBackupApp, null, { timeout: 120000 });
    const result = await window.evaluate(async () => {
      const bootstrap = await window.soraBackupApp.getBootstrap();
      const cleared = await window.soraBackupApp.clearSelectedCaches({ modes: ['ownDrafts'] });
      const start = await window.soraBackupApp.startBackup({
        scopes: {
          ownDrafts: true,
          ownPosts: false,
          castInPosts: false,
          castInDrafts: false,
          characterPosts: false,
          ownPrompts: false,
        },
        settings: {
          published_download_mode: 'smart',
          audio_mode: 'no_audiomark',
          framing_mode: 'sora_default',
          selectedScope: 'ownDrafts',
          character_handle: '',
        },
      });

      if (!start || !start.ok || !start.run || !start.run.id) {
        return { bootstrap, cleared, start };
      }

      const terminal = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ timeout: true }), 12 * 60 * 1000);
        const off = window.soraBackupApp.onBackupStatus((payload) => {
          const run = payload && payload.run;
          if (!run || run.id !== start.run.id) return;
          if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
            clearTimeout(timeout);
            try {
              off();
            } catch (_error) {}
            resolve(payload);
          }
        });
      });

      return { bootstrap, cleared, start, terminal };
    });

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error || 'playwright_backup_test_failed') + '\n');
  process.exit(1);
});
