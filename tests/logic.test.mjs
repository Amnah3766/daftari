import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canSetStatus, displayPhone, formatKWD, kuwaitMonthRange, nextActions, normalizePhone, parseAmount,
  reminderText, shortDate, summarize, toLatinDigits, validateLogin, validateOrder, validateSignup, waLink,
} from '../public/logic.js';

test('toLatinDigits converts Arabic-Indic and Persian digits and Arabic decimal mark', () => {
  assert.equal(toLatinDigits('١٢٫٥٠٠'), '12.500');
  assert.equal(toLatinDigits('۹۸'), '98');
  assert.equal(toLatinDigits('١٬٢٠٠'), '1,200', 'Arabic thousands mark becomes a comma (then validated)');
});

test('parseAmount → integer fils', () => {
  assert.deepEqual(parseAmount('12'), { ok: true, fils: 12000 });
  assert.deepEqual(parseAmount('12.5'), { ok: true, fils: 12500 });
  assert.deepEqual(parseAmount('0.125'), { ok: true, fils: 125 });
  assert.deepEqual(parseAmount('١٢٫٧٥'), { ok: true, fils: 12750 });
  assert.deepEqual(parseAmount(' 7 '), { ok: true, fils: 7000 });
  assert.deepEqual(parseAmount(3.5), { ok: true, fils: 3500 });
  assert.equal(parseAmount('0').ok, false);
  assert.deepEqual(parseAmount('0', { allowZero: true }), { ok: true, fils: 0 });
  // comma-decimal phone keyboards
  assert.deepEqual(parseAmount('12,5'), { ok: true, fils: 12500 });
  assert.deepEqual(parseAmount('12,25'), { ok: true, fils: 12250 });
  assert.deepEqual(parseAmount('١٢٬٥'), { ok: true, fils: 12500 });
  for (const bad of ['', 'abc', '1.2345', '-3', '1,250', '1,2,3', '1,5.2', '1e3', '.5', '12.', '1'.repeat(50), null, undefined, {}]) {
    assert.equal(parseAmount(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(parseAmount('100001').ok, false);
  assert.equal(parseAmount('100000').ok, true);
});

test('formatKWD always shows 3 decimals and thousands commas', () => {
  assert.equal(formatKWD(12500), '12.500 د.ك');
  assert.equal(formatKWD(0), '0.000 د.ك');
  assert.equal(formatKWD(1234567), '1,234.567 د.ك');
  assert.equal(formatKWD(-2250), '-2.250 د.ك');
  assert.equal(formatKWD(5, { unit: false }), '0.005');
});

test('normalizePhone handles Kuwaiti numbers in many shapes', () => {
  for (const input of ['55512345', '+965 5551 2345', '00965-55512345', '96555512345', '٥٥٥١٢٣٤٥', '(965) 5551-2345']) {
    assert.deepEqual(normalizePhone(input), { ok: true, digits: '96555512345' }, input);
  }
  // pasted from iPhone Contacts / WhatsApp: invisible direction marks, non-breaking spaces, Unicode dashes
  for (const input of ['‎+965 5551 2345‏', '‪5551–2345‬', '⁦٥٥٥١ ٢٣٤٥⁩']) {
    assert.deepEqual(normalizePhone(input), { ok: true, digits: '96555512345' }, JSON.stringify(input));
  }
  assert.deepEqual(normalizePhone('41234567'), { ok: true, digits: '96541234567' });
  assert.deepEqual(normalizePhone('+966 501234567'), { ok: true, digits: '966501234567' });
  for (const bad of ['', '1234', '05551234', '35551234', '9655551234', 'abc12345678', '0096512345678']) {
    assert.equal(normalizePhone(bad).ok, false, bad);
  }
  assert.equal(displayPhone('96555512345'), '+965 5551 2345');
});

test('WhatsApp reminder link encodes Arabic text', () => {
  const text = reminderText({ customerName: 'نورة', item: 'كيكة', priceFils: 8500, shopName: 'حلويات سارة' });
  assert.match(text, /نورة/);
  assert.match(text, /8\.500 د\.ك/);
  assert.match(text, /حلويات سارة/);
  const link = waLink('96555512345', text);
  assert.ok(link.startsWith('https://wa.me/96555512345?text='));
  assert.equal(decodeURIComponent(link.split('text=')[1]), text);
  assert.ok(!link.includes(' '));
});

test('kuwaitMonthRange uses Kuwait time (UTC+3)', () => {
  // 30 Nov 21:30 UTC is already 1 Dec 00:30 in Kuwait.
  const r = kuwaitMonthRange(new Date('2026-11-30T21:30:00Z'));
  assert.equal(r.label, 'ديسمبر 2026');
  assert.equal(r.start.toISOString(), '2026-11-30T21:00:00.000Z');
  assert.equal(r.end.toISOString(), '2026-12-31T21:00:00.000Z');
  const prev = kuwaitMonthRange(new Date('2026-01-10T10:00:00Z'), -1);
  assert.equal(prev.label, 'ديسمبر 2025');
  assert.equal(shortDate('2026-11-30T21:30:00Z'), '1 ديسمبر');
});

test('summarize: month sales/profit + outstanding unpaid and driver cash', () => {
  const range = kuwaitMonthRange(new Date('2026-11-15T12:00:00Z'));
  const orders = [
    { priceFils: 10000, costFils: 4000, status: 'paid', createdAt: '2026-11-02T10:00:00Z' },
    { priceFils: 5000, costFils: 2000, status: 'unpaid', createdAt: '2026-11-03T10:00:00Z' },
    { priceFils: 7000, costFils: 0, status: 'with_driver', createdAt: '2026-11-04T10:00:00Z' },
    { priceFils: 3000, costFils: 1000, status: 'unpaid', createdAt: '2026-10-20T10:00:00Z' }, // last month
  ];
  const s = summarize(orders, range);
  assert.equal(s.monthCount, 3);
  assert.equal(s.monthSales, 22000);
  assert.equal(s.profitPaid, 6000);
  assert.equal(s.profitAll, 16000);
  assert.equal(s.unpaidCount, 2);
  assert.equal(s.unpaid, 8000);
  assert.equal(s.driverCount, 1);
  assert.equal(s.driver, 7000);
});

test('nextActions and canSetStatus follow the payment method', () => {
  assert.deepEqual(nextActions({ status: 'unpaid', method: 'link' }).map((a) => a.to), ['paid']);
  assert.deepEqual(nextActions({ status: 'unpaid', method: 'cash_driver' }).map((a) => a.to), ['with_driver', 'paid']);
  assert.deepEqual(nextActions({ status: 'with_driver', method: 'cash_driver' }).map((a) => a.to), ['paid', 'unpaid']);
  // undo returns to where the order came from
  assert.deepEqual(nextActions({ status: 'paid', method: 'cash_driver', prevStatus: 'with_driver' }).map((a) => a.to), ['with_driver']);
  assert.deepEqual(nextActions({ status: 'paid', method: 'cash_driver', prevStatus: 'unpaid' }).map((a) => a.to), ['unpaid']);
  assert.deepEqual(nextActions({ status: 'paid', method: 'cash_driver' }).map((a) => a.to), ['unpaid']);
  assert.deepEqual(nextActions({ status: 'paid', method: 'transfer' }).map((a) => a.to), ['unpaid']);
  assert.equal(canSetStatus({ method: 'link' }, 'with_driver'), false);
  assert.equal(canSetStatus({ method: 'cash_driver' }, 'with_driver'), true);
  assert.equal(canSetStatus({ method: 'link' }, 'paid'), true);
  assert.equal(canSetStatus({ method: 'link' }, 'stolen'), false);
  assert.equal(canSetStatus({ method: 'link' }, '__proto__'), false);
});

test('validateOrder cleans input and reports every bad field', () => {
  const ok = validateOrder({
    customerName: '  أم   محمد ', customerPhone: '5551 2345', item: 'بوكس', price: '12.5', cost: '', method: 'cash_driver',
  });
  assert.deepEqual(ok, {
    ok: true,
    value: {
      customerName: 'أم محمد', customerPhone: '96555512345', item: 'بوكس', priceFils: 12500, costFils: 0, method: 'cash_driver',
    },
  });
  const bad = validateOrder({ customerName: '', customerPhone: '12', item: ' ', price: 'x', cost: '-1', method: 'bitcoin' });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['cost', 'customerName', 'customerPhone', 'item', 'method', 'price']);
  assert.equal(validateOrder({ customerName: 'x'.repeat(61), customerPhone: '55512345', item: 'a', price: '1', method: 'link' }).ok, false);
  assert.equal(validateOrder(null).ok, false);
  assert.equal(validateOrder({ customerName: { $gt: '' }, customerPhone: ['5'], item: 1, price: '1', method: 'link' }).ok, false);
});

test('validateSignup / validateLogin', () => {
  assert.deepEqual(validateSignup({ shopName: 'حلويات نورة', email: ' Noura@Example.com ', password: 'secret123' }), {
    ok: true, value: { shopName: 'حلويات نورة', email: 'noura@example.com', password: 'secret123' },
  });
  const bad = validateSignup({ shopName: 'x', email: 'nope', password: 'short' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'password', 'shopName']);
  assert.equal(validateLogin({ email: 'a@b.co', password: '' }).ok, false);
  assert.equal(validateLogin({ email: 'a@b.co', password: 'x' }).ok, true);
  assert.equal(validateLogin({ email: { $ne: null }, password: 'x' }).ok, false);
});

test('a huge crafted email is rejected fast (no regex blow-up)', () => {
  const evil = `a@${'.a'.repeat(500_000)}@`;
  const t = performance.now();
  assert.equal(validateLogin({ email: evil, password: 'x' }).ok, false);
  assert.equal(validateSignup({ shopName: 'متجر', email: evil, password: 'secret123' }).ok, false);
  assert.ok(performance.now() - t < 100, 'must finish in well under 100 ms');
});
