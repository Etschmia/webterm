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
import {
  canonicalOrigin, isLoopbackHost, isPathInside, terminalSize, validCsrfRequest,
} from './lib/security.js';
import {
  telegramBoot, telegramCancelSetup, telegramRemove, telegramSetToken,
  telegramStart, telegramStatus, telegramStop,
} from './lib/telegram.js';

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
if (!isLoopbackHost(HOST) && process.env.TERM_ALLOW_NON_LOOPBACK !== '1') {
  throw new Error(`Unsichere Bind-Adresse ${HOST}: nur Loopback ist erlaubt. `
    + 'Falls das wirklich beabsichtigt ist, TERM_ALLOW_NON_LOOPBACK=1 setzen.');
}
// Persistente tmux-Session hinter dem "Standard"-Eintrag: attach falls
// vorhanden, sonst neu anlegen (tmux new-session -A). Ueberlebt Reloads
// und Verbindungsabbrueche.
const STANDARD_SESSION = process.env.TERM_STANDARD_SESSION || 'Standard-Webterm';
// Wurzel des Datei-Explorers. Die /api/fs/*-Endpunkte koennen NICHT darueber
// hinaus (Schutz gegen Directory-Traversal in safePath). Default: Home.
const FS_ROOT = path.resolve(process.env.FS_ROOT || HOME);
let FS_ROOT_REAL;
try { FS_ROOT_REAL = fs.realpathSync.native(FS_ROOT); }
catch { throw new Error(`FS_ROOT existiert nicht oder ist nicht lesbar: ${FS_ROOT}`); }

// Sammelverzeichnis fuer Bilder aus der Browser-Zwischenablage (/api/clip).
// Liegt unter HOME, ist damit auch fuer den Datei-Explorer (FS_ROOT=HOME)
// sichtbar. Alte Clips werden beim Hochladen nach CLIP_TTL_MS aufgeraeumt.
const CLIP_DIR = path.join(HOME, '.term-clips');
const CLIP_MAX_BYTES = 25 * 1024 * 1024;        // harte Obergrenze pro Bild
const FS_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;  // harte Obergrenze pro Datei
const WS_MAX_PAYLOAD = 1024 * 1024;              // Terminalinput/Control pro Frame
const WS_MAX_CONNECTIONS = 32;                   // Schutz gegen PTY-Prozessflut
const CLIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // Aufbewahrung: 7 Tage
const CAPTURE_LINES_DEFAULT = 5000;              // Scrollback-Zeilen fuer /api/capture
const CAPTURE_LINES_MAX = 50000;                 // harte Obergrenze pro Abruf
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
  `http://${HOST.includes(':') && !HOST.startsWith('[') ? `[${HOST}]` : HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
].map(canonicalOrigin).filter(Boolean));
for (const o of (process.env.PUBLIC_ORIGIN || '').split(',')) {
  const origin = canonicalOrigin(o);
  if (o.trim() && !origin) throw new Error(`Ungueltiger PUBLIC_ORIGIN: ${o.trim()}`);
  if (origin) ALLOWED_ORIGINS.add(origin);
}
const CSRF_TOKEN = crypto.randomBytes(32).toString('base64url');

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

// Erkannte Agenten. Reihenfolge egal; Vergleich immer gegen comm (s. u.).
const AGENT_COMMANDS = ['claude', 'kimi', 'codex', 'grok', 'muse'];

// comm -> Agent-Name. Normalerweise identisch; muse ist die Ausnahme: der
// Launcher ~/.local/bin/muse ist ein Shell-Skript, das das VERSIONIERTE Binary
// exec't — comm heisst dann 'muse-bin-1.0.3-R2198.1' (und wird von Linux auf
// 15 Zeichen gekuerzt: 'muse-bin-1.0.3-'). Ein Gleichheitsvergleich findet die
// Session deshalb nie; nach jedem muse-Update waere es ausserdem ein anderer
// Name.
function agentFromComm(comm) {
  if (AGENT_COMMANDS.includes(comm)) return comm;
  if (comm.startsWith('muse-bin-')) return 'muse';
  return null;
}

// tmux-Sessions, in deren Pane-Prozess-Subtree gerade ein Agent laeuft.
// pane_current_command taugt dafuer nicht: hinter dem claude-auto-retry-Wrapper
// meldet es 'bash'/'node'. Verlaesslich ist nur der Prozessname comm irgendwo im
// Baum unter dem Pane-PID (gleiche Heuristik wie deploy/term-restart).
// Liefert Map: Session-Name -> { agent, pid }.
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
  const agentPids = new Map(); // pid -> 'claude'|'kimi'|'codex'|'grok'|'muse'
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    parent.set(m[1], m[2]);
    const agent = agentFromComm(m[3].trim());
    if (agent) agentPids.set(m[1], agent);
  }
  const found = new Map();
  for (const [pid, agent] of agentPids) {
    let x = pid;
    for (let i = 0; i < 64 && x && x !== '0'; i++) {
      const session = paneSession.get(x);
      if (session) {
        // Pro Session ein Agent-Eintrag (bei mehreren Panes gewinnt der erste).
        if (!found.has(session)) found.set(session, { agent, pid });
        break;
      }
      x = parent.get(x);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Modell & Effort einer Agent-Session (Chip-Zeile der Sidebar)
// ---------------------------------------------------------------------------
// Quelle ist NICHT das Pane: die TUIs zeigen das aktive Modell nicht
// verlaesslich an (bei Claude Code steht in der Fusszeile je nach Breite und
// Zustand etwas anderes). Alle vier Agenten schreiben ihren Sitzungszustand
// aber unter $HOME weg — von dort kommen Modell und Effort:
//
//   claude  ~/.claude/sessions/<pid>.json  -> sessionId (echte PID-Registry!)
//           ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl  -> je Assistant-
//           Record `message.model` + `effort` (also pro Turn, ein /model- oder
//           /effort-Wechsel mitten in der Sitzung ist damit sofort sichtbar)
//   codex   ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl -> letzter
//           `turn_context` mit `model` + `effort`
//   grok    ~/.grok/sessions/<urlencodeter cwd>/<id>/summary.json ->
//           `current_model_id` + `reasoning_effort`
//   kimi    ~/.kimi-code/sessions/wd_<dir>_<hash>/session_*/agents/main/
//           wire.jsonl -> `model`; einen Effort kennt die Sitzung nicht, der
//           steht global in ~/.kimi-code/config.toml ([thinking].effort)
//   muse    ~/.local/share/muse/runtime/muse/sessions/<sessionId>.json
//           -> `process_generation_hint: "pid=<pid>"` (PID-Registry!), dann
//           ~/.local/share/muse/sessions/<Y>/<M>/<D>/<sessionId>/session.jsonl
//           -> Modell aus dem juengsten `runtime.model_reconfigure.completed`
//           bzw. `run.model.configured`. Den EFFORT schreibt muse nirgends
//           mit; er kommt als einzige Ausnahme aus der Pane-Statuszeile
//           (s. museEffortFromPane).
//
// claude und muse fuehren eine PID-Registry; die anderen drei sind
// ausschliesslich ueber das Arbeitsverzeichnis des Prozesses zuzuordnen —
// daher der Mehrdeutigkeits-Riegel in listSessions() (zwei gleiche Tools im
// selben Verzeichnis => lieber nichts anzeigen als das Falsche).

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// "<mtime>:<size>" als Cache-Signatur einer Datei ('' wenn nicht lesbar).
function statSig(file) {
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

// Die letzten <bytes> einer Datei als Zeilen, NEUESTE ZUERST. Transcripte
// werden viele MB gross (Tool-Ergebnisse), gelesen wird deshalb nur der
// Schwanz; die erste — womoeglich angeschnittene — Zeile faellt weg.
function tailLines(file, bytes = 512 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();
    return lines.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* egal */ } }
  }
}

// Erste Zeile einer Datei (ohne sie ganz zu lesen). Gegenstueck zu tailLines:
// bei codex steht die Zuordnung zum Arbeitsverzeichnis im ERSTEN Record.
function headLine(file, bytes = 64 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    const text = buf.toString('utf8', 0, read);
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* egal */ } }
  }
}

// Die ersten <bytes> einer Datei als Zeilen, NEUESTE ZUERST. Gegenstueck zu
// tailLines fuer Logs, die den gesuchten Wert am ANFANG fuehren (muse schreibt
// das Modell nur beim Start bzw. bei /model, nicht je Turn — im Schwanz einer
// gewachsenen Datei steht es also nicht mehr). Die letzte — womoeglich
// angeschnittene — Zeile faellt weg.
function headLines(file, bytes = 256 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.pop();
    return lines.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* egal */ } }
  }
}

// Ergebnis-Cache. Die Sidebar pollt alle 4 s, die Quelldateien aendern sich nur
// bei echter Agent-Aktivitaet — ohne Cache wuerde jeder Poll dieselben Dateien
// neu parsen. Schluessel = Quelle, Gueltigkeit = deren mtime+size.
const modelCache = new Map(); // key -> { sig, value }
function cachedBySig(key, sig, compute) {
  const hit = modelCache.get(key);
  if (hit && hit.sig === sig) return hit.value;
  const value = compute();
  // Grob deckeln: beendete Sessions sollen den Cache nicht ewig fuellen.
  if (modelCache.size > 256) modelCache.clear();
  modelCache.set(key, { sig, value });
  return value;
}

// Anzeigename aus der rohen Modell-ID. Bewusst konservativ: was nicht sicher
// erkannt wird, bleibt wie es ist (lieber roh als falsch huebsch).
function modelLabel(id) {
  const raw = String(id || '').split('/').pop().trim();
  if (!raw) return '';
  let m;
  // claude-opus-5 -> "Opus 5", claude-haiku-4-5-20251001 -> "Haiku 4.5"
  if ((m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(raw))) {
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  }
  if (/^gpt-/i.test(raw)) return `GPT-${raw.slice(4)}`;
  if ((m = /^grok-(.+)$/.exec(raw))) return `Grok ${m[1]}`;
  if (/^k\d/i.test(raw)) return raw.toUpperCase();          // kimi: k3, k3-256k
  // muse-spark-1.3-contributor -> "Spark 1.3" (das Suffix ist die Zugangsstufe)
  if ((m = /^muse-([a-z]+)-(\d+(?:\.\d+)*)/.exec(raw))) {
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}`;
  }
  return raw;
}

