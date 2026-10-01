// Shared pieces of the parent app: language, who is signed in, API calls (with the
// "server unreachable" banner and its quiet retry), per-tab storage and small UI parts.
// Views import from here; app.js wires the router in through `hooks`.

import { api, ApiError, formatRM, formatKL, h, toast } from '/shared/api.js';
import { createI18n } from '/shared/i18n.js';
import { STRINGS } from './strings.js';

export const i18n = createI18n(STRINGS);
export const t = (key, vars) => i18n.t(key, vars);
export { formatRM, formatKL, h, toast, ApiError };

/** What the app knows right now. `offline` is null, 'SERVER_DOWN' or 'NETWORK'. */
export const state = {
  parent: null,
  offline: null,
  /** last GET /api/parent/children answer: { children, links } */
  family: null,
};

/** Set by app.js: what to do when the session is gone, and how to redraw the current page. */
export const hooks = {
  signedOut: () => {},
  refresh: () => {},
};

// ---- calls to the platform ------------------------------------------------------------------

const RETRY_MS = 4000;
let retryTimer = null;

/** api() plus what every page needs: the offline banner and a lost session. */
export async function call(path, opts) {
  try {
    const data = await api(path, opts);
    if (state.offline) setOffline(null);
    return data;
  } catch (err) {
    if (err instanceof ApiError) {
      if (isOfflineError(err)) setOffline(err.code === 'NETWORK' ? 'NETWORK' : 'SERVER_DOWN');
      else if (state.offline) setOffline(null);
      if (err.code === 'NOT_SIGNED_IN' && state.parent) hooks.signedOut();
    }
    throw err;
  }
}

export const isOfflineError = (err) => err?.code === 'SERVER_DOWN' || err?.code === 'NETWORK';

/** An answer that doesn't tell whether the request was carried out (so a retry must reuse its key). */
export const isUncertain = (err) => !(err instanceof ApiError) || err.code === 'NETWORK' || err.status >= 500 || err.status === 0;

function setOffline(code) {
  if (code === state.offline) return;
  const was = state.offline;
  state.offline = code;
  renderBanner();
  if (code && !retryTimer) retryTimer = setInterval(probe, RETRY_MS);
  if (!code && retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  if (!code && was) {
    toast(t('backOnline'), 'good');
    hooks.refresh({ soft: true, reconnect: true });
  }
}

/** Quietly asks the server whether it is back. Any answer but 503/no network means it is. */
async function probe() {
  try {
    await api('/api/parent/me');
    setOffline(null);
  } catch (err) {
    if (isOfflineError(err)) setOffline(err.code === 'NETWORK' ? 'NETWORK' : 'SERVER_DOWN');
    else setOffline(null);
  }
}

export function renderBanner() {
  const box = document.getElementById('banner');
  if (!box) return;
  if (!state.offline) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const down = state.offline === 'SERVER_DOWN';
  box.hidden = false;
  box.replaceChildren(
    h('div', { class: 'banner__inner' },
      icon('cloudOff', 'banner__icon'),
      h('div', { class: 'banner__text' },
        h('p', { class: 'banner__title' }, t(down ? 'offlineTitle' : 'networkTitle')),
        h('p', {}, t(down ? 'offlineText' : 'networkText')))),
  );
}

// ---- "signed in on this browser" hint -------------------------------------------------------

// The session cookie is HttpOnly, so the page cannot see it. Without this hint every first visit
// would ask GET /api/parent/me just to get a 401 (logged as an error by the browser).
const SESSION_HINT = 'onecard-parent-signed-in';

export const sessionHint = {
  /** true when this browser may hold a session (or storage is blocked and we cannot tell) */
  get() {
    try {
      return localStorage.getItem(SESSION_HINT) === '1';
    } catch {
      return true;
    }
  },
  set(on) {
    try {
      if (on) localStorage.setItem(SESSION_HINT, '1');
      else localStorage.removeItem(SESSION_HINT);
    } catch {
      // storage blocked: we simply ask the server every time
    }
  },
};

// ---- the family (children and links) --------------------------------------------------------

/** GET /api/parent/children, kept for the other pages. */
export async function loadFamily() {
  const family = await call('/api/parent/children');
  state.family = family;
  return family;
}

export const childKey = (schoolId, memberId) => `${schoolId}/${memberId}`;

export function findChild(schoolId, memberId) {
  return state.family?.children.find((c) => c.schoolId === schoolId && c.memberId === memberId) ?? null;
}

export const childPath = (c) => `#/child/${encodeURIComponent(c.schoolId)}/${encodeURIComponent(c.memberId)}`;

// ---- per-tab storage (survives the trip to the bank and back) -------------------------------

const PREFIX = 'onecard-parent:';
const memory = new Map();

export const store = {
  get(key) {
    try {
      const raw = sessionStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // storage blocked: the in-memory copy still covers this page
    }
  },
  del(key) {
    memory.delete(key);
    try {
      sessionStorage.removeItem(PREFIX + key);
    } catch {
      // ignore
    }
  },
  clear() {
    memory.clear();
    try {
      for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX)) sessionStorage.removeItem(k);
    } catch {
      // ignore
    }
  },
};

