const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { downloadToFile } = require('./http-download');

const MACOS_FFMPEG_DOWNLOADS = {
  arm64: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip',
  x86_64: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip',
};

function getFfmpegArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64';
}

function getFfmpegExecutableName() {
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function getManagedFfmpegPath(baseDir) {
  return path.join(baseDir, 'ffmpeg', getFfmpegArch(), getFfmpegExecutableName());
}

function getBundledFfmpegKey() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  if (process.platform === 'win32') {
    return 'win-x64';
  }
  return '';
}

function getPackagedBundledFfmpegPath() {
  const bundleKey = getBundledFfmpegKey();
  if (!bundleKey || !process.resourcesPath) return '';
  return path.join(process.resourcesPath, 'ffmpeg', bundleKey, getFfmpegExecutableName());
}

function getDevelopmentBundledFfmpegPath() {
  const bundleKey = getBundledFfmpegKey();
  if (!bundleKey) return '';
  return path.join(__dirname, '..', 'build-resources', 'ffmpeg', bundleKey, getFfmpegExecutableName());
}

function getLegacyMacManagedFfmpegPath() {
  if (process.platform !== 'darwin') return '';
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Sora Audiomark Remover',
    'ffmpeg',
    getFfmpegArch(),
    getFfmpegExecutableName()
  );
}

function uniqueCandidates(values) {
  const seen = new Set();
  const candidates = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    candidates.push(value);
  }
  return candidates;
}

function buildFfmpegCandidates(baseDir) {
  const candidates = [
    getPackagedBundledFfmpegPath(),
    getDevelopmentBundledFfmpegPath(),
    getManagedFfmpegPath(baseDir),
    getLegacyMacManagedFfmpegPath(),
  ];

  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg');
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    }
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
    if (process.env['ProgramFiles(x86)']) {
      candidates.push(path.join(process.env['ProgramFiles(x86)'], 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
  } else {
    candidates.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  }

  candidates.push(getFfmpegExecutableName(), 'ffmpeg');
  return uniqueCandidates(candidates);
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const settings = options || {};
    let stdout = '';
    let stderr = '';

    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || ('command_failed_' + code)).trim()));
    });

    if (settings.signal) {
      const abort = () => {
        child.kill('SIGTERM');
        reject(new Error('download_cancelled'));
      };
      if (settings.signal.aborted) abort();
      else settings.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

async function isUsableFfmpeg(candidate) {
  try {
    await runCommand(candidate, ['-version']);
    return true;
  } catch (_error) {
    return false;
  }
}

async function findFileRecursive(rootDir, targetName) {
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const nextPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === targetName) return nextPath;
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(nextPath, targetName);
      if (nested) return nested;
    }
  }
  return '';
}

async function installMacosFfmpeg(baseDir) {
  const arch = getFfmpegArch();
  const downloadUrl = MACOS_FFMPEG_DOWNLOADS[arch];
  if (!downloadUrl) {
    throw new Error('unsupported_ffmpeg_arch_' + arch);
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sora-ffmpeg-'));
  const zipPath = path.join(tempDir, 'ffmpeg.zip');
  const extractDir = path.join(tempDir, 'extract');
  const managedPath = getManagedFfmpegPath(baseDir);

  try {
    await downloadToFile(downloadUrl, zipPath);
    await fs.promises.mkdir(extractDir, { recursive: true });
    await runCommand('ditto', ['-x', '-k', zipPath, extractDir]);

    const extractedFfmpeg = await findFileRecursive(extractDir, getFfmpegExecutableName());
    if (!extractedFfmpeg) {
      throw new Error('ffmpeg_extract_missing_binary');
    }

    await fs.promises.mkdir(path.dirname(managedPath), { recursive: true });
    await fs.promises.copyFile(extractedFfmpeg, managedPath);
    await fs.promises.chmod(managedPath, 0o755);

    if (!(await isUsableFfmpeg(managedPath))) {
      throw new Error('ffmpeg_verify_failed');
    }

    return managedPath;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveFfmpegBinary(options) {
  const baseDir = options && options.baseDir ? options.baseDir : process.cwd();
  const onStatus = options && typeof options.onStatus === 'function' ? options.onStatus : null;
  const candidates = buildFfmpegCandidates(baseDir);

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (await isUsableFfmpeg(candidate)) return candidate;
  }

  if (process.platform === 'darwin') {
    if (onStatus) await onStatus('Downloading FFmpeg for Audio Mode...');
    try {
      const managedPath = await installMacosFfmpeg(baseDir);
      if (onStatus) await onStatus('FFmpeg ready. Removing audiomark...');
      return managedPath;
    } catch (error) {
      const detail = String((error && error.message) || error || 'ffmpeg_install_failed');
      throw new Error(
        'Could not download FFmpeg for "No Audiomark". Switch Audio Mode to "With Audiomark" or install FFmpeg and try again. ' +
        detail
      );
    }
  }

  throw new Error(
    'FFmpeg is required for "No Audiomark". Install FFmpeg or switch Audio Mode to "With Audiomark".'
  );
}

async function removeAudiomark(options) {
  const ffmpegPath = options && options.ffmpegPath ? options.ffmpegPath : 'ffmpeg';
  const inputPath = options && options.inputPath ? options.inputPath : '';
  const outputPath = options && options.outputPath ? options.outputPath : '';
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0',
    '-c:v',
    'copy',
    '-c:a',
    'alac',
    '-ar',
    '48000',
    '-c:s',
    'copy',
    '-movflags',
    '+faststart',
    outputPath,
  ], { signal: options && options.signal });
  return { path: outputPath };
}

function buildIntermediateDownloadPath(outputPath, mediaExt) {
  const parsed = path.parse(outputPath);
  const normalizedExt = String(mediaExt || '').trim().replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'mp4';
  return path.join(parsed.dir, parsed.name + '.source.' + normalizedExt);
}

module.exports = {
  resolveFfmpegBinary,
  removeAudiomark,
  buildIntermediateDownloadPath,
};
