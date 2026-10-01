// Reconciliation: differences the platform found between the cards, the machines and the books,
// each explained in plain words and resolved by a person with a note; importing a machine's
// journal from a USB stick; and (admins) running the platform's checks now.

import { h, formatKL } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, openDialog, pill, has, errorMessage, errorDetails } from './kit.js';
import { detailList } from './pretty.js';

const MAX_FILE = 1024 * 1024;

export async function renderReconciliation(ctx, el) {
  const { t, can } = ctx;
  const lede = can('differences') && can('importJournal') ? 'rc.ledeAll' : can('differences') ? 'rc.ledeFinance' : 'rc.ledeOffice';
  el.append(sectionHead({ title: t('nav.reconciliation'), text: t(lede) }));
  const jobs = [];
  if (can('differences')) jobs.push(differencesPanel(ctx, el));
  if (can('importJournal')) el.append(importPanel(ctx));
  if (can('runJobs')) el.append(jobsPanel(ctx));
  if (!can('differences')) el.append(h('p', { class: 'muted small' }, t('rc.financeOnly')));
  await Promise.all(jobs);
}

// ---- differences --------------------------------------------------------------------------

function differenceCard(ctx, d, names, onResolve) {
  const { t, lang } = ctx;
  const title = d.explanation?.[lang] ?? d.explanation?.en ?? d.kind;
  const technical = ['stored', 'received'].filter((k) => d.detail?.[k] !== undefined);
  return h(
    'article',
    { class: `diff diff--${d.status === 'OPEN' ? 'open' : 'done'}` },
    h('div', { class: 'diff__head' }, h('h4', { class: 'diff__title' }, title), pill(t(`diffStatus.${d.status}`), d.status === 'OPEN' ? 'warn' : 'good')),
    h('p', { class: 'muted small diff__meta' }, h('code', {}, d.kind), ' · ', t('rc.found', { at: formatKL(d.createdAt) }), ' · ', h('span', { class: 'mono ref', title: d.ref }, d.ref)),
    detailList(ctx, d.detail, names, ['stored', 'received']),
    technical.length
      ? h('details', { class: 'details' }, h('summary', {}, t('rc.technical')), technical.map((k) => h('pre', { class: 'json' }, `${k}: ${JSON.stringify(d.detail[k], null, 2)}`)))
      : null,
    d.status === 'OPEN'
      ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn--primary btn--small', onclick: () => onResolve(d, title) }, t('rc.resolve')))
      : h('p', { class: 'resolved small' }, t('rc.resolvedBy', { at: formatKL(d.resolvedAt), by: d.resolvedBy ?? '—' }), d.note ? h('span', { class: 'note-quote' }, `“${d.note}”`) : null),
  );
}

async function differencesPanel(ctx, el) {
  const { t, api } = ctx;
  const filters = ['OPEN', 'RESOLVED', ''];
  let status = 'OPEN';
  let names = new Map();
  let loaded = false;
  const list = h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('kit.loading')));
  const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': t('rc.show') });
  const count = h('p', { class: 'muted small', role: 'status' });

  function drawTabs() {
    tabs.replaceChildren(
      ...filters.map((f) =>
        h(
          'button',
          {
            type: 'button',
            class: 'seg__btn',
            'aria-pressed': String(f === status),
            onclick: () => {
              status = f;
              drawTabs();
              load();
            },
          },
          t(`rc.filter.${f || 'ALL'}`),
        ),
      ),
    );
  }
  drawTabs();

  async function resolve(d, title) {
    const out = await openDialog({
      t,
      title: t('rc.resolveTitle'),
      body: [h('p', {}, h('strong', {}, title)), h('p', { class: 'muted small' }, t('rc.resolveBody'))],
      fields: [{ name: 'note', label: t('rc.note'), type: 'textarea', required: true, maxLength: 500, placeholder: t('rc.notePlaceholder') }],
      confirmLabel: t('rc.resolveConfirm'),
      action: (v) => api.post(`/api/admin/differences/${encodeURIComponent(d.id)}/resolve`, { note: v.note }),
    });
    if (!out) return;
    ctx.flash(h('strong', {}, t('rc.resolvedDone', { what: title })));
    ctx.refreshBadges();
    load();
  }

  async function load() {
    let diffs;
    try {
      const [found, members] = await Promise.all([api.get(`/api/admin/differences${status ? `?status=${status}` : ''}`), loaded ? null : api.get('/api/admin/members')]);
      diffs = found;
      if (members) names = new Map(members.map((m) => [m.id, m.name]));
    } catch (err) {
      if (ctx.alive() && !loaded) list.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    loaded = true;
    count.textContent = t(`rc.count.${status || 'ALL'}`, { n: diffs.length });
    ctx.swap(list, ...(diffs.length ? diffs.map((d) => differenceCard(ctx, d, names, resolve)) : [h('p', { class: 'empty-note' }, t(status === 'OPEN' ? 'rc.noneOpen' : 'rc.none'))]));
  }

  el.append(panel(t('rc.differences'), h('div', { class: 'toolbar toolbar--split' }, tabs, count), list));
  ctx.poll(15000, load);
  await load();
}

