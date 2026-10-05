import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mqtt from 'mqtt';
import { startBroker } from '../../src/broker/broker.js';
import { TopupKiosk } from '../../src/devices/kiosk.js';
import { AdminCard } from '../../src/devices/adminCard.js';
import { VirtualCard } from '../../src/devices/card.js';
import { KioskApiError, createKioskApi } from '../../src/devices/kioskApi.js';
import { brokerPassword, cardDigest, randomSecret } from '../../src/shared/crypto.js';
import { deviceTxnNo, topicFor } from '../../src/shared/protocol.js';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';

// Simulation mode at the top-up kiosk (docs/DESIGN.md §11.2, §11.4): every API call passes the
// machine's hold point and is reported as device.http, every read of the card is a card.read
// step, and the kiosk API client hears from the lab whether there is a network and which
// extra headers to send. Fictional school, cards and orders; secrets are generated per run.

const A = 'smk-alpha';
const B = 'smk-beta';
const UID = '04A13B5C7D2E80';
const KIOSK = { code: 'KIOSK-01', secret: randomSecret() };
const NET = { timeout: 20_000 };
const K = (n) => deviceTxnNo('KIOSK-01', n);
const route = (call) =>
  ({
    pending: { method: 'POST', path: '/api/kiosk/pending' },
    confirm: { method: 'POST', path: '/api/kiosk/confirm' },
    packs: { method: 'GET', path: '/api/kiosk/packs' },
    receipts: { method: 'POST', path: '/api/kiosk/admin-card/receipts' },
  })[call];

/** A stand-in for the platform's top-up orders, without books: orders wait, a confirm adds them. */
function fakeApi(cardKey) {
  const digest = cardDigest(cardKey, A, UID);
  const orders = new Map();
  const calls = [];
  const failures = { pending: [], confirm: [], lookup: [], packs: [], receipts: [] };
  let n = 0;
  const fail = (method) => {
    const err = failures[method].shift();
    if (err) throw err;
  };
  return {
    digest,
    calls,
    orders,
    pay(amountSen) {
      n += 1;
      orders.set(`ord_${n}`, { orderId: `ord_${n}`, amountSen, status: 'PAID', kioskTxn: null });
      return `ord_${n}`;
    },
    failNext(method, err) {
      failures[method].push(err);
    },
    api: {
      async pending(args) {
        calls.push('pending');
        fail('pending');
        const waiting = [...orders.values()].filter((o) => o.status === 'PAID' && args.card === digest);
        const listed = waiting.map((o) => ({ orderId: o.orderId, kind: 'TOPUP', amountSen: o.amountSen }));
        return { member: { id: 'mem_1', name: 'Test Student' }, orders: listed, mirrorBalanceSen: 0, waitingSen: 0 };
      },
      async confirm(args) {
        calls.push('confirm');
        fail('confirm');
        const o = orders.get(args.orderId);
        if (args.result === 'ADDED') Object.assign(o, { status: 'ADDED', kioskTxn: args.kioskTxn });
        return { orderId: o.orderId, status: o.status, duplicate: false };
      },
      async lookup(kioskTxn) {
        calls.push('lookup');
        fail('lookup');
        const o = [...orders.values()].find((x) => x.kioskTxn === kioskTxn);
        return o ? { orderId: o.orderId, status: o.status } : null;
      },
      async packs() {
        calls.push('packs');
        fail('packs');
        return { token: 1, school: A, packs: [] };
      },
      async receipts(args) {
        calls.push('receipts');
        fail('receipts');
        return { recorded: args.receipts.length };
      },
    },
  };
}

/**
 * A broker, a raw MQTT client as the platform, and a started kiosk with the fake API (or the
 * given one) and a gate that records every hold point and holds what `hold(info, ctx)` picks.
 */
