// Passwords (scrypt, built into Node — no extra packages) and session tokens.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(password, salt, n = N, r = R, p = P) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** → "scrypt$16384$8$1$<salt b64>$<hash b64>" */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password).normalize('NFKC'), salt);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scryptAsync(
    String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p),
  );
  return expected.length === key.length && timingSafeEqual(expected, key);
}

// Used when the email does not exist, so a wrong email and a wrong password take the same time.
let dummyHash = null;
export async function burnPasswordCheck(password) {
  if (!dummyHash) dummyHash = await hashPassword('daftari-dummy-password');
  await verifyPassword(password, dummyHash);
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export const SESSION_COOKIE = 'daftari_session';
export const SESSION_DAYS = 30;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
