// term-web Frontend: xterm + Sidebar (Standard / tmux-Sessions / Copy-Mode) + URL-Parsing.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
// Editor-Fenster (Datei-Explorer -> Bearbeiten)
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tags } from '@lezer/highlight';
// Markdown-Vorschau: geteilte Bibliothek aus dem Nachbarprojekt mdlite
// (github:Etschmia/mdlite). renderMarkdown = marked(gfm) + DOMPurify, OHNE KaTeX
// — der Import zieht daher kein katex ins Bundle. NICHT 'mdlite/math' importieren.
import { renderMarkdown } from 'mdlite';

// ---------------------------------------------------------------- Terminal
const themeDark = {
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
// Helle Variante (warmes Cream, ANSI-Farben abgedunkelt fuer Kontrast auf hell).
const themeLight = {
  background: '#fbfaf6',
  foreground: '#3a352e',
  cursor: '#0f9d6c',
  cursorAccent: '#fbfaf6',
  selectionBackground: 'rgba(15,157,108,0.25)',
  black: '#3a352e', red: '#c2453a', green: '#0f8a5f', yellow: '#9a7b1f',
  blue: '#2f6fb0', magenta: '#8a5bc2', cyan: '#0e8b80', white: '#c9c4b8',
  brightBlack: '#7a7264', brightRed: '#d95f52', brightGreen: '#16a173',
  brightYellow: '#b08f2a', brightBlue: '#3f83c9', brightMagenta: '#9d70d6',
  brightCyan: '#149a8d', brightWhite: '#f5f3ee',
};
const theme = document.documentElement.dataset.theme === 'light' ? themeLight : themeDark;

const term = new Terminal({
  fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
  fontSize: 13.5,
  lineHeight: 1.05,
  cursorBlink: true,
  scrollback: 20000,
  allowProposedApi: true,
  macOptionIsMeta: false,
  theme,
  // Hellmodus: TUI-Apps (z. B. Claude Code) waehlen 256-/Truecolor-Farben fuer
  // dunklen Hintergrund; xterm hellt/dunkelt den Vordergrund pro Zelle nach,
  // bis der Mindestkontrast erreicht ist. Dunkel: aus (Palette unveraendert).
  minimumContrastRatio: theme === themeLight ? 4.5 : 1,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
const searchAddon = new SearchAddon();
term.loadAddon(searchAddon);
// Links im Terminal selbst klickbar (oeffnen in neuem Tab).
term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
term.open(document.getElementById('terminal'));

// ---------------------------------------------------------------- Theme-Umschalter
// data-theme setzt bereits ein Inline-Skript im <head> (vor dem ersten Paint);
// hier nur Schalterzustand, Persistenz und xterm-Palette nachziehen.
const themeToggle = document.getElementById('theme-toggle');
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="color-scheme"]').content = mode;
  localStorage.setItem('term-theme', mode);
  term.options.theme = mode === 'light' ? themeLight : themeDark;
  term.options.minimumContrastRatio = mode === 'light' ? 4.5 : 1;
  themeToggle.checked = mode !== 'light';
}
themeToggle.checked = document.documentElement.dataset.theme !== 'light';
themeToggle.addEventListener('change', () => applyTheme(themeToggle.checked ? 'dark' : 'light'));

// ---------------------------------------------------------------- Scrollback-Suche
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const SEARCH_DECOR = {
  matchBackground: '#e3c46b66',
  activeMatchBackground: '#35c692aa',
  matchOverviewRuler: '#e3c46b',
  activeMatchColorOverviewRuler: '#35c692',
};

function doSearch(dir, incremental) {
  const q = searchInput.value;
  if (!q) {
    searchAddon.clearDecorations();
    searchCount.textContent = '';
    return;
  }
  const opts = { decorations: SEARCH_DECOR, incremental: !!incremental };
  if (dir === 'prev') searchAddon.findPrevious(q, opts);
  else searchAddon.findNext(q, opts);
}
function openSearch() {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}
function closeSearch() {
  searchBar.hidden = true;
  searchAddon.clearDecorations();
  searchCount.textContent = '';
  term.focus();
}
searchInput.addEventListener('input', () => doSearch('next', true));
searchInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // Esc soll nicht zusaetzlich den Copy-Mode beenden
  if (e.key === 'Enter') doSearch(e.shiftKey ? 'prev' : 'next', false);
  else if (e.key === 'Escape') closeSearch();
});
document.getElementById('search-prev').addEventListener('click', () => doSearch('prev', false));
document.getElementById('search-next').addEventListener('click', () => doSearch('next', false));
document.getElementById('search-close').addEventListener('click', closeSearch);
searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
  searchCount.textContent = resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : '0';
});
// Strg+F im Terminal abfangen (statt Browser-Suche); F3/Shift+F3 blaettern.
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  if (e.ctrlKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openSearch();
    return false;
  }
  if (e.key === 'F3' && !searchBar.hidden) {
    e.preventDefault();
    doSearch(e.shiftKey ? 'prev' : 'next', false);
    return false;
  }
  return true;
});

// ---------------------------------------------------------------- State
const state = {
  active: { mode: 'standard', name: null }, // aktive Auswahl
  sessions: [],
};
let ws = null;
let reconnectTimer = null;
let copyMode = false; // Auswahl-/Kopier-Overlay aktiv?

