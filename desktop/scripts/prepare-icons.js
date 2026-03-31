const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const sourcePng = path.join(repoRoot, 'icons', '128.png');
const buildResourcesDir = path.join(repoRoot, 'desktop', 'build-resources');
const iconSetDir = path.join(buildResourcesDir, 'icon.iconset');
const macIconPath = path.join(buildResourcesDir, 'icon.icns');
const winIconPath = path.join(buildResourcesDir, 'icon.ico');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildWindowsIco() {
  const png = fs.readFileSync(sourcePng);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);

  fs.writeFileSync(winIconPath, Buffer.concat([header, entry, png]));
}

function resizePng(size, targetPath) {
  execFileSync('/usr/bin/sips', [
    '-z',
    String(size),
    String(size),
    sourcePng,
    '--out',
    targetPath,
  ], { stdio: 'ignore' });
}

function buildMacIcns() {
  if (process.platform !== 'darwin') return;
  ensureDir(iconSetDir);
  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  sizes.forEach(([size, filename]) => {
    resizePng(size, path.join(iconSetDir, filename));
  });
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconSetDir, '-o', macIconPath], { stdio: 'ignore' });
}

function main() {
  if (!fs.existsSync(sourcePng)) {
    throw new Error('Missing source icon at ' + sourcePng);
  }
  ensureDir(buildResourcesDir);
  buildWindowsIco();
  buildMacIcns();
}

try {
  main();
} catch (error) {
  console.error('[prepare:icons]', error && error.message ? error.message : error);
  process.exit(1);
}
