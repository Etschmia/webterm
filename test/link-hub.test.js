import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLinkStore } from '../lib/link-store.js';
import { createLinkConfig, hubHost } from '../lib/link-config.js';
import { createHubLinks } from '../lib/link-hub.js';

// Zwei oder mehr Installationen (je eigener Zustand in einem Temp-Verzeichnis)
// gegen einen Hub. Ab Werk eine Attrappe des Hubs in diesem Prozess, die das
// Protokoll nachbildet. Mit TERM_TEST_HUB_DIR=<Checkout des Hub-Projekts> laeuft
// dasselbe gegen den echten Hub-Code (braucht node ab 22.18); die Tests, die in
// die Attrappe hineingreifen, entfallen dann.
const REAL_DIR = process.env.TERM_TEST_HUB_DIR || '';
const MARK = 'HUBTEXT-nie-weitergeben';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (prefix, n = 9) => prefix + crypto.randomBytes(n).toString('base64url');

function fakeHub() {
  const links = new Map();
  const tokens = new Map(); // Mitglieds-Token -> { link, member }
  const waiters = new Set();
  const key = `vnk_${crypto.randomBytes(24).toString('base64url')}`;
  const wake = () => { for (const w of [...waiters]) w(); };
  const fail = (status, code) => Object.assign(new Error(code), { status, code });
  const bump = (link) => { link.rev += 1; wake(); };
  const active = (link) => [...link.members.values()].filter((m) => m.status === 'active');
  const seated = (link) => [...link.members.values()].filter((m) => m.status !== 'rejected');

  function auth(req, linkId, anyStatus) {
    const t = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!t || t.link.id !== linkId || !t.link.members.has(t.member.id)) throw fail(401, 'member_unknown');
    if (!anyStatus && t.member.status !== 'active') throw fail(403, 'not_active');
    return t;
  }

  function evaluate(e) {
    const t = tokens.get(e.token);
    if (!t || !t.link.members.has(t.member.id) || !links.has(t.link.id)) {
      return { ready: true, result: { error: { code: 'member_unknown', message: MARK } } };
    }
    const { link, member } = t;
    member.polls += 1;
    const head = { link_id: link.id, member_id: member.id, status: member.status };
    if (member.status === 'rejected') return { ready: true, result: { ...head, reason: member.reason } };
    if (member.status === 'pending') return { ready: false, result: head };
    member.acked = Math.max(member.acked, Math.min(e.ack || 0, link.seq));
    if (e.have_key) member.welcome = null;
    const messages = link.messages.filter((m) => m.seq > Math.max(member.acked, member.joinedSeq) && m.from !== member.id);
    const changed = (e.rev || 0) !== link.rev;
    const roster = changed ? {
      seats: link.seats, inviter: link.inviteBy,
      invite_expires_at: link.inviteExpires ? new Date(link.inviteExpires).toISOString() : null,
      members: seated(link).map((m) => ({ member_id: m.id, status: m.status })),
      ...(link.inviteBy === member.id ? {
        requests: seated(link).filter((m) => m.status === 'pending')
          .map((m) => ({ member_id: m.id, hello: m.hello, at: new Date().toISOString() })),
      } : {}),
    } : {};
    return {
      ready: changed || messages.length > 0 || !!member.welcome,
      result: { ...head, rev: link.rev, ...roster, ...(member.welcome ? { welcome: member.welcome } : {}), messages },
    };
  }

  async function route(req, body) {
    const url = req.url.replace('/api/v1/links', '');
    const at = (re) => re.exec(`${req.method} ${url}`);
    let m;
    if (at(/^GET \/info$/)) {
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (bearer && bearer !== key) throw fail(401, 'key_invalid');
      return [200, { links: { version: 1 }, ...(bearer ? { key: { label: 'Testschlüssel', active_links: links.size, links_max: 50 } } : {}) }];
    }
    if (at(/^POST $/)) {
      if ((req.headers.authorization || '') !== `Bearer ${key}`) throw fail(401, 'key_invalid');
      const link = {
        id: rid('ln_'), seats: body.seats, rev: 1, seq: 0, joinHash: body.join_hash, inviteBy: null,
        inviteExpires: Date.now() + 3600_000, members: new Map(), messages: [],
      };
      const member = { id: rid('m_'), status: 'active', acked: 0, joinedSeq: 0, welcome: null, polls: 0 };
      const token = rid('lmt_', 24);
      link.inviteBy = member.id;
      link.members.set(member.id, member);
      links.set(link.id, link);
      tokens.set(token, { link, member });
      return [201, { link_id: link.id, member_id: member.id, member_token: token, seats: link.seats, rev: 1,
        url: `http://ignoriert.example/l/${link.id}`, invite_expires_at: new Date(link.inviteExpires).toISOString() }];
    }
    if (at(/^POST \/poll$/)) {
      let out = body.members.map(evaluate);
      if (body.wait > 0 && !out.some((r) => r.ready)) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
          const timer = setTimeout(done, body.wait * 1000);
          waiters.add(done);
          req.on('close', done);
        });
        out = body.members.map(evaluate);
      }
      return [200, { results: out.map((r) => r.result) }];
    }
    if ((m = at(/^POST \/(ln_[\w-]+)\/join$/))) {
      const link = links.get(m[1]);
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!link || !link.joinHash || sha(bearer) !== link.joinHash) throw fail(404, 'link_unknown');
      if (seated(link).length >= link.seats) throw fail(409, 'link_full');
      const member = { id: rid('m_'), status: 'pending', hello: body.hello, acked: 0, joinedSeq: 0, welcome: null, polls: 0 };
      const token = rid('lmt_', 24);
      link.members.set(member.id, member);
      tokens.set(token, { link, member });
      bump(link);
      return [201, { member_id: member.id, member_token: token, status: 'pending' }];
    }
    if ((m = at(/^PUT \/(ln_[\w-]+)\/invite$/))) {
      const { link, member } = auth(req, m[1]);
      for (const x of link.members.values()) if (x.status === 'pending') { x.status = 'rejected'; x.reason = 'invite_renewed'; }
      Object.assign(link, { joinHash: body.join_hash, inviteBy: member.id, inviteExpires: Date.now() + 3600_000 });
      bump(link);
      return [200, { url: 'x', invite_expires_at: new Date(link.inviteExpires).toISOString(), rev: link.rev }];
    }
    if ((m = at(/^DELETE \/(ln_[\w-]+)\/invite$/))) {
      const { link } = auth(req, m[1]);
      for (const x of link.members.values()) if (x.status === 'pending') { x.status = 'rejected'; x.reason = 'invite_withdrawn'; }
      Object.assign(link, { joinHash: null, inviteBy: null, inviteExpires: null });
      bump(link);
      return [200, { rev: link.rev }];
    }
    if ((m = at(/^POST \/(ln_[\w-]+)\/messages$/))) {
      const { link, member } = auth(req, m[1]);
      const to = active(link).filter((x) => x !== member);
      if (!to.length) throw fail(409, 'no_recipients');
      link.seq += 1;
      link.messages.push({ seq: link.seq, from: member.id, box: body.box, sent_at: new Date().toISOString() });
      wake();
      return [201, { seq: link.seq, sent_at: new Date().toISOString(), recipients: to.map((x) => ({ member_id: x.id, presence: 'listening' })) }];
    }
    if ((m = at(/^DELETE \/(ln_[\w-]+)\/members\/me$/))) {
      const { link, member } = auth(req, m[1], true);
      link.members.delete(member.id);
      if (link.inviteBy === member.id) Object.assign(link, { joinHash: null, inviteBy: null, inviteExpires: null });
      if (!active(link).length) links.delete(link.id);
      bump(link);
      return [200, { ok: true }];
    }
    if ((m = at(/^(POST|DELETE) \/(ln_[\w-]+)\/members\/(m_[\w-]+)(\/admit)?$/))) {
      const { link, member } = auth(req, m[2]);
      if (link.inviteBy !== member.id) throw fail(403, 'not_inviter');
      const target = link.members.get(m[3]);
      if (!target || target.status !== 'pending') throw fail(409, 'not_pending');
      if (m[4]) Object.assign(target, { status: 'active', hello: null, welcome: body.welcome, joinedSeq: link.seq, acked: link.seq });
      else Object.assign(target, { status: 'rejected', reason: 'declined' });
      bump(link);
      return [200, { rev: link.rev }];
    }
    throw fail(404, 'not_found');
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let status = 500;
    let out = {};
    try {
      [status, out] = await route(req, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
    } catch (err) {
      status = err.status || 500;
      // Der Text traegt eine Marke: nichts davon darf je in einer Meldung der Installation auftauchen.
      out = { error: { code: err.code || 'internal', message: `${MARK} ${err.message}` } };
    }
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return {
    server, key, links,
    stored: () => JSON.stringify([...links.values()].map((l) => [l.messages, [...l.members.values()]])),
    members: (id) => (links.get(id) ? [...links.get(id).members.values()] : []),
  };
}

