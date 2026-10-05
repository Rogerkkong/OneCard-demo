import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';
import { startBroker } from '../../src/broker/broker.js';
import { createPlatform, PLATFORM_CLIENT_ID } from '../../src/platform/platform.js';
import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../../src/platform/configs.js';
import { brokerPassword, signEnvelope, verifyEnvelopeSignature } from '../../src/shared/crypto.js';
import { buildEnvelope, deviceTxnNo, topicFor, UP_TYPES, validateEnvelopeShape } from '../../src/shared/protocol.js';
import { DAY, MINUTE } from '../../src/shared/time.js';

// Every school, person and machine here is fictional; secrets and card keys are generated
// for each test. Machines are plain MQTT clients here (the virtual hardware is tested on its own).

const NET = { timeout: 20_000 };
const PRICE = Object.fromEntries(DEFAULT_PRICES.items.map((i) => [i.code, i.priceSen]));
const KINDS = ['prices', 'settings', 'blocklist'];

/** assert.throws / rejects matcher for a LabError code (and HTTP status). */
const labError = (code, status) => (err) => {
  assert.equal(err.name, 'LabError', `expected LabError ${code}, got ${err}`);
  assert.equal(err.code, code, err.message);
  if (status !== undefined) assert.equal(err.status, status);
  return true;
};

/** Two schools with machines, members holding cards, prices, settings and a block list (services only). */
function seed(platform) {
  const { schools, devices, configs } = platform.services;
  const school = (code, name, people, machines) => {
    const s = schools.createSchool({ code, name });
    const m = {};
    for (const [deviceCode, type] of machines) {
      const { device, secret } = devices.registerDevice({ schoolId: s.id, code: deviceCode, type, actor: 'seed' });
      m[deviceCode] = { id: device.id, code: deviceCode, type, secret, seq: 0 };
    }
    const members = {};
    for (const [key, p] of Object.entries(people)) {
      const member = schools.addMember({ schoolId: s.id, memberNo: p.no, name: p.name });
      const card = schools.issueCard({ schoolId: s.id, memberId: member.id, uid: p.uid, actor: 'seed' });
      members[key] = { id: member.id, uid: p.uid, digest: card.digest, cardId: card.id };
    }
    configs.publish({ schoolId: s.id, kind: 'prices', content: DEFAULT_PRICES, actor: 'seed' });
    configs.publish({ schoolId: s.id, kind: 'settings', content: DEFAULT_SETTINGS, actor: 'seed' });
    configs.ensureBlockList({ schoolId: s.id, actor: 'seed' });
    return { id: s.id, code, m, members };
  };
  return {
    a: school('smk-alpha', 'SMK Alpha (fictional)', {
      aina: { no: 'A001', name: 'Aina Alpha', uid: '04A1B2C3D4E5F6' },
      badrul: { no: 'A002', name: 'Badrul Alpha', uid: '04B7C8D9EAFB01' },
    }, [['CANTEEN-01', 'CANTEEN'], ['CANTEEN-02', 'CANTEEN'], ['WATER-01', 'WATER'], ['KIOSK-01', 'KIOSK']]),
    b: school('smk-beta', 'SMK Beta (fictional)', {
      chong: { no: 'B001', name: 'Chong Beta', uid: '04A1B2C3D4E5F6' },
    }, [['CANTEEN-01', 'CANTEEN'], ['KIOSK-01', 'KIOSK']]),
  };
}

/**
 * A platform with two seeded schools and a broker on a random port (the platform connected
 * unless `connect: false`). Everything it opens is closed when the test ends.
 */
async function setup(t, { connect = true, reconnectMs } = {}) {
  const ctx = createTestCtx();
  const platform = createPlatform(ctx);
  const world = seed(platform);
  const brokers = [];
  const clients = [];
  const startOn = async (port = 0) => {
    const broker = await startBroker(ctx, { port, resolveDevice: (username) => platform.resolveBrokerDevice(username) });
    brokers.push(broker);
    return broker;
  };
  await startOn();
  const broker = () => brokers.at(-1);
  platform.setBroker(broker);
  t.after(async () => {
    await Promise.all(clients.map((c) => c.endAsync(true).catch(() => {})));
    await platform.disconnectMqtt();
    for (const b of brokers) await b.close();
    ctx.db.close();
  });
  if (connect) await platform.connectMqtt(broker().url, reconnectMs ? { reconnectMs } : {});

  const login = (school, code) => {
    const username = `${school.code}.${code}`;
    return { username, clientId: username, password: brokerPassword(school.m[code].secret) };
  };

  /** A machine as a raw MQTT client: subscribed to its own commands, collecting them. */
  async function machine(school, code, { url = broker().url, subscribe = true } = {}) {
    const m = school.m[code];
    const client = await mqtt.connectAsync(url, { ...login(school, code), reconnectPeriod: 0, connectTimeout: 3000 }, false);
    clients.push(client);
    client.on('error', () => {});
    const inbox = [];
    client.on('message', (topic, payload, packet) => {
      inbox.push({ topic, kind: topic.split('/').at(-1), env: JSON.parse(payload.toString()), retain: packet.retain });
    });
    if (subscribe) await client.subscribeAsync(`${topicFor(school.code, code, 'commands')}/#`, { qos: 1 });
    return {
      client,
      inbox,
      /** Sign and publish a message the way a machine does (QoS 1, its own topic). */
      async send(type, body, { txn } = {}) {
        const env = signEnvelope(m.secret, buildEnvelope({ school: school.code, device: code, seq: ++m.seq, at: ctx.clock.iso(), type, txn, body }));
        await client.publishAsync(topicFor(school.code, code, UP_TYPES[type]), JSON.stringify(env), { qos: 1 });
        return env;
      },
    };
  }

  /** The CONNACK code with which the broker refuses this machine's login. */
  async function refusedLogin(school, code) {
    try {
      const client = await mqtt.connectAsync(broker().url, { ...login(school, code), reconnectPeriod: 0, connectTimeout: 3000 }, false);
      clients.push(client);
    } catch (err) {
      return err.code;
    }
    return assert.fail(`${school.code}.${code} should have been refused`);
  }

  return { ctx, platform, world, broker, startOn, machine, refusedLogin, ...platform.services };
}

let kioskTxns = 0;
/** Money onto a member's card the real way: a subsidy, added at the school's kiosk. */
function fund(env, school, key, amountSen) {
  const member = school.members[key];
  const order = env.topups.grantSubsidy({ schoolId: school.id, memberId: member.id, amountSen, actor: 'test' });
  const kioskTxn = deviceTxnNo('KIOSK-01', ++kioskTxns);
  env.topups.kioskConfirm({
    schoolId: school.id,
    kioskDeviceId: school.m['KIOSK-01'].id,
    kioskDeviceCode: 'KIOSK-01',
    orderId: order.id,
    result: 'ADDED',
    amountSen,
    cardDigest: member.digest,
    balanceAfterOnCardSen: amountSen,
    kioskTxn,
  });
  // the chip keeps the write, as a kiosk read-back lists it
  const writes = [{ orderId: order.id, amountSen, kioskTxn, at: env.ctx.clock.iso() }];
  return { digest: member.digest, last4: member.uid.slice(-4), cardSeq: 1, balanceSen: amountSen, writes };
}

/** A completed canteen record off a chip (as VirtualCard.debit fills it in). */
function saleRecord(env, card, { origin = 'CANTEEN-01', n, code = 'NASI-LEMAK' }) {
  const amountSen = PRICE[code];
  card.cardSeq += 1;
  const balanceBeforeSen = card.balanceSen;
  card.balanceSen -= amountSen;
  return {
    txn: deviceTxnNo(origin, n), origin, kind: 'SALE', card: card.digest, last4: card.last4, cardSeq: card.cardSeq,
    amountSen, items: [{ code, qty: 1, priceSen: amountSen }], priceVersion: 1, listVersion: 1,
    balanceBeforeSen, balanceAfterSen: card.balanceSen, at: env.ctx.clock.iso(), currency: 'MYR',
  };
}

