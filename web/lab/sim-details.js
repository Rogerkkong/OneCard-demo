// Packet details of the Simulation tab, like Packet Tracer's PDU window: the current step's
// layers, one section each, shown only when they apply (sim-steps.js says which): What
// happened, Card, Machine checks, Message, Security, MQTT, HTTP, Platform checks, Books, and the
// raw event as JSON (copyable). Everything is set as text, never as HTML.

import { h, toast } from '/shared/api.js';
import { prefs } from './util.js';

const MARKS = { ok: '✓', bad: '✗', warn: '!', skip: '–' };
// the colour of each section: the layer it belongs to
const SECTION_LAYER = {
  card: 'card',
  machine: 'machine',
  message: 'mqtt',
  security: 'lab',
  mqtt: 'mqtt',
  http: 'http',
  platform: 'platform',
  books: 'books',
  held: 'lab',
  raw: 'lab',
};

function value(v) {
  if (v && typeof v === 'object') return h('span', { class: v.mono ? 'mono' : null }, v.text);
  return document.createTextNode(String(v ?? '—'));
}

function rowsOf(rows) {
  return h(
    'dl',
    { class: 'pd__rows' },
    rows.map(([label, v]) => h('div', { class: 'pd__row' }, h('dt', {}, value(label)), h('dd', {}, value(v)))),
  );
}

function checksOf(checks, t) {
  return h(
    'ul',
    { class: 'pd__checks' },
    checks.map((c) =>
      h(
        'li',
        { class: `pd__check pd__check--${c.state}` },
        h('span', { class: 'pd__mark', 'aria-hidden': 'true' }, MARKS[c.state] ?? '·'),
        h('span', { class: 'sr-only' }, `${t(`pd.state.${c.state}`)}: `),
        h('span', { class: 'pd__label' }, c.label),
        c.value ? h('span', { class: 'pd__value' }, c.value) : null,
      ),
    ),
  );
}

function linesOf(lines, t) {
  return h(
    'div',
    { class: 'table-wrap pd__lineswrap' },
    h(
      'table',
      { class: 'pd__lines' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('pd.books.side')), h('th', { scope: 'col' }, t('pd.books.account')), h('th', { scope: 'col', class: 'num' }, t('pd.books.amount')))),
      h(
        'tbody',
        {},
        lines.map((l) => h('tr', {}, h('td', { class: 'mono' }, l.side === 'DR' ? t('ev.dr') : t('ev.cr')), h('td', {}, l.account), h('td', { class: 'num' }, l.amount))),
      ),
    ),
  );
}

async function copyText(text, t) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('pd.copied'), 'good');
  } catch {
    toast(t('pd.copyFailed'), 'warn');
  }
}

/**
 * Fill `container` with the sections of a step.
 * @param {HTMLElement} container
 * @param {object} step  a step of sim-steps.js (null: empty)
 * @param {{ t: Function }} options
 */
export function renderDetails(container, step, { t }) {
  if (!step) {
    container.replaceChildren();
    return;
  }
  const out = [];
  for (const s of step.sections) {
    const titleId = `pd-${s.id}-title`;
    const body = [];
    if (s.id === 'what') {
      body.push(h('p', { class: 'pd__text' }, s.text));
      if (s.note) body.push(h('p', { class: 'pd__note muted' }, s.note));
    } else if (s.id === 'raw') {
      const pre = h('pre', { class: 'pd__json', tabindex: '0', 'aria-label': t('pd.raw') }, s.json);
      const copy = h('button', { type: 'button', class: 'btn btn--small' }, t('pd.copy'));
      copy.addEventListener('click', () => copyText(s.json, t));
      const details = h(
        'details',
        { class: 'pd__raw' },
        h('summary', { class: 'pd__rawsummary' }, t('pd.raw.summary', { seq: s.seq })),
        h('div', { class: 'pd__rawbody' }, h('p', { class: 'pd__note muted' }, t('pd.raw.note')), copy, pre),
      );
      details.open = prefs.get('sim.rawOpen', false) === true;
      details.addEventListener('toggle', () => prefs.set('sim.rawOpen', details.open));
      body.push(details);
    } else {
      if (s.checksFirst && s.checks?.length) body.push(checksOf(s.checks, t));
      if (s.rows?.length) body.push(rowsOf(s.rows));
      if (!s.checksFirst && s.checks?.length) body.push(checksOf(s.checks, t));
      if (s.lines?.length) body.push(linesOf(s.lines, t));
      if (s.note) body.push(h('p', { class: 'pd__note muted' }, s.note));
    }
    if (s.id === 'raw') {
      out.push(h('section', { class: 'pd pd--raw', dataset: { layer: 'lab' } }, ...body));
      continue;
    }
    out.push(
      h(
        'section',
        { class: `pd pd--${s.id}`, 'aria-labelledby': titleId, dataset: { layer: s.id === 'what' ? step.layer : SECTION_LAYER[s.id] ?? 'lab' } },
        h('h4', { class: 'pd__title', id: titleId }, t(`pd.${s.id}`)),
        ...body,
      ),
    );
  }
  container.replaceChildren(...out);
}
