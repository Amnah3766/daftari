// The two API endpoints. Same code on Vercel (api/auth.js, api/orders.js) and locally (server.mjs).
import { getDb } from './db.js';
import { AppError, createStore } from './store.js';
import {
  checkWriteRequest, clearSessionCookie, getSessionToken, readJson, requestOrigin, route, send, setSessionCookie,
} from './http.js';
import {
  chargeCurrency, chargeTooSmall, createCheckoutSession, isCheckoutSessionId, isStripeCheckoutUrl, paymentMode,
  retrieveCheckoutSession, sessionPaysOrder, StripeError,
} from './stripe.js';

let storeFactory = async () => createStore(await getDb());
/** Tests can swap the store (e.g. a throw-away database). */
export function setStoreFactory(fn) {
  storeFactory = fn;
}

const notAllowed = (res, allow) => {
  res.setHeader('Allow', allow);
  send(res, 405, { error: 'method', message: 'غير مسموح' });
};

/**
 * /api/auth
 *   GET                              → { user | null }
 *   POST { action: 'signup', shopName, email, password }
 *   POST { action: 'login', email, password }
 *   POST { action: 'logout' }
 */
export const authHandler = route(async (req, res) => {
  if (req.method === 'GET') {
    const store = await storeFactory();
    const user = await store.sessionUser(getSessionToken(req));
    send(res, 200, { user });
    return;
  }
  if (req.method !== 'POST') return notAllowed(res, 'GET, POST');
  checkWriteRequest(req);
  const body = await readJson(req);
  if (body.action === 'logout') {
    // Clear the cookie first, so the browser is signed out even if the database is unreachable.
    clearSessionCookie(req, res);
    try {
      await (await storeFactory()).logout(getSessionToken(req));
    } catch (err) {
      console.error('logout cleanup failed:', err?.name, err?.message);
    }
    send(res, 200, { ok: true });
    return;
  }
  const store = await storeFactory();
  switch (body.action) {
    case 'signup': {
      const { user, token } = await store.signup(body);
      setSessionCookie(req, res, token);
      send(res, 201, { user });
      return;
    }
    case 'login': {
      const { user, token } = await store.login(body);
      setSessionCookie(req, res, token);
      send(res, 200, { user });
      return;
    }
    default:
      throw new AppError(400, 'bad_action', 'طلب غير معروف');
  }
});

/**
 * /api/orders  (needs a signed-in seller)
 *   GET                         → { user, orders }
 *   POST   { customerName, customerPhone, item, price, cost, method } → { order }
 *   PATCH  { id, status }       → { order }
 *   DELETE { id }               → { id }
 */
export const ordersHandler = route(async (req, res) => {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return notAllowed(res, 'GET, POST, PATCH, DELETE');
  if (req.method !== 'GET') checkWriteRequest(req);
  const store = await storeFactory();
  const user = await store.sessionUser(getSessionToken(req));
  if (!user) throw new AppError(401, 'signed_out', 'سجّل دخول أول');

  if (req.method === 'GET') {
    send(res, 200, { user, orders: await store.listOrders(user.id) });
    return;
  }
  const body = await readJson(req);
  if (req.method === 'POST') {
    send(res, 201, { order: await store.addOrder(user.id, body) });
  } else if (req.method === 'PATCH') {
    send(res, 200, { order: await store.setStatus(user.id, body.id, body.status) });
  } else {
    send(res, 200, await store.deleteOrder(user.id, body.id));
  }
});

/**
 * /api/pay — the customer's payment link (public; the secret token in the link is the key).
 *   GET  ?t=TOKEN                                  → { mode, order }   (mode: 'stripe' | 'test')
 *   GET  (no token)                                → { mode }
 *   POST { action: 'test', t, outcome }            → built-in test gateway (only when there is no Stripe key)
 *                                                    outcome 'success' → «وصلني» by itself, 'declined' → stays «ما دفع»
 *   POST { action: 'checkout', t }                 → { url } of a Stripe Checkout page (Stripe test mode)
 *   POST { action: 'confirm', t, sessionId }       → back from Stripe: checks the session WITH STRIPE, then «وصلني»
 *   POST { action: 'cancel', t }                   → back from Stripe without paying: a failed attempt
 */
