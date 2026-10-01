// Small DOM helpers for the lab console. The page patches elements in place (rather than
// rebuilding them) so focus, open menus and dialogs survive the state refreshes that arrive
// every couple of seconds. Everything that comes from the lab is set as text, never as HTML.

import { h } from '/shared/api.js';

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function setText(el, text) {
  const value = text === null || text === undefined ? '' : String(text);
  if (el.textContent !== value) el.textContent = value;
}

/** Set (or with null/false remove) an attribute, only when it changes. */
export function setAttr(el, name, value) {
  if (value === null || value === undefined || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const v = value === true ? '' : String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export function setHidden(el, hidden) {
  if (el.hidden !== Boolean(hidden)) el.hidden = Boolean(hidden);
}

/** Replace a class from a family (e.g. 'pill--good' among 'pill--*'). */
export function setTone(el, prefix, tone) {
  for (const c of [...el.classList]) if (c.startsWith(prefix) && c !== `${prefix}${tone}`) el.classList.remove(c);
  if (tone) el.classList.add(`${prefix}${tone}`);
}

/**
 * Keyed update of a container's children: existing elements (data-key) are kept and patched,
 * new ones created, missing ones removed, and the order follows `items`.
 */
export function reconcile(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const el of [...container.children]) {
    if (el.dataset.key !== undefined) existing.set(el.dataset.key, el);
    else el.remove();
  }
  let prev = null;
  for (const item of items) {
    const key = keyOf(item);
    let el = existing.get(key);
    if (el) existing.delete(key);
    else {
      el = create(item);
      el.dataset.key = key;
    }
    update(el, item);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (el !== want) container.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

/** Translated text with `code` parts as <code> nodes (text only, never HTML). */
export function rich(text) {
  const out = [];
  String(text)
    .split('`')
    .forEach((part, i) => {
      if (part === '') return;
      out.push(i % 2 === 1 ? h('code', {}, part) : document.createTextNode(part));
    });
  return out;
}

/** Save a JSON value as a file in the browser's downloads. */
export function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Read and write small per-browser preferences; storage may be blocked. */
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`onecard-lab-console.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`onecard-lab-console.${key}`, JSON.stringify(value));
    } catch {
      // storage blocked: the preference lasts until the page closes
    }
  },
};

/** While `fn` runs, the button is disabled and says what is happening. */
export async function busy(button, label, fn) {
  if (!button) return fn();
  const before = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (label) button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (label && button.textContent === label) button.textContent = before;
  }
}

/** A KL clock time HH:MM from lab ms (formatKL gives the date too). */
export function hhmm(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
}

// Line icons, static markup drawn with currentColor (24×24).
const ICONS = {
  cloud: '<path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.56A6.2 6.2 0 0 0 5.9 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  broker:
    '<circle cx="12" cy="12" r="2.6"/><circle cx="4.8" cy="5.5" r="1.8"/><circle cx="19.2" cy="5.5" r="1.8"/><circle cx="4.8" cy="18.5" r="1.8"/><circle cx="19.2" cy="18.5" r="1.8"/><path d="M6.3 6.9l3.7 3.3M17.7 6.9l-3.7 3.3M6.3 17.1l3.7-3.3M17.7 17.1l-3.7-3.3"/>',
  platform: '<path d="M12 3.5l8.5 4.6L12 12.7 3.5 8.1 12 3.5z"/><path d="M3.5 12.2l8.5 4.6 8.5-4.6"/><path d="M3.5 16.2l8.5 4.6 8.5-4.6"/>',
  db: '<ellipse cx="12" cy="5.6" rx="7" ry="2.6"/><path d="M5 5.6v12.8c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6V5.6"/><path d="M5 12c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6"/>',
  CANTEEN:
    '<rect x="5.5" y="2.5" width="13" height="19" rx="2"/><rect x="8.2" y="5.2" width="7.6" height="4.8" rx="0.8"/><path d="M9 13.5h.01M12 13.5h.01M15 13.5h.01M9 17h.01M12 17h.01M15 17h.01"/>',
  WATER: '<path d="M12 3.2s-6.2 6.8-6.2 11.3a6.2 6.2 0 0 0 12.4 0C18.2 10 12 3.2 12 3.2z"/><path d="M9.2 15.2a2.9 2.9 0 0 0 2.6 2.7"/>',
  KIOSK:
    '<rect x="4" y="2.5" width="16" height="12.5" rx="2"/><path d="M8 7.5h8M8 10.5h5M12 15v6M8 21h8"/>',
  school: '<path d="M3.5 10.2L12 4.5l8.5 5.7"/><path d="M5.5 9v11h13V9"/><path d="M10 20v-5h4v5"/>',
  router:
    '<rect x="3" y="13.5" width="18" height="6.5" rx="1.8"/><path d="M7 16.75h.01M10.5 16.75h.01M12 13.5V9"/><path d="M8.8 7.2a4.5 4.5 0 0 1 6.4 0M6.4 4.8a8 8 0 0 1 11.2 0"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  bolt: '<path d="M13.2 2.8L5.5 13.4h6l-.9 7.8 7.9-10.8h-6.1l.8-7.6z"/>',
  card: '<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><rect x="5.5" y="9" width="4.5" height="3.6" rx="0.6"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M6.5 9l3 3-3 3M11.5 15h5"/>',
  messages: '<path d="M4 5h16v10H9l-5 4V5z"/><path d="M8 9h8M8 12h5"/>',
};

/** An inline SVG icon (decorative: hidden from assistive technology). */
export function icon(name, cls = 'icon') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  // static markup from the table above only
  span.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false">${ICONS[name] ?? ''}</svg>`;
  return span;
}
