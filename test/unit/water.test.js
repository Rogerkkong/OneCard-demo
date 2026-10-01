import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { startBroker } from '../../src/broker/broker.js';
import { MAX_POUR_ML, WaterMachine } from '../../src/devices/water.js';
import { CanteenReader } from '../../src/devices/canteen.js';
import { SCREEN_CLOSED } from '../../src/devices/terminal.js';
import { VirtualCard } from '../../src/devices/card.js';
import { brokerPassword, cardDigest, last4, randomSecret, verifyEnvelopeSignature } from '../../src/shared/crypto.js';
import { SCREEN_CARD_UNAVAILABLE, deviceTxnNo, topicFor, validateRecord } from '../../src/shared/protocol.js';
import { maxAffordableMl, waterChargeSen } from '../../src/shared/money.js';
import { HOUR } from '../../src/shared/time.js';
import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../../src/platform/configs.js';
import { createSchools } from '../../src/platform/schools.js';
import { createLedger } from '../../src/platform/ledger.js';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';

// Fictional schools, machines and card UIDs; every key and secret is generated per run.
// Water: RM 0.20 a litre, rounded half up to the sen, at least RM 0.05 for any water poured.
// Default settings: open 06:30-18:30 KL, RM 20.00 a purchase, RM 30.00 and 10 purchases a day, 3 s between taps.

const A = 'smk-alpha';
const B = 'smk-beta';
const KEYS = { [A]: randomSecret(), [B]: randomSecret() };
const WATER = { school: A, code: 'WATER-01', secret: randomSecret() };
const CANTEEN = { school: A, code: 'CANTEEN-01', secret: randomSecret() };
const UID = '04C35D2F8B1A82';
const NET = { timeout: 20_000 };
const { perLitreSen: PER_LITRE, minChargeSen: MIN_CHARGE } = DEFAULT_PRICES.water;

const install = ({ settings = {}, water = DEFAULT_PRICES.water, entries = [] } = {}) => ({
  prices: { version: 1, content: { ...structuredClone(DEFAULT_PRICES), water } },
  settings: { version: 1, content: { ...structuredClone(DEFAULT_SETTINGS), ...settings } },
  blocklist: { version: 1, entries },
});

let seedOrders = 0;
function cardWith(ctx, school, balanceSen, { uid = UID, group = 'STUDENT', key = KEYS[school] } = {}) {
  const card = new VirtualCard({ uid, schoolCode: school, group, cardKey: key });
  if (balanceSen > 0) {
    seedOrders += 1;
    const write = { orderId: `ord_seed${seedOrders}`, kioskTxn: deviceTxnNo('KIOSK-09', seedOrders), at: ctx.clock.iso() };
    card.credit({ cardKey: key, amountSen: balanceSen, write });
  }
  return card;
}

function machine(ctx, Class, f, { key = KEYS[f.school], ...options } = {}) {
  return new Class({ school: { code: f.school, cardKey: key }, device: { code: f.code, secret: f.secret }, clock: ctx.clock, events: ctx.events, ...options });
}

/** A pour that poured nothing: its reason and screen, pouredMl 0, no record, the card untouched. */
async function nothingPoured(water, card, ml, reason, screen) {
  const before = card.memory;
  const journal = water.state.journal.total;
  const result = await water.tap(card, { ml });
  assert.deepEqual([result.ok, result.reason, result.pouredMl, result.record], [false, reason, 0, undefined]);
  if (screen instanceof RegExp) assert.match(result.screen, screen);
  else assert.equal(result.screen, screen);
  assert.deepEqual(card.memory, before);
  assert.equal(water.state.journal.total, journal);
  return result;
}