async function setup(t, { plugged = true, hold = () => false, api } = {}) {
  const ctx = createTestCtx();
  const cardKey = randomSecret();
  const platform = fakeApi(cardKey);
  const broker = await startBroker(ctx, {
    port: 0,
    resolveDevice: (u) => (u === `${A}.KIOSK-01` ? { schoolCode: A, deviceCode: 'KIOSK-01', password: brokerPassword(KIOSK.secret), active: true } : null),
  });
  const client = await mqtt.connectAsync(broker.url, { username: 'platform', password: ctx.settings.platformBrokerPassword, clientId: 'platform-test', reconnectPeriod: 0 });
  client.on('error', () => {});
  const inbox = [];
  client.on('message', (topic, payload) => inbox.push({ topic, env: JSON.parse(payload.toString()) }));
  await client.subscribeAsync([`lab/v1/${A}/+/records`], { qos: 1 });
  const gate = { calls: [], waiting: [] };
  gate.releaseOne = () => gate.waiting.shift()?.release();
  const kiosk = new TopupKiosk({
    school: { code: A, cardKey },
    device: KIOSK,
    brokerUrl: broker.url,
    clock: ctx.clock,
    events: ctx.events,
    api: api ? api(ctx, () => kiosk) : platform.api,
    cablePlugged: plugged,
    gate: (info) => {
      gate.calls.push(info);
      if (!hold(info, ctx)) return undefined;
      return new Promise((resolve) => gate.waiting.push({ info, release: resolve }));
    },
  });
  t.after(async () => {
    while (gate.waiting.length > 0) gate.releaseOne();
    await kiosk.stop();
    await client.endAsync(true);
    await broker.close();
    ctx.db.close();
  });
  kiosk.provision({ blocklist: { version: 3, entries: [] } });
  await kiosk.start();
  const newCard = (balanceSen = 0) => {
    const card = new VirtualCard({ uid: UID, schoolCode: A, cardKey });
    if (balanceSen > 0) card.credit({ cardKey, amountSen: balanceSen, write: { orderId: 'ord_old', kioskTxn: 'KIOSK-09-000001', at: ctx.clock.iso() } });
    return card;
  };
  return { ctx, platform, kiosk, inbox, gate, newCard, cardKey };
}

/** device.http data without its timing (checked on its own). */
const httpEvents = (ctx) =>
  eventsOf(ctx, 'device.http').map((e) => {
    assert.ok(Number.isSafeInteger(e.data.ms) && e.data.ms >= 0, 'ms');
    assert.equal(e.school, A);
    const { ms: _ms, ...rest } = e.data;
    return rest;
  });
const http200 = (call) => ({ device: 'KIOSK-01', call, ...route(call), status: 200, ok: true });

describe('the kiosk hold point', () => {
  test('the gate is asked before every API call, in the order the kiosk makes them, which does not change', NET, async (t) => {
    const { ctx, platform, kiosk, inbox, gate, newCard } = await setup(t);
    const first = platform.pay(2000);
    const second = platform.pay(500);
    gate.calls.length = 0; // the heartbeat on connect
    const result = await kiosk.tap(newCard(1000));
    assert.deepEqual(result.added.map((a) => [a.orderId, a.kioskTxn, a.confirmed]), [[first, K(1), true], [second, K(2), true]]);
    const readback = await waitFor(() => inbox.find((m) => m.env.type === 'card.readback'), { message: 'the read-back' });

    const at = { device: 'KIOSK-01', school: A };
    assert.deepEqual(gate.calls, [
      { kind: 'publish', ...at, type: 'card.readback', msgId: readback.env.id, seq: readback.env.seq, topic: topicFor(A, 'KIOSK-01', 'records') },
      { kind: 'http', ...at, call: 'pending', ...route('pending') },
      { kind: 'http', ...at, call: 'confirm', ...route('confirm') },
      { kind: 'http', ...at, call: 'confirm', ...route('confirm') },
    ]);
    assert.deepEqual(platform.calls, ['pending', 'confirm', 'confirm']);
    assert.deepEqual(httpEvents(ctx), [http200('pending'), http200('confirm'), http200('confirm')]);
  });

  test('a held API call waits for its release; the kiosk does nothing meanwhile', NET, async (t) => {
    const { ctx, platform, kiosk, gate, newCard } = await setup(t, { hold: (info) => info.kind === 'http' });
    platform.pay(2000);
    const card = newCard(1000);
    const tapping = kiosk.tap(card);
    await waitFor(() => gate.waiting.length === 1, { message: 'pending to be held' });
    assert.equal(gate.waiting[0].info.call, 'pending');
    assert.deepEqual([platform.calls, eventsOf(ctx, 'device.http')], [[], []]);
    gate.releaseOne();
    await waitFor(() => gate.waiting.length === 1, { message: 'the confirm to be held' });
    assert.equal(gate.waiting[0].info.call, 'confirm');
    assert.deepEqual(platform.calls, ['pending']);
    assert.equal(card.balanceSen, 3000); // written: only its report waits
    gate.releaseOne();
    const result = await tapping;
    assert.deepEqual([result.ok, result.added.length, platform.calls], [true, 1, ['pending', 'confirm']]);
  });
});

