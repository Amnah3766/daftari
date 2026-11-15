// Live smoke test: node scripts/smoke.mjs https://your-site.vercel.app
// Creates two throw-away sellers (@example.test), runs the whole flow, checks they can't see each
// other's orders, deletes the orders and signs out. Prints PASS/FAIL per step. No secrets needed.
const base = (process.argv[2] || 'http://localhost:5320').replace(/\/$/, '');
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let failed = 0;

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) failed += 1;
}

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const set = res.headers.get('set-cookie');
  return { status: res.status, json, cookie: set ? set.split(';')[0] : null, setCookie: set, res };
}

const page = await fetch(base + '/');
const html = await page.text();
check('home page loads', page.status === 200 && html.includes('دفتري'), String(page.status));
check('security headers', Boolean(page.headers.get('content-security-policy')) && page.headers.get('x-frame-options') === 'DENY');
for (const f of ['/app.js', '/logic.js', '/styles.css', '/favicon.svg']) {
  const r = await fetch(base + f);
  check(`asset ${f}`, r.status === 200, String(r.status));
}

const anon = await call('/api/auth');
check('GET /api/auth (signed out) → user null', anon.status === 200 && anon.json?.user === null, `${anon.status} ${JSON.stringify(anon.json)}`);
check('orders need a session', (await call('/api/orders')).status === 401);

const pass = `Smoke-${stamp}-pw`;
const a = await call('/api/auth', { method: 'POST', body: { action: 'signup', shopName: 'فحص أ', email: `smoke-a-${stamp}@example.test`, password: pass } });
check('signup A', a.status === 201 && Boolean(a.cookie), String(a.status));
check('cookie is HttpOnly + Secure on https', !base.startsWith('https') || (/HttpOnly/.test(a.setCookie || '') && /Secure/.test(a.setCookie || '')));
const b = await call('/api/auth', { method: 'POST', body: { action: 'signup', shopName: 'فحص ب', email: `smoke-b-${stamp}@example.test`, password: pass } });
check('signup B', b.status === 201 && Boolean(b.cookie), String(b.status));

const created = await call('/api/orders', {
  method: 'POST', cookie: a.cookie,
  body: { customerName: 'زبون فحص', customerPhone: '55512345', item: 'بوكس', price: '12.500', cost: '5', method: 'cash_driver' },
});
check('A adds an order (saved in MongoDB)', created.status === 201 && created.json?.order?.priceFils === 12500, String(created.status));
const id = created.json?.order?.id;

const listA = await call('/api/orders', { cookie: a.cookie });
check('A sees the order', listA.json?.orders?.some((o) => o.id === id));
const listB = await call('/api/orders', { cookie: b.cookie });
check('B does NOT see A\'s order', Array.isArray(listB.json?.orders) && !listB.json.orders.some((o) => o.id === id));
check('B cannot change A\'s order', (await call('/api/orders', { method: 'PATCH', cookie: b.cookie, body: { id, status: 'paid' } })).status === 404);
check('B cannot delete A\'s order', (await call('/api/orders', { method: 'DELETE', cookie: b.cookie, body: { id } })).status === 404);

const d = await call('/api/orders', { method: 'PATCH', cookie: a.cookie, body: { id, status: 'with_driver' } });
check('status → with driver', d.json?.order?.status === 'with_driver');
const p = await call('/api/orders', { method: 'PATCH', cookie: a.cookie, body: { id, status: 'paid' } });
check('status → paid', p.json?.order?.status === 'paid' && p.json?.order?.prevStatus === 'with_driver');

check('CSRF: form post refused', (await call('/api/orders', { method: 'POST', cookie: a.cookie, headers: { 'Content-Type': 'text/plain' }, body: undefined })).status === 415);
const foreign = await fetch(base + '/api/orders', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: a.cookie }, body: '{}',
});
check('CSRF: foreign origin refused', foreign.status === 403, String(foreign.status));
const wrong = await call('/api/auth', { method: 'POST', body: { action: 'login', email: `smoke-a-${stamp}@example.test`, password: 'wrong-password' } });
check('wrong password refused', wrong.status === 401);

check('A deletes the order', (await call('/api/orders', { method: 'DELETE', cookie: a.cookie, body: { id } })).status === 200);
for (const s of [a, b]) {
  const out = await call('/api/auth', { method: 'POST', cookie: s.cookie, body: { action: 'logout' } });
  check('logout', out.status === 200);
}
check('session gone after logout', (await call('/api/orders', { cookie: a.cookie })).status === 401);

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
