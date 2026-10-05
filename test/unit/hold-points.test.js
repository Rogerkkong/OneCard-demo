import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf, waitFor } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { startBroker } from '../../src/broker/broker.js';
import { createHttpServer } from '../../src/http/server.js';
import { CanteenReader } from '../../src/devices/canteen.js';
import { TopupKiosk } from '../../src/devices/kiosk.js';
import { createKioskApi } from '../../src/devices/kioskApi.js';
import { VirtualCard } from '../../src/devices/card.js';

// Simulation mode's hold points across the real hops (docs/DESIGN.md §11.4), without the lab:
// a gated canteen reader and kiosk, the broker, the platform with its books and its inbox gate,
// and the web server for the kiosk API. The machine gate holds what the lab's would: only the
// messages and calls of a traced flow ('tr_hold'). After every scenario each message was
// handled exactly once, the books balance and the card equals its mirror. The demo seed's
// schools, people and cards are fictional; every secret is made per run.

const NET = { timeout: 30_000 };
const HOLD = 'tr_hold';

/** A gate that holds what `match(info)` picks, until the test lets it go. */
function holdingGate(match) {
  const gate = { waiting: [] };
  gate.fn = (info) => (match(info) ? new Promise((release) => gate.waiting.push({ info, release })) : undefined);
  gate.next = () => gate.waiting.shift()?.release();
  gate.all = () => {
    for (const w of gate.waiting.splice(0)) w.release();
  };
  return gate;
}

/**
 * The platform with the demo seed, a broker and the web server on random ports, a canteen
 * reader and a kiosk of smk-contoh behind one machine gate, and a student's card with RM 20.00
 * put on it through the real flow (a subsidy added at the kiosk). Everything is closed when the
 * test ends; anything still held is let go first.
 */
async function world(t, { heartbeatMs = 60_000 } = {}) {
  const ctx = createTestCtx();
  const platform = createPlatform(ctx);
  const seed = seedDemo(platform);
  const school = seed.schools.find((s) => s.code === 'smk-contoh');
  const member = school.members.find((m) => m.group === 'STUDENT');
  const secretOf = (code) => school.devices.find((d) => d.code === code).secret;
  const lab = { ctx, platform, server: { up: true } };
  const brokers = [];
  const startOn = async (port = 0) => {
    const broker = await startBroker(ctx, { port, resolveDevice: (username) => platform.resolveBrokerDevice(username) });
    brokers.push(broker);
    return broker;
  };
  await startOn();
  platform.setBroker(() => brokers.at(-1));
  await platform.connectMqtt(brokers.at(-1).url, { reconnectMs: 50 });
  const http = createHttpServer({ lab });
  const { url } = await http.listen(0, '127.0.0.1');

  const gate = holdingGate(() => ctx.events.context()?.trace === HOLD);
  const inbox = { held: [], match: () => false };
  platform.setInboxGate((info) => (inbox.match(info) ? new Promise((release) => inbox.held.push({ info, release })) : undefined));
  const machine = (code) => ({
    school: { code: school.code, cardKey: school.cardKey },
    device: { code, secret: secretOf(code) },
    brokerUrl: brokers[0].url,
    clock: ctx.clock,
    events: ctx.events,
    reconnectMs: 50,
    heartbeatMs,
    gate: (info) => gate.fn(info),
  });
  const reader = new CanteenReader(machine('CANTEEN-01'));
  let kiosk = null;
  const api = createKioskApi({
    baseUrl: url,
    schoolCode: school.code,
    deviceCode: 'KIOSK-01',
    secret: secretOf('KIOSK-01'),
    clock: ctx.clock,
    // the lab's wiring: no network with the server off or the kiosk's cable out
    online: () => lab.server.up && kiosk.cablePlugged,
    headers: () => ({ 'x-lab-trace': ctx.events.context()?.trace }),
  });
  kiosk = new TopupKiosk({ ...machine('KIOSK-01'), api });
  t.after(async () => {
    gate.all();
    for (const h of inbox.held.splice(0)) h.release();
    platform.setInboxGate(null);
    await reader.stop();
    await kiosk.stop();
    await platform.disconnectMqtt();
    await http.close();
    for (const b of brokers) await b.close();
    ctx.db.close();
  });
  await reader.start();
  await kiosk.start();
  await waitFor(() => reader.state.versions.blocklist > 0 && kiosk.state.versions.blocklist > 0, { message: 'the retained settings' });

  const card = new VirtualCard({ uid: member.cardUid, schoolCode: school.code, group: member.group, cardKey: school.cardKey });
  const grant = (amountSen) => platform.services.topups.grantSubsidy({ schoolId: school.id, memberId: member.id, amountSen, actor: 'test', note: 'fictional' });
  grant(2000);
  assert.equal((await kiosk.tap(card)).ok, true);

  const { ledger } = platform.services;
  return {
    ctx,
    platform,
    reader,
    kiosk,
    card,
    gate,
    inbox,
    grant,
    /** The books balance and the card equals its mirror: `{ balanced, card, mirror }`. */
    books: () => ({
      balanced: ledger.trialBalance(school.id).balanced,
      card: card.balanceSen,
      mirror: ledger.balance(school.id, 'STUDENT_WALLET', member.id),
    }),
    /** The lab's server-down: the product answers 503, the platform's link and the broker are gone. */
    async serverOff() {
      lab.server.up = false;
      await platform.disconnectMqtt();
      await brokers.at(-1).close();
    },
    async serverOn() {
      await startOn(brokers.at(-1).port);
      lab.server.up = true;
      await platform.connectMqtt(brokers.at(-1).url, { reconnectMs: 50 });
    },
  };
}

