// Verbindungen zwischen Agent-Sitzungen: Anbindung an tmux, an die Agenten und
// an das Pane. Zustand und Regeln stehen in lib/link-store.js.
//
// Drei Wege fuehren hier hinein, mit bewusst verschiedenen Rechten:
//
//   1. Die Sidebar (HTTP /api/link/* und /api/vernetzung/*, CSRF-geschuetzt wie
//      alle schreibenden Routen): erzeugen, eintragen, trennen, zustellen, und
//      die Einstellung "aus / nur lokal / mit Hub". Nur hier entstehen und
//      enden Verbindungen — auch die ueber einen Hub (lib/link-hub.js): ueber
//      Gesuche entscheidet der Nutzer per Klick, nie der Agent.
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
// Welche Sitzung ein Agent ist, sagt nicht der Agent: der Kernel nennt die PID
// des Prozesses am Socket (SO_PEERCRED), und dessen Prozessbaum fuehrt zu einem
// Pane des tmux-Servers dieses Webterminals (lib/peer-pid.js). Was der Aufrufer
// selbst mitschickt, zaehlt dafuer nicht — auch nicht $TMUX oder $TMUX_PANE.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createLinkStore, isHubCode, LinkError, newEndpointId } from './link-store.js';
import { checkKey, createLinkConfig, hubHost, normalizeHub } from './link-config.js';
import { createHubLinks } from './link-hub.js';
import { createPeerLookup, paneOfProcess } from './peer-pid.js';

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

