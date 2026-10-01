// Audit log (admins only): who did what in this school, newest first.

import { h, formatKL } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, has } from './kit.js';
import { detailInline, actorLabel } from './pretty.js';

export async function renderAudit(ctx, el) {
  const { t, api } = ctx;
  const limit = h('select', { id: 'au-limit' }, ['100', '500'].map((n) => h('option', { value: n }, n)));
  el.append(sectionHead({ title: t('nav.audit'), text: t('au.lede'), actions: [h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh'))] }));
  const box = h('div', {}, h('p', { class: 'muted' }, t('kit.loading')));
  limit.addEventListener('change', () => load());
  el.append(panel(null, h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'au-limit' }, t('au.limit')), limit)), box));

  let names = null; // member id -> name, so the log shows people instead of ids

  async function load() {
    let entries;
    try {
      const [list, members] = await Promise.all([api.get(`/api/admin/audit?limit=${limit.value}`), names ? null : api.get('/api/admin/members')]);
      entries = list;
      if (members) names = new Map(members.map((m) => [m.id, m.name]));
    } catch (err) {
      if (ctx.alive() && !box.querySelector('table')) box.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    box.replaceChildren(
      dataTable({
        label: t('nav.audit'),
        head: [t('au.at'), t('au.who'), t('au.what'), t('au.detail')],
        empty: t('au.empty'),
        rows: entries.map((a) => [
          formatKL(a.at),
          h('span', { class: 'small' }, actorLabel(t, a.actor)),
          h('span', { class: 'who' }, h('strong', {}, has(t, `auditAction.${a.action}`) ? t(`auditAction.${a.action}`) : a.action), h('code', { class: 'muted small' }, a.action)),
          h('span', { class: 'small audit-detail' }, detailInline(ctx, a.detail, names)),
        ]),
      }),
    );
  }

  await load();
}
