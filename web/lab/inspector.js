// The message inspector: every lab event as it happens (time, school, machine, type and a
// one-line summary), filtered by school and by kind, with pause and clear. A click on a row
// shows the event's full JSON and what that type of event means.

import { formatKL, formatTimeKL, h } from '/shared/api.js';
import { KINDS, explain, isHeartbeat, isTrouble, kindOf, machineOf, summarize } from './describe.js';
import { eventSentence } from './sim-steps.js';
import { prefs, reducedMotion, setAttr, setHidden, setText } from './util.js';

const MAX_ITEMS = 1500; // events kept in memory
const MAX_ROWS = 400; // rows in the list at once
const MAX_KNOWN = 300; // flows and waiting items remembered for the summaries of Simulation mode's events
const narrow = window.matchMedia('(max-width: 1023px)');

/** 'intake.accepted' with a line-break chance after each dot, so a narrow column breaks there. */
function breakable(type) {
  const parts = String(type).split('.');
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [`${part}.`, h('wbr')] : [part]));
}

export function createInspector(app, root) {
  const { t } = app;
  const q = (sel) => root.querySelector(sel);
  const title = q('#insp-title');
  const liveEl = q('.insp__live');
  const liveText = q('.insp__livetext');
  const schoolLabel = q('label[for="insp-school"]');
  const schoolSelect = q('#insp-school');
  const kindsLabel = q('#insp-kinds-label');
  const kindsEl = q('.insp__kinds-list');
  const hbInput = q('#insp-hb');
  const hbLabel = q('.insp__hb-text');
  const pauseBtn = q('[data-role="pause"]');
  const clearBtn = q('[data-role="clear"]');
  const countEl = q('.insp__count');
  const headEl = q('.insp__head');
  const list = q('.insp__list');
  const emptyEl = q('.insp__empty');
  const detail = q('.insp__detail');
  const detailTitle = q('#insp-detail-title');
  const detailExplain = q('.insp__explain');
  const detailJson = q('.insp__json');
  const detailClose = q('[data-role="close-detail"]');

  let nextId = 1;
  let items = [];
  let pending = [];
  let paused = false;
  let matching = 0;
  let selectedId = null;
  let live = 'connecting';
  // Simulation mode's events (a machine's steps, its sends, the broker's acknowledgements, the
  // flows and what waits) have no summary of their own: they say what their step of a flow says
  const flows = new Map(); // trace id -> its sim.trace (title, device): a forged message's flow, the card it is about
  const waiting = new Map(); // held item id -> the item (sim.held), for its sim.released
  const remember = (map, key, value) => {
    map.set(key, value);
    if (map.size > MAX_KNOWN) map.delete(map.keys().next().value);
  };
  function summaryOf(e) {
    const text = summarize(e, t, app.i18n.lang);
    if (text) return text;
    return eventSentence(e, { t, lang: app.i18n.lang, trace: flows.get(e.trace) ?? null, held: waiting });
  }
  const filters = {
    school: String(prefs.get('insp.school', '') ?? ''),
    kinds: new Set([].concat(prefs.get('insp.kinds', KINDS)).filter((k) => KINDS.includes(k))),
    heartbeats: prefs.get('insp.heartbeats', false) === true,
  };

  // ---- filters ---------------------------------------------------------------------------

  const kindButtons = KINDS.map((kind) => {
    const b = h('button', { type: 'button', class: `chip chip--${kind}`, 'aria-pressed': String(filters.kinds.has(kind)), dataset: { kind } }, h('span', { class: 'chip__dot', 'aria-hidden': 'true' }), h('span', { class: 'chip__text' }));
    b.addEventListener('click', () => {
      if (filters.kinds.has(kind)) filters.kinds.delete(kind);
      else filters.kinds.add(kind);
      setAttr(b, 'aria-pressed', String(filters.kinds.has(kind)));
      prefs.set('insp.kinds', [...filters.kinds]);
      rebuild();
    });
    return b;
  });
  kindsEl.append(...kindButtons);
  hbInput.checked = filters.heartbeats;
  hbInput.addEventListener('change', () => {
    filters.heartbeats = hbInput.checked;
    prefs.set('insp.heartbeats', filters.heartbeats);
    rebuild();
  });
  schoolSelect.addEventListener('change', () => {
    filters.school = schoolSelect.value;
    prefs.set('insp.school', filters.school);
    rebuild();
  });
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    if (!paused) {
      const queued = pending;
      pending = [];
      for (const item of queued) keep(item);
      rebuild();
    }
    relabel();
  });
  clearBtn.addEventListener('click', clear);
  detailClose.addEventListener('click', closeDetail);

  function visible(item) {
    // a school keeps its own events and the lab-wide ones (server, broker, clock), like ?school= does
    const school = item.e.school ?? null;
    if (filters.school === '__lab' ? school !== null : filters.school && school !== null && school !== filters.school) return false;
    if (!filters.kinds.has(item.kind)) return false;
    if (item.hb && !filters.heartbeats) return false;
    return true;
  }

  // ---- rows ------------------------------------------------------------------------------

  function createRow(item) {
    const e = item.e;
    const button = h(
      'button',
      { type: 'button', class: 'ev__btn', tabindex: '-1', 'aria-controls': 'insp-detail', 'aria-expanded': String(selectedId === item.id) },
      h('span', { class: 'ev__time num' }, formatTimeKL(e.at)),
      h('span', { class: 'ev__school' }, e.school ?? t('insp.server')),
      h('span', { class: 'ev__machine' }, item.machine || '—'),
      h('span', { class: 'ev__type' }, h('span', { class: 'ev__dot', 'aria-hidden': 'true' }), h('span', {}, breakable(e.type))),
      h('span', { class: 'ev__summary' }, summaryOf(e)),
    );
    button.addEventListener('click', (ev) => openDetail(item, ev.detail === 0));
    const li = h('li', { class: `ev ev--${item.kind}${item.trouble ? ' ev--trouble' : ''}`, dataset: { id: String(item.id) } }, button);
    if (selectedId === item.id) li.classList.add('is-selected');
    return li;
  }

  /** Exactly one row is in the tab order; arrow keys move between rows. */
  function ensureTabStop() {
    const current = list.querySelector('.ev__btn[tabindex="0"]');
    if (current) return;
    const first = list.querySelector('.ev__btn');
    if (first) first.tabIndex = 0;
  }

  list.addEventListener('keydown', (ev) => {
    const btn = ev.target.closest('.ev__btn');
    if (!btn) return;
    const rows = [...list.querySelectorAll('.ev__btn')];
    const i = rows.indexOf(btn);
    let next = null;
    if (ev.key === 'ArrowDown') next = rows[i + 1];
    else if (ev.key === 'ArrowUp') next = rows[i - 1];
    else if (ev.key === 'Home') next = rows[0];
    else if (ev.key === 'End') next = rows[rows.length - 1];
    if (!next) return;
    ev.preventDefault();
    btn.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });

  function trimRows() {
    while (list.children.length > MAX_ROWS) list.lastElementChild.remove();
  }

  function updateCount() {
    setText(countEl, t('insp.count', { shown: matching, total: items.length }));
    const none = list.children.length === 0;
    const onlyHeartbeats = items.length > 0 && !filters.heartbeats && items.every((x) => x.hb || !visible({ ...x, hb: false }));
    setText(emptyEl, items.length === 0 ? t('insp.empty') : onlyHeartbeats ? t('insp.onlyHeartbeats') : t('insp.emptyFiltered'));
    setHidden(emptyEl, !none);
  }

  function rebuild() {
    matching = 0;
    const rows = [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (!visible(items[i])) continue;
      matching += 1;
      if (rows.length < MAX_ROWS) rows.push(createRow(items[i]));
    }
    list.replaceChildren(...rows);
    ensureTabStop();
    updateCount();
  }

  function keep(item) {
    items.push(item);
    if (visible(item)) matching += 1;
    while (items.length > MAX_ITEMS) {
      const old = items.shift();
      if (visible(old)) matching -= 1;
      list.querySelector(`li[data-id="${old.id}"]`)?.remove();
    }
  }

  /** A new event from the stream. */
  function add(e) {
    const d = e.data ?? {};
    if (e.type === 'sim.trace' && typeof d.id === 'string') remember(flows, d.id, { id: d.id, kind: d.kind, title: d.title, subject: d.subject ?? {}, school: e.school ?? null, device: d.device ?? null });
    if (e.type === 'sim.held' && typeof d.id === 'string') remember(waiting, d.id, d);
    const item = { id: nextId++, e, kind: kindOf(e), hb: isHeartbeat(e), trouble: isTrouble(e), machine: machineOf(e) };
    if (paused) {
      pending.push(item);
      if (pending.length > MAX_ITEMS) pending.shift();
      relabelLive();
      return;
    }
    keep(item);
    if (visible(item)) {
      list.prepend(createRow(item));
      trimRows();
      ensureTabStop();
    }
    updateCount();
  }

  function clear() {
    items = [];
    pending = [];
    matching = 0;
    list.replaceChildren();
    closeDetail();
    updateCount();
    relabelLive();
  }

  // ---- details ---------------------------------------------------------------------------

  function openDetail(item, fromKeyboard) {
    selectedId = item.id;
    for (const li of list.querySelectorAll('li.is-selected')) {
      li.classList.remove('is-selected');
      li.firstElementChild.setAttribute('aria-expanded', 'false');
    }
    const li = list.querySelector(`li[data-id="${item.id}"]`);
    if (li) {
      li.classList.add('is-selected');
      li.firstElementChild.setAttribute('aria-expanded', 'true');
    }
    detail._item = item;
    fillDetail();
    setHidden(detail, false);
    // on a narrow screen the details sit below the list, out of sight
    if (narrow.matches) detail.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    if (fromKeyboard) detailTitle.focus({ preventScroll: narrow.matches });
  }

  function fillDetail() {
    const item = detail._item;
    if (!item) return;
    const e = item.e;
    setText(detailTitle, `${e.type} · ${formatKL(e.at)}:${formatTimeKL(e.at).slice(6)}`);
    setText(detailExplain, `${explain(e.type, t)} ${summaryOf(e)}`);
    setText(detailJson, JSON.stringify(e, null, 2));
  }

  function closeDetail() {
    const li = selectedId !== null ? list.querySelector(`li[data-id="${selectedId}"]`) : null;
    selectedId = null;
    detail._item = null;
    setHidden(detail, true);
    if (li) {
      li.classList.remove('is-selected');
      li.firstElementChild.setAttribute('aria-expanded', 'false');
      li.firstElementChild.focus();
    }
  }

  // ---- labels ----------------------------------------------------------------------------

  function relabelLive() {
    liveEl.dataset.state = paused ? 'paused' : live;
    if (paused) setText(liveText, t('insp.pausedCount', { n: pending.length }));
    else setText(liveText, live === 'live' ? t('insp.live') : t('insp.reconnecting'));
  }

  function relabel() {
    setText(title, t('insp.title'));
    setText(schoolLabel, t('insp.school'));
    setText(kindsLabel, t('insp.kinds'));
    for (const b of kindButtons) setText(b.lastChild, t(`kind.${b.dataset.kind}`));
    setText(hbLabel, t('insp.heartbeats'));
    setText(pauseBtn, paused ? t('insp.resume') : t('insp.pause'));
    setAttr(pauseBtn, 'aria-pressed', String(paused));
    setText(clearBtn, t('insp.clear'));
    setText(detailClose, t('close'));
    for (const el of headEl.querySelectorAll('[data-key]')) setText(el, t(el.dataset.key));
    relabelLive();
    updateCount();
  }

  /** New schools appear in the filter; the choice is kept. */
  function update(state) {
    const options = [
      ['', t('insp.allSchools')],
      ...(state?.schools ?? []).map((s) => [s.code, `${s.name} (${s.code})`]),
      ['__lab', t('insp.labOnly')],
    ];
    const sig = JSON.stringify(options);
    if (schoolSelect.dataset.sig !== sig) {
      schoolSelect.replaceChildren(...options.map(([value, text]) => h('option', { value }, text)));
      schoolSelect.dataset.sig = sig;
    }
    if (![...schoolSelect.options].some((o) => o.value === filters.school)) filters.school = '';
    schoolSelect.value = filters.school;
  }

  function setLive(state) {
    live = state;
    relabelLive();
  }

  /** The page's language changed: every summary is written again. */
  function relang() {
    relabel();
    schoolSelect.dataset.sig = '';
    update(app.state);
    rebuild();
    fillDetail();
  }

  relabel();
  updateCount();
  return { add, update, setLive, relang, clear };
}
