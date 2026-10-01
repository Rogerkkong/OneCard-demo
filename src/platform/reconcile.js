import { LabError } from '../shared/errors.js';
import { isSen } from '../shared/money.js';
import { deviceTxnNo } from '../shared/protocol.js';
import { DAY } from '../shared/time.js';

// Reconciliation (docs/DESIGN.md §4.7): the platform's books against what the cards and
// machines say. A check never changes money; it opens a difference for a person: a card
// balance that differs from its mirror, transaction numbers that never arrived, and
// machines still running an old block list (the window in which a lost card still works).
// Opening the same (school, kind, ref) twice is a no-op, so the scans can run on every
// jobs tick and only report what is new.

/** How old the current block list may get before machines still behind it are flagged. */
export const DEFAULT_LIST_MAX_AGE_MS = DAY;

const DIGEST_RE = /^[0-9a-f]{64}$/;

// For each origin machine, every run of transaction numbers missing between two numbers
// the platform did receive. Nothing before the first or after the last one is guessed at.
const GAPS_SQL = `
  SELECT origin, prev + 1 AS from_n, n - 1 AS to_n
  FROM (
    SELECT origin_device_code AS origin, txn_number AS n,
           lag(txn_number) OVER (PARTITION BY origin_device_code ORDER BY txn_number) AS prev
    FROM (SELECT DISTINCT origin_device_code, txn_number FROM purchase WHERE school_id = ?)
  )
  WHERE prev IS NOT NULL AND n > prev + 1
  ORDER BY origin, from_n`;

const isId = (v) => typeof v === 'string' && v.length > 0;
// SQLite cannot bind undefined; a missing id must match nothing, not crash the query.
const asId = (v) => (isId(v) ? v : null);
const snapshotInvalid = (message) => new LabError('SNAPSHOT_INVALID', message, 400);

/** What a person should look at first, by which way the card and the books differ. */
function mismatchHint(cardSen, mirrorSen) {
  return cardSen > mirrorSen
    ? 'The card holds more than the books. Look for a kiosk top-up that reached the card but was never confirmed ' +
        '(for example a power cut), purchases made with a copy of this card (CARD_CLONE_SUSPECTED), or a card that was ' +
        'replaced after its balance moved to the new one.'
    : 'The card holds less than the books. Purchases made with it have not all reached the platform yet: they arrive ' +
        'by journal upload, kiosk read-back or USB import (see MISSING_RECORDS). Otherwise a top-up was booked as added ' +
        'but never reached the card.';
}

/**
 * Reconciliation checks for every school. All functions are synchronous.
 * @param {object} ctx  see docs/DESIGN.md "The context object"
 * @param {{ ledger: object, schools: object, configs: object, devices?: object, differences: object }} deps
 *   the same services as settlement (devices is accepted for the uniform signature; no check needs it yet)
 */