// Regex-Metazeichen in einem Literal entschaerfen (Modell-IDs enthalten '.').
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Arbeitsverzeichnis eines Prozesses (Linux). Auf Systemen ohne /proc bleibt
// nur der von tmux gemeldete Pfad — den reicht der Aufrufer als Fallback rein.
function procCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; }
}

function claudeModelInfo(pid) {
  const reg = readJsonFile(path.join(HOME, '.claude', 'sessions', `${pid}.json`));
  if (!reg || !reg.sessionId || !reg.cwd) return null;
  // Projekt-Ordnername: jedes Nicht-alphanumerische Zeichen wird zum Bindestrich
  // ("/home/librechat/term" -> "-home-librechat-term").
  const slug = String(reg.cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const file = path.join(HOME, '.claude', 'projects', slug, `${reg.sessionId}.jsonl`);
  return cachedBySig(`claude:${file}`, statSig(file), () => {
    for (const line of tailLines(file)) {
      if (!line.includes('"assistant"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      // Sidechains sind Subagenten — die laufen u. U. auf einem anderen Modell
      // und wuerden das der Hauptsitzung ueberschreiben. Ebenso raus:
      // synthetische Records ("<synthetic>"), die kein echtes Modell nennen.
      if (d.type !== 'assistant' || d.isSidechain) continue;
      const model = d.message && d.message.model;
      if (model && !String(model).startsWith('<')) return { model, effort: d.effort || '' };
    }
    return null;
  });
}

// Die neuesten Rollout-Dateien, ohne den ganzen Baum zu lesen: Jahr/Monat/Tag
// sind lexikografisch sortierbar, es reicht, von hinten so weit zu laufen, bis
// genug Kandidaten beisammen sind.
function newestCodexRollouts(root, limit = 40) {
  const out = [];
  const desc = (dir) => {
    try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; }
  };
  for (const y of desc(root)) {
    for (const mo of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, mo))) {
        const dir = path.join(root, y, mo, d);
        for (const f of desc(dir)) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(path.join(dir, f));
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

function codexModelInfo(cwd) {
  const root = path.join(HOME, '.codex', 'sessions');
  // Zuordnung Rollout <-> cwd steht in der ERSTEN Zeile (session_meta). Das
  // Ergebnis haengt an der mtime der jeweils neuesten Kandidatendatei: laeuft
  // der Turn weiter, bleibt die Datei dieselbe und der Scan entfaellt.
  const candidates = newestCodexRollouts(root);
  if (!candidates.length) return null;
  const file = cachedBySig(`codex-file:${cwd}`, statSig(candidates[0]), () => {
    const byTime = candidates
      .map((f) => ({ f, t: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of byTime) {
      let d;
      try { d = JSON.parse(headLine(f)); } catch { continue; }
      const meta = d && d.payload;
      if (meta && meta.cwd === cwd) return f;
    }
    return '';
  });
  if (!file) return null;
  return cachedBySig(`codex:${file}`, statSig(file), () => {
    for (const line of tailLines(file)) {
      if (!line.includes('"turn_context"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'turn_context' || !d.payload) continue;
      if (d.payload.model) return { model: d.payload.model, effort: d.payload.effort || '' };
    }
    return null;
  });
}

function grokModelInfo(cwd) {
  // Der Sitzungsordner ist der URL-kodierte cwd.
  const dir = path.join(HOME, '.grok', 'sessions', encodeURIComponent(cwd));
  let subs;
  try { subs = fs.readdirSync(dir); } catch { return null; }
  let newest = '', newestT = 0;
  for (const sub of subs) {
    const f = path.join(dir, sub, 'summary.json');
    let t = 0;
    try { t = fs.statSync(f).mtimeMs; } catch { continue; }
    if (t > newestT) { newestT = t; newest = f; }
  }
  if (!newest) return null;
  return cachedBySig(`grok:${newest}`, statSig(newest), () => {
    const d = readJsonFile(newest);
    if (!d || !d.current_model_id) return null;
    return { model: d.current_model_id, effort: d.reasoning_effort || '' };
  });
}

// kimi kennt keinen sitzungseigenen Effort — nur den globalen aus der
// config.toml ([thinking] effort = "…"). Wird als solcher angezeigt.
function kimiEffort() {
  const file = path.join(HOME, '.kimi-code', 'config.toml');
  return cachedBySig(`kimi-effort:${file}`, statSig(file), () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
    const sec = /^\[thinking\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text);
    const m = sec && /^\s*effort\s*=\s*"([^"]+)"/m.exec(sec[1]);
    return m ? m[1] : '';
  });
}

function kimiModelInfo(cwd) {
  // Arbeitsverzeichnis-Ordner heisst wd_<basename>_<hash> — der Praefix macht
  // die Suche billig; die Zugehoerigkeit belegt erst state.json (cwd).
  const root = path.join(HOME, '.kimi-code', 'sessions');
  const prefix = `wd_${path.basename(cwd)}_`;
  let wds;
  try { wds = fs.readdirSync(root).filter((d) => d.startsWith(prefix)); } catch { return null; }
  let wire = '', newestT = 0;
  for (const wd of wds) {
    let sessions;
    try { sessions = fs.readdirSync(path.join(root, wd)); } catch { continue; }
    for (const sess of sessions) {
      if (!sess.startsWith('session_')) continue;
      const dir = path.join(root, wd, sess);
      const state = readJsonFile(path.join(dir, 'state.json'));
      if (!state || state.cwd !== cwd) continue;
      const f = path.join(dir, 'agents', 'main', 'wire.jsonl');
      let t = 0;
      try { t = fs.statSync(f).mtimeMs; } catch { continue; }
      if (t > newestT) { newestT = t; wire = f; }
    }
  }
  if (!wire) return null;
  const model = cachedBySig(`kimi:${wire}`, statSig(wire), () => {
    for (const line of tailLines(wire)) {
      const m = /"model"\s*:\s*"([^"]+)"/.exec(line);
      if (m) return m[1];
    }
    return '';
  });
  return model ? { model, effort: kimiEffort() } : null;
}

// --- muse (Meta "Muse Code") ------------------------------------------------
// Besonderheit gegenueber den anderen Tools: der Sitzungslog liegt nicht flach
// im Tool-Verzeichnis, sondern unter <sessions>/<Y>/<M>/<D>/<sessionId>/ — die
// Zuordnung PID -> sessionId liefert aber eine echte Registry, das Raten ueber
// das Arbeitsverzeichnis entfaellt also (wie bei claude).

// Sitzungsordner zu einer muse-Session-ID. Datumsebenen sind lexikografisch
// sortierbar; gesucht wird von hinten (neueste zuerst) und nur ein Stat pro
// Tagesordner. Der Pfad einer Session aendert sich nie -> Treffer wird dauerhaft
// gemerkt; die Suche laeuft hoechstens ueber MUSE_DIR_PROBE_LIMIT Tage, damit ein
// verwaister Registry-Eintrag nicht bei jedem Poll den ganzen Baum abklappert.
const MUSE_DIR_PROBE_LIMIT = 120;
const museDirCache = new Map(); // sessionId -> Verzeichnis
function museSessionDir(sessionId) {
  const hit = museDirCache.get(sessionId);
  if (hit) return hit;
  const root = path.join(HOME, '.local', 'share', 'muse', 'sessions');
  // Nur die numerischen Datumsebenen: neben <Y>/<M>/<D> liegen im selben Baum
  // interne Ordner wie '.msp-view-v1', die dieselbe Session-ID enthalten.
  const desc = (dir) => {
    try { return fs.readdirSync(dir).filter((e) => /^\d+$/.test(e)).sort().reverse(); }
    catch { return []; }
  };
  let probes = 0;
  for (const y of desc(root)) {
    for (const mo of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, mo))) {
        if (++probes > MUSE_DIR_PROBE_LIMIT) return '';
        const dir = path.join(root, y, mo, d, sessionId);
        if (fs.existsSync(dir)) { museDirCache.set(sessionId, dir); return dir; }
      }
    }
  }
  return '';
}

