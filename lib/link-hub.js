// Verbindungen ueber einen Hub: Transport und Ablauf.
//
// Der Hub (Projekt "Vernetzung", Bereich /api/v1/links) ist nur Postfach: er
// lagert Chiffrat, bis es abgeholt ist. Diese Installation ist der Client —
// ausgehend, per Long-Poll; von aussen erreichbar sein muss sie nicht. Namen,
// Texte und Schluessel verlassen sie nur verschluesselt (lib/link-crypto.js).
//
// Was der Hub schickt, gilt hier als ungeprueft:
//   - Jedes Feld wird auf Form geprueft, bevor es in den Zustand kommt.
//   - Fehlertexte des Hubs werden NIE weitergegeben, nur sein Fehlercode auf
//     einen festen eigenen Text abgebildet: die Meldung landet sonst ueber
//     `term-link send` in der Ausgabe eines Agenten, und ein fremder Hub
//     koennte ihm so beliebigen Text unterschieben.
//   - Nachrichten zaehlen erst, wenn sie sich mit dem Gruppenschluessel
//     oeffnen lassen und ihr Zaehler ueber dem letzten Stand des Absenders liegt.
//
// Abgefragt wird je Hub mit EINEM Aufruf fuer alle Mitgliedschaften. Die
// Abfrage ist zustandsbasiert (bestaetigter Stand `ack`, Stand der Verbindung
// `rev`): eine verlorene Antwort oder ein Abbruch richtet nichts an.
//
// Eine Installation tritt nie von selbst aus. Fuer eine beendete Sitzung wird
// lediglich nicht mehr abgefragt; den Platz raeumt dann der Hub nach seiner Frist.

import { LinkError, cleanName, MAX_TEXT_BYTES } from './link-store.js';
import { hubHost, inviteUrl, parseInvite } from './link-config.js';
import {
  KEY_NO, fromSecret, makeHello, makeWelcome, newGroupKey, newSecret,
  openHello, openMessage, openWelcome, sealMessage,
} from './link-crypto.js';

const API = '/api/v1/links';
const POLL_WAIT_S = 50;                 // der Hub haelt hoechstens 60 s
const POLL_MEMBERS_MAX = 128;
const REPLY_MAX = 256 * 1024;           // Antwort auf einen gewoehnlichen Aufruf
const POLL_REPLY_MAX = 32 * 1024 * 1024; // Abfrage: bis zu 100 Nachrichten je Mitgliedschaft
const BOX_MAX = 32 * 1024;
const ENVELOPE_MAX = 2 * 1024;
const POLL_GAP_MS = 500;                // Mindestabstand zweier Abfragen, s. run()
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;
const WELCOME_NAME_MAX = 32;            // haelt das welcome unter der Grenze des Hubs
const UNKNOWN_NAME = 'Mitglied';

const LINK_RE = /^ln_[A-Za-z0-9_-]{8,40}$/;
const MEMBER_RE = /^m_[A-Za-z0-9_-]{6,40}$/;
const TOKEN_RE = /^lmt_[A-Za-z0-9_-]{20,128}$/;
const KEY_B64_RE = /^[A-Za-z0-9_-]{43}$/;

// Feste Texte je Fehlercode des Hubs (s. Kopfkommentar).
const HUB_ERRORS = {
  key_invalid: 'Der Hub kennt diesen Zugangsschlüssel nicht.',
  key_revoked: 'Der Zugangsschlüssel wurde vom Betreiber des Hubs widerrufen.',
  links_limit: 'Mit diesem Zugangsschlüssel sind schon so viele Verbindungen aktiv, wie der Betreiber des Hubs erlaubt. Erst eine beenden.',
  seats_invalid: 'Der Hub lehnt diese Zahl an Plätzen ab.',
  link_unknown: 'Zu dieser Einladung gibt es auf dem Hub keine offene Verbindung (vertippt, erneuert, zurückgezogen oder schon getrennt?).',
  invite_expired: 'Die Einladung ist abgelaufen — wer eingeladen hat, kann sie erneuern.',
  link_full: 'Alle Plätze dieser Verbindung sind vergeben.',
  rate_limited: 'Der Hub bremst gerade (zu viele Anfragen) — später noch einmal versuchen.',
  not_inviter: 'Über Gesuche entscheidet nur, wer die geltende Einladung erzeugt hat.',
  not_pending: 'Zu diesem Mitglied gibt es kein offenes Gesuch mehr.',
  no_recipients: 'In dieser Verbindung gibt es kein weiteres aktives Mitglied.',
  box_too_large: 'Die Nachricht ist für den Hub zu groß.',
  envelope_too_large: 'Der Hub lehnt den Umschlag als zu groß ab.',
  backlog_full: 'Auf dem Hub lagern zu viele nicht abgeholte Nachrichten dieser Verbindung — eine Gegenstelle holt nicht ab.',
  not_active: 'Der Beitritt zu dieser Verbindung ist noch nicht bestätigt.',
  member_unknown: 'Der Hub kennt diese Mitgliedschaft nicht mehr (Verbindung gelöscht oder abgelaufen).',
};

