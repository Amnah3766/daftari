// The real API handlers with fake req/res, wired to a throw-away database.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { authHandler, ordersHandler, setStoreFactory } from '../lib/handlers.js';
import { fakeReq, fakeRes, loadEnv, tempDb } from './helpers.mjs';

const hasDb = loadEnv();

async function call(handler, opts) {
  const res = fakeRes();
  await handler(fakeReq(opts), res);
  return res;
}

describe('HTTP API', { skip: !hasDb && 'MONGODB_URI not set' }, () => {
  let ctx;
  before(async () => {
    ctx = await tempDb('http');
    const store = createStore(ctx.db);
    setStoreFactory(async () => store);
  });
  after(async () => ctx?.cleanup());

  let cookieA;
  let cookieB;
  let orderId;

  test('GET /api/auth without a cookie → user null', async () => {
    const res = await call(authHandler, {});
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { user: null });
  });

  test('signup sets an HttpOnly cookie and never returns the password hash', async () => {
    const res = await call(authHandler, {
      method: 'POST', body: { action: 'signup', shopName: 'حلويات نورة', email: 'a@example.test', password: 'secret123' },
    });
    assert.equal(res.statusCode, 201);
    assert.match(res.headers['set-cookie'], /daftari_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
    assert.ok(!res.headers['set-cookie'].includes('Secure'), 'no Secure flag on plain http');
    assert.ok(!res.body.includes('passwordHash'));
    cookieA = res.cookie;
    const me = await call(authHandler, { cookie: cookieA });
    assert.equal(me.json.user.shopName, 'حلويات نورة');
  });

  test('Secure flag is added behind https (Vercel)', async () => {
    const res = await call(authHandler, {
      method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: { action: 'login', email: 'a@example.test', password: 'secret123' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['set-cookie'], /; Secure$/);
  });

  test('field errors come back in Arabic', async () => {
    const res = await call(authHandler, { method: 'POST', body: { action: 'signup', shopName: '', email: 'x', password: '1' } });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json.fields.email);
    assert.ok(res.json.fields.password);
    const wrong = await call(authHandler, { method: 'POST', body: { action: 'login', email: 'a@example.test', password: 'nope-nope' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json.message, 'الإيميل أو كلمة السر غلط');
  });

  test('orders need a session', async () => {
    assert.equal((await call(ordersHandler, {})).statusCode, 401);
    assert.equal((await call(ordersHandler, { cookie: 'daftari_session=forged' })).statusCode, 401);
  });

  test('write requests must be JSON from the same site (CSRF guard)', async () => {
    const form = await call(ordersHandler, {
      method: 'POST', cookie: cookieA, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'customerName=x',
    });
    assert.equal(form.statusCode, 415);
    const foreign = await call(ordersHandler, {
      method: 'POST', cookie: cookieA, headers: { origin: 'https://evil.example' }, body: { customerName: 'x' },
    });
    assert.equal(foreign.statusCode, 403);
    const logoutCsrf = await call(authHandler, { method: 'POST', headers: { origin: 'https://evil.example' }, body: { action: 'logout' } });
    assert.equal(logoutCsrf.statusCode, 403);
  });

  test('create → list → status → delete', async () => {
    const created = await call(ordersHandler, {
      method: 'POST', cookie: cookieA, headers: { origin: 'http://localhost:5320' },
      body: { customerName: 'أم محمد', customerPhone: '٥٥٥١٢٣٤٥', item: 'كيكة', price: '8.5', cost: '3', method: 'cash_driver' },
    });
    assert.equal(created.statusCode, 201);
    orderId = created.json.order.id;
    assert.equal(created.json.order.priceFils, 8500);
    const list = await call(ordersHandler, { cookie: cookieA });
    assert.equal(list.json.orders.length, 1);
    assert.equal(list.json.user.email, 'a@example.test');
    const patched = await call(ordersHandler, { method: 'PATCH', cookie: cookieA, body: { id: orderId, status: 'with_driver' } });
    assert.equal(patched.json.order.status, 'with_driver');
    const badStatus = await call(ordersHandler, { method: 'PATCH', cookie: cookieA, body: { id: orderId, status: { $ne: 1 } } });
    assert.equal(badStatus.statusCode, 400);
    const badJson = await call(ordersHandler, { method: 'POST', cookie: cookieA, body: '{oops' });
    assert.equal(badJson.statusCode, 400);
  });

  test('a second seller cannot read, change or delete the first seller\'s order', async () => {
    const res = await call(authHandler, {
      method: 'POST', body: { action: 'signup', shopName: 'متجر ب', email: 'b@example.test', password: 'secret456' },
    });
    cookieB = res.cookie;
    const list = await call(ordersHandler, { cookie: cookieB });
    assert.deepEqual(list.json.orders, []);
    assert.equal((await call(ordersHandler, { method: 'PATCH', cookie: cookieB, body: { id: orderId, status: 'paid' } })).statusCode, 404);
    assert.equal((await call(ordersHandler, { method: 'DELETE', cookie: cookieB, body: { id: orderId } })).statusCode, 404);
    const mine = await call(ordersHandler, { cookie: cookieA });
    assert.equal(mine.json.orders[0].status, 'with_driver');
  });

  test('delete, then logout ends the session', async () => {
    const del = await call(ordersHandler, { method: 'DELETE', cookie: cookieA, body: { id: orderId } });
    assert.equal(del.statusCode, 200);
    const out = await call(authHandler, { method: 'POST', cookie: cookieA, body: { action: 'logout' } });
    assert.equal(out.statusCode, 200);
    assert.match(out.headers['set-cookie'], /Max-Age=0/);
    assert.equal((await call(ordersHandler, { cookie: cookieA })).statusCode, 401);
  });

  test('Vercel-style bodies: oversized pre-parsed body → 413, malformed JSON getter → 400', async () => {
    const big = fakeReq({ method: 'POST', body: {} });
    big.body = { action: 'login', email: `a@${'.a'.repeat(20000)}@`, password: 'x' };
    const r1 = fakeRes();
    await authHandler(big, r1);
    assert.equal(r1.statusCode, 413);
    const broken = fakeReq({ method: 'POST', body: {} });
    Object.defineProperty(broken, 'body', { get() { throw new SyntaxError('Unexpected token'); } });
    const r2 = fakeRes();
    await authHandler(broken, r2);
    assert.equal(r2.statusCode, 400);
    const declared = await call(authHandler, { method: 'POST', headers: { 'content-length': '999999' }, body: { action: 'login' } });
    assert.equal(declared.statusCode, 413);
  });

  test('logout clears the cookie even when the database is down', async () => {
    const restore = async () => createStore(ctx.db);
    setStoreFactory(async () => { throw new Error('db down'); });
    try {
      const res = await call(authHandler, { method: 'POST', cookie: cookieB, body: { action: 'logout' } });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['set-cookie'], /Max-Age=0/);
    } finally {
      setStoreFactory(restore);
    }
  });

  test('unknown methods are refused', async () => {
    assert.equal((await call(ordersHandler, { method: 'PUT', cookie: cookieB, body: {} })).statusCode, 405);
    assert.equal((await call(authHandler, { method: 'DELETE' })).statusCode, 405);
  });
});
