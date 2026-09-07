import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { opencodeMessageFiles, opencodeModelFromFiles } from '../lib/opencode-model.js';

const cwd = '/home/test/term';

function makeStorage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-opencode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'storage');
}

function writeSession(storage, project, id, directory) {
  const dir = path.join(storage, 'session', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, directory, time: { created: 1, updated: 2 } }));
}

function writeMsg(storage, sessionId, name, obj, mtimeMs) {
  const dir = path.join(storage, 'message', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  const d = new Date(mtimeMs);
  fs.utimesSync(file, d, d);
  return file;
}

function assistant(model, created = 10) {
  return { role: 'assistant', modelID: model, providerID: 'prov', time: { created, completed: created + 1 } };
}

test('newest assistant message of the matching cwd wins, other cwds are ignored', (t) => {
  const storage = makeStorage(t);
  writeSession(storage, 'proj1', 'ses_AAA', cwd);
  writeSession(storage, 'proj1', 'ses_BBB', cwd);
  writeSession(storage, 'proj2', 'ses_OTHER', '/home/test/elsewhere');
  const old = writeMsg(storage, 'ses_AAA', 'msg_001.json', assistant('qwen3-coder'), 100);
  const fresh = writeMsg(storage, 'ses_BBB', 'msg_002.json', assistant('claude-4-5-sonnet'), 200);
  writeMsg(storage, 'ses_OTHER', 'msg_003.json', assistant('must-not-appear'), 300);
  // User-Nachricht ohne Modell und Record ohne modelID werden uebersprungen.
  writeMsg(storage, 'ses_BBB', 'msg_004.json', { role: 'user', time: { created: 400 } }, 400);
  writeMsg(storage, 'ses_BBB', 'msg_005.json', { role: 'assistant', time: { created: 500 } }, 500);

  const files = opencodeMessageFiles(storage, cwd);
  assert.deepEqual(files, [path.join(storage, 'message', 'ses_BBB', 'msg_005.json'),
    path.join(storage, 'message', 'ses_BBB', 'msg_004.json'), fresh, old]);
  assert.deepEqual(opencodeModelFromFiles(files), { model: 'claude-4-5-sonnet', effort: '' });
});

test('missing storage, foreign sessions and broken files yield nothing, never throw', (t) => {
  const storage = makeStorage(t);
  assert.deepEqual(opencodeMessageFiles(storage, cwd), []);
  assert.equal(opencodeModelFromFiles([]), null);
  assert.equal(opencodeModelFromFiles(null), null);
  writeSession(storage, 'proj1', 'ses_AAA', '/somewhere/else');
  assert.deepEqual(opencodeMessageFiles(storage, cwd), []);
  // Kaputte JSON und Pfadwanderer aus dem Dateiinhalt werden ignoriert.
  const dir = path.join(storage, 'session', 'proj1');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{kein json');
  fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify({ id: '../evil', directory: cwd }));
  writeSession(storage, 'proj1', 'ses_OK', cwd); // ohne Nachrichten
  assert.deepEqual(opencodeMessageFiles(storage, cwd), []);
  const msgDir = path.join(storage, 'message', 'ses_OK');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(path.join(msgDir, 'msg_x.json'), '{kaputt');
  assert.equal(opencodeModelFromFiles(opencodeMessageFiles(storage, cwd)), null);
});