export const payHandler = route(async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return notAllowed(res, 'GET, POST');
  const mode = paymentMode();
  if (req.method === 'GET') {
    const token = new URL(req.url || '/', 'http://x').searchParams.get('t');
    if (!token) {
      send(res, 200, { mode });
      return;
    }
    const store = await storeFactory();
    send(res, 200, { mode, order: await store.payInfo(token) });
    return;
  }
  checkWriteRequest(req);
  const body = await readJson(req);
  const token = typeof body.t === 'string' ? body.t : '';
  const store = await storeFactory();

  switch (body.action) {
    case 'test': {
      if (mode !== 'test') throw new AppError(409, 'use_stripe', 'الدفع يصير عن طريق صفحة Stripe');
      if (body.outcome === 'success') {
        send(res, 200, { result: 'paid', order: await store.markPaidByLink(token) });
      } else if (body.outcome === 'declined') {
        const info = await store.payInfo(token);
        if (info.status === 'paid') {
          send(res, 200, { result: 'paid', order: info });
          return;
        }
        send(res, 200, { result: 'declined', order: await store.recordPayFailure(token) });
      } else {
        throw new AppError(400, 'bad_outcome', 'طلب غير صالح');
      }
      return;
    }
    case 'checkout': {
      if (mode !== 'stripe') throw new AppError(409, 'test_mode', 'الدفع بالبطاقة التجريبية من نفس الصفحة');
      const { order, shopName } = await store.payOrder(token);
      if (order.status === 'paid') {
        send(res, 200, { result: 'paid', order: await store.payInfo(token) });
        return;
      }
      if (chargeTooSmall(order.priceFils, chargeCurrency())) {
        throw new AppError(400, 'too_small', 'المبلغ صغير على الدفع بالبطاقة');
      }
      const session = await stripeCall(() => createCheckoutSession({ order, shopName, origin: requestOrigin(req), token }));
      if (!isStripeCheckoutUrl(session.url)) throw new AppError(502, 'stripe', 'بوابة الدفع ما ردت، جرّب بعد شوي');
      await store.setCheckoutSession(token, session.id);
      send(res, 200, { url: session.url });
      return;
    }
    case 'confirm': {
      if (mode !== 'stripe') throw new AppError(409, 'test_mode', 'طلب غير صالح');
      if (!isCheckoutSessionId(body.sessionId)) throw new AppError(400, 'bad_session', 'طلب غير صالح');
      const { order } = await store.payOrder(token);
      if (order.status === 'paid') {
        send(res, 200, { result: 'paid', order: await store.payInfo(token) });
        return;
      }
      const session = await stripeCall(() => retrieveCheckoutSession(body.sessionId));
      if (sessionPaysOrder(session, order, token)) {
        send(res, 200, { result: 'paid', order: await store.markPaidByLink(token, { stripeSessionId: session.id }) });
      } else {
        send(res, 200, { result: 'not_paid', order: await store.payInfo(token) });
      }
      return;
    }
    case 'cancel': {
      const info = await store.payInfo(token);
      if (info.status === 'paid') {
        send(res, 200, { result: 'paid', order: info });
        return;
      }
      send(res, 200, { result: 'declined', order: await store.recordPayFailure(token) });
      return;
    }
    default:
      throw new AppError(400, 'bad_action', 'طلب غير معروف');
  }
});

async function stripeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StripeError) {
      console.error('stripe:', err.message); // status/type/code only — never the key
      throw new AppError(502, 'stripe', 'بوابة الدفع ما ردت، جرّب بعد شوي');
    }
    throw err;
  }
}
