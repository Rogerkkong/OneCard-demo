import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import {
  createConfigs,
  DEFAULT_PRICES,
  DEFAULT_SETTINGS,
  LIST_STATE_VIAS,
  validatePrices,
  validateSettings,
} from '../../src/platform/configs.js';
import { createSchools } from '../../src/platform/schools.js';
import { createDevices } from '../../src/platform/devices.js';
import { canonicalJson, cardDigest, randomSecret, sha256hex } from '../../src/shared/crypto.js';
import { HOUR, MINUTE, parseIso, toIso } from '../../src/shared/time.js';

// Schools, members, cards and devices are inserted straight into the tables so these
// tests depend only on the schema, not on the schools or devices services.
// Every name is made up; card keys and device secrets are generated for each run.

const A = 'sch_a';
const B = 'sch_b';
const SCHOOLS = {
  [A]: { code: 'smk-contoh', name: 'SMK Seri Contoh', cardKey: randomSecret() },
  [B]: { code: 'sjkc-contoh', name: 'SJK(C) Contoh', cardKey: randomSecret() },
};
// crd_b1 has the same UID as crd_a1 on purpose: the same chip in another school is another card.
const CARDS = {
  crd_a1: { schoolId: A, memberId: 'mem_a1', name: 'Aina Contoh', uid: '04A1B2C3D4E5F6' },
  crd_a2: { schoolId: A, memberId: 'mem_a2', name: 'Badrul Contoh', uid: '04B7C8D9EAFB01' },
  crd_a3: { schoolId: A, memberId: 'mem_a3', name: 'Chandra Contoh', uid: '04C2D3E4F5A6B7' },
  crd_b1: { schoolId: B, memberId: 'mem_b1', name: 'Dong Contoh', uid: '04A1B2C3D4E5F6' },
};
// Inserted out of code order: listStates() sorts by device code.
const DEVICES = {
  dev_a_water: { schoolId: A, code: 'WATER-01', type: 'WATER' },
  dev_a_canteen: { schoolId: A, code: 'CANTEEN-01', type: 'CANTEEN' },
  dev_a_kiosk: { schoolId: A, code: 'KIOSK-01', type: 'KIOSK' },
  dev_b_canteen: { schoolId: B, code: 'CANTEEN-01', type: 'CANTEEN' },
};

const digest = (cardId) => {
  const { schoolId, uid } = CARDS[cardId];
  return cardDigest(SCHOOLS[schoolId].cardKey, SCHOOLS[schoolId].code, uid);
};
const last4 = (cardId) => CARDS[cardId].uid.slice(-4);
/** The block-list entry for a card: digest and last4, never the UID. */
const entry = (cardId) => ({ card: digest(cardId), last4: last4(cardId) });

function seed(ctx) {
  const now = ctx.clock.now();
  for (const [id, s] of Object.entries(SCHOOLS)) {
    ctx.db.run('INSERT INTO school (id, code, name, card_key, created_at) VALUES (?, ?, ?, ?, ?)', id, s.code, s.name, s.cardKey, now);
  }
  for (const [id, c] of Object.entries(CARDS)) {
    ctx.db.run(
      'INSERT INTO member (id, school_id, member_no, name, created_at) VALUES (?, ?, ?, ?, ?)',
      c.memberId, c.schoolId, c.memberId.toUpperCase(), c.name, now,
    );
    ctx.db.run(
      'INSERT INTO card (id, school_id, uid, digest, member_id, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, c.schoolId, c.uid, digest(id), c.memberId, now,
    );
  }
  for (const [id, d] of Object.entries(DEVICES)) {
    ctx.db.run(
      'INSERT INTO device (id, school_id, code, type, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, d.schoolId, d.code, d.type, randomSecret(), now,
    );
  }
}

