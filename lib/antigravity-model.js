// Antigravity-CLI (`agy`) legt seinen Sitzungszustand unter
// ~/.gemini/antigravity-cli als SQLite/Protobuf ab — ohne PID-Registry und
// ohne lesbares Modellfeld. Einzige brauchbare Quelle ist die Fusszeile, die
// agy dauerhaft rechtsbuendig in die letzte Zeile schreibt:
//
//     ? for shortcuts                          auto · Gemini 4 Neon · high
//
// also `<modus> · <modell> · <effort>`. Gelesen wird nur die letzte nichtleere
// Zeile des Panes und nur in genau dieser Form (drei Felder, bekannter
// Effort). Modellnamen aus Antworten, dem Startbanner oder dem Scrollback
// zaehlen nicht; passt die Zeile nicht, bleibt der Chip leer.
const EFFORTS = 'none|minimal|low|medium|high|xhigh|max|ultra';
const FOOTER_RE = new RegExp(
  `(?:^|\\s{2,})([a-z][a-z-]*)\\s+·\\s+([^·]+?)\\s+·\\s+(${EFFORTS})\\s*$`,
);

export function antigravityModelFromPane(tail) {
  const footer = String(tail || '').trimEnd().split('\n').pop();
  const match = FOOTER_RE.exec(footer);
  if (!match) return null;
  const model = match[2].trim();
  // Ein Modellname beginnt mit einem Buchstaben und ist kurz; alles andere
  // ist eine fremde Zeile, die zufaellig zwei Mittelpunkte enthaelt.
  if (!/^[A-Za-z][\w .:/()-]{1,39}$/.test(model)) return null;
  return { model, effort: match[3] };
}

// Ampel-Status aus dem unteren Pane-Rand. Die Texte stammen aus dem
// agy-Binary; ein Freigabe-Dialog liess sich beim Einbau nicht live beobachten.
export function antigravityStatusFromTail(tail) {
  const text = String(tail || '');
  // Freigabe: die Auswahlzeilen heissen immer "Yes, allow …" / "Yes, and
  // always …" / "Yes, accept this change" / "No, deny …" — die Fragen selbst
  // ("Run this command?", "Allow calling this tool?") wechseln.
  if (/\bYes, (allow|and always|and use|accept)\b/.test(text) || /\bNo, deny\b/.test(text)) {
    return 'blocked';
  }
  // Arbeitet: "<Taetigkeit>… (12s · esc to cancel)" bzw. "… (esc to cancel)".
  // Das blosse "esc to cancel" eines Dialogs zaehlt nicht.
  if (/…\s*\((?:[^)\n]*·\s*)?esc to cancel\)/i.test(text)) return 'working';
  return 'idle';
}
