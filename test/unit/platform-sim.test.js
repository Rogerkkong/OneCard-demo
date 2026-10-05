import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';
import { startBroker } from '../../src/broker/broker.js';
import { createPlatform } from '../../src/platform/platform.js';
import { DEFAULT_PRICES, DEFAULT_SETTINGS } from '../../src/platform/configs.js';
import { brokerPassword, signEnvelope } from '../../src/shared/crypto.js';
import { buildEnvelope, topicFor, UP_TYPES } from '../../src/shared/protocol.js';

// Simulation mode on the platform (docs/DESIGN.md §11.2, §11.4): commands announced as
// platform.send in the sender's context, an MQTT client that never carries a trace it was not
// given, and the inbox gate that holds a machine's messages at the platform's door. Machines
// are plain MQTT clients; every school, machine and secret is fictional and made per test.

const NET = { timeout: 20_000 };
const KINDS = ['prices', 'settings', 'blocklist'];
const TRACE = 'tr_simtest0001';

/** Two schools with a few machines each, prices, settings and a block list (services only). */
function seed(platform) {
  const { schools, devices, configs } = platform.services;
  const school = (code, name, machines) => {
    const s = schools.createSchool({ code, name });
    const m = {};
    for (const [deviceCode, type] of machines) {
      const { device, secret } = devices.registerDevice({ schoolId: s.id, code: deviceCode, type, actor: 'seed' });
      m[deviceCode] = { id: device.id, code: deviceCode, type, secret, seq: 0 };
    }
    configs.publish({ schoolId: s.id, kind: 'prices', content: DEFAULT_PRICES, actor: 'seed' });
    configs.publish({ schoolId: s.id, kind: 'settings', content: DEFAULT_SETTINGS, actor: 'seed' });
    configs.ensureBlockList({ schoolId: s.id, actor: 'seed' });
    return { id: s.id, code, m };
  };
  return {
    a: school('smk-alpha', 'SMK Alpha (fictional)', [['CANTEEN-01', 'CANTEEN'], ['CANTEEN-02', 'CANTEEN'], ['KIOSK-01', 'KIOSK']]),
    b: school('smk-beta', 'SMK Beta (fictional)', [['CANTEEN-01', 'CANTEEN']]),
  };
}
const MACHINES = 4; // ACTIVE machines of both schools: each gets every retained kind on (re)connect

/** A platform, its seed and a broker on a random port; everything is closed when the test ends. */
async function setup(t, { connect = true, reconnectMs } = {}) {
  const ctx = createTestCtx();
  const logs = [];
  ctx.log = (level, message, meta) => logs.push({ level, message, meta });
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
    platform.setInboxGate(null);
    await Promise.all(clients.map((c) => c.endAsync(true).catch(() => {})));
    await platform.disconnectMqtt();
    for (const b of brokers) await b.close();
    ctx.db.close();
  });
  if (connect) await platform.connectMqtt(broker().url, reconnectMs ? { reconnectMs } : {});

  /** A machine as a raw MQTT client, collecting its commands; send() signs like a machine. */
  async function machine(school, code, { subscribe = true } = {}) {
    const m = school.m[code];
    const username = `${school.code}.${code}`;
    const client = await mqtt.connectAsync(broker().url, {
      username, clientId: username, password: brokerPassword(m.secret), reconnectPeriod: 0, connectTimeout: 3000,
    }, false);
    clients.push(client);
    client.on('error', () => {});
    const inbox = [];
    client.on('message', (topic, payload) => inbox.push({ topic, env: JSON.parse(payload.toString()) }));
    if (subscribe) await client.subscribeAsync(`${topicFor(school.code, code, 'commands')}/#`, { qos: 1 });
    return {
      client,
      inbox,
      async send(type, body) {
        const env = signEnvelope(m.secret, buildEnvelope({ school: school.code, device: code, seq: ++m.seq, at: ctx.clock.iso(), type, body }));
        await client.publishAsync(topicFor(school.code, code, UP_TYPES[type]), JSON.stringify(env), { qos: 1 });
        return env;
      },
      /** Publish raw bytes on its own topic. */
      async raw(channel, payload) {
        await client.publishAsync(topicFor(school.code, code, channel), payload, { qos: 1 });
      },
    };
  }

  return { ctx, logs, platform, world, broker, startOn, machine, ...platform.services };
}

