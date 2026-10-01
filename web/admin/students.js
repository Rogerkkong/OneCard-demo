// Students & cards: everyone in the school who has (or can have) a card — students and staff —
// with the platform's balance, plus the list of every card the school ever issued.

import { h, formatRM, formatKL } from '/shared/api.js';
import { sectionHead, dataTable, loadProblem, openDialog, pill, row } from './kit.js';
import { cardName, cardPill, cleanUid, uidProblem, reportLost, markFound } from './cards.js';

/** Tabs between the two lists (only staff who handle cards see the second one). */
function tabs(ctx, current) {
  if (!ctx.can('cards')) return null;
  const tab = (href, key, id) => h('a', { href, class: 'tab', 'aria-current': current === id ? 'page' : undefined }, ctx.t(key));
  return h('nav', { class: 'tabs', 'aria-label': ctx.t('st.lists') }, tab('#/students', 'st.tabStudents', 'students'), tab('#/cards', 'st.tabCards', 'cards'));
}

/** A search box that filters rows already on screen (the lists are one school's, so small). */
function searchBox(ctx, id, onInput) {
  const input = h('input', { id, type: 'search', autocomplete: 'off', placeholder: ctx.t('st.searchHint') });
  input.addEventListener('input', () => onInput(input.value.trim().toLowerCase()));
  return { input, field: h('div', { class: 'field search' }, h('label', { for: id }, ctx.t('st.search')), input) };
}

const matches = (q, ...values) => !q || values.some((v) => v && String(v).toLowerCase().includes(q));