function rejects(fn, code, status) {
  let caught;
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'LabError', `expected a LabError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (status !== undefined) assert.equal(err.status, status);
    caught = err;
    return true;
  });
  return caught;
}

/** Runs `fn`, expects CONFIG_INVALID (400) and returns its detail: the list of problems. */
function problemsOf(fn) {
  const err = rejects(fn, 'CONFIG_INVALID', 400);
  assert.ok(Array.isArray(err.detail) && err.detail.length > 0, 'detail must list the problems');
  for (const p of err.detail) assert.equal(typeof p, 'string');
  assert.ok(err.message.includes(err.detail[0]), 'the message shows the first problem');
  return err.detail;
}

/** Some problem mentions every fragment. */
function hasProblem(problems, ...fragments) {
  assert.ok(
    problems.some((p) => fragments.every((f) => p.includes(f))),
    `no problem mentions ${fragments.map((f) => JSON.stringify(f)).join(' + ')}:\n  ${problems.join('\n  ')}`,
  );
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const prices = (overrides = {}) => ({ ...plain(DEFAULT_PRICES), ...overrides });
const settings = (overrides = {}) => ({ ...plain(DEFAULT_SETTINGS), ...overrides });
const item = (code, priceSen, name = 'Something') => ({ code, name, priceSen });
const count = (ctx, from, ...params) => ctx.db.get(`SELECT count(*) AS n FROM ${from}`, ...params).n;
const published = (ctx) => eventsOf(ctx, 'config.published').map((e) => [e.school, e.data]);

let ctx;
let configs;
let audits;
beforeEach(() => {
  ctx = createTestCtx();
  seed(ctx);
  audits = [];
  // a stand-in for the schools service: only its audit() is used
  configs = createConfigs(ctx, { schools: { audit: (...args) => audits.push(args) } });
});
afterEach(() => {
  ctx.db.close();
});

const block = (cardId, actor) => configs.blockCard({ schoolId: CARDS[cardId].schoolId, cardId, actor });
const unblock = (cardId, actor) => configs.unblockCard({ schoolId: CARDS[cardId].schoolId, cardId, actor });

describe('DEFAULT_PRICES and DEFAULT_SETTINGS', () => {
  test('are the lab canteen menu, water tariff and terminal limits', () => {
    assert.deepEqual(plain(DEFAULT_PRICES), {
      items: [
        { code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 350 },
        { code: 'MEE-GORENG', name: 'Mee goreng', priceSen: 400 },
        { code: 'ROTI-CANAI', name: 'Roti canai', priceSen: 150 },
        { code: 'TEH-TARIK', name: 'Teh tarik', priceSen: 180 },
        { code: 'MILO-AIS', name: 'Milo ais', priceSen: 220 },
        { code: 'AIR-SIRAP', name: 'Air sirap', priceSen: 120 },
        { code: 'BUAH', name: 'Fruit', priceSen: 100 },
      ],
      water: { perLitreSen: 20, minChargeSen: 5 },
    });
    assert.deepEqual(plain(DEFAULT_SETTINGS), {
      mealWindows: [{ from: '06:30', to: '18:30' }],
      allowedGroups: ['STUDENT', 'STAFF'],
      perPurchaseMaxSen: 2000,
      dailyMaxSen: 3000,
      dailyMaxCount: 10,
      tapGapSeconds: 3,
    });
  });

  test('cannot be changed at run time', () => {
    for (const obj of [DEFAULT_PRICES, DEFAULT_PRICES.items, DEFAULT_PRICES.items[0], DEFAULT_PRICES.water]) assert.ok(Object.isFrozen(obj));
    for (const obj of [DEFAULT_SETTINGS, DEFAULT_SETTINGS.mealWindows, DEFAULT_SETTINGS.mealWindows[0], DEFAULT_SETTINGS.allowedGroups]) {
      assert.ok(Object.isFrozen(obj));
    }
    assert.throws(() => {
      DEFAULT_PRICES.items[0].priceSen = 1;
    }, TypeError);
  });

  test('pass their own validation unchanged, as fresh copies', () => {
    const p = validatePrices(DEFAULT_PRICES);
    assert.deepEqual(p, plain(DEFAULT_PRICES));
    assert.notEqual(p.items, DEFAULT_PRICES.items);
    assert.notEqual(p.items[0], DEFAULT_PRICES.items[0]);
    const s = validateSettings(DEFAULT_SETTINGS);
    assert.deepEqual(s, plain(DEFAULT_SETTINGS));
    assert.notEqual(s.mealWindows[0], DEFAULT_SETTINGS.mealWindows[0]);
    assert.notEqual(s.allowedGroups, DEFAULT_SETTINGS.allowedGroups);
  });

  test('every limit in the defaults is whole sen or a whole count', () => {
    for (const it of DEFAULT_PRICES.items) assert.ok(Number.isSafeInteger(it.priceSen) && it.priceSen > 0);
    for (const k of ['perPurchaseMaxSen', 'dailyMaxSen', 'dailyMaxCount', 'tapGapSeconds']) assert.ok(Number.isSafeInteger(DEFAULT_SETTINGS[k]));
  });
});

describe('validatePrices()', () => {
  test('returns a clean copy: item codes trimmed and upper-cased, names trimmed', () => {
    const input = { items: [{ code: ' nasi-lemak ', name: '  Nasi lemak  ', priceSen: 350 }], water: { perLitreSen: 20, minChargeSen: 0 } };
    const before = structuredClone(input);
    assert.deepEqual(validatePrices(input), {
      items: [{ code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 350 }],
      water: { perLitreSen: 20, minChargeSen: 0 },
    });
    assert.deepEqual(input, before, 'the input is not changed');
  });

  test('accepts the edges of every range', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`ITEM-${i}`, i % 2 ? 1 : 100_000));
    items[0] = { code: 'A'.repeat(24), name: 'N'.repeat(40), priceSen: 1 };
    assert.equal(validatePrices({ items, water: { perLitreSen: 1, minChargeSen: 0 } }).items.length, 50);
    assert.deepEqual(validatePrices({ items: [item('X', 100_000, 'X')], water: { perLitreSen: 10_000, minChargeSen: 10_000 } }).water, {
      perLitreSen: 10_000,
      minChargeSen: 10_000,
    });
  });

  test('refuses anything that is not an object', () => {
    for (const bad of [undefined, null, 'NASI-LEMAK 350', 42, [], [plain(DEFAULT_PRICES)]]) {
      hasProblem(problemsOf(() => validatePrices(bad)), 'the price list must be an object { items, water }');
    }
  });

  test('needs a list of 1 to 50 items', () => {
    hasProblem(problemsOf(() => validatePrices(prices({ items: undefined }))), 'items must be a list of 1 to 50 items', 'missing');
    hasProblem(problemsOf(() => validatePrices(prices({ items: { code: 'BUAH' } }))), 'items must be a list', 'got an object');
    hasProblem(problemsOf(() => validatePrices(prices({ items: [] }))), 'items must be a list', 'got a list of 0');
    const tooMany = Array.from({ length: 51 }, (_, i) => item(`ITEM-${i}`, 100));
    // one problem for the length, not one per item
    assert.deepEqual(problemsOf(() => validatePrices(prices({ items: tooMany }))), ['items must be a list of 1 to 50 items (got a list of 51)']);
  });

  test('every item is an object { code, name, priceSen }', () => {
    for (const bad of ['BUAH', null, 100, ['BUAH', 'Fruit', 100]]) {
      hasProblem(problemsOf(() => validatePrices(prices({ items: [item('TEH-TARIK', 180), bad] }))), 'items[1] must be an object { code, name, priceSen }');
    }
  });

  test('item codes are 1 to 24 of A-Z, 0-9 and "-"', () => {
    for (const code of ['', '   ', 'NASI LEMAK', 'NASI_LEMAK', 'TEH-TARIK!', 'KUIH.LAPIS', 'A'.repeat(25), 42, null, undefined]) {
      hasProblem(problemsOf(() => validatePrices(prices({ items: [item(code, 100)] }))), 'items[0].code must be 1 to 24 characters of A-Z, 0-9 and "-"');
    }
  });

  test('item codes are unique, whatever their case', () => {
    const items = [item('TEH-TARIK', 180), item('MILO-AIS', 220), item(' teh-tarik', 200)];
    assert.deepEqual(problemsOf(() => validatePrices(prices({ items }))), ['items[2].code TEH-TARIK is already used by items[0]']);
  });

  test('item names are text of 1 to 40 characters', () => {
    for (const name of ['', '    ', 'N'.repeat(41), 42, null, undefined, ['Nasi lemak']]) {
      hasProblem(
        problemsOf(() => validatePrices(prices({ items: [{ code: 'BUAH', name, priceSen: 100 }] }))),
        'items[0].name must be text of 1 to 40 characters',
      );
    }
  });

  test('item names cannot hold line breaks, tabs or other control characters', () => {
    for (const name of ['Nasi\nlemak', 'Teh\r\ntarik', 'Milo\tais', 'Roti\u0000canai', 'Air\u007fsirap', 'Buah\u0085', 'Mee goreng']) {
      hasProblem(
        problemsOf(() => validatePrices(prices({ items: [{ code: 'BUAH', name, priceSen: 100 }] }))),
        'items[0].name must not contain line breaks, tabs or other control characters',
      );
    }
    // white space around the name is trimmed, not refused; any script is fine
    assert.equal(validatePrices(prices({ items: [{ code: 'BUAH', name: '\tFruit\n', priceSen: 100 }] })).items[0].name, 'Fruit');
    assert.equal(validatePrices(prices({ items: [{ code: 'CKT', name: '炒粿条 Char kway teow', priceSen: 500 }] })).items[0].name, '炒粿条 Char kway teow');
  });

  test('prices are whole sen from 1 to 100000', () => {
    for (const priceSen of [0, -350, 100_001, 3.5, '350', null, undefined, NaN, Infinity, true]) {
      hasProblem(
        problemsOf(() => validatePrices(prices({ items: [item('BUAH', priceSen)] }))),
        'items[0].priceSen must be a whole number of sen from 1 to 100000',
      );
    }
  });

  test('the water tariff needs perLitreSen 1..10000 and minChargeSen 0..10000', () => {
    hasProblem(problemsOf(() => validatePrices(prices({ water: undefined }))), 'water must be an object { perLitreSen, minChargeSen }', 'missing');
    hasProblem(problemsOf(() => validatePrices(prices({ water: [20, 5] }))), 'water must be an object', 'got a list of 2');
    for (const v of [0, 10_001, 1.5, '20', null, undefined]) {
      hasProblem(
        problemsOf(() => validatePrices(prices({ water: { perLitreSen: v, minChargeSen: 5 } }))),
        'water.perLitreSen must be a whole number of sen from 1 to 10000',
      );
    }
    for (const v of [-1, 10_001, 0.5, '5', null, undefined]) {
      hasProblem(
        problemsOf(() => validatePrices(prices({ water: { perLitreSen: 20, minChargeSen: v } }))),
        'water.minChargeSen must be a whole number of sen from 0 to 10000',
      );
    }
  });

  test('refuses unknown fields instead of quietly dropping them', () => {
    hasProblem(problemsOf(() => validatePrices(prices({ currency: 'MYR' }))), 'price list: unknown field "currency" (allowed: items, water)');
    hasProblem(
      problemsOf(() => validatePrices(prices({ items: [{ ...item('BUAH', 100), costSen: 60 }] }))),
      'items[0]: unknown field "costSen" (allowed: code, name, priceSen)',
    );
    // the typo case: without this check the tariff would silently lose the field meant to be set
    const problems = problemsOf(() => validatePrices(prices({ water: { perLiterSen: 25, minChargeSen: 5 } })));
    hasProblem(problems, 'water: unknown field "perLiterSen"');
    hasProblem(problems, 'water.perLitreSen', 'missing');
    // an undefined value is the same as no field
    assert.equal(validatePrices(prices({ note: undefined })).items.length, 7);
  });

  test('reports every problem at once, each with where it is and what was given', () => {
    const problems = problemsOf(() =>
      validatePrices({
        items: [item('ROTI-CANAI', 150), 'not an item', { code: 'bad code', name: '', priceSen: 0 }],
        water: { perLitreSen: 0, minChargeSen: -1 },
        extra: 1,
      }),
    );
    assert.equal(problems.length, 7);
    hasProblem(problems, 'price list: unknown field "extra"');
    hasProblem(problems, 'items[1] must be an object', 'got "not an item"');
    hasProblem(problems, 'items[2].code', 'got "bad code"');
    hasProblem(problems, 'items[2].name', 'got ""');
    hasProblem(problems, 'items[2].priceSen', 'got 0');
    hasProblem(problems, 'water.perLitreSen', 'got 0');
    hasProblem(problems, 'water.minChargeSen', 'got -1');
  });

  test('the message shows the first three problems and how many more there are', () => {
    const err = rejects(() => validatePrices({ items: [{}], water: {} }), 'CONFIG_INVALID', 400);
    assert.equal(err.detail.length, 5);
    assert.match(err.message, /^invalid price list: items\[0\]\.code .+; items\[0\]\.name .+; items\[0\]\.priceSen .+; and 2 more$/);
  });
});

describe('validateSettings()', () => {
  test('returns a clean copy of valid settings', () => {
    const input = settings({ mealWindows: [{ from: '07:00', to: '09:00' }, { from: '12:30', to: '14:00' }], allowedGroups: ['STAFF'] });
    const out = validateSettings(input);
    assert.deepEqual(out, input);
    assert.notEqual(out.mealWindows, input.mealWindows);
    assert.notEqual(out.mealWindows[0], input.mealWindows[0]);
    assert.notEqual(out.allowedGroups, input.allowedGroups);
  });

  test('accepts the edges of every range', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` }));
    assert.equal(validateSettings(settings({ mealWindows: six, perPurchaseMaxSen: 1, dailyMaxSen: 1, dailyMaxCount: 1, tapGapSeconds: 0 })).mealWindows.length, 6);
    // no meal windows: no time limit
    const open = validateSettings(settings({ mealWindows: [], perPurchaseMaxSen: 100_000, dailyMaxSen: 1_000_000, dailyMaxCount: 100, tapGapSeconds: 600 }));
    assert.deepEqual(open.mealWindows, []);
    assert.deepEqual(validateSettings(settings({ mealWindows: [{ from: '00:00', to: '23:59' }] })).mealWindows, [{ from: '00:00', to: '23:59' }]);
    assert.deepEqual(validateSettings(settings({ allowedGroups: ['STAFF', 'STUDENT'] })).allowedGroups, ['STAFF', 'STUDENT']);
  });

  test('refuses anything that is not an object', () => {
    for (const bad of [undefined, null, 'open all day', 3, [plain(DEFAULT_SETTINGS)]]) {
      hasProblem(problemsOf(() => validateSettings(bad)), 'the settings must be an object');
    }
  });

  test('mealWindows is a list of 0 to 6 windows', () => {
    hasProblem(problemsOf(() => validateSettings(settings({ mealWindows: undefined }))), 'mealWindows must be a list of 0 to 6 windows', 'missing');
    hasProblem(problemsOf(() => validateSettings(settings({ mealWindows: { from: '06:30', to: '18:30' } }))), 'mealWindows must be a list', 'got an object');
    const seven = Array.from({ length: 7 }, (_, i) => ({ from: `1${i}:00`, to: `1${i}:30` }));
    assert.deepEqual(problemsOf(() => validateSettings(settings({ mealWindows: seven }))), ['mealWindows must be a list of 0 to 6 windows (got a list of 7)']);
  });

  test('each window has 24-hour "HH:MM" times', () => {
    for (const t of ['6:30', '24:00', '12:60', '0630', '06:30:00', '06h30', 630, null, undefined, ['06:30']]) {
      hasProblem(
        problemsOf(() => validateSettings(settings({ mealWindows: [{ from: t, to: '18:30' }] }))),
        'mealWindows[0].from must be a 24-hour time "HH:MM"',
      );
      hasProblem(
        problemsOf(() => validateSettings(settings({ mealWindows: [{ from: '06:30', to: t }] }))),
        'mealWindows[0].to must be a 24-hour time "HH:MM"',
      );
    }
  });

  test('each window starts before it ends, within one day', () => {
    hasProblem(problemsOf(() => validateSettings(settings({ mealWindows: [{ from: '12:00', to: '12:00' }] }))), 'mealWindows[0]: from (12:00) must be earlier than to (12:00)');
    hasProblem(
      problemsOf(() => validateSettings(settings({ mealWindows: [{ from: '06:30', to: '18:30' }, { from: '22:00', to: '02:00' }] }))),
      'mealWindows[1]: from (22:00) must be earlier than to (02:00)',
    );
  });

  test('each window is an object { from, to } with nothing else', () => {
    hasProblem(problemsOf(() => validateSettings(settings({ mealWindows: ['06:30-18:30'] }))), 'mealWindows[0] must be an object { from, to }');
    hasProblem(
      problemsOf(() => validateSettings(settings({ mealWindows: [{ from: '06:30', to: '18:30', label: 'Rehat' }] }))),
      'mealWindows[0]: unknown field "label" (allowed: from, to)',
    );
  });

  test('allowedGroups lists STUDENT and/or STAFF, each once', () => {
    for (const groups of [undefined, [], 'STUDENT', ['STUDENT', 'STAFF', 'STUDENT']]) {
      hasProblem(problemsOf(() => validateSettings(settings({ allowedGroups: groups }))), 'allowedGroups must list 1 to 2 of STUDENT, STAFF, each once');
    }
    hasProblem(problemsOf(() => validateSettings(settings({ allowedGroups: ['STUDENT', 'PARENT'] }))), 'allowedGroups[1] must be one of STUDENT, STAFF', 'got "PARENT"');
    hasProblem(problemsOf(() => validateSettings(settings({ allowedGroups: ['student'] }))), 'allowedGroups[0] must be one of STUDENT, STAFF');
    hasProblem(problemsOf(() => validateSettings(settings({ allowedGroups: [null] }))), 'allowedGroups[0] must be one of STUDENT, STAFF', 'got null');
    assert.deepEqual(problemsOf(() => validateSettings(settings({ allowedGroups: ['STAFF', 'STAFF'] }))), ['allowedGroups[1]: STAFF is listed twice']);
  });

  test('limits are whole numbers in their ranges', () => {
    const rules = {
      perPurchaseMaxSen: ['a whole number of sen from 1 to 100000', [0, 100_001, 12.5, '2000', null]],
      dailyMaxSen: ['a whole number of sen from 1 to 1000000', [0, 1_000_001, -3000, undefined]],
      dailyMaxCount: ['a whole number from 1 to 100', [0, 101, 2.5, '10']],
      tapGapSeconds: ['a whole number of seconds from 0 to 600', [-1, 601, 0.5, undefined]],
    };
    for (const [field, [rule, bads]] of Object.entries(rules)) {
      for (const bad of bads) hasProblem(problemsOf(() => validateSettings(settings({ [field]: bad }))), `${field} must be ${rule}`);
    }
  });

  test('refuses unknown fields', () => {
    hasProblem(problemsOf(() => validateSettings(settings({ dailyMaxAmountSen: 3000 }))), 'settings: unknown field "dailyMaxAmountSen"');
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`x${i}`, i]));
    hasProblem(problemsOf(() => validateSettings(settings(many))), 'settings: unknown fields "x0", "x1", "x2", "x3", "x4" and 3 more');
  });

  test('holes in a sparse list are checked like missing entries, not skipped', () => {
    const sparse = (at, value) => {
      const list = [];
      list[at] = value;
      return list;
    };
    hasProblem(problemsOf(() => validateSettings(settings({ allowedGroups: sparse(1, 'STUDENT') }))), 'allowedGroups[0] must be one of STUDENT, STAFF (missing)');
    hasProblem(problemsOf(() => validateSettings(settings({ mealWindows: sparse(1, { from: '06:30', to: '18:30' }) }))), 'mealWindows[0] must be an object { from, to } (missing)');
    hasProblem(problemsOf(() => validatePrices(prices({ items: sparse(1, item('BUAH', 100)) }))), 'items[0] must be an object { code, name, priceSen } (missing)');
  });

  test('reports every problem at once', () => {
    const problems = problemsOf(() =>
      validateSettings({
        mealWindows: [{ from: '18:30', to: '06:30' }],
        allowedGroups: [],
        perPurchaseMaxSen: 0,
        dailyMaxSen: 0,
        dailyMaxCount: 0,
        tapGapSeconds: -1,
      }),
    );
    assert.equal(problems.length, 6);
    for (const where of ['mealWindows[0]', 'allowedGroups', 'perPurchaseMaxSen', 'dailyMaxSen', 'dailyMaxCount', 'tapGapSeconds']) {
      hasProblem(problems, where);
    }
  });
});

