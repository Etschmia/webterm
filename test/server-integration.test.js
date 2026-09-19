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

test('git log and show endpoints page commits and reject non-hash revisions', { timeout: 15000 }, async t => {
  const server = await startServer(t);
  const repo = path.join(server.home, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).status, 0);
  git('init', '-q', '-b', 'main');
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(repo, 'a.txt'), `line ${n}\n`);
    git('add', 'a.txt');
    git('commit', '-q', '-m', `commit ${n}`);
  }
  const log = await (await fetch(server.base + '/api/fs/git/log?path=repo&limit=2')).json();
  assert.deepEqual(log.commits.map(c => c.subject), ['commit 3', 'commit 2']);
  assert.equal(log.more, true);
  assert.deepEqual(log.unpushed, []);
  assert.match(log.commits[0].refs, /HEAD -> main/);
  const rest = await (await fetch(server.base + '/api/fs/git/log?path=repo&skip=2&limit=2')).json();
  assert.deepEqual(rest.commits.map(c => c.subject), ['commit 1']);
  assert.equal(rest.more, false);

  const show = await (await fetch(server.base + `/api/fs/git/show?path=repo&rev=${log.commits[0].hash}`)).json();
  assert.equal(show.message, 'commit 3');
  assert.match(show.diff, /^diff --git a\/a\.txt b\/a\.txt/);
  assert.match(show.diff, /\n-line 2\n\+line 3\n/);
  assert.equal(show.truncated, false);

  for (const rev of ['HEAD', '--output=x', 'main', 'abc']) {
    assert.equal((await fetch(server.base + '/api/fs/git/show?path=repo&rev=' + encodeURIComponent(rev))).status, 400);
  }
  assert.equal((await fetch(server.base + '/api/fs/git/show?path=repo&rev=' + 'f'.repeat(40))).status, 404);
  assert.equal((await fetch(server.base + '/api/fs/git/log?path=')).status, 404);

  // Historie eines Eintrags: --follow ueber eine Umbenennung, Verzeichnis als Pathspec,
  // Dateinamen mit Pathspec-Magie bleiben woertlich.
  git('mv', 'a.txt', 'b.txt');
  git('commit', '-q', '-m', 'rename');
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', '*.txt'), 'star\n');
  fs.writeFileSync(path.join(repo, 'sub', 'c.txt'), 'c\n');
  git('add', 'sub');
  git('commit', '-q', '-m', 'sub');
  const scoped = p => fetch(server.base + '/api/fs/git/log?scope=1&path=' + encodeURIComponent(p)).then(r => r.json());
  const hist = await scoped('repo/b.txt');
  assert.deepEqual(hist.commits.map(c => c.subject), ['rename', 'commit 3', 'commit 2', 'commit 1']);
  assert.equal(hist.scopePath, 'b.txt');
  const dirHist = await scoped('repo/sub');
  assert.deepEqual(dirHist.commits.map(c => c.subject), ['sub']);
  assert.equal(dirHist.scopePath, 'sub');
  assert.equal((await scoped('repo/sub/*.txt')).scopePath, 'sub/*.txt');
  // show funktioniert auch mit einer Datei als path (cwd = deren Verzeichnis).
  assert.equal((await fetch(server.base + `/api/fs/git/show?path=repo%2Fb.txt&rev=${hist.commits[0].hash}`)).status, 200);

  // Stand gegen HEAD: Arbeitsverzeichnis + staged, auf den Eintrag begrenzt.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'line 3\nnew\n');
  fs.writeFileSync(path.join(repo, 'sub', 'c.txt'), 'changed\n');
  git('add', 'sub/c.txt');
  const work = p => fetch(server.base + '/api/fs/git/diff?path=' + encodeURIComponent(p)).then(r => r.json());
  const fileDiff = await work('repo/b.txt');
  assert.match(fileDiff.diff, /\n\+new\n/);
  assert.doesNotMatch(fileDiff.diff, /c\.txt/);
  assert.match((await work('repo/sub')).diff, /\n\+changed\n/);
  assert.equal((await work('repo/sub/*.txt')).diff, '');
  assert.match((await work('repo')).diff, /b\.txt[\s\S]*c\.txt/);
});
