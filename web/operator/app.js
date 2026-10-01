// Operator console (/operator/): the SaaS owner's view. One server, many schools: every tenant
// with its status and numbers, onboarding a new school whole (its machines' secrets are shown
// once), suspending or reactivating a school (an operator action, never a school's), and the
// health of the shared cloud server.

import { get, post, h, toast, formatRM, formatKL } from '/shared/api.js';
import { createI18n } from '/shared/i18n.js';
import {
  KIT_STRINGS,
  mergeStrings,
  createApi,
  createConnectionWatch,
  closeAllDialogs,
  dialogOpen,
  errorMessage,
  errorDetails,
  every,
  loadProblem,
  openDialog,
  pill,
  dataTable,
  tile,
  copyButton,
} from '/admin/kit.js';
import { STRINGS } from './strings.js';

const i18n = createI18n(mergeStrings(KIT_STRINGS, STRINGS));
const { t } = i18n;

const SCHOOL_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const DEVICE_CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,30}[A-Z0-9])?$/;
const ROLES = ['OFFICE', 'FINANCE', 'ADMIN'];
const TYPES = ['CANTEEN', 'WATER', 'KIOSK'];

/** Fictional schools for "Fill in an example" (the first whose code is free is used). */
const EXAMPLES = [
  { name: 'SK Taman Melati', code: 'sk-taman-melati', staff: [['Farah binti Ismail', 'OFFICE'], ['Lim Chee Keong', 'FINANCE'], ['Rajesh a/l Kumar', 'ADMIN']] },
  { name: 'SMK Bukit Contoh', code: 'smk-bukit-contoh', staff: [['Aminah binti Yusof', 'OFFICE'], ['Ng Kok Wai', 'FINANCE'], ['Devi a/p Raman', 'ADMIN']] },
  { name: 'SK Seri Cempaka', code: 'sk-seri-cempaka', staff: [['Hafiz bin Kassim', 'OFFICE'], ['Tan Siew Ping', 'FINANCE'], ['Mohan a/l Pillai', 'ADMIN']] },
];
const EXAMPLE_MACHINES = [
  { code: 'CANTEEN-01', type: 'CANTEEN', location: 'Canteen counter' },
  { code: 'WATER-01', type: 'WATER', location: 'Block A water point' },
  { code: 'KIOSK-01', type: 'KIOSK', location: 'Front office' },
];

const $ = (id) => document.getElementById(id);
const els = { conn: $('conn'), main: $('main'), band: $('band'), signout: $('signout') };

let screen = 'boot'; // 'boot' | 'waiting' | 'signin' | 'app'
let stopPoll = null;
let polling = false;
let lastSignInMessage = null;
let schools = []; // the last tenants overview
let ui = null; // the boxes of the signed-in page

const blankForm = () => ({
  name: '',
  code: '',
  codeTouched: false,
  staff: [{ name: '', role: 'ADMIN' }],
  machines: EXAMPLE_MACHINES.map((m) => ({ ...m, location: '' })),
  demo: '5',
});
let form = blankForm();
let result = null; // the last onboarding answer, kept (secrets included) until the operator hides it

const watch = createConnectionWatch({
  t,
  host: els.conn,
  probe: () => get('/api/operator/me'),
  onRestored: () => (screen === 'app' ? refresh() : boot()),
});

const api = createApi((err) => {
  if (watch.report(err)) {
    if (screen === 'app') drawHealthDown();
    return true;
  }
  if (err.code === 'NOT_SIGNED_IN' && screen === 'app') {
    showSignIn(() => t('signin.ended'));
    return true;
  }
  return false;
});

// ---- screens ------------------------------------------------------------------------------

function leaveApp() {
  stopPoll?.();
  stopPoll = null;
  closeAllDialogs();
  els.band.hidden = true;
  ui = null;
}

