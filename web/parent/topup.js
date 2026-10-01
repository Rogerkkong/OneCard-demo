// Top up a child's card, and the page the parent lands on when the bank sends them back.
//
// One top-up attempt = one Idempotency-Key, kept in this tab until the platform answers. A
// retry after no answer (no network, server off, server error) sends the same key, so the
// platform hands back the order it may already have made instead of making a second one.
// A clear refusal (limits, no card…) ends the attempt; changing the amount starts a new one.

import { parseRM, newIdempotencyKey } from '/shared/api.js';
import {
  call, h, t, state, store, loadFamily, findChild, childKey, childPath, avatar, icon, notice, errorText, loadError,
  skeleton, moneyTiles, schoolLine, setTitle, busy, money, when, goToBank, isUncertain, PENDING_PAYMENT,
} from './core.js';

const PRESETS = [1000, 2000, 5000, 10000];
const ATTEMPT = 'topup-attempt';
const limitsKey = (schoolId) => `limits:${schoolId}`;
/** What the form held per child (survives a language switch and "Try again" from the result page). */
const formMemory = new Map();

/** The attempt for this child and amount: the stored one (a retry) or a new one with a fresh key. */
function attemptFor(schoolId, memberId, amountSen) {
  const a = store.get(ATTEMPT);
  if (a && a.schoolId === schoolId && a.memberId === memberId && a.amountSen === amountSen && typeof a.key === 'string') return a;
  const fresh = { schoolId, memberId, amountSen, key: newIdempotencyKey() };
  store.set(ATTEMPT, fresh);
  return fresh;
}

/** Start the top-up form for this child already set to an amount. */
export function presetAmount(schoolId, memberId, amountSen) {
  formMemory.set(childKey(schoolId, memberId), PRESETS.includes(amountSen)
    ? { choice: String(amountSen), other: '' }
    : { choice: 'other', other: (amountSen / 100).toFixed(2) });
}

async function childOrNull(schoolId, memberId) {
  const known = findChild(schoolId, memberId);
  if (known) return known;
  await loadFamily();
  return findChild(schoolId, memberId);
}

// ---- the form -------------------------------------------------------------------------------

