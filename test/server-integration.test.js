import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';

async function startServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-server-test-'));
  const repo = path.resolve(import.meta.dirname, '..');
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  for (const file of ['server.js', 'package.json', 'package-lock.json', 'lib']) {
    fs.cpSync(path.join(repo, file), path.join(app, file), { recursive: true });
  }
  fs.mkdirSync(path.join(app, 'deploy'));
  fs.copyFileSync(path.join(repo, 'deploy/backend-paths.json'), path.join(app, 'deploy/backend-paths.json'));
  fs.copyFileSync(path.join(repo, 'deploy/backend-state.mjs'), path.join(app, 'deploy/backend-state.mjs'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(app, 'node_modules'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return listen.apply(this, args);
    };
    await import('./server.js');
  `], { cwd: app, env: { ...process.env, HOME: home, FS_ROOT: home, HOST: '127.0.0.1', PORT: '0', PUBLIC_ORIGIN: 'http://localhost:0', TERM_ALLOW_ORIGINLESS_WS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => errors += data);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill(); await ended;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + errors)), 5000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on('data', data => {
      const match = /TEST_PORT=(\d+)/.exec(String(data));
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { root, app, home, child, base: `http://127.0.0.1:${port}`, errors: () => errors };
}

test('oversized messages and invalid UTF-8 close only their own connection', { timeout: 15000 }, async t => {
  const server = await startServer(t);
  for (const [payload, options, expectedCode] of [
    [Buffer.alloc(1024 * 1024 + 1), { binary: true }, 1009],
    [Buffer.from([0xc0, 0xaf]), { binary: false }, 1007],
  ]) {
    const ws = new WebSocket(server.base.replace('http:', 'ws:') + '/ws', { origin: 'http://localhost:0' });
    ws.on('error', () => {});
    const closed = once(ws, 'close');
    await once(ws, 'open');
    ws.send(payload, options);
    const [code] = await closed;
    assert.ok([expectedCode, 1006].includes(code));
    assert.equal((await fetch(server.base + '/healthz')).status, 200);
    assert.equal(server.child.exitCode, null);
  }
  assert.equal(server.errors().includes("Unhandled 'error'"), false);
});

test('deploy compares lib-only changes and deletions against the running process stamp', { timeout: 15000 }, async t => {
  const server = await startServer(t);
  const before = await (await fetch(server.base + '/api/version')).json();
  const check = pid => spawnSync(process.execPath, [path.join(server.app, 'deploy/backend-state.mjs'), 'changed', String(pid)]).status;
  assert.equal(check(server.child.pid), 0);
  assert.equal(check(0), 2);
  const module = path.join(server.app, 'lib/security.js');
  const source = fs.readFileSync(module);
  fs.appendFileSync(module, '\n// Runtime-only edit\n');
  fs.utimesSync(module, new Date(0), new Date(0));
  assert.equal(check(server.child.pid), 1);
  assert.deepEqual(await (await fetch(server.base + '/api/version')).json(), before);
  fs.writeFileSync(module, source);
  assert.equal(check(server.child.pid), 0);
  fs.unlinkSync(module);
  assert.equal(check(server.child.pid), 1);
});

test('HTTP guards reject CSRF and external symlinks while atomic uploads work', { timeout: 15000 }, async t => {
  const server = await startServer(t);
  assert.equal((await fetch(server.base + '/api/sessions', { method: 'POST' })).status, 403);
  assert.equal((await fetch(server.base + '/%ZZ')).status, 400);
  const { token } = await (await fetch(server.base + '/api/csrf')).json();
  const headers = { 'X-Term-CSRF': token, Origin: 'http://localhost:0' };
  const upload = name => fetch(server.base + '/api/fs/upload?path=&name=' + name, { method: 'POST', headers, body: 'new content' });
  const outside = path.join(server.root, 'outside');
  fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(server.home, 'escape'));
  assert.equal((await upload('escape')).status, 409);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.equal((await upload('normal')).status, 200);
  assert.equal(fs.readFileSync(path.join(server.home, 'normal'), 'utf8'), 'new content');
  assert.equal(fs.statSync(path.join(server.home, 'normal')).mode & 0o777, 0o600);
});
