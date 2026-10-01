import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualCard, CardError, PowerCutError, CARD_WRITES_KEPT, FAIL_MODES, CARD_ERROR_CODES } from '../../src/devices/card.js';
import { LabError } from '../../src/shared/errors.js';
import { cardDigest, cardMac, last4, randomSecret } from '../../src/shared/crypto.js';
import { CARD_RECORDS_KEPT, deviceTxnNo, validateRecord } from '../../src/shared/protocol.js';
import { createClock } from '../../src/shared/clock.js';

// All school codes, card UIDs and order ids below are fictional; keys are generated.

const SCHOOL = 'smk-alpha';
const OTHER_SCHOOL = 'smk-beta';
const UID = '04A1B2C3D4E5F6';
const KEY = randomSecret();
const OTHER_KEY = randomSecret();
const clock = createClock({ mode: 'manual' });

/** assert.throws matcher for a CardError code. */
const cardError = (code) => (err) => {
  assert.ok(err instanceof CardError, `expected CardError ${code}, got ${err}`);
  assert.equal(err.code, code);
  return true;
};
/** assert.throws matcher for a LabError code that is not a CardError. */
const labError = (code) => (err) => {
  assert.ok(err instanceof LabError && !(err instanceof CardError), `expected LabError ${code}, got ${err}`);
  assert.equal(err.code, code);
  return true;
};

const newCard = (options = {}) => new VirtualCard({ uid: UID, schoolCode: SCHOOL, cardKey: KEY, ...options });

/** A canteen sale record as a reader builds it: without cardSeq and the two balances. */
function saleRecord(n, amountSen = 350) {
  return {
    txn: deviceTxnNo('CANTEEN-01', n),
    origin: 'CANTEEN-01',
    kind: 'SALE',
    card: cardDigest(KEY, SCHOOL, UID),
    last4: last4(UID),
    amountSen,
    items: [{ code: 'NASI-LEMAK', qty: 1, priceSen: amountSen }],
    priceVersion: 1,
    listVersion: 1,
    at: clock.iso(),
  };
}

let orders = 0;
/** One kiosk top-up with a fresh order id and kiosk txn unless given. */
function topUp(card, amountSen, { orderId, kioskTxn, failMode, cardKey = KEY, schoolCode } = {}) {
  orders += 1;
  const write = { orderId: orderId ?? `ord_test${orders}`, kioskTxn: kioskTxn ?? deviceTxnNo('KIOSK-01', orders), at: clock.iso() };
  return card.credit({ cardKey, amountSen, write, failMode, schoolCode });
}

/** The MAC is cardMac(school key, memory without mac). */
function assertSigned(card, key = KEY) {
  const { mac, ...rest } = card.memory;
  assert.equal(mac, cardMac(key, rest));
}

describe('a new card', () => {
  test('is blank and signed with the school card key', () => {
    const card = newCard();
    const expected = { uid: UID, school: SCHOOL, group: 'STUDENT', balanceSen: 0, cardSeq: 0, records: [], writes: [], listVersionOnCard: 0 };
    assert.deepEqual(card.memory, { ...expected, mac: cardMac(KEY, expected) });
    assert.deepEqual(card.read(KEY), card.memory);
  });

  test('normalises the UID and keeps the holder group', () => {
    const card = new VirtualCard({ uid: '04:a1:b2:c3', schoolCode: SCHOOL, group: 'STAFF', cardKey: KEY });
    assert.equal(card.uid, '04A1B2C3');
    assert.equal(card.schoolCode, SCHOOL);
    assert.equal(card.group, 'STAFF');
    assert.equal(card.balanceSen, 0);
    assert.equal(card.cardSeq, 0);
    assertSigned(card);
  });

  test('refuses a bad UID (CARD_UID_INVALID), school code, group or key', () => {
    assert.throws(() => newCard({ uid: 'not-hex' }), labError('CARD_UID_INVALID'));
    assert.throws(() => newCard({ uid: '04A1B' }), labError('CARD_UID_INVALID'));
    assert.throws(() => new VirtualCard(), labError('CARD_UID_INVALID'));
    assert.throws(() => newCard({ schoolCode: 'SMK Alpha' }), TypeError);
    assert.throws(() => newCard({ schoolCode: undefined }), TypeError);
    assert.throws(() => newCard({ group: 'PARENT' }), TypeError);
    assert.throws(() => newCard({ cardKey: undefined }), TypeError);
    assert.throws(() => newCard({ cardKey: 'ab'.repeat(8) }), TypeError); // 8 bytes: too short
    assert.throws(() => newCard({ cardKey: 'zz'.repeat(32) }), TypeError);
  });

  test('memory is a deep copy: editing it changes nothing on the chip', () => {
    const card = newCard();
    topUp(card, 1000);
    const copy = card.memory;
    copy.balanceSen = 99_999;
    copy.writes.push({ orderId: 'ord_fake' });
    copy.writes[0].amountSen = 1;
    assert.equal(card.balanceSen, 1000);
    assert.equal(card.memory.writes.length, 1);
    assert.equal(card.memory.writes[0].amountSen, 1000);
    assert.doesNotThrow(() => card.read(KEY));
  });

  test('toJSON() gives the memory', () => {
    const card = newCard();
    topUp(card, 500);
    assert.deepEqual(JSON.parse(JSON.stringify(card)), card.memory);
  });
});