const statusEl = document.getElementById('conn-status');
let statusTimer = null;
function setStatus(text, isErr, autoHideMs) {
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  if (!text) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle('err', !!isErr);
  // Optionales Auto-Ausblenden. Jeder neue setStatus-Aufruf loescht den Timer
  // zuvor, daher blendet er nie eine inzwischen aktuellere Meldung aus.
  if (autoHideMs) statusTimer = setTimeout(() => setStatus(null), autoHideMs);
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
        setStatus(msg.m, true, 30000);
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
  // Verwandte FitAddon-Schwaeche (horizontal statt vertikal): die fuer die
  // Spaltenzahl reservierte Scrollbar-Breite (core.viewport.scrollBarWidth) wird
  // einmalig beim Erzeugen des Terminals gemessen, oft bevor ueberhaupt Layout
  // existiert, und danach nie aktualisiert. Der gerenderte Screen (.xterm-screen)
  // kann dadurch breiter ausfallen als die tatsaechlich sichtbare Breite des
  // Viewports (ohne Scrollbar) -> die rechte Textspalte rutscht optisch unter
  // die Scrollbar. Daher real messen statt der FitAddon-Annahme vertrauen: reale
  // Screen-Breite gegen die reale (Scrollbar-bereinigte) Viewport-Breite pruefen
  // und Spalten ggf. nachkorrigieren.
  const viewportEl = term.element.querySelector('.xterm-viewport');
  const screenEl = term.element.querySelector('.xterm-screen');
  if (viewportEl && screenEl && term.cols > 0) {
    const screenWidth = screenEl.getBoundingClientRect().width;
    const availWidth = viewportEl.clientWidth;
    const perCol = screenWidth / term.cols;
    if (perCol > 0 && availWidth > 0 && screenWidth > availWidth) {
      const maxCols = Math.max(2, Math.floor(availWidth / perCol));
      if (term.cols > maxCols) term.resize(maxCols, term.rows);
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
const ro = new ResizeObserver(() => { scheduleFit(); edClampToWork(); });
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

// ---------------------------------------------------------------- Bild-Paste -> Pfad
// Bild aus der (Browser-)Zwischenablage: hochladen und den resultierenden
// Dateipfad als Tastatureingabe in die laufende Anwendung schreiben. Claude Code
// (und andere Tools) lesen das Bild dann ueber diesen Pfad ein. Der Umweg ist
// noetig, weil der Server headless ist: er hat keine System-Zwischenablage, das
// Bild lebt allein im Browser des Nutzers. Text-Paste bleibt unberuehrt (xterm).
async function uploadClip(file) {
  const r = await fetch(`${BASE}api/clip`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!r.ok) {
    let m = 'Upload fehlgeschlagen';
    try { m = (await r.json()).error || m; } catch {}
    throw new Error(m);
  }
  return (await r.json()).path;
}

function imageFromClipboard(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// Capture-Phase: vor xterms eigenem Paste-Handler. Nur bei einem Bild greifen
// wir ein (preventDefault + stopPropagation); reine Text-Paste laeuft normal
// durch zu xterm.
document.addEventListener('paste', async (e) => {
  if (copyMode) return;                     // Overlay-Auswahl nicht stoeren
  if (!workEl.contains(e.target)) return;   // nur wenn das Terminal den Fokus hat
  const file = imageFromClipboard(e);
  if (!file) return;                        // kein Bild -> normale Text-Paste
  e.preventDefault();
  e.stopPropagation();
  if (!(ws && ws.readyState === WebSocket.OPEN)) { setStatus('Nicht verbunden', true); return; }
  setStatus('Screenshot wird übertragen …');
  try {
    const p = await uploadClip(file);
    // Pfad als getippten Text in die PTY; kein Enter — der Nutzer formuliert
    // seinen Prompt drumherum. Fuehrendes Leerzeichen trennt den Pfad sicher vom
    // zuletzt getippten Wort (sonst klebt er daran), das abschliessende vom
    // folgenden Text. Ein evtl. ueberzaehliges Leerzeichen ist harmlos.
    send({ t: 'input', d: ' ' + p + ' ' });
    setStatus('Screenshot eingefügt ✓');
    setTimeout(() => { if (statusEl.textContent === 'Screenshot eingefügt ✓') setStatus(null); }, 2500);
  } catch (err) {
    setStatus(err.message || 'Übertragung fehlgeschlagen', true);
  }
}, true);

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
  // Andere Session -> Explorer auf deren CWD ziehen (Vergleich zuruecksetzen).
  fxLastCwdAbs = null;
  fxFollowCwd(true);
  if (ws && ws.readyState === WebSocket.OPEN) startActive();
  else connect();
  // Nach Layoutwechsel/Reset neu einpassen.
  scheduleFit();
  requestAnimationFrame(() => term.focus());
}

// Auto-Wechsel zu neu gestarteten Tool-Sessions: die Wrapper der Standard-
// Sitzung (deploy/standard-session-wrappers.sh) melden die frisch angelegte
// Session per OSC 5522 (tmux-Passthrough) durch die PTY. Sidebar nachladen
// und direkt dorthin attachen — die Sequenz erreicht nur Clients, die gerade
// die Standard-Sitzung anzeigen, also genau die richtigen.
term.parser.registerOscHandler(5522, (data) => {
  const name = String(data || '').trim();
  if (name) refreshSessions().then(() => switchTo('session', name));
  return true;
});

// Bereinigt den tmux pane_title: entfernt fuehrende Status-Glyphe (z. B. ⠂ / ✳,
// die Claude Code als Aktivitaets-Spinner setzt) und Whitespace.
function cleanTitle(t) {
  return (t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// Sprechendes Sidebar-Label: bevorzugt den gesetzten pane_title, faellt aber auf
// den Session-Namen zurueck, wenn der Titel nur ein Shell-Default ist
// (leer, = laufendes Kommando wie "bash", oder ein "user@host"-Prompt-Titel).
function sessionLabel(s) {
  // Vom Nutzer vergebener Name (Inline-Edit) hat Vorrang vor dem pane_title.
  if (s.userNamed) return s.name;
  const clean = cleanTitle(s.title);
  const cmd = (s.command || '').toLowerCase();
  const looksDefault = !clean || clean.toLowerCase() === cmd || /^\S+@\S+/.test(clean);
  return looksDefault ? s.name : clean;
}

function makeEntry({ label, tooltip, dotClass, badge, active, onClick, renameValue, onRename, onKill }) {
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

  // Inline-Umbenennen (nur tmux-Sessions): Stift-Knopf oder Doppelklick auf
  // den Namen oeffnet ein Eingabefeld; Enter speichert, Esc/Fokusverlust bricht ab.
  if (onRename) {
    const startEdit = () => {
      if (row.querySelector('.entry-edit')) return; // schon im Edit-Modus
      const input = document.createElement('input');
      input.className = 'entry-edit';
      input.value = renameValue;
      input.maxLength = 50;
      input.spellcheck = false;
      row.replaceChild(input, name);
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        // Original-Label zurücktauschen — gibt zugleich die Render-Sperre
        // (renderSidebar prüft auf .entry-edit) wieder frei.
        row.replaceChild(name, input);
        if (commit && val && val !== renameValue) onRename(val);
      };
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(false));
      input.focus();
      input.select();
    };
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdit(); });

    const pencil = document.createElement('button');
    pencil.className = 'entry-rename';
    pencil.title = 'Umbenennen';
    pencil.setAttribute('aria-label', 'Umbenennen');
    pencil.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.3a1.6 1.6 0 0 1 2.3 2.3L5.5 12.7 2.5 13.5l.8-3L11.3 2.3z"/></svg>';
    pencil.addEventListener('click', (e) => { e.stopPropagation(); startEdit(); });
    row.append(pencil);
  }

  // Session beenden (nur tmux-Sessions): ×-Knopf, Rueckfrage in killSession.
  if (onKill) {
    const x = document.createElement('button');
    x.className = 'entry-kill';
    x.title = 'Session beenden';
    x.setAttribute('aria-label', 'Session beenden');
    x.textContent = '×';
    x.addEventListener('click', (e) => { e.stopPropagation(); onKill(); });
    row.append(x);
  }

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
  // Offenes Inline-Edit nicht zerstoeren: das 4s-Session-Polling (und andere
  // Render-Anlaesse) warten, bis das Eingabefeld geschlossen ist.
  if (sessionsEl.querySelector('.entry-edit')) return;
  sessionsEl.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'group-label';
  const headText = document.createElement('span');
  headText.textContent = 'Sessions';
  const addBtn = document.createElement('button');
  addBtn.className = 'group-add';
  addBtn.title = 'Neue Session anlegen';
  addBtn.setAttribute('aria-label', 'Neue Session anlegen');
  addBtn.textContent = '+';
  addBtn.addEventListener('click', startCreateSession);
  heading.append(headText, addBtn);
  sessionsEl.append(heading);

  // Standard
  const stdActive = isActive('standard', null);
  const stdEntry = makeEntry({
    label: 'Standard',
    // Dahinter liegt serverseitig die persistente tmux-Session
    // "Standard-Webterm" (tmux new-session -A).
    dotClass: '',
    badge: 'tmux',
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
    if (s.standard) continue; // steckt bereits hinter dem Standard-Eintrag
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
      renameValue: s.name,
      onRename: (newName) => renameSession(s.name, newName),
      onKill: () => killSession(s.name, label),
    });
    if (active) entry.append(makeCopyToggle());
    sessionsEl.append(entry);
  }
}

// Neue Session anlegen: Eingabezeile direkt unter der Ueberschrift. Nutzt die
// .entry-edit-Klasse — dadurch greift auch die Render-Sperre in renderSidebar
// (das 4s-Polling zerstoert die offene Eingabe nicht).
function startCreateSession() {
  if (sessionsEl.querySelector('.entry-edit')) return; // schon eine Eingabe offen
  const row = document.createElement('div');
  row.className = 'entry';
  const inner = document.createElement('div');
  inner.className = 'entry-row';
  const dot = document.createElement('span');
  dot.className = 'entry-dot';
  const input = document.createElement('input');
  input.className = 'entry-edit';
  input.placeholder = 'Session-Name';
  input.maxLength = 50;
  input.spellcheck = false;
  inner.append(dot, input);
  row.append(inner);
  sessionsEl.insertBefore(row, sessionsEl.children[1] || null);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    row.remove();
    if (commit && val) createSession(val);
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
  input.focus();
}

