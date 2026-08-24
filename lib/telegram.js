// Telegram-Bot dieser Installation: Bruecke Telegram <-> lokales Claude Code.
//
// Eine Nachricht an den (per BotFather angelegten) Bot laeuft als `claude -p`
// in einem eigenen Arbeitsverzeichnis (~/.term-telegram/work) und die Antwort
// geht zurueck in den Chat. Folge-Nachrichten setzen dieselbe Claude-Session
// fort (--resume); /new beginnt ein frisches Gespraech.
//
// Sicherheitsmodell:
//   - Genau EIN Chat ist verknuepft (der, der beim Einrichten den Link-Code
//     per /start geschickt hat). Alle anderen Absender werden abgewiesen.
//   - claude laeuft OHNE --dangerously-skip-permissions: Werkzeuge, die eine
//     Freigabe braeuchten, werden im Headless-Modus schlicht verweigert.
//   - Der Bot-Token liegt in ~/.term-telegram/config.json (0600), nie im Repo.
//
// Verbindungstechnik: Long-Polling (getUpdates, timeout 50 s) im selben
// Prozess wie server.js — kein Webhook, keine oeffentliche Erreichbarkeit
// noetig. "connected" heisst: die Schleife laeuft und der letzte Zyklus war ok.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const HOME = process.env.HOME || os.homedir();
const TG_DIR = path.join(HOME, '.term-telegram');
const TG_CONF = path.join(TG_DIR, 'config.json');
const TG_WORKDIR = path.join(TG_DIR, 'work');
const TG_API = 'https://api.telegram.org';

const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;   // eine Anfrage an claude -p
const REPLY_CHUNK = 3900;                   // Telegram-Limit 4096, mit Luft
const POLL_TIMEOUT_S = 50;                  // getUpdates-Long-Poll
const CONNECTED_MAX_AGE_MS = 2 * 60 * 1000; // letzter ok-Zyklus juenger als das

// ---------------------------------------------------------------------------
// Konfiguration (~/.term-telegram/config.json)
// ---------------------------------------------------------------------------
// Felder: token, botUsername, botName, chatId, chatTitle, enabled,
//         lastSessionId, setup: { step: 'link', linkCode } | null

let cfg = loadConfig();

function loadConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(TG_CONF, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}

