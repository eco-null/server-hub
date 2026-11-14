import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, hotp, totpAt, matchStep, newSecret, newRecoveryCodes, normalizeRecoveryCode, provisioningUri } from '../src/totp.js';

const RFC_KEY = new TextEncoder().encode('12345678901234567890');

test('RFC 6238 SHA-1 test vectors (8 digits)', async () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  const secret = base32Encode(RFC_KEY);
  for (const [t, code] of vectors) assert.equal(await totpAt(secret, t, 8), code, `T=${t}`);
});

test('RFC 4226 HOTP vectors (6 digits)', async () => {
  const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let i = 0; i < want.length; i++) assert.equal(await hotp(RFC_KEY, i), want[i]);
});

test('base32 round trip and pyotp-shaped secrets', () => {
  assert.equal(base32Encode(RFC_KEY), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-gy3tqojqgezdgnbvgy3tqojq'), RFC_KEY);
  const s = newSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.throws(() => base32Decode('not base32!'));
});

test('matchStep accepts the current step and one either side, nothing else', async () => {
  const secret = newSecret();
  const now = 1_800_000_000;
  const step = Math.floor(now / 30);
  for (const d of [-1, 0, 1]) assert.equal(await matchStep(secret, await totpAt(secret, now + d * 30), now), step + d);
  assert.equal(await matchStep(secret, await totpAt(secret, now + 90), now), null);
  assert.equal(await matchStep(secret, '12345', now), null);
  assert.equal(await matchStep(secret, 'abcdef', now), null);
});

test('recovery codes and provisioning URI', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  for (const c of codes) assert.match(c, /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
  assert.equal(normalizeRecoveryCode(' ABCDE-fghjk '), 'abcdefghjk');
  assert.equal(provisioningUri('ABC', 'demo'), 'otpauth://totp/Server%20Hub:demo?secret=ABC&issuer=Server%20Hub');
});
