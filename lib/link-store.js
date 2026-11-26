// Verbindungen zwischen Agent-Sitzungen: Zustand und Regeln (ohne tmux, ohne HTTP).
//
// Eine VERBINDUNG ist eine kleine Gruppe (2 bis MAX_SEATS Mitglieder) mit
// gemeinsamem Nachrichtenverlauf. Ein MITGLIED ist ein Endpunkt, also eine
// tmux-Sitzung, die ueber die Session-Option @term-link-ep eine stabile Kennung
// traegt (s. lib/link.js). Der Endpunkt uebersteht das Umbenennen der Sitzung
// und verschwindet mit ihr. Die Kennung ist zufaellig und wird nie neu vergeben:
// taucht sie in einer spaeteren Sitzungsliste wieder auf, ist es dieselbe
// Sitzung, und sie war zu Unrecht als beendet vermerkt (s. reconcile).
//
// Nachrichten liegen im Postfach, bis das Mitglied sie abholt (readSeq). Dass
// dem Agenten ein Hinweis ins Pane getippt wurde, merkt sich wokenSeq — damit
// die Oberflaeche "zugestellt, aber noch nicht gelesen" von "neu" trennen kann.
//
// Der Zustand liegt in <dir>/state.json (0600).
//
// Zwei Arten von Verbindungen teilen sich dieses Modell:
//   kind 'local'  alle Mitglieder sind Sitzungen dieser Installation; die
//                 Nachricht liegt sofort im Postfach der anderen.
//   kind 'hub'    die Verbindung liegt auf einem Hub (lib/link-hub.js). Hier
//                 steht dann EINE Mitgliedschaft: die eigene Sitzung als
//                 einziges Mitglied mit Endpunkt, die Gegenstellen nur mit
//                 Kennung und Namen (`remote`). Dazu Token, Schluessel und der
//                 bestaetigte Stand. Postfach, Verlauf und Zustell-Vermerke
//                 funktionieren wie lokal — nur der Transport ist ein anderer.
//
// Eine Hub-Verbindung kann in einer Installation mehrfach vorkommen (zwei
// Sitzungen in derselben Gruppe). Der Schluessel im Speicher ist deshalb `key`
// und nur bei lokalen Verbindungen gleich der Kennung `id`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_SEATS = 8;                       // wie MAX_THREAD_MEMBERS im Hub
export const MAX_TEXT_BYTES = 16 * 1024;          // Klartext; laesst Luft fuer Chiffrat (Hub: 32 KB)
export const MAX_MESSAGES = 500;                  // Verlauf je Verbindung
export const MAX_LINK_BYTES = 2 * 1024 * 1024;    // Verlauf je Verbindung, Summe der Texte
export const SEND_LIMIT_PER_MINUTE = 30;          // je Mitgliedschaft (Sitzung UND Verbindung), s. sendLog
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // Einladung gilt einen Tag
export const MAX_LINKS_PER_ENDPOINT = 16;
const NAME_MAX = 64;

const CODE_RE = /^termlink:local\/(ln_[A-Za-z0-9_-]{8,40})#([A-Za-z0-9_-]{16,64})$/;

export class LinkError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Anzeigename eines Mitglieds: keine Steuerzeichen, begrenzte Laenge. Der Name
// landet in Werkzeugausgaben fremder Agenten und in der Oberflaeche.
export function cleanName(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return s.slice(0, NAME_MAX) || 'Sitzung';
}

// Zerlegt einen eingefuegten Verbindungs-Code. Liefert { kind, id, token } oder
// wirft einen LinkError mit handlungsleitendem Text.
// Einladungslinks eines Hubs (https://…/l/ln_…#…) sind kein lokaler Code: die
// traegt lib/link-hub.js ein. isHubCode trennt die beiden Wege.
export const isHubCode = (raw) => /^https?:\/\//i.test(String(raw ?? '').trim());