export async function topupView(view, [schoolId, memberId]) {
  setTitle(t('topupTitle'));
  let child;
  try {
    child = await childOrNull(schoolId, memberId);
  } catch (err) {
    if (!view.alive()) return;
    view.main.replaceChildren(loadError(err, () => view.refresh()));
    return;
  }
  if (!view.alive()) return;
  const back = h('nav', { class: 'crumbs', 'aria-label': t('backToChildren') },
    h('a', { class: 'back', href: child ? childPath(child) : '#/' }, icon('back'), child ? child.name : t('backToChildren')));
  if (!child) {
    view.main.replaceChildren(back, h('div', { class: 'narrow stack' },
      h('h1', { tabindex: '-1' }, t('notLinkedTitle')), notice('warn', null, t('notLinkedText'))));
    return;
  }
  const vars = { child: child.name, school: child.schoolName };
  const head = h('header', { class: 'formhead' },
    avatar(child.name),
    h('div', {},
      h('h1', { tabindex: '-1' }, t('topupTitle')),
      h('p', { class: 'muted' }, t('topupFor', vars))));

  if (child.schoolStatus !== 'ACTIVE') {
    view.main.replaceChildren(back, h('div', { class: 'narrow stack' }, head,
      notice('warn', t('suspendedTitle', { school: child.schoolName }), t('suspendedText', { child: child.name }))));
    return;
  }
  if (!child.card || child.card.status !== 'ACTIVE') {
    const lost = child.card?.status === 'LOST';
    view.main.replaceChildren(back, h('div', { class: 'narrow stack' }, head,
      notice(lost ? 'bad' : 'warn',
        t(lost ? 'lostCardTitle' : child.card ? 'retiredCardTitle' : 'noCardTitle', vars),
        t(lost ? 'lostCardText' : child.card ? 'retiredCardText' : 'noCardText', vars))));
    return;
  }

  const key = childKey(schoolId, memberId);
  const mem = formMemory.get(key) ?? { choice: null, other: '' };
  formMemory.set(key, mem);
  const base = `/api/parent/children/${encodeURIComponent(schoolId)}/${encodeURIComponent(memberId)}`;

  // amount: four presets and a free amount
  const radios = PRESETS.map((sen) => h('input', { type: 'radio', name: 'amount', value: String(sen), checked: mem.choice === String(sen) }));
  const chips = PRESETS.map((sen, i) =>
    h('label', { class: 'chip' }, radios[i], h('span', { class: 'chip__face num' }, h('span', {}, h('small', {}, 'RM'), ' ', String(sen / 100)))));
  const other = h('input', {
    id: 'other-amount', name: 'other', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
    value: mem.other, 'aria-describedby': 'other-hint',
  });
  const limitsLine = h('p', { class: 'hint limits', 'aria-live': 'polite' });
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--lg btn--block' });
  const nowBox = h('div', { class: 'topup-now' });

  const form = h('form', { class: 'form topup', novalidate: true },
    h('fieldset', { class: 'amounts' },
      h('legend', {}, t('howMuch')),
      h('div', { class: 'chips' }, ...chips),
      h('div', { class: 'field other' },
        h('label', { for: 'other-amount' }, t('otherAmount')),
        h('div', { class: 'money-input' }, h('span', { 'aria-hidden': 'true' }, 'RM'), other),
        h('p', { class: 'hint', id: 'other-hint' }, t('otherAmountHint'))),
      limitsLine),
    h('section', { class: 'steps', 'aria-labelledby': 'steps-h' },
      h('h2', { id: 'steps-h' }, t('nextTitle')),
      h('ol', {},
        h('li', {}, icon('bank'), h('span', {}, t('step1'))),
        h('li', {}, icon('hourglass'), h('span', {}, t('step2', vars))),
        h('li', {}, icon('card'), h('span', {}, t('step3', vars))))),
    msg,
    submit,
    h('p', { class: 'hint center' }, t('leaveNote')));

  view.main.replaceChildren(back, h('div', { class: 'narrow stack' }, head, nowBox, h('div', { class: 'panel' }, form)));

  for (const r of radios) {
    r.addEventListener('change', () => {
      mem.choice = r.value;
      mem.other = '';
      other.value = '';
      update();
    });
  }
  other.addEventListener('input', () => {
    mem.other = other.value;
    mem.choice = other.value.trim() ? 'other' : null;
    for (const r of radios) r.checked = false;
    other.removeAttribute('aria-invalid');
    update();
  });

  function readAmount() {
    if (mem.choice && mem.choice !== 'other') return { sen: Number(mem.choice) };
    const text = other.value.trim().replace(/,/g, '');
    if (!text) return { error: 'errChooseAmount' };
    const sen = parseRM(text);
    if (sen === null) return { error: 'errAmountFormat' };
    if (sen <= 0) return { error: 'errAmountZero' };
    return { sen };
  }

  function update() {
    const a = readAmount();
    submit.replaceChildren(icon('bank'), a.sen ? t('continueToBankAmount', { amount: money(a.sen) }) : t('continueToBank'));
  }

  function drawLimits() {
    const known = store.get(limitsKey(schoolId));
    limitsLine.textContent = known ? t('limitsKnown', { school: child.schoolName, min: money(known.minSen), max: money(known.maxSen) }) : '';
    limitsLine.hidden = !known;
  }

  function setAmount(sen) {
    if (PRESETS.includes(sen)) {
      mem.choice = String(sen);
      mem.other = '';
      other.value = '';
      for (const r of radios) r.checked = r.value === String(sen);
    } else {
      mem.choice = 'other';
      mem.other = (sen / 100).toFixed(2);
      other.value = mem.other;
      for (const r of radios) r.checked = false;
    }
    update();
  }

  let inFlight = false;
  /** true while the message says the last try got no answer (the server was off or unreachable) */
  let waitingForServer = false;
  const tryAgainRow = () => h('div', { class: 'notice__actions' },
    h('button', { type: 'button', class: 'btn btn--small', onclick: () => form.requestSubmit() }, icon('refresh'), t('tryAgain')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (inFlight) return;
    waitingForServer = false;
    msg.replaceChildren();
    const a = readAmount();
    if (a.error) {
      msg.replaceChildren(notice('bad', null, t(a.error)));
      if (mem.choice === 'other' || other.value) {
        other.setAttribute('aria-invalid', 'true');
        other.focus();
      } else radios[0].focus();
      return;
    }
    await start(a.sen, false);
  });

  async function start(sen, retried) {
    inFlight = true;
    const restore = busy(submit, t('starting'));
    const attempt = attemptFor(schoolId, memberId, sen);
    try {
      const res = await call(`${base}/topups`, {
        method: 'POST',
        body: { amountSen: sen },
        headers: { 'Idempotency-Key': attempt.key },
      });
      store.del(ATTEMPT);
      formMemory.delete(key);
      submit.lastChild.textContent = t('goingToBank'); // stays disabled while the bank page opens
      goToBank(res.order, res.payUrl);
    } catch (err) {
      inFlight = false;
      restore();
      if (!view.alive()) return;
      if (err.code === 'IDEMPOTENCY_KEY_REUSED' && !retried) {
        // only a stale key from another request gives this: drop it and ask once more with a new one
        store.del(ATTEMPT);
        await start(sen, true);
        return;
      }
      if (isUncertain(err)) {
        // keep the attempt: "Try again" sends the same key, so it can never make a second order
        const down = err.code === 'SERVER_DOWN';
        waitingForServer = true;
        msg.replaceChildren(notice('warn', t(down ? 'downTitle' : 'uncertainTitle'), t(down ? 'downText' : 'uncertainText'), tryAgainRow()));
        return;
      }
      store.del(ATTEMPT);
      refused(err, sen);
    }
  }

  /** The platform said no: say why in plain words and, when it helps, offer an amount that fits. */
  function refused(err, sen) {
    const d = err.detail ?? {};
    let text;
    let note = null;
    let suggest = null;
    switch (err.code) {
      case 'AMOUNT_OUT_OF_RANGE':
        if (Number.isInteger(d.minSen) && Number.isInteger(d.maxSen)) {
          store.set(limitsKey(schoolId), { minSen: d.minSen, maxSen: d.maxSen });
          drawLimits();
          text = t('AMOUNT_OUT_OF_RANGE', { ...vars, min: money(d.minSen), max: money(d.maxSen) });
          suggest = sen > d.maxSen ? d.maxSen : sen < d.minSen ? d.minSen : null;
        } else text = errorText(err);
        break;
      case 'DAILY_LIMIT':
      case 'MONTHLY_LIMIT': {
        const none = !(d.remainingSen > 0);
        text = t(none ? `${err.code}_NONE` : err.code, {
          ...vars, limit: money(d.limitSen), used: money(d.usedSen), remaining: money(d.remainingSen),
        });
        note = t('limitCountsNote');
        const min = store.get(limitsKey(schoolId))?.minSen ?? 1;
        if (!none && d.remainingSen >= min && d.remainingSen < sen) suggest = d.remainingSen;
        break;
      }
      case 'CARD_NOT_ACTIVE':
        text = t('CARD_NOT_ACTIVE', vars);
        state.family = null; // the card changed: the child's page will show why
        break;
      case 'NOT_LINKED':
      case 'CHILD_NOT_FOUND':
        text = t('NOT_LINKED', vars);
        state.family = null;
        break;
      case 'SCHOOL_SUSPENDED':
        text = t('suspendedText', vars);
        state.family = null;
        break;
      default:
        text = errorText(err, vars);
    }
    const actions = suggest
      ? h('div', { class: 'notice__actions' },
        h('button', {
          type: 'button', class: 'btn btn--small',
          onclick: () => {
            setAmount(suggest);
            msg.replaceChildren();
            submit.focus();
          },
        }, t('useAmount', { amount: money(suggest) })))
      : null;
    msg.replaceChildren(notice('bad', t('refusedTitle'), text, note ? h('p', { class: 'notice__text notice__note' }, note) : null, actions));
  }

  update();
  drawLimits();

  // what is already on the card and waiting, so nobody tops up twice by mistake
  async function drawNow() {
    try {
      const balance = await call(`${base}/balance`);
      if (view.alive()) nowBox.replaceChildren(moneyTiles(balance, { compact: true }));
    } catch {
      // the form still works without it; offline is explained by the banner
    }
  }

  // the server is back: keep what the parent typed and say they can go on (same key, no double payment)
  view.onReconnect(() => {
    if (waitingForServer && !inFlight) msg.replaceChildren(notice('info', t('backOnlineTitle'), t('backOnlineRetry'), tryAgainRow()));
    drawNow();
  });
  await drawNow();
}

