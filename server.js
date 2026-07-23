// term-web: Backend
// HTTP (Static + REST /api/sessions) + WebSocket (/ws) -> node-pty.
//
// Protokoll (WS):
//   Client -> Server:  Text-Frame  = JSON-Control  { t: 'start'|'input'|'resize', ... }
//   Server -> Client:  Binaer-Frame = rohe PTY-Ausgabe
//                      Text-Frame   = JSON-Control  { t: 'ready'|'exit'|'error', ... }
//
// Eine WS-Verbindung == ein PTY. Die erste 'start'-Nachricht legt den Modus fest.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Build-Stamp des LAUFENDEN Prozesses: EINMAL beim Start aus public/version.json
// gelesen (vom Build geschrieben) und in Erinnerung gehalten. Wird nach einem
// Deploy nicht neu gestartet, meldet /api/version weiter diesen alten Stamp,
// waehrend das frisch gebaute Frontend den neuen traegt -> das Frontend erkennt
// den Versatz. Fehlt die Datei (Backend aelter als das Feature), bleibt 'unknown'.
let BUILD_VERSION = 'unknown';
try {
  BUILD_VERSION = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'version.json'), 'utf8')).version || 'unknown';
} catch { /* version.json (noch) nicht vorhanden */ }

// Minimaler .env-Loader (keine Abhaengigkeit). Liest KEY=VALUE-Zeilen aus
// <projekt>/.env. Bereits gesetzte Umgebungsvariablen (z. B. aus der
// systemd-Unit oder einem Shell-Export) haben Vorrang und werden NICHT
// ueberschrieben. Die Datei wird von install.sh erzeugt.
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '7681', 10);
const HOME = process.env.HOME || '/home/librechat';
const SHELL = process.env.SHELL || '/bin/bash';
// Persistente tmux-Session hinter dem "Standard"-Eintrag: attach falls
// vorhanden, sonst neu anlegen (tmux new-session -A). Ueberlebt Reloads
// und Verbindungsabbrueche.
const STANDARD_SESSION = process.env.TERM_STANDARD_SESSION || 'Standard-Webterm';
// Wurzel des Datei-Explorers. Die /api/fs/*-Endpunkte koennen NICHT darueber
// hinaus (Schutz gegen Directory-Traversal in safePath). Default: Home.
const FS_ROOT = path.resolve(process.env.FS_ROOT || HOME);

// Sammelverzeichnis fuer Bilder aus der Browser-Zwischenablage (/api/clip).
// Liegt unter HOME, ist damit auch fuer den Datei-Explorer (FS_ROOT=HOME)
// sichtbar. Alte Clips werden beim Hochladen nach CLIP_TTL_MS aufgeraeumt.
const CLIP_DIR = path.join(HOME, '.term-clips');
const CLIP_MAX_BYTES = 25 * 1024 * 1024;        // harte Obergrenze pro Bild
const CLIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // Aufbewahrung: 7 Tage
const CLIP_EXT = {                               // erlaubte Bildtypen -> Endung
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
};

// Erlaubte Origins fuer den WS-Upgrade (gegen Cross-Site-WS-Hijacking).
// Basic Auth (Caddy) bleibt die primaere Schranke.
// Der oeffentliche Origin (Domain hinter Caddy) kommt portabel ueber
// PUBLIC_ORIGIN aus der Umgebung/.env — mehrere kommagetrennt moeglich.
// term.martuni.de bleibt als Default-Fallback erhalten.
const ALLOWED_ORIGINS = new Set([
  'https://term.martuni.de',
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
for (const o of (process.env.PUBLIC_ORIGIN || '').split(',')) {
  const t = o.trim();
  if (t) ALLOWED_ORIGINS.add(t);
}

// ---------------------------------------------------------------------------
// tmux-Helfer
// ---------------------------------------------------------------------------

function tmux(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: '', err: stderr || err.message });
      else resolve({ ok: true, out: stdout, err: '' });
    });
  });
}