async function createSession(name) {
  try {
    const r = await fetch(`${BASE}api/sessions/create?name=${encodeURIComponent(name)}`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Anlegen fehlgeschlagen');
    await refreshSessions();
    switchTo('session', data.name);
    return;
  } catch (e) {
    setStatus(String(e.message || e), true, 4000);
  }
  refreshSessions();
}

// Session beenden — mit Rueckfrage, denn kill-session beendet auch alle darin
// laufenden Prozesse (z. B. eine arbeitende Claude-Instanz).
async function killSession(name, label) {
  const what = label && label !== name ? `${label} (${name})` : name;
  if (!window.confirm(`Session „${what}" wirklich beenden?\nAlle darin laufenden Prozesse werden beendet.`)) return;
  try {
    const r = await fetch(`${BASE}api/sessions/kill?name=${encodeURIComponent(name)}`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Beenden fehlgeschlagen');
  } catch (e) {
    setStatus(String(e.message || e), true, 4000);
  }
  // War es die aktive Session, faellt refreshSessions auf Standard zurueck.
  refreshSessions();
}

// Session serverseitig umbenennen (tmux rename-session). Ein attachter
// tmux-Client bleibt dabei verbunden; nur die aktive Auswahl muss nachziehen.
async function renameSession(oldName, newName) {
  try {
    const r = await fetch(
      `${BASE}api/sessions/rename?name=${encodeURIComponent(oldName)}&new=${encodeURIComponent(newName)}`,
      { method: 'POST' },
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Umbenennen fehlgeschlagen');
    if (state.active.mode === 'session' && state.active.name === oldName) {
      state.active.name = data.name;
    }
  } catch (e) {
    setStatus(String(e.message || e), true, 4000);
  }
  refreshSessions();
}

async function refreshSessions() {
  try {
    const r = await fetch(`${BASE}api/sessions`, { cache: 'no-store' });
    const data = await r.json();
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    state.sessions = [];
  }
  updateBusyAndNotify();
  // Aktive Session verschwunden? -> zurueck auf Standard.
  if (state.active.mode === 'session' &&
      !state.sessions.some((s) => s.name === state.active.name)) {
    switchTo('standard', null);
    return;
  }
  renderSidebar();
}

// ---------------------------------------------------------------- Systemauslastung
// Sidebar-Widget ueber den Sessions: Load (5-Min-Mittel), Uptime, RAM/Swap in %,
// eingeloggte System-User + offene tmux-Sessions und die Prozesszahl. Die Werte
// liefert /api/sysstat; die Session-Zahl stammt aus dem ohnehin gepollten
// state.sessions (kein zweiter tmux-Aufruf im Backend).
const sysEl = {
  load: document.getElementById('sys-load'),
  up: document.getElementById('sys-up'),
  mem: document.getElementById('sys-mem'),
  memBar: document.getElementById('sys-mem-bar'),
  swap: document.getElementById('sys-swap'),
  swapBar: document.getElementById('sys-swap-bar'),
  users: document.getElementById('sys-users'),
  procs: document.getElementById('sys-procs'),
};

function sysFmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Ampelfarbe fuer die Auslastungsbalken: gruen < 70 %, gelb < 90 %, sonst rot.
function sysBarColor(pct) {
  if (pct >= 90) return 'oklch(0.62 0.20 25)';
  if (pct >= 70) return 'oklch(0.75 0.15 80)';
  return 'oklch(0.62 0.14 160)';
}

function sysSetMeter(barEl, valEl, pct) {
  if (pct == null || Number.isNaN(pct)) {
    barEl.style.width = '0%';
    valEl.textContent = '–';
    return;
  }
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  barEl.style.width = p + '%';
  barEl.style.background = sysBarColor(p);
  valEl.textContent = p + '%';
}

async function refreshSysStat() {
  let s;
  try {
    const r = await fetch(`${BASE}api/sysstat`, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    s = await r.json();
  } catch {
    return; // stiller Fehlschlag – zuletzt bekannte Werte stehen lassen
  }
  sysEl.load.textContent = typeof s.load5 === 'number' ? s.load5.toFixed(2) : '–';
  sysEl.up.textContent = typeof s.uptime === 'number' ? sysFmtUptime(s.uptime) : '–';
  sysSetMeter(sysEl.memBar, sysEl.mem, s.memPct);
  sysSetMeter(sysEl.swapBar, sysEl.swap, s.swapPct);
  const users = s.users == null ? '?' : s.users;
  const sess = Array.isArray(state.sessions) ? state.sessions.length : '?';
  sysEl.users.textContent = `${users} · ${sess}`;
  sysEl.procs.textContent = s.procs == null ? '–' : String(s.procs);
}

// ---------------------------------------------------------------- "Claude ist fertig"
// Claude Code setzt waehrend der Arbeit einen Braille-Spinner (⠋⠙⠸ …) an den
// Anfang des pane_title. Verschwindet der Spinner zwischen zwei Polls, ist die
// Session fertig: Badge im Tab-Titel/Favicon, optional Desktop-Benachrichtigung.
const notifyToggle = document.getElementById('notify-toggle');
let notifyEnabled = localStorage.getItem('term-notify') === '1';
notifyToggle.checked = notifyEnabled;
notifyToggle.addEventListener('change', async () => {
  if (notifyToggle.checked && 'Notification' in window && Notification.permission === 'default') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') setStatus('Browser-Benachrichtigungen sind blockiert — es bleibt beim Tab-Badge', true, 5000);
  }
  notifyEnabled = notifyToggle.checked;
  localStorage.setItem('term-notify', notifyEnabled ? '1' : '0');
});

const faviconEl = document.querySelector('link[rel="icon"]');
const FAVICON_IDLE = faviconEl.href;
const FAVICON_DONE = FAVICON_IDLE.replace('%3C/svg%3E', "%3Ccircle cx='12' cy='4' r='3.2' fill='%23e3a008'/%3E%3C/svg%3E");
let doneBadge = false;
function setDoneBadge(on) {
  if (doneBadge === on) return;
  doneBadge = on;
  document.title = on ? '● term' : 'term';
  faviconEl.href = on ? FAVICON_DONE : FAVICON_IDLE;
}
// Beim Zurueckkehren zum Tab nicht nur das Fertig-Badge loeschen, sondern auch
// die Session-Liste sofort neu laden. Hintergrund: Browser drosseln/pausieren
// setInterval in Hintergrund-Tabs (Chrome bis auf ~1x/min oder ganz einfrieren).
// Wer parallel per SSH/Termux eine tmux-Session spawnt (z. B.
// tagesbericht-aktualisieren.sh) und dann zum Webterminal zurueckwechselt, sah
// sie sonst erst beim naechsten (gedrosselten) Poll. Jetzt ist die Sidebar in
// dem Moment aktuell, in dem der Nutzer wieder hinschaut.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { setDoneBadge(false); refreshSessions(); refreshSysStat(); }
});
window.addEventListener('focus', () => { setDoneBadge(false); refreshSessions(); refreshSysStat(); });

const busyByName = new Map(); // Session-Name -> war beim letzten Poll beschaeftigt?
let busyInitialized = false;  // erster Poll setzt nur den Grundzustand
function isClaudeBusy(s) { return /^[⠀-⣿]/.test((s.title || '').trim()); }

function updateBusyAndNotify() {
  const current = new Map();
  for (const s of state.sessions) current.set(s.name, s);
  if (busyInitialized) {
    for (const [name, s] of current) {
      if (busyByName.get(name) === true && !isClaudeBusy(s)) claudeDone(s);
    }
  }
  busyByName.clear();
  for (const [name, s] of current) busyByName.set(name, isClaudeBusy(s));
  busyInitialized = true;
}

function claudeDone(s) {
  const label = s.standard ? 'Standard' : sessionLabel(s);
  const watching = !document.hidden && (s.standard
    ? state.active.mode === 'standard'
    : state.active.mode === 'session' && state.active.name === s.name);
  if (!watching) setStatus(`${label}: Claude ist fertig ✓`, false, 6000);
  if (document.hidden) setDoneBadge(true);
  if (notifyEnabled && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('Claude ist fertig', { body: label, tag: 'term-done-' + s.name });
    n.onclick = () => {
      window.focus();
      if (s.standard) switchTo('standard', null);
      else switchTo('session', s.name);
      n.close();
    };
  }
}

// ---------------------------------------------------------------- Hilfe-Panel
const helpOverlay = document.getElementById('help-overlay');
document.getElementById('help-btn').addEventListener('click', () => { helpOverlay.hidden = false; });
document.getElementById('help-close').addEventListener('click', () => { helpOverlay.hidden = true; });
helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) helpOverlay.hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !helpOverlay.hidden) { e.stopPropagation(); helpOverlay.hidden = true; }
}, true); // Capture: vor dem Copy-Mode-Esc-Handler

// ---------------------------------------------------------------- URL-Parsing
const linksPanel = document.getElementById('links-panel');
const linksEl = document.getElementById('links');
const URL_RE = /https?:\/\/[^\s"'`<>\\)\]}]+/g;
// Zeile endet mitten in einer URL (gleiche Zeichenklasse wie URL_RE, bis Zeilenende).
const URL_TAIL_RE = /https?:\/\/[^\s"'`<>\\)\]}]*$/;
const SCAN_LINES = 1200; // jüngster Puffer-Ausschnitt

function extractLinks() {
  const buf = term.buffer.active;
  const end = buf.length;
  const start = Math.max(0, end - SCAN_LINES);
  let text = '';
  let joinNext = false;
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const s = line.translateToString(true);
    // Umgebrochene Fortsetzungszeilen (isWrapped) direkt anhaengen, sonst
    // zerreisst ein langer URL an der Terminalbreite. TUI-Programme (Ink/
    // Claude Code) brechen selbst hart um — isWrapped bleibt dann false;
    // deshalb auch anhaengen, wenn die Vorzeile randvoll mitten in einer
    // URL endete (joinNext).
    if (i > start && !line.isWrapped && !joinNext) text += '\n';
    text += s;
    // Auf der bereits zusammengefuegten logischen Zeile testen, nicht auf s:
    // Fortsetzungszeilen enthalten selbst kein "https://".
    const tail = text.slice(-4000);
    const logicalLine = tail.slice(tail.lastIndexOf('\n') + 1);
    joinNext = s.length >= term.cols - 2 && URL_TAIL_RE.test(logicalLine);
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
  scanTimer = setTimeout(() => { renderLinks(extractLinks()); fxFollowCwd(false); }, 350);
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
let fxShowHidden = false;
let fxEntries = []; // zuletzt geladene Eintraege (unsortiert, fuer Re-Render bei Sortwechsel)
// Sortierung: std = Server-Reihenfolge (Ordner zuerst, dann Name); mtime/size mit
// Richtung (1 = aufsteigend, -1 = absteigend). Ueberlebt den Reload via localStorage.
let fxSort = { key: 'std', dir: -1 };
try {
  const saved = JSON.parse(localStorage.getItem('term-fx-sort'));
  if (saved && ['std', 'mtime', 'size'].includes(saved.key)) fxSort = { key: saved.key, dir: saved.dir === 1 ? 1 : -1 };
} catch {}
let fxLastCwdAbs = null; // zuletzt gesehenes CWD der Session (absolut), fuer cd-Follow
let fxCwd404Warned = false; // /api/fs/cwd 404 nur einmal ins Log schreiben (nicht bei jedem Poll)

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
  // Beim Aufklappen sofort das aktuelle Terminal-CWD einholen (im eingeklappten
  // Zustand folgt der Explorer nicht mit); fxLoad rendert derweil den Ist-Stand.
  if (!collapsed) { fxLoad(fxPath); fxFollowCwd(true); }
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
  fxEntries = data.entries || [];
  fxSetStatus(null);
  fxRenderCrumbs();
  fxRenderList(fxEntries);
}

// ---- Sortierung: Buttons unterhalb der Kopfzeile. Ordner bleiben immer vor
// Dateien; bei "Größe" werden Ordner nach Name sortiert (stat-Size ist dort
// bedeutungslos). Erneuter Klick auf mtime/size dreht die Richtung um.
const fxSortEl = document.getElementById('fx-sort');

function fxSortEntries(entries) {
  if (fxSort.key === 'std') return entries;
  return entries.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (fxSort.key === 'size' && a.type === 'dir') return a.name.localeCompare(b.name);
    const cmp = (a[fxSort.key] || 0) - (b[fxSort.key] || 0);
    return cmp ? fxSort.dir * cmp : a.name.localeCompare(b.name);
  });
}