describe('read', () => {
  test('returns a verified copy of the memory', () => {
    const card = newCard();
    topUp(card, 2000);
    const memory = card.read(KEY);
    assert.deepEqual(memory, card.memory);
    memory.balanceSen = 1;
    memory.writes.length = 0;
    assert.equal(card.read(KEY).balanceSen, 2000);
    assert.equal(card.read(KEY).writes.length, 1);
  });

  test('a wrong card key is CARD_UNREADABLE', () => {
    const card = newCard();
    const before = card.memory;
    assert.throws(() => card.read(OTHER_KEY), cardError('CARD_UNREADABLE'));
    assert.deepEqual(card.memory, before);
  });

  test("another school's card: unreadable with this school's key, WRONG_SCHOOL when the machine says its school", () => {
    const theirs = new VirtualCard({ uid: UID, schoolCode: OTHER_SCHOOL, cardKey: OTHER_KEY });
    assert.throws(() => theirs.read(KEY), cardError('CARD_UNREADABLE'));
    assert.throws(() => theirs.read(KEY, { schoolCode: SCHOOL }), (err) => {
      cardError('WRONG_SCHOOL')(err);
      assert.equal(err.detail.cardSchool, OTHER_SCHOOL);
      return true;
    });
    // Its own school's machines read it fine, with or without saying the school.
    assert.equal(theirs.read(OTHER_KEY, { schoolCode: OTHER_SCHOOL }).school, OTHER_SCHOOL);
    assert.equal(theirs.read(OTHER_KEY).uid, UID);
  });

  test('a malformed key is a bug in the machine (TypeError), not a bad card', () => {
    const card = newCard();
    assert.throws(() => card.read(), TypeError);
    assert.throws(() => card.read('xyz'), TypeError);
    assert.throws(() => card.read('ab'.repeat(8)), TypeError);
  });

  test('memory with a valid MAC but unusable fields is CARD_UNREADABLE', () => {
    const bad = { uid: UID, school: SCHOOL, group: 'STUDENT', balanceSen: -500, cardSeq: 0, records: [], writes: [], listVersionOnCard: 0 };
    const card = VirtualCard.fromMemory({ ...bad, mac: cardMac(KEY, bad) });
    assert.throws(() => card.read(KEY), cardError('CARD_UNREADABLE'));
  });

  test('memory without a MAC, or holding values that are not JSON, is CARD_UNREADABLE (never a crash)', () => {
    const { mac: _mac, ...noMac } = newCard().memory;
    assert.throws(() => VirtualCard.fromMemory(noMac).read(KEY), cardError('CARD_UNREADABLE'));
    const weird = { ...newCard().memory, balanceSen: Number.NaN };
    assert.throws(() => VirtualCard.fromMemory(weird).read(KEY), cardError('CARD_UNREADABLE'));
  });
});

