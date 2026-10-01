// One child: what is on the card and what waits at the kiosk (side by side, never added
// together), the top-up button, top-ups not paid yet, and the history of top-ups and purchases.

import {
  call, h, t, state, loadFamily, findChild, childPath, avatar, icon, notice, loadError, skeleton,
  moneyTiles, schoolLine, cardLine, setTitle, money, when, statusPill, itemName, litresText, minus,
  goToBank,
} from './core.js';

const POLL_MS = 15000;
const PAGE = 10;
/** Which history tab and how many rows each child's page showed, kept while the app is open. */
const remembered = new Map();

export async function childView(view, [schoolId, memberId]) {
  let child = findChild(schoolId, memberId);
  if (!child) {
    view.main.replaceChildren(skeleton(4));
    try {
      await loadFamily();
    } catch (err) {
      if (!view.alive()) return;
      view.main.replaceChildren(backLink(), loadError(err, () => view.refresh()));
      return;
    }
    if (!view.alive()) return;
    child = findChild(schoolId, memberId);
  }
  if (!child) return notLinked(view);

  setTitle(child.name);
  const key = `${schoolId}/${memberId}`;
  const memo = remembered.get(key) ?? { tab: 'topups', shown: { topups: PAGE, purchases: PAGE } };
  remembered.set(key, memo);
  const base = `/api/parent/children/${encodeURIComponent(schoolId)}/${encodeURIComponent(memberId)}`;

  const moneyBox = h('div', { class: 'money-box', 'aria-live': 'polite' }, skeleton(3));
  const cardBox = h('div', { class: 'card-box' });
  const unpaidBox = h('div', { class: 'unpaid-box' });
  const historyBox = h('div', { class: 'history-box' }, skeleton(5));
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const refreshBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--small refresh' }, icon('refresh'), t('refresh'));
  const topupLink = h('a', { class: 'btn btn--primary btn--lg btn--block', href: `${childPath(child)}/topup` }, icon('plus'), t('topUp'));

  view.main.replaceChildren(
    backLink(),
    header(child),
    child.schoolStatus !== 'ACTIVE'
      ? suspendedBox(child)
      : h('div', { class: 'childgrid' },
        h('div', { class: 'childgrid__main' },
          h('section', { class: 'panel moneypanel', 'aria-labelledby': 'money-h' },
            // the page heading already names the child; this one is for screen readers
            h('h2', { id: 'money-h', class: 'sr-only' }, t('moneyFor', { name: child.name })),
            moneyBox,
            h('p', { class: 'explain' }, icon('info'), h('span', {}, t('waitingExplain'))),
            h('div', { class: 'moneypanel__foot' },
              h('p', { class: 'explain explain--quiet' }, t('balanceExplain')),
              refreshBtn)),
          cardBox,
          topupLink,
          unpaidBox),
        h('section', { class: 'panel history', 'aria-labelledby': 'hist-h' },
          h('h2', { id: 'hist-h' }, t('historyTitle')),
          historyBox)),
    status,
  );
  if (child.schoolStatus !== 'ACTIVE') {
    view.poll(POLL_MS, recheckSchool);
    return;
  }

  drawCard(child);
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    status.textContent = t('refreshing');
    await load({ quiet: false, force: true });
    refreshBtn.disabled = false;
    status.textContent = t('updated');
  });

  let shown = { balance: '', history: '' };
  let latest = null; // the last history answer

  async function load({ quiet = false, force = false } = {}) {
    const [b, hst, fam] = await Promise.allSettled([call(`${base}/balance`), call(`${base}/history`), quiet || force ? loadFamily() : null]);
    if (!view.alive()) return;
    const failure = b.status === 'rejected' ? b.reason : hst.status === 'rejected' ? hst.reason : null;
    const now = fam.status === 'fulfilled' && fam.value ? findChild(schoolId, memberId) : child;
    if ((failure && (failure.code === 'SCHOOL_SUSPENDED' || failure.code === 'CHILD_NOT_FOUND'))
      || JSON.stringify([now?.card, now?.schoolStatus]) !== JSON.stringify([child.card, child.schoolStatus])) {
      // the school was paused, the link removed or the card changed while the page was open: draw it again
      if (failure) state.family = null;
      view.refresh({ soft: true });
      return;
    }
    if (b.status === 'fulfilled') {
      const sig = JSON.stringify(b.value);
      if (force || sig !== shown.balance) {
        shown.balance = sig;
        moneyBox.replaceChildren(moneyTiles(b.value));
      }
    } else if (!quiet || !shown.balance) {
      shown.balance = '';
      moneyBox.replaceChildren(loadError(b.reason, () => load()));
    }
    if (hst.status === 'fulfilled') {
      latest = hst.value;
      const sig = JSON.stringify(latest);
      if (force || sig !== shown.history) {
        shown.history = sig;
        drawUnpaid();
        drawHistory();
      }
    } else if (!quiet || !shown.history) {
      shown.history = '';
      historyBox.replaceChildren(loadError(hst.reason, () => load()));
    }
  }

  async function recheckSchool() {
    try {
      await loadFamily();
      if (!view.alive()) return;
      if (findChild(schoolId, memberId)?.schoolStatus === 'ACTIVE') view.refresh({ soft: true });
    } catch {
      // the banner explains an offline server; try again on the next round
    }
  }

  function drawCard(c) {
    const card = c.card;
    let box = null;
    if (!card) box = notice('warn', t('noCardTitle', { child: c.name }), t('noCardText', { child: c.name }));
    else if (card.status === 'LOST') box = notice('bad', t('lostCardTitle', { child: c.name }), t('lostCardText', { child: c.name }));
    else if (card.status !== 'ACTIVE') box = notice('warn', t('retiredCardTitle', { child: c.name }), t('retiredCardText'));
    cardBox.replaceChildren(...(box ? [box] : []));
    // the platform refuses top-ups for a child without a working card, so don't offer one
    topupLink.hidden = !card || card.status !== 'ACTIVE';
  }

  function drawUnpaid() {
    const unpaid = latest.topups.filter((o) => o.status === 'CREATED' && o.mine && o.payUrl);
    unpaidBox.replaceChildren(
      ...unpaid.map((o) =>
        notice('warn', t('unpaidTitle'),
          t('unpaidText', { amount: money(o.amountSen), time: when(o.createdAt) }),
          h('p', { class: 'notice__text' }, t('unpaidPayBy', { time: when(o.payBy) })),
          h('div', { class: 'notice__actions' },
            h('button', { type: 'button', class: 'btn btn--accent', onclick: () => goToBank(o, o.payUrl) },
              icon('bank'), t('payNow', { amount: money(o.amountSen) }))))),
    );
  }

  function drawHistory() {
    const lists = { topups: latest.topups, purchases: latest.purchases };
    const ids = ['topups', 'purchases'];
    const tabs = ids.map((id) =>
      h('button', {
        type: 'button', role: 'tab', id: `tab-${id}`, class: 'tab', 'aria-controls': `panel-${id}`,
        'aria-selected': String(memo.tab === id), tabindex: memo.tab === id ? '0' : '-1',
        onclick: () => select(id, false),
      }, t(id === 'topups' ? 'tabTopups' : 'tabPurchases'), h('span', { class: 'tab__count' }, String(lists[id].length))));
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('historyTitle') }, ...tabs);
    tablist.addEventListener('keydown', (e) => {
      const i = ids.indexOf(memo.tab);
      let next = null;
      if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
      else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
      else if (e.key === 'Home') next = ids[0];
      else if (e.key === 'End') next = ids[ids.length - 1];
      if (!next) return;
      e.preventDefault();
      select(next, true);
    });
    const panels = ids.map((id) => {
      const rows = lists[id];
      const visible = rows.slice(0, memo.shown[id]);
      const more = rows.length > visible.length
        ? h('button', {
          type: 'button', class: 'btn btn--small more',
          onclick: () => {
            memo.shown[id] += PAGE;
            drawHistory();
            document.getElementById(`panel-${id}`)?.querySelectorAll('.hist-item')[memo.shown[id] - PAGE]?.focus();
          },
        }, t('showMore'))
        : null;
      return h('div', { role: 'tabpanel', id: `panel-${id}`, class: 'tabpanel', 'aria-labelledby': `tab-${id}`, tabindex: '0', hidden: memo.tab !== id },
        rows.length
          ? h('ul', { class: 'hist' }, ...visible.map(id === 'topups' ? topupItem : purchaseItem))
          : h('p', { class: 'muted empty-line' }, t(id === 'topups' ? 'noTopups' : 'noPurchases')),
        more,
        id === 'purchases' ? h('p', { class: 'hint' }, t('purchasesNote')) : null);
    });
    historyBox.replaceChildren(tablist, ...panels);

    function select(id, focus) {
      memo.tab = id;
      for (const b of tabs) {
        const on = b.id === `tab-${id}`;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      }
      for (const p of panels) p.hidden = p.id !== `panel-${id}`;
    }
  }

  await load();
  view.poll(POLL_MS, () => load({ quiet: true }));
}