async function boot() {
  try {
    await api.get('/api/operator/me');
    showApp();
  } catch (err) {
    if (err.code === 'NOT_SIGNED_IN') return showSignIn();
    if (err.handled) {
      leaveApp();
      screen = 'waiting';
      els.main.replaceChildren(h('p', { class: 'muted boot-note' }, t('app.waiting')));
      return;
    }
    showSignIn(() => errorMessage(t, err));
  }
}

/** @param {() => string} [message] a note shown above the button (a function, so it follows the language) */
function showSignIn(message) {
  leaveApp();
  screen = 'signin';
  lastSignInMessage = message ?? null;
  document.title = `${t('signin.title')} · OneCard Lab`;
  const status = h('div', { role: 'status' }, message ? h('p', { class: 'notice notice--warn' }, message()) : null);
  const button = h('button', { type: 'button', class: 'btn btn--primary op-signin__button' }, t('signin.button'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await post('/api/operator/login');
      showApp();
    } catch (err) {
      button.disabled = false;
      if (!watch.report(err)) status.replaceChildren(h('p', { class: 'notice notice--bad' }, errorMessage(t, err)));
    }
  });
  els.main.replaceChildren(
    h(
      'section',
      { class: 'op-signin panel' },
      h('h1', {}, t('signin.title')),
      h('p', { class: 'signin__lede' }, t('signin.lede')),
      h('p', { class: 'muted' }, t('signin.what')),
      status,
      h('div', {}, button),
    ),
  );
}

async function signOut() {
  try {
    await post('/api/operator/logout');
  } catch (err) {
    watch.report(err);
  }
  showSignIn();
}
els.signout.addEventListener('click', signOut);

function showApp() {
  leaveApp();
  screen = 'app';
  els.band.hidden = false;
  document.title = `${t('app.name')} · OneCard Lab`;
  const flashes = h('div', { class: 'flashes' });
  const health = h('div', { class: 'tiles' }, h('p', { class: 'muted' }, t('kit.loading')));
  const tenants = h('div', {}, h('p', { class: 'muted' }, t('kit.loading')));
  const onboard = h('section', { class: 'panel stack', 'aria-labelledby': 'on-title' });
  ui = { flashes, health, tenants, onboard };
  els.main.replaceChildren(
    h(
      'div',
      { class: 'view op-view' },
      flashes,
      h(
        'section',
        { class: 'panel stack', 'aria-labelledby': 'hl-title' },
        h('div', { class: 'panel__head' }, h('h2', { id: 'hl-title', class: 'panel__title' }, t('hl.title'))),
        h('p', { class: 'muted small' }, t('hl.text')),
        health,
      ),
      h(
        'section',
        { class: 'panel stack', 'aria-labelledby': 'tn-title' },
        h(
          'div',
          { class: 'panel__head op-head' },
          h('h2', { id: 'tn-title', class: 'panel__title' }, t('tn.title')),
          h('button', { type: 'button', class: 'btn btn--small', onclick: () => refresh() }, t('tn.refresh')),
        ),
        h('p', { class: 'muted small' }, t('tn.text')),
        tenants,
      ),
      onboard,
    ),
  );
  drawOnboard();
  refresh();
  stopPoll = every(6000, async () => {
    if (screen !== 'app' || dialogOpen()) return;
    polling = true;
    try {
      await refresh();
    } finally {
      polling = false;
    }
  });
}

/** Replace a box's content, except during auto-refresh while the keyboard focus is inside it. */
function swap(box, ...nodes) {
  if (polling && box.contains(document.activeElement)) return;
  const hadFocus = box.contains(document.activeElement);
  box.replaceChildren(...nodes);
  if (hadFocus) $('tn-title')?.setAttribute('tabindex', '-1');
  if (hadFocus) $('tn-title')?.focus();
}

