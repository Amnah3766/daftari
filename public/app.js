// دفتري — page logic. All user text goes in with textContent (never innerHTML), so names can't inject HTML.
import {
  METHODS, STATUSES, displayPhone, formatKWD, kuwaitMonthRange, nextActions, parseAmount, payUrl, reminderText,
  shortDate, summarize, validateLogin, validateOrder, validateSignup, waLink,
} from './logic.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { user: null, orders: [], tab: 'unpaid', monthOffset: 0 };

/* ---------------- helpers ---------------- */

class ApiError extends Error {
  constructor(status, data) {
    super(data?.message || 'صار خلل، جرّب بعد شوي');
    this.status = status;
    this.data = data || {};
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { message: 'ما في اتصال بالإنترنت، جرّب مرة ثانية' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && path === '/api/orders') signedOut('انتهت الجلسة، سجّل دخول مرة ثانية');
    throw new ApiError(res.status, data);
  }
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = 0;
function toast(message, type = 'ok', ms = type === 'error' ? 4200 : 2600) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('error', type === 'error');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function setBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), busyText || 'لحظة…');
  } else {
    button.disabled = false;
    if (button.dataset.label !== undefined) button.textContent = button.dataset.label;
  }
}

function setErrors(form, errors = {}, formMessage = '') {
  for (const e of $$('[data-error-for]', form)) e.textContent = errors[e.dataset.errorFor] || '';
  for (const input of $$('input[name]', form)) {
    if (input.type === 'radio') continue;
    if (errors[input.name]) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  $('.form-error', form).textContent = formMessage;
  const first = Object.keys(errors)[0];
  if (first) {
    const target = form.elements[first];
    const node = target instanceof RadioNodeList ? target[0] : target;
    node?.focus?.();
  }
}

const formValues = (form) => Object.fromEntries(new FormData(form).entries());

/* ---------------- views ---------------- */

function show(view) {
  const changed = $(`#${view}`).hidden;
  for (const id of ['boot', 'landing', 'app']) $(`#${id}`).hidden = id !== view;
  $('#who').hidden = view !== 'app';
  $('#fab').hidden = view !== 'app';
  document.body.classList.toggle('in-app', view === 'app');
  if (changed) window.scrollTo(0, 0);
}

function signedOut(message) {
  state.user = null;
  state.orders = [];
  clearTimeout(refreshTimer);
  saving = false;
  if ($('#orderDialog').open) $('#orderDialog').close();
  show('landing');
  setAuthTab('login');
  if (message) toast(message, 'error');
}

function hidePasswords() {
  for (const t of $$('[data-pw-toggle]')) {
    t.parentElement.querySelector('input').type = 'password';
    t.textContent = 'إظهار';
    t.setAttribute('aria-label', 'إظهار كلمة السر');
  }
}

function setAuthTab(which) {
  hidePasswords();
  for (const b of $$('[data-auth-tab]')) b.setAttribute('aria-selected', String(b.dataset.authTab === which));
  $('#signupForm').hidden = which !== 'signup';
  $('#loginForm').hidden = which !== 'login';
  const form = which === 'signup' ? $('#signupForm') : $('#loginForm');
  setErrors(form, {});
}

/* ---------------- dashboard + list ---------------- */

function currentRange() {
  return kuwaitMonthRange(new Date(), state.monthOffset);
}

function renderStats() {
  const range = currentRange();
  const s = summarize(state.orders, range);
  $('#monthLabel').textContent = range.label;
  $('#nextMonth').disabled = state.monthOffset >= 0;
  $('#sSales').textContent = formatKWD(s.monthSales);
  $('#sSalesSub').textContent = s.monthCount === 1 ? 'طلب واحد' : `${s.monthCount} طلب`;
  $('#sProfit').textContent = formatKWD(s.profitPaid);
  $('#sProfitSub').textContent = s.profitAll !== s.profitPaid
    ? `من اللي وصلتك فلوسه · لو دفع الكل ${formatKWD(s.profitAll)}`
    : 'من الطلبات اللي وصلتك فلوسها';
  $('#sDriver').textContent = formatKWD(s.driver);
  $('#sDriverSub').textContent = s.driverCount ? `${s.driverCount} طلب، لازم يسلّمك` : 'ما عنده شي لك';
  $('#sUnpaid').textContent = formatKWD(s.unpaid);
  $('#sUnpaidSub').textContent = s.unpaidCount ? `${s.unpaidCount === 1 ? 'طلب واحد' : `${s.unpaidCount} طلب`} ما انقبض` : 'ما في شي معلّق';
  $('#cUnpaid').textContent = String(s.unpaidCount);
  $('#cDriver').textContent = String(s.driverCount);
  $('#cMonth').textContent = String(s.monthCount);
  $('#monthTabLabel').textContent = `طلبات ${range.label.split(' ')[0]}`;
}

function visibleOrders() {
  const range = currentRange();
  const inMonth = (o) => {
    const t = new Date(o.createdAt).getTime();
    return t >= range.start.getTime() && t < range.end.getTime();
  };
  const byOldest = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
  const byNewest = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  if (state.tab === 'unpaid') return state.orders.filter((o) => o.status === 'unpaid').sort(byOldest);
  if (state.tab === 'with_driver') return state.orders.filter((o) => o.status === 'with_driver').sort(byOldest);
  return state.orders.filter(inMonth).sort(byNewest);
}

const EMPTY = {
  unpaid: ['ما في زبون باقي عليه فلوس', 'لما تسجل طلب جديد من زر «+»، يطلع هني لين توصلك فلوسه.'],
  with_driver: ['المندوب ما عنده كاش لك', 'لما يستلم كاش من زبون، اضغط «استلم المندوب الكاش» على الطلب.'],
  month: ['ما في طلبات بهالشهر', 'أول طلب تسجله يطلع هني.'],
};

function orderCard(o) {
  const profit = o.priceFils - o.costFils;
  const actions = el('div', { class: 'o-actions' });

  const link = o.method === 'link' && o.payToken ? payUrl(location.origin, o.payToken) : null;
  if (o.status === 'unpaid') {
    const text = reminderText({
      customerName: o.customerName, item: o.item, priceFils: o.priceFils, shopName: state.user?.shopName, payUrl: link,
    });
    actions.append(el('a', {
      class: 'btn wa', href: waLink(o.customerPhone, text), target: '_blank', rel: 'noopener noreferrer',
    }, waIcon(), link ? 'ذكّر وأرسل رابط الدفع' : 'ذكّر بالواتساب'));
    if (link) {
      actions.append(el('button', {
        type: 'button', class: 'btn link', onclick: () => copyPayLink(link),
      }, 'نسخ رابط الدفع'));
    }
  }

  for (const a of nextActions(o)) {
    const cls = a.label === 'تراجع' ? 'btn soft' : a.to === 'paid' ? 'btn go-green' : 'btn go-amber';
    actions.append(el('button', {
      type: 'button', class: cls, onclick: (ev) => changeStatus(o, a, ev.currentTarget),
    }, a.label));
  }

  actions.append(el('button', {
    type: 'button', class: 'btn del', 'aria-label': `حذف طلب ${o.customerName}`,
    onclick: (ev) => removeOrder(o, ev.currentTarget),
  }, 'حذف'));

  let payNote = null;
  if (o.status === 'paid' && o.paidVia === 'link') {
    payNote = el('div', { class: 'o-pay ok', text: '💳 الزبون دفع من رابط الدفع، وانسجل «وصلني» لحاله' });
  } else if (o.status === 'unpaid' && o.payFailedAt) {
    payNote = el('div', { class: 'o-pay fail', text: `⚠️ الزبون حاول يدفع والدفع انرفض (${shortTime(o.payFailedAt)})` });
  }

  return el('li', { class: `order st-${o.status}`, 'data-id': o.id },
    el('div', { class: 'o-main' },
      el('div', { class: 'o-top' },
        el('strong', { class: 'o-name', text: o.customerName }),
        el('span', { class: `badge st-${o.status}`, text: STATUSES[o.status] || o.status })),
      el('div', { class: 'o-item', text: o.item }),
      el('div', { class: 'o-meta' },
        el('span', { text: METHODS[o.method] || o.method }),
        el('span', { text: shortDate(o.createdAt) }),
        el('a', { href: `tel:+${o.customerPhone}`, text: displayPhone(o.customerPhone) }))),
    el('div', { class: 'o-amount' },
      el('strong', { text: formatKWD(o.priceFils) }),
      el('small', { class: profit < 0 ? 'loss' : null, text: `${profit < 0 ? 'خسارة' : 'ربح'} ${formatKWD(Math.abs(profit), { unit: false })}` })),
    payNote,
    actions);
}

/** "2026-11-16T15:04:00Z" → "6:04 م" (Kuwait time). */
function shortTime(value) {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleTimeString('ar-KW-u-nu-latn', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kuwait' });
}

async function copyPayLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast('انسخ رابط الدفع ✅ ألصقه للزبون');
  } catch {
    window.prompt('انسخ رابط الدفع:', link);
  }
}

function waIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.2 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.6-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3Z');
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}

function renderList() {
  for (const b of $$('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  const list = visibleOrders();
  $('#orderList').replaceChildren(...list.map(orderCard));
  const empty = !list.length;
  $('#empty').hidden = !empty;
  if (empty) {
    const [title, text] = EMPTY[state.tab];
    $('#emptyTitle').textContent = title;
    $('#emptyText').textContent = text;
  }
}

function render() {
  $('#shopName').textContent = state.user?.shopName || '';
  renderStats();
  renderList();
  scheduleRefresh();
}

async function loadOrders() {
  const data = await api('/api/orders');
  state.user = data.user;
  state.orders = data.orders;
  render();
  show('app');
}

/* ---------------- payment links: the order turns «وصلني» by itself ---------------- */

// While a «رابط دفع» order is waiting, check every few seconds whether the customer paid on the link.
const REFRESH_MS = 5000;
let refreshTimer = 0;
let refreshing = false;
let busyActions = 0; // a status change / delete in flight → skip this round

const waitingForLink = () => state.orders.some((o) => o.method === 'link' && o.status === 'unpaid');

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!state.user || !waitingForLink()) return;
  refreshTimer = setTimeout(refreshOrders, REFRESH_MS);
}

async function refreshOrders() {
  if (refreshing || !state.user) return;
  if (document.hidden || saving || busyActions || $('#orderDialog').open) {
    scheduleRefresh();
    return;
  }
  refreshing = true;
  try {
    const before = new Map(state.orders.map((o) => [o.id, o]));
    const { orders } = await api('/api/orders');
    if (!state.user || saving || busyActions) return;
    const key = (o) => `${o.id}|${o.status}|${o.paidVia}|${o.payFailedAt}`;
    const changed = orders.length !== state.orders.length || orders.some((o) => key(o) !== key(before.get(o.id) || {}));
    if (!changed) return;
    const paidNow = orders.filter((o) => o.paidVia === 'link' && o.status === 'paid' && before.get(o.id)?.status === 'unpaid');
    const failedNow = orders.filter((o) => o.payFailedAt && o.payFailedAt !== before.get(o.id)?.payFailedAt);
    state.orders = orders;
    if (paidNow.length && state.tab === 'unpaid') state.tab = 'month';
    render();
    for (const o of paidNow) $(`#orderList [data-id="${o.id}"]`)?.classList.add('flash');
    if (paidNow.length) {
      const o = paidNow[0];
      toast(`💳 ${o.customerName} دفع ${formatKWD(o.priceFils)} من الرابط، وصار «وصلني» لحاله ✅`, 'ok', 6000);
    } else if (failedNow.length) {
      toast(`⚠️ ${failedNow[0].customerName} حاول يدفع والبطاقة انرفضت`, 'error');
    }
  } catch {
    // offline for a moment — try again next round
  } finally {
    refreshing = false;
    scheduleRefresh();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user) refreshOrders();
});