/** Resolves when the client's connection closes. */
function closed(client) {
  return new Promise((resolve, reject) => {
    if (client.disconnected || !client.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error(`${client.options.clientId} was not disconnected`)), 5000);
    client.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const latest = (inbox, kind) => inbox.filter((m) => m.kind === kind).at(-1);
const balanced = (env, school) => assert.equal(env.ledger.trialBalance(school.id).balanced, true, `books of ${school.code}`);
const platformPublishes = (ctx, since = 0) => ctx.events.since(since).filter((e) => e.type === 'mqtt.publish' && e.data.from === 'platform');

/**
 * The broker's mqtt.publish events of the platform since `since`, once there are at least
 * `count`: aedes answers a QoS 1 PUBLISH with its PUBACK before it routes the message and
 * announces it, so an event can come a moment after the platform's publish has resolved.
 */
async function publishesOf(ctx, count, since = 0, filter = () => true) {
  await waitFor(() => platformPublishes(ctx, since).filter(filter).length >= count, { message: `${count} platform publishes` });
  return platformPublishes(ctx, since).filter(filter);
}

describe('the facade', () => {
  test('builds every service and resolves machine logins for the broker', async (t) => {
    const { platform, world, devices } = await setup(t, { connect: false });
    assert.deepEqual(Object.keys(platform.services).sort(), [
      'configs', 'devices', 'differences', 'intake', 'ledger', 'reconcile', 'schools', 'settlement', 'topups',
    ]);
    assert.ok(Object.isFrozen(platform.services));
    const login = platform.resolveBrokerDevice('smk-alpha.CANTEEN-01');
    assert.deepEqual(login, { schoolCode: 'smk-alpha', deviceCode: 'CANTEEN-01', password: brokerPassword(world.a.m['CANTEEN-01'].secret), active: true });
    for (const bad of ['platform', 'viewer', 'smk-alpha.CANTEEN-99', 'smk-gamma.CANTEEN-01', 'SMK-ALPHA.CANTEEN-01', 'smk-alpha.canteen-01', '', null]) {
      assert.equal(platform.resolveBrokerDevice(bad), null, String(bad));
    }
    devices.setDeviceStatus({ schoolId: world.a.id, code: 'CANTEEN-02', status: 'DISABLED', actor: 'test' });
    assert.equal(platform.resolveBrokerDevice('smk-alpha.CANTEEN-02').active, false);
    platform.services.schools.setSchoolStatus(world.b.id, 'SUSPENDED', 'operator');
    assert.equal(platform.resolveBrokerDevice('smk-beta.CANTEEN-01').active, false);
    assert.deepEqual(platform.mqttStatus(), { connected: false, subscribed: false, url: null });
  });

  test('issueCard issues the card and announces it for the lab', async (t) => {
    const { ctx, platform, world, schools } = await setup(t, { connect: false });
    const member = schools.addMember({ schoolId: world.a.id, memberNo: 'A003', name: 'Cempaka Alpha' });
    const card = platform.issueCard({ schoolId: world.a.id, memberId: member.id, uid: '04 c1 c2 c3 c4 c5 c6', actor: 'staff:office' });
    assert.equal(card.uid, '04C1C2C3C4C5C6');
    assert.equal(card.status, 'ACTIVE');
    assert.deepEqual(eventsOf(ctx, 'card.issued').map((e) => [e.school, e.data]), [['smk-alpha', { uid: '04C1C2C3C4C5C6', memberId: member.id }]]);
    assert.throws(() => platform.issueCard({ schoolId: world.a.id, memberId: member.id, uid: '04D1D2D3D4D5D6' }), labError('MEMBER_HAS_ACTIVE_CARD', 409));
    assert.throws(() => platform.issueCard({ schoolId: 'sch_nope', memberId: member.id, uid: '04D1D2D3D4D5D6' }), labError('SCHOOL_NOT_FOUND', 404));
    assert.equal(eventsOf(ctx, 'card.issued').length, 1);
  });
});

describe('MQTT link', () => {
  test('connectMqtt receives a machine\'s signed sale and posts it', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, settlement, ledger } = env;
    assert.deepEqual(platform.mqttStatus(), { connected: true, subscribed: true, url: env.broker().url });
    const card = fund(env, world.a, 'aina', 2000);
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    const record = saleRecord(env, card, { n: 1 });
    await canteen.send('sale.recorded', { record }, { txn: record.txn });
    await waitFor(() => eventsOf(ctx, 'intake.accepted').length === 1, { message: 'the sale at the platform' });
    const [purchase] = settlement.listPurchases(world.a.id);
    assert.deepEqual([purchase.txn, purchase.via, purchase.status, purchase.amountSen], ['CANTEEN-01-000001', 'MQTT', 'POSTED', PRICE['NASI-LEMAK']]);
    assert.equal(ledger.balance(world.a.id, 'STUDENT_WALLET', world.a.members.aina.id), 2000 - PRICE['NASI-LEMAK']);
    balanced(env, world.a);
    // a heartbeat over status, and a forgery, go the same way
    await canteen.send('device.heartbeat', { fw: '1.0.0-lab', health: 'OK', listVersions: { prices: 1, settings: 1, blocklist: 1 }, journalUnsent: 0 });
    const forged = { ...signEnvelope(world.a.m['CANTEEN-01'].secret, buildEnvelope({ school: 'smk-alpha', device: 'CANTEEN-01', seq: 99, at: ctx.clock.iso(), type: 'device.heartbeat', body: {} })), sig: 'A'.repeat(43) };
    await canteen.client.publishAsync(topicFor('smk-alpha', 'CANTEEN-01', 'status'), JSON.stringify(forged), { qos: 1 });
    await waitFor(() => eventsOf(ctx, 'intake.refused').length === 1, { message: 'the forgery refused' });
    assert.equal(eventsOf(ctx, 'intake.refused')[0].data.code, 'SIGNATURE_INVALID');
    assert.equal(env.devices.getDevice(world.a.id, world.a.m['CANTEEN-01'].id).online, true);
  });

  test('on connect every retained setting goes to every ACTIVE machine of every ACTIVE school', NET, async (t) => {
    const env = await setup(t, { connect: false });
    const { ctx, platform, world } = env;
    env.devices.setDeviceStatus({ schoolId: world.a.id, code: 'CANTEEN-02', status: 'DISABLED', actor: 'test' });
    const gamma = await platform.createTenant({ code: 'smk-gamma', name: 'SMK Gamma (fictional)', devices: [{ code: 'CANTEEN-01', type: 'CANTEEN' }] });
    assert.equal(gamma.published, false, 'not connected yet');
    await platform.setSchoolStatus({ schoolId: gamma.school.id, status: 'SUSPENDED', actor: 'operator' });
    await platform.connectMqtt(env.broker().url);
    const expected = [];
    for (const [school, codes] of [['smk-alpha', ['CANTEEN-01', 'WATER-01', 'KIOSK-01']], ['smk-beta', ['CANTEEN-01', 'KIOSK-01']]]) {
      for (const code of codes) for (const kind of KINDS) expected.push(`lab/v1/${school}/${code}/commands/${kind}`);
    }
    const published = await publishesOf(ctx, expected.length);
    assert.deepEqual(published.map((e) => e.data.topic).sort(), expected.sort());
    assert.ok(published.every((e) => e.data.retained === true));
  });

  test('publishPrices delivers a retained, correctly signed config to a machine that subscribes afterwards', NET, async (t) => {
    const env = await setup(t);
    const { platform, world, configs } = env;
    const content = { items: [{ code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 400 }], water: { perLitreSen: 25, minChargeSen: 5 } };
    const config = await platform.publishPrices({ schoolId: world.a.id, content, actor: 'staff:office' });
    assert.deepEqual([config.kind, config.version, config.published], ['prices', 2, true]);
    assert.deepEqual(config.content, content);
    assert.equal(configs.current(world.a.id, 'prices').version, 2);

    const water = await env.machine(world.a, 'WATER-01');
    await waitFor(() => water.inbox.length === 3, { message: 'the three retained settings' });
    const prices = latest(water.inbox, 'prices');
    assert.equal(prices.topic, 'lab/v1/smk-alpha/WATER-01/commands/prices');
    assert.equal(prices.retain, true);
    const { env: command } = prices;
    assert.equal(validateEnvelopeShape(command).ok, true);
    assert.equal(verifyEnvelopeSignature(world.a.m['WATER-01'].secret, command), true);
    assert.equal(verifyEnvelopeSignature(world.a.m['CANTEEN-01'].secret, command), false, 'signed for this machine only');
    assert.deepEqual([command.type, command.school, command.device], ['config.prices', 'smk-alpha', 'WATER-01']);
    assert.ok(Number.isSafeInteger(command.seq) && command.seq >= 1);
    assert.deepEqual(command.body, { version: 2, effectiveFrom: new Date(config.effectiveFrom).toISOString(), currency: 'MYR', ...content });
    // the other school's machines heard nothing about it
    const beta = await env.machine(world.b, 'CANTEEN-01');
    await waitFor(() => beta.inbox.length === 3, { message: 'beta\'s retained settings' });
    assert.equal(latest(beta.inbox, 'prices').env.body.version, 1);
  });

  test('prices, settings and blocklist are retained side by side and never overwrite each other', NET, async (t) => {
    const env = await setup(t);
    const { platform, world } = env;
    const settings = { ...DEFAULT_SETTINGS, tapGapSeconds: 10, mealWindows: [{ from: '07:00', to: '14:00' }] };
    const result = await platform.publishSettings({ schoolId: world.a.id, content: settings, actor: 'staff:office' });
    assert.deepEqual([result.version, result.published], [2, true]);
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await waitFor(() => canteen.inbox.length === 3, { message: 'one retained message per kind' });
    assert.deepEqual(canteen.inbox.map((m) => m.kind).sort(), KINDS.slice().sort());
    assert.ok(canteen.inbox.every((m) => m.retain));
    assert.deepEqual(
      Object.fromEntries(canteen.inbox.map((m) => [m.kind, [m.env.type, m.env.body.version]])),
      { prices: ['config.prices', 1], settings: ['config.settings', 2], blocklist: ['blocklist.snapshot', 1] },
    );
    const body = latest(canteen.inbox, 'settings').env.body;
    assert.deepEqual({ ...body, effectiveFrom: undefined, version: undefined }, { ...settings, effectiveFrom: undefined, version: undefined });
    assert.deepEqual(latest(canteen.inbox, 'blocklist').env.body, { version: 1, entries: [] });
  });

  test('connectMqtt fails loudly: no broker, or a wrong password', NET, async (t) => {
    const env = await setup(t, { connect: false });
    const { ctx, platform } = env;
    const url = env.broker().url;
    const spare = await env.startOn();
    const deadUrl = spare.url;
    await spare.close();
    await assert.rejects(platform.connectMqtt(deadUrl), labError('BROKER_UNAVAILABLE', 503));
    assert.deepEqual(platform.mqttStatus(), { connected: false, subscribed: false, url: null });
    ctx.settings.platformBrokerPassword = 'cc'.repeat(32);
    await assert.rejects(platform.connectMqtt(url), labError('BROKER_UNAVAILABLE', 503));
    await assert.rejects(platform.connectMqtt(''), labError('BROKER_URL_INVALID', 400));
    ctx.settings.platformBrokerPassword = 'bb'.repeat(32);
    assert.deepEqual(await platform.connectMqtt(url), { url, clientId: PLATFORM_CLIENT_ID });
  });

  test('records sent while the platform\'s link is down wait for it at the broker', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, settlement } = env;
    const card = fund(env, world.a, 'aina', 1000);
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await platform.disconnectMqtt();
    // the broker acknowledges the sale, so the machine counts it as sent
    await canteen.send('sale.recorded', { record: saleRecord(env, card, { n: 1 }) });
    assert.deepEqual(settlement.listPurchases(world.a.id), []);
    await platform.connectMqtt(env.broker().url);
    await waitFor(() => settlement.listPurchases(world.a.id).length === 1, { message: 'the sale kept for the platform' });
    assert.equal(eventsOf(ctx, 'intake.accepted').length, 1);
  });

  test('overlapping connect and disconnect calls take effect in the order they were made', NET, async (t) => {
    const env = await setup(t, { connect: false });
    const { platform } = env;
    const url = env.broker().url;
    const platformSessions = () => env.broker().clients().filter((c) => c.username === 'platform').length;
    const [first, second] = await Promise.all([platform.connectMqtt(url), platform.connectMqtt(url)]);
    assert.deepEqual(first, second);
    await waitFor(() => platformSessions() === 1, { message: 'exactly one platform session' });
    assert.equal(platform.mqttStatus().connected, true);
    // a disconnect made right after a connect wins, and nothing is left running
    const connecting = platform.connectMqtt(url);
    await platform.disconnectMqtt();
    await connecting;
    assert.deepEqual(platform.mqttStatus(), { connected: false, subscribed: false, url: null });
    await waitFor(() => platformSessions() === 0, { message: 'no platform session' });
    await assert.rejects(platform.publishConfig(env.world.a.id, 'prices'), labError('BROKER_UNAVAILABLE', 503));
  });

  test('publishing while disconnected throws BROKER_UNAVAILABLE; actions keep their change and say published: false', NET, async (t) => {
    const env = await setup(t, { connect: false });
    const { platform, world, configs, schools } = env;
    const a = world.a.id;
    await assert.rejects(platform.publishConfig(a, 'prices'), labError('BROKER_UNAVAILABLE', 503));
    await assert.rejects(platform.sendControl(a, 'CANTEEN-01', 'control.heartbeat-now'), labError('BROKER_UNAVAILABLE', 503));
    await assert.rejects(platform.publishBlockListDelta(a, { fromVersion: 1, toVersion: 2, added: [], removed: [] }), labError('BROKER_UNAVAILABLE', 503));

    const prices = await platform.publishPrices({ schoolId: a, content: { ...DEFAULT_PRICES, water: { perLitreSen: 30, minChargeSen: 5 } }, actor: 'office' });
    assert.deepEqual([prices.version, prices.published], [2, false]);
    assert.equal(configs.current(a, 'prices').version, 2, 'the change is kept');
    const lost = await platform.reportCardLost({ schoolId: a, uid: world.a.members.aina.uid, actor: 'office' });
    assert.deepEqual([lost.status, lost.lostListVersion, lost.published], ['LOST', 2, false]);
    const reg = await platform.registerDevice({ schoolId: a, code: 'WATER-02', type: 'WATER', location: 'Hall', actor: 'office' });
    assert.equal(reg.published, false);
    assert.equal(schools.getCardByUid(a, world.a.members.aina.uid).status, 'LOST');

    // connected again: the machines get what was decided meanwhile
    await platform.connectMqtt(env.broker().url);
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await waitFor(() => canteen.inbox.length === 3, { message: 'the retained settings' });
    assert.equal(latest(canteen.inbox, 'prices').env.body.version, 2);
    assert.equal(latest(canteen.inbox, 'blocklist').env.body.version, 2);
    assert.deepEqual(latest(canteen.inbox, 'blocklist').env.body.entries.map((e) => e.card), [world.a.members.aina.digest]);
    // and after disconnecting, publishing fails again instead of queueing
    await platform.disconnectMqtt();
    assert.equal(platform.mqttStatus().connected, false);
    await assert.rejects(platform.publishConfig(a, 'settings'), labError('BROKER_UNAVAILABLE', 503));
  });

  test('after the broker is closed and a new one starts on the same port, connectMqtt again republishes the retained settings', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    const old = env.broker();
    const port = old.port;
    await old.close(); // the retained messages go with it
    const mark = ctx.events.lastSeq();
    const fresh = await env.startOn(port);
    assert.equal(fresh.url, old.url);
    await platform.connectMqtt(fresh.url);
    assert.equal((await publishesOf(ctx, 6 * 3, mark)).length, 6 * 3, 'six ACTIVE machines, three kinds each');
    const kiosk = await env.machine(world.b, 'KIOSK-01');
    await waitFor(() => kiosk.inbox.length === 3, { message: 'the retained settings on the new broker' });
    assert.deepEqual(kiosk.inbox.map((m) => m.kind).sort(), KINDS.slice().sort());
    assert.ok(kiosk.inbox.every((m) => m.retain && verifyEnvelopeSignature(world.b.m['KIOSK-01'].secret, m.env)));
  });

  test('the platform reconnects by itself after a broker restart and republishes', NET, async (t) => {
    const env = await setup(t, { reconnectMs: 50 });
    const { ctx, platform, world } = env;
    const old = env.broker();
    assert.equal(platform.mqttStatus().subscribed, true);
    await old.close();
    await waitFor(() => !platform.mqttStatus().connected, { message: 'the link to drop' });
    // a fresh broker would drop machine records until the platform has subscribed again: the lab can tell
    assert.equal(platform.mqttStatus().subscribed, false);
    const mark = ctx.events.lastSeq();
    await env.startOn(old.port);
    await waitFor(() => platformPublishes(ctx, mark).length === 6 * 3, { timeout: 8000, message: 'the republish after reconnecting' });
    assert.deepEqual(platform.mqttStatus(), { connected: true, subscribed: true, url: old.url });
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await waitFor(() => canteen.inbox.length === 3, { message: 'the retained settings' });
    // and records from machines reach intake again
    const card = fund(env, world.a, 'badrul', 1000);
    await canteen.send('sale.recorded', { record: saleRecord(env, card, { n: 1 }) });
    await waitFor(() => env.settlement.listPurchases(world.a.id).length === 1, { message: 'the sale after the restart' });
  });

  test('a school reactivated after a broker restart gets back the retained settings the restart lost', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    await platform.setSchoolStatus({ schoolId: world.b.id, status: 'SUSPENDED', actor: 'operator' });
    const old = env.broker();
    await old.close();
    const mark = ctx.events.lastSeq();
    await env.startOn(old.port);
    await platform.connectMqtt(env.broker().url);
    // the reconnect republished for the ACTIVE school only (four ACTIVE machines, three kinds each)
    const republished = await publishesOf(ctx, 4 * 3, mark);
    assert.ok(republished.every((e) => e.data.topic.startsWith('lab/v1/smk-alpha/')), 'nothing for the suspended school');
    const back = await platform.setSchoolStatus({ schoolId: world.b.id, status: 'ACTIVE', actor: 'operator' });
    assert.deepEqual([back.status, back.published], ['ACTIVE', true]);
    // the new broker had nothing for it: what its machine finds now was published on reactivation
    const kiosk = await env.machine(world.b, 'KIOSK-01');
    await waitFor(() => kiosk.inbox.length === 3, { message: 'the reactivated school\'s settings' });
    assert.ok(kiosk.inbox.every((m) => m.retain && verifyEnvelopeSignature(world.b.m['KIOSK-01'].secret, m.env)));
  });

  test('a kiosk read-back that reaches the platform after the tap\'s top-up was confirmed opens no false mismatch', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, topups, differences, ledger } = env;
    const aina = world.a.members.aina;
    const card = fund(env, world.a, 'aina', 1000);
    const order = topups.grantSubsidy({ schoolId: world.a.id, memberId: aina.id, amountSen: 700, actor: 'office' });
    const kiosk = await env.machine(world.a, 'KIOSK-01');
    ctx.clock.advance(MINUTE);
    // the platform's link is down for a moment: the broker acknowledges the read-back to the kiosk
    // and keeps it for the platform's session
    await platform.disconnectMqtt();
    await kiosk.send('card.readback', {
      card: card.digest, last4: card.last4, balanceSen: card.balanceSen, cardSeq: card.cardSeq, listVersionOnCard: 1, records: [], writes: card.writes,
    });
    // meanwhile the kiosk writes this tap's RM 7.00 and confirms it over HTTP: the books have it first
    ctx.clock.advance(800);
    topups.kioskPending({ schoolId: world.a.id, kioskDeviceId: world.a.m['KIOSK-01'].id, cardDigest: aina.digest });
    topups.kioskConfirm({
      schoolId: world.a.id, kioskDeviceId: world.a.m['KIOSK-01'].id, kioskDeviceCode: 'KIOSK-01', orderId: order.id, result: 'ADDED',
      amountSen: 700, cardDigest: aina.digest, balanceAfterOnCardSen: 1700, kioskTxn: deviceTxnNo('KIOSK-01', 901),
    });
    await platform.connectMqtt(env.broker().url);
    await waitFor(() => eventsOf(ctx, 'intake.accepted').some((e) => e.data.type === 'card.readback'), { message: 'the read-back' });
    assert.deepEqual(differences.list(world.a.id), [], 'the card was read before the write: no BALANCE_MISMATCH');
    assert.deepEqual(ledger.memberBalances(world.a.id, aina.id), { walletSen: 1700, waitingSen: 0 });
    balanced(env, world.a);
  });
});

