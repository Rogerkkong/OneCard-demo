// School office (/admin/): the staff of ONE school. The school comes from the staff session
// only (the API never takes it from the page), so this app shows whatever school the session
// belongs to, and hides the sections the staff member's role may not use (the API refuses
// them anyway with 403 FORBIDDEN).

import { get, post, h } from '/shared/api.js';
import { createI18n } from '/shared/i18n.js';
import { KIT_STRINGS, mergeStrings, createApi, createConnectionWatch, closeAllDialogs, dialogOpen, errorMessage, every, loadProblem, pill } from './kit.js';
import { STRINGS } from './strings.js';
import { renderOverview } from './overview.js';
import { renderStudents, renderCards } from './students.js';
import { renderMember } from './member.js';
import { renderParents } from './parents.js';
import { renderMachines } from './machines.js';
import { renderPrices } from './prices.js';
import { renderTopups } from './topups.js';
import { renderBooks } from './books.js';
import { renderReconciliation } from './recon.js';
import { renderAudit } from './audit.js';

const i18n = createI18n(mergeStrings(KIT_STRINGS, STRINGS));
const { t } = i18n;

const OFFICE = ['OFFICE', 'ADMIN'];
const FINANCE = ['FINANCE', 'ADMIN'];
const ANY = ['OFFICE', 'FINANCE', 'ADMIN'];
const ADMIN = ['ADMIN'];

/** What each role may use: the same rules the API enforces (DESIGN §7 and the HTTP builder's notes). */
const ABILITIES = {
  members: ANY,
  editMembers: OFFICE,
  cards: OFFICE,
  parents: OFFICE,
  machines: OFFICE,
  prices: OFFICE,
  importJournal: OFFICE,
  topups: FINANCE,
  subsidies: FINANCE,
  books: FINANCE,
  differences: FINANCE,
  audit: ADMIN,
  runJobs: ADMIN,
};

/** The menu, in order. A section a role may not use is not shown at all. */
const SECTIONS = [
  { id: 'overview', roles: ANY, render: renderOverview },
  { id: 'students', roles: ANY, render: renderStudents },
  { id: 'parents', roles: OFFICE, render: renderParents },
  { id: 'machines', roles: OFFICE, render: renderMachines },
  { id: 'prices', roles: OFFICE, render: renderPrices },
  { id: 'topups', roles: FINANCE, render: renderTopups },
  { id: 'books', roles: FINANCE, render: renderBooks },
  { id: 'reconciliation', roles: ANY, render: renderReconciliation },
  { id: 'audit', roles: ADMIN, render: renderAudit },
];

const $ = (id) => document.getElementById(id);
const els = {
  conn: $('conn'),
  main: $('main'),
  nav: $('nav'),
  band: $('school-band'),
  schoolName: $('school-name'),
  schoolCode: $('school-code'),
  staffName: $('staff-name'),
  staffRole: $('staff-role'),
  staffRoleText: $('staff-role-text'),
  signout: $('signout'),
};

let session = null; // { staff, school } from the server
let screen = 'boot'; // 'boot' | 'waiting' | 'signin' | 'app' | 'suspended'
const view = { token: 0, stops: [] };
let stopBadgeLoop = null;
let stopSuspendedLoop = null;
let lastSignInMessage = null;
let pendingFlash = null; // a result to show at the top of the next view (ctx.go with a message)

const SCHOOL_MEMO = 'onecard-lab-office-school';
function rememberSchool(name) {
  try {
    sessionStorage.setItem(SCHOOL_MEMO, name);
  } catch {
    // storage blocked: the suspended page then says "your school"
  }
}
function rememberedSchool() {
  try {
    return sessionStorage.getItem(SCHOOL_MEMO);
  } catch {
    return null;
  }
}

const watch = createConnectionWatch({
  t,
  host: els.conn,
  probe: () => get('/api/admin/me'),
  onRestored: () => {
    if (screen === 'app') {
      route();
      refreshBadges();
    } else boot();
  },
});

