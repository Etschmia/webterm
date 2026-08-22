import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

export function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1') return true;
  return net.isIP(value) === 4 && value.startsWith('127.');
}

export function canonicalOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/'
      && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

export function isPathInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export function terminalSize(cols, rows) {
  const c = Number(cols);
  const r = Number(rows);
  return {
    cols: Number.isInteger(c) && c >= 2 && c <= 500 ? c : 80,
    rows: Number.isInteger(r) && r >= 2 && r <= 200 ? r : 24,
  };
}

export function validCsrfRequest(headers, expectedToken, allowedOrigins) {
  const supplied = String(headers['x-term-csrf'] || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (!headers.origin) return true;
  const origin = canonicalOrigin(headers.origin);
  return !!origin && allowedOrigins.has(origin);
}