async function startHub(t) {
  let hub;
  if (REAL_DIR) {
    const { createHub } = await import(path.join(path.resolve(REAL_DIR), 'src', 'hub.ts'));
    const real = createHub({ dbPath: ':memory:', adminPassword: 'nur-fuer-den-test', log: () => {} });
    hub = {
      server: http.createServer(real.handler), key: real.links.admin.createKey('Test', 50), real,
      stored: () => JSON.stringify(real.core.all('SELECT * FROM link_messages').concat(real.core.all('SELECT * FROM link_members'))),
      members: (id) => real.core.all('SELECT id, status FROM link_members WHERE link_id = ?', id),
    };
    t.after(() => real.close());
  } else hub = fakeHub();
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { hub.server.close(); hub.server.closeAllConnections(); });
  hub.base = `http://127.0.0.1:${hub.server.address().port}`;
  return hub;
}

const quiet = { warn() {}, error() {}, log() {} };

function installation(t, hub, { mode = 'hub', base = hub.base, key = hub.key } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-link-hub-'));
  const store = createLinkStore({ dir });
  const config = createLinkConfig({ dir, insecure: true });
  config.set({ mode, hub: base, key });
  const client = createHubLinks({ store, config, log: quiet, pollWait: 2, minGapMs: 10 });
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    store, config, hub: client, dir,
    view: (ep) => store.view(ep),
    send: (ep, text, name) => client.send({ key: store.target({ endpoint: ep }).key, text, name }),
  };
}

