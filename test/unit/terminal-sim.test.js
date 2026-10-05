import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { startBroker } from '../../src/broker/broker.js';
import { Terminal } from '../../src/devices/terminal.js';
import { CanteenReader } from '../../src/devices/canteen.js';
import { WaterMachine } from '../../src/devices/water.js';
import { VirtualCard } from '../../src/devices/card.js';
import { brokerPassword, cardDigest, last4, randomSecret, signEnvelope, verifyEnvelopeSignature } from '../../src/shared/crypto.js';
import { DOWN_TYPES, RETAINED_COMMAND_KINDS, SCREEN_CARD_UNAVAILABLE, buildEnvelope, commandTopic, deviceTxnNo, topicFor } from '../../src/shared/protocol.js';
import { maxAffordableMl, waterChargeSen } from '../../src/shared/money.js';
import { HOUR } from '../../src/shared/time.js';
import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../../src/platform/configs.js';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';

// Simulation mode on the machine side (docs/DESIGN.md §11.1-11.4): the steps a machine
// emits, the flow (trace) each one belongs to, and the outbox hold point (gate).
// Fictional schools, machines and card UIDs; every key and secret is generated per run.
// The test clock starts on Mon 05/10/2026 at 10:00 in Kuala Lumpur.

const A = 'smk-alpha';
const B = 'smk-beta';
const KEYS = { [A]: randomSecret(), [B]: randomSecret() };
const READER = { school: A, code: 'CANTEEN-01', type: 'CANTEEN', secret: randomSecret() };
const WATER = { school: A, code: 'WATER-01', type: 'WATER', secret: randomSecret() };
const UID = '04A1B2C3D4E5F6';
const NET = { timeout: 20_000 };
const RECORDS = topicFor(A, 'CANTEEN-01', 'records');
const STATUS = topicFor(A, 'CANTEEN-01', 'status');

// Many purchases a day, no tap gap: one card can buy again and again.
const BUSY_SETTINGS = { ...DEFAULT_SETTINGS, dailyMaxCount: 100, tapGapSeconds: 0 };
const INSTALL = {
  prices: { version: 1, content: DEFAULT_PRICES },
  settings: { version: 1, content: BUSY_SETTINGS },
  blocklist: { version: 1, entries: [] },
};
const pricesBody = (version) => ({ version, effectiveFrom: '2026-10-05T02:00:00.000Z', currency: 'MYR', ...structuredClone(DEFAULT_PRICES) });
const entryFor = (school, uid) => ({ card: cardDigest(KEYS[school], school, uid), last4: last4(uid) });

let seedOrders = 0;
/** A card of `school` holding `balanceSen`, put there by an earlier kiosk top-up. */
function cardWith(ctx, school, balanceSen, { uid = UID, group = 'STUDENT' } = {}) {
  const card = new VirtualCard({ uid, schoolCode: school, group, cardKey: KEYS[school] });
  if (balanceSen > 0) {
    seedOrders += 1;
    const write = { orderId: `ord_seed${seedOrders}`, kioskTxn: deviceTxnNo('KIOSK-09', seedOrders), at: ctx.clock.iso() };
    card.credit({ cardKey: KEYS[school], amountSen: balanceSen, write });
  }
  return card;
}

/** A machine with no network at all (never started). */
function offline(ctx, Class, f, options = {}) {
  return new Class({
    school: { code: f.school, cardKey: KEYS[f.school] },
    device: { code: f.code, type: f.type, secret: f.secret },
    clock: ctx.clock,
    events: ctx.events,
    ...options,
  });
}

/**
 * A broker on a random port that knows the given machines, and a raw MQTT client as the
 * platform keeping every record and status message with its size on the wire. Everything
 * opened here is closed when the test ends.
 */