describe('publish()', () => {
  test('stores version 1, then 2, and returns { kind, version, content, effectiveFrom }', () => {
    const t0 = ctx.clock.now();
    assert.deepEqual(configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES, actor: 'stf_office' }), {
      kind: 'prices',
      version: 1,
      content: plain(DEFAULT_PRICES),
      effectiveFrom: t0,
    });
    ctx.clock.advance(MINUTE);
    const cheaper = prices({ items: [item('NASI-LEMAK', 300, 'Nasi lemak')] });
    const second = configs.publish({ schoolId: A, kind: 'prices', content: cheaper, actor: 'stf_admin' });
    assert.deepEqual(second, { kind: 'prices', version: 2, content: cheaper, effectiveFrom: t0 + MINUTE });
    assert.deepEqual(configs.current(A, 'prices').content, cheaper);
    const rows = ctx.db.all("SELECT version, created_by, created_at FROM config_version WHERE school_id = ? AND kind = 'prices' ORDER BY version", A);
    assert.deepEqual(rows.map((r) => [r.version, r.created_by, r.created_at]), [[1, 'stf_office', t0], [2, 'stf_admin', t0 + MINUTE]]);
  });

  test('stores the clean content', () => {
    const out = configs.publish({
      schoolId: A,
      kind: 'prices',
      content: { items: [{ code: ' teh-tarik', name: ' Teh tarik ', priceSen: 180 }], water: { perLitreSen: 20, minChargeSen: 5 } },
    });
    const clean = { items: [{ code: 'TEH-TARIK', name: 'Teh tarik', priceSen: 180 }], water: { perLitreSen: 20, minChargeSen: 5 } };
    assert.deepEqual(out.content, clean);
    assert.deepEqual(configs.current(A, 'prices').content, clean);
  });

  test('each school and each kind has its own version numbers', () => {
    const v = (schoolId, kind) => configs.publish({ schoolId, kind, content: kind === 'prices' ? DEFAULT_PRICES : DEFAULT_SETTINGS }).version;
    assert.equal(v(A, 'prices'), 1);
    assert.equal(v(A, 'prices'), 2);
    assert.equal(v(A, 'settings'), 1);
    assert.equal(v(B, 'prices'), 1);
    assert.equal(block('crd_a1').version, 1);
    assert.equal(v(A, 'prices'), 3);
    assert.equal(v(B, 'settings'), 1);
    assert.equal(v(A, 'settings'), 2);
    assert.equal(block('crd_b1').version, 1);
  });

  test('publishing the same content again is still a new version (previous + 1)', () => {
    configs.publish({ schoolId: A, kind: 'settings', content: DEFAULT_SETTINGS });
    const again = configs.publish({ schoolId: A, kind: 'settings', content: DEFAULT_SETTINGS });
    assert.equal(again.version, 2);
    assert.deepEqual(configs.getVersion(A, 'settings', 1).content, configs.getVersion(A, 'settings', 2).content);
  });

  test('effectiveFrom defaults to now and takes lab-clock ms or an ISO-8601 time', () => {
    const at = Date.parse('2026-10-06T00:00:00.000Z');
    assert.equal(configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES, effectiveFrom: at }).effectiveFrom, at);
    assert.equal(configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES, effectiveFrom: '2026-10-06T08:00:00+08:00' }).effectiveFrom, at);
    assert.equal(configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES, effectiveFrom: null }).effectiveFrom, ctx.clock.now());
    assert.deepEqual(configs.history(A, 'prices').map((v) => v.effectiveFrom), [ctx.clock.now(), at, at]);
    // stored as integer ms, like every time in the database
    assert.equal(ctx.db.get("SELECT typeof(effective_from) AS t FROM config_version WHERE school_id = ? AND version = 2 AND kind = 'prices'", A).t, 'integer');
  });

  test('a bad effectiveFrom is CONFIG_INVALID and stores nothing', () => {
    for (const bad of [-1, 1.5, NaN, 'tomorrow', '2026-10-06', '06/10/2026 08:00', {}, true]) {
      hasProblem(
        problemsOf(() => configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES, effectiveFrom: bad })),
        'effectiveFrom must be lab-clock milliseconds or an ISO-8601 timestamp',
      );
    }
    assert.equal(count(ctx, 'config_version'), 0);
  });

  test('effectiveFrom must fit an ISO-8601 timestamp with a 4-digit year (it is sent to machines as one)', () => {
    const last = Date.parse('9999-12-31T23:59:59.999Z');
    const pub = (effectiveFrom) => configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES, effectiveFrom });
    assert.equal(pub(0).effectiveFrom, 0);
    assert.equal(pub(last).effectiveFrom, last);
    assert.equal(pub('9999-12-31T23:59:59.999Z').effectiveFrom, last);
    // the Date maximum and beyond: toIso() throws or writes a 6-digit year parseIso() cannot read
    for (const bad of [last + 1, 8.64e15, Number.MAX_SAFE_INTEGER, '1969-12-31T23:59:59.999Z']) {
      hasProblem(
        problemsOf(() => pub(bad)),
        'effectiveFrom must be lab-clock milliseconds or an ISO-8601 timestamp, from 1970 to the end of 9999',
      );
    }
    const stored = configs.history(A, 'prices');
    assert.equal(stored.length, 3);
    for (const v of stored) assert.equal(parseIso(toIso(v.effectiveFrom)), v.effectiveFrom);
  });

  test('only prices and settings can be published (CONFIG_INVALID)', () => {
    for (const kind of ['blocklist', 'PRICES', 'menu', undefined]) {
      hasProblem(problemsOf(() => configs.publish({ schoolId: A, kind, content: { entries: [] } })), 'kind must be prices or settings');
    }
    assert.equal(count(ctx, 'config_version'), 0);
  });

  test('invalid content is CONFIG_INVALID: nothing stored, announced or audited', () => {
    problemsOf(() => configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_SETTINGS }));
    problemsOf(() => configs.publish({ schoolId: A, kind: 'settings', content: DEFAULT_PRICES }));
    problemsOf(() => configs.publish({ schoolId: A, kind: 'prices', content: prices({ water: { perLitreSen: 0, minChargeSen: 5 } }) }));
    problemsOf(() => configs.publish({ schoolId: A, kind: 'settings' }));
    assert.equal(count(ctx, 'config_version'), 0);
    assert.deepEqual(published(ctx), []);
    assert.deepEqual(audits, []);
    // and the first good one is still version 1
    assert.equal(configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES }).version, 1);
  });

  test('an unknown school is SCHOOL_NOT_FOUND (404)', () => {
    rejects(() => configs.publish({ schoolId: 'sch_nope', kind: 'prices', content: DEFAULT_PRICES }), 'SCHOOL_NOT_FOUND', 404);
    rejects(() => configs.publish({ kind: 'prices', content: DEFAULT_PRICES }), 'SCHOOL_NOT_FOUND', 404);
    assert.equal(count(ctx, 'config_version'), 0);
    assert.deepEqual(published(ctx), []);
  });

  test('announces config.published { kind, version } with the school code', () => {
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    configs.publish({ schoolId: B, kind: 'settings', content: DEFAULT_SETTINGS });
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    assert.deepEqual(published(ctx), [
      ['smk-contoh', { kind: 'prices', version: 1 }],
      ['sjkc-contoh', { kind: 'settings', version: 1 }],
      ['smk-contoh', { kind: 'prices', version: 2 }],
    ]);
  });

  test('writes the audit trail through the schools service', () => {
    configs.publish({ schoolId: A, kind: 'settings', content: DEFAULT_SETTINGS, actor: 'stf_office' });
    assert.deepEqual(audits, [[A, 'stf_office', 'config.publish', { kind: 'settings', version: 1 }]]);
  });

  test('works without a schools service, still recording who made the version', () => {
    const bare = createConfigs(ctx);
    assert.equal(bare.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES, actor: { id: 'stf_1', name: 'Nur Contoh' } }).version, 1);
    assert.equal(bare.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES }).version, 2);
    const who = ctx.db.all("SELECT created_by FROM config_version WHERE school_id = ? AND kind = 'prices' ORDER BY version", A).map((r) => r.created_by);
    assert.deepEqual(who, ['Nur Contoh (stf_1)', null]);
    assert.deepEqual(audits, []);
  });

  test('reads the last version number and writes the next one inside one transaction', () => {
    const seen = [];
    const { get, run } = ctx.db;
    ctx.db.get = (sql, ...params) => {
      if (sql.includes('max(version)')) seen.push(['read', ctx.db.inTransaction()]);
      return get(sql, ...params);
    };
    ctx.db.run = (sql, ...params) => {
      if (sql.startsWith('INSERT INTO config_version')) seen.push(['write', ctx.db.inTransaction()]);
      return run(sql, ...params);
    };
    try {
      configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
      block('crd_a1');
      unblock('crd_a1');
    } finally {
      ctx.db.get = get;
      ctx.db.run = run;
    }
    assert.deepEqual(seen, [['read', true], ['write', true], ['read', true], ['write', true], ['read', true], ['write', true]]);
  });

  test('a version whose surrounding transaction fails is not kept, so numbers stay gap-free', () => {
    assert.throws(
      () =>
        ctx.db.tx(() => {
          configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
          throw new Error('a later step failed');
        }),
      /a later step failed/,
    );
    assert.equal(configs.current(A, 'prices'), null);
    assert.equal(configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES }).version, 1);
  });

  test('changing the returned content does not change what was stored', () => {
    const out = configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    out.content.items[0].priceSen = 1;
    assert.equal(configs.current(A, 'prices').content.items[0].priceSen, 350);
  });
});

