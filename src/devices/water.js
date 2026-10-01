import { formatRM, maxAffordableMl, waterChargeSen } from '../shared/money.js';
import { Terminal } from './terminal.js';

// A water machine (docs/DESIGN.md §6): the student asks for an amount of water and taps the
// card. The machine charges by the litre from its own price list (rounded to the sen, with a
// minimum charge) and pours at most what the card can pay and the school's limits allow, so a
// request is cut short rather than refused while some water can still be poured. Nothing
// poured means nothing charged and no record.

/** The most one pour can be (validateRecord accepts 1 to 20000 ml). */
export const MAX_POUR_ML = 20_000;

export class WaterMachine extends Terminal {
  static deviceType = 'WATER';

  /**
   * A student taps a card for `ml` millilitres. Same rules as a canteen sale (DESIGN §3), in
   * the same order, except that the per-purchase limit, the daily total and the balance cap
   * the pour instead of refusing it, unless not even the minimum charge fits.
   * @param {import('./card.js').VirtualCard} card
   * @param {{ ml: number }} request  whole millilitres, 1 or more (more than MAX_POUR_ML pours MAX_POUR_ML)
   * @returns {Promise<{ ok: boolean, screen: string, record?: object, pouredMl: number, sent?: boolean, reason?: string }>}
   */
  async tap(card, { ml } = {}) {
    const none = (result) => ({ ...result, pouredMl: 0 });
    const gate = this._saleGate();
    if (gate) return none(gate);
    if (!Number.isSafeInteger(ml) || ml < 1) return none(this._refuse('AMOUNT_INVALID', 'Choose how much water to pour'));
    const admitted = this._admitCard(card);
    if (admitted.refusal) return none(admitted.refusal);
    const { memory, digest } = admitted;
    const { prices, settings } = this._sellingConfig();
    const { perLitreSen, minChargeSen } = prices.content.water;
    const s = settings.content;
    const affordable = (sen) => (sen > 0 ? maxAffordableMl(sen, perLitreSen, minChargeSen) : 0);

    const early = this._checkWindowAndGroup(memory);
    if (early) return none(early);
    let pour = Math.min(ml, MAX_POUR_ML);
    const perPurchase = affordable(s.perPurchaseMaxSen);
    if (perPurchase === 0) return none(this._refuseRule('PER_PURCHASE_LIMIT'));
    pour = Math.min(pour, perPurchase);
    const day = this._dayStats(memory);
    const today = affordable(s.dailyMaxSen - day.totalSen);
    if (today === 0) return none(this._refuseRule('DAILY_LIMIT'));
    pour = Math.min(pour, today);
    if (day.count >= s.dailyMaxCount) return none(this._refuseRule('DAILY_COUNT'));
    if (this._tapGapLeftMs(day) > 0) return none(this._refuseRule('TAP_GAP', { day }));
    const balance = affordable(memory.balanceSen);
    if (balance === 0) return none(this._refuseRule('INSUFFICIENT_BALANCE', { memory }));
    pour = Math.min(pour, balance);

    const amountSen = waterChargeSen(pour, perLitreSen, minChargeSen);
    const poured = pour === ml ? `Poured ${pour} ml` : `Poured ${pour} of ${ml} ml`;
    const result = await this._sell(
      card,
      memory,
      { kind: 'WATER', card: digest, last4: admitted.last4, amountSen, ml: pour, perLitreSen, priceVersion: prices.version },
      (record) => `${poured} · Paid ${formatRM(record.amountSen)} · Balance ${formatRM(record.balanceAfterSen)}`,
    );
    return { ...result, pouredMl: result.ok ? pour : 0 };
  }
}
