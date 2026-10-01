import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exportJournal, verifyJournalFile, JOURNAL_FORMAT } from '../../src/devices/usb.js';
import { VirtualCard } from '../../src/devices/card.js';
import { canonicalJson, cardDigest, hmacB64url, last4, randomSecret } from '../../src/shared/crypto.js';
import { deviceTxnNo, validateRecord } from '../../src/shared/protocol.js';
import { createClock } from '../../src/shared/clock.js';

// All school codes, card UIDs and devices below are fictional; secrets are generated.

const SCHOOL = 'smk-alpha';
const DEVICE = 'CANTEEN-02';
const SECRET = randomSecret();
const OTHER_SECRET = randomSecret();
const CARD_KEY = randomSecret();
const UID = '04C35D2F8B1A82';
const clock = createClock({ mode: 'manual' });

/** Two purchases as a reader with no network keeps them in its journal (completed by the card). */
function journalRecords() {
  const card = new VirtualCard({ uid: UID, schoolCode: SCHOOL, cardKey: CARD_KEY });
  card.credit({ cardKey: CARD_KEY, amountSen: 2000, write: { orderId: 'ord_usb1', kioskTxn: 'KIOSK-01-000001', at: clock.iso() } });
  const sale = (n, code, priceSen) => ({
    txn: deviceTxnNo(DEVICE, n),
    origin: DEVICE,
    kind: 'SALE',
    card: cardDigest(CARD_KEY, SCHOOL, UID),
    last4: last4(UID),
    amountSen: priceSen,
    items: [{ code, qty: 1, priceSen }],
    priceVersion: 1,
    listVersion: 2,
    at: clock.iso(),
  });
  return [
    card.debit({ cardKey: CARD_KEY, amountSen: 150, record: sale(1, 'ROTI-CANAI', 150) }).record,
    card.debit({ cardKey: CARD_KEY, amountSen: 180, record: sale(2, 'TEH-TARIK', 180) }).record,
  ];
}

const exportNow = (overrides = {}) =>
  exportJournal({ schoolCode: SCHOOL, deviceCode: DEVICE, secret: SECRET, records: journalRecords(), exportedAt: clock.iso(), ...overrides });

describe('exportJournal', () => {
  test('builds the signed file: format, school, device, time, count, records, sig', () => {
    const records = journalRecords();
    const exportedAt = clock.iso();
    const file = exportJournal({ schoolCode: SCHOOL, deviceCode: DEVICE, secret: SECRET, records, exportedAt });
    assert.deepEqual(Object.keys(file), ['format', 'school', 'device', 'exportedAt', 'count', 'records', 'sig']);
    assert.equal(file.format, JOURNAL_FORMAT);
    assert.equal(file.format, 'onecard-lab-journal/1');
    assert.equal(file.school, SCHOOL);
    assert.equal(file.device, DEVICE);
    assert.equal(file.exportedAt, exportedAt);
    assert.equal(file.count, 2);
    assert.deepEqual(file.records, records);
    for (const r of file.records) assert.deepEqual(validateRecord(r), { ok: true });
    const { sig, ...rest } = file;
    assert.equal(sig, hmacB64url(SECRET, canonicalJson(rest)));
  });

  test('copies the records: later changes to the journal do not change the file', () => {
    const records = journalRecords();
    const file = exportJournal({ schoolCode: SCHOOL, deviceCode: DEVICE, secret: SECRET, records, exportedAt: clock.iso() });
    records[0].amountSen = 1;
    records.push(records[1]);
    assert.equal(file.records[0].amountSen, 150);
    assert.equal(file.records.length, 2);
    assert.equal(verifyJournalFile(file, SECRET), true);
  });

  test('an empty journal exports as a valid file with count 0', () => {
    const file = exportNow({ records: [] });
    assert.equal(file.count, 0);
    assert.deepEqual(file.records, []);
    assert.equal(verifyJournalFile(file, SECRET), true);
  });

  test('refuses malformed arguments', () => {
    assert.throws(() => exportNow({ schoolCode: 'SMK Alpha' }), TypeError);
    assert.throws(() => exportNow({ deviceCode: 'canteen-02' }), TypeError);
    assert.throws(() => exportNow({ secret: undefined }), TypeError);
    assert.throws(() => exportNow({ secret: 'not-hex' }), TypeError);
    assert.throws(() => exportNow({ records: undefined }), TypeError);
    assert.throws(() => exportNow({ records: [null] }), TypeError);
    assert.throws(() => exportNow({ records: [[]] }), TypeError);
    // Records that are not plain JSON: the file could not carry what its signature covers.
    const [record] = journalRecords();
    assert.throws(() => exportNow({ records: [{ ...record, note() {} }] }), TypeError);
    assert.throws(() => exportNow({ records: [{ ...record, tag: Symbol('lab') }] }), TypeError);
    assert.throws(() => exportNow({ records: [{ ...record, at: new Date(0) }] }), TypeError);
    assert.throws(() => exportNow({ records: [{ ...record, amountSen: 10n }] }), TypeError);
    assert.throws(() => exportNow({ records: [new Date(0)] }), TypeError);
    assert.throws(() => exportNow({ exportedAt: 'now' }), TypeError);
    assert.throws(() => exportNow({ exportedAt: clock.now() }), TypeError);
    assert.throws(() => exportJournal(), TypeError);
  });
});