// Liefert die aktuell laufenden tmux-Sessions als Array.
async function listSessions() {
  // pane_title als LETZTES Feld: es kann Leerzeichen enthalten (Tabs sind in
  // Titeln unueblich), so bleibt das Splitten der Fixfelder stabil.
  const fmt = [
    '#{session_name}', '#{session_attached}', '#{session_windows}',
    '#{pane_in_mode}', '#{pane_current_command}', '#{@user-named}', '#{pane_title}',
  ].join('\t');
  const r = await tmux(['list-sessions', '-F', fmt]);
  if (!r.ok) return []; // kein tmux-Server -> leere Liste
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const [name, attached, windows, inMode, command, userNamed] = parts;
      const title = parts.slice(6).join('\t'); // Rest = pane_title (robust ggü. Tabs)
      return {
        name,
        attached: Number(attached) > 0,
        windows: Number(windows) || 0,
        copyMode: inMode === '1',
        command: command || '',
        // Vom Nutzer umbenannt (Session-Option @user-named): Sidebar zeigt
        // dann den Session-Namen statt des pane_title.
        userNamed: userNamed === '1',
        // Die Standard-Session steckt hinter dem "Standard"-Eintrag der
        // Sidebar; das Frontend blendet sie in der tmux-Liste aus, nutzt sie
        // aber fuer die "Claude ist fertig"-Erkennung.
        standard: name === STANDARD_SESSION,
        title: (title || '').trim(),
      };
    });
}