describe('current(), getVersion() and history()', () => {
  test('before anything is published: prices and settings are null, the block list is version 0', () => {
    assert.equal(configs.current(A, 'prices'), null);
    assert.equal(configs.current(A, 'settings'), null);
    assert.deepEqual(configs.current(A, 'blocklist'), { kind: 'blocklist', version: 0, content: { entries: [] } });
    assert.deepEqual(configs.history(A, 'prices'), []);
    assert.deepEqual(configs.history(A, 'blocklist'), []);
  });

  test('current() is the newest version, with when it applies and when it was made', () => {
    const t0 = ctx.clock.now();
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    ctx.clock.advance(HOUR);
    const next = prices({ items: [item('BUAH', 120, 'Fruit')] });
    configs.publish({ schoolId: A, kind: 'prices', content: next, effectiveFrom: t0 + 2 * HOUR });
    assert.deepEqual(configs.current(A, 'prices'), { kind: 'prices', version: 2, content: next, effectiveFrom: t0 + 2 * HOUR, createdAt: t0 + HOUR });
  });

  test('current() of the block list carries the snapshot and the change it made', () => {
    block('crd_a1');
    ctx.clock.advance(MINUTE);
    block('crd_a2');
    assert.deepEqual(configs.current(A, 'blocklist'), {
      kind: 'blocklist',
      version: 2,
      content: { entries: [entry('crd_a1'), entry('crd_a2')], added: [entry('crd_a2')], removed: [] },
      effectiveFrom: ctx.clock.now(),
      createdAt: ctx.clock.now(),
    });
  });

  test('getVersion() returns any issued version and null otherwise', () => {
    const t0 = ctx.clock.now();
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    ctx.clock.advance(MINUTE);
    configs.publish({ schoolId: A, kind: 'prices', content: prices({ water: { perLitreSen: 25, minChargeSen: 5 } }) });
    assert.deepEqual(configs.getVersion(A, 'prices', 1), { kind: 'prices', version: 1, content: plain(DEFAULT_PRICES), effectiveFrom: t0, createdAt: t0 });
    assert.equal(configs.getVersion(A, 'prices', 2).content.water.perLitreSen, 25);
    for (const v of [3, 0, -1, 1.5, '1', null, undefined]) assert.equal(configs.getVersion(A, 'prices', v), null);
    assert.equal(configs.getVersion(A, 'settings', 1), null);
  });

  test('getVersion() knows block-list version 0 as the empty list every school starts from', () => {
    assert.deepEqual(configs.getVersion(A, 'blocklist', 0), { kind: 'blocklist', version: 0, content: { entries: [] } });
    block('crd_a1');
    assert.deepEqual(configs.getVersion(A, 'blocklist', 0), { kind: 'blocklist', version: 0, content: { entries: [] } });
    assert.deepEqual(configs.getVersion(A, 'blocklist', 1).content, { entries: [entry('crd_a1')], added: [entry('crd_a1')], removed: [] });
    assert.equal(configs.getVersion(A, 'blocklist', 2), null);
  });

  test('history() is newest first, 20 by default, and takes a limit', () => {
    for (let i = 1; i <= 25; i++) configs.publish({ schoolId: A, kind: 'settings', content: settings({ dailyMaxCount: i }) });
    const recent = configs.history(A, 'settings');
    assert.deepEqual(recent.map((v) => v.version), Array.from({ length: 20 }, (_, i) => 25 - i));
    assert.equal(recent[0].content.dailyMaxCount, 25);
    assert.deepEqual(recent[0], configs.current(A, 'settings'));
    assert.deepEqual(configs.history(A, 'settings', 3).map((v) => v.version), [25, 24, 23]);
    // routes may pass the query string's text
    assert.deepEqual(configs.history(A, 'settings', '2').map((v) => v.version), [25, 24]);
    for (const unusable of [0, -5, 'all', null, 2.5]) assert.equal(configs.history(A, 'settings', unusable).length, 20);
    assert.equal(configs.history(A, 'settings', 5000).length, 25);
    assert.deepEqual(configs.history(A, 'prices'), []);
  });

  test('history() of the block list shows what each version changed', () => {
    block('crd_a1');
    block('crd_a2');
    unblock('crd_a1');
    assert.deepEqual(
      configs.history(A, 'blocklist').map((v) => [v.version, v.content.added.map((e) => e.last4), v.content.removed.length, v.content.entries.length]),
      [[3, [], 1, 1], [2, [last4('crd_a2')], 0, 2], [1, [last4('crd_a1')], 0, 1]],
    );
  });

  test('an unknown kind is CONFIG_INVALID', () => {
    for (const fn of [
      () => configs.current(A, 'menu'),
      () => configs.current(A),
      () => configs.getVersion(A, 'Prices', 1),
      () => configs.history(A, 'blocklist-delta'),
    ]) {
      hasProblem(problemsOf(fn), 'kind must be one of prices, settings, blocklist');
    }
  });

  test('results are copies: changing one does not change what is stored', () => {
    configs.publish({ schoolId: A, kind: 'settings', content: DEFAULT_SETTINGS });
    block('crd_a1');
    configs.current(A, 'settings').content.allowedGroups.push('PARENT');
    configs.getVersion(A, 'settings', 1).content.mealWindows.length = 0;
    configs.history(A, 'blocklist')[0].content.entries.length = 0;
    configs.currentBlockList(A).entries.push(entry('crd_a2'));
    configs.current(A, 'blocklist').content.entries.length = 0;
    assert.deepEqual(configs.current(A, 'settings').content, plain(DEFAULT_SETTINGS));
    assert.deepEqual(configs.currentBlockList(A), { version: 1, entries: [entry('crd_a1')] });
    configs.current(B, 'blocklist').content.entries.push(entry('crd_b1'));
    assert.deepEqual(configs.current(B, 'blocklist').content, { entries: [] });
  });

  test("one school never sees another school's versions", () => {
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    block('crd_a1');
    assert.equal(configs.current(B, 'prices'), null);
    assert.equal(configs.getVersion(B, 'prices', 1), null);
    assert.equal(configs.getVersion(B, 'blocklist', 1), null);
    assert.deepEqual(configs.history(B, 'prices'), []);
    assert.deepEqual(configs.current(B, 'blocklist'), { kind: 'blocklist', version: 0, content: { entries: [] } });
    // an unknown or missing school id simply has nothing
    assert.equal(configs.current('sch_nope', 'prices'), null);
    assert.equal(configs.current(undefined, 'prices'), null);
    assert.deepEqual(configs.history(undefined, 'prices'), []);
    assert.equal(configs.getVersion(undefined, 'prices', 1), null);
  });
});

