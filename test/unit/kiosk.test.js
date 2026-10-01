import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { startBroker } from '../../src/broker/broker.js';
import { KIOSK_FAULTS, PENDING_MAX, SCREEN_NO_PLATFORM, SCREEN_POWER_CUT, TopupKiosk } from '../../src/devices/kiosk.js';
import { CanteenReader } from '../../src/devices/canteen.js';
import { VirtualCard } from '../../src/devices/card.js';
import { AdminCard, packChecksum } from '../../src/devices/adminCard.js';
import { KioskApiError } from '../../src/devices/kioskApi.js';
import { LabError } from '../../src/shared/errors.js';
import { brokerPassword, cardDigest, last4, randomSecret, verifyEnvelopeSignature } from '../../src/shared/crypto.js';
import { SCREEN_CARD_UNAVAILABLE, deviceTxnNo, topicFor, validateEnvelopeShape } from '../../src/shared/protocol.js';
import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../../src/platform/configs.js';
import { createSchools } from '../../src/platform/schools.js';
import { createLedger } from '../../src/platform/ledger.js';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';

// Fictional school, members, cards and orders; every key and secret is generated per run.
//
// The kiosk talks to a fake kiosk API (no HTTP): a small stand-in for the platform's top-up
// orders that keeps real double-entry books (ledger.js). Paying posts DR cash / CR waiting;
// a confirmed write posts DR waiting / CR wallet, once per order. After every flow the books
// must balance and the member's mirror wallet must equal what the card holds.

const A = 'smk-alpha';
const B = 'smk-beta';
const UID = '04A13B5C7D2E80';
const KIOSK = { code: 'KIOSK-01', secret: randomSecret() };
const NET = { timeout: 20_000 };
const K = (n) => deviceTxnNo('KIOSK-01', n);
const noAnswer = () => new KioskApiError('NETWORK', 503, 'no answer from the platform within 5000 ms', { timedOut: true });