describe('debit', () => {
  test('charges the card and completes the record', () => {
    const card = newCard();
    topUp(card, 2000); // cardSeq 1
    const record = saleRecord(1, 350);
    const result = card.debit({ cardKey: KEY, amountSen: 350, record });
    assert.equal(result.balanceBeforeSen, 2000);
    assert.equal(result.balanceAfterSen, 1650);
    assert.equal(result.cardSeq, 2);
    assert.deepEqual(result.record, { ...record, cardSeq: 2, balanceBeforeSen: 2000, balanceAfterSen: 1650 });
    assert.deepEqual(validateRecord(result.record), { ok: true });
    // The caller's record is left as it was.
    assert.equal('cardSeq' in record, false);
    const memory = card.read(KEY);
    assert.equal(memory.balanceSen, 1650);
    assert.equal(memory.cardSeq, 2);
    assert.deepEqual(memory.records, [result.record]);
    assertSigned(card);
  });

  test('the returned record is a copy', () => {
    const card = newCard();
    topUp(card, 1000);
    const { record } = card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(2) });
    record.amountSen = 1;
    assert.equal(card.memory.records[0].amountSen, 350);
  });

  test('fills in amountSen when the record has none, and replaces values the caller put in the filled fields', () => {
    const card = newCard();
    topUp(card, 1000);
    const { amountSen: _a, ...noAmount } = saleRecord(3, 400);
    const r1 = card.debit({ cardKey: KEY, amountSen: 400, record: noAmount }).record;
    assert.equal(r1.amountSen, 400);
    const r2 = card.debit({
      cardKey: KEY,
      amountSen: 150,
      record: { ...saleRecord(4, 150), cardSeq: 99, balanceBeforeSen: 5, balanceAfterSen: 7 },
    }).record;
    assert.equal(r2.cardSeq, 3);
    assert.equal(r2.balanceBeforeSen, 600);
    assert.equal(r2.balanceAfterSen, 450);
  });

  test('a zero-amount purchase is still a change: new cardSeq and a stored record', () => {
    const card = newCard();
    topUp(card, 100);
    const result = card.debit({ cardKey: KEY, amountSen: 0, record: saleRecord(5, 0) });
    assert.equal(result.balanceAfterSen, 100);
    assert.equal(result.cardSeq, 2);
    assert.equal(card.memory.records.length, 1);
  });

  test('the exact balance is enough', () => {
    const card = newCard();
    topUp(card, 350);
    assert.equal(card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(6) }).balanceAfterSen, 0);
  });

  test('INSUFFICIENT_BALANCE changes nothing', () => {
    const card = newCard();
    topUp(card, 300);
    const before = card.memory;
    assert.throws(() => card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(7) }), (err) => {
      cardError('INSUFFICIENT_BALANCE')(err);
      assert.deepEqual(err.detail, { balanceSen: 300, amountSen: 350 });
      return true;
    });
    assert.deepEqual(card.memory, before);
    // An empty card refuses anything above zero.
    assert.throws(() => newCard().debit({ cardKey: KEY, amountSen: 1, record: saleRecord(8, 1) }), cardError('INSUFFICIENT_BALANCE'));
  });

  test("a wrong key, a tampered card or another school's machine is refused and nothing changes", () => {
    const card = newCard();
    topUp(card, 1000);
    const before = card.memory;
    assert.throws(() => card.debit({ cardKey: OTHER_KEY, amountSen: 350, record: saleRecord(9) }), cardError('CARD_UNREADABLE'));
    assert.throws(
      () => card.debit({ cardKey: OTHER_KEY, amountSen: 350, record: saleRecord(9), schoolCode: OTHER_SCHOOL }),
      cardError('WRONG_SCHOOL'),
    );
    assert.deepEqual(card.memory, before);
    card.tamper({ balanceSen: 50_000 });
    assert.throws(() => card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(9) }), cardError('CARD_UNREADABLE'));
    assert.equal(card.memory.balanceSen, 50_000);
    assert.equal(card.memory.records.length, 0);
  });

  test('a bad amount is AMOUNT_INVALID and a missing record a TypeError; nothing changes', () => {
    const card = newCard();
    topUp(card, 1000);
    const before = card.memory;
    for (const amountSen of [-1, 1.5, '350', Number.NaN, undefined]) {
      assert.throws(() => card.debit({ cardKey: KEY, amountSen, record: saleRecord(10) }), labError('AMOUNT_INVALID'));
    }
    assert.throws(() => card.debit({ cardKey: KEY, amountSen: 400, record: saleRecord(10, 350) }), labError('AMOUNT_INVALID'));
    assert.throws(() => card.debit({ cardKey: KEY, amountSen: 350 }), TypeError);
    assert.throws(() => card.debit({ cardKey: KEY, amountSen: 350, record: [saleRecord(10)] }), TypeError);
    assert.throws(() => card.debit({ cardKey: undefined, amountSen: 350, record: saleRecord(10) }), TypeError);
    assert.throws(() => card.debit(), labError('AMOUNT_INVALID'));
    assert.deepEqual(card.memory, before);
  });

  test('stays all-or-nothing when the record cannot be stored (not plain JSON): always a TypeError', () => {
    const card = newCard();
    topUp(card, 1000);
    const before = card.memory;
    const notJson = [
      { at: new Date(0) },
      { ml: Number.POSITIVE_INFINITY },
      { ml: Number.NaN },
      { note() {} },
      { tag: Symbol('lab') },
      { big: 10n },
      { items: [{ code: 'NASI-LEMAK', qty: 1, priceSen: 350, check: () => true }] },
    ];
    for (const change of notJson) {
      assert.throws(() => card.debit({ cardKey: KEY, amountSen: 350, record: { ...saleRecord(11), ...change } }), TypeError, Object.keys(change)[0]);
    }
    assert.deepEqual(card.memory, before);
    assert.doesNotThrow(() => card.read(KEY));
  });

  test('stores exactly the JSON its MAC covers: undefined fields are left out, and the memory survives a JSON round trip', () => {
    const card = newCard();
    topUp(card, 1000);
    const { record } = card.debit({ cardKey: KEY, amountSen: 350, record: { ...saleRecord(12), ml: undefined, currency: undefined } });
    assert.equal('ml' in record, false);
    assert.equal('currency' in card.memory.records[0], false);
    assert.deepEqual(validateRecord(record), { ok: true });
    // What a lab would save and load again, or send over HTTP.
    const restored = VirtualCard.fromMemory(JSON.parse(JSON.stringify(card.memory)));
    assert.deepEqual(restored.read(KEY), card.read(KEY));
    assert.equal(restored.debit({ cardKey: KEY, amountSen: 150, record: saleRecord(13, 150) }).balanceAfterSen, 500);
  });

  test(`keeps the last ${CARD_RECORDS_KEPT} records, newest last`, () => {
    const card = newCard();
    topUp(card, 10_000); // cardSeq 1
    for (let n = 1; n <= 25; n++) card.debit({ cardKey: KEY, amountSen: 100, record: saleRecord(n, 100) });
    const { records, balanceSen, cardSeq } = card.read(KEY);
    assert.equal(CARD_RECORDS_KEPT, 20);
    assert.equal(records.length, 20);
    assert.equal(records[0].txn, deviceTxnNo('CANTEEN-01', 6));
    assert.equal(records.at(-1).txn, deviceTxnNo('CANTEEN-01', 25));
    assert.deepEqual(records.map((r) => r.cardSeq), Array.from({ length: 20 }, (_, i) => i + 7));
    for (const r of records) assert.equal(r.balanceBeforeSen - r.amountSen, r.balanceAfterSen);
    assert.equal(balanceSen, 7500);
    assert.equal(cardSeq, 26);
  });
});