/* ---------------- actions ---------------- */

async function changeStatus(order, action, button) {
  setBusy(button, true);
  busyActions += 1;
  try {
    const { order: updated } = await api('/api/orders', { method: 'PATCH', body: { id: order.id, status: action.to } });
    state.orders = state.orders.map((o) => (o.id === updated.id ? updated : o));
    render();
    toast(action.label === 'تراجع' ? 'رجّعناه' : `تمام: ${STATUSES[updated.status]} ✅`);
  } catch (err) {
    setBusy(button, false);
    if (err.status === 404) {
      state.orders = state.orders.filter((o) => o.id !== order.id);
      render();
    }
    if (err.status !== 401) toast(err.message, 'error');
  } finally {
    busyActions -= 1;
  }
}

async function removeOrder(order, button) {
  const disarm = () => {
    clearTimeout(button.disarmTimer);
    button.dataset.armed = '';
    button.classList.remove('armed');
    button.textContent = 'حذف';
    button.setAttribute('aria-label', `حذف طلب ${order.customerName}`);
  };
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.classList.add('armed');
    button.textContent = 'متأكد؟ اضغط مرة ثانية';
    button.setAttribute('aria-label', `متأكد؟ اضغط مرة ثانية لحذف طلب ${order.customerName}`);
    clearTimeout(button.disarmTimer);
    button.disarmTimer = setTimeout(() => {
      if (button.isConnected && button.dataset.armed === '1') disarm();
    }, 4000);
    return;
  }
  clearTimeout(button.disarmTimer);
  button.dataset.armed = '';
  button.setAttribute('aria-label', `نحذف طلب ${order.customerName}…`);
  setBusy(button, true, 'نحذف…');
  busyActions += 1;
  try {
    await api('/api/orders', { method: 'DELETE', body: { id: order.id } });
    state.orders = state.orders.filter((o) => o.id !== order.id);
    render();
    toast('انحذف الطلب');
  } catch (err) {
    if (err.status === 404) {
      state.orders = state.orders.filter((o) => o.id !== order.id);
      render();
      return;
    }
    setBusy(button, false);
    disarm();
    if (err.status !== 401) toast(err.message, 'error');
  } finally {
    busyActions -= 1;
  }
}

