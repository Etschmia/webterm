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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

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
    '#{pane_in_mode}', '#{pane_current_command}', '#{pane_title}',
  ].join('\t');
  const r = await tmux(['list-sessions', '-F', fmt]);
  if (!r.ok) return []; // kein tmux-Server -> leere Liste
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const [name, attached, windows, inMode, command] = parts;
      const title = parts.slice(5).join('\t'); // Rest = pane_title (robust ggü. Tabs)
      return {
        name,
        attached: Number(attached) > 0,
        windows: Number(windows) || 0,
        copyMode: inMode === '1',
        command: command || '',
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
// HTTP-Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/sessions') {
    const sessions = await listSessions();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ sessions }));
    return;
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
      : pty.spawn(SHELL, ['-l'], opts);
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
