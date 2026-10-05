// Building the lab by drag and drop (DESIGN §12), like Packet Tracer's device bar: a canteen
// reader, a water machine, a top-up kiosk and a school, each a real button in a toolbar. Drag a
// machine onto a school's site, or the school onto the internet line or the cloud server: the
// places it may go light up, the one under the pointer more strongly. Or press one (a click,
// Enter or Space) and choose the school in the dialog. The dialogs add it through the lab
// (POST /api/lab/devices, POST /api/lab/schools); the new machine or site then shows on the map,
// scrolled into view and marked for a moment. "Add machine" on each site and "Add school" by the
// bar open the same dialogs without dragging.

import { get, h, toast } from '/shared/api.js';
import { errorText } from './describe.js';
import { draggable, dragLayer } from './drag.js';
import { icon, prefs, setAttr, setHidden, setText } from './util.js';

const TYPES = ['CANTEEN', 'WATER', 'KIOSK'];
// the platform's rules (src/shared/protocol.js, src/platform/schools.js); the lab checks them again
const DEVICE_CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,30}[A-Z0-9])?$/;
const SCHOOL_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_LOCATION = 60;
const MAX_NAME = 100;
const MAX_STUDENTS = 50;
const DEFAULT_STUDENTS = 5;
const REVEAL_WAIT_MS = 10_000; // how long a new machine or site may take to show before the page stops looking

