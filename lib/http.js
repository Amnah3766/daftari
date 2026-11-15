// Small HTTP helpers shared by the Vercel functions (api/*.js) and the local server (server.mjs).
import { AppError } from './store.js';
import { SESSION_COOKIE, SESSION_DAYS } from './auth.js';

const MAX_BODY = 16 * 1024;

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function getSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

export function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Write requests must be JSON from this same site. A plain HTML form on another site cannot send
 * application/json without a CORS preflight, and we also reject a foreign Origin header.
 */
export function checkWriteRequest(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new AppError(415, 'json_only', 'طلب غير مدعوم');
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      // fall through
    }
    const expected = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host || host !== expected) throw new AppError(403, 'bad_origin', 'طلب من موقع ثاني');
  }
}

export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (text.length > MAX_BODY) throw new AppError(413, 'too_large', 'الطلب كبير');
    return parseJson(text);
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new AppError(413, 'too_large', 'الطلب كبير');
  }
  return parseJson(raw);
}

function parseJson(text) {
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new AppError(400, 'bad_json', 'طلب غير صالح');
  }
}

/** Wrap a handler: security headers, error → JSON with an Arabic message. */
export function route(fn) {
  return async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof AppError) {
        send(res, err.status, { error: err.code, message: err.message, fields: err.fields });
      } else if (err?.code === 'missing_env') {
        console.error('config error: MONGODB_URI missing');
        send(res, 500, { error: 'config', message: 'الموقع مو مضبوط (قاعدة البيانات)' });
      } else {
        console.error('server error:', err?.name, err?.message);
        send(res, 503, { error: 'unavailable', message: 'صار خلل بالاتصال، جرّب بعد شوي' });
      }
    }
  };
}
