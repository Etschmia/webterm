// Verbindungen zwischen Agent-Sitzungen: Anbindung an tmux, an die Agenten und
// an das Pane. Zustand und Regeln stehen in lib/link-store.js.
//
// Drei Wege fuehren hier hinein, mit bewusst verschiedenen Rechten:
//
//   1. Die Sidebar (HTTP /api/link/*, CSRF-geschuetzt wie alle schreibenden
//      Routen): erzeugen, eintragen, trennen, zustellen. Nur hier entstehen
//      und enden Verbindungen.
//   2. Der Agent im Pane (Unix-Socket <dir>/agent.sock, ueber bin/term-link):
//      Postfach lesen, senden, Status. Er kann KEINE Verbindung anlegen oder
//      einer beitreten. Der Socket ist ueber Caddy nicht erreichbar und nur
//      fuer den Service-User les-/schreibbar (Verzeichnis 0700).
//   3. Das Pane selbst (tmux send-keys): hinein geht ausschliesslich eine FESTE
//      Hinweiszeile dieses Moduls. Was ins Pane getippt wird, hat fuer den
//      Agenten das Gewicht einer Nutzereingabe — Text eines fremden Agenten
//      darf dort deshalb nie landen. Er kommt nur als Ausgabe von
//      `term-link inbox` an, also als Daten. Diesen Riegel nicht aufweichen
//      (auch keine Namen oder Betreffzeilen der Gegenstelle in den Hinweis).
//
// Welche Sitzung ein Agent ist, sagt nicht der Agent, sondern tmux: das CLI
// schickt $TMUX_PANE und den Socket aus $TMUX, aufgeloest wird hier.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createLinkStore, LinkError, newEndpointId } from './link-store.js';

const EP_OPTION = '@term-link-ep';
const AGENT_BODY_LIMIT = 64 * 1024;
const KEY_DELAY_MS = 300; // Text und Enter getrennt: sonst werten manche TUIs beides als Einfuegung

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Laengster Pfad eines Unix-Sockets (sun_path ohne Abschluss-Null). Node kuerzt
// einen zu langen Pfad STILL und lauscht dann auf einer falsch benannten Datei —
// deshalb vorher pruefen statt hinterher suchen.
export const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;
export const socketPathOk = (p) => Buffer.byteLength(p, 'utf8') <= SOCKET_PATH_MAX;

