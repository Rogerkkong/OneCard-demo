// Small fetch wrapper shared by the lab console, the school office and the parent app.
// Errors from the lab come back as { error: { code, message, detail } }.

export class ApiError extends Error {
  constructor(code, message, status, detail) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @param {string} path  e.g. '/api/admin/members'
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [opts]
 */
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the lab server. Is it still running?', 0);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const e = data && data.error ? data.error : { code: `HTTP_${res.status}`, message: res.statusText };
    throw new ApiError(e.code, e.message, res.status, e.detail);
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body, headers) => api(path, { method: 'POST', body: body ?? {}, headers });

/** 1250 -> 'RM 12.50' */
export function formatRM(sen) {
  if (sen === null || sen === undefined || Number.isNaN(sen)) return '—';
  const sign = sen < 0 ? '-' : '';
  const abs = Math.abs(sen);
  return `${sign}RM ${Math.floor(abs / 100).toLocaleString('en-MY')}.${String(abs % 100).padStart(2, '0')}`;
}

/** '12.5' -> 1250, or null if it is not a ringgit amount. */
export function parseRM(text) {
  const m = /^\s*(?:RM\s*)?(\d{1,7})(?:\.(\d{1,2}))?\s*$/i.exec(String(text));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

const KL = 8 * 60 * 60 * 1000;

/** ISO string or ms -> 'DD/MM/YYYY HH:MM' in Kuala Lumpur time. */
export function formatKL(value) {
  if (value === null || value === undefined || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return '—';
  const iso = new Date(ms + KL).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
}

/** ISO string or ms -> 'HH:MM:SS' in Kuala Lumpur time. */
export function formatTimeKL(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms + KL).toISOString().slice(11, 19);
}

/** Create an element: h('button', { class: 'btn', onclick }, 'Save') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v; // only for trusted, static markup
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Brief message in the corner. tone: 'info' | 'good' | 'warn' | 'bad' */
export function toast(message, tone = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const item = h('div', { class: `toast toast--${tone}` }, message);
  box.append(item);
  setTimeout(() => item.remove(), 4200);
}

/** A new random idempotency key (one per user action, reused on retry). */
export function newIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
