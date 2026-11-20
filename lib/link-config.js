// Verbindungen: Einstellung der Installation und Regeln fuer Hub-Adressen.
//
// Drei Zustaende (Sidebar-Zeile "Vernetzung"):
//   off    Verbindungen sind aus; die Sidebar zeigt kein Ketten-Symbol.
//   local  Sitzungen dieser Installation lassen sich verbinden; nach draussen
//          geht nichts.
//   hub    zusaetzlich Verbindungen zu anderen Installationen ueber einen Hub
//          (Projekt "Vernetzung"). Die Adresse des eigenen Hubs steht hier; der
//          Zugangsschluessel dazu wird nur zum ANLEGEN gebraucht — beitreten
//          kann man mit dem Einladungslink allein.
//
// Die Einstellung liegt in <dir>/config.json (0600), nicht in der .env: sie
// enthaelt den Zugangsschluessel, und das Panel aendert sie ohne Neustart.
// install.sh legt sie an. Fehlt die Datei, gilt `off` — ausser es gibt schon
// Verbindungen (Bestand von vor dieser Einstellung), dann `local`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LinkError } from './link-store.js';

export const MODES = ['off', 'local', 'hub'];
const KEY_RE = /^vnk_[A-Za-z0-9_-]{20,128}$/;
const LINK_ID = 'ln_[A-Za-z0-9_-]{8,40}';
const INVITE_RE = new RegExp(`^(.+)/l/(${LINK_ID})#([A-Za-z0-9_-]{43})$`);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Prueft eine Hub-Adresse und bringt sie in eine feste Form (ohne Schraegstrich
// am Ende). Erlaubt ist nur https, ohne Zugangsdaten, Abfrage oder Fragment.
// Private Adressen sind bewusst erlaubt: ein eigener Hub steht oft im selben
// Netz. `insecure` laesst zusaetzlich http zu, aber nur zum eigenen Rechner —
// gedacht fuer Tests, nicht fuer den Betrieb.
export function normalizeHub(raw, { insecure = false } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw new LinkError(400, 'hub_missing', 'Bitte die Adresse des Hubs eintragen (https://…).');
  if (text.length > 300 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    throw new LinkError(400, 'hub_invalid', 'Das ist keine gültige Hub-Adresse.');
  }
  let url;
  try { url = new URL(text); } catch {
    throw new LinkError(400, 'hub_invalid', 'Das ist keine gültige Hub-Adresse (erwartet: https://hub.example.org).');
  }
  const plainOk = insecure && url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !plainOk) {
    throw new LinkError(400, 'hub_scheme', 'Die Hub-Adresse muss mit https:// beginnen.');
  }
  if (url.username || url.password) {
    throw new LinkError(400, 'hub_invalid', 'Die Hub-Adresse darf keine Zugangsdaten enthalten.');
  }
  if (url.search || url.hash || text.includes('?') || text.includes('#')) {
    throw new LinkError(400, 'hub_invalid', 'Die Hub-Adresse darf weder „?“ noch „#“ enthalten.');
  }
  if (!url.hostname) throw new LinkError(400, 'hub_invalid', 'Das ist keine gültige Hub-Adresse.');
  const dir = url.pathname.replace(/\/+$/, '');
  if (dir && !/^(\/[A-Za-z0-9._~-]+)+$/.test(dir)) {
    throw new LinkError(400, 'hub_invalid', 'Der Pfad der Hub-Adresse enthält unzulässige Zeichen.');
  }
  return `${url.protocol}//${url.host}${dir}`;
}

// Rechnername fuer Anzeige und Rueckfrage (bei abweichendem Port mit Port).
export const hubHost = (base) => { try { return new URL(base).host; } catch { return String(base); } };

// Zerlegt einen Einladungslink `https://<hub>/l/<ln_…>#<geheimnis>`.
export function parseInvite(raw, opts) {
  const m = INVITE_RE.exec(String(raw ?? '').trim());
  if (!m) {
    throw new LinkError(400, 'code_invalid',
      'Das ist kein vollständiger Einladungslink — er hat die Form https://…/l/ln_…#… und braucht den Teil hinter „#“.');
  }
  return { hub: normalizeHub(m[1], opts), id: m[2], secret: m[3] };
}

export const inviteUrl = (hub, id, secret) => `${hub}/l/${id}#${secret}`;

export function checkKey(raw) {
  const key = String(raw ?? '').trim();
  if (!KEY_RE.test(key)) {
    throw new LinkError(400, 'key_invalid', 'Das ist kein Zugangsschlüssel (er beginnt mit vnk_).');
  }
  return key;
}

export function createLinkConfig({ dir, insecure = false, hasLinks = () => false } = {}) {
  if (!dir) throw new Error('createLinkConfig: dir fehlt');
  const file = path.join(dir, 'config.json');
  let cached = null;
  let sig = null;

  const fileSig = () => {
    try { const st = fs.statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return ''; }
  };

  function read() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && typeof d === 'object' && MODES.includes(d.mode)) {
        let hub = '';
        let key = '';
        try { if (d.hub) hub = normalizeHub(d.hub, { insecure }); } catch { /* unbrauchbare Adresse: wie keine */ }
        try { if (d.key) key = checkKey(d.key); } catch { /* unbrauchbarer Schluessel: wie keiner */ }
        // "hub" ohne Adresse gibt es nicht: dann bleibt es bei lokalen Verbindungen.
        return { mode: d.mode === 'hub' && !hub ? 'local' : d.mode, hub, key, stored: true };
      }
    } catch { /* fehlt oder defekt */ }
    return null;
  }

  // Aktueller Stand; die Datei wird nur bei Aenderung neu gelesen (install.sh
  // oder eine zweite Instanz kann sie geschrieben haben).
  function get() {
    const now = fileSig();
    if (cached && now === sig) return cached;
    sig = now;
    cached = read() || { mode: hasLinks() ? 'local' : 'off', hub: '', key: '', stored: false };
    return cached;
  }

  function set({ mode, hub, key }) {
    if (!MODES.includes(mode)) throw new LinkError(400, 'mode_invalid', 'Unbekannter Zustand.');
    const next = { version: 1, mode, hub: hub || '', key: key || '' };
    if (mode === 'hub' && !next.hub) throw new LinkError(400, 'hub_missing', 'Bitte die Adresse des Hubs eintragen (https://…).');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.config-${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    sig = null;
    return get();
  }

  return { get, set, file, insecure };
}
