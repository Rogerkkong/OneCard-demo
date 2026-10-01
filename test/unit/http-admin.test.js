import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { createHttpServer } from '../../src/http/server.js';
import { routes as adminRoutes } from '../../src/http/routes/admin.js';
import { exportJournal } from '../../src/devices/usb.js';
import { signPayload } from '../../src/shared/crypto.js';
import { DAY } from '../../src/shared/time.js';

// The school office API: roles, tenant isolation and every admin row of DESIGN §7. Schools,
// people and cards are the fictional demo seed; secrets and card keys are generated per test.

async function startLab(t) {
  const ctx = createTestCtx();
  const platform = createPlatform(ctx);
  const seed = seedDemo(platform);
  const lab = { ctx, platform, server: { up: true } };
  const server = createHttpServer({ lab });
  const { url } = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const school = (code) => seed.schools.find((s) => s.code === code);
  const member = (code, memberNo) => school(code).members.find((m) => m.memberNo === memberNo);
  const device = (code, deviceCode) => school(code).devices.find((d) => d.code === deviceCode);
  const staff = (code, role) => school(code).staff.find((p) => p.role === role);
  /** A browser signed in as the school's staff member with this role. */
  const signIn = async (code, role) => {
    const b = browser(url);
    const res = await b.post('/api/admin/login', { staffId: staff(code, role).id });
    assert.equal(res.status, 200);
    return b;
  };
  return { ctx, platform, seed, lab, url, school, member, device, staff, signIn };
}