// Modell aus dem Sitzungslog. Zwei Satzformen: entweder ein Record je Zeile,
// oder ein "retained frame", der mehrere Records buendelt — deren JSON steckt
// dann als STRING in children[].record_json. Beruecksichtigt werden nur die
// Payload-Typen, die wirklich das Sitzungsmodell nennen (ein Subagent-Record
// wuerde sonst das Modell der Hauptsitzung ueberschreiben).
const MUSE_MODEL_PAYLOADS = new Set([
  'runtime.model_reconfigure.completed',
  'runtime.model_selection.initialized',
  'run.model.configured',
  'runtime.session.metadata',
]);
// Reihenfolge: erst der Schwanz (ein spaeteres /model gewinnt), dann der Kopf
// (dort steht das Startmodell — und nur dort, solange nie gewechselt wurde).
function museModelFromLog(file) {
  return museModelFromLines(tailLines(file)) || museModelFromLines(headLines(file));
}

function museModelFromLines(lines) {
  for (const line of lines) {
    if (!line.includes('model_id')) continue;
    let outer;
    try { outer = JSON.parse(line); } catch { continue; }
    const recs = [];
    if (Array.isArray(outer.children)) {
      for (const c of outer.children) {
        try { recs.push(JSON.parse(c.record_json)); } catch { /* Teil-Record */ }
      }
    } else {
      recs.push(outer);
    }
    recs.sort((a, b) => (Number(b.sequence) || 0) - (Number(a.sequence) || 0));
    for (const r of recs) {
      if (!MUSE_MODEL_PAYLOADS.has(r.payload_type)) continue;
      const rec = (r.payload && r.payload.record) || null;
      if (!rec) continue;
      // Beim Reconfigure steht das neue Modell unter `effective`; direkt nach
      // dem Start ist `model_id` noch leer ("") — dann weitersuchen.
      const id = (rec.effective && rec.effective.model_id) || rec.model_id;
      if (id) return String(id);
    }
  }
  return '';
}