describe('pouring', () => {
  test('charges by the litre: 650 ml at RM 0.20 is RM 0.13; offline pours come home in a batch, online ones at once', NET, async (t) => {
    const ctx = createTestCtx();
    // the platform's books for this school, to see every pour posted once
    const schools = createSchools(ctx);
    const ledger = createLedger(ctx);
    const school = schools.createSchool({ code: A, name: 'Lab Test School' });
    const member = schools.addMember({ schoolId: school.id, memberNo: 'S1003', name: 'Test Student' });
    const key = schools.schoolCardKey(school.id);
    const wallet = { kind: 'STUDENT_WALLET', memberId: member.id };
    const post = (idemKey, debit, credit, amountSen) =>
      ledger.post({ schoolId: school.id, idemKey, kind: idemKey.split(':')[0], lines: [{ ...debit, side: 'DR', amountSen }, { ...credit, side: 'CR', amountSen }] });

    const broker = await startBroker(ctx, {
      port: 0,
      resolveDevice: (u) => (u === `${A}.WATER-01` ? { schoolCode: A, deviceCode: 'WATER-01', password: brokerPassword(WATER.secret), active: true } : null),
    });
    const platform = await mqtt.connectAsync(broker.url, { username: 'platform', password: ctx.settings.platformBrokerPassword, clientId: 'platform-test', reconnectPeriod: 0 });
    platform.on('error', () => {});
    const inbox = [];
    platform.on('message', (topic, payload) => inbox.push({ topic, env: JSON.parse(payload.toString()) }));
    await platform.subscribeAsync([`lab/v1/${A}/+/records`], { qos: 1 });
    const water = machine(ctx, WaterMachine, WATER, { key, brokerUrl: broker.url, cablePlugged: false });
    t.after(async () => {
      await water.stop();
      await platform.endAsync(true);
      await broker.close();
    });
    water.provision(install());
    await water.start();
    const card = cardWith(ctx, A, 4000, { key });
    post(`TOPUP:${card.uid}:SEED`, { kind: 'CASH_RECEIVED' }, wallet, 4000);

    const offline = await water.tap(card, { ml: 650 });
    assert.equal(offline.ok, true);
    assert.equal(offline.pouredMl, 650);
    assert.equal(offline.sent, false);
    assert.equal(offline.screen, 'Poured 650 ml · Paid RM 0.13 · Balance RM 39.87');
    assert.deepEqual(offline.record, {
      txn: 'WATER-01-000001',
      origin: 'WATER-01',
      kind: 'WATER',
      card: cardDigest(key, A, UID),
      last4: last4(UID),
      amountSen: 13,
      ml: 650,
      perLitreSen: 20,
      priceVersion: 1,
      listVersion: 1,
      at: ctx.clock.iso(),
      currency: 'MYR',
      cardSeq: 2,
      balanceBeforeSen: 4000,
      balanceAfterSen: 3987,
    });
    assert.deepEqual(validateRecord(offline.record), { ok: true });
    assert.equal(offline.record.amountSen, waterChargeSen(650, PER_LITRE, MIN_CHARGE));

    await water.setCable(true);
    const batch = await waitFor(() => inbox.find((m) => m.env.type === 'journal.batch'));
    assert.deepEqual(batch.env.body.records, [offline.record]);
    ctx.clock.advance(5000);
    const online = await water.tap(card, { ml: 10 });
    assert.equal(online.sent, true);
    const message = await waitFor(() => inbox.find((m) => m.env.type === 'water.recorded'));
    assert.equal(message.topic, topicFor(A, 'WATER-01', 'records'));
    assert.equal(verifyEnvelopeSignature(WATER.secret, message.env), true);
    assert.equal(message.env.txn, 'WATER-01-000002');
    assert.deepEqual(message.env.body, { record: online.record });

    // the books: each pour posted once, the mirror follows the card
    const records = inbox.flatMap((m) => (m.env.type === 'journal.batch' ? m.env.body.records : [m.env.body.record]));
    for (const r of [...records, ...records]) post(`PURCHASE:${r.origin}:${r.txn}`, wallet, { kind: 'SALES_PAYABLE' }, r.amountSen);
    assert.equal(ledger.trialBalance(school.id).balanced, true);
    assert.equal(ledger.memberBalances(school.id, member.id).walletSen, card.balanceSen);
    assert.equal(card.balanceSen, 4000 - 13 - 5);
    assert.deepEqual(eventsOf(ctx, 'card.write').map((e) => e.data.amountSen), [13, 5]);
  });

  test('a small pour pays the minimum charge; amounts round half up to the sen', async () => {
    const ctx = createTestCtx();
    const water = machine(ctx, WaterMachine, WATER);
    water.provision(install({ settings: { tapGapSeconds: 0, dailyMaxCount: 100 } }));
    const card = cardWith(ctx, A, 2000);
    const expected = [[1, 5], [10, 5], [249, 5], [275, 6], [300, 6], [1000, 20], [1025, 21], [1024, 20]];
    for (const [ml, sen] of expected) {
      const r = await water.tap(card, { ml });
      assert.deepEqual([r.ok, r.pouredMl, r.record.ml, r.record.amountSen], [true, ml, ml, sen], `${ml} ml`);
      assert.equal(sen, waterChargeSen(ml, PER_LITRE, MIN_CHARGE));
    }
  });

  test('pours only what the balance pays for, and nothing below the minimum charge', async () => {
    const ctx = createTestCtx();
    const water = machine(ctx, WaterMachine, WATER);
    water.provision(install());
    const card = cardWith(ctx, A, 10);
    const capped = await water.tap(card, { ml: 1000 });
    const most = maxAffordableMl(10, PER_LITRE, MIN_CHARGE);
    assert.equal(most, 524);
    assert.deepEqual([capped.ok, capped.pouredMl, capped.record.ml, capped.record.amountSen], [true, most, most, 10]);
    assert.equal(capped.screen, 'Poured 524 of 1000 ml · Paid RM 0.10 · Balance RM 0.00');
    ctx.clock.advance(5000);
    await nothingPoured(water, card, 1000, 'INSUFFICIENT_BALANCE', 'Not enough balance · Balance RM 0.00');

    const almost = cardWith(ctx, A, MIN_CHARGE - 1, { uid: '04D47E3A9C2B83' });
    await nothingPoured(water, almost, 10, 'INSUFFICIENT_BALANCE', 'Not enough balance · Balance RM 0.04');
    const empty = cardWith(ctx, A, 0, { uid: '04F6925CBE4D85' });
    await nothingPoured(water, empty, 650, 'INSUFFICIENT_BALANCE', /^Not enough balance/);
    const enough = cardWith(ctx, A, MIN_CHARGE, { uid: '04E5814BAD3C84' });
    assert.deepEqual([(await water.tap(enough, { ml: 5000 })).pouredMl, enough.balanceSen], [maxAffordableMl(MIN_CHARGE, PER_LITRE, MIN_CHARGE), 0]);
  });

  test('the per-purchase limit caps the pour; below the minimum charge it refuses', async () => {
    const ctx = createTestCtx();
    const water = machine(ctx, WaterMachine, WATER);
    water.provision(install({ settings: { perPurchaseMaxSen: 50 } }));
    const card = cardWith(ctx, A, 5000);
    const capped = await water.tap(card, { ml: 5000 });
    assert.equal(maxAffordableMl(50, PER_LITRE, MIN_CHARGE), 2524);
    assert.deepEqual([capped.pouredMl, capped.record.amountSen], [2524, 50]);
    assert.equal(capped.screen, 'Poured 2524 of 5000 ml · Paid RM 0.50 · Balance RM 49.50');
    ctx.clock.advance(5000);
    assert.equal((await water.tap(card, { ml: 100 })).pouredMl, 100); // under the cap: poured as asked

    water.provision({ settings: { version: 2, content: { ...structuredClone(DEFAULT_SETTINGS), perPurchaseMaxSen: MIN_CHARGE - 1 } } });
    ctx.clock.advance(5000);
    await nothingPoured(water, card, 100, 'PER_PURCHASE_LIMIT', 'Above the limit of RM 0.04 per purchase');
  });

  test("the daily total caps the pour, counting the card's purchases on other machines", async () => {
    const ctx = createTestCtx();
    const settings = { dailyMaxSen: 1000, tapGapSeconds: 0 };
    const water = machine(ctx, WaterMachine, WATER);
    const canteen = machine(ctx, CanteenReader, CANTEEN);
    water.provision(install({ settings }));
    canteen.provision(install({ settings }));
    const card = cardWith(ctx, A, 5000);
    const lunch = { items: [{ code: 'NASI-LEMAK' }, { code: 'MEE-GORENG' }, { code: 'ROTI-CANAI' }] }; // RM 9.00
    assert.equal((await canteen.tap(card, lunch)).record.amountSen, 900);
    const capped = await water.tap(card, { ml: 8000 }); // RM 1.00 left today
    assert.deepEqual([capped.pouredMl, capped.record.amountSen], [maxAffordableMl(100, PER_LITRE, MIN_CHARGE), 100]);
    await nothingPoured(water, card, 100, 'DAILY_LIMIT', 'Daily limit of RM 10.00 reached');
    assert.equal((await canteen.tap(card, lunch)).reason, 'DAILY_LIMIT');

    // 3 sen left today is less than the minimum charge: nothing can be poured
    const other = cardWith(ctx, A, 5000, { uid: '04D47E3A9C2B83' });
    water.provision({ settings: { version: 2, content: { ...structuredClone(DEFAULT_SETTINGS), ...settings, dailyMaxSen: 1003 } } });
    canteen.provision({ settings: { version: 2, content: { ...structuredClone(DEFAULT_SETTINGS), ...settings, dailyMaxSen: 1003 } } });
    assert.equal((await canteen.tap(other, { items: [...lunch.items, { code: 'BUAH' }] })).record.amountSen, 1000);
    await nothingPoured(water, other, 10, 'DAILY_LIMIT', 'Daily limit of RM 10.03 reached');
    // the next KL day starts afresh
    ctx.clock.advance(24 * HOUR);
    assert.equal((await water.tap(other, { ml: 650 })).pouredMl, 650);
  });

  test(`more than ${MAX_POUR_ML} ml is cut to one full pour`, async () => {
    const ctx = createTestCtx();
    const water = machine(ctx, WaterMachine, WATER);
    water.provision(install());
    const card = cardWith(ctx, A, 5000);
    const r = await water.tap(card, { ml: 25_000 });
    assert.deepEqual([r.pouredMl, r.record.ml, r.record.amountSen], [MAX_POUR_ML, MAX_POUR_ML, 400]);
    assert.equal(r.screen, 'Poured 20000 of 25000 ml · Paid RM 4.00 · Balance RM 46.00');
    assert.deepEqual(validateRecord(r.record), { ok: true });
  });

  test('pours nothing for a bad request, a closed machine, another group, the daily count, the tap gap or a card problem', async () => {
    const ctx = createTestCtx();
    const water = machine(ctx, WaterMachine, WATER);
    const lostUid = '04FFEEDDCCBBAA';
    water.provision(install({
      settings: { allowedGroups: ['STUDENT'], dailyMaxCount: 2 },
      entries: [{ card: cardDigest(KEYS[A], A, lostUid), last4: last4(lostUid) }],
    }));
    const card = cardWith(ctx, A, 5000);
    for (const ml of [0, -5, 1.5, '650', undefined, null]) {
      await nothingPoured(water, card, ml, 'AMOUNT_INVALID', 'Choose how much water to pour');
    }
    await nothingPoured(water, cardWith(ctx, A, 5000, { uid: '0407A36DCF5E86', group: 'STAFF' }), 650, 'GROUP_NOT_ALLOWED', 'Staff cards are not accepted here');
    await nothingPoured(water, cardWith(ctx, A, 5000, { uid: lostUid }), 650, 'BLOCKED', SCREEN_CARD_UNAVAILABLE);
    await nothingPoured(water, cardWith(ctx, B, 5000), 650, 'WRONG_SCHOOL', SCREEN_CARD_UNAVAILABLE);
    const tampered = cardWith(ctx, A, 100, { uid: '04E5814BAD3C84' });
    tampered.tamper({ balanceSen: 9999 });
    await nothingPoured(water, tampered, 650, 'CARD_UNREADABLE', SCREEN_CARD_UNAVAILABLE);

    assert.equal((await water.tap(card, { ml: 650 })).ok, true);
    ctx.clock.advance(2000);
    await nothingPoured(water, card, 650, 'TAP_GAP', 'Please wait 1 s and tap again');
    ctx.clock.advance(1000);
    assert.equal((await water.tap(card, { ml: 650 })).ok, true);
    ctx.clock.advance(3000);
    await nothingPoured(water, card, 650, 'DAILY_COUNT', 'Daily limit of 2 purchases reached');
    ctx.clock.advance(9 * HOUR); // 19:00 KL
    await nothingPoured(water, card, 650, 'CLOSED', SCREEN_CLOSED);

    const fresh = machine(ctx, WaterMachine, WATER); // never got a block list
    await nothingPoured(fresh, card, 650, 'NO_BLOCKLIST', SCREEN_CARD_UNAVAILABLE);
    assert.deepEqual(water.journal().map((e) => e.record.txn), ['WATER-01-000001', 'WATER-01-000002']);
  });

  test('with no minimum charge a tiny pour costs nothing, but still makes a record', async () => {
    const ctx = createTestCtx();
    const water = machine(ctx, WaterMachine, WATER);
    water.provision(install({ water: { perLitreSen: 20, minChargeSen: 0 } }));
    const card = cardWith(ctx, A, 100);
    const r = await water.tap(card, { ml: 20 });
    assert.deepEqual([r.ok, r.pouredMl, r.record.amountSen, r.record.cardSeq], [true, 20, 0, 2]);
    assert.deepEqual(validateRecord(r.record), { ok: true });
    assert.equal(card.balanceSen, 100);
    assert.equal(water.state.journal.total, 1);
    // an empty card still gets nothing, even for free
    await nothingPoured(water, cardWith(ctx, A, 0, { uid: '04F6925CBE4D85' }), 20, 'INSUFFICIENT_BALANCE', /^Not enough balance/);
  });
});
