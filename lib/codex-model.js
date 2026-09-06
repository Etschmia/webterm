import fs from 'node:fs';
import path from 'node:path';

// Nur die aktuelle Fusszeile lesen, keine Modellnamen aus Antworten, dem
// Startbanner oder dem Scrollback. Der vollstaendige Pfad muss zum Pane passen.
export function codexModelFromPane(tail, cwd, home) {
  const footer = String(tail || '').trimEnd().split('\n').pop();
  const match = /^\s*([a-zA-Z0-9][\w./:-]*)\s+(none|minimal|low|medium|high|xhigh|max|ultra)\s+·\s+([^·]+?)(?:\s+·.*)?\s*$/.exec(footer);
  if (!match) return null;
  let dir = match[3].trim();
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/')) dir = path.join(home, dir.slice(2));
  if (!path.isAbsolute(dir) || path.normalize(dir) !== path.normalize(cwd)) return null;
  return { model: match[1], effort: match[2] };
}

// Ein altes Rollout im selben cwd gehoert nicht zwingend zu diesem Prozess
// (neuer CLI-Start, Desktop, Subagent). Nur eine eindeutig geoeffnete Datei
// verwenden; bei App-Servern mit mehreren Rollouts bewusst nichts raten.
export function codexRolloutForPid(pid, procRoot = '/proc') {
  if (!/^\d+$/.test(String(pid))) return '';
  const dir = path.join(procRoot, String(pid), 'fd');
  try {
    const files = new Set();
    for (const fd of fs.readdirSync(dir)) {
      let file;
      try { file = fs.readlinkSync(path.join(dir, fd)); } catch { continue; }
      if (path.isAbsolute(file) && /^rollout-.+\.jsonl$/.test(path.basename(file))) files.add(file);
    }
    return files.size === 1 ? [...files][0] : '';
  } catch {
    return '';
  }
}
