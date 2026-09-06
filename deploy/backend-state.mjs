import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendFiles, backendVersion } from '../lib/backend-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, pid] = process.argv.slice(2);
if (mode === 'paths') {
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'deploy/backend-paths.json'), 'utf8'));
  process.stdout.write(['deploy/backend-paths.json', ...entries].join('\n') + '\n');
} else if (mode === 'files') {
  process.stdout.write(backendFiles(root).join('\n') + '\n');
} else if (mode === 'changed') {
  // PID bindet den Stamp an genau den laufenden Dienst, nicht einen Altstart.
  try {
    const running = JSON.parse(fs.readFileSync(path.join(root, '.backend-running.json'), 'utf8'));
    if (String(running.pid) !== pid) process.exit(2);
    process.exit(running.version === backendVersion(root) ? 0 : 1);
  } catch { process.exit(2); }
} else {
  throw new Error('Usage: backend-state.mjs files | changed <pid>');
}
