import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { startBroker } from '../../src/broker/broker.js';
import { FIRMWARE_VERSION, JOURNAL_MAX_RECORDS, SCREEN_JOURNAL_FULL, Terminal } from '../../src/devices/terminal.js';
import { CanteenReader } from '../../src/devices/canteen.js';
import { WaterMachine } from '../../src/devices/water.js';
import { VirtualCard } from '../../src/devices/card.js';
import { AdminCard, packChecksum } from '../../src/devices/adminCard.js';
import { JOURNAL_FORMAT, verifyJournalFile } from '../../src/devices/usb.js';
import { brokerPassword, cardDigest, last4, randomSecret, signEnvelope, verifyEnvelopeSignature } from '../../src/shared/crypto.js';
import {
  DOWN_TYPES,
  MAX_BATCH_RECORDS,
  RETAINED_COMMAND_KINDS,
  SCREEN_CARD_UNAVAILABLE,
  buildEnvelope,
  commandTopic,
  deviceTxnNo,
  topicFor,
  validateEnvelopeShape,
  validateRecord,
} from '../../src/shared/protocol.js';
import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../../src/platform/configs.js';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';

// Fictional schools, machines and card UIDs; every key and secret is generated per run.

const A = 'smk-alpha';
const B = 'smk-beta';
const KEYS = { [A]: randomSecret(), [B]: randomSecret() };
const fixture = (school, code, type) => ({ school, code, type, secret: randomSecret() });
const READER = fixture(A, 'CANTEEN-01', 'CANTEEN');
const READER_B = fixture(B, 'CANTEEN-01', 'CANTEEN'); // same device code, other school
const UID = '04A1B2C3D4E5F6';
const NET = { timeout: 20_000 };

const pricesBody = (version, content = DEFAULT_PRICES) => ({ version, effectiveFrom: '2026-10-05T02:00:00.000Z', currency: 'MYR', ...structuredClone(content) });
const settingsBody = (version, content = DEFAULT_SETTINGS) => ({ version, effectiveFrom: '2026-10-05T02:00:00.000Z', ...structuredClone(content) });
// Many purchases a day, no tap gap: lets one card buy again and again.
const BUSY_SETTINGS = { ...DEFAULT_SETTINGS, dailyMaxCount: 100, tapGapSeconds: 0 };
const INSTALL = {
  prices: { version: 1, content: DEFAULT_PRICES },
  settings: { version: 1, content: BUSY_SETTINGS },
  blocklist: { version: 1, entries: [] },
};
const entryFor = (school, uid) => ({ card: cardDigest(KEYS[school], school, uid), last4: last4(uid) });

let seedOrders = 0;
/** A card of `school` holding `balanceSen`, put there by some earlier kiosk top-up. */
function cardWith(ctx, school, balanceSen, { uid = UID, group = 'STUDENT' } = {}) {
  const card = new VirtualCard({ uid, schoolCode: school, group, cardKey: KEYS[school] });
  if (balanceSen > 0) {
    seedOrders += 1;
    const write = { orderId: `ord_seed${seedOrders}`, kioskTxn: deviceTxnNo('KIOSK-09', seedOrders), at: ctx.clock.iso() };
    card.credit({ cardKey: KEYS[school], amountSen: balanceSen, write });
  }
  return card;
}

/** A machine with no network (never started): for what does not need the broker. */
function offline(ctx, Class, f, options = {}) {
  return new Class({
    school: { code: f.school, cardKey: KEYS[f.school] },
    device: { code: f.code, type: f.type, secret: f.secret },
    clock: ctx.clock,
    events: ctx.events,
    ...options,
  });
}

/** A raw MQTT client logged in as the platform, collecting every record and status message. */
async function platformClient(url, ctx, clientId = 'platform-test') {
  const client = await mqtt.connectAsync(url, {
    username: 'platform',
    password: ctx.settings.platformBrokerPassword,
    clientId,
    reconnectPeriod: 0,
    connectTimeout: 3000,
  });
  client.on('error', () => {});
  const inbox = [];
  client.on('message', (topic, payload, packet) => {
    let env = null;
    try {
      env = JSON.parse(payload.toString());
    } catch {
      // kept as null: a test looks at what arrived, parsable or not
    }
    inbox.push({ topic, env, retain: packet.retain });
  });
  await client.subscribeAsync(['lab/v1/+/+/records', 'lab/v1/+/+/status'], { qos: 1 });
  return { client, inbox };
}

/**
 * A broker on a random port that knows the given machines, a raw platform client, and
 * helpers. Every machine built here, the client and the broker are closed when the test ends.
 */
async function startNet(t, machines) {
  const ctx = createTestCtx();
  const accounts = new Map();
  const allow = (f, active = true) =>
    accounts.set(`${f.school}.${f.code}`, { schoolCode: f.school, deviceCode: f.code, password: brokerPassword(f.secret), active });
  for (const f of machines) allow(f);
  const resolveDevice = (username) => accounts.get(username) ?? null;
  const net = { ctx, accounts, allow, resolveDevice, opened: [] };
  net.broker = await startBroker(ctx, { port: 0, resolveDevice });
  Object.assign(net, await platformClient(net.broker.url, ctx));
  t.after(async () => {
    for (const m of net.opened) await m.stop();
    await net.client.endAsync(true);
    await net.broker.close();
    ctx.db.close();
  });
  let platformSeq = 0;

  /** A machine on this broker. */
  net.build = (Class, f, options = {}) => {
    const m = new Class({
      school: { code: f.school, cardKey: KEYS[f.school] },
      device: { code: f.code, type: f.type, secret: f.secret },
      brokerUrl: net.broker.url,
      clock: ctx.clock,
      events: ctx.events,
      ...options,
    });
    net.opened.push(m);
    return m;
  };
  /** Messages the platform got from one machine, of one type (or all). */
  net.from = (f, type) =>
    net.inbox.filter((m) => m.topic.startsWith(`lab/v1/${f.school}/${f.code}/`) && (type === undefined || m.env?.type === type));
  /** A command envelope as the platform signs it, with the machine's secret unless told otherwise. */
  net.envelope = (f, type, body, { secret = f.secret, fields = {} } = {}) =>
    signEnvelope(secret, { ...buildEnvelope({ school: f.school, device: f.code, seq: ++platformSeq, at: ctx.clock.iso(), type, body }), ...fields });
  /** Publish a command as the platform does: retained for the config kinds. */
  net.command = async (f, type, body, { secret, fields, topic, retain } = {}) => {
    const kind = DOWN_TYPES[type] ?? 'control';
    const envelope = net.envelope(f, type, body, { secret, fields });
    await net.client.publishAsync(topic ?? commandTopic(f.school, f.code, kind), JSON.stringify(envelope), {
      qos: 1,
      retain: retain ?? RETAINED_COMMAND_KINDS.includes(kind),
    });
    return envelope;
  };
  /** The machine's command.ack for a command. */
  net.ackOf = (f, envelope) =>
    waitFor(() => net.from(f, 'command.ack').find((m) => m.env.body.command === envelope.id), { message: `ack of ${envelope.type}` });
  /**
   * Wait until the machine has handled everything sent to it so far: a heartbeat-now goes
   * after it, and anything those commands made the machine send arrives before that heartbeat.
   */
  net.barrier = async (f) => {
    const beats = net.from(f, 'device.heartbeat').length;
    await net.command(f, 'control.heartbeat-now', {});
    await waitFor(() => net.from(f, 'device.heartbeat').length > beats, { message: 'the barrier heartbeat' });
  };
  return net;
}

