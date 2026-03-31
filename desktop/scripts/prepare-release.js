const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

function runNodeScript(scriptName) {
  const scriptPath = path.join(repoRoot, 'desktop', 'scripts', scriptName);
  const extraArgs = process.argv.slice(2);
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(scriptName + ' failed with exit code ' + result.status + '.');
  }
}

function main() {
  runNodeScript('prepare-icons.js');
  runNodeScript('prepare-ffmpeg.js');
}

try {
  main();
} catch (error) {
  console.error('[prepare:release]', error && error.message ? error.message : error);
  process.exit(1);
}