async function startNet(t, machines) {
  const ctx = createTestCtx();
  const accounts = new Map(machines.map((f) => [`${f.school}.${f.code}`, { schoolCode: f.school, deviceCode: f.code, password: brokerPassword(f.secret), active: true }]));
  const broker = await startBroker(ctx, { port: 0, resolveDevice: (username) => accounts.get(username) ?? null });
  const client = await mqtt.connectAsync(broker.url, {
    username: 'platform',
    password: ctx.settings.platformBrokerPassword,
    clientId: 'platform-test',
    reconnectPeriod: 0,
    connectTimeout: 3000,
  });
  client.on('error', () => {});
  const inbox = [];
  client.on('message', (topic, payload) => {
    let env = null;
    try {
      env = JSON.parse(payload.toString('utf8'));
    } catch {
      // kept as null
    }
    inbox.push({ topic, env, bytes: payload.length });
  });
  await client.subscribeAsync(['lab/v1/+/+/records', 'lab/v1/+/+/status'], { qos: 1 });
  const opened = [];
  const gates = [];
  t.after(async () => {
    for (const g of gates) g.releaseAll(); // nothing may wait for ever
    for (const m of opened) await m.stop();
    await client.endAsync(true);
    await broker.close();
    ctx.db.close();
  });
  let platformSeq = 0;
  const net = { ctx, broker, client, inbox };
  net.build = (Class, f, options = {}) => {
    const m = new Class({
      school: { code: f.school, cardKey: KEYS[f.school] },
      device: { code: f.code, type: f.type, secret: f.secret },
      brokerUrl: broker.url,
      clock: ctx.clock,
      events: ctx.events,
      ...options,
    });
    opened.push(m);
    return m;
  };
  /** A gate that holds what `match` picks until released, remembering every info it got. */
  net.gate = (match = () => false) => {
    const g = { calls: [], waiting: [] };
    g.fn = (info) => {
      g.calls.push(info);
      if (!match(info)) return undefined;
      return new Promise((resolve) => g.waiting.push({ info, release: resolve }));
    };
    g.releaseAll = () => {
      for (const w of g.waiting.splice(0)) w.release();
    };
    gates.push(g);
    return g;
  };
  net.from = (f, type) => inbox.filter((m) => m.topic.startsWith(`lab/v1/${f.school}/${f.code}/`) && (type === undefined || m.env?.type === type));
  net.envelope = (f, type, body, { secret = f.secret, fields = {} } = {}) =>
    signEnvelope(secret, { ...buildEnvelope({ school: f.school, device: f.code, seq: ++platformSeq, at: ctx.clock.iso(), type, body }), ...fields });
  /** Publish a command as the platform does (retained for the config kinds). */
  net.command = async (f, type, body, { secret, fields, topic } = {}) => {
    const kind = DOWN_TYPES[type] ?? 'control';
    const envelope = net.envelope(f, type, body, { secret, fields });
    await client.publishAsync(topic ?? commandTopic(f.school, f.code, kind), JSON.stringify(envelope), { qos: 1, retain: RETAINED_COMMAND_KINDS.includes(kind) });
    return envelope;
  };
  /** Wait until the machine has handled everything sent to it so far (a heartbeat-now goes after it). */
  net.barrier = async (f) => {
    const beats = net.from(f, 'device.heartbeat').length;
    await net.command(f, 'control.heartbeat-now', {});
    await waitFor(() => net.from(f, 'device.heartbeat').length > beats, { message: 'the barrier heartbeat' });
  };
  /** The next heartbeat the platform gets after `count` of them. */
  net.nextBeat = (f, count) => waitFor(() => net.from(f, 'device.heartbeat')[count], { message: 'the next heartbeat' });
  /** The device.send event of a message. */
  net.sendOf = (msgId) => eventsOf(ctx, 'device.send').find((e) => e.data.msgId === msgId);
  return net;
}

const steps = (ctx, step) => eventsOf(ctx, 'device.step').filter((e) => step === undefined || e.data.step === step);
const lastStep = (ctx, step) => steps(ctx, step).at(-1)?.data;
const traceOf = (e) => e?.trace ?? null;

// --- options ------------------------------------------------------------------------------

describe('options', () => {
  const ctx = createTestCtx();
  const good = { school: { code: A, cardKey: KEYS[A] }, device: { code: 'CANTEEN-01', type: 'CANTEEN', secret: randomSecret() }, clock: ctx.clock };

  test('gate must be a function, or left out', () => {
    for (const gate of [null, 'hold', {}, 42, true]) assert.throws(() => new Terminal({ ...good, gate }), TypeError, String(gate));
    assert.doesNotThrow(() => new Terminal({ ...good, gate: () => undefined }));
    assert.doesNotThrow(() => new Terminal({ ...good, gate: undefined }));
  });

  test('connectTraceMs is checked like the other timers', () => {
    for (const connectTraceMs of [0, -1, 1.5, 2 ** 31, '100', null, Number.NaN]) {
      assert.throws(() => new Terminal({ ...good, connectTraceMs }), TypeError, String(connectTraceMs));
    }
    for (const connectTraceMs of [1, 30_000, 2 ** 31 - 1]) assert.doesNotThrow(() => new Terminal({ ...good, connectTraceMs }));
  });
});

// --- the steps of a tap ---------------------------------------------------------------------

