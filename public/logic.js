// دفتري — shared pure logic (runs in the browser AND on the server, so validation and math match).
// Money is kept as integer fils (1 KWD = 1000 fils) to avoid floating-point errors.

export const METHODS = {
  link: 'رابط دفع',
  cash_driver: 'كاش مع المندوب',
  transfer: 'تحويل بنكي',
};

export const STATUSES = {
  unpaid: 'ما دفع',
  with_driver: 'عند المندوب',
  paid: 'وصلني',
};

export const LIMITS = {
  name: 60,
  item: 80,
  shop: 40,
  maxFils: 100_000_000, // 100,000 KWD
  passwordMin: 8,
  passwordMax: 128,
};

const AR_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000; // Asia/Kuwait is UTC+3 all year (no DST)

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → 0-9; Arabic decimal/thousands marks → . / nothing. */
export function toLatinDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');
}

/**
 * Parse a KWD amount typed by a person ("12", "12.5", "١٢٫٥٠٠") into integer fils.
 * Returns { ok: true, fils } or { ok: false, error }.
 */
export function parseAmount(input, { allowZero = false, max = LIMITS.maxFils } = {}) {
  if (typeof input === 'number' && Number.isFinite(input)) input = String(input);
  if (typeof input !== 'string') return { ok: false, error: 'اكتب المبلغ' };
  const s = toLatinDigits(input).replace(/\s+/g, '');
  if (s === '') return { ok: false, error: 'اكتب المبلغ' };
  if (s.includes(',')) return { ok: false, error: 'استخدم النقطة للكسور، مثل 12.500' };
  const m = s.match(/^(\d{1,6})(?:\.(\d{1,3}))?$/);
  if (!m) return { ok: false, error: 'المبلغ لازم يكون رقم، ولين 3 خانات بعد النقطة (فلس)' };
  const fils = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
  if (fils === 0 && !allowZero) return { ok: false, error: 'المبلغ لازم يكون أكبر من صفر' };
  if (fils > max) return { ok: false, error: 'المبلغ كبير وايد' };
  return { ok: true, fils };
}

/** 12500 → "12.500 د.ك" (always 3 decimals, Latin digits, thousands commas). */
export function formatKWD(fils, { unit = true } = {}) {
  const n = Math.trunc(Number(fils) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 1000).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 1000).padStart(3, '0');
  return `${sign}${whole}.${frac}${unit ? ' د.ك' : ''}`;
}

/**
 * Normalise a phone number for WhatsApp. Kuwaiti 8-digit numbers get 965 in front.
 * Accepts +965 / 00965 / 965 prefixes, spaces, dashes and Arabic digits.
 */
export function normalizePhone(input) {
  if (typeof input !== 'string') return { ok: false, error: 'اكتب رقم الزبون' };
  let d = toLatinDigits(input).replace(/[\s\-().]/g, '');
  if (d === '') return { ok: false, error: 'اكتب رقم الزبون' };
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (!/^\d+$/.test(d)) return { ok: false, error: 'الرقم لازم يكون أرقام بس' };
  if (d.length === 8) {
    if (!/^[24569]/.test(d)) return { ok: false, error: 'رقم كويتي غير صحيح' };
    return { ok: true, digits: `965${d}` };
  }
  if (d.startsWith('965')) {
    if (d.length !== 11 || !/^[24569]/.test(d.slice(3))) return { ok: false, error: 'رقم كويتي غير صحيح' };
    return { ok: true, digits: d };
  }
  if (d.length >= 9 && d.length <= 15 && !d.startsWith('0')) return { ok: true, digits: d };
  return { ok: false, error: 'الرقم غير صحيح (مثال: 55512345)' };
}

/** "96555512345" → "+965 5551 2345" */
export function displayPhone(digits) {
  const d = String(digits || '');
  if (/^965\d{8}$/.test(d)) return `+965 ${d.slice(3, 7)} ${d.slice(7)}`;
  return d ? `+${d}` : '';
}

export function reminderText({ customerName, item, priceFils, shopName }) {
  const name = String(customerName || '').trim();
  const shop = String(shopName || '').trim();
  return [
    `هلا ${name} 🌸`,
    `حبيت أذكرك بطلب «${String(item || '').trim()}» بمبلغ ${formatKWD(priceFils)}.`,
    'إذا حوّلت تجاهل هالرسالة، وشكراً لك 🙏',
    shop ? `— ${shop}` : '',
  ].filter(Boolean).join('\n');
}