const firstOf = (list, what) => waitFor(() => list().at(0), { message: what });

// --- construction ---------------------------------------------------------------------

describe('construction', () => {
  const ctx = createTestCtx();
  const good = { school: { code: A, cardKey: KEYS[A] }, device: { code: 'CANTEEN-01', type: 'CANTEEN', secret: randomSecret() }, clock: ctx.clock };

  test('a machine starts blank: no configs, empty journal, counters at 0', () => {
    const t = new Terminal(good);
    assert.deepEqual(t.state, {
      school: A,
      code: 'CANTEEN-01',
      type: 'CANTEEN',
      cablePlugged: true,
      connected: false,
      seq: 0,
      txnCounter: 0,
      journal: { total: 0, unsent: 0 },
      versions: { prices: 0, settings: 0, blocklist: 0 },
      blocklistSize: 0,
      lastScreen: null,
      highestAdminToken: 0,
    });
    assert.equal(t.schoolCode, A);
    assert.equal(t.deviceCode, 'CANTEEN-01');
    assert.equal(t.deviceType, 'CANTEEN');
    assert.equal(JOURNAL_MAX_RECORDS, 5000);
    assert.deepEqual(t.config.blocklist, { version: 0, content: { entries: [] }, effectiveFrom: null });
  });

  test('subclasses fill in their own type and refuse another', () => {
    const { type: _type, ...device } = good.device;
    assert.equal(new CanteenReader({ ...good, device }).deviceType, 'CANTEEN');
    assert.equal(new WaterMachine({ ...good, device: { ...device, code: 'WATER-01' } }).deviceType, 'WATER');
    assert.throws(() => new WaterMachine(good), TypeError);
    assert.throws(() => new Terminal({ ...good, device }), TypeError); // the base class needs a type
  });

  test('refuses malformed options', () => {
    const bad = [
      undefined,
      { ...good, school: undefined },
      { ...good, school: { code: 'SMK Alpha', cardKey: KEYS[A] } },
      { ...good, school: { code: A, cardKey: 'not-hex' } },
      { ...good, device: { ...good.device, code: 'canteen 1' } },
      { ...good, device: { ...good.device, type: 'VENDING' } },
      { ...good, device: { ...good.device, secret: 'ab'.repeat(8) } },
      { ...good, brokerUrl: 42 },
      { ...good, brokerUrl: '' },
      { ...good, brokerUrl: 'not a url' },
      { ...good, brokerUrl: 'http://127.0.0.1:1883' },
      { ...good, clock: undefined },
      { ...good, clock: { now: () => 0 } },
      { ...good, events: {} },
      { ...good, heartbeatMs: 0 },
      { ...good, heartbeatMs: 1.5 },
      { ...good, reconnectMs: -1 },
      { ...good, ackTimeoutMs: 2 ** 31 },
      { ...good, journalMax: 0 },
      { ...good, cablePlugged: 'yes' },
      { ...good, fw: '' },
      { ...good, log: 'console' },
    ];
    for (const options of bad) assert.throws(() => new Terminal(options), TypeError, JSON.stringify(options));
  });
});

// --- installation (no network) ----------------------------------------------------------

describe('provision', () => {
  test('installs the given configs, from configs.current() shapes or command bodies', () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    const lost = entryFor(A, '04FFEEDDCCBBAA');
    assert.deepEqual(reader.provision({ prices: { version: 3, content: DEFAULT_PRICES, effectiveFrom: 1 } }), { prices: 3, settings: 0, blocklist: 0 });
    assert.deepEqual(
      reader.provision({
        settings: { version: 2, ...structuredClone(DEFAULT_SETTINGS) },
        blocklist: { kind: 'blocklist', version: 5, content: { entries: [lost], added: [lost], removed: [] } },
      }),
      { prices: 3, settings: 2, blocklist: 5 },
    );
    const { config } = reader;
    assert.deepEqual(config.prices.content, structuredClone(DEFAULT_PRICES));
    assert.deepEqual(config.settings.content, structuredClone(DEFAULT_SETTINGS));
    assert.deepEqual(config.blocklist.content, { entries: [lost] });
    assert.equal(reader.state.blocklistSize, 1);
    // `config` is a copy
    config.prices.content.items[0].priceSen = 1;
    assert.equal(reader.config.prices.content.items[0].priceSen, DEFAULT_PRICES.items[0].priceSen);
  });

  test('checks every part before installing any; unusable content is a TypeError', () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    const bad = [
      { prices: { version: -1, content: DEFAULT_PRICES } },
      { prices: { content: DEFAULT_PRICES } },
      { prices: 'v1' },
      { prices: { version: 1, content: { items: [], water: DEFAULT_PRICES.water } } },
      { prices: { version: 1, content: { items: DEFAULT_PRICES.items } } },
      { settings: { version: 1, content: { ...DEFAULT_SETTINGS, mealWindows: [{ from: '18:00', to: '07:00' }] } } },
      { settings: { version: 1, content: { ...DEFAULT_SETTINGS, allowedGroups: ['PARENT'] } } },
      { blocklist: { version: 1, entries: [{ card: 'not-a-digest', last4: 'ABCD' }] } },
      { prices: INSTALL.prices, blocklist: { version: 'two', entries: [] } }, // prices fine, nothing installed
    ];
    for (const configs of bad) assert.throws(() => reader.provision(configs), TypeError, JSON.stringify(configs));
    assert.deepEqual(reader.state.versions, { prices: 0, settings: 0, blocklist: 0 });
  });

  test('a kind never published (null, or the empty block list at version 0) installs nothing', () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    const versions = reader.provision({ prices: null, settings: INSTALL.settings, blocklist: { kind: 'blocklist', version: 0, content: { entries: [] } } });
    assert.deepEqual(versions, { prices: 0, settings: 1, blocklist: 0 });
  });
});

