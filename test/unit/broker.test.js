import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import mqtt from 'mqtt';
import { PLATFORM_USERNAME, filterCovers, parseDeviceUsername, startBroker } from '../../src/broker/broker.js';
import { brokerPassword, randomSecret } from '../../src/shared/crypto.js';
import { COMMAND_KINDS, topicFor } from '../../src/shared/protocol.js';
import { newUuid } from '../../src/shared/ids.js';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';

// Fictional schools and machines; every password is generated per test run.
const A = 'smk-contoh';
const B = 'sjkc-contoh';
const CANTEEN_A = `${A}.CANTEEN-01`;
const CANTEEN_A2 = `${A}.CANTEEN-02`;
const WATER_A = `${A}.WATER-01`; // switched off
const CANTEEN_B = `${B}.CANTEEN-01`; // same device code, other school

/** Topic of a device login, e.g. topicOf(CANTEEN_A, 'commands/prices'). */
function topicOf(username, channel) {
  const [school, device] = username.split('.');
  return topicFor(school, device, channel);
}

function fakeDevices() {
  const devices = new Map();
  for (const [username, active] of [[CANTEEN_A, true], [CANTEEN_A2, true], [WATER_A, false], [CANTEEN_B, true]]) {
    const [schoolCode, deviceCode] = username.split('.');
    devices.set(username, { schoolCode, deviceCode, password: brokerPassword(randomSecret()), active });
  }
  return devices;
}

/**
 * A broker on a random port with four fake devices, plus login helpers. Everything it
 * opens is closed when the test ends.
 * @param {object|function} [options]  extra startBroker options, or ({ devices, lookups, ctx }) => options
 */
async function setup(t, options = {}) {
  const ctx = createTestCtx();
  const devices = fakeDevices();
  const lookups = [];
  const resolveDevice = (username) => {
    lookups.push(username);
    return devices.get(username) ?? null;
  };
  const extra = typeof options === 'function' ? options({ devices, lookups, ctx }) : options;
  const broker = await startBroker(ctx, { port: 0, resolveDevice, ...extra });
  const opened = [];
  t.after(async () => {
    await Promise.all(opened.map((client) => client.endAsync(true).catch(() => {})));
    await broker.close();
    ctx.db.close();
  });

  const as = {
    platform: (clientId = 'platform-test') => ({ username: PLATFORM_USERNAME, password: ctx.settings.platformBrokerPassword, clientId }),
    viewer: (clientId = 'viewer-test') => ({ ...ctx.settings.viewer, clientId }),
    device: (username) => ({ username, password: devices.get(username).password, clientId: username }),
  };

  const clientOptions = (login, extraOpts) => ({ reconnectPeriod: 0, connectTimeout: 3000, ...login, ...extraOpts });

  /** Log in; fails the test if the broker refuses. */
  async function connect(login, url = broker.url, extraOpts = {}) {
    const client = await mqtt.connectAsync(url, clientOptions(login, extraOpts), false);
    opened.push(client);
    client.on('error', () => {}); // e.g. ECONNRESET when the broker drops the connection
    return client;
  }

  /** Try to log in; resolves with the CONNACK return code of the refusal. */
  async function refusedCode(login, url = broker.url, extraOpts = {}) {
    let client;
    try {
      client = await mqtt.connectAsync(url, clientOptions(login, extraOpts), false);
    } catch (err) {
      return err.code;
    }
    opened.push(client);
    return assert.fail(`login as ${login.username} (${login.clientId}) should have been refused`);
  }

  /** Log in with an inbox already listening: a resumed session's messages follow the CONNACK at once. */
  async function connectWithInbox(login, extraOpts = {}) {
    const client = mqtt.connect(broker.url, clientOptions(login, extraOpts));
    opened.push(client);
    client.on('error', () => {});
    const got = inbox(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('close', () => reject(new Error(`login as ${login.username} (${login.clientId}) was refused`)));
    });
    return { client, got };
  }

  return { ctx, broker, devices, lookups, as, connect, refusedCode, connectWithInbox };
}

/**
 * startBroker must fail: resolves with its error. A broker that starts after all is
 * closed again, so the test fails instead of hanging on its open port and timers.
 */
async function startFails(ctx, options) {
  let broker;
  try {
    broker = await startBroker(ctx, options);
  } catch (err) {
    return err;
  }
  await broker.close();
  return assert.fail('startBroker should have failed');
}

/** Messages a client receives from now on. */
function inbox(client) {
  const got = [];
  client.on('message', (topic, payload, packet) => got.push({ topic, payload: payload.toString(), retain: packet.retain }));
  return got;
}

/** SUBACK return codes, one per filter (128 = refused). */
async function grants(client, filters, qos = 1) {
  try {
    const granted = await client.subscribeAsync(filters, { qos });
    return granted.map((g) => g.qos);
  } catch (err) {
    if (err.packet?.granted) return err.packet.granted; // mqtt.js rejects when any filter got 128
    throw err;
  }
}