describe('the steps of a tap', () => {
  test('a tap inside a trace: every step carries it, and the PUBACK (from the socket) joins by msgId', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    reader.provision(INSTALL);
    await reader.start();
    await net.nextBeat(READER, 0);
    const card = cardWith(net.ctx, A, 2000);
    const mark = net.ctx.events.lastSeq();

    const sale = await net.ctx.events.withContext({ trace: 'tr_t' }, () => reader.tap(card, { items: [{ code: 'NASI-LEMAK' }] }));
    assert.deepEqual([sale.ok, sale.sent], [true, true]);
    const acked = await waitFor(() => net.ctx.events.since(mark).find((e) => e.type === 'device.acked'), { message: 'device.acked' });
    const got = await waitFor(() => net.from(READER, 'sale.recorded')[0], { message: 'the sale' });

    const mine = net.ctx.events.since(mark).filter((e) => e.data?.device === 'CANTEEN-01');
    assert.deepEqual(
      mine.map((e) => [e.type, e.data.step ?? null, traceOf(e)]),
      [
        ['device.step', 'card.read', 'tr_t'],
        ['device.step', 'rules', 'tr_t'],
        ['card.write', null, 'tr_t'],
        ['device.step', 'journal', 'tr_t'],
        ['device.screen', null, 'tr_t'],
        ['device.send', null, 'tr_t'],
        ['device.acked', null, null], // fired from the MQTT socket: no flow of its own...
      ],
    );
    for (const e of mine) assert.equal(e.school, A);
    const [read, rules, , journal, , send] = mine;
    assert.deepEqual(read.data, { device: 'CANTEEN-01', step: 'card.read', ok: true, last4: 'E5F6', balanceSen: 2000, cardSeq: 1, records: 0, listVersionOnCard: 0 });
    assert.deepEqual(rules.data, {
      device: 'CANTEEN-01',
      step: 'rules',
      ok: true,
      amountSen: 350,
      checks: [
        { rule: 'window', ok: true, open: true },
        { rule: 'group', ok: true, group: 'STUDENT' },
        { rule: 'perPurchase', ok: true, limitSen: 2000 },
        { rule: 'dailyTotal', ok: true, usedSen: 0, limitSen: 3000 },
        { rule: 'dailyCount', ok: true, count: 0, limit: 100 },
        { rule: 'tapGap', ok: true, waitMs: 0 },
        { rule: 'balance', ok: true, balanceSen: 2000 },
      ],
    });
    assert.deepEqual(journal.data, { device: 'CANTEEN-01', step: 'journal', ok: true, txn: 'CANTEEN-01-000001', unsent: 1 });
    assert.deepEqual(send.data, {
      device: 'CANTEEN-01',
      msgId: got.env.id,
      type: 'sale.recorded',
      seq: got.env.seq,
      txn: 'CANTEEN-01-000001',
      topic: RECORDS,
      bytes: got.bytes, // the UTF-8 size of what went on the wire
    });
    // ...but the same message id, by which the lab links it to the tap's flow
    assert.equal(Number.isSafeInteger(acked.data.ms) && acked.data.ms >= 0, true);
    assert.deepEqual(acked.data, { device: 'CANTEEN-01', msgId: got.env.id, type: 'sale.recorded', ok: true, ms: acked.data.ms });
    assert.equal(acked.school, A);
  });

  test('a card that cannot be used: card.read says why, the screen still only says "card unavailable", no rules are checked', async () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    const lostUid = '04FFEEDDCCBBAA';
    reader.provision({ ...INSTALL, blocklist: { version: 2, entries: [entryFor(A, lostUid)] } });
    const tampered = cardWith(ctx, A, 500);
    tampered.tamper({ balanceSen: 50_000 });
    const foreign = cardWith(ctx, B, 2000);
    const lost = cardWith(ctx, A, 1500, { uid: lostUid });

    const chip = { last4: 'BBAA', balanceSen: 1500, cardSeq: 1, records: 0, listVersionOnCard: 0 };
    for (const [card, reason, read] of [
      [tampered, 'CARD_UNREADABLE', {}],
      [foreign, 'WRONG_SCHOOL', {}],
      [lost, 'BLOCKED', chip], // read before it was found on the list
    ]) {
      const mark = ctx.events.lastSeq();
      const result = await reader.tap(card, { items: [{ code: 'BUAH' }] });
      assert.deepEqual([result.ok, result.reason, result.screen], [false, reason, SCREEN_CARD_UNAVAILABLE]);
      const after = ctx.events.since(mark);
      assert.deepEqual(after.map((e) => e.type), ['device.step', 'device.screen'], reason);
      assert.deepEqual(after[0].data, { device: 'CANTEEN-01', step: 'card.read', ok: false, reason, ...read });
      assert.equal(after[1].data.text, SCREEN_CARD_UNAVAILABLE);
    }
  });

  test('the rules step stops at the first rule that fails, in DESIGN order, with what each rule looked at', async () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    reader.provision({
      ...INSTALL,
      settings: { version: 1, content: { ...DEFAULT_SETTINGS, allowedGroups: ['STUDENT'], dailyMaxSen: 1000, dailyMaxCount: 3 } },
    });
    const card = cardWith(ctx, A, 5000);
    const passed = (n) =>
      [
        { rule: 'window', ok: true, open: true },
        { rule: 'group', ok: true, group: 'STUDENT' },
        { rule: 'perPurchase', ok: true, limitSen: 2000 },
      ].slice(0, n);
    const tap = async (c, items, reason) => {
      const r = await reader.tap(c, { items });
      assert.equal(r.reason, reason);
      return lastStep(ctx, 'rules');
    };

    const teacher = cardWith(ctx, A, 5000, { uid: '0407A36DCF5E86', group: 'STAFF' });
    assert.deepEqual(await tap(teacher, [{ code: 'BUAH' }], 'GROUP_NOT_ALLOWED'), {
      device: 'CANTEEN-01', step: 'rules', ok: false, amountSen: 100, checks: [...passed(1), { rule: 'group', ok: false, group: 'STAFF' }],
    });
    assert.deepEqual((await tap(card, [{ code: 'MEE-GORENG', qty: 6 }], 'PER_PURCHASE_LIMIT')).checks, [...passed(2), { rule: 'perPurchase', ok: false, limitSen: 2000 }]);

    assert.equal((await reader.tap(card, { items: [{ code: 'NASI-LEMAK', qty: 2 }] })).ok, true); // 700 today
    assert.deepEqual((await tap(card, [{ code: 'BUAH' }], 'TAP_GAP')).checks, [
      ...passed(3),
      { rule: 'dailyTotal', ok: true, usedSen: 700, limitSen: 1000 },
      { rule: 'dailyCount', ok: true, count: 1, limit: 3 },
      { rule: 'tapGap', ok: false, waitMs: 3000 },
    ]);
    ctx.clock.advance(1000);
    const gap = await tap(card, [{ code: 'BUAH' }], 'TAP_GAP');
    assert.deepEqual(gap.checks.at(-1), { rule: 'tapGap', ok: false, waitMs: 2000 });
    assert.equal(reader.state.lastScreen.text, 'Please wait 2 s and tap again'); // the screen as before
    ctx.clock.advance(5000);
    assert.deepEqual((await tap(card, [{ code: 'NASI-LEMAK' }], 'DAILY_LIMIT')).checks.at(-1), { rule: 'dailyTotal', ok: false, usedSen: 700, limitSen: 1000 });
    for (let i = 0; i < 2; i++) {
      assert.equal((await reader.tap(card, { items: [{ code: 'BUAH' }] })).ok, true);
      ctx.clock.advance(5000);
    }
    assert.deepEqual((await tap(card, [{ code: 'BUAH' }], 'DAILY_COUNT')).checks.at(-1), { rule: 'dailyCount', ok: false, count: 3, limit: 3 });

    const poor = cardWith(ctx, A, 120, { uid: '04D47E3A9C2B83' });
    const balance = await tap(poor, [{ code: 'NASI-LEMAK' }], 'INSUFFICIENT_BALANCE');
    assert.deepEqual([balance.ok, balance.amountSen, balance.checks.length, balance.checks.at(-1)], [false, 350, 7, { rule: 'balance', ok: false, balanceSen: 120 }]);

    ctx.clock.advance(9 * HOUR); // 19:00 KL: nothing else is even looked at
    assert.deepEqual(await tap(poor, [{ code: 'BUAH' }], 'CLOSED'), { device: 'CANTEEN-01', step: 'rules', ok: false, amountSen: 100, checks: [{ rule: 'window', ok: false, open: false }] });
  });

  test('water: the rules step shows the capped pour and what it costs', async () => {
    const ctx = createTestCtx();
    const water = offline(ctx, WaterMachine, WATER);
    water.provision({ ...INSTALL, settings: { version: 1, content: { ...DEFAULT_SETTINGS, dailyMaxSen: 1000, tapGapSeconds: 0 } } });
    const { perLitreSen, minChargeSen } = DEFAULT_PRICES.water;
    const card = cardWith(ctx, A, 10, { uid: '04C35D2F8B1A82' });

    const capped = await water.tap(card, { ml: 1000 }); // RM 0.10 pays for 524 ml
    assert.equal(capped.pouredMl, maxAffordableMl(10, perLitreSen, minChargeSen));
    assert.deepEqual(lastStep(ctx, 'rules'), {
      device: 'WATER-01',
      step: 'rules',
      ok: true,
      amountSen: 10,
      ml: capped.pouredMl,
      checks: [
        { rule: 'window', ok: true, open: true },
        { rule: 'group', ok: true, group: 'STUDENT' },
        { rule: 'perPurchase', ok: true, limitSen: 2000 },
        { rule: 'dailyTotal', ok: true, usedSen: 0, limitSen: 1000 },
        { rule: 'dailyCount', ok: true, count: 0, limit: 10 },
        { rule: 'tapGap', ok: true, waitMs: 0 },
        { rule: 'balance', ok: true, balanceSen: 10 },
      ],
    });
    // the balance is gone: refused at the balance rule, for the pour as capped so far
    const refused = await water.tap(card, { ml: 30_000 });
    assert.equal(refused.reason, 'INSUFFICIENT_BALANCE');
    const rules = lastStep(ctx, 'rules');
    assert.deepEqual([rules.ok, rules.ml, rules.amountSen, rules.checks.at(-1)], [false, 20_000, waterChargeSen(20_000, perLitreSen, minChargeSen), { rule: 'balance', ok: false, balanceSen: 0 }]);
  });

  test('offline: the record is journaled and the offline step says it waits; a heartbeat or envelope not sent says so too', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { cablePlugged: false });
    reader.provision(INSTALL);
    await reader.start();
    const card = cardWith(net.ctx, A, 2000);
    const mark = net.ctx.events.lastSeq();
    const sale = await reader.tap(card, { items: [{ code: 'BUAH' }] });
    assert.deepEqual([sale.ok, sale.sent], [true, false]);
    assert.deepEqual(
      net.ctx.events.since(mark).map((e) => [e.type, e.data.step ?? null]),
      [['device.step', 'card.read'], ['device.step', 'rules'], ['card.write', null], ['device.step', 'journal'], ['device.screen', null], ['device.step', 'offline']],
    );
    assert.deepEqual(lastStep(net.ctx, 'offline'), { device: 'CANTEEN-01', step: 'offline', ok: false, type: 'sale.recorded', txn: 'CANTEEN-01-000001' });

    assert.equal(await reader.heartbeat(), false);
    assert.deepEqual(lastStep(net.ctx, 'offline'), { device: 'CANTEEN-01', step: 'offline', ok: false, type: 'device.heartbeat' });
    const envelope = net.envelope(READER, 'sale.recorded', { record: sale.record }, { fields: { txn: sale.record.txn } });
    assert.equal(await reader.publishEnvelope(envelope), false);
    assert.deepEqual(lastStep(net.ctx, 'offline'), { device: 'CANTEEN-01', step: 'offline', ok: false, type: 'sale.recorded', txn: sale.record.txn });
    assert.equal(reader.state.seq, 0); // nothing was built for the broker
    assert.deepEqual(eventsOf(net.ctx, 'device.send'), []);
  });
});