/** The fake platform: one school, one member with a card, top-up orders and the books. */
function fakePlatform(ctx) {
  const schools = createSchools(ctx);
  const ledger = createLedger(ctx);
  const school = schools.createSchool({ code: A, name: 'Lab Test School' });
  const member = schools.addMember({ schoolId: school.id, memberNo: 'S1001', name: 'Test Student' });
  const cardKey = schools.schoolCardKey(school.id);
  const digest = cardDigest(cardKey, A, UID);
  const wallet = { kind: 'STUDENT_WALLET', memberId: member.id };
  const waiting = { kind: 'WAITING_TO_BE_ADDED', memberId: member.id };
  const post = (idemKey, debit, credit, amountSen) =>
    ledger.post({ schoolId: school.id, idemKey, kind: idemKey.split(':')[0], lines: [{ ...debit, side: 'DR', amountSen }, { ...credit, side: 'CR', amountSen }] });
  const orders = new Map();
  const calls = [];
  const failures = { pending: [], confirm: [], lookup: [], packs: [], receipts: [] };
  const take = (method) => failures[method].shift();
  let lost = false;
  let orderNo = 0;
  let token = 0;

  const api = {
    async pending(args) {
      calls.push(['pending', args]);
      const failure = take('pending');
      if (failure) throw failure.before;
      if (args.card !== digest) throw new KioskApiError('CARD_NOT_FOUND', 404, 'no such card');
      if (lost) throw new KioskApiError('CARD_NOT_ACTIVE', 409, 'this card is not active');
      const paid = [...orders.values()].filter((o) => o.status === 'PAID').slice(0, args.max);
      const balances = ledger.memberBalances(school.id, member.id);
      return {
        member: { id: member.id, name: 'Test Student' },
        orders: paid.map((o) => ({ orderId: o.id, kind: 'TOPUP', amountSen: o.amountSen })),
        mirrorBalanceSen: balances.walletSen,
        waitingSen: balances.waitingSen,
      };
    },
    async confirm(args) {
      calls.push(['confirm', args]);
      const failure = take('confirm');
      if (failure?.before) throw failure.before;
      const o = orders.get(args.orderId);
      if (!o) throw new KioskApiError('ORDER_NOT_FOUND', 404, 'no such order');
      if (args.card !== digest) throw new KioskApiError('ORDER_CARD_MISMATCH', 409, 'another member');
      if (args.amountSen !== o.amountSen) throw new KioskApiError('ORDER_AMOUNT_MISMATCH', 409, 'wrong amount');
      let answer;
      if (args.result === 'FAILED') {
        o.writeResult = 'FAILED';
        answer = { orderId: o.id, status: o.status, duplicate: false };
      } else if (o.status === 'ADDED') {
        if (o.kioskTxn !== args.kioskTxn) throw new KioskApiError('ORDER_ALREADY_ADDED', 409, 'added by another write');
        answer = { orderId: o.id, status: 'ADDED', duplicate: true };
      } else if (o.status === 'REFUNDED') {
        throw new KioskApiError('ORDER_ALREADY_REFUNDED', 409, 'already refunded');
      } else {
        Object.assign(o, { status: 'ADDED', kioskTxn: args.kioskTxn, balanceAfterOnCardSen: args.balanceAfterOnCardSen });
        post(`TOPUP:${o.id}:ADDED`, waiting, wallet, o.amountSen);
        answer = { orderId: o.id, status: 'ADDED', duplicate: false };
      }
      if (failure?.after) throw failure.after; // done, but the answer never got back
      return answer;
    },
    async lookup(kioskTxn) {
      calls.push(['lookup', kioskTxn]);
      const failure = take('lookup');
      if (failure) throw failure.before;
      const o = [...orders.values()].find((x) => x.kioskTxn === kioskTxn);
      return o ? { orderId: o.id, status: o.status } : null;
    },
    async packs() {
      calls.push(['packs']);
      const failure = take('packs');
      if (failure) throw failure.before;
      token += 1;
      const content = structuredClone(DEFAULT_PRICES);
      return { token, school: A, packs: [{ kind: 'prices', version: 2, content, checksum: packChecksum(content) }] };
    },
    async receipts(args) {
      calls.push(['receipts', args]);
      const failure = take('receipts');
      if (failure) throw failure.before;
      return { recorded: args.receipts.length };
    },
  };

  return {
    api,
    calls,
    orders,
    cardKey,
    digest,
    ledger,
    /** A parent pays: the order waits on the platform. */
    pay(amountSen) {
      orderNo += 1;
      const id = `ord_pay${orderNo}`;
      orders.set(id, { id, amountSen, status: 'PAID', kioskTxn: null, writeResult: null });
      post(`TOPUP:${id}:PAID`, { kind: 'CASH_RECEIVED' }, waiting, amountSen);
      return id;
    },
    /** A new card for the member, with money added long ago by another kiosk (already in the books). */
    newCard(balanceSen = 0) {
      const card = new VirtualCard({ uid: UID, schoolCode: A, cardKey });
      if (balanceSen > 0) {
        card.credit({ cardKey, amountSen: balanceSen, write: { orderId: 'ord_old', kioskTxn: 'KIOSK-09-000001', at: ctx.clock.iso() } });
        post('TOPUP:ord_old:ADDED', { kind: 'CASH_RECEIVED' }, wallet, balanceSen);
      }
      return card;
    },
    /** The next call to `method` fails: before doing anything, or after doing it (the answer is lost). */
    failNext(method, { before, after } = {}) {
      failures[method].push({ before, after });
    },
    reportLost() {
      lost = true;
    },
    /** What settlement does with purchase records (read back from a card): each posted once. */
    settle(records) {
      for (const r of records) post(`PURCHASE:${r.origin}:${r.txn}`, wallet, { kind: 'SALES_PAYABLE' }, r.amountSen);
    },
    called: (fn) => calls.filter((c) => c[0] === fn).map((c) => c[1]),
    /** The books balance and the mirror wallet equals the card. */
    check(card) {
      assert.equal(ledger.trialBalance(school.id).balanced, true);
      assert.equal(ledger.memberBalances(school.id, member.id).walletSen, card.balanceSen);
    },
    mirror: () => ledger.memberBalances(school.id, member.id),
  };
}