/* ---------------- new order dialog ---------------- */

let saving = false; // while a save is in flight the sheet can't be closed (no stale result later)

function closeOrderDialog() {
  if (!saving) $('#orderDialog').close();
}

function openOrderDialog() {
  if (saving) {
    toast('لحظة، نحفظ الطلب اللي قبل', 'error');
    return;
  }
  const form = $('#orderForm');
  form.reset();
  setErrors(form, {});
  updateProfitHint();
  $('#orderDialog').showModal();
  setTimeout(() => form.elements.customerName.focus(), 30);
}

function updateProfitHint() {
  const form = $('#orderForm');
  const hint = $('#profitHint');
  const price = parseAmount(form.elements.price.value);
  const costText = form.elements.cost.value.trim();
  const cost = parseAmount(costText === '' ? '0' : costText, { allowZero: true });
  if (!price.ok || !cost.ok) {
    hint.textContent = '';
    return;
  }
  const profit = price.fils - cost.fils;
  hint.classList.toggle('loss', profit < 0);
  hint.textContent = profit < 0
    ? `انتبه: خسارة ${formatKWD(-profit)} بهالطلب`
    : `ربحك من هالطلب: ${formatKWD(profit)}`;
}

async function submitOrder(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const values = formValues(form);
  const v = validateOrder(values);
  if (!v.ok) {
    setErrors(form, v.errors);
    return;
  }
  setErrors(form, {});
  if (saving) return;
  saving = true;
  const button = $('button[type="submit"]', form);
  setBusy(button, true, 'نحفظ…');
  try {
    const { order } = await api('/api/orders', {
      method: 'POST',
      body: {
        customerName: values.customerName,
        customerPhone: values.customerPhone,
        item: values.item,
        price: values.price,
        cost: values.cost,
        method: values.method,
      },
    });
    saving = false;
    state.orders = [order, ...state.orders];
    state.tab = 'unpaid';
    state.monthOffset = 0;
    $('#orderDialog').close();
    render();
    toast('انحفظ الطلب ✅');
  } catch (err) {
    if (err.status !== 401) {
      setErrors(form, err.data?.fields || {}, err.message);
      if (!$('#orderDialog').open) toast(err.message, 'error');
    }
  } finally {
    saving = false;
    setBusy(button, false);
  }
}

/* ---------------- auth ---------------- */

