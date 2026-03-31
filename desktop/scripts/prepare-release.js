const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

function runNodeScript(scriptName) {
  const scriptPath = path.join(repoRoot, 'desktop', 'scripts', scriptName);
  const result = spawnSync(process.execPath, [scriptPath], {
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
}

try {
  main();
} catch (error) {
  console.error('[prepare:release]', error && error.message ? error.message : error);
  process.exit(1);
}