/** Resolves when the client's connection closes; fails if that takes more than 5 s. */
function onClose(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connection of ${client.options.clientId} was not closed`)), 5000);
    client.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A port that was free a moment ago. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** An UNSUBSCRIBE round trip (no authorization, no events): proves the session is still up. */
async function alive(client) {
  if (!client.connected) return false;
  await client.unsubscribeAsync('liveness/check');
  return client.connected;
}

const deniedOf = (ctx) => eventsOf(ctx, 'mqtt.denied').map((e) => [e.school, e.data]);

// Network tests fail instead of hanging if an MQTT reply never comes.
const NET = { timeout: 15_000 };

// --- pure helpers -------------------------------------------------------------

test('filterCovers: a filter is allowed only when it is no wider than the allowed one', () => {
  const covered = [
    ['lab/v1/#', 'lab/v1/#'],
    ['lab/v1/#', 'lab/v1'],
    ['lab/v1/#', 'lab/v1/smk-contoh/CANTEEN-01/records'],
    ['lab/v1/#', 'lab/v1/+/+/status'],
    ['lab/v1/+/+/records', 'lab/v1/+/+/records'],
    ['lab/v1/+/+/records', 'lab/v1/smk-contoh/+/records'],
    ['lab/v1/+/+/records', 'lab/v1/smk-contoh/CANTEEN-01/records'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/D/commands/#'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/D/commands/prices'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/D/commands/+'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/D/commands'],
  ];
  const wider = [
    ['lab/v1/#', '#'],
    ['lab/v1/#', '$SYS/#'],
    ['lab/v1/#', 'lab/#'],
    ['lab/v1/#', '+/v1/#'],
    ['lab/v1/#', 'lab/+/x'],
    ['lab/v1/+/+/records', 'lab/v1/#'],
    ['lab/v1/+/+/records', 'lab/v1/+/+/+'],
    ['lab/v1/+/+/records', 'lab/v1/+/+'],
    ['lab/v1/+/+/records', 'lab/v1/+/+/records/#'],
    ['lab/v1/+/+/records', 'lab/v1/+/+/status'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/+/commands/#'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/D/#'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/D/+/prices'],
    ['lab/v1/s/D/commands/#', 'lab/v1/s/D2/commands/#'],
  ];
  for (const [allowed, wanted] of covered) assert.equal(filterCovers(allowed, wanted), true, `${allowed} covers ${wanted}`);
  for (const [allowed, wanted] of wider) assert.equal(filterCovers(allowed, wanted), false, `${allowed} does not cover ${wanted}`);
});

test('parseDeviceUsername: only <school>.<DEVICE> in canonical case', () => {
  assert.deepEqual(parseDeviceUsername('smk-contoh.CANTEEN-01'), { schoolCode: 'smk-contoh', deviceCode: 'CANTEEN-01' });
  assert.deepEqual(parseDeviceUsername('sjkc-contoh.KIOSK-01'), { schoolCode: 'sjkc-contoh', deviceCode: 'KIOSK-01' });
  for (const bad of ['platform', 'viewer', 'SMK-CONTOH.CANTEEN-01', 'smk-contoh.canteen-01', 'smk-contoh.CANTEEN-01.X',
    '.CANTEEN-01', 'smk-contoh.', 'smk contoh.CANTEEN-01', '', null, undefined, 42]) {
    assert.equal(parseDeviceUsername(bad), null, String(bad));
  }
});

// --- start-up and options -------------------------------------------------------

test('starts on a random port and reports where to connect', NET, async (t) => {
  const { broker } = await setup(t);
  assert.ok(broker.port > 0);
  assert.equal(broker.url, `mqtt://127.0.0.1:${broker.port}`);
  assert.equal(broker.tlsUrl, null);
  assert.equal(broker.tlsPort, null);
  assert.equal(typeof broker.aedes.handle, 'function');
  assert.deepEqual(broker.clients(), []);
});

test('a wildcard listen address is reported as loopback, which clients can reach', NET, async (t) => {
  const { broker, as, connect } = await setup(t, { host: '0.0.0.0' });
  assert.equal(broker.url, `mqtt://127.0.0.1:${broker.port}`);
  await connect(as.platform());
});

test('bad options are refused before anything starts', NET, async (t) => {
  const ctx = createTestCtx();
  t.after(() => ctx.db.close());
  assert.ok((await startFails(ctx, { port: 0, resolveDevice: 'nope' })) instanceof TypeError);
  assert.ok((await startFails(ctx, { port: 0, tls: { port: 0 } })) instanceof TypeError);
});

test('startBroker rejects when a port is taken or the TLS key is unusable, and leaves nothing running', NET, async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const ctx = createTestCtx();
  t.after(() => ctx.db.close());
  assert.equal((await startFails(ctx, { port: blocker.address().port })).code, 'EADDRINUSE');
  // the plain listener is already up when the TLS one fails; it must be closed again
  // (the TLS test covers a taken TLS port)
  const port = await freePort();
  await startFails(ctx, { port, tls: { port: 0, key: 'not a key', cert: 'not a cert' } });
  const again = net.createServer();
  await new Promise((resolve, reject) => {
    again.once('error', reject);
    again.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => again.close(resolve));
  // (an aedes timer left behind would also keep this test file from ever exiting)
});

// --- logins -------------------------------------------------------------------------

test('logins: platform, viewer and devices with the right password get in', NET, async (t) => {
  const { ctx, broker, as, connect } = await setup(t);
  await connect(as.platform());
  await connect(as.viewer());
  await connect(as.device(CANTEEN_A));
  await connect(as.device(CANTEEN_B));
  const byId = (x, y) => x.clientId.localeCompare(y.clientId);
  assert.deepEqual(broker.clients().sort(byId), [
    { clientId: 'platform-test', username: 'platform' },
    { clientId: CANTEEN_B, username: CANTEEN_B },
    { clientId: CANTEEN_A, username: CANTEEN_A },
    { clientId: 'viewer-test', username: 'viewer' },
  ].sort(byId));
  assert.deepEqual(eventsOf(ctx, 'mqtt.connect').map((e) => [e.school, e.data]), [
    [null, { username: 'platform', clientId: 'platform-test' }],
    [null, { username: 'viewer', clientId: 'viewer-test' }],
    [A, { username: CANTEEN_A, clientId: CANTEEN_A }],
    [B, { username: CANTEEN_B, clientId: CANTEEN_B }],
  ]);
  assert.deepEqual(eventsOf(ctx, 'mqtt.denied'), []);
});

test('logins: anonymous, unknown users and wrong passwords are refused', NET, async (t) => {
  const { ctx, as, refusedCode, devices } = await setup(t);
  assert.equal(await refusedCode({ clientId: 'anonymous-1' }), 5);
  assert.equal(await refusedCode({ ...as.platform(), password: randomSecret() }), 4);
  assert.equal(await refusedCode({ ...as.platform(), password: undefined }), 4);
  assert.equal(await refusedCode({ ...as.viewer(), password: 'not-the-viewer-password' }), 4);
  assert.equal(await refusedCode({ username: 'admin', password: 'admin', clientId: 'guess-1' }), 4);
  assert.equal(await refusedCode({ ...as.device(CANTEEN_A), password: brokerPassword(randomSecret()) }), 4);
  assert.equal(await refusedCode({ ...as.device(CANTEEN_A), password: undefined }), 4);
  // a device password opens only its own account, in its own school
  assert.equal(await refusedCode({ ...as.device(CANTEEN_A2), password: devices.get(CANTEEN_A).password }), 4);
  assert.equal(await refusedCode({ ...as.device(CANTEEN_B), password: devices.get(CANTEEN_A).password }), 4);
  const ghost = `${A}.CANTEEN-99`;
  assert.equal(await refusedCode({ username: ghost, password: brokerPassword(randomSecret()), clientId: ghost }), 4);

  assert.deepEqual(eventsOf(ctx, 'mqtt.connect'), []);
  assert.deepEqual(deniedOf(ctx), [
    [null, { username: null, action: 'connect' }],
    [null, { username: 'platform', action: 'connect' }],
    [null, { username: 'platform', action: 'connect' }],
    [null, { username: 'viewer', action: 'connect' }],
    [null, { username: 'admin', action: 'connect' }],
    [A, { username: CANTEEN_A, action: 'connect' }],
    [A, { username: CANTEEN_A, action: 'connect' }],
    [A, { username: CANTEEN_A2, action: 'connect' }],
    [B, { username: CANTEEN_B, action: 'connect' }],
    [A, { username: ghost, action: 'connect' }],
  ]);
});

