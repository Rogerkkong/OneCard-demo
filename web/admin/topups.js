// Top-ups: money parents paid online and subsidies the school grants. It waits on the platform
// until the card is tapped at the top-up kiosk. Parked orders (the kiosk began writing but never
// confirmed) need a person to decide: on the card, or refund.

import { h, formatRM, formatKL } from '/shared/api.js';
import { sectionHead, panel, loadProblem, openDialog } from './kit.js';
import { ordersTable } from './tables.js';
import { parseMoney } from './cards.js';

const STATUSES = ['PAID', 'PARKED', 'ADDED', 'CREATED', 'REFUNDED', 'CANCELLED', 'FAILED', 'EXPIRED'];
const KINDS = ['TOPUP', 'SUBSIDY', 'TRANSFER'];

export async function renderTopups(ctx, el) {
  const { t, api } = ctx;
  el.append(
    sectionHead({
      title: t('nav.topups'),
      text: t('tu.lede'),
      actions: [
        h('button', { type: 'button', class: 'btn btn--accent', onclick: () => subsidy() }, t('tu.subsidy')),
        h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh')),
      ],
    }),
  );
  const parkedBox = h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('kit.loading')));
  const statusSel = h('select', { id: 'tu-status' }, h('option', { value: '' }, t('tu.allStatuses')), STATUSES.map((s) => h('option', { value: s }, t(`orderStatus.${s}`))));
  const kindSel = h('select', { id: 'tu-kind' }, h('option', { value: '' }, t('tu.allKinds')), KINDS.map((k) => h('option', { value: k }, t(`orderKind.${k}`))));
  const listBox = h('div');
  statusSel.addEventListener('change', () => loadList());
  kindSel.addEventListener('change', () => loadList());
  el.append(
    panel(t('tu.parked'), h('p', { class: 'muted small' }, t('tu.parkedText')), parkedBox),
    panel(
      t('tu.all'),
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'field' }, h('label', { for: 'tu-status' }, t('tu.status')), statusSel),
        h('div', { class: 'field' }, h('label', { for: 'tu-kind' }, t('tu.kind')), kindSel),
      ),
      listBox,
    ),
  );

  let parkedLoaded = false;

  async function resolve(o, decision) {
    const added = decision === 'ADDED';
    const vars = { amount: formatRM(o.amountSen), name: o.memberName ?? '—' };
    const out = await openDialog({
      t,
      title: t(added ? 'tu.addedTitle' : 'tu.refundTitle', vars),
      body: h('p', {}, t(added ? 'tu.addedBody' : 'tu.refundBody', vars)),
      fields: [{ name: 'note', label: t('tu.note'), type: 'textarea', required: true, maxLength: 500, placeholder: t(added ? 'tu.notePhAdded' : 'tu.notePhRefund') }],
      confirmLabel: t(added ? 'tu.markAdded' : 'tu.refund'),
      tone: added ? 'primary' : 'danger',
      action: (v) => api.post(`/api/admin/topups/${encodeURIComponent(o.id)}/resolve`, { decision, note: v.note }),
    });
    if (!out) return;
    ctx.flash(h('strong', {}, t(added ? 'tu.addedDone' : 'tu.refundDone', vars)), added ? 'good' : 'info');
    ctx.refreshBadges();
    load();
  }

  async function subsidy() {
    let members;
    try {
      members = await api.get('/api/admin/members');
    } catch (err) {
      if (!err.handled) ctx.flash(loadProblem(t, err), 'bad');
      return;
    }
    const options = [{ value: '', label: t('tu.pickMember') }].concat(
      members
        .filter((m) => m.status === 'ACTIVE')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => ({ value: m.id, label: `${m.name} (${m.memberNo}) · ${formatRM(m.mirrorBalanceSen)}` })),
    );
    let chosen = null;
    const order = await openDialog({
      t,
      title: t('tu.subsidyTitle'),
      body: h('p', {}, t('sub.body')),
      fields: [
        { name: 'memberId', label: t('tu.member'), type: 'select', required: true, options },
        { name: 'amount', label: t('sub.amount'), type: 'money', required: true, placeholder: '10.00' },
        { name: 'note', label: t('sub.note'), type: 'textarea', maxLength: 500, placeholder: t('sub.notePlaceholder') },
      ],
      parseMoney,
      confirmLabel: t('sub.confirm'),
      tone: 'accent',
      action: (v) => {
        chosen = members.find((m) => m.id === v.memberId);
        return api.post('/api/admin/subsidies', { memberId: v.memberId, amountSen: v.amount, note: v.note });
      },
    });
    if (!order) return;
    ctx.flash(h('strong', {}, t('sub.done', { amount: formatRM(order.amountSen), name: chosen?.name ?? order.memberName ?? '—', at: formatKL(order.addBy) })));
    load();
  }

  function drawParked(parked) {
    if (!parked.length) {
      ctx.swap(parkedBox, h('p', { class: 'empty-note' }, t('tu.noParked')));
      return;
    }
    ctx.swap(
      parkedBox,
      ...parked.map((o) =>
        h(
          'article',
          { class: 'parked' },
          h(
            'div',
            { class: 'parked__main' },
            h('p', { class: 'parked__amount num' }, formatRM(o.amountSen)),
            h('p', {}, h('a', { href: `#/students/${encodeURIComponent(o.memberId)}`, class: 'strong-link' }, o.memberName ?? '—'), ' · ', t(`orderKind.${o.kind}`)),
            h(
              'p',
              { class: 'muted small' },
              t('tu.parkedFacts', { paid: formatKL(o.paidAt), tried: formatKL(o.writeAttemptAt), by: formatKL(o.addBy) }),
            ),
            h('p', { class: 'mono muted small' }, o.id),
          ),
          h(
            'div',
            { class: 'parked__actions' },
            h('button', { type: 'button', class: 'btn btn--primary', onclick: () => resolve(o, 'ADDED') }, t('tu.onCard')),
            h('button', { type: 'button', class: 'btn btn--danger', onclick: () => resolve(o, 'REFUND') }, t('tu.notOnCard')),
          ),
        ),
      ),
    );
  }

  async function loadList() {
    const q = new URLSearchParams({ limit: '200' });
    if (statusSel.value) q.set('status', statusSel.value);
    if (kindSel.value) q.set('kind', kindSel.value);
    let orders;
    try {
      orders = await api.get(`/api/admin/topups?${q}`);
    } catch (err) {
      if (ctx.alive() && !listBox.querySelector('table')) listBox.replaceChildren(loadProblem(t, err, loadList));
      return;
    }
    if (ctx.alive()) ctx.swap(listBox, ordersTable(ctx, orders, { label: t('tu.all') }));
  }

  async function load() {
    let parked;
    try {
      parked = await api.get('/api/admin/topups/parked');
    } catch (err) {
      if (ctx.alive() && !parkedLoaded) parkedBox.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    parkedLoaded = true;
    drawParked(parked);
    await loadList();
  }

  ctx.poll(15000, load);
  await load();
}