describe('commands', () => {
  test('publishConfig: one machine or all ACTIVE ones; nothing to send is not an error', NET, async (t) => {
    const env = await setup(t);
    const { platform, world, devices } = env;
    const one = await platform.publishConfig(world.a.id, 'settings', { deviceCode: 'kiosk-01' });
    assert.deepEqual(one, { kind: 'settings', version: 1, devices: ['KIOSK-01'] });
    devices.setDeviceStatus({ schoolId: world.a.id, code: 'WATER-01', status: 'MAINTENANCE', actor: 'office' });
    assert.deepEqual((await platform.publishConfig(world.a.id, 'blocklist')).devices, ['CANTEEN-01', 'CANTEEN-02', 'KIOSK-01']);
    const empty = await platform.createTenant({ code: 'smk-delta', name: 'SMK Delta (fictional)' });
    assert.deepEqual(await platform.publishConfig(empty.school.id, 'prices'), { kind: 'prices', version: 1, devices: [] });
    await assert.rejects(platform.publishConfig(world.a.id, 'firmware'), labError('CONFIG_INVALID', 400));
    await assert.rejects(platform.publishConfig('sch_nope', 'prices'), labError('SCHOOL_NOT_FOUND', 404));
    await assert.rejects(platform.publishConfig(world.a.id, 'prices', { deviceCode: 'CANTEEN-09' }), labError('DEVICE_NOT_FOUND', 404));
    // another school's machine is not a machine of this school
    await assert.rejects(platform.publishConfig(world.b.id, 'prices', { deviceCode: 'WATER-01' }), labError('DEVICE_NOT_FOUND', 404));
  });

  test('sendControl and publishBlockListDelta reach the machine live, signed, not retained', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await waitFor(() => canteen.inbox.length === 3, { message: 'the retained settings' });
    const sent = await platform.sendControl(world.a.id, 'CANTEEN-01', 'control.upload-journal');
    assert.deepEqual({ ...sent, messageId: 'x' }, { deviceCode: 'CANTEEN-01', type: 'control.upload-journal', messageId: 'x' });
    await platform.sendControl(world.a.id, 'CANTEEN-01', 'heartbeat-now');
    await waitFor(() => canteen.inbox.length === 5, { message: 'two control commands' });
    const controls = canteen.inbox.filter((m) => m.kind === 'control');
    assert.deepEqual(controls.map((m) => m.env.type), ['control.upload-journal', 'control.heartbeat-now']);
    assert.equal(controls[0].env.id, sent.messageId);
    assert.ok(controls.every((m) => verifyEnvelopeSignature(world.a.m['CANTEEN-01'].secret, m.env) && m.env.body && Object.keys(m.env.body).length === 0));
    // each command carries the platform's own, increasing seq for this machine
    const seqs = canteen.inbox.map((m) => m.env.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    assert.equal(new Set(seqs).size, seqs.length);
    await assert.rejects(platform.sendControl(world.a.id, 'CANTEEN-01', 'control.reboot'), labError('CONTROL_INVALID', 400));
    await assert.rejects(platform.sendControl(world.a.id, 'CANTEEN-01', 'config.prices'), labError('CONTROL_INVALID', 400));
    await assert.rejects(platform.sendControl(world.a.id, 'CANTEEN-09', 'heartbeat-now'), labError('DEVICE_NOT_FOUND', 404));

    const delta = { fromVersion: 1, toVersion: 2, added: [{ card: 'a'.repeat(64), last4: 'F6A1' }], removed: [] };
    const out = await platform.publishBlockListDelta(world.a.id, delta);
    assert.deepEqual(out, { fromVersion: 1, toVersion: 2, devices: ['CANTEEN-01', 'CANTEEN-02', 'KIOSK-01', 'WATER-01'] });
    await waitFor(() => latest(canteen.inbox, 'blocklist-delta'), { message: 'the delta' });
    assert.deepEqual(latest(canteen.inbox, 'blocklist-delta').env.body, delta);
    const deltas = await publishesOf(ctx, 4, 0, (e) => e.data.type === 'blocklist.delta');
    assert.ok(deltas.length === 4 && deltas.every((e) => e.data.retained === false));
    assert.deepEqual(await platform.publishBlockListDelta(world.a.id, null), { fromVersion: null, toVersion: null, devices: [] });
    assert.deepEqual((await platform.publishBlockListDelta(world.a.id, { ...delta, toVersion: 1 })).devices, []);
    await assert.rejects(platform.publishBlockListDelta(world.a.id, { fromVersion: 1 }), labError('DELTA_INVALID', 400));
  });
});