/** A broker, a raw MQTT client as the platform, the fake platform and a started kiosk. */
async function setup(t, { plugged = true, blocklistVersion = 3 } = {}) {
  const ctx = createTestCtx();
  const platform = fakePlatform(ctx);
  const broker = await startBroker(ctx, {
    port: 0,
    resolveDevice: (u) => (u === `${A}.KIOSK-01` ? { schoolCode: A, deviceCode: 'KIOSK-01', password: brokerPassword(KIOSK.secret), active: true } : null),
  });
  const client = await mqtt.connectAsync(broker.url, { username: 'platform', password: ctx.settings.platformBrokerPassword, clientId: 'platform-test', reconnectPeriod: 0 });
  client.on('error', () => {});
  const inbox = [];
  client.on('message', (topic, payload) => inbox.push({ topic, env: JSON.parse(payload.toString()) }));
  await client.subscribeAsync([`lab/v1/${A}/+/records`], { qos: 1 });
  const kiosk = new TopupKiosk({
    school: { code: A, cardKey: platform.cardKey },
    device: KIOSK,
    brokerUrl: broker.url,
    clock: ctx.clock,
    events: ctx.events,
    api: platform.api,
    cablePlugged: plugged,
  });
  t.after(async () => {
    await kiosk.stop();
    await client.endAsync(true);
    await broker.close();
  });
  if (blocklistVersion > 0) kiosk.provision({ blocklist: { version: blocklistVersion, entries: [] } });
  await kiosk.start();
  const readbacks = () => inbox.filter((m) => m.env.type === 'card.readback');
  return { ctx, platform, kiosk, inbox, readbacks };
}

const confirmOf = (orderId, amountSen, kioskTxn, balanceAfterOnCardSen, digest, result = 'ADDED') =>
  ({ orderId, result, amountSen, card: digest, balanceAfterOnCardSen, kioskTxn });

// --- a normal tap ---------------------------------------------------------------------------

describe('a tap at the kiosk', () => {
  test('reads the card back, writes and confirms each waiting order, and notes its block-list version', NET, async (t) => {
    const { ctx, platform, kiosk, readbacks } = await setup(t);
    const card = platform.newCard(1000);
    // a purchase on an offline reader: on the card, not yet known to the platform
    const reader = new CanteenReader({ school: { code: A, cardKey: platform.cardKey }, device: { code: 'CANTEEN-02', secret: randomSecret() }, clock: ctx.clock });
    reader.provision({ prices: { version: 1, content: DEFAULT_PRICES }, settings: { version: 1, content: DEFAULT_SETTINGS }, blocklist: { version: 1, entries: [] } });
    const sale = (await reader.tap(card, { items: [{ code: 'NASI-LEMAK' }] })).record;
    const first = platform.pay(2000);
    const second = platform.pay(1000);
    const before = card.memory;

    const result = await kiosk.tap(card);
    assert.deepEqual(result, {
      ok: true,
      screen: 'Added RM 30.00 · Balance RM 36.50',
      added: [
        { orderId: first, amountSen: 2000, kioskTxn: K(1), confirmed: true },
        { orderId: second, amountSen: 1000, kioskTxn: K(2), confirmed: true },
      ],
      readback: { records: [sale], balanceSen: 650 },
      reconfirmed: [],
    });
    const memory = card.read(platform.cardKey);
    assert.equal(memory.balanceSen, 3650);
    assert.deepEqual(memory.writes.slice(-2).map((w) => [w.orderId, w.amountSen, w.kioskTxn]), [[first, 2000, K(1)], [second, 1000, K(2)]]);
    assert.equal(memory.listVersionOnCard, 3);
    assert.equal(memory.cardSeq, before.cardSeq + 3); // two writes and the list version

    assert.deepEqual(platform.calls, [
      ['pending', { card: platform.digest, max: PENDING_MAX }],
      ['confirm', confirmOf(first, 2000, K(1), 2650, platform.digest)],
      ['confirm', confirmOf(second, 1000, K(2), 3650, platform.digest)],
    ]);

    // the read-back: everything the card carried before the writes, signed by the kiosk
    const [readback] = await waitFor(() => readbacks().length === 1 && readbacks());
    assert.equal(readback.topic, topicFor(A, 'KIOSK-01', 'records'));
    assert.deepEqual(validateEnvelopeShape(readback.env), { ok: true });
    assert.equal(verifyEnvelopeSignature(KIOSK.secret, readback.env), true);
    assert.deepEqual(readback.env.body, {
      card: platform.digest,
      last4: last4(UID),
      balanceSen: 650,
      cardSeq: before.cardSeq,
      listVersionOnCard: 0,
      records: [sale],
      writes: before.writes,
    });

    // the platform posts the purchase the read-back brought: books balanced, mirror = card
    platform.settle(readback.env.body.records);
    platform.check(card);
    assert.deepEqual(eventsOf(ctx, 'card.write').filter((e) => e.data.kind === 'credit').map((e) => [e.school, e.data]), [
      [A, { device: 'KIOSK-01', uid: UID, kind: 'credit', amountSen: 2000, balanceAfterSen: 2650 }],
      [A, { device: 'KIOSK-01', uid: UID, kind: 'credit', amountSen: 1000, balanceAfterSen: 3650 }],
    ]);
  });
});

