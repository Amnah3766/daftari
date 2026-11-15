// Test helpers: a throw-away Atlas database (dropped after the run) and fake req/res objects.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from '../lib/store.js';
import { localDnsOptions } from '../lib/db.js';

export function loadEnv() {
  try {
    const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // no .env.local
  }
  return Boolean(process.env.MONGODB_URI);
}

export async function tempDb(tag) {
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, ...localDnsOptions() });
  await client.connect();
  const name = `daftari_test_${tag}_${process.pid}`;
  const db = client.db(name);
  await ensureIndexes(db);
  return {
    db,
    async cleanup() {
      if (!name.startsWith('daftari_test_')) throw new Error('refusing to drop a non-test database');
      await db.dropDatabase();
      await client.close();
    },
  };
}

export function fakeReq({ method = 'GET', body, headers = {}, cookie } = {}) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { host: 'localhost:5320', ...headers };
  if (body !== undefined && !('content-type' in req.headers)) req.headers['content-type'] = 'application/json';
  if (cookie) req.headers.cookie = cookie;
  req.socket = {};
  return req;
}

export function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b) {
      this.body = b === undefined ? '' : String(b);
    },
    get json() {
      return this.body ? JSON.parse(this.body) : null;
    },
    get cookie() {
      const c = this.headers['set-cookie'];
      return c ? c.split(';')[0] : null;
    },
  };
  return res;
}