// --- the PUBACK -----------------------------------------------------------------------------

describe('device.acked', () => {
  test('no PUBACK within ackTimeoutMs: ok false, reason timeout', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { ackTimeoutMs: 100 });
    reader.provision(INSTALL);
    await reader.start();
    await net.nextBeat(READER, 0);
    // the broker holds the reader's next message (a link that stalls) until the test ends
    const { aedes } = net.broker;
    const authorize = aedes.authorizePublish;
    let release = null;
    aedes.authorizePublish = (client, packet, done) => {
      if (!release && client?.id === `${A}.CANTEEN-01`) {
        release = () => authorize.call(aedes, client, packet, done);
        return;
      }
      authorize.call(aedes, client, packet, done);
    };
    t.after(() => release?.());
    const sale = await reader.tap(cardWith(net.ctx, A, 2000), { items: [{ code: 'BUAH' }] });
    assert.equal(sale.sent, false);
    const send = eventsOf(net.ctx, 'device.send').at(-1);
    const acked = eventsOf(net.ctx, 'device.acked').at(-1);
    assert.equal(acked.data.ms >= 100, true);
    assert.deepEqual(acked.data, { device: 'CANTEEN-01', msgId: send.data.msgId, type: 'sale.recorded', ok: false, ms: acked.data.ms, reason: 'timeout' });
  });

  test('the cable pulled before the PUBACK: ok false, reason connection lost, emitted in no flow (the lab joins it by msgId)', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    reader.provision(INSTALL);
    await reader.start();
    await net.nextBeat(READER, 0);
    const tapping = net.ctx.events.withContext({ trace: 'tr_tap' }, () => reader.tap(cardWith(net.ctx, A, 2000), { items: [{ code: 'BUAH' }] }));
    await net.ctx.events.withContext({ trace: 'tr_pull' }, () => reader.setCable(false));
    assert.equal((await tapping).sent, false);
    const send = eventsOf(net.ctx, 'device.send').at(-1);
    const acked = eventsOf(net.ctx, 'device.acked').at(-1);
    assert.equal(traceOf(send), 'tr_tap');
    assert.equal(traceOf(acked), null); // not the pull's: the message belongs to the tap
    assert.deepEqual(acked.data, { device: 'CANTEEN-01', msgId: send.data.msgId, type: 'sale.recorded', ok: false, ms: acked.data.ms, reason: 'connection lost' });
  });
});