export function waLink(digits, text) {
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Month boundaries in Kuwait time. offset 0 = this month, -1 = last month. */
export function kuwaitMonthRange(now = new Date(), offset = 0) {
  const shifted = new Date(now.getTime() + KUWAIT_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + offset;
  const start = new Date(Date.UTC(y, m, 1) - KUWAIT_OFFSET_MS);
  const end = new Date(Date.UTC(y, m + 1, 1) - KUWAIT_OFFSET_MS);
  const labelDate = new Date(Date.UTC(y, m, 1));
  return {
    start,
    end,
    label: `${AR_MONTHS[labelDate.getUTCMonth()]} ${labelDate.getUTCFullYear()}`,
  };
}

/** "2026-11-15T10:00:00Z" → "15 نوفمبر" (Kuwait date). */
export function shortDate(value) {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return '';
  const k = new Date(t.getTime() + KUWAIT_OFFSET_MS);
  return `${k.getUTCDate()} ${AR_MONTHS[k.getUTCMonth()]}`;
}

/**
 * Dashboard numbers.
 * - month*: orders created inside the month (Kuwait time).
 * - profitPaid: (price − cost) of this month's orders whose money arrived (status paid).
 * - unpaid / driver: everything still outstanding right now, whatever the month.
 */
export function summarize(orders, range) {
  const out = {
    monthCount: 0, monthSales: 0, profitPaid: 0, profitAll: 0, paidSales: 0,
    unpaidCount: 0, unpaid: 0, driverCount: 0, driver: 0,
  };
  for (const o of orders || []) {
    const t = new Date(o.createdAt).getTime();
    const price = Number(o.priceFils) || 0;
    const profit = price - (Number(o.costFils) || 0);
    if (t >= range.start.getTime() && t < range.end.getTime()) {
      out.monthCount += 1;
      out.monthSales += price;
      out.profitAll += profit;
      if (o.status === 'paid') {
        out.profitPaid += profit;
        out.paidSales += price;
      }
    }
    if (o.status === 'unpaid') {
      out.unpaidCount += 1;
      out.unpaid += price;
    } else if (o.status === 'with_driver') {
      out.driverCount += 1;
      out.driver += price;
    }
  }
  return out;
}

/** Which status buttons an order card shows. */
export function nextActions(order) {
  const cash = order.method === 'cash_driver';
  switch (order.status) {
    case 'unpaid':
      return cash
        ? [{ to: 'with_driver', label: 'استلم المندوب الكاش' }, { to: 'paid', label: 'وصلني المبلغ' }]
        : [{ to: 'paid', label: 'وصلني المبلغ' }];
    case 'with_driver':
      return [{ to: 'paid', label: 'سلّمني المندوب' }, { to: 'unpaid', label: 'تراجع' }];
    case 'paid':
      return [{ to: cash ? 'with_driver' : 'unpaid', label: 'تراجع' }];
    default:
      return [];
  }
}

export function canSetStatus(order, status) {
  if (!Object.hasOwn(STATUSES, status)) return false;
  if (status === 'with_driver' && order.method !== 'cash_driver') return false;
  return true;
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1);
}

/** Validate the "new order" form. Same rules in the browser and on the server. */
export function validateOrder(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const customerName = cleanText(src.customerName, LIMITS.name);
  if (!customerName) errors.customerName = 'اكتب اسم الزبون';
  else if (customerName.length > LIMITS.name) errors.customerName = `الاسم طويل (لين ${LIMITS.name} حرف)`;

  const phone = normalizePhone(typeof src.customerPhone === 'string' ? src.customerPhone : '');
  if (!phone.ok) errors.customerPhone = phone.error;

  const item = cleanText(src.item, LIMITS.item);
  if (!item) errors.item = 'اكتب المنتج';
  else if (item.length > LIMITS.item) errors.item = `الوصف طويل (لين ${LIMITS.item} حرف)`;

  const price = parseAmount(src.price);
  if (!price.ok) errors.price = price.error;

  const costRaw = typeof src.cost === 'string' && src.cost.trim() === '' ? '0' : src.cost;
  const cost = parseAmount(costRaw ?? '0', { allowZero: true });
  if (!cost.ok) errors.cost = cost.error;

  const method = typeof src.method === 'string' && Object.hasOwn(METHODS, src.method) ? src.method : null;
  if (!method) errors.method = 'اختار طريقة الدفع';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      customerName,
      customerPhone: phone.digits,
      item,
      priceFils: price.fils,
      costFils: cost.fils,
      method,
    },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export function validateSignup(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const shopName = cleanText(src.shopName, LIMITS.shop);
  if (shopName.length < 2) errors.shopName = 'اكتب اسم مشروعك';
  else if (shopName.length > LIMITS.shop) errors.shopName = `الاسم طويل (لين ${LIMITS.shop} حرف)`;
  const email = normalizeEmail(src.email);
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'اكتب إيميل صحيح';
  const password = typeof src.password === 'string' ? src.password : '';
  if (password.length < LIMITS.passwordMin) errors.password = `كلمة السر لازم ${LIMITS.passwordMin} أحرف أو أكثر`;
  else if (password.length > LIMITS.passwordMax) errors.password = 'كلمة السر طويلة وايد';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { shopName, email, password } };
}

export function validateLogin(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const email = normalizeEmail(src.email);
  if (!EMAIL_RE.test(email)) errors.email = 'اكتب إيميل صحيح';
  const password = typeof src.password === 'string' ? src.password : '';
  if (!password) errors.password = 'اكتب كلمة السر';
  else if (password.length > LIMITS.passwordMax) errors.password = 'كلمة السر طويلة وايد';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { email, password } };
}