describe('credit', () => {
  test('adds the money and remembers the write', () => {
    const card = newCard();
    const at = clock.iso();
    const result = card.credit({ cardKey: KEY, amountSen: 2000, write: { orderId: 'ord_a1', kioskTxn: 'KIOSK-01-000001', at } });
    assert.deepEqual(result, { balanceBeforeSen: 0, balanceAfterSen: 2000, cardSeq: 1 });
    const memory = card.read(KEY);
    assert.equal(memory.balanceSen, 2000);
    assert.deepEqual(memory.writes, [{ orderId: 'ord_a1', amountSen: 2000, kioskTxn: 'KIOSK-01-000001', at }]);
    assertSigned(card);
    assert.deepEqual(topUp(card, 500), { balanceBeforeSen: 2000, balanceAfterSen: 2500, cardSeq: 2 });
  });

  test('the same order twice is ALREADY_WRITTEN and changes nothing', () => {
    const card = newCard();
    topUp(card, 2000, { orderId: 'ord_twice', kioskTxn: 'KIOSK-01-000010' });
    const before = card.memory;
    assert.throws(() => topUp(card, 2000, { orderId: 'ord_twice', kioskTxn: 'KIOSK-01-000011' }), (err) => {
      cardError('ALREADY_WRITTEN')(err);
      // The earlier write tells the kiosk which txn number it used.
      assert.equal(err.detail.write.kioskTxn, 'KIOSK-01-000010');
      return true;
    });
    assert.deepEqual(card.memory, before);
  });

  test(`keeps the last ${CARD_WRITES_KEPT} writes`, () => {
    const card = newCard();
    for (let n = 1; n <= 11; n++) topUp(card, 100, { orderId: `ord_keep${n}` });
    const { writes, balanceSen, cardSeq } = card.read(KEY);
    assert.equal(CARD_WRITES_KEPT, 10);
    assert.equal(writes.length, 10);
    assert.equal(writes[0].orderId, 'ord_keep2');
    assert.equal(writes.at(-1).orderId, 'ord_keep11');
    assert.equal(balanceSen, 1100);
    assert.equal(cardSeq, 11);
    // Only what the card still remembers is refused; older orders are the platform's to catch.
    assert.throws(() => topUp(card, 100, { orderId: 'ord_keep2' }), cardError('ALREADY_WRITTEN'));
    assert.doesNotThrow(() => topUp(card, 100, { orderId: 'ord_keep1' }));
  });

  test('power cut before commit: PowerCutError and nothing changed', () => {
    const card = newCard();
    topUp(card, 1000);
    const before = card.memory;
    assert.throws(() => topUp(card, 2000, { orderId: 'ord_cut1', failMode: 'power-cut-before-commit' }), (err) => {
      assert.ok(err instanceof PowerCutError);
      assert.ok(err instanceof LabError);
      assert.equal(err.code, 'POWER_CUT');
      assert.equal(err.committed, false);
      return true;
    });
    assert.deepEqual(card.memory, before);
    // The same order can be written once the power is back.
    assert.equal(topUp(card, 2000, { orderId: 'ord_cut1' }).balanceAfterSen, 3000);
  });

  test('power cut after commit: PowerCutError, but the write is on the card with a valid MAC', () => {
    const card = newCard();
    topUp(card, 1000); // cardSeq 1
    assert.throws(
      () => topUp(card, 2000, { orderId: 'ord_cut2', kioskTxn: 'KIOSK-01-000020', failMode: 'power-cut-after-commit' }),
      (err) => err instanceof PowerCutError && err.committed === true && err.detail.committed === true,
    );
    const memory = card.read(KEY);
    assert.equal(memory.balanceSen, 3000);
    assert.equal(memory.cardSeq, 2);
    assert.deepEqual(memory.writes.at(-1), { orderId: 'ord_cut2', amountSen: 2000, kioskTxn: 'KIOSK-01-000020', at: clock.iso() });
    assertSigned(card);
    // Trying again finds the write: the kiosk must confirm it, never add it twice.
    assert.throws(() => topUp(card, 2000, { orderId: 'ord_cut2' }), cardError('ALREADY_WRITTEN'));
  });

  test('card checks come before the power cut', () => {
    const card = newCard();
    topUp(card, 1000, { orderId: 'ord_first' });
    for (const failMode of FAIL_MODES) {
      assert.throws(() => topUp(card, 1000, { orderId: 'ord_first', failMode }), cardError('ALREADY_WRITTEN'));
      assert.throws(() => topUp(card, 1000, { failMode, cardKey: OTHER_KEY }), cardError('CARD_UNREADABLE'));
    }
    assert.equal(card.memory.balanceSen, 1000);
  });

  test("a wrong key, a tampered card or another school's kiosk is refused and nothing changes", () => {
    const card = newCard();
    topUp(card, 1000);
    const before = card.memory;
    assert.throws(() => topUp(card, 500, { cardKey: OTHER_KEY }), cardError('CARD_UNREADABLE'));
    assert.throws(() => topUp(card, 500, { cardKey: OTHER_KEY, schoolCode: OTHER_SCHOOL }), cardError('WRONG_SCHOOL'));
    assert.deepEqual(card.memory, before);
    card.tamper({ balanceSen: 0 });
    assert.throws(() => topUp(card, 500), cardError('CARD_UNREADABLE'));
    assert.equal(card.memory.writes.length, 1);
  });

  test('bad arguments: AMOUNT_INVALID, TypeError or RangeError, and nothing changes', () => {
    const card = newCard();
    topUp(card, 1000);
    const before = card.memory;
    const write = { orderId: 'ord_bad', kioskTxn: 'KIOSK-01-000099', at: clock.iso() };
    for (const amountSen of [0, -100, 1.5, '100', undefined]) {
      assert.throws(() => card.credit({ cardKey: KEY, amountSen, write }), labError('AMOUNT_INVALID'));
    }
    assert.throws(() => card.credit({ cardKey: KEY, amountSen: 100, write: { ...write, amountSen: 200 } }), labError('AMOUNT_INVALID'));
    assert.throws(() => card.credit({ cardKey: KEY, amountSen: 100 }), TypeError);
    assert.throws(() => card.credit({ cardKey: KEY, amountSen: 100, write: { ...write, orderId: '' } }), TypeError);
    assert.throws(() => card.credit({ cardKey: KEY, amountSen: 100, write: { ...write, orderId: 42 } }), TypeError);
    assert.throws(() => card.credit({ cardKey: KEY, amountSen: 100, write: { ...write, kioskTxn: 'K'.repeat(65) } }), TypeError);
    assert.throws(() => card.credit({ cardKey: KEY, amountSen: 100, write: { ...write, at: 'yesterday' } }), TypeError);
    assert.throws(() => card.credit({ cardKey: KEY, amountSen: 100, write, failMode: 'explode' }), RangeError);
    assert.throws(() => card.credit({ cardKey: 'nope', amountSen: 100, write }), TypeError);
    assert.deepEqual(card.memory, before);
  });

  test('a balance too large to count is AMOUNT_INVALID', () => {
    const card = newCard();
    topUp(card, 1);
    const before = card.memory;
    assert.throws(() => topUp(card, Number.MAX_SAFE_INTEGER), labError('AMOUNT_INVALID'));
    assert.deepEqual(card.memory, before);
  });
});

