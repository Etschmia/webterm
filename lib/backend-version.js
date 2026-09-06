import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Gemeinsame Quelle fuer Build, laufenden Server und deploy/update.
export function backendFiles(root) {
  const manifest = 'deploy/backend-paths.json';
  const entries = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
  const files = [manifest];
  function visit(rel) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('Invalid backend path');
    let stat;
    try { stat = fs.lstatSync(path.join(root, rel)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(root, rel)).sort()) visit(path.join(rel, name));
    } else if (stat.isFile()) files.push(rel);
    else throw new Error(`Unsupported backend file: ${rel}`);
  }
  entries.forEach(visit);
  return [...new Set(files)].sort();
}

export function backendVersion(root) {
  const hash = crypto.createHash('sha256');
  for (const file of backendFiles(root)) {
    const data = fs.readFileSync(path.join(root, file));
    hash.update(`${file}\0${data.length}\0`).update(data);
  }
  return hash.digest('hex').slice(0, 16);
}