const heartbeat = { fw: '1.0.0-lab', health: 'OK', listVersions: { prices: 1, settings: 1, blocklist: 1 }, journalUnsent: 0 };
const sends = (ctx, since = 0) => ctx.events.since(since).filter((e) => e.type === 'platform.send');
/** The intake event (accepted, duplicate or refused) of a message, if it was handled. */
const intakeOf = (ctx, msgId) => ctx.events.since(0).find((e) => e.type.startsWith('intake.') && e.data.msgId === msgId);
const handledInOrder = (ctx, msgIds) =>
  ctx.events.since(0).filter((e) => e.type.startsWith('intake.') && msgIds.includes(e.data.msgId)).map((e) => e.data.msgId);

/** A gate that holds what `holds(info)` says, with each hold's release kept for the test. */
function holdingGate(holds) {
  const asked = [];
  const held = new Map(); // msgId -> { release, reject }
  const gate = (info) => {
    asked.push(info);
    if (!holds(info)) return undefined;
    return new Promise((resolve, reject) => held.set(info.msgId, { release: resolve, reject }));
  };
  return { gate, asked, held };
}

describe('platform.send', () => {
  test('announces each command just before it is published, with its id, in the sender\'s context', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    await waitFor(() => canteen.inbox.length === 3, { message: 'the retained settings' });
    const mark = ctx.events.lastSeq();

    const content = { items: [{ code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 400 }], water: { perLitreSen: 25, minChargeSen: 5 } };
    const result = await ctx.events.withContext({ trace: TRACE }, () => platform.publishPrices({ schoolId: world.a.id, content, actor: 'office' }));
    assert.equal(result.published, true);
    const announced = sends(ctx, mark);
    assert.deepEqual(announced.map((e) => [e.school, e.data.device, e.data.type, e.data.retained, e.data.topic]), [
      ['smk-alpha', 'CANTEEN-01', 'config.prices', true, 'lab/v1/smk-alpha/CANTEEN-01/commands/prices'],
      ['smk-alpha', 'CANTEEN-02', 'config.prices', true, 'lab/v1/smk-alpha/CANTEEN-02/commands/prices'],
      ['smk-alpha', 'KIOSK-01', 'config.prices', true, 'lab/v1/smk-alpha/KIOSK-01/commands/prices'],
    ]);
    assert.ok(announced.every((e) => Object.keys(e.data).sort().join() === 'device,msgId,retained,topic,type'));
    assert.ok(announced.every((e) => e.trace === TRACE), 'in the caller\'s trace');
    // the id is the command's envelope id: the machine receives exactly that message
    await waitFor(() => canteen.inbox.length === 4, { message: 'the new prices' });
    const [toCanteen] = announced;
    assert.equal(canteen.inbox.at(-1).env.id, toCanteen.data.msgId);
    // and the broker's event about it names the same id, after the announcement
    const published = await waitFor(() => eventsOf(ctx, 'mqtt.publish').find((e) => e.data.msgId === toCanteen.data.msgId));
    assert.ok(published.seq > toCanteen.seq);
    assert.equal('trace' in published, false, 'the broker knows no trace: the lab links it by msgId');

    // live commands are not retained; outside any flow they carry no trace
    const control = await platform.sendControl(world.a.id, 'CANTEEN-01', 'heartbeat-now');
    const [controlSend] = sends(ctx, published.seq).filter((e) => e.data.type === 'control.heartbeat-now');
    assert.deepEqual(controlSend.data, {
      msgId: control.messageId, topic: 'lab/v1/smk-alpha/CANTEEN-01/commands/control', type: 'control.heartbeat-now', device: 'CANTEEN-01', retained: false,
    });
    assert.equal('trace' in controlSend, false);
    const mark2 = ctx.events.lastSeq();
    await platform.publishBlockListDelta(world.b.id, { fromVersion: 1, toVersion: 2, added: [{ card: 'a'.repeat(64), last4: 'F6A1' }], removed: [] });
    assert.deepEqual(sends(ctx, mark2).map((e) => [e.school, e.data.device, e.data.type, e.data.retained]), [['smk-beta', 'CANTEEN-01', 'blocklist.delta', false]]);
  });

  test('nothing is announced when nothing can be sent', NET, async (t) => {
    const env = await setup(t, { connect: false });
    const { ctx, platform, world } = env;
    await assert.rejects(platform.publishConfig(world.a.id, 'prices'), (err) => err.code === 'BROKER_UNAVAILABLE');
    await assert.rejects(platform.sendControl(world.a.id, 'CANTEEN-01', 'heartbeat-now'), (err) => err.code === 'BROKER_UNAVAILABLE');
    assert.deepEqual(sends(ctx), []);
  });
});