describe('blockCard(), unblockCard() and currentBlockList()', () => {
  test('a school with nothing blocked has the empty list, version 0', () => {
    assert.deepEqual(configs.currentBlockList(A), { version: 0, entries: [] });
    assert.deepEqual(configs.currentBlockList('sch_nope'), { version: 0, entries: [] });
  });

  test('blocking a card makes a new version listing its digest and last4', () => {
    assert.deepEqual(block('crd_a1', 'stf_office'), { version: 1, changed: true });
    assert.deepEqual(configs.currentBlockList(A), { version: 1, entries: [entry('crd_a1')] });
    assert.deepEqual(configs.current(A, 'blocklist').content, { entries: [entry('crd_a1')], added: [entry('crd_a1')], removed: [] });
    assert.equal(ctx.db.get("SELECT created_by FROM config_version WHERE school_id = ? AND kind = 'blocklist'", A).created_by, 'stf_office');
  });

  test('the list carries card digests and last4, never card numbers', () => {
    block('crd_a1');
    block('crd_a2');
    unblock('crd_a1');
    const stored = ctx.db.all('SELECT content FROM config_version WHERE school_id = ?', A).map((r) => r.content).join('\n');
    for (const id of ['crd_a1', 'crd_a2']) {
      assert.ok(!stored.includes(CARDS[id].uid), `the stored list must not contain the UID of ${id}`);
      assert.ok(!stored.toLowerCase().includes(CARDS[id].uid.toLowerCase()));
    }
    const versions = [1, 2, 3].map((v) => configs.getVersion(A, 'blocklist', v).content);
    for (const e of versions.flatMap((c) => [...c.entries, ...c.added])) {
      assert.deepEqual(Object.keys(e).sort(), ['card', 'last4']);
      assert.match(e.card, /^[0-9a-f]{64}$/);
      assert.match(e.last4, /^[0-9A-F]{4}$/);
    }
    assert.deepEqual(versions[2].removed, [digest('crd_a1')]);
  });

  test('each block adds one entry and keeps the earlier ones', () => {
    block('crd_a1');
    assert.deepEqual(block('crd_a2'), { version: 2, changed: true });
    assert.deepEqual(configs.current(A, 'blocklist').content, { entries: [entry('crd_a1'), entry('crd_a2')], added: [entry('crd_a2')], removed: [] });
    assert.deepEqual(configs.currentBlockList(A), { version: 2, entries: [entry('crd_a1'), entry('crd_a2')] });
  });

  test('blocking a card that is already listed changes nothing (no new version)', () => {
    block('crd_a1');
    assert.deepEqual(block('crd_a1'), { version: 1, changed: false });
    block('crd_a2');
    // the answer is the current version, which still lists the card
    assert.deepEqual(block('crd_a1'), { version: 2, changed: false });
    assert.equal(count(ctx, "config_version WHERE kind = 'blocklist'"), 2);
    assert.equal(published(ctx).length, 2);
    assert.equal(audits.length, 2);
  });

  test('unblocking makes a new version without the card; old snapshots stay as they were', () => {
    block('crd_a1');
    block('crd_a2');
    assert.deepEqual(unblock('crd_a1', 'stf_office'), { version: 3, changed: true });
    assert.deepEqual(configs.current(A, 'blocklist').content, { entries: [entry('crd_a2')], added: [], removed: [digest('crd_a1')] });
    assert.deepEqual(configs.currentBlockList(A), { version: 3, entries: [entry('crd_a2')] });
    assert.deepEqual(configs.getVersion(A, 'blocklist', 2).content.entries, [entry('crd_a1'), entry('crd_a2')]);
  });

  test('unblocking a card that is not listed changes nothing', () => {
    assert.deepEqual(unblock('crd_a1'), { version: 0, changed: false });
    assert.equal(count(ctx, 'config_version'), 0);
    block('crd_a2');
    assert.deepEqual(unblock('crd_a1'), { version: 1, changed: false });
    assert.deepEqual(unblock('crd_a2'), { version: 2, changed: true });
    assert.deepEqual(unblock('crd_a2'), { version: 2, changed: false });
    assert.deepEqual(configs.currentBlockList(A), { version: 2, entries: [] });
  });

  test('a freed card can be blocked again', () => {
    block('crd_a1');
    unblock('crd_a1');
    assert.deepEqual(block('crd_a1'), { version: 3, changed: true });
    assert.deepEqual(configs.current(A, 'blocklist').content, { entries: [entry('crd_a1')], added: [entry('crd_a1')], removed: [] });
  });

  test('unknown cards are CARD_NOT_FOUND (404), unknown schools SCHOOL_NOT_FOUND (404)', () => {
    for (const fn of [configs.blockCard, configs.unblockCard]) {
      rejects(() => fn({ schoolId: A, cardId: 'crd_nope' }), 'CARD_NOT_FOUND', 404);
      rejects(() => fn({ schoolId: A }), 'CARD_NOT_FOUND', 404);
      rejects(() => fn({ schoolId: 'sch_nope', cardId: 'crd_a1' }), 'SCHOOL_NOT_FOUND', 404);
      rejects(() => fn(), 'SCHOOL_NOT_FOUND', 404);
    }
    assert.equal(count(ctx, 'config_version'), 0);
    assert.deepEqual(published(ctx), []);
  });

  test("a school can neither block nor free another school's card", () => {
    rejects(() => configs.blockCard({ schoolId: A, cardId: 'crd_b1' }), 'CARD_NOT_FOUND', 404);
    block('crd_b1');
    rejects(() => configs.unblockCard({ schoolId: A, cardId: 'crd_b1' }), 'CARD_NOT_FOUND', 404);
    assert.deepEqual(configs.currentBlockList(A), { version: 0, entries: [] });
    assert.deepEqual(configs.currentBlockList(B), { version: 1, entries: [entry('crd_b1')] });
  });

  test('each school has its own list, and the same chip has a different digest in each', () => {
    assert.equal(CARDS.crd_a1.uid, CARDS.crd_b1.uid);
    assert.notEqual(digest('crd_a1'), digest('crd_b1'));
    block('crd_a1');
    block('crd_b1');
    block('crd_a2');
    assert.deepEqual(configs.currentBlockList(A), { version: 2, entries: [entry('crd_a1'), entry('crd_a2')] });
    assert.deepEqual(configs.currentBlockList(B), { version: 1, entries: [entry('crd_b1')] });
    unblock('crd_a1');
    assert.deepEqual(configs.currentBlockList(B), { version: 1, entries: [entry('crd_b1')] });
  });

  test('announces each new version with the school code, and nothing for no-ops', () => {
    block('crd_a1');
    block('crd_a1');
    unblock('crd_a2');
    block('crd_b1');
    unblock('crd_a1');
    assert.deepEqual(published(ctx), [
      ['smk-contoh', { kind: 'blocklist', version: 1 }],
      ['sjkc-contoh', { kind: 'blocklist', version: 1 }],
      ['smk-contoh', { kind: 'blocklist', version: 2 }],
    ]);
  });

  test('writes the audit trail with last4, not the card number', () => {
    block('crd_a1', 'stf_office');
    block('crd_a1', 'stf_office');
    unblock('crd_a1', 'stf_admin');
    assert.deepEqual(audits, [
      [A, 'stf_office', 'blocklist.block', { cardId: 'crd_a1', last4: last4('crd_a1'), version: 1 }],
      [A, 'stf_admin', 'blocklist.unblock', { cardId: 'crd_a1', last4: last4('crd_a1'), version: 2 }],
    ]);
  });

  test('a block whose surrounding transaction fails is not kept', () => {
    assert.throws(() =>
      ctx.db.tx(() => {
        block('crd_a1');
        throw new Error('publishing failed');
      }),
    );
    assert.deepEqual(configs.currentBlockList(A), { version: 0, entries: [] });
    assert.deepEqual(block('crd_a1'), { version: 1, changed: true });
  });
});

