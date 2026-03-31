const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { spawnSync } = require('child_process');
const { downloadToFile } = require('../core/http-download');

const repoRoot = path.resolve(__dirname, '..', '..');
const buildResourcesDir = path.join(repoRoot, 'desktop', 'build-resources');
const ffmpegOutputDir = path.join(buildResourcesDir, 'ffmpeg');
const playwrightBrowsersPath = path.join(repoRoot, 'node_modules', 'playwright-core', 'browsers.json');
const playwrightPrimaryMirror = 'https://cdn.playwright.dev/dbazure/download/playwright';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function getPlaywrightFfmpegRevision() {
  const payload = JSON.parse(fs.readFileSync(playwrightBrowsersPath, 'utf8'));
  const entry = Array.isArray(payload && payload.browsers)
    ? payload.browsers.find((browser) => browser && browser.name === 'ffmpeg')
    : null;
  const revision = entry && entry.revision ? String(entry.revision) : '';
  if (!revision) {
    throw new Error('Could not resolve Playwright FFmpeg revision from ' + playwrightBrowsersPath);
  }
  return revision;
}

function getRequestedTargets(argvTarget) {
  const raw = String(argvTarget || '').trim().toLowerCase();
  if (raw === 'all') return ['mac-arm64', 'mac-x64', 'win-x64'];
  if (raw === 'mac') return ['mac-arm64', 'mac-x64'];
  if (raw === 'win') return ['win-x64'];
  if (raw === 'mac-arm64' || raw === 'mac-x64' || raw === 'win-x64') return [raw];
  if (process.platform === 'darwin') return ['mac-arm64', 'mac-x64'];
  if (process.platform === 'win32') return ['win-x64'];
  return [];
}

function getTargetConfig(targetKey, revision) {
  if (targetKey === 'mac-arm64') {
    return {
      key: targetKey,
      archiveName: 'ffmpeg-mac-arm64.zip',
      extractedExecutableName: 'ffmpeg-mac',
      destinationRelativePath: path.join('mac-arm64', 'ffmpeg'),
      url: util.format('%s/builds/ffmpeg/%s/ffmpeg-mac-arm64.zip', playwrightPrimaryMirror, revision),
    };
  }
  if (targetKey === 'mac-x64') {
    return {
      key: targetKey,
      archiveName: 'ffmpeg-mac.zip',
      extractedExecutableName: 'ffmpeg-mac',
      destinationRelativePath: path.join('mac-x64', 'ffmpeg'),
      url: util.format('%s/builds/ffmpeg/%s/ffmpeg-mac.zip', playwrightPrimaryMirror, revision),
    };
  }
  if (targetKey === 'win-x64') {
    return {
      key: targetKey,
      archiveName: 'ffmpeg-win64.zip',
      extractedExecutableName: 'ffmpeg-win64.exe',
      destinationRelativePath: path.join('win-x64', 'ffmpeg.exe'),
      url: util.format('%s/builds/ffmpeg/%s/ffmpeg-win64.zip', playwrightPrimaryMirror, revision),
    };
  }
  throw new Error('Unsupported FFmpeg target: ' + targetKey);
}

function extractZip(zipPath, outputDir) {
  ensureDir(outputDir);
  if (process.platform === 'win32') {
    const result = spawnSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force`,
    ], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error('Expand-Archive failed with exit code ' + result.status + '.');
    }
    return;
  }
  const result = spawnSync('ditto', ['-x', '-k', zipPath, outputDir], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error('ditto failed with exit code ' + result.status + '.');
  }
}

function findFileRecursive(rootDir, targetName) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const nextPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === targetName) return nextPath;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(nextPath, targetName);
      if (nested) return nested;
    }
  }
  return '';
}

async function prepareTarget(config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sora-bundled-ffmpeg-'));
  const zipPath = path.join(tempDir, config.archiveName);
  const extractDir = path.join(tempDir, 'extract');
  const destinationPath = path.join(ffmpegOutputDir, config.destinationRelativePath);
  let licenseBuffer = null;

  try {
    console.log('[prepare:ffmpeg] downloading', config.key, 'from', config.url);
    await downloadToFile(config.url, zipPath);
    extractZip(zipPath, extractDir);
    const extractedBinary = findFileRecursive(extractDir, config.extractedExecutableName);
    if (!extractedBinary) {
      throw new Error('Missing FFmpeg binary in archive for ' + config.key + '.');
    }
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(extractedBinary, destinationPath);
    if (process.platform !== 'win32') fs.chmodSync(destinationPath, 0o755);
    const extractedLicensePath = findFileRecursive(extractDir, 'COPYING.LGPLv2.1');
    if (extractedLicensePath) {
      licenseBuffer = fs.readFileSync(extractedLicensePath);
    }
  } finally {
    removeDir(tempDir);
  }
  return licenseBuffer;
}

async function main() {
  const targets = getRequestedTargets(process.argv[2]);
  if (!targets.length) {
    console.log('[prepare:ffmpeg] skipping: no FFmpeg bundle targets for this platform.');
    return;
  }
  if (!fs.existsSync(playwrightBrowsersPath)) {
    throw new Error('Missing ' + playwrightBrowsersPath + '. Run npm install first.');
  }

  ensureDir(buildResourcesDir);
  removeDir(ffmpegOutputDir);
  ensureDir(ffmpegOutputDir);

  const revision = getPlaywrightFfmpegRevision();
  let licenseBuffer = null;
  for (let index = 0; index < targets.length; index += 1) {
    const discoveredLicenseBuffer = await prepareTarget(getTargetConfig(targets[index], revision));
    if (!licenseBuffer && discoveredLicenseBuffer) licenseBuffer = discoveredLicenseBuffer;
  }
  if (!licenseBuffer) {
    throw new Error('Missing FFmpeg license file in downloaded archives.');
  }
  fs.writeFileSync(path.join(ffmpegOutputDir, 'COPYING.LGPLv2.1'), licenseBuffer);
}

main().catch((error) => {
  console.error('[prepare:ffmpeg]', error && error.message ? error.message : error);
  process.exit(1);
});
