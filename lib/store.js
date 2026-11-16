// دفتري — data layer on MongoDB. createStore(db) holds all the rules so tests can run it against a
// throw-away database. Every order query is filtered by owner, so one seller never sees another's data.
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  burnPasswordCheck, hashPassword, hashToken, newSessionToken, SESSION_DAYS, TOKEN_RE, verifyPassword,
} from './auth.js';
import {
  canSetStatus, PAY_TOKEN_RE, STATUSES, validateLogin, validateOrder, validateSignup,
} from '../public/logic.js';

export class AppError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const bad = (code, message, fields) => new AppError(400, code, message, fields);
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_ORDERS_LISTED = 1000;
const MAX_ORDERS_PER_USER = 5000;

export async function ensureIndexes(db) {
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('orders').createIndex({ owner: 1, createdAt: -1 }),
    // Customer payment links: one secret token per «رابط دفع» order.
    db.collection('orders').createIndex(
      { payToken: 1 },
      { unique: true, partialFilterExpression: { payToken: { $type: 'string' } } },
    ),
  ]);
}

const toUser = (u) => ({ id: String(u._id), email: u.email, shopName: u.shopName });

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
export const newPayToken = () => randomBytes(24).toString('base64url');

const toOrder = (o) => ({
  id: String(o._id),
  customerName: o.customerName,
  customerPhone: o.customerPhone,
  item: o.item,
  priceFils: o.priceFils,
  costFils: o.costFils,
  method: o.method,
  status: o.status,
  prevStatus: o.prevStatus ?? null,
  createdAt: iso(o.createdAt),
  paidAt: iso(o.paidAt),
  // «رابط دفع» orders: the customer's payment link token, how the money arrived, and the last failed attempt.
  payToken: o.method === 'link' ? o.payToken ?? null : null,
  paidVia: o.status === 'paid' ? o.paidVia ?? null : null,
  payFailedAt: o.status === 'paid' ? null : iso(o.payFailedAt),
});

/** What the customer sees on the payment page (no phone, no cost, no profit). */
const toPayInfo = (o, shopName) => ({
  shopName: shopName || '',
  customerName: o.customerName,
  item: o.item,
  priceFils: o.priceFils,
  status: o.status === 'paid' ? 'paid' : 'unpaid',
  paidAt: o.status === 'paid' ? iso(o.paidAt) : null,
  payFailedAt: o.status === 'paid' ? null : iso(o.payFailedAt),
});

function toObjectId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id)) throw bad('bad_id', 'الطلب مو موجود');
  return new ObjectId(id);
}