// muse schreibt den Effort NICHT in den Sitzungszustand (weder Log noch
// settings.json; /effort aendert ihn nur im Prozess). Einzige verlaessliche
// Quelle ist deshalb die Statuszeile des Panes, die muse dauerhaft anzeigt:
//
//     muse-spark-1.3-contributor · high · ~/depot3
//
// Uebernommen wird sie nur, wenn die dort stehende Modell-ID exakt der aus dem
// Log entspricht. Damit ist die Ausnahme von der Regel "Quelle ist nie das
// Pane" selbstpruefend: eine abgeschnittene (schmales Pane), gescrollte oder
// zu einer anderen Session gehoerende Zeile liefert keinen Treffer, und dann
// bleibt der Effort-Chip lieber leer.
function museEffortFromPane(model, tail) {
  if (!model || !tail) return '';
  const re = new RegExp(`^\\s*${escapeRe(model)}\\s+\u00b7\\s+([a-z]+)\\s+\u00b7`, 'm');
  const m = re.exec(tail);
  return m ? m[1] : '';
}

function museModelInfo(pid, paneTail) {
  // PID-Registry: ein JSON je lebender Session, darin process_generation_hint.
  const regDir = path.join(HOME, '.local', 'share', 'muse', 'runtime', 'muse', 'sessions');
  const sessionId = cachedBySig(`muse-pid:${pid}`, statSig(regDir), () => {
    let files;
    try { files = fs.readdirSync(regDir); } catch { return ''; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const d = readJsonFile(path.join(regDir, f));
      if (d && d.session_id && d.process_generation_hint === `pid=${pid}`) return d.session_id;
    }
    return '';
  });
  if (!sessionId) return null;
  const dir = museSessionDir(sessionId);
  if (!dir) return null;
  const file = path.join(dir, 'session.jsonl');
  const model = cachedBySig(`muse:${file}`, statSig(file), () => museModelFromLog(file));
  // Der Effort haengt am Pane, nicht an einer Datei — bewusst ausserhalb des
  // Datei-Caches, sonst bliebe eine /effort-Aenderung bis zum naechsten
  // Schreibvorgang im Log unsichtbar.
  return model ? { model, effort: museEffortFromPane(model, paneTail) } : null;
}

// Modell + Effort einer Agent-Session. Fehlerhafte/fehlende Quellen liefern
// null — die Sidebar zeigt dann einfach keine Chips (nie ein Fragezeichen).
function agentModelInfo(agent, pid, cwd, paneTail) {
  try {
    if (agent === 'claude') return claudeModelInfo(pid);
    if (agent === 'muse') return museModelInfo(pid, paneTail);
    if (!cwd) return null;
    if (agent === 'codex') return codexModelInfo(cwd);
    if (agent === 'grok') return grokModelInfo(cwd);
    if (agent === 'kimi') return kimiModelInfo(cwd);
  } catch { /* defekte/teilgeschriebene Datei: lieber nichts anzeigen */ }
  return null;
}

// Agent-Status einer Agent-Session: 'working' | 'blocked' | 'idle'.
// Idee von herdr.dev: primaeres Signal bei Claude ist der Spinner, den Claude
// Code in den pane_title schreibt; kimi setzt stattdessen eine Mondphasen-
// Glyphe (🌑–🌘) an den Zeilenanfang seiner Statuszeile im Pane (empirisch
// ermittelt, s. Git-History). Fuer die Unterscheidung blocked/idle wird der
// sichtbare untere Bildschirmrand des Panes gegen BEKANNTE Dialog-Muster
// geprueft. Konservativ wie bei Herdr: 'blocked' nur bei erkanntem Prompt,
// sonst 'idle'.
//
// Liefert { status, tail }: den eingelesenen Pane-Ausschnitt braucht der
// Aufrufer bei muse noch einmal (Effort steht nur dort, s. museEffortFromPane)
// — ein zweites capture-pane pro Poll waere reine Verschwendung.
async function agentPaneStatus(name, title, agent) {
  // Braille-Spinner am Titelanfang = Claude arbeitet (gleiche Erkennung wie
  // die "Claude ist fertig"-Logik im Frontend). Bei kimi steht nichts im Titel.
  if (agent === 'claude' && /^[⠀-⣿]/.test((title || '').trim())) {
    return { status: 'working', tail: '' };
  }
  const r = await tmux(['capture-pane', '-p', '-t', name]);
  if (!r.ok) return { status: 'idle', tail: '' };
  const tail = r.out.split('\n').slice(-25).join('\n');
  return { status: agentStatusFromTail(tail, agent), tail };
}