describe('cards', () => {
  test('reportCardLost bumps the block-list version, publishes snapshot + delta and stores lostListVersion', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, configs, schools } = env;
    const aina = world.a.members.aina;
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await waitFor(() => canteen.inbox.length === 3, { message: 'the retained settings' });
    const mark = ctx.events.lastSeq();

    const card = await platform.reportCardLost({ schoolId: world.a.id, uid: aina.uid, actor: 'staff:office' });
    assert.deepEqual([card.status, card.lostListVersion, card.published, card.uid], ['LOST', 2, true, aina.uid]);
    assert.equal(schools.getCard(world.a.id, aina.cardId).lostListVersion, 2);
    assert.deepEqual(configs.currentBlockList(world.a.id), { version: 2, entries: [{ card: aina.digest, last4: 'E5F6' }] });

    await waitFor(() => latest(canteen.inbox, 'blocklist').env.body.version === 2 && latest(canteen.inbox, 'blocklist-delta'), { message: 'snapshot and delta' });
    assert.deepEqual(latest(canteen.inbox, 'blocklist').env.body, { version: 2, entries: [{ card: aina.digest, last4: 'E5F6' }] });
    assert.deepEqual(latest(canteen.inbox, 'blocklist-delta').env.body, { fromVersion: 1, toVersion: 2, added: [{ card: aina.digest, last4: 'E5F6' }], removed: [] });
    // the snapshot is kept by the broker, the delta is not
    const sent = await publishesOf(ctx, 2, mark, (e) => e.data.topic.startsWith('lab/v1/smk-alpha/CANTEEN-01/'));
    assert.deepEqual(sent.map((e) => [e.data.type, e.data.retained]), [['blocklist.snapshot', true], ['blocklist.delta', false]]);
    assert.deepEqual(eventsOf(ctx, 'card.lost').map((e) => [e.school, e.data]), [['smk-alpha', { uid: aina.uid, memberId: aina.id, blockListVersion: 2 }]]);
    const actions = schools.listAudit(world.a.id).map((e) => e.action);
    assert.ok(actions.includes('card.lost') && actions.includes('blocklist.block'));
    // a machine coming online later finds the new list, but no delta
    const late = await env.machine(world.a, 'KIOSK-01');
    await waitFor(() => late.inbox.length === 3, { message: 'retained settings' });
    assert.equal(latest(late.inbox, 'blocklist').env.body.version, 2);
    assert.equal(latest(late.inbox, 'blocklist-delta'), undefined);
    // the other school's list is untouched
    assert.deepEqual(configs.currentBlockList(world.b.id), { version: 1, entries: [] });
    await assert.rejects(platform.reportCardLost({ schoolId: world.a.id, uid: aina.uid, actor: 'office' }), labError('CARD_NOT_ACTIVE', 409));
    await assert.rejects(platform.reportCardLost({ schoolId: world.b.id, uid: world.a.members.badrul.uid }), labError('CARD_NOT_FOUND', 404));

    // found again: off the list, published the same way
    const found = await platform.markCardFound({ schoolId: world.a.id, uid: aina.uid, actor: 'staff:office' });
    assert.deepEqual([found.status, found.lostListVersion, found.published], ['ACTIVE', null, true]);
    assert.deepEqual(configs.currentBlockList(world.a.id), { version: 3, entries: [] });
    await waitFor(() => latest(canteen.inbox, 'blocklist').env.body.version === 3, { message: 'the new snapshot' });
    await waitFor(() => latest(canteen.inbox, 'blocklist-delta').env.body.toVersion === 3, { message: 'the new delta' });
    assert.deepEqual(latest(canteen.inbox, 'blocklist-delta').env.body, { fromVersion: 2, toVersion: 3, added: [], removed: [aina.digest] });
    assert.deepEqual(eventsOf(ctx, 'card.found').map((e) => e.data), [{ uid: aina.uid, memberId: aina.id, blockListVersion: 3 }]);
  });

  test('replaceCard moves the mirror balance into a TRANSFER order for the new card', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, ledger, topups, schools } = env;
    const aina = world.a.members.aina;
    fund(env, world.a, 'aina', 1500);
    const out = await platform.replaceCard({ schoolId: world.a.id, memberId: aina.id, newUid: '04F0E0D0C0B0A0', actor: 'staff:office' });
    assert.deepEqual([out.oldCard.uid, out.oldCard.status, out.oldCard.lostListVersion, out.reportedLost], [aina.uid, 'LOST', 2, true]);
    assert.deepEqual([out.newCard.uid, out.newCard.status, out.newCard.memberId], ['04F0E0D0C0B0A0', 'ACTIVE', aina.id]);
    assert.deepEqual(
      [out.transferOrder.kind, out.transferOrder.status, out.transferOrder.amountSen, out.transferOrder.addBy],
      ['TRANSFER', 'PAID', 1500, null],
    );
    assert.equal(out.published, true);
    assert.deepEqual(ledger.memberBalances(world.a.id, aina.id), { walletSen: 0, waitingSen: 1500 });
    balanced(env, world.a);
    assert.equal(schools.activeCardForMember(world.a.id, aina.id).uid, '04F0E0D0C0B0A0');
    assert.deepEqual(env.configs.currentBlockList(world.a.id).entries.map((e) => e.card), [aina.digest]);
    assert.deepEqual(eventsOf(ctx, 'card.lost').map((e) => e.data.uid), [aina.uid]);
    assert.deepEqual(eventsOf(ctx, 'card.issued').map((e) => e.data), [{ uid: '04F0E0D0C0B0A0', memberId: aina.id }]);
    assert.ok(schools.listAudit(world.a.id).some((e) => e.action === 'card.replace' && e.detail.transferOrderId === out.transferOrder.id));

    // the kiosk adds the transfer to the new card: the money is back in the wallet
    const confirmed = topups.kioskConfirm({
      schoolId: world.a.id, kioskDeviceId: world.a.m['KIOSK-01'].id, kioskDeviceCode: 'KIOSK-01', orderId: out.transferOrder.id,
      result: 'ADDED', amountSen: 1500, cardDigest: out.newCard.digest, balanceAfterOnCardSen: 1500, kioskTxn: deviceTxnNo('KIOSK-01', 900),
    });
    assert.equal(confirmed.status, 'ADDED');
    assert.deepEqual(ledger.memberBalances(world.a.id, aina.id), { walletSen: 1500, waitingSen: 0 });
    balanced(env, world.a);

    // a member whose card was already reported lost: no second block, an empty wallet moves nothing
    const badrul = world.a.members.badrul;
    await platform.reportCardLost({ schoolId: world.a.id, uid: badrul.uid, actor: 'office' });
    const again = await platform.replaceCard({ schoolId: world.a.id, memberId: badrul.id, newUid: '04F1E1D1C1B1A1', actor: 'office' });
    assert.deepEqual([again.oldCard.uid, again.reportedLost, again.transferOrder, again.published], [badrul.uid, false, null, true]);
    assert.equal(env.configs.currentBlockList(world.a.id).version, 3);
    await assert.rejects(platform.replaceCard({ schoolId: world.a.id, memberId: 'mem_nope', newUid: '04F2E2D2C2B2A2' }), labError('MEMBER_NOT_FOUND', 404));
    // a taken UID rolls the whole replacement back
    const before = schools.activeCardForMember(world.a.id, badrul.id);
    await assert.rejects(platform.replaceCard({ schoolId: world.a.id, memberId: badrul.id, newUid: aina.uid }), labError('CARD_UID_TAKEN', 409));
    assert.equal(schools.activeCardForMember(world.a.id, badrul.id).id, before.id);
    assert.equal(env.configs.currentBlockList(world.a.id).version, 3);
  });
});