describe('device.http and the card steps', () => {
  test('success, no network, a refusal, a lookup that found nothing, and the confirm that never arrived', NET, async (t) => {
    const { ctx, platform, kiosk, newCard } = await setup(t);
    const card = newCard(1000);
    const at = { device: 'KIOSK-01' };
    platform.failNext('pending', new KioskApiError('NETWORK', 503, 'no answer', { timedOut: true }));
    assert.equal((await kiosk.tap(card)).reason, 'PLATFORM_UNREACHABLE');
    platform.failNext('pending', new KioskApiError('CARD_NOT_ACTIVE', 409, 'this card is not active'));
    assert.equal((await kiosk.tap(card)).reason, 'CARD_NOT_ACTIVE');
    assert.deepEqual(httpEvents(ctx), [
      { ...at, call: 'pending', ...route('pending'), status: 0, ok: false, code: 'NETWORK' },
      { ...at, call: 'pending', ...route('pending'), status: 409, ok: false, code: 'CARD_NOT_ACTIVE' },
    ]);

    // the lab fault: the first confirm is lost on the way, the lookup finds nothing, the confirm goes again
    const mark = ctx.events.lastSeq();
    platform.pay(2000);
    const result = await kiosk.tap(card, { fault: 'confirm-timeout' });
    assert.deepEqual(result.added.map((a) => a.confirmed), [true]);
    const lost = ctx.events.since(mark).filter((e) => e.type === 'device.http').map(({ data: { ms: _ms, ...rest } }) => rest);
    assert.deepEqual(lost, [
      http200('pending'),
      { ...at, call: 'confirm', ...route('confirm'), status: 0, ok: false, code: 'NETWORK', fault: 'confirm-timeout' },
      { ...at, call: 'lookup', method: 'GET', path: `/api/kiosk/confirm/${K(1)}`, status: 404, ok: true },
      http200('confirm'),
    ]);
    assert.deepEqual(platform.calls.slice(-3), ['pending', 'lookup', 'confirm']); // the lost one never reached it
  });

  test('every read of the card is a card.read step: before the read-back, and again before each write', NET, async (t) => {
    const { ctx, platform, kiosk, newCard } = await setup(t);
    platform.pay(2000);
    platform.pay(500);
    await kiosk.tap(newCard(1000));
    const read = (balanceSen, cardSeq) => ({ device: 'KIOSK-01', step: 'card.read', ok: true, last4: '2E80', balanceSen, cardSeq, records: 0, listVersionOnCard: 0 });
    assert.deepEqual(eventsOf(ctx, 'device.step').filter((e) => e.data.step === 'card.read').map((e) => e.data), [read(1000, 1), read(1000, 1), read(3000, 2)]);

    const damaged = newCard(1000);
    damaged.tamper({ balanceSen: 99_999 });
    const theirs = new VirtualCard({ uid: UID, schoolCode: B, cardKey: randomSecret() });
    for (const [card, reason] of [[damaged, 'CARD_UNREADABLE'], [theirs, 'WRONG_SCHOOL']]) {
      assert.equal((await kiosk.tap(card)).reason, reason);
      assert.deepEqual(eventsOf(ctx, 'device.step').at(-1).data, { device: 'KIOSK-01', step: 'card.read', ok: false, reason });
    }
  });

  test('offline: nothing is tried, and the offline step says what was not sent', NET, async (t) => {
    const { ctx, platform, kiosk, newCard } = await setup(t, { plugged: false });
    const adminCard = new AdminCard({ schoolCode: A });
    assert.equal((await kiosk.tap(newCard(1000))).reason, 'OFFLINE');
    assert.equal((await kiosk.loadAdminCard(adminCard)).reason, 'OFFLINE');
    assert.equal((await kiosk.uploadAdminCardReceipts(adminCard)).reason, 'OFFLINE');
    const offline = (fields) => ({ device: 'KIOSK-01', step: 'offline', ok: false, ...fields });
    assert.deepEqual(eventsOf(ctx, 'device.step').map((e) => e.data), [offline({ type: 'card.readback' }), offline({ call: 'packs' }), offline({ call: 'receipts' })]);
    assert.deepEqual([platform.calls, eventsOf(ctx, 'device.http')], [[], []]);
  });
});