async function until(check, what = 'Bedingung', ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) assert.fail(`Zeit abgelaufen: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

// Legt bei A an, laesst B beitreten und A annehmen. Liefert die Kennung.
async function linked(a, b, { seats = 2 } = {}) {
  const made = await a.hub.create({ endpoint: 'ep_a', name: 'alpha', seats });
  await b.hub.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  const req = (await until(() => a.view('ep_a')[0].requests[0], 'Gesuch bei A'));
  await a.hub.decide({ endpoint: 'ep_a', linkId: made.id, memberId: req.id, admit: true });
  await until(() => b.view('ep_b')[0].status === 'active', 'B aktiv');
  return made;
}

test('create, join, admit by click, then encrypted messages both ways', { timeout: 30000 }, async (t) => {
  const hub = await startHub(t);
  const a = installation(t, hub);
  const b = installation(t, hub, { key: '' }); // beitreten geht ohne Zugangsschluessel

  const made = await a.hub.create({ endpoint: 'ep_a', name: 'alpha', seats: 3 });
  assert.match(made.code, new RegExp(`^${hub.base}/l/ln_[\\w-]+#[\\w-]{43}$`));
  let va = a.view('ep_a')[0];
  assert.equal(va.kind, 'hub');
  assert.equal(va.status, 'active');
  assert.equal(va.invite.code, made.code);
  await assert.rejects(a.send('ep_a', 'niemand da', 'alpha'), (e) => e.code === 'no_recipients');
  await assert.rejects(b.hub.create({ endpoint: 'ep_b', name: 'beta' }), (e) => e.code === 'key_missing');

  await b.hub.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  assert.equal(b.view('ep_b')[0].status, 'pending');
  await assert.rejects(b.send('ep_b', 'zu früh', 'beta'), (e) => e.code === 'not_active');
  await assert.rejects(b.hub.join({ endpoint: 'ep_b', name: 'beta', code: made.code }), (e) => e.code === 'already_member');

  // A sieht das Gesuch samt Namen — und erst sein Klick laesst B hinein.
  const req = await until(() => a.view('ep_a')[0].requests[0], 'Gesuch bei A');
  assert.equal(req.name, 'beta');
  assert.equal(b.view('ep_b')[0].status, 'pending');
  await a.hub.decide({ endpoint: 'ep_a', linkId: made.id, memberId: req.id, admit: true });
  const vb = await until(() => { const v = b.view('ep_b')[0]; return v.status === 'active' && v; }, 'B aktiv');
  await until(() => a.view('ep_a')[0].members.some((m) => m.remote && !m.waiting), 'A sieht B als Mitglied');
  assert.deepEqual(vb.members.filter((m) => !m.self).map((m) => m.name), ['alpha']);
  va = a.view('ep_a')[0];
  assert.deepEqual(va.members.filter((m) => !m.self).map((m) => [m.name, m.remote, m.waiting]), [['beta', true, false]]);
  assert.deepEqual(va.requests, []);
  assert.equal(vb.invite, null, 'B kennt den Einladungslink nicht');

  const sent = await a.send('ep_a', 'Hallo von nebenan — streng vertraulich', 'alpha');
  assert.deepEqual(sent.recipients, ['beta']);
  await until(() => b.store.summary('ep_b').unread === 1, 'Nachricht bei B');
  assert.deepEqual(b.store.summary('ep_b'), { count: 1, unread: 1, pending: 1 });
  const inbox = b.store.inbox({ endpoint: 'ep_b' });
  assert.deepEqual(inbox.map((m) => [m.from, m.text, m.link]), [['alpha', 'Hallo von nebenan — streng vertraulich', made.id]]);

  // Der Absender nennt seinen aktuellen Namen mit jeder Nachricht (umbenannte Sitzung).
  await b.send('ep_b', 'Antwort', 'beta-umbenannt');
  await until(() => a.store.summary('ep_a').unread === 1, 'Antwort bei A');
  assert.deepEqual(a.store.inbox({ endpoint: 'ep_a' }).map((m) => [m.from, m.text]), [['beta-umbenannt', 'Antwort']]);
  assert.deepEqual(a.store.history({ endpoint: 'ep_a', full: true }).map((m) => [m.own, m.text]),
    [[true, 'Hallo von nebenan — streng vertraulich'], [false, 'Antwort']]);

  // Der Hub hat nur Chiffrat: weder Texte noch Namen noch das Geheimnis des Links.
  const stored = hub.stored();
  for (const secret of ['vertraulich', 'Antwort', 'alpha', 'beta', made.code.split('#')[1]]) {
    assert.ok(!stored.includes(secret), `Hub kennt „${secret}“`);
  }
});

