// Text aus Verbindungen fuer die Ausgabe in ein Terminal entschaerfen.
//
// `term-link inbox` druckt den Text eines FREMDEN Agenten in ein tmux-Pane, an
// dem xterm.js haengt. Steuerzeichen darin wuerde das Terminal ausfuehren:
// Statusabfragen beantwortet xterm.js, indem es auf die Eingabe des Panes
// zurueckschreibt, und OSC 52 erreicht ueber den Clipboard-Passthrough von tmux
// die Zwischenablage. Die Zufallsmarke um jede Nachricht schuetzt nur das
// Modell vor einer gefaelschten Endzeile, nicht das Terminal vor den Bytes.
//
// Deshalb wird jedes C0-/C1-Zeichen sichtbar ersetzt statt entfernt: der
// Agent soll sehen, dass dort etwas stand. Bewusst ohne Abhaengigkeiten —
// bin/term-link.mjs laedt diese Datei bei jedem Aufruf.

// C0 -> "Control Pictures" (U+2400 + Code, ESC wird zu ␛), DEL -> ␡, C1 -> �.
const visible = (ch) => {
  const c = ch.charCodeAt(0);
  if (c < 0x20) return String.fromCharCode(0x2400 + c);
  return c === 0x7f ? '\u2421' : '\ufffd';
};

// Mehrzeiliger Text: Zeilenumbruch und Tabulator bleiben, CRLF wird zu LF. Ein
// einzelnes CR bleibt nicht stehen — es wuerde die Zeile im Terminal ueberschreiben.
export function printable(raw) {
  return String(raw ?? '').replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, visible);
}

// Einzeiliger Wert (Sitzungsname, Kennung): zusaetzlich ohne Umbruch und Tabulator.
export function printableLine(raw) {
  return printable(raw).replace(/[\n\t\u2028\u2029]+/g, ' ');
}
