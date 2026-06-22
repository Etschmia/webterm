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

// ---------------------------------------------------------------- State
const state = {
  active: { mode: 'standard', name: null }, // aktive Auswahl
  sessions: [],
};
let ws = null;
let reconnectTimer = null;
let copyMode = false; // Auswahl-/Kopier-Overlay aktiv?

const statusEl = document.getElementById('conn-status');
function setStatus(text, isErr) {
  if (!text) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle('err', !!isErr);
}

// ---------------------------------------------------------------- WebSocket
// Basis-Pfad der Anwendung. Leitet sich aus dem aktuellen Dokumentpfad ab und
// traegt das fuehrende Verzeichnis (mit Slash). So laeuft das Frontend sowohl
// unter der Domain-Wurzel (https://host/) als auch unter einem Unterpfad
// (https://host/term/). Voraussetzung fuer den Unterpfad: abschliessender
// Slash — Caddy sollte /term auf /term/ umleiten (siehe install.sh-Snippet).
const BASE = location.pathname.replace(/[^/]*$/, '');

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${BASE}ws`;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function startActive() {
  term.reset();
  send({
    t: 'start',
    mode: state.active.mode,
    session: state.active.name,
    cols: term.cols,
    rows: term.rows,
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
    if (!copyMode) term.focus();
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

// ---------------------------------------------------------------- Resize / Fit
const workEl = document.querySelector('.work');

function sendResize() {
  if (term.cols > 0 && term.rows > 0) send({ t: 'resize', cols: term.cols, rows: term.rows });
}

// Passt das Terminal in den Container ein und korrigiert anschliessend die
// bekannte FitAddon-Schwaeche: die zur Berechnung benutzte Zellhoehe kann
// kleiner sein als die tatsaechlich gerenderte Zeilenhoehe (DOM-Renderer,
// sub-pixel durch lineHeight) -> die unterste Zeile wird abgeschnitten.
// Daher die echte Zeilenhoehe per getBoundingClientRect messen und die
// Zeilenzahl auf das reduzieren, was vollstaendig sichtbar hineinpasst.
function fitTerminal() {
  if (!term.element) return;
  try { fitAddon.fit(); } catch {}
  const rowEl = term.element.querySelector('.xterm-rows > div');
  if (rowEl) {
    const perRow = rowEl.getBoundingClientRect().height;      // reale Zeilenhoehe (fraktional)
    const avail = term.element.getBoundingClientRect().height; // verfuegbare Hoehe
    if (perRow > 0 && avail > 0) {
      const maxRows = Math.max(2, Math.floor(avail / perRow));
      if (term.rows > maxRows) term.resize(term.cols, maxRows);
    }
  }
  sendResize();
}

let fitScheduled = false;
function scheduleFit() {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => { fitScheduled = false; fitTerminal(); });
}

// ResizeObserver deckt alle Groessenaenderungen ab (Fenster, Zoom, DevTools).
const ro = new ResizeObserver(() => scheduleFit());
ro.observe(workEl);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);

// ---------------------------------------------------------------- Copy-Mode
// Im Copy-Mode legen wir den aktuellen Terminalinhalt als einfachen, markierbaren
// Klartext ueber das Arbeitsfenster. So kann mit der Maus markiert und per Strg-C
// (bzw. Cmd-C) mit den Bordmitteln des Systems kopiert werden — unabhaengig davon,
// ob die laufende Anwendung (tmux mit 'mouse on', Claude Code, vim …) die Maus
// selbst beansprucht. Das Overlay ist ein eingefrorener Schnappschuss: Markieren
// wird dadurch nicht von nachlaufender Ausgabe gestoert (wie in tmux' Copy-Mode).
const copyOverlay = document.createElement('div');
copyOverlay.className = 'copy-overlay';
copyOverlay.hidden = true;
copyOverlay.tabIndex = -1;
const copyText = document.createElement('pre');
copyText.className = 'copy-text';
copyOverlay.append(copyText);

const copyHint = document.createElement('div');
copyHint.className = 'copy-hint';
copyHint.hidden = true;
copyHint.textContent = 'Markieren + Strg-C kopiert · Esc beendet';

workEl.append(copyOverlay, copyHint);

// Sichtbaren Terminalinhalt (inkl. vorhandenem Scrollback) als Text einsammeln.
function snapshotTerminal() {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  // Leerzeilen am Rand kappen (haeufig leerer Scrollback ueber/unter dem Bild).
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function enterCopyMode() {
  if (copyMode) return;
  copyMode = true;
  copyText.textContent = snapshotTerminal();
  copyOverlay.hidden = false;
  copyHint.hidden = false;
  copyOverlay.scrollTop = copyOverlay.scrollHeight; // unten (juengste Ausgabe) zeigen
  copyOverlay.focus();
}

function exitCopyMode() {
  if (!copyMode) return;
  copyMode = false;
  copyOverlay.hidden = true;
  copyHint.hidden = true;
  copyText.textContent = '';
  renderSidebar(); // Toggle-Zustand spiegeln (z. B. bei Esc/Sessionwechsel)
  term.focus();
}

// Esc beendet den Copy-Mode — fokusunabhaengig, solange er aktiv ist.
document.addEventListener('keydown', (e) => {
  if (copyMode && e.key === 'Escape') { e.preventDefault(); exitCopyMode(); }
});

// ---------------------------------------------------------------- Sidebar
const sessionsEl = document.getElementById('sessions');

function isActive(mode, name) {
  return state.active.mode === mode && state.active.name === (name || null);
}

function switchTo(mode, name) {
  if (isActive(mode, name)) { term.focus(); return; }
  exitCopyMode();
  state.active = { mode, name: name || null };
  renderSidebar();
  if (ws && ws.readyState === WebSocket.OPEN) startActive();
  else connect();
  // Nach Layoutwechsel/Reset neu einpassen.
  scheduleFit();
  requestAnimationFrame(() => term.focus());
}

// Bereinigt den tmux pane_title: entfernt fuehrende Status-Glyphe (z. B. ⠂ / ✳,
// die Claude Code als Aktivitaets-Spinner setzt) und Whitespace.
function cleanTitle(t) {
  return (t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// Sprechendes Sidebar-Label: bevorzugt den gesetzten pane_title, faellt aber auf
// den Session-Namen zurueck, wenn der Titel nur ein Shell-Default ist
// (leer, = laufendes Kommando wie "bash", oder ein "user@host"-Prompt-Titel).
function sessionLabel(s) {
  const clean = cleanTitle(s.title);
  const cmd = (s.command || '').toLowerCase();
  const looksDefault = !clean || clean.toLowerCase() === cmd || /^\S+@\S+/.test(clean);
  return looksDefault ? s.name : clean;
}

function makeEntry({ label, tooltip, dotClass, badge, active, onClick }) {
  const el = document.createElement('div');
  el.className = 'entry' + (active ? ' active' : '');
  const row = document.createElement('div');
  row.className = 'entry-row';

  const dot = document.createElement('span');
  dot.className = 'entry-dot' + (dotClass ? ' ' + dotClass : '');
  const name = document.createElement('span');
  name.className = 'entry-name';
  name.textContent = label;
  name.title = tooltip || label;
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

function makeCopyToggle() {
  const row = document.createElement('div');
  row.className = 'copy-row';
  const label = document.createElement('span');
  label.className = 'copy-label';
  label.innerHTML = '<b>Markieren</b> &amp; Kopieren';

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = copyMode;
  const track = document.createElement('span'); track.className = 'track';
  const thumb = document.createElement('span'); thumb.className = 'thumb';
  sw.append(input, track, thumb);
  input.addEventListener('change', () => {
    if (input.checked) enterCopyMode();
    else exitCopyMode();
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
    const label = sessionLabel(s);
    const entry = makeEntry({
      label,
      // Tooltip zeigt zusaetzlich den echten Session-Namen (intern fuer Attach).
      tooltip: label === s.name ? s.name : `${label} · ${s.name}`,
      dotClass: s.attached ? 'attached' : '',
      badge: `${s.windows}▦`,
      active,
      onClick: () => switchTo('session', s.name),
    });
    if (active) entry.append(makeCopyToggle());
    sessionsEl.append(entry);
  }
}

async function refreshSessions() {
  try {
    const r = await fetch(`${BASE}api/sessions`, { cache: 'no-store' });
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
// Marke/Titel an den tatsaechlichen Host anpassen (portabel statt fest auf
// term.martuni.de verdrahtet).
const brandDim = document.querySelector('.brand-dim');
if (brandDim && location.hostname) brandDim.textContent = '.' + location.hostname;
if (location.hostname) document.title = 'term · ' + location.hostname;

renderSidebar();
refreshSessions();
setInterval(refreshSessions, 4000);
fitTerminal();
connect();
