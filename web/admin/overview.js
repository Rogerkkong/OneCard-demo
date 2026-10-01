// Overview: today's numbers for this school, each tile leading to the section that deals with it
// (when the staff member's role may open that section).

import { h, formatRM } from '/shared/api.js';
import { sectionHead, tile, loadProblem, formatDay, panel } from './kit.js';

export async function renderOverview(ctx, el) {
  const { t, api, can } = ctx;
  const refreshBtn = h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh'));
  el.append(sectionHead({ title: t('nav.overview'), text: t('ov.lede', { school: ctx.school.name }), actions: [refreshBtn] }));
  const tiles = h('div', { class: 'tiles' }, h('p', { class: 'muted' }, t('kit.loading')));
  const day = h('p', { class: 'muted ov-day' });
  el.append(day, tiles, tasksPanel(ctx), tenantNote(ctx));

  async function load() {
    let ov;
    let pending = null;
    try {
      [ov, pending] = await Promise.all([api.get('/api/admin/overview'), can('parents') ? api.get('/api/admin/links?status=PENDING') : null]);
    } catch (err) {
      // keep numbers already on screen (the banner explains an outage); show the problem otherwise
      if (ctx.alive() && !tiles.querySelector('.tile')) tiles.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    day.textContent = t('ov.today', { day: formatDay(ov.today.day) });
    const offline = ov.devices.total - ov.devices.online;
    const list = [
      tile({
        label: t('ov.sales'),
        value: formatRM(ov.today.salesSen),
        sub: t('ov.salesSub', { n: ov.today.purchases }),
        href: can('books') ? '#/books' : null,
      }),
      tile({
        label: t('ov.machines'),
        value: t('ov.machinesValue', { online: ov.devices.online, total: ov.devices.total }),
        sub: offline > 0 ? t('ov.machinesOff', { n: offline }) : t('ov.machinesAll'),
        href: can('machines') ? '#/machines' : null,
        tone: offline > 0 ? 'info' : 'good',
      }),
      tile({
        label: t('ov.waiting'),
        value: formatRM(ov.waitingSen),
        sub: t('ov.waitingSub'),
        href: can('topups') ? '#/topups' : null,
      }),
      tile({
        label: t('ov.differences'),
        value: String(ov.openDifferences),
        sub: ov.openDifferences > 0 ? (can('differences') ? t('ov.differencesSub') : t('ov.differencesFinance')) : t('ov.differencesNone'),
        href: can('differences') ? '#/reconciliation' : null,
        tone: ov.openDifferences > 0 ? 'warn' : '',
      }),
      tile({
        label: t('ov.parked'),
        value: String(ov.parkedOrders),
        sub: ov.parkedOrders > 0 ? (can('topups') ? t('ov.parkedSub') : t('ov.parkedFinance')) : t('ov.parkedNone'),
        href: can('topups') ? '#/topups' : null,
        tone: ov.parkedOrders > 0 ? 'warn' : '',
      }),
    ];
    if (pending) {
      list.push(
        tile({
          label: t('ov.links'),
          value: String(pending.length),
          sub: pending.length > 0 ? t('ov.linksSub') : t('ov.linksNone'),
          href: '#/parents',
          tone: pending.length > 0 ? 'info' : '',
        }),
      );
    }
    tiles.replaceChildren(...list);
  }

  ctx.poll(10000, load);
  await load();
}

/** Shortcuts to the everyday jobs of this role, in plain words. */
function tasksPanel(ctx) {
  const { t, can } = ctx;
  const tasks = [
    can('editMembers') && ['#/students', 'ov.task.lost'],
    can('parents') && ['#/parents', 'ov.task.links'],
    can('prices') && ['#/prices', 'ov.task.prices'],
    can('machines') && ['#/machines', 'ov.task.machines'],
    can('importJournal') && ['#/reconciliation', 'ov.task.usb'],
    can('topups') && ['#/topups', 'ov.task.parked'],
    can('subsidies') && ['#/topups', 'ov.task.subsidy'],
    can('books') && ['#/books', 'ov.task.books'],
    can('differences') && ['#/reconciliation', 'ov.task.differences'],
    can('audit') && ['#/audit', 'ov.task.audit'],
  ].filter(Boolean);
  return panel(t('ov.tasks'), h('ul', { class: 'tasks' }, tasks.map(([href, key]) => h('li', {}, h('a', { href }, t(key))))));
}

/** The SaaS idea, said once: this school is one tenant of a shared platform. */
function tenantNote(ctx) {
  const { t } = ctx;
  return h(
    'aside',
    { class: 'tenant-note' },
    h('h3', {}, t('ov.tenantTitle')),
    h('p', {}, t('ov.tenantText', { school: ctx.school.name, code: ctx.school.code })),
  );
}
