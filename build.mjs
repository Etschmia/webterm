// Build: buendelt src/app.js (inkl. xterm) nach public/ und kopiert statische Assets.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const PUBLIC = path.join(__dirname, 'public');
const watch = process.argv.includes('--watch');

fs.mkdirSync(PUBLIC, { recursive: true });

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
