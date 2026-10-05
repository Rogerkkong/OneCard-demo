import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// docs/SCENARIOS.md exercise 16, Simulation mode (docs/DESIGN.md §11), against a real lab: the
// demo seed (fictional schools, people and cards), broker and web server on random ports, the
// lab clock standing still. Every action is a trace that can be replayed hop by hop; with
// "hold at each hop" on, a traced flow really waits at a machine's outbox, at the kiosk's API
// calls and at the platform's inbox until Next, while cables are pulled and the server is
// switched off. Most exercises start from a fresh demo (lab.reset()).

const NET = { timeout: 60_000 };
const SMK = 'smk-contoh';
const AHMAD = '04A13B5C7D2E80'; // S1001: RM 30.00 on the card, RM 20.00 waiting
const LEE = '04B2194E6A3C81'; // S1002: RM 25.00
const ARJUN = '04C35D2F8B1A82'; // S1003: RM 40.00
const INTAKE_STEPS = ['topic', 'device', 'envelope', 'topicMatch', 'signature', 'duplicate', 'sequence', 'gates', 'typeRules', 'recorded'];

let lab;
let base;
const errors = [];
const labLog = (level, message, meta) => {
  if (level === 'error') errors.push(`${message} ${JSON.stringify(meta ?? {})}`);
};

before(async () => {
  lab = createLab({ clockMode: 'manual', httpPort: 0, mqttPort: 0, consolePort: 0, jobsMs: 0, log: labLog });
  base = (await lab.start()).httpUrl;
});

after(async () => {
  await lab?.stop();
});

// ---- helpers (each scenario file keeps its own copy) --------------------------------------

/** A browser of one person: JSON calls with its own cookies. */
function browser() {
  const jar = new Map();
  async function call(method, path, { json, headers = {} } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: data };
  }
  return {
    get: (path) => call('GET', path),
    post: (path, json = {}) => call('POST', path, { json }),
  };
}

