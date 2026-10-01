// Card actions shared by the student list, the card list and a student's page: report lost,
// mark found, replace and issue. Each asks in an in-page dialog first and leaves the result at
// the top of the view, including whether the new block list went out to the machines.

import { h, formatRM } from '/shared/api.js';
import { openDialog, pill } from './kit.js';

/** '04 A1:3b-5C' -> '04A13B5C' (the same clean-up the platform does). */
export const cleanUid = (value) => String(value ?? '').replace(/[\s:-]/g, '').toUpperCase();

/** A problem with a typed card UID, or null. */
export function uidProblem(t, value) {
  const uid = cleanUid(value);
  if (!/^[0-9A-F]{8,20}$/.test(uid) || uid.length % 2 !== 0) return t('card.uidInvalid');
  return null;
}

/** Cards are shown by their last 4 characters, like a bank card. */
export const cardName = (last4) => `••${last4}`;

const CARD_TONES = { ACTIVE: 'good', LOST: 'bad', RETIRED: '' };
export const cardPill = (t, status) => pill(t(`cardStatus.${status}`), CARD_TONES[status] ?? '');

/** The second sentence of every block-list change: did it reach the broker? */
function sentText(t, published) {
  return published ? t('card.sent') : t('card.notSent');
}

export async function reportLost(ctx, { uid, last4, memberName }) {
  const { t, api } = ctx;
  const card = await openDialog({
    t,
    title: t('card.lostTitle', { card: cardName(last4) }),
    body: [h('p', {}, t('card.lostBody', { name: memberName ?? '—' })), h('p', { class: 'muted' }, t('card.lostWindow'))],
    confirmLabel: t('card.lostConfirm'),
    tone: 'danger',
    action: () => api.post(`/api/admin/cards/${encodeURIComponent(uid)}/report-lost`),
  });
  if (!card) return null;
  ctx.flash(
    [
      h('strong', {}, t('card.lostDone', { card: cardName(card.last4), version: card.lostListVersion ?? '—' })),
      ' ',
      sentText(t, card.published),
      ' ',
      ctx.can('machines') ? h('a', { href: '#/machines' }, t('card.seeMachines')) : null,
    ],
    card.published ? 'good' : 'warn',
  );
  ctx.refreshBadges();
  return card;
}

export async function markFound(ctx, { uid, last4, memberName }) {
  const { t, api } = ctx;
  const card = await openDialog({
    t,
    title: t('card.foundTitle', { card: cardName(last4) }),
    body: h('p', {}, t('card.foundBody', { name: memberName ?? '—' })),
    confirmLabel: t('card.foundConfirm'),
    action: () => api.post(`/api/admin/cards/${encodeURIComponent(uid)}/found`),
  });
  if (!card) return null;
  ctx.flash([h('strong', {}, t('card.foundDone', { card: cardName(card.last4) })), ' ', sentText(t, card.published)], card.published ? 'good' : 'warn');
  return card;
}

/** @param {{ id: string, name: string }} member  @param {object|null} activeCard  @param {number} balanceSen */
export async function replaceCard(ctx, member, activeCard, balanceSen) {
  const { t, api } = ctx;
  const out = await openDialog({
    t,
    title: t('card.replaceTitle', { name: member.name }),
    body: [
      h('p', {}, activeCard ? t('card.replaceOld', { card: cardName(activeCard.last4) }) : t('card.replaceNoOld')),
      h('p', {}, t('card.replaceMoney', { amount: formatRM(balanceSen) })),
    ],
    fields: [{ name: 'uid', label: t('card.newUid'), required: true, mono: true, hint: t('card.uidHint'), validate: (v) => uidProblem(t, v), spellcheck: false }],
    confirmLabel: t('card.replaceConfirm'),
    action: (v) => api.post(`/api/admin/members/${encodeURIComponent(member.id)}/replace-card`, { newUid: cleanUid(v.uid) }),
  });
  if (!out) return null;
  // `oldCard` is also the earlier card when none was active; only an active one was reported lost now
  const reportedNow = Boolean(activeCard && out.oldCard && out.oldCard.uid === activeCard.uid);
  const parts = [h('strong', {}, t('card.replaceDone', { card: cardName(out.newCard.last4), name: member.name }))];
  if (reportedNow) parts.push(' ', t('card.replaceOldDone', { card: cardName(out.oldCard.last4) }));
  parts.push(' ', out.transferOrder ? t('card.replaceTransfer', { amount: formatRM(out.transferOrder.amountSen) }) : t('card.replaceNoTransfer'));
  if (reportedNow) parts.push(' ', sentText(t, out.published));
  ctx.flash(parts, reportedNow && out.published === false ? 'warn' : 'good');
  return out;
}

export async function issueCard(ctx, member) {
  const { t, api } = ctx;
  const card = await openDialog({
    t,
    title: t('card.issueTitle', { name: member.name }),
    body: h('p', {}, t('card.issueBody')),
    fields: [{ name: 'uid', label: t('card.uid'), required: true, mono: true, hint: t('card.uidHint'), validate: (v) => uidProblem(t, v), spellcheck: false }],
    confirmLabel: t('card.issueConfirm'),
    action: (v) => api.post('/api/admin/cards', { memberId: member.id, uid: cleanUid(v.uid) }),
  });
  if (!card) return null;
  ctx.flash(h('strong', {}, t('card.issueDone', { card: cardName(card.last4), name: member.name })));
  return card;
}
