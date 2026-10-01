import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { startBroker } from '../../src/broker/broker.js';
import { CanteenReader, MAX_ITEM_QTY, MAX_SALE_LINES } from '../../src/devices/canteen.js';
import { SCREEN_CLOSED, SCREEN_NOT_ENOUGH_BALANCE, SCREEN_NOT_READY } from '../../src/devices/terminal.js';
import { VirtualCard } from '../../src/devices/card.js';
import { brokerPassword, cardDigest, last4, randomSecret, signEnvelope, verifyEnvelopeSignature } from '../../src/shared/crypto.js';
import {
  SCREEN_CARD_UNAVAILABLE,
  buildEnvelope,
  commandTopic,
  deviceTxnNo,
  topicFor,
  validateEnvelopeShape,
  validateRecord,
} from '../../src/shared/protocol.js';
import { HOUR, MINUTE, klDay, klTime } from '../../src/shared/time.js';
import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../../src/platform/configs.js';
import { createSchools } from '../../src/platform/schools.js';
import { createLedger } from '../../src/platform/ledger.js';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';

// Fictional schools, machines and card UIDs; every key and secret is generated per run.
// Default price list: NASI-LEMAK 350, MEE-GORENG 400, ROTI-CANAI 150, TEH-TARIK 180, BUAH 100 (sen).
// Default settings: open 06:30-18:30 KL, RM 20.00 a purchase, RM 30.00 and 10 purchases a day, 3 s between taps.
// The test clock starts on Mon 05/10/2026 at 10:00 in Kuala Lumpur.

const A = 'smk-alpha';
const B = 'smk-beta';
const KEYS = { [A]: randomSecret(), [B]: randomSecret() };
const fixture = (school, code) => ({ school, code, secret: randomSecret() });
const READER = fixture(A, 'CANTEEN-01');
const READER_2 = fixture(A, 'CANTEEN-02');
const READER_B = fixture(B, 'CANTEEN-01');
const UID = '04A1B2C3D4E5F6';
const LOST_UID = '04FFEEDDCCBBAA';
const NET = { timeout: 20_000 };

const install = (settings = DEFAULT_SETTINGS, { entries = [], blocklistVersion = 1 } = {}) => ({
  prices: { version: 1, content: DEFAULT_PRICES },
  settings: { version: 1, content: settings },
  blocklist: { version: blocklistVersion, entries },
});
const entryFor = (school, uid, key = KEYS[school]) => ({ card: cardDigest(key, school, uid), last4: last4(uid) });
const order = (...codes) => ({ items: codes.map((code) => ({ code })) });

let seedOrders = 0;
/** A card of `school` holding `balanceSen`, put there by an earlier top-up at some other kiosk. */
function cardWith(ctx, school, balanceSen, { uid = UID, group = 'STUDENT', key = KEYS[school] } = {}) {
  const card = new VirtualCard({ uid, schoolCode: school, group, cardKey: key });
  if (balanceSen > 0) {
    seedOrders += 1;
    const write = { orderId: `ord_seed${seedOrders}`, kioskTxn: deviceTxnNo('KIOSK-09', seedOrders), at: ctx.clock.iso() };
    card.credit({ cardKey: key, amountSen: balanceSen, write });
  }
  return card;
}

function reader(ctx, f, { key = KEYS[f.school], ...options } = {}) {
  return new CanteenReader({
    school: { code: f.school, cardKey: key },
    device: { code: f.code, secret: f.secret },
    clock: ctx.clock,
    events: ctx.events,
    ...options,
  });
}

/** Asserts a refused tap: its reason and screen, the card untouched and nothing journaled. */
async function refused(machine, card, items, reason, screen) {
  const before = card.memory;
  const journal = machine.state.journal.total;
  const txns = machine.state.txnCounter;
  const result = await machine.tap(card, items);
  assert.equal(result.ok, false, `expected ${reason}`);
  assert.equal(result.reason, reason);
  if (screen instanceof RegExp) assert.match(result.screen, screen);
  else assert.equal(result.screen, screen);
  assert.equal(result.record, undefined);
  assert.deepEqual(card.memory, before);
  assert.equal(machine.state.journal.total, journal);
  assert.equal(machine.state.txnCounter, txns);
  assert.equal(machine.state.lastScreen.text, result.screen);
  return result;
}

