// Quick Atlas connectivity check (reads .env.local). Prints no secrets.
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import { MongoClient } from 'mongodb';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(','));
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
const t = Date.now();
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'daftari');
  await db.command({ ping: 1 });
  const cols = await db.listCollections().toArray();
  console.log('ok ping', Date.now() - t, 'ms; collections:', cols.map((c) => c.name));
} catch (e) {
  console.log('FAIL', e.name, e.message.slice(0, 200));
} finally {
  await client.close();
}
