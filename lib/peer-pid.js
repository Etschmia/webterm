// Wer haengt am anderen Ende eines Unix-Sockets — und in welchem tmux-Pane
// laeuft dieser Prozess?
//
// Der Agenten-Socket (lib/link.js) muss wissen, welche Sitzung fragt. Was der
// Aufrufer dazu selbst mitschickt ($TMUX, $TMUX_PANE), ist nur eine Behauptung:
// jeder Prozess, der den Socket oeffnen kann, koennte die Pane-ID einer anderen
// Sitzung nennen, deren Postfach leeren und unter ihrem Namen senden. Verlaesslich
// ist allein, was der Kernel ueber die Verbindung sagt: die PID des Prozesses,
// der sie aufgebaut hat (SO_PEERCRED). Von dort fuehrt der Prozessbaum zum Pane.
//
// node kann SO_PEERCRED nicht selbst lesen (kein getsockopt, kein FFI). Ein
// winziger Helfer in perl oder python3 bekommt deshalb den Socket als
// Dateideskriptor 3 vererbt und gibt PID und UID aus. Gibt es keinen Helfer oder
// ist das System kein Linux, bleibt der Agenten-Socket AUS (fail-closed) —
// lieber kein Postfach als eines, das der mitgeschickten Pane-ID glaubt.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Deskriptor 3, nicht 0: libuv schaltet vererbte Deskriptoren 0 bis 2 im Kind auf
// blockierend, und dieses Flag gehoert zur gemeinsamen Dateibeschreibung — der
// Socket des Servers wuerde mit blockierend und koennte die Ereignisschleife
// anhalten.
const PEER_FD = 3;

const HELPERS = [
  {
    name: 'perl',
    args: ['-e', 'use Socket qw(SOL_SOCKET SO_PEERCRED);'
      + ` open(my $s, "<&=", ${PEER_FD}) or exit 3;`
      + ' my $c = getsockopt($s, SOL_SOCKET, SO_PEERCRED) or exit 4;'
      + ' my ($pid, $uid) = unpack("i i", $c); print "$pid $uid\\n";'],
  },
  {
    name: 'python3',
    args: ['-c', 'import socket, struct\n'
      + `s = socket.socket(fileno=${PEER_FD})\n`
      + 'c = s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))\n'
      + 'print(*struct.unpack("3i", c)[:2])\n'
      + 's.detach()\n'],
  },
];

const executable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};

// Helfer suchen: erst die ueblichen festen Orte (`roots`), dann der PATH des
// Dienstes. Liefert { bin, args } oder null (kein Linux, weder perl noch python3).
export function findPeerHelper({
  platform = process.platform, env = process.env, roots = ['/usr/bin', '/bin', '/usr/local/bin'],
} = {}) {
  if (platform !== 'linux') return null;
  const dirs = [...roots, ...String(env.PATH || '').split(':').filter((d) => path.isAbsolute(d))];
  for (const helper of HELPERS) {
    for (const dir of dirs) {
      const bin = path.join(dir, helper.name);
      if (executable(bin)) return { bin, args: helper.args };
    }
  }
  return null;
}

// Liefert eine Funktion socket -> Promise<{ pid, uid }> fuer angenommene
// Unix-Socket-Verbindungen. Wirft, wenn sich der Absender nicht bestimmen laesst.
export function createPeerLookup({ helper = findPeerHelper(), timeoutMs = 3000 } = {}) {
  return function peerOf(socket) {
    return new Promise((resolve, reject) => {
      if (!helper) return reject(new Error('kein Helfer für SO_PEERCRED (perl oder python3 unter Linux)'));
      // _handle.fd ist nicht dokumentiert, aber der einzige Weg zum Deskriptor.
      // Das Socket-Objekt selbst als stdio zu uebergeben scheidet aus: node haelt
      // dann dessen Leseseite an.
      const fd = socket && socket._handle ? socket._handle.fd : undefined;
      if (!Number.isInteger(fd) || fd < 0) return reject(new Error('Verbindung ohne Dateideskriptor'));
      let child;
      try {
        child = spawn(helper.bin, helper.args, {
          stdio: ['ignore', 'pipe', 'ignore', fd],
          env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        });
      } catch (err) { return reject(err); }
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (d) => { if (out.length < 64) out += d; });
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('close', (code) => {
        clearTimeout(timer);
        const m = /^(\d{1,10}) (\d{1,10})\n$/.exec(out);
        const pid = m ? Number(m[1]) : 0;
        // PID 0 meldet der Kernel fuer einen Absender ausserhalb des sichtbaren PID-Namensraums.
        if (code !== 0 || !m || pid < 1) return reject(new Error(`Absender nicht bestimmbar (Helfer endete mit ${code})`));
        resolve({ pid, uid: Number(m[2]) });
      });
    });
  };
}

// Eltern-PID eines Prozesses aus /proc/<pid>/stat; 0, wenn es ihn nicht (mehr)
// gibt. Der Prozessname steht dort in Klammern und darf selbst Klammern und
// Leerzeichen enthalten — gezaehlt wird deshalb ab der LETZTEN schliessenden.
export function parentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // state, ppid, …
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : 0;
  } catch { return 0; }
}

// Steigt von `pid` den Prozessbaum hinauf, bis ein Prozess erreicht ist, der
// der erste eines Panes ist (`panes`: Map pane_pid -> beliebiger Wert). Liefert
// den Wert des innersten Panes oder null. PID 1 und alles darueber zaehlt nie.
export function paneOfProcess(pid, panes, parentOf = parentPid) {
  let x = Number(pid);
  for (let i = 0; i < 64 && Number.isInteger(x) && x > 1; i++) {
    if (panes.has(x)) return panes.get(x);
    x = parentOf(x);
  }
  return null;
}