describe('the card counter (cardSeq)', () => {
  test('every change increments it; reads and refused operations do not', () => {
    const card = newCard();
    assert.equal(topUp(card, 1000).cardSeq, 1);
    assert.equal(card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(30) }).cardSeq, 2);
    assert.equal(card.setListVersion({ cardKey: KEY, version: 3 }).cardSeq, 3);
    card.read(KEY);
    assert.equal(card.setListVersion({ cardKey: KEY, version: 3 }).cardSeq, 3);
    assert.throws(() => card.debit({ cardKey: KEY, amountSen: 5000, record: saleRecord(31, 5000) }), cardError('INSUFFICIENT_BALANCE'));
    assert.throws(() => topUp(card, 100, { failMode: 'power-cut-before-commit' }), PowerCutError);
    assert.equal(card.cardSeq, 3);
    assert.equal(card.debit({ cardKey: KEY, amountSen: 150, record: saleRecord(32, 150) }).cardSeq, 4);
  });
});

describe('setListVersion', () => {
  test('stores a higher version, as a signed change', () => {
    const card = newCard();
    assert.deepEqual(card.setListVersion({ cardKey: KEY, version: 5 }), { listVersionOnCard: 5, cardSeq: 1, changed: true });
    assert.equal(card.read(KEY).listVersionOnCard, 5);
    assertSigned(card);
  });

  test('the same or a lower version is not a change', () => {
    const card = newCard();
    card.setListVersion({ cardKey: KEY, version: 5 });
    const before = card.memory;
    assert.deepEqual(card.setListVersion({ cardKey: KEY, version: 5 }), { listVersionOnCard: 5, cardSeq: 1, changed: false });
    assert.deepEqual(card.setListVersion({ cardKey: KEY, version: 2 }), { listVersionOnCard: 5, cardSeq: 1, changed: false });
    assert.deepEqual(card.memory, before);
  });

  test('refuses a bad version, a wrong key and another school', () => {
    const card = newCard();
    for (const version of [-1, 1.5, '3', undefined]) {
      assert.throws(() => card.setListVersion({ cardKey: KEY, version }), RangeError);
    }
    assert.throws(() => card.setListVersion({ cardKey: OTHER_KEY, version: 3 }), cardError('CARD_UNREADABLE'));
    assert.throws(() => card.setListVersion({ cardKey: OTHER_KEY, version: 3, schoolCode: OTHER_SCHOOL }), cardError('WRONG_SCHOOL'));
    card.tamper({ balanceSen: 100 });
    assert.throws(() => card.setListVersion({ cardKey: KEY, version: 3 }), cardError('CARD_UNREADABLE'));
    assert.equal(card.memory.listVersionOnCard, 0);
  });
});

