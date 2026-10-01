import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// docs/SCENARIOS.md exercises 1-6 against a real lab: the demo seed (fictional schools, people
// and cards), broker and web server on random ports, the lab clock standing still. Each exercise
// starts from a fresh demo (lab.reset()) and drives the lab like a person would: lab actions for
// the hardware, the HTTP API for the school office, the parent app and the mock bank.

const NET = { timeout: 60_000 };
const SMK = 'smk-contoh';
const AHMAD = '04A13B5C7D2E80'; // S1001: RM 30.00 on the card, RM 20.00 waiting
const LEE = '04B2194E6A3C81'; // S1002: RM 25.00
const ARJUN = '04C35D2F8B1A82'; // S1003: RM 40.00
const SITI = '04D47E3A9C2B83'; // S1004: RM 15.00
const IRFAN = '04F6925CBE4D85'; // S1006: RM 0.00

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

// ---- the exercises -------------------------------------------------------------------------

test('1. Pay at a networked canteen reader', NET, async () => {
  const mark = lab.ctx.events.lastSeq();
  const sale = await tap('CANTEEN-01', AHMAD, { items: items('NASI-LEMAK', 'TEH-TARIK') });
  assert.equal(sale.screen, 'Paid RM 5.30 · Balance RM 24.70');
  assert.equal(sale.sent, true);
  assert.equal(lab.cards.get(`${SMK}/${AHMAD}`).balanceSen, 2470);
  // the inspector: sale.recorded on the reader's records topic, accepted by the platform
  await waitFor(() => eventsSince(mark, 'intake.accepted', (e) => e.data.device === 'CANTEEN-01' && e.data.type === 'sale.recorded').length === 1, {
    message: 'the platform accepting the sale',
  });
  const published = eventsSince(mark, 'mqtt.publish', (e) => e.data.type === 'sale.recorded');
  assert.deepEqual(published.map((e) => [e.data.topic, e.data.from, e.data.txn]), [['lab/v1/smk-contoh/CANTEEN-01/records', 'smk-contoh.CANTEEN-01', 'CANTEEN-01-000001']]);
  // the school office: the same RM 24.70, and the purchase with price version 1
  const office = await staff(SMK, 'OFFICE');
  const ahmad = await member(office, 'S1001');
  assert.equal(ahmad.mirrorBalanceSen, 2470);
  const detail = ok(await office.get(`/api/admin/members/${ahmad.id}`));
  assert.deepEqual(detail.purchases.map((p) => [p.txn, p.amountSen, p.priceVersion, p.via, p.status]), [['CANTEEN-01-000001', 530, 1, 'MQTT', 'POSTED']]);
  await booksBalance();
});

test('2. Pay at a reader with no network, and three ways records come back', NET, async () => {
  await lab.reset();
  const office = await staff(SMK, 'OFFICE');
  const sale = await tap('CANTEEN-02', LEE, { items: items('ROTI-CANAI') });
  assert.equal(sale.screen, 'Paid RM 1.50 · Balance RM 23.50');
  assert.equal(sale.sent, false, 'no network: the record waits in the journal');
  assert.equal(lab.terminals.get(`${SMK}/CANTEEN-02`).state.journal.unsent, 1);
  let lee = await member(office, 'S1002');
  assert.equal(lee.mirrorBalanceSen, 2500, 'the office still shows RM 25.00');

  // way 1: the kiosk reads the card's recent records and uploads them
  const mark = lab.ctx.events.lastSeq();
  const visit = await tap('KIOSK-01', LEE);
  assert.equal(visit.screen, 'Nothing to add · Balance RM 23.50');
  await waitFor(async () => (await member(office, 'S1002')).mirrorBalanceSen === 2350, { message: 'the read-back in the books' });
  assert.equal(eventsSince(mark, 'mqtt.publish', (e) => e.data.type === 'card.readback').length, 1);

  // way 2: USB export, imported in the school office: a duplicate, not a second charge
  const usb = browser();
  const exported = await usb.post('/api/lab/usb/export', { schoolCode: SMK, deviceCode: 'CANTEEN-02' });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /^attachment; filename="smk-contoh-CANTEEN-02-journal-\d+\.json"$/);
  assert.equal(exported.body.count, 1);
  const imported = ok(await office.post('/api/admin/imports/journal', exported.body));
  assert.deepEqual(imported.counts, { POSTED: 0, FLAGGED: 0, DUPLICATE: 1, REFUSED: 0 });

  // way 3: plug the cable in: the journal goes up as a journal.batch, again a duplicate
  const plugMark = lab.ctx.events.lastSeq();
  ok(await usb.post('/api/lab/cable', { schoolCode: SMK, deviceCode: 'CANTEEN-02', plugged: true }));
  await waitFor(() => eventsSince(plugMark, 'purchase.received', (e) => e.data.txn === 'CANTEEN-02-000001').length === 1, { message: 'the batch' });
  const batch = eventsSince(plugMark, 'purchase.received', (e) => e.data.txn === 'CANTEEN-02-000001')[0];
  assert.deepEqual([batch.data.via, batch.data.status], ['JOURNAL_BATCH', 'DUPLICATE']);

  lee = await member(office, 'S1002');
  assert.equal(lee.mirrorBalanceSen, 2350, 'the office now shows RM 23.50');
  const purchases = ok(await office.get(`/api/admin/members/${lee.id}`)).purchases;
  assert.deepEqual(purchases.map((p) => [p.txn, p.amountSen, p.via]), [['CANTEEN-02-000001', 150, 'KIOSK_READBACK']], 'each record counts once');
  // the duplicate-upload fault shows the same: a record sent again is a DUPLICATE
  const again = await lab.fault({ type: 'duplicate-upload', schoolCode: SMK, deviceCode: 'CANTEEN-02' });
  assert.equal(again.ok, true, again.summary);
  assert.deepEqual(again.platform, { status: 'DUPLICATE', code: null });
  await booksBalance();
});