// Warum eine Mitgliedschaft hier als beendet gefuehrt wird (die Texte dazu
// stehen in der Oberflaeche).
const REJECT_REASONS = new Set(['declined', 'invite_renewed', 'invite_withdrawn', 'request_expired']);

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); }
  if (signal) signal.addEventListener('abort', done, { once: true });
});

const isId = (v, re) => typeof v === 'string' && re.test(v);
const whenOf = (v) => { const t = Date.parse(typeof v === 'string' ? v : ''); return Number.isFinite(t) ? t : null; };

export function createHubLinks({
  store, config, isOwner = () => true, log = console, fetchImpl = globalThis.fetch, now = Date.now,
  pollWait = POLL_WAIT_S, minGapMs = POLL_GAP_MS,
}) {
  const pollers = new Map(); // Hub-Adresse -> { ctrl, gen, error, okAt, stopped }
  let keyInfo = null;        // Ergebnis der letzten Pruefung von Hub und Schluessel
  let closed = false;

  // --- HTTP -----------------------------------------------------------------

  // Ein Aufruf beim Hub. Keine Weiterleitungen (die Adresse ist geprueft, ihr
  // Ziel nach einer Weiterleitung waere es nicht), begrenzte Dauer und Groesse.
  async function request(base, method, route, { token, body, timeoutMs = 15_000, limit = REPLY_MAX, signal } = {}) {
    const host = hubHost(base);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let status = 0;
    let data = null;
    try {
      const res = await fetchImpl(`${base}${API}${route}`, {
        method,
        redirect: 'error',
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      const chunks = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > limit) { ctrl.abort(); throw new LinkError(502, 'hub_reply', `Die Antwort des Hubs ${host} ist zu groß.`); }
          chunks.push(chunk);
        }
      }
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
    } catch (err) {
      if (err instanceof LinkError) throw err;
      throw new LinkError(502, 'hub_unreachable', `Der Hub ${host} ist nicht erreichbar oder antwortet nicht.`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (status >= 200 && status < 300 && data && typeof data === 'object') return data;
    const rawCode = data && data.error && typeof data.error.code === 'string' ? data.error.code : '';
    const known = rawCode && Object.hasOwn(HUB_ERRORS, rawCode) ? rawCode : '';
    if (!rawCode) {
      throw new LinkError(502, status === 404 ? 'hub_no_links' : 'hub_reply', status === 404
        ? `Unter ${host} antwortet kein Hub mit Verbindungen (falsche Adresse oder ein zu alter Stand des Hubs).`
        : `Der Hub ${host} hat unerwartet geantwortet (HTTP ${status}).`);
    }
    if (!known) {
      throw new LinkError(status >= 400 && status < 500 ? status : 502, 'hub_rejected',
        `Der Hub ${host} hat die Anfrage abgelehnt (HTTP ${status}).`);
    }
    throw new LinkError(status >= 400 && status < 500 ? status : 502, known, HUB_ERRORS[known]);
  }

  // --- Einstellung ----------------------------------------------------------

  function assertOwner() {
    if (!isOwner()) {
      throw new LinkError(503, 'not_owner',
        'Verbindungen verwaltet inzwischen eine andere Webterminal-Instanz; diese Instanz schreibt nicht mehr.');
    }
  }

  function requireHubMode() {
    const cfg = config.get();
    if (cfg.mode !== 'hub') {
      throw new LinkError(409, 'hub_off',
        'Verbindungen über einen Hub sind hier nicht eingeschaltet — in der Sidebar unter „Vernetzung“ '
        + '„mit Hub“ wählen und die Adresse des Hubs eintragen.');
    }
    return cfg;
  }

  // Prueft Adresse und (falls angegeben) Zugangsschluessel gegen den Hub.
  async function check(base, key) {
    const data = await request(base, 'GET', '/info', { token: key || undefined });
    if (!data.links || data.links.version !== 1) {
      throw new LinkError(502, 'hub_version', `Der Hub ${hubHost(base)} spricht eine andere Protokollversion.`);
    }
    const k = key && data.key && typeof data.key === 'object' ? data.key : null;
    const info = {
      hub: base, at: now(), ok: true,
      key: k ? {
        label: cleanName(k.label),
        active: Number.isInteger(k.active_links) ? k.active_links : null,
        max: Number.isInteger(k.links_max) ? k.links_max : null,
      } : null,
    };
    keyInfo = info;
    return info;
  }

  // --- Anlegen, Einladen ----------------------------------------------------

  async function create({ endpoint, name, seats = 2 }) {
    const cfg = requireHubMode();
    if (!cfg.key) {
      throw new LinkError(409, 'key_missing',
        'Zum Anlegen fehlt der Zugangsschlüssel des Hubs — unter „Vernetzung“ eintragen. '
        + '(Beitreten geht ohne ihn, mit dem Einladungslink.)');
    }
    const n = Number(seats);
    if (!Number.isInteger(n) || n < 2 || n > 8) throw new LinkError(400, 'seats_invalid', 'Plätze: 2 bis 8.');
    store.assertRoom(endpoint);
    const secret = newSecret();
    const res = await request(cfg.hub, 'POST', '', { token: cfg.key, body: { seats: n, join_hash: fromSecret(secret).joinHash } });
    if (!isId(res.link_id, LINK_RE) || !isId(res.member_id, MEMBER_RE) || !isId(res.member_token, TOKEN_RE)) {
      throw new LinkError(502, 'hub_reply', `Der Hub ${hubHost(cfg.hub)} hat unerwartet geantwortet.`);
    }
    assertOwner();
    const inviteRev = Number.isInteger(res.rev) && res.rev > 0 ? res.rev : 0;
    store.hubAdd({
      endpoint, name, hub: cfg.hub, linkId: res.link_id, memberId: res.member_id, token: res.member_token,
      seats: n, rev: 0, status: 'active',
      invite: { secret, expiresAt: whenOf(res.invite_expires_at) ?? now() + 24 * 3600_000, ...(inviteRev ? { rev: inviteRev } : {}) },
      groupKey: newGroupKey().toString('base64url'),
    });
    sync();
    return { id: res.link_id, code: inviteUrl(cfg.hub, res.link_id, secret) };
  }

  function requireActive(endpoint, linkId) {
    const t = store.target({ endpoint, linkId });
    const link = store.hubGet(t.key);
    if (!link) throw new LinkError(404, 'link_unknown', 'Diese Sitzung gehört nicht zu dieser Verbindung.');
    if (link.status !== 'active') throw new LinkError(409, 'not_active', 'Diese Verbindung ist nicht aktiv.');
    return link;
  }

  // Neue Einladung; die alte gilt danach nicht mehr, offene Gesuche dazu lehnt der Hub ab.
  async function renewInvite({ endpoint, linkId }) {
    requireHubMode();
    const link = requireActive(endpoint, linkId);
    const secret = newSecret();
    const res = await request(link.hub, 'PUT', `/${link.id}/invite`,
      { token: link.me.token, body: { join_hash: fromSecret(secret).joinHash } });
    assertOwner();
    const expiresAt = whenOf(res.invite_expires_at) ?? now() + 24 * 3600_000;
    const inviteRev = Number.isInteger(res.rev) && res.rev > 0 ? res.rev : 0;
    store.hubUpdate(link.key, (l) => {
      l.invite = { secret, expiresAt, ...(inviteRev ? { rev: inviteRev } : {}) };
      l.inviter = l.me.id;
      l.inviteExpiresAt = expiresAt;
      l.requests = [];
    });
    kick(link.hub);
    return { id: link.id, code: inviteUrl(link.hub, link.id, secret) };
  }

  async function withdrawInvite({ endpoint, linkId }) {
    requireHubMode();
    const link = requireActive(endpoint, linkId);
    await request(link.hub, 'DELETE', `/${link.id}/invite`, { token: link.me.token });
    assertOwner();
    store.hubUpdate(link.key, (l) => { l.invite = null; l.inviteExpiresAt = null; l.requests = []; });
    kick(link.hub);
  }

  // --- Beitreten -------------------------------------------------------------

  // `confirm` ist der Rechnername, den der Nutzer bestaetigt hat. Ohne ihn wird
  // ein Hub, der nicht der eingetragene ist, nicht angesprochen: der Beitritt
  // heisst, dass diese Installation sich fortan dorthin verbindet.
  async function join({ endpoint, name, code, confirm }) {
    const cfg = requireHubMode();
    const inv = parseInvite(code, { insecure: config.insecure });
    const host = hubHost(inv.hub);
    if (inv.hub !== cfg.hub && confirm !== host) {
      const err = new LinkError(409, 'hub_confirm',
        `Diese Einladung läuft über den Hub ${host}, nicht über den hier eingetragenen.`);
      err.data = { host };
      throw err;
    }
    if (store.hubLinks().some((l) => l.hub === inv.hub && l.id === inv.id
      && l.members.some((m) => m.endpoint === endpoint))) {
      throw new LinkError(409, 'already_member', 'Diese Sitzung gehört bereits zu dieser Verbindung.');
    }
    store.assertRoom(endpoint);
    const { joinToken, inviteKey } = fromSecret(inv.secret);
    const { hello, privateKey } = makeHello(inviteKey, inv.id, cleanName(name));
    const res = await request(inv.hub, 'POST', `/${inv.id}/join`, { token: joinToken, body: { hello } });
    if (!isId(res.member_id, MEMBER_RE) || !isId(res.member_token, TOKEN_RE)) {
      throw new LinkError(502, 'hub_reply', `Der Hub ${host} hat unerwartet geantwortet.`);
    }
    assertOwner();
    store.hubAdd({
      endpoint, name, hub: inv.hub, linkId: inv.id, memberId: res.member_id, token: res.member_token,
      seats: 0, rev: 0, status: 'pending',
      join: { inviteKey: inviteKey.toString('base64url'), priv: privateKey },
    });
    sync();
    return { id: inv.id };
  }

  // --- Gesuche entscheiden (nur der Einladende) ---------------------------------

  async function decide({ endpoint, linkId, memberId, admit }) {
    requireHubMode();
    const link = requireActive(endpoint, linkId);
    const req = link.invite && link.requests.find((r) => r.id === memberId);
    if (!req) throw new LinkError(404, 'request_unknown', 'Dieses Gesuch gibt es nicht mehr.');
    const forget = () => store.hubUpdate(link.key, (l) => {
      l.requests = l.requests.filter((r) => r.id !== memberId);
      if (!admit) l.members = l.members.filter((m) => m.id !== memberId);
    });
    try {
      if (admit) {
        const self = link.members.find((m) => m.endpoint);
        const content = (names) => ({
          key_no: KEY_NO, key: link.keys[KEY_NO],
          members: names ? [self, ...link.members.filter((m) => m.remote && !m.pending)]
            .map((m) => ({ id: m.id, name: m.name.slice(0, WELCOME_NAME_MAX) })) : [],
        });
        const { inviteKey } = fromSecret(link.invite.secret);
        const pub = Buffer.from(req.pub, 'base64url');
        let welcome = makeWelcome(inviteKey, link.id, memberId, pub, content(true));
        // Zu viele oder zu lange Namen: lieber ohne — sie kommen mit den Nachrichten nach.
        if (Buffer.byteLength(welcome, 'base64url') > ENVELOPE_MAX) {
          welcome = makeWelcome(inviteKey, link.id, memberId, pub, content(false));
        }
        await request(link.hub, 'POST', `/${link.id}/members/${memberId}/admit`, { token: link.me.token, body: { welcome } });
      } else {
        await request(link.hub, 'DELETE', `/${link.id}/members/${memberId}`, { token: link.me.token });
      }
    } catch (err) {
      // Das Gesuch gibt es nicht mehr (zurueckgezogen, verfallen): hier aufraeumen.
      if (err instanceof LinkError && err.code === 'not_pending') {
        admit = false;
        if (isOwner()) { forget(); kick(link.hub); }
      }
      throw err;
    }
    assertOwner();
    if (!admit) { forget(); kick(link.hub); return; }
    store.hubUpdate(link.key, (l) => {
      l.requests = l.requests.filter((r) => r.id !== memberId);
      const m = l.members.find((x) => x.id === memberId);
      if (m) { m.pending = false; m.name = req.name; }
      else l.members.push({ id: memberId, name: req.name, remote: true, pending: false });
    });
    kick(link.hub);
    // Den uebrigen Mitgliedern den Namen des Neuen mitteilen. Gelingt das nicht,
    // erfahren sie ihn mit seiner ersten Nachricht.
    try { await post(link.key, { t: 'join', id: memberId, name: req.name }); } catch { /* s. o. */ }
  }

  // --- Senden -----------------------------------------------------------------

  // Verschluesselt `plain` (ohne Zaehler) und gibt es dem Hub. Der Zaehler ist
  // vorher gespeichert (hubPrepareSend bzw. hier fuer Mitteilungen).
  async function post(key, plain, n) {
    const link = store.hubGet(key);
    const count = n ?? store.hubUpdate(key, (l) => { l.sendN += 1; return l.sendN; });
    const groupKey = Buffer.from(link.keys[KEY_NO], 'base64url');
    const box = sealMessage(groupKey, KEY_NO, link.id, link.me.id, { ...plain, n: count });
    if (Buffer.byteLength(box, 'base64url') > BOX_MAX) {
      throw new LinkError(413, 'text_too_large', 'Die Nachricht ist verschlüsselt zu groß für den Hub.');
    }
    try {
      return await request(link.hub, 'POST', `/${link.id}/messages`, { token: link.me.token, body: { box } });
    } catch (err) {
      if (err instanceof LinkError && err.code === 'member_unknown' && isOwner()) end(key, 'removed');
      throw err;
    }
  }

  async function send({ key, text, name }) {
    requireHubMode();
    assertOwner();
    const prep = store.hubPrepareSend(key, { text, name });
    const res = await post(key, { t: 'msg', name: prep.name, text: prep.text }, prep.n);
    assertOwner();
    const ids = Array.isArray(res.recipients) ? res.recipients.map((r) => r && r.member_id) : [];
    return store.hubUpdate(key, (link, self, append) => {
      const seq = append({ from: link.me.id, fromName: self.name, text: prep.text, at: now() });
      const names = link.members.filter((m) => m.remote && ids.includes(m.id)).map((m) => m.name);
      return { id: link.id, seq, recipients: names.length ? names : ids.filter(Boolean).map(() => UNKNOWN_NAME) };
    });
  }

  // --- Austreten ---------------------------------------------------------------

  // Austritt auf dem Hub, dann hier entfernen. `force` entfernt nur hier (Hub
  // nicht erreichbar): der Platz auf dem Hub verfaellt dann nach dessen Frist.
  async function leave({ key, force = false }) {
    const link = store.hubGet(key);
    if (!link) throw new LinkError(404, 'link_unknown', 'Diese Verbindung gibt es hier nicht mehr.');
    const gone = link.status === 'ended' && link.ended !== 'key_failed'; // der Hub kennt sie schon nicht mehr
    if (!gone && !force) {
      try {
        await request(link.hub, 'DELETE', `/${link.id}/members/me`, { token: link.me.token });
      } catch (err) {
        if (!(err instanceof LinkError) || err.code !== 'member_unknown') {
          if (err instanceof LinkError && ['hub_unreachable', 'hub_reply', 'hub_no_links'].includes(err.code)) {
            err.data = { canForce: true, host: hubHost(link.hub) };
          }
          throw err;
        }
      }
    }
    assertOwner();
    store.hubRemove(key);
    kick(link.hub);
  }

  // --- Abfragen ---------------------------------------------------------------

  // Abgefragt wird, was noch lebt: wartende und aktive Mitgliedschaften laufender Sitzungen.
  const pollable = (l) => (l.status === 'pending' || l.status === 'active')
    && l.members.some((m) => m.endpoint && !m.gone);

  function end(key, reason) {
    try {
      store.hubUpdate(key, (l) => {
        l.status = 'ended';
        l.ended = reason;
        l.join = null;
        l.invite = null;
        l.inviteExpiresAt = null;
        l.requests = [];
      });
    } catch { /* inzwischen entfernt */ }
  }

  // Wendet das Ergebnis einer Abfrage auf eine Mitgliedschaft an. Liefert die
  // Kennungen der Gesuche, die sich nicht pruefen liessen (werden abgelehnt).
  function apply(key, token, r) {
    if (!isOwner()) return [];
    const link = store.hubGet(key);
    if (!link || link.me.token !== token || !r || typeof r !== 'object') return [];
    if (r.error) {
      if (r.error.code === 'member_unknown') end(key, link.status === 'pending' ? 'request_expired' : 'removed');
      return [];
    }
    if (r.link_id !== link.id || r.member_id !== link.me.id) return [];
    if (r.status === 'rejected') {
      end(key, REJECT_REASONS.has(r.reason) ? r.reason : 'declined');
      return [];
    }
    if (r.status !== 'active') return [];

    const bogus = [];
    let failed = false;
    store.hubUpdate(key, (l, self, append) => {
      // 1. Schluessel abholen (erste aktive Antwort nach der Annahme).
      if (!l.keys[KEY_NO]) {
        let w = null;
        try {
          w = openWelcome(Buffer.from(l.join.inviteKey, 'base64url'), l.id, l.me.id, l.join.priv, r.welcome);
        } catch { /* gefaelscht, beschaedigt oder fehlt (auch: kein l.join mehr) */ }
        if (!w || w.key_no !== KEY_NO || !isId(w.key, KEY_B64_RE)) { failed = true; return; }
        l.keys[KEY_NO] = w.key;
        l.status = 'active';
        l.join = null;
        l.welcomed = {};
        for (const m of Array.isArray(w.members) ? w.members.slice(0, 16) : []) {
          if (m && isId(m.id, MEMBER_RE) && typeof m.name === 'string') l.welcomed[m.id] = cleanName(m.name);
        }
      }

      // 2. Stand der Verbindung — immer vollstaendig, nie als Ereignisfolge.
      // Veraltete Staende (r.rev < l.rev) verwerfen.
      if (Array.isArray(r.members) && Number.isInteger(r.rev) && r.rev >= l.rev) {
        const known = new Map(l.members.filter((m) => m.remote).map((m) => [m.id, m.name]));
        // Ein frischer Einladungslink (create/renewInvite) hat eine Mindest-Revision:
        // eine noch laufende Poll-Antwort von davor kennt ihn nicht und darf ihn weder
        // loeschen noch alte Gesuche gegen das neue Geheimnis pruefen.
        const inviteStale = !!l.invite && Number.isInteger(l.invite.rev) && r.rev < l.invite.rev;
        const mine = !inviteStale && r.inviter === l.me.id && !!l.invite;
        if (!inviteStale && !mine) { l.invite = null; l.requests = []; }
        if (mine) {
          const { inviteKey } = fromSecret(l.invite.secret);
          const requests = [];
          for (const q of Array.isArray(r.requests) ? r.requests.slice(0, 16) : []) {
            if (!q || !isId(q.member_id, MEMBER_RE)) continue;
            try {
              const h = openHello(inviteKey, l.id, q.hello);
              requests.push({ id: q.member_id, name: cleanName(h.name), pub: h.pub.toString('base64url'), at: whenOf(q.at) ?? now() });
            } catch { bogus.push(q.member_id); } // kennt den Link nicht: kein echtes Gesuch
          }
          l.requests = requests;
        }
        const waitingName = new Map(l.requests.map((q) => [q.id, q.name]));
        const remote = [];
        for (const m of r.members.slice(0, 16)) {
          if (!m || !isId(m.member_id, MEMBER_RE) || m.member_id === l.me.id || bogus.includes(m.member_id)) continue;
          const pending = m.status === 'pending';
          remote.push({
            id: m.member_id, remote: true, pending,
            name: (pending && waitingName.get(m.member_id)) || known.get(m.member_id)
              || (l.welcomed && l.welcomed[m.member_id]) || waitingName.get(m.member_id) || UNKNOWN_NAME,
          });
        }
        l.members = [self, ...remote];
        l.rev = r.rev;
        if (Number.isInteger(r.seats) && r.seats >= 2 && r.seats <= 8) l.seats = r.seats;
        if (!inviteStale) {
          l.inviter = isId(r.inviter, MEMBER_RE) ? r.inviter : null;
          l.inviteExpiresAt = whenOf(r.invite_expires_at);
          if (l.invite && l.inviteExpiresAt) l.invite.expiresAt = l.inviteExpiresAt;
        }
        // Zaehler in l.seen NICHT loeschen, wenn ein Mitglied aus r.members faellt:
        // der Hub kontrolliert r.members und koennte sonst durch kurzzeitiges
        // Weglassen den Replay-Schutz fuer alte Chiffrate (gleicher Gruppenschluessel
        // in v1) aushebeln. Eintraege entstehen erst nach gelungenem openMessage, der
        // Hub kann l.seen also nicht mit erfundenen Kennungen aufblaehen.
      }

      // 3. Der Hub musste Unabgeholtes verwerfen.
      if (r.gap && Number.isInteger(r.gap.from) && Number.isInteger(r.gap.to) && r.gap.to >= r.gap.from
        && r.gap.to > (l.gapTo || 0)) {
        l.lost = (l.lost || 0) + Math.min(r.gap.to - Math.max(r.gap.from, (l.gapTo || 0) + 1) + 1, 10_000);
        l.gapTo = r.gap.to;
      }

      // 4. Nachrichten.
      const keys = new Map([[KEY_NO, Buffer.from(l.keys[KEY_NO], 'base64url')]]);
      for (const m of Array.isArray(r.messages) ? r.messages : []) {
        if (!m || !Number.isInteger(m.seq) || m.seq <= l.ack) continue;
        l.ack = m.seq; // auch Unlesbares ist erledigt — sonst kaeme es fuer immer wieder
        if (!isId(m.from, MEMBER_RE) || m.from === l.me.id) continue;
        let plain = null;
        try { plain = openMessage(keys, l.id, m.from, m.box); } catch { /* nicht echt oder fremder Schluessel */ }
        if (!plain || typeof plain !== 'object') { l.lost = (l.lost || 0) + 1; continue; }
        // Zaehler je Absender: schuetzt vor Wiedereinspielen durch den Hub.
        if (!Number.isInteger(plain.n) || plain.n <= (l.seen[m.from] || 0)) continue;
        l.seen[m.from] = plain.n;
        const sender = l.members.find((x) => x.remote && x.id === m.from);
        if (plain.t === 'msg') {
          if (typeof plain.text !== 'string' || !plain.text.trim()
            || Buffer.byteLength(plain.text, 'utf8') > MAX_TEXT_BYTES) continue;
          const name = cleanName(typeof plain.name === 'string' && plain.name ? plain.name : (sender ? sender.name : UNKNOWN_NAME));
          if (sender) sender.name = name;
          append({ from: m.from, fromName: name, text: plain.text, at: whenOf(m.sent_at) ?? now() });
        } else if (plain.t === 'join' && isId(plain.id, MEMBER_RE) && typeof plain.name === 'string') {
          // Nur fuer ein Mitglied, dessen Namen wir noch nicht kennen: niemand benennt andere um.
          const who = l.members.find((x) => x.remote && x.id === plain.id);
          if (who && who.name === UNKNOWN_NAME) who.name = cleanName(plain.name);
        }
      }
    });
    if (failed) end(key, 'key_failed');
    return bogus;
  }

  async function run(base, p) {
    let wait = 0;
    let warned = false;
    while (!p.stopped && !closed) {
      if (!isOwner() || config.get().mode !== 'hub') break;
      const all = store.hubLinks().filter((l) => l.hub === base && pollable(l));
      if (!all.length) break;
      if (all.length > POLL_MEMBERS_MAX && !warned) {
        warned = true;
        log.warn(`term-link: mehr als ${POLL_MEMBERS_MAX} Mitgliedschaften bei ${hubHost(base)} — die übrigen werden nicht abgefragt.`);
      }
      const list = all.slice(0, POLL_MEMBERS_MAX).map((l) => ({ key: l.key, token: l.me.token, id: l.id }));
      const gen = p.gen;
      const started = Date.now();
      p.ctrl = new AbortController();
      try {
        const data = await request(base, 'POST', '/poll', {
          timeoutMs: (pollWait + 20) * 1000, limit: POLL_REPLY_MAX, signal: p.ctrl.signal,
          body: {
            wait: pollWait,
            members: all.slice(0, POLL_MEMBERS_MAX).map((l) => ({
              token: l.me.token, ack: l.ack, rev: l.rev, ...(l.keys[KEY_NO] ? { have_key: true } : {}),
            })),
          },
        });
        if (p.stopped || closed || !isOwner() || config.get().mode !== 'hub') break;
        if (!Array.isArray(data.results) || data.results.length !== list.length) {
          throw new LinkError(502, 'hub_reply', `Der Hub ${hubHost(base)} hat unerwartet geantwortet.`);
        }
        for (let i = 0; i < list.length; i++) {
          let bogus = [];
          try { bogus = apply(list[i].key, list[i].token, data.results[i]); } catch (err) {
            log.warn('term-link: Ergebnis des Hubs nicht verarbeitbar:', err.message);
          }
          for (const id of bogus) {
            request(base, 'DELETE', `/${list[i].id}/members/${id}`, { token: list[i].token }).catch(() => {});
          }
        }
        p.error = null;
        p.okAt = now();
        wait = 0;
        // Ein Hub, der jede Abfrage sofort beantwortet (Fehler oder Absicht), soll
        // diese Schleife nicht zum Dauerfeuer machen.
        const early = minGapMs - (Date.now() - started);
        if (early > 0) await sleep(early, p.ctrl.signal);
      } catch (err) {
        if (p.gen !== gen || p.stopped || closed) continue; // geweckt: gleich neu abfragen
        p.error = err instanceof LinkError ? err.message : 'Abfrage fehlgeschlagen.';
        if (!(err instanceof LinkError)) log.warn('term-link: Abfrage beim Hub fehlgeschlagen:', err);
        wait = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, wait * 2));
        p.ctrl = new AbortController();
        await sleep(wait, p.ctrl.signal);
      }
    }
    if (pollers.get(base) === p) pollers.delete(base);
    // Zwischen letzter Pruefung und Ende kann eine Mitgliedschaft dazugekommen sein.
    if (!p.stopped && !closed) setImmediate(sync);
  }

  // Laufende Abfrage abbrechen und sofort neu stellen (die Liste hat sich geaendert).
  function kick(base) {
    const p = pollers.get(base);
    if (p) { p.gen += 1; if (p.ctrl) p.ctrl.abort(); } else sync();
  }

  // Abfrage-Schleifen an den Stand anpassen: eine je Hub mit lebender Mitgliedschaft.
  function sync() {
    if (closed) return;
    const on = isOwner() && config.get().mode === 'hub';
    const wanted = new Set(on ? store.hubLinks().filter(pollable).map((l) => l.hub) : []);
    for (const [base, p] of pollers) {
      if (!wanted.has(base)) { p.stopped = true; if (p.ctrl) p.ctrl.abort(); pollers.delete(base); }
    }
    for (const base of wanted) {
      if (pollers.has(base)) continue;
      const p = { ctrl: null, gen: 0, error: null, okAt: 0, stopped: false };
      pollers.set(base, p);
      run(base, p).catch((err) => log.error('term-link: Abfrage-Schleife beendet:', err));
    }
  }

  function close() {
    closed = true;
    for (const p of pollers.values()) { p.stopped = true; if (p.ctrl) p.ctrl.abort(); }
    pollers.clear();
  }

  // Stand fuer das Panel "Vernetzung".
  function status() {
    return {
      keyInfo,
      hubs: [...pollers].map(([base, p]) => ({ hub: base, host: hubHost(base), error: p.error, okAt: p.okAt })),
    };
  }

  return {
    check, create, join, decide, renewInvite, withdrawInvite, send, leave, sync, close, status,
    forgetCheck: () => { keyInfo = null; },
  };
}