/** The intake events (accepted, duplicate or refused) of one message. */
const handled = (ctx, msgId) => ctx.events.since(0).filter((e) => e.type.startsWith('intake.') && e.data.msgId === msgId).map((e) => e.type);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const tapIn = (w, trace) => w.ctx.events.withContext({ trace }, () => w.reader.tap(w.card, { items: [{ code: 'NASI-LEMAK' }] }));

test('held at the platform while the server goes off and on: handled exactly once when let go', NET, async (t) => {
  const w = await world(t);
  w.inbox.match = (info) => info.type === 'sale.recorded';
  assert.equal((await w.reader.tap(w.card, { items: [{ code: 'NASI-LEMAK' }] })).sent, true);
  await waitFor(() => w.inbox.held.length === 1, { message: 'the sale held at the platform' });
  const { msgId } = w.inbox.held[0].info;
  await w.serverOff();
  await w.serverOn();
  await waitFor(() => w.reader.connected, { message: 'the reader back online' });
  assert.deepEqual(handled(w.ctx, msgId), []);
  w.inbox.held.shift().release();
  await waitFor(() => w.platform.inboxWaiting() === 0, { message: 'the inbox to empty' });
  await settle();
  assert.deepEqual(handled(w.ctx, msgId), ['intake.accepted']);
  assert.deepEqual(w.books(), { balanced: true, card: 1650, mirror: 1650 });
});

test('let go at the platform while its link is down: handled once, and not again once the link is back', NET, async (t) => {
  const w = await world(t);
  w.inbox.match = (info) => info.type === 'sale.recorded';
  await w.reader.tap(w.card, { items: [{ code: 'NASI-LEMAK' }] });
  await waitFor(() => w.inbox.held.length === 1, { message: 'the sale held at the platform' });
  const { msgId } = w.inbox.held[0].info;
  await w.serverOff();
  w.inbox.held.shift().release();
  await waitFor(() => w.platform.inboxWaiting() === 0, { message: 'the inbox to empty' });
  await w.serverOn();
  await waitFor(() => w.reader.connected, { message: 'the reader back online' });
  await settle();
  assert.deepEqual(handled(w.ctx, msgId), ['intake.accepted']);
  assert.deepEqual(w.books(), { balanced: true, card: 1650, mirror: 1650 });
});

test('held in the machine while its cable is pulled: kept in the journal, uploaded once after the plug', NET, async (t) => {
  const w = await world(t);
  const tapping = tapIn(w, HOLD);
  await waitFor(() => w.gate.waiting.length === 1, { message: 'the sale held in the machine' });
  await w.reader.setCable(false);
  w.gate.next();
  const sale = await tapping;
  assert.deepEqual([sale.ok, sale.sent, w.reader.state.journal.unsent], [true, false, 1]);
  await w.ctx.events.withContext({ trace: 'tr_plug' }, () => w.reader.setCable(true));
  await waitFor(() => w.reader.state.journal.unsent === 0, { message: 'the upload' });
  await settle();
  const purchases = eventsOf(w.ctx, 'purchase.received').filter((e) => JSON.stringify(e.data).includes(sale.record.txn));
  assert.equal(purchases.length, 1);
  assert.deepEqual(w.books(), { balanced: true, card: 1650, mirror: 1650 });
});

