import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createPeerLookup, findPeerHelper, paneOfProcess, parentPid } from '../lib/peer-pid.js';

const HELPER = findPeerHelper();

async function listen(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-peer-'));
  const sock = path.join(dir, 's.sock');
  const accepted = [];
  const server = net.createServer((c) => accepted.push(c));
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => { for (const c of accepted) c.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const next = async () => { while (!accepted.length) await once(server, 'connection'); return accepted.shift(); };
  return { sock, next };
}

const nonBlocking = (socket) =>
  (Number.parseInt(/flags:\s+(\d+)/.exec(fs.readFileSync(`/proc/self/fdinfo/${socket._handle.fd}`, 'utf8'))[1], 8) & 0o4000) !== 0;

test('the kernel names the process at the other end of the socket', { skip: !HELPER }, async (t) => {
  const { sock, next } = await listen(t);
  const peerOf = createPeerLookup();

  // Fremder Prozess: was er ueber sich behauptet, spielt keine Rolle — es zaehlt seine PID.
  const child = spawn(process.execPath, ['-e',
    `const c = require('net').connect(${JSON.stringify(sock)}); c.on('data', () => {}); c.on('end', () => process.exit(0));`],
  { stdio: 'ignore', env: { ...process.env, TMUX_PANE: '%0' } });
  t.after(() => child.kill());
  const theirs = await next();
  assert.deepEqual(await peerOf(theirs), { pid: child.pid, uid: process.getuid() });
  // Die Abfrage laesst die Verbindung benutzbar: weiter nicht blockierend, Daten kommen an.
  assert.equal(nonBlocking(theirs), true);
  theirs.end('x');
  await once(child, 'exit');

  const own = net.connect(sock);
  t.after(() => own.destroy());
  assert.deepEqual(await peerOf(await next()), { pid: process.pid, uid: process.getuid() });
});

test('perl and python3 each read the same peer', { skip: !HELPER }, async (t) => {
  const { sock, next } = await listen(t);
  const own = net.connect(sock);
  t.after(() => own.destroy());
  const accepted = await next();
  let tried = 0;
  for (const name of ['perl', 'python3']) {
    const real = ['/usr/bin', '/bin', '/usr/local/bin'].map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
    if (!real) continue;
    // Ein Verzeichnis, in dem es nur diesen einen Helfer gibt.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-peer-bin-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.symlinkSync(real, path.join(dir, name));
    const helper = findPeerHelper({ roots: [dir], env: { PATH: '' } });
    assert.equal(helper.bin, path.join(dir, name));
    assert.deepEqual(await createPeerLookup({ helper })(accepted), { pid: process.pid, uid: process.getuid() });
    tried += 1;
  }
  assert.ok(tried >= 1);
});

test('without a helper, on another platform or without a descriptor the lookup fails closed', async () => {
  assert.equal(findPeerHelper({ platform: 'darwin' }), null);
  assert.equal(findPeerHelper({ env: { PATH: '/nirgendwo' }, roots: [] }), null);
  await assert.rejects(createPeerLookup({ helper: null })({ _handle: { fd: 5 } }), /kein Helfer/);
  const lookup = createPeerLookup({ helper: { bin: '/bin/sh', args: ['-c', 'echo "12 34 56"'] } });
  await assert.rejects(lookup({}), /ohne Dateideskriptor/);
  await assert.rejects(lookup({ _handle: { fd: -1 } }), /ohne Dateideskriptor/);
  // Unbrauchbare Ausgabe, Fehlercode oder PID 0 gelten nie als Absender.
  const devnull = fs.openSync('/dev/null', 'r');
  try {
    await assert.rejects(lookup({ _handle: { fd: devnull } }), /nicht bestimmbar/);
    const zero = createPeerLookup({ helper: { bin: '/bin/sh', args: ['-c', 'echo "0 1000"'] } });
    await assert.rejects(zero({ _handle: { fd: devnull } }), /nicht bestimmbar/);
    const failing = createPeerLookup({ helper: { bin: '/bin/sh', args: ['-c', 'echo "12 34"; exit 4'] } });
    await assert.rejects(failing({ _handle: { fd: devnull } }), /nicht bestimmbar/);
    if (HELPER) await assert.rejects(createPeerLookup()({ _handle: { fd: devnull } }), /nicht bestimmbar/);
  } finally {
    fs.closeSync(devnull);
  }
});

test('paneOfProcess finds the innermost pane above a process and nothing outside', () => {
  // 1 -> 100 (tmux) -> 200 (Pane A: Shell) -> 210 (Agent) -> 220 (CLI)
  //                 -> 300 (Pane B: Shell) -> 310 (tmux-Client) ; 400 haengt direkt an 1
  const parents = new Map([[220, 210], [210, 200], [200, 100], [310, 300], [300, 100], [100, 1], [400, 1]]);
  const parentOf = (pid) => parents.get(pid) || 0;
  const panes = new Map([[200, 'A'], [300, 'B']]);
  assert.equal(paneOfProcess(220, panes, parentOf), 'A');
  assert.equal(paneOfProcess(200, panes, parentOf), 'A');
  assert.equal(paneOfProcess(310, panes, parentOf), 'B');
  assert.equal(paneOfProcess(400, panes, parentOf), null);
  assert.equal(paneOfProcess(100, panes, parentOf), null);
  assert.equal(paneOfProcess(999, panes, parentOf), null);
  assert.equal(paneOfProcess(1, new Map([[1, 'init']]), parentOf), null);
  assert.equal(paneOfProcess('220', panes, parentOf), 'A');
  assert.equal(paneOfProcess(NaN, panes, parentOf), null);
  // Verschachtelt gewinnt das innere Pane; ein Kreis endet.
  assert.equal(paneOfProcess(220, new Map([[200, 'A'], [210, 'innen']]), parentOf), 'innen');
  assert.equal(paneOfProcess(5, panes, (pid) => (pid === 5 ? 6 : 5)), null);
});

test('parentPid reads /proc and survives odd process names', { skip: process.platform !== 'linux' }, () => {
  assert.equal(parentPid(process.pid), process.ppid);
  assert.equal(parentPid(0x7ffffff0), 0);
  assert.equal(parentPid('nicht-da'), 0);
});
