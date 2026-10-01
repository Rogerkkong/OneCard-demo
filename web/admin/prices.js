// Prices & settings: edit the price list (canteen items and the water tariff) and the machines'
// settings, publish a new version, and see whether it reached each machine. Also the block
// list (last 4 digits only) and the version history.

import { h, formatRM, formatKL, parseRM } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, openDialog, errorMessage, pill } from './kit.js';
import { versionsTable, KINDS } from './machines.js';
import { cardName, cardPill } from './cards.js';

const ITEM_CODE_RE = /^[A-Z0-9-]{1,24}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 350 -> '3.50' for an input box. */
const senText = (sen) => (Number.isSafeInteger(sen) ? `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, '0')}` : '');

let fieldSeq = 0;
/** An input with its label and a place for its error message. */
function field(label, input, hint) {
  const id = input.id || `pf${++fieldSeq}`;
  input.id = id;
  const err = h('span', { class: 'field-error', id: `${id}-err`, hidden: true });
  const hintEl = hint ? h('span', { class: 'field-hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hintEl, err);
}

/** Mark `input` as wrong (message next to it) or clear it (message null). */
function mark(input, message) {
  let err = document.getElementById(`${input.id}-err`);
  if (!err) {
    err = h('span', { class: 'field-error', id: `${input.id}-err` });
    (input.closest('.money-input') ?? input).after(err);
  }
  err.textContent = message ?? '';
  err.hidden = !message;
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  const hint = document.getElementById(`${input.id}-hint`);
  input.setAttribute('aria-describedby', [message ? err.id : null, hint ? hint.id : null].filter(Boolean).join(' ') || '');
  return !message;
}

/** sen from an input, within [min, max]; null when wrong. */
function moneyIn(input, min, max) {
  const sen = parseRM(input.value);
  return sen !== null && sen >= min && sen <= max ? sen : null;
}

export async function renderPrices(ctx, el) {
  const { t, api } = ctx;
  el.append(sectionHead({ title: t('nav.prices'), text: t('pr.lede'), actions: [h('button', { type: 'button', class: 'btn btn--small', onclick: () => loadSide() }, t('pr.refreshSide'))] }));
  const pricesBox = h('section', { class: 'panel stack' }, h('p', { class: 'muted' }, t('kit.loading')));
  const settingsBox = h('section', { class: 'panel stack' });
  const versionsBox = h('div');
  const blockBox = h('div');
  const historyBox = h('div');
  el.append(
    pricesBox,
    settingsBox,
    panel(t('pr.reached'), h('p', { class: 'muted small' }, t('pr.reachedText')), versionsBox),
    panel(t('pr.blocklist'), h('p', { class: 'muted small' }, t('pr.blocklistText')), blockBox),
    panel(t('pr.history'), historyBox),
  );

  let configs = null;

  async function load() {
    try {
      configs = await api.get('/api/admin/configs');
    } catch (err) {
      if (ctx.alive() && !configs) pricesBox.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    drawPrices(configs.prices);
    drawSettings(configs.settings);
    drawHistory(configs.history);
    await loadSide();
  }

  /** The read-only panels: versions on each machine and the block list. */
  async function loadSide() {
    let states;
    let devices;
    let block;
    try {
      [states, devices, block] = await Promise.all([api.get('/api/admin/devices/states'), api.get('/api/admin/devices'), api.get('/api/admin/blocklist')]);
    } catch (err) {
      if (ctx.alive() && !versionsBox.firstChild) versionsBox.replaceChildren(loadProblem(t, err, loadSide));
      return;
    }
    if (!ctx.alive()) return;
    versionsBox.replaceChildren(versionsTable(ctx, states, KINDS, devices));
    blockBox.replaceChildren(
      h('p', {}, h('strong', {}, t('pr.blockVersion', { v: block.version })), ' ', h('span', { class: 'muted' }, t('pr.since', { at: formatKL(block.createdAt) }))),
      dataTable({
        label: t('pr.blocklist'),
        head: [t('cards.card'), t('cards.holder'), t('cards.status')],
        empty: t('pr.blockEmpty'),
        compact: true,
        rows: block.entries.map((e) => [
          h('span', { class: 'mono strong' }, cardName(e.last4)),
          e.memberId ? h('a', { href: `#/students/${encodeURIComponent(e.memberId)}` }, e.memberName ?? '—') : '—',
          e.cardStatus ? cardPill(t, e.cardStatus) : '—',
        ]),
      }),
    );
  }

  /** After a publish, look again a little later: networked machines confirm within seconds. */
  function followUp() {
    for (const ms of [1500, 5000]) setTimeout(() => ctx.alive() && loadSide(), ms);
  }

  function sentNote(published, kindKey) {
    return published ? t('pr.sent', { what: t(kindKey) }) : t('pr.notSent');
  }

  // ---- price list --------------------------------------------------------------------------

  function drawPrices(current) {
    const content = current?.content ?? { items: [], water: { perLitreSen: 20, minChargeSen: 5 } };
    const rowsBody = h('tbody');
    const status = h('p', { class: 'form-status', role: 'status' });

    function addRow(item = { code: '', name: '', priceSen: null }) {
      const code = h('input', { type: 'text', class: 'mono', value: item.code, maxlength: 24, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('pr.code') });
      const name = h('input', { type: 'text', value: item.name, maxlength: 40, autocomplete: 'off', 'aria-label': t('pr.itemName') });
      const price = h('input', { type: 'text', inputmode: 'decimal', class: 'num', value: senText(item.priceSen), autocomplete: 'off', 'aria-label': t('pr.price') });
      for (const input of [code, name, price]) input.id = `pf${++fieldSeq}`;
      code.addEventListener('input', () => {
        const up = code.value.toUpperCase();
        if (up !== code.value) code.value = up;
      });
      const tr = h('tr', { class: 'item-row' });
      const remove = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, t('pr.remove'));
      remove.addEventListener('click', () => {
        const next = tr.nextElementSibling ?? tr.previousElementSibling;
        tr.remove();
        (next?.querySelector('input') ?? addBtn).focus();
      });
      const relabel = () => remove.setAttribute('aria-label', t('pr.removeItem', { name: name.value || code.value || '—' }));
      name.addEventListener('input', relabel);
      relabel();
      tr.append(h('td', {}, code), h('td', {}, name), h('td', { class: 'num' }, h('span', { class: 'money-input' }, h('span', { class: 'muted', 'aria-hidden': 'true' }, 'RM'), price)), h('td', {}, remove));
      tr._inputs = { code, name, price };
      rowsBody.append(tr);
      return tr;
    }

    for (const item of content.items) addRow(item);
    const addBtn = h('button', { type: 'button', class: 'btn btn--small' }, t('pr.addItem'));
    addBtn.addEventListener('click', () => addRow().querySelector('input').focus());

    const perLitre = h('input', { type: 'text', inputmode: 'decimal', value: senText(content.water?.perLitreSen), autocomplete: 'off' });
    const minCharge = h('input', { type: 'text', inputmode: 'decimal', value: senText(content.water?.minChargeSen), autocomplete: 'off' });

    function read() {
      let ok = true;
      const items = [];
      const seen = new Set();
      for (const tr of rowsBody.querySelectorAll('tr')) {
        const { code, name, price } = tr._inputs;
        const c = code.value.trim().toUpperCase();
        const n = name.value.trim();
        const p = moneyIn(price, 1, 100000);
        ok = mark(code, !ITEM_CODE_RE.test(c) ? t('pr.err.code') : seen.has(c) ? t('pr.err.codeTwice') : null) && ok;
        ok = mark(name, n.length < 1 || n.length > 40 ? t('pr.err.name') : null) && ok;
        ok = mark(price, p === null ? t('pr.err.price') : null) && ok;
        seen.add(c);
        items.push({ code: c, name: n, priceSen: p });
      }
      const water = { perLitreSen: moneyIn(perLitre, 1, 10000), minChargeSen: moneyIn(minCharge, 0, 10000) };
      ok = mark(perLitre, water.perLitreSen === null ? t('pr.err.perLitre') : null) && ok;
      ok = mark(minCharge, water.minChargeSen === null ? t('pr.err.minCharge') : null) && ok;
      if (items.length < 1 || items.length > 50) {
        status.textContent = t('pr.err.items');
        return null;
      }
      if (!ok) {
        status.textContent = t('pr.fixFirst');
        pricesBox.querySelector('[aria-invalid="true"]')?.focus();
        return null;
      }
      status.textContent = '';
      return { ...content, items, water };
    }

    function changes(next) {
      const out = [];
      const before = new Map(content.items.map((i) => [i.code, i]));
      const after = new Map(next.items.map((i) => [i.code, i]));
      for (const i of next.items) {
        const old = before.get(i.code);
        if (!old) out.push(t('pr.chAdded', { name: i.name, price: formatRM(i.priceSen) }));
        else {
          if (old.priceSen !== i.priceSen) out.push(t('pr.chPrice', { name: i.name, from: formatRM(old.priceSen), to: formatRM(i.priceSen) }));
          if (old.name !== i.name) out.push(t('pr.chName', { from: old.name, to: i.name }));
        }
      }
      for (const i of content.items) if (!after.has(i.code)) out.push(t('pr.chRemoved', { name: i.name }));
      if (content.water?.perLitreSen !== next.water.perLitreSen) out.push(t('pr.chLitre', { from: formatRM(content.water?.perLitreSen), to: formatRM(next.water.perLitreSen) }));
      if (content.water?.minChargeSen !== next.water.minChargeSen) out.push(t('pr.chMin', { from: formatRM(content.water?.minChargeSen), to: formatRM(next.water.minChargeSen) }));
      return out;
    }

    const publish = h('button', { type: 'submit', class: 'btn btn--primary' }, t('pr.publish'));
    const undo = h('button', { type: 'button', class: 'btn' }, t('pr.undo'));
    undo.addEventListener('click', () => drawPrices(current));

    const form = h(
      'form',
      { class: 'stack', novalidate: true },
      h(
        'div',
        { class: 'table-wrap', role: 'region', 'aria-label': t('pr.items') },
        h(
          'table',
          { class: 'editor' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('pr.code')), h('th', { scope: 'col' }, t('pr.itemName')), h('th', { scope: 'col', class: 'num' }, t('pr.price')), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('pr.remove'))))),
          rowsBody,
        ),
      ),
      h('div', { class: 'row' }, addBtn, h('span', { class: 'muted small' }, t('pr.codeHint'))),
      h(
        'fieldset',
        { class: 'fieldset' },
        h('legend', {}, t('pr.water')),
        h('div', { class: 'form-grid' }, field(t('pr.perLitre'), perLitre, t('pr.perLitreHint')), field(t('pr.minCharge'), minCharge, t('pr.minChargeHint'))),
      ),
      status,
      h('div', { class: 'row' }, publish, undo),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = read();
      if (!next) return;
      const list = changes(next);
      if (list.length === 0) {
        status.textContent = t('pr.nothing', { v: current?.version ?? 0 });
        return;
      }
      let latest = null;
      try {
        latest = await api.get('/api/admin/configs');
      } catch (err) {
        status.textContent = errorMessage(t, err);
        return;
      }
      const raced = latest.prices && current && latest.prices.version !== current.version;
      const out = await openDialog({
        t,
        title: t('pr.confirmTitle', { v: (latest.prices?.version ?? 0) + 1 }),
        body: [
          h('ul', { class: 'changes' }, list.map((c) => h('li', {}, c))),
          raced ? h('p', { class: 'notice notice--warn' }, t('pr.raced', { v: latest.prices.version })) : null,
          h('p', { class: 'muted small' }, t('pr.confirmText')),
        ],
        confirmLabel: t('pr.publish'),
        action: () => api.post('/api/admin/configs/prices', { content: next }),
      });
      if (!out) return;
      ctx.flash([h('strong', {}, t('pr.published', { what: t('kind.prices'), v: out.version })), ' ', sentNote(out.published, 'kind.prices')], out.published ? 'good' : 'warn');
      await load();
      followUp();
    });

    pricesBox.replaceChildren(
      h('div', { class: 'panel__head' }, h('h3', { class: 'panel__title' }, t('kind.prices')), current ? pill(t('pr.version', { v: current.version }), 'info') : null),
      current ? h('p', { class: 'muted small' }, t('pr.inUse', { at: formatKL(current.createdAt) })) : h('p', { class: 'muted' }, t('pr.noneYet')),
      form,
    );
  }

  // ---- settings ----------------------------------------------------------------------------

  function drawSettings(current) {
    const c = current?.content ?? { mealWindows: [], allowedGroups: ['STUDENT', 'STAFF'], perPurchaseMaxSen: 2000, dailyMaxSen: 3000, dailyMaxCount: 10, tapGapSeconds: 3 };
    const status = h('p', { class: 'form-status', role: 'status' });
    const windowsList = h('div', { class: 'windows' });
    const addWindowBtn = h('button', { type: 'button', class: 'btn btn--small' }, t('se.addWindow'));

    function addWindow(w = { from: '', to: '' }) {
      const from = h('input', { type: 'time', value: w.from, step: '60' });
      const to = h('input', { type: 'time', value: w.to, step: '60' });
      const remove = h('button', { type: 'button', class: 'btn btn--small btn--ghost', 'aria-label': t('se.removeWindow') }, t('pr.remove'));
      const line = h('div', { class: 'window' }, field(t('se.from'), from), h('span', { class: 'window__dash', 'aria-hidden': 'true' }, '–'), field(t('se.to'), to), remove);
      line._inputs = { from, to };
      remove.addEventListener('click', () => {
        line.remove();
        addWindowBtn.disabled = windowsList.children.length >= 6;
        addWindowBtn.focus();
      });
      windowsList.append(line);
      addWindowBtn.disabled = windowsList.children.length >= 6;
      return line;
    }
    for (const w of c.mealWindows ?? []) addWindow(w);
    addWindowBtn.addEventListener('click', () => addWindow().querySelector('input').focus());

    const groupBoxes = ['STUDENT', 'STAFF'].map((g) => {
      const box = h('input', { type: 'checkbox', value: g, checked: (c.allowedGroups ?? []).includes(g) });
      return { g, box, label: h('label', { class: 'check' }, box, h('span', {}, t(`group.${g}`))) };
    });
    const groupsErr = h('span', { class: 'field-error', hidden: true });
    const perPurchase = h('input', { type: 'text', inputmode: 'decimal', value: senText(c.perPurchaseMaxSen), autocomplete: 'off' });
    const daily = h('input', { type: 'text', inputmode: 'decimal', value: senText(c.dailyMaxSen), autocomplete: 'off' });
    const count = h('input', { type: 'text', inputmode: 'numeric', value: String(c.dailyMaxCount ?? ''), autocomplete: 'off' });
    const gap = h('input', { type: 'text', inputmode: 'numeric', value: String(c.tapGapSeconds ?? ''), autocomplete: 'off' });
    const whole = (input, min, max) => (/^\d{1,7}$/.test(input.value.trim()) && Number(input.value) >= min && Number(input.value) <= max ? Number(input.value) : null);

    function read() {
      let ok = true;
      const mealWindows = [];
      for (const line of windowsList.children) {
        const { from, to } = line._inputs;
        const okFrom = HHMM_RE.test(from.value);
        const okTo = HHMM_RE.test(to.value);
        ok = mark(from, okFrom ? null : t('se.err.time')) && ok;
        ok = mark(to, !okTo ? t('se.err.time') : okFrom && to.value <= from.value ? t('se.err.order') : null) && ok;
        mealWindows.push({ from: from.value, to: to.value });
      }
      const allowedGroups = groupBoxes.filter((x) => x.box.checked).map((x) => x.g);
      groupsErr.textContent = allowedGroups.length ? '' : t('se.err.groups');
      groupsErr.hidden = allowedGroups.length > 0;
      if (!allowedGroups.length) ok = false;
      const next = {
        ...c,
        mealWindows,
        allowedGroups,
        perPurchaseMaxSen: moneyIn(perPurchase, 1, 100000),
        dailyMaxSen: moneyIn(daily, 1, 1000000),
        dailyMaxCount: whole(count, 1, 100),
        tapGapSeconds: whole(gap, 0, 600),
      };
      ok = mark(perPurchase, next.perPurchaseMaxSen === null ? t('se.err.perPurchase') : null) && ok;
      ok = mark(daily, next.dailyMaxSen === null ? t('se.err.daily') : null) && ok;
      ok = mark(count, next.dailyMaxCount === null ? t('se.err.count') : null) && ok;
      ok = mark(gap, next.tapGapSeconds === null ? t('se.err.gap') : null) && ok;
      if (!ok) {
        status.textContent = t('pr.fixFirst');
        (settingsBox.querySelector('[aria-invalid="true"]') ?? groupBoxes[0].box).focus();
        return null;
      }
      status.textContent = '';
      return next;
    }

    function changes(next) {
      const out = [];
      const win = (list) => (list?.length ? list.map((w) => `${w.from}–${w.to}`).join(', ') : t('se.anyTime'));
      const groups = (list) => (list ?? []).map((g) => t(`group.${g}`)).join(', ');
      if (win(c.mealWindows) !== win(next.mealWindows)) out.push(t('se.chWindows', { from: win(c.mealWindows), to: win(next.mealWindows) }));
      if (groups(c.allowedGroups) !== groups(next.allowedGroups)) out.push(t('se.chGroups', { from: groups(c.allowedGroups), to: groups(next.allowedGroups) }));
      if (c.perPurchaseMaxSen !== next.perPurchaseMaxSen) out.push(t('se.chPerPurchase', { from: formatRM(c.perPurchaseMaxSen), to: formatRM(next.perPurchaseMaxSen) }));
      if (c.dailyMaxSen !== next.dailyMaxSen) out.push(t('se.chDaily', { from: formatRM(c.dailyMaxSen), to: formatRM(next.dailyMaxSen) }));
      if (c.dailyMaxCount !== next.dailyMaxCount) out.push(t('se.chCount', { from: c.dailyMaxCount, to: next.dailyMaxCount }));
      if (c.tapGapSeconds !== next.tapGapSeconds) out.push(t('se.chGap', { from: c.tapGapSeconds, to: next.tapGapSeconds }));
      return out;
    }

    const publish = h('button', { type: 'submit', class: 'btn btn--primary' }, t('se.publish'));
    const undo = h('button', { type: 'button', class: 'btn' }, t('pr.undo'));
    undo.addEventListener('click', () => drawSettings(current));
    const form = h(
      'form',
      { class: 'stack', novalidate: true },
      h(
        'fieldset',
        { class: 'fieldset' },
        h('legend', {}, t('se.windows')),
        h('p', { class: 'muted small' }, t('se.windowsText')),
        windowsList,
        h('div', {}, addWindowBtn),
      ),
      h('fieldset', { class: 'fieldset' }, h('legend', {}, t('se.groups')), h('div', { class: 'row' }, groupBoxes.map((x) => x.label)), groupsErr),
      h(
        'fieldset',
        { class: 'fieldset' },
        h('legend', {}, t('se.limits')),
        h(
          'div',
          { class: 'form-grid' },
          field(t('se.perPurchase'), perPurchase, t('se.inRM')),
          field(t('se.daily'), daily, t('se.inRM')),
          field(t('se.count'), count, t('se.countHint')),
          field(t('se.gap'), gap, t('se.gapHint')),
        ),
      ),
      status,
      h('div', { class: 'row' }, publish, undo),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = read();
      if (!next) return;
      const list = changes(next);
      if (list.length === 0) {
        status.textContent = t('se.nothing', { v: current?.version ?? 0 });
        return;
      }
      let latest = null;
      try {
        latest = await api.get('/api/admin/configs');
      } catch (err) {
        status.textContent = errorMessage(t, err);
        return;
      }
      const raced = latest.settings && current && latest.settings.version !== current.version;
      const out = await openDialog({
        t,
        title: t('se.confirmTitle', { v: (latest.settings?.version ?? 0) + 1 }),
        body: [
          h('ul', { class: 'changes' }, list.map((x) => h('li', {}, x))),
          raced ? h('p', { class: 'notice notice--warn' }, t('pr.raced', { v: latest.settings.version })) : null,
          h('p', { class: 'muted small' }, t('se.confirmText')),
        ],
        confirmLabel: t('se.publish'),
        action: () => api.post('/api/admin/configs/settings', { content: next }),
      });
      if (!out) return;
      ctx.flash([h('strong', {}, t('pr.published', { what: t('kind.settings'), v: out.version })), ' ', sentNote(out.published, 'kind.settings')], out.published ? 'good' : 'warn');
      await load();
      followUp();
    });

    settingsBox.replaceChildren(
      h('div', { class: 'panel__head' }, h('h3', { class: 'panel__title' }, t('kind.settings')), current ? pill(t('pr.version', { v: current.version }), 'info') : null),
      current ? h('p', { class: 'muted small' }, t('pr.inUse', { at: formatKL(current.createdAt) })) : h('p', { class: 'muted' }, t('pr.noneYet')),
      form,
    );
  }

  function drawHistory(history) {
    const rows = [];
    for (const kind of KINDS) for (const v of history?.[kind] ?? []) rows.push({ kind, ...v });
    rows.sort((a, b) => b.createdAt - a.createdAt);
    historyBox.replaceChildren(
      dataTable({
        label: t('pr.history'),
        head: [t('pr.histWhat'), { label: t('pr.histVersion'), num: true }, t('pr.histCreated'), t('pr.histFrom')],
        empty: t('pr.histEmpty'),
        compact: true,
        rows: rows.map((r) => [t(`kind.${r.kind}`), `v${r.version}`, formatKL(r.createdAt), formatKL(r.effectiveFrom)]),
      }),
    );
  }

  ctx.poll(10000, loadSide);
  await load();
}
