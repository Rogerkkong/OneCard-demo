import { formatRM } from '../shared/money.js';
import { Terminal } from './terminal.js';

// A canteen card reader (docs/DESIGN.md §6): the cashier keys in the items, the student taps
// the card and the reader charges it straight away, using its own copy of the price list, so
// it sells with or without a network. Each sale is one record with the items, the price
// version used and the block-list version the reader had (DESIGN §3 "Purchase record").

/** Lines one sale may have, and the largest quantity of one item (validateRecord's limits). */
export const MAX_SALE_LINES = 20;
export const MAX_ITEM_QTY = 99;

/**
 * Price the order from the reader's own list.
 * @returns {{ lines: Array<{ code: string, qty: number, priceSen: number }>, amountSen: number }
 *   | { problem: { reason: string, text: string } }}
 */
function priceItems(items, prices) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_SALE_LINES) {
    return { problem: { reason: 'ITEMS_INVALID', text: `Choose 1 to ${MAX_SALE_LINES} items` } };
  }
  const byCode = new Map(prices.items.map((item) => [item.code, item]));
  const lines = [];
  let amountSen = 0;
  for (const wanted of items) {
    const code = typeof wanted?.code === 'string' ? wanted.code.trim().toUpperCase() : '';
    const qty = wanted?.qty ?? 1;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_ITEM_QTY) {
      return { problem: { reason: 'ITEMS_INVALID', text: `Quantity must be 1 to ${MAX_ITEM_QTY}` } };
    }
    const item = byCode.get(code);
    if (!item) return { problem: { reason: 'UNKNOWN_ITEM', text: `Unknown item ${code || '(none)'}` } };
    lines.push({ code: item.code, qty, priceSen: item.priceSen });
    amountSen += qty * item.priceSen;
  }
  return { lines, amountSen };
}

export class CanteenReader extends Terminal {
  static deviceType = 'CANTEEN';

  /**
   * A student taps a card for an order. Refusals, in order: no block list yet (card
   * unavailable), reader not ready (no prices or settings), journal full, a bad or unknown
   * item, then the card rules of DESIGN §3 (card unavailable for an unreadable, foreign or
   * blocked card; plain messages for window, group, limits, tap gap and balance).
   * @param {import('./card.js').VirtualCard} card
   * @param {{ items: Array<{ code: string, qty?: number }> }} order  qty defaults to 1
   * @returns {Promise<{ ok: boolean, screen: string, record?: object, sent?: boolean, reason?: string }>}
   *   record: the completed purchase record; sent: whether it reached the broker now (else it
   *   waits in the journal); reason: why a tap was refused (for the lab console, never shown)
   */
  async tap(card, { items } = {}) {
    const gate = this._saleGate();
    if (gate) return gate;
    const { prices } = this._sellingConfig();
    const priced = priceItems(items, prices.content);
    if (priced.problem) return this._refuse(priced.problem.reason, priced.problem.text);
    const admitted = this._admitCard(card);
    if (admitted.refusal) return admitted.refusal;
    const { memory, digest } = admitted;
    const refusal = this._checkRules(memory, priced.amountSen);
    if (refusal) return refusal;
    return this._sell(
      card,
      memory,
      {
        kind: 'SALE',
        card: digest,
        last4: admitted.last4,
        amountSen: priced.amountSen,
        items: priced.lines,
        priceVersion: prices.version,
      },
      (record) => `Paid ${formatRM(record.amountSen)} · Balance ${formatRM(record.balanceAfterSen)}`,
    );
  }
}