// --- commands -------------------------------------------------------------------------------

describe('device.received', () => {
  test('one event for every message on the commands topic: what the machine made of it', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    const raw = (topic, payload) => net.client.publishAsync(topic, payload, { qos: 1 });
    const prices = commandTopic(A, 'CANTEEN-01', 'prices');

    const v2 = await net.command(READER, 'config.prices', pricesBody(2));
    const again = await net.command(READER, 'config.prices', pricesBody(2));
    const stale = await net.command(READER, 'config.prices', pricesBody(1));
    const forged = await net.command(READER, 'config.prices', pricesBody(3), { secret: randomSecret() });
    const misdirected = await net.command(READER, 'config.prices', pricesBody(3), { fields: { device: 'CANTEEN-02' } });
    const wrongTopic = await net.command(READER, 'config.prices', pricesBody(3), { topic: commandTopic(A, 'CANTEEN-01', 'settings') });
    await raw(prices, '{ not json');
    await raw(prices, JSON.stringify(v2)); // the same message again
    const snapshot = await net.command(READER, 'blocklist.snapshot', { version: 1, entries: [] });
    const delta = await net.command(READER, 'blocklist.delta', { fromVersion: 1, toVersion: 2, added: [entryFor(A, UID)], removed: [] });
    const gap = await net.command(READER, 'blocklist.delta', { fromVersion: 5, toVersion: 6, added: [], removed: [] });
    await net.barrier(READER);

    const id = (e) => ({ device: 'CANTEEN-01', msgId: e.id, type: e.type });
    const received = eventsOf(net.ctx, 'device.received');
    const barrier = received.at(-1);
    assert.deepEqual(received.map((e) => e.data), [
      { ...id(v2), kind: 'prices', version: 2, result: 'APPLIED' },
      { ...id(again), kind: 'prices', version: 2, result: 'ALREADY_APPLIED' },
      { ...id(stale), kind: 'prices', version: 1, result: 'REJECTED', reason: 'STALE_VERSION' },
      { ...id(forged), result: 'IGNORED', reason: 'SIGNATURE_INVALID' },
      { ...id(misdirected), result: 'IGNORED', reason: 'WRONG_TARGET' },
      { ...id(wrongTopic), result: 'IGNORED', reason: 'TOPIC_MISMATCH' },
      { device: 'CANTEEN-01', msgId: null, type: null, result: 'IGNORED', reason: 'UNREADABLE' },
      { ...id(v2), result: 'IGNORED', reason: 'DUPLICATE' },
      { ...id(snapshot), kind: 'blocklist', version: 1, result: 'APPLIED' },
      { ...id(delta), kind: 'blocklist', version: 2, result: 'APPLIED' },
      { ...id(gap), kind: 'blocklist', version: 6, result: 'IGNORED', reason: 'VERSION_MISMATCH' },
      { device: 'CANTEEN-01', msgId: barrier.data.msgId, type: 'control.heartbeat-now', result: 'APPLIED' },
    ]);
    for (const e of received) assert.equal(e.school, A);
  });

  test("the ack names the command (inReplyTo); what a command makes the machine do carries the command's id", NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    await net.nextBeat(READER, 0);
    const command = await net.command(READER, 'config.prices', pricesBody(1));
    const ack = await waitFor(() => net.from(READER, 'command.ack')[0], { message: 'the ack' });
    const send = net.sendOf(ack.env.id);
    assert.deepEqual(send.data, { device: 'CANTEEN-01', msgId: ack.env.id, type: 'command.ack', seq: ack.env.seq, topic: RECORDS, bytes: ack.bytes, inReplyTo: command.id });
    // handled from the machine's own connection: no flow, but the command's id rides along
    assert.deepEqual([traceOf(send), send.msgId], [null, command.id]);
    const received = eventsOf(net.ctx, 'device.received').at(-1);
    assert.deepEqual([traceOf(received), received.msgId, received.data.msgId], [null, command.id, command.id]);

    const beats = net.from(READER, 'device.heartbeat').length;
    const now = await net.command(READER, 'control.heartbeat-now', {});
    const beat = await net.nextBeat(READER, beats);
    assert.equal(net.sendOf(beat.env.id).msgId, now.id); // so the lab can link the heartbeat to the command's flow
  });
});

