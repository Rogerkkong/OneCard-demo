import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { BROKER_STATUS_CODES, createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// Live stepping in the lab (docs/DESIGN.md §11.4), at its awkward moments: Next pressed while
// the server goes down or the broker restarts (and either one while the broker is passing an
// acknowledged sale on), hold switched on or off while the server comes up, two machines held
// at once, a held admin-card load with a visit queued behind it, a kiosk's confirm held while
// the server goes off, a held clock move, and a reset or stop with flows held at every hop (or
// held while it waits for the lab). After each one every record is home exactly once, every
// school's books balance and every card equals its mirror, and nothing is left held. Then the
// follow-ups of §11.7: the broker's logins and logouts in the flow that caused them, the
// broker.status codes, and the subject every kind of flow names. A real lab: the demo seed
// (fictional schools, people and cards), broker and web server on random ports, the lab clock
// standing still.

const NET = { timeout: 60_000 };
const SMK = 'smk-contoh';
const SJKC = 'sjkc-contoh';
const AHMAD = '04A13B5C7D2E80'; // S1001: RM 30.00 on the card, RM 20.00 waiting
const LEE = '04B2194E6A3C81'; // S1002: RM 25.00
const ARJUN = '04C35D2F8B1A82'; // S1003: RM 40.00
const JUN_HAO = '0418B47ED06F87'; // sjkc-contoh P101: RM 20.00

let lab;
const errors = [];
const labLog = (level, message, meta) => {
  if (level === 'error') errors.push(`${message} ${JSON.stringify(meta ?? {})}`);
};

before(async () => {
  // machines retry the broker after 100 ms (doubling): back soon after the server is on again
  lab = createLab({ clockMode: 'manual', httpPort: 0, mqttPort: 0, consolePort: 0, jobsMs: 0, reconnectMs: 100, log: labLog });
  await lab.start();
});

// whatever a scenario left held (a failed one too), the next one starts in realtime
afterEach(() => {
  if (lab?.phase === 'running') lab.setSim({ mode: 'realtime' });
});

after(async () => {
  await lab?.stop();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const items = (...codes) => codes.map((code) => ({ code, qty: 1 }));
const tap = (deviceCode, uid, more = {}) => lab.tap({ schoolCode: SMK, deviceCode, uid, ...more });
const machine = (key) => lab.terminals.get(key.includes('/') ? key : `${SMK}/${key}`);
const eventsSince = (mark, type, match = () => true) => lab.ctx.events.since(mark).filter((e) => e.type === type && match(e));
const inTrace = (id, type, match = () => true) => (lab.tracer.get(id)?.events ?? []).filter((e) => e.type === type && match(e));
const heldNow = (match = () => true) => lab.simState().held.filter(match);
/** A purchase's verdicts at the platform since `mark`: [[status, via]] (both schools' readers are CANTEEN-01). */
const verdicts = (mark, txn, school = SMK) =>
  eventsSince(mark, 'purchase.received', (e) => e.school === school && e.data.txn === txn).map((e) => [e.data.status, e.data.via]);

/** Press Next until `predicate` holds (each press lets the oldest waiting hop go on). */
async function stepUntil(predicate, message) {
  await waitFor(
    () => {
      if (predicate()) return true;
      lab.simNext();
      return false;
    },
    { timeout: 15_000, interval: 25, message },
  );
}

/** Every record home (cables in, journals uploaded), every school's books balance, every card equals its mirror, nothing held. */
async function booksBalance() {
  for (const m of lab.terminals.values()) {
    if (!m.cablePlugged) await lab.setCable({ schoolCode: m.schoolCode, deviceCode: m.deviceCode, plugged: true });
  }
  await waitFor(() => [...lab.terminals.values()].every((m) => m.connected && m.state.journal.unsent === 0), {
    timeout: 20_000,
    message: 'every machine connected with its journal uploaded',
  });
  await waitFor(() => lab.checkBooks().ok && lab.platform.inboxWaiting() === 0, { timeout: 5000, message: 'every card equal to its mirror' });
  for (const s of lab.checkBooks().schools) assert.equal(s.balanced, true, `${s.code} trial balance`);
  assert.deepEqual(lab.simState().held, []);
  assert.deepEqual(errors, []);
}

/**
 * Run `fn` the next time the lab takes the platform off the broker, right after the platform has
 * left (the person presses Next at that moment), and give it `ms` to have its effect.
 */
function onPlatformLeaving(fn, ms = 150) {
  const leave = lab.platform.disconnectMqtt;
  lab.platform.disconnectMqtt = async (...args) => {
    lab.platform.disconnectMqtt = leave;
    const done = await leave(...args);
    fn();
    await sleep(ms);
    return done;
  };
  return () => {
    lab.platform.disconnectMqtt = leave;
  };
}

// ---- Next at the moment the server goes down -------------------------------------------------

test('Next pressed as the server goes off: the released sale stays in the machine, never acknowledged and lost', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  lab.setSim({ mode: 'simulation', hold: true });
  const sale = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  assert.equal(sale.held, true);
  // The worst moment: the platform has just left the broker. A broker still running then would
  // acknowledge the record (the reader counts it as sent) and keep it for the platform in a
  // queue that dies with it: RM 1.50 off the card, never in the books.
  const restore = onPlatformLeaving(() => lab.simNext());
  try {
    assert.equal((await lab.setServer({ up: false })).server.up, false);
  } finally {
    restore();
  }
  await waitFor(() => inTrace(sale.trace, 'lab.action').length === 1, { message: 'the tap to finish' });
  assert.ok(eventsSince(mark, 'device.acked', (e) => e.data.msgId === sale.item.msgId).every((e) => e.data.ok === false), 'nobody acknowledged it');
  assert.equal(machine('CANTEEN-01').state.journal.unsent, 1, 'the record waits in the journal');

  lab.setSim({ mode: 'realtime' });
  await lab.setServer({ up: true });
  await booksBalance();
  assert.deepEqual(verdicts(mark, sale.item.txn), [['POSTED', 'JOURNAL_BATCH']], 'uploaded once the server is back, counted once');
});

test('Next pressed during a broker restart: the old broker takes nothing it can no longer deliver', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  lab.setSim({ mode: 'simulation', hold: true });
  const sale = await tap('CANTEEN-01', ARJUN, { items: items('MEE-GORENG') });
  assert.equal(sale.held, true);
  const restore = onPlatformLeaving(() => lab.simNext());
  let restarted;
  try {
    restarted = await lab.restartBroker();
  } finally {
    restore();
  }
  assert.match(restarted.trace, /^tr_/);
  await waitFor(() => inTrace(sale.trace, 'lab.action').length === 1, { message: 'the tap to finish' });
  assert.ok(eventsSince(mark, 'device.acked', (e) => e.data.msgId === sale.item.msgId).every((e) => e.data.ok === false), 'nobody acknowledged it');

  // back on the new broker, the reader uploads it in the restart's flow
  lab.setSim({ mode: 'realtime' });
  await booksBalance();
  assert.deepEqual(verdicts(mark, sale.item.txn), [['POSTED', 'JOURNAL_BATCH']]);
});

/**
 * Tap a sale on CANTEEN-01 and run `action` at the worst moment for it: the broker has
 * acknowledged the sale (aedes sends the PUBACK first, so the reader marks it sent) and is
 * about to pass it on to the platform. @returns {Promise<object>} the tap's answer
 */
async function saleWhileThe(action) {
  const persistence = lab.broker.aedes.persistence;
  const enqueue = persistence.outgoingEnqueueCombi;
  let done = null;
  persistence.outgoingEnqueueCombi = function onItsWay(subs, packet, ...rest) {
    if (done === null && String(packet.payload).includes('"sale.recorded"')) done = action();
    return enqueue.call(this, subs, packet, ...rest);
  };
  try {
    const sale = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
    assert.ok(done, 'the action ran while the sale was on its way');
    await done;
    return sale;
  } finally {
    persistence.outgoingEnqueueCombi = enqueue;
  }
}

test('the server goes off while the broker passes a sale on: what it acknowledged still reaches the books', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  const sale = await saleWhileThe(() => lab.setServer({ up: false }));
  assert.equal(sale.sent, true, 'the reader counts it as sent');
  await lab.setServer({ up: true });
  await booksBalance();
  assert.deepEqual(verdicts(mark, sale.record.txn), [['POSTED', 'MQTT']]);
});

