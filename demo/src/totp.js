// @ts-check
/**
 * TOTP (RFC 6238, HMAC-SHA1) with WebCrypto, matching serverhub/auth/totp.py:
 * 30 s steps, 6 digits, one step of clock drift either way, and single-use
 * recovery codes in the same "xxxxx-xxxxx" shape.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP = 30;
export const WINDOW = 1;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** @param {Uint8Array} bytes */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** @param {string} s */
export function base32Decode(s) {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** @param {number} n */
function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

/** A new 32-character base32 secret (160 bits), like pyotp.random_base32(32). */
export function newSecret() {
  return base32Encode(randomBytes(20));
}

/**
 * HOTP value for a counter (RFC 4226).
 * @param {Uint8Array} key
 * @param {number} counter
 * @param {number} [digits]
 */
export async function hotp(key, counter, digits = 6) {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256;
    c = Math.floor(c / 256);
  }
  const k = await globalThis.crypto.subtle.importKey('raw', /** @type {BufferSource} */ (key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, msg));
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * TOTP value at a time (seconds since the epoch).
 * @param {string} secret base32
 * @param {number} t
 * @param {number} [digits]
 */
export function totpAt(secret, t, digits = 6) {
  return hotp(base32Decode(secret), Math.floor(t / STEP), digits);
}

/**
 * The time step `code` is valid for (current step +/- WINDOW), or null.
 * @param {string} secret
 * @param {string} code
 * @param {number} nowSeconds
 */
export async function matchStep(secret, code, nowSeconds) {
  if (!/^\d{6}$/.test(code)) return null;
  let key;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }
  const current = Math.floor(nowSeconds / STEP);
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if ((await hotp(key, step)) === code) return step;
  }
  return null;
}

/** Ten recovery codes like "abcde-fghjk". */
export function newRecoveryCodes() {
  const codes = [];
  for (let n = 0; n < 10; n++) {
    let raw = '';
    // Rejection sampling keeps the distribution uniform over the 31-letter alphabet.
    while (raw.length < 10) {
      const b = randomBytes(1)[0];
      if (b < 248) raw += RECOVERY_ALPHABET[b % 31];
    }
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return codes;
}

/** @param {string} code */
export function normalizeRecoveryCode(code) {
  return code.replace(/[\s-]/g, '').toLowerCase();
}

/**
 * otpauth:// URI in the same form pyotp produces.
 * @param {string} secret
 * @param {string} account
 * @param {string} [issuer]
 */
export function provisioningUri(secret, account, issuer = 'Server Hub') {
  const q = (/** @type {string} */ s) => encodeURIComponent(s);
  return `otpauth://totp/${q(issuer)}:${q(account)}?secret=${secret}&issuer=${q(issuer)}`;
}
