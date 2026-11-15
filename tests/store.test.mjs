// Runs against a throw-away database on the real Atlas cluster (skipped when MONGODB_URI is missing).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { loadEnv, tempDb } from './helpers.mjs';

const hasDb = loadEnv();

describe('store (MongoDB)', { skip: !hasDb && 'MONGODB_URI not set' }, () => {
  let ctx;
  let store;
  let clock = new Date('2026-11-15T09:00:00Z');
  before(async () => {
    ctx = await tempDb('store');
    store = createStore(ctx.db, { now: () => clock });
  });
  after(async () => ctx?.cleanup());

  const order = (extra = {}) => ({
    customerName: 'أم محمد', customerPhone: '55512345', item: 'بوكس شوكولاتة', price: '12.500', cost: '5', method: 'cash_driver', ...extra,
  });

  test('signup creates a user + session, password is hashed, email unique', async () => {
    const { user, token } = await store.signup({ shopName: 'حلويات نورة', email: 'Noura@Example.test', password: 'secret123' });
    assert.equal(user.email, 'noura@example.test');
    assert.equal(user.shopName, 'حلويات نورة');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const raw = await ctx.db.collection('users').findOne({ email: 'noura@example.test' });
    assert.ok(raw.passwordHash.startsWith('scrypt$'));
    assert.ok(!raw.passwordHash.includes('secret123'));
    const s = await ctx.db.collection('sessions').findOne({});
    assert.notEqual(s.tokenHash, token, 'only the hash of the token is stored');
    await assert.rejects(store.signup({ shopName: 'ثاني', email: 'noura@example.test', password: 'another123' }), { code: 'email_taken' });
    assert.deepEqual((await store.sessionUser(token)).email, 'noura@example.test');
  });

  test('signup rejects bad input', async () => {
    await assert.rejects(store.signup({ shopName: 'x', email: 'bad', password: '1' }), { code: 'invalid', status: 400 });
  });

  test('login: right password works, wrong one fails, 5 fails lock the account', async () => {
    await store.signup({ shopName: 'عطور', email: 'lock@example.test', password: 'rightpass1' });
    const ok = await store.login({ email: 'LOCK@example.test', password: 'rightpass1' });
    assert.equal(ok.user.email, 'lock@example.test');
    await assert.rejects(store.login({ email: 'nobody@example.test', password: 'whatever1' }), { code: 'bad_credentials', status: 401 });
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(store.login({ email: 'lock@example.test', password: 'wrongpass' }), { code: 'bad_credentials' });
    }
    await assert.rejects(store.login({ email: 'lock@example.test', password: 'rightpass1' }), { code: 'locked', status: 429 });
    clock = new Date(clock.getTime() + 16 * 60000);
    const again = await store.login({ email: 'lock@example.test', password: 'rightpass1' });
    assert.equal(again.user.email, 'lock@example.test');
  });

  test('old wrong guesses never lock the owner out later', async () => {
    await store.signup({ shopName: 'قديم', email: 'later@example.test', password: 'rightpass3' });
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(store.login({ email: 'later@example.test', password: 'wrongpass' }), { code: i < 4 ? 'bad_credentials' : 'bad_credentials' });
    }
    const saved = clock;
    clock = new Date(clock.getTime() + 24 * 3600 * 1000); // a day later
    const ok = await store.login({ email: 'later@example.test', password: 'rightpass3' });
    assert.equal(ok.user.email, 'later@example.test', '5 wrong guesses yesterday must not lock today');
    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(store.login({ email: 'later@example.test', password: 'wrongpass' }), { code: 'bad_credentials' });
    }
    clock = new Date(clock.getTime() + 24 * 3600 * 1000);
    assert.equal((await store.login({ email: 'later@example.test', password: 'rightpass3' })).user.email, 'later@example.test');
    clock = saved;
  });

  test('parallel wrong guesses cannot get past the 5-attempt lock', async () => {
    await store.signup({ shopName: 'هجوم', email: 'burst@example.test', password: 'rightpass2' });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.login({ email: 'burst@example.test', password: 'wrongpass' })),
    );
    const codes = results.map((r) => r.reason?.code);
    assert.ok(codes.every((c) => c === 'bad_credentials' || c === 'locked'), codes.join(','));
    assert.ok(codes.filter((c) => c === 'bad_credentials').length <= 5, `at most 5 checked, got ${codes.join(',')}`);
    await assert.rejects(store.login({ email: 'burst@example.test', password: 'rightpass2' }), { code: 'locked' });
  });

  test('logout kills the session; expired or junk tokens give no user', async () => {
    const { token } = await store.login({ email: 'noura@example.test', password: 'secret123' });
    assert.ok(await store.sessionUser(token));
    await store.logout(token);
    assert.equal(await store.sessionUser(token), null);
    assert.equal(await store.sessionUser('junk'), null);
    assert.equal(await store.sessionUser(null), null);
    assert.equal(await store.sessionUser({ $ne: null }), null);
    const { token: t2 } = await store.login({ email: 'noura@example.test', password: 'secret123' });
    const saved = clock;
    clock = new Date(clock.getTime() + 31 * 24 * 3600 * 1000);
    assert.equal(await store.sessionUser(t2), null, 'session expires after 30 days');
    clock = saved;
  });

  test('orders: add, list newest first, status flow, delete', async () => {
    const { user } = await store.login({ email: 'noura@example.test', password: 'secret123' });
    const a = await store.addOrder(user.id, order());
    assert.equal(a.status, 'unpaid');
    assert.equal(a.priceFils, 12500);
    assert.equal(a.costFils, 5000);
    assert.equal(a.customerPhone, '96555512345');
    clock = new Date(clock.getTime() + 60000);
    const b = await store.addOrder(user.id, order({ customerName: 'سارة', method: 'link', cost: '' }));
    const list = await store.listOrders(user.id);
    assert.deepEqual(list.map((o) => o.id), [b.id, a.id]);

    const d = await store.setStatus(user.id, a.id, 'with_driver');
    assert.equal(d.status, 'with_driver');
    const p = await store.setStatus(user.id, a.id, 'paid');
    assert.equal(p.status, 'paid');
    assert.equal(p.prevStatus, 'with_driver', 'remembers where it came from (for undo)');
    assert.ok(p.paidAt);
    const back = await store.setStatus(user.id, a.id, 'with_driver');
    assert.equal(back.paidAt, null);
    // a cash order paid directly (driver step skipped) remembers «unpaid»
    const direct = await store.addOrder(user.id, order({ customerName: 'مباشر' }));
    const directPaid = await store.setStatus(user.id, direct.id, 'paid');
    assert.equal(directPaid.prevStatus, 'unpaid');
    assert.equal((await store.listOrders(user.id)).find((o) => o.id === direct.id).prevStatus, 'unpaid');
    await store.deleteOrder(user.id, direct.id);
    await assert.rejects(store.setStatus(user.id, b.id, 'with_driver'), { code: 'bad_status' });
    await assert.rejects(store.setStatus(user.id, b.id, 'refunded'), { code: 'bad_status' });
    await assert.rejects(store.setStatus(user.id, 'not-an-id', 'paid'), { code: 'bad_id' });
    await assert.rejects(store.addOrder(user.id, order({ price: '0' })), { code: 'invalid' });

    await store.deleteOrder(user.id, b.id);
    assert.equal((await store.listOrders(user.id)).length, 1);
    await assert.rejects(store.deleteOrder(user.id, b.id), { code: 'not_found', status: 404 });
  });

  test('one seller can never see or touch another seller\'s orders', async () => {
    const owner = (await store.login({ email: 'noura@example.test', password: 'secret123' })).user;
    const other = (await store.signup({ shopName: 'متجر ثاني', email: 'other@example.test', password: 'otherpass1' })).user;
    const mine = await store.addOrder(owner.id, order({ customerName: 'سري' }));
    assert.equal((await store.listOrders(other.id)).length, 0);
    await assert.rejects(store.setStatus(other.id, mine.id, 'paid'), { code: 'not_found' });
    await assert.rejects(store.deleteOrder(other.id, mine.id), { code: 'not_found' });
    const still = (await store.listOrders(owner.id)).find((o) => o.id === mine.id);
    assert.equal(still.status, 'unpaid');
  });
});
