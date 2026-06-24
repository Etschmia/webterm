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
  const stdActive = isActive('standard', null);
  const stdEntry = makeEntry({
    label: 'Standard',
    dotClass: '',
    badge: 'ssh',
    active: stdActive,
    onClick: () => switchTo('standard', null),
  });
  // Copy-Mode auch im Standard-Modus: das Overlay ist modusunabhaengig und
  // hilft genauso, sobald hier eine maus-greifende Anwendung laeuft (Claude
  // Code, vim, htop …), die die native xterm-Auswahl unterbindet.
  if (stdActive) stdEntry.append(makeCopyToggle());
  sessionsEl.append(stdEntry);

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

// ---------------------------------------------------------------- Datei-Explorer
// Rechte, einklappbare Spalte: Verzeichnisbaum unter $HOME (serverseitig auf
// FS_ROOT begrenzt), Download per Klick, Upload per Drag & Drop vom Desktop.
const appEl = document.querySelector('.app');
const explorerEl = document.getElementById('explorer');
const fxListEl = document.getElementById('fx-list');
const fxCrumbsEl = document.getElementById('fx-crumbs');
const fxStatusEl = document.getElementById('fx-status');
const fxReopenBtn = document.getElementById('fx-reopen');
let fxPath = ''; // aktuelles Verzeichnis, relativ zu FS_ROOT ('' = Wurzel)

const ICON_DIR = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.6 4.2a1 1 0 0 1 1-1H6l1.3 1.5h6.1a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 1.8h4.6l3 3V13.7a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2.3A.5.5 0 0 1 4 1.8z"/><path d="M8.4 1.8v3.1h3"/></svg>';
const ICON_UP = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V4M4.5 7.5 8 4l3.5 3.5"/></svg>';

// Hover-Vorschau fuer Bilddateien: schwebendes, dem Cursor folgendes <img>.
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const fxPreviewEl = document.createElement('div');
fxPreviewEl.className = 'fx-preview';
fxPreviewEl.hidden = true;
const fxPreviewImg = document.createElement('img');
fxPreviewImg.alt = '';
fxPreviewEl.append(fxPreviewImg);
document.body.append(fxPreviewEl);
let fxPrevX = 0, fxPrevY = 0, fxPrevUrl = null;

function fxMovePreview(x, y) {
  fxPrevX = x; fxPrevY = y;
  if (fxPreviewEl.hidden) return;
  const m = 16;
  const pw = fxPreviewEl.offsetWidth || 320;
  const ph = fxPreviewEl.offsetHeight || 320;
  let left = x - pw - m;                  // bevorzugt links vom Cursor (Explorer ist rechts)
  if (left < m) left = x + m;             // sonst rechts daneben
  let top = Math.max(m, Math.min(y - ph / 2, window.innerHeight - ph - m));
  fxPreviewEl.style.left = left + 'px';
  fxPreviewEl.style.top = top + 'px';
}
function fxShowPreview(url) {
  fxPrevUrl = url;
  fxPreviewImg.onload = () => {
    if (fxPrevUrl !== url) return;        // Cursor inzwischen weiter -> verwerfen
    fxPreviewEl.hidden = false;
    fxMovePreview(fxPrevX, fxPrevY);
  };
  fxPreviewImg.onerror = () => { if (fxPrevUrl === url) fxPreviewEl.hidden = true; };
  fxPreviewImg.src = url;
}
function fxHidePreview() {
  fxPrevUrl = null;
  fxPreviewEl.hidden = true;
  fxPreviewImg.removeAttribute('src');
}

function fxSetStatus(text, isErr) {
  if (!text) { fxStatusEl.hidden = true; return; }
  fxStatusEl.hidden = false;
  fxStatusEl.textContent = text;
  fxStatusEl.classList.toggle('err', !!isErr);
}

function fxFmtSize(n) {
  if (!n) return '';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + u[i];
}

function fxCollapse(collapsed) {
  appEl.classList.toggle('fx-collapsed', collapsed);
  fxReopenBtn.hidden = !collapsed;
  if (!collapsed) fxLoad(fxPath);
  scheduleFit(); // Terminal an die geaenderte Breite anpassen
}

