import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const library = path.join(repo, 'deploy/lib-ip-allowlist.sh');
const normalize = value => spawnSync('bash', ['-c', '. "$1"; normalize_ip_allowlist "$2"', 'test', library, value], { encoding: 'utf8' });

test('optional allowlist accepts IPv4, IPv6 and VPN CIDRs without defaults', () => {
  assert.equal(normalize('').stdout, '');
  const result = normalize('203.0.113.7, 10.8.0.0/24, fd00:1234::/64, 203.0.113.7');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '203.0.113.7 10.8.0.0/24 fd00:1234::/64');
  for (const value of ['999.2.3.4', '1.2.3.4/33', 'fd00::/129', '1.2.3.4/', '1.2.3.4/24/1', 'fe80::1%eth0', '127.0.0.1; respond 200']) {
    assert.equal(normalize(value).status, 2, value);
  }
});

function setup(t, answers, args = ['--ip-only']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-net-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deploy = path.join(root, 'deploy');
  fs.mkdirSync(deploy);
  for (const file of ['setup-auth', 'lib-caddy-auth.sh', 'lib-ip-allowlist.sh']) {
    fs.copyFileSync(path.join(repo, 'deploy', file), path.join(deploy, file));
  }
  fs.writeFileSync(path.join(root, '.env'), 'PUBLIC_ORIGIN=https://term.example.test\nPORT=7681\n');
  // Dialogeingaben ohne echtes Terminal; Produktionsdateien bleiben unberuehrt.
  fs.writeFileSync(path.join(deploy, 'lib-ask.sh'), `
    info(){ :; }; ok(){ :; }; note(){ :; }; warn(){ :; }; err(){ :; }; step(){ :; }
    ask_value(){
      local answer
      IFS= read -r answer < "$ANSWERS_FILE" || answer=""
      sed -i '1d' "$ANSWERS_FILE"
      printf '%s' "\${answer:-\${2:-}}"
    }
    ask_yes_no(){ local answer; answer="$(ask_value "$1" "\${2:-n}")"; [ "$answer" = y ]; }
  `);
  const input = path.join(root, 'answers');
  fs.writeFileSync(input, answers.join('\n') + '\n');
  const result = spawnSync('bash', [path.join(deploy, 'setup-auth'), ...args], { env: { ...process.env, ANSWERS_FILE: input }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(deploy, 'term.example.test.auth.local.caddy');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

test('IP-only retrofit preserves authentication and limits a subpath filter to that application', t => {
  const snippet = setup(t, ['y', '/term', '2', '10.8.0.0/24, fd00::/64']);
  assert.match(snippet, /Bestehende Anmeldung unveraendert/);
  assert.match(snippet, /path \/term \/term\/\*/);
  assert.match(snippet, /not remote_ip 10\.8\.0\.0\/24 fd00::\/64/);
  assert.doesNotMatch(snippet, /^\s*(basic_auth|basicauth|forward_auth)\s*\{/m);
});

test('retrofit keeps everything by default; removal only describes the chosen network rule', t => {
  assert.equal(setup(t, ['n', 'n', '1'], []), null);
  assert.equal(setup(t, ['n', '2', '']), null);
  const snippet = setup(t, ['n', '3']);
  assert.match(snippet, /NETZREGELN ENTFERNEN/);
  assert.match(snippet, /Bestehende Anmeldung unveraendert/);
  assert.doesNotMatch(snippet, /^\s*(respond|basic_auth|forward_auth)\b/m);
});

test('generated IPv4/IPv6 VPN filter is accepted by Caddy', t => {
  try { execFileSync('caddy', ['version'], { stdio: 'ignore' }); } catch { t.skip('Caddy not installed'); return; }
  const snippet = setup(t, ['y', '/term', '2', '10.8.0.0/24, fd00::/64']);
  const result = spawnSync('caddy', ['adapt', '--config', '-', '--adapter', 'caddyfile'], {
    input: `http://127.0.0.1:18999 {\n${snippet}\nrespond "ok"\n}\n`, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /10\.8\.0\.0\/24/);
});