function flash(content, tone = 'good') {
  if (!ui) return;
  const note = h(
    'div',
    { class: `notice notice--${tone} flash`, role: 'status' },
    h('div', { class: 'flash__body' }, content),
    h('button', { type: 'button', class: 'btn btn--small btn--ghost flash__close', onclick: () => note.remove() }, t('kit.close')),
  );
  ui.flashes.prepend(note);
}

// ---- health and tenants -------------------------------------------------------------------

async function refresh() {
  if (screen !== 'app') return;
  let rows;
  let health;
  try {
    [rows, health] = await Promise.all([api.get('/api/operator/schools'), api.get('/api/operator/health')]);
  } catch (err) {
    if (ui && !err.handled && !ui.tenants.querySelector('table')) ui.tenants.replaceChildren(loadProblem(t, err, refresh));
    return;
  }
  if (screen !== 'app' || !ui) return;
  schools = rows;
  drawHealth(health);
  drawTenants(rows, health.broker?.bySchool ?? {});
}

function drawHealth(health) {
  const bySchool = health.broker?.bySchool ?? {};
  const machines = Object.values(bySchool).reduce((sum, n) => sum + n, 0);
  const mqtt = health.platform?.mqtt ?? null;
  const linked = mqtt ? Boolean(mqtt.connected) && mqtt.subscribed !== false : null;
  const active = schools.filter((s) => s.status === 'ACTIVE').length;
  ui.health.replaceChildren(
    tile({ label: t('hl.server'), value: t(health.server?.up === false ? 'hl.serverDown' : 'hl.serverUp'), sub: t('hl.serverSub'), tone: health.server?.up === false ? 'bad' : 'good' }),
    tile({
      label: t('hl.link'),
      value: linked === null ? t('hl.linkUnknown') : t(linked ? 'hl.linkUp' : 'hl.linkDown'),
      sub: mqtt?.url ?? '',
      tone: linked ? 'good' : 'warn',
    }),
    tile({
      label: t('hl.broker'),
      value: health.broker?.up ? String(health.broker.clients) : '—',
      sub: health.broker?.up ? t('hl.brokerSub', { machines, other: health.broker.other ?? 0 }) : t('hl.brokerDown'),
      tone: health.broker?.up ? 'info' : 'bad',
    }),
    tile({ label: t('hl.schools'), value: String(health.schools ?? schools.length), sub: t('hl.schoolsSub', { active, suspended: schools.length - active }) }),
  );
}

/** While the server is off the health API cannot answer either: say so in the tiles. */
function drawHealthDown() {
  if (!ui) return;
  ui.health.replaceChildren(
    tile({ label: t('hl.server'), value: t('hl.serverDown'), sub: t('hl.serverDownSub'), tone: 'bad' }),
    tile({ label: t('hl.link'), value: '—', sub: '' }),
    tile({ label: t('hl.broker'), value: '—', sub: t('hl.brokerDown'), tone: 'bad' }),
    tile({ label: t('hl.schools'), value: schools.length ? String(schools.length) : '—', sub: '' }),
  );
}

function drawTenants(rows, bySchool) {
  const head = [
    { label: t('tn.school'), class: 'col-school' },
    t('tn.status'),
    { label: t('tn.members'), num: true },
    { label: t('tn.machines'), num: true },
    { label: t('tn.sales'), num: true },
    { label: t('tn.waiting'), num: true },
    { label: t('tn.differences'), num: true },
    t('tn.action'),
  ];
  swap(
    ui.tenants,
    dataTable({
      label: t('tn.title'),
      head,
      empty: t('tn.empty'),
      rows: rows.map((s) => {
        const active = s.status === 'ACTIVE';
        return [
          h('span', { class: 'who' }, h('strong', {}, s.name), h('code', { class: 'chip' }, s.code), h('span', { class: 'muted small' }, t('tn.sinceAt', { at: formatKL(s.createdAt) }))),
          pill(t(`school.${s.status}`), active ? 'good' : 'bad'),
          h('span', { class: 'cell-2' }, h('span', {}, String(s.members)), h('span', { class: 'muted small' }, t('tn.cardsN', { n: s.cards }))),
          h(
            'span',
            { class: 'cell-2' },
            h('span', {}, t('tn.machinesValue', { online: s.devices.online, total: s.devices.total })),
            h('span', { class: 'muted small' }, t('tn.brokerN', { n: bySchool[s.code] ?? 0 })),
          ),
          formatRM(s.todaySalesSen),
          formatRM(s.waitingSen),
          s.openDifferences > 0 ? pill(String(s.openDifferences), 'warn') : '0',
          active
            ? h('button', { type: 'button', class: 'btn btn--small btn--danger', onclick: () => setStatus(s, 'SUSPENDED') }, t('tn.suspend'))
            : h('button', { type: 'button', class: 'btn btn--small btn--primary', onclick: () => setStatus(s, 'ACTIVE') }, t('tn.reactivate')),
        ];
      }),
    }),
  );
}