describe('refusals', () => {
  test('nothing waiting: the card is still read back, and the screen shows the balance', NET, async (t) => {
    const { platform, kiosk, readbacks } = await setup(t);
    const card = platform.newCard(1000);
    const result = await kiosk.tap(card);
    assert.deepEqual(result, { ok: true, screen: 'Nothing to add · Balance RM 10.00', added: [], readback: { records: [], balanceSen: 1000 }, reconfirmed: [] });
    await waitFor(() => readbacks().length === 1);
    assert.deepEqual(platform.called('confirm'), []);
    assert.equal(card.read(platform.cardKey).listVersionOnCard, 3);
    platform.check(card);
  });

  test('offline: nothing is read, sent or written ("come back later")', NET, async (t) => {
    const { platform, kiosk, readbacks } = await setup(t, { plugged: false });
    const card = platform.newCard(1000);
    platform.pay(2000);
    const before = card.memory;
    const result = await kiosk.tap(card);
    assert.deepEqual(result, { ok: false, screen: SCREEN_NO_PLATFORM, reason: 'OFFLINE', added: [], readback: null, reconfirmed: [] });
    assert.equal(kiosk.state.lastScreen.text, 'Cannot reach the platform, please come back later');
    assert.deepEqual(card.memory, before);
    assert.deepEqual(platform.calls, []);
    assert.equal(kiosk.state.txnCounter, 0);
    await kiosk.setCable(true);
    assert.equal((await kiosk.tap(card)).added.length, 1);
    await waitFor(() => readbacks().length === 1);
    platform.check(card);
  });

  test('a lost card is read back (its purchases come home), then refused; nothing is written', NET, async (t) => {
    const { platform, kiosk, readbacks } = await setup(t);
    const card = platform.newCard(1000);
    platform.pay(2000);
    platform.reportLost();
    const before = card.memory;
    const result = await kiosk.tap(card);
    assert.deepEqual([result.ok, result.reason, result.screen, result.added], [false, 'CARD_NOT_ACTIVE', SCREEN_CARD_UNAVAILABLE, []]);
    assert.deepEqual(result.readback, { records: [], balanceSen: 1000 });
    await waitFor(() => readbacks().length === 1);
    assert.deepEqual(card.memory, before); // not even the list version
    assert.deepEqual(platform.calls.map((c) => c[0]), ['pending']);
  });

  test("a card the platform does not know, another school's card or a tampered card is refused", NET, async (t) => {
    const { platform, kiosk, readbacks } = await setup(t);
    platform.pay(2000);
    const unknown = new VirtualCard({ uid: '04112233445566', schoolCode: A, cardKey: platform.cardKey });
    const result = await kiosk.tap(unknown);
    assert.deepEqual([result.ok, result.reason, result.screen], [false, 'CARD_NOT_FOUND', SCREEN_CARD_UNAVAILABLE]);
    await waitFor(() => readbacks().length === 1);

    const theirs = new VirtualCard({ uid: UID, schoolCode: B, cardKey: randomSecret() });
    const tampered = platform.newCard(1000);
    tampered.tamper({ balanceSen: 99_999 });
    for (const [card, reason] of [[theirs, 'WRONG_SCHOOL'], [tampered, 'CARD_UNREADABLE']]) {
      const before = card.memory;
      const refused = await kiosk.tap(card);
      assert.deepEqual([refused.ok, refused.reason, refused.screen, refused.readback], [false, reason, SCREEN_CARD_UNAVAILABLE, null]);
      assert.deepEqual(card.memory, before);
    }
    assert.equal(platform.calls.length, 1); // only the unknown card got as far as the platform
    assert.equal(readbacks().length, 1);
  });

  test('the platform out of reach when asked for orders: nothing is written', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(1000);
    platform.pay(2000);
    const before = card.memory;
    platform.failNext('pending', { before: noAnswer() });
    platform.failNext('pending', { before: new KioskApiError('SERVER_DOWN', 503, 'the server is switched off') });
    for (const error of ['NETWORK', 'SERVER_DOWN']) {
      const result = await kiosk.tap(card);
      assert.deepEqual([result.ok, result.reason, result.error, result.screen, result.added], [false, 'PLATFORM_UNREACHABLE', error, SCREEN_NO_PLATFORM, []]);
    }
    assert.deepEqual(card.memory, before);
    assert.equal((await kiosk.tap(card)).added.length, 1); // back again
    platform.check(card);
  });

  test('refuses an unknown fault and anything that is not a card', NET, async (t) => {
    const { kiosk } = await setup(t);
    assert.deepEqual(KIOSK_FAULTS, ['power-cut-before-commit', 'power-cut-after-commit', 'confirm-timeout']);
    await assert.rejects(kiosk.tap({}, { fault: 'meteor' }), (err) => err instanceof LabError && err.code === 'FAULT_INVALID' && err.status === 400);
    await assert.rejects(kiosk.tap(null), TypeError);
    assert.throws(() => new TopupKiosk({ school: { code: A, cardKey: randomSecret() }, device: { code: 'KIOSK-02', secret: randomSecret() }, clock: { now: () => 0, iso: () => '' } }), TypeError);
  });
});

