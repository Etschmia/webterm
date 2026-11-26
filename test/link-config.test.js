import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkKey, createLinkConfig, hubHost, inviteUrl, normalizeHub, parseInvite } from '../lib/link-config.js';

const LINK_CFG_BIN = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'deploy', 'link-config.mjs');

const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

test('hub addresses: https only, no credentials, query or fragment; private hosts are fine', () => {
  assert.equal(normalizeHub(' https://Hub.Example.org/ '), 'https://hub.example.org');
  assert.equal(normalizeHub('https://hub.example.org:8443/vernetzung/'), 'https://hub.example.org:8443/vernetzung');
  assert.equal(normalizeHub('https://192.168.1.20'), 'https://192.168.1.20');
  assert.equal(hubHost('https://hub.example.org:8443/x'), 'hub.example.org:8443');
  for (const bad of ['', 'hub.example.org', 'http://hub.example.org', 'ftp://hub.example.org',
    'https://user:pw@hub.example.org', 'https://hub.example.org/?a=1', 'https://hub.example.org/#x',
    'https://hub.example.org/a b', 'https://hub.example.org/a/../b%2f', 'javascript:alert(1)', 'https://']) {
    assert.throws(() => normalizeHub(bad), (e) => e.status === 400, bad);
  }
  // http nur mit dem Testschalter, und auch dann nur zum eigenen Rechner.
  assert.throws(() => normalizeHub('http://127.0.0.1:3140'));
  assert.equal(normalizeHub('http://127.0.0.1:3140', { insecure: true }), 'http://127.0.0.1:3140');
  assert.throws(() => normalizeHub('http://hub.example.org', { insecure: true }));
});

test('invitation links are split into hub, link id and secret', () => {
  const url = inviteUrl('https://hub.example.org/base', 'ln_abcdefgh1234', SECRET);
  assert.deepEqual(parseInvite(` ${url} `), { hub: 'https://hub.example.org/base', id: 'ln_abcdefgh1234', secret: SECRET });
  for (const bad of ['https://hub.example.org/l/ln_abcdefgh1234', `https://hub.example.org/l/ln_abcdefgh1234#${SECRET.slice(1)}`,
    `http://hub.example.org/l/ln_abcdefgh1234#${SECRET}`, `https://hub.example.org/x/ln_abcdefgh1234#${SECRET}`,
    'termlink:local/ln_abcdefgh1234#0123456789abcdef']) {
    assert.throws(() => parseInvite(bad), (e) => e.status === 400, bad);
  }
  assert.equal(checkKey(` vnk_${'a'.repeat(43)} `), `vnk_${'a'.repeat(43)}`);
  assert.throws(() => checkKey('lmt_' + 'a'.repeat(43)));
});

test('the setting defaults to off, to local for existing links, and is stored with mode 0600', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-link-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let links = false;
  const config = createLinkConfig({ dir, hasLinks: () => links });
  assert.equal(config.get().mode, 'off');
  assert.throws(() => config.set({ mode: 'hub', hub: '', key: '' }), (e) => e.code === 'hub_missing');
  assert.throws(() => config.set({ mode: 'sonstwas' }), (e) => e.code === 'mode_invalid');

  const key = `vnk_${'k'.repeat(40)}`;
  assert.deepEqual(config.set({ mode: 'hub', hub: 'https://hub.example.org', key }),
    { mode: 'hub', hub: 'https://hub.example.org', key, stored: true });
  assert.equal(fs.statSync(config.file).mode & 0o777, 0o600);
  // Eine zweite Instanz (oder install.sh) sieht denselben Stand.
  assert.equal(createLinkConfig({ dir }).get().key, key);

  // Von Hand verdorben: "hub" ohne brauchbare Adresse wird zu "local", nie zu einem Aufruf ins Leere.
  fs.writeFileSync(config.file, JSON.stringify({ mode: 'hub', hub: 'http://unsicher.example', key: 'x' }));
  assert.deepEqual(createLinkConfig({ dir }).get(), { mode: 'local', hub: '', key: '', stored: true });

  fs.rmSync(config.file);
  links = true;
  assert.equal(createLinkConfig({ dir, hasLinks: () => links }).get().mode, 'local');
});

test('deploy/link-config.mjs show reports legacy local links so install.sh does not turn them off', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-link-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const show = () => execFileSync(process.execPath, [LINK_CFG_BIN, '--dir', dir, 'show'], { encoding: 'utf8' });
  assert.equal(show(), 'none\t\t\n');

  // Bestand: state.json mit Verbindung, aber noch keine config.json.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    links: { ln_bestand00: { id: 'ln_bestand00', kind: 'local', createdAt: 1, seats: 2, seq: 0, invite: null, members: [], messages: [] } },
  }), { mode: 0o600 });
  assert.equal(show(), 'local\t\t\n');
});