async function fxLoad(rel) {
  fxSetStatus('Lade …');
  let data;
  try {
    const r = await fetch(`${BASE}api/fs/list?path=${encodeURIComponent(rel)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    data = await r.json();
  } catch {
    fxSetStatus('Konnte Verzeichnis nicht laden', true);
    return;
  }
  fxPath = data.path || '';
  fxSetStatus(null);
  fxRenderCrumbs();
  fxRenderList(data.entries || []);
}

function fxRenderCrumbs() {
  fxCrumbsEl.replaceChildren();
  const mk = (label, target) => {
    const c = document.createElement('span');
    c.className = 'fx-crumb';
    c.textContent = label;
    c.addEventListener('click', () => fxLoad(target));
    return c;
  };
  fxCrumbsEl.append(mk('~', ''));
  let acc = '';
  for (const part of (fxPath ? fxPath.split('/').filter(Boolean) : [])) {
    acc = acc ? acc + '/' + part : part;
    const sep = document.createElement('span'); sep.className = 'fx-sep'; sep.textContent = '/';
    fxCrumbsEl.append(sep, mk(part, acc));
  }
}

function fxRenderList(entries) {
  fxHidePreview(); // gehovertes Element wird ersetzt -> mouseleave faellt evtl. aus
  fxListEl.replaceChildren();
  if (fxPath) {
    fxListEl.append(fxItem({ name: '..', type: 'dir' }, ICON_UP, () => {
      const parts = fxPath.split('/').filter(Boolean); parts.pop();
      fxLoad(parts.join('/'));
    }));
  }
  for (const e of entries) {
    const child = fxPath ? fxPath + '/' + e.name : e.name;
    const onClick = e.type === 'dir'
      ? () => fxLoad(child)
      : () => fxDownload(child, e.name);
    const previewUrl = (e.type === 'file' && IMG_RE.test(e.name))
      ? `${BASE}api/fs/raw?path=${encodeURIComponent(child)}`
      : null;
    fxListEl.append(fxItem(e, e.type === 'dir' ? ICON_DIR : ICON_FILE, onClick, previewUrl));
  }
}

function fxItem(e, iconSvg, onClick, previewUrl) {
  const el = document.createElement('div');
  el.className = 'fx-item ' + (e.type === 'dir' ? 'dir' : 'file');
  const icon = document.createElement('span');
  icon.className = 'fx-icon';
  icon.innerHTML = iconSvg;
  const name = document.createElement('span');
  name.className = 'fx-name';
  name.textContent = e.name;
  name.title = e.name;
  el.append(icon, name);
  if (e.type === 'file' && e.size) {
    const sz = document.createElement('span');
    sz.className = 'fx-size';
    sz.textContent = fxFmtSize(e.size);
    el.append(sz);
  }
  el.addEventListener('click', onClick);
  // Bilddatei: schwebende Vorschau, solange der Cursor darueber steht.
  if (previewUrl) {
    el.classList.add('img');
    el.addEventListener('mouseenter', (ev) => { fxShowPreview(previewUrl); fxMovePreview(ev.clientX, ev.clientY); });
    el.addEventListener('mousemove', (ev) => fxMovePreview(ev.clientX, ev.clientY));
    el.addEventListener('mouseleave', fxHidePreview);
  }
  return el;
}

function fxDownload(rel, name) {
  const a = document.createElement('a');
  a.href = `${BASE}api/fs/download?path=${encodeURIComponent(rel)}`;
  a.download = name || '';
  document.body.append(a);
  a.click();
  a.remove();
}

async function fxUpload(files) {
  let ok = 0;
  for (const f of files) {
    fxSetStatus(`Lade hoch: ${f.name} …`);
    try {
      const r = await fetch(
        `${BASE}api/fs/upload?path=${encodeURIComponent(fxPath)}&name=${encodeURIComponent(f.name)}`,
        { method: 'POST', body: f },
      );
      if (r.ok) ok++;
    } catch {}
  }
  fxSetStatus(ok ? `${ok}/${files.length} hochgeladen` : 'Upload fehlgeschlagen', !ok);
  await fxLoad(fxPath);
  setTimeout(() => fxSetStatus(null), 2500);
}

// Drag & Drop: Desktop-Dateien -> Upload ins aktuelle Verzeichnis.
function fxDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  explorerEl.classList.add('drag');
}
explorerEl.addEventListener('dragenter', fxDragOver);
explorerEl.addEventListener('dragover', fxDragOver);
explorerEl.addEventListener('dragleave', (e) => {
  // Nur loslassen, wenn der Cursor den Explorer wirklich verlaesst.
  if (!explorerEl.contains(e.relatedTarget)) explorerEl.classList.remove('drag');
});
explorerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  explorerEl.classList.remove('drag');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) fxUpload(files);
});
// Versehentliches Ablegen ausserhalb des Explorers nicht im Browser oeffnen.
window.addEventListener('dragover', (e) => { if (!explorerEl.contains(e.target)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (!explorerEl.contains(e.target)) e.preventDefault(); });

document.getElementById('fx-refresh').addEventListener('click', () => fxLoad(fxPath));
document.getElementById('fx-collapse').addEventListener('click', () => fxCollapse(true));
fxReopenBtn.addEventListener('click', () => fxCollapse(false));

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

// Datei-Explorer initial: auf schmalen Viewports eingeklappt starten.
fxCollapse(window.innerWidth < 900);
