import { LabError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { canonicalJson } from '../shared/crypto.js';
import { isSen, waterChargeSen } from '../shared/money.js';
import { parseDeviceTxnNo, validateRecord } from '../shared/protocol.js';
import { DAY, klDay, parseIso } from '../shared/time.js';

// Settlement (docs/DESIGN.md §4.6): every purchase record a canteen reader or water
// machine reports. The card is the wallet, so by the time a record arrives the money has
// already left the card. The platform keeps each record once per (origin machine, txn),
// mirrors it in the books (DR the member's wallet, CR sales payable) and opens a
// difference for a person whenever something does not add up, while still posting what
// the card was really charged.
//
// The same record can arrive over MQTT, in a journal batch, in a kiosk read-back of the
// card or from a USB file, in any order: the first copy counts, later copies are
// duplicates. Only a record the platform cannot place at all (malformed, or naming a
// machine the school does not have) is refused.

/** How a record reached the platform (purchase.via). Only MQTT is live; the rest are catch-up. */
export const PURCHASE_VIAS = Object.freeze(['MQTT', 'JOURNAL_BATCH', 'KIOSK_READBACK', 'USB_IMPORT']);

/** A record reaching the platform more than this long after the sale is late, even over MQTT. */
const LATE_AFTER_MS = DAY;
// One posting moves at most RM 10,000,000 (ledger.js). A record charging more is broken or
// forged; it is refused here instead of making the books throw halfway through.
const MAX_RECORD_SEN = 1_000_000_000;
// The txn becomes part of the posting's idemKey; an envelope's own txn has the same limit.
const MAX_TXN_LENGTH = 64;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isId = (v) => typeof v === 'string' && v.length > 0;
// SQLite cannot bind undefined; a missing id must match nothing, not crash the query.
const asId = (v) => (isId(v) ? v : null);
const given = (v) => v !== undefined && v !== null && v !== '';

const refused = (code, message) => ({ status: 'REFUSED', code, message, differences: [] });

/**
 * Step 1 on the record alone: validateRecord() plus the limits the platform's own storage
 * needs (validateRecord leaves txn length and amounts open-ended).
 * @returns {string|null} what is wrong, or null
 */
function recordProblem(record) {
  const check = validateRecord(record);
  if (!check.ok) return check.message;
  if (record.txn.length > MAX_TXN_LENGTH) return `txn must be at most ${MAX_TXN_LENGTH} characters`;
  // '<origin>-<6+ digits>' allows any number of digits; the number itself must stay exact
  if (!Number.isSafeInteger(parseDeviceTxnNo(record.txn).n)) return 'txn number is too large';
  if (record.amountSen > MAX_RECORD_SEN) return `amountSen must be at most ${MAX_RECORD_SEN} sen`;
  if (record.kind === 'SALE') {
    for (const it of record.items) {
      // validateRecord reads the code through String(), so the number 123 would pass as "123"
      if (typeof it.code !== 'string') return 'item code must be text';
      if (it.priceSen > MAX_RECORD_SEN) return `item priceSen must be at most ${MAX_RECORD_SEN} sen`;
    }
  }
  return null;
}

/** Top-level fields that differ between two records, so a person sees what changed. */
function changedFields(a, b) {
  const encoded = (o, k) => (Object.hasOwn(o, k) ? canonicalJson(o[k]) : undefined);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => encoded(a, k) !== encoded(b, k));
}

/** Lab-clock ms of 00:00 in Kuala Lumpur on `day` ('YYYY-MM-DD'). Codes: DAY_INVALID (400). */
function klDayStart(day) {
  const ms = typeof day === 'string' && DAY_RE.test(day) ? Date.parse(`${day}T00:00:00.000+08:00`) : NaN;
  // Date.parse would roll 2026-02-30 over into March; reading the day back catches that
  if (Number.isNaN(ms) || klDay(ms) !== day) throw new LabError('DAY_INVALID', 'day must be a date written YYYY-MM-DD', 400);
  return ms;
}

/** Routes may pass the query string's text ('20'); anything unusable means the default. */
function listLimit(limit) {
  const asked = Number(limit);
  return Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
}