// --- broker connection, heartbeat -------------------------------------------------------

describe('connection and heartbeat', () => {
  test('logs in as <school>.<DEVICE>, subscribes to its commands and sends a signed heartbeat', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    assert.equal(reader.connected, true);
    const username = `${A}.CANTEEN-01`;
    assert.deepEqual(net.broker.clients().filter((c) => c.username === username), [{ clientId: username, username }]);

    const beat = await firstOf(() => net.from(READER, 'device.heartbeat'), 'the first heartbeat');
    assert.equal(beat.topic, topicFor(A, 'CANTEEN-01', 'status'));
    assert.deepEqual(validateEnvelopeShape(beat.env), { ok: true });
    assert.equal(verifyEnvelopeSignature(READER.secret, beat.env), true);
    assert.equal(beat.env.seq, 1);
    assert.deepEqual(beat.env.body, {
      fw: FIRMWARE_VERSION,
      health: 'WARN', // a reader with no prices, settings or block list cannot sell
      listVersions: { prices: 0, settings: 0, blocklist: 0 },
      journalUnsent: 0,
    });

    reader.provision(INSTALL);
    await net.command(READER, 'control.heartbeat-now', {});
    const second = await waitFor(() => net.from(READER, 'device.heartbeat')[1], { message: 'heartbeat-now' });
    assert.equal(second.env.seq, 2);
    assert.deepEqual(second.env.body, { fw: FIRMWARE_VERSION, health: 'OK', listVersions: { prices: 1, settings: 1, blocklist: 1 }, journalUnsent: 0 });
    assert.deepEqual(eventsOf(net.ctx, 'mqtt.denied'), []); // it never touches a topic that is not its own
  });

  test('heartbeats every heartbeatMs while connected, none while unplugged, one again on plugging in', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { heartbeatMs: 25 });
    await reader.start();
    await waitFor(() => net.from(READER, 'device.heartbeat').length >= 4, { message: 'periodic heartbeats' });
    const seqs = net.from(READER, 'device.heartbeat').map((m) => m.env.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seq must rise: ${seqs}`);

    await reader.setCable(false);
    assert.equal(reader.connected, false);
    assert.equal(reader.state.cablePlugged, false);
    await waitFor(() => !net.broker.clients().some((c) => c.username === `${A}.CANTEEN-01`), { message: 'the broker to see it go' });
    const heard = net.from(READER).length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(net.from(READER).length, heard);
    assert.equal(await reader.heartbeat(), false);

    const lastSeq = Math.max(...net.from(READER, 'device.heartbeat').map((m) => m.env.seq));
    await reader.setCable(true);
    assert.equal(reader.connected, true);
    await waitFor(() => net.from(READER, 'device.heartbeat').some((m) => m.env.seq > lastSeq), { message: 'a heartbeat after plugging in' });
    assert.deepEqual(
      eventsOf(net.ctx, 'device.cable').map((e) => [e.school, e.data]),
      [[A, { device: 'CANTEEN-01', plugged: false }], [A, { device: 'CANTEEN-01', plugged: true }]],
    );
  });

  test('health turns WARN when the journal is nearly full of unsent records, not when it is full of sent ones', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { journalMax: 10 });
    reader.provision(INSTALL);
    await reader.start();
    const card = cardWith(net.ctx, A, 5000);
    const buy = () => reader.tap(card, { items: [{ code: 'BUAH' }] });
    const beat = async () => {
      const n = net.from(READER, 'device.heartbeat').length;
      await net.command(READER, 'control.heartbeat-now', {});
      return (await waitFor(() => net.from(READER, 'device.heartbeat')[n], { message: 'heartbeat-now' })).env.body;
    };
    for (let i = 0; i < 10; i++) assert.equal((await buy()).sent, true);
    assert.deepEqual(reader.state.journal, { total: 10, unsent: 0 });
    assert.deepEqual(await beat(), { fw: FIRMWARE_VERSION, health: 'OK', listVersions: { prices: 1, settings: 1, blocklist: 1 }, journalUnsent: 0 });

    // offline, nine of the ten places fill with unsent records: sales will soon be refused
    await reader.setCable(false);
    for (let i = 0; i < 9; i++) assert.equal((await buy()).sent, false);
    assert.deepEqual(reader.state.journal, { total: 10, unsent: 9 });
    await reader.setCable(true); // heartbeat first, then the upload
    const before = await waitFor(() => net.from(READER, 'device.heartbeat').find((m) => m.env.body.journalUnsent === 9), { message: 'the heartbeat on connect' });
    assert.equal(before.env.body.health, 'WARN');
    assert.deepEqual([(await beat()).health, reader.state.journal.unsent], ['OK', 0]);
  });

  test('a machine that starts unplugged stays offline until the cable goes in', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { cablePlugged: false });
    await reader.start();
    assert.equal(reader.connected, false);
    assert.equal(net.broker.clients().length, 1); // only the platform
    await reader.setCable(true);
    assert.equal(reader.connected, true);
    await firstOf(() => net.from(READER, 'device.heartbeat'), 'a heartbeat');
  });

  test('stop() disconnects; start() again (a reboot) keeps seq and txn counters going up', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    reader.provision(INSTALL);
    await reader.start();
    const card = cardWith(net.ctx, A, 2000);
    const first = await reader.tap(card, { items: [{ code: 'BUAH' }] });
    assert.equal(first.sent, true);
    const before = reader.state;
    await reader.stop();
    assert.equal(reader.connected, false);
    await reader.start();
    const second = await reader.tap(card, { items: [{ code: 'BUAH' }] });
    assert.equal(second.record.txn, deviceTxnNo('CANTEEN-01', 2));
    assert.ok(reader.state.seq > before.seq);
    const seqs = net.from(READER).map((m) => m.env.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    assert.equal(new Set(seqs).size, seqs.length);
  });

  test('reconnects by itself after a broker restart (or a switch-off) and uploads what it kept', NET, async (t) => {
    const ctx = createTestCtx();
    const accounts = new Map([[`${A}.CANTEEN-01`, { schoolCode: A, deviceCode: 'CANTEEN-01', password: brokerPassword(READER.secret), active: true }]]);
    const resolveDevice = (username) => accounts.get(username) ?? null;
    let broker = await startBroker(ctx, { port: 0, resolveDevice });
    let platform = null;
    const reader = new CanteenReader({
      school: { code: A, cardKey: KEYS[A] },
      device: { code: 'CANTEEN-01', secret: READER.secret },
      brokerUrl: broker.url,
      clock: ctx.clock,
      events: ctx.events,
      reconnectMs: 20,
    });
    t.after(async () => {
      await reader.stop();
      await platform?.client.endAsync(true);
      await broker.close();
      ctx.db.close();
    });
    reader.provision(INSTALL);
    await reader.start();
    const card = cardWith(ctx, A, 2000);
    assert.equal((await reader.tap(card, { items: [{ code: 'BUAH' }] })).sent, true);
    const seqBefore = reader.state.seq;

    const { port } = broker;
    await broker.close();
    await waitFor(() => !reader.connected, { message: 'the reader to notice' });
    const kept = await reader.tap(card, { items: [{ code: 'TEH-TARIK' }] });
    assert.equal(kept.ok, true);
    assert.equal(kept.sent, false);

    // The broker comes back on the same address, with the machine switched off at first: it
    // keeps knocking (CONNACK 5 does not stop it) until it is let in.
    accounts.get(`${A}.CANTEEN-01`).active = false;
    broker = await startBroker(ctx, { port, resolveDevice });
    platform = await platformClient(broker.url, ctx, 'platform-after-restart');
    await waitFor(() => eventsOf(ctx, 'mqtt.denied').some((e) => e.data.username === `${A}.CANTEEN-01`), { message: 'a refused login' });
    accounts.get(`${A}.CANTEEN-01`).active = true;
    const batch = await waitFor(() => platform.inbox.find((m) => m.env?.type === 'journal.batch'), { message: 'the batch', timeout: 8000 });
    assert.equal(verifyEnvelopeSignature(READER.secret, batch.env), true);
    assert.deepEqual(batch.env.body.records, [kept.record]);
    assert.ok(batch.env.seq > seqBefore);
    // marked sent on its PUBACK, which may reach the reader just after the platform got the batch
    await waitFor(() => reader.state.journal.unsent === 0, { message: 'the batch to be marked sent' });
    assert.deepEqual(reader.state.journal, { total: 2, unsent: 0 });
  });
});

// --- commands ---------------------------------------------------------------------------

describe('commands', () => {
  test('retained prices, settings and block list arrive on connect, each on its own topic, and are acked', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const lost = entryFor(A, '04FFEEDDCCBBAA');
    const prices = await net.command(READER, 'config.prices', pricesBody(1));
    const settings = await net.command(READER, 'config.settings', settingsBody(1));
    const blocklist = await net.command(READER, 'blocklist.snapshot', { version: 4, entries: [lost] });
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    for (const [envelope, kind, version] of [[prices, 'prices', 1], [settings, 'settings', 1], [blocklist, 'blocklist', 4]]) {
      const ack = await net.ackOf(READER, envelope);
      assert.equal(ack.topic, topicFor(A, 'CANTEEN-01', 'records'));
      assert.equal(verifyEnvelopeSignature(READER.secret, ack.env), true);
      assert.deepEqual(ack.env.body, { command: envelope.id, kind, result: 'APPLIED', appliedVersion: version });
    }
    assert.deepEqual(reader.state.versions, { prices: 1, settings: 1, blocklist: 4 });
    assert.equal(reader.state.blocklistSize, 1);
    assert.deepEqual(reader.config.prices, { version: 1, content: structuredClone(DEFAULT_PRICES), effectiveFrom: '2026-10-05T02:00:00.000Z' });
    assert.deepEqual(reader.config.settings.content, structuredClone(DEFAULT_SETTINGS));
    assert.deepEqual(reader.config.blocklist.content, { entries: [lost] });

    // A reconnect gets the same retained messages again: already handled, not acked twice.
    await reader.setCable(false);
    await reader.setCable(true);
    await net.barrier(READER);
    assert.equal(net.from(READER, 'command.ack').length, 3);
  });

  test('newer versions replace, the same version is ALREADY_APPLIED, an older or unusable one is REJECTED', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    const ackBody = async (type, body) => (await net.ackOf(READER, await net.command(READER, type, body))).env.body;
    const outcome = (b) => [b.kind, b.result, b.error, b.appliedVersion];
    const cheaper = { ...structuredClone(DEFAULT_PRICES), items: [{ code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 300 }] };

    assert.deepEqual(outcome(await ackBody('config.prices', pricesBody(2, cheaper))), ['prices', 'APPLIED', undefined, 2]);
    assert.deepEqual(reader.config.prices.content.items, cheaper.items); // the whole table replaced
    assert.deepEqual(outcome(await ackBody('config.prices', pricesBody(2))), ['prices', 'ALREADY_APPLIED', undefined, 2]);
    assert.deepEqual(reader.config.prices.content.items, cheaper.items); // the same version is not read again
    assert.deepEqual(outcome(await ackBody('config.prices', pricesBody(1))), ['prices', 'REJECTED', 'STALE_VERSION', 2]);
    const broken = { ...pricesBody(3), items: [{ code: 'nasi lemak', name: 'Nasi lemak', priceSen: -1 }] };
    assert.deepEqual(outcome(await ackBody('config.prices', broken)), ['prices', 'REJECTED', 'CONFIG_INVALID', 2]);
    assert.deepEqual(outcome(await ackBody('config.prices', { ...pricesBody(3), currency: 'USD' })), ['prices', 'REJECTED', 'CONFIG_INVALID', 2]);
    assert.deepEqual(outcome(await ackBody('config.prices', { ...pricesBody(3), version: 'three' })), ['prices', 'REJECTED', 'CONFIG_INVALID', 2]);
    assert.equal(reader.state.versions.prices, 2);

    // settings and the block list follow the same rules, each in its own version space
    assert.deepEqual(outcome(await ackBody('config.settings', settingsBody(5))), ['settings', 'APPLIED', undefined, 5]);
    assert.deepEqual(outcome(await ackBody('config.settings', settingsBody(4))), ['settings', 'REJECTED', 'STALE_VERSION', 5]);
    const noWindowEnd = { ...settingsBody(6), mealWindows: [{ from: '07:00' }] };
    assert.deepEqual(outcome(await ackBody('config.settings', noWindowEnd)), ['settings', 'REJECTED', 'CONFIG_INVALID', 5]);
    assert.deepEqual(outcome(await ackBody('blocklist.snapshot', { version: 2, entries: [] })), ['blocklist', 'APPLIED', undefined, 2]);
    assert.deepEqual(outcome(await ackBody('blocklist.snapshot', { version: 2, entries: [] })), ['blocklist', 'ALREADY_APPLIED', undefined, 2]);
    assert.deepEqual(outcome(await ackBody('blocklist.snapshot', { version: 1, entries: [] })), ['blocklist', 'REJECTED', 'STALE_VERSION', 2]);
    assert.deepEqual(reader.state.versions, { prices: 2, settings: 5, blocklist: 2 });
  });

  test('a block-list delta applies only on top of the version it was made from', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    const lost = entryFor(A, '04FFEEDDCCBBAA');
    const other = entryFor(A, '04112233445566');
    await net.ackOf(READER, await net.command(READER, 'blocklist.snapshot', { version: 1, entries: [other] }));

    const add = await net.command(READER, 'blocklist.delta', { fromVersion: 1, toVersion: 2, added: [lost], removed: [] });
    assert.deepEqual((await net.ackOf(READER, add)).env.body, { command: add.id, kind: 'blocklist', result: 'APPLIED', appliedVersion: 2 });
    assert.deepEqual(reader.config.blocklist.content.entries, [other, lost]);

    // made from another version: ignored, no ack (the retained snapshot brings the list)
    const gap = await net.command(READER, 'blocklist.delta', { fromVersion: 5, toVersion: 6, added: [], removed: [lost.card] });
    const behind = await net.command(READER, 'blocklist.delta', { fromVersion: 1, toVersion: 2, added: [], removed: [lost.card] });
    const malformed = await net.command(READER, 'blocklist.delta', { fromVersion: 2, toVersion: 3, added: [{ card: 'xyz' }], removed: [] });
    await net.barrier(READER);
    for (const envelope of [gap, behind, malformed]) {
      assert.equal(net.from(READER, 'command.ack').some((m) => m.env.body.command === envelope.id), false);
    }
    assert.equal(reader.state.versions.blocklist, 2);

    const remove = await net.command(READER, 'blocklist.delta', { fromVersion: 2, toVersion: 3, added: [], removed: [other.card] });
    assert.equal((await net.ackOf(READER, remove)).env.body.appliedVersion, 3);
    assert.deepEqual(reader.config.blocklist.content.entries, [lost]);
    // the snapshot of that version, arriving after the delta, changes nothing
    const snap = await net.command(READER, 'blocklist.snapshot', { version: 3, entries: [lost] });
    assert.equal((await net.ackOf(READER, snap)).env.body.result, 'ALREADY_APPLIED');
  });

  test('ignores forged, misdirected and malformed commands, and handles a repeated one once', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    const pricesTopic = commandTopic(A, 'CANTEEN-01', 'prices');
    const raw = (topic, payload) => net.client.publishAsync(topic, payload, { qos: 1 });
    // signed with another key
    await net.command(READER, 'config.prices', pricesBody(7), { secret: randomSecret() });
    // naming another machine or another school, though signed with this machine's own secret
    await net.command(READER, 'config.prices', pricesBody(7), { fields: { device: 'CANTEEN-02' } });
    await net.command(READER, 'config.prices', pricesBody(7), { fields: { school: B } });
    // a command type on another kind's sub-topic
    await net.command(READER, 'config.prices', pricesBody(7), { topic: commandTopic(A, 'CANTEEN-01', 'settings') });
    // edited after it was signed
    const genuine = net.envelope(READER, 'blocklist.snapshot', { version: 1, entries: [] });
    await raw(commandTopic(A, 'CANTEEN-01', 'blocklist'), JSON.stringify({ ...genuine, body: { version: 1, entries: [entryFor(A, UID)] } }));
    // not an envelope at all
    await raw(pricesTopic, '{ not json');
    await raw(pricesTopic, JSON.stringify({ type: 'config.prices', body: pricesBody(7) }));
    await net.barrier(READER);
    assert.equal(net.from(READER, 'command.ack').length, 0);
    assert.deepEqual(reader.state.versions, { prices: 0, settings: 0, blocklist: 0 });

    // the same envelope twice (a repeat): handled and acked once
    const once = net.envelope(READER, 'config.prices', pricesBody(8));
    await raw(pricesTopic, JSON.stringify(once));
    await raw(pricesTopic, JSON.stringify(once));
    await net.barrier(READER);
    assert.deepEqual(net.from(READER, 'command.ack').map((m) => [m.env.body.command, m.env.body.result]), [[once.id, 'APPLIED']]);
    assert.deepEqual(reader.state.versions, { prices: 8, settings: 0, blocklist: 0 });
  });

  test('control.upload-journal makes it upload its journal', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    const flushes = [];
    const flush = reader.flushJournal.bind(reader);
    reader.flushJournal = () => {
      flushes.push(net.ctx.clock.iso());
      return flush();
    };
    await reader.start();
    assert.equal(flushes.length, 1); // on connect
    await net.command(READER, 'control.upload-journal', {});
    await waitFor(() => flushes.length === 2, { message: 'the flush' });
  });

  test('the same device code in another school never takes this school\'s commands', NET, async (t) => {
    const net = await startNet(t, [READER, READER_B]);
    const ours = net.build(CanteenReader, READER);
    const theirs = net.build(CanteenReader, READER_B);
    await ours.start();
    await theirs.start();
    const theirsCommand = await net.command(READER_B, 'config.prices', pricesBody(9));
    await net.ackOf(READER_B, theirsCommand);
    // the other school's genuine command, copied onto this school's topic: it names another
    // school and its signature is not this machine's
    await net.client.publishAsync(commandTopic(A, 'CANTEEN-01', 'prices'), JSON.stringify(theirsCommand), { qos: 1 });
    await net.barrier(READER);
    assert.equal(ours.state.versions.prices, 0);
    assert.equal(theirs.state.versions.prices, 9);
    assert.equal(net.from(READER, 'command.ack').length, 0);
  });
});

// --- sending ----------------------------------------------------------------------------

describe('publishUp and publishEnvelope', () => {
  test('publishUp sends only device message types, and says false while offline', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { cablePlugged: false });
    await reader.start();
    assert.equal(await reader.publishUp('device.heartbeat', { fw: 'x', health: 'OK' }), false);
    assert.equal(reader.state.seq, 0); // nothing was sent, so no seq was used
    await assert.rejects(reader.publishUp('config.prices', {}), TypeError);
    await assert.rejects(reader.publishUp('toString', {}), TypeError);
    await assert.rejects(reader.publishUp('device.heartbeat', null), TypeError);
    await reader.setCable(true);
    assert.equal(await reader.publishUp('command.ack', { command: 'x', kind: 'prices', result: 'APPLIED', appliedVersion: 0 }, { txn: 'T-1' }), true);
    const ack = await waitFor(() => net.from(READER, 'command.ack')[0]);
    assert.equal(ack.env.txn, 'T-1');
  });

  test('publishEnvelope sends an envelope exactly as given, on the machine\'s own topic only', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    await reader.start();
    await waitFor(() => net.from(READER, 'device.heartbeat')[0]);
    const forged = { ...buildEnvelope({ school: A, device: 'CANTEEN-02', seq: 1, at: net.ctx.clock.iso(), type: 'sale.recorded', body: {} }), sig: 'x'.repeat(43) };
    assert.equal(await reader.publishEnvelope(forged), true);
    const got = await waitFor(() => net.from(READER, 'sale.recorded')[0]);
    assert.equal(got.topic, topicFor(A, 'CANTEEN-01', 'records')); // its own topic, whatever the envelope says
    assert.deepEqual(got.env, forged);
    assert.equal(await reader.publishEnvelope({ ...forged, type: 'device.heartbeat' }), true);
    await waitFor(() => net.from(READER, 'device.heartbeat').some((m) => m.env.sig === forged.sig));
    assert.deepEqual(eventsOf(net.ctx, 'mqtt.denied'), []);
    assert.equal(reader.connected, true);
  });
});

// --- journal --------------------------------------------------------------------------

describe('journal', () => {
  test(`unsent records go up as journal.batch messages of at most ${MAX_BATCH_RECORDS} when the cable is plugged in`, NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { cablePlugged: false });
    reader.provision(INSTALL);
    await reader.start();
    const card = cardWith(net.ctx, A, 50_000);
    const n = 2 * MAX_BATCH_RECORDS + 50;
    const records = [];
    for (let i = 0; i < n; i++) {
      const r = await reader.tap(card, { items: [{ code: 'BUAH' }] });
      assert.equal(r.sent, false);
      records.push(r.record);
    }
    assert.deepEqual(reader.state.journal, { total: n, unsent: n });
    assert.equal(net.from(READER).length, 0);

    await reader.setCable(true);
    assert.deepEqual(reader.state.journal, { total: n, unsent: 0 });
    const batches = await waitFor(() => {
      const got = net.from(READER, 'journal.batch');
      return got.length === 3 ? got : null;
    }, { message: 'three batches' });
    assert.deepEqual(batches.map((b) => [b.env.txn, b.env.body.batchId, b.env.body.count, b.env.body.records.length]), [
      ['CANTEEN-01-B1', 'CANTEEN-01-B1', 200, 200],
      ['CANTEEN-01-B2', 'CANTEEN-01-B2', 200, 200],
      ['CANTEEN-01-B3', 'CANTEEN-01-B3', 50, 50],
    ]);
    assert.deepEqual(batches.flatMap((b) => b.env.body.records), records);
    for (const b of batches) {
      assert.equal(b.topic, topicFor(A, 'CANTEEN-01', 'records'));
      assert.equal(verifyEnvelopeSignature(READER.secret, b.env), true);
      assert.deepEqual(validateEnvelopeShape(b.env), { ok: true });
    }
    assert.deepEqual(records.map((r) => r.txn), Array.from({ length: n }, (_, i) => deviceTxnNo('CANTEEN-01', i + 1)));
    const heartbeat = net.from(READER, 'device.heartbeat')[0];
    assert.equal(heartbeat.env.body.journalUnsent, n); // sent before the upload
    assert.ok(batches.every((b) => b.env.seq > heartbeat.env.seq));
    // nothing left: another upload sends nothing
    assert.deepEqual(await reader.flushJournal(), { batches: 0, records: 0, unsent: 0 });
  });

  test('keeps at most journalMax records, dropping the oldest sent ones first, and never an unsent one', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { journalMax: 3 });
    reader.provision(INSTALL);
    await reader.start();
    const card = cardWith(net.ctx, A, 5000);
    const buy = () => reader.tap(card, { items: [{ code: 'BUAH' }] });
    const txns = () => reader.journal().map((e) => [e.record.txn.slice(-1), e.sent]);
    await buy();
    await buy();
    await reader.setCable(false);
    await buy();
    assert.deepEqual(txns(), [['1', true], ['2', true], ['3', false]]);
    await buy();
    assert.deepEqual(txns(), [['2', true], ['3', false], ['4', false]]);
    await buy();
    assert.deepEqual(txns(), [['3', false], ['4', false], ['5', false]]);
    const balance = card.balanceSen;
    const full = await buy();
    assert.deepEqual([full.ok, full.reason, full.screen], [false, 'JOURNAL_FULL', SCREEN_JOURNAL_FULL]);
    assert.equal(card.balanceSen, balance); // refused before the card was touched
    assert.equal(reader.state.txnCounter, 5);
    await reader.setCable(true);
    assert.deepEqual(reader.state.journal, { total: 3, unsent: 0 });
    assert.equal((await buy()).ok, true);
    assert.deepEqual(txns(), [['4', true], ['5', true], ['6', true]]);
  });

  test('a sale still waiting for its PUBACK when the cable is pulled counts as unsent and goes up in the next batch', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER);
    reader.provision(INSTALL);
    await reader.start();
    const card = cardWith(net.ctx, A, 2000);
    const tapping = reader.tap(card, { items: [{ code: 'BUAH' }] }); // published; its PUBACK cannot be back yet
    await reader.setCable(false);
    const sale = await tapping;
    assert.deepEqual([sale.ok, sale.sent], [true, false]);
    assert.deepEqual(reader.state.journal, { total: 1, unsent: 1 });

    await reader.setCable(true);
    assert.deepEqual(reader.state.journal, { total: 1, unsent: 0 });
    const batch = await firstOf(() => net.from(READER, 'journal.batch'), 'the batch');
    assert.deepEqual(batch.env.body.records, [sale.record]);
    // the first copy may have reached the platform too: the same record, which it drops as a repeat
    for (const m of net.from(READER, 'sale.recorded')) assert.deepEqual(m.env.body.record, sale.record);
    assert.ok(net.from(READER, 'sale.recorded').length <= 1);
  });

  test('a record whose PUBACK does not come within ackTimeoutMs stays unsent, even when the PUBACK comes later', NET, async (t) => {
    const net = await startNet(t, [READER]);
    const reader = net.build(CanteenReader, READER, { ackTimeoutMs: 100 });
    reader.provision(INSTALL);
    await reader.start();
    await firstOf(() => net.from(READER, 'device.heartbeat'), 'the first heartbeat');
    // the broker holds the reader's next message (a link that stalls) until it is let go
    const { aedes } = net.broker;
    const authorize = aedes.authorizePublish;
    let hold = true;
    let release = null;
    aedes.authorizePublish = (client, packet, done) => {
      if (hold && client?.id === `${A}.CANTEEN-01`) {
        hold = false;
        release = () => authorize.call(aedes, client, packet, done);
        return;
      }
      authorize.call(aedes, client, packet, done);
    };
    const card = cardWith(net.ctx, A, 2000);
    const sale = await reader.tap(card, { items: [{ code: 'BUAH' }] });
    assert.deepEqual([sale.ok, sale.sent, reader.connected], [true, false, true]);
    assert.deepEqual(reader.state.journal, { total: 1, unsent: 1 });

    // let go at last: the platform gets it, but the late PUBACK does not count
    release();
    await firstOf(() => net.from(READER, 'sale.recorded'), 'the late sale');
    await net.barrier(READER); // the reader has read everything the broker sent it before the barrier
    assert.deepEqual(reader.state.journal, { total: 1, unsent: 1 });
    assert.equal(net.from(READER, 'device.heartbeat').at(-1).env.body.journalUnsent, 1);

    // the next upload sends it again (the platform drops the repeat); mqtt.js never resends the old envelope
    await net.command(READER, 'control.upload-journal', {});
    const batch = await firstOf(() => net.from(READER, 'journal.batch'), 'the batch');
    assert.deepEqual(batch.env.body.records, [sale.record]);
    await waitFor(() => reader.state.journal.unsent === 0, { message: 'the batch to be marked sent' });
    await net.barrier(READER);
    assert.equal(net.from(READER, 'sale.recorded').length, 1);
  });

  test('journal({ limit }) gives the newest records, as copies', async () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    reader.provision(INSTALL);
    const card = cardWith(ctx, A, 1000);
    for (let i = 0; i < 3; i++) await reader.tap(card, { items: [{ code: 'BUAH' }] });
    assert.deepEqual(reader.journal({ limit: 2 }).map((e) => e.record.txn), [deviceTxnNo('CANTEEN-01', 2), deviceTxnNo('CANTEEN-01', 3)]);
    assert.equal(reader.journal({ limit: 10 }).length, 3);
    assert.deepEqual(reader.journal({ limit: 0 }), []);
    const copy = reader.journal();
    copy[0].record.amountSen = 1;
    assert.equal(reader.journal()[0].record.amountSen, 100);
  });

  test('exports the whole journal as a USB file signed with the machine secret', async () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    reader.provision(INSTALL);
    const card = cardWith(ctx, A, 1000);
    const sales = [];
    for (const code of ['NASI-LEMAK', 'TEH-TARIK']) sales.push((await reader.tap(card, { items: [{ code }] })).record);
    const file = reader.exportJournal();
    assert.equal(file.format, JOURNAL_FORMAT);
    assert.equal(file.school, A);
    assert.equal(file.device, 'CANTEEN-01');
    assert.equal(file.exportedAt, ctx.clock.iso());
    assert.equal(file.count, 2);
    assert.deepEqual(file.records, sales);
    for (const r of file.records) assert.deepEqual(validateRecord(r), { ok: true });
    assert.equal(verifyJournalFile(file, READER.secret), true);
    assert.equal(verifyJournalFile(file, randomSecret()), false);
    assert.equal(verifyJournalFile({ ...file, records: file.records.slice(1), count: 1 }, READER.secret), false);
    assert.deepEqual(reader.state.journal, { total: 2, unsent: 2 }); // exporting does not mark anything sent
    assert.deepEqual(offline(ctx, CanteenReader, READER).exportJournal().records, []);
  });
});

// --- admin card -------------------------------------------------------------------------

describe('admin card', () => {
  const lost = entryFor(A, '04FFEEDDCCBBAA');
  const pack = (kind, version, content) => ({ kind, version, content, checksum: packChecksum(content) });
  const newPrices = { ...structuredClone(DEFAULT_PRICES), items: [{ code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 380 }] };

  function setup() {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    reader.provision(INSTALL); // prices 1, settings 1, block list 1
    const adminCard = new AdminCard({ schoolCode: A });
    return { ctx, reader, adminCard };
  }

  test('applies newer packs at once, writes one receipt per pack and remembers the token', () => {
    const { ctx, reader, adminCard } = setup();
    adminCard.load({
      token: 3,
      loadedAt: ctx.clock.iso(),
      packs: [pack('blocklist', 2, { entries: [lost] }), pack('prices', 2, newPrices), pack('settings', 1, structuredClone(BUSY_SETTINGS))],
    });
    ctx.clock.advance(60_000);
    const { results } = reader.tapAdminCard(adminCard);
    const at = ctx.clock.iso();
    assert.deepEqual(results, [
      { device: 'CANTEEN-01', kind: 'blocklist', appliedVersion: 2, result: 'APPLIED', at },
      { device: 'CANTEEN-01', kind: 'prices', appliedVersion: 2, result: 'APPLIED', at },
      { device: 'CANTEEN-01', kind: 'settings', appliedVersion: 1, result: 'ALREADY_APPLIED', at },
    ]);
    assert.deepEqual(adminCard.memory.receipts, results);
    assert.deepEqual(reader.state.versions, { prices: 2, settings: 1, blocklist: 2 });
    assert.equal(reader.state.highestAdminToken, 3);
    assert.deepEqual(reader.config.prices.content.items, newPrices.items); // the whole table replaced
    assert.deepEqual(reader.state.lastScreen.text, 'Admin card read: 2 applied, 1 already applied, 0 rejected');
    const [event] = eventsOf(ctx, 'admin-card.applied');
    assert.equal(event.school, A);
    assert.deepEqual(event.data, { device: 'CANTEEN-01', token: 3, results });
  });

  test('an old token is refused for every pack; a damaged or older pack is refused on its own', () => {
    const { ctx, reader, adminCard } = setup();
    adminCard.load({ token: 5, loadedAt: ctx.clock.iso(), packs: [pack('prices', 2, newPrices)] });
    reader.tapAdminCard(adminCard);
    adminCard.takeReceipts();

    // the same card again, or one loaded with a lower token: STALE_TOKEN for everything
    adminCard.load({ token: 4, loadedAt: ctx.clock.iso(), packs: [pack('prices', 9, newPrices), pack('blocklist', 9, { entries: [] })] });
    for (const token of [4, 5]) {
      if (token === 5) adminCard.load({ token: 5, loadedAt: ctx.clock.iso(), packs: [pack('prices', 9, newPrices)] });
      const { results } = reader.tapAdminCard(adminCard);
      assert.ok(results.length > 0);
      for (const r of results) assert.deepEqual([r.result, r.error], ['REJECTED', 'STALE_TOKEN']);
      assert.equal(results[0].appliedVersion, 2);
    }
    assert.deepEqual(reader.state.versions, { prices: 2, settings: 1, blocklist: 1 });
    assert.equal(reader.state.highestAdminToken, 5);
    adminCard.takeReceipts();

    // a newer token: per pack, a damaged one, an older one, and a good one
    const damaged = { ...pack('blocklist', 3, { entries: [lost] }), checksum: packChecksum({ entries: [] }) };
    adminCard.load({ token: 6, loadedAt: ctx.clock.iso(), packs: [damaged, pack('prices', 1, DEFAULT_PRICES), pack('settings', 2, structuredClone(BUSY_SETTINGS))] });
    const { results } = reader.tapAdminCard(adminCard);
    assert.deepEqual(results.map((r) => [r.kind, r.result, r.error, r.appliedVersion]), [
      ['blocklist', 'REJECTED', 'BAD_CHECKSUM', 1],
      ['prices', 'REJECTED', 'STALE_VERSION', 2],
      ['settings', 'APPLIED', undefined, 2],
    ]);
    assert.equal(reader.state.blocklistSize, 0);
    assert.equal(reader.state.highestAdminToken, 6);
    assert.equal(reader.state.lastScreen.tone, 'warn');
  });

  test("another school's admin card is refused and gets no receipts", () => {
    const { ctx, reader } = setup();
    const theirs = new AdminCard({ schoolCode: B });
    theirs.load({ token: 99, loadedAt: ctx.clock.iso(), packs: [pack('prices', 7, newPrices)] });
    assert.deepEqual(reader.tapAdminCard(theirs), { results: [] });
    assert.deepEqual(theirs.memory.receipts, []);
    assert.equal(reader.state.highestAdminToken, 0);
    assert.equal(reader.state.versions.prices, 1);
    assert.equal(reader.state.lastScreen.text, SCREEN_CARD_UNAVAILABLE);
    assert.throws(() => reader.tapAdminCard({}), TypeError);
  });

  test('a block list from the admin card blocks the card at the next tap', async () => {
    const { ctx, reader, adminCard } = setup();
    const card = cardWith(ctx, A, 1000, { uid: '04FFEEDDCCBBAA' });
    assert.equal((await reader.tap(card, { items: [{ code: 'BUAH' }] })).ok, true);
    adminCard.load({ token: 1, loadedAt: ctx.clock.iso(), packs: [pack('blocklist', 2, { entries: [lost] })] });
    reader.tapAdminCard(adminCard);
    const refused = await reader.tap(card, { items: [{ code: 'BUAH' }] });
    assert.deepEqual([refused.ok, refused.reason, refused.screen], [false, 'BLOCKED', SCREEN_CARD_UNAVAILABLE]);
  });
});

describe('screen', () => {
  test('emits device.screen with the school and keeps the last screen', () => {
    const ctx = createTestCtx();
    const reader = offline(ctx, CanteenReader, READER);
    assert.equal(reader.screen('Hello'), 'Hello');
    reader.screen('Careful', 'warn');
    reader.screen('Odd', 'purple'); // an unknown tone is shown as info
    assert.deepEqual(eventsOf(ctx, 'device.screen').map((e) => [e.school, e.data]), [
      [A, { device: 'CANTEEN-01', text: 'Hello', tone: 'info' }],
      [A, { device: 'CANTEEN-01', text: 'Careful', tone: 'warn' }],
      [A, { device: 'CANTEEN-01', text: 'Odd', tone: 'info' }],
    ]);
    assert.deepEqual(reader.state.lastScreen, { text: 'Odd', tone: 'info', at: ctx.clock.iso() });
  });
});