function fxRenderSortButtons() {
  for (const b of fxSortEl.querySelectorAll('.fx-sort-btn')) {
    const active = b.dataset.key === fxSort.key;
    b.classList.toggle('active', active);
    b.textContent = b.dataset.label + (active && b.dataset.key !== 'std' ? (fxSort.dir === 1 ? ' ↑' : ' ↓') : '');
  }
}

fxSortEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.fx-sort-btn');
  if (!btn) return;
  const key = btn.dataset.key;
  if (key === fxSort.key && key !== 'std') fxSort.dir = -fxSort.dir; // Richtung umdrehen
  else fxSort = { key, dir: -1 }; // neu: absteigend (neueste/groesste zuerst)
  localStorage.setItem('term-fx-sort', JSON.stringify(fxSort));
  fxRenderSortButtons();
  fxRenderList(fxEntries);
});
fxRenderSortButtons();

// Explorer folgt dem 'cd' im Terminal. Beide Modi laufen in tmux; der Server
// liest das CWD der aktiven Pane (pane_current_path) — kein Shell-Hook noetig.
// Uebernommen wird nur, wenn sich das CWD seit dem letzten Poll wirklich
// geaendert hat: so bleibt manuelles Blaettern im Explorer erhalten und wird
// erst durch ein echtes 'cd' wieder eingeholt. force=true ignoriert den
// Vergleich (Sessionwechsel/Aufklappen). Liegt das CWD ausserhalb FS_ROOT
// (path=null), bleibt der Explorer stehen.
async function fxFollowCwd(force) {
  if (appEl.classList.contains('fx-collapsed')) return;
  const session = state.active.mode === 'session' ? (state.active.name || '') : '';
  let data;
  try {
    const r = await fetch(`${BASE}api/fs/cwd?session=${encodeURIComponent(session)}`, { cache: 'no-store' });
    if (!r.ok) {
      // Ein 404 heisst meist: Backend kennt /api/fs/cwd noch nicht (veraltet, Deploy
      // unvollstaendig). Frueher komplett stumm — jetzt einmalig protokollieren, damit
      // der Grund sichtbar ist, ohne bei jedem Poll zu spammen.
      if (r.status === 404 && !fxCwd404Warned) {
        fxCwd404Warned = true;
        console.warn('[term] /api/fs/cwd -> 404: Backend kennt den Endpunkt nicht — Explorer folgt dem cd nicht. Deploy unvollstaendig? (Backend-Restart nötig)');
      }
      return;
    }
    data = await r.json();
  } catch { return; }
  if (!data || data.abs == null) return;
  if (!force && data.abs === fxLastCwdAbs) return;
  fxLastCwdAbs = data.abs;
  if (typeof data.path === 'string' && data.path !== fxPath) fxLoad(data.path);
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
  const visible = fxSortEntries(fxShowHidden ? entries : entries.filter(e => !e.name.startsWith('.')));
  for (const e of visible) {
    const child = fxPath ? fxPath + '/' + e.name : e.name;
    const onClick = e.type === 'dir'
      ? () => fxLoad(child)
      : () => fxDownload(child, e.name);
    const previewUrl = (e.type === 'file' && IMG_RE.test(e.name))
      ? `${BASE}api/fs/raw?path=${encodeURIComponent(child)}`
      : null;
    const item = fxItem(e, e.type === 'dir' ? ICON_DIR : ICON_FILE, onClick, previewUrl);
    // Kontextmenue fuer Dateien: Bearbeiten (Textdateien) + Herunterladen.
    if (e.type === 'file') {
      item.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        fxShowMenu(ev.clientX, ev.clientY, [
          { label: 'Bearbeiten', icon: ICON_EDIT, disabled: !fxEditable(e.name),
            onClick: () => edOpen(child, e.name, e.size) },
          ...(isMarkdown(e.name) ? [
            { label: 'Vorschau (mdlite)', icon: ICON_EYE,
              onClick: () => mdPreviewOpen(child, e.name, e.size) },
          ] : []),
          { label: 'Herunterladen', icon: ICON_DOWNLOAD,
            onClick: () => fxDownload(child, e.name) },
        ]);
      });
    }
    fxListEl.append(item);
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

document.getElementById('fx-home').addEventListener('click', () => fxLoad(''));
document.getElementById('fx-refresh').addEventListener('click', () => fxLoad(fxPath));
document.getElementById('fx-collapse').addEventListener('click', () => fxCollapse(true));
const fxToggleHiddenBtn = document.getElementById('fx-toggle-hidden');
fxToggleHiddenBtn.addEventListener('click', () => {
  fxShowHidden = !fxShowHidden;
  fxToggleHiddenBtn.classList.toggle('active', fxShowHidden);
  fxToggleHiddenBtn.setAttribute('aria-pressed', fxShowHidden);
  fxToggleHiddenBtn.title = fxShowHidden ? 'Versteckte Dateien ausblenden' : 'Versteckte Dateien einblenden';
  fxLoad(fxPath);
});
fxReopenBtn.addEventListener('click', () => fxCollapse(false));

// ---------------------------------------------------------------- Kontextmenü (Datei-Explorer)
const ICON_EDIT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m11.1 2.4 2.5 2.5L5.4 13l-3 .6.6-3z"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5V10M4.8 7.2 8 10.4l3.2-3.2M3 13h10"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="1.9"/></svg>';

const fxMenuEl = document.createElement('div');
fxMenuEl.className = 'fx-menu';
fxMenuEl.hidden = true;
document.body.append(fxMenuEl);

function fxHideMenu() {
  fxMenuEl.hidden = true;
  fxMenuEl.replaceChildren();
}

function fxShowMenu(x, y, items) {
  fxHidePreview(); // schwebende Bild-Vorschau nicht unter dem Menue stehen lassen
  fxMenuEl.replaceChildren();
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = !!it.disabled;
    const ic = document.createElement('span');
    ic.className = 'fx-mi';
    ic.innerHTML = it.icon || '';
    const label = document.createElement('span');
    label.textContent = it.label;
    b.append(ic, label);
    b.addEventListener('click', () => { fxHideMenu(); it.onClick(); });
    fxMenuEl.append(b);
  }
  fxMenuEl.hidden = false;
  // Im Viewport halten (Explorer sitzt am rechten Rand).
  const m = 6;
  fxMenuEl.style.left = Math.max(m, Math.min(x, window.innerWidth - fxMenuEl.offsetWidth - m)) + 'px';
  fxMenuEl.style.top = Math.max(m, Math.min(y, window.innerHeight - fxMenuEl.offsetHeight - m)) + 'px';
}

document.addEventListener('pointerdown', (e) => {
  if (!fxMenuEl.hidden && !fxMenuEl.contains(e.target)) fxHideMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !fxMenuEl.hidden) fxHideMenu();
});
window.addEventListener('blur', fxHideMenu);
fxListEl.addEventListener('scroll', fxHideMenu);

// Als Text bearbeitbare Dateien: bekannte Endungen + bekannte Namen.
const EDIT_EXT = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'json', 'jsonc', 'map', 'html', 'htm', 'css', 'scss', 'less', 'sh', 'bash', 'zsh',
  'py', 'rb', 'pl', 'php', 'lua', 'sql', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini',
  'cfg', 'conf', 'env', 'csv', 'tsv', 'service', 'timer', 'socket', 'desktop',
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'bashrc', 'zshrc', 'profile',
]);
const EDIT_NAMES = new Set(['dockerfile', 'makefile', 'caddyfile', 'license', 'readme']);

// Markdown-Datei? Steuert den zusaetzlichen Vorschau-Eintrag im Kontextmenue.
function isMarkdown(name) {
  return /\.(md|markdown)$/i.test(String(name || ''));
}

function fxEditable(name) {
  const n = String(name || '').toLowerCase();
  if (EDIT_NAMES.has(n)) return true;
  const i = n.lastIndexOf('.');
  // Ohne Endung (z. B. "notiz"): optimistisch anbieten — ob es wirklich Text
  // ist, prueft edOpen beim Laden (Binaer-Erkennung).
  if (i <= 0) return true; // i==0: Dotfile ohne weitere Endung (.bashrc & Co.)
  return EDIT_EXT.has(n.slice(i + 1));
}

// ---------------------------------------------------------------- Editor-Fenster
// Verschieb- und skalierbares Fenster im Arbeitsbereich mit CodeMirror.
// Lesen ueber /api/fs/download (fetch ignoriert Content-Disposition), Schreiben
// ueber /api/fs/upload (schreibt den rohen Body) — kein neuer Server-Endpunkt.
const ED_MAX_BYTES = 2 * 1024 * 1024;