const api = createApi((err) => {
  if (watch.report(err)) return true;
  if (err.code === 'NOT_SIGNED_IN' && session) {
    showSignIn(() => t('signin.ended'));
    return true;
  }
  if (err.code === 'SCHOOL_SUSPENDED') {
    showSuspended();
    return true;
  }
  return false;
});

// ---- screens ------------------------------------------------------------------------------

function stopView() {
  view.token += 1;
  for (const stop of view.stops.splice(0)) stop();
  closeAllDialogs();
}

function stopLoops() {
  stopBadgeLoop?.();
  stopBadgeLoop = null;
  stopSuspendedLoop?.();
  stopSuspendedLoop = null;
}

function leaveApp() {
  stopView();
  stopLoops();
  els.band.hidden = true;
  els.nav.hidden = true;
  document.body.classList.remove('is-signed-in');
}

async function boot() {
  try {
    const me = await api.get('/api/admin/me');
    startSession(me);
  } catch (err) {
    if (err.code === 'NOT_SIGNED_IN') return showSignIn();
    if (err.handled) {
      if (watch.down) showWaiting();
      return;
    }
    showSignIn(() => errorMessage(t, err));
  }
}

function showWaiting() {
  leaveApp();
  screen = 'waiting';
  els.main.replaceChildren(h('p', { class: 'muted boot-note' }, t('app.waiting')));
}

/** @param {(() => string)} [message] a note above the list (a function, so it follows the language) */
async function showSignIn(message) {
  leaveApp();
  session = null;
  screen = 'signin';
  lastSignInMessage = message ?? null;
  document.title = `${t('signin.title')} · OneCard Lab`;
  const status = h('div', { class: 'signin__status', role: 'status' }, message ? h('p', { class: 'notice notice--warn' }, message()) : null);
  const list = h('div', { class: 'signin__schools' }, h('p', { class: 'muted' }, t('kit.loading')));
  els.main.replaceChildren(
    h(
      'section',
      { class: 'signin' },
      h('h1', { class: 'signin__title' }, t('signin.title')),
      h('p', { class: 'signin__lede' }, t('signin.lede')),
      h('p', { class: 'muted' }, t('signin.tenants')),
      status,
      list,
    ),
  );
  let options;
  try {
    options = await api.get('/api/admin/staff-options');
  } catch (err) {
    if (screen === 'signin') list.replaceChildren(loadProblem(t, err, () => showSignIn(message)));
    return;
  }
  if (screen !== 'signin') return;
  const schools = new Map();
  for (const s of options) {
    if (!schools.has(s.schoolId)) schools.set(s.schoolId, { name: s.schoolName, code: s.schoolCode, status: s.schoolStatus, staff: [] });
    schools.get(s.schoolId).staff.push(s);
  }
  if (schools.size === 0) {
    list.replaceChildren(h('p', { class: 'muted' }, t('signin.none')));
    return;
  }
  list.replaceChildren(
    ...[...schools.values()].map((school) =>
      h(
        'section',
        { class: 'panel signin__school', 'aria-label': school.name },
        h(
          'div',
          { class: 'signin__schoolhead' },
          h('h2', {}, school.name),
          h('code', { class: 'chip' }, school.code),
          school.status === 'ACTIVE' ? null : pill(t('school.SUSPENDED'), 'bad'),
        ),
        h(
          'div',
          { class: 'signin__staff' },
          school.staff.map((s) =>
            h(
              'button',
              { type: 'button', class: 'person', onclick: (e) => signIn(s, status, e.currentTarget) },
              h('span', { class: 'person__name' }, s.name),
              h('span', { class: 'person__role' }, pill(t(`role.${s.role}`), 'info'), h('span', { class: 'muted' }, t(`roleText.${s.role}`))),
            ),
          ),
        ),
      ),
    ),
  );
}

async function signIn(person, status, button) {
  button.disabled = true;
  try {
    // not through the api hook: a suspended school is explained here, on the sign-in page
    const out = await post('/api/admin/login', { staffId: person.id });
    history.replaceState(null, '', '#/overview');
    startSession(out);
  } catch (err) {
    button.disabled = false;
    if (watch.report(err)) return;
    const text = err.code === 'SCHOOL_SUSPENDED' ? t('signin.suspended', { school: person.schoolName }) : errorMessage(t, err);
    status.replaceChildren(h('p', { class: 'notice notice--bad' }, text));
  }
}