function agentStatusFromTail(tail, agent) {
  if (agent === 'muse') {
    // Freigabe-Dialog: die Auswahl heisst immer "Allow once" / "Allow for this
    // session" / "Reject" / "Always allow in this workspace".
    if (/\bAllow (once|for this session)\b/.test(tail)) return 'blocked';
    // Arbeitet: Fusszeile "Esc to interrupt" (neben "Working"/"Calling tools").
    if (/\bEsc to interrupt\b/i.test(tail)) return 'working';
    return 'idle';
  }
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
        // Laeuft in dieser Session gerade ein Agent ('claude'|'kimi'|'codex'|
        // 'grok'|'muse')? Steuert das Sidebar-Label ("<Verzeichnis> — Claude"), das
        // nach dem Beenden wieder verschwindet.
        agent: (agents.get(name) || {}).agent || null,
        // PID des Agenten — nur intern (Modell-/Effort-Lookup), wird unten
        // wieder entfernt und geht nicht an den Client.
        agentPid: (agents.get(name) || {}).pid || null,
        // Modell + Effort der Agent-Session (Chip-Zeile); null = unbekannt.
        model: null,
        modelLabel: '',
        effort: '',
        // Woher der Effort stammt: 'session' (pro Turn mitgeschrieben) oder
        // 'global' (nur eine globale Einstellung, so bei kimi) — das Frontend
        // sagt es im Tooltip dazu, damit die Anzeige nicht mehr verspricht,
        // als die Quelle hergibt.
        effortScope: '',
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
    const st = await agentPaneStatus(s.name, s.title, s.agent);
    s.agentStatus = st.status;
    // Nur intern (muse-Effort), wird unten wieder entfernt.
    s.paneTail = st.tail;
  }));

  // Modell/Effort nachtragen. Zuordnung ueber das Arbeitsverzeichnis des
  // Prozesses (bei claude ueber dessen PID-Registry, das ist exakt).
  const agentRows = sessions.filter((s) => s.agent && s.agentPid);
  for (const s of agentRows) s.agentCwd = procCwd(s.agentPid) || s.path || '';
  // Mehrdeutigkeits-Riegel: laufen ZWEI Prozesse desselben Tools im selben
  // Verzeichnis, laesst sich die Sitzungsdatei nicht mehr eindeutig zuordnen —
  // dann lieber nichts anzeigen als das Falsche. claude und muse sind
  // ausgenommen, dort fuehrt die PID ueber eine Registry zur richtigen Datei.
  const byPid = new Set(['claude', 'muse']);
  const perKey = new Map();
  for (const s of agentRows) {
    const key = `${s.agent}\u0000${s.agentCwd}`;
    perKey.set(key, (perKey.get(key) || 0) + 1);
  }
  for (const s of agentRows) {
    const ambiguous = !byPid.has(s.agent) && perKey.get(`${s.agent}\u0000${s.agentCwd}`) > 1;
    const info = ambiguous ? null : agentModelInfo(s.agent, s.agentPid, s.agentCwd, s.paneTail);
    if (info) {
      s.model = info.model;
      s.modelLabel = modelLabel(info.model);
      s.effort = info.effort || '';
      s.effortScope = s.effort ? (s.agent === 'kimi' ? 'global' : 'session') : '';
    }
  }
  for (const s of sessions) { delete s.agentPid; delete s.agentCwd; delete s.paneTail; }
  return sessions;
}

