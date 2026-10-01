// One student's (or staff member's) page: the two balances side by side — never added together —
// their cards, parents, money waiting at the kiosk, top-ups and purchases, and the actions the
// staff member's role allows.

import { h, formatRM, formatKL } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, openDialog, pill, copyButton } from './kit.js';
import { cardName, cardPill, reportLost, markFound, replaceCard, issueCard, parseMoney } from './cards.js';
import { ordersTable, purchasesTable } from './tables.js';

const LINK_TONES = { PENDING: 'warn', APPROVED: 'good', REJECTED: '' };

export async function renderMember(ctx, el, memberId) {
  const { t, api, can } = ctx;
  el.append(h('a', { href: '#/students', class: 'back-link' }, t('mem.back')));
  const head = sectionHead({ title: t('mem.title'), actions: [h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh'))] });
  el.append(head);
  const body = h('div', { class: 'stack-lg' }, h('p', { class: 'muted' }, t('kit.loading')));
  el.append(body);

  async function load() {
    let data;
    try {
      data = await api.get(`/api/admin/members/${encodeURIComponent(memberId)}`);
    } catch (err) {
      if (!ctx.alive()) return;
      if (err.code === 'MEMBER_NOT_FOUND' || err.status === 404) {
        head.querySelector('.view-title').textContent = t('mem.notFoundTitle');
        body.replaceChildren(h('div', { class: 'notice notice--warn' }, h('p', {}, t('mem.notFound', { school: ctx.school.name }))));
      } else if (!body.querySelector('.balances')) body.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (ctx.alive()) draw(data);
  }

  function draw({ member, balances, waitingOrders, orders, purchases, cards, links }) {
    const title = head.querySelector('.view-title');
    title.textContent = member.name;
    document.title = `${member.name} · ${ctx.school.name} · ${t('app.name')}`;
    let meta = head.querySelector('.member-meta');
    if (!meta) {
      meta = h('p', { class: 'muted member-meta' });
      head.querySelector('.section-head__text').append(meta);
    }
    meta.replaceChildren(
      h('span', { class: 'mono' }, member.memberNo),
      ' · ',
      member.className || t('mem.noClass'),
      ' · ',
      t(`group.${member.group}`),
      member.status !== 'ACTIVE' ? [' · ', pill(t(`memberStatus.${member.status}`))] : null,
    );

    const active = cards.find((c) => c.status === 'ACTIVE') ?? null;
    const lost = cards.filter((c) => c.status === 'LOST');
    const reload = (result) => result && load();

    // ---- balances: two numbers, never one sum
    const money = h(
      'section',
      { class: 'panel balances', 'aria-label': t('mem.balances') },
      h(
        'div',
        { class: 'balances__pair' },
        h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, t('mem.platformBalance')), h('span', { class: 'stat__value num' }, formatRM(balances.mirrorBalanceSen)), h('span', { class: 'stat__sub' }, t('mem.platformSub'))),
        h(
          'div',
          { class: `stat stat--waiting${balances.waitingSen > 0 ? ' stat--hot' : ''}` },
          h('span', { class: 'stat__label' }, t('mem.waiting')),
          h('span', { class: 'stat__value num' }, formatRM(balances.waitingSen)),
          h('span', { class: 'stat__sub' }, t('mem.waitingSub')),
        ),
      ),
      h('p', { class: 'muted small' }, t('mem.neverAdded')),
      can('subsidies') ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn--accent', onclick: async () => reload(await grantSubsidy(ctx, member)) }, t('mem.subsidy'))) : null,
    );

    // ---- the card in use and what can be done with it
    const cardActions = [];
    if (can('cards')) {
      if (active) {
        cardActions.push(
          h('button', { type: 'button', class: 'btn btn--danger', onclick: async () => reload(await reportLost(ctx, { uid: active.uid, last4: active.last4, memberName: member.name })) }, t('card.lostButton')),
          h('button', { type: 'button', class: 'btn', onclick: async () => reload(await replaceCard(ctx, member, active, balances.mirrorBalanceSen)) }, t('card.replaceButton')),
        );
      } else {
        cardActions.push(h('button', { type: 'button', class: 'btn btn--primary', onclick: async () => reload(await issueCard(ctx, member)) }, t('card.issueButton')));
        if (lost.length) {
          cardActions.push(h('button', { type: 'button', class: 'btn', onclick: async () => reload(await replaceCard(ctx, member, null, balances.mirrorBalanceSen)) }, t('card.replaceButton')));
        }
      }
      for (const c of lost) {
        if (!active) {
          cardActions.push(
            h('button', { type: 'button', class: 'btn', onclick: async () => reload(await markFound(ctx, { uid: c.uid, last4: c.last4, memberName: member.name })) }, t('card.foundOne', { card: cardName(c.last4) })),
          );
        }
      }
    }
    const cardBox = h(
      'section',
      { class: 'panel stack card-panel' },
      h('h3', { class: 'panel__title' }, t('mem.card')),
      active
        ? h('div', { class: 'card-now' }, h('span', { class: 'card-now__id mono' }, cardName(active.last4)), cardPill(t, active.status), h('span', { class: 'mono muted small' }, active.uid))
        : h('p', {}, lost.length ? t('mem.onlyLost') : t('mem.noCard')),
      active ? h('p', { class: 'muted small' }, t('mem.issued', { at: formatKL(active.issuedAt) })) : null,
      cardActions.length ? h('div', { class: 'row' }, cardActions) : null,
      !can('cards') ? h('p', { class: 'muted small' }, t('mem.cardsByOffice')) : null,
    );

    // ---- parents linked to this child
    const parentRows = links.map((l) => [l.parentName, h('span', { class: 'small' }, l.parentEmail), pill(t(`linkStatus.${l.status}`), LINK_TONES[l.status] ?? ''), formatKL(l.createdAt)]);
    const parentsBox = panel(
      t('mem.parents'),
      dataTable({ label: t('mem.parents'), head: [t('par.parent'), t('par.email'), t('par.status'), t('par.requested')], rows: parentRows, empty: t('mem.noParents'), compact: true }),
      can('parents') ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => createInvite(ctx, member) }, t('mem.invite')), h('a', { href: '#/parents' }, t('mem.allParents'))) : null,
    );

    body.replaceChildren(
      h('div', { class: 'member-top' }, money, cardBox),
      panel(t('mem.waitingOrders'), h('p', { class: 'muted small' }, t('mem.waitingOrdersText')), ordersTable(ctx, waitingOrders, { showMember: false, label: t('mem.waitingOrders'), empty: t('mem.noWaiting') })),
      panel(t('mem.purchases'), purchasesTable(ctx, purchases, { showMember: false, label: t('mem.purchases') })),
      panel(t('mem.orders'), ordersTable(ctx, orders, { showMember: false, label: t('mem.orders') })),
      parentsBox,
      panel(
        t('mem.cards'),
        dataTable({
          label: t('mem.cards'),
          head: [t('cards.card'), t('cards.status'), t('cards.issued'), t('cards.lostAt'), { label: t('cards.listVersion'), num: true }],
          rows: cards.map((c) => [h('span', { class: 'card-id' }, h('span', { class: 'mono strong' }, cardName(c.last4)), h('span', { class: 'mono muted small' }, c.uid)), cardPill(t, c.status), formatKL(c.issuedAt), formatKL(c.lostAt), c.lostListVersion ?? '—']),
          empty: t('mem.noCards'),
          compact: true,
        }),
      ),
    );
  }

  await load();
}

