// Each school's card tray and admin card, and the tap dialog: pick a card (one selection for the
// whole page), then tap it on a machine — items and quantities at a canteen reader, millilitres
// at a water machine, an optional power cut or lost confirmation at the kiosk.

import { formatKL, formatRM, h, toast } from '/shared/api.js';
import { errorText, faultResult, kioskResult, screenCaption, toneOfScreen } from './describe.js';
import { reconcile, setAttr, setHidden, setText, setTone } from './util.js';

const KIOSK_FAULTS = ['power-cut-before-commit', 'power-cut-after-commit', 'confirm-timeout'];
const WATER_PRESETS = [250, 500, 650, 1000];
const MAX_QTY = 99;
const MAX_ML = 20_000;

/** Water charge as the machine works it out: per litre, rounded half up, at least the minimum. */
function waterCharge(ml, perLitreSen, minChargeSen) {
  if (!Number.isSafeInteger(ml) || ml <= 0) return 0;
  return Math.max(Math.floor((ml * perLitreSen + 500) / 1000), minChargeSen);
}

export function createTrays(app) {
  const { t } = app;
  const cardKey = (school, uid) => `${school}/${uid}`;

  const schoolOf = (code) => app.state?.schools?.find((s) => s.code === code) ?? null;
  const cardOf = (key) => {
    if (!key) return null;
    const i = key.indexOf('/');
    const s = schoolOf(key.slice(0, i));
    const c = s?.cards.find((x) => x.uid === key.slice(i + 1));
    return c ? { school: s, card: c } : null;
  };
  const kioskOf = (school) => school?.devices.find((d) => d.type === 'KIOSK') ?? null;

  function statusPill(c) {
    if (c.platformStatus === 'ACTIVE') return { text: t('card.status.ACTIVE'), tone: 'good' };
    if (c.platformStatus === 'LOST') return { text: t('card.status.LOST'), tone: 'bad' };
    if (c.platformStatus === 'RETIRED') return { text: t('card.status.RETIRED'), tone: '' };
    return { text: t('card.status.none'), tone: 'warn' };
  }

  // ---- the card tray ------------------------------------------------------------------------

  function createTray(code) {
    const title = h('h4', { class: 'tray__title', id: `tray-${code}-title` });
    const hint = h('p', { class: 'tray__hint', 'aria-live': 'polite' });
    const list = h('ul', { class: 'tray__cards', role: 'list' });
    const empty = h('p', { class: 'muted', hidden: true });
    const el = h('section', { class: 'tray', 'aria-labelledby': `tray-${code}-title` }, h('div', { class: 'tray__head' }, title, hint), list, empty);
    el._r = { title, hint, list, empty };
    return el;
  }

  function createCard(school) {
    return (c) => {
      const r = {};
      r.name = h('span', { class: 'chipcard__name' });
      r.uid = h('span', { class: 'chipcard__uid mono' });
      r.balance = h('span', { class: 'chipcard__balance num' });
      r.onChip = h('span', { class: 'chipcard__onchip' });
      r.meta = h('span', { class: 'chipcard__meta' });
      r.status = h('span', { class: 'pill chipcard__pill' });
      r.copy = h('span', { class: 'pill pill--info chipcard__pill' });
      r.tamper = h('span', { class: 'pill pill--bad chipcard__pill' });
      r.staff = h('span', { class: 'pill chipcard__pill' });
      r.button = h(
        'button',
        { type: 'button', class: 'chipcard', 'aria-pressed': 'false' },
        h('span', { class: 'chipcard__chip', 'aria-hidden': 'true' }),
        r.name,
        r.uid,
        h('span', { class: 'chipcard__money' }, r.balance, r.onChip),
        r.meta,
        h('span', { class: 'chipcard__tags' }, r.status, r.copy, r.tamper, r.staff),
      );
      r.button.addEventListener('click', () => app.select(cardKey(school, c.uid)));
      const li = h('li', {}, r.button);
      li._r = r;
      return li;
    };
  }

  function updateCard(li, c, school) {
    const r = li._r;
    const key = cardKey(school.code, c.uid);
    setText(r.name, c.member ?? t('card.noMember'));
    setText(r.uid, c.uid);
    setText(r.balance, formatRM(c.balanceSen));
    setText(r.onChip, t('card.onChip'));
    setText(r.meta, [t('card.counter', { n: c.cardSeq }), c.memberNo].filter(Boolean).join(' · '));
    const st = statusPill(c);
    setText(r.status, st.text);
    setTone(r.status, 'pill--', st.tone);
    setText(r.copy, c.copy ? t('card.copy', { uid: c.copyOf }) : '');
    setHidden(r.copy, !c.copy);
    setText(r.tamper, t('card.tampered'));
    setHidden(r.tamper, c.readable !== false);
    setText(r.staff, t('card.staff'));
    setHidden(r.staff, c.group !== 'STAFF');
    const picked = app.selected === key;
    setAttr(r.button, 'aria-pressed', picked ? 'true' : 'false');
    setAttr(r.button, 'aria-label', t('card.pick', { name: c.member ?? t('card.noMember'), uid: c.uid, balance: formatRM(c.balanceSen) }));
    li.classList.toggle('is-copy', Boolean(c.copy));
    li.classList.toggle('is-bad', c.readable === false || c.platformStatus === 'LOST');
  }

  function updateTray(el, school) {
    const r = el._r;
    setText(r.title, t('tray.title'));
    const picked = cardOf(app.selected);
    const mine = picked && picked.school.code === school.code;
    setText(
      r.hint,
      mine ? t('tray.picked', { name: picked.card.member ?? picked.card.uid, balance: formatRM(picked.card.balanceSen) }) : t('tray.hint'),
    );
    r.hint.classList.toggle('is-picked', Boolean(mine));
    reconcile(r.list, school.cards, (c) => c.uid, createCard(school.code), (li, c) => updateCard(li, c, school));
    setText(r.empty, t('tray.empty'));
    setHidden(r.empty, school.cards.length > 0);
  }

  /** Briefly mark a card whose chip just changed. */
  function flashCard(key) {
    const [school, uid] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    const li = document.querySelector(`#site-${CSS.escape(school)} .tray__cards > li[data-key="${CSS.escape(uid)}"]`);
    if (!li) return;
    li.classList.add('is-changed');
    setTimeout(() => li.classList.remove('is-changed'), 1600);
  }

  // ---- the admin card -----------------------------------------------------------------------

  function createAdmin(code) {
    const r = {};
    r.title = h('h4', { class: 'admincard__title', id: `admin-${code}-title` });
    r.what = h('p', { class: 'admincard__what muted' });
    r.state = h('p', { class: 'admincard__state' });
    r.packs = h('p', { class: 'admincard__packs' });
    r.receipts = h('p', { class: 'admincard__receipts' });
    r.receiptList = h('ul', { class: 'admincard__list' });
    r.load = h('button', { type: 'button', class: 'btn btn--small' });
    r.upload = h('button', { type: 'button', class: 'btn btn--small' });
    r.select = h('select', { id: `admin-${code}-target`, class: 'admincard__select' });
    r.selectLabel = h('label', { for: `admin-${code}-target`, class: 'admincard__label' });
    r.tap = h('button', { type: 'button', class: 'btn btn--small' });
    r.noKiosk = h('p', { class: 'muted', hidden: true });
    r.load.addEventListener('click', () => adminCard('load', code, null, r.load));
    r.upload.addEventListener('click', () => adminCard('upload', code, null, r.upload));
    r.tap.addEventListener('click', () => adminCard('tap', code, r.select.value, r.tap));
    const el = h(
      'section',
      { class: 'admincard', 'aria-labelledby': `admin-${code}-title` },
      h('div', { class: 'admincard__visual', 'aria-hidden': 'true' }, h('span', { class: 'chipcard__chip' })),
      h(
        'div',
        { class: 'admincard__body' },
        r.title,
        r.what,
        r.state,
        r.packs,
        r.receipts,
        r.receiptList,
        h('div', { class: 'admincard__actions' }, r.load, h('span', { class: 'admincard__tapgroup' }, r.selectLabel, r.select, r.tap), r.upload),
        r.noKiosk,
      ),
    );
    el._r = r;
    return el;
  }

  function updateAdmin(el, school) {
    const r = el._r;
    const a = school.adminCard;
    const kiosk = kioskOf(school);
    setText(r.title, t('admin.title'));
    setText(r.what, t('admin.what'));
    const loaded = a && a.loadedAt;
    setText(r.state, loaded ? t('admin.loaded', { token: a.token, time: formatKL(a.loadedAt) }) : t('admin.empty'));
    const packs = a?.packs ?? [];
    setText(r.packs, packs.length ? t('admin.packs', { list: packs.map((p) => `${t(`kind.${p.kind}`)} v${p.version}`).join(t('list.sep')) }) : '');
    setHidden(r.packs, packs.length === 0);
    const receipts = a?.receipts ?? [];
    setText(r.receipts, receipts.length ? t('admin.receipts', { n: receipts.length }) : t('admin.receipts.none'));
    r.receipts.classList.toggle('is-waiting', receipts.length > 0);
    reconcile(
      r.receiptList,
      receipts.slice(-8).map((x, i) => ({ ...x, i })),
      (x) => `${x.device}|${x.kind}|${x.at}|${x.i}`,
      () => h('li'),
      (li, x) =>
        setText(li, t('admin.receipt', { device: x.device, kind: t(`kind.${x.kind}`), version: x.appliedVersion, result: t(`result.${x.result}`) }) + (x.error ? ` (${x.error})` : '')),
    );
    setHidden(r.receiptList, receipts.length === 0);

    if (!r.load.hasAttribute('aria-busy')) setText(r.load, t('admin.load', { kiosk: kiosk?.code ?? '—' }));
    if (!r.upload.hasAttribute('aria-busy')) setText(r.upload, t('admin.upload', { kiosk: kiosk?.code ?? '—' }));
    r.load.disabled = !kiosk || r.load.hasAttribute('aria-busy');
    r.upload.disabled = !kiosk || r.upload.hasAttribute('aria-busy');
    setText(r.noKiosk, t('admin.noKiosk'));
    setHidden(r.noKiosk, Boolean(kiosk));

    setText(r.selectLabel, t('admin.tapLabel'));
    if (!r.tap.hasAttribute('aria-busy')) setText(r.tap, t('admin.tap'));
    const targets = school.devices.filter((d) => d.type !== 'KIOSK');
    const wanted = targets.map((d) => d.code).join('|');
    if (r.select.dataset.options !== wanted) {
      const keep = r.select.value;
      r.select.replaceChildren(...targets.map((d) => h('option', { value: d.code }, d.code)));
      if (targets.some((d) => d.code === keep)) r.select.value = keep;
      r.select.dataset.options = wanted;
    }
    r.select.disabled = targets.length === 0;
    r.tap.disabled = targets.length === 0 || r.tap.hasAttribute('aria-busy');
  }

  /** Load, tap or upload the school's admin card. */
  async function adminCard(action, school, deviceCode, button) {
    const s = schoolOf(school);
    const kiosk = kioskOf(s);
    const body = { schoolCode: school };
    if (action === 'tap') body.deviceCode = deviceCode;
    else if (kiosk) body.deviceCode = kiosk.code;
    const res = await app.call(`/api/lab/admin-card/${action}`, body, button);
    if (!res.ok) return app.fail(res.error);
    const where = action === 'tap' ? deviceCode : kiosk?.code ?? '';
    const screen = res.data.screen ?? '';
    const text = screenCaption(screen, t, app.i18n.lang) ?? screen;
    toast(`${where}: ${text}`, res.data.ok ? 'good' : 'bad');
    if (where) app.highlight(`${school}/${where}`);
  }

  // ---- the tap dialog -----------------------------------------------------------------------

  const dialog = document.getElementById('tap-dialog');
  const form = dialog.querySelector('form');
  const titleEl = dialog.querySelector('#tap-title');
  const subEl = dialog.querySelector('#tap-sub');
  const bodyEl = dialog.querySelector('.dialog__body');
  const errorEl = dialog.querySelector('.dialog__error');
  const submitBtn = dialog.querySelector('[data-role="submit"]');
  const cancelBtn = dialog.querySelector('[data-role="cancel"]');
  let current = null; // { key, school, code, type, opener, read(), label() }

  cancelBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const opener = current?.opener;
    current = null;
    bodyEl.replaceChildren();
    if (opener && opener.isConnected) opener.focus();
  });
  // a click on the backdrop closes it, like Esc
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });

  function cardSelect(machineSchool) {
    const select = h('select', { id: 'tap-card', required: true });
    const groups = (app.state?.schools ?? []).map((s) =>
      h(
        'optgroup',
        { label: s.name },
        s.cards.map((c) => h('option', { value: cardKey(s.code, c.uid) }, `${c.member ?? t('card.noMember')} · ${c.uid} · ${formatRM(c.balanceSen)}`)),
      ),
    );
    select.append(...groups);
    const fallback = schoolOf(machineSchool)?.cards[0];
    const pick = cardOf(app.selected) ? app.selected : fallback ? cardKey(machineSchool, fallback.uid) : null;
    if (pick) select.value = pick;
    return select;
  }

  function cardInfo(select, machineSchool, infoEl, warnEl) {
    const found = cardOf(select.value);
    if (!found) {
      setText(infoEl, '');
      setHidden(warnEl, true);
      return;
    }
    const st = statusPill(found.card);
    const bits = [t('tap.cardInfo', { balance: formatRM(found.card.balanceSen), n: found.card.cardSeq, status: st.text })];
    if (found.card.copy) bits.push(t('card.copy', { uid: found.card.copyOf }));
    if (found.card.readable === false) bits.push(t('card.tampered'));
    setText(infoEl, bits.join(' · '));
    const other = found.school.code !== machineSchool;
    setText(warnEl, other ? t('tap.otherSchool', { school: found.school.name }) : '');
    setHidden(warnEl, !other);
  }

  function canteenBody(m) {
    const items = m.prices?.items ?? [];
    const qty = new Map(items.map((i) => [i.code, 0]));
    const totalEl = h('p', { class: 'tapform__total num', 'aria-live': 'polite' });
    const update = () => {
      const total = items.reduce((sum, i) => sum + i.priceSen * (qty.get(i.code) ?? 0), 0);
      setText(totalEl, t('tap.total', { amount: formatRM(total) }));
      submitBtn.disabled = total === 0;
      setText(submitBtn, total > 0 ? t('tap.pay', { amount: formatRM(total) }) : t('tap.go'));
      return total;
    };
    const rows = items.map((i) => {
      const input = h('input', {
        type: 'number',
        min: '0',
        max: String(MAX_QTY),
        step: '1',
        value: '0',
        inputmode: 'numeric',
        class: 'stepper__input',
        'aria-label': t('tap.qty', { name: i.name }),
      });
      const set = (n) => {
        const v = Math.max(0, Math.min(MAX_QTY, Number.isFinite(n) ? Math.trunc(n) : 0));
        qty.set(i.code, v);
        input.value = String(v);
        update();
      };
      input.addEventListener('input', () => set(Number(input.value)));
      const less = h('button', { type: 'button', class: 'btn btn--small stepper__btn', 'aria-label': t('tap.less', { name: i.name }) }, '−');
      const more = h('button', { type: 'button', class: 'btn btn--small stepper__btn', 'aria-label': t('tap.more', { name: i.name }) }, '+');
      less.addEventListener('click', () => set((qty.get(i.code) ?? 0) - 1));
      more.addEventListener('click', () => set((qty.get(i.code) ?? 0) + 1));
      return h(
        'li',
        { class: 'tapform__item' },
        h('span', { class: 'tapform__itemname' }, i.name, h('span', { class: 'tapform__code mono' }, i.code)),
        h('span', { class: 'tapform__price num' }, formatRM(i.priceSen)),
        h('span', { class: 'stepper' }, less, input, more),
      );
    });
    const legend = h('legend', {}, t('tap.items'));
    const note = h('p', { class: 'muted tapform__note' }, m.prices ? t('tap.itemsNote', { version: m.prices.version }) : '');
    const fieldset = h('fieldset', { class: 'tapform__fieldset' }, legend, note, h('ul', { class: 'tapform__items' }, rows), totalEl);
    update();
    return {
      el: fieldset,
      read() {
        const chosen = items.filter((i) => (qty.get(i.code) ?? 0) > 0).map((i) => ({ code: i.code, qty: qty.get(i.code) }));
        if (chosen.length === 0) return { error: t('tap.pickItems') };
        return { body: { items: chosen } };
      },
    };
  }

  function waterBody(m) {
    const water = m.prices?.water ?? { perLitreSen: 0, minChargeSen: 0 };
    let ml = 650;
    const range = h('input', { type: 'range', min: '50', max: '2000', step: '10', value: String(ml), id: 'tap-ml-range', 'aria-label': t('tap.ml') });
    const number = h('input', { type: 'number', min: '1', max: String(MAX_ML), step: '1', value: String(ml), id: 'tap-ml', inputmode: 'numeric', class: 'tapform__ml' });
    const cost = h('p', { class: 'tapform__total num', 'aria-live': 'polite' });
    const presets = WATER_PRESETS.map((p) => {
      const b = h('button', { type: 'button', class: 'btn btn--small tapform__preset', 'aria-pressed': 'false' }, t('tap.mlUnit', { ml: p }));
      b.addEventListener('click', () => set(p));
      b._ml = p;
      return b;
    });
    function set(v, from) {
      ml = Number.isFinite(v) ? Math.trunc(v) : 0;
      if (from !== 'number') number.value = String(ml);
      if (from !== 'range') range.value = String(Math.min(2000, Math.max(50, ml)));
      for (const b of presets) setAttr(b, 'aria-pressed', b._ml === ml ? 'true' : 'false');
      const ok = ml >= 1 && ml <= MAX_ML;
      setText(cost, ok ? t('tap.waterCost', { amount: formatRM(waterCharge(ml, water.perLitreSen, water.minChargeSen)), perLitre: formatRM(water.perLitreSen), min: formatRM(water.minChargeSen) }) : t('tap.mlInvalid'));
      submitBtn.disabled = !ok;
      setText(submitBtn, ok ? t('tap.pour', { ml }) : t('tap.go'));
    }
    range.addEventListener('input', () => set(Number(range.value), 'range'));
    number.addEventListener('input', () => set(Number(number.value), 'number'));
    const fieldset = h(
      'fieldset',
      { class: 'tapform__fieldset' },
      h('legend', {}, t('tap.water')),
      h('div', { class: 'tapform__presets', role: 'group', 'aria-label': t('tap.water') }, presets),
      h('div', { class: 'tapform__mlrow' }, range, h('label', { for: 'tap-ml', class: 'tapform__mllabel' }, number, h('span', {}, t('tap.ml')))),
      cost,
      h('p', { class: 'muted tapform__note' }, t('tap.waterNote')),
    );
    set(ml);
    return {
      el: fieldset,
      read() {
        if (!(ml >= 1 && ml <= MAX_ML)) return { error: t('tap.mlInvalid') };
        return { body: { ml } };
      },
    };
  }

  function kioskBody() {
    const name = 'tap-fault';
    const option = (value, title, text) => {
      const input = h('input', { type: 'radio', name, value, id: `tap-fault-${value || 'none'}` });
      if (!value) input.checked = true;
      return h(
        'label',
        { class: 'tapform__radio', for: `tap-fault-${value || 'none'}` },
        input,
        h('span', {}, h('span', { class: 'tapform__radiotitle' }, title), text ? h('span', { class: 'tapform__radiotext muted' }, text) : null),
      );
    };
    const fieldset = h(
      'fieldset',
      { class: 'tapform__fieldset' },
      h('legend', {}, t('tap.fault')),
      option('', t('tap.fault.none'), ''),
      KIOSK_FAULTS.map((f) => option(f, t(`fault.${f}.title`), t(`fault.${f}.text`))),
    );
    setText(submitBtn, t('tap.go'));
    submitBtn.disabled = false;
    return {
      el: h('div', {}, h('p', { class: 'tapform__note' }, t('tap.kiosk')), fieldset),
      read() {
        const fault = fieldset.querySelector(`input[name="${name}"]:checked`)?.value || null;
        return { body: fault ? { fault } : {} };
      },
    };
  }

  /** Open the tap dialog for a machine. */
  function openTap(key, opener) {
    const [schoolCode, code] = key.split('/');
    const school = schoolOf(schoolCode);
    const m = school?.devices.find((d) => d.code === code);
    if (!school || !m) return;
    const hasCards = (app.state?.schools ?? []).some((s) => s.cards.length > 0);
    setText(titleEl, t('tap.title', { code }));
    setText(subEl, t('tap.where', { type: t(`type.${m.type}`), location: m.location || '—', school: school.name }));
    setText(errorEl, '');
    setHidden(errorEl, true);
    setText(cancelBtn, t('cancel'));
    if (!hasCards) {
      bodyEl.replaceChildren(h('p', {}, t('tap.noCards')));
      submitBtn.disabled = true;
      setText(submitBtn, t('tap.go'));
      current = { key, opener, read: () => ({ error: t('tap.noCards') }) };
      dialog.showModal();
      return;
    }
    const select = cardSelect(schoolCode);
    const info = h('p', { class: 'tapform__cardinfo muted', id: 'tap-card-info' });
    const warn = h('p', { class: 'tapform__warn', hidden: true });
    setAttr(select, 'aria-describedby', 'tap-card-info');
    select.addEventListener('change', () => {
      cardInfo(select, schoolCode, info, warn);
      app.select(select.value);
    });
    const part = m.type === 'CANTEEN' ? canteenBody(m) : m.type === 'WATER' ? waterBody(m) : kioskBody();
    bodyEl.replaceChildren(h('div', { class: 'tapform__card' }, h('label', { for: 'tap-card' }, t('tap.card')), select, info, warn), part.el);
    cardInfo(select, schoolCode, info, warn);
    current = { key, school: schoolCode, code, type: m.type, opener, select, read: part.read };
    dialog.showModal();
    select.focus();
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!current || submitBtn.disabled) return;
    const job = current;
    const found = cardOf(job.select?.value);
    const read = job.read();
    if (read.error || !found) {
      setText(errorEl, read.error ?? t('fault.needCard'));
      setHidden(errorEl, false);
      return;
    }
    setHidden(errorEl, true);
    const body = { schoolCode: job.school, deviceCode: job.code, uid: found.card.uid, cardSchoolCode: found.school.code, ...read.body };
    const label = submitBtn.textContent;
    const res = await app.call('/api/lab/tap', body, submitBtn, t('tap.busy'));
    if (current !== job) return; // closed meanwhile
    if (!res.ok) {
      setText(submitBtn, label);
      setText(errorEl, errorText(res.error, t));
      setHidden(errorEl, false);
      return;
    }
    dialog.close();
    const r = res.data;
    if (job.type === 'KIOSK') {
      const out = body.fault ? faultResult(body.fault, r, t, app.i18n.lang) : kioskResult(null, r, t, app.i18n.lang);
      toast(`${job.code}: ${out.text}`, out.tone);
    } else {
      const text = screenCaption(r.screen, t, app.i18n.lang) ?? r.screen;
      toast(`${job.code}: ${text}`, toneOfScreen(r.ok ? 'ok' : 'warn'));
    }
    app.highlight(job.key);
    flashCard(cardKey(found.school.code, found.card.uid));
  });

  return { createTray, updateTray, createAdmin, updateAdmin, openTap, adminCard, flashCard };
}