/**
 * A broker on a random port knowing the given machines, and a raw MQTT client as the
 * platform. Machines built here, the client and the broker are closed when the test ends.
 */
async function startNet(t, ctx, machines) {
  const accounts = new Map(
    machines.map((f) => [`${f.school}.${f.code}`, { schoolCode: f.school, deviceCode: f.code, password: brokerPassword(f.secret), active: true }]),
  );
  const broker = await startBroker(ctx, { port: 0, resolveDevice: (username) => accounts.get(username) ?? null });
  const client = await mqtt.connectAsync(broker.url, {
    username: 'platform',
    password: ctx.settings.platformBrokerPassword,
    clientId: 'platform-test',
    reconnectPeriod: 0,
  });
  client.on('error', () => {});
  const inbox = [];
  client.on('message', (topic, payload) => inbox.push({ topic, env: JSON.parse(payload.toString()) }));
  await client.subscribeAsync(['lab/v1/+/+/records', 'lab/v1/+/+/status'], { qos: 1 });
  const opened = [];
  t.after(async () => {
    for (const m of opened) await m.stop();
    await client.endAsync(true);
    await broker.close();
  });
  let seq = 0;
  return {
    broker,
    client,
    inbox,
    build(f, options = {}) {
      const m = reader(ctx, f, { brokerUrl: broker.url, ...options });
      opened.push(m);
      return m;
    },
    from: (f, type) => inbox.filter((m) => m.topic.startsWith(`lab/v1/${f.school}/${f.code}/`) && (!type || m.env.type === type)),
    async command(f, type, kind, body, { retain = false } = {}) {
      const envelope = signEnvelope(f.secret, buildEnvelope({ school: f.school, device: f.code, seq: ++seq, at: ctx.clock.iso(), type, body }));
      await client.publishAsync(commandTopic(f.school, f.code, kind), JSON.stringify(envelope), { qos: 1, retain });
      return envelope;
    },
  };
}

/**
 * The platform's books for one school and one member, kept the way settlement keeps them:
 * every purchase record that arrives is posted once (idemKey PURCHASE:<origin>:<txn>), whatever
 * channel brought it and however often. The card's starting money is posted as already added.
 */
function booksFor(ctx, code) {
  const schools = createSchools(ctx);
  const ledger = createLedger(ctx);
  const school = schools.createSchool({ code, name: 'Lab Test School' });
  const member = schools.addMember({ schoolId: school.id, memberNo: 'S1001', name: 'Test Student' });
  const post = (idemKey, kind, debit, credit, amountSen) =>
    ledger.post({ schoolId: school.id, idemKey, kind, lines: [{ ...debit, side: 'DR', amountSen }, { ...credit, side: 'CR', amountSen }] });
  const wallet = { kind: 'STUDENT_WALLET', memberId: member.id };
  return {
    cardKey: schools.schoolCardKey(school.id),
    ledger,
    schoolId: school.id,
    seed: (card) => post(`SEED:${card.uid}`, 'TOPUP', { kind: 'CASH_RECEIVED' }, wallet, card.balanceSen),
    /** Post every record in these messages or files; returns how many new postings were made. */
    settle(records) {
      let created = 0;
      for (const r of records) {
        if (r.amountSen > 0) created += post(`PURCHASE:${r.origin}:${r.txn}`, 'PURCHASE', wallet, { kind: 'SALES_PAYABLE' }, r.amountSen).created ? 1 : 0;
      }
      return created;
    },
    mirror: () => ledger.memberBalances(school.id, member.id).walletSen,
    /** The books balance and the mirror equals what the card holds. */
    check(card) {
      assert.equal(ledger.trialBalance(school.id).balanced, true);
      assert.equal(ledger.memberBalances(school.id, member.id).walletSen, card.balanceSen);
    },
  };
}

const recordsIn = (messages) => messages.flatMap((m) => (m.env.type === 'journal.batch' ? m.env.body.records : [m.env.body.record]));

// --- selling ----------------------------------------------------------------------------

