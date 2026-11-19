import assert from 'node:assert/strict';
import test from 'node:test';
import { printable, printableLine } from '../lib/link-text.js';

test('printable neutralises terminal control characters but keeps line breaks and tabs', () => {
  // Statusabfrage (DSR), OSC 52 mit BEL, 8-Bit-CSI: nichts davon darf als Steuerzeichen ankommen.
  const hostile = 'a\u001b[5n\u001b]52;c;QUJD\u0007b\u009b6n\u0000\u007f';
  const out = printable(hostile);
  assert.equal(out, 'a\u241b[5n\u241b]52;c;QUJD\u2407b\ufffd6n\u2400\u2421');
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out), false);

  assert.equal(printable('Zeile 1\nZeile 2\tSpalte'), 'Zeile 1\nZeile 2\tSpalte');
  assert.equal(printable('dos\r\nende'), 'dos\nende');
  // Ein einzelnes CR wuerde die Zeile ueberschreiben (z. B. eine vorgetaeuschte Marke).
  assert.equal(printable('sichtbar\rversteckt'), 'sichtbar\u240dversteckt');
  assert.equal(printable('Umlaute äöü „“ 🙂 bleiben'), 'Umlaute äöü „“ 🙂 bleiben');
  assert.equal(printable(undefined), '');
  assert.equal(printable(42), '42');
});

test('printableLine additionally removes line breaks and tabs', () => {
  assert.equal(printableLine('name\nmit\tumbruch\u2028x'), 'name mit umbruch x');
  assert.equal(printableLine('x\u001b[2Jy'), 'x\u241b[2Jy');
});
