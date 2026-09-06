import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { restartRisks } from '../lib/restart-safety.js';

try {
  const group = process.argv[2];
  let panes = [];
  try {
    panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean);
  } catch (error) {
    if (!/no server running|No such file or directory/.test(String(error.stderr))) throw error;
  }
  const serverPid = panes.length ? execFileSync('tmux', ['display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim() : '';
  const records = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  const processes = records.trim().split('\n').map(line => {
    const [, pid, ppid, comm] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    let groups = [];
    try { groups = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').map(line => line.split(':').slice(2).join(':')); }
    catch { /* Unbekannte tmux-Prozessgruppen werden unten abgewiesen. */ }
    return { pid, ppid, comm, groups };
  });
  // Auch Server auf benannten/custom Sockets pruefen, nicht nur den aktuellen.
  panes.push(...processes.filter(p => p.comm === 'tmux: server').map(p => p.pid));
  const risks = restartRisks(group, processes, panes, serverPid);
  if (risks.length) {
    console.error(`Restart abgebrochen: ${risks.length} tmux-Prozess(e) liegen in ${group}.`);
    console.error('Sessions zuerst ausserhalb der Webterminal-Unit betreiben bzw. nach gesicherter Arbeit beenden.');
    process.exit(5);
  }
  console.log('Restart-Pruefung: tmux und alle Pane-Prozesse liegen ausserhalb der Service-Gruppe.');
} catch (error) {
  console.error('Restart-Sicherheit konnte nicht nachgewiesen werden:', error.message);
  process.exit(5);
}