test('logins: a device must use its username as client id and be switched on', NET, async (t) => {
  const { ctx, as, connect, refusedCode, devices } = await setup(t);
  assert.equal(await refusedCode({ ...as.device(CANTEEN_A), clientId: 'canteen-reader' }), 2);
  assert.equal(await refusedCode({ ...as.device(CANTEEN_A), clientId: CANTEEN_A2 }), 2);
  assert.equal(await refusedCode({ ...as.device(CANTEEN_A), clientId: '' }), 2); // aedes makes up an id
  // not ACTIVE, or its school SUSPENDED: resolveDevice says active false
  assert.equal(await refusedCode(as.device(WATER_A)), 5);
  assert.deepEqual(deniedOf(ctx), [
    [A, { username: CANTEEN_A, action: 'connect' }],
    [A, { username: CANTEEN_A, action: 'connect' }],
    [A, { username: CANTEEN_A, action: 'connect' }],
    [A, { username: WATER_A, action: 'connect' }],
  ]);
  // switched on again, it gets in
  devices.get(WATER_A).active = true;
  await connect(as.device(WATER_A));
  // anything but a strict true counts as switched off
  devices.get(CANTEEN_A2).active = 'yes';
  assert.equal(await refusedCode(as.device(CANTEEN_A2)), 5);
});

test('logins: usernames that are not <school>.<DEVICE> never reach the device lookup', NET, async (t) => {
  const { ctx, refusedCode, devices, lookups } = await setup(t);
  const password = devices.get(CANTEEN_A).password;
  const names = ['SMK-CONTOH.CANTEEN-01', 'smk-contoh.canteen-01', 'smk-contoh.CANTEEN-01.X', 'smk-contoh.', '.CANTEEN-01'];
  for (const username of names) assert.equal(await refusedCode({ username, password, clientId: username }), 4, username);
  assert.deepEqual(lookups, []);
  assert.deepEqual(deniedOf(ctx).map(([school]) => school), names.map(() => null));
});

test('logins: a failing device lookup answers "server unavailable" and the broker carries on', NET, async (t) => {
  const logs = [];
  const { as, connect, refusedCode } = await setup(t, ({ ctx }) => {
    ctx.log = (level, message, meta) => logs.push({ level, message, meta });
    return {
      resolveDevice: () => {
        throw new Error('database is locked');
      },
    };
  });
  assert.equal(await refusedCode(as.device(CANTEEN_A)), 3);
  assert.ok(logs.some((l) => l.level === 'error' && l.meta?.error === 'database is locked'));
  assert.ok(logs.some((l) => l.level === 'warn' && l.message === 'broker refused connect' && l.meta.reason === 'device lookup failed'));
  await connect(as.platform());
});

test('logins: an asynchronous device lookup works too', NET, async (t) => {
  const { as, connect, refusedCode } = await setup(t, ({ devices }) => ({
    resolveDevice: async (username) => devices.get(username) ?? null,
  }));
  await connect(as.device(CANTEEN_A));
  assert.equal(await refusedCode(as.device(WATER_A)), 5);
});

test('logins: an unset platform password or viewer account lets nobody in', NET, async (t) => {
  const { refusedCode } = await setup(t, { platformPassword: '', viewer: null });
  assert.equal(await refusedCode({ username: 'platform', password: '', clientId: 'p-1' }), 4);
  assert.equal(await refusedCode({ username: 'platform', clientId: 'p-2' }), 4);
  assert.equal(await refusedCode({ username: 'viewer', password: 'viewer', clientId: 'v-1' }), 4);
});

test('logins: explicit platformPassword and viewer options replace the ctx settings', NET, async (t) => {
  const platformPassword = randomSecret();
  const viewer = { username: 'watcher', password: randomSecret(8) };
  const { ctx, connect, refusedCode } = await setup(t, { platformPassword, viewer });
  assert.equal(await refusedCode({ username: 'platform', password: ctx.settings.platformBrokerPassword, clientId: 'p-1' }), 4);
  assert.equal(await refusedCode({ ...ctx.settings.viewer, clientId: 'v-1' }), 4);
  await connect({ username: 'platform', password: platformPassword, clientId: 'p-2' });
  await connect({ ...viewer, clientId: 'v-2' });
});

test('client ids: device ids are reserved and the viewer cannot take over other sessions', NET, async (t) => {
  const { ctx, as, connect, refusedCode } = await setup(t);
  const device = await connect(as.device(CANTEEN_A));
  // nobody else may use a device's client id, so nobody can push the machine off the broker
  assert.equal(await refusedCode(as.viewer(CANTEEN_A)), 2);
  assert.equal(await refusedCode(as.platform(CANTEEN_A)), 2);
  assert.equal(await refusedCode(as.viewer(`${B}.KIOSK-01`)), 2); // reserved even while that device is offline
  assert.equal(await alive(device), true);

  // the viewer cannot take over the platform's session...
  const platform = await connect(as.platform('platform-main'));
  assert.equal(await refusedCode(as.viewer('platform-main')), 2);
  assert.equal(await alive(platform), true);
  // ...but the platform takes back an id the viewer is sitting on
  const squatter = await connect(as.viewer('platform-spare'));
  const squatterGone = onClose(squatter);
  await connect(as.platform('platform-spare'));
  await squatterGone;

  // the same account may take over its own session: a machine back before its old link timed out
  const oldLinkGone = onClose(device);
  const again = await connect(as.device(CANTEEN_A));
  await oldLinkGone;
  assert.equal(await alive(again), true);
  assert.deepEqual(deniedOf(ctx), [
    [null, { username: 'viewer', action: 'connect' }],
    [null, { username: 'platform', action: 'connect' }],
    [null, { username: 'viewer', action: 'connect' }],
    [null, { username: 'viewer', action: 'connect' }],
  ]);
});