/** Suspend or reactivate, after a confirmation in the page. */
async function setStatus(school, status) {
  const suspend = status === 'SUSPENDED';
  const out = await openDialog({
    t,
    title: t(suspend ? 'tn.suspendTitle' : 'tn.reactivateTitle', { school: school.name }),
    body: suspend
      ? h('ul', { class: 'changes' }, h('li', {}, t('tn.suspendBody1')), h('li', {}, t('tn.suspendBody2')), h('li', {}, t('tn.suspendBody3')))
      : h('p', {}, t('tn.reactivateBody')),
    confirmLabel: t(suspend ? 'tn.suspendConfirm' : 'tn.reactivateConfirm'),
    tone: suspend ? 'danger' : 'primary',
    focusCancel: suspend,
    action: () => api.post(`/api/operator/schools/${encodeURIComponent(school.code)}/status`, { status }),
  });
  if (!out) return;
  if (suspend) flash(h('strong', {}, t('tn.suspended', { school: out.name, n: out.kicked ?? 0 })), 'warn');
  else flash([h('strong', {}, t('tn.reactivated', { school: out.name })), ' ', t(out.published ? 'tn.sent' : 'tn.notSent')], out.published ? 'good' : 'warn');
  await refresh();
}

// ---- onboarding -----------------------------------------------------------------------------