/**
 * @typedef {{ status: 'POSTED'|'FLAGGED'|'DUPLICATE'|'REFUSED', purchaseId?: string, code?: string,
 *   message?: string, differences: string[] }} ReceiveResult
 *   `code`: RECORD_INVALID or UNKNOWN_ORIGIN_DEVICE (REFUSED), CONFLICT (DUPLICATE with other content).
 *   `message` explains a refusal. `differences`: the kinds found for this record, in step order.
 * @typedef {{ id: string, originDeviceCode: string, txn: string, via: string, kind: 'SALE'|'WATER',
 *   memberId: string|null, memberName: string|null, amountSen: number, ml: number|null,
 *   items: Array<{ code: string, qty: number, priceSen: number }>, priceVersion: number, listVersion: number,
 *   occurredAt: number, receivedAt: number, status: 'POSTED'|'FLAGGED', late: boolean }} PurchaseDto
 */

/**
 * Purchases reported by the terminals of every school. All functions are synchronous.
 * @param {object} ctx  see docs/DESIGN.md "The context object"
 * @param {{ ledger: object, schools: object, configs: object, devices: object, differences: object }} deps
 */
export function createSettlement(ctx, { ledger, schools, configs, devices, differences } = {}) {
  const { db, clock, events } = ctx;
  for (const [name, service] of Object.entries({ ledger, schools, configs, devices, differences })) {
    if (!service) throw new TypeError(`createSettlement needs the ${name} service`);
  }

  function insertPurchase(p, { status, cardId, memberId, postingId }) {
    const r = p.record;
    db.run(
      `INSERT INTO purchase (id, school_id, origin_device_code, device_txn, txn_number, uploader_device_id, via, kind,
         card_digest, card_id, member_id, amount_sen, ml, price_version, list_version, card_seq, balance_before_sen,
         balance_after_sen, occurred_at, received_at, status, posting_id, late, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, p.schoolId, r.origin, r.txn, p.txnNumber, p.uploaderId, p.via, r.kind,
      r.card, cardId, memberId, r.amountSen, r.kind === 'WATER' ? r.ml : null, r.priceVersion, r.listVersion, r.cardSeq, r.balanceBeforeSen,
      r.balanceAfterSen, p.occurredAt, p.receivedAt, status, postingId, p.late ? 1 : 0, p.raw,
    );
  }

  /**
   * Step 4: the amount against the price list version the machine says it used, not today's:
   * an offline machine may run an old list for days, and that is allowed.
   * @returns {[string, object] | null} difference kind and detail, or null when it checks out
   */
  function priceDifference(schoolId, record) {
    const version = configs.getVersion(schoolId, 'prices', record.priceVersion);
    if (!version) {
      const latestVersion = configs.current(schoolId, 'prices')?.version ?? 0;
      return ['PRICE_VERSION_UNKNOWN', { priceVersion: record.priceVersion, latestVersion }];
    }
    const problems = [];
    let expectedSen = 0; // what the list says the purchase costs; null when it cannot say
    if (record.kind === 'SALE') {
      const listed = new Map(version.content.items.map((i) => [i.code, i.priceSen]));
      let itemsSen = 0;
      for (const it of record.items) {
        itemsSen += it.qty * it.priceSen;
        const priceSen = listed.get(it.code);
        if (priceSen === undefined) {
          problems.push(`${it.code} is not on price list version ${version.version}`);
          expectedSen = null;
          continue;
        }
        if (it.priceSen !== priceSen) problems.push(`${it.code} charged at ${it.priceSen} sen, the list says ${priceSen} sen`);
        if (expectedSen !== null) expectedSen += it.qty * priceSen;
      }
      if (itemsSen !== record.amountSen) problems.push(`the items add up to ${itemsSen} sen, the record charged ${record.amountSen} sen`);
    } else {
      const { perLitreSen, minChargeSen } = version.content.water;
      if (record.perLitreSen !== perLitreSen) {
        problems.push(`water charged at ${record.perLitreSen} sen a litre, the list says ${perLitreSen} sen`);
      }
      expectedSen = waterChargeSen(record.ml, perLitreSen, minChargeSen);
      if (record.amountSen !== expectedSen) problems.push(`${record.ml} ml costs ${expectedSen} sen, the record charged ${record.amountSen} sen`);
    }
    if (problems.length === 0) return null;
    return ['PRICE_MISMATCH', { kind: record.kind, priceVersion: version.version, amountSen: record.amountSen, expectedSen, problems }];
  }

  /** Opens the differences found for a stored purchase; the result lists their kinds in step order. */
  function finish(p, status, found) {
    for (const [kind, ref, detail] of found) differences.open({ schoolId: p.schoolId, kind, ref, detail });
    return { status, purchaseId: p.id, differences: found.map(([kind]) => kind) };
  }

  /** Steps 2-8 of DESIGN.md §4.6 for a well-formed record from a known machine. Runs inside db.tx. */
  function settleInTx(p) {
    const { schoolId, record } = p;
    const { origin, txn } = record;
    const ref = `${origin}:${txn}`;

    // 2. Only the first copy counts. Looked up by the number, so the same txn written with
    //    more leading zeros is the same transaction, not a second purchase.
    const stored = db.get(
      'SELECT id, device_txn, raw FROM purchase WHERE school_id = ? AND origin_device_code = ? AND txn_number = ? ORDER BY rowid LIMIT 1',
      schoolId, origin, p.txnNumber,
    );
    if (stored) {
      if (stored.raw === p.raw) return { status: 'DUPLICATE', purchaseId: stored.id, differences: [] };
      const before = JSON.parse(stored.raw);
      const after = JSON.parse(p.raw);
      differences.open({
        schoolId,
        kind: 'DUPLICATE_CONFLICT',
        ref: `${origin}:${stored.device_txn}`,
        detail: { purchaseId: stored.id, changed: changedFields(before, after), stored: before, received: after },
      });
      return { status: 'DUPLICATE', purchaseId: stored.id, code: 'CONFLICT', differences: ['DUPLICATE_CONFLICT'] };
    }

    // 3. A card the school does not know: kept for a person, but there is no wallet to post to.
    const card = schools.getCardByDigest(schoolId, record.card);
    if (!card || !card.memberId) {
      insertPurchase(p, { status: 'FLAGGED', cardId: card?.id ?? null, memberId: null, postingId: null });
      return finish(p, 'FLAGGED', [['UNKNOWN_CARD', ref, { origin, txn, last4: record.last4, amountSen: record.amountSen }]]);
    }

    const found = [];
    // 4. Prices. A mismatch is still posted: the card was really charged that amount.
    const price = priceDifference(schoolId, record);
    if (price) found.push([price[0], ref, { origin, txn, ...price[1] }]);

    // 5. The card's own arithmetic.
    const expectedAfterSen = record.balanceBeforeSen - record.amountSen;
    if (expectedAfterSen !== record.balanceAfterSen) {
      const { balanceBeforeSen, amountSen, balanceAfterSen } = record;
      found.push(['BALANCE_CONTINUITY', ref, { origin, txn, balanceBeforeSen, amountSen, balanceAfterSen, expectedAfterSen }]);
    }

    // 6. Every change to a card raises its counter, so two different purchases with the same
    //    counter came from two chips holding the same memory: a copied card.
    const twins = db.all(
      'SELECT origin_device_code AS origin, device_txn AS txn FROM purchase WHERE school_id = ? AND card_digest = ? AND card_seq = ? ORDER BY rowid LIMIT 10',
      schoolId, record.card, record.cardSeq,
    );
    if (twins.length > 0) {
      found.push([
        'CARD_CLONE_SUSPECTED',
        `${record.card}:${record.cardSeq}`,
        { last4: record.last4, cardSeq: record.cardSeq, purchases: [...twins.map((tw) => ({ origin: tw.origin, txn: tw.txn })), { origin, txn }] },
      ]);
    }

    // 7. Used after the office reported the card lost (a report with no time cannot clear it).
    if (card.status === 'LOST' && (card.lostAt === null || p.occurredAt >= card.lostAt)) {
      const lostListVersion = card.lostListVersion;
      found.push(['SPENT_AFTER_LOST_REPORT', ref, {
        listVersionOnMachine: record.listVersion,
        lostListVersion,
        // No: the expected lost-card window of an offline machine. Yes: the machine already
        // held a list that blocks the card and sold anyway.
        machineHadUpdatedList: lostListVersion !== null && record.listVersion >= lostListVersion,
      }]);
    }

    // 8. Post what the card was charged, then store the purchase (a zero amount moves no money).
    let postingId = null;
    if (record.amountSen > 0) {
      const { posting } = ledger.post({
        schoolId,
        idemKey: `PURCHASE:${origin}:${txn}`,
        kind: 'PURCHASE',
        ref: p.id,
        memo: record.kind === 'SALE' ? `Sale ${txn}` : `Water ${record.ml} ml ${txn}`,
        lines: [
          { kind: 'STUDENT_WALLET', memberId: card.memberId, side: 'DR', amountSen: record.amountSen },
          { kind: 'SALES_PAYABLE', side: 'CR', amountSen: record.amountSen },
        ],
      });
      postingId = posting.id;
    }
    insertPurchase(p, { status: 'POSTED', cardId: card.id, memberId: card.memberId, postingId });
    // Only a purchase that moved money can have taken the wallet below zero.
    if (postingId !== null) {
      const walletSen = ledger.balance(schoolId, 'STUDENT_WALLET', card.memberId);
      if (walletSen < 0) {
        found.push(['MIRROR_NEGATIVE', `${card.memberId}:${txn}`, { memberId: card.memberId, origin, txn, amountSen: record.amountSen, walletSen }]);
      }
    }
    return finish(p, 'POSTED', found);
  }

  /** purchase.received data. Only short text from a refused record reaches the console. */
  function receivedEvent(record, via, result) {
    const r = record !== null && typeof record === 'object' && !Array.isArray(record) ? record : {};
    const short = (v) => (typeof v === 'string' ? v.slice(0, MAX_TXN_LENGTH) : null);
    const data = {
      purchaseId: result.purchaseId ?? null,
      origin: short(r.origin),
      txn: short(r.txn),
      status: result.status,
      amountSen: isSen(r.amountSen) ? r.amountSen : null,
      differences: [...result.differences],
      via,
    };
    if (result.code) data.code = result.code;
    return data;
  }

  /**
   * Take one purchase record from a terminal, whichever way it came (DESIGN.md §4.6 steps
   * 1-8). Never throws for a problem with the record: a record the platform cannot place is
   * REFUSED, a repeat is a DUPLICATE, a card the school does not know is stored FLAGGED, and
   * everything else is POSTED, with a difference opened for each check that failed. The
   * purchase row, its posting and its differences are written in one transaction.
   * `late` is set when `via` is not MQTT or the record arrives more than 24 h after its `at`.
   * Emits `purchase.received`.
   * @param {{ schoolId: string, uploaderDeviceId?: string|null, via: 'MQTT'|'JOURNAL_BATCH'|'KIOSK_READBACK'|'USB_IMPORT',
   *   record: unknown }} args  uploaderDeviceId: the machine that delivered it (null if none, e.g. a USB file)
   * @returns {ReceiveResult}
   * @throws {LabError} only for a broken call: SCHOOL_NOT_FOUND (404), VIA_INVALID (400),
   *   DEVICE_NOT_FOUND (404) when uploaderDeviceId is not a device of the school
   */
  function receive({ schoolId, uploaderDeviceId = null, via, record } = {}) {
    const school = schools.getSchool(schoolId);
    if (!school) throw new LabError('SCHOOL_NOT_FOUND', 'no such school', 404);
    if (!PURCHASE_VIAS.includes(via)) throw new LabError('VIA_INVALID', `via must be one of ${PURCHASE_VIAS.join(', ')}`);
    // the uploader is stored with the purchase, so it must be a machine of this school
    if (uploaderDeviceId != null && !devices.getDevice(school.id, uploaderDeviceId)) {
      throw new LabError('DEVICE_NOT_FOUND', 'the uploading device is not a device of this school', 404);
    }
    const result = settle(school.id, uploaderDeviceId ?? null, via, record);
    // Announced after our own transaction (or savepoint) has succeeded.
    events.emit('purchase.received', receivedEvent(record, via, result), school.code);
    return result;
  }

  function settle(schoolId, uploaderId, via, record) {
    // 1. A record the platform cannot read, or from a machine the school does not have.
    const problem = recordProblem(record);
    if (problem) return refused('RECORD_INVALID', problem);
    let raw;
    try {
      raw = canonicalJson(record);
    } catch {
      return refused('RECORD_INVALID', 'record must be plain JSON');
    }
    if (!devices.getDeviceByCode(schoolId, record.origin)) {
      return refused('UNKNOWN_ORIGIN_DEVICE', `${record.origin} is not a machine of this school`);
    }
    const receivedAt = clock.now();
    const occurredAt = parseIso(record.at);
    const incoming = {
      id: newId('pur'),
      schoolId,
      uploaderId,
      via,
      record,
      raw,
      txnNumber: parseDeviceTxnNo(record.txn).n,
      occurredAt,
      receivedAt,
      late: via !== 'MQTT' || receivedAt - occurredAt > LATE_AFTER_MS,
    };
    return db.tx(() => settleInTx(incoming));
  }

  const purchaseDto = (row) => {
    const record = JSON.parse(row.raw);
    return {
      id: row.id,
      originDeviceCode: row.origin_device_code,
      txn: row.device_txn,
      via: row.via,
      kind: row.kind,
      memberId: row.member_id ?? null,
      memberName: row.member_name ?? null,
      amountSen: row.amount_sen,
      ml: row.ml ?? null,
      // only the fields the record format defines, never whatever else a machine added
      items: row.kind === 'SALE' ? record.items.map(({ code, qty, priceSen }) => ({ code, qty, priceSen })) : [],
      priceVersion: row.price_version,
      listVersion: row.list_version,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      status: row.status,
      late: row.late === 1,
    };
  };

  /**
   * The school's purchases, newest sale first (by when it happened, so a late record takes
   * its place in the history). `memberId` and `deviceCode` (the origin machine) narrow the
   * list; `limit` is 1-1000, default 100.
   * @param {string} schoolId
   * @param {{ limit?: number|string, memberId?: string, deviceCode?: string }} [options]
   * @returns {PurchaseDto[]}
   */
  function listPurchases(schoolId, options = {}) {
    const { limit = DEFAULT_LIST_LIMIT, memberId, deviceCode } = options ?? {};
    const where = ['p.school_id = ?'];
    const params = [asId(schoolId)];
    if (given(memberId)) {
      where.push('p.member_id = ?');
      params.push(String(memberId));
    }
    if (given(deviceCode)) {
      // office input may be typed in lower case; device codes are stored in upper case
      where.push('p.origin_device_code = ?');
      params.push(String(deviceCode).trim().toUpperCase());
    }
    return db
      .all(
        `SELECT p.*, m.name AS member_name FROM purchase p
         LEFT JOIN member m ON m.id = p.member_id AND m.school_id = p.school_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.occurred_at DESC, p.received_at DESC, p.rowid DESC LIMIT ?`,
        ...params, listLimit(limit),
      )
      .map(purchaseDto);
  }

  /**
   * Sales of one Kuala Lumpur day (default today), by when they happened. Counts POSTED
   * purchases only, so the total matches what the books owe the operators; FLAGGED ones
   * (unknown cards) wait for a person. `byItem` lists canteen items; water is in `byDevice`.
   * Codes: DAY_INVALID (400) unless `day` is 'YYYY-MM-DD'.
   * @param {string} schoolId
   * @param {{ day?: string }} [options]
   * @returns {{ day: string, totalSen: number, count: number,
   *   byDevice: Array<{ deviceCode: string, kind: string, count: number, totalSen: number }>,
   *   byItem: Array<{ code: string, qty: number, totalSen: number }> }}
   */
  function salesReport(schoolId, options = {}) {
    const { day } = options ?? {};
    const reportDay = given(day) ? day : klDay(clock.now());
    const from = klDayStart(reportDay);
    const rows = db.all(
      `SELECT origin_device_code, kind, amount_sen, raw FROM purchase
       WHERE school_id = ? AND status = 'POSTED' AND occurred_at >= ? AND occurred_at < ?
       ORDER BY origin_device_code, kind, occurred_at, rowid`,
      asId(schoolId), from, from + DAY, // Malaysia keeps no daylight saving: a KL day is always 24 h
    );
    let totalSen = 0;
    const byDevice = new Map();
    const byItem = new Map();
    for (const row of rows) {
      totalSen += row.amount_sen;
      const key = `${row.origin_device_code}/${row.kind}`;
      const device = byDevice.get(key) ?? { deviceCode: row.origin_device_code, kind: row.kind, count: 0, totalSen: 0 };
      device.count += 1;
      device.totalSen += row.amount_sen;
      byDevice.set(key, device);
      if (row.kind !== 'SALE') continue;
      for (const it of JSON.parse(row.raw).items) {
        const item = byItem.get(it.code) ?? { code: it.code, qty: 0, totalSen: 0 };
        item.qty += it.qty;
        item.totalSen += it.qty * it.priceSen;
        byItem.set(it.code, item);
      }
    }
    return {
      day: reportDay,
      totalSen,
      count: rows.length,
      byDevice: [...byDevice.values()],
      byItem: [...byItem.values()].sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0)),
    };
  }

  return { receive, listPurchases, salesReport };
}
