import { LabError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { canonicalJson, safeEqual, sha256hex, signPayload } from '../shared/crypto.js';
import { isSen } from '../shared/money.js';
import { DAY, MINUTE, klDay, klMonth, parseIso } from '../shared/time.js';
import { ACCOUNT_KINDS } from './ledger.js';

// Money on its way to a card (docs/DESIGN.md §4.5): parent top-ups paid online, school
// subsidies, and balance transfers to a replacement card. Only the kiosk can put money on
// a card, so each of them is an order whose money waits on the platform ("waiting to be
// added") until the student taps there:
//
//   TOPUP     CREATED ──paid──► PAID ──kiosk──► ADDED
//               ├─ the bank says no ──► FAILED
//               └─ not paid by payBy ─► CANCELLED      (a late payment still lands: → PAID)
//   SUBSIDY   PAID ──kiosk──► ADDED
//   TRANSFER  PAID ──kiosk──► ADDED                      (never expires)
//
//   PAID past addBy: no write tried, or the write failed ─► EXPIRED ─► REFUNDED
//                    a write was tried but never confirmed ─► PARKED: the money may already
//                    be on the card, so a person decides (resolveParked)
//
// The status says where an order's money is; the ledger moves it, once per step, under the
// idemKeys of DESIGN.md §2 (`<KIND>:<orderId>:PAID|GRANTED|CREATED|ADDED|REVERSAL`), so a
// repeated callback, confirm or job run can never move it twice.
//
// Events are emitted inside the transactions that make the change: the event bus holds them
// back until the outermost commit and drops them on a rollback (shared/events.js).

/** Order kinds, as in the topup_order table. */
export const ORDER_KINDS = Object.freeze(['TOPUP', 'SUBSIDY', 'TRANSFER']);
/** Order statuses, as in the topup_order table (EXPIRED only ever lasts inside a refund). */
export const ORDER_STATUSES = Object.freeze(['CREATED', 'PAID', 'ADDED', 'CANCELLED', 'FAILED', 'EXPIRED', 'REFUNDED', 'PARKED']);

/**
 * How each kind of order puts its money in WAITING_TO_BE_ADDED (DESIGN.md §2 postings): the
 * step named in the idemKey, and the account the money comes from.
 */
const FUNDING = Object.freeze({
  TOPUP: Object.freeze({ step: 'PAID', from: 'CASH_RECEIVED' }),
  SUBSIDY: Object.freeze({ step: 'GRANTED', from: 'SCHOOL_SUBSIDY' }),
  TRANSFER: Object.freeze({ step: 'CREATED', from: 'STUDENT_WALLET' }),
});

/** What the books say when an order's funding is undone. */
const REFUND_MEMO = Object.freeze({
  TOPUP: 'refund sent to parent (mock)',
  SUBSIDY: 'subsidy not added in time: returned to the school',
  TRANSFER: 'transfer undone: returned to the wallet',
});

// A successful payment is accepted while the order still waits for one, and also after we
// gave up on it (CANCELLED, FAILED): the provider took the parent's money, so it must land.
const PAYABLE = new Set(['CREATED', 'CANCELLED', 'FAILED']);
// Orders whose amount counts against a member's daily and monthly top-up limits.
const LIMITED_STATUSES = "('CREATED','PAID','ADDED','PARKED')";

const DEFAULT_PENDING = 10;
const MAX_PENDING = 50;
const DEFAULT_LIST = 100;
const MAX_LIST = 1000;
const MAX_KEY = 200; // idempotency keys, provider txn ids, device codes
const MAX_KIOSK_TXN = 64; // the kiosk client's own limit (one URL path segment)
const MAX_NOTE = 500;
// One order moves at most what one ledger posting may move (RM 10,000,000).
const MAX_ORDER_SEN = 1_000_000_000;

const isId = (v) => typeof v === 'string' && v.length > 0;
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Start of the Kuala Lumpur month that `ms` falls in (Malaysia is UTC+8 all year). */
const klMonthStart = (ms) => parseIso(`${klMonth(ms)}-01T00:00:00.000+08:00`);

/** A count from a request: a positive whole number up to `most`, otherwise `fallback`. */
function boundedCount(value, fallback, most) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, most) : fallback;
}

/** Same rule as the schools service: who did it, as short text. */
function actorText(actor) {
  if (typeof actor === 'string' && actor.trim()) return actor.trim().slice(0, 120);
  if (actor && typeof actor === 'object' && (actor.id || actor.name)) {
    return [actor.name, actor.id && `(${actor.id})`].filter(Boolean).join(' ').slice(0, 120);
  }
  return 'system';
}

/** Staff notes are kept, never refused: trimmed, cut to MAX_NOTE, null when empty. */
function noteText(note) {
  if (note === undefined || note === null) return null;
  return String(note).trim().slice(0, MAX_NOTE) || null;
}