// ---- the trip to the bank -------------------------------------------------------------------

/** The order we sent the parent to the bank for. The bank sends them back to /parent/ with no reference. */
export const PENDING_PAYMENT = 'pending-payment';

/**
 * Remember the order, then open the bank's page. Only ever a bank page of this same site: any
 * other address from the API is ignored in favour of the order's own /pay/<id>.
 */
export function goToBank(order, payUrl) {
  const own = `/pay/${encodeURIComponent(order.id)}`;
  let path = own;
  try {
    const url = new URL(payUrl ?? own, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/pay/')) path = url.pathname;
  } catch {
    // not an address at all: use our own
  }
  store.set(PENDING_PAYMENT, { orderId: order.id, schoolId: order.schoolId, memberId: order.memberId, amountSen: order.amountSen });
  location.assign(path);
}

// ---- words for statuses, kinds and purchases ------------------------------------------------

const STATUS_TONE = {
  CREATED: '',
  PAID: 'warn',
  ADDED: 'good',
  PARKED: '', // not pill--info: its teal text is below 4.5:1 on the light theme
  EXPIRED: '',
  REFUNDED: '',
  FAILED: 'bad',
  CANCELLED: '',
};

export function statusPill(status) {
  const tone = STATUS_TONE[status] ?? '';
  const key = `status${status}`;
  const text = t(key);
  return h('span', { class: `pill${tone ? ` pill--${tone}` : ''}` }, text === key ? status : text);
}

/** 'NASI-LEMAK' -> 'Nasi lemak' (the parent API gives item codes only). */
export function itemName(code) {
  const words = String(code ?? '').toLowerCase().split('-').filter(Boolean);
  if (!words.length) return '';
  const text = words.join(' ');
  return text[0].toUpperCase() + text.slice(1);
}

/** 650 -> '0.65' */
export function litresText(ml) {
  const n = Number(ml) / 1000;
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/** 'DD/MM/YYYY HH:MM' (Kuala Lumpur) that never breaks between the date and the time. */
export const when = (value) => formatKL(value).replace(' ', '\u00a0');

/** 'RM 12.50' that never breaks between 'RM' and the number. */
export const money = (sen) => formatRM(sen).replace(' ', '\u00a0');

export const minus = (sen) => `−${money(Math.abs(sen))}`;

/** A big amount: a small 'RM' and the number, which may sit on two lines only between the two. */
export function bigAmount(sen) {
  const m = /^(-?)RM (.+)$/.exec(formatRM(sen));
  if (!m) return h('span', {}, formatRM(sen));
  return h('span', { class: 'amt' }, h('span', { class: 'amt__cur' }, `${m[1]}RM`), ' ', h('span', { class: 'amt__num' }, m[2]));
}

/** Initials for the round badge, skipping 'bin', 'binti', 'a/l', 'a/p'. */
export function initials(name) {
  const skip = new Set(['bin', 'binti', 'bt', 'a/l', 'a/p', 'b.', 'bt.']);
  const words = String(name ?? '').trim().split(/\s+/).filter((w) => !skip.has(w.toLowerCase()));
  return words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

// ---- small UI parts -------------------------------------------------------------------------

const ICONS = {
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  school: '<path d="M3 10.5 12 5l9 5.5"/><path d="M5 10v8.5h14V10"/><path d="M10 18.5v-4h4v4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  alert: '<path d="M12 4.2 21 19.5H3z"/><path d="M12 10v4.2"/><path d="M12 17.2v.1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.8v.1"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  bowl: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M9 3.8c-.8 1.3.8 2.2 0 3.6M13 3.8c-.8 1.3.8 2.2 0 3.6"/>',
  drop: '<path d="M12 3.6c3.6 4.3 6 7.4 6 10.4a6 6 0 0 1-12 0c0-3 2.4-6.1 6-10.4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V6.5M6.5 12 12 6.5l5.5 5.5"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.6"/><path d="M12 9v11M4 13.5h16"/><path d="M12 9C10.5 6 7 5.6 7 7.6S10 9 12 9c2 0 5 1.6 5-1.4S13.5 6 12 9z"/>',
  swap: '<path d="M4.5 8.5h14l-3.5-3.5M19.5 15.5h-14l3.5 3.5"/>',
  link: '<path d="M10 13.8a4 4 0 0 0 5.7.1l2.9-2.9a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10.2a4 4 0 0 0-5.7-.1l-2.9 2.9a4 4 0 0 0 5.7 5.7l1-1"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  bank: '<path d="M3.5 9 12 4.5 20.5 9"/><path d="M5.5 9.5v8M9.8 9.5v8M14.2 9.5v8M18.5 9.5v8"/><path d="M3.5 19.5h17"/>',
  cloudOff: '<path d="M7 18.5h9.5a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 9.3 4.6 4.6 0 0 0 7 18.5z"/><path d="M4 4l16 16"/>',
  hourglass: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 4.5 8 4.5 8 8.5s-8 4-8 8.5M16 3.5c0 4.5-8 4.5-8 8.5s8 4 8 8.5"/>',
  person: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c1.2-3.6 4-5.2 7-5.2s5.8 1.6 7 5.2"/>',
};

/** A decorative line icon (hidden from screen readers). */
export function icon(name, cls = '') {
  return h('span', {
    class: `icon${cls ? ` ${cls}` : ''}`,
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${ICONS[name] ?? ''}</svg>`,
  });
}

export function avatar(name, cls = '') {
  return h('span', { class: `avatar${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, initials(name));
}

/** A coloured box with an icon, a title and text. tone: info | warn | bad | good */
export function notice(tone, title, text, ...extra) {
  const ICON = { info: 'info', warn: 'alert', bad: 'alert', good: 'check' };
  return h('div', { class: `notice notice--${tone}` },
    icon(ICON[tone] ?? 'info', 'notice__icon'),
    h('div', { class: 'notice__body' },
      title ? h('p', { class: 'notice__title' }, title) : null,
      text ? h('p', { class: 'notice__text' }, text) : null,
      ...extra));
}

/** Plain words for an error from the API (or the network). */
export function errorText(err, vars = {}) {
  const code = err?.code ?? 'UNKNOWN';
  if (code === 'SERVER_DOWN') return t('offlineTitle');
  if (code === 'NETWORK') return t('networkTitle');
  const own = t(code, vars);
  if (own !== code) return own;
  return t('genericError', { code });
}

/** "We couldn't load this" with a Try again button. */
export function loadError(err, retry) {
  const text = isOfflineError(err) ? (err.code === 'NETWORK' ? t('networkText') : t('offlineText')) : errorText(err);
  return notice('warn', t('loadFailed'), text,
    retry ? h('div', { class: 'notice__actions' }, h('button', { type: 'button', class: 'btn btn--small', onclick: retry }, icon('refresh'), t('tryAgain'))) : null);
}

/** Grey placeholder lines while something loads. */
export function skeleton(lines = 3, cls = '') {
  return h('div', { class: `skel-group ${cls}`, 'aria-hidden': 'true' },
    ...Array.from({ length: lines }, (_, i) => h('div', { class: 'skel', style: `width:${[92, 68, 80, 55][i % 4]}%` })));
}

/**
 * The two money boxes, side by side and never added up: what the card holds (as the
 * platform last heard it) and what waits at the school's kiosk.
 */
export function moneyTiles(balance, { compact = false } = {}) {
  const asOf = balance.asOf ? t('asOf', { time: when(balance.asOf) }) : t('noCardUseYet');
  return h('div', { class: `money${compact ? ' money--compact' : ''}` },
    h('div', { class: 'tile tile--card' },
      h('p', { class: 'tile__label' }, icon('card'), t('onCard')),
      h('p', { class: 'tile__amount num' }, bigAmount(balance.mirrorBalanceSen)),
      h('p', { class: 'tile__meta' }, asOf)),
    h('div', { class: 'tile tile--waiting' },
      h('p', { class: 'tile__label' }, icon('hourglass'), t('waitingAtKiosk')),
      h('p', { class: 'tile__amount num' }, bigAmount(balance.waitingSen)),
      h('p', { class: 'tile__meta' }, t('notOnCardYet'))));
}

/** The school's name with a small building icon. */
export function schoolLine(name, cls = '') {
  return h('span', { class: `school${cls ? ` ${cls}` : ''}` }, icon('school'), h('span', {}, name));
}

/** 'Card ending 2E80' or the card's problem, as a small line. */
export function cardLine(card) {
  if (!card) return h('span', { class: 'cardline cardline--warn' }, icon('card'), t('noCardShort'));
  if (card.status === 'LOST') return h('span', { class: 'cardline cardline--bad' }, icon('card'), `${t('cardLostShort')} · ${card.last4}`);
  if (card.status !== 'ACTIVE') return h('span', { class: 'cardline cardline--warn' }, icon('card'), `${t('cardRetiredShort')} · ${card.last4}`);
  return h('span', { class: 'cardline' }, icon('card'), t('cardEnding', { last4: card.last4 }));
}

export function setTitle(text) {
  document.title = text ? `${text} · ${t('appTitle')}` : t('appTitle');
}

/** Disable a button and show what it is doing; returns a function that puts it back. */
export function busy(button, label) {
  const before = [...button.childNodes];
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.replaceChildren(...before);
  };
}