// `peerOf` (Socket -> { pid, uid }) und `parentOf` (PID -> Eltern-PID) sind nur
// fuer Tests austauschbar, ebenso `hubOptions` (Abfrage-Takt des Hub-Clients).
// `insecureHub` laesst http-Hubs auf dem eigenen Rechner zu — fuer Tests.
export function createLink({
  tmux, dir, cliScript, nodeBin = process.execPath, log = console,
  peerOf = createPeerLookup(), parentOf, insecureHub = false, hubOptions = {},
}) {
  const store = createLinkStore({ dir });
  const config = createLinkConfig({ dir, insecure: insecureHub, hasLinks: () => store.count() > 0 });
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
    hub.sync(); // ohne den Socket auch nicht mehr beim Hub abfragen
    return false;
  }

  // Der Hub-Client fragt nur ab, solange diese Instanz schreibt: jede Antwort
  // des Hubs aendert state.json.
  const hub = createHubLinks({ store, config, isOwner: () => owner(), log, ...hubOptions });

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
    try {
      // Beendete Sitzungen werden beim Hub nicht mehr abgefragt, wiedergekehrte wieder.
      if (store.reconcile(live)) hub.sync();
    } catch (err) { log.warn('term-link: Abgleich fehlgeschlagen:', err.message); }
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

  // Anfragender Prozess -> Sitzung. `who` ist der Absender laut Kernel (peerOf).
  // Gesucht wird das innerste Pane, in dessen Prozessbaum er liegt; gefragt wird
  // der tmux-Server DIESES Webterminals, Panes anderer Server kommen also gar
  // nicht vor. Wer in keinem Pane laeuft, hat keine Sitzung und bekommt nichts.
  async function sessionOfCaller(who) {
    if (who.uid !== process.getuid()) {
      throw new LinkError(403, 'foreign_user', 'Der Aufruf kommt von einem anderen Benutzer.');
    }
    const r = await tmux(['list-panes', '-a', '-F',
      `#{pane_pid}\t#{session_id}\t#{${EP_OPTION}}\t#{session_name}`]);
    if (!r.ok) throw new LinkError(503, 'tmux_failed', 'Der tmux-Server des Webterminals antwortet nicht.');
    const panes = new Map();
    for (const line of r.out.split('\n')) {
      const [pid, tmuxId, ep, ...rest] = line.split('\t');
      if (/^\d+$/.test(pid) && tmuxId) panes.set(Number(pid), { tmuxId, linkEp: ep || '', name: rest.join('\t') });
    }
    const found = paneOfProcess(who.pid, panes, parentOf);
    if (!found) {
      throw new LinkError(403, 'not_in_pane',
        'term-link funktioniert nur aus einem tmux-Pane des Webterminals: der aufrufende Prozess gehört zu '
        + 'keinem Pane seines tmux-Servers (Aufruf von außerhalb oder aus einem abgekoppelten Hintergrundprozess?).');
    }
    return found;
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
    const cfg = config.get();
    return {
      session: row.name,
      agent: row.agent || null,
      agentStatus: row.agentStatus || null,
      cli: cliPath,
      socket: socketState,
      mode: cfg.mode,
      // Der eigene Hub: Anlegen braucht Adresse UND Zugangsschluessel.
      hub: cfg.mode === 'hub' ? { host: hubHost(cfg.hub), canCreate: !!cfg.key } : null,
      ...sum,
      deliverable: check.ok,
      deliverHint: check.hint,
      links: ep ? store.view(ep) : [],
    };
  }

  // --- Aktionen der Sidebar -------------------------------------------------

  // Alles Aendernde verlangt den Socket (requireOwner) — und zwar VOR dem ersten
  // tmux-Aufruf: auch die Session-Option setzt nur die schreibende Instanz.
  // Neues entsteht ausserdem nur, wenn Verbindungen eingeschaltet sind.
  function requireOn() {
    requireOwner();
    if (config.get().mode === 'off') {
      throw new LinkError(409, 'link_off',
        'Verbindungen sind ausgeschaltet — in der Sidebar unter „Vernetzung“ einschalten.');
    }
  }

  // `via: 'hub'` legt die Verbindung auf dem eigenen Hub an (fuer Sitzungen
  // anderer Installationen), sonst lokal.
  async function create(row, seats, via) {
    requireOn();
    const endpoint = await ensureEndpoint(row);
    if (via === 'hub') return hub.create({ endpoint, name: row.name, seats: seats ?? 2 });
    return store.create({ endpoint, name: row.name, seats: seats ?? 2 });
  }

  // Lokaler Code oder Einladungslink eines Hubs. `confirm`: s. hub.join.
  async function join(row, code, confirm) {
    requireOn();
    const endpoint = await ensureEndpoint(row);
    if (isHubCode(code)) return hub.join({ endpoint, name: row.name, code, confirm });
    return store.join({ endpoint, name: row.name, code });
  }

  async function connect(row, peer) {
    requireOn();
    const endpoint = await ensureEndpoint(row);
    const peerEndpoint = await ensureEndpoint(peer);
    return store.connect({ endpoint, name: row.name, peerEndpoint, peerName: peer.name });
  }

  function requireEndpoint(row) {
    if (!row.linkEp) throw new LinkError(409, 'not_linked', 'Diese Sitzung hat keine Verbindung.');
    return row.linkEp;
  }

  // Die genannte Verbindung der Sitzung; `onHub` sagt, ob sie ueber einen Hub laeuft.
  function targetOf(row, linkId) {
    const endpoint = requireEndpoint(row);
    if (!linkId) throw new LinkError(400, 'link_missing', 'Welche Verbindung?');
    const t = store.target({ endpoint, linkId });
    return { endpoint, linkId: t.id, key: t.key, onHub: t.kind === 'hub' };
  }

  // Trennen. Bei einer Hub-Verbindung ist das der Austritt auf dem Hub — der
  // einzige Weg dorthin ist dieser Klick (s. reconcile im Store).
  async function leave(row, linkId, force) {
    requireOwner();
    const t = targetOf(row, linkId);
    if (t.onHub) return hub.leave({ key: t.key, force: force === true });
    return store.leave(t);
  }

  async function renewInvite(row, linkId) {
    requireOn();
    const t = targetOf(row, linkId);
    return t.onHub ? hub.renewInvite(t) : store.renewInvite(t);
  }

  async function withdrawInvite(row, linkId) {
    requireOwner();
    const t = targetOf(row, linkId);
    if (!t.onHub) throw new LinkError(400, 'not_hub', 'Das geht nur bei Verbindungen über einen Hub.');
    return hub.withdrawInvite(t);
  }

  // Beitrittsgesuch annehmen oder ablehnen (nur wer eingeladen hat).
  async function decide(row, linkId, memberId, admit) {
    requireOwner();
    const t = targetOf(row, linkId);
    if (!t.onHub) throw new LinkError(400, 'not_hub', 'Das geht nur bei Verbindungen über einen Hub.');
    return hub.decide({ ...t, memberId: String(memberId ?? ''), admit: admit === true });
  }

  const history = (row, linkId) =>
    store.history({ endpoint: requireEndpoint(row), linkId, limit: 200, full: true });

  // --- Einstellung (Panel "Vernetzung") ----------------------------------------

  function settings() {
    const cfg = config.get();
    owner(); // Stand des Sockets auffrischen
    // Die Einstellung kann auch von aussen geschrieben sein (install.sh): die
    // Abfragen beim Hub daran angleichen. Ohne Aenderung tut das nichts.
    hub.sync();
    return {
      mode: cfg.mode,
      hub: cfg.hub,
      host: cfg.hub ? hubHost(cfg.hub) : '',
      hasKey: !!cfg.key,
      socket: socketState,
      ...hub.status(),
      memberships: store.hubView(),
    };
  }

  // Zustand, Hub-Adresse und Zugangsschluessel setzen. `key`: undefined laesst
  // den gespeicherten stehen (er verlaesst den Server nie wieder, das Panel kann
  // ihn also nicht zurueckschicken), '' entfernt ihn. Wechselt die Adresse,
  // gilt der alte Schluessel nicht mit: er gehoert zum alten Hub.
  // "mit Hub" wird nur gespeichert, wenn der Hub antwortet und den Schluessel kennt.
  async function configure({ mode, hub: rawHub, key: rawKey }) {
    requireOwner();
    const old = config.get();
    const base = rawHub === undefined ? old.hub : (String(rawHub).trim() ? normalizeHub(rawHub, { insecure: insecureHub }) : '');
    let key = base === old.hub ? old.key : '';
    if (rawKey !== undefined) key = String(rawKey).trim() ? checkKey(rawKey) : '';
    if (mode === 'hub') {
      if (!base) throw new LinkError(400, 'hub_missing', 'Bitte die Adresse des Hubs eintragen (https://…).');
      await hub.check(base, key);
    } else hub.forgetCheck();
    config.set({ mode, hub: base, key });
    hub.sync();
    return settings();
  }

  // Hub und Schluessel erneut pruefen (Knopf im Panel).
  async function recheck() {
    const cfg = config.get();
    if (cfg.mode !== 'hub') throw new LinkError(409, 'hub_off', 'Es ist kein Hub eingeschaltet.');
    await hub.check(cfg.hub, cfg.key);
    return settings();
  }

  // Austritt aus einer Mitgliedschaft ohne ihre Sitzung (die es evtl. nicht mehr gibt).
  async function leaveMembership(key, force) {
    requireOwner();
    await hub.leave({ key, force: force === true });
    return settings();
  }

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

  // Absender je Verbindung, gleich bei der Annahme bestimmt (dann lebt der
  // aufrufende Prozess sicher noch). Ein Fehler wird aufgehoben und erst beim
  // Aufruf gemeldet.
  const peers = new WeakMap();
  function notePeer(socket) {
    peers.set(socket, peerOf(socket).then((who) => ({ who }), (err) => ({ err })));
  }

  async function callerOf(socket) {
    const noted = await peers.get(socket);
    if (!noted || noted.err) {
      log.warn('term-link: Absender am Socket nicht bestimmbar:', noted ? noted.err.message : 'unbekannte Verbindung');
      throw new LinkError(503, 'peer_unknown', 'Das Webterminal konnte den aufrufenden Prozess nicht bestimmen (siehe Log des Dienstes).');
    }
    return noted.who;
  }

  async function agentCall(route, body, socket) {
    requireOwner(); // inbox und send aendern den Stand
    const who = await sessionOfCaller(await callerOf(socket));
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
      const t = store.target({ endpoint: ep, linkId: body.link });
      if (t.kind === 'hub') return hub.send({ key: t.key, text: body.text, name: who.name });
      return store.send({ endpoint: ep, linkId: t.id, text: body.text, name: who.name });
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
      .then((body) => agentCall((req.url || '').split('?')[0], body, req.socket))
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

  // Probe nach dem Start: sich selbst verbinden und pruefen, dass der Kernel die
  // eigene PID nennt. Scheitert das (kein Helfer, kein Linux, kein Deskriptor),
  // bleibt der Socket aus — er wuerde sonst jeden Aufruf ablehnen oder, schlimmer,
  // den Falschen erkennen. Verbindet sich waehrenddessen schon ein Agent, stoert
  // das nicht: gesucht wird unter den angenommenen Verbindungen die eigene.
  async function probePeer(server) {
    const seen = [];
    const onConnection = (socket) => seen.push(socket);
    server.on('connection', onConnection);
    const client = net.connect(sockPath);
    try {
      await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
      let failure = new Error('die Probe-Verbindung kam nicht an');
      for (let i = 0; i < 100; i++) {
        for (const socket of seen) {
          const noted = await peers.get(socket);
          if (noted && noted.who && noted.who.pid === process.pid && noted.who.uid === process.getuid()) return;
          if (noted && noted.err) failure = noted.err;
        }
        await sleep(20);
      }
      throw failure;
    } finally {
      server.off('connection', onConnection);
      client.destroy();
    }
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
      server.on('connection', notePeer);
      try { await probePeer(server); } catch (err) {
        throw new Error(`der aufrufende Prozess lässt sich nicht bestimmen (${err.message}) — `
          + 'nötig sind Linux und perl oder python3');
      }
      server.unref();
      sockId = fileId(sockPath);
      // Ab jetzt schreibt diese Instanz: vom Stand auf der Platte ausgehen, nicht
      // von dem, der beim Anlegen des Speichers galt.
      store.refresh();
      socketState = 'ok';
      hub.sync(); // Abfragen beim Hub aufnehmen, falls es Mitgliedschaften gibt
    } catch (err) {
      close();
      socketState = 'error';
      log.warn('term-link: Agenten-Socket nicht verfügbar:', err.message);
    }
  }

  function close() {
    hub.close();
    if (agentServer) { agentServer.close(); agentServer = null; }
    socketState = 'off';
  }

  return {
    boot, close, snapshot, observe, summary, stateFor,
    create, join, connect, leave, renewInvite, withdrawInvite, decide, history, deliver,
    settings, configure, recheck, leaveMembership, mode: () => config.get().mode,
    cliPath, sockPath,
  };
}