test('client ids: a session kept for a clean:false login stays with its account while it is away', NET, async (t) => {
  const { ctx, as, connect, connectWithInbox, refusedCode } = await setup(t);
  const kept = { clean: false };
  const first = await connect(as.platform('platform-main'), undefined, kept);
  assert.deepEqual(await grants(first, ['lab/v1/+/+/records']), [1]);
  await first.endAsync();
  // records sent while the platform is away wait in its session
  const device = await connect(as.device(CANTEEN_A));
  for (const n of [1, 2]) await device.publishAsync(topicOf(CANTEEN_A, 'records'), `record-${n}`, { qos: 1 });

  // the public viewer login can neither resume that session (taking the records) nor wipe it
  assert.equal(await refusedCode(as.viewer('platform-main'), undefined, kept), 2);
  assert.equal(await refusedCode(as.viewer('platform-main')), 2);
  const { client: back, got } = await connectWithInbox(as.platform('platform-main'), kept);
  assert.equal(back.connackPacket.sessionPresent, true);
  await waitFor(() => got.length === 2, { message: 'the records kept for the platform' });
  assert.deepEqual(got.map((m) => m.payload), ['record-1', 'record-2']);

  // a clean login of the same account ends the kept session, and then the id is free again
  await back.endAsync();
  await (await connect(as.platform('platform-main'))).endAsync();
  const platformLogouts = () => eventsOf(ctx, 'mqtt.disconnect').filter((e) => e.data.clientId === 'platform-main').length;
  await waitFor(() => platformLogouts() === 3, { message: 'the platform sessions to end' });
  await connect(as.viewer('platform-main'));

  // and the viewer cannot lock the platform out by leaving a kept session on an id it wants
  const squatter = await connect(as.viewer('platform-spare'), undefined, kept);
  assert.deepEqual(await grants(squatter, ['lab/v1/#']), [1]);
  await squatter.endAsync();
  await connect(as.platform('platform-spare'));
  assert.deepEqual(deniedOf(ctx), [
    [null, { username: 'viewer', action: 'connect' }],
    [null, { username: 'viewer', action: 'connect' }],
  ]);
});

test('a machine\'s clean:false session gets the commands sent while it was away, and only its own', NET, async (t) => {
  const { as, connect, connectWithInbox } = await setup(t);
  const kept = { clean: false };
  const first = await connect(as.device(CANTEEN_A), undefined, kept);
  assert.deepEqual(await grants(first, [`${topicOf(CANTEEN_A, 'commands')}/#`]), [1]);
  await first.endAsync();
  const platform = await connect(as.platform());
  await platform.publishAsync(topicOf(CANTEEN_A2, 'commands/control'), 'for CANTEEN-02', { qos: 1 });
  await platform.publishAsync(topicOf(CANTEEN_A, 'commands/control'), 'for CANTEEN-01', { qos: 1 });
  // its kept subscription is checked again on the way back in, under its own account
  const { client: back, got } = await connectWithInbox(as.device(CANTEEN_A), kept);
  assert.equal(back.connackPacket.sessionPresent, true);
  await waitFor(() => got.length === 1, { message: 'the command kept for the machine' });
  assert.deepEqual(got, [{ topic: topicOf(CANTEEN_A, 'commands/control'), payload: 'for CANTEEN-01', retain: false }]);
});

// --- publish ---------------------------------------------------------------------------

test('a device publishes its own records and status, and the platform receives them', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  assert.deepEqual(await grants(platform, ['lab/v1/+/+/records', 'lab/v1/+/+/status']), [1, 1]);
  const got = inbox(platform);
  const device = await connect(as.device(CANTEEN_A));
  const envelope = { v: '1.0', id: newUuid(), school: A, device: 'CANTEEN-01', seq: 1, at: ctx.clock.iso(), sig: 'x'.repeat(43) };
  const body = { item: 'Teh tarik – kurang manis' }; // the dash is 3 bytes in UTF-8
  const sale = JSON.stringify({ ...envelope, type: 'sale.recorded', txn: 'CANTEEN-01-000001', body });
  const heartbeat = JSON.stringify({ ...envelope, seq: 2, type: 'device.heartbeat', body: { fw: '1.0.0', health: 'OK' } });
  await device.publishAsync(topicOf(CANTEEN_A, 'records'), sale, { qos: 1 });
  await device.publishAsync(topicOf(CANTEEN_A, 'status'), heartbeat, { qos: 1 });

  await waitFor(() => got.length === 2, { message: 'both messages at the platform' });
  assert.deepEqual(got, [
    { topic: topicOf(CANTEEN_A, 'records'), payload: sale, retain: false },
    { topic: topicOf(CANTEEN_A, 'status'), payload: heartbeat, retain: false },
  ]);
  await waitFor(() => eventsOf(ctx, 'mqtt.publish').length === 2, { message: 'publish events' });
  assert.deepEqual(eventsOf(ctx, 'mqtt.publish').map((e) => [e.school, e.data]), [
    [A, {
      from: CANTEEN_A, topic: topicOf(CANTEEN_A, 'records'), type: 'sale.recorded', txn: 'CANTEEN-01-000001',
      retained: false, bytes: Buffer.byteLength(sale),
    }],
    [A, {
      from: CANTEEN_A, topic: topicOf(CANTEEN_A, 'status'), type: 'device.heartbeat', txn: null,
      retained: false, bytes: Buffer.byteLength(heartbeat),
    }],
  ]);
  assert.notEqual(Buffer.byteLength(sale), sale.length); // bytes, not characters
  assert.deepEqual(eventsOf(ctx, 'mqtt.denied'), []);
});