// ---- USB journal import --------------------------------------------------------------------

function importPanel(ctx) {
  const { t, api } = ctx;
  const input = h('input', { id: 'rc-file', type: 'file', accept: '.json,application/json' });
  const button = h('button', { type: 'submit', class: 'btn btn--primary' }, t('rc.import'));
  const status = h('div', { role: 'status', class: 'stack' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'rc-file' }, t('rc.file')), input, h('span', { class: 'field-hint' }, t('rc.fileHint'))),
    h('div', { class: 'row' }, button),
    status,
  );
  const say = (text, tone = 'bad') => status.replaceChildren(h('p', { class: `notice notice--${tone}` }, text));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = input.files?.[0];
    if (!file) return say(t('rc.pickFile'), 'warn');
    if (file.size > MAX_FILE) return say(t('rc.tooBig'));
    let body;
    try {
      body = JSON.parse(await file.text());
    } catch {
      return say(t('rc.notJson'));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return say(t('err.JOURNAL_INVALID'));
    button.disabled = true;
    button.textContent = t('kit.working');
    try {
      const out = await api.post('/api/admin/imports/journal', body);
      status.replaceChildren(importResult(ctx, out, file.name));
      input.value = '';
      ctx.refreshBadges();
    } catch (err) {
      const details = errorDetails(err);
      status.replaceChildren(h('div', { class: 'notice notice--bad' }, h('p', {}, errorMessage(t, err)), details.length ? h('ul', {}, details.map((d) => h('li', {}, d))) : null));
    } finally {
      button.disabled = false;
      button.textContent = t('rc.import');
    }
  });

  return panel(t('rc.importTitle'), h('p', { class: 'muted small' }, t('rc.importText')), form);
}

function importResult(ctx, out, fileName) {
  const { t } = ctx;
  const c = out.counts ?? {};
  const stat = (key, n, tone) => h('div', { class: `stat stat--small${tone && n > 0 ? ` stat--${tone}` : ''}` }, h('span', { class: 'stat__label' }, t(`rc.count${key}`)), h('span', { class: 'stat__value num' }, String(n ?? 0)));
  const diffKinds = Object.entries(out.differences ?? {});
  return h(
    'div',
    { class: 'import-result stack' },
    h('p', {}, h('strong', {}, t('rc.importedTitle', { device: out.device, n: out.total })), ' ', h('span', { class: 'muted' }, t('rc.importedFrom', { file: fileName, at: formatKL(out.exportedAt) }))),
    h('div', { class: 'stats' }, stat('POSTED', c.POSTED, 'good'), stat('FLAGGED', c.FLAGGED, 'warn'), stat('DUPLICATE', c.DUPLICATE, ''), stat('REFUSED', c.REFUSED, 'bad')),
    h('p', { class: 'muted small' }, t('rc.countsHelp')),
    out.conflicts > 0 ? h('p', { class: 'notice notice--warn' }, t('rc.conflicts', { n: out.conflicts })) : null,
    diffKinds.length
      ? h(
          'div',
          { class: 'notice notice--warn' },
          h('p', {}, h('strong', {}, t('rc.newDifferences'))),
          h('ul', {}, diffKinds.map(([kind, n]) => h('li', {}, `${has(t, `diffKind.${kind}`) ? t(`diffKind.${kind}`) : kind} × ${n}`))),
          ctx.can('differences') ? null : h('p', { class: 'small' }, t('rc.tellFinance')),
        )
      : null,
    out.refused?.length
      ? dataTable({
          label: t('rc.refusedTitle'),
          head: [{ label: '#', num: true }, t('rc.txn'), t('rc.reason')],
          compact: true,
          rows: out.refused.map((r) => [String(r.index + 1), h('span', { class: 'mono' }, r.txn ?? '—'), h('span', { class: 'who' }, h('code', {}, r.code ?? '—'), r.message ? h('span', { class: 'muted small' }, r.message) : null)]),
        })
      : null,
  );
}

// ---- checks (admins) -----------------------------------------------------------------------

function jobsPanel(ctx) {
  const { t, api } = ctx;
  const result = h('div', { role: 'status' });
  const button = h('button', { type: 'button', class: 'btn' }, t('rc.runJobs'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const out = await api.post('/api/admin/jobs/run');
      result.replaceChildren(
        h(
          'ul',
          { class: 'job-result' },
          ['cancelled', 'refunded', 'parked', 'gaps', 'lag'].map((k) => h('li', {}, h('strong', { class: 'num' }, String(out[k] ?? 0)), ' ', t(`rc.job.${k}`))),
        ),
      );
      ctx.refreshBadges();
    } catch (err) {
      result.replaceChildren(h('p', { class: 'notice notice--bad' }, errorMessage(t, err)));
    } finally {
      button.disabled = false;
    }
  });
  return panel(t('rc.jobsTitle'), h('p', { class: 'muted small' }, t('rc.jobsText')), h('div', { class: 'row' }, button), result);
}
