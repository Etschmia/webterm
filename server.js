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
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
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
const HOME = process.env.HOME || os.homedir();
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
// Ohne PUBLIC_ORIGIN sind nur die lokalen Origins erlaubt.
const ALLOWED_ORIGINS = new Set([
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

// tmux-Sessions, in deren Pane-Prozess-Subtree gerade ein Agent (`claude` oder
// `kimi`) laeuft. pane_current_command taugt dafuer nicht: hinter dem
// claude-auto-retry-Wrapper meldet es 'bash'/'node'. Verlaesslich ist nur der
// Prozessname comm irgendwo im Baum unter dem Pane-PID (gleiche
// Heuristik wie deploy/term-restart). Liefert Map: Session-Name -> Agent.
async function agentSessions() {
  const panes = await tmux(['list-panes', '-a', '-F', '#{pane_pid}\t#{session_name}']);
  if (!panes.ok) return new Map();
  const paneSession = new Map();
  for (const line of panes.out.split('\n')) {
    const [pid, session] = line.split('\t');
    if (pid && session) paneSession.set(pid, session);
  }
  if (!paneSession.size) return new Map();

  const ps = await new Promise((resolve) => {
    execFile('ps', ['-e', '-o', 'pid=,ppid=,comm='], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
  const parent = new Map();
  const agentPids = new Map(); // pid -> 'claude'|'kimi'
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    parent.set(m[1], m[2]);
    const comm = m[3].trim();
    if (comm === 'claude' || comm === 'kimi') agentPids.set(m[1], comm);
  }
  const found = new Map();
  for (const [pid, agent] of agentPids) {
    let x = pid;
    for (let i = 0; i < 64 && x && x !== '0'; i++) {
      const session = paneSession.get(x);
      if (session) {
        // Pro Session ein Agent-Eintrag (bei mehreren Panes gewinnt der erste).
        if (!found.has(session)) found.set(session, agent);
        break;
      }
      x = parent.get(x);
    }
  }
  return found;
}

// Agent-Status einer Agent-Session: 'working' | 'blocked' | 'idle'.
// Idee von herdr.dev: primaeres Signal bei Claude ist der Spinner, den Claude
// Code in den pane_title schreibt; kimi setzt stattdessen eine Mondphasen-
// Glyphe (🌑–🌘) an den Zeilenanfang seiner Statuszeile im Pane (empirisch
// ermittelt, s. Git-History). Fuer die Unterscheidung blocked/idle wird der
// sichtbare untere Bildschirmrand des Panes gegen BEKANNTE Dialog-Muster
// geprueft. Konservativ wie bei Herdr: 'blocked' nur bei erkanntem Prompt,
// sonst 'idle'.
async function agentPaneStatus(name, title, agent) {
  // Braille-Spinner am Titelanfang = Claude arbeitet (gleiche Erkennung wie
  // die "Claude ist fertig"-Logik im Frontend). Bei kimi steht nichts im Titel.
  if (agent === 'claude' && /^[⠀-⣿]/.test((title || '').trim())) return 'working';
  const r = await tmux(['capture-pane', '-p', '-t', name]);
  if (!r.ok) return 'idle';
  const tail = r.out.split('\n').slice(-25).join('\n');
  if (agent === 'kimi') {
    // Mondphasen-Spinner in der Statuszeile ("🌖 · Tip: …") = kimi arbeitet.
    if (/^\s*[\u{1F311}-\u{1F318}]/mu.test(tail)) return 'working';
    // Freigabe-/Frage-Dialog: nummerierte Optionen mit Auswahl-Fusszeile
    // ("↑/↓ select · 1/2/3/4 choose · ↵ confirm") — deckt Tool-Freigaben und
    // Rückfragen ab.
    if (/↑\/↓ select .* choose .* ↵ confirm/.test(tail)) return 'blocked';
    return 'idle';
  }
  // Permission-/Frage-Dialoge: Auswahlpfeil vor nummerierter Option ("❯ 1. Yes")
  // faengt alle Dialogarten (Tool-Freigabe, Plan-Freigabe, AskUserQuestion,
  // Trust-Prompt); die Fragetexte decken Varianten ohne sichtbaren Pfeil ab.
  if (/❯\s+\d+\./.test(tail) || /\b(Do you want|Do you trust|Would you like)\b/.test(tail)) {
    return 'blocked';
  }
  // Arbeitszeile am unteren Rand ("… (esc to interrupt)") — greift, falls der
  // Titel-Spinner (noch) fehlt, z. B. direkt nach dem Start.
  if (/esc to interrupt/i.test(tail)) return 'working';
  return 'idle';
}

// Liefert die aktuell laufenden tmux-Sessions als Array.
async function listSessions() {
  // pane_title als LETZTES Feld: es kann Leerzeichen enthalten (Tabs sind in
  // Titeln unueblich), so bleibt das Splitten der Fixfelder stabil.
  const fmt = [
    '#{session_name}', '#{session_attached}', '#{session_windows}',
    '#{pane_in_mode}', '#{pane_current_command}', '#{@user-named}',
    '#{pane_current_path}', '#{pane_title}',
  ].join('\t');
  const [r, agents] = await Promise.all([
    tmux(['list-sessions', '-F', fmt]),
    agentSessions(),
  ]);
  if (!r.ok) return []; // kein tmux-Server -> leere Liste
  const sessions = r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const [name, attached, windows, inMode, command, userNamed, path] = parts;
      const title = parts.slice(7).join('\t'); // Rest = pane_title (robust ggü. Tabs)
      return {
        name,
        attached: Number(attached) > 0,
        windows: Number(windows) || 0,
        copyMode: inMode === '1',
        command: command || '',
        path: path || '',
        // Laeuft in dieser Session gerade ein Agent ('claude'|'kimi')? Steuert
        // das Sidebar-Label ("<Verzeichnis> — Claude"), das nach dem Beenden
        // wieder verschwindet.
        agent: agents.get(name) || null,
        // Vom Nutzer umbenannt (Session-Option @user-named): Sidebar zeigt
        // dann den Session-Namen statt des pane_title.
        userNamed: userNamed === '1',
        // Die Standard-Session steckt hinter dem "Standard"-Eintrag der
        // Sidebar; das Frontend blendet sie in der tmux-Liste aus, nutzt sie
        // aber fuer die "Claude ist fertig"-Erkennung.
        standard: name === STANDARD_SESSION,
        title: (title || '').trim(),
        // Agent-Status, nur fuer Agent-Sessions (sonst null); wird unten
        // nachgetragen. Steuert Ampel-Punkt und Benachrichtigungen der Sidebar.
        agentStatus: null,
      };
    });
  await Promise.all(sessions.filter((s) => s.agent).map(async (s) => {
    s.agentStatus = await agentPaneStatus(s.name, s.title, s.agent);
  }));
  return sessions;
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
    // Cache-Header sind hier Pflicht, nicht Kosmetik: ohne sie darf der Browser
    // heuristisch cachen und liefert nach einem Deploy weiter das alte Bundle
    // aus, ohne nachzufragen — ein normaler Reload half dann nicht, nur ein
    // harter (und Strg+F5 kommt im Terminal gar nicht beim Browser an, xterm
    // schickt daraus ESC[15;5~ an die PTY).
    //   no-cache = darf gecacht werden, muss aber JEDES Mal revalidiert werden.
    //   ETag     = Revalidierung endet dann meist in einem billigen 304.
    // Assets mit ?v=<Hash> im Namen (siehe build.mjs) sind unveraenderlich und
    // duerfen lange liegen bleiben.
    const etag = `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 16)}"`;
    const immutable = /[?&]v=/.test(req.url || '');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
    };
    if (!immutable && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
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

// --- Git-Status je Verzeichnis (Faerbung im Datei-Explorer) -----------------
// Zwei Aufrufe: `rev-parse --show-prefix` (ist es ueberhaupt ein Repo, und wo
// liegt das Verzeichnis relativ zur Repo-Wurzel?) und ein `status` im
// Porcelain-v2-Format, das Branch UND Eintraege in einem Rutsch liefert.
// Pfade sind dort immer relativ zur Repo-Wurzel — daher der Prefix-Abgleich.
// Der Pathspec '.' begrenzt den Scan auf das angezeigte Verzeichnis; die
// '# branch.*'-Kopfzeilen kommen trotzdem vollstaendig.
const GIT_FS_TTL_MS = 1500;                 // deckt Bursts ab (mehrere Panels/Polls)
const GIT_FS_CACHE_MAX = 40;
const gitFsCache = new Map();               // abs -> { at, data }
const GIT_NONE = { repo: false, branch: '', detached: false, ahead: 0, behind: 0, entries: {} };

function gitIn(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

// Das n-te durch Leerzeichen getrennte Feld bis zum Zeilenende (Pfade duerfen
// selbst Leerzeichen enthalten, deshalb kein split(' ')).
function gitField(s, n) {
  let i = 0;
  for (let k = 0; k < n; k++) {
    i = s.indexOf(' ', i);
    if (i < 0) return '';
    i++;
  }
  return s.slice(i);
}

// Ein Code je Eintrag: U Konflikt > D geloescht > A neu (staged) > R umbenannt
// > M geaendert > ? unversioniert > ! ignoriert. Unterverzeichnisse erben den
// hoechsten Code ihres Inhalts (wie in VS Code).
const GIT_RANK = { U: 6, D: 5, A: 4, R: 3, M: 2, '?': 1, '!': 0 };

function gitCodeFromXY(xy) {
  const x = xy[0], y = xy[1];
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'A') return 'A';
  if (x === 'R' || x === 'C' || y === 'R' || y === 'C') return 'R';
  return 'M';
}

function gitParseStatusV2(out, prefix) {
  const info = { repo: true, branch: '', detached: false, ahead: 0, behind: 0, entries: {} };
  const put = (p, code) => {
    if (prefix && !p.startsWith(prefix)) return;
    const rest = p.slice(prefix.length);
    const name = rest.split('/')[0];
    if (!name) return;
    // 'ignoriert' gilt nur fuer den Eintrag selbst: eine einzelne ignorierte
    // Datei in einem versionierten Ordner darf den Ordner nicht ausgrauen.
    if (code === '!' && rest !== name && rest !== name + '/') return;
    const cur = info.entries[name];
    if (cur == null || GIT_RANK[code] > GIT_RANK[cur]) info.entries[name] = code;
  };
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      if (t.startsWith('# branch.head ')) {
        const v = t.slice(14).trim();
        info.detached = v === '(detached)';
        if (!info.detached) info.branch = v;
      } else if (t.startsWith('# branch.oid ')) {
        info.oid = t.slice(13).trim().slice(0, 7);
      } else if (t.startsWith('# branch.ab ')) {
        const m = t.slice(12).match(/\+(\d+)\s+-(\d+)/);
        if (m) { info.ahead = +m[1]; info.behind = +m[2]; }
      }
      continue;
    }
    const kind = t[0];
    if (kind === '?' || kind === '!') { put(t.slice(2), kind); continue; }
    // 1/2 = getrackt (2 = umbenannt/kopiert, mit Original-Pfad im NAECHSTEN
    // NUL-Feld), u = ungemergt. Der Pfad beginnt jeweils nach dem n-ten Feld.
    if (kind === '1' || kind === '2' || kind === 'u') {
      const p = gitField(t, kind === '1' ? 8 : kind === '2' ? 9 : 10);
      if (p) put(p, kind === 'u' ? 'U' : gitCodeFromXY(t.slice(2, 4)));
      if (kind === '2') i++;              // Original-Pfad ueberspringen
    }
  }
  if (info.detached && info.oid) info.branch = info.oid;
  return info;
}

async function gitDirStatus(abs) {
  const hit = gitFsCache.get(abs);
  if (hit && Date.now() - hit.at < GIT_FS_TTL_MS) return hit.data;

  let data = GIT_NONE;
  const prefixOut = await gitIn(abs, ['rev-parse', '--show-prefix']);
  if (prefixOut != null) {
    const prefix = prefixOut.split('\n')[0].trim();   // '' an der Repo-Wurzel
    const status = await gitIn(abs, [
      'status', '--porcelain=v2', '--branch', '-z',
      '--untracked-files=normal', '--ignored=traditional', '--', '.',
    ]);
    // status kann scheitern (index.lock, Timeout, Riesen-Ausgabe) — dann bleibt
    // es ein Repo, nur ohne Faerbung.
    data = status == null ? { ...GIT_NONE, repo: true } : gitParseStatusV2(status, prefix);
  }
  if (gitFsCache.size >= GIT_FS_CACHE_MAX) gitFsCache.clear();
  gitFsCache.set(abs, { at: Date.now(), data });
  return data;
}

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

  // Git-Zustand des angezeigten Verzeichnisses -> { repo, branch, detached,
  // ahead, behind, entries: { <name>: <code> } }. Bewusst ein EIGENER Endpunkt
  // statt Teil von /list: `git status` kann in grossen Repos bummeln, die
  // Dateiliste soll darauf nicht warten (das Frontend faerbt nachtraeglich).
  if (route === '/api/fs/git' && req.method === 'GET') {
    return sendJson(res, 200, await gitDirStatus(abs));
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
// Bugtracker (/api/bugs) — Backend: GitHub Issues des Projekt-Repos
// ---------------------------------------------------------------------------
// "Nur GitHub", KEIN lokaler Fallback: alle Installationen melden in dieselben
// Issues EINES zentralen (privaten) Repos, sodass das Team eine gemeinsame Liste
// sieht. Auth ueber das `gh`-CLI — jede Installation ist als ihr eigener GitHub-
// Account angemeldet (`gh auth login`), daher ist der Issue-Autor die meldende
// Person. Ist gh nicht da/nicht angemeldet/ohne Repo-Zugriff, liefert /api/bugs
// einen klaren Fehler (503) statt still lokal zu speichern.

const BUG_TITLE_MAX = 200;
const BUG_BODY_MAX = 8000;
const BUG_BODY_LIMIT = 64 * 1024; // Request-Body-Obergrenze
const GH_TIMEOUT_MS = 20000;

// gh-Binary robust aufloesen: die systemd-Unit hat ~/.local/bin (wo node UND gh
// liegen) evtl. nicht im PATH. Reihenfolge: GH_BIN -> ~/.local/bin -> ueblich -> PATH.
function resolveGhBin() {
  const cands = [process.env.GH_BIN, path.join(HOME, '.local/bin/gh'),
    '/usr/local/bin/gh', '/usr/bin/gh'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'gh';
}
const GH_BIN = resolveGhBin();

// Ziel-Repo: explizit via BUGS_GITHUB_REPO, sonst aus dem origin-Remote abgeleitet
// (jede Installation zielt so von selbst auf dasselbe zentrale Repo).
function detectBugsRepo() {
  if (process.env.BUGS_GITHUB_REPO) return process.env.BUGS_GITHUB_REPO.trim();
  try {
    const url = execFileSync('git', ['-C', __dirname, 'remote', 'get-url', 'origin'],
      { timeout: 5000 }).toString().trim();
    const clean = url.replace(/\.git$/, '').replace(/\/$/, '');
    const m = clean.match(/github\.com[:/]+([^/]+\/[^/]+)$/i);
    if (m) return m[1];
  } catch {}
  return null;
}
const BUGS_REPO = detectBugsRepo();

function readJsonBody(req, limit = BUG_BODY_LIMIT) {
  return new Promise((resolve) => {
    let data = '', total = 0, aborted = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { aborted = true; try { req.destroy(); } catch {} }
      else data += c;
    });
    req.on('end', () => {
      if (aborted) return resolve(null);
      try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// gh-Aufruf gegen das Bug-Repo. `-R <repo>` wird ans Ende gehaengt (cobra erlaubt
// Flags nach den Positionsargumenten) und execFile nutzt KEINE Shell -> Titel/Body
// gehen sicher als Argumente durch (keine Injection).
function ghBugs(args) {
  return new Promise((resolve) => {
    execFile(GH_BIN, [...args, '-R', BUGS_REPO], {
      timeout: GH_TIMEOUT_MS, env: { ...process.env, HOME }, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: stdout || '', err: (stderr || err.message || '').trim(), code: err.code });
      else resolve({ ok: true, out: stdout || '', err: '', code: 0 });
    });
  });
}

// gh-Fehler in eine verstaendliche, handlungsleitende Meldung uebersetzen.
function ghBugsError(r) {
  const e = (r && r.err || '').toLowerCase();
  let error;
  if (r && r.code === 'ENOENT') error = 'gh-CLI nicht gefunden — bitte GitHub CLI installieren.';
  else if (/not logged|authentication|gh auth login|no token|requires authentication/.test(e))
    error = `Nicht bei GitHub angemeldet — einmalig \`gh auth login\` (mit Zugriff auf ${BUGS_REPO}).`;
  else if (/could not resolve to a repository|not found|does not exist|http 404|resource not accessible/.test(e))
    error = `Kein Zugriff auf ${BUGS_REPO} — als Collaborator hinzufuegen lassen.`;
  else if (/timed out|etimedout|dial tcp|no such host|network/.test(e))
    error = 'GitHub nicht erreichbar (Netzwerk/Timeout).';
  else error = 'GitHub-Bugtracker nicht verfuegbar.';
  return { error, detail: (r && r.err) || '', repo: BUGS_REPO };
}

// Issues -> das vom Frontend erwartete Bug-Format (open zuerst wird dort sortiert).
async function ghListBugs() {
  const r = await ghBugs(['issue', 'list', '--state', 'all', '--limit', '200',
    '--json', 'number,title,body,state,author,createdAt,updatedAt,url']);
  if (!r.ok) return { error: r };
  let arr;
  try { arr = JSON.parse(r.out || '[]'); } catch { return { error: { err: 'Ungueltige gh-Ausgabe' } }; }
  const bugs = arr.map((i) => ({
    id: String(i.number),
    number: i.number,
    title: i.title || '',
    body: i.body || '',
    done: String(i.state || '').toUpperCase() === 'CLOSED',
    author: (i.author && i.author.login) || '',
    url: i.url || '',
    created: i.createdAt ? Date.parse(i.createdAt) : 0,
    updated: i.updatedAt ? Date.parse(i.updatedAt) : 0,
  }));
  return { bugs };
}

async function handleBugs(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  if (!BUGS_REPO) {
    return sendJson(res, 503, {
      error: 'Kein GitHub-Repo ermittelt — origin-Remote fehlt? Sonst BUGS_GITHUB_REPO setzen.',
      repo: null,
    });
  }

  if (req.method === 'GET') {
    const r = await ghListBugs();
    if (r.error) return sendJson(res, 503, ghBugsError(r.error));
    return sendJson(res, 200, { bugs: r.bugs, repo: BUGS_REPO });
  }

  if (req.method === 'POST') {
    const b = await readJsonBody(req);
    const title = (b && typeof b.title === 'string' ? b.title : '').trim();
    if (!title) return sendJson(res, 400, { error: 'Titel fehlt' });
    const bodyText = (b && typeof b.body === 'string' ? b.body : '').slice(0, BUG_BODY_MAX).trim();
    // Herkunft anstempeln: es gibt keinen Login in der App, so ist erkennbar,
    // welche Installation den Bug gemeldet hat. Trenner '\n\n---\n' -> das
    // Frontend blendet den Stempel in der Liste aus, GitHub zeigt ihn voll.
    const stamp = `\n\n---\n_via webterm · ${os.hostname()} · ${process.env.USER || 'user'}_`;
    const cr = await ghBugs(['issue', 'create',
      '--title', title.slice(0, BUG_TITLE_MAX), '--body', bodyText + stamp]);
    if (!cr.ok) return sendJson(res, 503, ghBugsError(cr));
    const list = await ghListBugs();
    return sendJson(res, 200, { ok: true, bugs: list.bugs || [], repo: BUGS_REPO, created: cr.out.trim() });
  }

  // done=true -> Issue schliessen, done=false -> wieder oeffnen.
  if (req.method === 'PATCH') {
    const id = q.get('id') || '';
    if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: 'Ungueltige Issue-Nummer' });
    const b = await readJsonBody(req);
    if (!b || typeof b.done !== 'boolean') return sendJson(res, 400, { error: 'Feld done (boolean) erwartet' });
    const r = await ghBugs(['issue', b.done ? 'close' : 'reopen', id]);
    if (!r.ok) return sendJson(res, 503, ghBugsError(r));
    const list = await ghListBugs();
    return sendJson(res, 200, { ok: true, bugs: list.bugs || [], repo: BUGS_REPO });
  }

  // Hartes Loeschen kann die GitHub-API fuer normale Collaborator NICHT (braucht
  // Admin) -> "Loeschen" bedeutet hier: Issue schliessen (= erledigt).
  if (req.method === 'DELETE') {
    const id = q.get('id') || '';
    if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: 'Ungueltige Issue-Nummer' });
    const r = await ghBugs(['issue', 'close', id]);
    if (!r.ok) return sendJson(res, 503, ghBugsError(r));
    const list = await ghListBugs();
    return sendJson(res, 200, { ok: true, bugs: list.bugs || [], repo: BUGS_REPO });
  }

  return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
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
    // Maschinen-Hostname mitliefern: tmux setzt den pane_title per Default auf
    // den (kurzen) Hostnamen. Das Frontend erkennt so einen uninformativen
    // Default-Titel und faellt in dem Fall auf den Session-Namen zurueck.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ sessions, host: os.hostname() }));
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
    // WICHTIG: hier KEIN '='-Praefix vor dem Ziel. Anders als bei
    // kill-session/list-sessions lehnt `set-option -t '=name'` das exakt-Match-
    // Praefix ab ("no such session: =name") — @user-named wuerde dann NIE gesetzt,
    // die Sidebar fiele auf den pane_title (= Hostname) zurueck und der eingegebene
    // Name "verschwaende". Der Name ist gerade frisch als eindeutig validiert, das
    // Ziel greift also exakt (wie beim Umbenennen einige Zeilen weiter oben).
    await tmux(['set-option', '-t', name, '@user-named', '1']);
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

  if (url === '/api/bugs') {
    return handleBugs(req, res);
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