describe('the platform\'s MQTT client', () => {
  test('its first republish belongs to the connectMqtt caller; messages and automatic reconnects carry no trace', NET, async (t) => {
    const env = await setup(t, { connect: false, reconnectMs: 50 });
    const { ctx, platform, world } = env;
    await ctx.events.withContext({ trace: TRACE }, () => platform.connectMqtt(env.broker().url));
    const first = sends(ctx);
    assert.equal(first.length, MACHINES * KINDS.length);
    assert.ok(first.every((e) => e.trace === TRACE), 'the first subscribe and republish are part of the caller\'s flow');

    // a message the platform receives later is no part of that flow
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    const hb = await canteen.send('device.heartbeat', heartbeat);
    const accepted = await waitFor(() => intakeOf(ctx, hb.id), { message: 'the heartbeat at the platform' });
    assert.equal(accepted.type, 'intake.accepted');
    assert.equal('trace' in accepted, false);
    assert.equal(accepted.msgId, hb.id);

    // the broker restarts: the client reconnects by itself, untraced
    const old = env.broker();
    await old.close();
    await waitFor(() => !platform.mqttStatus().connected, { message: 'the link to drop' });
    const mark = ctx.events.lastSeq();
    await env.startOn(old.port);
    await waitFor(() => sends(ctx, mark).length === MACHINES * KINDS.length, { timeout: 8000, message: 'the republish after reconnecting' });
    assert.ok(sends(ctx, mark).every((e) => !('trace' in e)), 'an automatic reconnect belongs to no flow');
  });

  test('connectMqtt outside any flow republishes untraced', NET, async (t) => {
    const { ctx } = await setup(t);
    assert.equal(sends(ctx).length, MACHINES * KINDS.length);
    assert.ok(sends(ctx).every((e) => !('trace' in e)));
  });
});