test('a third member learns the names from the welcome, the others from the join notice', { timeout: 30000 }, async (t) => {
  const hub = await startHub(t);
  const [a, b, c] = [installation(t, hub), installation(t, hub), installation(t, hub)];
  const made = await linked(a, b, { seats: 3 });
  await c.hub.join({ endpoint: 'ep_c', name: 'gamma', code: made.code });
  // B ist Mitglied, aber nicht der Einladende: er sieht ein wartendes Mitglied, kein Gesuch.
  await until(() => b.view('ep_b')[0].members.some((m) => m.waiting), 'B sieht den Wartenden');
  assert.deepEqual(b.view('ep_b')[0].requests, []);
  await assert.rejects(b.hub.decide({ endpoint: 'ep_b', linkId: made.id, memberId: 'm_irgendwer0', admit: true }),
    (e) => e.code === 'request_unknown');
  const req = await until(() => a.view('ep_a')[0].requests[0], 'Gesuch von C');
  await a.hub.decide({ endpoint: 'ep_a', linkId: made.id, memberId: req.id, admit: true });
  const names = (x, ep) => x.view(ep)[0].members.filter((m) => !m.self && !m.waiting).map((m) => m.name).sort();
  await until(() => c.view('ep_c')[0].status === 'active', 'C aktiv');
  assert.deepEqual(names(c, 'ep_c'), ['alpha', 'beta']);
  await until(() => names(b, 'ep_b').includes('gamma'), 'B kennt den Namen von C');
  assert.deepEqual(a.view('ep_a')[0].invite, null, 'alle Plätze vergeben: keine Einladung mehr');

  await c.send('ep_c', 'an alle', 'gamma');
  await until(() => a.store.summary('ep_a').unread === 1 && b.store.summary('ep_b').unread === 1, 'Rundnachricht');
  // Die Beitrittsmitteilung ist keine Nachricht: im Postfach liegt nur der Text von C.
  assert.deepEqual(b.store.inbox({ endpoint: 'ep_b' }).map((m) => [m.from, m.text]), [['gamma', 'an alle']]);
});