// Session-Namen aus der Sidebar (Anlegen/Umbenennen) pruefen und auf das
// bringen, was tmux tatsaechlich speichert. tmux ersetzt in Session-Namen
// selbst '.' und ':' durch '_' (Target-Syntax session:window.pane) — frueher
// hat die Validierung solche Namen stattdessen mit "Ungueltiger Name"
// abgelehnt, obwohl sie voellig unproblematisch sind. Deshalb hier dieselbe
// Ersetzung vornehmen, damit Antwort und Frontend-State den echten Namen
// tragen (und nicht den eingetippten mit Punkt).
function normalizeSessionName(raw) {
  const cleaned = String(raw || '').trim().replace(/[.:]/g, '_');
  // Fuehrendes '-' bleibt verboten: tmux wuerde es als Option lesen.
  // Erlaubt sind sonst Buchstaben/Ziffern/_ am Anfang, danach zusaetzlich
  // Leerzeichen und '-'; max. 50 Zeichen.
  if (!/^[\p{L}\p{N}_][\p{L}\p{N} _-]{0,49}$/u.test(cleaned)) {
    return {
      error: 'Ungueltiger Name (erlaubt: Buchstaben, Ziffern, Leerzeichen, _ und -, '
        + 'max. 50 Zeichen, nicht mit "-" beginnend)',
    };
  }
  return { name: cleaned };
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request'); return; }
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

// Lexikalische Pfadpruefung allein reicht nicht: stat/read/open folgen Symlinks.
// Deshalb wird jedes bestehende Ziel real aufgeloest und erneut gegen die reale
// FS_ROOT-Grenze geprueft. Uploads verwenden den realen Elternpfad plus O_NOFOLLOW.
async function safeExistingPath(abs) {
  try {
    const real = await fs.promises.realpath(abs);
    return isPathInside(FS_ROOT_REAL, real) ? real : null;
  } catch {
    return null;
  }
}

function openUploadFile(dest, mode = 0o600) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  return new Promise((resolve, reject) => fs.open(dest, flags, mode,
    (err, fd) => err ? reject(err) : resolve(fd)));
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
    const real = await safeExistingPath(abs);
    if (!real) return sendJson(res, 404, { error: 'Verzeichnis nicht gefunden oder ausserhalb von FS_ROOT' });
    let dirents;
    try {
      dirents = await fs.promises.readdir(real, { withFileTypes: true });
    } catch {
      return sendJson(res, 404, { error: 'Verzeichnis nicht gefunden' });
    }
    const entries = await Promise.all(dirents.map(async (d) => {
      let size = 0, mtime = 0;
      try { const st = await fs.promises.stat(path.join(real, d.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', symlink: d.isSymbolicLink(), size, mtime };
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
    const real = await safeExistingPath(abs);
    if (!real) return sendJson(res, 404, { error: 'Verzeichnis nicht gefunden oder ausserhalb von FS_ROOT' });
    return sendJson(res, 200, await gitDirStatus(real));
  }

  // Datei herunterladen (als Attachment).
  if (route === '/api/fs/download' && req.method === 'GET') {
    const real = await safeExistingPath(abs);
    if (!real) return sendJson(res, 404, { error: 'Nicht gefunden oder ausserhalb von FS_ROOT' });
    let st;
    try { st = await fs.promises.stat(real); } catch { return sendJson(res, 404, { error: 'Nicht gefunden' }); }
    if (st.isDirectory()) return sendJson(res, 400, { error: 'Ist ein Verzeichnis' });
    const base = path.basename(abs);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      // ASCII-Fallback + RFC-5987-codierter Name fuer Umlaute u. Ae.
      'Content-Disposition':
        `attachment; filename="${base.replace(/[\r\n"]/g, '')}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    });
    const stream = fs.createReadStream(real);
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
    return;
  }

  // Datei inline ausliefern (Bild-Vorschau). MIME aus der Endung; unbekannt ->
  // octet-stream + nosniff (kein HTML-Sniffing). CSP-Sandbox entschaerft zudem
  // ein direkt aufgerufenes SVG (kein Skript-Ausfuehren).
  if (route === '/api/fs/raw' && req.method === 'GET') {
    const real = await safeExistingPath(abs);
    if (!real) return sendJson(res, 404, { error: 'Nicht gefunden oder ausserhalb von FS_ROOT' });
    let st;
    try { st = await fs.promises.stat(real); } catch { return sendJson(res, 404, { error: 'Nicht gefunden' }); }
    if (st.isDirectory()) return sendJson(res, 400, { error: 'Ist ein Verzeichnis' });
    const ext = path.extname(real).toLowerCase();
    res.writeHead(200, {
      'Content-Type': IMG_MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    const stream = fs.createReadStream(real);
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
    if (Number(req.headers['content-length'] || 0) > FS_UPLOAD_MAX_BYTES) {
      return sendJson(res, 413, { error: 'Datei zu gross' });
    }
    const realDir = await safeExistingPath(abs);
    if (!realDir) return sendJson(res, 404, { error: 'Zielverzeichnis fehlt oder liegt ausserhalb von FS_ROOT' });
    let dirStat;
    try { dirStat = await fs.promises.stat(realDir); } catch { return sendJson(res, 404, { error: 'Zielverzeichnis fehlt' }); }
    if (!dirStat.isDirectory()) return sendJson(res, 400, { error: 'Kein Verzeichnis' });
    const dest = path.join(realDir, name);
    if (!isPathInside(FS_ROOT_REAL, dest)) return sendJson(res, 400, { error: 'Ungueltiger Pfad' });

    // Atomarer Ersatz soll bei bearbeiteten Skripten das Executable-Bit erhalten;
    // Sonderbits werden bewusst nicht uebernommen. Bestehende Symlinks werden
    // abgewiesen, damit ein Speichern ihre Bedeutung nicht ueberraschend aendert.
    let destMode = 0o600;
    try {
      const old = await fs.promises.lstat(dest);
      if (old.isSymbolicLink()) return sendJson(res, 409, { error: 'Symlink-Ziele werden nicht ueberschrieben' });
      if (old.isFile() && !old.isSymbolicLink()) destMode = old.mode & 0o777;
    } catch {}
    const temp = path.join(realDir, `.term-upload-${crypto.randomBytes(12).toString('hex')}`);
    let fd;
    try { fd = await openUploadFile(temp, destMode); }
    catch { return sendJson(res, 400, { error: 'Zieldatei ist nicht sicher schreibbar' }); }
    const out = fs.createWriteStream(temp, { fd, autoClose: true });
    let total = 0;
    let done = false;
    const fail = (code, m) => {
      if (done) return; done = true;
      try { out.destroy(); } catch {}
      fs.promises.unlink(temp).catch(() => {});
      sendJson(res, code, { error: m });
    };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > FS_UPLOAD_MAX_BYTES) { req.unpipe(out); req.resume(); fail(413, 'Datei zu gross'); }
    });
    req.on('error', () => fail(400, 'Uebertragung abgebrochen'));
    out.on('error', () => fail(500, 'Schreibfehler'));
    out.on('finish', async () => {
      if (done) return;
      try {
        await fs.promises.rename(temp, dest); // ersetzt einen Symlink selbst, folgt ihm nicht
        done = true;
        sendJson(res, 200, { ok: true, name });
      } catch {
        fail(500, 'Datei konnte nicht atomar gespeichert werden');
      }
    });
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
      const st = await fs.promises.lstat(fp);
      if (!st.isFile()) return;
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

  try {
    await fs.promises.mkdir(CLIP_DIR, { recursive: true, mode: 0o700 });
    const st = await fs.promises.lstat(CLIP_DIR);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unsafe clip dir');
    await fs.promises.chmod(CLIP_DIR, 0o700);
  }
  catch { return sendJson(res, 500, { error: 'Clip-Verzeichnis nicht anlegbar' }); }

  const name = `clip-${clipStamp()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
  const dest = path.join(CLIP_DIR, name);
  const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
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
    if (total > CLIP_MAX_BYTES) { req.unpipe(out); req.resume(); fail(413, 'Bild zu gross'); }
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
// Telegram-Bot (/api/telegram/*) — Sidebar-Zeile "Telegram"
// ---------------------------------------------------------------------------
// Die eigentliche Logik (Long-Polling, claude -p, Konfigurationsdatei) steckt
// in lib/telegram.js; hier nur das HTTP-Geruest. Schreibende Routen laufen wie
// alle anderen durch die CSRF-Pruefung in handleRequest.

async function handleTelegram(req, res, route) {
  if (route === '/api/telegram/status' && req.method === 'GET') {
    return sendJson(res, 200, telegramStatus());
  }
  if (route === '/api/telegram/setup/token' && req.method === 'POST') {
    const b = await readJsonBody(req);
    const r = await telegramSetToken(b && b.token);
    if (r.error) return sendJson(res, 400, r);
    return sendJson(res, 200, telegramStatus());
  }
  if (route === '/api/telegram/setup/cancel' && req.method === 'POST') {
    telegramCancelSetup();
    return sendJson(res, 200, telegramStatus());
  }
  if (route === '/api/telegram/start' && req.method === 'POST') {
    const r = telegramStart();
    if (r.error) return sendJson(res, 400, r);
    return sendJson(res, 200, telegramStatus());
  }
  if (route === '/api/telegram/stop' && req.method === 'POST') {
    const r = telegramStop();
    if (r.error) return sendJson(res, 400, r);
    return sendJson(res, 200, telegramStatus());
  }
  if (route === '/api/telegram' && req.method === 'DELETE') {
    telegramRemove();
    return sendJson(res, 200, telegramStatus());
  }
  return sendJson(res, 404, { error: 'Unbekannte Route' });
}

// ---------------------------------------------------------------------------
// Zugangsschutz (/api/authguard/*) — Zahnrad "Zugangsschutz" in der Sidebar
// ---------------------------------------------------------------------------
// Das Panel ist Erklaerung + Snippet-Generator, KEIN Schalter: es aendert
// weder /etc/caddy noch startet es etwas neu. Das ist Absicht — dort liegen
// fremde Sites, und ein Webterminal, das seinen eigenen Tuersteher umbauen
// darf, waere genau die Luecke, die der Tuersteher schliessen soll. Erzeugt
// wird derselbe Block wie bei der Erstinstallation; das Einspielen bleibt ein
// bewusster Schritt mit sudo (die Anleitung dazu zeigt das Panel).
//
// Erkennung des Ist-Zustands: NICHT aus der Caddy-Datei (die ist fuer den
// Service-User meist gar nicht lesbar), sondern aus den Headern genau dieser
// Anfrage — Caddy reicht bei Basic Auth den Authorization-Header durch, bei
// forward_auth die per copy_headers gesetzten Remote-*-Header.

const AUTH_SETUP_SCRIPT = path.join(__dirname, 'deploy', 'setup-auth');

function authGuardDetect(req) {
  const h = req.headers || {};
  const fwdUser = h['remote-user'] || h['x-forwarded-user'] || h['x-forwarded-preferred-username'] || '';
  if (fwdUser) return { detected: 'forward', user: String(fwdUser).slice(0, 120) };
  const auth = String(h.authorization || '');
  if (/^basic /i.test(auth)) {
    let user = '';
    try { user = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')[0] || ''; } catch {}
    return { detected: 'basic', user: user.slice(0, 120) };
  }
  return { detected: 'unknown', user: '' };
}

function authGuardStatus(req) {
  const origin = (process.env.PUBLIC_ORIGIN || '').split(',')[0].trim();
  let host = '', urlPath = '';
  if (origin) {
    try { const u = new URL(origin); host = u.host; } catch {}
  }
  // Unterpfad-Betrieb: das Frontend liegt dann nicht unter '/'. Caddy schneidet
  // das Praefix per handle_path ab, der Server sieht es also nicht — deshalb
  // meldet das Frontend seinen BASE-Pfad mit (Query ?base=/term/).
  try { urlPath = new URL(req.url, 'http://localhost').searchParams.get('base') || ''; } catch {}
  return {
    ...authGuardDetect(req),
    publicOrigin: origin,
    host,
    basePath: urlPath,
    port: PORT,
    scriptAvailable: fs.existsSync(AUTH_SETUP_SCRIPT),
    scriptPath: path.relative(__dirname, AUTH_SETUP_SCRIPT),
    repoDir: __dirname,
  };
}

// Snippet-Erzeugung delegiert an deploy/setup-auth --print: die Bloecke haben
// genau EINE Quelle (deploy/lib-caddy-auth.sh), die auch install.sh benutzt.
// execFile ohne Shell + Whitelist der Argumente -> keine Injection; die
// eigentliche Wertepruefung macht das Skript noch einmal selbst.
function authGuardSnippet(body) {
  const mode = String(body && body.mode || '');
  if (!['basic', 'forward', 'none'].includes(mode)) {
    return Promise.resolve({ error: 'Ungueltiger Modus' });
  }
  const indent = body && body.indent === 8 ? '8' : '4';
  const args = ['--print', '--mode', mode, '--indent', indent];
  if (mode === 'forward') {
    const upstream = String(body.upstream || '');
    const portal = String(body.portal || '');
    const uri = String(body.uri || '');
    if (!/^([A-Za-z0-9._-]+:\d{1,5}|unix\/\/[A-Za-z0-9._/-]+)$/.test(upstream)) {
      return Promise.resolve({ error: 'Adresse des Auth-Dienstes: bitte host:port angeben.' });
    }
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(portal)) {
      return Promise.resolve({ error: 'Portal-URL: bitte eine vollstaendige URL angeben.' });
    }
    if (uri && !/^\/[A-Za-z0-9._~/%=&?+-]*$/.test(uri)) {
      return Promise.resolve({ error: 'Verify-Endpunkt: bitte einen Pfad wie /api/verify angeben.' });
    }
    args.push('--upstream', upstream, '--portal', portal);
    if (uri) args.push('--uri', uri);
  }
  return new Promise((resolve) => {
    execFile(AUTH_SETUP_SCRIPT, args, { cwd: __dirname, timeout: 10000, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').trim();
          resolve({ error: err.code === 'ENOENT'
            ? 'deploy/setup-auth nicht gefunden — Repository unvollstaendig?'
            : `Snippet-Erzeugung fehlgeschlagen: ${detail}` });
        } else {
          resolve({ snippet: stdout });
        }
      });
  });
}

async function handleAuthGuard(req, res, route) {
  if (route === '/api/authguard/status' && req.method === 'GET') {
    return sendJson(res, 200, authGuardStatus(req));
  }
  if (route === '/api/authguard/snippet' && req.method === 'POST') {
    const b = await readJsonBody(req, 8 * 1024);
    if (!b) return sendJson(res, 400, { error: 'Ungueltiger Request-Body' });
    const r = await authGuardSnippet(b);
    if (r.error) return sendJson(res, 400, r);
    return sendJson(res, 200, r);
  }
  return sendJson(res, 404, { error: 'Unbekannte Route' });
}

// ---------------------------------------------------------------------------
// HTTP-Server
// ---------------------------------------------------------------------------

function csrfRequestAllowed(req) {
  // Fehlender Origin bleibt fuer nicht-browserbasierte Clients erlaubt, aber
  // nur mit dem explizit zuvor gelesenen Token. Browser senden bei fetch den Origin.
  return validCsrfRequest(req.headers, CSRF_TOKEN, ALLOWED_ORIGINS);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; "
    + "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; "
    + "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
}

async function handleRequest(req, res) {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/csrf' && req.method === 'GET') {
    return sendJson(res, 200, { token: CSRF_TOKEN });
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !csrfRequestAllowed(req)) {
    return sendJson(res, 403, { error: 'CSRF-Pruefung fehlgeschlagen' });
  }

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

  // Scrollback der aktiven Pane einer Session als Klartext — Quelle fuer das
  // "Markieren & Kopieren"-Overlay. xterm.js allein reicht dafuer nicht: tmux
  // schaltet das Terminal in den Alternate-Screen, dort ist term.buffer.active
  // genau EIN Bildschirm ohne History. Das Overlay haette also nichts zu
  // scrollen — man kann nur markieren, was gerade sichtbar ist. Ohne 'session'
  // die Standard-Session.
  if (url === '/api/capture' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const target = q.get('session') || STANDARD_SESSION;
    if (!(await sessionExists(target))) {
      return sendJson(res, 404, { error: `Session '${target}' nicht gefunden` });
    }
    const want = parseInt(q.get('lines') || '', 10);
    const lines = Math.min(Math.max(Number.isFinite(want) ? want : CAPTURE_LINES_DEFAULT, 1),
      CAPTURE_LINES_MAX);
    // Ziel ist die aktive Pane der Session: '=<name>:' — das '=' erzwingt den
    // exakten Namens-Match (tmux' Praefix-Matching koennte sonst eine fremde
    // Session treffen), der Doppelpunkt macht daraus ein Session-Ziel (ohne ihn
    // sucht capture-pane einen Pane namens '=<name>' und scheitert).
    // '-S -<n>' = n Zeilen History vor dem sichtbaren Bild; ist die History
    // kuerzer, klemmt tmux an deren Anfang.
    const r = await tmux(['capture-pane', '-p', '-S', `-${lines}`, '-t', `=${target}:`]);
    if (!r.ok) return sendJson(res, 500, { error: r.err.trim() || 'tmux-Fehler' });
    // Leerzeilen an den Raendern kappen (kurze History -> fuehrende Leerzeilen).
    const rows = r.out.split('\n');
    while (rows.length && rows[0].trim() === '') rows.shift();
    while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
    return sendJson(res, 200, { text: rows.join('\n'), lines: rows.length });
  }

  // Session umbenennen (Inline-Edit in der Sidebar): tmux rename-session plus
  // Markierung @user-named, damit das Label ab dann der Session-Name ist.
  if (url === '/api/sessions/rename' && req.method === 'POST') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const from = q.get('name') || '';
    if (from === STANDARD_SESSION) {
      return sendJson(res, 400, { error: 'Standard-Session kann nicht umbenannt werden' });
    }
    if (!(await sessionExists(from))) {
      return sendJson(res, 404, { error: `Session '${from}' nicht gefunden` });
    }
    const checked = normalizeSessionName(q.get('new'));
    if (checked.error) return sendJson(res, 400, { error: checked.error });
    const to = checked.name;
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
    const checked = normalizeSessionName(q.get('name'));
    if (checked.error) return sendJson(res, 400, { error: checked.error });
    const name = checked.name;
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

  if (url === '/api/telegram' || url.startsWith('/api/telegram/')) {
    return handleTelegram(req, res, url);
  }

  if (url.startsWith('/api/authguard/')) {
    return handleAuthGuard(req, res, url);
  }

  if (url === '/api/clip') {
    return handleClip(req, res);
  }

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  setSecurityHeaders(res);
  handleRequest(req, res).catch((err) => {
    console.error('HTTP request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Interner Serverfehler' });
    else { try { res.destroy(); } catch {} }
  });
});
server.headersTimeout = 15_000;
server.requestTimeout = 120_000;

// ---------------------------------------------------------------------------
// WebSocket -> PTY
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== '/ws') {
    socket.destroy();
    return;
  }
  if (wss.clients.size >= WS_MAX_CONNECTIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
    socket.destroy();
    return;
  }
  const origin = canonicalOrigin(req.headers.origin);
  if ((!origin && process.env.TERM_ALLOW_ORIGINLESS_WS !== '1')
      || (origin && !ALLOWED_ORIGINS.has(origin))) {
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
  let startSeq = 0;         // verwirft ueberholte asynchrone start-Nachrichten

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
    const size = terminalSize(cols, rows);
    const opts = {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
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

  async function handleWsMessage(data, isBinary) {
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
        const seq = ++startSeq;
        disposeTerm();
        session = null;
        if (msg.mode === 'session') {
          if (!(await sessionExists(msg.session))) {
            if (seq !== startSeq) return;
            send(ws, { t: 'error', m: `Session '${msg.session}' nicht gefunden.` });
            return;
          }
          if (seq !== startSeq) return;
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
        if (term && typeof msg.d === 'string' && Buffer.byteLength(msg.d, 'utf8') <= WS_MAX_PAYLOAD) {
          term.write(msg.d);
        }
        break;

      case 'resize': {
        if (term) {
          const size = terminalSize(msg.cols, msg.rows);
          try { term.resize(size.cols, size.rows); } catch {}
        }
        break;
      }
    }
  }

  ws.on('message', (data, isBinary) => {
    handleWsMessage(data, isBinary).catch((err) => {
      console.error('WebSocket message failed:', err);
      send(ws, { t: 'error', m: 'Terminal-Anfrage fehlgeschlagen.' });
    });
  });

  ws.on('close', () => {
    disposeTerm();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`term-web listening on http://${HOST}:${PORT}`);
});

// Konfigurierter Telegram-Bot laeuft nach einem Neustart von selbst wieder an.
telegramBoot();
