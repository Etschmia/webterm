// node/npm-Suche der Deploy-Skripte (term_find_cmd in deploy/lib-service.sh).
//
// Anlass: Auf einer Installation lag node nur unter ~/.nvm. deploy/update fand es
// dort, deploy/term-restart suchte dort nicht — aus der Sidebar gestartet (Umgebung
// des Dienstes, karger PATH) kam das Update bis nach dem Build und scheiterte am
// Restart: neues Frontend gegen altes Backend. Seitdem suchen beide gleich.
//
// Gesucht wird hier ein Programm mit Kunstnamen: ein echtes `node` unter /usr/bin
// der Testmaschine wuerde sonst (zu Recht) vor nvm gefunden.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, 'deploy', 'lib-service.sh');
const NAME = 'tnode-suche';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-findcmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tool(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

// Ruft term_find_cmd in einer frischen bash auf; PATH enthaelt nur `extraPath`
// und die Systemverzeichnisse (fuer ls/sort/tail).
function find({ home, extraPath = '', lib = LIB }) {
  const r = spawnSync('bash', ['-c', '. "$1"; term_find_cmd "$2"', '_', lib, NAME], {
    env: { HOME: home, PATH: [extraPath, '/usr/bin', '/bin'].filter(Boolean).join(':') },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout };
}

test('finds a tool that exists only under ~/.nvm, taking the highest version', (t) => {
  const home = tmp(t);
  tool(path.join(home, '.nvm/versions/node/v9.11.0/bin', NAME));
  const want = tool(path.join(home, '.nvm/versions/node/v25.9.0/bin', NAME));
  tool(path.join(home, '.nvm/versions/node/v10.2.0/bin', NAME));
  assert.deepEqual(find({ home }), { status: 0, out: want });
});

test('PATH and ~/.local/bin win over nvm; vendor/node wins over everything', (t) => {
  const home = tmp(t);
  tool(path.join(home, '.nvm/versions/node/v25.9.0/bin', NAME));
  const local = tool(path.join(home, '.local/bin', NAME));
  assert.equal(find({ home }).out, local);

  const bin = path.join(tmp(t), 'bin');
  const inPath = tool(path.join(bin, NAME));
  assert.equal(find({ home, extraPath: bin }).out, inPath);

  // vendor/node haengt am Ort der Bibliothek: Kopie in ein eigenes "Repo".
  const repo = tmp(t);
  fs.mkdirSync(path.join(repo, 'deploy'));
  fs.copyFileSync(LIB, path.join(repo, 'deploy', 'lib-service.sh'));
  const vendor = tool(path.join(repo, 'vendor/node/bin', NAME));
  assert.equal(find({ home, extraPath: bin, lib: path.join(repo, 'deploy', 'lib-service.sh') }).out, vendor);
});

test('reports failure instead of guessing when nothing is installed', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, '.nvm/versions/node/v25.9.0/bin'), { recursive: true }); // Verzeichnis ohne Programm
  assert.deepEqual(find({ home }), { status: 1, out: '' });
});

test('update and term-restart share this search, and update hands its node on', () => {
  const update = fs.readFileSync(path.join(ROOT, 'deploy', 'update'), 'utf8');
  const restart = fs.readFileSync(path.join(ROOT, 'deploy', 'term-restart'), 'utf8');
  assert.match(update, /NODE_BIN="\$\(term_find_cmd node/);
  assert.match(update, /NPM_BIN="\$\(term_find_cmd npm/);
  assert.match(restart, /term_find_cmd node/);
  assert.match(update, /TERM_NODE_BIN="\$NODE_BIN" "\$SCRIPT_DIR\/deploy\/term-restart"/);
  assert.match(restart, /NODE_BIN="\$\{TERM_NODE_BIN:-\}"/);
  for (const f of ['update', 'term-restart', 'lib-service.sh']) {
    execFileSync('bash', ['-n', path.join(ROOT, 'deploy', f)]);
  }
});
