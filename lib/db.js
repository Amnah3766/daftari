// MongoDB Atlas connection, cached across serverless invocations (one client per warm instance).
import dns from 'node:dns';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from './store.js';

let clientPromise = null;
let indexesPromise = null;

/**
 * Local only: some home networks break DNS lookups for Atlas (SRV and host names).
 * With DNS_SERVERS set, both go through those public resolvers. Vercel never sets DNS_SERVERS.
 */
export function localDnsOptions() {
  const servers = String(process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!servers.length) return {};
  dns.setServers(servers);
  const resolver = new dns.Resolver();
  resolver.setServers(servers);
  const lookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    resolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses?.length) return dns.lookup(hostname, opts, cb);
      if (opts.all) return cb(null, addresses.map((address) => ({ address, family: 4 })));
      return cb(null, addresses[0], 4);
    });
  };
  return { lookup };
}

export async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    const err = new Error('MONGODB_URI is not set');
    err.code = 'missing_env';
    throw err;
  }
  if (!clientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5, ...localDnsOptions() });
    clientPromise = client.connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  const client = await clientPromise;
  const db = client.db(process.env.MONGODB_DB || 'daftari');
  if (!indexesPromise) {
    indexesPromise = ensureIndexes(db).catch((err) => {
      indexesPromise = null;
      throw err;
    });
  }
  await indexesPromise;
  return db;
}