describe('with the signed kiosk API over HTTP', () => {
  /** A platform stand-in that answers pending (nothing waiting) and keeps what it got. */
  async function fakeServer(t) {
    const requests = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ member: { id: 'mem_1', name: 'Test Student' }, orders: [], mirrorBalanceSen: 1000, waitingSen: 0 }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    return { url: `http://127.0.0.1:${server.address().port}`, requests };
  }

  test("the lab's wiring: the flow's trace rides as a header; with the cable out a released call fails as NETWORK without going out", NET, async (t) => {
    const server = await fakeServer(t);
    const { ctx, kiosk, gate, newCard } = await setup(t, {
      hold: (info, c) => info.kind === 'http' && c.events.context()?.trace === 'tr_hold',
      api: (c, machine) =>
        createKioskApi({
          baseUrl: server.url,
          schoolCode: A,
          deviceCode: 'KIOSK-01',
          secret: KIOSK.secret,
          clock: c.clock,
          online: () => machine().cablePlugged,
          headers: () => ({ 'x-lab-trace': c.events.context()?.trace }),
        }),
    });
    const card = newCard(1000);
    const done = await ctx.events.withContext({ trace: 'tr_k' }, () => kiosk.tap(card));
    assert.equal(done.screen, 'Nothing to add · Balance RM 10.00');
    assert.deepEqual(server.requests.map((r) => [r.method, r.url, r.headers['x-lab-trace']]), [['POST', '/api/kiosk/pending', 'tr_k']]);
    assert.equal(eventsOf(ctx, 'device.http').at(-1).trace, 'tr_k');
    await kiosk.tap(card); // outside any flow: no header at all
    assert.equal('x-lab-trace' in server.requests[1].headers, false);

    const tapping = ctx.events.withContext({ trace: 'tr_hold' }, () => kiosk.tap(card));
    await waitFor(() => gate.waiting.length === 1, { message: 'pending to be held' });
    await kiosk.setCable(false);
    gate.releaseOne();
    const refused = await tapping;
    assert.deepEqual([refused.reason, refused.error], ['PLATFORM_UNREACHABLE', 'NETWORK']);
    assert.equal(server.requests.length, 2);
    const last = eventsOf(ctx, 'device.http').at(-1);
    assert.deepEqual([last.trace, last.data.status, last.data.code], ['tr_hold', 0, 'NETWORK']);
  });
});
