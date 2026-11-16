// Stripe Checkout (TEST MODE ONLY) over plain fetch — no `stripe` npm package, so دفتري stays zero-dependency.
// Used by the customer payment link (/pay) when STRIPE_SECRET_KEY is set on the server. Without a key the payment
// page runs its own built-in test gateway instead (see lib/store.js payByTestCard), so the link always works.
// The key is read from the server environment only and is never logged or sent to the browser.

const STRIPE_API = 'https://api.stripe.com/v1';

/** 1 KWD = 3.25 USD (fixed demo rate). The Stripe test account rejects KWD, so the charge is made in USD. */
export const KWD_TO_USD = 3.25;

/** Pull a Stripe secret key out of a pasted value (quotes, spaces or "STRIPE_SECRET_KEY=" around it). */
export function normalizeSecretKey(raw) {
  if (!raw) return undefined;
  const found = /(?:^|[^A-Za-z0-9])((?:sk|rk)_(?:test|live)_[A-Za-z0-9]{10,})(?![A-Za-z0-9])/.exec(String(raw));
  return found ? found[1] : String(raw).trim() || undefined;
}

/** 'ready' | 'missing' | 'live' | 'malformed'. Live keys are refused: this is a classwork MVP. */
export function keyStatus(raw = process.env.STRIPE_SECRET_KEY) {
  const key = normalizeSecretKey(raw);
  if (!key) return 'missing';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(key)) return 'malformed';
  return 'ready';
}

/** 'stripe' when a valid test key is configured, otherwise 'test' (the built-in test gateway). */
export function paymentMode() {
  return keyStatus() === 'ready' ? 'stripe' : 'test';
}

/** Charge currency: USD by default; STRIPE_CHARGE_CURRENCY=kwd switches to KWD for accounts that support it. */
export function chargeCurrency() {
  return String(process.env.STRIPE_CHARGE_CURRENCY || '').trim().toLowerCase() === 'kwd' ? 'kwd' : 'usd';
}

/** Fils → Stripe minor units: fils (rounded to 10, Stripe's rule for 3-decimal currencies) or US cents. */
export function toChargeAmount(fils, currency) {
  return currency === 'kwd' ? Math.round(fils / 10) * 10 : Math.round((fils * KWD_TO_USD) / 10);
}

/** Stripe's smallest card charge is about 0.50 USD. */
export function chargeTooSmall(fils, currency) {
  return currency === 'kwd' ? fils < 200 : toChargeAmount(fils, currency) < 50;
}

/** application/x-www-form-urlencoded with Stripe's bracket syntax: line_items[0][price_data][currency]=usd */
export function encodeForm(params) {
  const out = [];
  const walk = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${key}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join('&');
}

export const isCheckoutSessionId = (v) => typeof v === 'string' && /^cs_test_[A-Za-z0-9]{10,200}$/.test(v);

/** Only ever send the customer to Stripe's own hosted checkout. */
export function isStripeCheckoutUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'checkout.stripe.com' || u.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

export class StripeError extends Error {
  constructor(status, type, code, param = null) {
    super(`Stripe error ${status} (${type}${code ? `/${code}` : ''}${param ? ` param=${param}` : ''})`);
    this.name = 'StripeError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

let fetchImpl = (...args) => fetch(...args);
/** Tests swap in a fake Stripe. */
export function setStripeFetch(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

async function stripeRequest(method, path, params) {
  if (keyStatus() !== 'ready') throw new StripeError(0, 'not_configured', null);
  const key = normalizeSecretKey(process.env.STRIPE_SECRET_KEY);
  const body = params ? encodeForm(params) : undefined;
  let res;
  // Retry network failures only (never an answer from Stripe).
  for (let attempt = 1; attempt <= 3 && !res; attempt++) {
    try {
      res = await fetchImpl(`${STRIPE_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      if (attempt === 3) throw new StripeError(0, 'network_error', null);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = data?.error;
    throw new StripeError(res.status, e?.type || 'api_error', e?.code || null, typeof e?.param === 'string' ? e.param.slice(0, 80) : null);
  }
  if (!data || typeof data !== 'object') throw new StripeError(res.status, 'invalid_response', null);
  return data;
}

/**
 * One Checkout Session for one order. The server writes the pay token, order id and expected amount into the
 * session metadata; only the secret key can write metadata, so after payment it is the trusted record.
 */
export function createCheckoutSession({ order, shopName, origin, token }) {
  const currency = chargeCurrency();
  const amount = toChargeAmount(order.priceFils, currency);
  const kwd = (order.priceFils / 1000).toFixed(3);
  const back = `${origin}/pay?t=${token}`;
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: String(order._id),
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: amount,
        product_data: {
          name: `${order.item} — ${shopName}`.slice(0, 250),
          description: currency === 'kwd' ? `${kwd} KWD` : `${kwd} KWD (1 KWD = ${KWD_TO_USD} USD, test mode)`,
        },
      },
    }],
    metadata: {
      payToken: token,
      orderId: String(order._id),
      priceFils: String(order.priceFils),
      currency,
      amount: String(amount),
    },
    success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back}&canceled=1`,
  });
}

export function retrieveCheckoutSession(id) {
  if (!isCheckoutSessionId(id)) throw new StripeError(400, 'invalid_request_error', 'invalid_session_id');
  return stripeRequest('GET', `/checkout/sessions/${id}`);
}

/** True only for a PAID session that the server created for exactly this order, token and amount. */
export function sessionPaysOrder(session, order, token) {
  if (!session || session.object !== 'checkout.session' || session.livemode) return false;
  if (session.payment_status !== 'paid') return false;
  const m = session.metadata || {};
  if (m.payToken !== token || m.orderId !== String(order._id)) return false;
  if (m.priceFils !== String(order.priceFils)) return false;
  const currency = m.currency === 'kwd' ? 'kwd' : 'usd';
  return session.currency === currency && session.amount_total === toChargeAmount(order.priceFils, currency);
}