export function createReconcile(ctx, { ledger, schools, configs, differences } = {}) {
  const { db, clock } = ctx;
  for (const [name, service] of Object.entries({ ledger, schools, configs, differences })) {
    if (!service) throw new TypeError(`createReconcile needs the ${name} service`);
  }

  /**
   * Compare what a card says it holds (a kiosk read-back) with the platform's mirror of the
   * member's wallet. A mismatch opens BALANCE_MISMATCH (ref `<digest>:<cardSeq>`), once per
   * card counter. A card the school does not know (or with no member) has no mirror:
   * `{ match: false, mirrorSen: null }` and no difference (its purchases are already FLAGGED).
   * `writes` are the kiosk top-ups the card itself records (the read-back's `writes`). A write
   * whose order is still PAID or PARKED reached the card but was never confirmed (a power cut
   * after the write): the money is on the card but not yet in the books, and the kiosk confirms
   * it right after the read-back. Those amounts (`unconfirmedSen`) are left out of the card's
   * side, so a power cut does not raise a false BALANCE_MISMATCH. Refunded or unknown orders are
   * never left out.
   * `readAt` is when the card was read (the read-back's time, ms). The kiosk writes and confirms
   * this tap's top-ups right after the read-back, and the confirm can reach the books before the
   * read-back does (the broker acknowledges a message before delivering it). Top-ups confirmed
   * as written to this card at or after `readAt`, and not among its writes, were not on the card
   * when it was read: their amounts (`laterSen`) are left out of the books' side.
   * Codes: SNAPSHOT_INVALID (400) for a malformed digest, balance, counter, writes list or time.
   * @param {{ schoolId: string, cardDigest: string, balanceSen: number, cardSeq: number,
   *   writes?: Array<{ orderId: string, amountSen: number }>, readAt?: number }} args
   * @returns {{ match: boolean, mirrorSen: number|null, cardSen: number, unconfirmedSen: number, laterSen: number }}
   */
  function checkCardSnapshot(args) {
    const { schoolId, cardDigest, balanceSen, cardSeq, writes = [], readAt } = args ?? {};
    if (typeof cardDigest !== 'string' || !DIGEST_RE.test(cardDigest)) throw snapshotInvalid('cardDigest must be a 64-character card digest');
    if (!isSen(balanceSen)) throw snapshotInvalid('balanceSen must be whole sen, 0 or more');
    // a new card that was never written has counter 0
    if (!Number.isSafeInteger(cardSeq) || cardSeq < 0) throw snapshotInvalid('cardSeq must be a whole number, 0 or more');
    if (!Array.isArray(writes) || writes.length > 50) throw snapshotInvalid('writes must be a list of at most 50 card writes');
    for (const w of writes) {
      if (!w || typeof w.orderId !== 'string' || w.orderId.length === 0 || w.orderId.length > 64 || !isSen(w.amountSen)) {
        throw snapshotInvalid('each write needs an orderId and amountSen in whole sen');
      }
    }
    if (readAt !== undefined && (!Number.isSafeInteger(readAt) || readAt < 0)) throw snapshotInvalid('readAt must be a time in ms');
    const card = schools.getCardByDigest(schoolId, cardDigest);
    if (!card || !card.memberId) return { match: false, mirrorSen: null, cardSen: balanceSen, unconfirmedSen: 0, laterSen: 0 };
    const unconfirmedSen = unconfirmedWritesSen(schoolId, card.memberId, writes);
    const laterSen = readAt === undefined ? 0 : laterWritesSen(schoolId, card, writes, readAt);
    const mirrorSen = ledger.balance(schoolId, 'STUDENT_WALLET', card.memberId);
    const cardSide = balanceSen - unconfirmedSen;
    const booksSide = mirrorSen - laterSen;
    const match = cardSide === booksSide;
    if (!match) {
      differences.open({
        schoolId,
        kind: 'BALANCE_MISMATCH',
        ref: `${cardDigest}:${cardSeq}`,
        detail: {
          memberId: card.memberId,
          last4: card.last4,
          cardSeq,
          cardSen: balanceSen,
          unconfirmedSen,
          mirrorSen,
          laterSen,
          differenceSen: cardSide - booksSide,
          hint: mismatchHint(cardSide, booksSide),
        },
      });
    }
    return { match, mirrorSen, cardSen: balanceSen, unconfirmedSen, laterSen };
  }

  /**
   * Sum of the card's own top-up writes whose orders (of this member, in this school) the
   * platform still holds as PAID or PARKED — written to the card but not yet confirmed. The
   * amount is the order's, and only counted when the card records the same amount.
   */
  function unconfirmedWritesSen(schoolId, memberId, writes) {
    const seen = new Set();
    let total = 0;
    for (const w of writes) {
      if (seen.has(w.orderId)) continue;
      seen.add(w.orderId);
      const order = db.get(
        "SELECT amount_sen FROM topup_order WHERE school_id = ? AND id = ? AND member_id = ? AND status IN ('PAID', 'PARKED')",
        asId(schoolId), w.orderId, memberId,
      );
      if (order && order.amount_sen === w.amountSen) total += order.amount_sen;
    }
    return total;
  }

  /**
   * Sum of the top-ups a kiosk confirmed as written to this very card at or after `readAt`
   * that the card did not list among its writes: written after the card was read. Orders a
   * person marked ADDED have no card, so they are never left out.
   */
  function laterWritesSen(schoolId, card, writes, readAt) {
    const listed = new Set(writes.map((w) => w.orderId));
    let total = 0;
    for (const order of db.all(
      "SELECT id, amount_sen FROM topup_order WHERE school_id = ? AND member_id = ? AND card_id = ? AND status = 'ADDED' AND added_at >= ?",
      asId(schoolId), card.memberId, card.id, readAt,
    )) {
      if (!listed.has(order.id)) total += order.amount_sen;
    }
    return total;
  }

  /**
   * For each origin machine, the transaction numbers missing between the lowest and the
   * highest one received: one MISSING_RECORDS difference per run of consecutive missing
   * numbers (ref `<origin>:<from>-<to>`, e.g. `CANTEEN-01:5-7`; one number is `5-5`).
   * @param {string} schoolId
   * @returns {number} differences opened by this scan (ranges already open are not counted)
   */
  function scanGaps(schoolId) {
    return db.tx(() => {
      let opened = 0;
      for (const gap of db.all(GAPS_SQL, asId(schoolId))) {
        const { origin, from_n: from, to_n: to } = gap;
        const detail = { origin, from, to, count: to - from + 1, fromTxn: deviceTxnNo(origin, from), toTxn: deviceTxnNo(origin, to) };
        if (differences.open({ schoolId, kind: 'MISSING_RECORDS', ref: `${origin}:${from}-${to}`, detail }).created) opened += 1;
      }
      return opened;
    });
  }

  /**
   * Machines whose applied block-list version is below the current one, once the current
   * version is older than `maxAgeMs` (it has had time to reach them by MQTT or admin card):
   * OLD_BLOCK_LIST, ref `<deviceCode>:<currentVersion>`. Version 0 (the school never had a
   * list) has nothing to lag behind. An unusable `maxAgeMs` means the default, 24 h.
   * @param {string} schoolId
   * @param {{ maxAgeMs?: number }} [options]
   * @returns {number} differences opened by this scan
   */
  function scanListLag(schoolId, options = {}) {
    const { maxAgeMs = DEFAULT_LIST_MAX_AGE_MS } = options ?? {};
    const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_LIST_MAX_AGE_MS;
    const current = configs.current(schoolId, 'blocklist');
    if (!current || current.version === 0 || !(clock.now() - current.createdAt > maxAge)) return 0;
    return db.tx(() => {
      let opened = 0;
      for (const s of configs.listStates(schoolId)) {
        if (s.kind !== 'blocklist' || s.appliedVersion >= current.version) continue;
        const detail = {
          deviceCode: s.deviceCode,
          appliedVersion: s.appliedVersion,
          currentVersion: current.version,
          currentSince: current.createdAt,
          reportedVia: s.via,
          reportedAt: s.updatedAt,
        };
        const ref = `${s.deviceCode}:${current.version}`;
        if (differences.open({ schoolId, kind: 'OLD_BLOCK_LIST', ref, detail }).created) opened += 1;
      }
      return opened;
    });
  }

  /**
   * Both scans, as the jobs timer runs them.
   * @param {string} schoolId
   * @returns {{ gaps: number, lag: number }} differences opened by each scan
   */
  function run(schoolId) {
    return { gaps: scanGaps(schoolId), lag: scanListLag(schoolId) };
  }

  return { checkCardSnapshot, scanGaps, scanListLag, run };
}
