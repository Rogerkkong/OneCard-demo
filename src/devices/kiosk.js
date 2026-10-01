import { LabError } from '../shared/errors.js';
import { last4 } from '../shared/crypto.js';
import { formatRM } from '../shared/money.js';
import { SCREEN_CARD_UNAVAILABLE, parseDeviceTxnNo } from '../shared/protocol.js';
import { CardError, PowerCutError } from './card.js';
import { Terminal } from './terminal.js';

// The top-up kiosk (docs/DESIGN.md §6, rules in §3 "Kiosk HTTP"): the only machine that puts
// money on a card, and only with the platform on the line. On every tap it reads the card,
// uploads what the card carries (card.readback), settles any earlier write of its own whose
// report never arrived, asks the platform what is waiting (signed HTTP) and writes each order
// to the card all or nothing, reporting each write under its own kiosk txn number.
//
// The order of a write and its report is what keeps money from being added twice: a write
// whose report got lost is looked up and re-sent under the same kiosk txn, and found again on
// the card at the next tap; it is never written again under a new number.

/** Lab faults a tap can simulate (on the first order of the tap only). */
export const KIOSK_FAULTS = Object.freeze(['power-cut-before-commit', 'power-cut-after-commit', 'confirm-timeout']);
export const SCREEN_NO_PLATFORM = 'Cannot reach the platform, please come back later';
export const SCREEN_POWER_CUT = 'Power cut while adding money, please tap again';
/** Orders asked for on one tap. */
export const PENDING_MAX = 10;

// The faults the card simulates itself (card.credit failMode); a lost confirm is the kiosk's.
const CARD_FAULTS = Object.freeze(['power-cut-before-commit', 'power-cut-after-commit']);
const SETTLED_KEPT = 10_000;
const MAX_REF_LENGTH = 64;

// What became of the report of one write.
const CONFIRMED = 'CONFIRMED'; // the platform has it
const REFUSED = 'REFUSED'; // the platform answered no (e.g. the order was refunded meanwhile)
const UNREACHABLE = 'UNREACHABLE'; // no answer: try again at the next tap

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRef = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_REF_LENGTH;
const isOrder = (o) => isPlainObject(o) && isRef(o.orderId) && Number.isSafeInteger(o.amountSen) && o.amountSen > 0;

/**
 * True when the platform has really answered no about this request. Anything else (no
 * answer, a server failure, a refused signature or nonce, a school or kiosk switched off)
 * may pass later, so the write stays to be reported again.
 */
function isFinalRefusal(err) {
  return err.code !== 'NETWORK' && err.code !== 'REPLAY' && err.status < 500 && err.status !== 401 && err.status !== 403;
}

export class TopupKiosk extends Terminal {
  static deviceType = 'KIOSK';

  #api;
  #settled = new Set(); // kiosk txns the platform has answered about
  #queue = Promise.resolve(); // one card (or admin card) at a time

  /**
   * @param {object} options  the Terminal options, plus:
   * @param {{ pending: Function, confirm: Function, lookup: Function, packs: Function, receipts: Function }} options.api
   *   the signed kiosk API (createKioskApi in kioskApi.js); its calls reject with KioskApiError
   */
  constructor(options) {
    super(options);
    const api = options?.api;
    for (const name of ['pending', 'confirm', 'lookup', 'packs', 'receipts']) {
      if (typeof api?.[name] !== 'function') throw new TypeError(`api.${name} must be a function (see createKioskApi)`);
    }
    this.#api = api;
  }

  #exclusive(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * A student taps a card to collect the money waiting for it (DESIGN §3 kiosk rules).
   * Offline: nothing is read or written ("Cannot reach the platform"). Otherwise: read the card
   * (another school's or a damaged card is refused), publish card.readback and wait for its
   * PUBACK, re-confirm this kiosk's own unreported writes, fetch the waiting orders (a lost
   * card is refused), write and confirm them one by one, then note the kiosk's block-list
   * version on the card.
   * @param {import('./card.js').VirtualCard} card
   * @param {{ fault?: 'power-cut-before-commit'|'power-cut-after-commit'|'confirm-timeout' }} [options]
   *   a lab fault, applied to the first order only
   * @returns {Promise<{ ok: boolean, screen: string, reason?: string,
   *   added: Array<{ orderId: string, amountSen: number, kioskTxn: string, confirmed: boolean }>,
   *   readback: { records: object[], balanceSen: number } | null,
   *   reconfirmed: Array<{ orderId: string, kioskTxn: string, result: string }>,
   *   interrupted?: { orderId: string, amountSen: number, kioskTxn: string, committed: boolean } }>}
   *   added: written to the card on this tap (confirmed: the platform has the report);
   *   interrupted: the order a power cut hit (committed: the money did reach the card)
   * @throws {LabError} FAULT_INVALID for an unknown fault
   */
  async tap(card, { fault } = {}) {
    if (fault != null && !KIOSK_FAULTS.includes(fault)) {
      throw new LabError('FAULT_INVALID', `fault must be one of ${KIOSK_FAULTS.join(', ')}`, 400);
    }
    return this.#exclusive(() => this.#tap(card, fault ?? null));
  }