/** 'SMK Bukit Indah' -> 'smk-bukit-indah' (a suggestion until the person types a code). */
export function schoolCodeFrom(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

/** The next free '<TYPE>-NN' of a school, from what the page knows (the lab's answer replaces it). */
function nextCodeHere(school, type) {
  const used = new Set((school?.devices ?? []).map((d) => d.code));
  let n = 0;
  for (const code of used) {
    const m = new RegExp(`^${type}-(\\d+)$`).exec(code);
    if (m) n = Math.max(n, Number(m[1]));
  }
  for (n += 1; used.has(`${type}-${String(n).padStart(2, '0')}`); n += 1);
  return `${type}-${String(n).padStart(2, '0')}`;
}

/**
 * @param {object} app  the page: t, i18n, state, call(), refresh()
 * @param {{ root: HTMLElement, cloudEl: HTMLElement, sitesEl: HTMLElement, topology: object, live: HTMLElement }} deps
 */
export function createBuild(app, { root, cloudEl, sitesEl, topology, live }) {
  const { t } = app;
  const bar = root.querySelector('.build__bar');
  const titleEl = root.querySelector('#build-title');
  const hintEl = root.querySelector('#build-hint');

  const schools = () => app.state?.schools ?? [];
  const schoolOf = (code) => schools().find((s) => s.code === code) ?? null;
  const say = (text) => {
    setText(live, '');
    // a new text is announced even when it repeats the last one
    requestAnimationFrame(() => setText(live, text));
  };

  // ---- the device bar: a toolbar of real buttons --------------------------------------------------

  const items = [...TYPES.map((type) => ({ kind: 'machine', type })), { kind: 'school', type: null }].map((item) => {
    const b = h(
      'button',
      { type: 'button', class: `build__item build__item--${(item.type ?? 'school').toLowerCase()}` },
      icon(item.type ?? 'school', 'build__icon'),
      h('span', { class: 'build__label' }),
    );
    b._item = item;
    b.addEventListener('click', () => (item.kind === 'school' ? openAddSchool({ opener: b }) : openAddMachine({ type: item.type, opener: b })));
    return b;
  });
  const addSchoolBtn = h('button', { type: 'button', class: 'btn btn--small build__addschool' }, icon('plus', 'build__addicon'), h('span', {}));
  addSchoolBtn.addEventListener('click', () => openAddSchool({ opener: addSchoolBtn }));
  bar.append(...items, h('span', { class: 'build__sep', 'aria-hidden': 'true' }), addSchoolBtn);
  const tools = [...items, addSchoolBtn];

  // one tab stop for the whole bar; the arrow keys, Home and End move along it
  let toolAt = 0;
  function rove(i, focus = false) {
    toolAt = (i + tools.length) % tools.length;
    tools.forEach((b, j) => (b.tabIndex = j === toolAt ? 0 : -1));
    if (focus) tools[toolAt].focus();
  }
  rove(0);
  bar.addEventListener('focusin', (ev) => {
    const i = tools.indexOf(ev.target);
    if (i >= 0) rove(i);
  });
  bar.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const keys = { ArrowRight: toolAt + 1, ArrowLeft: toolAt - 1, Home: 0, End: tools.length - 1 };
    if (!(ev.key in keys)) return;
    ev.preventDefault();
    rove(keys[ev.key], true);
  });

  function relabelBar() {
    setText(titleEl, t('build.title'));
    setText(hintEl, t('build.hint'));
    setAttr(bar, 'aria-label', t('build.bar'));
    for (const b of items) {
      const { type } = b._item;
      setText(b.lastChild, t(type ? `type.${type}` : 'build.school'));
      setAttr(b, 'aria-label', t(type ? `build.add.${type}` : 'build.add.school'));
      setAttr(b, 'title', t(type ? 'build.dragMachine' : 'build.dragSchool'));
    }
    setText(addSchoolBtn.lastChild, t('build.addSchool'));
  }

  // ---- dragging an item onto the map ----------------------------------------------------------------

  const layer = () => dragLayer();
  const nameOf = (item) => t(item.type ? `type.${item.type}` : 'build.school');

  /** Where a dragged item may go: every school's site for a machine; the cloud and the internet line for a school. */
  function zonesFor(item) {
    if (item.kind === 'school') return [{ el: cloudEl, kind: 'cloud' }, { el: sitesEl, kind: 'internet' }];
    return [...sitesEl.querySelectorAll(':scope > .site')].map((el) => {
      const s = schoolOf(el.dataset.school);
      return { el, kind: 'site', code: el.dataset.school, name: s?.name ?? el.dataset.school, blocked: s?.status === 'SUSPENDED' };
    });
  }

  /** The zone under the pointer, if any. */
  function zoneAt(s, p) {
    const under = document.elementFromPoint(p.x, p.y);
    if (s.item.kind === 'school') {
      if (under?.closest?.('.cloud') === cloudEl) return s.zones[0];
      // the internet line: the trunk on the left of the sites, and a little below the last one
      const r = sitesEl.getBoundingClientRect();
      const cs = getComputedStyle(sitesEl);
      const left = r.left - (parseFloat(cs.marginLeft) || 0);
      const right = r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      if (p.x >= left && p.x <= right && p.y >= r.top - 12 && p.y <= r.bottom + 40) return s.zones[1];
      return null;
    }
    const site = under?.closest?.('.site');
    return site ? (s.zones.find((z) => z.el === site) ?? null) : null;
  }

  function placeGhost(s, p) {
    const g = layer().ghost;
    const w = g.offsetWidth;
    const hh = g.offsetHeight;
    // under a finger the ghost goes above it, where it can be seen
    let x = s.type === 'touch' ? p.x - w / 2 : p.x + 16;
    let y = s.type === 'touch' ? p.y - hh - 44 : p.y + 16;
    x = Math.max(4, Math.min(window.innerWidth - w - 4, x));
    y = Math.max(4, Math.min(window.innerHeight - hh - 4, y));
    g.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function clearZones(s) {
    for (const z of s.zones) z.el.classList.remove('is-drop-target', 'is-drop-over', 'is-drop-blocked');
    const l = layer();
    l.el.hidden = true;
    l.ghost.hidden = true;
    s.button.classList.remove('is-dragged');
  }

  draggable(
    bar,
    {
      start(p) {
        const item = p.target._item;
        if (!item) return null;
        const l = layer();
        l.svg.hidden = true;
        l.ghost.replaceChildren(
          icon(item.type ?? 'school', 'drag-ghost__icon'),
          h('span', { class: 'drag-ghost__name' }, nameOf(item)),
          h('span', { class: 'drag-ghost__where' }),
        );
        l.ghost.className = 'drag-ghost';
        l.ghost.hidden = false;
        l.el.hidden = false;
        const zones = zonesFor(item);
        for (const z of zones) z.el.classList.add(z.blocked ? 'is-drop-blocked' : 'is-drop-target');
        p.target.classList.add('is-dragged');
        say(item.kind === 'school' ? t('drag.live.school') : t('drag.live.machine', { type: nameOf(item) }));
        return { item, button: p.target, zones, over: null, type: p.type };
      },
      move(s, p) {
        const zone = zoneAt(s, p);
        if (zone !== s.over) {
          s.over?.el.classList.remove('is-drop-over');
          if (zone && !zone.blocked) zone.el.classList.add('is-drop-over');
          s.over = zone;
        }
        const g = layer().ghost;
        let where;
        if (s.item.kind === 'school') where = t(zone ? 'drag.onNet' : 'drag.toNet');
        else if (!zone) where = t('drag.toSchool');
        else where = t(zone.blocked ? 'drag.blocked' : 'drag.onSchool', { school: zone.name });
        setText(g.lastChild, where);
        g.classList.toggle('is-on', Boolean(zone && !zone.blocked));
        g.classList.toggle('is-blocked', Boolean(zone?.blocked));
        placeGhost(s, p);
      },
      drop(s, p) {
        const zone = zoneAt(s, p);
        clearZones(s);
        if (!zone) {
          toast(t('drag.missed'), 'info');
          say(t('drag.missed'));
          return;
        }
        if (zone.blocked) {
          toast(t('drag.suspended', { school: zone.name }), 'warn');
          return;
        }
        if (s.item.kind === 'school') openAddSchool({ opener: s.button });
        else openAddMachine({ type: s.item.type, school: zone.code, opener: s.button });
      },
      cancel(s, why) {
        clearZones(s);
        if (why === 'escape') say(t('drag.live.cancelled'));
      },
    },
    { selector: '.build__item' },
  );

  // ---- dialogs: shared parts ----------------------------------------------------------------------

  let seq = 0;
  /** A form field: label, control, hint; `mark()` shows a problem with it. */
  function field(labelText, control, hintText = null) {
    control.id ||= `bf${++seq}`;
    const label = h('label', { for: control.id, class: 'bfield__label' }, labelText);
    const hint = hintText === null ? null : h('p', { class: 'bfield__hint', id: `${control.id}-hint` }, hintText);
    if (hint) control.setAttribute('aria-describedby', hint.id);
    const el = h('div', { class: 'bfield' }, label, control, hint);
    return { el, label, control, hint };
  }

  /** A dialog's frame: title, subtitle, body, error, Cancel and the main button. */
  function frame(dialog) {
    const form = dialog.querySelector('form');
    const r = {
      dialog,
      form,
      title: dialog.querySelector('.dialog__head h2'),
      sub: dialog.querySelector('.dialog__head p'),
      body: dialog.querySelector('.dialog__body'),
      error: dialog.querySelector('.dialog__error'),
      cancel: dialog.querySelector('[data-role="cancel"]'),
      submit: dialog.querySelector('[data-role="submit"]'),
      opener: null,
    };
    r.cancel.addEventListener('click', () => dialog.close());
    // a click on the backdrop closes it, like Escape
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      const opener = r.opener;
      r.opener = null;
      // back where the person was; the page may scroll to what was just added (not to the opener)
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
    return r;
  }

  function showError(r, error, control = null) {
    setText(r.error, typeof error === 'string' ? error : errorText(error, t));
    setHidden(r.error, false);
    for (const el of r.body.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      control.focus();
    }
  }

  function clearError(r) {
    setText(r.error, '');
    setHidden(r.error, true);
    for (const el of r.body.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
  }

  // ---- add a machine --------------------------------------------------------------------------------

  const am = frame(document.getElementById('addm-dialog'));
  const amTypeLegend = h('legend', {});
  const amTypes = TYPES.map((type) => {
    const input = h('input', { type: 'radio', name: 'addm-type', value: type, id: `addm-type-${type}` });
    const text = h('span', { class: 'bchoice__text' });
    const label = h('label', { class: 'bchoice', for: input.id }, input, icon(type, 'bchoice__icon'), text);
    input.addEventListener('change', () => amChanged());
    return { type, input, text, label };
  });
  const amTypeSet = h('fieldset', { class: 'bfieldset bchoices' }, amTypeLegend, amTypes.map((x) => x.label));
  const amSchool = field('', h('select', { id: 'addm-school' }), '');
  amSchool.control.addEventListener('change', () => amChanged());
  const amCode = field('', h('input', { type: 'text', id: 'addm-code', class: 'mono', maxlength: '32', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters' }), '');
  const amLocation = field('', h('input', { type: 'text', id: 'addm-location', maxlength: String(MAX_LOCATION), autocomplete: 'off' }), '');
  const amPlugInput = h('input', { type: 'checkbox', id: 'addm-plug' });
  const amPlugText = h('span', {});
  const amPlugHint = h('p', { class: 'bfield__hint', id: 'addm-plug-hint' });
  amPlugInput.setAttribute('aria-describedby', amPlugHint.id);
  const amPlug = h('div', { class: 'bfield' }, h('label', { class: 'bcheck', for: amPlugInput.id }, amPlugInput, amPlugText), amPlugHint);
  am.body.append(amTypeSet, amSchool.el, h('div', { class: 'bfields' }, amCode.el, amLocation.el), amPlug);

  let amCodeTouched = false; // the person typed a code: the suggestions leave it alone
  let amAsk = 0; // the newest next-code question (older answers are ignored)
  amCode.control.addEventListener('input', () => {
    const up = amCode.control.value.toUpperCase();
    if (up !== amCode.control.value) amCode.control.value = up;
    // typed: the suggestions leave it alone; emptied: the lab picks the next free code
    amCodeTouched = true;
  });

  const amType = () => amTypes.find((x) => x.input.checked)?.type ?? null;

  function relabelAddMachine() {
    const school = schoolOf(amSchool.control.value);
    setText(am.title, school ? t('addm.titleTo', { school: school.name }) : t('addm.title'));
    setText(am.sub, t('addm.sub'));
    setText(amTypeLegend, t('addm.type'));
    for (const x of amTypes) setText(x.text, t(`type.${x.type}`));
    setText(amSchool.label, t('addm.school'));
    setText(amCode.label, t('addm.code'));
    setText(amCode.hint, t('addm.codeHint'));
    setText(amLocation.label, t('addm.location'));
    setText(amLocation.hint, t('addm.locationHint', { n: MAX_LOCATION }));
    setText(amPlugText, t('addm.plug'));
    setText(amPlugHint, t('addm.plugHint'));
    setText(am.cancel, t('cancel'));
    if (!am.submit.hasAttribute('aria-busy')) setText(am.submit, t('addm.submit'));
    schoolOptions();
  }

  /** The school list: every school (a suspended one cannot be chosen), drawn again only when it changes. */
  function schoolOptions() {
    const list = schools();
    const sig = JSON.stringify([app.i18n.lang, list.map((s) => [s.code, s.name, s.status])]);
    const select = amSchool.control;
    if (select.dataset.sig !== sig) {
      const keep = select.value;
      select.replaceChildren(
        h('option', { value: '', disabled: true }, t('addm.schoolPick')),
        ...list.map((s) => {
          const suspended = s.status === 'SUSPENDED';
          return h('option', { value: s.code, disabled: suspended }, suspended ? t('addm.schoolSuspended', { name: s.name }) : `${s.name} (${s.code})`);
        }),
      );
      select.value = list.some((s) => s.code === keep && s.status !== 'SUSPENDED') ? keep : '';
      select.dataset.sig = sig;
    }
    const school = schoolOf(select.value);
    const suspended = school?.status === 'SUSPENDED';
    setText(amSchool.hint, suspended ? t('addm.suspended', { name: school.name }) : t('addm.schoolHint'));
    amSchool.hint.classList.toggle('is-warn', suspended);
  }

  /** The type or school changed: the code suggestion follows (unless the person typed one). */
  function amChanged() {
    const type = amType();
    const school = schoolOf(amSchool.control.value);
    setText(am.title, school ? t('addm.titleTo', { school: school.name }) : t('addm.title'));
    clearError(am);
    if (!type || !school) return;
    prefs.set('build.school', school.code);
    const here = nextCodeHere(school, type);
    amCode.control.placeholder = here;
    if (!amCodeTouched) amCode.control.value = here;
    const ask = ++amAsk;
    get(`/api/lab/devices/next-code?schoolCode=${encodeURIComponent(school.code)}&type=${encodeURIComponent(type)}`)
      .then((res) => {
        if (ask !== amAsk || typeof res?.code !== 'string') return;
        amCode.control.placeholder = res.code;
        if (!amCodeTouched) amCode.control.value = res.code;
      })
      .catch(() => {
        // the page's own suggestion stays (an older lab has no next-code)
      });
  }

  /**
   * Open the Add machine dialog. type: from the device bar; school: where it was dropped (else the
   * person chooses, starting from the school they chose last time).
   */
  function openAddMachine({ type = null, school = null, opener = null } = {}) {
    if (am.dialog.open) return;
    am.opener = opener ?? document.activeElement;
    amCodeTouched = false;
    amCode.control.value = '';
    amLocation.control.value = '';
    amPlugInput.checked = false;
    for (const x of amTypes) x.input.checked = x.type === (type ?? 'CANTEEN');
    amCode.control.placeholder = '';
    const last = prefs.get('build.school', null);
    const usable = (code) => schools().some((s) => s.code === code && s.status !== 'SUSPENDED');
    schoolOptions();
    amSchool.control.value = school && schoolOf(school) ? school : usable(last) ? last : '';
    relabelAddMachine();
    clearError(am);
    amChanged();
    am.dialog.showModal();
    // dropped on a school: the code is ready, Enter adds it; else choose the school first
    if (school) {
      amCode.control.focus();
      amCode.control.select();
    } else if (type) amSchool.control.focus();
    else amTypes.find((x) => x.input.checked)?.input.focus();
  }

  am.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (am.submit.disabled) return;
    const type = amType();
    const school = schoolOf(amSchool.control.value);
    const code = amCode.control.value.trim().toUpperCase();
    const location = amLocation.control.value.trim();
    if (!school) return showError(am, t('addm.needSchool'), amSchool.control);
    if (school.status === 'SUSPENDED') return showError(am, t('addm.suspended', { name: school.name }), amSchool.control);
    if (!type) return showError(am, t('addm.needType'), amTypes[0].input);
    if (code && !DEVICE_CODE_RE.test(code)) return showError(am, t('addm.codeInvalid'), amCode.control);
    if (location.length > MAX_LOCATION) return showError(am, t('addm.locationLong', { n: MAX_LOCATION }), amLocation.control);
    clearError(am);
    const body = { schoolCode: school.code, type, cablePlugged: amPlugInput.checked };
    if (code) body.code = code;
    if (location) body.location = location;
    const res = await app.call('/api/lab/devices', body, am.submit, t('addm.busy'));
    if (!res.ok) {
      const at = { DEVICE_CODE_TAKEN: amCode, DEVICE_CODE_INVALID: amCode, LOCATION_INVALID: amLocation, SCHOOL_NOT_FOUND: amSchool, SCHOOL_SUSPENDED: amSchool }[res.error?.code];
      if (am.dialog.open) showError(am, res.error, at?.control ?? null);
      else app.fail(res.error);
      return;
    }
    am.dialog.close();
    // (an answer held at a hop may not carry the machine: then the code it was given, or the suggestion)
    const added = res.data?.machine?.code ?? (code || amCode.control.placeholder);
    const plugged = Boolean(res.data?.machine?.cablePlugged ?? body.cablePlugged);
    let text = t(plugged ? 'addm.doneIn' : 'addm.doneOut', { code: added, school: school.name });
    if (res.held) text = t('addm.doneHeld', { code: added, school: school.name });
    toast(text, 'good');
    say(text);
    if (added) showWhenThere({ kind: 'machine', key: `${school.code}/${added}` });
  });

  // ---- add a school ---------------------------------------------------------------------------------

  const as = frame(document.getElementById('adds-dialog'));
  const asName = field('', h('input', { type: 'text', id: 'adds-name', maxlength: String(MAX_NAME), autocomplete: 'off' }), null);
  const asCode = field('', h('input', { type: 'text', id: 'adds-code', class: 'mono', maxlength: '32', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' }), '');
  const asStudents = field('', h('input', { type: 'number', id: 'adds-students', min: '0', max: String(MAX_STUDENTS), step: '1', inputmode: 'numeric', class: 'bfield__number' }), '');
  const asMachineLegend = h('legend', {});
  const asMachines = TYPES.map((type) => {
    const input = h('input', { type: 'checkbox', id: `adds-m-${type}`, value: type });
    const text = h('span', { class: 'bchoice__text' });
    return { type, input, text, label: h('label', { class: 'bchoice', for: input.id }, input, icon(type, 'bchoice__icon'), text) };
  });
  const asMachinesHint = h('p', { class: 'bfield__hint', id: 'adds-machines-hint' });
  const asMachineSet = h('fieldset', { class: 'bfieldset bchoices', 'aria-describedby': asMachinesHint.id }, asMachineLegend, asMachines.map((x) => x.label), asMachinesHint);
  const asStaff = h('p', { class: 'bfield__hint addform__staff' });
  as.body.append(asName.el, h('div', { class: 'bfields' }, asCode.el, asStudents.el), asMachineSet, asStaff);

  let asCodeTouched = false;
  asName.control.addEventListener('input', () => {
    if (!asCodeTouched) asCode.control.value = schoolCodeFrom(asName.control.value);
  });
  asCode.control.addEventListener('input', () => {
    const low = asCode.control.value.toLowerCase();
    if (low !== asCode.control.value) asCode.control.value = low;
    // typed: the name no longer changes it; emptied: it follows the name again
    asCodeTouched = low !== '';
  });

  function relabelAddSchool() {
    setText(as.title, t('adds.title'));
    setText(as.sub, t('adds.sub'));
    setText(asName.label, t('adds.name'));
    setAttr(asName.control, 'placeholder', t('adds.namePlaceholder'));
    setText(asCode.label, t('adds.code'));
    setText(asCode.hint, t('adds.codeHint'));
    setText(asStudents.label, t('adds.students'));
    setText(asStudents.hint, t('adds.studentsHint', { max: MAX_STUDENTS }));
    setText(asMachineLegend, t('adds.machines'));
    for (const x of asMachines) setText(x.text, t(`type.${x.type}`));
    setText(asMachinesHint, t('adds.machinesHint'));
    setText(asStaff, t('adds.staff'));
    setText(as.cancel, t('cancel'));
    if (!as.submit.hasAttribute('aria-busy')) setText(as.submit, t('adds.submit'));
  }

  function openAddSchool({ opener = null } = {}) {
    if (as.dialog.open) return;
    as.opener = opener ?? document.activeElement;
    asCodeTouched = false;
    asName.control.value = '';
    asCode.control.value = '';
    asStudents.control.value = String(DEFAULT_STUDENTS);
    for (const x of asMachines) x.input.checked = true;
    clearError(as);
    relabelAddSchool();
    as.dialog.showModal();
    asName.control.focus();
  }

  as.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (as.submit.disabled) return;
    const name = asName.control.value.trim();
    const code = asCode.control.value.trim().toLowerCase() || schoolCodeFrom(name);
    const studentsText = asStudents.control.value.trim();
    const students = studentsText === '' ? DEFAULT_STUDENTS : Number(studentsText);
    if (name.length < 1 || name.length > MAX_NAME) return showError(as, t('adds.nameInvalid', { max: MAX_NAME }), asName.control);
    if (!SCHOOL_CODE_RE.test(code)) return showError(as, t('adds.codeInvalid'), asCode.control);
    if (schoolOf(code)) return showError(as, t('adds.codeTaken', { code }), asCode.control);
    if (!Number.isInteger(students) || students < 0 || students > MAX_STUDENTS) return showError(as, t('adds.studentsInvalid', { max: MAX_STUDENTS }), asStudents.control);
    clearError(as);
    const machines = asMachines.filter((x) => x.input.checked).map((x) => ({ type: x.type }));
    // the site appears with the state refresh, maybe before the answer: this page says so itself
    topology.expectSchool(code);
    const res = await app.call('/api/lab/schools', { name, code, students, machines }, as.submit, t('adds.busy'));
    if (!res.ok) {
      topology.unexpectSchool(code);
      const at = { SCHOOL_CODE_TAKEN: asCode, SCHOOL_CODE_INVALID: asCode, NAME_INVALID: asName }[res.error?.code];
      if (as.dialog.open) showError(as, res.error, at?.control ?? null);
      else app.fail(res.error);
      return;
    }
    as.dialog.close();
    const added = res.data?.school ?? { code, name };
    const text = t('adds.done', { name: added.name ?? name, code: added.code ?? code, machines: res.data?.machines?.length ?? machines.length, cards: students });
    toast(text, 'good');
    say(text);
    showWhenThere({ kind: 'site', code: added.code ?? code });
  });

  // ---- what was just added: shown as soon as it is on the page ---------------------------------------

  let reveal = null; // { kind: 'machine'|'site', key?, code?, until }
  function showWhenThere(what) {
    reveal = { ...what, until: performance.now() + REVEAL_WAIT_MS };
    tryReveal();
    app.refresh(0);
  }
  function tryReveal() {
    if (!reveal) return;
    if (performance.now() > reveal.until) {
      reveal = null;
      return;
    }
    const shown = reveal.kind === 'machine' ? topology.showMachine(reveal.key) : topology.showSite(reveal.code);
    if (shown) reveal = null;
  }

  relabelBar();

  return {
    openAddMachine,
    openAddSchool,
    /** The state was drawn again: what was just added may be there now. */
    update() {
      relabelBar();
      tryReveal();
      // an open dialog keeps its choices; its school list follows the lab
      if (am.dialog.open) schoolOptions();
    },
    relang() {
      relabelBar();
      if (am.dialog.open) relabelAddMachine();
      if (as.dialog.open) relabelAddSchool();
    },
  };
}