describe('switching machines and schools off', () => {
  test('setDeviceStatus DISABLED kicks the machine, which cannot log in again until switched back on', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    const water = await env.machine(world.a, 'WATER-01');
    const other = await env.machine(world.a, 'CANTEEN-01');
    const gone = closed(water.client);
    const device = await platform.setDeviceStatus({ schoolId: world.a.id, code: 'WATER-01', status: 'DISABLED', actor: 'staff:office' });
    assert.deepEqual([device.status, device.kicked], ['DISABLED', 1]);
    await gone;
    assert.ok(!env.broker().clients().some((c) => c.username === 'smk-alpha.WATER-01'));
    assert.equal(other.client.connected, true);
    assert.equal(await env.refusedLogin(world.a, 'WATER-01'), 5);
    const mark = ctx.events.lastSeq();
    const back = await platform.setDeviceStatus({ schoolId: world.a.id, code: 'WATER-01', status: 'ACTIVE', actor: 'staff:office' });
    assert.deepEqual([back.status, back.kicked, back.published], ['ACTIVE', 0, true]);
    // switched back on, it is sent the settings it may have missed while off, and only it
    const resent = await publishesOf(ctx, 3, mark);
    assert.deepEqual(resent.map((e) => e.data.topic).sort(), KINDS.map((k) => `lab/v1/smk-alpha/WATER-01/commands/${k}`).sort());
    const again = await env.machine(world.a, 'WATER-01');
    await waitFor(() => again.inbox.length === 3, { message: 'its settings' });
    await assert.rejects(platform.setDeviceStatus({ schoolId: world.a.id, code: 'WATER-01', status: 'BROKEN' }), labError('DEVICE_STATUS_INVALID'));
    await assert.rejects(platform.setDeviceStatus({ schoolId: world.b.id, code: 'WATER-01', status: 'DISABLED' }), labError('DEVICE_NOT_FOUND', 404));
  });

  test('setSchoolStatus SUSPENDED kicks every machine of that school and no other school\'s', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, intake } = env;
    const a1 = await env.machine(world.a, 'CANTEEN-01');
    const a2 = await env.machine(world.a, 'KIOSK-01');
    const b1 = await env.machine(world.b, 'CANTEEN-01');
    const b2 = await env.machine(world.b, 'KIOSK-01');
    const gone = Promise.all([closed(a1.client), closed(a2.client)]);
    const school = await platform.setSchoolStatus({ schoolId: world.a.id, status: 'SUSPENDED', actor: 'operator' });
    assert.deepEqual([school.status, school.kicked], ['SUSPENDED', 2]);
    await gone;
    assert.equal(b1.client.connected, true);
    assert.equal(b2.client.connected, true);
    assert.deepEqual(env.broker().clients().map((c) => c.username).filter((u) => u !== 'platform').sort(), ['smk-beta.CANTEEN-01', 'smk-beta.KIOSK-01']);
    assert.deepEqual(eventsOf(ctx, 'school.status').map((e) => [e.school, e.data]), [['smk-alpha', { code: 'smk-alpha', status: 'SUSPENDED', from: 'ACTIVE' }]]);
    assert.equal(await env.refusedLogin(world.a, 'CANTEEN-01'), 5);
    // its uploads are refused at intake too, and the other school's go on
    const m = world.a.m['CANTEEN-01'];
    const hb = signEnvelope(m.secret, buildEnvelope({ school: 'smk-alpha', device: 'CANTEEN-01', seq: ++m.seq, at: ctx.clock.iso(), type: 'device.heartbeat', body: {} }));
    assert.equal(intake.handle(topicFor('smk-alpha', 'CANTEEN-01', 'status'), JSON.stringify(hb)).code, 'SCHOOL_SUSPENDED');
    await b1.send('device.heartbeat', { fw: 'x', health: 'OK', listVersions: {} });
    await waitFor(() => eventsOf(ctx, 'intake.accepted').some((e) => e.school === 'smk-beta'), { message: 'beta\'s heartbeat' });
    // the runJobs and overview see the suspension
    assert.deepEqual(platform.operatorOverview().map((r) => [r.code, r.status]), [['smk-alpha', 'SUSPENDED'], ['smk-beta', 'ACTIVE']]);

    const back = await platform.setSchoolStatus({ schoolId: world.a.id, status: 'ACTIVE', actor: 'operator' });
    assert.deepEqual([back.status, back.published], ['ACTIVE', true]);
    const again = await env.machine(world.a, 'CANTEEN-01');
    await waitFor(() => again.inbox.length === 3, { message: 'its settings' });
    // no change, no event
    await platform.setSchoolStatus({ schoolId: world.a.id, status: 'ACTIVE', actor: 'operator' });
    assert.equal(eventsOf(ctx, 'school.status').length, 2);
    await assert.rejects(platform.setSchoolStatus({ schoolId: world.a.id, status: 'CLOSED' }), labError('SCHOOL_STATUS_INVALID'));
  });
});

