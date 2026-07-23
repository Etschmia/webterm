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

// Build-Stamp fuer die Version-Skew-Erkennung: er wird SOWOHL ins Frontend-Bundle
// eingebettet (__BUILD_STAMP__) ALS AUCH nach public/version.json geschrieben.
// server.js liest version.json EINMAL beim Start; laeuft nach einem Deploy weiter
// ein alter Prozess, meldet /api/version noch dessen alten Stamp, waehrend das neue
// Bundle den neuen traegt -> das Frontend erkennt den Versatz und warnt.
//
// Als Stamp NICHT der HEAD-Commit, sondern der Kurzhash des LETZTEN Commits, der
// eine Backend-Datei (server.js/package*.json) beruehrt hat. Sonst wuerde ein
// reiner Frontend-/Docs-Commit den Stamp aendern und — weil dabei zurecht KEIN
// Backend-Restart passiert — eine falsch-positive „Backend veraltet"-Warnung
// ausloesen. So spiegelt der Stamp genau die Version des laufenden Backends.
function buildStamp() {
  const git = (args) => {
    try { return execSync(`git ${args}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
    catch { return null; }
  };
  return git('log -1 --format=%h -- server.js package.json package-lock.json')
      || git('rev-parse --short HEAD');
}
const STAMP = buildStamp() || `build-${Date.now()}`;

// Frontend-Stamp = HEAD-Kurzhash: aendert sich bei JEDEM neuen Commit (auch
// frontend-only), im Gegensatz zum backend-orientierten STAMP oben. Er treibt den
// Auto-Reload im Frontend (neues Bundle liegt bereit -> hart neu laden), waehrend
// STAMP weiterhin nur die "Backend-Restart nötig?"-Warnung steuert. So loest ein
// reiner Frontend-Deploy einen Reload aus, aber KEINE falsch-positive Warnung, und
// ein No-op-Rebuild (gleicher HEAD) laedt nicht neu.
function headStamp() {
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
  catch { return null; }
}
const HEAD = headStamp() || STAMP;
fs.writeFileSync(
  path.join(PUBLIC, 'version.json'),
  JSON.stringify({ version: STAMP, head: HEAD, builtAt: new Date().toISOString() }) + '\n',
);

// Statische Dateien kopieren
const copies = [
  [path.join(SRC, 'index.html'), path.join(PUBLIC, 'index.html')],
  [path.join(SRC, 'styles.css'), path.join(PUBLIC, 'styles.css')],
  [path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'), path.join(PUBLIC, 'xterm.css')],
  // Prose-Styles der Markdown-Vorschau aus der mdlite-Bibliothek (single source of truth).
  [path.join(__dirname, 'node_modules/mdlite/src/mdlite.css'), path.join(PUBLIC, 'mdlite.css')],
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
  // Beide Stamps fest ins Bundle einbrennen: __BUILD_STAMP__ (Backend-Version, fuer
  // die Skew-Warnung) und __FRONTEND_STAMP__ (HEAD, fuer den Auto-Reload).
  define: {
    __BUILD_STAMP__: JSON.stringify(STAMP),
    __FRONTEND_STAMP__: JSON.stringify(HEAD),
  },
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