// --- the outbox hold point (gate) ---------------------------------------------------------

describe('gate', () => {
  test('asked before every publish, after the envelope is signed; a gate that holds nothing keeps the publish synchronous', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const gate = net.gate();
    const reader = net.build(CanteenReader, READER, { gate: gate.fn });
    reader.provision(INSTALL);
    await reader.start();
    const beat = await net.nextBeat(READER, 0);
    assert.deepEqual(gate.calls, [{ kind: 'publish', device: 'CANTEEN-01', school: A, type: 'device.heartbeat', msgId: beat.env.id, seq: 1, topic: STATUS }]);

    const card = cardWith(net.ctx, A, 2000);
    const mark = net.ctx.events.lastSeq();
    const tapping = reader.tap(card, { items: [{ code: 'BUAH' }] });
    // nothing awaited yet: the gate was asked and the message handed to the client already
    assert.equal(gate.calls.length, 2);
    assert.equal(net.ctx.events.since(mark).filter((e) => e.type === 'device.send').length, 1);
    assert.equal((await tapping).sent, true);
    const sale = await waitFor(() => net.from(READER, 'sale.recorded')[0], { message: 'the sale' });
    assert.deepEqual(gate.calls[1], { kind: 'publish', device: 'CANTEEN-01', school: A, type: 'sale.recorded', msgId: sale.env.id, seq: 2, txn: 'CANTEEN-01-000001', topic: RECORDS });
  });

  test('a gate that throws or rejects is noted and passed: the machine carries on', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const notes = [];
    const log = (level, message, meta) => notes.push([level, message, meta?.error]);
    const throwing = net.build(CanteenReader, READER, {
      log,
      gate: () => {
        throw new Error('broken gate');
      },
    });
    await throwing.start();
    await net.nextBeat(READER, 0);
    assert.deepEqual(notes.filter((n) => n[1] === 'gate failed'), [['warn', 'gate failed', 'broken gate']]);
    await throwing.stop();

    const rejecting = net.build(CanteenReader, READER, { log, gate: () => Promise.reject(new Error('gate down')) });
    await rejecting.start();
    await net.nextBeat(READER, 1);
    assert.deepEqual(notes.filter((n) => n[1] === 'gate failed').at(-1), ['warn', 'gate failed', 'gate down']);
  });

  test('a sale held at the gate while the cable is pulled is not sent; plugging in uploads it in the plug\'s flow', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const gate = net.gate((info) => info.type === 'sale.recorded');
    const reader = net.build(CanteenReader, READER, { gate: gate.fn });
    reader.provision(INSTALL);
    await reader.start();
    await net.nextBeat(READER, 0);

    const tapping = net.ctx.events.withContext({ trace: 'tr_tap' }, () => reader.tap(cardWith(net.ctx, A, 2000), { items: [{ code: 'BUAH' }] }));
    await waitFor(() => gate.waiting.length === 1, { message: 'the sale to be held' });
    assert.deepEqual(eventsOf(net.ctx, 'device.send').filter((e) => e.data.type === 'sale.recorded'), []); // nothing went out yet
    await reader.setCable(false);
    gate.releaseAll();
    const sale = await tapping;
    assert.deepEqual([sale.ok, sale.sent], [true, false]);
    const offlineStep = steps(net.ctx, 'offline').at(-1);
    assert.deepEqual(offlineStep.data, { device: 'CANTEEN-01', step: 'offline', ok: false, type: 'sale.recorded', txn: 'CANTEEN-01-000001' });
    assert.equal(traceOf(offlineStep), 'tr_tap');
    assert.deepEqual(reader.state.journal, { total: 1, unsent: 1 });
    assert.deepEqual(net.from(READER, 'sale.recorded'), []);

    await net.ctx.events.withContext({ trace: 'tr_plug' }, () => reader.setCable(true));
    const batch = await waitFor(() => net.from(READER, 'journal.batch')[0], { message: 'the batch' });
    assert.deepEqual(batch.env.body.records, [sale.record]);
    assert.equal(traceOf(net.sendOf(batch.env.id)), 'tr_plug');
    await waitFor(() => reader.state.journal.unsent === 0, { message: 'the batch to be marked sent' });
  });

  test('a message overtaken while held goes out under the next seq (same id), so it is never a rollback', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const gate = net.gate((info) => info.type === 'sale.recorded');
    const reader = net.build(CanteenReader, READER, { gate: gate.fn });
    reader.provision(INSTALL);
    await reader.start();
    await net.nextBeat(READER, 0);

    const tapping = reader.tap(cardWith(net.ctx, A, 2000), { items: [{ code: 'BUAH' }] });
    await waitFor(() => gate.waiting.length === 1, { message: 'the sale to be held' });
    const held = gate.waiting[0].info;
    assert.equal(await reader.heartbeat(), true); // a heartbeat goes out meanwhile, with the next seq
    await waitFor(() => net.from(READER, 'device.heartbeat').some((m) => m.env.seq === held.seq + 1), { message: 'the overtaking heartbeat' });
    gate.releaseAll();
    assert.equal((await tapping).sent, true);

    const sale = await waitFor(() => net.from(READER, 'sale.recorded')[0], { message: 'the sale' });
    assert.equal(sale.env.id, held.msgId);
    assert.equal(sale.env.seq, held.seq + 2);
    assert.equal(verifyEnvelopeSignature(READER.secret, sale.env), true);
    assert.equal(net.sendOf(held.msgId).data.seq, held.seq + 2);
    assert.equal(reader.state.seq, held.seq + 2);
  });

  test('publishEnvelope passes the gate too, and a held envelope still goes out exactly as given', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const gate = net.gate((info) => info.type === 'sale.recorded');
    const reader = net.build(CanteenReader, READER, { gate: gate.fn });
    await reader.start();
    await net.nextBeat(READER, 0);
    // a lab fault: an old seq on purpose
    const envelope = signEnvelope(READER.secret, buildEnvelope({ school: A, device: 'CANTEEN-01', seq: 1, at: net.ctx.clock.iso(), type: 'sale.recorded', txn: 'CANTEEN-01-000009', body: {} }));
    const sending = reader.publishEnvelope(envelope);
    await waitFor(() => gate.waiting.length === 1, { message: 'the envelope to be held' });
    assert.deepEqual(gate.waiting[0].info, { kind: 'publish', device: 'CANTEEN-01', school: A, type: 'sale.recorded', msgId: envelope.id, seq: 1, txn: 'CANTEEN-01-000009', topic: RECORDS });
    assert.equal(await reader.heartbeat(), true);
    gate.releaseAll();
    assert.equal(await sending, true);
    const got = await waitFor(() => net.from(READER, 'sale.recorded')[0], { message: 'the envelope' });
    assert.deepEqual(got.env, envelope);
  });
});