  async #tap(card, fault) {
    const added = [];
    const reconfirmed = [];
    let readback = null;
    const refuse = (reason, text) => ({ ...this._refuse(reason, text, 'error'), added, readback, reconfirmed });

    if (!this.connected) return refuse('OFFLINE', SCREEN_NO_PLATFORM);
    let memory;
    try {
      memory = this._readCard(card);
    } catch (err) {
      if (err instanceof CardError) return refuse(err.code, SCREEN_CARD_UNAVAILABLE);
      throw err;
    }
    const digest = this._digestOf(memory.uid);
    // What the card carries goes up first: purchases made on offline machines come home this
    // way, and the platform can check its mirror against the balance on the chip.
    const delivered = await this.publishUp('card.readback', {
      card: digest,
      last4: last4(memory.uid),
      balanceSen: memory.balanceSen,
      cardSeq: memory.cardSeq,
      listVersionOnCard: memory.listVersionOnCard,
      records: memory.records,
      writes: memory.writes,
    });
    if (!delivered) return refuse('OFFLINE', SCREEN_NO_PLATFORM);
    readback = { records: memory.records, balanceSen: memory.balanceSen };

    // Earlier writes of this kiosk the platform never heard about (a power cut right after
    // the write, a confirm that got lost) are reported now, under their own kiosk txn.
    for (const write of memory.writes) {
      if (!this.#ownUnsettled(write)) continue;
      const outcome = await this.#reportAdded({
        orderId: write.orderId,
        amountSen: write.amountSen,
        card: digest,
        balanceAfterOnCardSen: memory.balanceSen,
        kioskTxn: write.kioskTxn,
      });
      if (outcome === UNREACHABLE) return refuse('OFFLINE', SCREEN_NO_PLATFORM);
      reconfirmed.push({ orderId: write.orderId, kioskTxn: write.kioskTxn, result: outcome });
    }

    let pending;
    try {
      pending = await this.#api.pending({ card: digest, max: PENDING_MAX });
    } catch (err) {
      if (!(err instanceof LabError)) throw err;
      // A lost or retired card (CARD_NOT_ACTIVE), or one the platform does not know.
      if (err.code === 'CARD_NOT_ACTIVE' || err.code === 'CARD_NOT_FOUND') return refuse(err.code, SCREEN_CARD_UNAVAILABLE);
      return refuse('OFFLINE', SCREEN_NO_PLATFORM);
    }

    let balanceSen = memory.balanceSen;
    let stopped = null;
    const orders = Array.isArray(pending?.orders) ? pending.orders : [];
    for (const [i, order] of orders.entries()) {
      const outcome = await this.#addOrder(card, order, { digest, uid: memory.uid, balanceSen, fault: i === 0 ? fault : null });
      if (outcome.added) {
        added.push(outcome.added);
        balanceSen = outcome.balanceSen;
      }
      if (outcome.stop) {
        stopped = outcome;
        break;
      }
    }
    if (stopped?.stop === 'POWER_CUT') {
      // The kiosk is dark: nothing more happens on this tap.
      return { ...refuse('POWER_CUT', SCREEN_POWER_CUT), interrupted: stopped.interrupted };
    }
    if (stopped?.stop === 'CARD') return refuse(stopped.reason, SCREEN_CARD_UNAVAILABLE);
    try {
      this._setCardListVersion(card);
    } catch (err) {
      if (!(err instanceof CardError)) throw err;
    }
    const total = added.reduce((sum, a) => sum + a.amountSen, 0);
    const text = added.length > 0
      ? `Added ${formatRM(total)} · Balance ${formatRM(balanceSen)}`
      : `Nothing to add · Balance ${formatRM(balanceSen)}`;
    return { ok: true, screen: this.screen(text, added.length > 0 ? 'ok' : 'info'), added, readback, reconfirmed };
  }

  /**
   * Write one order to the card and report it.
   * @returns {Promise<{ added?: object, balanceSen?: number, stop?: string|null, reason?: string, interrupted?: object }>}
   */
  async #addOrder(card, order, { digest, uid, balanceSen, fault }) {
    if (!isOrder(order)) return {};
    const { orderId, amountSen } = order;
    const kioskTxn = this.nextTxn();
    const report = { orderId, amountSen, card: digest, kioskTxn };
    let credit;
    try {
      credit = this._creditCard(card, {
        amountSen,
        write: { orderId, kioskTxn, at: this._iso() },
        failMode: CARD_FAULTS.includes(fault) ? fault : undefined,
      });
    } catch (err) {
      if (err instanceof PowerCutError) {
        if (err.committed) {
          // On the card, but the kiosk lost power before it could say so: the next tap finds
          // the write on the card and reports it then.
          this.#cardWrite(uid, amountSen, balanceSen + amountSen);
        } else {
          // Nothing reached the card; once the power is back the kiosk reports the failure.
          await this.#call(() => this.#api.confirm({ ...report, result: 'FAILED', balanceAfterOnCardSen: balanceSen }));
        }
        return { stop: 'POWER_CUT', interrupted: { orderId, amountSen, kioskTxn, committed: err.committed } };
      }
      if (err instanceof CardError && err.code === 'ALREADY_WRITTEN') {
        // Written on an earlier tap. Only that write's own report can settle it; another
        // kiosk's write is left to that kiosk (or the school office).
        const earlier = err.detail?.write;
        if (this.#ownUnsettled(earlier)) {
          const outcome = await this.#reportAdded({ ...report, amountSen: earlier.amountSen, balanceAfterOnCardSen: balanceSen, kioskTxn: earlier.kioskTxn });
          if (outcome === UNREACHABLE) return { stop: 'UNREACHABLE' };
        }
        return {};
      }
      if (err instanceof CardError) return { stop: 'CARD', reason: err.code };
      throw err;
    }
    this.#cardWrite(uid, amountSen, credit.balanceAfterSen);
    const outcome = await this.#reportAdded(
      { ...report, balanceAfterOnCardSen: credit.balanceAfterSen },
      { firstLost: fault === 'confirm-timeout' },
    );
    return {
      added: { orderId, amountSen, kioskTxn, confirmed: outcome === CONFIRMED },
      balanceSen: credit.balanceAfterSen,
      stop: outcome === UNREACHABLE ? 'UNREACHABLE' : null,
    };
  }

  /**
   * Report a write (result ADDED). With no answer, look the kiosk txn up and resend the same
   * confirm if the platform has nothing; the card is never written again.
   * `firstLost` (lab fault 'confirm-timeout'): the first confirm never reaches the platform.
   * @returns {Promise<'CONFIRMED'|'REFUSED'|'UNREACHABLE'>}
   */
  async #reportAdded(args, { firstLost = false } = {}) {
    const confirm = () => this.#api.confirm({ ...args, result: 'ADDED' });
    const first = firstLost ? { ok: false, final: false } : await this.#call(confirm);
    if (first.ok) return this.#settle(args.kioskTxn, CONFIRMED);
    if (first.final) return this.#settle(args.kioskTxn, REFUSED);
    const found = await this.#call(() => this.#api.lookup(args.kioskTxn));
    if (!found.ok) return found.final ? this.#settle(args.kioskTxn, REFUSED) : UNREACHABLE;
    if (found.value) return this.#settle(args.kioskTxn, CONFIRMED);
    const again = await this.#call(confirm);
    if (again.ok) return this.#settle(args.kioskTxn, CONFIRMED);
    return again.final ? this.#settle(args.kioskTxn, REFUSED) : UNREACHABLE;
  }

  /** One API call: { ok: true, value } or { ok: false, final, error } for an expected failure. */
  async #call(fn) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (!(err instanceof LabError)) throw err;
      return { ok: false, final: isFinalRefusal(err), error: err };
    }
  }

  #settle(kioskTxn, outcome) {
    this.#settled.add(kioskTxn);
    if (this.#settled.size > SETTLED_KEPT) this.#settled.delete(this.#settled.values().next().value);
    return outcome;
  }

  /** A write this kiosk made (its txn names this kiosk) that the platform has not answered about yet. */
  #ownUnsettled(write) {
    if (!isPlainObject(write) || !isRef(write.kioskTxn) || !isOrder({ orderId: write.orderId, amountSen: write.amountSen })) return false;
    return parseDeviceTxnNo(write.kioskTxn)?.device === this.deviceCode && !this.#settled.has(write.kioskTxn);
  }

  #cardWrite(uid, amountSen, balanceAfterSen) {
    this._emit('card.write', { device: this.deviceCode, uid, kind: 'credit', amountSen, balanceAfterSen });
  }

  // ---- admin card ---------------------------------------------------------------------

  /**
   * Load the school's admin card with a new token and the platform's current packs
   * (api.packs()), for staff to carry to machines with no network.
   * @param {import('./adminCard.js').AdminCard} adminCard
   * @returns {Promise<{ ok: boolean, screen: string, reason?: string, token?: number,
   *   packs?: Array<{ kind: string, version: number }> }>}
   */
  async loadAdminCard(adminCard) {
    if (!adminCard || typeof adminCard.load !== 'function') throw new TypeError('adminCard must be an AdminCard');
    return this.#exclusive(async () => {
      if (adminCard.schoolCode !== this.schoolCode) return this._refuse('WRONG_SCHOOL', SCREEN_CARD_UNAVAILABLE, 'error');
      if (!this.connected) return this._refuse('OFFLINE', SCREEN_NO_PLATFORM, 'error');
      let answer;
      try {
        answer = await this.#api.packs();
      } catch (err) {
        if (err instanceof LabError) return this._refuse(err.code, SCREEN_NO_PLATFORM, 'error');
        throw err;
      }
      try {
        adminCard.load({ token: answer?.token, packs: answer?.packs, loadedAt: this._iso(), school: answer?.school });
      } catch (err) {
        // The answer does not fit the card (another school's packs, a malformed pack): the
        // card keeps what it had.
        if (err instanceof CardError || err instanceof TypeError) return this._refuse('PACKS_INVALID', 'Admin card could not be loaded', 'error');
        throw err;
      }
      const packs = answer.packs.map((p) => ({ kind: p.kind, version: p.version }));
      this._emit('admin-card.loaded', { device: this.deviceCode, token: answer.token, packs });
      const text = `Admin card loaded · token ${answer.token} · ${packs.length} pack${packs.length === 1 ? '' : 's'}`;
      return { ok: true, screen: this.screen(text, 'ok'), token: answer.token, packs };
    });
  }

  /**
   * Upload the receipts machines wrote on the admin card (api.receipts()). The card hands them
   * over; if the upload fails they go back on the card for the next try.
   * @param {import('./adminCard.js').AdminCard} adminCard
   * @returns {Promise<{ ok: boolean, screen: string, reason?: string, uploaded?: number, recorded?: number }>}
   */
  async uploadAdminCardReceipts(adminCard) {
    if (!adminCard || typeof adminCard.takeReceipts !== 'function') throw new TypeError('adminCard must be an AdminCard');
    return this.#exclusive(async () => {
      if (adminCard.schoolCode !== this.schoolCode) return this._refuse('WRONG_SCHOOL', SCREEN_CARD_UNAVAILABLE, 'error');
      if (!this.connected) return this._refuse('OFFLINE', SCREEN_NO_PLATFORM, 'error');
      const receipts = adminCard.takeReceipts();
      if (receipts.length === 0) return { ok: true, screen: this.screen('No receipts on the admin card', 'info'), uploaded: 0, recorded: 0 };
      let answer;
      try {
        answer = await this.#api.receipts({ token: adminCard.token, receipts });
      } catch (err) {
        for (const r of receipts) adminCard.addReceipt(r);
        if (err instanceof LabError) return this._refuse(err.code, SCREEN_NO_PLATFORM, 'error');
        throw err;
      }
      const recorded = Number.isSafeInteger(answer?.recorded) ? answer.recorded : receipts.length;
      const text = `Admin card receipts uploaded · ${receipts.length}`;
      return { ok: true, screen: this.screen(text, 'ok'), uploaded: receipts.length, recorded };
    });
  }
}
