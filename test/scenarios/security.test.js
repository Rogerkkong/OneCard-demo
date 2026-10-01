import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// docs/SCENARIOS.md exercises 9, 10 and 13 against a real lab (fictional seed, random ports, the
// lab clock standing still): new prices and the machines that get them late, device security
// (forged and replayed messages, a machine publishing on another's topic, machines switched off,
// a school suspended), and reconciliation. Each exercise starts from a fresh demo.

const NET = { timeout: 60_000 };
const SMK = 'smk-contoh';
const SJKC = 'sjkc-contoh';
const AHMAD = '04A13B5C7D2E80'; // S1001: RM 30.00
const LEE = '04B2194E6A3C81'; // S1002: RM 25.00
const UNAVAILABLE = 'Card unavailable, please contact the front desk';
const DAY_MS = 24 * 3600 * 1000;

let lab;
let base;
const errors = [];

before(async () => {
  lab = createLab({
    clockMode: 'manual',
    httpPort: 0,
    mqttPort: 0,
    consolePort: 0,
    jobsMs: 0,
    log: (level, message, meta) => {
      if (level === 'error') errors.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
  });
  base = (await lab.start()).httpUrl;
});

after(async () => {
  await lab?.stop();
});

// ---- helpers (each scenario file keeps its own copy) --------------------------------------

/** A browser of one person: JSON calls with its own cookies. */
function browser() {
  const jar = new Map();
  async function call(method, path, { json, form, headers = {} } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
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
      // an HTML page (the mock bank) stays text
    }
    return { status: res.status, body: data, headers: res.headers };
  }
  return {
    get: (path, headers) => call('GET', path, { headers }),
    post: (path, json = {}, headers) => call('POST', path, { json, headers }),
    form: (path, fields) => call('POST', path, { form: fields }),
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

/** A parent app browser signed in as the demo parent with this name. */
async function parent(name) {
  const b = browser();
  const who = ok(await b.get('/api/parent/options')).find((p) => p.name === name);
  ok(await b.post('/api/parent/login', { parentId: who.id }));
  return b;
}

async function child(p, name) {
  const { children } = ok(await p.get('/api/parent/children'));
  const found = children.find((c) => c.name.startsWith(name));
  assert.ok(found, `${name} among ${children.map((c) => c.name)}`);
  return found;
}

const balanceOf = async (p, c) => ok(await p.get(`/api/parent/children/${c.schoolId}/${c.memberId}/balance`));

let topupNo = 0;
/** A parent tops up a child and pays at the mock bank (the bank page, then its Pay form). */
async function topUpAndPay(p, c, amountSen) {
  const { order, payUrl } = ok(await p.post(`/api/parent/children/${c.schoolId}/${c.memberId}/topups`, { amountSen }, { 'idempotency-key': `scenario-${++topupNo}` }), 201);
  assert.equal(order.status, 'CREATED');
  const page = await p.get(payUrl);
  assert.equal(page.status, 200);
  assert.match(page.body, /Mock Bank/);
  const paid = await p.form(payUrl, { result: 'SUCCESS' });
  assert.equal(paid.status, 303);
  assert.equal(paid.headers.get('location'), '/parent/');
  return order;
}

async function member(office, memberNo) {
  const found = ok(await office.get('/api/admin/members')).find((m) => m.memberNo === memberNo);
  assert.ok(found, memberNo);
  return found;
}

const tap = (deviceCode, uid, more = {}) => lab.tap({ schoolCode: SMK, deviceCode, uid, ...more });
const items = (...codes) => codes.map((code) => ({ code, qty: 1 }));
const eventsSince = (mark, type, match = () => true) => lab.ctx.events.since(mark).filter((e) => e.type === type && match(e));

/**
 * The end of every exercise: bring every record home (cables in, journals uploaded), then
 * every school's books balance and every card holds what its mirror says.
 */
async function booksBalance() {
  for (const m of lab.terminals.values()) {
    if (!m.cablePlugged) await lab.setCable({ schoolCode: m.schoolCode, deviceCode: m.deviceCode, plugged: true });
  }
  await waitFor(() => [...lab.terminals.values()].every((m) => m.connected && m.state.journal.unsent === 0), {
    timeout: 20_000,
    message: 'every machine connected with its journal uploaded',
  });
  await waitFor(() => lab.checkBooks().ok, { message: 'every card equal to its mirror' });
  for (const s of lab.checkBooks().schools) assert.equal(s.balanced, true, `${s.code} trial balance`);
  assert.deepEqual(errors, []);
}

const machine = (code, school = SMK) => lab.terminals.get(`${school}/${code}`);

async function operator() {
  const b = browser();
  ok(await b.post('/api/operator/login'));
  return b;
}

// ---- the exercises -------------------------------------------------------------------------

test('9. New prices', NET, async () => {
  const office = await staff(SMK, 'OFFICE');
  const { prices } = ok(await office.get('/api/admin/configs'));
  const content = structuredClone(prices.content);
  content.items.find((i) => i.code === 'NASI-LEMAK').priceSen = 380;
  const mark = lab.ctx.events.lastSeq();
  const published = ok(await office.post('/api/admin/configs/prices', { content }), 201);
  assert.deepEqual([published.kind, published.version, published.published], ['prices', 2, true]);
  // networked machines get it at once; their settings and block list are untouched (their own topics)
  await waitFor(() => machine('CANTEEN-01').state.versions.prices === 2 && machine('KIOSK-01').state.versions.prices === 2, {
    message: 'the networked machines on price list v2',
  });
  for (const code of ['CANTEEN-01', 'KIOSK-01']) assert.deepEqual(machine(code).state.versions, { prices: 2, settings: 1, blocklist: 1 });
  const sent = eventsSince(mark, 'mqtt.publish', (e) => e.data.from === 'platform');
  assert.ok(sent.length > 0 && sent.every((e) => e.data.type === 'config.prices' && e.data.topic.endsWith('/commands/prices') && e.data.retained));

  // CANTEEN-02 keeps the old price until the admin card visits it
  const old = await tap('CANTEEN-02', AHMAD, { items: items('NASI-LEMAK') });
  assert.equal(old.screen, 'Paid RM 3.50 · Balance RM 26.50');
  assert.equal(old.record.priceVersion, 1);
  const fresh = await tap('CANTEEN-01', LEE, { items: items('NASI-LEMAK') });
  assert.equal(fresh.screen, 'Paid RM 3.80 · Balance RM 21.20');
  assert.equal(fresh.record.priceVersion, 2);
  await lab.adminCardLoad({ schoolCode: SMK });
  const read = await lab.adminCardTap({ schoolCode: SMK, deviceCode: 'CANTEEN-02' });
  assert.deepEqual(read.results.find((r) => r.kind === 'prices'), { device: 'CANTEEN-02', kind: 'prices', appliedVersion: 2, result: 'APPLIED', at: read.results[0].at });
  await lab.advanceClock(5000);
  const visited = await tap('CANTEEN-02', AHMAD, { items: items('NASI-LEMAK') });
  assert.equal(visited.screen, 'Paid RM 3.80 · Balance RM 22.70');
  assert.equal(visited.record.priceVersion, 2);

  // each sale is checked against the price version the machine used, not today's price
  ok(await browser().post('/api/lab/cable', { schoolCode: SMK, deviceCode: 'CANTEEN-02', plugged: true }));
  const finance = await staff(SMK, 'FINANCE');
  await waitFor(async () => ok(await finance.get('/api/admin/purchases?device=CANTEEN-02')).length === 2, { message: 'the CANTEEN-02 records' });
  const c2 = ok(await finance.get('/api/admin/purchases?device=CANTEEN-02'));
  assert.deepEqual(c2.map((p) => [p.txn, p.priceVersion, p.amountSen, p.status]).sort(), [
    ['CANTEEN-02-000001', 1, 350, 'POSTED'],
    ['CANTEEN-02-000002', 2, 380, 'POSTED'],
  ]);
  assert.deepEqual(ok(await finance.get('/api/admin/differences')), [], 'no PRICE_MISMATCH');
  await booksBalance();
});

test('10. Device security', NET, async () => {
  await lab.reset();
  const office = await staff(SMK, 'OFFICE');
  const log = async (code) => ok(await office.get('/api/admin/device-log?device=CANTEEN-01')).filter((e) => e.code === code);

  // a forged message: refused with SIGNATURE_INVALID, in the office's device log
  const forged = await lab.fault({ type: 'forged-message', schoolCode: SMK, deviceCode: 'CANTEEN-01' });
  assert.equal(forged.ok, true, forged.summary);
  assert.deepEqual(forged.platform, { result: 'REFUSED', code: 'SIGNATURE_INVALID' });
  assert.deepEqual((await log('SIGNATURE_INVALID')).map((e) => [e.level, e.message]), [['WARN', 'signature does not match']]);

  // publishing on another machine's topic: the broker refuses it, nothing reaches the platform
  const mark = lab.ctx.events.lastSeq();
  const cross = await lab.fault({ type: 'cross-device-publish', schoolCode: SMK, deviceCode: 'CANTEEN-01' });
  assert.equal(cross.ok, true, cross.summary);
  assert.deepEqual([cross.topic, cross.brokerRefused, cross.connectionClosed, cross.reachedPlatform], ['lab/v1/smk-contoh/CANTEEN-02/records', true, true, false]);
  assert.ok(cross.machineOfflineMs > 0 && cross.machineOfflineMs < 10_000, `the real CANTEEN-01 was knocked off for about a second (${cross.machineOfflineMs} ms)`);
  assert.equal(machine('CANTEEN-01').connected, true, 'and came back by itself');
  assert.deepEqual(eventsSince(mark, 'mqtt.denied').map((e) => [e.data.username, e.data.action, e.data.topic]), [['smk-contoh.CANTEEN-01', 'publish', 'lab/v1/smk-contoh/CANTEEN-02/records']]);
  assert.deepEqual(eventsSince(mark, 'intake.accepted', (e) => e.data.device === 'CANTEEN-02'), []);

  // a sequence rollback: refused with SEQUENCE_ROLLBACK
  const rollback = await lab.fault({ type: 'sequence-rollback', schoolCode: SMK, deviceCode: 'CANTEEN-01' });
  assert.equal(rollback.ok, true, rollback.summary);
  assert.equal((await log('SEQUENCE_ROLLBACK')).length, 1);

  // the school office switches a machine off: the broker disconnects it at once, and it stays out
  const off = ok(await office.post('/api/admin/devices/CANTEEN-01/status', { status: 'DISABLED' }));
  assert.equal(off.kicked, 1);
  await waitFor(() => !machine('CANTEEN-01').connected, { message: 'CANTEEN-01 kicked' });
  const offMark = lab.ctx.events.lastSeq();
  await waitFor(() => eventsSince(offMark, 'mqtt.denied', (e) => e.data.username === 'smk-contoh.CANTEEN-01' && e.data.action === 'connect').length > 0, {
    timeout: 5000,
    message: 'its login refused',
  });
  const offline = await tap('CANTEEN-01', AHMAD, { items: items('BUAH') });
  assert.equal(offline.sent, false, 'it keeps selling offline');
  ok(await office.post('/api/admin/devices/CANTEEN-01/status', { status: 'ACTIVE' }));
  await waitFor(() => machine('CANTEEN-01').connected && machine('CANTEEN-01').state.journal.unsent === 0, {
    timeout: 20_000,
    message: 'CANTEEN-01 back, with its sale uploaded',
  });

  // the operator suspends the school: its machines are disconnected and its staff and parents blocked
  const op = await operator();
  const suspended = ok(await op.post(`/api/operator/schools/${SMK}/status`, { status: 'SUSPENDED' }));
  assert.equal(suspended.status, 'SUSPENDED');
  await waitFor(() => !machine('CANTEEN-01').connected && !machine('KIOSK-01').connected, { message: 'its machines disconnected' });
  assert.ok(['CANTEEN-01', 'KIOSK-01', 'WATER-01'].every((c) => machine(c, SJKC).connected), 'the other school carries on');
  assert.equal((await office.get('/api/admin/overview')).body.error.code, 'SCHOOL_SUSPENDED');
  const rahman = await parent('Rahman bin Yusof');
  const { children } = ok(await rahman.get('/api/parent/children'));
  const blocked = await rahman.get(`/api/parent/children/${children[0].schoolId}/${children[0].memberId}/balance`);
  assert.deepEqual([blocked.status, blocked.body.error.code], [403, 'SCHOOL_SUSPENDED']);
  await lab.advanceClock(5000);
  const kept = await tap('CANTEEN-01', AHMAD, { items: items('BUAH') });
  assert.equal(kept.sent, false, 'readers keep their records while the school is suspended');
  // reactivated: the machines log in again and send what they kept
  ok(await op.post(`/api/operator/schools/${SMK}/status`, { status: 'ACTIVE' }));
  await waitFor(() => machine('CANTEEN-01').connected && machine('CANTEEN-01').state.journal.unsent === 0, {
    timeout: 20_000,
    message: 'CANTEEN-01 back after the reactivation',
  });
  const finance = await staff(SMK, 'FINANCE');
  await waitFor(async () => ok(await finance.get('/api/admin/purchases?device=CANTEEN-01')).length === 2, { message: 'both kept sales' });
  await booksBalance();
});

test('13. Reconciliation', NET, async () => {
  await lab.reset();
  const office = await staff(SMK, 'OFFICE');
  const finance = await staff(SMK, 'FINANCE');
  ok(await office.post(`/api/admin/cards/${LEE}/report-lost`));
  // the offline reader sells three times: Lee's lost card (the window), Ahmad, Lee again
  assert.equal((await tap('CANTEEN-02', LEE, { items: items('ROTI-CANAI') })).ok, true);
  assert.equal((await tap('CANTEEN-02', AHMAD, { items: items('ROTI-CANAI') })).ok, true);
  await lab.advanceClock(5000); // the tap gap is 3 s
  assert.equal((await tap('CANTEEN-02', LEE, { items: items('BUAH') })).ok, true);
  // Lee's card at the kiosk: refused (lost), but its read-back brings its two window sales home first
  assert.equal((await tap('KIOSK-01', LEE)).screen, UNAVAILABLE);
  const kinds = async () => ok(await finance.get('/api/admin/differences?status=OPEN')).map((d) => d.kind);
  await waitFor(async () => (await kinds()).length === 2, { message: 'the two window sales' });
  // moving the clock runs the jobs: Ahmad's sale between them is missing
  const step = await lab.advanceClock(60_000);
  assert.deepEqual([step.jobs.gaps, step.jobs.lag], [1, 0]);
  // a day later: the machines still on the old block list are flagged
  const day = await lab.advanceClock(DAY_MS);
  assert.deepEqual([day.jobs.gaps, day.jobs.lag], [0, 2]);
  const open = ok(await finance.get('/api/admin/differences?status=OPEN'));
  assert.deepEqual(open.map((d) => `${d.kind} ${d.ref}`).sort(), [
    'MISSING_RECORDS CANTEEN-02:2-2',
    'OLD_BLOCK_LIST CANTEEN-02:2',
    'OLD_BLOCK_LIST WATER-01:2',
    'SPENT_AFTER_LOST_REPORT CANTEEN-02:CANTEEN-02-000001',
    'SPENT_AFTER_LOST_REPORT CANTEEN-02:CANTEEN-02-000003',
  ]);
  for (const d of open) {
    assert.ok(d.explanation.en.length > 10 && d.explanation.zh.length > 2, `${d.kind} is explained`);
  }
  // each is resolved with a note, and stays in the history
  for (const d of open) ok(await finance.post(`/api/admin/differences/${d.id}/resolve`, { note: `checked: ${d.kind.toLowerCase()}` }));
  assert.deepEqual(ok(await finance.get('/api/admin/differences?status=OPEN')), []);
  const history = ok(await finance.get('/api/admin/differences?status=RESOLVED'));
  assert.equal(history.length, 5);
  assert.ok(history.every((d) => d.status === 'RESOLVED' && d.note === `checked: ${d.kind.toLowerCase()}` && d.resolvedBy));
  await booksBalance();
});