describe('the inbox gate', () => {
  test('holds one machine\'s messages, in order, while other machines go on; release lets them through', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    const alpha1 = await env.machine(world.a, 'CANTEEN-01');
    const kiosk = await env.machine(world.a, 'KIOSK-01');
    const beta1 = await env.machine(world.b, 'CANTEEN-01'); // the same machine code in another school
    const { gate, asked, held } = holdingGate((info) => info.school === 'smk-alpha' && info.device === 'CANTEEN-01' && info.type === 'device.heartbeat');
    platform.setInboxGate(gate);
    assert.equal(platform.inboxWaiting(), 0);

    const h1 = await alpha1.send('device.heartbeat', heartbeat); // held
    await waitFor(() => held.has(h1.id), { message: 'the gate to hold the heartbeat' });
    const s1 = await alpha1.send('command.ack', { command: 'cmd-00000001', kind: 'prices', result: 'APPLIED', appliedVersion: 1 }); // not held, but behind h1
    const k1 = await kiosk.send('device.heartbeat', heartbeat);
    const b1 = await beta1.send('device.heartbeat', heartbeat);
    await waitFor(() => intakeOf(ctx, k1.id) && intakeOf(ctx, b1.id), { message: 'the other machines\' messages' });
    await waitFor(() => asked.some((i) => i.msgId === s1.id), { message: 'the gate asked about the ack' });
    assert.equal(intakeOf(ctx, h1.id), undefined, 'held');
    assert.equal(intakeOf(ctx, s1.id), undefined, 'waits behind the held one of its machine');
    assert.equal(platform.inboxWaiting(), 2);
    assert.deepEqual(asked.find((i) => i.msgId === h1.id), {
      topic: 'lab/v1/smk-alpha/CANTEEN-01/status', school: 'smk-alpha', device: 'CANTEEN-01', type: 'device.heartbeat', msgId: h1.id,
    });

    // a second hold of the same machine, released first: still nothing goes before h1
    const h2 = await alpha1.send('device.heartbeat', heartbeat);
    await waitFor(() => held.has(h2.id), { message: 'the second hold' });
    held.get(h2.id).release();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(handledInOrder(ctx, [h1.id, s1.id, h2.id]), []);
    assert.equal(platform.inboxWaiting(), 3);

    held.get(h1.id).release();
    await waitFor(() => platform.inboxWaiting() === 0, { message: 'the inbox to empty' });
    assert.deepEqual(handledInOrder(ctx, [h1.id, s1.id, h2.id]), [h1.id, s1.id, h2.id], 'in arrival order');
    assert.ok([h1, s1, h2].every((m) => intakeOf(ctx, m.id).type === 'intake.accepted'));
    // processed after the release, still under its own message id and no trace
    assert.equal(intakeOf(ctx, h1.id).msgId, h1.id);
    assert.equal('trace' in intakeOf(ctx, h1.id), false);
    assert.equal(env.devices.getDevice(world.a.id, world.a.m['CANTEEN-01'].id).lastSeq, 3);
  });

  test('a gate that lets a message through changes nothing: it is processed at once, synchronously', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    const canteen = await env.machine(world.a, 'CANTEEN-02');
    const seenRightAfter = [];
    platform.setInboxGate((info) => {
      // a microtask queued now runs after the message is processed only if that happens in this same tick
      queueMicrotask(() => seenRightAfter.push(Boolean(intakeOf(ctx, info.msgId))));
      return undefined;
    });
    const hb = await canteen.send('device.heartbeat', heartbeat);
    await waitFor(() => seenRightAfter.length === 1, { message: 'the gate to be asked' });
    assert.deepEqual(seenRightAfter, [true]);
    assert.equal(intakeOf(ctx, hb.id).type, 'intake.accepted');
    assert.equal(platform.inboxWaiting(), 0);
    // a payload that is no envelope: the gate sees nulls, and intake refuses it as always
    const asked = [];
    platform.setInboxGate((info) => {
      asked.push(info);
    });
    await canteen.raw('records', 'not json at all');
    await waitFor(() => eventsOf(ctx, 'intake.refused').length === 1, { message: 'the refusal' });
    assert.deepEqual(asked, [{ topic: 'lab/v1/smk-alpha/CANTEEN-02/records', school: 'smk-alpha', device: 'CANTEEN-02', type: null, msgId: null }]);
    assert.equal(eventsOf(ctx, 'intake.refused')[0].data.code, 'ENVELOPE_INVALID');
  });

  test('a gate that throws, or a hold that fails, lets the message through and is logged', NET, async (t) => {
    const env = await setup(t);
    const { ctx, logs, platform, world } = env;
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    platform.setInboxGate(() => {
      throw new Error('the lab broke');
    });
    const hb = await canteen.send('device.heartbeat', heartbeat);
    await waitFor(() => intakeOf(ctx, hb.id), { message: 'the heartbeat' });
    assert.ok(logs.some((l) => l.level === 'error' && /inbox gate/.test(l.message) && l.meta.error === 'the lab broke'));

    platform.setInboxGate(() => Promise.reject(new Error('the hold broke')));
    const hb2 = await canteen.send('device.heartbeat', heartbeat);
    await waitFor(() => intakeOf(ctx, hb2.id), { message: 'the second heartbeat' });
    assert.ok(logs.some((l) => l.level === 'warn' && /inbox gate/.test(l.message) && l.meta.error === 'the hold broke'));
    assert.equal(platform.inboxWaiting(), 0);
    assert.throws(() => platform.setInboxGate('hold everything'), TypeError);
  });

  test('a held message was stored by the platform: it is processed on release even after the link is gone', NET, async (t) => {
    const env = await setup(t);
    const { ctx, platform, world } = env;
    const canteen = await env.machine(world.a, 'CANTEEN-01');
    const kiosk = await env.machine(world.a, 'KIOSK-01');
    const { gate, held } = holdingGate((info) => info.device === 'CANTEEN-01');
    platform.setInboxGate(gate);
    const hb = await canteen.send('device.heartbeat', heartbeat);
    await waitFor(() => held.has(hb.id), { message: 'the hold' });
    // the gate goes away (the person turned hold off) while the message is held: its machine's
    // next message still waits behind it, other machines go straight through
    platform.setInboxGate(null);
    const next = await canteen.send('device.heartbeat', heartbeat);
    const other = await kiosk.send('device.heartbeat', heartbeat);
    await waitFor(() => intakeOf(ctx, other.id), { message: 'the kiosk heartbeat' });
    await waitFor(() => platform.inboxWaiting() === 2, { message: 'the second message to queue' });
    await platform.disconnectMqtt();
    held.get(hb.id).release();
    await waitFor(() => platform.inboxWaiting() === 0, { message: 'the inbox to empty' });
    assert.deepEqual(handledInOrder(ctx, [hb.id, next.id]), [hb.id, next.id]);
  });
});