test('a device publishing to another device\'s topic is cut off, and nobody receives the message', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  await grants(platform, ['lab/v1/+/+/records']);
  const viewer = await connect(as.viewer());
  await grants(viewer, ['lab/v1/#']);
  const atPlatform = inbox(platform);
  const atViewer = inbox(viewer);

  const offender = await connect(as.device(CANTEEN_A));
  const cutOff = onClose(offender);
  let acked = false;
  const forged = JSON.stringify({ type: 'sale.recorded', txn: 'CANTEEN-02-000001' });
  offender.publish(topicOf(CANTEEN_A2, 'records'), forged, { qos: 1 }, (err) => {
    if (!err) acked = true;
  });
  // aedes answers a refused QoS 1 publish by closing the connection, without a PUBACK
  await cutOff;
  assert.equal(acked, false);
  await waitFor(() => eventsOf(ctx, 'mqtt.disconnect').some((e) => e.data.username === CANTEEN_A), { message: 'disconnect event' });

  // a later, allowed message arrives on its own: the refused one was never routed
  const witness = await connect(as.device(CANTEEN_A2));
  await witness.publishAsync(topicOf(CANTEEN_A2, 'records'), 'witness', { qos: 1 });
  await waitFor(() => atPlatform.length === 1 && atViewer.length === 1, { message: 'the witness message' });
  assert.deepEqual(atPlatform.map((m) => m.payload), ['witness']);
  assert.deepEqual(atViewer.map((m) => m.payload), ['witness']);

  assert.deepEqual(deniedOf(ctx), [[A, { username: CANTEEN_A, action: 'publish', topic: topicOf(CANTEEN_A2, 'records') }]]);
  await waitFor(() => eventsOf(ctx, 'mqtt.publish').length === 1, { message: 'publish event' });
  assert.deepEqual(eventsOf(ctx, 'mqtt.publish').map((e) => e.data.from), [CANTEEN_A2]);
});

test('tenant isolation: a device cannot publish into another school, even under its own device code', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  await grants(platform, ['lab/v1/+/+/records']);
  const got = inbox(platform);
  const offender = await connect(as.device(CANTEEN_A));
  const cutOff = onClose(offender);
  offender.publish(topicOf(CANTEEN_B, 'records'), '{"type":"sale.recorded"}', { qos: 1 });
  await cutOff;
  const witness = await connect(as.device(CANTEEN_B));
  await witness.publishAsync(topicOf(CANTEEN_B, 'records'), 'witness', { qos: 1 });
  await waitFor(() => got.length === 1, { message: 'the witness message' });
  assert.deepEqual(got.map((m) => m.payload), ['witness']);
  // the event belongs to the school named in the topic
  assert.deepEqual(deniedOf(ctx), [[B, { username: CANTEEN_A, action: 'publish', topic: topicOf(CANTEEN_B, 'records') }]]);
});

test('a device may publish nowhere but its own records and status', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const forbidden = [
    [topicOf(CANTEEN_A, 'commands/prices'), 1], // commands come only from the platform
    [`${topicOf(CANTEEN_A, 'records')}/extra`, 0],
    [`lab/v1/${A}/CANTEEN-01`, 0],
    [topicOf(CANTEEN_A2, 'status'), 2],
    ['$SYS/broker/clients', 0],
    ['anything/else', 1],
  ];
  for (const [topic, qos] of forbidden) {
    const device = await connect(as.device(CANTEEN_A));
    const cutOff = onClose(device);
    device.publish(topic, 'x', { qos });
    await cutOff;
  }
  assert.deepEqual(deniedOf(ctx), forbidden.map(([topic]) => [A, { username: CANTEEN_A, action: 'publish', topic }]));
  assert.deepEqual(eventsOf(ctx, 'mqtt.publish'), []);
});

test('the platform may publish every command kind, and nothing else', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  for (const kind of COMMAND_KINDS) await platform.publishAsync(topicOf(CANTEEN_A, `commands/${kind}`), '{}', { qos: 1 });
  assert.equal(await alive(platform), true);
  const forbidden = [
    topicOf(CANTEEN_A, 'records'),
    topicOf(CANTEEN_A, 'status'),
    topicOf(CANTEEN_A, 'commands/firmware'),
    `lab/v1/${A}/CANTEEN-01/commands`,
    'lab/v1/Not A School/CANTEEN-01/commands/prices',
    '$SYS/whatever',
  ];
  for (const [i, topic] of forbidden.entries()) {
    const p = await connect(as.platform(`platform-${i}`));
    const cutOff = onClose(p);
    p.publish(topic, '{}', { qos: 1 });
    await cutOff;
  }
  assert.deepEqual(deniedOf(ctx).map(([, data]) => data), forbidden.map((topic) => ({ username: 'platform', action: 'publish', topic })));
  await waitFor(() => eventsOf(ctx, 'mqtt.publish').length === COMMAND_KINDS.length, { message: 'publish events' });
});

test('a retained command reaches the device that subscribes later, and only that device', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  const pricesA = JSON.stringify({ type: 'config.prices', body: { version: 3 } });
  const pricesB = JSON.stringify({ type: 'config.prices', body: { version: 7 } });
  await platform.publishAsync(topicOf(CANTEEN_A, 'commands/prices'), pricesA, { qos: 1, retain: true });
  await platform.publishAsync(topicOf(CANTEEN_B, 'commands/prices'), pricesB, { qos: 1, retain: true });

  const deviceA = await connect(as.device(CANTEEN_A));
  const deviceA2 = await connect(as.device(CANTEEN_A2));
  const deviceB = await connect(as.device(CANTEEN_B));
  const atA = inbox(deviceA);
  const atA2 = inbox(deviceA2);
  const atB = inbox(deviceB);
  assert.deepEqual(await grants(deviceA, [`${topicOf(CANTEEN_A, 'commands')}/#`]), [1]);
  assert.deepEqual(await grants(deviceA2, [`${topicOf(CANTEEN_A2, 'commands')}/#`]), [1]);
  assert.deepEqual(await grants(deviceB, [`${topicOf(CANTEEN_B, 'commands')}/prices`]), [1]);
  await waitFor(() => atA.length === 1 && atB.length === 1, { message: 'retained prices' });
  assert.deepEqual(atA, [{ topic: topicOf(CANTEEN_A, 'commands/prices'), payload: pricesA, retain: true }]);
  assert.deepEqual(atB, [{ topic: topicOf(CANTEEN_B, 'commands/prices'), payload: pricesB, retain: true }]);

  // a live command is not retained; CANTEEN-02 had nothing waiting, so this is all it gets
  const control = JSON.stringify({ type: 'control.heartbeat-now', body: {} });
  await platform.publishAsync(topicOf(CANTEEN_A2, 'commands/control'), control, { qos: 1 });
  await waitFor(() => atA2.length === 1, { message: 'the control command' });
  assert.deepEqual(atA2, [{ topic: topicOf(CANTEEN_A2, 'commands/control'), payload: control, retain: false }]);
  assert.equal(atA.length, 1);
  assert.equal(atB.length, 1);

  await waitFor(() => eventsOf(ctx, 'mqtt.publish').length === 3, { message: 'publish events' });
  assert.deepEqual(eventsOf(ctx, 'mqtt.publish').map((e) => [e.school, e.data.from, e.data.topic, e.data.type, e.data.retained]), [
    [A, 'platform', topicOf(CANTEEN_A, 'commands/prices'), 'config.prices', true],
    [B, 'platform', topicOf(CANTEEN_B, 'commands/prices'), 'config.prices', true],
    [A, 'platform', topicOf(CANTEEN_A2, 'commands/control'), 'control.heartbeat-now', false],
  ]);
});