test('held in the machine while untraced heartbeats go by: the sale goes out under a newer seq and is accepted', NET, async (t) => {
  const w = await world(t, { heartbeatMs: 30 });
  const tapping = tapIn(w, HOLD);
  await waitFor(() => w.gate.waiting.length === 1, { message: 'the sale held in the machine' });
  const { seq, msgId } = w.gate.waiting[0].info;
  await waitFor(() => w.reader.state.seq > seq + 1, { message: 'heartbeats going by' });
  w.gate.next();
  assert.equal((await tapping).sent, true);
  await waitFor(() => handled(w.ctx, msgId).length === 1, { message: 'the sale at the platform' });
  assert.deepEqual(handled(w.ctx, msgId), ['intake.accepted']);
  assert.deepEqual(eventsOf(w.ctx, 'intake.refused'), []);
  assert.deepEqual(w.books(), { balanced: true, card: 1650, mirror: 1650 });
});

test('a kiosk confirm held while the server goes off: the money waits on the card, and the next tap settles it', NET, async (t) => {
  const w = await world(t);
  w.grant(500);
  const tapping = w.ctx.events.withContext({ trace: HOLD }, () => w.kiosk.tap(w.card));
  // the read-back, then the pending call, go on; the confirm waits
  for (;;) {
    await waitFor(() => w.gate.waiting.length === 1, { message: 'the next hold' });
    const { info } = w.gate.waiting[0];
    if (info.kind === 'http' && info.call === 'confirm') break;
    w.gate.next();
  }
  assert.equal(w.card.balanceSen, 2500); // written; only its report waits
  await w.serverOff();
  w.gate.next(); // the confirm: no network
  await waitFor(() => w.gate.waiting.length === 1, { message: 'the lookup held' });
  w.gate.next(); // the lookup: no network either
  const tap = await tapping;
  assert.deepEqual([tap.ok, tap.added.map((a) => a.confirmed)], [true, [false]]);
  await w.serverOn();
  await waitFor(() => w.kiosk.connected, { message: 'the kiosk back online' });
  const next = await w.kiosk.tap(w.card);
  assert.deepEqual(next.reconfirmed.map((r) => r.result), ['CONFIRMED']);
  await settle();
  assert.deepEqual(w.books(), { balanced: true, card: 2500, mirror: 2500 });
});

test('a read-back and a sale held at the platform, let go out of order: the same record once, no false difference', NET, async (t) => {
  const w = await world(t);
  w.grant(700);
  w.inbox.match = (info) => info.type === 'sale.recorded' || info.type === 'card.readback';
  const sale = await w.reader.tap(w.card, { items: [{ code: 'NASI-LEMAK' }] });
  // the kiosk adds RM 7.00 over HTTP while its read-back (carrying the sale) waits at the platform
  const tap = await w.kiosk.tap(w.card);
  assert.deepEqual(tap.added.map((a) => [a.amountSen, a.confirmed]), [[700, true]]);
  await waitFor(() => w.inbox.held.length === 2, { message: 'both held' });
  for (const type of ['card.readback', 'sale.recorded']) w.inbox.held.find((h) => h.info.type === type).release();
  await waitFor(() => w.platform.inboxWaiting() === 0, { message: 'the inbox to empty' });
  await settle();
  assert.deepEqual(eventsOf(w.ctx, 'difference.opened'), []);
  const posted = eventsOf(w.ctx, 'ledger.posting').filter((e) => JSON.stringify(e.data).includes(sale.record.txn));
  assert.equal(posted.length, 1, 'the purchase is in the books once');
  assert.deepEqual(w.books(), { balanced: true, card: 2350, mirror: 2350 });
});

test('a hold that calls back twice lets its message go once, at the machine and at the platform', NET, async (t) => {
  const w = await world(t);
  const fired = [];
  /** A thenable that, once fired, calls its callback twice. */
  const callsBackTwice = (info) => ({
    then(onDone) {
      fired.push({
        info,
        fire() {
          onDone();
          onDone();
        },
      });
    },
  });
  const sales = (info) => (info.type === 'sale.recorded' ? callsBackTwice(info) : undefined);
  w.gate.fn = sales;
  w.platform.setInboxGate(sales);
  const tapping = w.reader.tap(w.card, { items: [{ code: 'NASI-LEMAK' }] });
  await waitFor(() => fired.length === 1, { message: 'the machine hold' });
  const { msgId } = fired[0].info;
  fired.shift().fire();
  assert.equal((await tapping).sent, true);
  await waitFor(() => fired.length === 1, { message: 'the platform hold' });
  assert.equal(fired[0].info.msgId, msgId);
  fired.shift().fire();
  await waitFor(() => w.platform.inboxWaiting() === 0, { message: 'the inbox to empty' });
  await settle();
  assert.equal(eventsOf(w.ctx, 'device.send').filter((e) => e.data.msgId === msgId).length, 1);
  assert.deepEqual(handled(w.ctx, msgId), ['intake.accepted']);
  assert.deepEqual(w.books(), { balanced: true, card: 1650, mirror: 1650 });
});
