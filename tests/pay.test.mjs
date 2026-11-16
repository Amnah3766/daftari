// Customer payment link (/api/pay): built-in test gateway + Stripe test mode (with a fake Stripe), on a throw-away DB.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { ordersHandler, authHandler, payHandler, setStoreFactory } from '../lib/handlers.js';
import { keyStatus, paymentMode, setStripeFetch, toChargeAmount } from '../lib/stripe.js';
import { fakeReq, fakeRes, loadEnv, tempDb } from './helpers.mjs';

const hasDb = loadEnv();
// Key-shaped strings are built at run time, so no literal key ever sits in the repository.
const fakeKey = (mode) => ['sk', mode, 'Fake0123456789abcdefXYZ'].join('_');

async function call(handler, opts) {
  const res = fakeRes();
  await handler(fakeReq(opts), res);
  return res;
}

describe('payment link', { skip: !hasDb && 'MONGODB_URI not set' }, () => {
  let ctx;
  let db;
  let cookie;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  before(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    ctx = await tempDb('pay');
    db = ctx.db;
    const store = createStore(db);
    setStoreFactory(async () => store);
    const res = await call(authHandler, {
      method: 'POST', body: { action: 'signup', shopName: 'حلويات أم محمد', email: 'pay@example.test', password: 'secret123' },
    });
    cookie = res.cookie;
  });
  after(async () => {
    setStripeFetch(null);
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
    await ctx?.cleanup();
  });

  const addOrder = async (method, price = '12.500') => {
    const res = await call(ordersHandler, {
      method: 'POST', cookie, body: { customerName: 'نورة العلي', customerPhone: '55512345', item: 'بوكس شوكولاتة', price, cost: '5', method },
    });
    assert.equal(res.statusCode, 201);
    return res.json.order;
  };
  const list = async () => (await call(ordersHandler, { cookie })).json.orders;
  const pay = (body, headers) => call(payHandler, { method: 'POST', body, headers });
  const callGet = async (t) => {
    const res = fakeRes();
    const req = fakeReq({});
    req.url = t === undefined ? '/api/pay' : `/api/pay?t=${encodeURIComponent(t)}`;
    await payHandler(req, res);
    return res;
  };

  let linkOrder;

  test('a «رابط دفع» order gets its own payment token; cash and transfer orders do not', async () => {
    linkOrder = await addOrder('link');
    assert.match(linkOrder.payToken, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await addOrder('cash_driver')).payToken, null);
    assert.equal((await addOrder('transfer')).payToken, null);
    const other = await addOrder('link');
    assert.notEqual(other.payToken, linkOrder.payToken);
  });

  test('GET /api/pay without a Stripe key → test mode; the page shows the order but no phone, cost or profit', async () => {
    assert.equal(paymentMode(), 'test');
    const res = await callGet(linkOrder.payToken);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.mode, 'test');
    assert.deepEqual(Object.keys(res.json.order).sort(), ['customerName', 'item', 'paidAt', 'payFailedAt', 'priceFils', 'shopName', 'status']);
    assert.equal(res.json.order.shopName, 'حلويات أم محمد');
    assert.equal(res.json.order.priceFils, 12500);
    assert.equal(res.json.order.status, 'unpaid');
    assert.ok(!res.body.includes('965'), 'no phone number');
    assert.equal((await callGet()).json.mode, 'test');
  });

  test('a wrong or malformed token → 404 with an Arabic message', async () => {
    assert.equal((await callGet('A'.repeat(32))).statusCode, 404);
    assert.equal((await callGet('short')).statusCode, 404);
    assert.equal((await callGet('$where')).statusCode, 404);
    assert.equal((await pay({ action: 'test', t: 'B'.repeat(32), outcome: 'success' })).statusCode, 404);
    assert.match((await callGet('A'.repeat(32))).json.message, /رابط الدفع/);
  });

  test('write calls must be same-site JSON', async () => {
    const plain = await call(payHandler, {
      method: 'POST', body: JSON.stringify({ action: 'test', t: linkOrder.payToken, outcome: 'success' }), headers: { 'content-type': 'text/plain' },
    });
    assert.equal(plain.statusCode, 415);
    const foreign = await pay({ action: 'test', t: linkOrder.payToken, outcome: 'success' }, { origin: 'https://evil.example' });
    assert.equal(foreign.statusCode, 403);
    assert.equal((await pay({ action: 'test', t: linkOrder.payToken, outcome: 'maybe' })).statusCode, 400);
    assert.equal((await pay({ action: 'nope', t: linkOrder.payToken })).statusCode, 400);
    assert.equal((await list()).find((o) => o.id === linkOrder.id).status, 'unpaid');
  });

  test('declined card → stays «ما دفع» and the seller sees the failed try', async () => {
    const res = await pay({ action: 'test', t: linkOrder.payToken, outcome: 'declined' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.result, 'declined');
    assert.equal(res.json.order.status, 'unpaid');
    assert.ok(res.json.order.payFailedAt);
    const seen = (await list()).find((o) => o.id === linkOrder.id);
    assert.equal(seen.status, 'unpaid');
    assert.ok(seen.payFailedAt);
  });

  test('successful card → the order turns «وصلني» by itself (paid by link), and paying twice changes nothing', async () => {
    const res = await pay({ action: 'test', t: linkOrder.payToken, outcome: 'success' });
    assert.equal(res.json.result, 'paid');
    assert.equal(res.json.order.status, 'paid');
    const seen = (await list()).find((o) => o.id === linkOrder.id);
    assert.equal(seen.status, 'paid');
    assert.equal(seen.paidVia, 'link');
    assert.equal(seen.payFailedAt, null);
    assert.ok(seen.paidAt);
    const again = await pay({ action: 'test', t: linkOrder.payToken, outcome: 'success' });
    assert.equal(again.json.order.paidAt, seen.paidAt, 'paidAt is not moved');
    const lateDecline = await pay({ action: 'test', t: linkOrder.payToken, outcome: 'declined' });
    assert.equal(lateDecline.json.result, 'paid', 'a decline after paying does not undo it');
    const page = await callGet(linkOrder.payToken);
    assert.equal(page.json.order.status, 'paid');
  });

  test('the seller can still undo it by hand (then it no longer counts as paid by link)', async () => {
    const res = await call(ordersHandler, { method: 'PATCH', cookie, body: { id: linkOrder.id, status: 'unpaid' } });
    assert.equal(res.json.order.status, 'unpaid');
    assert.equal(res.json.order.paidVia, null);
    const manual = await call(ordersHandler, { method: 'PATCH', cookie, body: { id: linkOrder.id, status: 'paid' } });
    assert.equal(manual.json.order.paidVia, null, 'marked by hand');
  });

  test('a deleted order\'s link stops working', async () => {
    const o = await addOrder('link');
    await call(ordersHandler, { method: 'DELETE', cookie, body: { id: o.id } });
    assert.equal((await callGet(o.payToken)).statusCode, 404);
  });

  test('old «رابط دفع» orders (saved before links existed) get a token when the seller opens the list', async () => {
    const owner = (await db.collection('orders').findOne({ _id: { $exists: true } })).owner;
    const t = new Date();
    const { insertedId } = await db.collection('orders').insertOne({
      owner, customerName: 'قديم', customerPhone: '96555512345', item: 'قديم', priceFils: 5000, costFils: 0,
      method: 'link', status: 'unpaid', createdAt: t, updatedAt: t, paidAt: null,
    });
    const seen = (await list()).find((o) => o.id === String(insertedId));
    assert.match(seen.payToken, /^[A-Za-z0-9_-]{32}$/);
    const stored = await db.collection('orders').findOne({ _id: insertedId });
    assert.equal(stored.payToken, seen.payToken);
    assert.equal((await list()).find((o) => o.id === String(insertedId)).payToken, seen.payToken, 'stable');
  });

  test('cancel (back from Stripe without paying) → a failed attempt, order stays unpaid', async () => {
    const o = await addOrder('link');
    const res = await pay({ action: 'cancel', t: o.payToken });
    assert.equal(res.json.result, 'declined');
    assert.equal(res.json.order.status, 'unpaid');
  });

  describe('Stripe test mode (fake Stripe)', () => {
    let o;
    let created;
    const requests = [];
    let sessionReply;
    before(async () => {
      process.env.STRIPE_SECRET_KEY = fakeKey('test');
      setStripeFetch(async (url, init) => {
        requests.push({ url, init });
        if (init.method === 'POST') {
          created = new URLSearchParams(init.body);
          return Response.json({ id: 'cs_test_abcdefghijklmnop', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_abcdefghijklmnop' });
        }
        return Response.json(sessionReply);
      });
      o = await addOrder('link', '12.500');
    });

    test('live keys are refused; a test key switches the page to Stripe', () => {
      assert.equal(keyStatus(fakeKey('live')), 'live');
      assert.equal(keyStatus('not-a-key'), 'malformed');
      assert.equal(keyStatus(` "${fakeKey('test')}" `), 'ready');
      assert.equal(paymentMode(), 'stripe');
    });

    test('checkout → a Stripe page for exactly this order (USD at 3.25, token in metadata, back to /pay)', async () => {
      const res = await pay({ action: 'checkout', t: o.payToken }, { 'x-forwarded-proto': 'https', host: 'daftari.example' });
      assert.equal(res.statusCode, 200);
      assert.match(res.json.url, /^https:\/\/checkout\.stripe\.com\//);
      assert.equal(requests[0].init.headers.Authorization, `Bearer ${fakeKey('test')}`);
      assert.equal(created.get('line_items[0][price_data][currency]'), 'usd');
      assert.equal(created.get('line_items[0][price_data][unit_amount]'), String(toChargeAmount(12500, 'usd')));
      assert.equal(toChargeAmount(12500, 'usd'), 4063);
      assert.equal(created.get('metadata[payToken]'), o.payToken);
      assert.equal(created.get('metadata[orderId]'), o.id);
      assert.equal(created.get('success_url'), `https://daftari.example/pay?t=${o.payToken}&session_id={CHECKOUT_SESSION_ID}`);
      assert.equal(created.get('cancel_url'), `https://daftari.example/pay?t=${o.payToken}&canceled=1`);
      assert.ok(!res.body.includes('sk_'), 'the key never reaches the browser');
    });

    test('the test-card shortcut is closed when Stripe is on', async () => {
      assert.equal((await pay({ action: 'test', t: o.payToken, outcome: 'success' })).statusCode, 409);
    });

    test('confirm: an unpaid or mismatched session does NOT mark the order paid', async () => {
      const base = {
        id: 'cs_test_abcdefghijklmnop', object: 'checkout.session', livemode: false, currency: 'usd', amount_total: 4063,
        metadata: { payToken: o.payToken, orderId: o.id, priceFils: '12500', currency: 'usd', amount: '4063' },
      };
      for (const reply of [
        { ...base, payment_status: 'unpaid' },
        { ...base, payment_status: 'paid', amount_total: 100 },
        { ...base, payment_status: 'paid', metadata: { ...base.metadata, payToken: 'C'.repeat(32) } },
        { ...base, payment_status: 'paid', livemode: true },
      ]) {
        sessionReply = reply;
        const res = await pay({ action: 'confirm', t: o.payToken, sessionId: 'cs_test_abcdefghijklmnop' });
        assert.equal(res.json.result, 'not_paid');
      }
      assert.equal((await pay({ action: 'confirm', t: o.payToken, sessionId: '../x' })).statusCode, 400);
      assert.equal((await list()).find((x) => x.id === o.id).status, 'unpaid');
    });

    test('confirm: a paid session for this order → «وصلني» by itself', async () => {
      sessionReply = {
        id: 'cs_test_abcdefghijklmnop', object: 'checkout.session', livemode: false, payment_status: 'paid', currency: 'usd', amount_total: 4063,
        metadata: { payToken: o.payToken, orderId: o.id, priceFils: '12500', currency: 'usd', amount: '4063' },
      };
      const res = await pay({ action: 'confirm', t: o.payToken, sessionId: 'cs_test_abcdefghijklmnop' });
      assert.equal(res.json.result, 'paid');
      const seen = (await list()).find((x) => x.id === o.id);
      assert.equal(seen.status, 'paid');
      assert.equal(seen.paidVia, 'link');
    });

    test('Stripe down → a calm Arabic message, never a stack trace or the key', async () => {
      setStripeFetch(async () => Response.json({ error: { type: 'api_error' } }, { status: 500 }));
      const fresh = await addOrder('link');
      const res = await pay({ action: 'checkout', t: fresh.payToken });
      assert.equal(res.statusCode, 502);
      assert.match(res.json.message, /بوابة الدفع/);
      assert.ok(!res.body.includes('sk_'));
    });
  });
});
