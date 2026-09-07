import fs from 'node:fs';
import path from 'node:path';

// opencode (sst/opencode) legt seinen Sitzungszustand unter
// ~/.local/share/opencode/storage ab:
//
//   storage/session/<projectID>/ses_*.json  -> { id, directory, time }
//   storage/message/<sessionID>/msg_*.json  -> Nachrichten; Assistant-
//      Nachrichten tragen `modelID` (+ `providerID`), `path.cwd` und
//      `time.created/completed`.
//
// Angezeigt wird das Modell der juengsten Assistant-Nachricht aller
// Sitzungen, deren `directory` exakt dem Prozess-cwd entspricht — dieselbe
// cwd-Zuordnung wie bei grok/kimi (keine PID-Registry), also mit demselben
// Mehrdeutigkeits-Riegel in listSessions(). Einen Effort kennt opencode
// nicht.

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Alle Nachrichten-Dateien der zum cwd gehoerenden Sitzungen, NEUESTE ZUERST
// (sortiert nach mtime; der Nachrichten-Zeitstempel steht erst im Inhalt).
export function opencodeMessageFiles(storageRoot, cwd) {
  let projects;
  try { projects = fs.readdirSync(path.join(storageRoot, 'session')); } catch { return []; }
  const found = [];
  for (const proj of projects) {
    let files;
    try { files = fs.readdirSync(path.join(storageRoot, 'session', proj)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const s = readJson(path.join(storageRoot, 'session', proj, f));
      if (!s || s.directory !== cwd || typeof s.id !== 'string' || !s.id) continue;
      // Die Session-ID kommt aus dem DateiINHALT und wird zum Pfad — gegen
      // Pfadwandern ('..', Separatoren) pruefen.
      if (s.id === '.' || s.id === '..' || s.id.includes('/') || s.id.includes('\\')) continue;
      let msgs;
      try { msgs = fs.readdirSync(path.join(storageRoot, 'message', s.id)); } catch { continue; }
      for (const mf of msgs) {
        if (!mf.startsWith('msg_') || !mf.endsWith('.json')) continue;
        const file = path.join(storageRoot, 'message', s.id, mf);
        let t = 0;
        try { t = fs.statSync(file).mtimeMs; } catch { continue; }
        found.push({ file, t });
      }
    }
  }
  found.sort((a, b) => b.t - a.t);
  return found.map((e) => e.file);
}

// Modell aus der juengsten Assistant-Nachricht mit modelID. User-Nachrichten
// und Records ohne Modell werden uebersprungen.
export function opencodeModelFromFiles(files) {
  for (const file of files || []) {
    const m = readJson(file);
    if (m && m.role === 'assistant' && m.modelID) return { model: String(m.modelID), effort: '' };
  }
  return null;
}