describe('an older event bus', () => {
  test('without context methods the platform works as before: no context, the same events', NET, async (t) => {
    const full = createTestCtx();
    const bus = full.events;
    // emit/subscribe/since/lastSeq only: no withContext, context or untraced
    const ctx = { ...full, events: { emit: bus.emit, subscribe: bus.subscribe, since: bus.since, lastSeq: bus.lastSeq } };
    const platform = createPlatform(ctx);
    const world = seed(platform);
    const broker = await startBroker(ctx, { port: 0, resolveDevice: (username) => platform.resolveBrokerDevice(username) });
    const m = world.a.m['CANTEEN-01'];
    const username = `${world.a.code}.CANTEEN-01`;
    let machine = null;
    t.after(async () => {
      platform.setInboxGate(null);
      await machine?.endAsync(true).catch(() => {});
      await platform.disconnectMqtt();
      await broker.close();
      full.db.close();
    });
    await platform.connectMqtt(broker.url);
    assert.equal(sends(full).length, MACHINES * KINDS.length);
    machine = await mqtt.connectAsync(broker.url, { username, clientId: username, password: brokerPassword(m.secret), reconnectPeriod: 0 }, false);
    machine.on('error', () => {});
    const { gate, held } = holdingGate(() => true);
    platform.setInboxGate(gate);
    const env = signEnvelope(m.secret, buildEnvelope({ school: world.a.code, device: 'CANTEEN-01', seq: 1, at: full.clock.iso(), type: 'device.heartbeat', body: heartbeat }));
    await machine.publishAsync(topicFor(world.a.code, 'CANTEEN-01', 'status'), JSON.stringify(env), { qos: 1 });
    await waitFor(() => held.has(env.id), { message: 'the hold' });
    held.get(env.id).release();
    const accepted = await waitFor(() => intakeOf(full, env.id), { message: 'the heartbeat' });
    assert.equal(accepted.type, 'intake.accepted');
    assert.ok(full.events.since(0).every((e) => !('trace' in e) && !('msgId' in e)));
  });
});
