import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// Live stepping in the lab (docs/DESIGN.md §11.4), at its awkward moments: Next pressed while
// the server goes down or the broker restarts, hold switched on while the server comes up, two
// machines held at once, a held admin-card load with a visit queued behind it, a held clock
// move, and a reset or stop with flows held at every hop. After each one every record is home
// exactly once, every school's books balance and every card equals its mirror, and nothing is
// left held. A real lab: the demo seed (fictional schools, people and cards), broker and web
// server on random ports, the lab clock standing still.

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