describe('onboarding', () => {
  test('registerDevice announces the machine, which then finds its settings waiting', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, devices } = env;
    const out = await platform.registerDevice({ schoolId: world.a.id, code: 'water-02', type: 'WATER', location: 'Block B', actor: 'staff:office' });
    assert.deepEqual([out.device.code, out.device.type, out.device.status, out.published], ['WATER-02', 'WATER', 'ACTIVE', true]);
    assert.match(out.secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(eventsOf(ctx, 'device.registered').map((e) => [e.school, e.data]), [['smk-alpha', { code: 'WATER-02', type: 'WATER', location: 'Block B' }]]);
    assert.ok(!JSON.stringify(ctx.events.since(0)).includes(out.secret), 'the secret never reaches the console');
    world.a.m['WATER-02'] = { id: out.device.id, code: 'WATER-02', type: 'WATER', secret: out.secret, seq: 0 };
    const water2 = await env.machine(world.a, 'WATER-02');
    await waitFor(() => water2.inbox.length === 3, { message: 'its settings' });
    assert.ok(water2.inbox.every((m) => verifyEnvelopeSignature(out.secret, m.env)));
    assert.equal(devices.listDevices(world.a.id).length, 5);
    await assert.rejects(platform.registerDevice({ schoolId: world.a.id, code: 'WATER-02', type: 'WATER' }), labError('DEVICE_CODE_TAKEN', 409));
  });

  test('createTenant creates a working third school whose machine logs in and finds its settings', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, schools, configs, devices, settlement, ledger } = env;
    const out = await platform.createTenant({
      code: 'sk-ketiga',
      name: 'SK Ketiga (fictional)',
      staff: [{ name: 'Puan Contoh', role: 'ADMIN' }, { name: 'Encik Teladan', role: 'FINANCE' }],
      devices: [{ code: 'CANTEEN-01', type: 'CANTEEN', location: 'Kantin' }, { code: 'KIOSK-01', type: 'KIOSK' }],
      demoMembers: 3,
      actor: 'operator',
    });
    const id = out.school.id;
    assert.deepEqual([out.school.code, out.school.name, out.school.status, out.published], ['sk-ketiga', 'SK Ketiga (fictional)', 'ACTIVE', true]);
    assert.deepEqual(out.staff.map((s) => [s.name, s.role, s.schoolId]), [['Puan Contoh', 'ADMIN', id], ['Encik Teladan', 'FINANCE', id]]);
    assert.deepEqual(out.devices.map((d) => [d.device.code, d.device.type, d.device.location]), [['CANTEEN-01', 'CANTEEN', 'Kantin'], ['KIOSK-01', 'KIOSK', '']]);
    assert.ok(out.devices.every((d) => /^[0-9a-f]{64}$/.test(d.secret)));
    assert.equal(out.members.length, 3);
    for (const member of out.members) {
      assert.match(member.card.uid, /^04[0-9A-F]{12}$/);
      assert.equal(member.card.status, 'ACTIVE');
      assert.match(member.memberNo, /^D\d{3}$/);
      assert.match(member.name, /^[A-Za-z ]+ (Contoh|Teladan|Sampel|Ujian)$/);
    }
    assert.equal(new Set(out.members.map((m) => m.card.uid)).size, 3);
    assert.deepEqual(KINDS.map((k) => configs.current(id, k).version), [1, 1, 1]);
    assert.deepEqual(configs.current(id, 'prices').content, DEFAULT_PRICES);
    assert.deepEqual(configs.currentBlockList(id), { version: 1, entries: [] });
    assert.deepEqual(eventsOf(ctx, 'device.registered').map((e) => [e.school, e.data.code]), [['sk-ketiga', 'CANTEEN-01'], ['sk-ketiga', 'KIOSK-01']]);
    assert.equal(eventsOf(ctx, 'card.issued').filter((e) => e.school === 'sk-ketiga').length, 3);
    assert.deepEqual(eventsOf(ctx, 'tenant.created').map((e) => [e.school, e.data]), [['sk-ketiga', { code: 'sk-ketiga', name: 'SK Ketiga (fictional)' }]]);
    assert.ok(schools.listAudit(id).some((e) => e.action === 'tenant.create' && e.actor === 'operator'));

    // its machine logs in with its own secret and finds its school's settings
    const third = { id, code: 'sk-ketiga', m: {}, members: {} };
    for (const d of out.devices) third.m[d.device.code] = { id: d.device.id, code: d.device.code, type: d.device.type, secret: d.secret, seq: 0 };
    out.members.forEach((m, i) => {
      third.members[`m${i}`] = { id: m.id, uid: m.card.uid, digest: schools.cardDigestFor(id, m.card.uid) };
    });
    const canteen = await env.machine(third, 'CANTEEN-01');
    await waitFor(() => canteen.inbox.length === 3, { message: 'the new school\'s settings' });
    assert.ok(canteen.inbox.every((m) => m.env.school === 'sk-ketiga' && verifyEnvelopeSignature(third.m['CANTEEN-01'].secret, m.env)));
    // and it sells: a demo member with money from the school's kiosk buys lunch
    const card = fund(env, third, 'm0', 1000);
    await canteen.send('sale.recorded', { record: saleRecord(env, card, { n: 1 }) });
    await waitFor(() => settlement.listPurchases(id).length === 1, { message: 'the sale in the new school' });
    assert.equal(settlement.listPurchases(id)[0].status, 'POSTED');
    assert.equal(ledger.balance(id, 'STUDENT_WALLET', third.members.m0.id), 1000 - PRICE['NASI-LEMAK']);
    balanced(env, third);
    assert.deepEqual(settlement.listPurchases(world.a.id), []);
    assert.equal(devices.listDevices(id).length, 2);
    assert.deepEqual(platform.operatorOverview().map((r) => r.code), ['smk-alpha', 'smk-beta', 'sk-ketiga']);
  });

  test('createTenant is all or nothing, and checks what it is given', NET, async (t) => {
    const env = await setup(t, { connect: false });
    const { platform, schools } = env;
    const bad = [
      [{ code: 'smk-alpha', name: 'Again' }, 'SCHOOL_CODE_TAKEN'],
      [{ code: 'Bad Code', name: 'X' }, 'SCHOOL_CODE_INVALID'],
      [{ code: 'sk-empat', name: 'SK Empat', staff: 'everyone' }, 'TENANT_INVALID'],
      [{ code: 'sk-empat', name: 'SK Empat', devices: {} }, 'TENANT_INVALID'],
      [{ code: 'sk-empat', name: 'SK Empat', demoMembers: 1.5 }, 'TENANT_INVALID'],
      [{ code: 'sk-empat', name: 'SK Empat', demoMembers: 201 }, 'TENANT_INVALID'],
      [{ code: 'sk-empat', name: 'SK Empat', staff: [{ name: 'Cik Sampel', role: 'JANITOR' }] }, 'STAFF_ROLE_INVALID'],
      [{ code: 'sk-empat', name: 'SK Empat', devices: [{ code: 'CANTEEN-01', type: 'CANTEEN' }, { code: 'canteen-01', type: 'CANTEEN' }] }, 'DEVICE_CODE_TAKEN'],
    ];
    for (const [args, code] of bad) await assert.rejects(platform.createTenant({ ...args, actor: 'operator' }), labError(code), code);
    assert.equal(schools.getSchoolByCode('sk-empat'), null, 'nothing of a failed onboarding is left');
    assert.deepEqual(eventsOf(env.ctx, 'tenant.created'), []);
    assert.deepEqual(eventsOf(env.ctx, 'device.registered'), []);
    const ok = await platform.createTenant({ code: 'sk-empat', name: 'SK Empat (fictional)', staff: null, devices: null });
    assert.deepEqual([ok.staff, ok.devices, ok.members, ok.published], [[], [], [], true]);
  });
});

