import { statSync, readdirSync } from 'fs';
import { join } from 'path';

const DIST = join(import.meta.dirname, '..', 'dist');

const FILES = [
  'extension.js',
  'webview/webview.bundle.js',
  'webview/md-editor.bundle.js',
  'webview/tutorial-viewer.bundle.js',
  'queryEditor/vendor/echarts/echarts.webview.js',
  'queryEditor/vendor/toastui-editor/toastui-editor.webview.js',
];

function formatKB(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(p);
    } else {
      total += statSync(p).size;
    }
  }
  return total;
}

console.log('\nBundle sizes:');
console.log('─'.repeat(50));

let tracked = 0;
for (const rel of FILES) {
  const full = join(DIST, rel);
  try {
    const size = statSync(full).size;
    tracked += size;
    console.log(`  ${rel.padEnd(55)} ${formatKB(size).padStart(10)}`);
  } catch {
    console.log(`  ${rel.padEnd(55)} ${'MISSING'.padStart(10)}`);
  }
}

const monacoDir = join(DIST, 'monaco');
let monacoSize = 0;
try {
  monacoSize = dirSize(monacoDir);
  console.log(`  ${'monaco/ (copied assets)'.padEnd(55)} ${formatKB(monacoSize).padStart(10)}`);
} catch {
  console.log(`  ${'monaco/ (copied assets)'.padEnd(55)} ${'MISSING'.padStart(10)}`);
}

console.log('─'.repeat(50));

try {
  const totalDist = dirSize(DIST);
  console.log(`  ${'Total dist/'.padEnd(55)} ${formatKB(totalDist).padStart(10)}`);
} catch {
  console.log(`  ${'Total dist/'.padEnd(55)} ${'MISSING'.padStart(10)}`);
}
console.log('');
