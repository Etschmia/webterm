import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityModelFromPane, antigravityStatusFromTail } from '../lib/antigravity-model.js';

const pad = ' '.repeat(60);

test('antigravity: Fusszeile liefert Modell und Effort', () => {
  const tail = `>\n${'─'.repeat(40)}\n? for shortcuts${pad}auto · Gemini 4 Neon · high\n\n`;
  assert.deepEqual(antigravityModelFromPane(tail), { model: 'Gemini 4 Neon', effort: 'high' });
});

test('antigravity: Fusszeile ohne linken Hinweistext', () => {
  assert.deepEqual(
    antigravityModelFromPane(`${pad}auto · Gemini 4 Neon · low`),
    { model: 'Gemini 4 Neon', effort: 'low' },
  );
});

test('antigravity: nur die letzte nichtleere Zeile zaehlt', () => {
  const tail = `? for shortcuts${pad}auto · Gemini 4 Neon · high\nirgendeine Ausgabe\n`;
  assert.equal(antigravityModelFromPane(tail), null);
});

test('antigravity: fremde oder unvollstaendige Zeilen liefern nichts', () => {
  assert.equal(antigravityModelFromPane(''), null);
  assert.equal(antigravityModelFromPane(null), null);
  assert.equal(antigravityModelFromPane(`? for shortcuts${pad}auto · Gemini 4 Neon`), null);
  assert.equal(antigravityModelFromPane(`? for shortcuts${pad}auto · Gemini 4 Neon · schnell`), null);
  // Fliesstext mit Mittelpunkten: das erste Feld haengt nicht am Zeilenanfang
  // oder hinter einer Luecke.
  assert.equal(antigravityModelFromPane('Tests gruen · Build fertig · high'), null);
});

test('antigravity: Status aus dem Pane-Rand', () => {
  const footer = `? for shortcuts${pad}auto · Gemini 4 Neon · high`;
  assert.equal(antigravityStatusFromTail(`>\n${footer}`), 'idle');
  assert.equal(antigravityStatusFromTail(`Generating… (12s · esc to cancel)\n${footer}`), 'working');
  assert.equal(antigravityStatusFromTail(`Thinking… (esc to cancel)\n${footer}`), 'working');
  assert.equal(antigravityStatusFromTail(`Run this command?\n> Yes, allow tool call\n  No, deny permission\nesc to cancel`), 'blocked');
  assert.equal(antigravityStatusFromTail(`  Yes, and always allow 'npm test' (Persist to settings)`), 'blocked');
  // Dialog-Fusszeile allein ist kein "arbeitet".
  assert.equal(antigravityStatusFromTail('esc to cancel'), 'idle');
  assert.equal(antigravityStatusFromTail(''), 'idle');
});
