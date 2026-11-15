// Removes the throw-away test sellers (emails ending in @example.test) and their orders/sessions.
// Local only: node scripts/cleanup-test-users.mjs [prefix]   (reads MONGODB_URI from .env.local)
// With a prefix (e.g. "smoke-") only those test emails are removed.
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { localDnsOptions } from '../lib/db.js';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, ...localDnsOptions() });
await client.connect();
try {
  const db = client.db(process.env.MONGODB_DB || 'daftari');
  const prefix = (process.argv[2] || '').replace(/[^a-z0-9._-]/gi, '');
  const pattern = new RegExp(`^${prefix.replace(/[.]/g, '\\.')}.*@example\\.test$`);
  const testUsers = await db.collection('users').find({ email: pattern }, { projection: { _id: 1, email: 1 } }).toArray();
  const ids = testUsers.map((u) => u._id);
  const o = await db.collection('orders').deleteMany({ owner: { $in: ids } });
  const s = await db.collection('sessions').deleteMany({ userId: { $in: ids } });
  const u = await db.collection('users').deleteMany({ _id: { $in: ids } });
  console.log(`removed ${u.deletedCount} test users, ${o.deletedCount} orders, ${s.deletedCount} sessions`);
} finally {
  await client.close();
}
