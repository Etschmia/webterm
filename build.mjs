// Build: buendelt src/app.js (inkl. xterm) nach public/ und kopiert statische Assets.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const PUBLIC = path.join(__dirname, 'public');
const watch = process.argv.includes('--watch');

fs.mkdirSync(PUBLIC, { recursive: true });

// Build-Stamp (Commit-Kurzhash, Fallback Zeitstempel) fuer die Version-Skew-
// Erkennung: er wird SOWOHL ins Frontend-Bundle eingebettet (__BUILD_STAMP__)
// ALS AUCH nach public/version.json geschrieben. server.js liest version.json
// EINMAL beim Start; laeuft nach einem Deploy weiter ein alter Prozess, meldet
// /api/version noch dessen alten Stamp, waehrend das neue Bundle den neuen traegt
// -> das Frontend erkennt den Versatz und warnt. Siehe checkVersionSkew().
function buildStamp() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch { return null; }
}
const STAMP = buildStamp() || `build-${Date.now()}`;
fs.writeFileSync(
  path.join(PUBLIC, 'version.json'),
  JSON.stringify({ version: STAMP, builtAt: new Date().toISOString() }) + '\n',
);

// Statische Dateien kopieren
const copies = [
  [path.join(SRC, 'index.html'), path.join(PUBLIC, 'index.html')],
  [path.join(SRC, 'styles.css'), path.join(PUBLIC, 'styles.css')],
  [path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'), path.join(PUBLIC, 'xterm.css')],
];
function copyAssets() {
  for (const [from, to] of copies) fs.copyFileSync(from, to);
}
copyAssets();

const options = {
  entryPoints: [path.join(SRC, 'app.js')],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  outfile: path.join(PUBLIC, 'app.bundle.js'),
  sourcemap: true,
  minify: !watch,
  legalComments: 'none',
  // Build-Stamp fest ins Bundle einbrennen (das Frontend kennt so seine eigene Version).
  define: { __BUILD_STAMP__: JSON.stringify(STAMP) },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // index.html/styles.css ebenfalls beobachten
  for (const [from] of copies) {
    if (from.startsWith(SRC)) fs.watch(from, () => { copyAssets(); console.log('copied assets'); });
  }
  console.log('esbuild watching …');
} else {
  await esbuild.build(options);
  console.log('build complete -> public/');
}