function fillBand() {
  const { staff, school } = session;
  els.schoolName.textContent = school.name;
  els.schoolCode.textContent = school.code;
  els.staffName.textContent = staff.name;
  els.staffRole.textContent = t(`role.${staff.role}`);
  els.staffRoleText.textContent = t(`roleText.${staff.role}`);
}

function startSession(me) {
  stopLoops();
  session = { staff: me.staff, school: me.school };
  rememberSchool(me.school.name);
  screen = 'app';
  fillBand();
  els.band.hidden = false;
  document.body.classList.add('is-signed-in');
  buildNav();
  if (!location.hash.startsWith('#/')) history.replaceState(null, '', '#/overview');
  route();
  refreshBadges();
  stopBadgeLoop = every(15000, refreshBadges);
}

function showSuspended(rerender = false) {
  if (screen === 'suspended' && !rerender) return;
  leaveApp();
  screen = 'suspended';
  const name = session?.school?.name ?? rememberedSchool();
  document.title = `${t('susp.short')} · OneCard Lab`;
  const status = h('p', { class: 'muted', role: 'status' });
  const check = async () => {
    try {
      const me = await get('/api/admin/me');
      startSession(me);
    } catch (err) {
      if (watch.report(err)) return;
      if (err.code === 'NOT_SIGNED_IN') showSignIn();
      else if (err.code === 'SCHOOL_SUSPENDED') status.textContent = t('susp.still');
      else status.textContent = errorMessage(t, err);
    }
  };
  els.main.replaceChildren(
    h(
      'section',
      { class: 'suspended panel' },
      h('h1', {}, name ? t('susp.title', { school: name }) : t('susp.titleUnknown')),
      h('p', {}, t('susp.text')),
      h('p', {}, t('susp.ask')),
      h('p', { class: 'muted' }, t('susp.lab'), ' ', h('a', { href: '/operator/' }, t('susp.operatorLink'))),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--primary', onclick: check }, t('susp.check')),
        h('button', { type: 'button', class: 'btn', onclick: signOut }, t('app.signOut')),
      ),
      status,
    ),
  );
  stopSuspendedLoop = every(5000, check);
}

async function signOut() {
  try {
    await post('/api/admin/logout');
  } catch (err) {
    watch.report(err); // the page still signs out; the old cookie is replaced at the next sign-in
  }
  history.replaceState(null, '', '#/overview');
  showSignIn();
}
els.signout.addEventListener('click', signOut);

// ---- menu and routes ------------------------------------------------------------------------

function buildNav() {
  const role = session.staff.role;
  els.nav.replaceChildren(
    h(
      'ul',
      { class: 'nav__list' },
      SECTIONS.filter((s) => s.roles.includes(role)).map((s) =>
        h(
          'li',
          {},
          h(
            'a',
            { href: `#/${s.id}`, class: 'nav__item', dataset: { id: s.id } },
            h('span', { class: 'nav__label' }, t(`nav.${s.id}`)),
            h('span', { class: 'nav__badge', hidden: true }),
          ),
        ),
      ),
    ),
  );
  els.nav.hidden = false;
}

function setBadge(id, count, tone) {
  const badge = els.nav.querySelector(`[data-id="${id}"] .nav__badge`);
  if (!badge) return;
  badge.hidden = !(count > 0);
  badge.className = `nav__badge nav__badge--${tone}`;
  badge.replaceChildren(h('span', { 'aria-hidden': 'true' }, String(count)), h('span', { class: 'sr-only' }, t(`badge.${id}`, { n: count })));
}

async function refreshBadges() {
  if (screen !== 'app') return;
  const role = session.staff.role;
  try {
    const ov = await api.get('/api/admin/overview');
    if (screen !== 'app') return;
    setBadge('reconciliation', ABILITIES.differences.includes(role) ? ov.openDifferences : 0, 'warn');
    setBadge('topups', ABILITIES.topups.includes(role) ? ov.parkedOrders : 0, 'warn');
    if (ABILITIES.parents.includes(role)) {
      const pending = await api.get('/api/admin/links?status=PENDING');
      if (screen === 'app') setBadge('parents', pending.length, 'info');
    }
  } catch {
    // outages and sign-outs are shown by the api hook; the badges simply keep their numbers
  }
}