// --- flows across connections ---------------------------------------------------------------

describe('the flow of a connection', () => {
  test('a plug owns the first post-connect routine; the periodic heartbeat and later reconnects belong to no flow', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { cablePlugged: false, heartbeatMs: 40, reconnectMs: 20 });
    reader.provision(INSTALL);
    await reader.start();
    await reader.tap(cardWith(net.ctx, A, 2000), { items: [{ code: 'BUAH' }] }); // waits in the journal

    await net.ctx.events.withContext({ trace: 'tr_plug' }, () => reader.setCable(true));
    const first = await net.nextBeat(READER, 0);
    const batch = await waitFor(() => net.from(READER, 'journal.batch')[0], { message: 'the batch' });
    assert.equal(traceOf(net.sendOf(first.env.id)), 'tr_plug');
    assert.equal(traceOf(net.sendOf(batch.env.id)), 'tr_plug');
    const periodic = await net.nextBeat(READER, 1); // from the interval timer
    assert.equal(traceOf(net.sendOf(periodic.env.id)), null);

    // the broker drops it and it comes back by itself: that routine is no one's
    const beats = net.from(READER, 'device.heartbeat').length;
    net.broker.kick(`${A}.CANTEEN-01`);
    const after = await net.nextBeat(READER, beats);
    assert.equal(traceOf(net.sendOf(after.env.id)), null);
  });

  test('traceNextConnect: the next reconnect within connectTraceMs belongs to the flow, and only that one', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { reconnectMs: 20 });
    await reader.start();
    await net.nextBeat(READER, 0);
    const reconnect = async () => {
      const beats = net.from(READER, 'device.heartbeat').length;
      net.broker.kick(`${A}.CANTEEN-01`); // it comes back by itself, with a fresh routine
      return traceOf(net.sendOf((await net.nextBeat(READER, beats)).env.id));
    };
    net.ctx.events.withContext({ trace: 'tr_restart' }, () => reader.traceNextConnect());
    assert.equal(await reconnect(), 'tr_restart');
    assert.equal(await reconnect(), null);
    // plugging a machine that is online already keeps nothing for later
    await net.ctx.events.withContext({ trace: 'tr_noop' }, () => reader.setCable(true));
    assert.equal(await reconnect(), null);
  });

  test('connectTraceMs: a connection that comes later than that runs in no flow', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { reconnectMs: 20, connectTraceMs: 50 });
    await reader.start();
    await net.nextBeat(READER, 0);
    net.ctx.events.withContext({ trace: 'tr_late' }, () => reader.traceNextConnect());
    await new Promise((resolve) => setTimeout(resolve, 120));
    const beats = net.from(READER, 'device.heartbeat').length;
    net.broker.kick(`${A}.CANTEEN-01`);
    const beat = await net.nextBeat(READER, beats);
    assert.equal(traceOf(net.sendOf(beat.env.id)), null);
  });

  test('a machine started inside a flow does not keep it: its connection, PUBACKs and commands run in none', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await net.ctx.events.withContext({ trace: 'tr_start' }, () => reader.start());
    const beat = await net.nextBeat(READER, 0);
    assert.equal(traceOf(net.sendOf(beat.env.id)), null);
    const command = await net.command(READER, 'config.prices', pricesBody(1));
    await waitFor(() => net.from(READER, 'command.ack')[0], { message: 'the ack' });
    const received = eventsOf(net.ctx, 'device.received').find((e) => e.data.msgId === command.id);
    assert.equal(traceOf(received), null);
    for (const e of eventsOf(net.ctx, 'device.acked')) assert.equal(traceOf(e), null);
  });
});

