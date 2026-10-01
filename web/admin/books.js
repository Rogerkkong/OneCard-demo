// Books: the school's double-entry books on the platform — the trial balance (balanced or not,
// said plainly), the latest postings in words, purchases, and sales by day.

import { h, formatRM, formatKL } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, pill, formatDay } from './kit.js';
import { purchasesTable } from './tables.js';

const ACCOUNT_ORDER = ['CASH_RECEIVED', 'STUDENT_WALLET', 'WAITING_TO_BE_ADDED', 'SCHOOL_SUBSIDY', 'SALES_PAYABLE'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function renderBooks(ctx, el) {
  const { t, api } = ctx;
  el.append(sectionHead({ title: t('nav.books'), text: t('bk.lede'), actions: [h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh'))] }));
  const tbBox = h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('kit.loading')));
  const postLimit = h('select', { id: 'bk-limit' }, ['20', '50', '200'].map((n) => h('option', { value: n, selected: n === '50' }, n)));
  const postBox = h('div');
  const machineSel = h('select', { id: 'bk-machine' }, h('option', { value: '' }, t('bk.allMachines')));
  const purBox = h('div');
  const dayInput = h('input', { id: 'bk-day', type: 'date' });
  const salesBox = h('div', { class: 'stack' });
  const salesForm = h(
    'form',
    { class: 'toolbar', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'bk-day' }, t('bk.day')), dayInput),
    h('button', { type: 'submit', class: 'btn' }, t('bk.show')),
  );
  salesForm.addEventListener('submit', (e) => {
    e.preventDefault();
    loadSales(dayInput.value);
  });
  postLimit.addEventListener('change', () => loadPostings());
  machineSel.addEventListener('change', () => loadPurchases());
  el.append(
    panel(t('bk.tb'), tbBox),
    panel(t('bk.sales'), salesForm, salesBox),
    panel(t('bk.postings'), h('p', { class: 'muted small' }, t('bk.postingsText')), h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'bk-limit' }, t('bk.show')), postLimit)), postBox),
    panel(t('bk.purchases'), h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'bk-machine' }, t('bk.machine')), machineSel)), purBox),
  );

  let names = new Map(); // memberId -> name, from the trial balance
  let loaded = false;
  const machines = new Set();

  const accountName = (kind, memberId) => `${t(`acct.${kind}`)}${memberId ? ` · ${names.get(memberId) ?? memberId}` : ''}`;

  function drawTrialBalance(tb) {
    names = new Map(tb.accounts.filter((a) => a.memberId).map((a) => [a.memberId, a.memberName]));
    const { debitSen, creditSen } = tb.totals;
    const verdict = tb.balanced
      ? h('div', { class: 'verdict verdict--good', role: 'status' }, h('strong', {}, t('bk.balanced')), h('span', {}, t('bk.balancedText', { amount: formatRM(debitSen) })))
      : h(
          'div',
          { class: 'verdict verdict--bad', role: 'status' },
          h('strong', {}, t('bk.notBalanced')),
          h('span', {}, t('bk.notBalancedText', { debit: formatRM(debitSen), credit: formatRM(creditSen), diff: formatRM(Math.abs(debitSen - creditSen)) })),
        );
    const byKind = new Map();
    for (const a of tb.accounts) {
      const k = byKind.get(a.kind) ?? { debitSen: 0, creditSen: 0, balanceSen: 0, members: 0 };
      k.debitSen += a.debitSen;
      k.creditSen += a.creditSen;
      k.balanceSen += a.balanceSen;
      if (a.memberId) k.members += 1;
      byKind.set(a.kind, k);
    }
    const kinds = [...byKind.keys()].sort((a, b) => ACCOUNT_ORDER.indexOf(a) - ACCOUNT_ORDER.indexOf(b));
    const head = [t('bk.account'), { label: t('bk.debit'), num: true }, { label: t('bk.credit'), num: true }, { label: t('bk.balance'), num: true }];
    const summary = dataTable({
      label: t('bk.tb'),
      head,
      rows: kinds
        .map((k) => {
          const v = byKind.get(k);
          return [
            h('span', { class: 'who' }, h('strong', {}, t(`acct.${k}`)), h('span', { class: 'muted small' }, t(`acctText.${k}`), v.members ? ` · ${t('bk.members', { n: v.members })}` : '')),
            formatRM(v.debitSen),
            formatRM(v.creditSen),
            formatRM(v.balanceSen),
          ];
        })
        .concat([[h('strong', {}, t('bk.totals')), h('strong', {}, formatRM(debitSen)), h('strong', {}, formatRM(creditSen)), tb.balanced ? pill(t('bk.equal'), 'good') : pill(t('bk.unequal'), 'bad')]]),
    });
    const perMember = tb.accounts.filter((a) => a.memberId);
    const details = h(
      'details',
      { class: 'details' },
      h('summary', {}, t('bk.perMember', { n: perMember.length })),
      dataTable({
        label: t('bk.perMemberLabel'),
        head: [t('bk.member'), t('bk.account'), { label: t('bk.debit'), num: true }, { label: t('bk.credit'), num: true }, { label: t('bk.balance'), num: true }],
        compact: true,
        rows: perMember
          .slice()
          .sort((a, b) => (a.memberName ?? '').localeCompare(b.memberName ?? '') || ACCOUNT_ORDER.indexOf(a.kind) - ACCOUNT_ORDER.indexOf(b.kind))
          .map((a) => [h('a', { href: `#/students/${encodeURIComponent(a.memberId)}` }, a.memberName ?? a.memberId), t(`acct.${a.kind}`), formatRM(a.debitSen), formatRM(a.creditSen), formatRM(a.balanceSen)]),
      }),
    );
    tbBox.replaceChildren(verdict, summary, details);
  }

  async function loadPostings() {
    let postings;
    try {
      postings = await api.get(`/api/admin/ledger/postings?limit=${postLimit.value}`);
    } catch (err) {
      if (ctx.alive() && !postBox.querySelector('table')) postBox.replaceChildren(loadProblem(t, err, loadPostings));
      return;
    }
    if (!ctx.alive()) return;
    postBox.replaceChildren(
      dataTable({
        label: t('bk.postings'),
        head: [t('bk.at'), t('bk.what'), t('bk.lines'), t('bk.memo')],
        empty: t('bk.noPostings'),
        rows: postings.map((p) => [
          formatKL(p.createdAt),
          h('span', { class: 'who' }, h('strong', {}, t(`posting.${p.kind}`)), p.reversalOf ? h('span', { class: 'muted small' }, t('bk.reverses')) : null),
          h(
            'ul',
            { class: 'lines' },
            p.lines.map((l) =>
              h(
                'li',
                { class: `line line--${l.side === 'DR' ? 'dr' : 'cr'}` },
                h('span', { class: 'line__side' }, t(l.side === 'DR' ? 'bk.dr' : 'bk.cr')),
                h('span', { class: 'line__acct' }, accountName(l.kind, l.memberId)),
                h('span', { class: 'line__amt num' }, formatRM(l.amountSen)),
              ),
            ),
          ),
          h('span', { class: 'small' }, p.memo ?? '—'),
        ]),
      }),
    );
  }

  async function loadPurchases() {
    const code = machineSel.value;
    let list;
    try {
      list = await api.get(`/api/admin/purchases?limit=100${code ? `&device=${encodeURIComponent(code)}` : ''}`);
    } catch (err) {
      if (ctx.alive() && !purBox.querySelector('table')) purBox.replaceChildren(loadProblem(t, err, loadPurchases));
      return;
    }
    if (!ctx.alive()) return;
    let added = false;
    for (const p of list) {
      if (!machines.has(p.originDeviceCode)) {
        machines.add(p.originDeviceCode);
        added = true;
      }
    }
    if (added) {
      machineSel.replaceChildren(h('option', { value: '' }, t('bk.allMachines')), ...[...machines].sort().map((m) => h('option', { value: m, selected: m === code }, m)));
    }
    purBox.replaceChildren(purchasesTable(ctx, list, { label: t('bk.purchases') }));
  }

  async function loadSales(day) {
    let report;
    try {
      report = await api.get(`/api/admin/reports/sales${day && DAY_RE.test(day) ? `?day=${day}` : ''}`);
    } catch (err) {
      if (ctx.alive()) salesBox.replaceChildren(loadProblem(t, err, () => loadSales(day)));
      return;
    }
    if (!ctx.alive()) return;
    if (!dayInput.value) dayInput.value = report.day;
    salesBox.replaceChildren(
      h('p', { class: 'sales-total' }, h('span', { class: 'muted' }, t('bk.salesOn', { day: formatDay(report.day) })), ' ', h('strong', { class: 'num' }, formatRM(report.totalSen)), ' ', h('span', { class: 'muted' }, t('bk.fromPurchases', { n: report.count }))),
      h(
        'div',
        { class: 'two-col' },
        dataTable({
          label: t('bk.byMachine'),
          head: [t('bk.machine'), t('bk.kind'), { label: t('bk.count'), num: true }, { label: t('bk.total'), num: true }],
          empty: t('bk.noSales'),
          compact: true,
          rows: report.byDevice.map((d) => [h('span', { class: 'mono' }, d.deviceCode), t(`saleKind.${d.kind}`), d.count, formatRM(d.totalSen)]),
        }),
        dataTable({
          label: t('bk.byItem'),
          head: [t('bk.item'), { label: t('bk.qty'), num: true }, { label: t('bk.total'), num: true }],
          empty: t('bk.noSales'),
          compact: true,
          rows: report.byItem.map((i) => [h('span', { class: 'mono' }, i.code), i.qty, formatRM(i.totalSen)]),
        }),
      ),
    );
  }

  async function load() {
    let tb;
    try {
      tb = await api.get('/api/admin/ledger/trial-balance');
    } catch (err) {
      if (ctx.alive() && !loaded) tbBox.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    loaded = true;
    drawTrialBalance(tb);
    await Promise.all([loadPostings(), loadPurchases(), loadSales(dayInput.value)]);
  }

  await load();
}