describe('faults and lost reports', () => {
  test('power cut before the write: nothing on the card, FAILED reported, the money still waits', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(1000);
    const orderId = platform.pay(2000);
    platform.pay(500); // a second order: the tap stops at the power cut
    const before = card.memory;
    const result = await kiosk.tap(card, { fault: 'power-cut-before-commit' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'POWER_CUT');
    assert.equal(result.screen, SCREEN_POWER_CUT);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.interrupted, { orderId, amountSen: 2000, kioskTxn: K(1), committed: false });
    assert.deepEqual(card.memory, before); // no write, no list version
    assert.deepEqual(platform.called('confirm'), [confirmOf(orderId, 2000, K(1), 1000, platform.digest, 'FAILED')]);
    assert.equal(platform.orders.get(orderId).status, 'PAID');
    platform.check(card);

    const again = await kiosk.tap(card);
    assert.deepEqual(again.added.map((a) => [a.orderId, a.kioskTxn, a.confirmed]), [[orderId, K(2), true], ['ord_pay2', K(3), true]]);
    assert.equal(card.balanceSen, 3500);
    platform.check(card);
  });

  test('power cut after the write: on the card, unreported; the next tap reports it under its own number', NET, async (t) => {
    const { ctx, platform, kiosk } = await setup(t);
    const card = platform.newCard(1000);
    const orderId = platform.pay(2000);
    const result = await kiosk.tap(card, { fault: 'power-cut-after-commit' });
    assert.deepEqual([result.ok, result.reason, result.screen, result.added], [false, 'POWER_CUT', SCREEN_POWER_CUT, []]);
    assert.deepEqual(result.interrupted, { orderId, amountSen: 2000, kioskTxn: K(1), committed: true });
    assert.equal(card.balanceSen, 3000); // the money is on the card...
    assert.deepEqual(platform.called('confirm'), []); // ...and the platform never heard
    assert.equal(platform.orders.get(orderId).status, 'PAID');
    assert.equal(platform.mirror().walletSen, 1000);
    assert.deepEqual(eventsOf(ctx, 'card.write').at(-1).data, { device: 'KIOSK-01', uid: UID, kind: 'credit', amountSen: 2000, balanceAfterSen: 3000 });

    const mark = platform.calls.length;
    const next = await kiosk.tap(card);
    assert.deepEqual(next.reconfirmed, [{ orderId, kioskTxn: K(1), result: 'CONFIRMED' }]);
    assert.deepEqual(next.added, []); // never written a second time
    assert.equal(next.screen, 'Nothing to add · Balance RM 30.00');
    assert.deepEqual(platform.called('confirm'), [confirmOf(orderId, 2000, K(1), 3000, platform.digest)]);
    assert.deepEqual(platform.calls.slice(mark).map((c) => c[0]), ['confirm', 'pending']); // reported before asking for orders
    assert.equal(card.balanceSen, 3000);
    assert.equal(card.read(platform.cardKey).writes.filter((w) => w.orderId === orderId).length, 1);
    platform.check(card);

    // and only once: a third tap has nothing more to report
    const third = await kiosk.tap(card);
    assert.deepEqual(third.reconfirmed, []);
    assert.equal(platform.called('confirm').length, 1);
  });

  test('confirm-timeout: the first confirm is lost, looked up by the same kiosk txn and resent; the card is written once', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(1000);
    const first = platform.pay(2000);
    const second = platform.pay(500); // the fault hits the first order only
    const result = await kiosk.tap(card, { fault: 'confirm-timeout' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.added.map((a) => [a.orderId, a.kioskTxn, a.confirmed]), [[first, K(1), true], [second, K(2), true]]);
    assert.deepEqual(platform.calls.map((c) => [c[0], c[0] === 'lookup' ? c[1] : c[1]?.kioskTxn]), [
      ['pending', undefined],
      ['lookup', K(1)],
      ['confirm', K(1)],
      ['confirm', K(2)],
    ]);
    assert.equal(card.balanceSen, 3500);
    assert.deepEqual(card.read(platform.cardKey).writes.slice(-2).map((w) => w.kioskTxn), [K(1), K(2)]);
    platform.check(card);
  });

  test('a confirm whose answer got lost: the lookup finds it, and nothing is sent again', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(0);
    const orderId = platform.pay(2000);
    platform.failNext('confirm', { after: noAnswer() }); // the platform did it; the answer never came
    const result = await kiosk.tap(card);
    assert.deepEqual(result.added, [{ orderId, amountSen: 2000, kioskTxn: K(1), confirmed: true }]);
    assert.deepEqual(platform.calls.map((c) => c[0]), ['pending', 'confirm', 'lookup']);
    platform.check(card);
  });

  test('no answer at all: the money stays on the card unconfirmed, the tap stops, and the next tap reports it', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(0);
    const first = platform.pay(2000);
    const second = platform.pay(500);
    platform.failNext('confirm', { before: noAnswer() });
    platform.failNext('lookup', { before: noAnswer() });
    const result = await kiosk.tap(card);
    assert.equal(result.ok, true);
    assert.equal(result.screen, 'Added RM 20.00 · Balance RM 20.00');
    assert.deepEqual(result.added, [{ orderId: first, amountSen: 2000, kioskTxn: K(1), confirmed: false }]);
    assert.equal(platform.orders.get(second).status, 'PAID'); // not written while the platform is out of reach
    assert.equal(card.read(platform.cardKey).listVersionOnCard, 3);

    const next = await kiosk.tap(card);
    assert.deepEqual(next.reconfirmed, [{ orderId: first, kioskTxn: K(1), result: 'CONFIRMED' }]);
    assert.deepEqual(next.added.map((a) => [a.orderId, a.kioskTxn, a.confirmed]), [[second, K(2), true]]);
    assert.equal(card.balanceSen, 2500);
    platform.check(card);
  });

  test('an unreported write stays to be reported while the platform is out of reach', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(0);
    const orderId = platform.pay(2000);
    await kiosk.tap(card, { fault: 'power-cut-after-commit' });
    platform.failNext('confirm', { before: noAnswer() });
    platform.failNext('lookup', { before: noAnswer() });
    const asked = platform.called('pending').length;
    const blocked = await kiosk.tap(card);
    assert.deepEqual([blocked.ok, blocked.reason, blocked.reconfirmed], [false, 'PLATFORM_UNREACHABLE', []]);
    assert.equal(platform.called('pending').length, asked); // it does not go on without reporting
    const next = await kiosk.tap(card);
    assert.deepEqual(next.reconfirmed, [{ orderId, kioskTxn: K(1), result: 'CONFIRMED' }]);
    platform.check(card);
  });

  test('a report the platform refuses is not retried forever (e.g. the order was refunded meanwhile)', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(0);
    const orderId = platform.pay(2000);
    await kiosk.tap(card, { fault: 'power-cut-after-commit' });
    platform.orders.get(orderId).status = 'REFUNDED';
    const next = await kiosk.tap(card);
    assert.deepEqual(next.reconfirmed, [{ orderId, kioskTxn: K(1), result: 'REFUSED' }]);
    const third = await kiosk.tap(card);
    assert.deepEqual(third.reconfirmed, []);
    assert.equal(platform.called('confirm').length, 1);
  });

  test("another kiosk's unreported write is left to that kiosk: never written or reported again here", NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(0);
    const theirs = platform.pay(2000);
    const ours = platform.pay(500);
    // KIOSK-02 wrote the first order and lost power before reporting it
    card.credit({ cardKey: platform.cardKey, amountSen: 2000, write: { orderId: theirs, kioskTxn: 'KIOSK-02-000001', at: '2026-10-05T01:00:00.000Z' } });
    const result = await kiosk.tap(card);
    assert.deepEqual(result.reconfirmed, []);
    assert.deepEqual(result.added.map((a) => [a.orderId, a.kioskTxn]), [[ours, K(1)]]); // no number spent on the other
    assert.deepEqual(platform.called('confirm').map((c) => c.orderId), [ours]);
    assert.equal(card.balanceSen, 2500);
    assert.equal(platform.orders.get(theirs).status, 'PAID');
  });

  test('an order still listed after its write was settled is not written again', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(0);
    const orderId = platform.pay(2000);
    await kiosk.tap(card, { fault: 'power-cut-after-commit' });
    // the platform answers the report with a refusal and keeps listing the order
    platform.failNext('confirm', { before: new KioskApiError('ORDER_AMOUNT_MISMATCH', 409, 'wrong amount') });
    const next = await kiosk.tap(card);
    assert.deepEqual(next.reconfirmed, [{ orderId, kioskTxn: K(1), result: 'REFUSED' }]);
    assert.deepEqual(next.added, []);
    assert.equal(card.balanceSen, 2000);
    assert.equal(card.read(platform.cardKey).writes.filter((w) => w.orderId === orderId).length, 1);
    assert.equal(kiosk.state.txnCounter, 1);
  });

  test('one card at a time: two taps at once write the order once', NET, async (t) => {
    const { platform, kiosk } = await setup(t);
    const card = platform.newCard(0);
    platform.pay(2000);
    const [one, two] = await Promise.all([kiosk.tap(card), kiosk.tap(card)]);
    assert.equal(one.added.length + two.added.length, 1);
    assert.equal(card.balanceSen, 2000);
    assert.equal(platform.called('confirm').length, 1);
    platform.check(card);
  });
});

