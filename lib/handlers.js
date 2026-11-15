// The two API endpoints. Same code on Vercel (api/auth.js, api/orders.js) and locally (server.mjs).
import { getDb } from './db.js';
import { AppError, createStore } from './store.js';
import {
  checkWriteRequest, clearSessionCookie, getSessionToken, readJson, route, send, setSessionCookie,
} from './http.js';

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