describe('blockListDelta()', () => {
  test('with no list at all: from 0 to 0, nothing changed', () => {
    assert.deepEqual(configs.blockListDelta(A, 0), { fromVersion: 0, toVersion: 0, added: [], removed: [] });
  });

  test('from version 0 it is the whole current list', () => {
    block('crd_a1');
    block('crd_a2');
    assert.deepEqual(configs.blockListDelta(A, 0), { fromVersion: 0, toVersion: 2, added: [entry('crd_a1'), entry('crd_a2')], removed: [] });
  });

  test('from the current version nothing changed', () => {
    block('crd_a1');
    assert.deepEqual(configs.blockListDelta(A, 1), { fromVersion: 1, toVersion: 1, added: [], removed: [] });
  });

  test('is the net change between the two snapshots', () => {
    block('crd_a1'); // v1
    block('crd_a2'); // v2
    unblock('crd_a1'); // v3
    block('crd_a3'); // v4
    assert.deepEqual(configs.blockListDelta(A, 0), { fromVersion: 0, toVersion: 4, added: [entry('crd_a2'), entry('crd_a3')], removed: [] });
    assert.deepEqual(configs.blockListDelta(A, 1), { fromVersion: 1, toVersion: 4, added: [entry('crd_a2'), entry('crd_a3')], removed: [digest('crd_a1')] });
    assert.deepEqual(configs.blockListDelta(A, 2), { fromVersion: 2, toVersion: 4, added: [entry('crd_a3')], removed: [digest('crd_a1')] });
    assert.deepEqual(configs.blockListDelta(A, 3), { fromVersion: 3, toVersion: 4, added: [entry('crd_a3')], removed: [] });
  });

  test('a card blocked and freed in between is in neither list', () => {
    block('crd_a1'); // v1
    block('crd_a2'); // v2
    unblock('crd_a2'); // v3
    assert.deepEqual(configs.blockListDelta(A, 1), { fromVersion: 1, toVersion: 3, added: [], removed: [] });
    unblock('crd_a1'); // v4
    block('crd_a1'); // v5
    assert.deepEqual(configs.blockListDelta(A, 3), { fromVersion: 3, toVersion: 5, added: [], removed: [] });
  });

  test('applying the delta to the old snapshot gives the current snapshot', () => {
    block('crd_a1');
    block('crd_a2');
    unblock('crd_a1');
    block('crd_a3');
    unblock('crd_a2');
    const current = configs.currentBlockList(A);
    for (let from = 0; from <= current.version; from++) {
      const delta = configs.blockListDelta(A, from);
      const old = configs.getVersion(A, 'blocklist', from).content.entries;
      const rebuilt = [...old.filter((e) => !delta.removed.includes(e.card)), ...delta.added];
      assert.deepEqual(new Set(rebuilt.map((e) => e.card)), new Set(current.entries.map((e) => e.card)), `from version ${from}`);
      assert.equal(delta.toVersion, current.version);
    }
  });

  test('null when fromVersion was never issued', () => {
    block('crd_a1');
    for (const v of [2, 99, -1, 1.5, '1', null, undefined, NaN]) assert.equal(configs.blockListDelta(A, v), null, `fromVersion ${String(v)}`);
  });

  test("works on the school's own versions only", () => {
    block('crd_a1');
    block('crd_a2');
    assert.equal(configs.blockListDelta(B, 1), null);
    assert.deepEqual(configs.blockListDelta(B, 0), { fromVersion: 0, toVersion: 0, added: [], removed: [] });
    block('crd_b1');
    assert.deepEqual(configs.blockListDelta(B, 0), { fromVersion: 0, toVersion: 1, added: [entry('crd_b1')], removed: [] });
    assert.equal(configs.blockListDelta(B, 2), null);
    assert.equal(configs.blockListDelta('sch_nope', 1), null);
  });
});