async function grantSubsidy(ctx, member) {
  const { t, api } = ctx;
  const order = await openDialog({
    t,
    title: t('sub.title', { name: member.name }),
    body: h('p', {}, t('sub.body')),
    fields: [
      { name: 'amount', label: t('sub.amount'), type: 'money', required: true, placeholder: '10.00' },
      { name: 'note', label: t('sub.note'), type: 'textarea', maxLength: 500, placeholder: t('sub.notePlaceholder') },
    ],
    parseMoney,
    confirmLabel: t('sub.confirm'),
    tone: 'accent',
    action: (v) => api.post('/api/admin/subsidies', { memberId: member.id, amountSen: v.amount, note: v.note }),
  });
  if (!order) return null;
  ctx.flash(h('strong', {}, t('sub.done', { amount: formatRM(order.amountSen), name: member.name, at: formatKL(order.addBy) })));
  ctx.refreshBadges();
  return order;
}

/** A new invitation code for this child's parent, shown with a copy button. */
export async function createInvite(ctx, member) {
  const { t, api } = ctx;
  const invite = await openDialog({
    t,
    title: t('inv.title', { name: member.name }),
    body: h('p', {}, t('inv.body')),
    confirmLabel: t('inv.confirm'),
    action: () => api.post('/api/admin/invites', { memberId: member.id }),
  });
  if (!invite) return null;
  showInviteCode(ctx, invite.code, member.name);
  return invite;
}

export function showInviteCode(ctx, code, name) {
  const { t } = ctx;
  ctx.flash(
    h(
      'div',
      { class: 'invite-done' },
      h('p', {}, h('strong', {}, t('inv.done', { name }))),
      h('div', { class: 'invite-code' }, h('code', { class: 'invite-code__value' }, code), copyButton(t, code)),
      h('p', { class: 'muted small' }, t('inv.next')),
    ),
  );
}
