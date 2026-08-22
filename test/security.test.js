import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalOrigin, isLoopbackHost, isPathInside, terminalSize, validCsrfRequest,
} from '../lib/security.js';

test('only explicit loopback hosts pass the safe bind check', () => {
  for (const host of ['localhost', '127.0.0.1', '127.12.3.4', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', 'example.com', '192.168.1.2']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('origins are canonical and cannot contain paths', () => {
  assert.equal(canonicalOrigin('https://term.example.test'), 'https://term.example.test');
  assert.equal(canonicalOrigin('https://term.example.test/'), 'https://term.example.test');
  assert.equal(canonicalOrigin('https://term.example.test/path'), null);
  assert.equal(canonicalOrigin('javascript:alert(1)'), null);
});

test('real paths outside the configured root are rejected', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'term-security-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'escape'));

  const rootReal = fs.realpathSync(root);
  assert.equal(isPathInside(rootReal, fs.realpathSync(path.join(root, 'escape'))), false);
  assert.equal(isPathInside(rootReal, path.join(rootReal, 'inside')), true);
});

test('terminal dimensions are bounded and typed', () => {
  assert.deepEqual(terminalSize(120, 40), { cols: 120, rows: 40 });
  assert.deepEqual(terminalSize('500', '200'), { cols: 500, rows: 200 });
  assert.deepEqual(terminalSize(100000, -1), { cols: 80, rows: 24 });
  assert.deepEqual(terminalSize('x', null), { cols: 80, rows: 24 });
});

test('state changes require both the token and an allowed browser origin', () => {
  const allowed = new Set(['https://term.example.test']);
  assert.equal(validCsrfRequest({
    'x-term-csrf': 'secret', origin: 'https://term.example.test',
  }, 'secret', allowed), true);
  assert.equal(validCsrfRequest({
    'x-term-csrf': 'wrong', origin: 'https://term.example.test',
  }, 'secret', allowed), false);
  assert.equal(validCsrfRequest({
    'x-term-csrf': 'secret', origin: 'https://evil.example.test',
  }, 'secret', allowed), false);
  assert.equal(validCsrfRequest({ 'x-term-csrf': 'secret' }, 'secret', allowed), true);
});
