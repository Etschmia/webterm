// Ein Auftrag wird genau einmal gestartet. Auch ein fehlgeschlagener Lauf kann
// bereits Werkzeuge ausgefuehrt haben; ein Neustart ohne Verlauf waere unsicher.
export async function runSessionPrompt(prompt, { sessionId, run, saveSession }) {
  const result = await run(prompt, { resume: sessionId || undefined });
  if (result.ok && result.sessionId && result.sessionId !== sessionId) {
    saveSession(result.sessionId);
  }
  return result;
}