test('the broker restarts while it passes a sale on: what it acknowledged still reaches the books', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  const sale = await saleWhileThe(() => lab.restartBroker());
  assert.equal(sale.sent, true, 'the reader counts it as sent');
  await booksBalance();
  assert.deepEqual(verdicts(mark, sale.record.txn), [['POSTED', 'MQTT']]);
});

test('Next and server off at once, again and again: every sale reaches the books exactly once', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  const txns = [];
  for (let i = 0; i < 3; i++) {
    lab.ctx.clock.advance(5000); // past the card's tap gap
    lab.setSim({ mode: 'simulation', hold: true });
    const sale = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
    assert.equal(sale.held, true);
    txns.push(sale.item.txn);
    lab.setSim({ mode: 'realtime' }); // lets the sale go...
    await lab.setServer({ up: false }); // ...while the server goes off
    await lab.setServer({ up: true });
    await booksBalance();
  }
  for (const txn of txns) assert.equal(verdicts(mark, txn).filter(([status]) => status === 'POSTED').length, 1, txn);
});

// ---- hold switched on while the server comes up ----------------------------------------------

test('hold switched on while the server comes up: the machines\' first heartbeat and upload wait, then go home once', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  await lab.setServer({ up: false });
  const offline = await tap('CANTEEN-01', LEE, { items: items('TEH-TARIK') });
  assert.deepEqual([offline.ok, offline.sent], [true, false]);
  const txn = offline.record.txn;

  const coming = lab.setServer({ up: true });
  lab.setSim({ mode: 'simulation', hold: true }); // while the server is still coming up
  const on = await coming;
  assert.match(on.trace, /^tr_/);
  // the reader's first heartbeat on the new broker belongs to the server's flow and waits at its outbox
  await waitFor(() => heldNow((h) => h.trace === on.trace && h.school === SMK && h.device === 'CANTEEN-01').length > 0, {
    timeout: 10_000,
    message: "CANTEEN-01's first post-connect message held in the server-up flow",
  });
  assert.deepEqual(verdicts(mark, txn), []);
  await stepUntil(() => verdicts(mark, txn).length > 0, 'the record uploaded through every hop');
  assert.deepEqual(verdicts(mark, txn), [['POSTED', 'JOURNAL_BATCH']]);
  assert.equal(eventsSince(mark, 'purchase.received', (e) => e.school === SMK && e.data.txn === txn)[0].trace, on.trace, 'in the server-up flow');

  lab.setSim({ mode: 'realtime' });
  await booksBalance();
  assert.deepEqual(verdicts(mark, txn), [['POSTED', 'JOURNAL_BATCH']], 'counted once');
});