export function parseCode(raw) {
  const code = String(raw ?? '').trim();
  if (!code) throw new LinkError(400, 'code_missing', 'Bitte einen Verbindungs-Code oder Einladungslink einfügen.');
  if (isHubCode(code)) {
    throw new LinkError(400, 'code_remote', 'Das ist ein Einladungslink eines Hubs, kein lokaler Code.');
  }
  const m = CODE_RE.exec(code);
  if (!m) throw new LinkError(400, 'code_invalid', 'Das ist kein gültiger Verbindungs-Code.');
  return { kind: 'local', id: m[1], token: m[2] };
}

const id = (prefix, bytes) => prefix + crypto.randomBytes(bytes).toString('base64url');
export const newEndpointId = () => id('ep_', 12);

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createLinkStore({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error('createLinkStore: dir fehlt');
  const file = path.join(dir, 'state.json');
  // Kennzeichen des Dateistands, den `state` wiedergibt ('' = keine Datei).
  const fileSig = () => {
    try { const st = fs.statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return ''; }
  };
  let sig = fileSig();
  let state = load();
  const sendLog = new Map(); // memberId -> Zeitstempel der letzten Sendungen (nur im Speicher)

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && typeof d === 'object' && d.links && typeof d.links === 'object') {
        const links = {};
        for (const [key, l] of Object.entries(d.links)) {
          if (l && (l.key ?? l.id) === key && Array.isArray(l.members) && Array.isArray(l.messages)) links[key] = l;
        }
        return { version: 1, links };
      }
    } catch { /* fehlt oder defekt: leer anfangen */ }
    return { version: 1, links: {} };
  }

  function save() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.state-${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    sig = fileSig();
  }

  const links = () => Object.values(state.links);
  const keyOf = (link) => link.key ?? link.id;
  const isHub = (link) => link.kind === 'hub';
  // Gegenstellen einer Hub-Verbindung haben keinen Endpunkt und passen nie.
  const memberOf = (link, endpoint) => (endpoint && link.members.find((m) => m.endpoint === endpoint)) || null;
  const linksOf = (endpoint) => links().filter((l) => memberOf(l, endpoint));
  // Einen Platz belegt nur, wer noch da ist. Beendete Mitglieder (gone) bleiben
  // als Zeile fuer die Anzeige "beendet" stehen, zaehlen aber nicht: sonst bliebe
  // der Platz fuer immer vergeben — niemand ausser dem Mitglied selbst kann die
  // Zeile entfernen (leave), und das gibt es nicht mehr.
  // Bei einer Hub-Verbindung fuehrt der Hub die Plaetze: dort zaehlt jedes
  // Mitglied der Liste, auch ein wartendes Gesuch und die eigene, beendete Sitzung.
  const seatsTaken = (link) => (isHub(link) ? link.members.length : link.members.filter((m) => !m.gone).length);
  const inviteValid = (link) => !!link.invite && link.invite.expiresAt > now()
    && seatsTaken(link) < link.seats;
  // Lokal ein Code mit Geheimnis; bei einer Hub-Verbindung der Einladungslink,
  // dessen Teil hinter `#` der Hub nie erfaehrt.
  const inviteCode = (link) => (isHub(link)
    ? `${link.hub}/l/${link.id}#${link.invite.secret}`
    : `termlink:${link.kind}/${link.id}#${link.invite.token}`);
  const unreadOf = (link, member) =>
    link.messages.filter((msg) => msg.seq > member.readSeq && msg.from !== member.id);

  function requireLink(endpoint, linkId) {
    const want = String(linkId ?? '');
    const link = links().find((l) => l.id === want && memberOf(l, endpoint));
    if (!link) throw new LinkError(404, 'link_unknown', 'Diese Sitzung gehört nicht zu dieser Verbindung.');
    return { link, member: memberOf(link, endpoint) };
  }

  // Die Verbindung, die ein Aufruf meint: die genannte, oder die einzige der Sitzung.
  function pickLink(endpoint, linkId) {
    const mine = linksOf(endpoint);
    if (!mine.length) throw new LinkError(409, 'not_linked', 'Diese Sitzung hat keine Verbindung.');
    if (linkId) return requireLink(endpoint, linkId).link;
    if (mine.length === 1) return mine[0];
    throw new LinkError(400, 'link_ambiguous',
      `Diese Sitzung hat ${mine.length} Verbindungen — bitte eine mit --link <id> nennen: `
      + mine.map((l) => l.id).join(', '));
  }

  function checkText(text) {
    const body = typeof text === 'string' ? text : '';
    if (!body.trim()) throw new LinkError(400, 'text_missing', 'Leere Nachricht.');
    if (Buffer.byteLength(body, 'utf8') > MAX_TEXT_BYTES) {
      throw new LinkError(413, 'text_too_large', `Nachricht zu groß (höchstens ${MAX_TEXT_BYTES / 1024} KB).`);
    }
    return body;
  }

  function checkRate(member, t) {
    const recent = (sendLog.get(member.id) || []).filter((at) => t - at < 60_000);
    if (recent.length >= SEND_LIMIT_PER_MINUTE) {
      throw new LinkError(429, 'rate_limited',
        `Zu viele Nachrichten. Höchstens ${SEND_LIMIT_PER_MINUTE} pro Minute.`);
    }
    recent.push(t);
    sendLog.set(member.id, recent);
  }

  // Haengt eine Nachricht an den Verlauf. Aelteste weichen, wenn er zu lang oder
  // zu gross wird — auch ungelesene: ein Postfach, das niemand abholt, waechst
  // nicht unbegrenzt.
  function append(link, { from, fromName, text, at }) {
    link.seq += 1;
    link.messages.push({ seq: link.seq, from, fromName, text, at });
    if (link.messages.length > MAX_MESSAGES) link.messages.splice(0, link.messages.length - MAX_MESSAGES);
    let bytes = link.messages.reduce((n, msg) => n + Buffer.byteLength(msg.text, 'utf8'), 0);
    while (bytes > MAX_LINK_BYTES && link.messages.length > 1) {
      bytes -= Buffer.byteLength(link.messages.shift().text, 'utf8');
    }
    return link.seq;
  }

  function addMember(link, endpoint, name) {
    if (linksOf(endpoint).length >= MAX_LINKS_PER_ENDPOINT) {
      throw new LinkError(409, 'too_many_links',
        `Eine Sitzung kann höchstens ${MAX_LINKS_PER_ENDPOINT} Verbindungen haben.`);
    }
    const member = {
      id: id('m_', 6), endpoint, name: cleanName(name), joinedAt: now(),
      // Ein neues Mitglied beginnt beim aktuellen Stand: der bisherige Verlauf
      // ist fuer seinen Agenten weder ungelesen noch per `history` abrufbar.
      joinedSeq: link.seq, readSeq: link.seq, wokenSeq: link.seq, gone: false,
    };
    link.members.push(member);
    return member;
  }

  function dropIfDead(link) {
    if (!isHub(link) && link.members.every((m) => m.gone)) delete state.links[keyOf(link)];
  }

  return {
    // Stand neu von der Platte lesen, falls die Datei sich geaendert hat. Nur
    // fuer eine Instanz, die NICHT schreibt (s. owner in lib/link.js): sie zeigt
    // so den Stand der schreibenden Instanz, statt mit ihrem eigenen, veralteten
    // weiterzuarbeiten. Liefert, ob neu gelesen wurde.
    refresh() {
      const now = fileSig();
      if (now === sig) return false;
      sig = now;
      state = load();
      return true;
    },

    // Neue Verbindung mit `endpoint` als erstem Mitglied; liefert den Code zum Weitergeben.
    create({ endpoint, name, seats = 2 }) {
      const n = Number(seats);
      if (!Number.isInteger(n) || n < 2 || n > MAX_SEATS) {
        throw new LinkError(400, 'seats_invalid', `Plätze: 2 bis ${MAX_SEATS}.`);
      }
      const link = {
        id: id('ln_', 9), kind: 'local', createdAt: now(), seats: n, seq: 0,
        invite: { token: id('', 16), expiresAt: now() + INVITE_TTL_MS },
        members: [], messages: [],
      };
      addMember(link, endpoint, name);
      state.links[link.id] = link;
      save();
      return { id: link.id, code: inviteCode(link) };
    },

    join({ endpoint, name, code }) {
      const parsed = parseCode(code);
      const link = state.links[parsed.id];
      // Unbekannt und falsches Geheimnis sind von aussen nicht unterscheidbar.
      if (!link || !link.invite || !sameToken(link.invite.token, parsed.token)) {
        throw new LinkError(404, 'code_unknown',
          'Zu diesem Code gibt es hier keine offene Verbindung (vertippt, erneuert oder schon getrennt?).');
      }
      if (memberOf(link, endpoint)) {
        throw new LinkError(409, 'already_member', 'Diese Sitzung gehört bereits zu dieser Verbindung.');
      }
      if (link.invite.expiresAt <= now()) {
        throw new LinkError(410, 'invite_expired',
          'Die Einladung ist abgelaufen — in der erzeugenden Sitzung „Einladung erneuern“.');
      }
      if (seatsTaken(link) >= link.seats) {
        throw new LinkError(409, 'link_full', 'Alle Plätze dieser Verbindung sind vergeben.');
      }
      // Wer einen freigewordenen Platz uebernimmt, loest die aelteste "beendet"-Zeile
      // ab: so hat eine Verbindung nie mehr Zeilen als Plaetze, auch wenn ueber die
      // Zeit viele Sitzungen kommen und gehen.
      while (link.members.length >= link.seats) {
        link.members.splice(link.members.findIndex((m) => m.gone), 1);
      }
      addMember(link, endpoint, name);
      save();
      return { id: link.id };
    },

    // Zwei lokale Sitzungen in einem Schritt verbinden (ohne Code-Umweg).
    connect({ endpoint, name, peerEndpoint, peerName }) {
      if (endpoint === peerEndpoint) {
        throw new LinkError(400, 'self_link', 'Eine Sitzung kann sich nicht mit sich selbst verbinden.');
      }
      const both = links().find((l) => !isHub(l) && memberOf(l, endpoint) && memberOf(l, peerEndpoint)
        && l.members.length === 2);
      if (both) throw new LinkError(409, 'already_linked', 'Diese beiden Sitzungen sind bereits verbunden.');
      const link = {
        id: id('ln_', 9), kind: 'local', createdAt: now(), seats: 2, seq: 0,
        invite: null, members: [], messages: [],
      };
      addMember(link, endpoint, name);
      addMember(link, peerEndpoint, peerName);
      state.links[link.id] = link;
      save();
      return { id: link.id };
    },

    // Neuer Code fuer eine Verbindung mit freien Plaetzen; der alte gilt danach nicht mehr.
    renewInvite({ endpoint, linkId }) {
      const { link } = requireLink(endpoint, linkId);
      if (isHub(link)) throw new LinkError(500, 'internal', 'Hub-Verbindungen erneuert lib/link-hub.js.');
      if (seatsTaken(link) >= link.seats) {
        throw new LinkError(409, 'link_full', 'Alle Plätze dieser Verbindung sind vergeben.');
      }
      link.invite = { token: id('', 16), expiresAt: now() + INVITE_TTL_MS };
      save();
      return { id: link.id, code: inviteCode(link) };
    },

    leave({ endpoint, linkId }) {
      const { link, member } = requireLink(endpoint, linkId);
      if (isHub(link)) throw new LinkError(500, 'internal', 'Hub-Verbindungen verlässt lib/link-hub.js.');
      link.members = link.members.filter((m) => m !== member);
      sendLog.delete(member.id);
      dropIfDead(link); // auch: niemand mehr da
      save();
    },

    // Nachricht an alle uebrigen Mitglieder. Ohne linkId nur, wenn die Sitzung
    // genau eine Verbindung hat.
    send({ endpoint, linkId, text, name }) {
      const link = pickLink(endpoint, linkId);
      if (isHub(link)) throw new LinkError(500, 'internal', 'Hub-Verbindungen sendet lib/link-hub.js.');
      const member = memberOf(link, endpoint);
      const body = checkText(text);
      const recipients = link.members.filter((m) => m !== member && !m.gone);
      if (!recipients.length) {
        throw new LinkError(409, 'no_recipients', link.members.length > 1
          ? 'Die Gegenstelle gibt es nicht mehr (Sitzung beendet).'
          : 'Dieser Verbindung ist noch niemand beigetreten.');
      }
      const t = now();
      checkRate(member, t);
      if (name) member.name = cleanName(name);
      append(link, { from: member.id, fromName: member.name, text: body, at: t });
      save();
      return { id: link.id, seq: link.seq, recipients: recipients.map((m) => m.name) };
    },

    // Ungelesene Nachrichten aller Verbindungen der Sitzung; markiert sie als gelesen.
    inbox({ endpoint }) {
      const out = [];
      let changed = false;
      for (const link of linksOf(endpoint)) {
        const member = memberOf(link, endpoint);
        for (const msg of unreadOf(link, member)) {
          out.push({ link: link.id, seq: msg.seq, from: msg.fromName, text: msg.text, at: msg.at });
        }
        if (member.readSeq !== link.seq || member.wokenSeq !== link.seq) {
          member.readSeq = link.seq;
          member.wokenSeq = link.seq;
          changed = true;
        }
      }
      if (changed) save();
      return out.sort((a, b) => a.at - b.at || a.seq - b.seq);
    },

    // Verlauf einer Verbindung. `full` (Oberflaeche) zeigt alles Vorhandene, sonst
    // (Agent) nur, was seit dem eigenen Beitritt geschrieben wurde.
    history({ endpoint, linkId, limit = 50, full = false }) {
      const link = pickLink(endpoint, linkId);
      const member = memberOf(link, endpoint);
      const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_MESSAGES);
      return link.messages
        .filter((msg) => full || msg.seq > member.joinedSeq)
        .slice(-n)
        .map((msg) => ({
          link: link.id, seq: msg.seq, from: msg.fromName, own: msg.from === member.id,
          text: msg.text, at: msg.at,
        }));
    },

    // Der Hinweis wurde ins Pane getippt: bis zum Abholen nicht erneut als "neu" werten.
    markWoken({ endpoint }) {
      let changed = false;
      for (const link of linksOf(endpoint)) {
        const member = memberOf(link, endpoint);
        if (member.wokenSeq !== link.seq) { member.wokenSeq = link.seq; changed = true; }
      }
      if (changed) save();
    },

    // Kurzfassung fuer die Sidebar-Zeile: Zahl der Verbindungen, ungelesene
    // Nachrichten und wie viele davon noch nicht zugestellt (angekuendigt) sind.
    summary(endpoint) {
      let count = 0, unread = 0, pending = 0;
      for (const link of linksOf(endpoint)) {
        const member = memberOf(link, endpoint);
        const open = unreadOf(link, member);
        count += 1;
        unread += open.length;
        pending += open.filter((msg) => msg.seq > member.wokenSeq).length;
      }
      return { count, unread, pending };
    },

    // Ausfuehrliche Sicht einer Sitzung auf ihre Verbindungen (Overlay, `status`).
    view(endpoint) {
      return linksOf(endpoint).map((link) => viewOf(link, memberOf(link, endpoint)))
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    // Abgleich mit den tatsaechlich laufenden Sitzungen. `live` ist eine Map
    // Endpunkt -> aktueller Sitzungsname und darf NUR aus einer erfolgreichen
    // und aktuellen tmux-Abfrage stammen (s. snapshot/observe in lib/link.js):
    // fehlt ein Endpunkt darin, gilt die Sitzung als beendet (die Session-Option
    // lebt nur im tmux-Server). Lokale Verbindungen ohne lebendes Mitglied
    // werden entfernt.
    //
    // `gone` klebt nicht: nennt eine spaetere Liste den Endpunkt wieder, lebt
    // die Sitzung, und der Vermerk war falsch — etwa aus einer Liste, die vor
    // dem Setzen des Endpunkts gestartet wurde. Ohne das Zuruecknehmen bliebe
    // die Mitgliedschaft fuer immer tot und liesse sich wegen already_member
    // nicht einmal neu eintragen.
    //
    // Eine Hub-Verbindung endet hier NIE von selbst: "beendet" ist lokal
    // widerruflich, ein Austritt auf dem Hub waere es nicht. Sie bleibt stehen,
    // bis der Nutzer austritt oder der Hub das Mitglied nach seiner Frist
    // entfernt (abgefragt wird fuer eine beendete Sitzung nicht mehr).
    reconcile(live) {
      let changed = false;
      for (const link of links()) {
        for (const m of link.members) {
          if (!m.endpoint) continue; // Gegenstelle einer Hub-Verbindung
          const name = live.get(m.endpoint);
          if (name === undefined) {
            if (!m.gone) { m.gone = true; changed = true; }
          } else {
            if (m.gone) { m.gone = false; changed = true; }
            const clean = cleanName(name);
            if (m.name !== clean) { m.name = clean; changed = true; }
          }
        }
        if (!isHub(link) && link.members.every((m) => m.gone)) { delete state.links[keyOf(link)]; changed = true; }
      }
      if (changed) save();
      return changed;
    },

    endpoints() {
      const set = new Set();
      for (const link of links()) for (const m of link.members) if (m.endpoint && !m.gone) set.add(m.endpoint);
      return set;
    },

    count: () => links().length,

    // Hat die Sitzung noch Platz fuer eine weitere Verbindung? Vor einem Aufruf
    // beim Hub pruefen — sonst entstuende dort etwas, das hier nicht unterkommt.
    assertRoom(endpoint) {
      if (linksOf(endpoint).length >= MAX_LINKS_PER_ENDPOINT) {
        throw new LinkError(409, 'too_many_links',
          `Eine Sitzung kann höchstens ${MAX_LINKS_PER_ENDPOINT} Verbindungen haben.`);
      }
    },

    // Hat die Sitzung bereits eine Verbindung mit dieser Kennung (lokal oder ueber einen Hub)?
    hasLink: (endpoint, linkId) => linksOf(endpoint).some((l) => l.id === linkId),

    // Welche Verbindung meint ein Aufruf der Sitzung, und wie laeuft sie?
    target({ endpoint, linkId }) {
      const link = pickLink(endpoint, linkId);
      return { key: keyOf(link), id: link.id, kind: link.kind };
    },

    // --- Hub-Verbindungen (Transport und Ablauf in lib/link-hub.js) -----------

    // Neue Mitgliedschaft: nach dem Anlegen (status 'active', mit Gruppenschluessel
    // und Einladung) oder nach dem Beitrittsgesuch (status 'pending', mit dem, was
    // zum Oeffnen des welcome noetig ist).
    hubAdd({ endpoint, name, hub, linkId, memberId, token, seats, rev = 0, status, invite = null, join = null, groupKey = null }) {
      if (linksOf(endpoint).some((l) => l.id === linkId)) {
        throw new LinkError(409, 'already_member', 'Diese Sitzung gehört bereits zu einer Verbindung mit dieser Kennung.');
      }
      const link = {
        key: id('hl_', 9), id: linkId, kind: 'hub', hub, createdAt: now(), seats, seq: 0,
        status, me: { id: memberId, token }, rev, ack: 0,
        inviter: invite ? memberId : null, inviteExpiresAt: invite ? invite.expiresAt : null,
        invite, join,
        keys: groupKey ? { 1: groupKey } : {}, sendN: 0, seen: {}, requests: [], lost: 0,
        members: [], messages: [],
      };
      addMember(link, endpoint, name).id = memberId;
      state.links[link.key] = link;
      save();
      return link.key;
    },

    // Alle Hub-Mitgliedschaften der Installation (Abfrage-Schleife, Panel).
    hubLinks: () => links().filter(isHub),
    hubGet: (key) => { const l = state.links[String(key ?? '')]; return l && isHub(l) ? l : null; },

    // Aendert eine Hub-Mitgliedschaft und speichert. `fn(link, self, append)`:
    // `self` ist das eigene Mitglied, `append` haengt eine Nachricht an den
    // Verlauf. Liefert, was fn liefert.
    hubUpdate(key, fn) {
      const link = state.links[String(key ?? '')];
      if (!link || !isHub(link)) throw new LinkError(404, 'link_unknown', 'Diese Verbindung gibt es hier nicht mehr.');
      const out = fn(link, link.members.find((m) => m.endpoint), (msg) => append(link, msg));
      save();
      return out;
    },

    hubRemove(key) {
      const link = state.links[String(key ?? '')];
      if (!link || !isHub(link)) return;
      sendLog.delete(link.me.id);
      delete state.links[link.key];
      save();
    },

    // Vor dem Senden ueber den Hub: Text und Takt pruefen, den Zaehler der
    // eigenen Nachrichten hochsetzen und SPEICHERN — nach einem Absturz darf
    // derselbe Zaehlerstand nie ein zweites Mal vergeben werden (die Empfaenger
    // verwerfen alles, was nicht ueber ihrem letzten Stand liegt).
    hubPrepareSend(key, { text, name }) {
      const link = state.links[String(key ?? '')];
      if (!link || !isHub(link)) throw new LinkError(404, 'link_unknown', 'Diese Verbindung gibt es hier nicht mehr.');
      const self = link.members.find((m) => m.endpoint);
      const body = checkText(text);
      if (link.status === 'pending') {
        throw new LinkError(409, 'not_active', 'Der Beitritt zu dieser Verbindung ist noch nicht bestätigt.');
      }
      if (link.status !== 'active' || !link.keys[1]) {
        throw new LinkError(409, 'link_ended', 'Diese Verbindung besteht nicht mehr.');
      }
      if (!link.members.some((m) => m.remote && !m.pending)) {
        throw new LinkError(409, 'no_recipients', 'In dieser Verbindung gibt es gerade kein weiteres Mitglied.');
      }
      checkRate(self, now());
      if (name) self.name = cleanName(name);
      link.sendN += 1;
      save();
      return { text: body, n: link.sendN, name: self.name };
    },

    // Sicht der Installation auf alle Hub-Mitgliedschaften (Panel "Vernetzung").
    // Bewusst knapp: weder Einladungslink noch Mitglieder — die zeigt nur der
    // Dialog der jeweiligen Sitzung.
    hubView() {
      return links().filter(isHub).map((link) => {
        const self = link.members.find((m) => m.endpoint);
        return {
          key: link.key, id: link.id, hub: link.hub, createdAt: link.createdAt,
          status: link.status, ended: link.ended || null, session: self.name, sessionGone: !!self.gone,
        };
      }).sort((a, b) => a.createdAt - b.createdAt);
    },
  };

  function viewOf(link, member) {
    const open = unreadOf(link, member);
    const out = {
      id: link.id, kind: link.kind, createdAt: link.createdAt, seats: link.seats,
      taken: seatsTaken(link), // belegte Plaetze: lokal ohne beendete Mitglieder
      members: link.members.map((m) => ({
        id: m.id, name: m.name, self: m === member, gone: !!m.gone,
        ...(m.remote ? { remote: true, waiting: !!m.pending } : {}),
      })),
      messages: link.messages.length,
      unread: open.length,
      pending: open.filter((msg) => msg.seq > member.wokenSeq).length,
      invite: link.invite && seatsTaken(link) < link.seats
        ? { code: inviteCode(link), expiresAt: link.invite.expiresAt, valid: inviteValid(link) }
        : null,
    };
    if (!isHub(link)) return out;
    const active = link.status === 'active';
    return {
      ...out,
      hub: link.hub,
      status: link.status,            // 'pending' | 'active' | 'ended'
      ended: link.ended || null,      // Grund, wenn status 'ended'
      // Die Einladung gehoert einem Mitglied (dem Einladenden). Ist es ein anderes,
      // kennt diese Installation den Link nicht — nur, dass und bis wann er gilt.
      invite: active ? out.invite : null,
      inviteElsewhere: active && !link.invite && !!link.inviteExpiresAt && link.inviteExpiresAt > now()
        && seatsTaken(link) < link.seats,
      canInvite: active && seatsTaken(link) < link.seats,
      requests: active && link.invite ? link.requests.map((r) => ({ id: r.id, name: r.name, at: r.at })) : [],
      lost: link.lost || 0,
    };
  }
}