describe('packs() and nextAdminCardToken()', () => {
  test('no packs before anything was published', () => {
    assert.deepEqual(configs.packs(A), []);
  });

  test('only kinds that have a version', () => {
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    assert.deepEqual(configs.packs(A).map((p) => [p.kind, p.version]), [['prices', 1]]);
    block('crd_a1');
    assert.deepEqual(configs.packs(A).map((p) => [p.kind, p.version]), [['blocklist', 1], ['prices', 1]]);
  });

  test('each pack is the newest version with checksum = sha256hex(canonicalJson(content))', () => {
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    const cheaper = prices({ items: [item('ROTI-CANAI', 120, 'Roti canai')] });
    configs.publish({ schoolId: A, kind: 'prices', content: cheaper });
    configs.publish({ schoolId: A, kind: 'settings', content: DEFAULT_SETTINGS });
    block('crd_a1');
    block('crd_a2');
    const packs = configs.packs(A);
    assert.deepEqual(packs.map((p) => p.kind), ['blocklist', 'prices', 'settings']);
    const listContent = { entries: [entry('crd_a1'), entry('crd_a2')] };
    assert.deepEqual(packs, [
      // the block-list pack holds the entries only, not what the version changed
      { kind: 'blocklist', version: 2, content: listContent, checksum: sha256hex(canonicalJson(listContent)) },
      { kind: 'prices', version: 2, content: cheaper, checksum: sha256hex(canonicalJson(cheaper)) },
      { kind: 'settings', version: 1, content: plain(DEFAULT_SETTINGS), checksum: sha256hex(canonicalJson(plain(DEFAULT_SETTINGS))) },
    ]);
    for (const p of packs) assert.match(p.checksum, /^[0-9a-f]{64}$/);
  });

  test('the checksum follows the content', () => {
    block('crd_a1');
    const one = configs.packs(A)[0].checksum;
    block('crd_a2');
    const two = configs.packs(A)[0].checksum;
    unblock('crd_a2');
    const back = configs.packs(A)[0];
    assert.notEqual(one, two);
    // same entries, same checksum, even though the version moved on
    assert.equal(back.version, 3);
    assert.equal(back.checksum, one);
  });

  test('a list that was emptied again still has a pack, so offline machines can catch up to it', () => {
    block('crd_a1'); // v1
    unblock('crd_a1'); // v2
    const empty = { entries: [] };
    assert.deepEqual(configs.packs(A), [{ kind: 'blocklist', version: 2, content: empty, checksum: sha256hex(canonicalJson(empty)) }]);
  });

  test("packs hold only the school's own versions", () => {
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    block('crd_b1');
    assert.deepEqual(configs.packs(A).map((p) => p.kind), ['prices']);
    assert.deepEqual(configs.packs(B).map((p) => [p.kind, p.content]), [['blocklist', { entries: [entry('crd_b1')] }]]);
    assert.deepEqual(configs.packs('sch_nope'), []);
    assert.deepEqual(configs.packs(undefined), []);
  });

  test('tokens go up by one per school and are stored', () => {
    assert.equal(configs.nextAdminCardToken(A), 1);
    assert.equal(configs.nextAdminCardToken(A), 2);
    assert.equal(configs.nextAdminCardToken(B), 1);
    assert.equal(configs.nextAdminCardToken(A), 3);
    const stored = (id) => ctx.db.get('SELECT admin_card_token AS t FROM school WHERE id = ?', id).t;
    assert.equal(stored(A), 3);
    assert.equal(stored(B), 1);
  });

  test('tokens carry on from the stored value, e.g. after a restart', () => {
    ctx.db.run('UPDATE school SET admin_card_token = 41 WHERE id = ?', A);
    assert.equal(createConfigs(ctx).nextAdminCardToken(A), 42);
    assert.equal(configs.nextAdminCardToken(A), 43);
  });

  test('an unknown school gets no token (SCHOOL_NOT_FOUND)', () => {
    rejects(() => configs.nextAdminCardToken('sch_nope'), 'SCHOOL_NOT_FOUND', 404);
    rejects(() => configs.nextAdminCardToken(), 'SCHOOL_NOT_FOUND', 404);
    assert.deepEqual(ctx.db.all('SELECT admin_card_token AS t FROM school').map((r) => r.t), [0, 0]);
  });
});

describe('recordListState() and listStates()', () => {
  const ALL_KINDS = ['prices', 'settings', 'blocklist'];
  const report = (deviceId, kind, version, via) => configs.recordListState({ deviceId, kind, version, via });
  const stateOf = (schoolId, deviceCode, kind) => configs.listStates(schoolId).find((r) => r.deviceCode === deviceCode && r.kind === kind);

  test('LIST_STATE_VIAS are the ways a version can reach the platform', () => {
    assert.deepEqual([...LIST_STATE_VIAS], ['MQTT', 'ADMIN_CARD', 'HEARTBEAT', 'PROVISION']);
    assert.ok(Object.isFrozen(LIST_STATE_VIAS));
  });

  test('one row per device and kind, by device code; never-reported kinds are version 0', () => {
    const rows = configs.listStates(A);
    assert.deepEqual(
      rows.map((r) => `${r.deviceCode}/${r.kind}`),
      ['CANTEEN-01', 'KIOSK-01', 'WATER-01'].flatMap((code) => ALL_KINDS.map((kind) => `${code}/${kind}`)),
    );
    assert.deepEqual(rows[0], {
      deviceId: 'dev_a_canteen',
      deviceCode: 'CANTEEN-01',
      kind: 'prices',
      appliedVersion: 0,
      via: null,
      updatedAt: null,
      currentVersion: 0,
      behind: false,
    });
    for (const r of rows) assert.deepEqual([r.appliedVersion, r.via, r.updatedAt, r.behind], [0, null, null, false]);
  });

  test('stores what a device reported and returns it', () => {
    assert.deepEqual(report('dev_a_canteen', 'prices', 1, 'HEARTBEAT'), {
      deviceId: 'dev_a_canteen',
      kind: 'prices',
      appliedVersion: 1,
      via: 'HEARTBEAT',
      updatedAt: ctx.clock.now(),
    });
    for (const via of LIST_STATE_VIAS) assert.equal(report('dev_a_water', 'settings', 1, via).via, via);
  });

  test('a later report replaces the earlier one (one row per device and kind)', () => {
    report('dev_a_canteen', 'blocklist', 1, 'PROVISION');
    ctx.clock.advance(MINUTE);
    report('dev_a_canteen', 'blocklist', 2, 'MQTT');
    assert.deepEqual(report('dev_a_canteen', 'blocklist', 2, 'HEARTBEAT'), {
      deviceId: 'dev_a_canteen',
      kind: 'blocklist',
      appliedVersion: 2,
      via: 'HEARTBEAT',
      updatedAt: ctx.clock.now(),
    });
    assert.equal(count(ctx, 'device_list_state WHERE device_id = ?', 'dev_a_canteen'), 1);
  });

  test('a late admin-card receipt never lowers a version; heartbeats, acks and provisioning may', () => {
    const t0 = ctx.clock.now();
    report('dev_a_canteen', 'blocklist', 5, 'HEARTBEAT');
    ctx.clock.advance(HOUR);
    // the receipt was written on the machine before it got version 5 over MQTT
    assert.deepEqual(report('dev_a_canteen', 'blocklist', 3, 'ADMIN_CARD'), {
      deviceId: 'dev_a_canteen',
      kind: 'blocklist',
      appliedVersion: 5,
      via: 'HEARTBEAT',
      updatedAt: t0,
    });
    assert.equal(report('dev_a_canteen', 'blocklist', 5, 'ADMIN_CARD').via, 'ADMIN_CARD');
    assert.equal(report('dev_a_canteen', 'blocklist', 6, 'ADMIN_CARD').appliedVersion, 6);
    assert.equal(report('dev_a_canteen', 'blocklist', 4, 'MQTT').appliedVersion, 4);
    assert.equal(report('dev_a_canteen', 'blocklist', 3, 'PROVISION').appliedVersion, 3);
    assert.equal(report('dev_a_canteen', 'blocklist', 2, 'HEARTBEAT').appliedVersion, 2);
  });

  test('a bad kind, version or via is CONFIG_INVALID with every problem listed', () => {
    const problems = problemsOf(() => configs.recordListState({ deviceId: 'dev_a_canteen', kind: 'menu', version: -1, via: 'EMAIL' }));
    assert.equal(problems.length, 3);
    hasProblem(problems, 'kind must be one of prices, settings, blocklist', 'got "menu"');
    hasProblem(problems, 'version must be a whole number, 0 or more', 'got -1');
    hasProblem(problems, 'via must be one of MQTT, ADMIN_CARD, HEARTBEAT, PROVISION', 'got "EMAIL"');
    for (const version of [1.5, '2', null, undefined, NaN]) {
      hasProblem(problemsOf(() => report('dev_a_canteen', 'prices', version, 'MQTT')), 'version must be a whole number, 0 or more');
    }
    hasProblem(problemsOf(() => report('dev_a_canteen', 'blocklist-delta', 1, 'MQTT')), 'kind must be one of');
    hasProblem(problemsOf(() => report('dev_a_canteen', 'prices', 1, 'mqtt')), 'via must be one of');
    assert.equal(problemsOf(() => configs.recordListState()).length, 3);
    assert.equal(count(ctx, 'device_list_state'), 0);
  });

  test('an unknown device is DEVICE_NOT_FOUND (404)', () => {
    rejects(() => report('dev_nope', 'prices', 1, 'MQTT'), 'DEVICE_NOT_FOUND', 404);
    rejects(() => report(undefined, 'prices', 1, 'MQTT'), 'DEVICE_NOT_FOUND', 404);
    assert.equal(count(ctx, 'device_list_state'), 0);
  });

  test('with a schoolId the device must belong to that school', () => {
    const args = { deviceId: 'dev_b_canteen', kind: 'blocklist', version: 1, via: 'ADMIN_CARD' };
    rejects(() => configs.recordListState({ ...args, schoolId: A }), 'DEVICE_NOT_FOUND', 404);
    rejects(() => configs.recordListState({ ...args, schoolId: 'sch_nope' }), 'DEVICE_NOT_FOUND', 404);
    assert.equal(count(ctx, 'device_list_state'), 0);
    assert.equal(configs.recordListState({ ...args, schoolId: B }).appliedVersion, 1);
  });

  test('listStates() compares each device with the current versions (behind)', () => {
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    configs.publish({ schoolId: A, kind: 'prices', content: DEFAULT_PRICES });
    configs.publish({ schoolId: A, kind: 'settings', content: DEFAULT_SETTINGS });
    block('crd_a1');
    const t = ctx.clock.now();
    report('dev_a_canteen', 'prices', 2, 'MQTT');
    report('dev_a_canteen', 'settings', 1, 'HEARTBEAT');
    report('dev_a_canteen', 'blocklist', 0, 'PROVISION');
    report('dev_a_water', 'prices', 1, 'ADMIN_CARD');
    assert.deepEqual(stateOf(A, 'CANTEEN-01', 'prices'), {
      deviceId: 'dev_a_canteen',
      deviceCode: 'CANTEEN-01',
      kind: 'prices',
      appliedVersion: 2,
      via: 'MQTT',
      updatedAt: t,
      currentVersion: 2,
      behind: false,
    });
    const brief = (code, kind) => {
      const r = stateOf(A, code, kind);
      return [r.appliedVersion, r.via, r.currentVersion, r.behind];
    };
    assert.deepEqual(brief('CANTEEN-01', 'settings'), [1, 'HEARTBEAT', 1, false]);
    assert.deepEqual(brief('CANTEEN-01', 'blocklist'), [0, 'PROVISION', 1, true]);
    assert.deepEqual(brief('WATER-01', 'prices'), [1, 'ADMIN_CARD', 2, true]);
    // never reported, while a version exists: behind
    assert.deepEqual(brief('WATER-01', 'settings'), [0, null, 1, true]);
    assert.deepEqual(brief('KIOSK-01', 'blocklist'), [0, null, 1, true]);
  });

  test('a device reporting a version the platform has not issued is not behind', () => {
    report('dev_a_canteen', 'prices', 3, 'HEARTBEAT');
    assert.deepEqual(
      (({ appliedVersion, currentVersion, behind }) => ({ appliedVersion, currentVersion, behind }))(stateOf(A, 'CANTEEN-01', 'prices')),
      { appliedVersion: 3, currentVersion: 0, behind: false },
    );
  });

  test("lists only the school's own devices, states and versions", () => {
    report('dev_b_canteen', 'blocklist', 7, 'HEARTBEAT');
    configs.publish({ schoolId: B, kind: 'prices', content: DEFAULT_PRICES });
    const a = configs.listStates(A);
    assert.equal(a.length, 9);
    assert.ok(a.every((r) => r.deviceId.startsWith('dev_a_') && r.appliedVersion === 0 && r.currentVersion === 0));
    assert.deepEqual(
      configs.listStates(B).map((r) => [r.deviceId, r.kind, r.appliedVersion, r.currentVersion, r.behind]),
      [
        ['dev_b_canteen', 'prices', 0, 1, true],
        ['dev_b_canteen', 'settings', 0, 0, false],
        ['dev_b_canteen', 'blocklist', 7, 0, false],
      ],
    );
    assert.deepEqual(configs.listStates('sch_nope'), []);
    assert.deepEqual(configs.listStates(undefined), []);
  });

  test('a school without devices has no rows', () => {
    ctx.db.run("INSERT INTO school (id, code, name, card_key, created_at) VALUES ('sch_c', 'sk-contoh', 'SK Contoh', ?, ?)", randomSecret(), ctx.clock.now());
    configs.publish({ schoolId: 'sch_c', kind: 'prices', content: DEFAULT_PRICES });
    assert.deepEqual(configs.listStates('sch_c'), []);
  });
});