export async function renderStudents(ctx, el) {
  const { t, api, can } = ctx;
  const actions = [];
  if (can('editMembers')) actions.push(h('button', { type: 'button', class: 'btn btn--primary', onclick: () => addMember(ctx) }, t('st.add')));
  actions.push(h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh')));
  el.append(sectionHead({ title: t('nav.students'), text: t('st.lede'), actions }));
  const tabBar = tabs(ctx, 'students');
  if (tabBar) el.append(tabBar);

  let members = [];
  let query = '';
  const count = h('p', { class: 'muted count', role: 'status' });
  const box = h('div', {}, h('p', { class: 'muted' }, t('kit.loading')));
  const search = searchBox(ctx, 'st-search', (q) => {
    query = q;
    draw();
  });
  el.append(h('section', { class: 'panel stack' }, h('div', { class: 'toolbar toolbar--split' }, search.field, count), box));

  const head = [
    { label: t('st.no') },
    { label: t('st.name') },
    { label: t('st.class') },
    { label: t('st.group'), nowrap: true },
    { label: t('st.card') },
    { label: t('st.balance'), num: true },
    { label: t('st.waiting'), num: true },
  ];

  function draw() {
    const shown = members.filter((m) => matches(query, m.memberNo, m.name, m.className, m.card?.last4, m.card?.uid));
    count.textContent = t('st.count', { shown: shown.length, total: members.length });
    box.replaceChildren(
      dataTable({
        label: t('nav.students'),
        head,
        empty: members.length ? t('st.noMatch') : t('st.empty'),
        rows: shown.map((m) => [
          h('span', { class: 'mono' }, m.memberNo),
          h('a', { href: `#/students/${encodeURIComponent(m.id)}`, class: 'strong-link' }, m.name),
          m.className || '—',
          m.group === 'STAFF' ? pill(t('group.STAFF'), 'info') : t('group.STUDENT'),
          m.card ? h('span', { class: 'card-cell' }, h('span', { class: 'mono' }, cardName(m.card.last4)), ' ', cardPill(t, m.card.status)) : pill(t('st.noCard')),
          formatRM(m.mirrorBalanceSen),
          m.waitingSen > 0 ? h('strong', {}, formatRM(m.waitingSen)) : formatRM(m.waitingSen),
        ]),
      }),
    );
  }

  async function load() {
    try {
      members = await api.get('/api/admin/members');
    } catch (err) {
      if (ctx.alive() && !members.length) box.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (ctx.alive()) draw();
  }

  await load();
}

async function addMember(ctx) {
  const { t, api } = ctx;
  const out = await openDialog({
    t,
    title: t('st.addTitle'),
    body: h('p', { class: 'muted' }, t('st.addBody')),
    fields: [
      { name: 'memberNo', label: t('st.no'), required: true, maxLength: 32, hint: t('st.noHint'), mono: true },
      { name: 'name', label: t('st.fullName'), required: true, maxLength: 100 },
      { name: 'className', label: t('st.class'), maxLength: 40, hint: t('st.classHint') },
      {
        name: 'group',
        label: t('st.group'),
        type: 'select',
        value: 'STUDENT',
        options: [
          { value: 'STUDENT', label: t('group.STUDENT') },
          { value: 'STAFF', label: t('group.STAFF') },
        ],
      },
      { name: 'cardUid', label: t('st.cardUid'), mono: true, hint: t('st.cardUidHint'), validate: (v) => (v ? uidProblem(t, v) : null), spellcheck: false },
    ],
    confirmLabel: t('st.addConfirm'),
    action: (v) =>
      api.post('/api/admin/members', {
        memberNo: v.memberNo,
        name: v.name,
        className: v.className,
        group: v.group,
        cardUid: v.cardUid ? cleanUid(v.cardUid) : undefined,
      }),
  });
  if (!out) return;
  const text = out.card ? t('st.addedWithCard', { name: out.member.name, card: cardName(out.card.last4) }) : t('st.added', { name: out.member.name });
  ctx.go(`#/students/${encodeURIComponent(out.member.id)}`, { content: h('strong', {}, text) });
}

export async function renderCards(ctx, el) {
  const { t, api } = ctx;
  el.append(sectionHead({ title: t('nav.cards'), text: t('cards.lede'), actions: [h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh'))] }));
  const tabBar = tabs(ctx, 'cards');
  if (tabBar) el.append(tabBar);

  let cards = [];
  let query = '';
  const count = h('p', { class: 'muted count', role: 'status' });
  const box = h('div', {}, h('p', { class: 'muted' }, t('kit.loading')));
  const search = searchBox(ctx, 'cards-search', (q) => {
    query = q;
    draw();
  });
  el.append(h('section', { class: 'panel stack' }, h('div', { class: 'toolbar toolbar--split' }, search.field, count), box));

  const head = [
    { label: t('cards.card') },
    { label: t('cards.holder') },
    { label: t('cards.status') },
    { label: t('cards.issued') },
    { label: t('cards.lostAt') },
    { label: t('cards.listVersion'), num: true },
    { label: t('cards.actions') },
  ];

  function actionFor(c) {
    const who = { uid: c.uid, last4: c.last4, memberName: c.memberName };
    if (c.status === 'ACTIVE') {
      return h('button', { type: 'button', class: 'btn btn--small btn--danger', onclick: async () => (await reportLost(ctx, who)) && load() }, t('card.lostButton'));
    }
    if (c.status === 'LOST') {
      return h('button', { type: 'button', class: 'btn btn--small', onclick: async () => (await markFound(ctx, who)) && load() }, t('card.foundButton'));
    }
    return '—';
  }

  function draw() {
    const shown = cards.filter((c) => matches(query, c.uid, c.last4, c.memberName, c.memberNo));
    count.textContent = t('cards.count', { shown: shown.length, total: cards.length });
    box.replaceChildren(
      dataTable({
        label: t('nav.cards'),
        head,
        empty: cards.length ? t('st.noMatch') : t('cards.empty'),
        rows: shown.map((c) =>
          row(
            [
              h('span', { class: 'card-id' }, h('span', { class: 'mono strong' }, cardName(c.last4)), h('span', { class: 'mono muted small' }, c.uid)),
              c.memberId ? h('a', { href: `#/students/${encodeURIComponent(c.memberId)}` }, c.memberName ?? '—') : '—',
              cardPill(t, c.status),
              formatKL(c.issuedAt),
              formatKL(c.lostAt),
              c.lostListVersion ?? '—',
              actionFor(c),
            ],
            {},
            head,
          ),
        ),
      }),
    );
  }

  async function load() {
    try {
      cards = await api.get('/api/admin/cards');
    } catch (err) {
      if (ctx.alive() && !cards.length) box.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (ctx.alive()) draw();
  }

  await load();
}
