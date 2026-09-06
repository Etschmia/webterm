// Prueft alle tmux-Panes und deren Nachfahren, unabhaengig vom Agent-Namen.
export function restartRisks(controlGroup, processes, panePids, serverPid) {
  if (!controlGroup || controlGroup === '/' || !controlGroup.startsWith('/')) {
    throw new Error('Service-ControlGroup fehlt oder ist ungueltig');
  }
  const byPid = new Map(processes.map(p => [String(p.pid), p]));
  const roots = new Set([...panePids, serverPid].filter(Boolean).map(String));
  for (const pid of roots) {
    if (!byPid.get(pid)?.groups?.length) throw new Error(`Prozessgruppe fuer tmux-PID ${pid} unbekannt`);
  }
  const inside = group => group === controlGroup || group.startsWith(controlGroup + '/');
  return processes.filter(p => {
    let pid = String(p.pid);
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (roots.has(pid)) return !p.groups?.length || p.groups.some(inside);
      seen.add(pid);
      pid = String(byPid.get(pid)?.ppid || '');
    }
    return false;
  });
}