/** Lines that put an order's money in WAITING_TO_BE_ADDED (DESIGN.md §2). */
function fundingLines(kind, memberId, amountSen) {
  const from = FUNDING[kind].from;
  return [
    { kind: from, memberId: ACCOUNT_KINDS[from].perMember ? memberId : null, side: 'DR', amountSen },
    { kind: 'WAITING_TO_BE_ADDED', memberId, side: 'CR', amountSen },
  ];
}

/** Kiosk added money to the card: DR WAITING_TO_BE_ADDED / CR STUDENT_WALLET. */
const addedLines = (memberId, amountSen) => [
  { kind: 'WAITING_TO_BE_ADDED', memberId, side: 'DR', amountSen },
  { kind: 'STUDENT_WALLET', memberId, side: 'CR', amountSen },
];

/**
 * When the parent paid, for the add window: the provider's time (ms or ISO-8601), kept
 * between the order's creation and now (it cannot have been paid outside them). A missing or
 * unreadable time is now, when we heard of the payment.
 */
function paidTime(paidAt, createdAt, now) {
  const ms = typeof paidAt === 'number' ? paidAt : parseIso(paidAt);
  if (!Number.isSafeInteger(ms)) return now;
  return Math.min(Math.max(ms, createdAt), now);
}

/**
 * Top-up orders, subsidies and transfers. All functions are synchronous.
 * @param {object} ctx  see docs/DESIGN.md "The context object"
 * @param {{ ledger: object, schools: object, differences: object }} services
 */
