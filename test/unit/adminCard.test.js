import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCard, verifyPack, packChecksum, RECEIPT_RESULTS } from '../../src/devices/adminCard.js';
import { CardError } from '../../src/devices/card.js';
import { canonicalJson, sha256hex, randomSecret, cardDigest } from '../../src/shared/crypto.js';
import { createClock } from '../../src/shared/clock.js';

// All school codes, items and card UIDs below are fictional; keys are generated.

const SCHOOL = 'smk-alpha';
const clock = createClock({ mode: 'manual' });
const KEY = randomSecret();

const PRICES = {
  items: [
    { code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 380 },
    { code: 'TEH-TARIK', name: 'Teh tarik', priceSen: 180 },
  ],
  water: { perLitreSen: 20, minChargeSen: 5 },
};
const SETTINGS = {
  mealWindows: [{ from: '06:30', to: '18:30' }],
  allowedGroups: ['STUDENT', 'STAFF'],
  perPurchaseMaxSen: 2000,
  dailyMaxSen: 3000,
  dailyMaxCount: 10,
  tapGapSeconds: 5,
};
const BLOCKLIST = { entries: [{ card: cardDigest(KEY, SCHOOL, '04B2194E6A3C81'), last4: '3C81' }] };

/** A pack the way the platform builds one: checksum = sha256hex(canonicalJson(content)). */
const pack = (kind, version, content) => ({ kind, version, content, checksum: sha256hex(canonicalJson(content)) });
const PACKS = [pack('blocklist', 4, BLOCKLIST), pack('prices', 2, PRICES), pack('settings', 1, SETTINGS)];

const receipt = (overrides = {}) => ({ device: 'CANTEEN-02', kind: 'prices', appliedVersion: 2, result: 'APPLIED', at: clock.iso(), ...overrides });

const loaded = () => {
  const card = new AdminCard({ schoolCode: SCHOOL });
  card.load({ token: 7, packs: PACKS, loadedAt: clock.iso() });
  return card;
};

describe('a new admin card', () => {
  test('is blank: token 0, no packs, no receipts', () => {
    const card = new AdminCard({ schoolCode: SCHOOL });
    assert.deepEqual(card.memory, { school: SCHOOL, token: 0, loadedAt: null, packs: [], receipts: [] });
    assert.equal(card.schoolCode, SCHOOL);
    assert.equal(card.token, 0);
  });

  test('needs a school code', () => {
    assert.throws(() => new AdminCard(), TypeError);
    assert.throws(() => new AdminCard({ schoolCode: 'SMK ALPHA' }), TypeError);
  });
});