test('hold switched off while the server comes up: nothing stays held, and the sale kept offline reaches the books', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  lab.setSim({ mode: 'simulation', hold: true });
  await lab.setServer({ up: false });
  const offline = await tap('CANTEEN-01', LEE, { items: items('TEH-TARIK') });
  assert.deepEqual([offline.ok, offline.sent], [true, false]);

  // The platform is back on the broker, but the switch has not finished: the machines log in and
  // answer the settings it republished, and their acks wait at its door. Hold goes off right then.
  const connect = lab.platform.connectMqtt;
  lab.platform.connectMqtt = async (...args) => {
    lab.platform.connectMqtt = connect;
    const done = await connect(...args);
    await waitFor(() => heldNow((h) => h.where === 'platform').length > 0, {
      timeout: 15_000,
      message: 'an ack held at the platform while the server comes up',
    });
    lab.setSim({ hold: false });
    return done;
  };
  try {
    await lab.setServer({ up: true });
  } finally {
    lab.platform.connectMqtt = connect;
  }
  // hold is off: nothing may wait for a Next nobody is going to press, nor the sale behind it
  await waitFor(() => heldNow().length === 0, { message: 'nothing held once hold is off' });
  await booksBalance();
  assert.deepEqual(verdicts(mark, offline.record.txn), [['POSTED', 'JOURNAL_BATCH']]);
});

// ---- two machines at once ----------------------------------------------------------------------

test('two machines held at once: one loses its cable, the other goes on through the platform; both sales counted once', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  lab.setSim({ mode: 'simulation', hold: true });
  const here = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  const there = await lab.tap({ schoolCode: SJKC, deviceCode: 'CANTEEN-01', uid: JUN_HAO, items: items('BUAH') });
  assert.deepEqual([here.held, there.held], [true, true]);
  assert.deepEqual(heldNow().map((h) => [h.school, h.device, h.where]), [[SMK, 'CANTEEN-01', 'machine'], [SJKC, 'CANTEEN-01', 'machine']]);

  // smk-contoh's reader loses its cable while its sale waits; Next goes oldest first
  await lab.setCable({ schoolCode: SMK, deviceCode: 'CANTEEN-01', plugged: false });
  assert.equal(lab.simNext().released.id, here.item.id);
  await waitFor(() => inTrace(here.trace, 'device.step', (e) => e.data.step === 'offline').length === 1, { message: 'the first sale kept offline' });
  assert.equal(lab.simNext().released.id, there.item.id);
  await waitFor(() => heldNow((h) => h.trace === there.trace && h.where === 'platform').length === 1, { message: "the other school's sale at the platform" });
  assert.deepEqual(verdicts(mark, there.item.txn, SJKC), []);
  lab.simNext();
  await waitFor(() => verdicts(mark, there.item.txn, SJKC).length === 1, { message: "the other school's sale in its books" });
  assert.deepEqual(verdicts(mark, there.item.txn, SJKC), [['POSTED', 'MQTT']]);
  assert.deepEqual(verdicts(mark, here.item.txn), [], 'the first one still waits in its reader');

  // the cable back: the kept sale goes up through the hops of the plug's flow
  const plug = await lab.setCable({ schoolCode: SMK, deviceCode: 'CANTEEN-01', plugged: true });
  assert.equal(plug.held, true);
  await stepUntil(() => verdicts(mark, here.item.txn).length > 0, 'the kept sale uploaded');
  assert.deepEqual(verdicts(mark, here.item.txn), [['POSTED', 'JOURNAL_BATCH']]);
  lab.setSim({ mode: 'realtime' });
  await booksBalance();
});

// ---- the kiosk's queue and the admin card ----------------------------------------------------------

test('a held admin-card load holds the kiosk: a visit waits behind it, then both go on with Next and the money adds up', NET, async () => {
  await lab.reset();
  lab.setSim({ mode: 'simulation', hold: true });
  const load = await lab.adminCardLoad({ schoolCode: SMK });
  assert.equal(load.held, true);
  assert.deepEqual([load.item.where, load.item.call, load.item.method, load.item.path], ['kiosk-http', 'packs', 'GET', '/api/kiosk/packs']);
  assert.deepEqual([load.machine, load.adminCard.token], [`${SMK}/KIOSK-01`, 0], 'nothing loaded yet');

  // the kiosk serves one card at a time: the student's visit waits for the admin card
  let answered = null;
  const visit = tap('KIOSK-01', AHMAD).then((answer) => (answered = answer));
  await sleep(200);
  assert.equal(answered, null, 'the visit waits its turn');
  assert.deepEqual(heldNow().map((h) => h.trace), [load.trace]);

  // Next: the packs come, the card is loaded, and the visit starts (and waits at its first hop)
  lab.simNext();
  await visit;
  assert.equal(answered.held, true);
  await waitFor(() => lab.adminCards.get(SMK).token > 0, { message: 'the admin card loaded' });
  assert.ok(lab.adminCards.get(SMK).memory.packs.length >= 3);
  await stepUntil(() => inTrace(answered.trace, 'lab.action').length === 1, 'the visit to finish');
  assert.deepEqual(inTrace(answered.trace, 'lab.action').map((e) => [e.data.ok, e.data.screen]), [[true, 'Added RM 20.00 · Balance RM 50.00']]);
  lab.setSim({ mode: 'realtime' });
  await booksBalance();
});