test('3. Water by the litre', NET, async () => {
  await lab.reset();
  const first = await tap('WATER-01', ARJUN, { ml: 650 });
  assert.equal(first.screen, 'Poured 650 ml · Paid RM 0.13 · Balance RM 39.87');
  assert.equal(first.record.amountSen, 13);
  await lab.advanceClock(5000); // the tap gap is 3 s
  const small = await tap('WATER-01', ARJUN, { ml: 10 });
  assert.equal(small.screen, 'Poured 10 ml · Paid RM 0.05 · Balance RM 39.82');
  assert.equal(small.record.amountSen, 5, 'the minimum charge');
  const empty = await tap('WATER-01', IRFAN, { ml: 250 });
  assert.equal(empty.ok, false);
  assert.match(empty.screen, /^Not enough balance/);
  assert.equal(empty.pouredMl, 0);
  // bring the records back and check the amounts in the school office
  ok(await browser().post('/api/lab/cable', { schoolCode: SMK, deviceCode: 'WATER-01', plugged: true }));
  const office = await staff(SMK, 'FINANCE');
  await waitFor(async () => ok(await office.get('/api/admin/purchases')).length === 2, { message: 'the water records' });
  const water = ok(await office.get('/api/admin/purchases?device=WATER-01'));
  assert.deepEqual(water.map((p) => [p.ml, p.amountSen, p.memberName]).sort(), [[10, 5, 'Arjun a/l Suresh'], [650, 13, 'Arjun a/l Suresh']]);
  assert.equal((await member(office, 'S1003')).mirrorBalanceSen, 3982);
  await booksBalance();
});

test('4. A parent tops up', NET, async () => {
  await lab.reset();
  const rahman = await parent('Rahman bin Yusof');
  const ahmad = await child(rahman, 'Ahmad Faiz');
  // balance and waiting side by side, never added together
  const before = await balanceOf(rahman, ahmad);
  assert.equal(before.mirrorBalanceSen, 3000);
  assert.equal(before.waitingSen, 2000);
  const order = await topUpAndPay(rahman, ahmad, 1500);
  const waiting = await balanceOf(rahman, ahmad);
  assert.equal(waiting.mirrorBalanceSen, 3000, 'the balance does not move');
  assert.equal(waiting.waitingSen, 3500, 'waiting becomes RM 35.00');

  const added = await tap('KIOSK-01', AHMAD);
  assert.equal(added.screen, 'Added RM 35.00 · Balance RM 65.00');
  assert.equal(added.added.length, 2);
  const after = await balanceOf(rahman, ahmad);
  assert.equal(after.mirrorBalanceSen, 6500);
  assert.equal(after.waitingSen, 0);
  const history = ok(await rahman.get(`/api/parent/children/${ahmad.schoolId}/${ahmad.memberId}/history`));
  assert.equal(history.topups.find((o) => o.id === order.id).status, 'ADDED');

  // the books: each payment DR cash received / CR waiting; each kiosk write DR waiting / CR wallet
  const finance = await staff(SMK, 'FINANCE');
  const postings = ok(await finance.get('/api/admin/ledger/postings?limit=200'));
  const linesOf = (kind) => postings.filter((p) => p.ref === order.id && p.kind === kind).map((p) => p.lines.map((l) => `${l.side} ${l.kind} ${l.amountSen}`));
  assert.deepEqual(linesOf('TOPUP_PAID'), [['DR CASH_RECEIVED 1500', 'CR WAITING_TO_BE_ADDED 1500']]);
  assert.deepEqual(linesOf('TOPUP_ADDED'), [['DR WAITING_TO_BE_ADDED 1500', 'CR STUDENT_WALLET 1500']]);
  const tb = ok(await finance.get('/api/admin/ledger/trial-balance'));
  assert.equal(tb.balanced, true);
  assert.equal(tb.totals.debitSen, tb.totals.creditSen);
  await booksBalance();
});