function browser(url) {
  const jar = new Map();
  async function call(method, path, { json, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(url + path, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      if (/;\s*max-age=0/i.test(c)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, data, text };
  }
  return { get: (p) => call('GET', p), post: (p, json = {}) => call('POST', p, { json }) };
}

/** A paid parent top-up, through the real signed payment callback. */
function paidTopup(lab, { parentId, schoolId, memberId, amountSen, key }) {
  const { topups } = lab.platform.services;
  const order = topups.createOrder({ parentId, schoolId, memberId, amountSen, idemKey: key });
  const payload = { orderId: order.id, provider: 'MOCKBANK', providerTxnId: `TEST-${order.id}`, result: 'SUCCESS', paidAmountSen: amountSen, paidAt: lab.ctx.clock.iso() };
  return topups.paymentCallback({ ...payload, signature: signPayload(lab.ctx.settings.providerSecret, payload) });
}

/** Everything waiting for a card, written at the school's KIOSK-01 (as the kiosk reports it). */
function addAtKiosk(lab, { schoolId, uid, startTxn = 1 }) {
  const { topups, devices, schools } = lab.platform.services;
  const kiosk = devices.getDeviceByCode(schoolId, 'KIOSK-01');
  const digest = schools.cardDigestFor(schoolId, uid);
  const pending = topups.kioskPending({ schoolId, kioskDeviceId: kiosk.id, cardDigest: digest });
  let balance = pending.mirrorBalanceSen;
  let n = startTxn;
  for (const o of pending.orders) {
    balance += o.amountSen;
    topups.kioskConfirm({
      schoolId,
      kioskDeviceId: kiosk.id,
      kioskDeviceCode: 'KIOSK-01',
      orderId: o.orderId,
      result: 'ADDED',
      amountSen: o.amountSen,
      cardDigest: digest,
      balanceAfterOnCardSen: balance,
      kioskTxn: `KIOSK-01-${String(n++).padStart(6, '0')}`,
    });
  }
  return pending.orders;
}

/** A canteen sale record as a reader writes it (DESIGN §3 "Purchase record"). */
function sale({ origin, n, digest, last4, cardSeq, before, items, at, priceVersion = 1 }) {
  const amountSen = items.reduce((sum, i) => sum + i.qty * i.priceSen, 0);
  return {
    txn: `${origin}-${String(n).padStart(6, '0')}`,
    origin,
    kind: 'SALE',
    card: digest,
    last4,
    cardSeq,
    amountSen,
    items,
    priceVersion,
    listVersion: 1,
    balanceBeforeSen: before,
    balanceAfterSen: before - amountSen,
    at,
  };
}

const ROTI = { code: 'ROTI-CANAI', qty: 1, priceSen: 150 };
const TEH = { code: 'TEH-TARIK', qty: 1, priceSen: 180 };

describe('admin: session and roles', () => {
  test('staff-options lists every school\'s staff; login and me; unknown staff 404', async (t) => {
    const { url, seed } = await startLab(t);
    const b = browser(url);
    const options = await b.get('/api/admin/staff-options');
    assert.equal(options.status, 200);
    assert.equal(options.data.length, 6);
    const nur = options.data.find((p) => p.name === 'Nur Aisyah');
    assert.deepEqual(nur, {
      id: seed.schools[0].staff[0].id,
      name: 'Nur Aisyah',
      role: 'OFFICE',
      schoolId: seed.schools[0].id,
      schoolCode: 'smk-contoh',
      schoolName: 'SMK Seri Contoh',
      schoolStatus: 'ACTIVE',
    });
    for (const staffId of ['stf_nobody', 42, null]) {
      const res = await b.post('/api/admin/login', { staffId });
      assert.equal(res.status, 404);
      assert.equal(res.data.error.code, 'STAFF_NOT_FOUND');
    }
    await b.post('/api/admin/login', { staffId: nur.id });
    const me = await b.get('/api/admin/me');
    assert.equal(me.data.staff.role, 'OFFICE');
    assert.equal(me.data.school.code, 'smk-contoh');
    assert.doesNotMatch(me.text, /card_?key/i);
    assert.equal(me.text.includes(seed.schools[0].cardKey), false, 'the card key never leaves the platform');
  });

  test('OFFICE, FINANCE and ADMIN each reach their own areas only (403 FORBIDDEN otherwise)', async (t) => {
    const { signIn, member } = await startLab(t);
    const office = await signIn('smk-contoh', 'OFFICE');
    const finance = await signIn('smk-contoh', 'FINANCE');
    const admin = await signIn('smk-contoh', 'ADMIN');
    const lee = member('smk-contoh', 'S1002');

    const forbidden = async (b, method, path, json) => {
      const res = method === 'GET' ? await b.get(path) : await b.post(path, json);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.data.error.code, 'FORBIDDEN');
      return res;
    };
    const fine = async (b, method, path, json) => {
      const res = method === 'GET' ? await b.get(path) : await b.post(path, json);
      assert.ok(res.status < 300, `${method} ${path} -> ${res.status} ${res.text}`);
      return res;
    };

    const denied = await forbidden(office, 'GET', '/api/admin/ledger/trial-balance');
    assert.deepEqual(denied.data.error.detail, { role: 'OFFICE', needs: ['FINANCE', 'ADMIN'] });
    for (const path of ['/api/admin/topups', '/api/admin/topups/parked', '/api/admin/ledger/postings', '/api/admin/purchases', '/api/admin/reports/sales', '/api/admin/differences', '/api/admin/audit']) {
      await forbidden(office, 'GET', path);
    }
    await forbidden(office, 'POST', '/api/admin/subsidies', { memberId: lee.id, amountSen: 100 });
    await forbidden(office, 'POST', '/api/admin/jobs/run');

    for (const path of ['/api/admin/devices', '/api/admin/devices/states', '/api/admin/device-log', '/api/admin/cards', '/api/admin/invites', '/api/admin/links', '/api/admin/configs', '/api/admin/blocklist', '/api/admin/audit']) {
      await forbidden(finance, 'GET', path);
    }
    await forbidden(finance, 'POST', `/api/admin/cards/${lee.cardUid}/report-lost`);
    await forbidden(finance, 'POST', '/api/admin/configs/prices', {});
    await forbidden(finance, 'POST', '/api/admin/imports/journal', {});
    await forbidden(finance, 'POST', '/api/admin/members', { memberNo: 'X1', name: 'X' });

    // reading the members is open to every role (finance picks the member of a subsidy)
    for (const b of [office, finance, admin]) {
      await fine(b, 'GET', '/api/admin/members');
      await fine(b, 'GET', `/api/admin/members/${lee.id}`);
      await fine(b, 'GET', '/api/admin/overview');
    }
    await fine(office, 'GET', '/api/admin/devices');
    await fine(finance, 'GET', '/api/admin/ledger/trial-balance');
    await fine(finance, 'POST', '/api/admin/subsidies', { memberId: lee.id, amountSen: 100 });
    for (const path of ['/api/admin/devices', '/api/admin/ledger/trial-balance', '/api/admin/audit', '/api/admin/differences', '/api/admin/configs']) {
      await fine(admin, 'GET', path);
    }
    await fine(admin, 'POST', '/api/admin/jobs/run');
  });

  test('every office route names its roles (DESIGN §7); a route without them would be open to every role', () => {
    const ANY = ['ADMIN', 'FINANCE', 'OFFICE'];
    const OFFICE = ['ADMIN', 'OFFICE'];
    const FINANCE = ['ADMIN', 'FINANCE'];
    const ADMIN = ['ADMIN'];
    const expected = {
      'GET /api/admin/me': ANY,
      'GET /api/admin/overview': ANY,
      'GET /api/admin/members': ANY, // finance picks the member of a subsidy
      'GET /api/admin/members/:id': ANY,
      'POST /api/admin/members': OFFICE,
      'POST /api/admin/members/:id/replace-card': OFFICE,
      'GET /api/admin/cards': OFFICE,
      'POST /api/admin/cards': OFFICE,
      'POST /api/admin/cards/:uid/report-lost': OFFICE,
      'POST /api/admin/cards/:uid/found': OFFICE,
      'GET /api/admin/invites': OFFICE,
      'POST /api/admin/invites': OFFICE,
      'GET /api/admin/links': OFFICE,
      'POST /api/admin/links/:id/approve': OFFICE,
      'POST /api/admin/links/:id/reject': OFFICE,
      'GET /api/admin/devices': OFFICE,
      'POST /api/admin/devices': OFFICE,
      'POST /api/admin/devices/:code/status': OFFICE,
      'GET /api/admin/devices/states': OFFICE,
      'GET /api/admin/device-log': OFFICE,
      'GET /api/admin/configs': OFFICE,
      'POST /api/admin/configs/prices': OFFICE,
      'POST /api/admin/configs/settings': OFFICE,
      'GET /api/admin/blocklist': OFFICE,
      'POST /api/admin/imports/journal': OFFICE,
      'GET /api/admin/topups': FINANCE,
      'GET /api/admin/topups/parked': FINANCE,
      'POST /api/admin/topups/:id/resolve': FINANCE,
      'POST /api/admin/subsidies': FINANCE,
      'GET /api/admin/ledger/trial-balance': FINANCE,
      'GET /api/admin/ledger/postings': FINANCE,
      'GET /api/admin/purchases': FINANCE,
      'GET /api/admin/reports/sales': FINANCE,
      'GET /api/admin/differences': FINANCE,
      'POST /api/admin/differences/:id/resolve': FINANCE,
      'GET /api/admin/audit': ADMIN,
      'POST /api/admin/jobs/run': ADMIN,
    };
    const defined = adminRoutes({});
    const staffRoutes = defined.filter((r) => r.auth === 'staff');
    for (const r of staffRoutes) {
      const key = `${r.method} ${r.path}`;
      assert.ok(Object.hasOwn(expected, key), `${key} is not in the table: decide its roles`);
      assert.ok(Array.isArray(r.roles), `${key} names no roles`);
      assert.deepEqual([...r.roles].sort(), expected[key], key);
    }
    assert.deepEqual(staffRoutes.map((r) => `${r.method} ${r.path}`).sort(), Object.keys(expected).sort());
    // the only routes of the office without a session pick who you are
    assert.deepEqual(defined.filter((r) => r.auth !== 'staff').map((r) => `${r.method} ${r.path}`).sort(), [
      'GET /api/admin/staff-options',
      'POST /api/admin/login',
      'POST /api/admin/logout',
    ]);
  });

  test('overview: today\'s sales, machines, money waiting, open differences, parked orders', async (t) => {
    const { signIn, lab, school, member } = await startLab(t);
    const smk = school('smk-contoh');
    lab.platform.services.topups.grantSubsidy({ schoolId: smk.id, memberId: member('smk-contoh', 'S1005').id, amountSen: 1000, actor: 'test' });
    const res = await (await signIn('smk-contoh', 'FINANCE')).get('/api/admin/overview');
    assert.equal(res.status, 200);
    assert.equal(res.data.school.code, 'smk-contoh');
    assert.deepEqual(res.data.today, { day: '2026-10-05', salesSen: 0, purchases: 0 });
    assert.deepEqual(res.data.devices, { total: 4, online: 0 });
    assert.equal(res.data.waitingSen, 1000);
    assert.equal(res.data.openDifferences, 0);
    assert.equal(res.data.parkedOrders, 0);
  });
});

describe('admin: members and cards', () => {
  test('members with the platform\'s balances; adding one with a card; a refused card adds nobody', async (t) => {
    const { signIn, lab, school, member, ctx } = await startLab(t);
    const smk = school('smk-contoh');
    lab.platform.services.topups.grantSubsidy({ schoolId: smk.id, memberId: member('smk-contoh', 'S1005').id, amountSen: 1000, actor: 'test' });
    const office = await signIn('smk-contoh', 'OFFICE');
    const list = await office.get('/api/admin/members');
    assert.equal(list.data.length, 7);
    const wong = list.data.find((m) => m.memberNo === 'S1005');
    assert.equal(wong.name, 'Wong Jia Hui');
    assert.equal(wong.mirrorBalanceSen, 0);
    assert.equal(wong.waitingSen, 1000);
    assert.equal(wong.card.status, 'ACTIVE');

    const added = await office.post('/api/admin/members', { memberNo: 'S2001', name: 'Aina Sampel', className: '1 Contoh', cardUid: '04 aa bb cc dd ee 01' });
    assert.equal(added.status, 201);
    assert.equal(added.data.member.memberNo, 'S2001');
    assert.equal(added.data.member.card.uid, '04AABBCCDDEE01');
    assert.equal(added.data.card.status, 'ACTIVE');
    assert.equal(eventsOf(ctx, 'card.issued').at(-1).data.uid, '04AABBCCDDEE01');

    const taken = await office.post('/api/admin/members', { memberNo: 'S2002', name: 'Badrul Sampel', cardUid: member('smk-contoh', 'S1001').cardUid });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.error.code, 'CARD_UID_TAKEN');
    assert.equal((await office.get('/api/admin/members')).data.length, 8, 'no member without the card');
    const again = await office.post('/api/admin/members', { memberNo: 'S2002', name: 'Badrul Sampel' });
    assert.equal(again.status, 201);
    assert.equal(again.data.card, null);
    assert.equal(again.data.member.card, null);
    const dup = await office.post('/api/admin/members', { memberNo: 'S2002', name: 'Someone Else' });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error.code, 'MEMBER_NO_TAKEN');
    const bad = await office.post('/api/admin/members', { memberNo: 'S2003', name: '' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'NAME_INVALID');

    // a card for the member who has none
    const card = await office.post('/api/admin/cards', { memberId: again.data.member.id, uid: '04AABBCCDDEE02' });
    assert.equal(card.status, 201);
    assert.equal(card.data.last4, 'EE02');
    const cards = await office.get('/api/admin/cards');
    assert.equal(cards.data.length, 9);
    assert.equal(cards.data.find((c) => c.uid === '04AABBCCDDEE02').memberName, 'Badrul Sampel');
  });

  test('a member\'s page: balances, waiting orders, orders, purchases, cards and parent links', async (t) => {
    const { signIn, lab, school, member, seed } = await startLab(t);
    const smk = school('smk-contoh');
    const ahmad = member('smk-contoh', 'S1001');
    const rahman = seed.parents.find((p) => p.name === 'Rahman bin Yusof');
    paidTopup(lab, { parentId: rahman.id, schoolId: smk.id, memberId: ahmad.id, amountSen: 3000, key: 'k1' });
    addAtKiosk(lab, { schoolId: smk.id, uid: ahmad.cardUid });
    paidTopup(lab, { parentId: rahman.id, schoolId: smk.id, memberId: ahmad.id, amountSen: 2000, key: 'k2' });
    const digest = lab.platform.services.schools.cardDigestFor(smk.id, ahmad.cardUid);
    lab.platform.services.settlement.receive({
      schoolId: smk.id,
      via: 'MQTT',
      record: sale({ origin: 'CANTEEN-01', n: 1, digest, last4: ahmad.cardUid.slice(-4), cardSeq: 2, before: 3000, items: [ROTI], at: lab.ctx.clock.iso() }),
    });
    const res = await (await signIn('smk-contoh', 'FINANCE')).get(`/api/admin/members/${ahmad.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.member.name, 'Ahmad Faiz bin Rahman');
    assert.deepEqual(res.data.balances, { mirrorBalanceSen: 2850, waitingSen: 2000 });
    assert.deepEqual(res.data.waitingOrders.map((o) => o.amountSen), [2000]);
    assert.deepEqual(res.data.orders.map((o) => o.status), ['PAID', 'ADDED']);
    assert.equal(res.data.purchases.length, 1);
    assert.equal(res.data.purchases[0].amountSen, 150);
    assert.deepEqual(res.data.cards.map((c) => c.uid), [ahmad.cardUid]);
    assert.deepEqual(res.data.links.map((l) => [l.parentName, l.status]), [['Rahman bin Yusof', 'APPROVED']]);
    const missing = await (await signIn('smk-contoh', 'OFFICE')).get('/api/admin/members/mem_nobody');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error.code, 'MEMBER_NOT_FOUND');
  });

  test('report lost puts the card on a new block-list version, found takes it off; refusals', async (t) => {
    const { signIn, member, ctx } = await startLab(t);
    const office = await signIn('smk-contoh', 'OFFICE');
    const lee = member('smk-contoh', 'S1002');
    const lost = await office.post(`/api/admin/cards/${lee.cardUid}/report-lost`);
    assert.equal(lost.status, 200);
    assert.equal(lost.data.status, 'LOST');
    assert.equal(lost.data.lostListVersion, 2);
    assert.equal(lost.data.published, false, 'no broker: the office sees the machines did not hear of it');
    assert.equal(eventsOf(ctx, 'card.lost').at(-1).data.uid, lee.cardUid);
    const list = await office.get('/api/admin/blocklist');
    assert.equal(list.data.version, 2);
    assert.deepEqual(list.data.entries, [{ last4: '3C81', cardStatus: 'LOST', memberId: lee.id, memberName: 'Lee Mei Ling' }]);
    assert.doesNotMatch(list.text, /[0-9a-f]{64}/, 'no card digests');

    const twice = await office.post(`/api/admin/cards/${lee.cardUid}/report-lost`);
    assert.equal(twice.status, 409);
    assert.equal(twice.data.error.code, 'CARD_NOT_ACTIVE');
    const unknown = await office.post('/api/admin/cards/04FFFFFFFFFF99/report-lost');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.error.code, 'CARD_NOT_FOUND');
    const badUid = await office.post('/api/admin/cards/not-a-uid/report-lost');
    assert.equal(badUid.status, 400);
    assert.equal(badUid.data.error.code, 'CARD_UID_INVALID');

    const found = await office.post(`/api/admin/cards/${lee.cardUid}/found`);
    assert.equal(found.status, 200);
    assert.equal(found.data.status, 'ACTIVE');
    const after = await office.get('/api/admin/blocklist');
    assert.equal(after.data.version, 3);
    assert.deepEqual(after.data.entries, []);
    const notLost = await office.post(`/api/admin/cards/${lee.cardUid}/found`);
    assert.equal(notLost.status, 409);
    assert.equal(notLost.data.error.code, 'CARD_NOT_LOST');
  });

  test('replace a card: the old one is reported lost and the balance waits for the new card', async (t) => {
    const { signIn, lab, school, member } = await startLab(t);
    const smk = school('smk-contoh');
    const arjun = member('smk-contoh', 'S1003');
    lab.platform.services.topups.grantSubsidy({ schoolId: smk.id, memberId: arjun.id, amountSen: 4000, actor: 'test' });
    addAtKiosk(lab, { schoolId: smk.id, uid: arjun.cardUid });
    const office = await signIn('smk-contoh', 'OFFICE');
    const res = await office.post(`/api/admin/members/${arjun.id}/replace-card`, { newUid: '04ABCDEF012345' });
    assert.equal(res.status, 200);
    assert.equal(res.data.oldCard.uid, arjun.cardUid);
    assert.equal(res.data.oldCard.status, 'LOST');
    assert.equal(res.data.newCard.uid, '04ABCDEF012345');
    assert.equal(res.data.newCard.status, 'ACTIVE');
    assert.equal(res.data.transferOrder.kind, 'TRANSFER');
    assert.equal(res.data.transferOrder.amountSen, 4000);
    const page = await office.get(`/api/admin/members/${arjun.id}`);
    assert.deepEqual(page.data.balances, { mirrorBalanceSen: 0, waitingSen: 4000 });
    const bad = await office.post(`/api/admin/members/${arjun.id}/replace-card`, { newUid: 'zz' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'CARD_UID_INVALID');
  });
});

describe('admin: parents', () => {
  test('invites, a parent redeems one, the office approves or rejects the link', async (t) => {
    const { signIn, url, member } = await startLab(t);
    const office = await signIn('smk-contoh', 'OFFICE');
    const irfan = member('smk-contoh', 'S1006');
    const invites = await office.get('/api/admin/invites');
    assert.equal(invites.data.length, 5, 'the seed made one per demo link (4) and one open invitation');
    assert.ok(invites.data.some((i) => i.memberId === irfan.id && i.status === 'OPEN'));
    const created = await office.post('/api/admin/invites', { memberId: irfan.id });
    assert.equal(created.status, 201);
    assert.match(created.data.code, /^[2-9A-HJ-NP-Z]{8}$/);
    assert.equal(created.data.status, 'OPEN');

    const parent = browser(url);
    await parent.post('/api/parent/register', { email: 'hakim.sampel@example.com', name: 'Hakim Sampel' });
    const redeemed = await parent.post('/api/parent/invites/redeem', { code: created.data.code });
    assert.equal(redeemed.status, 201);
    assert.equal(redeemed.data.link.status, 'PENDING');

    const pending = await office.get('/api/admin/links?status=pending');
    assert.deepEqual(pending.data.map((l) => [l.parentName, l.memberName]), [['Hakim Sampel', 'Muhammad Irfan bin Hakim']]);
    const approve = await office.post(`/api/admin/links/${redeemed.data.link.id}/approve`);
    assert.equal(approve.status, 200);
    assert.equal(approve.data.status, 'APPROVED');
    const again = await office.post(`/api/admin/links/${redeemed.data.link.id}/reject`);
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'LINK_ALREADY_DECIDED');
    const children = await parent.get('/api/parent/children');
    assert.deepEqual(children.data.children.map((c) => c.name), ['Muhammad Irfan bin Hakim']);

    // another parent asks for the same child; the office says no
    const second = await office.post('/api/admin/invites', { memberId: irfan.id });
    const other = browser(url);
    await other.post('/api/parent/register', { email: 'other.sampel@example.com', name: 'Other Sampel' });
    const link = (await other.post('/api/parent/invites/redeem', { code: second.data.code })).data.link;
    const reject = await office.post(`/api/admin/links/${link.id}/reject`);
    assert.equal(reject.data.status, 'REJECTED');
    assert.deepEqual((await other.get('/api/parent/children')).data.children, []);
    const unknown = await office.post('/api/admin/links/lnk_nobody/approve');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.error.code, 'LINK_NOT_FOUND');
  });
});

describe('admin: machines', () => {
  test('register (secret once), list without secrets, switch on and off, version states, device log', async (t) => {
    const { signIn, lab, school, device } = await startLab(t);
    const smk = school('smk-contoh');
    const office = await signIn('smk-contoh', 'OFFICE');
    const created = await office.post('/api/admin/devices', { code: 'canteen-03', type: 'canteen', location: 'Canteen counter C' });
    assert.equal(created.status, 201);
    assert.match(created.data.secret, /^[0-9a-f]{64}$/);
    assert.equal(created.data.device.code, 'CANTEEN-03');
    assert.equal(created.data.device.type, 'CANTEEN');
    assert.equal(created.data.device.secret, undefined);
    assert.equal(created.data.published, false);
    const taken = await office.post('/api/admin/devices', { code: 'CANTEEN-03', type: 'CANTEEN' });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.error.code, 'DEVICE_CODE_TAKEN');
    const badType = await office.post('/api/admin/devices', { code: 'TOASTER-01', type: 'TOASTER' });
    assert.equal(badType.status, 400);

    const list = await office.get('/api/admin/devices');
    assert.deepEqual(list.data.map((d) => d.code), ['CANTEEN-01', 'CANTEEN-02', 'CANTEEN-03', 'KIOSK-01', 'WATER-01']);
    assert.equal(list.text.includes(created.data.secret), false);
    for (const d of smk.devices) assert.equal(list.text.includes(d.secret), false);

    const off = await office.post('/api/admin/devices/CANTEEN-02/status', { status: 'DISABLED' });
    assert.equal(off.status, 200);
    assert.equal(off.data.status, 'DISABLED');
    assert.equal(off.data.kicked, 0);
    assert.equal((await office.get('/api/admin/devices')).data.find((d) => d.code === 'CANTEEN-02').status, 'DISABLED');
    const on = await office.post('/api/admin/devices/canteen-02/status', { status: 'ACTIVE' });
    assert.equal(on.data.status, 'ACTIVE');
    const bad = await office.post('/api/admin/devices/CANTEEN-02/status', { status: 'BROKEN' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'DEVICE_STATUS_INVALID');
    const unknown = await office.post('/api/admin/devices/CANTEEN-99/status', { status: 'DISABLED' });
    assert.equal(unknown.status, 404);

    const states = await office.get('/api/admin/devices/states');
    assert.equal(states.data.length, 5 * 3);
    const row = states.data.find((s) => s.deviceCode === 'CANTEEN-01' && s.kind === 'prices');
    assert.deepEqual([row.appliedVersion, row.currentVersion, row.behind], [0, 1, true]);

    const { devices } = lab.platform.services;
    devices.log({ schoolId: smk.id, deviceId: device('smk-contoh', 'CANTEEN-01').id, level: 'WARN', code: 'SIGNATURE_INVALID' });
    devices.log({ schoolId: smk.id, deviceId: device('smk-contoh', 'WATER-01').id, level: 'INFO', code: 'NOTE', message: 'water note' });
    const all = await office.get('/api/admin/device-log');
    assert.deepEqual(all.data.map((l) => l.code), ['NOTE', 'SIGNATURE_INVALID']);
    const one = await office.get('/api/admin/device-log?device=CANTEEN-01&limit=5');
    assert.deepEqual(one.data.map((l) => [l.deviceCode, l.code]), [['CANTEEN-01', 'SIGNATURE_INVALID']]);
    const byId = await office.get(`/api/admin/device-log?deviceId=${device('smk-contoh', 'WATER-01').id}`);
    assert.deepEqual(byId.data.map((l) => l.code), ['NOTE']);
    assert.equal((await office.get('/api/admin/device-log?device=NOPE-01')).status, 404);
  });
});

describe('admin: prices, settings and the block list', () => {
  test('current versions; publishing a new price list and settings; invalid content is 400', async (t) => {
    const { signIn, ctx } = await startLab(t);
    const office = await signIn('smk-contoh', 'OFFICE');
    const configs = await office.get('/api/admin/configs');
    assert.equal(configs.data.prices.version, 1);
    assert.equal(configs.data.settings.version, 1);
    assert.deepEqual(configs.data.blocklist, { version: 1 });
    assert.deepEqual(configs.data.history.prices.map((v) => v.version), [1]);
    const prices = configs.data.prices.content;
    prices.items.find((i) => i.code === 'NASI-LEMAK').priceSen = 380;

    const published = await office.post('/api/admin/configs/prices', prices);
    assert.equal(published.status, 201);
    assert.equal(published.data.kind, 'prices');
    assert.equal(published.data.version, 2);
    assert.equal(published.data.content.items.find((i) => i.code === 'NASI-LEMAK').priceSen, 380);
    assert.equal(published.data.published, false);
    assert.equal(eventsOf(ctx, 'config.published').at(-1).data.version, 2);

    const wrapped = await office.post('/api/admin/configs/prices', { content: prices, effectiveFrom: ctx.clock.now() + DAY });
    assert.equal(wrapped.data.version, 3);
    assert.equal(wrapped.data.effectiveFrom, ctx.clock.now() + DAY);

    const invalid = await office.post('/api/admin/configs/prices', { items: [], water: { perLitreSen: 0, minChargeSen: 5 } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error.code, 'CONFIG_INVALID');
    assert.ok(Array.isArray(invalid.data.error.detail) && invalid.data.error.detail.length >= 2);
    const typo = await office.post('/api/admin/configs/prices', { ...prices, water: { perLiterSen: 20, minChargeSen: 5 } });
    assert.equal(typo.status, 400);

    const settings = configs.data.settings.content;
    const newSettings = await office.post('/api/admin/configs/settings', { ...settings, tapGapSeconds: 5 });
    assert.equal(newSettings.status, 201);
    assert.equal(newSettings.data.version, 2);
    assert.equal(newSettings.data.content.tapGapSeconds, 5);
    const after = await office.get('/api/admin/configs');
    assert.deepEqual([after.data.prices.version, after.data.settings.version], [3, 2]);
  });
});

describe('admin: top-ups, books and jobs', () => {
  test('subsidies, the top-up list, a parked order resolved by a person', async (t) => {
    const { signIn, lab, school, member, seed, ctx } = await startLab(t);
    const smk = school('smk-contoh');
    const finance = await signIn('smk-contoh', 'FINANCE');
    const irfan = member('smk-contoh', 'S1006');
    const subsidy = await finance.post('/api/admin/subsidies', { memberId: irfan.id, amountSen: 500, note: 'school fund' });
    assert.equal(subsidy.status, 201);
    assert.equal(subsidy.data.kind, 'SUBSIDY');
    assert.equal(subsidy.data.status, 'PAID');
    assert.equal(subsidy.data.amountSen, 500);
    const zero = await finance.post('/api/admin/subsidies', { memberId: irfan.id, amountSen: 0 });
    assert.equal(zero.status, 400);
    assert.equal(zero.data.error.code, 'AMOUNT_INVALID');

    // a top-up the kiosk wrote but never confirmed: after the add window it is parked for a person
    const ahmad = member('smk-contoh', 'S1001');
    const rahman = seed.parents.find((p) => p.name === 'Rahman bin Yusof');
    const order = paidTopup(lab, { parentId: rahman.id, schoolId: smk.id, memberId: ahmad.id, amountSen: 1500, key: 'park-me' });
    const kiosk = lab.platform.services.devices.getDeviceByCode(smk.id, 'KIOSK-01');
    lab.platform.services.topups.kioskPending({ schoolId: smk.id, kioskDeviceId: kiosk.id, cardDigest: lab.platform.services.schools.cardDigestFor(smk.id, ahmad.cardUid) });
    ctx.clock.advance(15 * DAY);
    const admin = await signIn('smk-contoh', 'ADMIN');
    const jobs = await admin.post('/api/admin/jobs/run');
    assert.equal(jobs.status, 200);
    assert.equal(jobs.data.parked, 1);
    assert.equal(jobs.data.refunded, 1, 'the subsidy was never written: refunded');
    assert.deepEqual(jobs.data.schools.map((s) => s.code), ['smk-contoh'], 'only the staff member\'s school');

    const all = await finance.get('/api/admin/topups');
    assert.deepEqual(all.data.map((o) => [o.kind, o.status]), [['TOPUP', 'PARKED'], ['SUBSIDY', 'REFUNDED']]);
    assert.deepEqual((await finance.get('/api/admin/topups?kind=SUBSIDY')).data.map((o) => o.id), [subsidy.data.id]);
    const parked = await finance.get('/api/admin/topups/parked');
    assert.deepEqual(parked.data.map((o) => o.id), [order.id]);
    const badDecision = await finance.post(`/api/admin/topups/${order.id}/resolve`, { decision: 'MAYBE' });
    assert.equal(badDecision.status, 400);
    assert.equal(badDecision.data.error.code, 'DECISION_INVALID');
    const resolved = await finance.post(`/api/admin/topups/${order.id}/resolve`, { decision: 'ADDED', note: 'seen on the card' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.status, 'ADDED');
    assert.equal(resolved.data.resolutionNote, 'seen on the card');
    assert.match(resolved.data.resolvedBy, /^Tan Wei Ming \(stf_/);
    const twice = await finance.post(`/api/admin/topups/${order.id}/resolve`, { decision: 'REFUND' });
    assert.equal(twice.status, 409);
    assert.equal(twice.data.error.code, 'ORDER_NOT_PARKED');
  });

  test('trial balance, postings, purchases and the sales report', async (t) => {
    const { signIn, lab, school, member } = await startLab(t);
    const smk = school('smk-contoh');
    const siti = member('smk-contoh', 'S1004');
    lab.platform.services.topups.grantSubsidy({ schoolId: smk.id, memberId: siti.id, amountSen: 1500, actor: 'test' });
    addAtKiosk(lab, { schoolId: smk.id, uid: siti.cardUid });
    const digest = lab.platform.services.schools.cardDigestFor(smk.id, siti.cardUid);
    lab.platform.services.settlement.receive({
      schoolId: smk.id,
      via: 'MQTT',
      record: sale({ origin: 'CANTEEN-01', n: 1, digest, last4: siti.cardUid.slice(-4), cardSeq: 2, before: 1500, items: [ROTI, TEH], at: lab.ctx.clock.iso() }),
    });
    const finance = await signIn('smk-contoh', 'FINANCE');
    const tb = await finance.get('/api/admin/ledger/trial-balance');
    assert.equal(tb.data.balanced, true);
    assert.equal(tb.data.totals.debitSen, tb.data.totals.creditSen);
    const wallet = tb.data.accounts.find((a) => a.kind === 'STUDENT_WALLET' && a.memberId === siti.id);
    assert.equal(wallet.balanceSen, 1500 - 330);
    const postings = await finance.get('/api/admin/ledger/postings?limit=2');
    assert.deepEqual(postings.data.map((p) => p.kind), ['PURCHASE', 'SUBSIDY_ADDED']);
    const mine = await finance.get(`/api/admin/ledger/postings?memberId=${siti.id}`);
    assert.equal(mine.data.length, 3);
    const purchases = await finance.get('/api/admin/purchases?device=canteen-01');
    assert.equal(purchases.data.length, 1);
    assert.equal(purchases.data[0].amountSen, 330);
    assert.equal((await finance.get('/api/admin/purchases?device=CANTEEN-02')).data.length, 0);
    const report = await finance.get('/api/admin/reports/sales');
    assert.deepEqual([report.data.day, report.data.totalSen, report.data.count], ['2026-10-05', 330, 1]);
    assert.deepEqual(report.data.byItem.map((i) => i.code), ['ROTI-CANAI', 'TEH-TARIK']);
    const otherDay = await finance.get('/api/admin/reports/sales?day=2026-10-04');
    assert.equal(otherDay.data.totalSen, 0);
    const badDay = await finance.get('/api/admin/reports/sales?day=2026-02-30');
    assert.equal(badDay.status, 400);
    assert.equal(badDay.data.error.code, 'DAY_INVALID');
  });

  test('the audit trail, newest first, for ADMIN', async (t) => {
    const { signIn, member } = await startLab(t);
    const office = await signIn('smk-contoh', 'OFFICE');
    await office.post(`/api/admin/cards/${member('smk-contoh', 'S1004').cardUid}/report-lost`);
    const audit = await (await signIn('smk-contoh', 'ADMIN')).get('/api/admin/audit?limit=3');
    assert.equal(audit.data.length, 3);
    assert.ok(audit.data[0].id > audit.data[1].id);
    assert.ok(audit.data.some((a) => a.action === 'card.lost' && /^Nur Aisyah \(stf_/.test(a.actor)));
  });
});

describe('admin: reconciliation and the USB journal import', () => {
  /** A USB export of `records` from a machine of the seed. */
  const usbFile = ({ school, device, records, exportedAt }) =>
    exportJournal({ schoolCode: school.code, deviceCode: device.code, secret: device.secret, records, exportedAt });

  test('a good file is settled record by record; the same file again counts as duplicates', async (t) => {
    const { signIn, lab, school, member, device } = await startLab(t);
    const smk = school('smk-contoh');
    const lee = member('smk-contoh', 'S1002');
    const digest = lab.platform.services.schools.cardDigestFor(smk.id, lee.cardUid);
    const at = lab.ctx.clock.iso();
    const records = [
      sale({ origin: 'CANTEEN-02', n: 1, digest, last4: '3C81', cardSeq: 1, before: 2500, items: [ROTI], at }),
      sale({ origin: 'CANTEEN-02', n: 2, digest, last4: '3C81', cardSeq: 2, before: 2350, items: [TEH], at }),
      { ...sale({ origin: 'CANTEEN-02', n: 3, digest, last4: '3C81', cardSeq: 3, before: 2170, items: [ROTI], at }), items: [{ ...ROTI, priceSen: 999 }], amountSen: 999, balanceAfterSen: 2170 - 999 },
      { txn: 'nonsense' },
    ];
    const file = usbFile({ school: smk, device: device('smk-contoh', 'CANTEEN-02'), records, exportedAt: at });
    const office = await signIn('smk-contoh', 'OFFICE');
    const first = await office.post('/api/admin/imports/journal', file);
    assert.equal(first.status, 200);
    assert.equal(first.data.school, 'smk-contoh');
    assert.equal(first.data.device, 'CANTEEN-02');
    assert.equal(first.data.total, 4);
    assert.deepEqual(first.data.counts, { POSTED: 3, FLAGGED: 0, DUPLICATE: 0, REFUSED: 1 });
    assert.equal(first.data.differences.PRICE_MISMATCH, 1);
    assert.equal(first.data.refused[0].index, 3);
    assert.equal(first.data.refused[0].code, 'RECORD_INVALID');

    const second = await office.post('/api/admin/imports/journal', { file });
    assert.deepEqual(second.data.counts, { POSTED: 0, FLAGGED: 0, DUPLICATE: 3, REFUSED: 1 });
    assert.equal(second.data.conflicts, 0);

    const purchases = lab.platform.services.settlement.listPurchases(smk.id);
    assert.equal(purchases.length, 3);
    assert.ok(purchases.every((p) => p.via === 'USB_IMPORT' && p.late));
    const audit = lab.platform.services.schools.listAudit(smk.id, 5);
    assert.ok(audit.some((a) => a.action === 'journal.import' && a.detail.device === 'CANTEEN-02'));
  });

  test('a tampered file, another school\'s file, an unknown machine and a malformed file are refused', async (t) => {
    const { signIn, lab, school, member, device } = await startLab(t);
    const smk = school('smk-contoh');
    const sjkc = school('sjkc-contoh');
    const lee = member('smk-contoh', 'S1002');
    const at = lab.ctx.clock.iso();
    const digest = lab.platform.services.schools.cardDigestFor(smk.id, lee.cardUid);
    const records = [sale({ origin: 'CANTEEN-02', n: 1, digest, last4: '3C81', cardSeq: 1, before: 2500, items: [ROTI], at })];
    const good = usbFile({ school: smk, device: device('smk-contoh', 'CANTEEN-02'), records, exportedAt: at });
    const office = await signIn('smk-contoh', 'OFFICE');

    const tampered = structuredClone(good);
    tampered.records[0].amountSen = 1;
    tampered.records[0].balanceAfterSen = 2499;
    const res = await office.post('/api/admin/imports/journal', tampered);
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'JOURNAL_SIGNATURE_INVALID');
    assert.equal(lab.platform.services.settlement.listPurchases(smk.id).length, 0, 'nothing from a tampered file');

    const sjkcFile = usbFile({ school: sjkc, device: device('sjkc-contoh', 'CANTEEN-01'), records: [], exportedAt: at });
    const other = await office.post('/api/admin/imports/journal', sjkcFile);
    assert.equal(other.status, 400);
    assert.equal(other.data.error.code, 'JOURNAL_WRONG_SCHOOL');
    // another school's machine secret on a file that claims this school: looked up here, so it does not verify
    const forged = exportJournal({ schoolCode: 'smk-contoh', deviceCode: 'CANTEEN-01', secret: device('sjkc-contoh', 'CANTEEN-01').secret, records, exportedAt: at });
    const forgedRes = await office.post('/api/admin/imports/journal', forged);
    assert.equal(forgedRes.data.error.code, 'JOURNAL_SIGNATURE_INVALID');

    const ghost = exportJournal({ schoolCode: 'smk-contoh', deviceCode: 'CANTEEN-09', secret: device('smk-contoh', 'CANTEEN-02').secret, records, exportedAt: at });
    const ghostRes = await office.post('/api/admin/imports/journal', ghost);
    assert.equal(ghostRes.status, 404);
    assert.equal(ghostRes.data.error.code, 'DEVICE_NOT_FOUND');

    for (const body of [{}, { school: 'smk-contoh', device: 'CANTEEN-02' }, { file: 'text' }]) {
      const bad = await office.post('/api/admin/imports/journal', body);
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal(bad.data.error.code, 'JOURNAL_INVALID');
    }
    assert.equal((await office.post('/api/admin/imports/journal', good)).data.counts.POSTED, 1, 'the untouched file still imports');
  });

  test('differences with their plain explanation, filtered, resolved once with a note', async (t) => {
    const { signIn, lab, school, member, device } = await startLab(t);
    const smk = school('smk-contoh');
    const lee = member('smk-contoh', 'S1002');
    const digest = lab.platform.services.schools.cardDigestFor(smk.id, lee.cardUid);
    const at = lab.ctx.clock.iso();
    const records = [sale({ origin: 'CANTEEN-02', n: 1, digest, last4: '3C81', cardSeq: 1, before: 2500, items: [ROTI], at })];
    const office = await signIn('smk-contoh', 'OFFICE');
    await office.post('/api/admin/imports/journal', usbFile({ school: smk, device: device('smk-contoh', 'CANTEEN-02'), records, exportedAt: at }));

    const finance = await signIn('smk-contoh', 'FINANCE');
    const open = await finance.get('/api/admin/differences?status=OPEN');
    assert.deepEqual(open.data.map((d) => d.kind), ['MIRROR_NEGATIVE'], 'the platform never saw her money arrive');
    assert.match(open.data[0].explanation.en, /below zero/);
    assert.equal(typeof open.data[0].explanation.zh, 'string');
    assert.equal((await finance.get('/api/admin/differences?status=bogus')).status, 400);

    const id = open.data[0].id;
    const resolved = await finance.post(`/api/admin/differences/${id}/resolve`, { note: 'start balance was loaded before the platform' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.status, 'RESOLVED');
    assert.equal(resolved.data.note, 'start balance was loaded before the platform');
    assert.match(resolved.data.resolvedBy, /^Tan Wei Ming \(stf_/);
    assert.equal(resolved.data.explanation.en.length > 0, true);
    const twice = await finance.post(`/api/admin/differences/${id}/resolve`, { note: 'again' });
    assert.equal(twice.status, 409);
    assert.equal(twice.data.error.code, 'DIFFERENCE_ALREADY_RESOLVED');
    const badNote = await finance.post(`/api/admin/differences/${id}/resolve`, { note: { not: 'text' } });
    assert.equal(badNote.status, 400);
    assert.deepEqual((await finance.get('/api/admin/differences?status=OPEN')).data, []);
    assert.equal((await finance.get('/api/admin/differences?status=resolved')).data.length, 1);
    const audit = lab.platform.services.schools.listAudit(smk.id, 3);
    assert.equal(audit[0].action, 'difference.resolve');
  });
});

describe('admin: tenant isolation', () => {
  test('another school\'s member, card, device, order, link and difference ids answer 404 as if they did not exist', async (t) => {
    const { signIn, lab, school, member, device, seed } = await startLab(t);
    const smk = school('smk-contoh');
    const sjkc = school('sjkc-contoh');
    const { topups, schools, differences } = lab.platform.services;
    const junHao = member('sjkc-contoh', 'P101');
    // things that exist only in SJK(C) Contoh
    const tanKokWai = seed.parents.find((p) => p.name === 'Tan Kok Wai');
    const sjkcOrder = paidTopup(lab, { parentId: tanKokWai.id, schoolId: sjkc.id, memberId: member('sjkc-contoh', 'P102').id, amountSen: 1000, key: 'iso' });
    const sjkcLink = schools.listLinks(sjkc.id)[0];
    const sjkcDifference = differences.open({ schoolId: sjkc.id, kind: 'OLD_BLOCK_LIST', ref: 'CANTEEN-01:1', detail: {} }).difference;
    const sjkcInvite = schools.createInvite({ schoolId: sjkc.id, memberId: junHao.id, actor: 'test' });

    const admin = await signIn('smk-contoh', 'ADMIN');
    const notFound = async (method, path, json, code) => {
      const res = method === 'GET' ? await admin.get(path) : await admin.post(path, json);
      assert.equal(res.status, 404, `${method} ${path}: ${res.text}`);
      if (code) assert.equal(res.data.error.code, code, path);
    };
    await notFound('GET', `/api/admin/members/${junHao.id}`, undefined, 'MEMBER_NOT_FOUND');
    await notFound('POST', `/api/admin/members/${junHao.id}/replace-card`, { newUid: '04ABABABABAB01' }, 'MEMBER_NOT_FOUND');
    await notFound('POST', '/api/admin/invites', { memberId: junHao.id }, 'MEMBER_NOT_FOUND');
    await notFound('POST', '/api/admin/subsidies', { memberId: junHao.id, amountSen: 100 }, 'MEMBER_NOT_FOUND');
    await notFound('POST', '/api/admin/cards', { memberId: junHao.id, uid: '04ABABABABAB02' }, 'MEMBER_NOT_FOUND');
    await notFound('POST', `/api/admin/cards/${junHao.cardUid}/report-lost`, {}, 'CARD_NOT_FOUND');
    await notFound('POST', `/api/admin/cards/${junHao.cardUid}/found`, {}, 'CARD_NOT_FOUND');
    await notFound('GET', `/api/admin/device-log?deviceId=${device('sjkc-contoh', 'KIOSK-01').id}`, undefined, 'DEVICE_NOT_FOUND');
    await notFound('POST', `/api/admin/topups/${sjkcOrder.id}/resolve`, { decision: 'ADDED' }, 'ORDER_NOT_FOUND');
    await notFound('POST', `/api/admin/links/${sjkcLink.id}/approve`, {}, 'LINK_NOT_FOUND');
    await notFound('POST', `/api/admin/differences/${sjkcDifference.id}/resolve`, { note: 'x' }, 'DIFFERENCE_NOT_FOUND');
    // a machine code only the other school has
    const sjkcStaff = await signIn('sjkc-contoh', 'ADMIN');
    const res = await sjkcStaff.post('/api/admin/devices/CANTEEN-02/status', { status: 'DISABLED' });
    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, 'DEVICE_NOT_FOUND');

    // nothing of the other school in any list
    const sjkcNames = sjkc.members.map((m) => m.name);
    const lists = [
      '/api/admin/members',
      '/api/admin/cards',
      '/api/admin/devices',
      '/api/admin/topups',
      '/api/admin/invites',
      '/api/admin/links',
      '/api/admin/purchases',
      '/api/admin/differences',
      '/api/admin/audit?limit=1000',
      '/api/admin/ledger/trial-balance',
      '/api/admin/ledger/postings?limit=1000',
      `/api/admin/ledger/postings?memberId=${junHao.id}`,
      `/api/admin/topups?memberId=${member('sjkc-contoh', 'P102').id}`,
    ];
    for (const path of lists) {
      const list = await admin.get(path);
      assert.equal(list.status, 200, path);
      for (const name of sjkcNames) assert.equal(list.text.includes(name), false, `${path} shows ${name}`);
      for (const id of [sjkc.id, sjkcOrder.id, sjkcLink.id, sjkcDifference.id, sjkcInvite.code, junHao.cardUid]) {
        assert.equal(list.text.includes(id), false, `${path} shows ${id}`);
      }
    }
    // a school id in the body is ignored: the session names the school
    const subsidy = await admin.post('/api/admin/subsidies', { schoolId: sjkc.id, memberId: member('smk-contoh', 'S1006').id, amountSen: 100 });
    assert.equal(subsidy.status, 201);
    assert.equal(subsidy.data.schoolId, smk.id);
  });

  test('the overview, block list, prices, machine states, device log, sales and parked orders show the own school only', async (t) => {
    const { signIn, lab, school, member, device, seed, url } = await startLab(t);
    const smk = school('smk-contoh');
    const sjkc = school('sjkc-contoh');
    const { topups, settlement, devices, configs, schools, differences } = lab.platform.services;
    // SJK(C) Contoh gets one of everything: a parked order, a lost card, its own price list, a
    // device log line, a sale today and a pending parent link
    const tanKokWai = seed.parents.find((p) => p.name === 'Tan Kok Wai');
    const xinYi = member('sjkc-contoh', 'P102');
    const parked = paidTopup(lab, { parentId: tanKokWai.id, schoolId: sjkc.id, memberId: xinYi.id, amountSen: 1000, key: 'parked' });
    const kiosk = device('sjkc-contoh', 'KIOSK-01');
    topups.kioskPending({ schoolId: sjkc.id, kioskDeviceId: kiosk.id, cardDigest: schools.cardDigestFor(sjkc.id, xinYi.cardUid) });
    lab.ctx.clock.advance(15 * DAY);
    lab.platform.runJobs();
    assert.equal(topups.getOrder(sjkc.id, parked.id).status, 'PARKED');
    await lab.platform.reportCardLost({ schoolId: sjkc.id, uid: member('sjkc-contoh', 'P103').cardUid, actor: 'test' });
    configs.publish({ schoolId: sjkc.id, kind: 'prices', content: { items: [{ code: 'SJKC-ONLY', name: 'Sjkc only', priceSen: 100 }], water: { perLitreSen: 20, minChargeSen: 5 } }, actor: 'test' });
    devices.log({ schoolId: sjkc.id, deviceId: kiosk.id, level: 'WARN', code: 'SJKC_ONLY_LOG', message: 'sjkc only log line' });
    const junHao = member('sjkc-contoh', 'P101');
    const sold = settlement.receive({
      schoolId: sjkc.id,
      via: 'MQTT',
      record: sale({
        origin: 'CANTEEN-01', n: 1, digest: schools.cardDigestFor(sjkc.id, junHao.cardUid), last4: junHao.cardUid.slice(-4),
        cardSeq: 1, before: 1000, items: [TEH], at: lab.ctx.clock.iso(),
      }),
    });
    assert.equal(sold.status, 'POSTED');
    const newcomer = browser(url);
    await newcomer.post('/api/parent/register', { email: 'pending.sampel@example.com', name: 'Pending Sampel' });
    const pending = await newcomer.post('/api/parent/invites/redeem', { code: sjkc.openInvite.code });
    assert.equal(pending.data.link.status, 'PENDING');

    const admin = await signIn('smk-contoh', 'ADMIN');
    const overview = await admin.get('/api/admin/overview');
    assert.equal(overview.data.school.id, smk.id);
    assert.deepEqual([overview.data.today.salesSen, overview.data.today.purchases, overview.data.parkedOrders], [0, 0, 0]);
    assert.equal(overview.data.openDifferences, differences.countOpen(smk.id));
    const sales = await admin.get('/api/admin/reports/sales');
    assert.deepEqual([sales.data.totalSen, sales.data.count, sales.data.byItem], [0, 0, []]);
    assert.deepEqual((await admin.get('/api/admin/topups/parked')).data, []);
    const blocklist = await admin.get('/api/admin/blocklist');
    assert.deepEqual(blocklist.data.entries, []);
    const sjkcDeviceIds = sjkc.devices.map((d) => d.id);
    for (const path of ['/api/admin/blocklist', '/api/admin/configs', '/api/admin/devices/states', '/api/admin/device-log?limit=1000', '/api/admin/overview']) {
      const res = await admin.get(path);
      assert.equal(res.status, 200, path);
      for (const text of ['Ng Zhi Hao', 'SJKC-ONLY', 'SJKC_ONLY_LOG', 'sjkc only', sjkc.id, ...sjkcDeviceIds]) {
        assert.equal(res.text.includes(text), false, `${path} shows ${text}`);
      }
    }
    const reject = await admin.post(`/api/admin/links/${pending.data.link.id}/reject`);
    assert.equal(reject.status, 404);
    assert.equal(reject.data.error.code, 'LINK_NOT_FOUND');
    assert.equal(schools.listLinks(sjkc.id, { status: 'PENDING' }).length, 1, 'the other school\'s link is untouched');

    // a school id in the query string is ignored too
    const members = await admin.get(`/api/admin/members?schoolId=${sjkc.id}`);
    assert.deepEqual(members.data.map((m) => m.id).sort(), smk.members.map((m) => m.id).sort());
    const orders = await admin.get(`/api/admin/topups?schoolId=${sjkc.id}`);
    assert.equal(orders.text.includes(parked.id), false);
    const report = await admin.get(`/api/admin/reports/sales?schoolId=${sjkc.id}`);
    assert.equal(report.data.count, 0);
  });
});