/** One top-up, subsidy or balance transfer with its status in plain words. */
function topupItem(o) {
  const at = (ms) => when(ms);
  const funded = o.kind === 'SUBSIDY' ? t('detailGiven', { time: at(o.paidAt) })
    : o.kind === 'TRANSFER' ? t('detailMoved', { time: at(o.paidAt) })
      : t('detailPaid', { time: at(o.paidAt) });
  const lines = [];
  switch (o.status) {
    case 'CREATED':
      lines.push(t('detailStarted', { time: at(o.createdAt) }), t('detailPayBy', { time: at(o.payBy) }));
      break;
    case 'PAID':
      lines.push(funded);
      if (o.addBy) lines.push(t(o.kind === 'SUBSIDY' ? 'detailAddBySubsidy' : 'detailAddBy', { time: at(o.addBy) }));
      break;
    case 'ADDED':
      lines.push(funded, t('detailAdded', { time: at(o.addedAt) }));
      break;
    case 'PARKED':
      lines.push(funded, t('detailParked'));
      break;
    case 'EXPIRED':
    case 'REFUNDED':
      lines.push(funded, t(o.kind === 'SUBSIDY' ? 'detailRefundedSubsidy' : 'detailRefundedTopup'));
      break;
    case 'FAILED':
      lines.push(t('detailStarted', { time: at(o.createdAt) }), t('detailFailed'));
      break;
    case 'CANCELLED':
      lines.push(t('detailStarted', { time: at(o.createdAt) }), t('detailCancelled'));
      break;
    default:
      lines.push(t('detailStarted', { time: at(o.createdAt) }));
  }
  const kindIcon = { TOPUP: 'up', SUBSIDY: 'gift', TRANSFER: 'swap' }[o.kind] ?? 'up';
  const struck = ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].includes(o.status);
  return h('li', { class: `hist-item hist-item--${o.status.toLowerCase()}`, tabindex: '-1' },
    h('span', { class: `hist-item__icon hist-item__icon--${kindIcon}` }, icon(kindIcon)),
    h('p', { class: 'hist-item__title' }, t(`kind${o.kind}`)),
    h('p', { class: `hist-item__amount num${struck ? ' is-void' : ''}` }, money(o.amountSen)),
    h('div', { class: 'hist-item__more' },
      h('p', { class: 'hist-item__status' }, statusPill(o.status)),
      ...lines.map((l) => h('p', { class: 'hist-item__detail' }, l))));
}