test('a will message is held to the same rules as any publish', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  await grants(platform, ['lab/v1/+/+/status', 'lab/v1/+/+/records']);
  const got = inbox(platform);
  const will = (topic, payload) => ({ will: { topic, payload, qos: 1 } });
  const honest = await connect(as.device(CANTEEN_A), undefined, will(topicOf(CANTEEN_A, 'status'), 'gone'));
  const sneaky = await connect(as.device(CANTEEN_A2), undefined, will(topicOf(CANTEEN_B, 'records'), 'forged'));
  honest.stream.destroy(); // the link drops without DISCONNECT, so the broker sends the will
  sneaky.stream.destroy();
  await waitFor(() => got.length === 1 && eventsOf(ctx, 'mqtt.denied').length === 1, { message: 'the will and the refusal' });
  assert.deepEqual(got, [{ topic: topicOf(CANTEEN_A, 'status'), payload: 'gone', retain: false }]);
  assert.deepEqual(deniedOf(ctx), [[B, { username: CANTEEN_A2, action: 'publish', topic: topicOf(CANTEEN_B, 'records') }]]);
});

// --- subscribe -------------------------------------------------------------------------------

test('a device may subscribe only to its own commands; any other filter gets SUBACK 128', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const device = await connect(as.device(CANTEEN_A));
  const own = topicOf(CANTEEN_A, 'commands');
  assert.deepEqual(await grants(device, [`${own}/#`]), [1]);
  assert.deepEqual(await grants(device, [`${own}/prices`, `${own}/+`]), [1, 1]);
  assert.deepEqual(await grants(device, [`${own}/blocklist`], 0), [0]);
  const otherSchool = `${topicOf(CANTEEN_B, 'commands')}/#`;
  const refused = [
    `${topicOf(CANTEEN_A2, 'commands')}/#`, // another device
    otherSchool, // same device code, other school
    `lab/v1/${A}/+/commands/#`,
    topicOf(CANTEEN_A, 'records'), // its own uplink is for the platform to read
    `lab/v1/${A}/CANTEEN-01/#`,
    'lab/v1/#',
    '#',
    '$SYS/#',
  ];
  for (const filter of refused) assert.deepEqual(await grants(device, [filter]), [128], filter);
  // in one SUBSCRIBE, only the bad filter is refused
  assert.deepEqual(await grants(device, [`${own}/settings`, `${topicOf(CANTEEN_A2, 'commands')}/settings`]), [1, 128]);

  // the session carries on, and the granted filters work
  const got = inbox(device);
  const platform = await connect(as.platform());
  await platform.publishAsync(topicOf(CANTEEN_A2, 'commands/settings'), 'not yours', { qos: 1 });
  await platform.publishAsync(topicOf(CANTEEN_A, 'commands/settings'), 'yours', { qos: 1 });
  await waitFor(() => got.length >= 1, { message: 'the command' });
  assert.deepEqual([...new Set(got.map((m) => m.payload))], ['yours']);

  // each event belongs to the school in the filter, or else to the device's own school
  assert.deepEqual(deniedOf(ctx), [
    ...refused.map((topic) => [topic === otherSchool ? B : A, { username: CANTEEN_A, action: 'subscribe', topic }]),
    [A, { username: CANTEEN_A, action: 'subscribe', topic: `${topicOf(CANTEEN_A2, 'commands')}/settings` }],
  ]);
});

test('the platform subscribes to records and status only', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  const allowed = ['lab/v1/+/+/records', 'lab/v1/+/+/status', `lab/v1/${A}/+/records`, topicOf(CANTEEN_B, 'status')];
  assert.deepEqual(await grants(platform, allowed), [1, 1, 1, 1]);
  const refused = [
    'lab/v1/+/+/commands/#', topicOf(CANTEEN_A, 'commands/prices'), 'lab/v1/#', 'lab/v1/+/+/+', 'lab/v1/+/+/records/#', '#', '$SYS/#',
  ];
  for (const filter of refused) assert.deepEqual(await grants(platform, [filter]), [128], filter);
  assert.deepEqual(deniedOf(ctx).map(([, data]) => data), refused.map((topic) => ({ username: 'platform', action: 'subscribe', topic })));
  assert.equal(await alive(platform), true);
});

test('the viewer watches lab/v1/# but cannot publish anything', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const viewer = await connect(as.viewer());
  assert.deepEqual(await grants(viewer, ['lab/v1/#']), [1]);
  assert.deepEqual(await grants(viewer, [`lab/v1/${A}/#`, 'lab/v1/+/+/status', `${topicOf(CANTEEN_B, 'commands')}/+`]), [1, 1, 1]);
  const refused = ['#', '$SYS/#', 'lab/#', '+/v1/#'];
  for (const filter of refused) assert.deepEqual(await grants(viewer, [filter]), [128], filter);

  const seen = inbox(viewer);
  const device = await connect(as.device(CANTEEN_A));
  const platform = await connect(as.platform());
  await device.publishAsync(topicOf(CANTEEN_A, 'records'), 'a record', { qos: 1 });
  await platform.publishAsync(topicOf(CANTEEN_B, 'commands/control'), 'a command', { qos: 1 });
  const saw = (payload) => seen.some((m) => m.payload === payload);
  await waitFor(() => saw('a record') && saw('a command'), { message: 'traffic both ways' });

  const cutOff = onClose(viewer);
  viewer.publish(topicOf(CANTEEN_A, 'records'), 'fake record', { qos: 1 });
  await cutOff;
  assert.deepEqual(deniedOf(ctx), [
    ...refused.map((topic) => [null, { username: 'viewer', action: 'subscribe', topic }]),
    [A, { username: 'viewer', action: 'publish', topic: topicOf(CANTEEN_A, 'records') }],
  ]);
});

// --- kick, events, clients --------------------------------------------------------------