// Validiert einen vom Client gelieferten Session-Namen gegen die echte Liste.
async function sessionExists(name) {
  if (typeof name !== 'string' || !name) return false;
  const sessions = await listSessions();
  return sessions.some((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// System-Auslastung (/api/sysstat) — Sidebar-Widget, alle 4 s abgefragt
// ---------------------------------------------------------------------------

// Eingeloggte System-User (utmp) wie in top — zaehlt die Login-Zeilen von `who`.
// Im Webterminal oft 0, weil die tmux-Panes keine utmp-Sitzung erzeugen.
function countLoginUsers() {
  return new Promise((resolve) => {
    execFile('who', [], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.split('\n').filter((l) => l.trim()).length);
    });
  });
}

// Momentaufnahme der Systemlast fuer die Sidebar. Die Anzahl offener
// tmux-Sessions steuert das Frontend aus seinem ohnehin gepollten state bei
// (kein zweiter tmux-Aufruf hier).
async function readSysStat() {
  const load5 = os.loadavg()[1];      // 1=5-Minuten-Mittel
  const uptime = os.uptime();         // Sekunden

  // Speicher/Swap aus /proc/meminfo. "Belegt" = Total - Available (Cache/Puffer
  // zaehlen NICHT als belegt), wie "used" im modernen top/free.
  let memPct = null, swapPct = null;
  try {
    const mi = await fs.promises.readFile('/proc/meminfo', 'utf8');
    const kv = {};
    for (const line of mi.split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (m) kv[m[1]] = Number(m[2]); // Werte in kB
    }
    if (kv.MemTotal > 0) {
      const avail = kv.MemAvailable != null
        ? kv.MemAvailable
        : (kv.MemFree || 0) + (kv.Buffers || 0) + (kv.Cached || 0);
      memPct = Math.round((1 - avail / kv.MemTotal) * 100);
    }
    swapPct = kv.SwapTotal > 0 ? Math.round((1 - kv.SwapFree / kv.SwapTotal) * 100) : 0;
  } catch { /* /proc nicht lesbar -> null */ }

  // Prozesse: numerische Eintraege unter /proc (wie tops "Tasks total").
  let procs = null;
  try {
    const entries = await fs.promises.readdir('/proc');
    procs = entries.reduce((n, e) => n + (/^\d+$/.test(e) ? 1 : 0), 0);
  } catch { /* null */ }

  const users = await countLoginUsers();
  return { load5, uptime, memPct, swapPct, users, procs };
}

// ---------------------------------------------------------------------------
// Static-Serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Pfad auf PUBLIC_DIR einschraenken (kein Directory-Traversal).
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Datei-Explorer-API (/api/fs/*) — strikt auf FS_ROOT eingeschraenkt
// ---------------------------------------------------------------------------

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Loest einen vom Client gelieferten (relativen) Pfad sicher gegen FS_ROOT auf.
// Fuehrender Slash + normalize neutralisieren jegliche '..'-Anteile, sodass ein
// Ausbruch aus FS_ROOT unmoeglich ist. Rueckgabe: absoluter Pfad oder null.
function safePath(rel) {
  const cleaned = path.normalize('/' + String(rel || '')).replace(/^\/+/, '');
  const abs = path.resolve(FS_ROOT, cleaned);
  if (abs !== FS_ROOT && !abs.startsWith(FS_ROOT + path.sep)) return null;
  return abs;
}

// Bild-MIME-Typen fuer die Inline-Auslieferung (/api/fs/raw, Hover-Vorschau).
const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function handleFs(req, res, route) {
  const u = new URL(req.url, 'http://localhost');

  // Arbeitsverzeichnis der (aktiven) tmux-Session -> { abs, path }. 'path' ist
  // relativ zu FS_ROOT (wie /list); liegt das CWD ausserhalb FS_ROOT, ist es
  // null. Beide Terminal-Modi laufen in tmux, daher genuegt pane_current_path
  // der aktiven Pane — kein Shell-Hook noetig. Ohne 'session' die Standard-Session.
  if (route === '/api/fs/cwd' && req.method === 'GET') {
    const target = u.searchParams.get('session') || STANDARD_SESSION;
    // Exakter Namensabgleich ueber list-sessions (das '='-Praefix greift bei
    // display-message/target-pane nicht zuverlaessig). pane_current_path ist der
    // Pfad der aktiven Pane der jeweiligen Session.
    const r = await tmux(['list-sessions', '-F', '#{session_name}\t#{pane_current_path}']);
    let cwd = '';
    if (r.ok) {
      for (const line of r.out.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab > -1 && line.slice(0, tab) === target) { cwd = line.slice(tab + 1).trim(); break; }
      }
    }
    if (!cwd) return sendJson(res, 200, { abs: null, path: null });
    const resolved = path.resolve(cwd);
    let relPath = null;
    if (resolved === FS_ROOT) relPath = '';
    else if (resolved.startsWith(FS_ROOT + path.sep)) relPath = path.relative(FS_ROOT, resolved);
    return sendJson(res, 200, { abs: resolved, path: relPath });
  }

  const rel = u.searchParams.get('path') || '';
  const abs = safePath(rel);
  if (!abs) return sendJson(res, 400, { error: 'Ungueltiger Pfad' });

  // Verzeichnis auflisten -> { path, entries: [{name,type,size,mtime}] }
  if (route === '/api/fs/list' && req.method === 'GET') {
    let dirents;
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return sendJson(res, 404, { error: 'Verzeichnis nicht gefunden' });
    }
    const entries = await Promise.all(dirents.map(async (d) => {
      let size = 0, mtime = 0;
      try { const st = await fs.promises.stat(path.join(abs, d.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size, mtime };
    }));
    // Verzeichnisse zuerst, dann alphabetisch.
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
    return sendJson(res, 200, { path: rel, entries });
  }

  // Datei herunterladen (als Attachment).
  if (route === '/api/fs/download' && req.method === 'GET') {
    let st;
    try { st = await fs.promises.stat(abs); } catch { return sendJson(res, 404, { error: 'Nicht gefunden' }); }
    if (st.isDirectory()) return sendJson(res, 400, { error: 'Ist ein Verzeichnis' });
    const base = path.basename(abs);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      // ASCII-Fallback + RFC-5987-codierter Name fuer Umlaute u. Ae.
      'Content-Disposition':
        `attachment; filename="${base.replace(/[\r\n"]/g, '')}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    });
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
    return;
  }

  // Datei inline ausliefern (Bild-Vorschau). MIME aus der Endung; unbekannt ->
  // octet-stream + nosniff (kein HTML-Sniffing). CSP-Sandbox entschaerft zudem
  // ein direkt aufgerufenes SVG (kein Skript-Ausfuehren).
  if (route === '/api/fs/raw' && req.method === 'GET') {
    let st;
    try { st = await fs.promises.stat(abs); } catch { return sendJson(res, 404, { error: 'Nicht gefunden' }); }
    if (st.isDirectory()) return sendJson(res, 400, { error: 'Ist ein Verzeichnis' });
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': IMG_MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
    return;
  }

  // Datei hochladen: Roh-Body in <dir>/<name>. Kein Multipart -> keine Abhaengigkeit.
  if (route === '/api/fs/upload' && req.method === 'POST') {
    const name = u.searchParams.get('name') || '';
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      return sendJson(res, 400, { error: 'Ungueltiger Dateiname' });
    }
    let dirStat;
    try { dirStat = await fs.promises.stat(abs); } catch { return sendJson(res, 404, { error: 'Zielverzeichnis fehlt' }); }
    if (!dirStat.isDirectory()) return sendJson(res, 400, { error: 'Kein Verzeichnis' });
    const dest = safePath(path.posix.join(String(rel).replace(/\\/g, '/'), name));
    if (!dest) return sendJson(res, 400, { error: 'Ungueltiger Pfad' });

    const out = fs.createWriteStream(dest);
    let done = false;
    const fail = (code, m) => { if (done) return; done = true; try { out.destroy(); } catch {} sendJson(res, code, { error: m }); };
    req.on('error', () => fail(400, 'Uebertragung abgebrochen'));
    out.on('error', () => fail(500, 'Schreibfehler'));
    out.on('finish', () => { if (!done) { done = true; sendJson(res, 200, { ok: true, name }); } });
    req.pipe(out);
    return;
  }

  return sendJson(res, 404, { error: 'Unbekannte Route' });
}

// ---------------------------------------------------------------------------
// Zwischenablage-Bilder (/api/clip) — Browser-Paste -> Datei -> Pfad
// ---------------------------------------------------------------------------
// Nimmt rohe Bild-Bytes (POST-Body, Content-Type = image/*) entgegen, legt sie
// als Datei unter CLIP_DIR ab und gibt den absoluten Pfad zurueck. Das Frontend
// schreibt diesen Pfad dann als Text in die laufende Anwendung (z. B. Claude
// Code), die das Bild ueber den Pfad einliest. Loest das Headless-Problem:
// der Host hat keine System-Zwischenablage.

// Kollisionssicherer, lesbarer Dateiname-Stempel: JJJJMMTT-HHMMSS-mmm.
function clipStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
       + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// Alte Clips entfernen (best effort, blockiert die Antwort nicht).
async function pruneClips() {
  let names;
  try { names = await fs.promises.readdir(CLIP_DIR); } catch { return; }
  const now = Date.now();
  await Promise.all(names.map(async (n) => {
    if (!n.startsWith('clip-')) return;
    const fp = path.join(CLIP_DIR, n);
    try {
      const st = await fs.promises.stat(fp);
      if (now - st.mtimeMs > CLIP_TTL_MS) await fs.promises.unlink(fp);
    } catch {}
  }));
}

async function handleClip(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
  const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = CLIP_EXT[ctype];
  if (!ext) return sendJson(res, 415, { error: 'Kein unterstuetztes Bildformat' });
  if (Number(req.headers['content-length'] || 0) > CLIP_MAX_BYTES) {
    return sendJson(res, 413, { error: 'Bild zu gross' });
  }

  try { await fs.promises.mkdir(CLIP_DIR, { recursive: true }); }
  catch { return sendJson(res, 500, { error: 'Clip-Verzeichnis nicht anlegbar' }); }

  const name = `clip-${clipStamp()}.${ext}`;
  const dest = path.join(CLIP_DIR, name);
  const out = fs.createWriteStream(dest);
  let total = 0, done = false;
  const fail = (code, m) => {
    if (done) return; done = true;
    try { out.destroy(); } catch {}
    fs.promises.unlink(dest).catch(() => {});
    sendJson(res, code, { error: m });
  };
  req.on('data', (chunk) => {
    total += chunk.length;
    // Laufende Groessenkontrolle (Content-Length ist nur ein Hinweis).
    if (total > CLIP_MAX_BYTES) { try { req.destroy(); } catch {} fail(413, 'Bild zu gross'); }
  });
  req.on('error', () => fail(400, 'Uebertragung abgebrochen'));
  out.on('error', () => fail(500, 'Schreibfehler'));
  out.on('finish', () => {
    if (done) return; done = true;
    pruneClips().catch(() => {});
    sendJson(res, 200, { ok: true, path: dest, name });
  });
  req.pipe(out);
}

// ---------------------------------------------------------------------------
// Self-Update (/api/update/*) — Sidebar-Icon: Stand pruefen + deploy/update
// ---------------------------------------------------------------------------
// status: gedrosseltes `git fetch` + Commit-Zaehler HEAD..@{u} (wie viele
//         Commits das Remote voraus ist). TTL, damit nicht jeder Client-Poll
//         das Remote anfragt; ?refresh=1 (Klick aufs Icon) erzwingt.
// run:    startet deploy/update als Kindprozess (Ausgabe gepuffert). Loest das
//         Update einen Backend-Restart aus, stirbt dieser Prozess samt Kind mit
//         dem Service-cgroup — das ist ok: term-restart hat den eigentlichen
//         Restart da laengst an eine entkoppelte transiente Unit uebergeben,
//         und das Frontend erkennt den Neustart am Verbindungsverlust.
// log:    Fortschritt/Ergebnis des laufenden bzw. letzten Laufs.

const UPDATE_CHECK_TTL_MS = 5 * 60 * 1000;
const UPDATE_OUT_MAX = 64 * 1024;           // Puffer-Obergrenze fuer die Ausgabe

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: __dirname, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: '', err: (stderr || err.message || '').trim() });
      else resolve({ ok: true, out: stdout.trim(), err: '' });
    });
  });
}

let updCache = { checkedAt: 0, behind: null, head: '', upstream: '', error: null };
let updChecking = null;      // laufender Check (Single-Flight fuer parallele Polls)
let updRun = null;           // { startedAt, finishedAt, code, output } — code null = laeuft

async function updateCheck(force) {
  if (updChecking) return updChecking;
  if (!force && Date.now() - updCache.checkedAt < UPDATE_CHECK_TTL_MS) return updCache;
  updChecking = (async () => {
    const next = { checkedAt: Date.now(), behind: null, head: '', upstream: '', error: null };
    // fetch kann scheitern (offline, Remote weg) — dann Fehler melden, aber die
    // Zaehlung trotzdem gegen den letzten bekannten Remote-Stand versuchen.
    const f = await git(['fetch', '--quiet']);
    if (!f.ok) next.error = f.err || 'git fetch fehlgeschlagen';
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    next.upstream = up.ok && up.out ? up.out : 'origin/main';
    const head = await git(['rev-parse', '--short', 'HEAD']);
    if (head.ok) next.head = head.out;
    const cnt = await git(['rev-list', '--count', `HEAD..${next.upstream}`]);
    if (cnt.ok) next.behind = parseInt(cnt.out, 10) || 0;
    else if (!next.error) next.error = cnt.err || 'git rev-list fehlgeschlagen';
    updCache = next;
    return next;
  })();
  try { return await updChecking; } finally { updChecking = null; }
}

function startUpdateRun() {
  if (updRun && updRun.code === null) return { error: 'Update laeuft bereits', code: 409 };
  const run = { startedAt: Date.now(), finishedAt: null, code: null, output: '' };
  updRun = run;
  const append = (chunk) => {
    run.output += chunk.toString('utf8');
    if (run.output.length > UPDATE_OUT_MAX) run.output = run.output.slice(-UPDATE_OUT_MAX);
  };
  let child;
  try {
    // stdin zu (deploy/update ist nicht interaktiv); stdout+stderr einsammeln.
    child = spawn(path.join(__dirname, 'deploy', 'update'), [], {
      cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    run.code = -1; run.finishedAt = Date.now();
    run.output = `deploy/update nicht startbar: ${e.message}`;
    return { ok: true };
  }
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (e) => {
    append(`\n[server] Startfehler: ${e.message}\n`);
    if (run.code === null) { run.code = -1; run.finishedAt = Date.now(); }
  });
  child.on('close', (code) => {
    if (run.code === null) { run.code = code === null ? -1 : code; run.finishedAt = Date.now(); }
    // Stand neu bewerten (billig: TTL laeuft, aber nach einem Update soll das
    // Icon sofort wieder gruen werden koennen).
    updateCheck(true).catch(() => {});
  });
  return { ok: true };
}

async function handleUpdate(req, res, route) {
  if (route === '/api/update/status' && req.method === 'GET') {
    const force = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
    const s = await updateCheck(force);
    return sendJson(res, 200, {
      behind: s.behind, head: s.head, upstream: s.upstream,
      checkedAt: s.checkedAt, error: s.error,
      running: !!(updRun && updRun.code === null),
    });
  }
  if (route === '/api/update/run' && req.method === 'POST') {
    const r = startUpdateRun();
    if (r.error) return sendJson(res, r.code, { error: r.error });
    return sendJson(res, 200, { ok: true });
  }
  if (route === '/api/update/log' && req.method === 'GET') {
    if (!updRun) return sendJson(res, 200, { running: false, code: null, output: '' });
    return sendJson(res, 200, {
      running: updRun.code === null, code: updRun.code,
      startedAt: updRun.startedAt, finishedAt: updRun.finishedAt,
      output: updRun.output,
    });
  }
  return sendJson(res, 404, { error: 'Unbekannte Route' });
}

// ---------------------------------------------------------------------------
// HTTP-Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // Build-Stamp des laufenden Backends (fuer die Version-Skew-Erkennung im Frontend).
  if (url === '/api/version') {
    return sendJson(res, 200, { version: BUILD_VERSION });
  }

  // Systemauslastung fuer das Sidebar-Widget (Load 5m, Uptime, RAM/Swap, User, Prozesse).
  if (url === '/api/sysstat') {
    try {
      return sendJson(res, 200, await readSysStat());
    } catch {
      return sendJson(res, 500, { error: 'sysstat fehlgeschlagen' });
    }
  }

  if (url === '/api/sessions') {
    const sessions = await listSessions();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // Session umbenennen (Inline-Edit in der Sidebar): tmux rename-session plus
  // Markierung @user-named, damit das Label ab dann der Session-Name ist.
  if (url === '/api/sessions/rename' && req.method === 'POST') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const from = q.get('name') || '';
    const to = (q.get('new') || '').trim();
    if (from === STANDARD_SESSION) {
      return sendJson(res, 400, { error: 'Standard-Session kann nicht umbenannt werden' });
    }
    if (!(await sessionExists(from))) {
      return sendJson(res, 404, { error: `Session '${from}' nicht gefunden` });
    }
    // Buchstaben/Ziffern plus Leerzeichen, _ und -; kein ':' oder '.'
    // (tmux-Target-Syntax), max. 50 Zeichen.
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,49}$/u.test(to)) {
      return sendJson(res, 400, { error: 'Ungueltiger Name' });
    }
    if (to === from) return sendJson(res, 200, { ok: true, name: to });
    if (to === STANDARD_SESSION || (await sessionExists(to))) {
      return sendJson(res, 409, { error: 'Name bereits vergeben' });
    }
    const r = await tmux(['rename-session', '-t', from, to]);
    if (!r.ok) return sendJson(res, 500, { error: r.err.trim() || 'tmux-Fehler' });
    await tmux(['set-option', '-t', to, '@user-named', '1']);
    return sendJson(res, 200, { ok: true, name: to });
  }

  // Session anlegen ("+"-Knopf in der Sidebar): tmux new-session -d. Der
  // eingegebene Name ist gewollt — @user-named setzt ihn als Sidebar-Label
  // (statt eines spaeteren pane_title), wie beim Umbenennen.
  if (url === '/api/sessions/create' && req.method === 'POST') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const name = (q.get('name') || '').trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,49}$/u.test(name)) {
      return sendJson(res, 400, { error: 'Ungueltiger Name' });
    }
    if (name === STANDARD_SESSION || (await sessionExists(name))) {
      return sendJson(res, 409, { error: 'Name bereits vergeben' });
    }
    const r = await tmux(['new-session', '-d', '-s', name, '-c', HOME]);
    if (!r.ok) return sendJson(res, 500, { error: r.err.trim() || 'tmux-Fehler' });
    await tmux(['set-option', '-t', '=' + name, '@user-named', '1']);
    return sendJson(res, 200, { ok: true, name });
  }

  // Session beenden (×-Knopf, Rueckfrage im Frontend): tmux kill-session.
  // '=' erzwingt exakten Namens-Match — tmux' Praefix-Matching koennte sonst
  // eine andere Session treffen.
  if (url === '/api/sessions/kill' && req.method === 'POST') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const name = q.get('name') || '';
    if (name === STANDARD_SESSION) {
      return sendJson(res, 400, { error: 'Standard-Session kann nicht beendet werden' });
    }
    if (!(await sessionExists(name))) {
      return sendJson(res, 404, { error: `Session '${name}' nicht gefunden` });
    }
    const r = await tmux(['kill-session', '-t', '=' + name]);
    if (!r.ok) return sendJson(res, 500, { error: r.err.trim() || 'tmux-Fehler' });
    return sendJson(res, 200, { ok: true });
  }

  if (url.startsWith('/api/fs/')) {
    return handleFs(req, res, url);
  }

  if (url.startsWith('/api/update/')) {
    return handleUpdate(req, res, url);
  }

  if (url === '/api/clip') {
    return handleClip(req, res);
  }

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// WebSocket -> PTY
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== '/ws') {
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  let term = null;          // aktives PTY
  let session = null;       // tmux-Session-Name (nur im session-Modus)
  let disposables = [];     // onData/onExit-Listener des aktiven PTY

  const baseEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
  };

  // Aktives PTY sauber beenden: erst Listener disposen (damit verspaetete
  // Ausgaben/Exit nicht das naechste PTY stoeren — verhindert Switch-Race),
  // dann den Prozess killen.
  function disposeTerm() {
    for (const d of disposables) { try { d.dispose(); } catch {} }
    disposables = [];
    if (term) { try { term.kill(); } catch {} }
    term = null;
  }

  function spawnPty(mode, cols, rows) {
    const opts = {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: HOME,
      env: baseEnv,
    };
    const p = mode === 'session'
      ? pty.spawn('tmux', ['attach-session', '-t', session], opts)
      : pty.spawn('tmux', ['new-session', '-A', '-s', STANDARD_SESSION], opts);
    term = p;

    disposables.push(p.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, 'utf8'));
    }));
    disposables.push(p.onExit(({ exitCode }) => {
      // Nur reagieren, wenn dieses PTY noch das aktive ist (kein Switch-Race).
      if (term !== p) return;
      term = null;
      send(ws, { t: 'exit', code: exitCode });
      // Verbindung schliessen -> Frontend reconnectet und bekommt eine frische
      // Shell (statt eines toten Prompts).
      try { ws.close(1000, 'pty exit'); } catch {}
    }));
    send(ws, { t: 'ready', mode });
  }

  ws.on('message', async (data, isBinary) => {
    // Binaer-Frames waeren PTY-Input; wir nutzen ausschliesslich JSON-Control.
    if (isBinary) {
      if (term) term.write(data.toString('utf8'));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }

    switch (msg.t) {
      case 'start': {
        disposeTerm();
        session = null;
        if (msg.mode === 'session') {
          if (!(await sessionExists(msg.session))) {
            send(ws, { t: 'error', m: `Session '${msg.session}' nicht gefunden.` });
            return;
          }
          session = msg.session;
          // Hinweis zur Fenstergroesse bei mehreren Clients: tmux-Default ist
          // bereits 'window-size latest' (neuester Client gewinnt), daher keine
          // Option-Mutation noetig. Bei Bedarf global via tmux.conf auf
          // 'largest'/'manual' umstellbar.
        }
        spawnPty(msg.mode === 'session' ? 'session' : 'standard', msg.cols, msg.rows);
        break;
      }

      case 'input':
        if (term && typeof msg.d === 'string') term.write(msg.d);
        break;

      case 'resize':
        if (term && msg.cols > 0 && msg.rows > 0) {
          try { term.resize(msg.cols, msg.rows); } catch {}
        }
        break;
    }
  });

  ws.on('close', () => {
    disposeTerm();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`term-web listening on http://${HOST}:${PORT}`);
});