describe('load', () => {
  test('writes the token, the packs and the time, and returns the memory', () => {
    const card = new AdminCard({ schoolCode: SCHOOL });
    const at = clock.iso();
    const memory = card.load({ token: 7, packs: PACKS, loadedAt: at });
    assert.deepEqual(memory, { school: SCHOOL, token: 7, loadedAt: at, packs: PACKS, receipts: [] });
    assert.deepEqual(card.memory, memory);
    assert.equal(card.token, 7);
  });

  test('keeps its own copy of the packs, and memory is a deep copy', () => {
    const packs = structuredClone(PACKS);
    const card = new AdminCard({ schoolCode: SCHOOL });
    card.load({ token: 1, packs, loadedAt: clock.iso() });
    packs[1].content.items[0].priceSen = 1;
    packs.pop();
    const copy = card.memory;
    copy.packs[0].content.entries.length = 0;
    assert.deepEqual(card.memory.packs, PACKS);
    assert.ok(card.memory.packs.every(verifyPack));
  });

  test('a new load replaces token and packs at once but keeps receipts not uploaded yet', () => {
    const card = loaded();
    card.addReceipt(receipt());
    clock.advance(60_000);
    const later = clock.iso();
    card.load({ token: 8, packs: [pack('prices', 3, PRICES)], loadedAt: later });
    const m = card.memory;
    assert.equal(m.token, 8);
    assert.equal(m.loadedAt, later);
    assert.deepEqual(m.packs.map((p) => [p.kind, p.version]), [['prices', 3]]);
    assert.equal(m.receipts.length, 1);
  });

  test('takes the school from the packs answer only if it is this card’s school', () => {
    const card = new AdminCard({ schoolCode: SCHOOL });
    assert.doesNotThrow(() => card.load({ token: 1, school: SCHOOL, packs: PACKS, loadedAt: clock.iso() }));
    assert.throws(() => card.load({ token: 2, school: 'smk-beta', packs: [], loadedAt: clock.iso() }), (err) => {
      assert.ok(err instanceof CardError);
      assert.equal(err.code, 'WRONG_SCHOOL');
      return true;
    });
    assert.equal(card.token, 1);
    assert.deepEqual(card.memory.packs, PACKS);
    // No school in the answer (null or left out) means nothing to check, as on VirtualCard.
    assert.equal(card.load({ token: 3, school: null, packs: PACKS, loadedAt: clock.iso() }).token, 3);
    assert.equal(card.load({ token: 4, school: undefined, packs: PACKS, loadedAt: clock.iso() }).token, 4);
  });

  test('does not judge checksums: a damaged pack is carried as it is (machines refuse it)', () => {
    const damaged = { ...pack('prices', 2, PRICES), checksum: 'f'.repeat(64) };
    const card = new AdminCard({ schoolCode: SCHOOL });
    card.load({ token: 1, packs: [damaged], loadedAt: clock.iso() });
    assert.deepEqual(card.memory.packs, [damaged]);
    assert.equal(verifyPack(card.memory.packs[0]), false);
  });

  test('an empty pack list is allowed (a school with nothing published yet)', () => {
    const card = new AdminCard({ schoolCode: SCHOOL });
    assert.deepEqual(card.load({ token: 1, packs: [], loadedAt: clock.iso() }).packs, []);
  });

  test('refuses a malformed token, pack list or time and keeps what it had', () => {
    const card = loaded();
    const before = card.memory;
    const at = clock.iso();
    for (const token of [0, -1, 1.5, '8', undefined]) {
      assert.throws(() => card.load({ token, packs: PACKS, loadedAt: at }), TypeError);
    }
    const bad = [
      undefined,
      'packs',
      [null],
      [{ ...PACKS[0], kind: 'menu' }],
      [PACKS[1], { ...PACKS[1], version: 3 }], // two price packs
      [{ ...PACKS[1], version: -1 }],
      [{ ...PACKS[1], version: '2' }],
      [{ ...PACKS[1], content: null }],
      [{ ...PACKS[1], content: [] }],
      [{ ...PACKS[1], checksum: undefined }],
      // Content that is not plain JSON cannot have come from the platform's JSON answer.
      [{ ...PACKS[1], content: { ...PRICES, check() {} } }],
      [{ ...PACKS[1], content: { ...PRICES, at: new Date(0) } }],
      [{ ...PACKS[1], content: { ...PRICES, water: { perLitreSen: Number.NaN, minChargeSen: 5 } } }],
      [PACKS[0], { ...PACKS[1], content: { ...PRICES, tag: Symbol('lab') } }], // the bad pack is not the first
    ];
    for (const packs of bad) assert.throws(() => card.load({ token: 8, packs, loadedAt: at }), TypeError);
    for (const loadedAt of [undefined, 'today', 1_760_000_000_000]) {
      assert.throws(() => card.load({ token: 8, packs: PACKS, loadedAt }), TypeError);
    }
    assert.throws(() => card.load(), TypeError);
    assert.deepEqual(card.memory, before);
  });
});

describe('verifyPack', () => {
  test('accepts a pack whose checksum is sha256hex(canonicalJson(content))', () => {
    for (const p of PACKS) assert.equal(verifyPack(p), true);
    assert.equal(packChecksum(PRICES), sha256hex(canonicalJson(PRICES)));
    assert.equal(verifyPack({ kind: 'prices', version: 2, content: PRICES, checksum: packChecksum(PRICES) }), true);
  });

  test('does not depend on key order (canonical JSON)', () => {
    const reordered = {
      water: { minChargeSen: 5, perLitreSen: 20 },
      items: PRICES.items.map(({ priceSen, name, code }) => ({ priceSen, name, code })),
    };
    assert.equal(verifyPack({ ...pack('prices', 2, PRICES), content: reordered }), true);
  });

  test('refuses a pack whose content or checksum changed', () => {
    const p = pack('prices', 2, PRICES);
    const cheaper = structuredClone(PRICES);
    cheaper.items[0].priceSen = 100;
    assert.equal(verifyPack({ ...p, content: cheaper }), false);
    assert.equal(verifyPack({ ...p, checksum: packChecksum(cheaper) }), false);
    assert.equal(verifyPack({ ...p, checksum: p.checksum.toUpperCase() }), false);
    const unlisted = { entries: [] };
    assert.equal(verifyPack({ ...pack('blocklist', 4, BLOCKLIST), content: unlisted }), false);
  });

  test('never throws: anything malformed is false', () => {
    const p = pack('prices', 2, PRICES);
    const notPacks = [
      null,
      undefined,
      'pack',
      42,
      [p],
      {},
      { checksum: p.checksum },
      { content: PRICES },
      { content: PRICES, checksum: 42 },
      { content: { price: Number.NaN }, checksum: p.checksum },
      { content: { at: new Date(0) }, checksum: p.checksum },
    ];
    for (const value of notPacks) assert.equal(verifyPack(value), false);
  });
});