const edWin = document.createElement('div');
edWin.className = 'ed-win';
edWin.hidden = true;
edWin.innerHTML = `
  <div class="ed-head">
    <span class="ed-dirty" hidden title="Ungespeicherte Änderungen"></span>
    <span class="ed-title"></span>
    <button class="ed-save" type="button">Speichern</button>
    <button class="ed-close fx-btn" type="button" title="Schließen" aria-label="Schließen">×</button>
  </div>
  <div class="ed-body"></div>
  <div class="ed-foot">
    <span class="ed-path"></span>
    <span class="ed-status" hidden></span>
    <span class="ed-hint">Strg+S speichert</span>
  </div>`;
workEl.append(edWin);

const edHeadEl = edWin.querySelector('.ed-head');
const edBodyEl = edWin.querySelector('.ed-body');
const edTitleEl = edWin.querySelector('.ed-title');
const edDirtyEl = edWin.querySelector('.ed-dirty');
const edPathEl = edWin.querySelector('.ed-path');
const edStatusEl = edWin.querySelector('.ed-status');

const ed = { path: null, name: null, dirty: false, saving: false };
let edView = null;
let edPlaced = false; // Position/Groesse einmal gesetzt? (bleibt ueber Dateien erhalten)
let edStatusTimer = null;

function edSetStatus(text, isErr, autoHideMs) {
  if (edStatusTimer) { clearTimeout(edStatusTimer); edStatusTimer = null; }
  if (!text) { edStatusEl.hidden = true; return; }
  edStatusEl.hidden = false;
  edStatusEl.textContent = text;
  edStatusEl.classList.toggle('err', !!isErr);
  if (autoHideMs) edStatusTimer = setTimeout(() => edSetStatus(null), autoHideMs);
}

function edSetDirty(d) {
  ed.dirty = d;
  edDirtyEl.hidden = !d;
}

// Syntax- und Editorfarben ueber CSS-Variablen (styles.css definiert sie je Theme),
// dadurch schaltet der Hell-/Dunkel-Umschalter auch offene Editoren live um.
const edHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword, tags.operatorKeyword, tags.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syn-string)' },
  { tag: [tags.comment, tags.blockComment, tags.lineComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-function)' },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: 'var(--syn-property)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syn-number)' },
  { tag: tags.tagName, color: 'var(--syn-tag)' },
  { tag: tags.attributeValue, color: 'var(--syn-string)' },
  { tag: tags.heading, color: 'var(--syn-heading)', fontWeight: '650' },
  { tag: [tags.link, tags.url], color: 'var(--syn-heading)', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--syn-comment)' },
  { tag: tags.invalid, color: 'var(--syn-invalid)' },
]);

const edTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--term-bg)', color: 'var(--ed-fg)', height: '100%', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--ed-caret)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ed-caret)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--ed-selection)' },
  '.cm-activeLine': { backgroundColor: 'var(--ed-activeline)' },
  '.cm-gutters': {
    backgroundColor: 'var(--term-bg)', color: 'var(--ed-gutter-fg)',
    border: 'none', borderRight: '1px solid var(--ed-gutter-border)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--ed-activeline)', color: 'var(--ed-gutter-fg)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ed-match)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ed-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ed-search)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--ed-selection)' },
});

// Sprache anhand des Dateinamens waehlen (null = reiner Text).
function edLanguage(name) {
  const n = String(name || '').toLowerCase();
  const i = n.lastIndexOf('.');
  const ext = i === -1 ? '' : n.slice(i + 1);
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return javascript({ jsx: true });
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'json': case 'jsonc': case 'map': return json();
    case 'html': case 'htm': return html();
    case 'css': case 'scss': case 'less': return css();
    case 'md': case 'markdown': return markdown();
    case 'py': return python();
    case 'yml': case 'yaml': return yaml();
    case 'xml': case 'svg': return xml();
    case 'sh': case 'bash': case 'zsh': case 'env':
    case 'bashrc': case 'zshrc': case 'profile':
      return StreamLanguage.define(shell);
    default:
      if (n === 'dockerfile' || n === 'makefile' || n === 'caddyfile') return StreamLanguage.define(shell);
      return null;
  }
}

const edBaseExtensions = [
  basicSetup,
  keymap.of([
    { key: 'Mod-s', run: () => { edSave(); return true; } },
    indentWithTab,
  ]),
  edTheme,
  syntaxHighlighting(edHighlight),
  EditorView.updateListener.of((u) => { if (u.docChanged) edSetDirty(true); }),
];