describe('a sale', () => {
  test('online: the card is charged, the record journaled and delivered as a signed sale.recorded', NET, async (t) => {
    const ctx = createTestCtx();
    const net = await startNet(t, ctx, [READER]);
    const machine = net.build(READER);
    machine.provision(install());
    await machine.start();
    const card = cardWith(ctx, A, 2000); // cardSeq 1

    const result = await machine.tap(card, { items: [{ code: 'NASI-LEMAK' }, { code: 'TEH-TARIK', qty: 1 }] });
    assert.equal(result.ok, true);
    assert.equal(result.screen, 'Paid RM 5.30 · Balance RM 14.70');
    assert.equal(result.sent, true);
    assert.deepEqual(result.record, {
      txn: 'CANTEEN-01-000001',
      origin: 'CANTEEN-01',
      kind: 'SALE',
      card: cardDigest(KEYS[A], A, UID),
      last4: 'E5F6',
      amountSen: 530,
      items: [{ code: 'NASI-LEMAK', qty: 1, priceSen: 350 }, { code: 'TEH-TARIK', qty: 1, priceSen: 180 }],
      priceVersion: 1,
      listVersion: 1,
      at: ctx.clock.iso(),
      currency: 'MYR',
      cardSeq: 2,
      balanceBeforeSen: 2000,
      balanceAfterSen: 1470,
    });
    assert.deepEqual(validateRecord(result.record), { ok: true });
    assert.equal(card.balanceSen, 1470);
    assert.deepEqual(card.read(KEYS[A]).records, [result.record]);
    assert.deepEqual(machine.state.journal, { total: 1, unsent: 0 });

    const [message] = await waitFor(() => net.from(READER, 'sale.recorded').length === 1 && net.from(READER, 'sale.recorded'));
    assert.equal(message.topic, topicFor(A, 'CANTEEN-01', 'records'));
    assert.deepEqual(validateEnvelopeShape(message.env), { ok: true });
    assert.equal(verifyEnvelopeSignature(READER.secret, message.env), true);
    assert.equal(message.env.txn, result.record.txn);
    assert.deepEqual(message.env.body, { record: result.record });

    ctx.clock.advance(5000);
    const second = await machine.tap(card, { items: [{ code: 'MEE-GORENG', qty: 2 }] });
    assert.equal(second.record.txn, 'CANTEEN-01-000002');
    assert.equal(second.record.amountSen, 800);
    const sales = await waitFor(() => net.from(READER, 'sale.recorded').length === 2 && net.from(READER, 'sale.recorded'));
    assert.ok(sales[1].env.seq > sales[0].env.seq);
    const seqs = net.from(READER).map((m) => m.env.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));

    assert.deepEqual(eventsOf(ctx, 'card.write').map((e) => [e.school, e.data]), [
      [A, { device: 'CANTEEN-01', uid: UID, kind: 'debit', amountSen: 530, balanceAfterSen: 1470 }],
      [A, { device: 'CANTEEN-01', uid: UID, kind: 'debit', amountSen: 800, balanceAfterSen: 670 }],
    ]);
    assert.deepEqual(eventsOf(ctx, 'device.screen').at(-1).data, { device: 'CANTEEN-01', text: 'Paid RM 8.00 · Balance RM 6.70', tone: 'ok' });
  });

  test('offline: records wait in the journal, come home as a journal.batch, and the books stay balanced', NET, async (t) => {
    const ctx = createTestCtx();
    const books = booksFor(ctx, A);
    const net = await startNet(t, ctx, [READER]);
    const machine = net.build(READER, { key: books.cardKey, cablePlugged: false });
    machine.provision(install());
    await machine.start();
    const card = cardWith(ctx, A, 2000, { key: books.cardKey });
    books.seed(card);
    books.check(card);

    const kept = [];
    for (const items of [order('NASI-LEMAK'), order('ROTI-CANAI', 'TEH-TARIK'), order('BUAH')]) {
      const r = await machine.tap(card, items);
      assert.equal(r.ok, true);
      assert.equal(r.sent, false);
      kept.push(r.record);
      ctx.clock.advance(5000);
    }
    assert.deepEqual(machine.state.journal, { total: 3, unsent: 3 });
    assert.equal(net.from(READER).length, 0);
    assert.equal(card.balanceSen, 2000 - 350 - 330 - 100);
    // until the records arrive, the platform's mirror is behind the card
    assert.equal(books.mirror(), 2000);

    await machine.setCable(true);
    assert.deepEqual(machine.state.journal, { total: 3, unsent: 0 });
    const [batch] = await waitFor(() => net.from(READER, 'journal.batch').length === 1 && net.from(READER, 'journal.batch'));
    assert.equal(verifyEnvelopeSignature(READER.secret, batch.env), true);
    assert.deepEqual(batch.env.body, { batchId: 'CANTEEN-01-B1', count: 3, records: kept });
    assert.equal(books.settle(recordsIn(net.from(READER, 'journal.batch'))), 3);
    books.check(card);

    // online again: the next sale goes up at once
    const online = await machine.tap(card, order('MILO-AIS'));
    assert.equal(online.sent, true);
    await waitFor(() => net.from(READER, 'sale.recorded').length === 1);
    // every record also reaches the platform a second time (a repeated upload, a USB file):
    // each is still posted only once
    await machine.publishUp('sale.recorded', { record: online.record }, { txn: online.record.txn });
    await waitFor(() => net.from(READER, 'sale.recorded').length === 2);
    const everything = [...recordsIn(net.from(READER, 'sale.recorded')), ...recordsIn(net.from(READER, 'journal.batch')), ...machine.exportJournal().records];
    assert.equal(books.settle(everything), 1);
    books.check(card);
    assert.equal(books.ledger.postings(books.schoolId, { limit: 100 }).length, 1 + 4);
  });
});

