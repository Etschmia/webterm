import assert from 'node:assert/strict';
import test from 'node:test';
import { restartRisks } from '../lib/restart-safety.js';

const service = '/system.slice/term.service';
const proc = (pid, ppid, group) => ({ pid, ppid, groups: group ? [group] : [] });

test('any endangered pane or descendant blocks restart, regardless of agent or window', () => {
  const records = [proc(1, 0, '/tmux'), proc(2, 1, '/tmux'), proc(3, 1, service), proc(4, 2, service + '/agent')];
  assert.deepEqual(restartRisks(service, records, [2, 3], 1).map(p => p.pid), [3, 4]);
});
test('endangered tmux server blocks restart even when its panes migrated elsewhere', () => {
  assert.equal(restartRisks(service, [proc(1, 0, service), proc(2, 1, '/other')], [2], 1).length, 1);
});
test('independent tmux sessions survive; similarly named services are not confused', () => {
  assert.deepEqual(restartRisks(service, [proc(1, 0, service + '-other'), proc(2, 1, '/tmux')], [2], 1), []);
});
test('unknown cgroups and missing pane PIDs fail closed', () => {
  assert.throws(() => restartRisks('', [], [], ''), /ControlGroup/);
  assert.throws(() => restartRisks(service, [proc(1, 0, null)], [], 1), /unbekannt/);
  assert.throws(() => restartRisks(service, [], [2], 1), /unbekannt/);
});
