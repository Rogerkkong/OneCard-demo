import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// docs/SCENARIOS.md exercises 7, 8, 11 and 12 against a real lab (fictional seed, random ports,
// the lab clock standing still): a lost card and the window before offline machines know, a
// replacement card, kiosk power cuts and lost confirmations, copied and tampered cards. Each
// exercise starts from a fresh demo.

const NET = { timeout: 60_000 };
const SMK = 'smk-contoh';
const LEE = '04B2194E6A3C81'; // S1002: RM 25.00
const ARJUN = '04C35D2F8B1A82'; // S1003: RM 40.00
const SITI = '04D47E3A9C2B83'; // S1004: RM 15.00
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

/** A card's row in checkBooks(): chip balance against the member's mirror. */
const bookRow = (uid) => lab.checkBooks().schools.flatMap((s) => s.cards).find((c) => c.uid === uid);

/**
 * The end of every exercise: bring every record home (cables in, journals uploaded), then
 * every school's books balance and every card holds what its mirror says, except the cards
 * the exercise broke on purpose (`mismatched`), which must differ.
 */
async function booksBalance({ mismatched = [] } = {}) {
  for (const m of lab.terminals.values()) {
    if (!m.cablePlugged) await lab.setCable({ schoolCode: m.schoolCode, deviceCode: m.deviceCode, plugged: true });
  }
  await waitFor(() => [...lab.terminals.values()].every((m) => m.connected && m.state.journal.unsent === 0), {
    timeout: 20_000,
    message: 'every machine connected with its journal uploaded',
  });
  const fine = () => lab.checkBooks().schools.flatMap((s) => s.cards).every((c) => c.match !== mismatched.includes(c.uid));
  await waitFor(fine, { message: 'every card equal to its mirror (but the broken ones)' });
  for (const s of lab.checkBooks().schools) assert.equal(s.balanced, true, `${s.code} trial balance`);
  assert.deepEqual(errors, []);
}

async function differences(finance, kind) {
  return ok(await finance.get(`/api/admin/differences?kind=${kind}`));
}

// ---- the exercises -------------------------------------------------------------------------

test('7. A lost card, and the window before offline machines know', NET, async () => {
  const office = await staff(SMK, 'OFFICE');
  const mark = lab.ctx.events.lastSeq();
  const lost = ok(await office.post(`/api/admin/cards/${LEE}/report-lost`));
  assert.deepEqual([lost.status, lost.lostListVersion, lost.published], ['LOST', 2, true], 'the block-list version goes up');
  // networked machines get the new list at once, as a retained message on their commands/blocklist topic
  const version = (code) => lab.terminals.get(`${SMK}/${code}`).state.versions.blocklist;
  await waitFor(() => version('CANTEEN-01') === 2 && version('KIOSK-01') === 2, { message: 'the networked machines on list v2' });
  const snapshots = eventsSince(mark, 'mqtt.publish', (e) => e.data.type === 'blocklist.snapshot');
  assert.deepEqual(snapshots.map((e) => [e.data.topic, e.data.retained]).sort(), [
    ['lab/v1/smk-contoh/CANTEEN-01/commands/blocklist', true],
    ['lab/v1/smk-contoh/CANTEEN-02/commands/blocklist', true],
    ['lab/v1/smk-contoh/KIOSK-01/commands/blocklist', true],
    ['lab/v1/smk-contoh/WATER-01/commands/blocklist', true],
  ]);
  assert.equal(version('CANTEEN-02'), 1, 'no network: still the old list');
  const refused = await tap('CANTEEN-01', LEE, { items: items('ROTI-CANAI') });
  assert.equal(refused.screen, UNAVAILABLE, 'it never says why');
  assert.equal(refused.reason, 'BLOCKED');
  // the lost-card window: the offline reader still accepts the card
  const window = await tap('CANTEEN-02', LEE, { items: items('ROTI-CANAI') });
  assert.equal(window.screen, 'Paid RM 1.50 · Balance RM 23.50');
  assert.equal(window.record.listVersion, 1);

  // the admin card: loaded at the kiosk, tapped on CANTEEN-02, back to the kiosk with the receipts
  const loaded = await lab.adminCardLoad({ schoolCode: SMK });
  assert.equal(loaded.ok, true, loaded.screen);
  assert.deepEqual(loaded.adminCard.packs, [{ kind: 'blocklist', version: 2 }, { kind: 'prices', version: 1 }, { kind: 'settings', version: 1 }]);
  const read = await lab.adminCardTap({ schoolCode: SMK, deviceCode: 'CANTEEN-02' });
  assert.deepEqual(read.results.map((r) => [r.kind, r.result, r.appliedVersion]), [
    ['blocklist', 'APPLIED', 2],
    ['prices', 'ALREADY_APPLIED', 1],
    ['settings', 'ALREADY_APPLIED', 1],
  ]);
  const uploaded = await lab.adminCardTap({ schoolCode: SMK, deviceCode: 'KIOSK-01' });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.uploaded, 3);
  await lab.advanceClock(5000);
  const now = await tap('CANTEEN-02', LEE, { items: items('ROTI-CANAI') });
  assert.equal(now.screen, UNAVAILABLE, 'CANTEEN-02 now refuses the card');
  const states = ok(await office.get('/api/admin/devices/states'));
  const c2 = states.find((s) => s.deviceCode === 'CANTEEN-02' && s.kind === 'blocklist');
  assert.deepEqual([c2.appliedVersion, c2.via, c2.behind], [2, 'ADMIN_CARD', false], 'the office sees it on the new list (via admin card)');

  // the window purchase reaches the platform: card used after it was reported lost, list not updated
  ok(await browser().post('/api/lab/cable', { schoolCode: SMK, deviceCode: 'CANTEEN-02', plugged: true }));
  const finance = await staff(SMK, 'FINANCE');
  await waitFor(async () => (await differences(finance, 'SPENT_AFTER_LOST_REPORT')).length === 1, { message: 'the difference' });
  const [spent] = await differences(finance, 'SPENT_AFTER_LOST_REPORT');
  assert.equal(spent.explanation.en, 'Card used after it was reported lost');
  assert.deepEqual(spent.detail, { listVersionOnMachine: 1, lostListVersion: 2, machineHadUpdatedList: false });
  await booksBalance();
});

