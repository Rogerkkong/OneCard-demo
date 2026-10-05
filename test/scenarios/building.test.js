import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// Building the lab by drag and drop (docs/DESIGN.md §12), against a real lab: the lab console
// adds a machine to a school, or a whole school, through the lab API, the way the school office
// and the operator console do it. The demo seed (fictional schools, people and cards), broker and
// web server on random ports, the lab clock standing still. Most exercises start from a fresh
// demo (lab.reset()).

const NET = { timeout: 60_000 };
const SMK = 'smk-contoh';
const SJKC = 'sjkc-contoh';
const LEE = '04B2194E6A3C81'; // S1002: RM 25.00 on the card

let lab;
let base;
const errors = [];
const labLog = (level, message, meta) => {
  if (level === 'error') errors.push(`${message} ${JSON.stringify(meta ?? {})}`);
};

before(async () => {
  // machines retry the broker after 200 ms (doubling): back soon after the server is switched on
  lab = createLab({ clockMode: 'manual', httpPort: 0, mqttPort: 0, consolePort: 0, jobsMs: 0, reconnectMs: 200, log: labLog });
  base = (await lab.start()).httpUrl;
});

// whatever an exercise left held (a failed one too), the next one starts in realtime
afterEach(() => {
  if (lab?.phase === 'running') lab.setSim({ mode: 'realtime' });
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
    return { status: res.status, body: data, text };
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

/** The error code of a refused call, checking its HTTP status. */
function refused(res, status) {
  assert.equal(res.status, status, `HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.error.code;
}

/** A school office browser signed in as that school's staff member of `role`. */
async function staff(schoolCode, role) {
  const b = browser();
  const options = ok(await b.get('/api/admin/staff-options'));
  const who = options.find((s) => s.schoolCode === schoolCode && s.role === role);
  assert.ok(who, `${role} of ${schoolCode}`);
  ok(await b.post('/api/admin/login', { staffId: who.id }));
  return b;
}

const lab$ = browser(); // the lab console
const state = async () => ok(await lab$.get('/api/lab/state'));
const siteOf = async (code) => (await state()).schools.find((s) => s.code === code);
const nextCode = async (schoolCode, type) => ok(await lab$.get(`/api/lab/devices/next-code?schoolCode=${schoolCode}&type=${type}`)).code;
const machine = (key) => lab.terminals.get(key);
const eventsSince = (mark, type, match = () => true) => lab.ctx.events.since(mark).filter((e) => e.type === type && match(e));
/** The events a trace keeps, in order. */
const traced = (id) => lab.tracer.get(id)?.events ?? [];
const inTrace = (id, type, match = () => true) => traced(id).filter((e) => e.type === type && match(e));
const heldNow = (match = () => true) => lab.simState().held.filter(match);
/** A purchase's verdicts at the platform since `mark`: [[status, via]]. */
const verdicts = (mark, school, txn) =>
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

test('12.1 next-code: the next free code of each type, from what the platform has registered', NET, async () => {
  await lab.reset();
  assert.equal(await nextCode(SMK, 'CANTEEN'), 'CANTEEN-03'); // CANTEEN-01 and CANTEEN-02 are there
  assert.equal(await nextCode(SMK, 'WATER'), 'WATER-02');
  assert.equal(await nextCode(SMK, 'KIOSK'), 'KIOSK-02');
  assert.equal(await nextCode(SJKC, 'canteen'), 'CANTEEN-02', 'any case');

  // the school office registers CANTEEN-04: the lab installs it as always (a reader comes plugged
  // in), and the suggestion fills the gap first
  const office = await staff(SMK, 'OFFICE');
  ok(await office.post('/api/admin/devices', { code: 'CANTEEN-04', type: 'CANTEEN', location: 'Staff room' }), 201);
  await waitFor(() => machine(`${SMK}/CANTEEN-04`)?.connected, { timeout: 10_000, message: 'the office-registered reader online' });
  assert.equal(machine(`${SMK}/CANTEEN-04`).cablePlugged, true, "an office registration keeps today's cable");
  assert.equal(await nextCode(SMK, 'CANTEEN'), 'CANTEEN-03');
  // a number taken in any spelling is taken
  ok(await office.post('/api/admin/devices', { code: 'CANTEEN-3', type: 'CANTEEN' }), 201);
  assert.equal(await nextCode(SMK, 'CANTEEN'), 'CANTEEN-05');

  assert.equal(refused(await lab$.get('/api/lab/devices/next-code?type=CANTEEN'), 400), 'INPUT_INVALID');
  assert.equal(refused(await lab$.get(`/api/lab/devices/next-code?schoolCode=${SMK}`), 400), 'INPUT_INVALID');
  assert.equal(refused(await lab$.get(`/api/lab/devices/next-code?schoolCode=${SMK}&type=TOASTER`), 400), 'INPUT_INVALID');
  assert.equal(refused(await lab$.get('/api/lab/devices/next-code?schoolCode=nowhere&type=CANTEEN'), 404), 'SCHOOL_NOT_FOUND');
  assert.equal(refused(await lab$.get('/api/lab/devices/next-code?schoolCode=Not%20A%20Code&type=CANTEEN'), 404), 'SCHOOL_NOT_FOUND');
  await booksBalance();
});

test('12.2 add a canteen reader: registered on the platform, installed with its cable out; plugged in, its sale is booked once', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  const added = ok(await lab$.post('/api/lab/devices', { schoolCode: SMK, type: 'CANTEEN', location: 'Canteen counter C' }));
  assert.match(added.trace, /^tr_/);
  const m = added.machine;
  assert.deepEqual([m.school, m.code, m.type, m.location, m.deviceStatus], [SMK, 'CANTEEN-03', 'CANTEEN', 'Canteen counter C', 'ACTIVE']);
  assert.deepEqual([m.cablePlugged, m.connected, m.online], [false, false, false], 'a dangling cable');
  assert.ok(m.versions.prices >= 1 && m.versions.settings >= 1 && m.versions.blocklist >= 1, 'installed with the current settings');

  // the platform has it, as the lab registered it; its secret never leaves the lab
  const { devices, schools } = lab.platform.services;
  const school = schools.getSchoolByCode(SMK);
  const found = devices.resolveByCodes(SMK, 'CANTEEN-03');
  assert.equal(found.device.type, 'CANTEEN');
  assert.ok(!JSON.stringify(added).includes(found.secret));
  assert.ok(!(await lab$.get('/api/lab/state')).text.includes(found.secret));
  assert.deepEqual(schools.listAudit(school.id).filter((a) => a.action === 'device.register').map((a) => [a.actor, a.detail.code]).slice(0, 1), [['lab', 'CANTEEN-03']]);
  // and the lab console's view of the site is the same machine
  assert.deepEqual((await siteOf(SMK)).devices.find((d) => d.code === 'CANTEEN-03'), m);
  assert.deepEqual(eventsSince(mark, 'mqtt.connect', (e) => e.data.username === `${SMK}.CANTEEN-03`), [], 'not on the broker');

  // draw the cable to the school network: it connects
  const plug = ok(await lab$.post('/api/lab/cable', { schoolCode: SMK, deviceCode: 'CANTEEN-03', plugged: true }));
  assert.deepEqual([plug.machine.cablePlugged, plug.machine.connected], [true, true]);

  // a seeded card buys at the new reader: the sale reaches the books once
  const sale = ok(await lab$.post('/api/lab/tap', { schoolCode: SMK, deviceCode: 'CANTEEN-03', uid: LEE, items: [{ code: 'ROTI-CANAI', qty: 1 }] }));
  assert.deepEqual([sale.ok, sale.sent, sale.screen], [true, true, 'Paid RM 1.50 · Balance RM 23.50']);
  await waitFor(() => verdicts(mark, SMK, 'CANTEEN-03-000001').length === 1, { message: 'the sale in the books' });
  assert.deepEqual(verdicts(mark, SMK, 'CANTEEN-03-000001'), [['POSTED', 'MQTT']]);
  await booksBalance();
  assert.deepEqual(verdicts(mark, SMK, 'CANTEEN-03-000001'), [['POSTED', 'MQTT']], 'counted once');
  const card = lab.checkBooks().schools.find((s) => s.code === SMK).cards.find((c) => c.uid === LEE);
  assert.deepEqual([card.cardSen, card.mirrorSen], [2350, 2350]);
});

test('12.3 add a water machine with its cable plugged in: it connects by itself and reports in', NET, async () => {
  await lab.reset();
  const added = ok(await lab$.post('/api/lab/devices', { schoolCode: SJKC, type: 'WATER', cablePlugged: true }));
  assert.deepEqual([added.machine.code, added.machine.cablePlugged, added.machine.connected], ['WATER-02', true, true]);
  assert.equal(added.machine.location, '');
  await waitFor(async () => (await siteOf(SJKC)).devices.find((d) => d.code === 'WATER-02')?.online, { message: 'its heartbeat at the platform' });
  // and it pours for a card of its school
  const pour = ok(await lab$.post('/api/lab/tap', { schoolCode: SJKC, deviceCode: 'WATER-02', uid: '0429C58FE17A88', ml: 500 }));
  assert.deepEqual([pour.ok, pour.sent], [true, true]);
  await booksBalance();
});

test('12.4 what the lab API refuses: every code, and a refused add leaves no trace', NET, async () => {
  await lab.reset();
  const traces = () => lab.tracer.list({ limit: 200 }).filter((t) => t.kind === 'add-device' || t.kind === 'add-school').length;
  const add = (body) => lab$.post('/api/lab/devices', body);
  const good = { schoolCode: SMK, type: 'CANTEEN' };
  for (const body of [
    { ...good, type: undefined },
    { ...good, type: 'TOASTER' },
    { ...good, type: 5 },
    { ...good, code: 'CANTEEN 03' },
    { ...good, code: '-CANTEEN' },
    { ...good, code: 42 },
    { ...good, location: 'x'.repeat(61) },
    { ...good, location: 7 },
    { ...good, cablePlugged: 'yes' },
    { ...good, schoolCode: undefined },
    { ...good, schoolCode: 12 },
  ]) {
    assert.equal(refused(await add(body), 400), 'INPUT_INVALID', JSON.stringify(body));
  }
  assert.equal(refused(await lab$.post('/api/lab/devices', ['not', 'an', 'object']), 400), 'BAD_JSON');
  assert.equal(refused(await add({ ...good, schoolCode: 'smk-nowhere' }), 404), 'SCHOOL_NOT_FOUND');
  assert.equal(refused(await add({ ...good, code: 'CANTEEN-01' }), 409), 'DEVICE_CODE_TAKEN');
  assert.equal(refused(await add({ ...good, code: 'canteen-02' }), 409), 'DEVICE_CODE_TAKEN', 'any case');
  ok(await add({ ...good, location: 'x'.repeat(60) }), 200); // the longest location fits

  // a suspended school takes no new machine
  const operator = browser();
  ok(await operator.post('/api/operator/login'));
  ok(await operator.post(`/api/operator/schools/${SJKC}/status`, { status: 'SUSPENDED' }));
  assert.equal((await siteOf(SJKC)).status, 'SUSPENDED', 'the lab console sees the suspension');
  assert.equal(refused(await add({ ...good, schoolCode: SJKC }), 409), 'SCHOOL_SUSPENDED');
  ok(await operator.post(`/api/operator/schools/${SJKC}/status`, { status: 'ACTIVE' }));

  // schools
  const school = (body) => lab$.post('/api/lab/schools', body);
  const fine = { name: 'SMK Baru (fictional)', code: 'smk-baru' };
  for (const body of [
    { ...fine, code: undefined },
    { ...fine, name: undefined },
    { ...fine, name: 42 },
    { ...fine, machines: 'all of them' },
    { ...fine, machines: Array.from({ length: 13 }, () => ({ type: 'CANTEEN' })) },
    { ...fine, machines: [{ type: 'TOASTER' }] },
    { ...fine, machines: ['CANTEEN'] },
    { ...fine, machines: [{ type: 'WATER', location: 'x'.repeat(61) }] },
    { ...fine, machines: [{ type: 'CANTEEN', code: 'CANTEEN-07' }, { type: 'CANTEEN', code: 'canteen-07' }] },
    { ...fine, students: 51 },
    { ...fine, students: -1 },
    { ...fine, students: 2.5 },
    { ...fine, students: '3' },
  ]) {
    assert.equal(refused(await school(body), 400), 'INPUT_INVALID', JSON.stringify(body));
  }
  assert.equal(refused(await school({ ...fine, code: 'smk baru!' }), 400), 'SCHOOL_CODE_INVALID');
  assert.equal(refused(await school({ ...fine, name: '   ' }), 400), 'NAME_INVALID');
  assert.equal(refused(await school({ ...fine, name: 'S'.repeat(101) }), 400), 'NAME_INVALID');
  assert.equal(refused(await school({ ...fine, code: SMK }), 409), 'SCHOOL_CODE_TAKEN');
  assert.equal(refused(await school({ ...fine, code: 'SMK-Contoh' }), 409), 'SCHOOL_CODE_TAKEN', 'codes are lower case');

  // registering needs the cloud server: while it is off both adds say so
  await lab.setServer({ up: false });
  assert.equal(refused(await add(good), 409), 'SERVER_DOWN');
  assert.equal(refused(await school(fine), 409), 'SERVER_DOWN');
  assert.equal(await nextCode(SMK, 'WATER'), 'WATER-02', 'the suggestion still works');
  await lab.setServer({ up: true });

  assert.equal(traces(), 1, 'only the one add that went through started a flow');
  await booksBalance();
});

test('12.5 add a school with 3 students: its site, machines, cards and admin card, as onboarding gives them; its reader sells', NET, async () => {
  await lab.reset();
  const mark = lab.ctx.events.lastSeq();
  const added = ok(await lab$.post('/api/lab/schools', { name: 'SMK Bukit Contoh (fictional)', code: 'smk-bukit', students: 3 }));
  assert.deepEqual(added.school, { code: 'smk-bukit', name: 'SMK Bukit Contoh (fictional)' });
  assert.match(added.trace, /^tr_/);
  assert.deepEqual(added.machines.map((m) => [m.code, m.type, m.cablePlugged, m.connected]), [
    ['CANTEEN-01', 'CANTEEN', false, false],
    ['WATER-01', 'WATER', false, false],
    ['KIOSK-01', 'KIOSK', false, false],
  ]);

  // the lab console's view: like any onboarded school
  const site = await siteOf('smk-bukit');
  assert.deepEqual([site.name, site.status], ['SMK Bukit Contoh (fictional)', 'ACTIVE']);
  assert.deepEqual(site.devices.map((d) => [d.code, d.cablePlugged]).sort(), [['CANTEEN-01', false], ['KIOSK-01', false], ['WATER-01', false]]);
  assert.equal(site.cards.length, 3);
  for (const c of site.cards) assert.deepEqual([c.balanceSen, c.platformStatus, c.copy, Boolean(c.member)], [0, 'ACTIVE', false, true]);
  assert.ok(site.adminCard, 'its admin card');
  assert.deepEqual(inTrace(added.trace, 'tenant.created').map((e) => e.data), [{ code: 'smk-bukit', name: 'SMK Bukit Contoh (fictional)' }]);
  assert.equal(inTrace(added.trace, 'device.registered').length, 3);
  assert.equal(inTrace(added.trace, 'card.issued').length, 3);
  assert.deepEqual(eventsSince(mark, 'mqtt.connect', (e) => e.school === 'smk-bukit'), [], 'no machine on the broker yet');
  // one fictional staff member per office role
  const people = ok(await lab$.get('/api/admin/staff-options')).filter((s) => s.schoolCode === 'smk-bukit');
  assert.deepEqual(people.map((p) => p.role).sort(), ['ADMIN', 'FINANCE', 'OFFICE']);

  // cables in for the kiosk and the reader
  for (const deviceCode of ['KIOSK-01', 'CANTEEN-01']) {
    assert.equal(ok(await lab$.post('/api/lab/cable', { schoolCode: 'smk-bukit', deviceCode, plugged: true })).machine.connected, true, deviceCode);
  }
  const [first, second] = site.cards;
  // an empty card: the plain refusal
  const empty = ok(await lab$.post('/api/lab/tap', { schoolCode: 'smk-bukit', deviceCode: 'CANTEEN-01', uid: second.uid, items: ['NASI-LEMAK'] }));
  assert.deepEqual([empty.ok, empty.reason, empty.screen], [false, 'INSUFFICIENT_BALANCE', 'Not enough balance · Balance RM 0.00']);
  // money on the first card: a subsidy from the office, added at the kiosk
  const finance = await staff('smk-bukit', 'FINANCE');
  const member = ok(await finance.get('/api/admin/members')).find((x) => x.card?.uid === first.chipUid);
  ok(await finance.post('/api/admin/subsidies', { memberId: member.id, amountSen: 1000, note: 'welcome' }), 201);
  const visit = ok(await lab$.post('/api/lab/tap', { schoolCode: 'smk-bukit', deviceCode: 'KIOSK-01', uid: first.uid }));
  assert.equal(visit.screen, 'Added RM 10.00 · Balance RM 10.00');
  const sale = ok(await lab$.post('/api/lab/tap', { schoolCode: 'smk-bukit', deviceCode: 'CANTEEN-01', uid: first.uid, items: ['NASI-LEMAK'] }));
  assert.deepEqual([sale.ok, sale.screen], [true, 'Paid RM 3.50 · Balance RM 6.50']);
  await waitFor(() => verdicts(mark, 'smk-bukit', sale.record.txn).length === 1, { message: 'the sale in the books' });
  assert.deepEqual(verdicts(mark, 'smk-bukit', sale.record.txn), [['POSTED', 'MQTT']]);
  await booksBalance();
  const card = lab.checkBooks().schools.find((s) => s.code === 'smk-bukit').cards.find((c) => c.uid === first.uid);
  assert.deepEqual([card.cardSen, card.mirrorSen], [650, 650]);

  // named machines and no students: codes filled in around the ones given
  const other = ok(await lab$.post('/api/lab/schools', {
    name: 'SJK(T) Contoh (fictional)',
    code: 'sjkt-contoh',
    students: 0,
    machines: [{ type: 'CANTEEN' }, { type: 'CANTEEN', code: 'CANTEEN-01', location: 'Hall' }, { type: 'KIOSK' }],
  }));
  assert.deepEqual(other.machines.map((m) => [m.code, m.location]), [['CANTEEN-02', ''], ['CANTEEN-01', 'Hall'], ['KIOSK-01', '']]);
  assert.equal((await siteOf('sjkt-contoh')).cards.length, 0);
  await booksBalance();
});

test('12.6 Simulation: an add with its cable plugged in replays as one flow: registration, plug, broker login, first heartbeat', NET, async () => {
  await lab.reset();
  ok(await lab$.post('/api/lab/sim', { mode: 'simulation' }));
  const added = ok(await lab$.post('/api/lab/devices', { schoolCode: SMK, type: 'KIOSK', location: 'Library', cablePlugged: true }));
  await waitFor(() => inTrace(added.trace, 'intake.accepted', (e) => e.data.type === 'device.heartbeat').length === 1, { message: 'the first heartbeat at the platform' });
  const { trace, events } = ok(await lab$.get(`/api/lab/sim/traces/${added.trace}`));
  assert.deepEqual([trace.kind, trace.title, trace.school, trace.device], ['add-device', `Add a top-up kiosk KIOSK-02 to ${SMK}`, SMK, 'KIOSK-02']);
  assert.deepEqual(trace.subject, { school: SMK, type: 'KIOSK', code: 'KIOSK-02' });
  assert.deepEqual(events[0].data.subject, trace.subject);
  assert.ok(events.every((e) => e.trace === added.trace), 'every hop carries the trace');
  const at = (type, match = () => true) => events.findIndex((e) => e.type === type && match(e));
  const registered = at('device.registered', (e) => e.data.code === 'KIOSK-02');
  const configs = events.filter((e) => e.type === 'platform.send' && e.data.device === 'KIOSK-02');
  const plugged = at('device.cable', (e) => e.data.device === 'KIOSK-02' && e.data.plugged === true);
  const login = at('mqtt.connect', (e) => e.data.username === `${SMK}.KIOSK-02`);
  const beat = at('device.send', (e) => e.data.device === 'KIOSK-02' && e.data.type === 'device.heartbeat');
  assert.deepEqual(configs.map((e) => [e.data.type, e.data.retained]), [['config.prices', true], ['config.settings', true], ['blocklist.snapshot', true]]);
  assert.ok(registered > 0 && registered < events.indexOf(configs[0]) && events.indexOf(configs.at(-1)) < plugged, 'registered and its settings sent before the plug');
  assert.ok(plugged < login && login < beat, 'plugged, logged in, then its first heartbeat');
  // the settings sent at registration wait at the broker and reach the kiosk when it logs in: its acks are in the flow too
  await waitFor(() => inTrace(added.trace, 'intake.accepted', (e) => e.data.type === 'command.ack').length === 3, { message: "the kiosk's acks" });

  // a reader added with its cable out, plugged in later: the plug's flow has the login and the first heartbeat
  const reader = ok(await lab$.post('/api/lab/devices', { schoolCode: SMK, type: 'CANTEEN' }));
  assert.deepEqual(inTrace(reader.trace, 'mqtt.connect'), [], 'no login while the cable is out');
  const plug = ok(await lab$.post('/api/lab/cable', { schoolCode: SMK, deviceCode: reader.machine.code, plugged: true }));
  await waitFor(() => inTrace(plug.trace, 'intake.accepted', (e) => e.data.type === 'device.heartbeat').length === 1, { message: "the plug's heartbeat" });
  const flow = traced(plug.trace);
  assert.ok(flow.every((e) => e.trace === plug.trace));
  assert.deepEqual(flow.filter((e) => ['device.cable', 'mqtt.connect'].includes(e.type) || (e.type === 'device.send' && e.data.type === 'device.heartbeat')).map((e) => e.type), [
    'device.cable',
    'mqtt.connect',
    'device.send',
  ]);
  assert.equal(lab.tracer.get(plug.trace).trace.subject.plugged, true);
  // its acks of the settings sent when it was added answer commands of the add's flow, and join it
  await waitFor(() => inTrace(reader.trace, 'intake.accepted', (e) => e.data.type === 'command.ack').length === 3, { message: "the reader's acks" });

  // hold at each hop: the add answers at its first held hop (the heartbeat in the outbox), Next lets it go on
  ok(await lab$.post('/api/lab/sim', { hold: true }));
  const held = ok(await lab$.post('/api/lab/devices', { schoolCode: SJKC, type: 'WATER', cablePlugged: true }));
  assert.equal(held.held, true);
  assert.deepEqual([held.item.where, held.item.type, held.item.device, held.machine.code, held.machine.cablePlugged], ['machine', 'device.heartbeat', 'WATER-02', 'WATER-02', true]);
  assert.ok(heldNow().every((h) => h.trace === held.trace), 'only this flow waits');
  await stepUntil(() => inTrace(held.trace, 'lab.action').length === 1 && inTrace(held.trace, 'intake.accepted', (e) => e.data.type === 'device.heartbeat').length === 1,
    'the add to finish');
  assert.deepEqual(inTrace(held.trace, 'lab.action').map((e) => [e.data.action, e.data.device, e.data.cablePlugged]), [['add-device', 'WATER-02', true]]);
  ok(await lab$.post('/api/lab/sim', { mode: 'realtime' }));
  await booksBalance();
});

test('12.7 a reset removes what the lab console added, and an add the reset overtakes answers LAB_BUSY (503)', NET, async () => {
  await lab.reset();
  ok(await lab$.post('/api/lab/schools', { name: 'SMK Awal (fictional)', code: 'smk-awal', students: 1 }));
  ok(await lab$.post('/api/lab/devices', { schoolCode: SMK, type: 'CANTEEN' }));
  await lab.reset();
  assert.equal(await siteOf('smk-awal'), undefined, 'the added school is gone');
  assert.deepEqual([...lab.terminals.keys()].filter((k) => k.startsWith('smk-awal/') || k === `${SMK}/CANTEEN-03`), []);
  assert.deepEqual([...lab.cards.keys()].filter((k) => k.startsWith('smk-awal/')), []);
  assert.equal(await nextCode(SMK, 'CANTEEN'), 'CANTEEN-03');

  // The platform registers, then answers late (as while it waits for the broker): a reset gets in
  // between, and the machines the adds were waiting for belong to the old demo.
  const { platform } = lab;
  const original = { registerDevice: platform.registerDevice, createTenant: platform.createTenant };
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  platform.registerDevice = async (args) => {
    const out = await original.registerDevice(args);
    await late;
    return out;
  };
  platform.createTenant = async (args) => {
    const out = await original.createTenant(args);
    await late;
    return out;
  };
  try {
    const adds = Promise.allSettled([
      lab.addDevice({ schoolCode: SMK, type: 'WATER' }),
      lab.addSchool({ code: 'smk-lewat', name: 'SMK Lewat (fictional)', students: 0 }),
    ]);
    await waitFor(() => machine(`${SMK}/WATER-02`) && machine('smk-lewat/KIOSK-01'), { message: 'both adds installed' });
    const resetting = lab.reset();
    await waitFor(() => !machine(`${SMK}/WATER-02`) && !machine('smk-lewat/KIOSK-01'), { message: 'the reset took them away' });
    release();
    const [device, school] = await adds;
    for (const [what, outcome] of [['add machine', device], ['add school', school]]) {
      assert.equal(outcome.status, 'rejected', what);
      assert.deepEqual([outcome.reason.code, outcome.reason.status], ['LAB_BUSY', 503], `${what}: ${outcome.reason.message}`);
    }
    await resetting;
  } finally {
    Object.assign(platform, original);
    release();
  }
  assert.equal(await siteOf('smk-lewat'), undefined);
  assert.equal(machine(`${SMK}/WATER-02`), undefined);
  await booksBalance();
});