test('kick() disconnects every session of an account at once and leaves the others alone', NET, async (t) => {
  const { ctx, broker, as, connect, refusedCode, devices } = await setup(t);
  const platform = await connect(as.platform());
  const device = await connect(as.device(CANTEEN_A));
  const other = await connect(as.device(CANTEEN_A2));
  const gone = onClose(device);
  devices.get(CANTEEN_A).active = false; // the office switches the machine off...
  assert.equal(broker.kick(CANTEEN_A), 1); // ...and the platform kicks it
  await gone;
  const event = await waitFor(() => eventsOf(ctx, 'mqtt.disconnect').find((e) => e.data.username === CANTEEN_A));
  assert.deepEqual([event.school, event.data], [A, { username: CANTEEN_A, clientId: CANTEEN_A }]);
  assert.deepEqual(broker.clients().map((c) => c.username).sort(), ['platform', CANTEEN_A2]);
  assert.equal(await alive(platform), true);
  assert.equal(await alive(other), true);

  assert.equal(broker.kick(CANTEEN_A), 0);
  assert.equal(broker.kick('nobody'), 0);
  assert.equal(await refusedCode(as.device(CANTEEN_A)), 5); // it cannot come back while switched off
  devices.get(CANTEEN_A).active = true;
  await connect(as.device(CANTEEN_A));

  // several sessions of one account all go
  const v1 = await connect(as.viewer('viewer-1'));
  const v2 = await connect(as.viewer('viewer-2'));
  const bothGone = Promise.all([onClose(v1), onClose(v2)]);
  assert.equal(broker.kick('viewer'), 2);
  await bothGone;
});

test('kick() also voids a login that is still waiting for the device lookup', NET, async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { broker, as, connect, refusedCode, lookups } = await setup(t, ({ devices, lookups: seen }) => ({
    resolveDevice: async (username) => {
      seen.push(username);
      await gate;
      return devices.get(username) ?? null; // still says active: the switch-off came too late for it
    },
  }));
  const pending = refusedCode(as.device(CANTEEN_A));
  await waitFor(() => lookups.length === 1, { message: 'the lookup to start' });
  assert.deepEqual(broker.clients(), []); // a login still being checked is not a client yet
  assert.equal(broker.kick(CANTEEN_A), 0); // not connected yet
  release();
  assert.equal(await pending, 5);
  await connect(as.device(CANTEEN_A)); // a login that starts after the kick is judged afresh
});

test('kick() also closes a login that passed its check while aedes was still setting the session up', NET, async (t) => {
  const { ctx, broker, as, connect, devices } = await setup(t);
  // aedes finishes a session in several asynchronous steps after the login check says yes
  const check = broker.aedes.authenticate;
  let kicked;
  broker.aedes.authenticate = (client, username, password, callback) => check(client, username, password, (err, ok) => {
    callback(err, ok);
    if (ok && username === CANTEEN_A && kicked === undefined) {
      devices.get(CANTEEN_A).active = false; // switched off right then
      kicked = broker.kick(CANTEEN_A);
    }
  });
  await assert.rejects(connect(as.device(CANTEEN_A)));
  assert.equal(kicked, 0); // nothing registered yet to close
  assert.deepEqual(broker.clients(), []);
  await waitFor(() => eventsOf(ctx, 'mqtt.disconnect').length === 1, { message: 'the disconnect event' });
  assert.deepEqual(eventsOf(ctx, 'mqtt.connect').map((e) => e.data.username), [CANTEEN_A]);
  assert.deepEqual(eventsOf(ctx, 'mqtt.disconnect').map((e) => [e.school, e.data]), [[A, { username: CANTEEN_A, clientId: CANTEEN_A }]]);
  // switched on again, its next login is judged afresh
  devices.get(CANTEEN_A).active = true;
  await connect(as.device(CANTEEN_A));
  assert.deepEqual(broker.clients().map((c) => c.username), [CANTEEN_A]);
});

test('kick() also closes a login that was taking over an older session of the same machine', NET, async (t) => {
  const { ctx, broker, as, connect, devices } = await setup(t);
  const old = await connect(as.device(CANTEEN_A));
  // with a subscription to drop, closing the old session takes aedes more than one tick
  assert.deepEqual(await grants(old, [`${topicOf(CANTEEN_A, 'commands')}/#`]), [1]);
  const oldGone = onClose(old);
  let kicked;
  // the old session is gone and the new one not registered yet when the machine is switched off
  broker.aedes.once('clientDisconnect', () => {
    devices.get(CANTEEN_A).active = false;
    kicked = broker.kick(CANTEEN_A);
  });
  let takeover = null;
  try {
    takeover = await connect(as.device(CANTEEN_A)); // aedes answers a takeover before registering it
  } catch {
    // or the connection closed before the CONNACK: either way no session may survive
  }
  await oldGone;
  assert.equal(kicked, 0);
  await waitFor(() => !takeover?.connected && broker.clients().length === 0, { message: 'the takeover to be closed' });
  await waitFor(() => eventsOf(ctx, 'mqtt.disconnect').length === 2, { message: 'both disconnect events' });
  assert.deepEqual(eventsOf(ctx, 'mqtt.connect').map((e) => e.data.username), [CANTEEN_A, CANTEEN_A]);
  devices.get(CANTEEN_A).active = true;
  await connect(as.device(CANTEEN_A));
});

test('mqtt.connect and mqtt.disconnect events carry the account, the client id and the school', NET, async (t) => {
  const { ctx, as, connect } = await setup(t);
  const platform = await connect(as.platform());
  const device = await connect(as.device(CANTEEN_B));
  await device.endAsync();
  await platform.endAsync();
  await waitFor(() => eventsOf(ctx, 'mqtt.disconnect').length === 2, { message: 'disconnect events' });
  assert.deepEqual(eventsOf(ctx, 'mqtt.connect').map((e) => [e.school, e.data]), [
    [null, { username: 'platform', clientId: 'platform-test' }],
    [B, { username: CANTEEN_B, clientId: CANTEEN_B }],
  ]);
  const byUsername = (x, y) => x[1].username.localeCompare(y[1].username);
  assert.deepEqual(eventsOf(ctx, 'mqtt.disconnect').map((e) => [e.school, e.data]).sort(byUsername), [
    [null, { username: 'platform', clientId: 'platform-test' }],
    [B, { username: CANTEEN_B, clientId: CANTEEN_B }],
  ]);
});

