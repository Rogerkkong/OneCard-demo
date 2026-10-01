// The faults panel (DESIGN §8 "Faults"): each fault in one plain sentence, run against the
// machine and card chosen at the top of the panel, with what happened written under it.

import { h, parseRM, toast } from '/shared/api.js';
import { errorText, faultResult } from './describe.js';
import { setHidden, setText, setTone } from './util.js';

const FAULTS = [
  { group: 'cards', type: 'clone-card', needs: 'card' },
  { group: 'cards', type: 'tamper-card', needs: 'card', extra: 'amount' },
  { group: 'cards', type: 'cross-school-card', needs: 'card', extra: 'otherMachine' },
  { group: 'messages', type: 'duplicate-upload', needs: 'machine' },
  { group: 'messages', type: 'sequence-rollback', needs: 'machine' },
  { group: 'messages', type: 'forged-message', needs: 'machine' },
  { group: 'messages', type: 'cross-device-publish', needs: 'machine', extra: 'target' },
  { group: 'kiosk', type: 'power-cut-before-commit', needs: 'kiosk' },
  { group: 'kiosk', type: 'power-cut-after-commit', needs: 'kiosk' },
  { group: 'kiosk', type: 'confirm-timeout', needs: 'kiosk' },
  { group: 'server', type: 'server-down' },
  { group: 'server', type: 'server-up' },
  { group: 'server', type: 'broker-restart' },
];
const GROUPS = ['cards', 'messages', 'kiosk', 'server'];