describe('admin card at the kiosk', () => {
  test("loads the platform's packs with a new token; refuses offline, another school's card, or packs that do not fit", NET, async (t) => {
    const { ctx, platform, kiosk } = await setup(t);
    const adminCard = new AdminCard({ schoolCode: A });
    const loaded = await kiosk.loadAdminCard(adminCard);
    assert.deepEqual(loaded, { ok: true, screen: 'Admin card loaded · token 1 · 1 pack', token: 1, packs: [{ kind: 'prices', version: 2 }] });
    assert.equal(adminCard.token, 1);
    assert.equal(adminCard.memory.loadedAt, ctx.clock.iso());
    assert.deepEqual(eventsOf(ctx, 'admin-card.loaded').map((e) => [e.school, e.data]), [[A, { device: 'KIOSK-01', token: 1, packs: [{ kind: 'prices', version: 2 }] }]]);

    const theirs = new AdminCard({ schoolCode: B });
    assert.deepEqual(await kiosk.loadAdminCard(theirs), { ok: false, screen: SCREEN_CARD_UNAVAILABLE, reason: 'WRONG_SCHOOL' });
    assert.equal(theirs.token, 0);
    platform.failNext('packs', { before: noAnswer() });
    assert.deepEqual(await kiosk.loadAdminCard(adminCard), { ok: false, screen: SCREEN_NO_PLATFORM, reason: 'PLATFORM_UNREACHABLE', error: 'NETWORK' });
    platform.api.packs = async () => ({ token: 9, school: B, packs: [] }); // the answer is for another school
    assert.equal((await kiosk.loadAdminCard(adminCard)).reason, 'PACKS_INVALID');
    assert.equal(adminCard.token, 1);
    await kiosk.setCable(false);
    assert.equal((await kiosk.loadAdminCard(adminCard)).reason, 'OFFLINE');
    await assert.rejects(kiosk.loadAdminCard({}), TypeError);
  });

  test("uploads the receipts the machines wrote, clearing them; a failed upload puts them back", NET, async (t) => {
    const { ctx, platform, kiosk } = await setup(t);
    const adminCard = new AdminCard({ schoolCode: A });
    await kiosk.loadAdminCard(adminCard);
    const reader = new CanteenReader({ school: { code: A, cardKey: platform.cardKey }, device: { code: 'CANTEEN-02', secret: randomSecret() }, clock: ctx.clock });
    reader.provision({ prices: { version: 1, content: DEFAULT_PRICES } });
    const { results } = reader.tapAdminCard(adminCard);
    assert.deepEqual(results.map((r) => [r.device, r.kind, r.result, r.appliedVersion]), [['CANTEEN-02', 'prices', 'APPLIED', 2]]);

    platform.failNext('receipts', { before: noAnswer() });
    assert.deepEqual(await kiosk.uploadAdminCardReceipts(adminCard), { ok: false, screen: SCREEN_NO_PLATFORM, reason: 'PLATFORM_UNREACHABLE', error: 'NETWORK' });
    assert.deepEqual(adminCard.memory.receipts, results); // back on the card
    const uploaded = await kiosk.uploadAdminCardReceipts(adminCard);
    assert.deepEqual(uploaded, { ok: true, screen: 'Admin card receipts uploaded · 1', uploaded: 1, recorded: 1 });
    assert.deepEqual(platform.called('receipts').at(-1), { token: 1, receipts: results });
    assert.deepEqual(adminCard.memory.receipts, []);
    assert.deepEqual(await kiosk.uploadAdminCardReceipts(adminCard), { ok: true, screen: 'No receipts on the admin card', uploaded: 0, recorded: 0 });
    assert.equal((await kiosk.uploadAdminCardReceipts(new AdminCard({ schoolCode: B }))).reason, 'WRONG_SCHOOL');
  });
});
