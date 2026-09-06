import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

let caddy = false;
try { execFileSync('caddy', ['version'], { stdio: 'ignore' }); caddy = true; } catch {}

test('Caddy headers survive auth errors and preserve upstream sandbox CSP', { skip: !caddy, timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-caddy-test-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/sandbox') res.setHeader('Content-Security-Policy', 'sandbox');
    res.end('ok');
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const headers = execFileSync('bash', ['-c', '. deploy/lib-caddy-security.sh; term_security_headers'], { encoding: 'utf8' });
  const directive = execFileSync('bash', ['-c', '. deploy/lib-caddy-auth.sh; caddy_basicauth_directive'], { encoding: 'utf8' });
  const hash = execFileSync('caddy', ['hash-password'], { input: 'test-only\ntest-only\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  const config = path.join(root, 'Caddyfile');
  fs.writeFileSync(config, `{
 admin off
 auto_https off
}
http://127.0.0.1:${port} {
${headers}
 ${directive} {
  test ${hash}
 }
 respond /denied "Forbidden" 403
 reverse_proxy 127.0.0.1:${upstream.address().port}
}
`);
  const child = spawn('caddy', ['run', '--config', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', d => log += d);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base); await r.text(); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(ready, log);
  for (const [url, auth, status] of [['/', false, 401], ['/', true, 200], ['/denied', true, 403], ['/sandbox', true, 200]]) {
    const r = await fetch(base + url, { headers: auth ? { Authorization: 'Basic ' + Buffer.from('test:test-only').toString('base64') } : {} });
    assert.equal(r.status, status);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.ok(r.headers.get('content-security-policy'));
    if (url === '/sandbox') assert.ok(r.headers.get('content-security-policy').split(',').map(s => s.trim()).includes('sandbox'));
    if (!auth) assert.match(r.headers.get('www-authenticate'), /Basic/);
    await r.text();
  }
});