test('a foreign hub needs the user\'s confirmation; without hub mode nothing leaves the installation', { timeout: 30000 }, async (t) => {
  const hub = await startHub(t);
  const a = installation(t, hub);
  const elsewhere = installation(t, hub, { base: 'https://eigener-hub.example', key: '' });
  const local = installation(t, hub, { mode: 'local', key: '' });
  const made = await a.hub.create({ endpoint: 'ep_a', name: 'alpha' });

  await assert.rejects(local.hub.join({ endpoint: 'ep_l', name: 'lokal', code: made.code }), (e) => e.code === 'hub_off');
  await assert.rejects(elsewhere.hub.join({ endpoint: 'ep_e', name: 'fern', code: made.code }),
    (e) => e.code === 'hub_confirm' && e.data.host === hubHost(hub.base));
  await assert.rejects(elsewhere.hub.join({ endpoint: 'ep_e', name: 'fern', code: made.code, confirm: 'anderer.example' }),
    (e) => e.code === 'hub_confirm');
  assert.deepEqual(elsewhere.view('ep_e'), []);
  await elsewhere.hub.join({ endpoint: 'ep_e', name: 'fern', code: made.code, confirm: hubHost(hub.base) });
  assert.equal(elsewhere.view('ep_e')[0].status, 'pending');
  const req = await until(() => a.view('ep_a')[0].requests[0], 'Gesuch über den fremden Hub');
  assert.equal(req.name, 'fern');

  // Ablehnen: beim Beitretenden steht danach der Grund, und er fragt nicht weiter ab.
  await a.hub.decide({ endpoint: 'ep_a', linkId: made.id, memberId: req.id, admit: false });
  const ended = await until(() => { const v = elsewhere.view('ep_e')[0]; return v.status === 'ended' && v; }, 'Ablehnung');
  assert.equal(ended.ended, 'declined');
  await until(() => elsewhere.hub.status().hubs.length === 0, 'Abfrage endet');
  await elsewhere.hub.leave({ key: elsewhere.store.hubView()[0].key });
  assert.deepEqual(elsewhere.view('ep_e'), []);
  assert.deepEqual(a.view('ep_a')[0].requests, []);
});

test('hub errors map to fixed texts; nothing the hub says reaches the user or the agent', { timeout: 30000 }, async (t) => {
  const hub = await startHub(t);
  const a = installation(t, hub);
  const b = installation(t, hub, { key: `vnk_${'x'.repeat(32)}` });
  const made = await a.hub.create({ endpoint: 'ep_a', name: 'alpha' });
  const wrong = `${made.code.split('#')[0]}#${'A'.repeat(43)}`;
  const errors = [];
  for (const attempt of [
    () => b.hub.join({ endpoint: 'ep_b', name: 'beta', code: wrong }),
    () => b.hub.create({ endpoint: 'ep_b', name: 'beta' }),
    () => b.hub.check(hub.base, `vnk_${'x'.repeat(32)}`),
    () => b.hub.join({ endpoint: 'ep_b', name: 'beta', code: 'https://hub.example.org/l/ln_ohneGeheimnis' }),
  ]) {
    try { await attempt(); assert.fail('sollte scheitern'); } catch (e) { errors.push(e); }
  }
  assert.deepEqual(errors.map((e) => e.code), ['link_unknown', 'key_invalid', 'key_invalid', 'code_invalid']);
  for (const e of errors) assert.ok(!e.message.includes('HUBTEXT') && !/[a-z]+_[a-z]+/.test(e.message), e.message);
  assert.deepEqual(b.view('ep_b'), []);

  const info = await a.hub.check(hub.base, hub.key);
  assert.equal(info.ok, true);
  assert.equal(typeof info.key.label, 'string');
  // Kein Hub unter der Adresse: klare Meldung statt eines Absturzes.
  const dead = http.createServer((req, res) => { res.writeHead(404); res.end('nichts'); });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  t.after(() => dead.close());
  await assert.rejects(a.hub.check(`http://127.0.0.1:${dead.address().port}`, ''), (e) => e.code === 'hub_no_links');
  // Weiterleitungen folgt der Client nicht.
  const redirect = http.createServer((req, res) => { res.writeHead(302, { Location: `${hub.base}${req.url}` }); res.end(); });
  await new Promise((r) => redirect.listen(0, '127.0.0.1', r));
  t.after(() => redirect.close());
  await assert.rejects(a.hub.check(`http://127.0.0.1:${redirect.address().port}`, ''), (e) => e.code === 'hub_unreachable');
});