async function submitAuth(ev, kind) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const values = formValues(form);
  const v = kind === 'signup' ? validateSignup(values) : validateLogin(values);
  if (!v.ok) {
    setErrors(form, v.errors);
    return;
  }
  setErrors(form, {});
  const button = $('button[type="submit"]', form);
  setBusy(button, true);
  try {
    const { user } = await api('/api/auth', { method: 'POST', body: { action: kind, ...v.value } });
    state.user = user;
    state.tab = 'unpaid';
    state.monthOffset = 0;
    form.reset();
    hidePasswords();
    await loadOrders();
    toast(kind === 'signup' ? `هلا ${user.shopName}! دفترك جاهز 🎉` : `هلا فيك، ${user.shopName}`);
  } catch (err) {
    setErrors(form, err.data?.fields || {}, err.message);
  } finally {
    setBusy(button, false);
  }
}

async function logout() {
  const button = $('#logoutBtn');
  setBusy(button, true, '…');
  try {
    await api('/api/auth', { method: 'POST', body: { action: 'logout' } });
  } catch (err) {
    setBusy(button, false);
    toast(err.status === 0 ? 'ما قدرنا نطلعك، تأكد من الاتصال' : err.message, 'error');
    return;
  }
  setBusy(button, false);
  signedOut();
  toast('طلعت من حسابك. نشوفك قريب 👋');
}

/* ---------------- wiring ---------------- */

/** Typing in a field (or picking a payment method) clears that field's old error message. */
function clearErrorOnInput(form) {
  form.addEventListener('input', (e) => {
    const name = e.target?.name;
    if (!name) return;
    const err = $(`[data-error-for="${name}"]`, form);
    if (err) err.textContent = '';
    if (e.target.type !== 'radio') e.target.removeAttribute('aria-invalid');
    $('.form-error', form).textContent = '';
  });
}

function wire() {
  for (const f of [$('#signupForm'), $('#loginForm'), $('#orderForm')]) clearErrorOnInput(f);
  for (const b of $$('[data-auth-tab]')) b.addEventListener('click', () => setAuthTab(b.dataset.authTab));
  $('#signupForm').addEventListener('submit', (e) => submitAuth(e, 'signup'));
  $('#loginForm').addEventListener('submit', (e) => submitAuth(e, 'login'));
  for (const t of $$('[data-pw-toggle]')) {
    t.addEventListener('click', () => {
      const input = t.parentElement.querySelector('input');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      t.textContent = showing ? 'إظهار' : 'إخفاء';
      t.setAttribute('aria-label', showing ? 'إظهار كلمة السر' : 'إخفاء كلمة السر');
    });
  }
  $('#logoutBtn').addEventListener('click', logout);

  for (const b of $$('[data-tab]')) {
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      renderList();
    });
  }
  $('#prevMonth').addEventListener('click', () => {
    state.monthOffset -= 1;
    render();
  });
  $('#nextMonth').addEventListener('click', () => {
    if (state.monthOffset < 0) state.monthOffset += 1;
    render();
  });

  $('#newOrderBtn').addEventListener('click', openOrderDialog);
  $('#fab').addEventListener('click', openOrderDialog);
  const form = $('#orderForm');
  form.addEventListener('submit', submitOrder);
  form.elements.price.addEventListener('input', updateProfitHint);
  form.elements.cost.addEventListener('input', updateProfitHint);
  for (const b of $$('[data-close]', form)) b.addEventListener('click', closeOrderDialog);
  const dialog = $('#orderDialog');
  dialog.addEventListener('cancel', (e) => {
    if (saving) e.preventDefault(); // Escape while saving
  });
  // Browsers may force-close it anyway (2nd Escape / Android back) — reopen so the result shows on the typed form.
  dialog.addEventListener('close', () => {
    if (saving) dialog.showModal();
  });
  // Close on a tap on the dimmed background — only if the press also STARTED there (not a text-selection drag).
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => {
    downOnBackdrop = e.target === dialog;
  });
  dialog.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === dialog) closeOrderDialog();
    downOnBackdrop = false;
  });
}

async function boot() {
  wire();
  try {
    const { user } = await api('/api/auth');
    if (user) {
      state.user = user;
      await loadOrders();
      return;
    }
    show('landing');
  } catch (err) {
    show('landing');
    if (err.status !== 401) toast(err.message, 'error');
  }
}

boot();