export function createTopups(ctx, { ledger, schools, differences } = {}) {
  if (!ledger || !schools || !differences) throw new TypeError('createTopups needs { ledger, schools, differences }');
  const { db, clock, events } = ctx;

  const schoolCode = (schoolId) => db.get('SELECT code FROM school WHERE id = ?', schoolId)?.code ?? null;

  // The member's name always comes from the order's own school.
  const ORDER_SELECT = `
    SELECT o.*, m.name AS member_name
    FROM topup_order o
    JOIN member m ON m.id = o.member_id AND m.school_id = o.school_id`;

  const orderDto = (row) =>
    row
      ? {
          id: row.id,
          schoolId: row.school_id,
          kind: row.kind,
          parentId: row.parent_id ?? null,
          memberId: row.member_id,
          memberName: row.member_name,
          amountSen: row.amount_sen,
          status: row.status,
          createdAt: row.created_at,
          payBy: row.pay_by ?? null,
          paidAt: row.paid_at ?? null,
          addBy: row.add_by ?? null,
          writeAttemptAt: row.write_attempt_at ?? null,
          writeResult: row.write_result ?? null,
          addedAt: row.added_at ?? null,
          addedByDevice: row.added_by_device ?? null,
          kioskTxn: row.kiosk_txn ?? null,
          balanceAfterOnCardSen: row.balance_after_on_card ?? null,
          resolvedBy: row.resolved_by ?? null,
          resolutionNote: row.resolution_note ?? null,
        }
      : null;

  const orderRow = (schoolId, orderId) =>
    isId(schoolId) && isId(orderId) ? db.get(`${ORDER_SELECT} WHERE o.school_id = ? AND o.id = ?`, schoolId, orderId) : undefined;

  function requireOrder(schoolId, orderId) {
    const row = orderRow(schoolId, orderId);
    if (!row) throw new LabError('ORDER_NOT_FOUND', 'no such order in this school', 404);
    return row;
  }

  function requireMember(schoolId, memberId) {
    const member = schools.getMember(schoolId, memberId);
    if (!member) throw new LabError('MEMBER_NOT_FOUND', 'no such member in this school', 404);
    return member;
  }

  /** `topup.status` for an order that is now `status` (a new order counts as a change too). */
  const announceStatus = (row, status) =>
    events.emit('topup.status', { orderId: row.id, kind: row.kind, status, amountSen: row.amount_sen }, schoolCode(row.school_id));

  function setStatus(row, status) {
    db.run('UPDATE topup_order SET status = ? WHERE school_id = ? AND id = ?', status, row.school_id, row.id);
    announceStatus(row, status);
  }

  function postFunding(row, memo) {
    const { step } = FUNDING[row.kind];
    ledger.post({
      schoolId: row.school_id,
      idemKey: `${row.kind}:${row.id}:${step}`,
      kind: `${row.kind}_${step}`,
      ref: row.id,
      memo,
      lines: fundingLines(row.kind, row.member_id, row.amount_sen),
    });
  }

  function postAdded(row, memo) {
    ledger.post({
      schoolId: row.school_id,
      idemKey: `${row.kind}:${row.id}:ADDED`,
      kind: `${row.kind}_ADDED`,
      ref: row.id,
      memo,
      lines: addedLines(row.member_id, row.amount_sen),
    });
  }

  /** Undo the order's funding (reversal of its PAID/GRANTED/CREATED posting) and mark it REFUNDED. */
  function refund(row) {
    const { step } = FUNDING[row.kind];
    const funding = ledger.findByIdemKey(row.school_id, `${row.kind}:${row.id}:${step}`);
    // Every PAID order was funded in the same transaction that made it PAID.
    if (!funding) throw new LabError('ORDER_POSTING_MISSING', `order ${row.id} has no ${step} posting to reverse`, 500);
    setStatus(row, 'REFUNDED');
    ledger.reverse({ schoolId: row.school_id, postingId: funding.id, idemKey: `${row.kind}:${row.id}:REVERSAL`, memo: REFUND_MEMO[row.kind] });
    events.emit(
      'topup.refunded',
      { orderId: row.id, kind: row.kind, amountSen: row.amount_sen, parentId: row.parent_id ?? null },
      schoolCode(row.school_id),
    );
  }

  /**
   * A kiosk txn names one write, so one order (the schema's unique index on school, kiosk
   * and kiosk txn): refuse a reused one clearly instead of failing on the index.
   */
  function requireFreeKioskTxn(row, deviceCode, kioskTxn) {
    const clash = db.get(
      'SELECT 1 FROM topup_order WHERE school_id = ? AND added_by_device = ? AND kiosk_txn = ? AND id <> ?',
      row.school_id, deviceCode, kioskTxn, row.id,
    );
    if (clash) throw new LabError('KIOSK_TXN_REUSED', `kiosk txn ${kioskTxn} was already used for another order`, 409, { kioskTxn });
  }

  /** Amounts of the member's top-ups that count against the limits, today and this month (KL time). */
  function usedLimits(schoolId, memberId, now) {
    const rows = db.all(
      `SELECT amount_sen, created_at FROM topup_order
       WHERE school_id = ? AND member_id = ? AND kind = 'TOPUP' AND status IN ${LIMITED_STATUSES} AND created_at >= ?`,
      schoolId, memberId, klMonthStart(now),
    );
    const day = klDay(now);
    const month = klMonth(now);
    let daySen = 0;
    let monthSen = 0;
    for (const r of rows) {
      if (klMonth(r.created_at) !== month) continue;
      monthSen += r.amount_sen;
      if (klDay(r.created_at) === day) daySen += r.amount_sen;
    }
    return { daySen, monthSen };
  }

  function signatureValid(payload) {
    if (!isPlainObject(payload) || typeof payload.signature !== 'string') return false;
    const { signature, ...signed } = payload;
    try {
      canonicalJson(signed);
    } catch {
      return false; // not plain JSON, so the provider cannot have signed it
    }
    return safeEqual(signature, signPayload(ctx.settings.providerSecret, signed));
  }

  return {
    /**
     * A parent asks to top up a linked child's card. The order waits for payment until payBy.
     * Codes: IDEMPOTENCY_KEY_REQUIRED, AMOUNT_INVALID (not whole sen), NOT_LINKED (403),
     * CARD_NOT_ACTIVE (409), AMOUNT_OUT_OF_RANGE, DAILY_LIMIT, MONTHLY_LIMIT,
     * IDEMPOTENCY_KEY_REUSED (409). The same (parentId, idemKey) with the same request returns
     * the order made the first time, whatever has happened to it since.
     * @param {{ parentId: string, schoolId: string, memberId: string, amountSen: number, idemKey: string }} args
     * @returns order DTO
     */
    createOrder({ parentId, schoolId, memberId, amountSen, idemKey } = {}) {
      if (!isText(idemKey, MAX_KEY)) {
        throw new LabError('IDEMPOTENCY_KEY_REQUIRED', `an idempotency key of 1 to ${MAX_KEY} characters is required`);
      }
      if (!Number.isSafeInteger(amountSen)) throw new LabError('AMOUNT_INVALID', 'amountSen must be a whole number of sen');
      if (!isId(parentId) || !isId(schoolId) || !isId(memberId)) {
        throw new LabError('NOT_LINKED', 'you can only top up a child the school has linked to you', 403);
      }
      const requestHash = sha256hex(canonicalJson({ schoolId, memberId, amountSen }));

      return db.tx(() => {
        // Keys belong to the parent, who spans schools, so this one lookup is by parent. The
        // hash covers the school, so another school's order is never returned.
        const earlier = db.get('SELECT id, request_hash FROM topup_order WHERE parent_id = ? AND idem_key = ?', parentId, idemKey);
        if (earlier) {
          if (earlier.request_hash !== requestHash) {
            throw new LabError('IDEMPOTENCY_KEY_REUSED', 'this idempotency key was already used for a different top-up', 409);
          }
          // Checked before the limits on purpose: the first order already counts against them.
          return orderDto(orderRow(schoolId, earlier.id));
        }
        if (!schools.isLinked(parentId, schoolId, memberId)) {
          throw new LabError('NOT_LINKED', 'you can only top up a child the school has linked to you', 403);
        }
        if (!schools.activeCardForMember(schoolId, memberId)) {
          throw new LabError('CARD_NOT_ACTIVE', 'this child has no active card to add the money to', 409);
        }
        const limits = schools.schoolSettings(schoolId).topup;
        if (amountSen < limits.minSen || amountSen > limits.maxSen) {
          throw new LabError('AMOUNT_OUT_OF_RANGE', `a top-up must be ${limits.minSen} to ${limits.maxSen} sen`, 400, {
            minSen: limits.minSen,
            maxSen: limits.maxSen,
            amountSen,
          });
        }
        const now = clock.now();
        const used = usedLimits(schoolId, memberId, now);
        if (used.daySen + amountSen > limits.dailyMaxSen) {
          throw new LabError('DAILY_LIMIT', 'this would go over the daily top-up limit', 400, {
            limitSen: limits.dailyMaxSen,
            usedSen: used.daySen,
            remainingSen: Math.max(0, limits.dailyMaxSen - used.daySen),
          });
        }
        if (used.monthSen + amountSen > limits.monthlyMaxSen) {
          throw new LabError('MONTHLY_LIMIT', 'this would go over the monthly top-up limit', 400, {
            limitSen: limits.monthlyMaxSen,
            usedSen: used.monthSen,
            remainingSen: Math.max(0, limits.monthlyMaxSen - used.monthSen),
          });
        }
        const id = newId('ord');
        db.run(
          `INSERT INTO topup_order (id, school_id, kind, parent_id, member_id, amount_sen, status, idem_key, request_hash, created_at, created_by, pay_by)
           VALUES (?, ?, 'TOPUP', ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)`,
          id, schoolId, parentId, memberId, amountSen, idemKey, requestHash, now, `parent:${parentId}`, now + limits.payWindowMinutes * MINUTE,
        );
        const row = orderRow(schoolId, id);
        announceStatus(row, 'CREATED');
        return orderDto(row);
      });
    },

    /**
     * The payment provider's signed callback. FAILED: CREATED -> FAILED. SUCCESS: CREATED,
     * CANCELLED or FAILED -> PAID (addBy = paidAt + addWindowDays), posting TOPUP:<id>:PAID.
     * The provider repeating a callback (same providerTxnId) changes nothing.
     * Codes: PAYMENT_SIGNATURE_INVALID (401), PAYMENT_INVALID (malformed signed payload),
     * ORDER_NOT_FOUND (404), PAYMENT_AMOUNT_MISMATCH, ORDER_ALREADY_PAID (409: paid under
     * another providerTxnId).
     * @param {{ orderId: string, provider: string, providerTxnId: string, result: 'SUCCESS'|'FAILED',
     *   paidAmountSen: number, paidAt: number|string, signature: string }} payload
     * @returns order DTO
     */
    paymentCallback(payload) {
      if (!signatureValid(payload)) throw new LabError('PAYMENT_SIGNATURE_INVALID', 'the payment callback signature does not match', 401);
      const { orderId, providerTxnId, result, paidAmountSen, paidAt } = payload;
      if (result !== 'SUCCESS' && result !== 'FAILED') throw new LabError('PAYMENT_INVALID', 'result must be SUCCESS or FAILED');
      if (result === 'SUCCESS' && !isText(providerTxnId, MAX_KEY)) {
        throw new LabError('PAYMENT_INVALID', 'a successful payment needs the provider transaction id');
      }
      // The provider knows only the order id (random, unique across schools); everything
      // after this lookup works inside the order's own school. Only top-ups are paid for.
      const found = isId(orderId) ? db.get("SELECT school_id FROM topup_order WHERE id = ? AND kind = 'TOPUP'", orderId) : undefined;
      if (!found) throw new LabError('ORDER_NOT_FOUND', 'no such top-up order', 404);

      return db.tx(() => {
        const row = requireOrder(found.school_id, orderId);
        if (result === 'FAILED') {
          // Only an order still waiting for its payment can fail; a late FAILED never undoes a payment.
          if (row.status === 'CREATED') setStatus(row, 'FAILED');
          return orderDto(orderRow(row.school_id, row.id));
        }
        if (paidAmountSen !== row.amount_sen) {
          throw new LabError('PAYMENT_AMOUNT_MISMATCH', `paid ${paidAmountSen} sen for an order of ${row.amount_sen} sen`, 400, {
            amountSen: row.amount_sen,
            paidAmountSen,
          });
        }
        if (PAYABLE.has(row.status)) {
          const paid = paidTime(paidAt, row.created_at, clock.now());
          const { addWindowDays } = schools.schoolSettings(row.school_id).topup;
          db.run(
            'UPDATE topup_order SET paid_at = ?, provider_txn_id = ?, add_by = ? WHERE school_id = ? AND id = ?',
            paid, providerTxnId, paid + addWindowDays * DAY, row.school_id, row.id,
          );
          setStatus(row, 'PAID');
          postFunding(row, `parent payment ${providerTxnId}`);
        } else if (row.provider_txn_id !== providerTxnId) {
          throw new LabError('ORDER_ALREADY_PAID', 'this order was already paid under another provider transaction', 409);
        }
        // else: the provider repeated its callback; nothing changes
        return orderDto(orderRow(row.school_id, row.id));
      });
    },

    /**
     * The kiosk read a card: who it belongs to and what to write on it. Lists the member's
     * PAID orders not past addBy, oldest first, at most `max` (1-50), and marks each one
     * writeResult UNCONFIRMED until the kiosk confirms it. `kioskDeviceId` is the asking kiosk
     * (authenticated by the caller).
     * Codes: CARD_NOT_FOUND (404), CARD_NOT_ACTIVE (409, LOST or RETIRED card).
     * @returns {{ member: { id: string, name: string }, orders: Array<{ orderId: string, kind: string, amountSen: number }>,
     *   mirrorBalanceSen: number, waitingSen: number }}
     */
    kioskPending({ schoolId, cardDigest, max = DEFAULT_PENDING } = {}) {
      const card = schools.getCardByDigest(schoolId, cardDigest);
      if (!card || !card.memberId) throw new LabError('CARD_NOT_FOUND', 'this card is not registered in this school', 404);
      if (card.status !== 'ACTIVE') throw new LabError('CARD_NOT_ACTIVE', `card is ${card.status}, not ACTIVE`, 409);
      const member = requireMember(schoolId, card.memberId);
      const limit = boundedCount(max, DEFAULT_PENDING, MAX_PENDING);

      return db.tx(() => {
        const now = clock.now();
        const rows = db.all(
          `SELECT id, kind, amount_sen FROM topup_order
           WHERE school_id = ? AND member_id = ? AND status = 'PAID' AND (add_by IS NULL OR add_by >= ?)
           ORDER BY created_at, rowid LIMIT ?`,
          schoolId, member.id, now, limit,
        );
        // From here until the kiosk confirms, the write may or may not have happened.
        for (const r of rows) {
          db.run("UPDATE topup_order SET write_attempt_at = ?, write_result = 'UNCONFIRMED' WHERE school_id = ? AND id = ?", now, schoolId, r.id);
        }
        const { walletSen, waitingSen } = ledger.memberBalances(schoolId, member.id);
        return {
          member: { id: member.id, name: member.name },
          orders: rows.map((r) => ({ orderId: r.id, kind: r.kind, amountSen: r.amount_sen })),
          mirrorBalanceSen: walletSen,
          waitingSen,
        };
      });
    },

    /**
     * The kiosk reports one write. ADDED on PAID or PARKED -> ADDED, posting <KIND>:<id>:ADDED.
     * The same kiosk and kioskTxn again -> `duplicate: true`. FAILED on PAID/PARKED only notes
     * writeResult FAILED. Codes: CONFIRM_INVALID, ORDER_NOT_FOUND (404), ORDER_CARD_MISMATCH,
     * ORDER_AMOUNT_MISMATCH, ORDER_NOT_PAID (409), KIOSK_TXN_REUSED (409), ORDER_ALREADY_ADDED
     * (409, opens DOUBLE_ADD_SUSPECTED), ORDER_ALREADY_REFUNDED (409, opens
     * TOPUP_ADDED_AFTER_REFUND). Call it outside a transaction: the difference is kept although
     * the call fails.
     * @param {{ schoolId: string, kioskDeviceId: string, kioskDeviceCode: string, orderId: string,
     *   result: 'ADDED'|'FAILED', amountSen: number, cardDigest: string, balanceAfterOnCardSen: number,
     *   kioskTxn: string }} args
     * @returns {{ orderId: string, status: string, duplicate: boolean }}
     */
    kioskConfirm({ schoolId, kioskDeviceCode, orderId, result, amountSen, cardDigest, balanceAfterOnCardSen, kioskTxn } = {}) {
      if (result !== 'ADDED' && result !== 'FAILED') throw new LabError('CONFIRM_INVALID', 'result must be ADDED or FAILED');
      if (result === 'ADDED') {
        if (!isText(kioskDeviceCode, MAX_KEY)) throw new LabError('CONFIRM_INVALID', 'the kiosk device code is missing');
        if (!isText(kioskTxn, MAX_KIOSK_TXN)) throw new LabError('CONFIRM_INVALID', `kioskTxn must be 1 to ${MAX_KIOSK_TXN} characters`);
        if (!isSen(balanceAfterOnCardSen)) throw new LabError('CONFIRM_INVALID', 'balanceAfterOnCardSen must be whole sen, 0 or more');
      }

      const outcome = db.tx(() => {
        const row = requireOrder(schoolId, orderId);
        const card = schools.getCardByDigest(schoolId, cardDigest);
        if (!card || card.memberId !== row.member_id) {
          throw new LabError('ORDER_CARD_MISMATCH', 'this order is not for the card that was written', 400);
        }
        if (amountSen !== row.amount_sen) {
          throw new LabError('ORDER_AMOUNT_MISMATCH', `the order is for ${row.amount_sen} sen, not ${amountSen}`, 400, { amountSen: row.amount_sen });
        }
        const reply = (status, duplicate = false) => ({ reply: { orderId: row.id, status, duplicate } });

        if (result === 'FAILED') {
          // Nothing reached the card; the order keeps waiting (or keeps waiting for a person).
          if (row.status === 'PAID' || row.status === 'PARKED') {
            db.run("UPDATE topup_order SET write_result = 'FAILED' WHERE school_id = ? AND id = ?", row.school_id, row.id);
          }
          return reply(row.status);
        }

        const suspect = (kind, error) => ({
          problem: {
            error,
            difference: {
              schoolId: row.school_id,
              kind,
              ref: `${row.id}:${kioskDeviceCode}:${kioskTxn}`,
              detail: {
                orderId: row.id,
                orderKind: row.kind,
                memberId: row.member_id,
                amountSen: row.amount_sen,
                status: row.status,
                addedByDevice: row.added_by_device ?? null,
                addedKioskTxn: row.kiosk_txn ?? null,
                reportedByDevice: kioskDeviceCode,
                reportedKioskTxn: kioskTxn,
                balanceAfterOnCardSen,
                cardLast4: card.last4,
              },
            },
          },
        });

        switch (row.status) {
          case 'PAID':
          case 'PARKED': {
            requireFreeKioskTxn(row, kioskDeviceCode, kioskTxn);
            // The kiosk is kept by its code: kioskLookup is asked by code, and codes are unique per school.
            db.run(
              `UPDATE topup_order SET write_result = 'ADDED', added_at = ?, added_by_device = ?, kiosk_txn = ?, card_id = ?, balance_after_on_card = ?
               WHERE school_id = ? AND id = ?`,
              clock.now(), kioskDeviceCode, kioskTxn, card.id, balanceAfterOnCardSen, row.school_id, row.id,
            );
            setStatus(row, 'ADDED');
            postAdded(row, `added to the card by ${kioskDeviceCode} (${kioskTxn})`);
            return reply('ADDED');
          }
          case 'ADDED': {
            if (row.added_by_device === kioskDeviceCode && row.kiosk_txn === kioskTxn) return reply('ADDED', true);
            if (row.kiosk_txn === null) {
              // A person marked this parked order ADDED after checking the card; this is the
              // kiosk's own report of that write, arriving late. The money was booked then.
              requireFreeKioskTxn(row, kioskDeviceCode, kioskTxn);
              db.run(
                `UPDATE topup_order SET write_result = 'ADDED', added_by_device = ?, kiosk_txn = ?, card_id = ?, balance_after_on_card = ?
                 WHERE school_id = ? AND id = ?`,
                kioskDeviceCode, kioskTxn, card.id, balanceAfterOnCardSen, row.school_id, row.id,
              );
              return reply('ADDED', true);
            }
            return suspect('DOUBLE_ADD_SUSPECTED', new LabError('ORDER_ALREADY_ADDED', 'this order was already added to the card by another write', 409));
          }
          case 'EXPIRED':
          case 'REFUNDED':
            return suspect(
              'TOPUP_ADDED_AFTER_REFUND',
              new LabError('ORDER_ALREADY_REFUNDED', 'this order was refunded; the money must not be on the card', 409),
            );
          default: // CREATED, CANCELLED, FAILED: never paid, so there was nothing to add
            throw new LabError('ORDER_NOT_PAID', `order is ${row.status}: there is no money to add`, 409);
        }
      });

      if (outcome.problem) {
        // Kept apart from the order's transaction, so the error below cannot roll it back.
        db.tx(() => differences.open(outcome.problem.difference));
        throw outcome.problem.error;
      }
      return outcome.reply;
    },

    /**
     * What the platform recorded for a kiosk write, by the kiosk's own txn number (the kiosk
     * asks after a confirm timed out, instead of writing again).
     * @returns {{ orderId: string, status: string } | null}
     */
    kioskLookup({ schoolId, kioskDeviceCode, kioskTxn } = {}) {
      if (!isId(schoolId) || !isId(kioskDeviceCode) || !isId(kioskTxn)) return null;
      const row = db.get(
        'SELECT id, status FROM topup_order WHERE school_id = ? AND added_by_device = ? AND kiosk_txn = ?',
        schoolId, kioskDeviceCode, kioskTxn,
      );
      return row ? { orderId: row.id, status: row.status } : null;
    },

    /**
     * The school gives a member money, waiting at the kiosk until addBy (now + addWindowDays).
     * Posts SUBSIDY:<id>:GRANTED; the note goes to the posting memo and the audit trail.
     * Codes: AMOUNT_INVALID, MEMBER_NOT_FOUND (404).
     * @returns order DTO (kind SUBSIDY, status PAID)
     */
    grantSubsidy({ schoolId, memberId, amountSen, actor, note } = {}) {
      if (!Number.isSafeInteger(amountSen) || amountSen <= 0 || amountSen > MAX_ORDER_SEN) {
        throw new LabError('AMOUNT_INVALID', `amountSen must be a whole number of sen from 1 to ${MAX_ORDER_SEN}`);
      }
      const who = actorText(actor);
      const text = noteText(note);
      return db.tx(() => {
        requireMember(schoolId, memberId);
        const { addWindowDays } = schools.schoolSettings(schoolId).topup;
        const now = clock.now();
        const id = newId('ord');
        db.run(
          `INSERT INTO topup_order (id, school_id, kind, parent_id, member_id, amount_sen, status, created_at, created_by, paid_at, add_by)
           VALUES (?, ?, 'SUBSIDY', NULL, ?, ?, 'PAID', ?, ?, ?, ?)`,
          id, schoolId, memberId, amountSen, now, who, now, now + addWindowDays * DAY,
        );
        const row = orderRow(schoolId, id);
        announceStatus(row, 'PAID');
        postFunding(row, text ?? 'school subsidy');
        schools.audit(schoolId, who, 'subsidy.grant', { orderId: id, memberId, amountSen, note: text });
        return orderDto(row);
      });
    },

    /**
     * Move the member's whole mirror wallet into an order waiting for the replacement card
     * (posting TRANSFER:<id>:CREATED). It never expires: the money is the student's.
     * Code: MEMBER_NOT_FOUND (404).
     * @returns order DTO (kind TRANSFER, status PAID, addBy null), or null if the wallet is 0 or less
     */
    createTransfer({ schoolId, memberId, actor } = {}) {
      const who = actorText(actor);
      return db.tx(() => {
        requireMember(schoolId, memberId);
        const walletSen = ledger.balance(schoolId, 'STUDENT_WALLET', memberId);
        if (walletSen <= 0) return null;
        const now = clock.now();
        const id = newId('ord');
        db.run(
          `INSERT INTO topup_order (id, school_id, kind, parent_id, member_id, amount_sen, status, created_at, created_by, paid_at, add_by)
           VALUES (?, ?, 'TRANSFER', NULL, ?, ?, 'PAID', ?, ?, ?, NULL)`,
          id, schoolId, memberId, walletSen, now, who, now,
        );
        const row = orderRow(schoolId, id);
        announceStatus(row, 'PAID');
        postFunding(row, 'balance moved to a replacement card');
        schools.audit(schoolId, who, 'transfer.create', { orderId: id, memberId, amountSen: walletSen });
        return orderDto(row);
      });
    },

    /**
     * Scheduled work: CREATED past payBy -> CANCELLED; PAID past addBy with no write tried, or a
     * failed one -> EXPIRED -> REFUNDED (funding reversed, `topup.refunded`); PAID past addBy
     * with an unconfirmed write -> PARKED. Every school when no `schoolId` is given (whatever its
     * status: the platform calls it per ACTIVE school), otherwise only that school; a `schoolId`
     * that is not an id matches no school, so a request that lost its school never runs them all.
     * Each order is its own transaction.
     * @param {{ schoolId?: string }} [options]
     * @returns {{ cancelled: number, refunded: number, parked: number }}
     */
    runJobs(options = {}) {
      const { schoolId } = options ?? {};
      const now = clock.now();
      const counts = { cancelled: 0, refunded: 0, parked: 0 };
      let schoolIds;
      if (schoolId === undefined) schoolIds = db.all('SELECT id FROM school ORDER BY created_at, rowid').map((r) => r.id);
      else schoolIds = isId(schoolId) ? [schoolId] : [];
      for (const sid of schoolIds) {
        const unpaid = db.all("SELECT id FROM topup_order WHERE school_id = ? AND status = 'CREATED' AND pay_by < ? ORDER BY pay_by, rowid", sid, now);
        for (const { id } of unpaid) {
          // Each order is checked again inside its own transaction: an event subscriber may
          // have acted on it after the previous order's events went out.
          const done = db.tx(() => {
            const row = orderRow(sid, id);
            if (!row || row.status !== 'CREATED' || !(row.pay_by < now)) return null;
            setStatus(row, 'CANCELLED');
            return 'cancelled';
          });
          if (done) counts[done]++;
        }
        const late = db.all(
          "SELECT id FROM topup_order WHERE school_id = ? AND status = 'PAID' AND add_by IS NOT NULL AND add_by < ? ORDER BY add_by, rowid",
          sid, now,
        );
        for (const { id } of late) {
          const done = db.tx(() => {
            const row = orderRow(sid, id);
            if (!row || row.status !== 'PAID' || row.add_by === null || !(row.add_by < now)) return null;
            // The kiosk may have written it and lost the reply: a person must check the card.
            if (row.write_result === 'UNCONFIRMED') {
              setStatus(row, 'PARKED');
              return 'parked';
            }
            setStatus(row, 'EXPIRED');
            refund(row);
            return 'refunded';
          });
          if (done) counts[done]++;
        }
      }
      return counts;
    },

    /**
     * A person decides a PARKED order after checking the card: ADDED (the money is on it,
     * posting <KIND>:<id>:ADDED) or REFUND (funding reversed, `topup.refunded`).
     * Codes: DECISION_INVALID, ORDER_NOT_FOUND (404), ORDER_NOT_PARKED (409).
     * @returns order DTO
     */
    resolveParked({ schoolId, orderId, decision, actor, note } = {}) {
      if (decision !== 'ADDED' && decision !== 'REFUND') throw new LabError('DECISION_INVALID', 'decision must be ADDED or REFUND');
      const who = actorText(actor);
      const text = noteText(note);
      return db.tx(() => {
        const row = requireOrder(schoolId, orderId);
        if (row.status !== 'PARKED') throw new LabError('ORDER_NOT_PARKED', `order is ${row.status}, not PARKED`, 409);
        db.run('UPDATE topup_order SET resolved_by = ?, resolution_note = ? WHERE school_id = ? AND id = ?', who, text, row.school_id, row.id);
        if (decision === 'ADDED') {
          // writeResult stays UNCONFIRMED: the kiosk never confirmed; a person did.
          db.run('UPDATE topup_order SET added_at = ? WHERE school_id = ? AND id = ?', clock.now(), row.school_id, row.id);
          setStatus(row, 'ADDED');
          postAdded(row, `confirmed on the card by ${who}`);
        } else {
          refund(row);
        }
        schools.audit(schoolId, who, 'topup.resolve', { orderId: row.id, kind: row.kind, decision, amountSen: row.amount_sen, note: text });
        return orderDto(orderRow(row.school_id, row.id));
      });
    },

    /** @returns order DTO, or null if there is no such order in this school */
    getOrder(schoolId, id) {
      return orderDto(orderRow(schoolId, id)) ?? null;
    },

    /**
     * Newest first. Needs a school or a parent (a parent's own orders span schools); with
     * neither it returns nothing rather than every school's orders.
     * @param {{ schoolId?: string, parentId?: string, memberId?: string, status?: string, kind?: string, limit?: number }} [filter]
     */
    listOrders(filter = {}) {
      const { schoolId, parentId, memberId, status, kind, limit = DEFAULT_LIST } = filter ?? {};
      const given = (v) => v !== undefined && v !== null && v !== '';
      const where = [];
      const params = [];
      if (given(schoolId)) { where.push('o.school_id = ?'); params.push(String(schoolId)); }
      if (given(parentId)) { where.push('o.parent_id = ?'); params.push(String(parentId)); }
      if (where.length === 0) return [];
      if (given(memberId)) { where.push('o.member_id = ?'); params.push(String(memberId)); }
      if (given(status)) { where.push('o.status = ?'); params.push(String(status)); }
      if (given(kind)) { where.push('o.kind = ?'); params.push(String(kind)); }
      const n = boundedCount(limit, DEFAULT_LIST, MAX_LIST);
      return db
        .all(`${ORDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC, o.rowid DESC LIMIT ?`, ...params, n)
        .map(orderDto);
    },

    /**
     * The member's mirror wallet and waiting money, kept apart, and the orders waiting
     * (PAID, and PARKED ones a person has not decided yet), oldest first.
     * Code: MEMBER_NOT_FOUND (404).
     * @returns {{ mirrorBalanceSen: number, waitingSen: number, waitingOrders: object[] }}
     */
    memberSummary(schoolId, memberId) {
      requireMember(schoolId, memberId);
      const { walletSen, waitingSen } = ledger.memberBalances(schoolId, memberId);
      const waitingOrders = db
        .all(`${ORDER_SELECT} WHERE o.school_id = ? AND o.member_id = ? AND o.status IN ('PAID','PARKED') ORDER BY o.created_at, o.rowid`, schoolId, memberId)
        .map(orderDto);
      return { mirrorBalanceSen: walletSen, waitingSen, waitingOrders };
    },
  };
}