test('a held confirm and the server off: the money written on the card is reported at the next visit', NET, async () => {
  await lab.reset();
  lab.setSim({ mode: 'simulation', hold: true });
  const visit = await tap('KIOSK-01', AHMAD);
  assert.deepEqual([visit.held, visit.item.type], [true, 'card.readback']);
  await stepUntil(() => heldNow((h) => h.trace === visit.trace && h.call === 'confirm').length === 1, 'the confirm call held');
  assert.equal(lab.cards.get(`${SMK}/${AHMAD}`).balanceSen, 5000, 'on the card already');

  // the server goes off before the kiosk could report the write: no answer, and none to the lookup
  await lab.setServer({ up: false });
  await stepUntil(() => inTrace(visit.trace, 'lab.action').length === 1, 'the visit to finish');
  assert.deepEqual(inTrace(visit.trace, 'device.http').map((e) => [e.data.call, e.data.status]), [['pending', 200], ['confirm', 0], ['lookup', 0]]);
  assert.equal(lab.checkBooks().ok, true, 'the books leave the unreported write out');

  // the server on again: the next visit reports it, and the card equals its mirror
  lab.setSim({ mode: 'realtime' });
  await lab.setServer({ up: true });
  await waitFor(() => machine('KIOSK-01').connected, { timeout: 15_000, message: 'the kiosk back on the broker' });
  const again = await tap('KIOSK-01', AHMAD);
  assert.deepEqual([again.screen, again.reconfirmed.map((r) => r.result)], ['Nothing to add · Balance RM 50.00', ['CONFIRMED']]);
  await booksBalance();
  const card = lab.checkBooks().schools.find((s) => s.code === SMK).cards.find((c) => c.uid === AHMAD);
  assert.deepEqual([card.cardSen, card.mirrorSen, card.unconfirmedSen], [5000, 5000, 0]);
});

test('a held clock move answers with the new time at once; its heartbeats go on with Next', NET, async () => {
  await lab.reset();
  const before = lab.state().clock.now;
  lab.setSim({ mode: 'simulation', hold: true });
  const moved = await lab.advanceClock(3_600_000);
  assert.equal(moved.held, true);
  assert.deepEqual([moved.clock.now - before, moved.clock.kl, moved.item.type], [3_600_000, '05/10/2026 11:00', 'device.heartbeat']);
  const connected = [...lab.terminals.values()].filter((m) => m.connected).map((m) => `${m.schoolCode}/${m.deviceCode}`).sort();
  const heard = () => inTrace(moved.trace, 'intake.accepted', (e) => e.data.type === 'device.heartbeat').map((e) => `${e.school}/${e.data.device}`).sort();
  await stepUntil(() => heard().length === connected.length, "every connected machine's heartbeat at the platform");
  assert.deepEqual(heard(), connected);
  assert.equal(inTrace(moved.trace, 'lab.clock').length, 1);
  lab.setSim({ mode: 'realtime' });
  await booksBalance();
});

// ---- reset and stop with flows held at every hop ----------------------------------------------------

/**
 * A kiosk visit with its read-back at the platform's door and its first API call waiting, then
 * a sale and a heartbeat in their machines' outboxes (Next goes oldest first, so in this order).
 */
async function holdEverywhere() {
  lab.setSim({ mode: 'simulation', hold: true });
  const visit = await tap('KIOSK-01', AHMAD);
  assert.deepEqual([visit.held, visit.item.type], [true, 'card.readback']);
  lab.simNext();
  await waitFor(
    () => heldNow((h) => h.trace === visit.trace && h.where === 'platform').length === 1 &&
      heldNow((h) => h.trace === visit.trace && h.call === 'pending').length === 1,
    { message: 'the read-back at the platform and the pending call held' },
  );
  const sale = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  const beat = await lab.heartbeat({ schoolCode: SJKC, deviceCode: 'KIOSK-01' });
  assert.deepEqual([sale.held, beat.held], [true, true]);
  assert.deepEqual([...new Set(heldNow().map((h) => h.where))].sort(), ['kiosk-http', 'machine', 'platform']);
}

test('a reset with flows held at every hop: nothing held, nothing of the old demo left in the new one', NET, async () => {
  await lab.reset();
  await holdEverywhere();
  await lab.reset();
  assert.deepEqual(lab.simState(), { mode: 'realtime', hold: false, held: [] });
  assert.equal(lab.platform.inboxWaiting(), 0);
  await sleep(300); // the flows the reset let go end in the old demo
  assert.deepEqual(lab.tracer.list(), []);
  const lastResults = lab.state().schools.flatMap((s) => s.devices.filter((d) => d.lastResult).map((d) => `${s.code}/${d.code}`));
  assert.deepEqual(lastResults, [], "no machine of the new demo shows a result of the old one's flows");
  const { devices, schools } = lab.platform.services;
  const warned = devices.listLog(schools.getSchoolByCode(SMK).id).filter((l) => l.level !== 'INFO');
  assert.deepEqual(warned.map((l) => `${l.code}: ${l.message}`), [], "the old demo's kiosk never reached the new platform");

  // the new demo works at once: a sale and a visit, through every hop
  const mark = lab.ctx.events.lastSeq();
  const sale = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  assert.equal(sale.ok, true);
  const visit = await tap('KIOSK-01', AHMAD);
  assert.equal(visit.screen, 'Added RM 20.00 · Balance RM 50.00');
  await waitFor(() => verdicts(mark, sale.record.txn).length === 1, { message: 'the new sale in the books' });
  await booksBalance();
});

test('a kiosk visit a reset let go ends in the old demo, even when its next call comes after the reset', NET, async () => {
  await lab.reset();
  lab.setSim({ mode: 'simulation', hold: true });
  // this kiosk's API calls go only once the reset is over (as a slow call would)
  const kiosk = machine('KIOSK-01');
  let resetOver;
  const afterReset = new Promise((resolve) => {
    resetOver = resolve;
  });
  const hold = kiosk._hold;
  kiosk._hold = function lateCall(info) {
    const held = hold.call(this, info);
    return held && info.kind === 'http' ? held.then(() => afterReset) : held;
  };
  const visit = await tap('KIOSK-01', AHMAD);
  assert.deepEqual([visit.held, visit.item.type], [true, 'card.readback']);
  lab.simNext();
  await waitFor(() => heldNow((h) => h.trace === visit.trace && h.call === 'pending').length === 1, { message: 'the pending call held' });

  await lab.reset();
  resetOver();
  await sleep(300); // the old kiosk asks what is waiting, in a demo that is gone
  const { devices, schools } = lab.platform.services;
  const warned = devices.listLog(schools.getSchoolByCode(SMK).id).filter((l) => l.level !== 'INFO');
  assert.deepEqual(warned.map((l) => `${l.code}: ${l.message}`), [], "the old demo's kiosk never reached the new platform");
  await booksBalance();
});