describe('operator view and jobs', () => {
  test('operatorOverview: one row per school with its own numbers', NET, async (t) => {
    const env = await setup(t);
    const { platform, world, topups } = env;
    const card = fund(env, world.a, 'aina', 2000);
    topups.grantSubsidy({ schoolId: world.a.id, memberId: world.a.members.badrul.id, amountSen: 700, actor: 'office' });
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await canteen.send('device.heartbeat', { fw: 'x', health: 'OK', listVersions: {} });
    await canteen.send('sale.recorded', { record: saleRecord(env, card, { n: 1 }) });
    const stranger = { digest: env.schools.cardDigestFor(world.a.id, '04ABABABABABAB'), last4: 'ABAB', cardSeq: 0, balanceSen: 500 };
    await canteen.send('sale.recorded', { record: saleRecord(env, stranger, { n: 2 }) });
    await waitFor(() => env.settlement.listPurchases(world.a.id).length === 2, { message: 'both sales' });
    const rows = platform.operatorOverview();
    assert.deepEqual(rows.map((r) => Object.keys(r).sort()), rows.map(() => [
      'cards', 'code', 'createdAt', 'devices', 'id', 'members', 'name', 'openDifferences', 'status', 'todaySalesSen', 'waitingSen',
    ]));
    const [alpha, beta] = rows;
    assert.deepEqual(
      { ...alpha, id: undefined, createdAt: undefined },
      {
        id: undefined, createdAt: undefined, code: 'smk-alpha', name: 'SMK Alpha (fictional)', status: 'ACTIVE', members: 2, cards: 2,
        devices: { total: 4, online: 1 }, todaySalesSen: PRICE['NASI-LEMAK'], waitingSen: 700, openDifferences: 1,
      },
    );
    assert.deepEqual(
      [beta.code, beta.members, beta.cards, beta.devices, beta.todaySalesSen, beta.waitingSen, beta.openDifferences],
      ['smk-beta', 1, 1, { total: 2, online: 0 }, 0, 0, 0],
    );
  });

  test('runJobs runs top-up deadlines and reconciliation per ACTIVE school, and a failing job does not stop the rest', async (t) => {
    const env = await setup(t, { connect: false });
    const { ctx, platform, world, schools, topups, settlement, reconcile } = env;
    // a parent's unpaid top-up in each school
    const orderIn = (school, key, n) => {
      const parent = schools.registerParent({ email: `parent${n}@example.com`, name: `Parent ${n} (fictional)` });
      const invite = schools.createInvite({ schoolId: school.id, memberId: school.members[key].id, actor: 'office' });
      const link = schools.redeemInvite({ parentId: parent.id, code: invite.code });
      schools.decideLink({ schoolId: school.id, linkId: link.id, approve: true, actor: 'office' });
      return topups.createOrder({ parentId: parent.id, schoolId: school.id, memberId: school.members[key].id, amountSen: 1000, idemKey: `k${n}` });
    };
    const orderA = orderIn(world.a, 'aina', 1);
    const orderB = orderIn(world.b, 'chong', 2);
    // a gap in A's canteen numbers: 1 and 3 arrived, 2 never did
    const card = fund(env, world.a, 'badrul', 2000);
    for (const n of [1, 3]) {
      settlement.receive({ schoolId: world.a.id, uploaderDeviceId: world.a.m['CANTEEN-01'].id, via: 'MQTT', record: saleRecord(env, card, { n }) });
    }
    await platform.setSchoolStatus({ schoolId: world.b.id, status: 'SUSPENDED', actor: 'operator' });
    ctx.clock.advance(31 * MINUTE);

    const out = platform.runJobs();
    assert.deepEqual(out, {
      cancelled: 1, refunded: 0, parked: 0, gaps: 1, lag: 0,
      schools: [{ schoolId: world.a.id, code: 'smk-alpha', cancelled: 1, refunded: 0, parked: 0, gaps: 1, lag: 0 }],
    });
    assert.equal(topups.getOrder(world.a.id, orderA.id).status, 'CANCELLED');
    assert.equal(topups.getOrder(world.b.id, orderB.id).status, 'CREATED', 'a suspended school\'s orders wait');

    // one school's failing job is reported, and the others still run
    await platform.setSchoolStatus({ schoolId: world.b.id, status: 'ACTIVE', actor: 'operator' });
    const run = reconcile.run;
    reconcile.run = (schoolId) => {
      if (schoolId === world.a.id) throw new Error('scan failed');
      return run(schoolId);
    };
    t.after(() => {
      reconcile.run = run;
    });
    const logs = [];
    ctx.log = (level, message, meta) => logs.push({ level, message, meta });
    const second = platform.runJobs();
    assert.deepEqual(second.schools.map((r) => [r.code, r.cancelled, r.errors?.map((e) => [e.job, e.message])]), [
      ['smk-alpha', 0, [['reconcile', 'scan failed']]],
      ['smk-beta', 1, undefined],
    ]);
    assert.equal(topups.getOrder(world.b.id, orderB.id).status, 'CANCELLED');
    assert.ok(logs.some((l) => l.level === 'error' && l.meta.error === 'scan failed'));
    // only one school, when asked
    assert.deepEqual(platform.runJobs({ schoolId: world.b.id }).schools.map((r) => r.code), ['smk-beta']);
  });

  test('runJobs refunds money never added, parks unconfirmed writes, once, and every school\'s books stay balanced', async (t) => {
    const env = await setup(t, { connect: false });
    const { ctx, platform, world, topups, ledger } = env;
    const { aina, badrul } = world.a.members;
    const forAina = topups.grantSubsidy({ schoolId: world.a.id, memberId: aina.id, amountSen: 800, actor: 'office' });
    const forChong = topups.grantSubsidy({ schoolId: world.b.id, memberId: world.b.members.chong.id, amountSen: 600, actor: 'office' });
    // offered to the kiosk but never confirmed: it may be on the card, so it is parked, not refunded
    const forBadrul = topups.grantSubsidy({ schoolId: world.a.id, memberId: badrul.id, amountSen: 300, actor: 'office' });
    topups.kioskPending({ schoolId: world.a.id, kioskDeviceId: world.a.m['KIOSK-01'].id, cardDigest: badrul.digest });
    await platform.setSchoolStatus({ schoolId: world.b.id, status: 'SUSPENDED', actor: 'operator' });
    ctx.clock.advance(15 * DAY); // the add window is 14 days

    const out = platform.runJobs();
    assert.deepEqual([out.refunded, out.parked, out.schools.map((r) => r.code)], [1, 1, ['smk-alpha']]);
    assert.deepEqual(
      [topups.getOrder(world.a.id, forAina.id).status, topups.getOrder(world.a.id, forBadrul.id).status, topups.getOrder(world.b.id, forChong.id).status],
      ['REFUNDED', 'PARKED', 'PAID'],
    );
    assert.deepEqual(ledger.memberBalances(world.a.id, aina.id), { walletSen: 0, waitingSen: 0 });
    assert.deepEqual(ledger.memberBalances(world.a.id, badrul.id), { walletSen: 0, waitingSen: 300 });
    balanced(env, world.a);
    balanced(env, world.b);
    // reactivated, the other school's deadline is applied too; nothing is refunded twice
    await platform.setSchoolStatus({ schoolId: world.b.id, status: 'ACTIVE', actor: 'operator' });
    assert.equal(platform.runJobs().refunded, 1);
    assert.equal(topups.getOrder(world.b.id, forChong.id).status, 'REFUNDED');
    const again = platform.runJobs();
    assert.deepEqual([again.cancelled, again.refunded, again.parked], [0, 0, 0]);
    assert.equal(ledger.postings(world.a.id, { limit: 100 }).filter((p) => p.reversalOf).length, 1);
    balanced(env, world.a);
    balanced(env, world.b);
  });
});

