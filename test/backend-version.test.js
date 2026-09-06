import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backendVersion } from '../lib/backend-version.js';

test('runtime-only edits, additions and deletions change the version; frontend-only edits do not', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'deploy'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.copyFileSync(new URL('../deploy/backend-paths.json', import.meta.url), path.join(root, 'deploy/backend-paths.json'));
  fs.writeFileSync(path.join(root, 'server.js'), '// server');
  const initial = backendVersion(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'docs');
  assert.equal(backendVersion(root), initial);
  const module = path.join(root, 'lib/security.js');
  fs.writeFileSync(module, '// initial');
  const added = backendVersion(root);
  assert.notEqual(added, initial);
  fs.writeFileSync(module, '// changed');
  fs.utimesSync(module, new Date(0), new Date(0));
  assert.notEqual(backendVersion(root), added);
  fs.unlinkSync(module);
  assert.equal(backendVersion(root), initial);
});