describe('without the context of the event bus', () => {
  test('a bus with only emit (or none at all): the machine works as before and still reports its steps', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const seen = [];
    const bus = { emit: (type, data, school) => seen.push({ type, data, school }) };
    const reader = net.build(CanteenReader, READER, { events: bus, gate: () => undefined });
    reader.provision(INSTALL);
    await reader.start();
    const sale = await reader.tap(cardWith(net.ctx, A, 2000), { items: [{ code: 'BUAH' }] });
    assert.equal(sale.sent, true);
    await net.command(READER, 'control.heartbeat-now', {});
    await waitFor(() => seen.some((e) => e.type === 'device.received'), { message: 'the command' });
    await reader.setCable(false);
    reader.traceNextConnect();
    await reader.setCable(true);
    assert.equal(reader.connected, true);
    for (const type of ['device.step', 'device.send', 'device.acked', 'device.received', 'device.cable']) {
      assert.ok(seen.some((e) => e.type === type && e.school === A), type);
    }

    const bare = net.build(CanteenReader, READER, { events: undefined });
    bare.provision(INSTALL);
    await reader.stop();
    await bare.start();
    assert.equal((await bare.tap(cardWith(net.ctx, A, 2000, { uid: '04112233445566' }), { items: [{ code: 'BUAH' }] })).sent, true);
  });
});