export function createStore(db, { now = () => new Date() } = {}) {
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const orders = db.collection('orders');

  async function startSession(userId) {
    const token = newSessionToken();
    const created = now();
    await sessions.insertOne({
      tokenHash: hashToken(token),
      userId,
      createdAt: created,
      expiresAt: new Date(created.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000),
    });
    return token;
  }

  async function signup(input) {
    const v = validateSignup(input);
    if (!v.ok) throw bad('invalid', 'راجع الخانات', v.errors);
    const { shopName, email, password } = v.value;
    const doc = {
      email,
      shopName,
      passwordHash: await hashPassword(password),
      failedLogins: 0,
      lockUntil: null,
      createdAt: now(),
    };
    try {
      const { insertedId } = await users.insertOne(doc);
      doc._id = insertedId;
    } catch (err) {
      if (err?.code === 11000) {
        throw bad('email_taken', 'هذا الإيميل مسجل من قبل، سجّل دخول', { email: 'الإيميل مسجل من قبل' });
      }
      throw err;
    }
    return { user: toUser(doc), token: await startSession(doc._id) };
  }

  async function login(input) {
    const v = validateLogin(input);
    if (!v.ok) throw bad('invalid', 'راجع الخانات', v.errors);
    const { email, password } = v.value;
    const existing = await users.findOne({ email }, { projection: { _id: 1 } });
    const wrong = () => new AppError(401, 'bad_credentials', 'الإيميل أو كلمة السر غلط');
    if (!existing) {
      await burnPasswordCheck(password);
      throw wrong();
    }
    const t = now();
    const lockedError = (until) => {
      const mins = Math.max(1, Math.ceil((until - t) / 60000));
      return new AppError(429, 'locked', `محاولات كثيرة غلط. جرّب بعد ${mins} دقيقة`);
    };
    // Reserve this attempt atomically BEFORE checking the password, so parallel guesses can't share one count.
    const user = await users.findOneAndUpdate(
      { _id: existing._id, $or: [{ lockUntil: null }, { lockUntil: { $lte: t } }] },
      { $inc: { failedLogins: 1 } },
      { returnDocument: 'after' },
    );
    if (!user) {
      const locked = await users.findOne({ _id: existing._id }, { projection: { lockUntil: 1 } });
      throw lockedError(locked?.lockUntil || new Date(t.getTime() + LOCK_MINUTES * 60000));
    }
    if (user.failedLogins > MAX_FAILS) {
      const until = new Date(t.getTime() + LOCK_MINUTES * 60000);
      await users.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockUntil: until } });
      throw lockedError(until);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      // The 5th wrong password locks right away (and resets the count), so the owner's next try after the
      // lock ends starts fresh — a stranger can't "arm" an account to lock its owner days later.
      if (user.failedLogins >= MAX_FAILS) {
        await users.updateOne(
          { _id: user._id },
          { $set: { failedLogins: 0, lockUntil: new Date(t.getTime() + LOCK_MINUTES * 60000) } },
        );
      }
      throw wrong();
    }
    await users.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockUntil: null } });
    return { user: toUser(user), token: await startSession(user._id) };
  }

  async function sessionUser(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const s = await sessions.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: now() } });
    if (!s) return null;
    const u = await users.findOne({ _id: s.userId });
    return u ? toUser(u) : null;
  }

  async function logout(token) {
    if (typeof token === 'string' && TOKEN_RE.test(token)) {
      await sessions.deleteOne({ tokenHash: hashToken(token) });
    }
  }

  /** Every open order (unpaid / with driver) + the newest paid ones, newest first. */
  async function listOrders(userId) {
    const owner = new ObjectId(userId);
    const newest = { createdAt: -1, _id: -1 };
    const [open, paid] = await Promise.all([
      orders.find({ owner, status: { $ne: 'paid' } }).sort(newest).limit(MAX_ORDERS_PER_USER).toArray(),
      orders.find({ owner, status: 'paid' }).sort(newest).limit(MAX_ORDERS_LISTED).toArray(),
    ]);
    // An order whose status flips between the two reads could appear in both → keep one copy per id.
    const unique = [...new Map([...open, ...paid].map((o) => [String(o._id), o])).values()];
    // Orders saved before payment links existed get their token the first time the seller opens the list.
    await Promise.all(unique.filter((o) => o.method === 'link' && !o.payToken).map(async (o) => {
      const token = newPayToken();
      const r = await orders.updateOne({ _id: o._id, owner, payToken: { $exists: false } }, { $set: { payToken: token } });
      o.payToken = r.modifiedCount ? token : (await orders.findOne({ _id: o._id }, { projection: { payToken: 1 } }))?.payToken;
    }));
    return unique
      .sort((a, b) => b.createdAt - a.createdAt || (String(b._id) > String(a._id) ? 1 : -1))
      .map(toOrder);
  }

  async function addOrder(userId, input) {
    const v = validateOrder(input);
    if (!v.ok) throw bad('invalid', 'راجع الخانات', v.errors);
    const owner = new ObjectId(userId);
    if ((await orders.countDocuments({ owner }, { limit: MAX_ORDERS_PER_USER })) >= MAX_ORDERS_PER_USER) {
      throw bad('too_many', 'وصلت الحد الأقصى للطلبات');
    }
    const t = now();
    const doc = { owner, ...v.value, status: 'unpaid', createdAt: t, updatedAt: t, paidAt: null };
    if (doc.method === 'link') doc.payToken = newPayToken();
    const { insertedId } = await orders.insertOne(doc);
    doc._id = insertedId;
    return toOrder(doc);
  }

  async function setStatus(userId, orderId, status) {
    const _id = toObjectId(orderId);
    if (typeof status !== 'string' || !Object.hasOwn(STATUSES, status)) throw bad('bad_status', 'حالة غير معروفة');
    const owner = new ObjectId(userId);
    const order = await orders.findOne({ _id, owner });
    if (!order) throw new AppError(404, 'not_found', 'الطلب مو موجود');
    if (!canSetStatus(order, status)) throw bad('bad_status', '«عند المندوب» بس للطلبات اللي دفعها كاش مع المندوب');
    const t = now();
    const set = {
      status,
      prevStatus: status === order.status ? order.prevStatus ?? null : order.status,
      updatedAt: t,
      paidAt: status === 'paid' ? (order.paidAt || t) : null,
      // Marked by hand → not "paid by the link"; moved away from paid → the old link payment no longer counts.
      paidVia: status === 'paid' && order.status === 'paid' ? order.paidVia ?? null : null,
    };
    await orders.updateOne({ _id, owner }, { $set: set });
    return toOrder({ ...order, ...set });
  }

  async function deleteOrder(userId, orderId) {
    const _id = toObjectId(orderId);
    const { deletedCount } = await orders.deleteOne({ _id, owner: new ObjectId(userId) });
    if (!deletedCount) throw new AppError(404, 'not_found', 'الطلب مو موجود');
    return { id: orderId };
  }

  /* ---------- customer payment link (public: the token in the link is the only key) ---------- */

  async function orderByPayToken(token) {
    if (typeof token !== 'string' || !PAY_TOKEN_RE.test(token)) return null;
    return orders.findOne({ payToken: token, method: 'link' });
  }

  async function payOrder(token) {
    const order = await orderByPayToken(token);
    if (!order) throw new AppError(404, 'not_found', 'رابط الدفع غير صحيح أو انحذف الطلب');
    const owner = await users.findOne({ _id: order.owner }, { projection: { shopName: 1 } });
    return { order, shopName: owner?.shopName || '' };
  }

  async function payInfo(token) {
    const { order, shopName } = await payOrder(token);
    return toPayInfo(order, shopName);
  }

  /** The customer paid: the order turns «وصلني» by itself. Safe to call twice (the second call changes nothing). */
  async function markPaidByLink(token, extra = {}) {
    const { order, shopName } = await payOrder(token);
    if (order.status !== 'paid') {
      const t = now();
      const set = {
        status: 'paid', prevStatus: order.status, paidAt: t, paidVia: 'link', payFailedAt: null, updatedAt: t, ...extra,
      };
      await orders.updateOne({ _id: order._id, status: { $ne: 'paid' } }, { $set: set });
    }
    return toPayInfo(await orders.findOne({ _id: order._id }), shopName);
  }

  /** A declined or cancelled attempt: the order stays «ما دفع», and the seller sees that a try failed. */
  async function recordPayFailure(token) {
    const { order, shopName } = await payOrder(token);
    if (order.status !== 'paid') {
      await orders.updateOne({ _id: order._id, status: { $ne: 'paid' } }, { $set: { payFailedAt: now() } });
    }
    return toPayInfo(await orders.findOne({ _id: order._id }), shopName);
  }

  async function setCheckoutSession(token, sessionId) {
    await orders.updateOne({ payToken: token, method: 'link' }, { $set: { stripeSessionId: sessionId } });
  }

  return {
    signup, login, sessionUser, logout, listOrders, addOrder, setStatus, deleteOrder,
    payOrder, payInfo, markPaidByLink, recordPayFailure, setCheckoutSession,
  };
}