// --- tap rules ----------------------------------------------------------------------------

describe('tap rules (DESIGN §3)', () => {
  test('before the card: no block list yet (card unavailable), no prices or settings, a bad or unknown item', async () => {
    const ctx = createTestCtx();
    const machine = reader(ctx, READER);
    const card = cardWith(ctx, A, 2000);
    // a reader that never received a block list refuses every card, whatever else it has
    await refused(machine, card, order('NASI-LEMAK'), 'NO_BLOCKLIST', SCREEN_CARD_UNAVAILABLE);
    machine.provision({ prices: install().prices });
    await refused(machine, card, order('NASI-LEMAK'), 'NO_BLOCKLIST', SCREEN_CARD_UNAVAILABLE);
    machine.provision({ blocklist: install().blocklist });
    await refused(machine, card, order('NASI-LEMAK'), 'NOT_READY', SCREEN_NOT_READY); // no settings yet
    machine.provision({ settings: install().settings });

    const tooMany = { items: Array.from({ length: MAX_SALE_LINES + 1 }, () => ({ code: 'BUAH' })) };
    for (const items of [{}, { items: [] }, { items: 'NASI-LEMAK' }, tooMany]) {
      await refused(machine, card, items, 'ITEMS_INVALID', `Choose 1 to ${MAX_SALE_LINES} items`);
    }
    for (const qty of [0, -1, 1.5, MAX_ITEM_QTY + 1, '2']) {
      await refused(machine, card, { items: [{ code: 'BUAH', qty }] }, 'ITEMS_INVALID', `Quantity must be 1 to ${MAX_ITEM_QTY}`);
    }
    await refused(machine, card, { items: [{ code: 'BUAH' }, { code: 'PIZZA' }] }, 'UNKNOWN_ITEM', 'Unknown item PIZZA');
    await refused(machine, card, { items: [{ qty: 1 }] }, 'UNKNOWN_ITEM', 'Unknown item (none)');

    // codes are read the way a cashier types them; qty defaults to 1
    const sold = await machine.tap(card, { items: [{ code: ' teh-tarik ' }, { code: 'BUAH', qty: 3 }] });
    assert.deepEqual(sold.record.items, [{ code: 'TEH-TARIK', qty: 1, priceSen: 180 }, { code: 'BUAH', qty: 3, priceSen: 100 }]);
    assert.equal(sold.record.amountSen, 480);
    assert.equal(sold.record.txn, deviceTxnNo('CANTEEN-01', 1)); // refused taps used no number
    assert.equal(sold.sent, false);
  });

  test('card problems all show "card unavailable", never why: block list, MAC, other school', async () => {
    const ctx = createTestCtx();
    const machine = reader(ctx, READER);
    machine.provision(install(DEFAULT_SETTINGS, { entries: [entryFor(A, LOST_UID)] }));
    const lost = cardWith(ctx, A, 2000, { uid: LOST_UID });
    const tampered = cardWith(ctx, A, 500);
    tampered.tamper({ balanceSen: 50_000 });
    const foreign = cardWith(ctx, B, 2000); // same UID, issued by the other school with its own key
    for (const [card, reason] of [[lost, 'BLOCKED'], [tampered, 'CARD_UNREADABLE'], [foreign, 'WRONG_SCHOOL']]) {
      const r = await refused(machine, card, order('NASI-LEMAK'), reason, SCREEN_CARD_UNAVAILABLE);
      assert.equal(machine.state.lastScreen.tone, 'error');
      assert.equal(r.screen, 'Card unavailable, please contact the front desk');
    }
    // card checks come first: outside the window a blocked card is still "card unavailable"
    ctx.clock.advance(9 * HOUR); // 19:00 KL
    await refused(machine, lost, order('NASI-LEMAK'), 'BLOCKED', SCREEN_CARD_UNAVAILABLE);
    // an old but complete block list still blocks: the reader on list 1 while the school is on 5
    assert.equal(machine.state.versions.blocklist, 1);
  });

  test('plain-message rules: window, holder group, per purchase, tap gap and balance', async () => {
    const ctx = createTestCtx();
    const machine = reader(ctx, READER);
    // generous daily limits, so only the rules under test can refuse
    machine.provision(install({ ...DEFAULT_SETTINGS, allowedGroups: ['STUDENT'], dailyMaxSen: 100_000, dailyMaxCount: 100 }));
    const card = cardWith(ctx, A, 3000);
    const teacher = cardWith(ctx, A, 3000, { uid: '0407A36DCF5E86', group: 'STAFF' });

    await refused(machine, teacher, order('NASI-LEMAK'), 'GROUP_NOT_ALLOWED', 'Staff cards are not accepted here');
    const six = { items: [{ code: 'NASI-LEMAK', qty: 6 }] }; // RM 21.00
    await refused(machine, card, six, 'PER_PURCHASE_LIMIT', 'Above the limit of RM 20.00 per purchase');
    assert.equal((await machine.tap(card, { items: [{ code: 'MEE-GORENG', qty: 5 }] })).ok, true); // exactly RM 20.00

    // 3 s between purchases on one card
    ctx.clock.advance(1000);
    await refused(machine, card, order('BUAH'), 'TAP_GAP', 'Please wait 2 s and tap again');
    ctx.clock.advance(1500);
    await refused(machine, card, order('BUAH'), 'TAP_GAP', 'Please wait 1 s and tap again');
    ctx.clock.advance(500);
    assert.equal((await machine.tap(card, order('BUAH'))).ok, true);

    // balance: RM 9.00 left
    ctx.clock.advance(5000);
    await refused(machine, card, { items: [{ code: 'MEE-GORENG', qty: 3 }] }, 'INSUFFICIENT_BALANCE', `${SCREEN_NOT_ENOUGH_BALANCE} · Balance RM 9.00`);
    assert.equal(machine.state.lastScreen.tone, 'warn');
    const exact = await machine.tap(card, { items: [{ code: 'MEE-GORENG', qty: 2 }, { code: 'BUAH' }] });
    assert.deepEqual([exact.ok, exact.record.balanceAfterSen, exact.screen], [true, 0, 'Paid RM 9.00 · Balance RM 0.00']);
    ctx.clock.advance(5000);
    await refused(machine, card, order('BUAH'), 'INSUFFICIENT_BALANCE', `${SCREEN_NOT_ENOUGH_BALANCE} · Balance RM 0.00`);

    // outside the meal window (18:30 KL) nothing is sold, whatever else is wrong
    ctx.clock.advance(8 * HOUR + 30 * MINUTE); // 18:30:15 KL
    assert.equal(klTime(ctx.clock.now()), '18:30');
    await refused(machine, card, order('BUAH'), 'CLOSED', SCREEN_CLOSED);
    await refused(machine, teacher, six, 'CLOSED', SCREEN_CLOSED);
    assert.deepEqual(machine.journal().map((e) => e.record.txn), ['CANTEEN-01-000001', 'CANTEEN-01-000002', 'CANTEEN-01-000003']);
  });

  test("daily total and count come from the card's own records, across machines, per KL day", async () => {
    const ctx = createTestCtx();
    const settings = { ...DEFAULT_SETTINGS, mealWindows: [], dailyMaxSen: 1000, dailyMaxCount: 3, tapGapSeconds: 0 };
    const one = reader(ctx, READER);
    const two = reader(ctx, READER_2);
    one.provision(install(settings));
    two.provision(install(settings));
    const card = cardWith(ctx, A, 5000);

    assert.equal((await one.tap(card, order('NASI-LEMAK'))).ok, true); // 350
    assert.equal((await two.tap(card, order('MEE-GORENG'))).ok, true); // 750 today, on two machines
    await refused(one, card, order('NASI-LEMAK'), 'DAILY_LIMIT', 'Daily limit of RM 10.00 reached'); // would be 1100
    await refused(two, card, order('NASI-LEMAK'), 'DAILY_LIMIT', 'Daily limit of RM 10.00 reached');
    assert.equal((await two.tap(card, order('ROTI-CANAI', 'BUAH'))).ok, true); // exactly RM 10.00, third today
    await refused(one, card, { items: [{ code: 'BUAH', qty: 1 }] }, 'DAILY_LIMIT', /Daily limit of RM 10.00/);

    // the count: a fresh day, small purchases
    ctx.clock.advance(13 * HOUR + 59 * MINUTE); // 23:59 KL, still Monday
    assert.equal(klTime(ctx.clock.now()), '23:59');
    await refused(two, card, order('BUAH'), 'DAILY_LIMIT', /Daily limit/);
    ctx.clock.advance(MINUTE); // 00:00 KL Tuesday: yesterday's records no longer count
    assert.equal(klDay(ctx.clock.now()), '2026-10-06');
    for (const machine of [one, two, one]) assert.equal((await machine.tap(card, order('BUAH'))).ok, true);
    await refused(two, card, order('BUAH'), 'DAILY_COUNT', 'Daily limit of 3 purchases reached');
    await refused(one, card, order('BUAH'), 'DAILY_COUNT', 'Daily limit of 3 purchases reached');
  });

  test('a card from another school is refused, though its UID is the same as one of ours', async () => {
    const ctx = createTestCtx();
    const ours = reader(ctx, READER);
    const theirs = reader(ctx, READER_B);
    ours.provision(install());
    theirs.provision(install());
    const ourCard = cardWith(ctx, A, 1000);
    const theirCard = cardWith(ctx, B, 1000);
    assert.notEqual(cardDigest(KEYS[A], A, UID), cardDigest(KEYS[B], B, UID));
    await refused(ours, theirCard, order('BUAH'), 'WRONG_SCHOOL', SCREEN_CARD_UNAVAILABLE);
    await refused(theirs, ourCard, order('BUAH'), 'WRONG_SCHOOL', SCREEN_CARD_UNAVAILABLE);
    assert.equal((await ours.tap(ourCard, order('BUAH'))).record.card, cardDigest(KEYS[A], A, UID));
    assert.equal((await theirs.tap(theirCard, order('BUAH'))).record.card, cardDigest(KEYS[B], B, UID));
    await assert.rejects(ours.tap(null, order('BUAH')), TypeError); // a machine needs a card
  });

  test('a lost card is refused online as soon as the block-list update arrives', NET, async (t) => {
    const ctx = createTestCtx();
    const net = await startNet(t, ctx, [READER]);
    const machine = net.build(READER);
    machine.provision({ prices: install().prices, settings: install().settings });
    await net.command(READER, 'blocklist.snapshot', 'blocklist', { version: 1, entries: [] }, { retain: true });
    await machine.start();
    await waitFor(() => machine.state.versions.blocklist === 1);
    const card = cardWith(ctx, A, 2000, { uid: LOST_UID });
    const before = await machine.tap(card, order('BUAH'));
    assert.equal(before.record.listVersion, 1);

    const delta = await net.command(READER, 'blocklist.delta', 'blocklist-delta', { fromVersion: 1, toVersion: 2, added: [entryFor(A, LOST_UID)], removed: [] });
    await waitFor(() => net.from(READER, 'command.ack').some((m) => m.env.body.command === delta.id));
    ctx.clock.advance(5000);
    await refused(machine, card, order('BUAH'), 'BLOCKED', SCREEN_CARD_UNAVAILABLE);
    assert.equal(machine.state.blocklistSize, 1);
  });
});