// ---- back from the bank ---------------------------------------------------------------------

const RESULT = {
  PAID: { tone: 'good', icon: 'check', title: 'resultPaidTitle', text: 'resultPaidText' },
  ADDED: { tone: 'good', icon: 'check', title: 'resultAddedTitle', text: 'resultAddedText' },
  PARKED: { tone: 'info', icon: 'hourglass', title: 'resultParkedTitle', text: 'resultParkedText' },
  FAILED: { tone: 'bad', icon: 'cross', title: 'resultFailedTitle', text: 'resultFailedText' },
  CREATED: { tone: 'warn', icon: 'alert', title: 'resultCreatedTitle', text: 'resultCreatedText' },
  CANCELLED: { tone: 'warn', icon: 'clock', title: 'resultCancelledTitle', text: 'resultCancelledText' },
  REFUNDED: { tone: 'info', icon: 'swap', title: 'resultRefundedTitle', text: 'resultRefundedText' },
  EXPIRED: { tone: 'info', icon: 'swap', title: 'resultRefundedTitle', text: 'resultRefundedText' },
};

export async function paymentView(view, [orderId]) {
  setTitle(t('resultTitle'));
  const body = h('div', { class: 'narrow result-wrap' }, h('h1', { class: 'sr-only', tabindex: '-1' }, t('resultTitle')), skeleton(5));
  view.main.replaceChildren(body);
  let shown = '';

  async function load(quiet) {
    let order;
    let child = null;
    let balance = null;
    try {
      const orders = await call('/api/parent/topups?limit=1000');
      order = orders.find((o) => o.id === orderId) ?? null;
      if (order) {
        child = await childOrNull(order.schoolId, order.memberId).catch(() => null);
        if (child && child.schoolStatus === 'ACTIVE') balance = await call(`/api/parent/children/${encodeURIComponent(order.schoolId)}/${encodeURIComponent(order.memberId)}/balance`).catch(() => null);
      }
    } catch (err) {
      if (!view.alive() || quiet) return;
      body.replaceChildren(h('h1', { tabindex: '-1' }, t('resultTitle')), loadError(err, () => load(false)));
      return;
    }
    if (!view.alive()) return;
    const sig = JSON.stringify([order, balance, child?.schoolStatus]);
    if (sig === shown) return;
    shown = sig;
    draw(order, child, balance);
  }

  function draw(order, child, balance) {
    if (!order) {
      body.replaceChildren(
        h('div', { class: 'result result--warn' },
          h('span', { class: 'result__badge' }, icon('alert')),
          h('h1', { tabindex: '-1' }, t('resultMissingTitle')),
          h('p', { class: 'result__text' }, t('resultMissingText')),
          h('div', { class: 'result__actions' }, h('a', { class: 'btn btn--primary btn--lg', href: '#/' }, t('backHome')))));
      return;
    }
    const r = RESULT[order.status] ?? RESULT.CREATED;
    const vars = {
      amount: money(order.amountSen),
      child: order.memberName,
      school: order.schoolName ?? child?.schoolName ?? '',
      time: when(order.payBy),
    };
    const childHref = child ? childPath(child) : '#/';
    const actions = [];
    if (order.status === 'CREATED' && order.payUrl) {
      actions.push(h('button', { type: 'button', class: 'btn btn--accent btn--lg', onclick: () => goToBank(order, order.payUrl) },
        icon('bank'), t('payNow', { amount: money(order.amountSen) })));
      actions.push(h('a', { class: 'btn btn--lg', href: childHref }, t('later')));
    } else if ((order.status === 'FAILED' || order.status === 'CANCELLED') && child) {
      actions.push(h('button', {
        type: 'button', class: 'btn btn--primary btn--lg',
        onclick: () => {
          presetAmount(order.schoolId, order.memberId, order.amountSen);
          view.go(`${childPath(child)}/topup`);
        },
      }, icon('refresh'), t(order.status === 'FAILED' ? 'tryAgain' : 'startNewTopup')));
      actions.push(h('a', { class: 'btn btn--lg', href: childHref }, t('seeChild', { child: order.memberName })));
    } else {
      actions.push(h('a', { class: 'btn btn--primary btn--lg', href: childHref }, t('seeChild', { child: order.memberName })));
      actions.push(h('a', { class: 'btn btn--lg', href: '#/' }, t('backHome')));
    }
    body.replaceChildren(
      h('div', { class: `result result--${r.tone}` },
        h('span', { class: 'result__badge' }, icon(r.icon)),
        h('h1', { tabindex: '-1' }, t(r.title)),
        h('p', { class: 'result__text' }, t(r.text, vars)),
        order.status === 'PAID' && order.addBy ? h('p', { class: 'result__sub' }, t('resultPaidAddBy', { time: when(order.addBy) })) : null,
        h('p', { class: 'result__school' }, schoolLine(vars.school), h('span', { class: 'result__ref' }, t('reference', { ref: order.id })))),
      balance
        ? h('section', { class: 'panel', 'aria-label': t('moneyFor', { name: order.memberName }), 'aria-live': 'polite' },
          moneyTiles(balance),
          h('p', { class: 'explain' }, icon('info'), h('span', {}, t('waitingExplain'))))
        : null,
      h('div', { class: 'result__actions' }, ...actions),
    );
  }

  // the bank answered before sending the parent here, so this is normally final at once
  store.del(PENDING_PAYMENT);
  await load(false);
  view.poll(15000, () => load(true));
}