// Fuer eine sh-Zeile bzw. den Hinweis im Pane: nur quoten, wenn noetig.
export function shellQuote(s) {
  return /^[A-Za-z0-9_./+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Darf der Hinweis jetzt ins Pane? `row` ist eine Zeile aus listSessions.
// 'idle' heisst dort nur "nicht als arbeitend oder wartend erkannt" — deshalb
// loest ausschliesslich ein Klick des Nutzers die Zustellung aus. Erlaubt ist
// allein 'idle': jeder andere Wert lehnt ab, auch ein kuenftig neuer und
// 'unknown' (Pane nicht lesbar — dort koennte ein Dialog stehen).
export function deliverCheck(row) {
  if (!row.agent) {
    return { ok: false, hint: 'In dieser Sitzung läuft kein erkannter Agent — der Hinweis würde in der Shell landen.' };
  }
  // Der Status (und der Kopiermodus) stammen vom AKTIVEN Pane der Sitzung. Laeuft
  // der Agent in einem anderen Pane oder Fenster, sagt der Status nichts ueber ihn.
  if (!row.agentPane || row.agentPane !== row.activePane) {
    return { ok: false, hint: 'Der Agent läuft nicht im aktiven Pane der Sitzung — dorthin wechseln.' };
  }
  if (row.copyMode) return { ok: false, hint: 'Das Pane ist im Kopiermodus.' };
  if (row.agentStatus === 'blocked') {
    return { ok: false, hint: 'Der Agent wartet auf eine Freigabe — eine Eingabe könnte den Dialog beantworten.' };
  }
  if (row.agentStatus === 'working') return { ok: false, hint: 'Der Agent arbeitet gerade.' };
  if (row.agentStatus !== 'idle') {
    return { ok: false, hint: 'Der Zustand des Agenten ließ sich gerade nicht lesen — gleich noch einmal versuchen.' };
  }
  return { ok: true, hint: '' };
}

export function createLink({ tmux, dir, cliScript, nodeBin = process.execPath, log = console }) {
  const store = createLinkStore({ dir });
  const sockPath = path.join(dir, 'agent.sock');
  const cliPath = path.join(dir, 'bin', 'term-link');
  const delivering = new Set(); // Sitzungen mit laufender Zustellung (Doppelklick-Schutz)
  let socketState = 'off';      // 'ok' | 'busy' (andere Instanz) | 'error' | 'off'
  let agentServer = null;
  let sockId = '';              // Geraet:Inode des eigenen Sockets, s. owner()

  // --- Wer schreibt ---------------------------------------------------------
  //
  // state.json wird immer als Ganzes geschrieben. Zwei Instanzen mit demselben
  // Verzeichnis haetten je eine eigene Kopie im Speicher, und die letzte
  // Schreibung gewoenne: Nachrichten, die nur die eine angenommen hat, waeren
  // nach deren Neustart weg. Deshalb schreibt genau EINE Instanz — die, der der
  // Agenten-Socket gehoert. Jede andere zeigt den Stand nur an (liest ihn bei
  // Aenderung neu von der Platte) und lehnt alles Aendernde ab, auch den
  // Abgleich mit der Sitzungsliste.
  const fileId = (p) => {
    try { const st = fs.statSync(p); return `${st.dev}:${st.ino}`; } catch { return ''; }
  };

  // Gehoert der Socket (noch) dieser Instanz? Geprueft wird die Datei selbst:
  // starten zwei Instanzen gleichzeitig, sehen beide keinen lebenden Socket,
  // und die zweite ersetzt die Datei der ersten. Die erste lauscht dann auf
  // einem Socket ohne Namen und darf nicht weiter schreiben.
  function owner() {
    if (socketState !== 'ok') return false;
    const now = fileId(sockPath);
    if (now === sockId) return true;
    log.warn(`term-link: ${sockPath} gehört nicht mehr dieser Instanz — Verbindungen werden hier nur noch angezeigt.`);
    if (agentServer) { agentServer.close(); agentServer = null; }
    socketState = now ? 'busy' : 'error';
    return false;
  }

  function requireOwner() {
    if (owner()) return;
    throw new LinkError(503, 'not_owner', {
      busy: 'Verbindungen verwaltet eine andere laufende Webterminal-Instanz desselben Benutzers; diese '
        + 'Instanz zeigt sie nur an. Dort ändern — oder dieser Instanz mit TERM_LINK_DIR ein eigenes '
        + 'Verzeichnis geben.',
      off: 'Der Agenten-Zugang startet noch — gleich noch einmal versuchen.',
    }[socketState] || 'Der Agenten-Zugang ist nicht verfügbar (siehe Log des Dienstes); Verbindungen lassen '
      + 'sich deshalb nicht ändern.');
  }

  const wakeLine = () => 'Hinweis vom Webterminal: Für diese Sitzung liegen neue Nachrichten anderer '
    + `Agenten bereit. Abrufen mit: ${shellQuote(cliPath)} inbox`;
  const introLine = () => 'Hinweis vom Webterminal: Diese Sitzung ist jetzt mit anderen Agent-Sitzungen '
    + `verbunden. Anleitung: ${shellQuote(cliPath)} help`;

  // --- tmux ---------------------------------------------------------------

  // Eine Sitzungsliste ist nur so aktuell wie ihr Start. Sie laeuft als eigener
  // tmux-Aufruf und kommt spaeter zurueck; hat inzwischen eine Sitzung ihren
  // Endpunkt bekommen (set-option in ensureEndpoint) und ist die Mitgliedschaft
  // schon gespeichert, fehlt der Endpunkt in dieser Liste — der Abgleich hielte
  // eine laufende Sitzung fuer beendet. Deshalb zaehlt `epGen` jede
  // Endpunkt-Aenderung: wer eine Liste abgleichen will, holt VOR dem
  // tmux-Aufruf den Stand per snapshot() und gibt ihn observe() mit. Hat sich
  // der Stand seither geaendert, wird die Liste wie eine fehlgeschlagene
  // Abfrage behandelt — die naechste gleicht wieder ab.
  let epGen = 0;
  let epQueue = Promise.resolve(); // Endpunkte entstehen nacheinander, s. ensureEndpoint
  const snapshot = () => epGen;

  // Laufende Sitzungen samt Endpunkt. ok=false heisst: tmux hat nicht
  // geantwortet — dann wird NICHT abgeglichen (s. reconcile im Store).
  async function listLive() {
    const snap = snapshot();
    const r = await tmux(['list-sessions', '-F', `#{session_id}\t#{${EP_OPTION}}\t#{session_name}`]);
    if (!r.ok) return { ok: false, sessions: [] };
    const sessions = r.out.split('\n').filter(Boolean).map((line) => {
      const [tmuxId, ep, ...rest] = line.split('\t');
      return { tmuxId, linkEp: ep || '', name: rest.join('\t') };
    });
    observe(sessions, snap);
    return { ok: true, sessions };
  }

  // Abgleich mit einer ERFOLGREICHEN Sitzungsliste (auch von listSessions in
  // server.js). `snap` ist der Wert von snapshot() von VOR dem tmux-Aufruf;
  // fehlt er oder ist er ueberholt, wird nicht abgeglichen. Liefert, ob
  // abgeglichen wurde.
  function observe(sessions, snap) {
    // Ohne den Socket nur anzeigen: Stand der schreibenden Instanz nachlesen,
    // nichts abgleichen und nichts speichern.
    if (!owner()) {
      try { store.refresh(); } catch (err) { log.warn('term-link: Stand nicht lesbar:', err.message); }
      return false;
    }
    if (snap !== epGen) return false;
    const live = new Map();
    for (const s of sessions) if (s.linkEp) live.set(s.linkEp, s.name);
    try { store.reconcile(live); } catch (err) { log.warn('term-link: Abgleich fehlgeschlagen:', err.message); }
    return true;
  }

  // Endpunkt der Sitzung; legt ihn beim ersten Bedarf an. Ziel ist die
  // Session-ID ($N): Namen wuerde tmux als Praefix deuten.
  //
  // `row` stammt aus einer Sitzungsliste und kann veraltet sein (zwei Klicks,
  // zwei Browser-Tabs): steht dort noch kein Endpunkt, wird deshalb erst bei
  // tmux nachgefragt und nur ein fehlender gesetzt — nacheinander, damit zwei
  // Anfragen derselben Sitzung nicht zwei Kennungen vergeben, von denen die
  // erste samt ihrer Mitgliedschaft sofort wieder "beendet" waere.
  function ensureEndpoint(row) {
    if (row.linkEp) return Promise.resolve(row.linkEp);
    const run = epQueue.then(async () => {
      const cur = await tmux(['show-options', '-qv', '-t', row.tmuxId, EP_OPTION]);
      if (!cur.ok) throw new LinkError(500, 'tmux_failed', cur.err.trim() || 'tmux-Fehler');
      const have = cur.out.trim();
      if (/^ep_[A-Za-z0-9_-]{8,64}$/.test(have)) { row.linkEp = have; return have; }
      const ep = newEndpointId();
      // Vor UND nach set-option zaehlen: eine Liste, die waehrenddessen startet,
      // kann tmux noch vor der Aenderung beantworten.
      epGen += 1;
      let r;
      try { r = await tmux(['set-option', '-t', row.tmuxId, EP_OPTION, ep]); } finally { epGen += 1; }
      if (!r.ok) throw new LinkError(500, 'tmux_failed', r.err.trim() || 'tmux-Fehler');
      row.linkEp = ep;
      return ep;
    });
    epQueue = run.catch(() => {});
    return run;
  }

  // Pane eines anfragenden Agenten -> Sitzung. Der Socket aus $TMUX muss der
  // tmux-Server dieses Webterminals sein; Pane-IDs anderer Server waeren sonst
  // Zufallstreffer in fremden Sitzungen.
  async function resolvePane(tmuxEnv, pane) {
    if (typeof pane !== 'string' || !/^%\d{1,9}$/.test(pane) || typeof tmuxEnv !== 'string' || !tmuxEnv) {
      throw new LinkError(400, 'not_in_tmux',
        'term-link funktioniert nur in einem tmux-Pane des Webterminals ($TMUX und $TMUX_PANE fehlen).');
    }
    const r = await tmux(['display-message', '-p', '-t', pane,
      `#{session_id}\t#{${EP_OPTION}}\t#{socket_path}\t#{session_name}`]);
    const line = r.ok ? r.out.replace(/\n$/, '') : '';
    const [tmuxId, ep, socket, ...rest] = line.split('\t');
    if (!tmuxId || !socket) {
      throw new LinkError(404, 'pane_unknown', 'Dieses Pane kennt der tmux-Server des Webterminals nicht.');
    }
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const claimed = tmuxEnv.replace(/,\d+,\d+$/, '');
    if (real(claimed) !== real(socket)) {
      throw new LinkError(403, 'foreign_tmux', 'Dieses Pane gehört zu einem anderen tmux-Server als dem des Webterminals.');
    }
    return { tmuxId, linkEp: ep || '', name: rest.join('\t') };
  }

  // --- Sicht fuer die Sidebar ---------------------------------------------

  function summary(ep) {
    if (!ep) return null;
    const s = store.summary(ep);
    return s.count ? s : null;
  }

  function stateFor(row) {
    const ep = row.linkEp || '';
    const sum = ep ? store.summary(ep) : { count: 0, unread: 0, pending: 0 };
    const check = deliverCheck(row);
    return {
      session: row.name,
      agent: row.agent || null,
      agentStatus: row.agentStatus || null,
      cli: cliPath,
      socket: socketState,
      ...sum,
      deliverable: check.ok,
      deliverHint: check.hint,
      links: ep ? store.view(ep) : [],
    };
  }

  // --- Aktionen der Sidebar -------------------------------------------------

  // Alles Aendernde verlangt den Socket (requireOwner) — und zwar VOR dem ersten
  // tmux-Aufruf: auch die Session-Option setzt nur die schreibende Instanz.
  async function create(row, seats) {
    requireOwner();
    const endpoint = await ensureEndpoint(row);
    return store.create({ endpoint, name: row.name, seats: seats ?? 2 });
  }

  async function join(row, code) {
    requireOwner();
    const endpoint = await ensureEndpoint(row);
    return store.join({ endpoint, name: row.name, code });
  }

  async function connect(row, peer) {
    requireOwner();
    const endpoint = await ensureEndpoint(row);
    const peerEndpoint = await ensureEndpoint(peer);
    return store.connect({ endpoint, name: row.name, peerEndpoint, peerName: peer.name });
  }

  function requireEndpoint(row) {
    if (!row.linkEp) throw new LinkError(409, 'not_linked', 'Diese Sitzung hat keine Verbindung.');
    return row.linkEp;
  }

  const leave = (row, linkId) => {
    requireOwner();
    return store.leave({ endpoint: requireEndpoint(row), linkId });
  };
  const renewInvite = (row, linkId) => {
    requireOwner();
    return store.renewInvite({ endpoint: requireEndpoint(row), linkId });
  };
  const history = (row, linkId) =>
    store.history({ endpoint: requireEndpoint(row), linkId, limit: 200, full: true });

  // Tippt die feste Hinweiszeile ins Pane des Agenten (= aktives Pane, s. deliverCheck). kind: 'wake'
  // (neue Nachrichten) oder 'intro' (Einweisung nach dem Verbinden). `row`
  // muss frisch aus listSessions stammen — der Status darin ist die Freigabe.
  async function deliver(row, kind = 'wake') {
    requireOwner();
    const endpoint = requireEndpoint(row);
    if (kind !== 'wake' && kind !== 'intro') throw new LinkError(400, 'kind_invalid', 'Unbekannte Zustellart.');
    if (kind === 'wake' && !store.summary(endpoint).unread) {
      throw new LinkError(409, 'nothing_to_deliver', 'Für diese Sitzung liegt nichts Ungelesenes vor.');
    }
    const check = deliverCheck(row);
    if (!check.ok) throw new LinkError(409, 'not_deliverable', check.hint);
    if (delivering.has(row.tmuxId)) throw new LinkError(409, 'busy', 'Die Zustellung läuft bereits.');
    delivering.add(row.tmuxId);
    try {
      const target = row.agentPane; // Pane-ID (%N): eindeutig, kein Namensabgleich
      const typed = await tmux(['send-keys', '-t', target, '-l', kind === 'intro' ? introLine() : wakeLine()]);
      if (!typed.ok) throw new LinkError(500, 'tmux_failed', typed.err.trim() || 'tmux-Fehler');
      await sleep(KEY_DELAY_MS);
      const sent = await tmux(['send-keys', '-t', target, 'Enter']);
      if (!sent.ok) throw new LinkError(500, 'tmux_failed', sent.err.trim() || 'tmux-Fehler');
      if (kind === 'wake') store.markWoken({ endpoint });
    } finally {
      delivering.delete(row.tmuxId);
    }
  }

  // --- Agenten-Socket -------------------------------------------------------

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > AGENT_BODY_LIMIT) {
          reject(new LinkError(413, 'body_too_large', 'Die Anfrage ist zu groß.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (!d || typeof d !== 'object') throw new Error();
          resolve(d);
        } catch { reject(new LinkError(400, 'json_invalid', 'Ungültige Anfrage.')); }
      });
      req.on('error', () => reject(new LinkError(400, 'aborted', 'Anfrage abgebrochen.')));
    });
  }

  async function agentCall(route, body) {
    requireOwner(); // inbox und send aendern den Stand
    const who = await resolvePane(body.tmux, body.pane);
    await listLive(); // Gegenstellen abgleichen, bevor gesendet oder gelesen wird
    const ep = who.linkEp;
    if (route === '/status') return { session: who.name, links: ep ? store.view(ep) : [] };
    if (route === '/inbox') return { session: who.name, messages: ep ? store.inbox({ endpoint: ep }) : [] };
    if (route === '/history') {
      if (!ep) throw new LinkError(409, 'not_linked', 'Diese Sitzung hat keine Verbindung.');
      return { messages: store.history({ endpoint: ep, linkId: body.link, limit: body.limit }) };
    }
    if (route === '/send') {
      if (!ep) throw new LinkError(409, 'not_linked', 'Diese Sitzung hat keine Verbindung.');
      return store.send({ endpoint: ep, linkId: body.link, text: body.text, name: who.name });
    }
    throw new LinkError(404, 'route_unknown', 'Unbekannter Aufruf.');
  }

  function agentHandler(req, res) {
    const reply = (status, obj) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') return reply(405, { error: { code: 'method', message: 'Nur POST.' } });
    readBody(req)
      .then((body) => agentCall((req.url || '').split('?')[0], body))
      .then((out) => reply(200, out))
      .catch((err) => {
        if (err instanceof LinkError) return reply(err.status, { error: { code: err.code, message: err.message } });
        log.error('term-link: Agenten-Aufruf fehlgeschlagen:', err);
        reply(500, { error: { code: 'internal', message: 'Interner Fehler.' } });
      });
  }

  // Lauscht schon eine andere Instanz auf dem Socket? Dann nicht wegnehmen.
  function socketAlive() {
    return new Promise((resolve) => {
      const c = net.connect(sockPath);
      const done = (v) => { c.destroy(); resolve(v); };
      c.once('connect', () => done(true));
      c.once('error', () => done(false));
      c.setTimeout(1000, () => done(false));
    });
  }

  // Kleiner Starter fuer das CLI: der Agent braucht weder node im PATH noch den
  // Ort des Repos zu kennen. Bewusst NICHT im PATH und nicht `node` genannt.
  function writeCliWrapper() {
    fs.mkdirSync(path.dirname(cliPath), { recursive: true, mode: 0o700 });
    const tmp = `${cliPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, '#!/bin/sh\n# Erzeugt vom Webterminal bei jedem Start — nicht bearbeiten.\n'
      + `TERM_LINK_DIR=${shellQuote(dir)} exec ${shellQuote(nodeBin)} ${shellQuote(cliScript)} "$@"\n`,
    { mode: 0o700 });
    fs.renameSync(tmp, cliPath);
  }

  async function boot() {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      if (/[\u0000-\u001f\u007f]/.test(cliPath)) throw new Error('Steuerzeichen im Pfad');
      if (!socketPathOk(sockPath)) {
        throw new Error(`Pfad zu lang für einen Unix-Socket (${sockPath}) — TERM_LINK_DIR auf ein kürzeres Verzeichnis setzen`);
      }
      if (await socketAlive()) {
        socketState = 'busy';
        log.warn(`term-link: ${sockPath} gehört einer anderen laufenden Instanz — `
          + 'diese Instanz zeigt Verbindungen nur an, und ihre Agenten erreichen ihr Postfach nicht.');
        return;
      }
      writeCliWrapper();
      try { fs.unlinkSync(sockPath); } catch { /* gab keinen alten Socket */ }
      const server = http.createServer(agentHandler);
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, resolve);
      });
      agentServer = server;
      fs.chmodSync(sockPath, 0o600);
      server.on('error', (err) => log.warn('term-link: Socket-Fehler:', err.message));
      server.unref();
      sockId = fileId(sockPath);
      // Ab jetzt schreibt diese Instanz: vom Stand auf der Platte ausgehen, nicht
      // von dem, der beim Anlegen des Speichers galt.
      store.refresh();
      socketState = 'ok';
    } catch (err) {
      close();
      socketState = 'error';
      log.warn('term-link: Agenten-Socket nicht verfügbar:', err.message);
    }
  }

  function close() {
    if (agentServer) { agentServer.close(); agentServer = null; }
    socketState = 'off';
  }

  return {
    boot, close, snapshot, observe, summary, stateFor,
    create, join, connect, leave, renewInvite, history, deliver,
    cliPath, sockPath,
  };
}