test('hold switched on again while a reset waits for the lab: the reset still leaves nothing held', NET, async () => {
  await lab.reset();
  const busy = lab.setServer({ up: false }); // the lab's lock is taken for a moment
  const resetting = lab.reset(); // lets go of what waits now, then waits for the lock
  lab.setSim({ mode: 'simulation', hold: true });
  const late = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  assert.equal(late.held, true, 'held while the reset waited');
  await busy;
  await resetting;
  assert.deepEqual(lab.simState(), { mode: 'realtime', hold: false, held: [] });
  assert.equal(lab.platform.inboxWaiting(), 0);
  await booksBalance();
});

test('stop with flows held at every hop: it ends at once, lets them all go, and the process can exit', NET, async () => {
  const logs = [];
  const other = createLab({
    clockMode: 'manual',
    httpPort: 0,
    mqttPort: 0,
    consolePort: 0,
    jobsMs: 0,
    reconnectMs: 100,
    log: (level, message, meta) => {
      if (level !== 'debug') logs.push(`${level}: ${message} ${JSON.stringify(meta ?? {})}`);
    },
  });
  await other.start();
  const main = lab;
  lab = other; // the helpers work on `lab`
  try {
    await holdEverywhere();
    await other.stop(); // (the test's own timeout catches a stop that never ends)
  } finally {
    lab = main;
  }
  assert.deepEqual(other.simState(), { mode: 'realtime', hold: false, held: [] });
  assert.equal(other.phase, 'stopped');
  await sleep(300); // the flows let go end against a stopped lab, quietly
  assert.deepEqual(logs, []);
});

