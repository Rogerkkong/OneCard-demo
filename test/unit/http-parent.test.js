import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { createHttpServer } from '../../src/http/server.js';
import { signPayload } from '../../src/shared/crypto.js';
import { MINUTE } from '../../src/shared/time.js';

// The parent app API: sign-in, children through APPROVED links only, the balance and the money
// waiting kept apart, history and top-ups. Everyone here is the fictional demo seed.

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
  const parent = (name) => seed.parents.find((p) => p.name === name);
  const signIn = async (name) => {
    const b = browser(url);
    const res = await b.post('/api/parent/login', { parentId: parent(name).id });
    assert.equal(res.status, 200);
    return b;
  };
  return { ctx, platform, seed, lab, url, school, member, parent, signIn };
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
  return { jar, get: (p) => call('GET', p), post: (p, json = {}, headers = {}) => call('POST', p, { json, headers }) };
}

/** Pay an order the way the provider does: a signed callback. */
function pay(lab, order) {
  const payload = { orderId: order.id, provider: 'MOCKBANK', providerTxnId: `TEST-${order.id}`, result: 'SUCCESS', paidAmountSen: order.amountSen, paidAt: lab.ctx.clock.iso() };
  return lab.platform.services.topups.paymentCallback({ ...payload, signature: signPayload(lab.ctx.settings.providerSecret, payload) });
}

/** Everything waiting for a card, written and confirmed at KIOSK-01. */
function addAtKiosk(lab, { schoolId, uid, txn = 1 }) {
  const { topups, devices, schools } = lab.platform.services;
  const kiosk = devices.getDeviceByCode(schoolId, 'KIOSK-01');
  const digest = schools.cardDigestFor(schoolId, uid);
  const pending = topups.kioskPending({ schoolId, kioskDeviceId: kiosk.id, cardDigest: digest });
  let balance = pending.mirrorBalanceSen;
  for (const o of pending.orders) {
    balance += o.amountSen;
    topups.kioskConfirm({ schoolId, kioskDeviceId: kiosk.id, kioskDeviceCode: 'KIOSK-01', orderId: o.orderId, result: 'ADDED', amountSen: o.amountSen, cardDigest: digest, balanceAfterOnCardSen: balance, kioskTxn: `KIOSK-01-${String(txn++).padStart(6, '0')}` });
  }
}

const childPath = (schoolId, memberId, tail) => `/api/parent/children/${schoolId}/${memberId}/${tail}`;

