import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KEY_NO, fromSecret, makeHello, makeWelcome, newGroupKey, newSecret,
  openHello, openMessage, openWelcome, sealMessage, SECRET_RE,
} from '../lib/link-crypto.js';

// Feste Werte aus der Referenz des Hub-Projekts (test/links-crypto.ts dort):
// hello, welcome und box hat die Referenz erzeugt. Oeffnet diese Seite sie
// nicht mehr, verstehen sich zwei Installationen nicht mehr.
const V = {
  secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  joinToken: 'mkh8fm2BApj9FQFsqO_zzL6ejEVM00Semt-afFCbZ9I',
  joinHash: '6b0b4c96d97f18a7f7f9e40fdef55872b5e9a7a7ca43535fb81506f4ff66374b',
  inviteKey: 'ATuWHBsb8xv3KT7qZX3B0dUbvqY82Oj7ttTJWsEUueM',
  linkId: 'ln_TestVektor01',
  memberId: 'm_Beitretender',
  from: 'm_Absender0001',
  hello: 'AfTDYTasEsDKmvW0n6hh36mmAHW0dPqxF14CCZNPW8ceDF4HMHvE8SXGczD7FMBgkjZL5gDdCb-NopLbhzWEECQNilYH7HWt8IZlTsE-Rdi8R07kBA',
  helloPrivate: {
    crv: 'X25519', d: 'mLwx0hGtZb1x_GKNxRhQbxYuPx0zkosV4B-6sL-S62Y',
    x: '9MNhNqwSwMqa9bSfqGHfqaYAdbR0-rEXXgIJk09bxx4', kty: 'OKP',
  },
  welcome: 'AdXK4ubuYiQvNVFdQ63UPbx37Na5IfNf5VEWJFkFTzc6VbWmBV8sWZETNHhkmF68lgpnoMsQbWtZ6gnWYo47DTUnuOUHrlVw6ONsZ7JP7XJWyXUl3Bpph0tdWBF7rHXU3sQpgFJktbm5Clo1tsBegfenc6U1gH6Ug3Fi29y5uGUkIKHNP3fWpViPUjlWV4Tuw9tuTU5zAt92vSUpJtNwumFELEiOEnVgmrHDZRQw9ODNiRDu',
  box: 'AQAAAAHhLgLjUjlrwhH3rwqLKNTPHlYQqFmaVuxboPu3Y3x3qEchpT7d3F5S6Ahe9BWx1iDceEGKqD51kc8sMzMuL9KT7i3bGrV8Vr1nKOSBo9saWLEm_0tAVTxiWNyvioU',
};
const groupKey = Buffer.alloc(32, 7);

test('the link secret yields the join token, its hash and the invite key of the reference', () => {
  const s = fromSecret(V.secret);
  assert.equal(s.joinToken, V.joinToken);
  assert.equal(s.joinHash, V.joinHash);
  assert.equal(s.inviteKey.toString('base64url'), V.inviteKey);
  assert.match(newSecret(), SECRET_RE);
  assert.throws(() => fromSecret('zu-kurz'));
});

test('envelopes produced by the hub reference open here', () => {
  const { inviteKey } = fromSecret(V.secret);
  const hello = openHello(inviteKey, V.linkId, V.hello);
  assert.equal(hello.name, 'Sitzung ä€');
  assert.equal(hello.pub.toString('base64url'), V.helloPrivate.x);
  assert.deepEqual(openWelcome(inviteKey, V.linkId, V.memberId, V.helloPrivate, V.welcome), {
    key_no: 1, key: groupKey.toString('base64url'), members: [{ id: V.from, name: 'Gastgeber' }],
  });
  assert.deepEqual(openMessage(new Map([[KEY_NO, groupKey]]), V.linkId, V.from, V.box),
    { t: 'msg', n: 3, name: 'Gastgeber', text: 'Hallo über den Hub' });
});

test('hello, welcome and messages round-trip and are bound to link, member and sender', () => {
  const { inviteKey } = fromSecret(newSecret());
  const other = fromSecret(newSecret()).inviteKey;
  const { hello, privateKey } = makeHello(inviteKey, 'ln_aaaaaaaaaaaa', 'beta');
  const opened = openHello(inviteKey, 'ln_aaaaaaaaaaaa', hello);
  assert.equal(opened.name, 'beta');
  assert.throws(() => openHello(other, 'ln_aaaaaaaaaaaa', hello), 'wrong invite key');
  assert.throws(() => openHello(inviteKey, 'ln_bbbbbbbbbbbb', hello), 'other link');

  const key = newGroupKey();
  const content = { key_no: KEY_NO, key: key.toString('base64url'), members: [] };
  const welcome = makeWelcome(inviteKey, 'ln_aaaaaaaaaaaa', 'm_neu000000', opened.pub, content);
  assert.deepEqual(openWelcome(inviteKey, 'ln_aaaaaaaaaaaa', 'm_neu000000', privateKey, welcome), content);
  // Der Hub kennt den Einladungsschluessel nicht — ohne ihn entsteht kein gueltiges welcome.
  const forged = makeWelcome(other, 'ln_aaaaaaaaaaaa', 'm_neu000000', opened.pub, content);
  assert.throws(() => openWelcome(inviteKey, 'ln_aaaaaaaaaaaa', 'm_neu000000', privateKey, forged));
  assert.throws(() => openWelcome(inviteKey, 'ln_aaaaaaaaaaaa', 'm_anderer00', privateKey, welcome), 'other member');

  const keys = new Map([[KEY_NO, key]]);
  const box = sealMessage(key, KEY_NO, 'ln_aaaaaaaaaaaa', 'm_absender0', { t: 'msg', n: 1, text: 'hi' });
  assert.equal(openMessage(keys, 'ln_aaaaaaaaaaaa', 'm_absender0', box).text, 'hi');
  assert.throws(() => openMessage(keys, 'ln_aaaaaaaaaaaa', 'm_jemand000', box), 'sender swapped by the hub');
  assert.throws(() => openMessage(keys, 'ln_bbbbbbbbbbbb', 'm_absender0', box), 'other link');
  assert.throws(() => openMessage(new Map([[KEY_NO, newGroupKey()]]), 'ln_aaaaaaaaaaaa', 'm_absender0', box));
  const flipped = Buffer.from(box, 'base64url');
  flipped[flipped.length - 20] ^= 1;
  assert.throws(() => openMessage(keys, 'ln_aaaaaaaaaaaa', 'm_absender0', flipped.toString('base64url')), 'tampered');
  for (const junk of ['', 'AA', 'kein base64url!', 42, null]) {
    assert.throws(() => openMessage(keys, 'ln_aaaaaaaaaaaa', 'm_absender0', junk));
  }
});