test('hold switched on again while a stop waits for the lab: the stop still leaves nothing held', NET, async () => {
  const logs = [];
  const other = createLab({
    clockMode: 'manual',
    httpPort: 0,
    mqttPort: 0,
    consolePort: 0,
    jobsMs: 0,
    reconnectMs: 100,
    log: (level, message, meta) => {
      if (level === 'error') logs.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
  });
  await other.start();
  const busy = other.setServer({ up: false }); // the lab's lock is taken for a moment
  const stopping = other.stop(); // lets go of what waits now, then waits for the lock
  other.setSim({ mode: 'simulation', hold: true });
  const late = await other.tap({ schoolCode: SMK, deviceCode: 'CANTEEN-01', uid: LEE, items: items('ROTI-CANAI') });
  assert.equal(late.held, true, 'held while the stop waited');
  await busy;
  await stopping;
  assert.equal(other.phase, 'stopped');
  assert.deepEqual(other.simState(), { mode: 'realtime', hold: false, held: [] });
  assert.deepEqual(logs, []);
});

// ---- no leakage ---------------------------------------------------------------------------------------

/** JSON calls to a lab's web server with one cookie jar. */
function webClient(base) {
  let cookie = '';
  return async (method, path, json) => {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((pair) => !pair.endsWith('='));
    if (set.length > 0) cookie = set.join('; ');
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test('no leakage: a lab started inside a flow, its jobs timer, and machines a traced request brings to life run in no flow', NET, async (t) => {
  const quick = createLab({ clockMode: 'manual', httpPort: 0, mqttPort: 0, consolePort: 0, jobsMs: 100, heartbeatMs: 150, reconnectMs: 100, log: labLog });
  t.after(() => quick.stop());
  const outer = 'tr_startedinsideaflow';
  const { httpUrl } = await quick.ctx.events.withContext({ trace: outer }, () => quick.start());
  const runJobs = quick.platform.runJobs;
  quick.platform.runJobs = (...args) => {
    quick.ctx.events.emit('probe.jobs', {}); // in whatever flow the timer runs in
    return runJobs(...args);
  };
  t.after(() => {
    quick.platform.runJobs = runJobs;
  });

  // the operator onboards a school: a traced request, during which the lab installs its machines
  const call = webClient(httpUrl);
  assert.equal((await call('POST', '/api/operator/login')).status, 200);
  const created = await call('POST', '/api/operator/schools', {
    code: 'smk-teladan',
    name: 'SMK Teladan (fictional)',
    staff: [{ name: 'Aminah Teladan', role: 'ADMIN' }],
    devices: [{ code: 'CANTEEN-01', type: 'CANTEEN', location: 'Dewan makan' }, { code: 'KIOSK-01', type: 'KIOSK', location: 'Pejabat' }],
    demoMembers: 1,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const request = quick.tracer.list().find((x) => x.title === 'Operator console: POST /api/operator/schools');
  assert.ok(request, 'the onboarding is a trace');
  assert.ok(quick.tracer.get(request.id).events.some((e) => e.type === 'device.registered'));
  const fresh = ['smk-teladan/CANTEEN-01', 'smk-teladan/KIOSK-01'];
  await waitFor(() => fresh.every((key) => quick.terminals.get(key)?.connected), { timeout: 10_000, message: 'the new machines online' });

  const mark = quick.ctx.events.lastSeq();
  const since = (type, match = () => true) => quick.ctx.events.since(mark).filter((e) => e.type === type && match(e));
  // (their acks of the settings the onboarding published do belong to it: they answer its commands)
  const beat = (e) => e.school === 'smk-teladan' && e.data?.type === 'device.heartbeat';
  await waitFor(() => since('probe.jobs').length >= 3 && since('intake.accepted', beat).length >= 4, {
    timeout: 10_000,
    message: "the jobs timer's runs and the new machines' heartbeats",
  });
  for (const e of [...since('probe.jobs'), ...since('device.send', beat), ...since('intake.accepted', beat), ...since('mqtt.publish', beat)]) {
    assert.equal(e.trace, undefined, `${e.type} ${JSON.stringify(e.data)}`);
  }
  assert.ok(!quick.ctx.events.since(0).some((e) => e.trace === outer), 'nothing in the flow the lab was started from');
  assert.deepEqual(errors, []);
});

// ---- the realtime path ----------------------------------------------------------------------------

test("the platform's inbox gate is there only while hold is on: in realtime a message goes to intake as it always did", NET, async () => {
  await lab.reset();
  const installed = [];
  const original = lab.platform.setInboxGate;
  lab.platform.setInboxGate = (fn) => {
    installed.push(fn === null ? null : typeof fn);
    return original(fn);
  };
  try {
    lab.setSim({ mode: 'simulation' });
    lab.setSim({ hold: true });
    lab.setSim({ hold: false });
    lab.setSim({ mode: 'simulation', hold: true });
    lab.setSim({ mode: 'realtime' });
  } finally {
    lab.platform.setInboxGate = original;
  }
  assert.deepEqual(installed, [null, 'function', null, 'function', null]);
  // and a sale in realtime goes straight through
  const mark = lab.ctx.events.lastSeq();
  const sale = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  await waitFor(() => verdicts(mark, sale.record.txn).length === 1, { message: 'the sale in the books' });
  assert.deepEqual(eventsSince(mark, 'sim.held'), []);
  await booksBalance();
});

// ---- broker logins join their flow; every flow names its subject (DESIGN §11.7) -----------------

/** The lab's web server with one cookie jar: (method, path, json?, headers?) -> { status, body }. */
function webSession() {
  let cookie = '';
  return async (method, path, json, extra = {}) => {
    const headers = { accept: 'application/json', ...extra };
    if (cookie) headers.cookie = cookie;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(lab.urls.httpUrl + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((pair) => !pair.endsWith('='));
    if (set.length > 0) cookie = set.join('; ');
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const loginOf = (key) => key.replace('/', '.'); // 'smk-contoh/CANTEEN-01' -> its broker username
const connectedKeys = () => [...lab.terminals.values()].filter((m) => m.connected).map((m) => `${m.schoolCode}/${m.deviceCode}`).sort();
/** Usernames of the broker's logins (mqtt.connect) or logouts (mqtt.disconnect) in a trace, sorted. */
const loginsIn = (trace, type) => inTrace(trace, type).map((e) => e.data.username).sort();

test('broker logins join their flow: a pull, a plug and its first heartbeat, the server off and on, a broker restart', NET, async () => {
  await lab.reset();
  const where = { schoolCode: SMK, deviceCode: 'CANTEEN-01' };
  const reader = `${SMK}.CANTEEN-01`;

  const pull = await lab.setCable({ ...where, plugged: false });
  await waitFor(() => loginsIn(pull.trace, 'mqtt.disconnect').includes(reader), { message: "the pull's logout" });
  assert.deepEqual(loginsIn(pull.trace, 'mqtt.disconnect'), [reader]);

  const plug = await lab.setCable({ ...where, plugged: true });
  await waitFor(() => inTrace(plug.trace, 'intake.accepted', (e) => e.data.type === 'device.heartbeat').length === 1, { message: "the plug's heartbeat" });
  assert.deepEqual(loginsIn(plug.trace, 'mqtt.connect'), [reader]);
  const kinds = inTrace(plug.trace, 'mqtt.connect').concat(inTrace(plug.trace, 'device.send')).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(kinds.map((e) => e.data.type ?? e.type), ['mqtt.connect', 'device.heartbeat'], 'logged in, then its first heartbeat');

  // the server off: every machine on the broker and the platform leave in its flow
  const online = connectedKeys();
  assert.ok(online.length >= 5, online.join(' '));
  const off = await lab.setServer({ up: false });
  assert.deepEqual(loginsIn(off.trace, 'mqtt.disconnect'), [...online.map(loginOf), 'platform'].sort());
  // on again: the platform and every machine with a cable log in in its flow
  const on = await lab.setServer({ up: true });
  const plugged = [...lab.terminals.values()].filter((m) => m.cablePlugged).map((m) => `${m.schoolCode}.${m.deviceCode}`);
  await waitFor(() => loginsIn(on.trace, 'mqtt.connect').length === plugged.length + 1, { timeout: 15_000, message: 'every login in the server-on flow' });
  assert.deepEqual(loginsIn(on.trace, 'mqtt.connect'), [...plugged, 'platform'].sort());

  // a broker restart: out and back in, all in its flow
  await waitFor(() => connectedKeys().length === plugged.length, { timeout: 15_000, message: 'every plugged machine back' });
  const restart = await lab.restartBroker();
  assert.deepEqual(loginsIn(restart.trace, 'mqtt.disconnect'), [...plugged, 'platform'].sort());
  await waitFor(() => loginsIn(restart.trace, 'mqtt.connect').length === plugged.length + 1, { timeout: 15_000, message: 'every login in the restart flow' });
  assert.deepEqual(loginsIn(restart.trace, 'mqtt.connect'), [...plugged, 'platform'].sort());

  // the read-only viewer is nobody's flow
  const mark = lab.ctx.events.lastSeq();
  const viewer = await mqtt.connectAsync(lab.broker.url, { ...lab.ctx.settings.viewer, clientId: 'viewer-lab-sim', reconnectPeriod: 0 });
  await viewer.endAsync();
  await waitFor(() => eventsSince(mark, 'mqtt.disconnect', (e) => e.data.username === 'viewer').length === 1, { message: "the viewer's logout" });
  assert.ok(lab.ctx.events.since(mark).filter((e) => e.data?.username === 'viewer').every((e) => e.trace === undefined));
  await booksBalance();
});

test('broker.status: every one the lab emits says why with a stable code next to the English reason', NET, async () => {
  const mark = lab.ctx.events.lastSeq();
  await lab.reset();
  await lab.setServer({ up: false });
  await lab.setServer({ up: true });
  await lab.restartBroker();
  const statuses = eventsSince(mark, 'broker.status').map((e) => [e.data.up, e.data.code, e.data.reason]);
  assert.deepEqual(statuses, [
    [false, 'LAB_RESET', 'reset'],
    [true, 'LAB_RESET', 'reset'],
    [false, 'SERVER_OFF', 'server switched off'],
    [true, 'SERVER_ON', 'server switched on'],
    [false, 'RESTARTING', 'restart'],
    [true, 'RESTARTED', 'restarted'],
  ]);
  for (const [, code, reason] of statuses) assert.equal(BROKER_STATUS_CODES[code], reason);
  await booksBalance();
});

test("the cross-device-publish fault: the copied login, the machine knocked off, the refusal and the copied login leaving are the fault's", NET, async () => {
  await lab.reset();
  const reader = `${SMK}.CANTEEN-01`;
  const cross = await lab.fault({ type: 'cross-device-publish', schoolCode: SMK, deviceCode: 'CANTEEN-01' });
  assert.equal(cross.ok, true, cross.summary);
  const steps = lab.tracer.get(cross.trace).events
    .filter((e) => ['mqtt.connect', 'mqtt.disconnect', 'mqtt.denied', 'device.send'].includes(e.type))
    .map((e) => [e.type, e.data.username ?? e.data.device, e.data.copiedLogin ?? null]);
  assert.deepEqual(steps, [
    ['mqtt.disconnect', reader, null], // the real reader knocked off by the copied login...
    ['mqtt.connect', reader, null], // ...which the broker reports logged in
    ['device.send', 'CANTEEN-01', true],
    ['mqtt.denied', reader, null],
    ['mqtt.disconnect', reader, null], // the copied login cut off
    ['mqtt.connect', reader, null], // the real reader back
  ]);
  assert.equal(machine('CANTEEN-01').connected, true);
  await booksBalance();
});

test('every kind of flow names its subject, in sim.trace and in the trace lists', NET, async () => {
  await lab.reset();
  const subjectOf = (answer) => {
    assert.match(answer?.trace ?? '', /^tr_/, JSON.stringify(answer));
    const kept = lab.tracer.get(answer.trace);
    assert.deepEqual(kept.events[0].data.subject, kept.trace.subject, 'sim.trace and the summary agree');
    return [kept.trace.kind, kept.trace.subject];
  };
  const smk = (device, more = {}) => ({ school: SMK, device, ...more });
  const check = async (what, answer, kind, subject) => assert.deepEqual(subjectOf(await answer), [kind, subject], what);

  await check('canteen tap', tap('CANTEEN-01', LEE, { items: [{ code: 'ROTI-CANAI', qty: 1 }, { code: 'TEH-TARIK', qty: 2 }] }), 'tap',
    { uid: LEE, cardSchool: SMK, ...smk('CANTEEN-01'), items: 'ROTI-CANAI TEH-TARIK*2' });
  await check('water tap', tap('WATER-01', ARJUN, { ml: 250 }), 'tap', { uid: ARJUN, cardSchool: SMK, ...smk('WATER-01'), ml: 250 });
  await check('kiosk tap', tap('KIOSK-01', AHMAD), 'tap', { uid: AHMAD, cardSchool: SMK, ...smk('KIOSK-01') });
  await check('kiosk fault', lab.fault({ type: 'power-cut-before-commit', schoolCode: SMK, deviceCode: 'KIOSK-01', uid: LEE }), 'fault',
    { uid: LEE, cardSchool: SMK, ...smk('KIOSK-01'), fault: 'power-cut-before-commit' });
  await check('cable', lab.setCable({ schoolCode: SMK, deviceCode: 'CANTEEN-02', plugged: true }), 'cable', smk('CANTEEN-02', { plugged: true }));
  await check('admin card load', lab.adminCardLoad({ schoolCode: SMK }), 'admin-card', smk('KIOSK-01', { op: 'load' }));
  await check('admin card tap', lab.adminCardTap({ schoolCode: SMK, deviceCode: 'CANTEEN-01' }), 'admin-card', smk('CANTEEN-01', { op: 'tap' }));
  await check('admin card upload', lab.adminCardUpload({ schoolCode: SMK }), 'admin-card', smk('KIOSK-01', { op: 'upload' }));
  lab.exportUsb({ schoolCode: SMK, deviceCode: 'CANTEEN-01' }); // answers the file itself, without its trace
  assert.deepEqual(subjectOf(lab.tracer.list()[0].kind === 'usb' ? { trace: lab.tracer.list()[0].id } : null), ['usb', smk('CANTEEN-01')]);
  await check('heartbeat', lab.heartbeat({ schoolCode: SMK, deviceCode: 'KIOSK-01' }), 'heartbeat', smk('KIOSK-01'));
  await check('upload', lab.upload({ schoolCode: SMK, deviceCode: 'CANTEEN-01' }), 'upload', smk('CANTEEN-01'));
  await check('reboot', lab.reboot({ schoolCode: SJKC, deviceCode: 'KIOSK-01' }), 'reboot', { school: SJKC, device: 'KIOSK-01' });
  await check('clock', lab.advanceClock(60_000), 'clock', { ms: 60_000 });
  await check('jobs', lab.runJobs(), 'jobs', {});
  await check('server off', lab.setServer({ up: false }), 'server', { up: false });
  await check('server on', lab.setServer({ up: true }), 'server', { up: true });
  await check('broker', lab.restartBroker(), 'broker', {});
  await waitFor(() => machine('CANTEEN-01').connected && machine('KIOSK-01').connected, { timeout: 15_000, message: 'the machines back' });

  // faults: the fault and what it works on
  await check('clone', lab.fault({ type: 'clone-card', schoolCode: SMK, uid: ARJUN }), 'fault', { fault: 'clone-card', school: SMK, uid: ARJUN });
  await check('tamper', lab.fault({ type: 'tamper-card', schoolCode: SMK, uid: `${ARJUN}-copy` }), 'fault',
    { fault: 'tamper-card', school: SMK, uid: `${ARJUN}-copy` });
  await check('duplicate', lab.fault({ type: 'duplicate-upload', schoolCode: SMK, deviceCode: 'CANTEEN-01' }), 'fault', { fault: 'duplicate-upload', ...smk('CANTEEN-01') });
  await check('rollback', lab.fault({ type: 'sequence-rollback', schoolCode: SMK, deviceCode: 'CANTEEN-01' }), 'fault', { fault: 'sequence-rollback', ...smk('CANTEEN-01') });
  await check('forged', lab.fault({ type: 'forged-message', schoolCode: SMK, deviceCode: 'CANTEEN-01' }), 'fault', { fault: 'forged-message', ...smk('CANTEEN-01') });
  await check('cross device', lab.fault({ type: 'cross-device-publish', schoolCode: SMK, deviceCode: 'CANTEEN-01', toSchoolCode: SJKC, toDeviceCode: 'WATER-01' }),
    'fault', { fault: 'cross-device-publish', ...smk('CANTEEN-01'), toSchool: SJKC, toDevice: 'WATER-01' });
  await check('cross school', lab.fault({ type: 'cross-school-card', schoolCode: SMK, uid: LEE, toSchoolCode: SJKC }), 'fault',
    { fault: 'cross-school-card', school: SJKC, device: 'CANTEEN-01', uid: LEE, cardSchool: SMK, items: 'NASI-LEMAK' });
  await check('server fault', lab.fault({ type: 'server-down' }), 'fault', { fault: 'server-down' });
  await check('server fault', lab.fault({ type: 'server-up' }), 'fault', { fault: 'server-up' });
  await check('broker fault', lab.fault({ type: 'broker-restart' }), 'fault', { fault: 'broker-restart' });

  // building (DESIGN §12)
  await check('add device', lab.addDevice({ schoolCode: SMK, type: 'WATER' }), 'add-device', { school: SMK, type: 'WATER', code: 'WATER-02' });
  await check('add school', lab.addSchool({ code: 'smk-teladan', name: 'SMK Teladan (fictional)', students: 1 }), 'add-school', { code: 'smk-teladan' });

  // a person's request in the web apps: the area, the method, the path without its query, the school when known
  const call = webSession();
  const requestSubject = () => lab.tracer.list()[0].subject;
  const finance = (await call('GET', '/api/admin/staff-options')).body.find((s) => s.schoolCode === SMK && s.role === 'FINANCE');
  assert.equal((await call('POST', '/api/admin/login?from=lab-sim', { staffId: finance.id })).status, 200);
  assert.deepEqual(requestSubject(), { area: 'admin', method: 'POST', path: '/api/admin/login' }, 'no school before signing in');
  const lee = (await call('GET', '/api/admin/members')).body.find((m) => m.memberNo === 'S1002');
  assert.equal((await call('POST', '/api/admin/subsidies', { memberId: lee.id, amountSen: 500, note: 'trip' })).status, 201);
  assert.deepEqual(requestSubject(), { area: 'admin', method: 'POST', path: '/api/admin/subsidies', school: SMK });
  assert.equal((await call('POST', '/api/operator/login')).status, 200);
  assert.deepEqual(requestSubject(), { area: 'operator', method: 'POST', path: '/api/operator/login' });
  const parent = (await call('GET', '/api/parent/options')).body.find((p) => p.name === 'Lee Kah Seng');
  assert.equal((await call('POST', '/api/parent/login', { parentId: parent.id })).status, 200);
  assert.deepEqual(requestSubject(), { area: 'parent', method: 'POST', path: '/api/parent/login' });
  const child = (await call('GET', '/api/parent/children')).body.children.find((c) => c.schoolCode === SMK);
  const topup = await call('POST', `/api/parent/children/${child.schoolId}/${child.memberId}/topups`, { amountSen: 1000 }, { 'idempotency-key': 'lab-sim-subject' });
  assert.equal(topup.status, 201, JSON.stringify(topup.body));
  assert.equal((await call('POST', `/api/pay/${topup.body.order.id}/complete`, { result: 'SUCCESS' })).status, 200);
  assert.deepEqual(requestSubject(), { area: 'pay', method: 'POST', path: `/api/pay/${topup.body.order.id}/complete` });

  // the lab API lists them with their subjects: every trace has one
  const sim = await call('GET', '/api/lab/sim?limit=200');
  assert.ok(sim.body.traces.length >= 30);
  for (const t of sim.body.traces) assert.ok(t.subject && typeof t.subject === 'object' && !Array.isArray(t.subject), JSON.stringify(t));
  const one = await call('GET', `/api/lab/sim/traces/${sim.body.traces.at(-1).id}`);
  assert.deepEqual(one.body.trace.subject, one.body.events[0].data.subject);
  await booksBalance();
});