/** 'SK Taman Melati' -> 'sk-taman-melati' (a suggestion until the operator types a code). */
function slug(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

let fieldSeq = 0;
const nextId = (p) => `${p}${++fieldSeq}`;

/** An input with its label, hint and a place for an error. */
function field(label, input, hint) {
  input.id ||= nextId('of');
  const err = h('span', { class: 'field-error', id: `${input.id}-err`, hidden: true });
  const hintEl = hint ? h('span', { class: 'field-hint', id: `${input.id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hintEl, err);
}

function mark(input, message) {
  const err = document.getElementById(`${input.id}-err`);
  if (err) {
    err.textContent = message ?? '';
    err.hidden = !message;
  }
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  const hint = document.getElementById(`${input.id}-hint`);
  const ids = [message && err ? err.id : null, hint ? hint.id : null].filter(Boolean).join(' ');
  if (ids) input.setAttribute('aria-describedby', ids);
  else input.removeAttribute('aria-describedby');
  return !message;
}

function select(options, value, onChange) {
  const el = h('select', {}, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function drawOnboard() {
  if (!ui) return;
  const box = ui.onboard;
  const status = h('div', { class: 'form-status', role: 'status' });

  const name = h('input', { type: 'text', value: form.name, maxlength: 100, autocomplete: 'off' });
  const code = h('input', { type: 'text', class: 'mono', value: form.code, maxlength: 32, autocomplete: 'off', spellcheck: 'false' });
  name.addEventListener('input', () => {
    form.name = name.value;
    if (!form.codeTouched) {
      form.code = slug(name.value);
      code.value = form.code;
    }
  });
  code.addEventListener('input', () => {
    form.code = code.value.toLowerCase();
    if (code.value !== form.code) code.value = form.code;
    form.codeTouched = form.code !== '';
  });

  // staff rows
  const staffRows = h('div', { class: 'rows' });
  const drawStaff = (focusLast = false) => {
    staffRows.replaceChildren(
      ...form.staff.map((p, i) => {
        const input = h('input', { type: 'text', value: p.name, maxlength: 100, autocomplete: 'off' });
        input.addEventListener('input', () => {
          p.name = input.value;
        });
        const role = select(ROLES.map((r) => [r, `${t(`role.${r}`)} · ${t(`roleText.${r}`)}`]), p.role, (v) => {
          p.role = v;
        });
        role.id = nextId('of');
        const remove = h('button', { type: 'button', class: 'btn btn--small btn--ghost', 'aria-label': t('on.removeStaff', { n: i + 1 }) }, t('on.remove'));
        remove.addEventListener('click', () => {
          form.staff.splice(i, 1);
          drawStaff();
          addStaff.focus();
        });
        const line = h('div', { class: 'row-line' }, field(t('on.staffName'), input), field(t('on.role'), role), h('div', { class: 'row-line__end' }, remove));
        line._input = input;
        return line;
      }),
    );
    if (focusLast) staffRows.lastElementChild?.querySelector('input')?.focus();
  };
  const addStaff = h('button', { type: 'button', class: 'btn btn--small' }, t('on.addStaff'));
  addStaff.addEventListener('click', () => {
    form.staff.push({ name: '', role: 'OFFICE' });
    drawStaff(true);
  });

  // machine rows
  const machineRows = h('div', { class: 'rows' });
  const drawMachines = (focusLast = false) => {
    machineRows.replaceChildren(
      ...form.machines.map((m, i) => {
        const mcode = h('input', { type: 'text', class: 'mono', value: m.code, maxlength: 32, autocomplete: 'off', spellcheck: 'false' });
        mcode.addEventListener('input', () => {
          const up = mcode.value.toUpperCase();
          if (up !== mcode.value) mcode.value = up;
          m.code = up;
        });
        const type = select(TYPES.map((x) => [x, t(`devType.${x}`)]), m.type, (v) => {
          m.type = v;
        });
        type.id = nextId('of');
        const loc = h('input', { type: 'text', value: m.location, maxlength: 80, autocomplete: 'off' });
        loc.addEventListener('input', () => {
          m.location = loc.value;
        });
        const remove = h('button', { type: 'button', class: 'btn btn--small btn--ghost', 'aria-label': t('on.removeMachine', { n: i + 1 }) }, t('on.remove'));
        remove.addEventListener('click', () => {
          form.machines.splice(i, 1);
          drawMachines();
          addMachine.focus();
        });
        const line = h('div', { class: 'row-line row-line--machine' }, field(t('on.machineCode'), mcode), field(t('on.machineType'), type), field(t('on.location'), loc), h('div', { class: 'row-line__end' }, remove));
        line._inputs = { mcode, loc };
        return line;
      }),
    );
    if (focusLast) machineRows.lastElementChild?.querySelector('input')?.focus();
  };
  const addMachine = h('button', { type: 'button', class: 'btn btn--small' }, t('on.addMachine'));
  addMachine.addEventListener('click', () => {
    form.machines.push({ code: '', type: 'CANTEEN', location: '' });
    drawMachines(true);
  });

  const demo = h('input', { type: 'text', inputmode: 'numeric', value: form.demo, maxlength: 3, autocomplete: 'off' });
  demo.addEventListener('input', () => {
    form.demo = demo.value;
  });

  drawStaff();
  drawMachines();

  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, t('on.submit'));
  const example = h('button', { type: 'button', class: 'btn' }, t('on.example'));
  const clear = h('button', { type: 'button', class: 'btn btn--ghost' }, t('on.clear'));
  example.addEventListener('click', () => {
    const taken = new Set(schools.map((s) => s.code));
    let pick = EXAMPLES.find((e) => !taken.has(e.code));
    if (!pick) {
      let n = 2;
      while (taken.has(`${EXAMPLES[0].code}-${n}`)) n += 1;
      pick = { ...EXAMPLES[0], name: `${EXAMPLES[0].name} ${n}`, code: `${EXAMPLES[0].code}-${n}` };
    }
    form = {
      name: pick.name,
      code: pick.code,
      codeTouched: true,
      staff: pick.staff.map(([n, role]) => ({ name: n, role })),
      machines: EXAMPLE_MACHINES.map((m) => ({ ...m })),
      demo: '5',
    };
    drawOnboard();
    ui.onboard.querySelector('input')?.focus();
  });
  clear.addEventListener('click', () => {
    form = blankForm();
    drawOnboard();
    ui.onboard.querySelector('input')?.focus();
  });

  /** Check everything here first, so the operator sees each problem next to its field. */
  function validate() {
    let ok = true;
    ok = mark(name, form.name.trim().length < 1 || form.name.trim().length > 100 ? t('on.err.name') : null) && ok;
    const c = form.code.trim();
    ok = mark(code, !SCHOOL_CODE_RE.test(c) ? t('on.err.code') : schools.some((s) => s.code === c) ? t('on.err.codeTaken') : null) && ok;
    for (const line of staffRows.children) {
      const v = line._input.value.trim();
      ok = mark(line._input, v.length < 1 || v.length > 100 ? t('on.err.staffName') : null) && ok;
    }
    const seen = new Set();
    for (const line of machineRows.children) {
      const { mcode, loc } = line._inputs;
      const v = mcode.value.trim().toUpperCase();
      ok = mark(mcode, !DEVICE_CODE_RE.test(v) ? t('on.err.machineCode') : seen.has(v) ? t('on.err.machineTwice') : null) && ok;
      seen.add(v);
      ok = mark(loc, loc.value.trim().length > 80 ? t('on.err.location') : null) && ok;
    }
    const n = /^\d{1,3}$/.test(form.demo.trim()) ? Number(form.demo.trim()) : -1;
    ok = mark(demo, n < 0 || n > 200 ? t('on.err.demo') : null) && ok;
    return ok;
  }

  const formEl = h(
    'form',
    { class: 'stack', novalidate: true },
    h('div', { class: 'form-grid' }, field(t('on.name'), name, t('on.nameHint')), field(t('on.code'), code, t('on.codeHint'))),
    h('fieldset', { class: 'fieldset' }, h('legend', {}, t('on.staff')), h('p', { class: 'muted small' }, t('on.staffText')), staffRows, h('div', {}, addStaff)),
    h('fieldset', { class: 'fieldset' }, h('legend', {}, t('on.machines')), h('p', { class: 'muted small' }, t('on.machinesText')), machineRows, h('div', {}, addMachine)),
    h('div', { class: 'form-grid form-grid--narrow' }, field(t('on.demo'), demo, t('on.demoHint'))),
    status,
    h('div', { class: 'row' }, submit, example, clear),
  );
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) {
      status.replaceChildren(h('p', { class: 'notice notice--bad' }, t('on.fixFirst')));
      formEl.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    status.replaceChildren();
    submit.disabled = true;
    submit.textContent = t('on.working');
    const body = {
      code: form.code.trim(),
      name: form.name.trim(),
      staff: form.staff.map((p) => ({ name: p.name.trim(), role: p.role })),
      devices: form.machines.map((m) => ({ code: m.code.trim().toUpperCase(), type: m.type, location: m.location.trim() })),
      demoMembers: Number(form.demo.trim()),
    };
    try {
      result = await api.post('/api/operator/schools', body);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = t('on.submit');
      const details = errorDetails(err);
      status.replaceChildren(h('div', { class: 'notice notice--bad', role: 'alert' }, h('p', {}, errorMessage(t, err)), details.length ? h('ul', {}, details.map((d) => h('li', {}, d))) : null));
      return;
    }
    form = blankForm();
    toast(t('on.doneTitle', { school: result.school.name }), 'good');
    drawOnboard();
    ui.onboard.querySelector('.onboard-result h3')?.focus();
    refresh();
  });

  box.replaceChildren(
    h('div', { class: 'panel__head' }, h('h2', { id: 'on-title', class: 'panel__title' }, t('on.title'))),
    h('p', { class: 'muted small' }, t('on.text')),
    ...(result ? [resultPanel(result)] : []),
    formEl,
  );
}

/** What onboarding created, with each machine's secret shown once. */
function resultPanel(out) {
  const hidden = out.secretsHidden === true;
  const hide = h('button', { type: 'button', class: 'btn btn--small' }, t('on.hideSecrets'));
  hide.addEventListener('click', () => {
    out.secretsHidden = true;
    for (const d of out.devices) delete d.secret; // gone from this page for good
    drawOnboard();
    ui.onboard.querySelector('.onboard-result h3')?.focus();
  });
  const close = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, t('kit.close'));
  close.addEventListener('click', () => {
    result = null;
    drawOnboard();
  });
  const machines = out.devices.length
    ? dataTable({
        label: t('on.doneMachines'),
        head: [t('on.machineCode'), t('on.machineType'), t('on.location'), t('on.secret')],
        compact: true,
        rows: out.devices.map((d) => [
          h('strong', { class: 'mono' }, d.code),
          t(`devType.${d.type}`),
          d.location || '—',
          hidden || !d.secret ? h('span', { class: 'muted' }, '••••••') : h('span', { class: 'secret-cell' }, h('code', { class: 'secret__value' }, d.secret), copyButton(t, d.secret)),
        ]),
      })
    : h('p', { class: 'muted' }, t('on.noMachines'));
  return h(
    'section',
    { class: 'onboard-result stack', 'aria-labelledby': 'ob-done' },
    h('div', { class: 'panel__head op-head' }, h('h3', { id: 'ob-done', tabindex: '-1' }, t('on.doneTitle', { school: out.school.name })), close),
    h('p', {}, h('code', { class: 'chip' }, out.school.code), ' ', t(out.published ? 'on.donePublished' : 'on.doneNotPublished')),
    h('div', { class: 'stack-sm' }, h('p', {}, h('strong', {}, t('on.doneStaff'))), out.staff.length ? h('ul', { class: 'people' }, out.staff.map((s) => h('li', {}, s.name, ' ', pill(t(`role.${s.role}`), 'info')))) : h('p', { class: 'muted' }, t('on.noStaff')), h('a', { href: '/admin/' }, t('on.openOffice'))),
    h(
      'div',
      { class: 'stack-sm' },
      h('h4', {}, t('on.doneMachines')),
      out.devices.length ? (hidden ? h('p', { class: 'muted' }, t('on.secretsHidden')) : h('p', { class: 'secret secret--note' }, t('on.secretsWarn'))) : null,
      machines,
      out.devices.length && !hidden ? h('div', {}, hide) : null,
    ),
    h('p', {}, out.members > 0 ? t('on.doneMembers', { n: out.members }) : t('on.doneNoMembers')),
    h('p', {}, h('a', { href: '/lab/' }, t('on.openLab'))),
  );
}

// ---- language -----------------------------------------------------------------------------

document.getElementById('lang').append(i18n.switcher());
i18n.onChange(() => {
  watch.render();
  if (screen === 'app') {
    // keep the result notes and the form as typed; redraw everything else in the new language
    const kept = ui ? [...ui.flashes.children] : [];
    showApp();
    ui.flashes.append(...kept);
  } else if (screen === 'signin') showSignIn(lastSignInMessage);
  else if (screen === 'waiting') boot();
});
i18n.apply();
boot();