describe('tenant isolation', () => {
  test('a machine of school A can never affect school B: refused at the broker and at intake', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world, intake, settlement, ledger } = env;
    const cardB = fund(env, world.b, 'chong', 1000);
    const record = saleRecord(env, cardB, { n: 1 });
    // at the broker: A's reader publishing on B's same-code reader topic is cut off (QoS 0,
    // so mqtt.js has nothing to resend); B's own reader then gets through on its own
    const intruder = await env.machine(world.a, 'CANTEEN-01');
    const m = world.a.m['CANTEEN-01'];
    const claim = signEnvelope(m.secret, buildEnvelope({ school: 'smk-beta', device: 'CANTEEN-01', seq: ++m.seq, at: ctx.clock.iso(), type: 'sale.recorded', body: { record } }));
    const cutOff = closed(intruder.client);
    intruder.client.publish(topicFor('smk-beta', 'CANTEEN-01', 'records'), JSON.stringify(claim), { qos: 0 });
    await cutOff;
    await waitFor(() => eventsOf(ctx, 'mqtt.denied').length === 1, { message: 'the refusal at the broker' });
    assert.deepEqual(eventsOf(ctx, 'mqtt.denied')[0].data, { username: 'smk-alpha.CANTEEN-01', action: 'publish', topic: 'lab/v1/smk-beta/CANTEEN-01/records', msgId: claim.id });
    // nor may it listen to B's commands
    const listener = await env.machine(world.a, 'KIOSK-01', { subscribe: false });
    await assert.rejects(listener.client.subscribeAsync('lab/v1/smk-beta/KIOSK-01/commands/#', { qos: 1 }));
    const witness = await env.machine(world.b, 'CANTEEN-01');
    await witness.send('device.heartbeat', { fw: 'x', health: 'OK', listVersions: {} });
    await waitFor(() => eventsOf(ctx, 'intake.accepted').length === 1, { message: 'the witness heartbeat' });
    assert.deepEqual(eventsOf(ctx, 'intake.accepted').map((e) => [e.school, e.data.device]), [['smk-beta', 'CANTEEN-01']]);
    assert.deepEqual(eventsOf(ctx, 'intake.refused'), [], 'the forged message never reached the platform');

    // at intake (had it got through): it cannot sign as B's machine, and its own envelope does not match B's topic
    assert.equal(intake.handle(topicFor('smk-beta', 'CANTEEN-01', 'records'), JSON.stringify(claim)).code, 'SIGNATURE_INVALID');
    const own = signEnvelope(m.secret, buildEnvelope({ school: 'smk-alpha', device: 'CANTEEN-01', seq: ++m.seq, at: ctx.clock.iso(), type: 'sale.recorded', body: { record } }));
    assert.equal(intake.handle(topicFor('smk-beta', 'CANTEEN-01', 'records'), JSON.stringify(own)).code, 'TOPIC_MISMATCH');
    assert.deepEqual(settlement.listPurchases(world.b.id), []);
    assert.deepEqual(ledger.memberBalances(world.b.id, world.b.members.chong.id), { walletSen: 1000, waitingSen: 0 });
    // and through its own topic, B's card is a card A does not know
    assert.equal(intake.handle(topicFor('smk-alpha', 'CANTEEN-01', 'records'), JSON.stringify(own)).detail.results[0].status, 'FLAGGED');
    assert.deepEqual(settlement.listPurchases(world.b.id), []);
    balanced(env, world.a);
    balanced(env, world.b);
    // suspending A, or anything A's office does, leaves B's machines alone
    await platform.setSchoolStatus({ schoolId: world.a.id, status: 'SUSPENDED', actor: 'operator' });
    await platform.publishPrices({ schoolId: world.a.id, content: { ...DEFAULT_PRICES, water: { perLitreSen: 99, minChargeSen: 1 } }, actor: 'office' });
    assert.equal(witness.client.connected, true);
    await waitFor(() => witness.inbox.length === 3, { message: 'B\'s retained settings' });
    assert.ok(witness.inbox.every((msg) => msg.env.school === 'smk-beta' && msg.env.body.version === 1));
  });
});