test('8. A replacement card', NET, async () => {
  await lab.reset();
  const office = await staff(SMK, 'OFFICE');
  const lee = await member(office, 'S1002');
  const NEW_UID = '04B2194E6A3C99';
  const out = ok(await office.post(`/api/admin/members/${lee.id}/replace-card`, { newUid: NEW_UID }));
  assert.equal(out.oldCard.status, 'LOST');
  assert.equal(out.newCard.uid, NEW_UID);
  assert.deepEqual([out.transferOrder.kind, out.transferOrder.status, out.transferOrder.amountSen], ['TRANSFER', 'PAID', 2500]);
  // her platform balance moved into a transfer that waits at the kiosk
  const after = await member(office, 'S1002');
  assert.deepEqual([after.mirrorBalanceSen, after.waitingSen], [0, 2500]);
  // the lab made the new card at once: blank, ACTIVE on the platform
  const tray = lab.state().schools.find((s) => s.code === SMK).cards.find((c) => c.uid === NEW_UID);
  assert.deepEqual([tray.balanceSen, tray.platformStatus, tray.member], [0, 'ACTIVE', 'Lee Mei Ling']);
  const added = await tap('KIOSK-01', NEW_UID);
  assert.equal(added.screen, 'Added RM 25.00 · Balance RM 25.00');
  // the old card is blocked wherever the new list has arrived
  assert.equal((await tap('CANTEEN-01', LEE, { items: items('BUAH') })).screen, UNAVAILABLE);
  assert.equal((await tap('CANTEEN-01', NEW_UID, { items: items('BUAH') })).screen, 'Paid RM 1.00 · Balance RM 24.00');
  await booksBalance();
});

