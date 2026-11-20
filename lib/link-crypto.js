// Verbindungen ueber einen Hub: Inhalt der Umschlaege (Ende-zu-Ende).
//
// Der Hub lagert nur Chiffrat; was hier entsteht, kann er weder lesen noch
// unbemerkt aendern. Verfahren: HKDF-SHA-256, X25519, AES-256-GCM mit
// zufaelliger 96-Bit-Nonce — alles aus node:crypto. Das Format ist das des
// Hub-Projekts "Vernetzung" (docs/PROTOKOLL-VERBINDUNGEN.md, Abschnitt 11) und
// muss Byte fuer Byte dazu passen: zwei Installationen verstehen sich nur, wenn
// beide dasselbe rechnen. test/link-crypto.test.js prueft gegen feste Vektoren
// aus der Referenz des Hubs.
//
// Jede Oeffnen-Funktion wirft bei falschem Schluessel, veraendertem Inhalt oder
// unbekannter Version; der Aufrufer behandelt das als "nicht fuer mich / nicht
// echt" und verarbeitet nichts davon.

import crypto from 'node:crypto';

const VERSION = 1;
export const KEY_NO = 1; // Version 1 kennt nur diese Schluesselnummer
const HEAD = 1 + 32;     // Version + oeffentlicher X25519-Schluessel
const MIN_SEALED = 12 + 16; // Nonce + Pruefsumme

const b64 = (b) => b.toString('base64url');
const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));

function seal(key, aad, plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  return Buffer.concat([nonce, c.update(JSON.stringify(plain), 'utf8'), c.final(), c.getAuthTag()]);
}

function open(key, aad, sealed) {
  if (sealed.length < MIN_SEALED) throw new Error('Umschlag zu kurz');
  const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]).toString('utf8'));
}

// Zusatzdaten aus mehreren Teilen, jeder mit zwei Bytes Laenge davor: sonst
// ergaeben verschiedene Aufteilungen derselben Bytes dasselbe.
function aad(...parts) {
  return Buffer.concat(parts.map((p) => {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    return Buffer.concat([len, b]);
  }));
}

const rawPublic = (key) => Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
const publicFromRaw = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64(raw) }, format: 'jwk' });

function decode(envelope, min) {
  if (typeof envelope !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope)) throw new Error('kein Umschlag');
  const raw = Buffer.from(envelope, 'base64url');
  if (raw.length < min) throw new Error('Umschlag zu kurz');
  if (raw[0] !== VERSION) throw new Error('unbekannte Version');
  return raw;
}

// --- Das Geheimnis im Einladungslink ------------------------------------------

export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/; // 32 Bytes, base64url ohne Auffuellung

export function newSecret() {
  return b64(crypto.randomBytes(32));
}

// Aus dem Geheimnis: das Beitritts-Token (geht beim Gesuch an den Hub; der kennt
// vorher nur `joinHash`) und der Einladungsschluessel (verlaesst die
// Installationen nie; sichert hello und welcome).
export function fromSecret(secret) {
  if (!SECRET_RE.test(String(secret))) throw new Error('ungueltiges Geheimnis');
  const s = Buffer.from(secret, 'base64url');
  const joinToken = b64(hkdf(s, Buffer.alloc(0), 'vernetzung/link/v1/join'));
  return {
    joinToken,
    joinHash: crypto.createHash('sha256').update(joinToken).digest('hex'),
    inviteKey: hkdf(s, Buffer.alloc(0), 'vernetzung/link/v1/invite'),
  };
}

// --- Gesuch des Beitretenden ---------------------------------------------------

// Liefert den Umschlag und den privaten Schluessel (JWK), mit dem spaeter das
// welcome geoeffnet wird.
export function makeHello(inviteKey, linkId, name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = rawPublic(publicKey);
  const hello = b64(Buffer.concat([Buffer.from([VERSION]), pub, seal(inviteKey, aad('hello', linkId, pub), { name })]));
  return { hello, privateKey: privateKey.export({ format: 'jwk' }) };
}

// Gelingt das, kennt der Absender den Link, und sein oeffentlicher Schluessel
// ist unveraendert. Der Name bleibt eine Selbstauskunft.
export function openHello(inviteKey, linkId, hello) {
  const raw = decode(hello, HEAD + MIN_SEALED);
  const pub = raw.subarray(1, HEAD);
  const plain = open(inviteKey, aad('hello', linkId, pub), raw.subarray(HEAD));
  return { pub: Buffer.from(pub), name: plain && typeof plain.name === 'string' ? plain.name : '' };
}

// --- Antwort des Einladenden: der Gruppenschluessel fuer genau dieses Mitglied --

// Der Einladungsschluessel geht als Salz in die Ableitung ein: der Hub kennt
// ihn nicht und kann deshalb kein welcome faelschen.
export function makeWelcome(inviteKey, linkId, memberId, pub, content) {
  const once = crypto.generateKeyPairSync('x25519');
  const oncePub = rawPublic(once.publicKey);
  const shared = crypto.diffieHellman({ privateKey: once.privateKey, publicKey: publicFromRaw(pub) });
  const wrap = hkdf(shared, inviteKey, 'vernetzung/link/v1/welcome');
  return b64(Buffer.concat([Buffer.from([VERSION]), oncePub,
    seal(wrap, aad('welcome', linkId, memberId, oncePub), content)]));
}

export function openWelcome(inviteKey, linkId, memberId, privateJwk, welcome) {
  const raw = decode(welcome, HEAD + MIN_SEALED);
  const oncePub = raw.subarray(1, HEAD);
  const shared = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: privateJwk, format: 'jwk' }), publicKey: publicFromRaw(oncePub),
  });
  const wrap = hkdf(shared, inviteKey, 'vernetzung/link/v1/welcome');
  return open(wrap, aad('welcome', linkId, memberId, oncePub), raw.subarray(HEAD));
}

// --- Nachrichten unter dem Gruppenschluessel -----------------------------------

export const newGroupKey = () => crypto.randomBytes(32);

// Die Kennung des Absenders steht in den Zusatzdaten: nennt der Hub einen
// anderen Absender, scheitert das Oeffnen.
export function sealMessage(groupKey, keyNo, linkId, fromMember, plain) {
  const head = Buffer.alloc(5);
  head[0] = VERSION;
  head.writeUInt32BE(keyNo, 1);
  return b64(Buffer.concat([head, seal(groupKey, aad('msg', linkId, fromMember, head), plain)]));
}

// `keys`: Schluesselnummer -> Gruppenschluessel (Buffer).
export function openMessage(keys, linkId, fromMember, box) {
  const raw = decode(box, 5 + MIN_SEALED);
  const head = raw.subarray(0, 5);
  const key = keys.get(head.readUInt32BE(1));
  if (!key) throw new Error('unbekannte Schlüsselnummer');
  return open(key, aad('msg', linkId, fromMember, head), raw.subarray(5));
}
