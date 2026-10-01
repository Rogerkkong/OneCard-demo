// Audit log (admins only): who did what in this school, newest first.

import { h, formatRM, formatKL } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, has, humanKey } from './kit.js';

/** A short "key: value" line for an audit entry's detail (ids stay as they are). */
function detailText(t, detail) {
  if (!detail || typeof detail !== 'object') return '—';
  const parts = Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const label = has(t, `dk.${k}`) ? t(`dk.${k}`) : humanKey(k);
      let value;
      if (typeof v === 'number' && /Sen$/.test(k)) value = formatRM(v);
      else if (typeof v === 'boolean') value = t(v ? 'kit.yes' : 'kit.no');
      else if (Array.isArray(v)) value = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
      else if (typeof v === 'object') value = Object.entries(v).map(([a, b]) => `${a} ${typeof b === 'object' ? JSON.stringify(b) : b}`).join(', ');
      else value = String(v);
      return `${label}: ${value}`;
    });
  return parts.length ? parts.join(' · ') : '—';
}

export async function renderAudit(ctx, el) {
  const { t, api } = ctx;
  const limit = h('select', { id: 'au-limit' }, ['100', '500'].map((n) => h('option', { value: n }, n)));
  el.append(sectionHead({ title: t('nav.audit'), text: t('au.lede'), actions: [h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh'))] }));
  const box = h('div', {}, h('p', { class: 'muted' }, t('kit.loading')));
  limit.addEventListener('change', () => load());
  el.append(panel(null, h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'au-limit' }, t('au.limit')), limit)), box));

  async function load() {
    let entries;
    try {
      entries = await api.get(`/api/admin/audit?limit=${limit.value}`);
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
          h('span', { class: 'small' }, a.actor),
          h('span', { class: 'who' }, h('strong', {}, has(t, `auditAction.${a.action}`) ? t(`auditAction.${a.action}`) : a.action), h('code', { class: 'muted small' }, a.action)),
          h('span', { class: 'small audit-detail' }, detailText(t, a.detail)),
        ]),
      }),
    );
  }

  await load();
}
