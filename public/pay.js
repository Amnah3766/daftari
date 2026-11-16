// دفتري — the customer's payment page (/pay?t=…). All text goes in with textContent (never innerHTML).
import {
  formatCardNumber, formatKWD, PAY_TOKEN_RE, testCardOutcome, toLatinDigits, validExpiry,
} from './logic.js';

const $ = (sel, root = document) => root.querySelector(sel);
const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
let order = null;
let mode = 'test';

async function api(body) {
  let res;
  try {
    res = await fetch(body ? '/api/pay' : `/api/pay?t=${encodeURIComponent(token)}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify({ t: token, ...body }) : undefined,
    });
  } catch {
    throw Object.assign(new Error('ما في اتصال بالإنترنت، جرّب مرة ثانية'), { status: 0 });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw Object.assign(new Error(data?.message || 'صار خلل، جرّب بعد شوي'), { status: res.status });
  return data;
}

let toastTimer = 0;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show', 'error');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

function setBusy(button, busy, text) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    const s = document.createElement('span');
    s.className = 'spinner';
    s.setAttribute('aria-hidden', 'true');
    button.replaceChildren(s, text);
  } else {
    button.disabled = false;
    if (button.dataset.label !== undefined) button.textContent = button.dataset.label;
  }
}

function show(id) {
  for (const s of ['payBoot', 'payMissing', 'payBox']) $(`#${s}`).hidden = s !== id;
}

function render() {
  const first = String(order.customerName || '').split(' ')[0];
  $('#pHello').textContent = first ? `هلا ${first} 🌸` : 'هلا فيك 🌸';
  $('#pShop').textContent = order.shopName || 'المحل';
  $('#pItem').textContent = order.item;
  $('#pAmount').textContent = formatKWD(order.priceFils);
  $('#testPayBtn').textContent = `ادفع ${formatKWD(order.priceFils)}`;
  $('#stripeBtn').textContent = `ادفع ${formatKWD(order.priceFils)} بالبطاقة`;
  const paid = order.status === 'paid';
  $('#rPaid').hidden = !paid;
  if (paid) {
    $('#rPaidText').textContent = `وصل ${formatKWD(order.priceFils)} لـ ${order.shopName || 'المحل'}، وطلبك صار «مدفوع» عندهم. شكراً لك 🙏`;
    $('#rDeclined').hidden = true;
  }
  $('#testForm').hidden = paid || mode !== 'test';
  $('#stripeBox').hidden = paid || mode !== 'stripe';
  show('payBox');
}

function declined(title, text) {
  $('#rDeclinedTitle').textContent = title;
  $('#rDeclinedText').textContent = text;
  $('#rDeclined').hidden = false;
  $('#rDeclined').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function apply(result) {
  if (result.order) order = result.order;
  render();
  if (result.result === 'paid') $('#rPaid').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------------- built-in test gateway ---------------- */

function fieldError(form, name, message) {
  $(`[data-error-for="${name}"]`, form).textContent = message || '';
  const input = form.elements[name];
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

async function submitTest(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const card = form.elements.card.value;
  const exp = form.elements.exp.value;
  const cvc = toLatinDigits(form.elements.cvc.value).trim();
  const digits = toLatinDigits(card).replace(/\D/g, '');
  const outcome = testCardOutcome(card);
  const errors = {
    card: !digits ? 'اكتب رقم البطاقة'
      : !outcome ? 'هذي بوابة تجريبية: استخدم بطاقة الاختبار 4242 4242 4242 4242 (أو 4000 0000 0000 0002 للرفض)' : '',
    exp: validExpiry(exp) ? '' : 'اكتب تاريخ انتهاء صحيح (مثال 12/30)',
    cvc: /^\d{3,4}$/.test(cvc) ? '' : 'اكتب الرمز (3 أرقام)',
  };
  for (const [k, v] of Object.entries(errors)) fieldError(form, k, v);
  const firstBad = Object.keys(errors).find((k) => errors[k]);
  if (firstBad) {
    form.elements[firstBad].focus();
    return;
  }
  $('#rDeclined').hidden = true;
  const button = $('#testPayBtn');
  setBusy(button, true, 'نتحقق من البطاقة…');
  try {
    await new Promise((r) => setTimeout(r, 1200)); // like a real gateway: a short "processing" moment
    const result = await api({ action: 'test', outcome });
    setBusy(button, false);
    apply(result);
    if (result.result === 'declined') {
      form.elements.card.value = '';
      declined('انرفض الدفع', 'البنك رفض البطاقة، وما انخصم منك أي مبلغ. جرّب بطاقة ثانية.');
    }
  } catch (err) {
    setBusy(button, false);
    toast(err.message);
  }
}

/* ---------------- Stripe (test mode) ---------------- */

async function goToStripe() {
  const button = $('#stripeBtn');
  setBusy(button, true, 'نفتح صفحة الدفع…');
  try {
    const result = await api({ action: 'checkout' });
    if (result.url) {
      location.assign(result.url);
      return;
    }
    setBusy(button, false);
    apply(result);
  } catch (err) {
    setBusy(button, false);
    toast(err.message);
  }
}

/* ---------------- start ---------------- */

async function boot() {
  const form = $('#testForm');
  form.addEventListener('submit', submitTest);
  form.elements.card.addEventListener('input', (e) => {
    e.target.value = formatCardNumber(e.target.value);
    fieldError(form, 'card', '');
  });
  form.elements.exp.addEventListener('input', (e) => {
    const d = toLatinDigits(e.target.value).replace(/\D/g, '').slice(0, 4);
    e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    fieldError(form, 'exp', '');
  });
  form.elements.cvc.addEventListener('input', (e) => {
    e.target.value = toLatinDigits(e.target.value).replace(/\D/g, '').slice(0, 4);
    fieldError(form, 'cvc', '');
  });
  $('#stripeBtn').addEventListener('click', goToStripe);

  if (!PAY_TOKEN_RE.test(token)) {
    show('payMissing');
    return;
  }
  try {
    const data = await api();
    mode = data.mode;
    order = data.order;
  } catch (err) {
    if (err.status === 404) show('payMissing');
    else {
      show('payMissing');
      $('#payMissing strong').textContent = 'ما قدرنا نفتح الطلب';
      $('#payMissing .result span:last-child').textContent = err.message;
    }
    return;
  }
  render();

  // Back from Stripe: confirm with the server (which asks Stripe), or record the cancelled attempt.
  const sessionId = params.get('session_id');
  const canceled = params.get('canceled') === '1';
  if (sessionId || canceled) history.replaceState(null, '', `/pay?t=${encodeURIComponent(token)}`);
  if (order.status === 'paid') return;
  if (sessionId) {
    try {
      const result = await api({ action: 'confirm', sessionId });
      apply(result);
      if (result.result !== 'paid') declined('ما تم الدفع', 'الدفع ما كمل، وما انخصم منك أي مبلغ. جرّب مرة ثانية.');
    } catch (err) {
      toast(err.message);
    }
  } else if (canceled) {
    try {
      apply(await api({ action: 'cancel' }));
      declined('ما تم الدفع', 'انرفضت البطاقة أو انلغى الدفع، وما انخصم منك أي مبلغ. تقدر تجرّب مرة ثانية.');
    } catch (err) {
      toast(err.message);
    }
  }
}

boot();
