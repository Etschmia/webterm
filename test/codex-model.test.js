import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexModelFromPane, codexRolloutForPid } from '../lib/codex-model.js';

const home = '/home/test';
const cwd = `${home}/term`;

test('Codex footer reports the current model and effort, including before the first turn', () => {
  const pane = 'model: gpt-5.6-sol medium\n› Ask Codex to do anything\n\n  gpt-6-astra high · ~/term · ← for agents\n\n';
  assert.deepEqual(codexModelFromPane(pane, cwd, home), { model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(codexModelFromPane('  gpt-6-astra xhigh · /home/test/term', cwd, home), {
    model: 'gpt-6-astra', effort: 'xhigh',
  });
  assert.deepEqual(codexModelFromPane('  gpt-6-astra low · ~', home, home), {
    model: 'gpt-6-astra', effort: 'low',
  });
});

test('model switches replace both model and effort', () => {
  for (const [model, effort] of [['gpt-5.6-sol', 'medium'], ['gpt-6-astra', 'high']]) {
    assert.deepEqual(codexModelFromPane(`  ${model} ${effort} · ~/term`, cwd, home), { model, effort });
  }
});

test('banners, quoted output, hidden footers and mismatched or truncated paths are rejected', () => {
  for (const pane of [
    '', 'model: gpt-6-astra high',
    '  gpt-5.6-sol medium · ~/term\n› Continue',
    '› gpt-6-astra high · ~/term',
    '  gpt-6-astra high · ~/other',
    '  gpt-6-astra high · ~/ter…',
    '  gpt-6-astra high · term',
    '  gpt-6-astra high ·',
  ]) assert.equal(codexModelFromPane(pane, cwd, home), null, pane);
});

test('rollout fallback uses only a unique open file of the selected process', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fdDir = path.join(root, '123', 'fd');
  fs.mkdirSync(fdDir, { recursive: true });
  // Merely existing on disk, even under the same cwd, is insufficient.
  const stale = path.join(root, 'rollout-old.jsonl');
  fs.writeFileSync(stale, '{"model":"gpt-5.6-sol"}\n');
  assert.equal(codexRolloutForPid(123, root), '');
  fs.symlinkSync('/tmp/rollout-current.jsonl', path.join(fdDir, '10'));
  fs.symlinkSync('/tmp/rollout-current.jsonl', path.join(fdDir, '11'));
  fs.symlinkSync('socket:[1234]', path.join(fdDir, '12'));
  assert.equal(codexRolloutForPid(123, root), '/tmp/rollout-current.jsonl');
  assert.equal(codexRolloutForPid(456, root), '');
  assert.equal(codexRolloutForPid('../123', root), '');
  fs.symlinkSync(stale, path.join(fdDir, '13'));
  assert.equal(codexRolloutForPid(123, root), '');
});