export function createFaults(app, root) {
  const { t } = app;
  const title = root.querySelector('#faults-title');
  const intro = root.querySelector('.faults__intro');
  const machineLabel = root.querySelector('label[for="fault-machine"]');
  const machineSelect = root.querySelector('#fault-machine');
  const cardLabel = root.querySelector('label[for="fault-card"]');
  const cardSelect = root.querySelector('#fault-card');
  const groupsEl = root.querySelector('.faults__groups');
  const rows = new Map(); // type -> refs

  machineSelect.addEventListener('change', () => update(app.state));
  cardSelect.addEventListener('change', () => app.select(cardSelect.value || null));

  for (const group of GROUPS) {
    const heading = h('h3', { class: 'faults__group', dataset: { key: `fault.group.${group}` } });
    const list = h('ul', { class: 'faults__list' });
    for (const f of FAULTS.filter((x) => x.group === group)) {
      const r = { f };
      r.title = h('h4', { class: 'fault__title', id: `fault-${f.type}-title` });
      r.text = h('p', { class: 'fault__text' });
      r.where = h('p', { class: 'fault__where muted' });
      r.button = h('button', { type: 'button', class: 'btn btn--small fault__run', 'aria-describedby': `fault-${f.type}-title` });
      r.result = h('p', { class: 'fault__result', 'aria-live': 'polite', hidden: true });
      const controls = h('div', { class: 'fault__controls' });
      if (f.extra === 'amount') {
        r.amount = h('input', { type: 'text', inputmode: 'decimal', id: `fault-${f.type}-amount`, value: '100.00', class: 'fault__amount', autocomplete: 'off' });
        r.amountLabel = h('label', { for: `fault-${f.type}-amount`, class: 'fault__label' });
        controls.append(r.amountLabel, r.amount);
      } else if (f.extra === 'otherMachine' || f.extra === 'target') {
        r.target = h('select', { id: `fault-${f.type}-target`, class: 'fault__select' });
        r.targetLabel = h('label', { for: `fault-${f.type}-target`, class: 'fault__label' });
        controls.append(r.targetLabel, r.target);
      }
      controls.append(r.button);
      r.button.addEventListener('click', () => run(f, r));
      list.append(h('li', { class: 'fault' }, r.title, r.text, r.where, controls, r.result));
      rows.set(f.type, r);
    }
    groupsEl.append(h('section', { class: 'faults__section' }, heading, list));
  }

  // ---- helpers -------------------------------------------------------------------------------

  const schools = () => app.state?.schools ?? [];
  const machineFrom = (value) => {
    if (!value) return null;
    const [school, code] = value.split('/');
    const s = schools().find((x) => x.code === school);
    const m = s?.devices.find((d) => d.code === code);
    return m ? { school: s, m } : null;
  };
  const cardFrom = (value) => {
    if (!value) return null;
    const i = value.indexOf('/');
    const s = schools().find((x) => x.code === value.slice(0, i));
    const c = s?.cards.find((x) => x.uid === value.slice(i + 1));
    return c ? { school: s, card: c } : null;
  };

  /** Fill a select with grouped options, keeping the choice; only rebuilt when the list changes. */
  function fill(select, groups, keep) {
    const signature = JSON.stringify(groups.map((g) => [g.label, g.options.map((o) => [o.value, o.text])]));
    if (select.dataset.sig !== signature) {
      select.replaceChildren(
        ...groups.map((g) =>
          g.label === null
            ? g.options.map((o) => h('option', { value: o.value }, o.text))
            : h('optgroup', { label: g.label }, g.options.map((o) => h('option', { value: o.value }, o.text))),
        ).flat(),
      );
      select.dataset.sig = signature;
    }
    const values = [...select.options].map((o) => o.value);
    if (keep !== undefined && values.includes(keep)) select.value = keep;
    else if (!values.includes(select.value) && values.length) select.value = values[0];
  }

  function update(state) {
    if (!state) return;
    setText(title, t('fault.title'));
    setText(intro, t('fault.intro'));
    setText(machineLabel, t('fault.machine'));
    setText(cardLabel, t('fault.card'));
    for (const el of groupsEl.querySelectorAll('[data-key]')) setText(el, t(el.dataset.key));

    const list = schools();
    fill(
      machineSelect,
      list.filter((s) => s.devices.length).map((s) => ({ label: s.name, options: s.devices.map((d) => ({ value: `${s.code}/${d.code}`, text: `${d.code} · ${t(`type.${d.type}`)}` })) })),
      machineSelect.value || undefined,
    );
    fill(
      cardSelect,
      list.filter((s) => s.cards.length).map((s) => ({ label: s.name, options: s.cards.map((c) => ({ value: `${s.code}/${c.uid}`, text: `${c.member ?? t('card.noMember')} · ${c.uid}` })) })),
      app.selected ?? undefined,
    );

    const machine = machineFrom(machineSelect.value);
    const card = cardFrom(cardSelect.value);
    for (const [type, r] of rows) {
      setText(r.title, t(`fault.${type}.title`));
      setText(r.text, t(`fault.${type}.text`));
      if (!r.button.hasAttribute('aria-busy')) setText(r.button, t('fault.run'));
      let where = '';
      if (r.f.needs === 'kiosk' && card) {
        const kiosk = card.school.devices.find((d) => d.type === 'KIOSK');
        where = kiosk ? t('fault.kioskAt', { kiosk: kiosk.code, school: card.school.name }) : t('fault.needKiosk');
      }
      setText(r.where, where);
      setHidden(r.where, !where);
      if (r.amountLabel) setText(r.amountLabel, t('fault.amount'));
      if (r.target && r.f.extra === 'otherMachine') {
        setText(r.targetLabel, t('fault.on'));
        const others = list.filter((s) => s.code !== card?.school.code);
        fill(
          r.target,
          others.map((s) => ({
            label: s.name,
            options: s.devices.filter((d) => d.type !== 'KIOSK').map((d) => ({ value: `${s.code}/${d.code}`, text: `${d.code} · ${t(`type.${d.type}`)}` })),
          })),
        );
      } else if (r.target && r.f.extra === 'target') {
        setText(r.targetLabel, t('fault.target'));
        const options = [{ label: null, options: [{ value: '', text: t('fault.target.auto') }] }];
        for (const s of list) {
          const devices = s.devices.filter((d) => !(machine && s.code === machine.school.code && d.code === machine.m.code));
          if (devices.length) options.push({ label: s.name, options: devices.map((d) => ({ value: `${s.code}/${d.code}`, text: d.code })) });
        }
        fill(r.target, options);
      }
      if (r.f.type === 'server-down') r.button.disabled = !state.server?.up || r.button.hasAttribute('aria-busy');
      if (r.f.type === 'server-up') r.button.disabled = Boolean(state.server?.up) || r.button.hasAttribute('aria-busy');
      if (r.f.type === 'broker-restart') r.button.disabled = !state.server?.up || r.button.hasAttribute('aria-busy');
    }
  }

  function showResult(r, text, tone) {
    setText(r.result, text);
    setTone(r.result, 'fault__result--', tone);
    setHidden(r.result, false);
  }

  async function run(f, r) {
    const machine = machineFrom(machineSelect.value);
    const card = cardFrom(cardSelect.value);
    const body = { type: f.type };
    if (f.needs === 'card' || f.needs === 'kiosk') {
      if (!card) return showResult(r, t('fault.needCard'), 'warn');
      body.schoolCode = card.school.code;
      body.uid = card.card.uid;
    }
    if (f.needs === 'machine') {
      if (!machine) return showResult(r, t('fault.needMachine'), 'warn');
      body.schoolCode = machine.school.code;
      body.deviceCode = machine.m.code;
    }
    if (f.needs === 'kiosk') {
      const kiosk = card.school.devices.find((d) => d.type === 'KIOSK');
      if (!kiosk) return showResult(r, t('fault.needKiosk'), 'warn');
      body.deviceCode = kiosk.code;
    }
    if (f.extra === 'amount') {
      const sen = parseRM(r.amount.value);
      if (sen === null) return showResult(r, t('fault.amountInvalid'), 'warn');
      body.balanceSen = sen;
    }
    if (f.extra === 'otherMachine') {
      if (!r.target.value) return showResult(r, t('fault.needOther'), 'warn');
      const [toSchool, toDevice] = r.target.value.split('/');
      body.toSchoolCode = toSchool;
      body.deviceCode = toDevice;
    }
    if (f.extra === 'target' && r.target.value) {
      const [toSchool, toDevice] = r.target.value.split('/');
      body.toSchoolCode = toSchool;
      body.toDeviceCode = toDevice;
    }
    const res = await app.call('/api/lab/fault', body, r.button, t('working'));
    if (!res.ok) return showResult(r, errorText(res.error, t), 'bad');
    const out = faultResult(f.type, res.data, t, app.i18n.lang);
    showResult(r, out.text, out.tone);
    if (f.type === 'clone-card' && res.data.uid) app.select(`${body.schoolCode}/${res.data.uid}`);
    if (body.deviceCode && body.schoolCode && f.needs !== 'card') app.highlight(`${body.schoolCode}/${body.deviceCode}`);
    if (f.type === 'cross-school-card' && res.data.machine) app.highlight(res.data.machine);
    if (f.type === 'server-down' || f.type === 'server-up' || f.type === 'broker-restart') toast(out.text, out.tone);
  }

  return { update };
}