describe('verifyJournalFile', () => {
  test('accepts an untouched file, also after a trip through JSON (USB stick, upload)', () => {
    const file = exportNow();
    assert.equal(verifyJournalFile(file, SECRET), true);
    assert.equal(verifyJournalFile(JSON.parse(JSON.stringify(file)), SECRET), true);
    assert.equal(verifyJournalFile(JSON.parse(JSON.stringify(file, null, 2)), SECRET), true);
    // Key order does not matter (canonical JSON).
    const reordered = Object.fromEntries(Object.entries(file).reverse());
    assert.equal(verifyJournalFile(reordered, SECRET), true);
  });

  test('refuses any edited record', () => {
    const file = exportNow();
    const edits = [
      (f) => { f.records[0].amountSen = 0; },
      (f) => { f.records[0].balanceAfterSen += 150; },
      (f) => { f.records[1].items[0].qty = 2; },
      (f) => { f.records[1].card = '0'.repeat(64); },
      (f) => { delete f.records[1].at; },
      (f) => { f.records.reverse(); },
    ];
    for (const edit of edits) {
      const copy = structuredClone(file);
      edit(copy);
      assert.equal(verifyJournalFile(copy, SECRET), false, String(edit));
    }
  });

  test('refuses a dropped record, whether or not the count was fixed', () => {
    const file = exportNow();
    const dropped = structuredClone(file);
    dropped.records.pop();
    assert.equal(verifyJournalFile(dropped, SECRET), false);
    dropped.count = 1;
    assert.equal(verifyJournalFile(dropped, SECRET), false);
  });

  test('refuses a count that does not match the records, even when correctly signed', () => {
    const { sig: _sig, ...rest } = exportNow();
    const lying = { ...rest, count: 3 };
    assert.equal(verifyJournalFile({ ...lying, sig: hmacB64url(SECRET, canonicalJson(lying)) }, SECRET), false);
  });

  test('refuses changed school, device, time or format, and added fields', () => {
    const file = exportNow();
    const changes = [
      { school: 'smk-beta' },
      { device: 'CANTEEN-01' },
      { exportedAt: '2026-10-06T02:00:00.000Z' },
      { format: 'onecard-lab-journal/2' },
      { note: 'imported twice' },
    ];
    for (const change of changes) assert.equal(verifyJournalFile({ ...file, ...change }, SECRET), false, JSON.stringify(change));
  });

  test("tenant isolation: another school's machine with the same code, or a file relabelled as ours, does not verify", () => {
    const theirs = exportJournal({ schoolCode: 'smk-beta', deviceCode: DEVICE, secret: OTHER_SECRET, records: journalRecords(), exportedAt: clock.iso() });
    assert.equal(verifyJournalFile(theirs, OTHER_SECRET), true);
    // Our CANTEEN-02's secret does not verify their CANTEEN-02's file...
    assert.equal(verifyJournalFile(theirs, SECRET), false);
    // ...and putting our school code on it breaks their signature, so it cannot be imported as ours.
    assert.equal(verifyJournalFile({ ...theirs, school: SCHOOL }, OTHER_SECRET), false);
    assert.equal(verifyJournalFile({ ...theirs, school: SCHOOL }, SECRET), false);
  });

  test("refuses another device's secret, and a missing or foreign signature", () => {
    const file = exportNow();
    assert.equal(verifyJournalFile(file, OTHER_SECRET), false);
    const { sig: _sig, ...unsigned } = file;
    assert.equal(verifyJournalFile(unsigned, SECRET), false);
    assert.equal(verifyJournalFile({ ...file, sig: 42 }, SECRET), false);
    const other = exportNow({ secret: OTHER_SECRET });
    assert.equal(verifyJournalFile({ ...file, sig: other.sig }, SECRET), false);
  });

  test('never throws: malformed files and secrets are simply false', () => {
    const file = exportNow();
    const notFiles = [null, undefined, 'file', 42, [file], {}, { ...file, records: 'two' }, { ...file, school: 7 }, { ...file, exportedAt: 'x' }];
    for (const value of notFiles) assert.equal(verifyJournalFile(value, SECRET), false);
    for (const secret of [undefined, '', 'not-hex', 'ab'.repeat(8)]) assert.equal(verifyJournalFile(file, secret), false);
    const notJson = structuredClone(file);
    notJson.records[0].at = new Date(0);
    assert.equal(verifyJournalFile(notJson, SECRET), false);
  });
});
