import assert from 'node:assert/strict';
import test from 'node:test';
import { runSessionPrompt } from '../lib/telegram-session.js';

test('timeouts, API errors and missing sessions never repeat a potentially executed order', async () => {
  for (const err of ['Zeitueberschreitung', 'API error 529', 'Session not found']) {
    let calls = 0, saved = 'existing';
    const result = await runSessionPrompt('perform an action', {
      sessionId: saved,
      async run(prompt, options) {
        calls++;
        assert.equal(options.resume, 'existing');
        return { ok: false, err };
      },
      saveSession(id) { saved = id; },
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.equal(saved, 'existing');
  }
});

test('successful first request persists the returned session for follow-up requests', async () => {
  let saved;
  await runSessionPrompt('hello', {
    async run(prompt, options) {
      assert.equal(options.resume, undefined);
      return { ok: true, sessionId: 'new-session' };
    },
    saveSession(id) { saved = id; },
  });
  assert.equal(saved, 'new-session');
});
