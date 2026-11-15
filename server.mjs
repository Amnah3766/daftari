// دفتري local server: serves public/ and the same /api handlers Vercel runs (api/auth.js, api/orders.js).
// Reads MONGODB_URI (and optional DNS_SERVERS) from the environment or from .env.local.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(root, 'public');

try {
  const text = await readFile(join(root, '.env.local'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {
  // no .env.local — settings come from the environment
}

const { authHandler, ordersHandler } = await import('./lib/handlers.js');
const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const HEADERS = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const API = { '/api/auth': authHandler, '/api/orders': ordersHandler };

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }
  if (API[pathname]) {
    await API[pathname](req, res);
    return;
  }
  if (pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'not_found', message: 'مو موجود' }));
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(publicDir, `.${pathname}`);
  if (!file.startsWith(publicDir + sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

const port = Number(process.env.PORT) || 5320;
server.listen(port, '127.0.0.1', () => console.log(`دفتري running on http://localhost:${port}`));