test('leaving happens on click only: an ended session keeps its seat and is no longer polled', { timeout: 30000 }, async (t) => {
  const hub = await startHub(t);
  const [a, b] = [installation(t, hub), installation(t, hub)];
  const made = await linked(a, b);
  const seats = () => hub.members(made.id).filter((m) => m.status === 'active').length;
  assert.equal(seats(), 2);

  // Die Sitzung von B endet (tmux nennt ihren Endpunkt nicht mehr).
  b.store.reconcile(new Map());
  b.hub.sync();
  await until(() => b.hub.status().hubs.length === 0, 'B fragt nicht mehr ab');
  assert.equal(b.store.hubView().length, 1, 'die Mitgliedschaft bleibt stehen');
  assert.equal(b.store.hubView()[0].sessionGone, true);
  assert.equal(seats(), 2, 'kein Austritt von selbst');
  // "Beendet" ist widerruflich: taucht der Endpunkt wieder auf, laeuft alles weiter.
  b.store.reconcile(new Map([['ep_b', 'beta']]));
  b.hub.sync();
  await a.send('ep_a', 'noch da?', 'alpha');
  await until(() => b.store.summary('ep_b').unread === 1, 'Nachricht nach Wiederkehr');

  // Austritt auf Klick: der Platz wird frei, A erfaehrt es mit dem naechsten Stand.
  await b.hub.leave({ key: b.store.hubView()[0].key });
  assert.deepEqual(b.store.hubView(), []);
  assert.equal(seats(), 1);
  await until(() => a.view('ep_a')[0].members.length === 1, 'A sieht den Austritt');
  await assert.rejects(a.send('ep_a', 'hallo?', 'alpha'), (e) => e.code === 'no_recipients');

  // Hub nicht erreichbar: der Austritt scheitert sichtbar und laesst sich nur hier erzwingen.
  hub.server.close();
  hub.server.closeAllConnections();
  await assert.rejects(a.hub.leave({ key: a.store.hubView()[0].key }),
    (e) => e.code === 'hub_unreachable' && e.data.canForce === true);
  assert.equal(a.store.hubView().length, 1);
  await a.hub.leave({ key: a.store.hubView()[0].key, force: true });
  assert.deepEqual(a.store.hubView(), []);
});