async function edOpen(rel, name, size) {
  if (ed.dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
  if (size > ED_MAX_BYTES) { fxSetStatus('Zu groß zum Bearbeiten (max. 2 MB)', true); return; }
  fxSetStatus(`Öffne ${name} …`);
  let text;
  try {
    const r = await fetch(`${BASE}api/fs/download?path=${encodeURIComponent(rel)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    text = await r.text();
  } catch {
    fxSetStatus('Konnte Datei nicht laden', true);
    return;
  }
  // Binaer-Erkennung (fuer Dateien ohne aussagekraeftige Endung): NUL-Bytes
  // oder ein hoher Anteil an UTF-8-Dekodierfehlern (U+FFFD) -> kein Text.
  if (text.includes('\u0000') ||
      (text.length > 0 && (text.split('�').length - 1) / text.length > 0.05)) {
    fxSetStatus(`${name} ist keine Textdatei`, true);
    return;
  }
  fxSetStatus(null);
  ed.path = rel;
  ed.name = name;
  edTitleEl.textContent = name;
  edTitleEl.title = '~/' + rel;
  edPathEl.textContent = '~/' + rel;
  edPathEl.title = '~/' + rel;
  edSetDirty(false);
  edSetStatus(null);
  if (edView) edView.destroy();
  const lang = edLanguage(name);
  const wrap = /\.(md|markdown|txt|text|log)$/i.test(name); // Prosa umbrechen, Code scrollen
  edView = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        ...edBaseExtensions,
        ...(lang ? [lang] : []),
        ...(wrap ? [EditorView.lineWrapping] : []),
      ],
    }),
    parent: edBodyEl,
  });
  edShow();
  edView.focus();
}

async function edSave() {
  if (!ed.path || !edView || ed.saving) return;
  ed.saving = true;
  edSetStatus('Speichere …');
  const content = edView.state.doc.toString();
  const i = ed.path.lastIndexOf('/');
  const dir = i === -1 ? '' : ed.path.slice(0, i);
  try {
    const r = await fetch(
      `${BASE}api/fs/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(ed.name)}`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: content },
    );
    if (!r.ok) throw new Error();
    edSetDirty(false);
    edSetStatus('Gespeichert ✓', false, 2500);
    if (dir === fxPath) fxLoad(fxPath); // Groesse in der Liste auffrischen
  } catch {
    edSetStatus('Speichern fehlgeschlagen', true);
  }
  ed.saving = false;
}

function edClose() {
  if (ed.dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
  edWin.hidden = true;
  if (edView) { edView.destroy(); edView = null; }
  ed.path = null;
  ed.name = null;
  edSetDirty(false);
  edSetStatus(null);
  term.focus();
}

function edShow() {
  edWin.hidden = false;
  if (!edPlaced) {
    edPlaced = true;
    const w = Math.max(320, Math.min(720, workEl.clientWidth - 48));
    const h = Math.max(220, Math.min(560, Math.round(workEl.clientHeight * 0.7)));
    edWin.style.width = w + 'px';
    edWin.style.height = h + 'px';
    edWin.style.left = Math.max(12, Math.round((workEl.clientWidth - w) / 2)) + 'px';
    edWin.style.top = '32px';
  }
  edClampToWork();
}

// Fenster im Arbeitsbereich halten (auch wenn dieser schrumpft).
function edClampToWork() {
  if (edWin.hidden) return;
  const maxW = Math.max(280, workEl.clientWidth - 24);
  const maxH = Math.max(180, workEl.clientHeight - 24);
  if (edWin.offsetWidth > maxW) edWin.style.width = maxW + 'px';
  if (edWin.offsetHeight > maxH) edWin.style.height = maxH + 'px';
  const maxX = Math.max(0, workEl.clientWidth - edWin.offsetWidth);
  const maxY = Math.max(0, workEl.clientHeight - edWin.offsetHeight);
  edWin.style.left = Math.max(0, Math.min(edWin.offsetLeft, maxX)) + 'px';
  edWin.style.top = Math.max(0, Math.min(edWin.offsetTop, maxY)) + 'px';
}

// Verschieben per Titelleiste (Pointer-Capture: bleibt auch ueber dem Terminal dran).
let edDrag = null;
edHeadEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  edDrag = { dx: e.clientX - edWin.offsetLeft, dy: e.clientY - edWin.offsetTop };
  edHeadEl.setPointerCapture(e.pointerId);
});
edHeadEl.addEventListener('pointermove', (e) => {
  if (!edDrag) return;
  const maxX = Math.max(0, workEl.clientWidth - edWin.offsetWidth);
  const maxY = Math.max(0, workEl.clientHeight - edWin.offsetHeight);
  edWin.style.left = Math.max(0, Math.min(e.clientX - edDrag.dx, maxX)) + 'px';
  edWin.style.top = Math.max(0, Math.min(e.clientY - edDrag.dy, maxY)) + 'px';
});
edHeadEl.addEventListener('pointerup', () => { edDrag = null; });
edHeadEl.addEventListener('pointercancel', () => { edDrag = null; });

edWin.querySelector('.ed-save').addEventListener('click', edSave);
edWin.querySelector('.ed-close').addEventListener('click', edClose);
// Strg+S auch, wenn der Fokus im Fenster, aber nicht im Editor liegt. (Der
// saving-Guard in edSave faengt das Doppel-Feuern mit der CodeMirror-Keymap ab.)
edWin.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); edSave(); }
});
// Ungespeicherte Aenderungen nicht kommentarlos mit dem Tab verlieren.
window.addEventListener('beforeunload', (e) => {
  if (ed.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------ Markdown-Vorschau (mdlite)
// Nur-Lese-Fenster im Arbeitsbereich: rendert Markdown ueber die geteilte
// mdlite-Bibliothek (renderMarkdown = marked+DOMPurify, kein KaTeX). Laden wie der
// Editor ueber /api/fs/download; kein Speichern. Fenster-Mechanik spiegelt .ed-win.
const MD_MAX_BYTES = 2 * 1024 * 1024;

const mdWin = document.createElement('div');
mdWin.className = 'md-win';
mdWin.hidden = true;
mdWin.innerHTML = `
  <div class="md-head">
    <span class="md-title"></span>
    <button class="md-close fx-btn" type="button" title="Schließen" aria-label="Schließen">×</button>
  </div>
  <div class="md-body"><div class="mdlite-prose"></div></div>
  <div class="md-foot">
    <span class="md-path"></span>
    <span class="md-hint">Nur Vorschau · Esc schließt</span>
  </div>`;
workEl.append(mdWin);

const mdHeadEl = mdWin.querySelector('.md-head');
const mdBodyEl = mdWin.querySelector('.md-body');
const mdProseEl = mdWin.querySelector('.mdlite-prose');
const mdTitleEl = mdWin.querySelector('.md-title');
const mdPathEl = mdWin.querySelector('.md-path');
let mdPlaced = false;

async function mdPreviewOpen(rel, name, size) {
  if (size > MD_MAX_BYTES) { fxSetStatus('Zu groß für die Vorschau (max. 2 MB)', true); return; }
  fxSetStatus(`Öffne ${name} …`);
  let text;
  try {
    const r = await fetch(`${BASE}api/fs/download?path=${encodeURIComponent(rel)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    text = await r.text();
  } catch {
    fxSetStatus('Konnte Datei nicht laden', true);
    return;
  }
  fxSetStatus(null);
  mdTitleEl.textContent = name;
  mdTitleEl.title = '~/' + rel;
  mdPathEl.textContent = '~/' + rel;
  mdPathEl.title = '~/' + rel;
  // renderMarkdown sanitisiert bereits per DOMPurify -> innerHTML ist sicher.
  mdProseEl.innerHTML = renderMarkdown(text);
  mdBodyEl.scrollTop = 0;
  mdShow();
}

function mdClose() {
  mdWin.hidden = true;
  mdProseEl.innerHTML = '';
  term.focus();
}

function mdShow() {
  mdWin.hidden = false;
  if (!mdPlaced) {
    mdPlaced = true;
    const w = Math.max(320, Math.min(760, workEl.clientWidth - 48));
    const h = Math.max(240, Math.min(620, Math.round(workEl.clientHeight * 0.75)));
    mdWin.style.width = w + 'px';
    mdWin.style.height = h + 'px';
    mdWin.style.left = Math.max(12, Math.round((workEl.clientWidth - w) / 2)) + 'px';
    mdWin.style.top = '28px';
  }
  mdClampToWork();
}

function mdClampToWork() {
  if (mdWin.hidden) return;
  const maxW = Math.max(280, workEl.clientWidth - 24);
  const maxH = Math.max(180, workEl.clientHeight - 24);
  if (mdWin.offsetWidth > maxW) mdWin.style.width = maxW + 'px';
  if (mdWin.offsetHeight > maxH) mdWin.style.height = maxH + 'px';
  const maxX = Math.max(0, workEl.clientWidth - mdWin.offsetWidth);
  const maxY = Math.max(0, workEl.clientHeight - mdWin.offsetHeight);
  mdWin.style.left = Math.max(0, Math.min(mdWin.offsetLeft, maxX)) + 'px';
  mdWin.style.top = Math.max(0, Math.min(mdWin.offsetTop, maxY)) + 'px';
}

let mdDrag = null;
mdHeadEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  mdDrag = { dx: e.clientX - mdWin.offsetLeft, dy: e.clientY - mdWin.offsetTop };
  mdHeadEl.setPointerCapture(e.pointerId);
});
mdHeadEl.addEventListener('pointermove', (e) => {
  if (!mdDrag) return;
  const maxX = Math.max(0, workEl.clientWidth - mdWin.offsetWidth);
  const maxY = Math.max(0, workEl.clientHeight - mdWin.offsetHeight);
  mdWin.style.left = Math.max(0, Math.min(e.clientX - mdDrag.dx, maxX)) + 'px';
  mdWin.style.top = Math.max(0, Math.min(e.clientY - mdDrag.dy, maxY)) + 'px';
});
mdHeadEl.addEventListener('pointerup', () => { mdDrag = null; });
mdHeadEl.addEventListener('pointercancel', () => { mdDrag = null; });
mdWin.querySelector('.md-close').addEventListener('click', mdClose);
mdWin.addEventListener('keydown', (e) => { if (e.key === 'Escape') mdClose(); });

// ---------------------------------------------------------------- Version-Skew
// Der Build brennt seinen Stamp ins Bundle (__BUILD_STAMP__) und schreibt ihn
// zugleich nach public/version.json. /api/version meldet den Stamp des LAUFENDEN
// Backends (einmal beim Start gelesen). Weichen beide ab — typisch: Frontend
// frisch gebaut, Backend nicht neu gestartet (genau der Deploy-Vorfall) — ist der
// Deploy unvollstaendig; wir warnen einmal sichtbar. Ein fehlendes /api/version
// (Backend aelter als dieses Feature) zaehlt ebenfalls als Versatz.
const FRONTEND_VERSION = __BUILD_STAMP__;
const versionWarnEl = document.getElementById('version-warn');
let versionWarned = false;

function showVersionWarn(backend) {
  if (versionWarned || !versionWarnEl) return;
  versionWarned = true;
  versionWarnEl.replaceChildren();
  const msg = document.createElement('span');
  msg.textContent = `Backend veraltet — Deploy unvollständig? (Frontend ${FRONTEND_VERSION} ≠ Backend ${backend})`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'version-warn-close';
  close.setAttribute('aria-label', 'Schließen');
  close.textContent = '×';
  close.addEventListener('click', () => { versionWarnEl.hidden = true; });
  versionWarnEl.append(msg, close);
  versionWarnEl.hidden = false;
}

async function checkVersionSkew() {
  let backend;
  try {
    const r = await fetch(`${BASE}api/version`, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json().catch(() => null);
      backend = d && d.version;
    } else if (r.status === 404) {
      backend = 'ohne /api/version';   // Backend aelter als dieses Feature
    } else {
      return;                          // andere Fehler: nicht faelschlich warnen
    }
  } catch {
    return;                            // Backend offline o. ae.: die Verbindungsanzeige uebernimmt
  }
  if (backend && backend !== FRONTEND_VERSION) {
    console.warn(`[term] Version-Skew: Frontend ${FRONTEND_VERSION} != Backend ${backend} — Deploy unvollständig?`);
    showVersionWarn(backend);
  }
}

// ---------------------------------------------------------------- Self-Update
// Icon in der Brand-Zeile: gruen/dezent = aktuell, pulsierend mit Zaehler =
// Remote ist voraus, drehend = Pruefung bzw. deploy/update laeuft. Hover-Title
// erklaert den Klick; Klick prueft neu (aktuell) bzw. startet nach Rueckfrage
// deploy/update (Update verfuegbar). Ein durch das Update ausgeloester
// Backend-Restart kappt den /run-Kindprozess mitsamt Log — daher zaehlt auch
// "Backend weg und mit neuer Version wieder da" als Erfolgsende.
const upBtn = document.getElementById('up-btn');
const upBadge = document.getElementById('up-badge');
const upState = { behind: null, head: '', upstream: '', error: null, phase: 'idle' }; // idle|check|run