function saveConfig() {
  fs.mkdirSync(TG_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(TG_DIR, `.config-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, TG_CONF);
}

function isConfigured() { return !!(cfg.token && cfg.chatId && !cfg.setup); }

// ---------------------------------------------------------------------------
// Claude-Binary finden (Voraussetzung des Features)
// ---------------------------------------------------------------------------
// Wie beim gh-CLI: die systemd-Unit hat ~/.local/bin evtl. nicht im PATH.
// Kandidaten zuerst, dann der PATH des Prozesses. Ergebnis kurz gecacht —
// der Status wird von der Sidebar gepollt.

let claudeCache = { at: 0, bin: null };
function findClaudeBin() {
  if (Date.now() - claudeCache.at < 60 * 1000) return claudeCache.bin;
  const cands = [
    process.env.CLAUDE_BIN,
    path.join(HOME, '.local/bin/claude'),
    path.join(HOME, '.npm-global/bin/claude'),
    path.join(HOME, '.bun/bin/claude'),
    '/usr/local/bin/claude', '/usr/bin/claude',
  ].filter(Boolean);
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir) cands.push(path.join(dir, 'claude'));
  }
  let bin = null;
  for (const c of cands) {
    try { fs.accessSync(c, fs.constants.X_OK); bin = c; break; } catch { /* weiter */ }
  }
  claudeCache = { at: Date.now(), bin };
  return bin;
}

// ---------------------------------------------------------------------------
// Telegram-API
// ---------------------------------------------------------------------------

async function tg(method, params, { token = cfg.token, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) {
      return {
        ok: false,
        code: d && d.error_code != null ? d.error_code : r.status,
        desc: (d && d.description) || `HTTP ${r.status}`,
      };
    }
    return { ok: true, result: d.result };
  } catch (e) {
    return { ok: false, code: 0, desc: e.name === 'AbortError' ? 'Zeitueberschreitung' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function tgErrorText(r) {
  if (r.code === 401 || r.code === 404) return 'Bot-Token ungueltig oder widerrufen.';
  if (r.code === 409) return 'Der Token wird bereits woanders benutzt (zweites getUpdates/Webhook).';
  if (r.code === 0) return `Telegram nicht erreichbar (${r.desc}).`;
  return `Telegram-Fehler ${r.code}: ${r.desc}`;
}

// Lange Antworten stueckeln (Telegram-Limit 4096 Zeichen), bevorzugt an
// Zeilenumbruechen. Fehler beim Senden sind best effort (naechster Chunk trotzdem).
async function sendText(chatId, text) {
  let rest = String(text || '').trim() || '(leere Antwort)';
  while (rest.length) {
    let part = rest.slice(0, REPLY_CHUNK);
    if (rest.length > REPLY_CHUNK) {
      const nl = part.lastIndexOf('\n');
      if (nl > REPLY_CHUNK / 2) part = part.slice(0, nl);
    }
    rest = rest.slice(part.length).replace(/^\n+/, '');
    await tg('sendMessage', { chat_id: chatId, text: part });
  }
}

// ---------------------------------------------------------------------------
// Claude-Lauf (eine Nachricht -> eine Antwort), strikt seriell
// ---------------------------------------------------------------------------

let claudeQueue = Promise.resolve();

function runClaude(prompt, { resume } = {}) {
  const bin = findClaudeBin();
  if (!bin) return Promise.resolve({ ok: false, err: 'claude nicht gefunden' });
  const args = ['-p', '--output-format', 'json'];
  if (resume) args.push('--resume', resume);
  args.push(prompt);
  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd: TG_WORKDIR,
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HOME },
    }, (err, stdout, stderr) => {
      let data = null;
      try { data = JSON.parse(stdout); } catch { /* unten behandelt */ }
      if (data && typeof data.result === 'string') {
        resolve({ ok: !data.is_error, text: data.result, sessionId: data.session_id || null, err: data.is_error ? data.result : '' });
        return;
      }
      if (err) {
        const detail = (stderr || err.message || '').trim().slice(0, 600);
        resolve({ ok: false, err: err.killed ? 'Zeitueberschreitung (10 min)' : detail || 'claude fehlgeschlagen' });
        return;
      }
      resolve({ ok: true, text: (stdout || '').trim(), sessionId: null });
    });
  });
}

async function answerWithClaude(chatId, prompt) {
  // "tippt …" anzeigen, solange claude arbeitet (Telegram blendet die Aktion
  // nach ~5 s aus, daher periodisch erneuern).
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const typing = setInterval(() => {
    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4500);
  try {
    fs.mkdirSync(TG_WORKDIR, { recursive: true, mode: 0o700 });
    let r = await runClaude(prompt, { resume: cfg.lastSessionId || undefined });
    // --resume kann scheitern (Session-Datei weg/veraltet) -> einmal frisch.
    if (!r.ok && cfg.lastSessionId) {
      cfg.lastSessionId = null; saveConfig();
      r = await runClaude(prompt);
    }
    if (r.ok) {
      if (r.sessionId && r.sessionId !== cfg.lastSessionId) { cfg.lastSessionId = r.sessionId; saveConfig(); }
      await sendText(chatId, r.text);
    } else {
      await sendText(chatId, `⚠️ Claude-Fehler: ${r.err}`);
    }
  } finally {
    clearInterval(typing);
  }
}

// ---------------------------------------------------------------------------
// Eingehende Nachrichten
// ---------------------------------------------------------------------------

const HELP_TEXT = 'Schick mir einfach eine Nachricht — ich gebe sie an Claude Code auf dem Server '
  + 'weiter und antworte mit dem Ergebnis. Folge-Nachrichten setzen das Gespraech fort.\n\n'
  + 'Befehle:\n/new — neues Gespraech beginnen\n/status — Zustand des Bots';

function chatLabel(chat, from) {
  return (chat && (chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ')))
    || (from && (from.username || from.first_name)) || '';
}

async function handleMessage(msg) {
  const text = (msg.text || msg.caption || '').trim();
  const chatId = msg.chat && msg.chat.id;
  if (chatId == null) return;

  // Einrichtungs-Phase: auf "/start <code>" aus BELIEBIGEM Chat warten; der
  // richtige Code verknuepft genau diesen Chat.
  if (cfg.setup && cfg.setup.step === 'link') {
    const m = /^\/start(?:\s+(\S+))?/.exec(text);
    if (m && m[1] && m[1] === cfg.setup.linkCode) {
      cfg.chatId = chatId;
      cfg.chatTitle = chatLabel(msg.chat, msg.from);
      cfg.enabled = true;
      cfg.setup = null;
      cfg.lastSessionId = null;
      saveConfig();
      await sendText(chatId, `✅ Verbunden mit ${os.hostname()}. ${HELP_TEXT}`);
    } else if (m) {
      await sendText(chatId, 'Dieser Bot wird gerade eingerichtet — bitte den Link aus dem Webterminal benutzen.');
    }
    return;
  }

  if (!cfg.chatId) return;
  if (chatId !== cfg.chatId) {
    // Fremde Absender klar, aber knapp abweisen (nur auf /start, gegen Spam).
    if (/^\/start\b/.test(text)) await sendText(chatId, 'Dieser Bot ist privat und an eine andere Person gebunden.');
    return;
  }

  if (!text) { await sendText(chatId, 'Ich kann nur mit Text umgehen.'); return; }
  if (/^\/start\b/.test(text)) { await sendText(chatId, HELP_TEXT); return; }
  if (/^\/new\b/.test(text)) {
    cfg.lastSessionId = null; saveConfig();
    await sendText(chatId, '🆕 Neues Gespraech — der bisherige Verlauf ist fuer Claude beendet.');
    return;
  }
  if (/^\/status\b/.test(text)) {
    const bin = findClaudeBin();
    await sendText(chatId, `Host: ${os.hostname()}\nClaude: ${bin || 'nicht gefunden'}\n`
      + `Arbeitsverzeichnis: ${TG_WORKDIR}\nGespraech: ${cfg.lastSessionId ? 'wird fortgesetzt' : 'frisch'}`);
    return;
  }

  // Seriell abarbeiten: eine Claude-Instanz zur Zeit, Reihenfolge bleibt erhalten.
  claudeQueue = claudeQueue
    .then(() => answerWithClaude(chatId, text))
    .catch(() => {});
  await claudeQueue;
}

// ---------------------------------------------------------------------------
// Long-Polling-Schleife
// ---------------------------------------------------------------------------

const poll = { running: false, gen: 0, offset: 0, lastOkAt: 0, lastError: null };

function shouldPoll() {
  if (!cfg.token) return false;
  if (cfg.setup && cfg.setup.step === 'link') return true;   // auf /start warten
  return !!(cfg.chatId && cfg.enabled);
}

async function pollLoop(gen) {
  while (gen === poll.gen && shouldPoll()) {
    const r = await tg('getUpdates', {
      timeout: POLL_TIMEOUT_S,
      offset: poll.offset || undefined,
      allowed_updates: ['message'],
    }, { timeoutMs: (POLL_TIMEOUT_S + 15) * 1000 });
    if (gen !== poll.gen) break;
    if (!r.ok) {
      poll.lastError = tgErrorText(r);
      // Token tot: Schleife beenden, der Fehler bleibt im Status sichtbar.
      if (r.code === 401 || r.code === 404) break;
      await new Promise((ok) => setTimeout(ok, r.code === 409 ? 15000 : 5000));
      continue;
    }
    poll.lastOkAt = Date.now();
    poll.lastError = null;
    for (const u of r.result || []) {
      if (u.update_id != null) poll.offset = u.update_id + 1;
      if (u.message) {
        try { await handleMessage(u.message); }
        catch (e) { console.error('telegram: Nachricht fehlgeschlagen:', e); }
      }
    }
  }
  if (gen === poll.gen) poll.running = false;
}

function ensurePolling() {
  if (!shouldPoll()) { stopPolling(); return; }
  if (poll.running) return;
  poll.running = true;
  poll.gen += 1;
  poll.lastError = null;
  pollLoop(poll.gen).catch((e) => {
    poll.lastError = String(e.message || e);
    poll.running = false;
  });
}

function stopPolling() {
  poll.gen += 1;        // laufende Schleife laeuft beim naechsten Zyklus aus
  poll.running = false;
}

// ---------------------------------------------------------------------------
// Oeffentliche API (von server.js benutzt)
// ---------------------------------------------------------------------------

export function telegramStatus() {
  const connected = poll.running && !poll.lastError
    && Date.now() - poll.lastOkAt < CONNECTED_MAX_AGE_MS;
  return {
    claude: !!findClaudeBin(),
    configured: isConfigured(),
    enabled: !!cfg.enabled,
    connected,
    botUsername: cfg.botUsername || null,
    botName: cfg.botName || null,
    chatTitle: cfg.chatTitle || null,
    setup: cfg.setup ? { step: cfg.setup.step, linkCode: cfg.setup.linkCode, botUsername: cfg.botUsername || null } : null,
    lastError: poll.lastError,
  };
}

// Schritt "Token": Token gegen getMe pruefen, Bot-Identitaet uebernehmen und
// in die Link-Phase wechseln (Polling wartet ab jetzt auf /start <code>).
export async function telegramSetToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return { error: 'Das sieht nicht wie ein Bot-Token aus (Format: 123456789:AA…).' };
  }
  if (!findClaudeBin()) return { error: 'Claude Code ist auf diesem Server nicht installiert.' };
  const me = await tg('getMe', {}, { token, timeoutMs: 12000 });
  if (!me.ok) return { error: `Token nicht angenommen: ${tgErrorText(me)}` };
  // Ein evtl. gesetzter Webhook wuerde getUpdates blockieren (409).
  await tg('deleteWebhook', {}, { token, timeoutMs: 8000 });
  stopPolling();
  cfg.token = token;
  cfg.botUsername = me.result.username || '';
  cfg.botName = me.result.first_name || me.result.username || 'Bot';
  cfg.chatId = null;
  cfg.chatTitle = null;
  cfg.enabled = false;
  cfg.lastSessionId = null;
  cfg.setup = { step: 'link', linkCode: crypto.randomBytes(6).toString('hex') };
  saveConfig();
  ensurePolling();
  return { ok: true };
}

// Einrichtung verwerfen: alles Angefangene weg (Token inklusive) — die
// naechste Einrichtung beginnt von vorn. Den Bot bei BotFather loeschen
// muss die Person selbst (/deletebot), das kann die Bot-API nicht.
export function telegramCancelSetup() {
  if (!cfg.setup) return { ok: true };
  stopPolling();
  cfg = {};
  try { fs.rmSync(TG_CONF, { force: true }); } catch { /* egal */ }
  return { ok: true };
}

export function telegramStart() {
  if (!isConfigured()) return { error: 'Bot ist nicht fertig eingerichtet.' };
  cfg.enabled = true;
  saveConfig();
  poll.lastOkAt = 0;      // "connected" erst nach dem naechsten ok-Zyklus
  ensurePolling();
  return { ok: true };
}

export function telegramStop() {
  if (!isConfigured()) return { error: 'Bot ist nicht fertig eingerichtet.' };
  cfg.enabled = false;
  saveConfig();
  stopPolling();
  return { ok: true };
}

// Einrichtung dieser Installation loeschen (Token + Verknuepfung). Der Bot
// selbst existiert bei Telegram weiter, bis er per BotFather geloescht wird.
export function telegramRemove() {
  stopPolling();
  cfg = {};
  try { fs.rmSync(TG_CONF, { force: true }); } catch { /* egal */ }
  return { ok: true };
}

// Beim Serverstart: konfigurierten (oder mitten in der Verknuepfung steckenden)
// Bot wieder anwerfen.
export function telegramBoot() {
  ensurePolling();
}