describe('a lost card, the way the platform uses this service', () => {
  test('block, send snapshot and delta, devices catch up, card found again', () => {
    for (const id of ['dev_a_canteen', 'dev_a_water']) report(id, 'blocklist', 0, 'PROVISION');
    function report(deviceId, kind, version, via) {
      return configs.recordListState({ deviceId, kind, version, via });
    }

    // reportCardLost: block, keep the version, publish the snapshot (retained) and the delta
    const { version, changed } = configs.blockCard({ schoolId: A, cardId: 'crd_a2', actor: 'stf_office' });
    assert.deepEqual({ version, changed }, { version: 1, changed: true });
    assert.deepEqual(configs.currentBlockList(A), { version: 1, entries: [entry('crd_a2')] });
    assert.deepEqual(configs.blockListDelta(A, version - 1), { fromVersion: 0, toVersion: 1, added: [entry('crd_a2')], removed: [] });
    const behind = () => configs.listStates(A).filter((r) => r.kind === 'blocklist' && r.behind).map((r) => r.deviceCode);
    assert.deepEqual(behind(), ['CANTEEN-01', 'KIOSK-01', 'WATER-01']);

    // the online canteen acks over MQTT; the offline water machine gets it from the admin card
    report('dev_a_canteen', 'blocklist', 1, 'MQTT');
    const token = configs.nextAdminCardToken(A);
    const pack = configs.packs(A).find((p) => p.kind === 'blocklist');
    assert.deepEqual([token, pack.version, pack.checksum], [1, 1, sha256hex(canonicalJson({ entries: [entry('crd_a2')] }))]);
    report('dev_a_water', 'blocklist', pack.version, 'ADMIN_CARD');
    assert.deepEqual(behind(), ['KIOSK-01']);

    // markCardFound: unblock and publish again
    assert.deepEqual(configs.unblockCard({ schoolId: A, cardId: 'crd_a2', actor: 'stf_office' }), { version: 2, changed: true });
    assert.deepEqual(configs.blockListDelta(A, 1), { fromVersion: 1, toVersion: 2, added: [], removed: [digest('crd_a2')] });
    assert.deepEqual(behind(), ['CANTEEN-01', 'KIOSK-01', 'WATER-01']);
    assert.deepEqual(published(ctx), [
      ['smk-contoh', { kind: 'blocklist', version: 1 }],
      ['smk-contoh', { kind: 'blocklist', version: 2 }],
    ]);
  });
});

describe('with the real schools and devices services', () => {
  let real;
  beforeEach(() => {
    real = createTestCtx();
  });
  afterEach(() => {
    real.db.close();
  });

  test('blocks the card the schools service issued and writes its audit trail, last4 only', () => {
    const schools = createSchools(real);
    const devices = createDevices(real);
    const svc = createConfigs(real, { schools });
    const school = schools.createSchool({ code: 'smk-contoh', name: 'SMK Seri Contoh' });
    const member = schools.addMember({ schoolId: school.id, memberNo: 'S1001', name: 'Aina Contoh' });
    const card = schools.issueCard({ schoolId: school.id, memberId: member.id, uid: '04A1B2C3D4E5F6', actor: 'seed' });
    const { device } = devices.registerDevice({ schoolId: school.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'seed' });
    assert.equal(svc.publish({ schoolId: school.id, kind: 'prices', content: DEFAULT_PRICES, actor: 'staff:stf_office' }).version, 1);

    // reportCardLost as the facade runs it: mark LOST, block, keep the version, all in one transaction
    const lost = real.db.tx(() => {
      const c = schools.markCardLost({ schoolId: school.id, uid: card.uid, actor: 'staff:stf_office' });
      const { version } = svc.blockCard({ schoolId: school.id, cardId: c.id, actor: 'staff:stf_office' });
      return schools.setLostListVersion(school.id, c.id, version);
    });
    assert.equal(lost.lostListVersion, 1);
    assert.deepEqual(svc.currentBlockList(school.id), { version: 1, entries: [{ card: card.digest, last4: card.last4 }] });

    svc.recordListState({ deviceId: device.id, kind: 'blocklist', version: 1, via: 'MQTT', schoolId: school.id });
    assert.deepEqual(
      svc.listStates(school.id).map((r) => [r.deviceCode, r.kind, r.appliedVersion, r.currentVersion, r.behind]),
      [
        ['CANTEEN-01', 'prices', 0, 1, true],
        ['CANTEEN-01', 'settings', 0, 0, false],
        ['CANTEEN-01', 'blocklist', 1, 1, false],
      ],
    );

    // freeing the card inside a transaction that then fails keeps neither the version nor its audit row
    assert.throws(
      () =>
        real.db.tx(() => {
          svc.unblockCard({ schoolId: school.id, cardId: card.id, actor: 'staff:stf_office' });
          throw new Error('publishing failed');
        }),
      /publishing failed/,
    );
    assert.equal(svc.currentBlockList(school.id).version, 1);

    const trail = schools
      .listAudit(school.id)
      .filter((a) => a.action.startsWith('config.') || a.action.startsWith('blocklist.'))
      .reverse();
    assert.deepEqual(
      trail.map((a) => [a.action, a.actor, a.detail]),
      [
        ['config.publish', 'staff:stf_office', { kind: 'prices', version: 1 }],
        ['blocklist.block', 'staff:stf_office', { cardId: card.id, last4: card.last4, version: 1 }],
      ],
    );
    assert.ok(!JSON.stringify(trail).includes(card.uid), 'the audit trail never holds the card number');
  });
});
