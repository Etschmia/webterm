// Schreibt die Einstellung "Vernetzung" (~/.term-link/config.json, 0600) —
// fuer install.sh. Dieselben Regeln wie das Panel in der Sidebar
// (lib/link-config.js), aber ohne den Hub anzusprechen: ob er antwortet und
// den Schluessel kennt, zeigt danach das Panel.
//
//   node deploy/link-config.mjs --dir <verzeichnis> show
//   node deploy/link-config.mjs --dir <verzeichnis> off|local
//   node deploy/link-config.mjs --dir <verzeichnis> hub <adresse>     (Schluessel optional auf stdin)
//   node deploy/link-config.mjs check-hub <adresse>                   (nur pruefen, gibt die feste Form aus)
//
// Exit 0 = geschrieben/gueltig, 2 = ungueltige Eingabe (Meldung auf stderr).

import fs from 'node:fs';
import { checkKey, createLinkConfig, normalizeHub } from '../lib/link-config.js';
import { createLinkStore, LinkError } from '../lib/link-store.js';

const args = process.argv.slice(2);
let dir = '';
if (args[0] === '--dir') { dir = args[1] || ''; args.splice(0, 2); }
const [cmd, value] = args;

function stdinText() {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8').trim(); } catch { return ''; }
}

try {
  if (cmd === 'check-hub') {
    process.stdout.write(normalizeHub(value) + '\n');
  } else {
    if (!dir) throw new LinkError(400, 'usage', 'Aufruf: link-config.mjs --dir <verzeichnis> show|off|local|hub <adresse>');
    const config = createLinkConfig({ dir, hasLinks: () => createLinkStore({ dir }).count() > 0 });
    if (cmd === 'show') {
      const c = config.get();
      // Bestand ohne config.json, aber mit vorhandenen Verbindungen, gilt als 'local',
      // damit install.sh ihn nicht still auf 'off' schaltet.
      const shown = c.stored || c.mode === 'local' ? c.mode : 'none';
      process.stdout.write(`${shown}\t${c.hub}\t${c.key ? 'key' : ''}\n`);
    } else if (cmd === 'off' || cmd === 'local') {
      const old = config.get();
      config.set({ mode: cmd, hub: old.hub, key: old.key });
    } else if (cmd === 'hub') {
      const key = stdinText();
      config.set({ mode: 'hub', hub: normalizeHub(value), key: key ? checkKey(key) : '' });
    } else {
      throw new LinkError(400, 'usage', 'Aufruf: link-config.mjs --dir <verzeichnis> show|off|local|hub <adresse>');
    }
  }
} catch (err) {
  process.stderr.write(`${err instanceof LinkError ? err.message : String(err && err.message ? err.message : err)}\n`);
  process.exit(err instanceof LinkError ? 2 : 1);
}