function upRender() {
  upBtn.classList.toggle('busy', upState.phase !== 'idle');
  upBtn.classList.toggle('avail', upState.phase === 'idle' && upState.behind > 0);
  upBtn.classList.toggle('err', upState.phase === 'idle' && upState.behind == null);
  upBadge.hidden = !(upState.phase === 'idle' && upState.behind > 0);
  if (!upBadge.hidden) upBadge.textContent = upState.behind > 9 ? '9+' : String(upState.behind);
  if (upState.phase === 'run') {
    upBtn.title = 'deploy/update läuft — bitte warten. Bei einem Backend-Neustart lädt die Seite danach automatisch neu.';
  } else if (upState.phase === 'check') {
    upBtn.title = 'Update-Status wird geprüft …';
  } else if (upState.behind > 0) {
    upBtn.title = `Update verfügbar: ${upState.behind} Commit${upState.behind === 1 ? '' : 's'} hinter ${upState.upstream}.\n`
      + 'Klick startet deploy/update: git pull → Build → bei Backend-Änderung sessions-schonender Neustart '
      + '(laufende Claude-Sessions kommen per --resume zurück).';
  } else if (upState.behind === 0) {
    upBtn.title = `Installation ist aktuell (Stand ${upState.head || '?'}, geprüft gegen ${upState.upstream}).\n`
      + 'Klick prüft erneut.';
  } else {
    upBtn.title = `Update-Prüfung fehlgeschlagen${upState.error ? ': ' + upState.error : ''} — Klick versucht es erneut.`;
  }
}

async function upRefresh(force) {
  if (upState.phase === 'run') return;
  if (force) { upState.phase = 'check'; upRender(); }
  try {
    const r = await fetch(`${BASE}api/update/status${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const d = await r.json();
    if (upState.phase === 'run') return;           // inzwischen gestarteter Lauf gewinnt
    if (d.running) { upWatchRun(); return; }       // z. B. in anderem Tab gestartet
    upState.behind = typeof d.behind === 'number' ? d.behind : null;
    upState.head = d.head || '';
    upState.upstream = d.upstream || 'origin/main';
    upState.error = d.error || null;
  } catch {
    if (upState.phase === 'run') return;
    upState.behind = null;
    upState.error = 'Backend nicht erreichbar';
  }
  if (upState.phase !== 'run') upState.phase = 'idle';
  upRender();
}

// Nach einem Lauf (bzw. Backend-Neustart) pruefen, ob ein neues Frontend
// gebaut wurde — dann Seite neu laden, damit auch das Bundle aktuell ist.
// Vor dem Reload warten, bis das Backend wieder antwortet: der entkoppelte
// Restart (term-restart) kann dem Skript-Ende um Sekunden NACHlaufen — ein
// sofortiger Reload traefe sonst genau in die Neustart-Luecke (502).
async function upMaybeReload() {
  try {
    const r = await fetch(`${BASE}version.json`, { cache: 'no-store' });
    const d = await r.json();
    if (!d || !d.version || d.version === FRONTEND_VERSION) return false;
  } catch { return false; }
  setStatus('Update installiert — Seite wird neu geladen …');
  const started = Date.now();
  const reloadWhenUp = async () => {
    try {
      const h = await fetch(`${BASE}healthz`, { cache: 'no-store' });
      if (h.ok) { location.reload(); return; }
    } catch {}
    if (Date.now() - started < 60000) setTimeout(reloadWhenUp, 1500);
    else setStatus('Backend meldet sich nicht zurück — Seite bitte manuell neu laden.', true);
  };
  setTimeout(reloadWhenUp, 1500);
  return true;
}

// Laufenden deploy/update-Lauf beobachten. Reisst die Verbindung ab (Backend-
// Restart), weiter pollen, bis das Backend zurueck ist; verliert es dabei den
// Log-Zustand (frischer Prozess), zaehlt das als Ende des Laufs.
function upWatchRun() {
  upState.phase = 'run';
  upRender();
  let sawServerGone = false;
  const poll = async () => {
    let d = null;
    try {
      const r = await fetch(`${BASE}api/update/log`, { cache: 'no-store' });
      if (!r.ok) throw new Error();
      d = await r.json();
    } catch {
      sawServerGone = true;                        // Restart im Gang — dranbleiben
      setTimeout(poll, 1500);
      return;
    }
    if (d.running) { setTimeout(poll, 1000); return; }
    upState.phase = 'idle';
    if (d.output) console.log('[term] deploy/update:\n' + d.output);
    if (d.code === 0) {
      if (!(await upMaybeReload())) setStatus('Update abgeschlossen ✓ — Stand ist aktuell.', false, 6000);
    } else if (d.code != null) {
      setStatus(`deploy/update fehlgeschlagen (Exit ${d.code}) — Details in der Browser-Konsole.`, true, 15000);
    } else if (sawServerGone) {
      // Backend war weg und ist ohne Log-Zustand zurueck: Restart-Ende.
      if (!(await upMaybeReload())) setStatus('Update abgeschlossen — Backend neu gestartet ✓', false, 6000);
    }
    upRefresh(false);
  };
  poll();
}

async function upStart() {
  const n = upState.behind;
  const msg = `Jetzt aktualisieren? (${n} Commit${n === 1 ? '' : 's'} hinter ${upState.upstream})\n\n`
    + 'deploy/update führt aus: git pull → Build → bei Backend-Änderung ein sessions-schonender '
    + 'Neustart (laufende Claude-Sessions werden automatisch per --resume wiederhergestellt; '
    + 'die Verbindung bricht dabei kurz ab).';
  if (!window.confirm(msg)) return;
  upState.phase = 'run';
  upRender();
  try {
    const r = await fetch(`${BASE}api/update/run`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) throw new Error(d.error || 'Start fehlgeschlagen');
  } catch (e) {
    upState.phase = 'idle';
    upRender();
    setStatus(String(e.message || e), true, 6000);
    return;
  }
  upWatchRun();
}

upBtn.addEventListener('click', () => {
  if (upState.phase !== 'idle') return;            // laeuft schon — nichts doppelt anstossen
  if (upState.behind > 0) upStart();
  else upRefresh(true);                            // aktuell/Fehler: neu pruefen
});

// ---------------------------------------------------------------- Bugtracker
// Kaefer-Icon in der Sidebar oeffnet ein Overlay mit einer schlanken Bug-Liste.
// Backend: GitHub Issues des Projekt-Repos (/api/bugs). "Nur GitHub" — ohne
// funktionierendes gh liefert der Server 503; dann zeigen wir statt einer Liste
// einen klaren Einrichtungs-Hinweis (kein stiller lokaler Speicher). Jede Mutation
// gibt die komplette Liste zurueck, damit Liste + Badge in einem Roundtrip stimmen.
const bugBtn = document.getElementById('bug-btn');
const bugBadge = document.getElementById('bug-badge');
const bugOverlay = document.getElementById('bug-overlay');
const bugListEl = document.getElementById('bug-list');
const bugEmptyEl = document.getElementById('bug-empty');
const bugForm = document.getElementById('bug-form');
const bugTitleEl = document.getElementById('bug-title');
const bugBodyEl = document.getElementById('bug-body');
const bugRepoEl = document.getElementById('bug-repo');
let bugs = [];
let bugRepo = null;
let bugError = null; // { error, detail } wenn GitHub nicht verfuegbar

function bugFmtDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

// Der serverseitig angehaengte Herkunfts-Stempel ("\n\n---\n_via webterm …_")
// gehoert nicht in die kompakte Listenansicht — nur der eigentliche Text.
function bugDisplayBody(body) {
  return (body || '').split('\n\n---\n')[0].trim();
}

function setBugRepo(repo) {
  if (repo) bugRepo = repo;
  if (bugRepo) {
    bugRepoEl.textContent = bugRepo;
    bugRepoEl.href = `https://github.com/${bugRepo}/issues`;
    bugRepoEl.hidden = false;
  } else {
    bugRepoEl.hidden = true;
  }
}

function updateBugBadge() {
  if (bugError) {
    bugBadge.hidden = true;
    bugBtn.classList.remove('has-open');
    bugBtn.classList.add('err');
    bugBtn.title = 'Bugtracker: ' + bugError.error;
    return;
  }
  bugBtn.classList.remove('err');
  const open = bugs.filter((b) => !b.done).length;
  bugBadge.textContent = String(open);
  bugBadge.hidden = open === 0;
  bugBtn.classList.toggle('has-open', open > 0);
  bugBtn.title = open > 0 ? `Bugtracker – ${open} offen` : 'Bugtracker';
}

function setBugs(list, repo) {
  bugError = null;
  setBugRepo(repo);
  bugs = Array.isArray(list) ? list : [];
  updateBugBadge();
  if (!bugOverlay.hidden) renderBugs();
}

function setBugError(err) {
  bugError = err || { error: 'Bugtracker nicht erreichbar' };
  if (err && err.repo) setBugRepo(err.repo);
  bugs = [];
  updateBugBadge();
  if (!bugOverlay.hidden) renderBugs();
}

function renderBugError() {
  bugEmptyEl.hidden = true;
  const box = document.createElement('div');
  box.className = 'bug-error';
  const h = document.createElement('div');
  h.className = 'bug-error-h';
  h.textContent = 'GitHub-Bugtracker nicht verfügbar';
  const p = document.createElement('div');
  p.className = 'bug-error-p';
  p.textContent = bugError.error;
  box.append(h, p);
  // Einrichtungs-Tipp: bei privatem Repo braucht jede Installation einen eigenen
  // GitHub-Login mit Repo-Zugriff.
  const tip = document.createElement('div');
  tip.className = 'bug-error-tip';
  tip.append(document.createTextNode('Einrichten (einmalig): '));
  const code = document.createElement('code');
  code.textContent = 'gh auth login';
  tip.append(code);
  if (bugRepo) tip.append(document.createTextNode(` — mit Zugriff auf ${bugRepo}.`));
  box.append(tip);
  if (bugError.detail) {
    const det = document.createElement('details');
    det.className = 'bug-error-det';
    const sum = document.createElement('summary');
    sum.textContent = 'Details';
    const pre = document.createElement('pre');
    pre.textContent = bugError.detail;
    det.append(sum, pre);
    box.append(det);
  }
  bugListEl.append(box);
}

function renderBugs() {
  bugListEl.replaceChildren();
  if (bugError) { renderBugError(); return; }
  if (!bugs.length) { bugEmptyEl.hidden = false; return; }
  bugEmptyEl.hidden = true;
  // Offene zuerst (neueste oben), erledigte darunter.
  const sorted = [...bugs].sort((a, b) =>
    (a.done === b.done ? (b.created || 0) - (a.created || 0) : (a.done ? 1 : -1)));
  const frag = document.createDocumentFragment();
  for (const b of sorted) {
    const item = document.createElement('div');
    item.className = 'bug-item' + (b.done ? ' done' : '');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'bug-check';
    check.checked = !!b.done;
    check.title = b.done ? 'Wieder öffnen (Issue reopen)' : 'Als erledigt markieren (Issue schließen)';
    check.addEventListener('change', () => toggleBug(b.id, check.checked));

    const main = document.createElement('div');
    main.className = 'bug-main';
    const title = document.createElement('div');
    title.className = 'bug-item-title';
    title.textContent = b.title;
    main.append(title);
    const displayBody = bugDisplayBody(b.body);
    if (displayBody) {
      const body = document.createElement('div');
      body.className = 'bug-item-body';
      body.textContent = displayBody;
      main.append(body);
    }
    const meta = document.createElement('div');
    meta.className = 'bug-item-meta';
    if (b.url) {
      const num = document.createElement('a');
      num.className = 'bug-num';
      num.href = b.url;
      num.target = '_blank';
      num.rel = 'noopener noreferrer';
      num.textContent = '#' + b.number;
      num.title = 'Auf GitHub öffnen';
      meta.append(num);
    }
    const rest = document.createElement('span');
    rest.textContent = (b.author ? ` · ${b.author}` : '') + (b.created ? ` · ${bugFmtDate(b.created)}` : '');
    meta.append(rest);
    main.append(meta);

    item.append(check, main);
    frag.append(item);
  }
  bugListEl.append(frag);
}

async function loadBugs() {
  try {
    const r = await fetch(`${BASE}api/bugs`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { setBugError(data); return; }
    setBugs(data.bugs, data.repo);
  } catch {
    setBugError({ error: 'Bugtracker nicht erreichbar (Backend?).' });
  }
}

async function addBug() {
  const title = bugTitleEl.value.trim();
  if (!title) { bugTitleEl.focus(); return; }
  const body = bugBodyEl.value.trim();
  const btn = document.getElementById('bug-add');
  btn.disabled = true;
  try {
    const r = await fetch(`${BASE}api/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Anlegen fehlgeschlagen');
    bugTitleEl.value = '';
    bugBodyEl.value = '';
    setBugs(data.bugs, data.repo);
    bugTitleEl.focus();
  } catch (e) {
    setStatus(String(e.message || e), true, 5000);
  } finally {
    btn.disabled = false;
  }
}

async function toggleBug(id, done) {
  try {
    const r = await fetch(`${BASE}api/bugs?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Aktualisieren fehlgeschlagen');
    setBugs(data.bugs, data.repo);
  } catch (e) {
    setStatus(String(e.message || e), true, 5000);
    loadBugs(); // Server-Wahrheit zuruecksynchronisieren (Checkbox war optimistisch)
  }
}

function openBugs() {
  bugOverlay.hidden = false;
  renderBugs();
  loadBugs();          // frischen Stand von GitHub nachladen
  bugTitleEl.focus();
}
function closeBugs() { bugOverlay.hidden = true; }

bugBtn.addEventListener('click', openBugs);
document.getElementById('bug-close').addEventListener('click', closeBugs);
bugOverlay.addEventListener('click', (e) => { if (e.target === bugOverlay) closeBugs(); });
bugForm.addEventListener('submit', (e) => { e.preventDefault(); addBug(); });
// Eingaben nicht ans Terminal/globale Shortcuts durchreichen. Enter im Titel
// legt an; in der Textarea nur mit Strg/Cmd+Enter (sonst normaler Zeilenumbruch).
bugTitleEl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); addBug(); }
});
bugBodyEl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addBug(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !bugOverlay.hidden) { e.stopPropagation(); closeBugs(); }
}, true); // Capture: vor dem Copy-Mode-Esc-Handler