function parseHash() {
  const parts = location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return '';
      }
    });
  return { name: parts[0] || 'overview', param: parts[1] || null };
}

function resolveRoute({ name, param }) {
  if (name === 'students' && param) return { nav: 'students', title: 'nav.students', roles: ANY, render: (ctx, el) => renderMember(ctx, el, param) };
  if (name === 'cards') return { nav: 'students', title: 'nav.cards', roles: OFFICE, render: renderCards };
  const section = SECTIONS.find((s) => s.id === name);
  return section ? { nav: section.id, title: `nav.${section.id}`, roles: section.roles, render: section.render } : null;
}

function makeCtx(token, el) {
  const alive = () => token === view.token && screen === 'app';
  return {
    t,
    api,
    school: session.school,
    staff: session.staff,
    role: session.staff.role,
    get lang() {
      return i18n.lang;
    },
    can: (ability) => ABILITIES[ability].includes(session.staff.role),
    alive,
    /** Refresh while this view is open (not while a dialog is open); stopped when the person leaves it. */
    poll(ms, fn) {
      view.stops.push(
        every(ms, async () => {
          if (alive() && !dialogOpen()) await fn();
        }),
      );
    },
    /** Open another view; `flash` ({ content, tone }) is shown at its top. */
    go: (hash, flash) => {
      pendingFlash = flash ?? null;
      if (location.hash === hash) route(true);
      else location.hash = hash;
    },
    rerender: () => route(),
    refreshBadges,
    /** A result that stays at the top of the view until closed (role=status reads it out). */
    flash(content, tone = 'good') {
      if (!alive()) return null;
      let box = el.querySelector(':scope > .flashes');
      if (!box) {
        box = h('div', { class: 'flashes' });
        const head = el.querySelector(':scope > .section-head');
        if (head) head.after(box);
        else el.prepend(box);
      }
      const note = h(
        'div',
        { class: `notice notice--${tone} flash`, role: 'status' },
        h('div', { class: 'flash__body' }, content),
        h('button', { type: 'button', class: 'btn btn--small btn--ghost flash__close', onclick: () => note.remove() }, t('kit.close')),
      );
      box.prepend(note);
      return note;
    },
  };
}

async function route(userNav = false) {
  if (screen !== 'app') return;
  const target = resolveRoute(parseHash());
  if (!target || !target.roles.includes(session.staff.role)) {
    history.replaceState(null, '', '#/overview');
    return route(userNav);
  }
  stopView();
  const token = view.token;
  for (const a of els.nav.querySelectorAll('.nav__item')) {
    if (a.dataset.id === target.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${t(target.title)} · ${session.school.name} · ${t('app.name')}`;
  const el = h('div', { class: 'view' });
  els.main.replaceChildren(el);
  const ctx = makeCtx(token, el);
  const pending = target.render(ctx, el);
  // every view puts its heading in place before its first request, so focus can move now
  if (pendingFlash) {
    ctx.flash(pendingFlash.content, pendingFlash.tone ?? 'good');
    pendingFlash = null;
  }
  if (userNav) el.querySelector('.view-title')?.focus();
  try {
    await pending;
  } catch (err) {
    if (token === view.token && !err?.handled) el.append(loadProblem(t, err, () => route()));
  }
}

window.addEventListener('hashchange', () => route(true));

// ---- language -----------------------------------------------------------------------------

document.getElementById('lang').append(i18n.switcher());
i18n.onChange(() => {
  watch.render();
  if (screen === 'app') {
    fillBand();
    buildNav();
    route();
    refreshBadges();
  } else if (screen === 'signin') showSignIn(lastSignInMessage);
  else if (screen === 'suspended') showSuspended(true);
  else if (screen === 'waiting') showWaiting();
});
i18n.apply();
boot();