test('5. A new parent signs up with an invitation code', NET, async () => {
  const office = await staff(SMK, 'OFFICE');
  const invite = ok(await office.get('/api/admin/invites')).find((i) => i.memberName === 'Muhammad Irfan bin Hakim' && i.status === 'OPEN');
  assert.ok(invite, 'the open invitation for Muhammad Irfan (S1006)');
  const newcomer = browser();
  ok(await newcomer.post('/api/parent/register', { email: 'hakim.ali@example.com', name: 'Hakim bin Ali' }), 201);
  const { link } = ok(await newcomer.post('/api/parent/invites/redeem', { code: invite.code }), 201);
  assert.equal(link.status, 'PENDING');
  let mine = ok(await newcomer.get('/api/parent/children'));
  assert.deepEqual(mine.children, [], 'nothing to see before the school approves');
  assert.deepEqual(mine.links.map((l) => [l.name, l.status]), [['Muhammad Irfan bin Hakim', 'PENDING']]);
  const pending = ok(await office.get('/api/admin/links?status=PENDING'));
  assert.deepEqual(pending.map((l) => l.parentName), ['Hakim bin Ali']);
  ok(await office.post(`/api/admin/links/${pending[0].id}/approve`));
  mine = ok(await newcomer.get('/api/parent/children'));
  assert.deepEqual(mine.children.map((c) => [c.name, c.schoolCode]), [['Muhammad Irfan bin Hakim', SMK]]);
  await booksBalance();
});

test('6. Money that never reaches the card is refunded', NET, async () => {
  await lab.reset();
  const omar = await parent('Omar bin Zainal');
  const siti = await child(omar, 'Siti Aisyah');
  const order = await topUpAndPay(omar, siti, 1000);
  assert.equal((await balanceOf(omar, siti)).waitingSen, 1000);
  // no kiosk visit; the add window is 14 days
  const moved = await lab.advanceClock(15 * 24 * 3600 * 1000);
  assert.ok(moved.jobs.refunded >= 1);
  const finance = await staff(SMK, 'FINANCE');
  const refunded = ok(await finance.get('/api/admin/topups?status=REFUNDED'));
  assert.ok(refunded.some((o) => o.id === order.id));
  // the books show a reversal of the payment
  const postings = ok(await finance.get('/api/admin/ledger/postings?limit=200')).filter((p) => p.ref === order.id);
  const paid = postings.find((p) => p.kind === 'TOPUP_PAID');
  const reversal = postings.find((p) => p.reversalOf === paid.id);
  assert.ok(reversal, 'a reversal of the payment');
  assert.equal(reversal.memo, 'refund sent to parent (mock)');
  assert.deepEqual(reversal.lines.map((l) => `${l.side} ${l.kind} ${l.amountSen}`).sort(), ['CR CASH_RECEIVED 1000', 'DR WAITING_TO_BE_ADDED 1000']);
  // the parent app shows the refund, and nothing waiting
  const mine = ok(await omar.get('/api/parent/topups'));
  assert.equal(mine.find((o) => o.id === order.id).status, 'REFUNDED');
  assert.equal((await balanceOf(omar, siti)).waitingSen, 0);
  assert.equal(lab.cards.get(`${SMK}/${SITI}`).balanceSen, 1500, 'the card never had it');
  await booksBalance();
});
