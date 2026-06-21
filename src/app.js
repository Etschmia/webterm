// term-web Frontend: xterm + Sidebar (Standard / tmux-Sessions / Copy-Mode) + URL-Parsing.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

// ---------------------------------------------------------------- Terminal
const theme = {
  background: '#12100c',
  foreground: '#f5f3ee',
  cursor: '#35c692',
  cursorAccent: '#12100c',
  selectionBackground: 'rgba(53,198,146,0.32)',
  black: '#2a2620', red: '#f2766b', green: '#35c692', yellow: '#e3c46b',
  blue: '#6cb7f0', magenta: '#c79bf0', cyan: '#5fd4c4', white: '#d8d3c8',
  brightBlack: '#5b554b', brightRed: '#ff8f84', brightGreen: '#57e0ab',
  brightYellow: '#f2d98a', brightBlue: '#8fccff', brightMagenta: '#dab6ff',
  brightCyan: '#83e6d8', brightWhite: '#f7f4ee',
};

const term = new Terminal({
  fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
  fontSize: 13.5,
  lineHeight: 1.05,
  cursorBlink: true,
  scrollback: 20000,
  allowProposedApi: true,
  macOptionIsMeta: true,
  theme,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
// Links im Terminal selbst klickbar (oeffnen in neuem Tab).
term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
term.open(document.getElementById('terminal'));
fitAddon.fit();

// ---------------------------------------------------------------- State
const state = {
  active: { mode: 'standard', name: null }, // aktive Auswahl
  sessions: [],
};
let ws = null;
let reconnectTimer = null;

const statusEl = document.getElementById('conn-status');
function setStatus(text, isErr) {
  if (!text) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle('err', !!isErr);
}

// ---------------------------------------------------------------- WebSocket
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function startActive() {
  term.reset();
  const dims = fitAddon.proposeDimensions() || { cols: term.cols, rows: term.rows };
  send({
    t: 'start',
    mode: state.active.mode,
    session: state.active.name,
    cols: dims.cols,
    rows: dims.rows,
  });
}

function connect() {
  clearTimeout(reconnectTimer);
  setStatus('Verbinde …');
  ws = new WebSocket(wsUrl());
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus(null);
    startActive();
    term.focus();
  };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'error') {
        setStatus(msg.m, true);
      }
      // 'exit': der Server schliesst die Verbindung; der Reconnect (onclose)
      // liefert automatisch eine frische Shell.
      return;
    }
    term.write(new Uint8Array(e.data));
    scheduleScan();
  };

  ws.onclose = () => {
    setStatus('Verbindung getrennt — neuer Versuch …', true);
    reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// Tastatureingaben -> PTY
term.onData((d) => send({ t: 'input', d }));

// ---------------------------------------------------------------- Resize
function doResize() {
  fitAddon.fit();
  send({ t: 'resize', cols: term.cols, rows: term.rows });
}
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(doResize, 120);
});

// ---------------------------------------------------------------- Sidebar
const sessionsEl = document.getElementById('sessions');

function isActive(mode, name) {
  return state.active.mode === mode && state.active.name === (name || null);
}

function switchTo(mode, name) {
  if (isActive(mode, name)) { term.focus(); return; }
  state.active = { mode, name: name || null };
  renderSidebar();
  if (ws && ws.readyState === WebSocket.OPEN) startActive();
  else connect();
  // Nach Layoutwechsel neu einpassen.
  requestAnimationFrame(() => { doResize(); term.focus(); });
}

function makeEntry({ label, dotClass, badge, active, onClick }) {
  const el = document.createElement('div');
  el.className = 'entry' + (active ? ' active' : '');
  const row = document.createElement('div');
  row.className = 'entry-row';

  const dot = document.createElement('span');
  dot.className = 'entry-dot' + (dotClass ? ' ' + dotClass : '');
  const name = document.createElement('span');
  name.className = 'entry-name';
  name.textContent = label;
  name.title = label;
  row.append(dot, name);

  if (badge) {
    const b = document.createElement('span');
    b.className = 'entry-badge';
    b.textContent = badge;
    row.append(b);
  }
  el.append(row);
  el.addEventListener('click', onClick);
  return el;
}

function makeCopyToggle(session) {
  const row = document.createElement('div');
  row.className = 'copy-row';
  const label = document.createElement('span');
  label.className = 'copy-label';
  label.innerHTML = 'tmux <b>Copy-Mode</b>';

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!session.copyMode;
  const track = document.createElement('span'); track.className = 'track';
  const thumb = document.createElement('span'); thumb.className = 'thumb';
  sw.append(input, track, thumb);
  input.addEventListener('change', () => {
    send({ t: 'copyMode', on: input.checked });
    term.focus();
  });
  // Klick auf die Toggle-Zeile soll den Eintrag nicht erneut umschalten.
  row.addEventListener('click', (e) => e.stopPropagation());

  row.append(label, sw);
  return row;
}

function renderSidebar() {
  sessionsEl.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'group-label';
  heading.textContent = 'Sessions';
  sessionsEl.append(heading);

  // Standard
  sessionsEl.append(makeEntry({
    label: 'Standard',
    dotClass: '',
    badge: 'ssh',
    active: isActive('standard', null),
    onClick: () => switchTo('standard', null),
  }));

  // tmux-Sessions
  for (const s of state.sessions) {
    const active = isActive('session', s.name);
    const entry = makeEntry({
      label: s.name,
      dotClass: s.attached ? 'attached' : '',
      badge: `${s.windows}▦`,
      active,
      onClick: () => switchTo('session', s.name),
    });
    if (active) entry.append(makeCopyToggle(s));
    sessionsEl.append(entry);
  }
}

async function refreshSessions() {
  try {
    const r = await fetch('/api/sessions', { cache: 'no-store' });
    const data = await r.json();
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    state.sessions = [];
  }
  // Aktive Session verschwunden? -> zurueck auf Standard.
  if (state.active.mode === 'session' &&
      !state.sessions.some((s) => s.name === state.active.name)) {
    switchTo('standard', null);
    return;
  }
  renderSidebar();
}

// ---------------------------------------------------------------- URL-Parsing
const linksPanel = document.getElementById('links-panel');
const linksEl = document.getElementById('links');
const URL_RE = /https?:\/\/[^\s"'`<>\\)\]}]+/g;
const SCAN_LINES = 1200; // jüngster Puffer-Ausschnitt

function extractLinks() {
  const buf = term.buffer.active;
  const end = buf.length;
  const start = Math.max(0, end - SCAN_LINES);
  let text = '';
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (line) text += line.translateToString(true) + '\n';
  }
  const seen = new Set();
  const found = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?)]+$/, ''); // Satzzeichen am Ende abschneiden
    if (url.length < 8 || seen.has(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found.slice(-30).reverse(); // jüngste zuerst
}

function renderLinks(urls) {
  if (!urls.length) {
    linksPanel.hidden = true;
    linksEl.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const url of urls) {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.title = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
  }
  linksEl.replaceChildren(frag);
  linksPanel.hidden = false;
}

let scanTimer = null;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => renderLinks(extractLinks()), 350);
}

// ---------------------------------------------------------------- Init
renderSidebar();
refreshSessions();
setInterval(refreshSessions, 4000);
connect();