test('renewing and withdrawing the invitation; a link deleted on the hub ends locally', { timeout: 30000 }, async (t) => {
  const hub = await startHub(t);
  const [a, b, c] = [installation(t, hub), installation(t, hub), installation(t, hub)];
  const made = await a.hub.create({ endpoint: 'ep_a', name: 'alpha', seats: 3 });
  await b.hub.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  await until(() => a.view('ep_a')[0].requests.length === 1, 'Gesuch');
  // Neue Einladung: die alte gilt nicht mehr, das offene Gesuch dazu ist erledigt.
  const renewed = await a.hub.renewInvite({ endpoint: 'ep_a', linkId: made.id });
  assert.notEqual(renewed.code, made.code);
  const gone = await until(() => { const v = b.view('ep_b')[0]; return v.status === 'ended' && v; }, 'altes Gesuch erledigt');
  assert.equal(gone.ended, 'invite_renewed');
  await assert.rejects(c.hub.join({ endpoint: 'ep_c', name: 'gamma', code: made.code }), (e) => e.code === 'link_unknown');
  await until(() => a.view('ep_a')[0].requests.length === 0, 'Gesuch bei A verschwunden');
  assert.equal(a.view('ep_a')[0].invite.code, renewed.code);

  await a.hub.withdrawInvite({ endpoint: 'ep_a', linkId: made.id });
  assert.equal(a.view('ep_a')[0].invite, null);
  assert.equal(a.view('ep_a')[0].canInvite, true);
  await assert.rejects(c.hub.join({ endpoint: 'ep_c', name: 'gamma', code: renewed.code }), (e) => e.code === 'link_unknown');

  // Der Betreiber loescht die Verbindung: hier steht sie danach als beendet, bis der Nutzer sie entfernt.
  if (REAL_DIR) hub.real.links.admin.deleteLink(made.id);
  else { hub.links.delete(made.id); }
  a.hub.sync();
  await a.hub.renewInvite({ endpoint: 'ep_a', linkId: made.id }).catch(() => {});
  const ended = await until(() => { const v = a.view('ep_a')[0]; return v.status === 'ended' && v; }, 'A bemerkt die Löschung', 15000);
  assert.equal(ended.ended, 'removed');
});

test('two sessions of one installation can sit in the same hub link', { timeout: 30000 }, async (t) => {
  const hub = await startHub(t);
  const a = installation(t, hub);
  const made = await a.hub.create({ endpoint: 'ep_1', name: 'eins' });
  await a.hub.join({ endpoint: 'ep_2', name: 'zwei', code: made.code });
  const req = await until(() => a.view('ep_1')[0].requests[0], 'Gesuch der zweiten Sitzung');
  await a.hub.decide({ endpoint: 'ep_1', linkId: made.id, memberId: req.id, admit: true });
  await until(() => a.view('ep_2')[0].status === 'active', 'zweite Sitzung aktiv');
  assert.equal(a.store.hubView().length, 2);
  assert.equal(a.view('ep_1')[0].id, a.view('ep_2')[0].id);
  await a.hub.send({ key: a.store.target({ endpoint: 'ep_1', linkId: made.id }).key, text: 'von eins', name: 'eins' });
  await until(() => a.store.summary('ep_2').unread === 1, 'Nachricht bei der zweiten Sitzung');
  assert.deepEqual(a.store.summary('ep_1'), { count: 1, unread: 0, pending: 0 });
  assert.deepEqual(a.store.inbox({ endpoint: 'ep_2' }).map((m) => [m.from, m.text]), [['eins', 'von eins']]);
});

test('replayed, re-attributed and undecryptable messages from the hub are dropped', { timeout: 30000, skip: !!REAL_DIR }, async (t) => {
  const hub = await startHub(t);
  const [a, b] = [installation(t, hub), installation(t, hub)];
  const made = await linked(a, b);
  await a.send('ep_a', 'echt', 'alpha');
  await until(() => b.store.summary('ep_b').unread === 1, 'echte Nachricht');
  const link = hub.links.get(made.id);
  const original = link.messages[link.messages.length - 1];
  const inject = (m) => { link.seq += 1; link.messages.push({ ...m, seq: link.seq, sent_at: new Date().toISOString() }); };
  const sender = original.from;
  const other = [...link.members.keys()].find((id) => id !== sender);

  inject({ from: sender, box: original.box });                       // wiedereingespielt
  inject({ from: 'm_ErfundenerAbs', box: original.box });           // anderem Absender zugeschrieben
  inject({ from: sender, box: Buffer.from('kein Chiffrat, nur Text des Hubs').toString('base64url') });
  inject({ from: other, box: original.box });                       // als kaeme es vom Empfaenger selbst
  await a.send('ep_a', 'danach', 'alpha');                           // weckt die Abfrage von B
  await until(() => b.store.history({ endpoint: 'ep_b', full: true }).length === 2, 'zweite echte Nachricht');
  assert.deepEqual(b.store.history({ endpoint: 'ep_b', full: true }).map((m) => m.text), ['echt', 'danach']);
  assert.equal(b.view('ep_b')[0].lost, 2, 'zwei Umschläge ließen sich nicht öffnen');
  assert.equal(b.store.summary('ep_b').unread, 2);
});