test('11. Kiosk power cuts and lost confirmations', NET, async () => {
  await lab.reset();
  const suresh = await parent('Suresh Kumar');
  const arjun = await child(suresh, 'Arjun');
  const order = await topUpAndPay(suresh, arjun, 1000);
  const finance = await staff(SMK, 'FINANCE');
  const orderNow = async (id = order.id) => ok(await finance.get('/api/admin/topups?limit=1000')).find((o) => o.id === id);

  // power cut before writing: nothing is written, the money keeps waiting
  const before = await tap('KIOSK-01', ARJUN, { fault: 'power-cut-before-commit' });
  assert.equal(before.screen, 'Power cut while adding money, please tap again');
  assert.deepEqual([before.reason, before.interrupted.committed], ['POWER_CUT', false]);
  assert.equal(lab.cards.get(`${SMK}/${ARJUN}`).balanceSen, 4000);
  assert.equal((await orderNow()).status, 'PAID');
  assert.equal((await balanceOf(suresh, arjun)).waitingSen, 1000);

  // power cut after writing: the money is on the card, the platform never heard back
  const afterCut = await tap('KIOSK-01', ARJUN, { fault: 'power-cut-after-commit' });
  assert.deepEqual([afterCut.reason, afterCut.interrupted.committed], ['POWER_CUT', true]);
  assert.equal(lab.cards.get(`${SMK}/${ARJUN}`).balanceSen, 5000);
  assert.deepEqual([(await orderNow()).status, (await orderNow()).writeResult], ['PAID', 'UNCONFIRMED']);
  assert.deepEqual([bookRow(ARJUN).unconfirmedSen, bookRow(ARJUN).match], [1000, true], 'on the card, not yet in the books');

  // after the add window the order is parked for a person, never refunded automatically
  const moved = await lab.advanceClock(15 * DAY_MS);
  assert.ok(moved.jobs.parked >= 1);
  assert.equal((await orderNow()).status, 'PARKED');
  assert.ok(ok(await finance.get('/api/admin/topups/parked')).some((o) => o.id === order.id));

  // the next tap finds the write on the card and confirms it: the order becomes added
  const found = await tap('KIOSK-01', ARJUN);
  assert.equal(found.ok, true, found.screen);
  assert.deepEqual(found.reconfirmed.map((r) => [r.orderId, r.result]), [[order.id, 'CONFIRMED']]);
  assert.equal((await orderNow()).status, 'ADDED');
  assert.equal(lab.cards.get(`${SMK}/${ARJUN}`).balanceSen, 5000, 'never written twice');

  // a lost confirmation: looked up by the same kiosk txn and sent again, the card written once
  const second = await topUpAndPay(suresh, arjun, 500);
  const mark = lab.ctx.events.lastSeq();
  const timedOut = await tap('KIOSK-01', ARJUN, { fault: 'confirm-timeout' });
  assert.equal(timedOut.screen, 'Added RM 5.00 · Balance RM 55.00');
  assert.deepEqual(timedOut.added.map((a) => [a.orderId, a.confirmed]), [[second.id, true]]);
  const confirmed = await orderNow(second.id);
  assert.deepEqual([confirmed.status, confirmed.kioskTxn], ['ADDED', timedOut.added[0].kioskTxn]);
  assert.equal(eventsSince(mark, 'card.write', (e) => e.data.kind === 'credit').length, 1, 'one write on the card');
  assert.equal(lab.cards.get(`${SMK}/${ARJUN}`).memory.writes.filter((w) => w.orderId === second.id).length, 1);
  // none of this looked like a mismatch between card and books
  assert.deepEqual(await differences(finance, 'BALANCE_MISMATCH'), []);
  await booksBalance();
});

test('12. Copied and tampered cards', NET, async () => {
  await lab.reset();
  const copy = await lab.fault({ type: 'clone-card', schoolCode: SMK, uid: SITI });
  assert.deepEqual([copy.ok, copy.uid, copy.copyOf], [true, `${SITI}-copy`, SITI]);
  const tray = lab.state().schools.find((s) => s.code === SMK).cards;
  assert.deepEqual(tray.filter((c) => c.chipUid === SITI).map((c) => [c.uid, c.copy, c.balanceSen]), [[SITI, false, 1500], [`${SITI}-copy`, true, 1500]]);
  // spend on both: each chip believes it holds RM 15.00
  assert.equal((await tap('CANTEEN-01', SITI, { items: items('NASI-LEMAK') })).screen, 'Paid RM 3.50 · Balance RM 11.50');
  assert.equal((await tap('CANTEEN-01', `${SITI}-copy`, { items: items('MEE-GORENG') })).screen, 'Paid RM 4.00 · Balance RM 11.00');
  const finance = await staff(SMK, 'FINANCE');
  await waitFor(async () => (await differences(finance, 'CARD_CLONE_SUSPECTED')).length === 1, { message: 'the clone difference' });
  const [clone] = await differences(finance, 'CARD_CLONE_SUSPECTED');
  assert.equal(clone.explanation.en, 'Two different purchases carry the same card counter (possible copied card)');
  assert.equal(clone.detail.purchases.length, 2);
  // the card no longer matches the books (RM 15.00 - 3.50 - 4.00 = RM 7.50 in the books, RM 11.50 on the card)
  assert.deepEqual([bookRow(SITI).cardSen, bookRow(SITI).mirrorSen, bookRow(SITI).match], [1150, 750, false]);
  await tap('KIOSK-01', SITI);
  await waitFor(async () => (await differences(finance, 'BALANCE_MISMATCH')).length === 1, { message: 'the read-back mismatch' });
  const [mismatch] = await differences(finance, 'BALANCE_MISMATCH');
  assert.deepEqual([mismatch.detail.cardSen, mismatch.detail.mirrorSen], [1150, 750]);

  // a card changed by hand: every machine refuses it, its security code no longer matches
  const tampered = await lab.fault({ type: 'tamper-card', schoolCode: SMK, uid: ARJUN, balanceSen: 99_900 });
  assert.equal(tampered.ok, true);
  for (const [device, more] of [['CANTEEN-01', { items: items('BUAH') }], ['CANTEEN-02', { items: items('BUAH') }], ['WATER-01', { ml: 250 }], ['KIOSK-01', {}]]) {
    const r = await tap(device, ARJUN, more);
    assert.deepEqual([r.ok, r.screen, r.reason], [false, UNAVAILABLE, 'CARD_UNREADABLE'], device);
  }
  assert.equal(lab.state().schools.find((s) => s.code === SMK).cards.find((c) => c.uid === ARJUN).readable, false);
  await booksBalance({ mismatched: [SITI] });
});