// ------------------------------------------- Spaltenbreiten (Sidebar/Explorer)
// Beide Randspalten sind per Maus ziehbar. Die Breiten leben als CSS-Custom-
// Properties auf .app; der Ziehgriff (.col-resizer) ist nur eine transparente
// Greifzone ueber der 1px-Border — die Trennlinie bleibt 1px (siehe styles.css).
// Die ResizeObserver auf .work fittet das Terminal beim Ziehen automatisch nach.
const sidebarEl = document.querySelector('.sidebar');
const COL = {
  sidebar:  { min: 200, max: 560, key: 'term-sidebar-w',  varName: '--sidebar-w' },
  explorer: { min: 220, max: 680, key: 'term-explorer-w', varName: '--explorer-w' },
};
const WORK_MIN = 320; // Terminalspalte nie schmaler als das

// Sichtbare Breite der jeweils anderen Randspalte (0, falls Explorer eingeklappt).
function otherColWidth(which) {
  return which === 'sidebar' ? explorerEl.offsetWidth : sidebarEl.offsetWidth;
}
function clampCol(which, w) {
  const c = COL[which];
  const hardMax = Math.min(c.max, window.innerWidth - otherColWidth(which) - WORK_MIN);
  return Math.round(Math.max(c.min, Math.min(w, Math.max(c.min, hardMax))));
}
function setCol(which, w) { appEl.style.setProperty(COL[which].varName, w + 'px'); }

function loadColWidths() {
  for (const which of ['sidebar', 'explorer']) {
    const raw = parseInt(localStorage.getItem(COL[which].key), 10);
    if (Number.isFinite(raw)) setCol(which, clampCol(which, raw));
  }
}

function beginColResize(which, ev) {
  ev.preventDefault();
  const c = COL[which];
  const grip = ev.currentTarget;
  grip.classList.add('active');
  document.body.classList.add('col-resizing');
  try { grip.setPointerCapture(ev.pointerId); } catch {}
  let latest = null;
  const move = (e) => {
    const raw = which === 'sidebar' ? e.clientX : (window.innerWidth - e.clientX);
    latest = clampCol(which, raw);
    setCol(which, latest);
  };
  const end = () => {
    grip.classList.remove('active');
    document.body.classList.remove('col-resizing');
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    if (latest != null) localStorage.setItem(c.key, String(latest));
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

// Doppelklick auf den Griff: zurueck auf die CSS-Standardbreite.
function resetCol(which) {
  appEl.style.removeProperty(COL[which].varName);
  localStorage.removeItem(COL[which].key);
}

const sidebarGrip = document.getElementById('resize-sidebar');
const explorerGrip = document.getElementById('resize-explorer');
sidebarGrip?.addEventListener('pointerdown', (e) => beginColResize('sidebar', e));
explorerGrip?.addEventListener('pointerdown', (e) => beginColResize('explorer', e));
sidebarGrip?.addEventListener('dblclick', () => resetCol('sidebar'));
explorerGrip?.addEventListener('dblclick', () => resetCol('explorer'));

// ---------------------------------------------------------------- Init
// Marke/Titel an den tatsaechlichen Host anpassen (portabel statt fest auf
// term.martuni.de verdrahtet).
const brandDim = document.querySelector('.brand-dim');
if (brandDim && location.hostname) brandDim.textContent = '.' + location.hostname;
if (location.hostname) document.title = 'term · ' + location.hostname;
// Voller Name als Tooltip — sichtbar wird er ggf. abgeschnitten (Icons rechts).
const brandNameEl = document.querySelector('.brand-name');
if (brandNameEl) brandNameEl.title = brandNameEl.textContent;

// Gespeicherte Spaltenbreiten anwenden (vor dem ersten fitTerminal).
loadColWidths();

renderSidebar();
refreshSessions();
setInterval(refreshSessions, 4000);
refreshSysStat();
setInterval(refreshSysStat, 4000);
fitTerminal();
connect();
checkVersionSkew();
upRefresh(false);
setInterval(() => upRefresh(false), 5 * 60 * 1000);
// Beim Zurueckkehren zum Tab mitpruefen (Backend-TTL drosselt das Remote).
document.addEventListener('visibilitychange', () => { if (!document.hidden) upRefresh(false); });

// Datei-Explorer initial: auf schmalen Viewports eingeklappt starten.
fxCollapse(window.innerWidth < 900);

// Bugtracker: Badge/Liste initial laden (zeigt offene Eintraege am Kaefer-Icon).
loadBugs();
