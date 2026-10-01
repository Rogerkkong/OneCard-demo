// Tables that appear in more than one section: top-up orders and purchases.

import { h, formatRM, formatKL } from '/shared/api.js';
import { dataTable, pill } from './kit.js';

const ORDER_TONES = { CREATED: '', PAID: 'info', ADDED: 'good', PARKED: 'warn', REFUNDED: '', CANCELLED: '', FAILED: 'bad', EXPIRED: 'warn' };

export const orderPill = (t, status) => pill(t(`orderStatus.${status}`), ORDER_TONES[status] ?? '');

/** One line saying where an order stands, in plain words. */
export function orderDetail(t, o) {
  let text;
  switch (o.status) {
    case 'CREATED':
      text = t('order.payBy', { at: formatKL(o.payBy) });
      break;
    case 'PAID':
      if (o.writeResult === 'UNCONFIRMED') text = t('order.unconfirmed', { at: formatKL(o.writeAttemptAt) });
      else if (o.writeResult === 'FAILED') text = t('order.writeFailed', { at: formatKL(o.writeAttemptAt) });
      else text = o.addBy ? t('order.addBy', { at: formatKL(o.addBy) }) : t('order.noDeadline');
      break;
    case 'ADDED':
      text = o.resolvedBy ? t('order.markedAdded', { by: o.resolvedBy }) : t('order.added', { at: formatKL(o.addedAt), device: o.addedByDevice ?? '—' });
      break;
    case 'PARKED':
      text = t('order.parked', { at: formatKL(o.writeAttemptAt) });
      break;
    case 'REFUNDED':
      text = o.resolvedBy ? t('order.refundedBy', { by: o.resolvedBy }) : t('order.refunded');
      break;
    default:
      text = t(`order.${o.status}`);
  }
  return h(
    'span',
    { class: 'order-detail' },
    text,
    o.kioskTxn ? h('span', { class: 'mono muted small' }, ` ${o.kioskTxn}`) : null,
    o.resolutionNote ? h('span', { class: 'note-quote' }, `“${o.resolutionNote}”`) : null,
  );
}

/** @param {{ showMember?: boolean, label: string, empty?: string }} opts */
export function ordersTable(ctx, orders, { showMember = true, label, empty }) {
  const { t } = ctx;
  const head = [
    { label: t('order.created') },
    showMember ? { label: t('order.member') } : null,
    { label: t('order.kind'), nowrap: true },
    { label: t('order.amount'), num: true },
    { label: t('order.status') },
    { label: t('order.detail') },
  ].filter(Boolean);
  return dataTable({
    label,
    head,
    empty: empty ?? t('order.empty'),
    rows: orders.map((o) =>
      [
        formatKL(o.createdAt),
        showMember ? h('a', { href: `#/students/${encodeURIComponent(o.memberId)}` }, o.memberName ?? '—') : null,
        t(`orderKind.${o.kind}`),
        h('strong', {}, formatRM(o.amountSen)),
        orderPill(t, o.status),
        orderDetail(t, o),
      ].filter((c) => c !== null),
    ),
  });
}

/** What was bought: canteen items with quantities, or millilitres of water. */
export function whatText(t, p) {
  if (p.kind === 'WATER') return t('purchase.water', { ml: p.ml ?? '—' });
  const items = Array.isArray(p.items) ? p.items : [];
  return items.map((i) => (i.qty > 1 ? `${i.code} ×${i.qty}` : i.code)).join(', ') || '—';
}

const PURCHASE_TONES = { POSTED: 'good', FLAGGED: 'warn' };

/** @param {{ showMember?: boolean, label: string, empty?: string }} opts */
export function purchasesTable(ctx, purchases, { showMember = true, label, empty }) {
  const { t } = ctx;
  const head = [
    { label: t('purchase.at') },
    { label: t('purchase.machine') },
    showMember ? { label: t('purchase.member') } : null,
    { label: t('purchase.what') },
    { label: t('purchase.amount'), num: true },
    { label: t('purchase.priceVersion'), num: true },
    { label: t('purchase.arrived') },
    { label: t('purchase.status') },
  ].filter(Boolean);
  return dataTable({
    label,
    head,
    empty: empty ?? t('purchase.empty'),
    rows: purchases.map((p) =>
      [
        formatKL(p.occurredAt),
        h('span', { class: 'mono' }, p.originDeviceCode),
        showMember ? (p.memberId ? h('a', { href: `#/students/${encodeURIComponent(p.memberId)}` }, p.memberName ?? '—') : pill(t('purchase.unknownCard'), 'warn')) : null,
        whatText(t, p),
        h('strong', {}, formatRM(p.amountSen)),
        `v${p.priceVersion}`,
        h(
          'span',
          { class: 'arrived' },
          t(`via.${p.via}`),
          p.late ? [' ', pill(t('purchase.late'), 'info')] : null,
          h('span', { class: 'muted small' }, formatKL(p.receivedAt)),
        ),
        pill(t(`purchaseStatus.${p.status}`), PURCHASE_TONES[p.status] ?? ''),
      ].filter((c) => c !== null),
    ),
  });
}