describe('two schools (tenant isolation)', () => {
  test('the same UID issued by two schools is two cards; each school can only use its own', () => {
    const ours = newCard();
    const theirs = new VirtualCard({ uid: UID, schoolCode: OTHER_SCHOOL, cardKey: OTHER_KEY });
    topUp(ours, 1000);
    topUp(theirs, 1000, { cardKey: OTHER_KEY });
    assert.notEqual(ours.memory.mac, theirs.memory.mac);
    const theirsBefore = theirs.memory;
    // Our machines, with and without saying their school: refused, and their card is unchanged.
    for (const schoolCode of [SCHOOL, undefined]) {
      const expected = cardError(schoolCode ? 'WRONG_SCHOOL' : 'CARD_UNREADABLE');
      assert.throws(() => theirs.read(KEY, { schoolCode }), expected);
      assert.throws(() => theirs.debit({ cardKey: KEY, amountSen: 100, record: saleRecord(70, 100), schoolCode }), expected);
      assert.throws(() => topUp(theirs, 100, { schoolCode }), expected);
      assert.throws(() => theirs.setListVersion({ cardKey: KEY, version: 9, schoolCode }), expected);
    }
    assert.deepEqual(theirs.memory, theirsBefore);
    // Each school's own machines still use their own card.
    assert.equal(ours.read(KEY, { schoolCode: SCHOOL }).balanceSen, 1000);
    assert.equal(theirs.read(OTHER_KEY, { schoolCode: OTHER_SCHOOL }).balanceSen, 1000);
  });

  test("the card's own school passes the school check for every operation", () => {
    const card = newCard();
    assert.equal(topUp(card, 1000, { schoolCode: SCHOOL }).balanceAfterSen, 1000);
    assert.equal(card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(71), schoolCode: SCHOOL }).balanceAfterSen, 650);
    assert.equal(card.setListVersion({ cardKey: KEY, version: 2, schoolCode: SCHOOL }).listVersionOnCard, 2);
    assert.equal(card.read(KEY, { schoolCode: SCHOOL }).cardSeq, 3);
  });

  test('a card edited to claim another school is refused by both schools', () => {
    const card = newCard();
    topUp(card, 1000);
    const moved = VirtualCard.fromMemory({ ...card.memory, school: OTHER_SCHOOL });
    assert.equal(moved.schoolCode, OTHER_SCHOOL);
    assert.throws(() => moved.read(KEY, { schoolCode: SCHOOL }), cardError('WRONG_SCHOOL'));
    assert.throws(() => moved.read(KEY), cardError('CARD_UNREADABLE'));
    assert.throws(() => moved.read(OTHER_KEY, { schoolCode: OTHER_SCHOOL }), cardError('CARD_UNREADABLE'));
  });
});

