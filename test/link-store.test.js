import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanName, createLinkStore, INVITE_TTL_MS, LinkError, MAX_LINK_BYTES, MAX_MESSAGES, MAX_TEXT_BYTES,
  parseCode, SEND_LIMIT_PER_MINUTE,
} from '../lib/link-store.js';

function tempStore(t, clock = { t: 1_000_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-link-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, clock, store: createLinkStore({ dir, now: () => clock.t }) };
}

const code = (fn, expected) => assert.throws(fn, (err) => err instanceof LinkError && err.code === expected);

test('create, join, send and inbox keep per-member read state', (t) => {
  const { store } = tempStore(t);
  const made = store.create({ endpoint: 'ep_a', name: 'alpha' });
  assert.match(made.code, /^termlink:local\/ln_[\w-]+#[\w-]+$/);
  code(() => store.send({ endpoint: 'ep_a', text: 'hallo' }), 'no_recipients');
  store.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  code(() => store.join({ endpoint: 'ep_b', name: 'beta', code: made.code }), 'already_member');
  code(() => store.join({ endpoint: 'ep_c', name: 'gamma', code: made.code }), 'link_full');

  const sent = store.send({ endpoint: 'ep_a', text: 'Frage 1' });
  assert.deepEqual(sent.recipients, ['beta']);
  store.send({ endpoint: 'ep_a', text: 'Frage 2' });
  assert.deepEqual(store.summary('ep_b'), { count: 1, unread: 2, pending: 2 });
  assert.deepEqual(store.summary('ep_a'), { count: 1, unread: 0, pending: 0 });

  store.markWoken({ endpoint: 'ep_b' });
  assert.deepEqual(store.summary('ep_b'), { count: 1, unread: 2, pending: 0 });
  store.send({ endpoint: 'ep_a', text: 'Frage 3' });
  assert.deepEqual(store.summary('ep_b'), { count: 1, unread: 3, pending: 1 });

  const inbox = store.inbox({ endpoint: 'ep_b' });
  assert.deepEqual(inbox.map((m) => [m.from, m.text]), [['alpha', 'Frage 1'], ['alpha', 'Frage 2'], ['alpha', 'Frage 3']]);
  assert.deepEqual(store.inbox({ endpoint: 'ep_b' }), []);
  assert.deepEqual(store.summary('ep_b'), { count: 1, unread: 0, pending: 0 });

  store.send({ endpoint: 'ep_b', text: 'Antwort' });
  assert.deepEqual(store.inbox({ endpoint: 'ep_a' }).map((m) => m.text), ['Antwort']);
  const view = store.view('ep_a')[0];
  assert.deepEqual(view.members.map((m) => [m.name, m.self]), [['alpha', true], ['beta', false]]);
  assert.equal(view.invite, null); // alle Plaetze vergeben
  assert.equal(view.messages, 4);
});

test('state survives a reload and is written with private permissions', (t) => {
  const { dir, store } = tempStore(t);
  const made = store.create({ endpoint: 'ep_a', name: 'alpha', seats: 3 });
  store.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  store.send({ endpoint: 'ep_a', text: 'bleibt' });
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
  const again = createLinkStore({ dir });
  assert.deepEqual(again.inbox({ endpoint: 'ep_b' }).map((m) => m.text), ['bleibt']);
  // Defekte Datei: leer anfangen statt abstuerzen.
  fs.writeFileSync(path.join(dir, 'state.json'), '{ kaputt');
  assert.deepEqual(createLinkStore({ dir }).view('ep_a'), []);
});

test('invites expire, can be renewed and reject wrong secrets', (t) => {
  const { clock, store } = tempStore(t);
  const made = store.create({ endpoint: 'ep_a', name: 'alpha', seats: 3 });
  const wrong = made.code.replace(/#.*/, '#' + 'x'.repeat(22));
  code(() => store.join({ endpoint: 'ep_b', name: 'beta', code: wrong }), 'code_unknown');
  code(() => store.join({ endpoint: 'ep_b', name: 'beta', code: 'termlink:local/ln_unbekannt99#' + 'x'.repeat(22) }), 'code_unknown');
  clock.t += INVITE_TTL_MS + 1;
  assert.equal(store.view('ep_a')[0].invite.valid, false);
  code(() => store.join({ endpoint: 'ep_b', name: 'beta', code: made.code }), 'invite_expired');
  const renewed = store.renewInvite({ endpoint: 'ep_a', linkId: made.id });
  assert.notEqual(renewed.code, made.code);
  code(() => store.join({ endpoint: 'ep_b', name: 'beta', code: made.code }), 'code_unknown');
  store.join({ endpoint: 'ep_b', name: 'beta', code: renewed.code });
  code(() => store.renewInvite({ endpoint: 'ep_x', linkId: made.id }), 'link_unknown');
});

test('group links fan out, need --link when ambiguous and hide earlier history from late joiners', (t) => {
  const { clock, store } = tempStore(t);
  const group = store.create({ endpoint: 'ep_a', name: 'alpha', seats: 3 });
  store.join({ endpoint: 'ep_b', name: 'beta', code: group.code });
  store.send({ endpoint: 'ep_a', text: 'vor gamma' });
  store.join({ endpoint: 'ep_c', name: 'gamma', code: group.code });
  assert.deepEqual(store.summary('ep_c'), { count: 1, unread: 0, pending: 0 });
  assert.deepEqual(store.send({ endpoint: 'ep_c', text: 'an alle' }).recipients, ['alpha', 'beta']);
  assert.deepEqual(store.history({ endpoint: 'ep_c' }).map((m) => [m.text, m.own]), [['an alle', true]]);
  assert.deepEqual(store.history({ endpoint: 'ep_c', full: true }).map((m) => m.text), ['vor gamma', 'an alle']);

  store.connect({ endpoint: 'ep_a', name: 'alpha', peerEndpoint: 'ep_b', peerName: 'beta' });
  code(() => store.connect({ endpoint: 'ep_b', name: 'beta', peerEndpoint: 'ep_a', peerName: 'alpha' }), 'already_linked');
  code(() => store.connect({ endpoint: 'ep_a', name: 'alpha', peerEndpoint: 'ep_a', peerName: 'alpha' }), 'self_link');
  code(() => store.send({ endpoint: 'ep_a', text: 'wohin?' }), 'link_ambiguous');
  const direct = store.view('ep_a').find((l) => l.seats === 2);
  clock.t += 1000; // das Postfach ordnet verbindungsuebergreifend nach Zeit
  store.send({ endpoint: 'ep_a', linkId: direct.id, text: 'nur beta' });
  assert.deepEqual(store.inbox({ endpoint: 'ep_b' }).map((m) => m.text), ['vor gamma', 'an alle', 'nur beta']);
  code(() => store.send({ endpoint: 'ep_c', linkId: direct.id, text: 'fremd' }), 'link_unknown');
  code(() => store.send({ endpoint: 'ep_z', text: 'x' }), 'not_linked');
});

test('limits: text size, empty text, send rate and history cap', (t) => {
  const { clock, store } = tempStore(t);
  const made = store.create({ endpoint: 'ep_a', name: 'alpha' });
  store.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  code(() => store.send({ endpoint: 'ep_a', text: '   ' }), 'text_missing');
  code(() => store.send({ endpoint: 'ep_a', text: 42 }), 'text_missing');
  code(() => store.send({ endpoint: 'ep_a', text: 'ä'.repeat(MAX_TEXT_BYTES / 2 + 1) }), 'text_too_large');
  store.send({ endpoint: 'ep_a', text: 'ä'.repeat(MAX_TEXT_BYTES / 2) });
  for (let i = 1; i < SEND_LIMIT_PER_MINUTE; i++) store.send({ endpoint: 'ep_a', text: `n${i}` });
  code(() => store.send({ endpoint: 'ep_a', text: 'zu viel' }), 'rate_limited');
  store.send({ endpoint: 'ep_b', text: 'anderes Mitglied darf' });
  clock.t += 61_000;
  store.send({ endpoint: 'ep_a', text: 'wieder frei' });
  for (let round = 0; round < 20; round++) {
    clock.t += 61_000;
    for (let i = 0; i < SEND_LIMIT_PER_MINUTE; i++) store.send({ endpoint: 'ep_a', text: `r${round}-${i}` });
  }
  assert.equal(store.view('ep_a')[0].messages, MAX_MESSAGES);
  // Grosse Texte: der Verlauf bleibt unter der Byte-Grenze, die neueste Nachricht bleibt.
  const big = 'x'.repeat(MAX_TEXT_BYTES);
  for (let round = 0; round < 6; round++) {
    clock.t += 61_000;
    for (let i = 0; i < SEND_LIMIT_PER_MINUTE; i++) store.send({ endpoint: 'ep_a', text: big });
  }
  store.send({ endpoint: 'ep_b', text: 'zuletzt' });
  const kept = store.history({ endpoint: 'ep_a', limit: MAX_MESSAGES, full: true });
  assert.ok(kept.reduce((n, m) => n + Buffer.byteLength(m.text), 0) <= MAX_LINK_BYTES);
  assert.ok(kept.length < MAX_MESSAGES);
  assert.equal(kept.at(-1).text, 'zuletzt');
  code(() => store.create({ endpoint: 'ep_a', name: 'alpha', seats: 9 }), 'seats_invalid');
  code(() => store.create({ endpoint: 'ep_a', name: 'alpha', seats: 1 }), 'seats_invalid');
});

test('reconcile marks vanished endpoints, renames members and drops dead links', (t) => {
  const { store } = tempStore(t);
  const made = store.create({ endpoint: 'ep_a', name: 'alpha' });
  store.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  store.reconcile(new Map([['ep_a', 'alpha neu'], ['ep_b', 'beta']]));
  assert.equal(store.view('ep_b')[0].members[0].name, 'alpha neu');

  store.reconcile(new Map([['ep_a', 'alpha neu']]));
  assert.equal(store.view('ep_a')[0].members[1].gone, true);
  code(() => store.send({ endpoint: 'ep_a', text: 'niemand da' }), 'no_recipients');
  // Ein verschwundener Endpunkt kommt nicht zurueck, auch wenn die Kennung wieder auftaucht.
  store.reconcile(new Map([['ep_a', 'alpha neu'], ['ep_b', 'beta']]));
  assert.equal(store.view('ep_a')[0].members[1].gone, true);

  store.reconcile(new Map());
  assert.deepEqual(store.view('ep_a'), []);
});

test('leaving removes the member and deletes the link once nobody alive remains', (t) => {
  const { store } = tempStore(t);
  const made = store.create({ endpoint: 'ep_a', name: 'alpha' });
  store.join({ endpoint: 'ep_b', name: 'beta', code: made.code });
  store.leave({ endpoint: 'ep_b', linkId: made.id });
  assert.deepEqual(store.view('ep_b'), []);
  assert.equal(store.view('ep_a')[0].members.length, 1);
  code(() => store.leave({ endpoint: 'ep_b', linkId: made.id }), 'link_unknown');
  store.leave({ endpoint: 'ep_a', linkId: made.id });
  assert.deepEqual(store.view('ep_a'), []);
  code(() => store.join({ endpoint: 'ep_c', name: 'gamma', code: made.code }), 'code_unknown');

  // Uebrig bleibt nur ein beendetes Mitglied -> Verbindung faellt beim Trennen weg.
  const two = store.create({ endpoint: 'ep_a', name: 'alpha' });
  store.join({ endpoint: 'ep_b', name: 'beta', code: two.code });
  store.reconcile(new Map([['ep_a', 'alpha']]));
  store.leave({ endpoint: 'ep_a', linkId: two.id });
  assert.equal(store.endpoints().size, 0);
});

test('codes and names are validated', () => {
  code(() => parseCode(''), 'code_missing');
  code(() => parseCode('https://treff.example.org/l/abc#key'), 'code_remote');
  code(() => parseCode('termlink:local/../../etc#aaaaaaaaaaaaaaaaaaaaaa'), 'code_invalid');
  assert.deepEqual(parseCode('  termlink:local/ln_abcdefgh1234#' + 'k'.repeat(22) + ' '),
    { kind: 'local', id: 'ln_abcdefgh1234', token: 'k'.repeat(22) });
  assert.equal(cleanName('  a\u0007b\nc\u2028d  '), 'a b c d');
  assert.equal(cleanName(''), 'Sitzung');
  assert.equal(cleanName('x'.repeat(200)).length, 64);
});
