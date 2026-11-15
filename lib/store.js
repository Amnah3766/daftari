// دفتري — data layer on MongoDB. createStore(db) holds all the rules so tests can run it against a
// throw-away database. Every order query is filtered by owner, so one seller never sees another's data.
import { ObjectId } from 'mongodb';
import {
  burnPasswordCheck, hashPassword, hashToken, newSessionToken, SESSION_DAYS, TOKEN_RE, verifyPassword,
} from './auth.js';
import {
  canSetStatus, STATUSES, validateLogin, validateOrder, validateSignup,
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
  ]);
}

const toUser = (u) => ({ id: String(u._id), email: u.email, shopName: u.shopName });

const toOrder = (o) => ({
  id: String(o._id),
  customerName: o.customerName,
  customerPhone: o.customerPhone,
  item: o.item,
  priceFils: o.priceFils,
  costFils: o.costFils,
  method: o.method,
  status: o.status,
  createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
  paidAt: o.paidAt instanceof Date ? o.paidAt.toISOString() : o.paidAt ?? null,
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
    const user = await users.findOne({ email });
    const wrong = () => new AppError(401, 'bad_credentials', 'الإيميل أو كلمة السر غلط');
    if (!user) {
      await burnPasswordCheck(password);
      throw wrong();
    }
    const t = now();
    if (user.lockUntil && user.lockUntil > t) {
      const mins = Math.max(1, Math.ceil((user.lockUntil - t) / 60000));
      throw new AppError(429, 'locked', `محاولات كثيرة غلط. جرّب بعد ${mins} دقيقة`);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      const fails = (user.failedLogins || 0) + 1;
      const set = fails >= MAX_FAILS
        ? { failedLogins: 0, lockUntil: new Date(t.getTime() + LOCK_MINUTES * 60000) }
        : { failedLogins: fails };
      await users.updateOne({ _id: user._id }, { $set: set });
      throw wrong();
    }
    if (user.failedLogins || user.lockUntil) {
      await users.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockUntil: null } });
    }
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

  async function listOrders(userId) {
    const list = await orders
      .find({ owner: new ObjectId(userId) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_ORDERS_LISTED)
      .toArray();
    return list.map(toOrder);
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
    const set = { status, updatedAt: t, paidAt: status === 'paid' ? (order.paidAt || t) : null };
    await orders.updateOne({ _id, owner }, { $set: set });
    return toOrder({ ...order, ...set });
  }

  async function deleteOrder(userId, orderId) {
    const _id = toObjectId(orderId);
    const { deletedCount } = await orders.deleteOne({ _id, owner: new ObjectId(userId) });
    if (!deletedCount) throw new AppError(404, 'not_found', 'الطلب مو موجود');
    return { id: orderId };
  }

  return { signup, login, sessionUser, logout, listOrders, addOrder, setStatus, deleteOrder };
}