describe('fromMemory', () => {
  test('restores a card exactly, MAC included, and it keeps working', () => {
    const card = newCard();
    topUp(card, 1000);
    card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(40) });
    const restored = VirtualCard.fromMemory(card.memory);
    assert.ok(restored instanceof VirtualCard);
    assert.deepEqual(restored.memory, card.memory);
    assert.equal(restored.uid, UID);
    assert.equal(restored.schoolCode, SCHOOL);
    assert.equal(restored.debit({ cardKey: KEY, amountSen: 150, record: saleRecord(41, 150) }).balanceAfterSen, 500);
  });

  test('copies its input', () => {
    const memory = newCard().memory;
    const card = VirtualCard.fromMemory(memory);
    memory.balanceSen = 5000;
    assert.equal(card.balanceSen, 0);
    assert.doesNotThrow(() => card.read(KEY));
  });

  test('keeps a broken MAC broken', () => {
    const memory = { ...newCard().memory, balanceSen: 5000 };
    assert.throws(() => VirtualCard.fromMemory(memory).read(KEY), cardError('CARD_UNREADABLE'));
  });

  test('refuses anything that is not card memory', () => {
    for (const memory of [null, undefined, 'card', [], {}, { uid: UID }, { school: SCHOOL }]) {
      assert.throws(() => VirtualCard.fromMemory(memory), TypeError);
    }
  });
});