/** One canteen sale (items) or water purchase (litres). */
function purchaseItem(p) {
  const water = p.kind === 'WATER';
  const what = water
    ? t('litres', { n: litresText(p.ml) })
    : (p.items ?? []).map((i) => `${itemName(i.code)}\u00a0×${i.qty}`).join(' · ');
  return h('li', { class: 'hist-item', tabindex: '-1' },
    h('span', { class: `hist-item__icon hist-item__icon--${water ? 'drop' : 'bowl'}` }, icon(water ? 'drop' : 'bowl')),
    h('p', { class: 'hist-item__title' }, t(water ? 'purchaseWATER' : 'purchaseSALE')),
    h('p', { class: 'hist-item__amount hist-item__amount--out num' }, minus(p.amountSen)),
    h('div', { class: 'hist-item__more' },
      what ? h('p', { class: 'hist-item__detail' }, what) : null,
      h('p', { class: 'hist-item__detail' }, when(p.occurredAt))));
}

function backLink() {
  return h('nav', { class: 'crumbs', 'aria-label': t('backToChildren') },
    h('a', { class: 'back', href: '#/' }, icon('back'), t('backToChildren')));
}

function header(c) {
  return h('header', { class: 'childhead' },
    avatar(c.name, 'avatar--large'),
    h('div', { class: 'childhead__who' },
      h('h1', { tabindex: '-1' }, c.name),
      h('p', { class: 'childhead__meta' },
        schoolLine(c.schoolName),
        c.className ? h('span', { class: 'childhead__class' }, t('classOf', { name: c.className })) : null,
        cardLine(c.card))));
}

function suspendedBox(c) {
  return h('div', { class: 'narrow' }, notice('warn', t('suspendedTitle', { school: c.schoolName }), t('suspendedText', { child: c.name })));
}

function notLinked(view) {
  setTitle(t('notLinkedTitle'));
  view.main.replaceChildren(
    backLink(),
    h('div', { class: 'narrow stack' },
      h('h1', { tabindex: '-1' }, t('notLinkedTitle')),
      notice('warn', null, t('notLinkedText')),
      h('a', { class: 'btn btn--primary', href: '#/' }, t('backHome'))),
  );
}