describe('parent: session', () => {
  test('options list the demo parents with their children; login, me, logout', async (t) => {
    const { url, parent } = await startLab(t);
    const b = browser(url);
    const options = await b.get('/api/parent/options');
    assert.equal(options.status, 200);
    assert.equal(options.data.length, 6);
    const lee = options.data.find((p) => p.name === 'Lee Kah Seng');
    assert.deepEqual(lee.children, [
      { schoolCode: 'smk-contoh', schoolName: 'SMK Seri Contoh', name: 'Lee Mei Ling' },
      { schoolCode: 'sjkc-contoh', schoolName: 'SJK(C) Contoh', name: 'Lee Jun Hao' },
    ]);
    assert.equal((await b.get('/api/parent/me')).status, 401);
    const login = await b.post('/api/parent/login', { parentId: parent('Lee Kah Seng').id });
    assert.deepEqual(login.data.parent, { id: parent('Lee Kah Seng').id, email: 'lee.kahseng@example.com', name: 'Lee Kah Seng' });
    assert.equal((await b.get('/api/parent/me')).data.parent.name, 'Lee Kah Seng');
    await b.post('/api/parent/logout');
    assert.equal((await b.get('/api/parent/me')).status, 401);
    const unknown = await b.post('/api/parent/login', { parentId: 'par_nobody' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.error.code, 'PARENT_NOT_FOUND');
  });

  test('register signs the new parent in; a taken or invalid email is refused', async (t) => {
    const { url } = await startLab(t);
    const b = browser(url);
    const res = await b.post('/api/parent/register', { email: ' Nora.Sampel@Example.com ', name: 'Nora Sampel' });
    assert.equal(res.status, 201);
    assert.equal(res.data.parent.email, 'nora.sampel@example.com');
    assert.equal((await b.get('/api/parent/me')).data.parent.name, 'Nora Sampel');
    assert.deepEqual((await b.get('/api/parent/children')).data, { children: [], links: [] });
    const taken = await browser(url).post('/api/parent/register', { email: 'nora.sampel@example.com', name: 'Again' });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.error.code, 'EMAIL_TAKEN');
    const invalid = await browser(url).post('/api/parent/register', { email: 'not-an-email', name: 'X' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error.code, 'EMAIL_INVALID');
  });
});

describe('parent: children', () => {
  test('one parent, children in two schools; nobody else\'s', async (t) => {
    const { signIn, school, member } = await startLab(t);
    const b = await signIn('Lee Kah Seng');
    const res = await b.get('/api/parent/children');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.children.map((c) => [c.schoolCode, c.name, c.className, c.schoolStatus]), [
      ['smk-contoh', 'Lee Mei Ling', '4 Bestari', 'ACTIVE'],
      ['sjkc-contoh', 'Lee Jun Hao', '3 Merah', 'ACTIVE'],
    ]);
    const meiLing = res.data.children[0];
    assert.equal(meiLing.schoolId, school('smk-contoh').id);
    assert.equal(meiLing.memberId, member('smk-contoh', 'S1002').id);
    assert.deepEqual(meiLing.card, { last4: '3C81', status: 'ACTIVE' }, 'last 4 only, not the card number');
    assert.deepEqual(res.data.links.map((l) => [l.name, l.status]), [['Lee Mei Ling', 'APPROVED'], ['Lee Jun Hao', 'APPROVED']]);
  });

  test('an invitation code gives a pending link; the child appears once the school approves', async (t) => {
    const { url, seed, member, school, lab } = await startLab(t);
    const b = browser(url);
    await b.post('/api/parent/register', { email: 'hakim.sampel@example.com', name: 'Hakim Sampel' });
    const code = seed.schools[0].openInvite.code;
    const res = await b.post('/api/parent/invites/redeem', { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` });
    assert.equal(res.status, 201);
    assert.equal(res.data.link.status, 'PENDING');
    assert.equal(res.data.link.memberName, 'Muhammad Irfan bin Hakim');
    let children = await b.get('/api/parent/children');
    assert.deepEqual(children.data.children, []);
    assert.deepEqual(children.data.links.map((l) => [l.name, l.status]), [['Muhammad Irfan bin Hakim', 'PENDING']]);
    // a pending link grants nothing yet
    const irfan = member('smk-contoh', 'S1006');
    assert.equal((await b.get(childPath(school('smk-contoh').id, irfan.id, 'balance'))).status, 404);

    const used = await browser(url).post('/api/parent/invites/redeem', { code });
    assert.equal(used.status, 401, 'signed-out callers cannot redeem');
    const wrong = await b.post('/api/parent/invites/redeem', { code: 'ZZZZZZZZ' });
    assert.equal(wrong.status, 404);
    assert.equal(wrong.data.error.code, 'INVITE_INVALID');

    lab.platform.services.schools.decideLink({ schoolId: school('smk-contoh').id, linkId: res.data.link.id, approve: true, actor: 'test' });
    children = await b.get('/api/parent/children');
    assert.deepEqual(children.data.children.map((c) => c.name), ['Muhammad Irfan bin Hakim']);
    assert.equal((await b.get(childPath(school('smk-contoh').id, irfan.id, 'balance'))).status, 200);
  });

  test('an unlinked child answers 404 exactly as one that does not exist', async (t) => {
    const { signIn, school, member } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const smk = school('smk-contoh').id;
    const sjkc = school('sjkc-contoh').id;
    const attempts = [
      [smk, member('smk-contoh', 'S1002').id], // another parent's child, same school
      [sjkc, member('sjkc-contoh', 'P101').id], // another school's child
      [sjkc, member('smk-contoh', 'S1001').id], // own child under the wrong school
      [smk, 'mem_nobody'],
      ['sch_nobody', member('smk-contoh', 'S1001').id],
    ];
    for (const [schoolId, memberId] of attempts) {
      for (const tail of ['balance', 'history']) {
        const res = await b.get(childPath(schoolId, memberId, tail));
        assert.equal(res.status, 404, `${schoolId}/${memberId}/${tail}`);
        assert.equal(res.data.error.code, 'CHILD_NOT_FOUND');
      }
      const topup = await b.post(childPath(schoolId, memberId, 'topups'), { amountSen: 1000 }, { 'idempotency-key': `k-${memberId}` });
      assert.equal(topup.status, 404);
      assert.equal(topup.data.error.code, 'CHILD_NOT_FOUND');
    }
  });

  test('a suspended school blocks its own children only', async (t) => {
    const { signIn, school, member, lab } = await startLab(t);
    const b = await signIn('Lee Kah Seng');
    const smk = school('smk-contoh').id;
    const sjkc = school('sjkc-contoh').id;
    await lab.platform.setSchoolStatus({ schoolId: sjkc, status: 'SUSPENDED', actor: 'test' });
    const junHao = member('sjkc-contoh', 'P101').id;
    for (const tail of ['balance', 'history']) {
      const res = await b.get(childPath(sjkc, junHao, tail));
      assert.equal(res.status, 403);
      assert.equal(res.data.error.code, 'SCHOOL_SUSPENDED');
    }
    const topup = await b.post(childPath(sjkc, junHao, 'topups'), { amountSen: 1000 }, { 'idempotency-key': 'sus-1' });
    assert.equal(topup.status, 403);
    assert.equal((await b.get(childPath(smk, member('smk-contoh', 'S1002').id, 'balance'))).status, 200);
    const children = await b.get('/api/parent/children');
    assert.deepEqual(children.data.children.map((c) => c.schoolStatus), ['ACTIVE', 'SUSPENDED']);
    // an unlinked child of the suspended school is still just not found
    assert.equal((await b.get(childPath(sjkc, member('sjkc-contoh', 'P102').id, 'balance'))).status, 404);
  });
});

describe('parent: balance, history and top-ups', () => {
  test('balance and waiting money side by side, with the time the platform last heard about the card', async (t) => {
    const { signIn, school, member, parent, lab, ctx } = await startLab(t);
    const smk = school('smk-contoh').id;
    const ahmad = member('smk-contoh', 'S1001');
    const b = await signIn('Rahman bin Yusof');
    const path = childPath(smk, ahmad.id, 'balance');
    assert.deepEqual((await b.get(path)).data, { mirrorBalanceSen: 0, waitingSen: 0, asOf: null });

    const { topups, settlement, schools } = lab.platform.services;
    pay(lab, topups.createOrder({ parentId: parent('Rahman bin Yusof').id, schoolId: smk, memberId: ahmad.id, amountSen: 3000, idemKey: 'a' }));
    assert.deepEqual((await b.get(path)).data, { mirrorBalanceSen: 0, waitingSen: 3000, asOf: null }, 'a payment is not news about the card');

    ctx.clock.advance(5 * MINUTE);
    addAtKiosk(lab, { schoolId: smk, uid: ahmad.cardUid });
    const added = ctx.clock.now();
    assert.deepEqual((await b.get(path)).data, { mirrorBalanceSen: 3000, waitingSen: 0, asOf: added });

    ctx.clock.advance(5 * MINUTE);
    const digest = schools.cardDigestFor(smk, ahmad.cardUid);
    // a purchase made earlier on an offline reader, received now: asOf is when it arrived
    const record = {
      txn: 'CANTEEN-02-000001', origin: 'CANTEEN-02', kind: 'SALE', card: digest, last4: ahmad.cardUid.slice(-4), cardSeq: 2,
      amountSen: 350, items: [{ code: 'NASI-LEMAK', qty: 1, priceSen: 350 }], priceVersion: 1, listVersion: 1,
      balanceBeforeSen: 3000, balanceAfterSen: 2650, at: new Date(added - MINUTE).toISOString(),
    };
    assert.equal(settlement.receive({ schoolId: smk, via: 'JOURNAL_BATCH', record }).status, 'POSTED');
    assert.deepEqual((await b.get(path)).data, { mirrorBalanceSen: 2650, waitingSen: 0, asOf: ctx.clock.now() });
  });

  test('history: this parent\'s top-ups, the school\'s subsidies and transfers, the child\'s purchases', async (t) => {
    const { signIn, url, school, member, parent, lab } = await startLab(t);
    const smk = school('smk-contoh').id;
    const meiLing = member('smk-contoh', 'S1002');
    const { topups, schools } = lab.platform.services;
    // a second parent of the same child
    const other = schools.registerParent({ email: 'aunty.sampel@example.com', name: 'Aunty Sampel' });
    const invite = schools.createInvite({ schoolId: smk, memberId: meiLing.id, actor: 'test' });
    const link = schools.redeemInvite({ parentId: other.id, code: invite.code });
    schools.decideLink({ schoolId: smk, linkId: link.id, approve: true, actor: 'test' });
    const leeKahSeng = parent('Lee Kah Seng').id;
    const mine = pay(lab, topups.createOrder({ parentId: leeKahSeng, schoolId: smk, memberId: meiLing.id, amountSen: 2000, idemKey: 'mine' }));
    pay(lab, topups.createOrder({ parentId: other.id, schoolId: smk, memberId: meiLing.id, amountSen: 1000, idemKey: 'theirs' }));
    const subsidy = topups.grantSubsidy({ schoolId: smk, memberId: meiLing.id, amountSen: 500, actor: 'test', note: 'staff note: hardship fund' });
    addAtKiosk(lab, { schoolId: smk, uid: meiLing.cardUid });
    const digest = schools.cardDigestFor(smk, meiLing.cardUid);
    lab.platform.services.settlement.receive({
      schoolId: smk,
      via: 'MQTT',
      record: {
        txn: 'WATER-01-000001', origin: 'WATER-01', kind: 'WATER', card: digest, last4: '3C81', cardSeq: 4, amountSen: 13,
        ml: 650, perLitreSen: 20, priceVersion: 1, listVersion: 1, balanceBeforeSen: 3500, balanceAfterSen: 3487, at: lab.ctx.clock.iso(),
      },
    });

    const b = await signIn('Lee Kah Seng');
    const res = await b.get(childPath(smk, meiLing.id, 'history'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.topups.map((o) => o.id).sort(), [mine.id, subsidy.id].sort(), 'not the other parent\'s top-up');
    const topup = res.data.topups.find((o) => o.id === mine.id);
    assert.equal(topup.status, 'ADDED');
    assert.equal(topup.mine, true);
    assert.equal(topup.amountSen, 2000);
    assert.doesNotMatch(res.text, /hardship|kioskTxn|resolutionNote|KIOSK-01-0/, 'no staff notes or kiosk numbers');
    assert.deepEqual(res.data.purchases.map((p) => [p.kind, p.ml, p.amountSen, p.originDeviceCode]), [['WATER', 650, 13, 'WATER-01']]);

    // the other parent sees their own top-up and the subsidy, not Lee Kah Seng's
    const aunty = browser(url);
    await aunty.post('/api/parent/login', { parentId: other.id });
    const theirs = await aunty.get(childPath(smk, meiLing.id, 'history'));
    assert.equal(theirs.data.topups.some((o) => o.id === mine.id), false);
    assert.equal(theirs.data.topups.length, 2);
  });

  test('top-up: Idempotency-Key required and honoured, limits explained, then the bank', async (t) => {
    const { signIn, school, member } = await startLab(t);
    const smk = school('smk-contoh').id;
    const ahmad = member('smk-contoh', 'S1001');
    const b = await signIn('Rahman bin Yusof');
    const path = childPath(smk, ahmad.id, 'topups');

    const noKey = await b.post(path, { amountSen: 1500 });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const first = await b.post(path, { amountSen: 1500 }, { 'idempotency-key': 'key-1' });
    assert.equal(first.status, 201);
    assert.equal(first.data.order.status, 'CREATED');
    assert.equal(first.data.order.amountSen, 1500);
    assert.equal(first.data.order.kind, 'TOPUP');
    assert.equal(first.data.order.mine, true);
    assert.equal(first.data.payUrl, `/pay/${first.data.order.id}`);
    assert.equal(first.data.order.payUrl, first.data.payUrl);
    const retry = await b.post(path, { amountSen: 1500 }, { 'idempotency-key': 'key-1' });
    assert.equal(retry.data.order.id, first.data.order.id, 'a retry is the same order');
    const reused = await b.post(path, { amountSen: 2500 }, { 'idempotency-key': 'key-1' });
    assert.equal(reused.status, 409);
    assert.equal(reused.data.error.code, 'IDEMPOTENCY_KEY_REUSED');

    const tooSmall = await b.post(path, { amountSen: 100 }, { 'idempotency-key': 'key-2' });
    assert.equal(tooSmall.status, 400);
    assert.equal(tooSmall.data.error.code, 'AMOUNT_OUT_OF_RANGE');
    assert.deepEqual(tooSmall.data.error.detail, { minSen: 500, maxSen: 20000, amountSen: 100 });
    const notSen = await b.post(path, { amountSen: 12.5 }, { 'idempotency-key': 'key-3' });
    assert.equal(notSen.status, 400);
    assert.equal(notSen.data.error.code, 'AMOUNT_INVALID');
    await b.post(path, { amountSen: 20000 }, { 'idempotency-key': 'key-4' });
    const daily = await b.post(path, { amountSen: 20000 }, { 'idempotency-key': 'key-5' });
    assert.equal(daily.status, 400);
    assert.equal(daily.data.error.code, 'DAILY_LIMIT');
    assert.equal(daily.data.error.detail.remainingSen, 30000 - 21500);

    const list = await b.get('/api/parent/topups');
    assert.deepEqual(list.data.map((o) => [o.amountSen, o.status, o.schoolName]), [
      [20000, 'CREATED', 'SMK Seri Contoh'],
      [1500, 'CREATED', 'SMK Seri Contoh'],
    ]);
  });

  test('a lost card cannot be topped up', async (t) => {
    const { signIn, school, member, lab } = await startLab(t);
    const smk = school('smk-contoh').id;
    const ahmad = member('smk-contoh', 'S1001');
    await lab.platform.reportCardLost({ schoolId: smk, uid: ahmad.cardUid, actor: 'test' });
    const b = await signIn('Rahman bin Yusof');
    const res = await b.post(childPath(smk, ahmad.id, 'topups'), { amountSen: 1500 }, { 'idempotency-key': 'lost-1' });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'CARD_NOT_ACTIVE');
    const children = await b.get('/api/parent/children');
    assert.deepEqual(children.data.children[0].card, { last4: '2E80', status: 'LOST' });
  });
});