function ok(res, status = 200) {
  assert.equal(res.status, status, `HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A school office browser signed in as that school's staff member of `role`. */
async function staff(schoolCode, role) {
  const b = browser();
  const options = ok(await b.get('/api/admin/staff-options'));
  const who = options.find((s) => s.schoolCode === schoolCode && s.role === role);
  ok(await b.post('/api/admin/login', { staffId: who.id }));
  return b;
}

const tap = (deviceCode, uid, more = {}) => lab.tap({ schoolCode: SMK, deviceCode, uid, ...more });
const items = (...codes) => codes.map((code) => ({ code, qty: 1 }));
const machine = (code) => lab.terminals.get(`${SMK}/${code}`);
const eventsSince = (mark, type, match = () => true) => lab.ctx.events.since(mark).filter((e) => e.type === type && match(e));
/** The events a trace keeps, in order. */
const traced = (id) => lab.tracer.get(id)?.events ?? [];
/** An event's type, with the step for device.step ('device.step card.read'). */
const kindOf = (e) => (e.type === 'device.step' ? `device.step ${e.data.step}` : e.type);
const kinds = (id) => traced(id).map(kindOf);
const inTrace = (id, type, match = () => true) => traced(id).filter((e) => e.type === type && match(e));
/** The held items, optionally only those matching. */
const heldNow = (match = () => true) => lab.simState().held.filter(match);

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

/** Every record home (cables in, journals uploaded), then every school's books balance and every card equals its mirror. */
async function booksBalance() {
  for (const m of lab.terminals.values()) {
    if (!m.cablePlugged) await lab.setCable({ schoolCode: m.schoolCode, deviceCode: m.deviceCode, plugged: true });
  }
  await waitFor(() => [...lab.terminals.values()].every((m) => m.connected && m.state.journal.unsent === 0), {
    timeout: 20_000,
    message: 'every machine connected with its journal uploaded',
  });
  await waitFor(() => lab.checkBooks().ok, { timeout: 5000, message: 'every card equal to its mirror' });
  for (const s of lab.checkBooks().schools) assert.equal(s.balanced, true, `${s.code} trial balance`);
  assert.deepEqual(errors, []);
}

// ---- the exercises -------------------------------------------------------------------------

test('16.1 a canteen tap is one trace, from the card to the books, and the lab API replays it', NET, async () => {
  await lab.reset();
  const sale = await tap('CANTEEN-01', AHMAD, { items: items('NASI-LEMAK', 'TEH-TARIK') });
  assert.equal(sale.screen, 'Paid RM 5.30 · Balance RM 24.70');
  assert.match(sale.trace, /^tr_[A-Za-z0-9_-]{4,64}$/);
  await waitFor(() => kinds(sale.trace).includes('intake.accepted') && kinds(sale.trace).includes('mqtt.publish'), { message: 'the sale at the platform' });

  const b = browser();
  const { trace, events } = ok(await b.get(`/api/lab/sim/traces/${sale.trace}`));
  assert.deepEqual([trace.id, trace.n, trace.kind, trace.title, trace.school, trace.device], [sale.trace, 1, 'tap', `Tap ${AHMAD} on ${SMK}/CANTEEN-01`, SMK, 'CANTEEN-01']);
  assert.equal(trace.events, events.length);
  assert.ok(events.every((e) => e.trace === sale.trace), 'every hop carries the trace');
  // the machine's own steps, in order, then the hops that follow (broker, platform, books,
  // the PUBACK and the lab's answer), each once and nothing else
  const order = events.map(kindOf);
  assert.deepEqual(order.slice(0, 7), [
    'sim.trace', 'device.step card.read', 'device.step rules', 'card.write', 'device.step journal', 'device.screen', 'device.send',
  ]);
  assert.deepEqual(order.slice(7).sort(), ['device.acked', 'intake.accepted', 'lab.action', 'ledger.posting', 'mqtt.publish', 'purchase.received']);
  const at = (type) => order.indexOf(type);
  assert.ok(at('device.acked') < at('lab.action'), 'the tap answers once the broker has the record');
  assert.ok(at('purchase.received') < at('intake.accepted') && at('ledger.posting') < at('intake.accepted'), 'intake announces after the books');

  const one = (type) => events.find((e) => e.type === type);
  assert.deepEqual(one('sim.trace').data, { id: sale.trace, n: 1, kind: 'tap', title: `Tap ${AHMAD} on ${SMK}/CANTEEN-01`, device: 'CANTEEN-01' });
  const send = one('device.send');
  assert.deepEqual([send.data.type, send.data.txn, send.data.topic], ['sale.recorded', 'CANTEEN-01-000001', `lab/v1/${SMK}/CANTEEN-01/records`]);
  for (const type of ['mqtt.publish', 'intake.accepted', 'device.acked']) assert.equal(one(type).data.msgId, send.data.msgId, type);
  assert.equal(one('mqtt.publish').data.qos, 1);
  assert.equal(one('device.acked').data.ok, true);
  assert.deepEqual(one('intake.accepted').data.checks, INTAKE_STEPS.map((step) => ({ step, ok: true })));
  assert.deepEqual([one('purchase.received').data.status, one('purchase.received').data.amountSen], ['POSTED', 530]);
  assert.deepEqual(one('lab.action').data, { action: 'tap', device: 'CANTEEN-01', uid: AHMAD, ok: true, screen: sale.screen });

  // the lab's simulation state lists it, newest first; an unknown trace is a 404
  const sim = ok(await b.get('/api/lab/sim'));
  assert.deepEqual([sim.mode, sim.hold, sim.held], ['realtime', false, []]);
  assert.equal(sim.traces[0].id, sale.trace);
  assert.deepEqual(Object.keys(sim.traces[0]).sort(), ['at', 'device', 'events', 'id', 'kind', 'lastAt', 'n', 'school', 'title']);
  assert.equal(ok(await b.get('/api/lab/sim?limit=1')).traces.length, 1);
  assert.equal(ok(await b.get('/api/lab/sim?limit=0'), 400).error.code, 'INPUT_INVALID');
  assert.equal(ok(await b.get('/api/lab/sim/traces/tr_unknown0000'), 404).error.code, 'TRACE_NOT_FOUND');
  assert.deepEqual(ok(await b.get('/api/lab/state')).sim, { mode: 'realtime', hold: false, held: [] });
  await booksBalance();
});

test('16.2 a kiosk tap: the read-back, the signed API calls and the books are one trace', NET, async () => {
  const visit = await tap('KIOSK-01', AHMAD);
  assert.equal(visit.screen, 'Added RM 20.00 · Balance RM 44.70');
  await waitFor(() => inTrace(visit.trace, 'intake.accepted').length > 0, { message: 'the read-back at the platform' });
  const events = traced(visit.trace);
  assert.ok(events.every((e) => e.trace === visit.trace));
  assert.equal(events[0].data.title, `Tap ${AHMAD} on ${SMK}/KIOSK-01`);
  const readback = inTrace(visit.trace, 'device.send', (e) => e.data.type === 'card.readback');
  assert.equal(readback.length, 1);
  const accepted = inTrace(visit.trace, 'intake.accepted', (e) => e.data.msgId === readback[0].data.msgId);
  assert.equal(accepted.length, 1);
  const { snapshot } = accepted[0].data;
  assert.deepEqual([snapshot.checked, snapshot.match, snapshot.cardSen, snapshot.mirrorSen], [true, true, 2470, 2470], 'the card equals the books');
  // the kiosk's calls (device.http) and the platform's answers to them (http.kiosk), in the same trace
  assert.deepEqual(inTrace(visit.trace, 'device.http').map((e) => [e.data.call, e.data.method, e.data.path, e.data.status, e.data.ok]), [
    ['pending', 'POST', '/api/kiosk/pending', 200, true],
    ['confirm', 'POST', '/api/kiosk/confirm', 200, true],
  ]);
  assert.deepEqual(inTrace(visit.trace, 'http.kiosk').map((e) => [e.data.device, e.data.path, e.data.status]), [
    ['KIOSK-01', '/api/kiosk/pending', 200],
    ['KIOSK-01', '/api/kiosk/confirm', 200],
  ]);
  assert.deepEqual(inTrace(visit.trace, 'topup.status').map((e) => [e.data.status, e.data.amountSen]), [['ADDED', 2000]]);
  assert.deepEqual(inTrace(visit.trace, 'ledger.posting').map((e) => [e.data.kind, e.data.amountSen]), [['TOPUP_ADDED', 2000]]);
  assert.deepEqual(inTrace(visit.trace, 'card.write').map((e) => [e.data.kind, e.data.amountSen, e.data.balanceAfterSen]), [['credit', 2000, 4470]]);
  assert.deepEqual(inTrace(visit.trace, 'device.screen').map((e) => e.data.text), ['Added RM 20.00 · Balance RM 44.70']);
  assert.equal(inTrace(visit.trace, 'lab.action').length, 1);
  await booksBalance();
});

test('16.3 hold at the machine: a held sale, the cable pulled, Next, the cable back', NET, async () => {
  await lab.reset();
  const b = browser();
  assert.deepEqual(ok(await b.post('/api/lab/sim', { mode: 'simulation', hold: true })), { mode: 'simulation', hold: true, held: [] });
  const mark = lab.ctx.events.lastSeq();

  // the reader charges the card and answers at once; the record waits in its outbox
  const sale = ok(await b.post('/api/lab/tap', { schoolCode: SMK, deviceCode: 'CANTEEN-01', uid: LEE, items: [{ code: 'ROTI-CANAI', qty: 1 }] }));
  assert.equal(sale.held, true);
  assert.deepEqual([sale.machine, sale.screen, sale.card.balanceSen], [`${SMK}/CANTEEN-01`, 'Paid RM 1.50 · Balance RM 23.50', 2350]);
  const { item } = sale;
  assert.match(item.id, /^held_/);
  assert.deepEqual([item.trace, item.where, item.device, item.school, item.type, item.txn], [sale.trace, 'machine', 'CANTEEN-01', SMK, 'sale.recorded', 'CANTEEN-01-000001']);
  assert.deepEqual(ok(await b.get('/api/lab/sim')).held, [item]);
  assert.deepEqual(inTrace(sale.trace, 'sim.held').map((e) => e.data), [item]);
  assert.equal(inTrace(sale.trace, 'device.send').length, 0, 'nothing sent yet');

  // pull the cable while the sale is in the machine (an action of its own)
  const pulled = await lab.setCable({ schoolCode: SMK, deviceCode: 'CANTEEN-01', plugged: false });
  assert.equal(pulled.held, undefined);
  assert.equal(pulled.machine.cablePlugged, false);
  assert.notEqual(pulled.trace, sale.trace);

  // Next: the sale goes on, finds no link, and waits in the journal
  assert.deepEqual(ok(await b.post('/api/lab/sim/next')), { released: item, waiting: 0 });
  await waitFor(() => inTrace(sale.trace, 'lab.action').length === 1, { message: 'the tap to finish' });
  assert.deepEqual(inTrace(sale.trace, 'sim.released').map((e) => e.data), [{ id: item.id }]);
  assert.deepEqual(inTrace(sale.trace, 'device.step', (e) => e.data.step === 'offline').map((e) => e.data), [
    { device: 'CANTEEN-01', step: 'offline', ok: false, type: 'sale.recorded', txn: 'CANTEEN-01-000001' },
  ]);
  assert.equal(inTrace(sale.trace, 'device.send').length, 0);
  assert.equal(machine('CANTEEN-01').state.journal.unsent, 1);

  // plug it back: the first heartbeat waits at the outbox, so the plug answers early too
  const plug = await lab.setCable({ schoolCode: SMK, deviceCode: 'CANTEEN-01', plugged: true });
  assert.equal(plug.held, true);
  assert.deepEqual([plug.item.where, plug.item.type, plug.item.trace], ['machine', 'device.heartbeat', plug.trace]);
  assert.equal(plug.machine.cablePlugged, true);
  // step it through: heartbeat and journal upload, at the machine and at the platform
  const posted = () => eventsSince(mark, 'purchase.received', (e) => e.data.txn === 'CANTEEN-01-000001');
  await stepUntil(() => posted().length > 0 && machine('CANTEEN-01').state.journal.unsent === 0, 'the record uploaded');
  assert.deepEqual(posted().map((e) => [e.data.status, e.data.via, e.trace]), [['POSTED', 'JOURNAL_BATCH', plug.trace]]);
  const batch = inTrace(plug.trace, 'device.send', (e) => e.data.type === 'journal.batch');
  assert.equal(batch.length, 1);
  assert.equal(inTrace(plug.trace, 'intake.accepted', (e) => e.data.msgId === batch[0].data.msgId).length, 1);
  assert.ok(inTrace(plug.trace, 'sim.held', (e) => e.data.where === 'platform' && e.data.type === 'journal.batch').length === 1);

  assert.deepEqual(lab.setSim({ mode: 'realtime' }), { mode: 'realtime', hold: false, held: [] });
  assert.equal(posted().length, 1, 'counted once');
  await booksBalance();
});

test('16.4 hold at the platform: the message waits there while the server is off, and goes on when it is back', NET, async () => {
  await lab.reset();
  lab.setSim({ mode: 'simulation', hold: true });
  const mark = lab.ctx.events.lastSeq();
  const sale = await tap('CANTEEN-01', ARJUN, { items: items('MEE-GORENG') });
  assert.equal(sale.held, true);
  // Next lets it out of the machine: the broker takes it (the tap is over) and it waits at the platform's door
  assert.equal(lab.simNext().released.id, sale.item.id);
  const atPlatform = await waitFor(() => heldNow((h) => h.trace === sale.trace && h.where === 'platform')[0], { message: 'the sale at the platform' });
  assert.deepEqual([atPlatform.device, atPlatform.type, atPlatform.msgId], ['CANTEEN-01', 'sale.recorded', sale.item.msgId]);
  await waitFor(() => inTrace(sale.trace, 'lab.action').length === 1, { message: 'the tap to finish' });
  assert.equal(machine('CANTEEN-01').state.journal.unsent, 0, 'for the machine it is sent: the broker took it');
  assert.ok(lab.platform.inboxWaiting() >= 1);
  const posted = () => eventsSince(mark, 'purchase.received', (e) => e.data.txn === sale.item.txn);
  assert.equal(posted().length, 0);

  // the server goes off: the message stays with the platform, and Next cannot let it go
  const off = await lab.setServer({ up: false });
  assert.deepEqual([off.changed, off.server.up], [true, false]);
  const b = browser();
  assert.deepEqual(ok(await b.post('/api/lab/sim/next')), { released: null, waiting: 1 });
  assert.deepEqual(ok(await b.post('/api/lab/sim/release')), { released: 0 });
  assert.equal(posted().length, 0);

  // on again: it goes on by itself once the platform is back on the broker, exactly once
  const on = await lab.setServer({ up: true });
  assert.equal(on.server.up, true);
  await waitFor(() => posted().length === 1, { timeout: 5000, message: 'the held sale processed' });
  assert.deepEqual(posted().map((e) => [e.data.status, e.data.via, e.trace]), [['POSTED', 'MQTT', sale.trace]]);
  assert.equal(heldNow((h) => h.where === 'platform' && h.trace === sale.trace).length, 0);
  assert.deepEqual(inTrace(sale.trace, 'sim.released').map((e) => e.data.id), [sale.item.id, atPlatform.id]);
  // the server's own flow: the platform republished every retained setting, and the plugged
  // machines' first heartbeats on the new broker belong to it (they wait at their outboxes)
  assert.ok(inTrace(on.trace, 'platform.send', (e) => e.data.retained).length >= 3);
  await waitFor(() => heldNow((h) => h.trace === on.trace && h.school === SMK && h.device === 'CANTEEN-01' && h.type === 'device.heartbeat').length === 1, {
    timeout: 15_000,
    message: 'CANTEEN-01 back, its first heartbeat held in the server-up flow',
  });

  // back to realtime: everything held goes on
  const realtime = lab.setSim({ mode: 'realtime' });
  assert.deepEqual(realtime.held, []);
  await waitFor(() => inTrace(on.trace, 'intake.accepted', (e) => e.school === SMK && e.data.device === 'CANTEEN-01' && e.data.type === 'device.heartbeat').length === 1, {
    message: 'the heartbeat in the server-up flow',
  });
  assert.equal(posted().length, 1, 'counted once');
  await booksBalance();
});

test('16.5 hold at the kiosk API: with the server off the call fails, and the next visit adds the money', NET, async () => {
  await lab.reset();
  lab.setSim({ mode: 'simulation', hold: true });
  const visit = await tap('KIOSK-01', AHMAD);
  assert.equal(visit.held, true);
  assert.deepEqual([visit.item.where, visit.item.type], ['machine', 'card.readback']);
  // Next: the read-back goes to the broker and waits at the platform; the kiosk asks what is waiting
  lab.simNext();
  const call = await waitFor(() => heldNow((h) => h.trace === visit.trace && h.where === 'kiosk-http')[0], { message: 'the pending call held' });
  assert.deepEqual([call.call, call.method, call.path, call.device], ['pending', 'POST', '/api/kiosk/pending', 'KIOSK-01']);
  await waitFor(() => heldNow((h) => h.trace === visit.trace && h.where === 'platform' && h.type === 'card.readback').length === 1, {
    message: 'the read-back at the platform',
  });

  // switch the server off, then let the call go: nothing answers, so the kiosk adds nothing
  await lab.setServer({ up: false });
  const next = lab.simNext();
  assert.deepEqual([next.released.id, next.waiting], [call.id, 1], 'the platform hop cannot go on while the server is off');
  await waitFor(() => inTrace(visit.trace, 'lab.action').length === 1, { message: 'the visit to finish' });
  assert.deepEqual(inTrace(visit.trace, 'device.http').map((e) => [e.data.call, e.data.status, e.data.ok, e.data.code]), [['pending', 0, false, 'NETWORK']]);
  assert.deepEqual(inTrace(visit.trace, 'lab.action').map((e) => [e.data.ok, e.data.reason]), [[false, 'PLATFORM_UNREACHABLE']]);
  assert.equal(inTrace(visit.trace, 'http.kiosk').length, 0, 'the platform never saw the call');
  assert.equal(lab.cards.get(`${SMK}/${AHMAD}`).balanceSen, 3000);

  // on again: the read-back goes on by itself; then, in realtime, the next visit adds the money
  await lab.setServer({ up: true });
  await waitFor(() => inTrace(visit.trace, 'intake.accepted', (e) => e.data.type === 'card.readback').length === 1, { message: 'the read-back processed' });
  lab.setSim({ mode: 'realtime' });
  await waitFor(() => machine('KIOSK-01').connected, { timeout: 15_000, message: 'the kiosk back on the broker' });
  const again = await tap('KIOSK-01', AHMAD);
  assert.equal(again.screen, 'Added RM 20.00 · Balance RM 50.00');
  assert.deepEqual(again.added.map((a) => [a.amountSen, a.confirmed]), [[2000, true]]);
  await booksBalance();
});

test('16.6 switching to realtime lets every held hop go on; a reset leaves nothing held', NET, async () => {
  await lab.reset();
  const b = browser();
  const mark = lab.ctx.events.lastSeq();
  ok(await b.post('/api/lab/sim', { mode: 'simulation' }));
  assert.deepEqual(ok(await b.post('/api/lab/sim', { hold: true })), { mode: 'simulation', hold: true, held: [] });
  const sale = await tap('CANTEEN-01', LEE, { items: items('TEH-TARIK') });
  const beat = await lab.heartbeat({ schoolCode: SMK, deviceCode: 'KIOSK-01' });
  const reboot = await lab.reboot({ schoolCode: 'sjkc-contoh', deviceCode: 'CANTEEN-01' });
  for (const answer of [sale, beat, reboot]) assert.equal(answer.held, true);
  assert.equal(beat.machine.code, 'KIOSK-01');
  assert.deepEqual([reboot.item.type, reboot.machine.lastScreen.text], ['device.heartbeat', 'Starting…'], 'the reboot waits for its first heartbeat');
  assert.deepEqual(heldNow().map((h) => h.trace), [sale.trace, beat.trace, reboot.trace]);
  // the clock moves at once; the connected machines' heartbeats at the new time wait at their outboxes
  const moved = await lab.advanceClock(60_000);
  assert.deepEqual([moved.held, moved.clock.kl, moved.item.type], [true, '05/10/2026 10:01', 'device.heartbeat']);
  assert.equal(lab.tracer.get(moved.trace).trace.title, 'Move the lab clock forward 1 min');

  // realtime: everything goes on, and each action finishes in the background
  assert.deepEqual(ok(await b.post('/api/lab/sim', { mode: 'realtime' })), { mode: 'realtime', hold: false, held: [] });
  assert.deepEqual(eventsSince(mark, 'sim.mode').map((e) => e.data), [{ mode: 'simulation', hold: false }, { mode: 'simulation', hold: true }, { mode: 'realtime', hold: false }]);
  await waitFor(() => eventsSince(mark, 'purchase.received', (e) => e.trace === sale.trace).length === 1, { message: 'the sale in the books' });
  await waitFor(() => inTrace(reboot.trace, 'lab.action').length === 1, { message: 'the reboot to finish' });
  assert.equal(lab.terminals.get('sjkc-contoh/CANTEEN-01').state.lastScreen.text, 'Ready');
  await waitFor(() => inTrace(beat.trace, 'intake.accepted').length === 1, { message: 'the heartbeat at the platform' });
  await waitFor(() => inTrace(moved.trace, 'intake.accepted').length >= 4, { message: 'the clock move\'s heartbeats at the platform' });

  // the API checks what it is given
  for (const body of [{}, { mode: 'fast' }, { hold: 'yes' }, { mode: 'realtime', hold: true }, { hold: true }]) {
    assert.equal(ok(await b.post('/api/lab/sim', body), 400).error.code, 'INPUT_INVALID', JSON.stringify(body));
  }

  // held again, then a reset: nothing waits, nothing is traced, back in realtime
  lab.setSim({ mode: 'simulation', hold: true });
  assert.equal((await tap('CANTEEN-01', ARJUN, { items: items('TEH-TARIK') })).held, true);
  assert.equal(heldNow().length, 1);
  await lab.reset();
  assert.deepEqual(lab.simState(), { mode: 'realtime', hold: false, held: [] });
  assert.deepEqual(lab.state().sim, { mode: 'realtime', hold: false, held: [] });
  assert.equal(lab.platform.inboxWaiting(), 0);
  assert.deepEqual(lab.tracer.list(), []);
  await booksBalance();
});

test('16.7 a held fault that can no longer finish says so in its trace', NET, async () => {
  await lab.reset();
  await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  lab.setSim({ mode: 'simulation', hold: true });
  const dup = await lab.fault({ type: 'duplicate-upload', schoolCode: SMK, deviceCode: 'CANTEEN-01' });
  assert.deepEqual([dup.held, dup.fault, dup.machine, dup.item.type], [true, 'duplicate-upload', `${SMK}/CANTEEN-01`, 'sale.recorded']);
  assert.equal(lab.tracer.get(dup.trace).trace.title, `Fault: duplicate upload from ${SMK}/CANTEEN-01`);
  await lab.setCable({ schoolCode: SMK, deviceCode: 'CANTEEN-01', plugged: false });
  lab.simNext();
  const failed = await waitFor(() => inTrace(dup.trace, 'lab.action')[0], { message: 'the fault to end' });
  assert.deepEqual({ ...failed.data, message: undefined }, {
    action: 'fault',
    type: 'duplicate-upload',
    device: 'CANTEEN-01',
    ok: false,
    code: 'MACHINE_OFFLINE',
    message: undefined,
  });
  lab.setSim({ mode: 'realtime' });
  await booksBalance();
});

test('16.8 a school office request is a trace too: the price list, the machines taking it, their acks coming home', NET, async () => {
  await lab.reset();
  const office = await staff(SMK, 'OFFICE');
  const { prices } = ok(await office.get('/api/admin/configs'));
  const content = structuredClone(prices.content);
  content.items.find((i) => i.code === 'NASI-LEMAK').priceSen = 380;
  ok(await office.post('/api/admin/configs/prices', { content }), 201);
  const request = lab.tracer.list().find((t) => t.title === 'School office: POST /api/admin/configs/prices');
  assert.ok(request, 'the request started a trace');
  assert.deepEqual([request.kind, request.school], ['request', SMK]);
  const acked = () => inTrace(request.id, 'intake.accepted', (e) => e.data.type === 'command.ack').map((e) => e.data.device).sort();
  await waitFor(() => acked().length === 2, { timeout: 5000, message: "the networked machines' acks at the platform" });
  assert.deepEqual(acked(), ['CANTEEN-01', 'KIOSK-01']);
  assert.deepEqual(inTrace(request.id, 'config.published').map((e) => [e.data.kind, e.data.version]), [['prices', 2]]);
  assert.deepEqual(inTrace(request.id, 'platform.send').map((e) => [e.data.device, e.data.type, e.data.retained]).sort(), [
    ['CANTEEN-01', 'config.prices', true],
    ['CANTEEN-02', 'config.prices', true],
    ['KIOSK-01', 'config.prices', true],
    ['WATER-01', 'config.prices', true],
  ]);
  assert.deepEqual(inTrace(request.id, 'device.received').map((e) => [e.data.device, e.data.kind, e.data.version, e.data.result]).sort(), [
    ['CANTEEN-01', 'prices', 2, 'APPLIED'],
    ['KIOSK-01', 'prices', 2, 'APPLIED'],
  ]);
  // each ack answers its command (inReplyTo), and joins the flow that sent it
  const sends = inTrace(request.id, 'platform.send');
  for (const ack of inTrace(request.id, 'device.send', (e) => e.data.type === 'command.ack')) {
    assert.ok(sends.some((s) => s.data.msgId === ack.data.inReplyTo), 'the ack names its command');
  }
  await booksBalance();
});

test('16.9 no leakage: the timer\'s heartbeats belong to no flow, even right after traced actions', NET, async (t) => {
  const quick = createLab({ clockMode: 'manual', httpPort: 0, mqttPort: 0, consolePort: 0, jobsMs: 0, heartbeatMs: 150, log: labLog });
  t.after(() => quick.stop());
  await quick.start();
  const where = { schoolCode: SMK, deviceCode: 'CANTEEN-01' };
  const sale = await quick.tap({ ...where, uid: AHMAD, items: items('NASI-LEMAK') });
  await quick.setCable({ ...where, plugged: false });
  const plug = await quick.setCable({ ...where, plugged: true });
  const reboot = await quick.reboot(where);
  const beat = await quick.heartbeat(where);
  for (const answer of [sale, plug, reboot, beat]) assert.match(answer.trace, /^tr_/);
  // the plug's and the reboot's first heartbeats were theirs
  assert.equal(quick.tracer.get(plug.trace).events.filter((e) => e.type === 'device.send' && e.data.type === 'device.heartbeat').length, 1);
  assert.equal(quick.tracer.get(reboot.trace).events.filter((e) => e.type === 'device.send' && e.data.type === 'device.heartbeat').length, 1);
  const mark = quick.ctx.events.lastSeq();
  const beats = () => quick.ctx.events.since(mark).filter((e) => e.type === 'device.send' && e.data.type === 'device.heartbeat' && e.data.device === 'CANTEEN-01');
  await waitFor(() => beats().length >= 3, { timeout: 5000, message: "the timer's heartbeats" });
  const ids = new Set(beats().map((e) => e.data.msgId));
  const theirs = quick.ctx.events.since(mark).filter((e) => ids.has(e.data?.msgId) || ids.has(e.msgId));
  assert.ok(theirs.some((e) => e.type === 'intake.accepted') && theirs.some((e) => e.type === 'mqtt.publish'));
  for (const e of theirs) assert.equal(e.trace, undefined, `${e.type} of a timer heartbeat`);

  // with hold on, what belongs to no flow never waits: the timer's heartbeats go on as in realtime
  quick.setSim({ mode: 'simulation', hold: true });
  const holdMark = quick.ctx.events.lastSeq();
  const accepted = () => quick.ctx.events.since(holdMark).filter((e) => e.type === 'intake.accepted' && e.data.type === 'device.heartbeat');
  await waitFor(() => accepted().length >= 5, { timeout: 5000, message: "the timer's heartbeats while hold is on" });
  assert.deepEqual(quick.simState().held, []);
  assert.ok(accepted().every((e) => e.trace === undefined));
  assert.deepEqual(errors, []);
});