describe('receipts', () => {
  test('addReceipt stores what a machine did and returns a copy', () => {
    const card = loaded();
    const stored = card.addReceipt({ ...receipt(), extra: 'dropped' });
    assert.deepEqual(stored, receipt());
    stored.result = 'REJECTED';
    const rejected = card.addReceipt(receipt({ kind: 'blocklist', appliedVersion: 3, result: 'REJECTED', error: 'checksum does not match' }));
    assert.equal(rejected.error, 'checksum does not match');
    assert.deepEqual(card.memory.receipts, [receipt(), rejected]);
  });

  test('accepts every result, and an error only as text', () => {
    const card = loaded();
    for (const result of RECEIPT_RESULTS) card.addReceipt(receipt({ result }));
    card.addReceipt(receipt({ result: 'REJECTED', error: null }));
    assert.deepEqual(card.memory.receipts.map((r) => r.result), [...RECEIPT_RESULTS, 'REJECTED']);
    assert.equal('error' in card.memory.receipts.at(-1), false);
  });

  test('refuses a malformed receipt and keeps the others', () => {
    const card = loaded();
    card.addReceipt(receipt());
    const bad = [
      null,
      'APPLIED',
      receipt({ device: 'canteen 2' }),
      receipt({ device: undefined }),
      receipt({ kind: 'menu' }),
      receipt({ appliedVersion: -1 }),
      receipt({ appliedVersion: '2' }),
      receipt({ appliedVersion: undefined }),
      receipt({ result: 'OK' }),
      receipt({ error: 42 }),
      receipt({ at: 'now' }),
    ];
    for (const r of bad) assert.throws(() => card.addReceipt(r), TypeError);
    assert.deepEqual(card.memory.receipts, [receipt()]);
  });

  test('takeReceipts hands over every receipt, oldest first, and clears them', () => {
    const card = loaded();
    card.addReceipt(receipt({ device: 'CANTEEN-02', kind: 'blocklist', appliedVersion: 4 }));
    card.addReceipt(receipt({ device: 'WATER-01', kind: 'prices', result: 'ALREADY_APPLIED' }));
    const taken = card.takeReceipts();
    assert.deepEqual(taken.map((r) => r.device), ['CANTEEN-02', 'WATER-01']);
    assert.deepEqual(card.memory.receipts, []);
    assert.deepEqual(card.takeReceipts(), []);
    // What was handed over no longer belongs to the card.
    card.addReceipt(receipt({ device: 'CANTEEN-01' }));
    assert.equal(taken.length, 2);
    taken[0].result = 'REJECTED';
    assert.equal(card.memory.receipts[0].result, 'APPLIED');
    // Token and packs stay for the next round of taps.
    assert.equal(card.token, 7);
    assert.equal(card.memory.packs.length, 3);
  });

  test('receipts taken for an upload that failed can be put back', () => {
    const card = loaded();
    card.addReceipt(receipt({ device: 'CANTEEN-02' }));
    card.addReceipt(receipt({ device: 'WATER-01', error: 'older version', result: 'REJECTED' }));
    const before = card.memory.receipts;
    const taken = card.takeReceipts();
    for (const r of taken) card.addReceipt(r);
    assert.deepEqual(card.memory.receipts, before);
  });
});

describe('a round with an offline machine', () => {
  test('load at the kiosk, check each pack at the machine, write receipts, take them back', () => {
    const card = new AdminCard({ schoolCode: SCHOOL });
    const damaged = { ...pack('settings', 2, SETTINGS), checksum: packChecksum({ other: true }) };
    card.load({ token: 3, packs: [pack('blocklist', 4, BLOCKLIST), pack('prices', 2, PRICES), damaged], loadedAt: clock.iso() });
    // A machine that has prices 2 already and no block list yet.
    const machine = { blocklist: 0, prices: 2, settings: 1 };
    for (const p of card.memory.packs) {
      let result = 'APPLIED';
      let error;
      if (!verifyPack(p)) {
        result = 'REJECTED';
        error = 'checksum does not match';
      } else if (p.version === machine[p.kind]) result = 'ALREADY_APPLIED';
      else machine[p.kind] = p.version;
      card.addReceipt({ device: 'CANTEEN-02', kind: p.kind, appliedVersion: machine[p.kind], result, error, at: clock.iso() });
    }
    assert.deepEqual(
      card.takeReceipts().map((r) => [r.kind, r.appliedVersion, r.result]),
      [['blocklist', 4, 'APPLIED'], ['prices', 2, 'ALREADY_APPLIED'], ['settings', 1, 'REJECTED']],
    );
  });
});