test('mqtt.publish events: type and txn come from a JSON envelope when there is one', NET, async (t) => {
  const { ctx, broker, as, connect } = await setup(t);
  const device = await connect(as.device(CANTEEN_A));
  const records = topicOf(CANTEEN_A, 'records');
  const payloads = [
    JSON.stringify({ type: 'journal.batch', txn: 'BATCH-0001', body: { count: 0 } }),
    'not json at all',
    '[1,2,3]',
    JSON.stringify({ type: 42, txn: ['CANTEEN-01-000001'] }),
    '',
    // a type or txn longer than 64 characters is no envelope's, and is not copied into events
    JSON.stringify({ type: 'x'.repeat(65), txn: 'T'.repeat(100_000) }),
    JSON.stringify({ type: 'y'.repeat(64), txn: 'U'.repeat(64) }),
  ];
  for (const payload of payloads) await device.publishAsync(records, payload, { qos: 1 });
  // a message the server itself sends has no sender account
  const fromServer = Buffer.from('{"type":"control.upload-journal"}');
  await new Promise((resolve, reject) => broker.aedes.publish(
    { topic: topicOf(CANTEEN_A, 'commands/control'), payload: fromServer, qos: 0, retain: false },
    (err) => (err ? reject(err) : resolve()),
  ));
  await waitFor(() => eventsOf(ctx, 'mqtt.publish').length === payloads.length + 1, { message: 'publish events' });
  const base = { from: CANTEEN_A, topic: records, retained: false };
  assert.deepEqual(eventsOf(ctx, 'mqtt.publish').map((e) => e.data), [
    { ...base, type: 'journal.batch', txn: 'BATCH-0001', bytes: Buffer.byteLength(payloads[0]) },
    { ...base, type: null, txn: null, bytes: Buffer.byteLength(payloads[1]) },
    { ...base, type: null, txn: null, bytes: Buffer.byteLength(payloads[2]) },
    { ...base, type: null, txn: null, bytes: Buffer.byteLength(payloads[3]) },
    { ...base, type: null, txn: null, bytes: 0 },
    { ...base, type: null, txn: null, bytes: Buffer.byteLength(payloads[5]) },
    { ...base, type: 'y'.repeat(64), txn: 'U'.repeat(64), bytes: Buffer.byteLength(payloads[6]) },
    {
      from: null, topic: topicOf(CANTEEN_A, 'commands/control'), type: 'control.upload-journal', txn: null,
      retained: false, bytes: fromServer.length,
    },
  ]);
  assert.ok(eventsOf(ctx, 'mqtt.publish').every((e) => e.school === A));
  // the broker's own $SYS messages (one per connect, subscribe, ...) are not reported
  assert.ok(eventsOf(ctx, 'mqtt.publish').every((e) => !e.data.topic.startsWith('$')));
});

// --- close and TLS --------------------------------------------------------------------------

test('close() disconnects everyone, frees the port, does not wait for idle sockets and can repeat', { timeout: 10_000 }, async (t) => {
  const ctx = createTestCtx();
  const broker = await startBroker(ctx, { port: 0 });
  t.after(async () => {
    await broker.close(); // (already closed when the test passes)
    ctx.db.close();
  });
  const platform = await mqtt.connectAsync(broker.url, {
    username: PLATFORM_USERNAME, password: ctx.settings.platformBrokerPassword, clientId: 'p-close', reconnectPeriod: 0,
  }, false);
  platform.on('error', () => {});
  t.after(() => platform.endAsync(true));
  const platformGone = onClose(platform);
  // a TCP connection that never sends CONNECT is unknown to aedes; close() must not wait 30 s for it
  const idle = net.connect(broker.port, '127.0.0.1');
  idle.on('error', () => {});
  t.after(() => idle.destroy());
  await new Promise((resolve) => idle.once('connect', resolve));
  const idleGone = new Promise((resolve) => idle.once('close', resolve));

  await broker.close();
  await Promise.all([platformGone, idleGone]);
  await broker.close(); // a second call is harmless
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect(broker.port, '127.0.0.1', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  }), { code: 'ECONNREFUSED' });
});

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const TLS_TEST = { ...NET, skip: hasOpenssl ? false : 'the openssl command is not available' };

test('TLS listener: the same accounts and rules over mqtts', TLS_TEST, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onecard-broker-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'broker.key');
  const certFile = path.join(dir, 'broker.crt');
  // a throwaway self-signed certificate, valid for one day, for this test only
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=onecard-lab-test-broker',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  const key = readFileSync(keyFile, 'utf8');
  const cert = readFileSync(certFile, 'utf8');

  const { ctx, broker, as, connect, refusedCode } = await setup(t, { tls: { port: 0, key, cert } });
  assert.ok(broker.tlsPort > 0);
  assert.notEqual(broker.tlsPort, broker.port);
  assert.equal(broker.tlsUrl, `mqtts://127.0.0.1:${broker.tlsPort}`);

  const platform = await connect(as.platform()); // plain TCP
  await grants(platform, ['lab/v1/+/+/records']);
  const got = inbox(platform);
  const device = await connect(as.device(CANTEEN_A), broker.tlsUrl, { ca: cert }); // checks the certificate and its IP name
  assert.equal(device.stream.encrypted, true);
  await device.publishAsync(topicOf(CANTEEN_A, 'records'), 'over TLS', { qos: 1 });
  await waitFor(() => got.length === 1, { message: 'the record sent over TLS' });
  assert.equal(got[0].payload, 'over TLS');

  // the same refusals apply over TLS
  assert.equal(await refusedCode({ ...as.device(CANTEEN_A2), password: 'wrong' }, broker.tlsUrl, { ca: cert }), 4);
  const cutOff = onClose(device);
  device.publish(topicOf(CANTEEN_A2, 'records'), 'x', { qos: 1 });
  await cutOff;
  assert.deepEqual(deniedOf(ctx), [
    [A, { username: CANTEEN_A2, action: 'connect' }],
    [A, { username: CANTEEN_A, action: 'publish', topic: topicOf(CANTEEN_A2, 'records') }],
  ]);
  // a client that does not trust the certificate gets no session at all
  await assert.rejects(mqtt.connectAsync(broker.tlsUrl, { ...as.device(CANTEEN_A2), reconnectPeriod: 0, connectTimeout: 3000 }, false));
  assert.deepEqual(broker.clients().map((c) => c.username), ['platform']);

  // a taken TLS port fails start-up after the plain listener is already up; that one is closed again
  const other = createTestCtx();
  t.after(() => other.db.close());
  assert.equal((await startFails(other, { port: 0, tls: { port: broker.tlsPort, key, cert } })).code, 'EADDRINUSE');
});