describe('lab faults: clone and tamper', () => {
  test('a clone has identical memory and a valid MAC', () => {
    const card = newCard();
    topUp(card, 2000);
    const copy = card.clone();
    assert.ok(copy instanceof VirtualCard);
    assert.notEqual(copy, card);
    assert.deepEqual(copy.memory, card.memory);
    assert.deepEqual(copy.read(KEY), card.read(KEY));
    assertSigned(copy);
  });

  test('original and clone spend separately with the same card counter (what the platform catches)', () => {
    const card = newCard();
    topUp(card, 2000);
    const copy = card.clone();
    const a = card.debit({ cardKey: KEY, amountSen: 350, record: saleRecord(50) });
    const b = copy.debit({ cardKey: KEY, amountSen: 400, record: saleRecord(51, 400) });
    assert.equal(a.record.cardSeq, b.record.cardSeq);
    assert.notEqual(a.record.txn, b.record.txn);
    // Each copy still holds the full RM 20.00 it started from: the same money is spent twice.
    assert.equal(card.balanceSen, 1650);
    assert.equal(copy.balanceSen, 1600);
    assert.doesNotThrow(() => card.read(KEY));
    assert.doesNotThrow(() => copy.read(KEY));
  });

  test('tamper changes the balance without a new MAC: every operation refuses the card', () => {
    const card = newCard();
    topUp(card, 500);
    const { mac } = card.memory;
    const edited = card.tamper({ balanceSen: 99_999 });
    assert.equal(edited.balanceSen, 99_999);
    assert.equal(edited.mac, mac);
    assert.equal(card.balanceSen, 99_999);
    assert.throws(() => card.read(KEY), cardError('CARD_UNREADABLE'));
    assert.throws(() => card.debit({ cardKey: KEY, amountSen: 100, record: saleRecord(60, 100) }), cardError('CARD_UNREADABLE'));
    assert.throws(() => topUp(card, 100), cardError('CARD_UNREADABLE'));
    assert.throws(() => card.clone().read(KEY), cardError('CARD_UNREADABLE'));
  });

  test('putting the same balance back leaves nothing to detect', () => {
    const card = newCard();
    topUp(card, 500);
    card.tamper({ balanceSen: 500 });
    assert.equal(card.read(KEY).balanceSen, 500);
  });

  test('tamper takes a whole number of sen only', () => {
    const card = newCard();
    for (const balanceSen of [-1, 2.5, '100', undefined]) {
      assert.throws(() => card.tamper({ balanceSen }), labError('AMOUNT_INVALID'));
    }
    assert.doesNotThrow(() => card.read(KEY));
  });
});

describe('CardError and PowerCutError', () => {
  test('CardError is a LabError with a code, a default message and a status', () => {
    for (const code of CARD_ERROR_CODES) {
      const err = new CardError(code);
      assert.ok(err instanceof CardError && err instanceof LabError && err instanceof Error);
      assert.equal(err.name, 'CardError');
      assert.equal(err.code, code);
      assert.ok(err.message.length > 0 && err.message !== code);
      assert.ok(Number.isInteger(err.status) && err.status >= 400);
    }
    const custom = new CardError('WRONG_SCHOOL', 'not ours', { cardSchool: OTHER_SCHOOL });
    assert.equal(custom.message, 'not ours');
    assert.deepEqual(custom.detail, { cardSchool: OTHER_SCHOOL });
  });

  test('PowerCutError says whether the write was committed', () => {
    const before = new PowerCutError(false);
    const after = new PowerCutError(true);
    assert.equal(before.name, 'PowerCutError');
    assert.equal(before.code, 'POWER_CUT');
    assert.equal(before.committed, false);
    assert.equal(after.committed, true);
    assert.notEqual(before.message, after.message);
    assert.ok(before instanceof LabError);
  });
});
