import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createLedger } from '../../src/platform/ledger.js';
import { createSchools } from '../../src/platform/schools.js';
import { createDifferences } from '../../src/platform/differences.js';
import { createTopups, ORDER_KINDS, ORDER_STATUSES } from '../../src/platform/topups.js';
import { signPayload } from '../../src/shared/crypto.js';
import { DAY, HOUR, MINUTE, klDay, klMonth } from '../../src/shared/time.js';

// All schools, people, e-mail addresses and card numbers below are fictional.

const KIOSK = Object.freeze({ id: 'dev_kiosk_alpha', code: 'KIOSK-01' });
const OTHER_KIOSK = Object.freeze({ id: 'dev_kiosk_other', code: 'KIOSK-02' });
const ORDER_KEYS = [
  'addBy', 'addedAt', 'addedByDevice', 'amountSen', 'balanceAfterOnCardSen', 'createdAt', 'id', 'kind', 'kioskTxn', 'memberId',
  'memberName', 'paidAt', 'parentId', 'payBy', 'resolutionNote', 'resolvedBy', 'schoolId', 'status', 'writeAttemptAt', 'writeResult',
];

/** assert.throws matcher for a LabError code (and optional HTTP status). */
const code = (c, status) => (err) => {
  assert.equal(err.name, 'LabError', `expected LabError ${c}, got ${err}`);
  assert.equal(err.code, c, `expected ${c}, got ${err.code}: ${err.message}`);
  if (status !== undefined) assert.equal(err.status, status, `${c} should be HTTP ${status}`);
  return true;
};

/**
 * The books balance, and every account agrees with the orders: cash received = paid top-ups,
 * school subsidy = granted subsidies, waiting = PAID + PARKED orders, and each mirror wallet =
 * added − transferred away − spent.
 */
function checkBooks(t) {
  for (const school of [t.a, t.b]) {
    assert.equal(t.ledger.trialBalance(school.id).balanced, true, `${school.code}: the trial balance must balance`);
    const orders = t.topups.listOrders({ schoolId: school.id, limit: 1000 });
    const total = (keep) => orders.filter(keep).reduce((sum, o) => sum + o.amountSen, 0);
    const funded = (o) => o.status === 'PAID' || o.status === 'PARKED' || o.status === 'ADDED';
    assert.equal(t.ledger.balance(school.id, 'CASH_RECEIVED'), total((o) => o.kind === 'TOPUP' && funded(o)), `${school.code}: cash received`);
    assert.equal(t.ledger.balance(school.id, 'SCHOOL_SUBSIDY'), total((o) => o.kind === 'SUBSIDY' && funded(o)), `${school.code}: subsidies`);
    for (const m of t.schools.listMembers(school.id)) {
      const mine = (keep) => total((o) => o.memberId === m.id && keep(o));
      assert.equal(
        t.ledger.balance(school.id, 'WAITING_TO_BE_ADDED', m.id),
        mine((o) => o.status === 'PAID' || o.status === 'PARKED'),
        `${m.name}: waiting to be added`,
      );
      assert.equal(
        t.ledger.balance(school.id, 'STUDENT_WALLET', m.id),
        mine((o) => o.status === 'ADDED') - mine((o) => o.kind === 'TRANSFER' && funded(o)) - (t.spent.get(m.id) ?? 0),
        `${m.name}: mirror wallet`,
      );
    }
  }
}

// Every test builds its own fixture; afterwards its books are checked and its database closed.
const fixtures = [];
afterEach(() => {
  for (const t of fixtures.splice(0)) {
    try {
      checkBooks(t);
    } finally {
      t.ctx.db.close();
    }
  }
});

function link(t, member, parent, approve = true) {
  const invite = t.schools.createInvite({ schoolId: member.schoolId, memberId: member.id, actor: 'test' });
  const l = t.schools.redeemInvite({ parentId: parent.id, code: invite.code });
  if (approve !== null) t.schools.decideLink({ schoolId: member.schoolId, linkId: l.id, approve, actor: 'test' });
}

/**
 * Two schools. Parent One is linked to Aina, Badrul and Dewi (school A) and Eng (school B);
 * Parent Two to Aina only. Nobody is linked to Chandra; Dewi has no card.
 */
function setup({ startAt, settings } = {}) {
  const ctx = createTestCtx(startAt === undefined ? {} : { startAt });
  const ledger = createLedger(ctx);
  const schools = createSchools(ctx);
  const differences = createDifferences(ctx);
  const topups = createTopups(ctx, { ledger, schools, differences });
  const a = schools.createSchool({ code: 'smk-alpha', name: 'SMK Alpha (fictional)', settings });
  const b = schools.createSchool({ code: 'smk-beta', name: 'SMK Beta (fictional)' });
  const parent = schools.registerParent({ email: 'parent.one@example.com', name: 'Parent One' });
  const parent2 = schools.registerParent({ email: 'parent.two@example.com', name: 'Parent Two' });
  const t = { ctx, ledger, schools, differences, topups, a, b, parent, parent2, spent: new Map() };
  fixtures.push(t);
  const student = (school, memberNo, name, uid) => {
    const member = schools.addMember({ schoolId: school.id, memberNo, name });
    const card = uid ? schools.issueCard({ schoolId: school.id, memberId: member.id, uid, actor: 'test' }) : null;
    return { id: member.id, name: member.name, schoolId: school.id, card };
  };
  t.aina = student(a, 'A001', 'Aina Contoh', '04A1B2C3D4E5F6');
  t.badrul = student(a, 'A002', 'Badrul Contoh', '04B1B2C3D4E5F6');
  t.chandra = student(a, 'A003', 'Chandra Contoh', '04C1B2C3D4E5F6');
  t.dewi = student(a, 'A004', 'Dewi Contoh', null);
  t.eng = student(b, 'B001', 'Eng Contoh', '04E1B2C3D4E5F6');
  link(t, t.aina, parent);
  link(t, t.aina, parent2);
  link(t, t.badrul, parent);
  link(t, t.dewi, parent);
  link(t, t.eng, parent);
  return t;
}

let seq = 0;
const next = () => ++seq;
const kioskTxn = () => `KIOSK-01-${String(next()).padStart(6, '0')}`;

function order(t, { member = t.aina, parent = t.parent, amountSen = 1500, idemKey = `idem-${next()}` } = {}) {
  return t.topups.createOrder({ parentId: parent.id, schoolId: member.schoolId, memberId: member.id, amountSen, idemKey });
}

/** The payment provider's callback for `o`, signed with the lab's provider secret. */
function callback(t, o, over = {}) {
  const payload = {
    orderId: o.id,
    provider: 'mock-bank',
    providerTxnId: `MB-${o.id}`,
    result: 'SUCCESS',
    paidAmountSen: o.amountSen,
    paidAt: t.ctx.clock.now(),
    ...over,
  };
  return { ...payload, signature: signPayload(t.ctx.settings.providerSecret, payload) };
}

const pay = (t, o, over) => t.topups.paymentCallback(callback(t, o, over));
const paid = (t, opts) => pay(t, order(t, opts));
const memberOf = (t, o) => [t.aina, t.badrul, t.chandra, t.dewi, t.eng].find((m) => m.id === o.memberId);
const balances = (t, member) => t.ledger.memberBalances(member.schoolId, member.id);
const getOrder = (t, o) => t.topups.getOrder(o.schoolId, o.id);
const orderCount = (t) => t.ctx.db.get('SELECT count(*) AS n FROM topup_order').n;
const statusesOf = (t, o) => eventsOf(t.ctx, 'topup.status').filter((e) => e.data.orderId === o.id).map((e) => e.data.status);
/** idemKeys of the postings about an order (a reversal keeps the order id as its ref). */
const postingsOf = (t, o) => t.ctx.db.all('SELECT idem_key FROM posting WHERE school_id = ? AND ref = ? ORDER BY rowid', o.schoolId, o.id).map((r) => r.idem_key);

function pending(t, member, over = {}) {
  return t.topups.kioskPending({ schoolId: member.schoolId, kioskDeviceId: KIOSK.id, cardDigest: member.card.digest, ...over });
}

function confirm(t, o, over = {}) {
  return t.topups.kioskConfirm({
    schoolId: o.schoolId,
    kioskDeviceId: KIOSK.id,
    kioskDeviceCode: KIOSK.code,
    orderId: o.id,
    result: 'ADDED',
    amountSen: o.amountSen,
    cardDigest: memberOf(t, o).card.digest,
    balanceAfterOnCardSen: o.amountSen,
    kioskTxn: kioskTxn(),
    ...over,
  });
}

/** Paid, offered at the kiosk and confirmed: the money is on the card. */
function added(t, opts) {
  const o = paid(t, opts);
  pending(t, memberOf(t, o));
  assert.equal(confirm(t, o).status, 'ADDED');
  return getOrder(t, o);
}

/** Paid and offered at the kiosk, but the write was never confirmed: parked after the add window. */
function parked(t, opts) {
  const o = paid(t, opts);
  pending(t, memberOf(t, o));
  t.ctx.clock.advance(14 * DAY + 1);
  t.topups.runJobs();
  const row = getOrder(t, o);
  assert.equal(row.status, 'PARKED');
  return row;
}

/** A canteen purchase reaching the books (what settlement posts). */
function purchase(t, member, amountSen) {
  const txn = `CANTEEN-01-${String(next()).padStart(6, '0')}`;
  t.ledger.post({
    schoolId: member.schoolId,
    idemKey: `PURCHASE:CANTEEN-01:${txn}`,
    kind: 'PURCHASE',
    ref: txn,
    lines: [
      { kind: 'STUDENT_WALLET', memberId: member.id, side: 'DR', amountSen },
      { kind: 'SALES_PAYABLE', side: 'CR', amountSen },
    ],
  });
  t.spent.set(member.id, (t.spent.get(member.id) ?? 0) + amountSen);
}

describe('module', () => {
  test('ORDER_KINDS and ORDER_STATUSES follow the schema and cannot be changed', () => {
    assert.deepEqual([...ORDER_KINDS], ['TOPUP', 'SUBSIDY', 'TRANSFER']);
    assert.deepEqual([...ORDER_STATUSES], ['CREATED', 'PAID', 'ADDED', 'CANCELLED', 'FAILED', 'EXPIRED', 'REFUNDED', 'PARKED']);
    assert.ok(Object.isFrozen(ORDER_KINDS) && Object.isFrozen(ORDER_STATUSES));
  });

  test('createTopups needs the ledger, schools and differences services', () => {
    const t = setup();
    assert.throws(() => createTopups(t.ctx), TypeError);
    assert.throws(() => createTopups(t.ctx, { ledger: t.ledger, schools: t.schools }), TypeError);
  });
});

describe('parent top-up lifecycle', () => {
  test('create → pay → kioskPending → kioskConfirm moves the money onto the card', () => {
    const t = setup();
    const { ctx, topups, ledger, a, aina } = t;
    const t0 = ctx.clock.now();

    const created = order(t, { amountSen: 1500 });
    assert.deepEqual(Object.keys(created).sort(), ORDER_KEYS);
    assert.match(created.id, /^ord_/);
    const { id, ...rest } = created;
    assert.deepEqual(rest, {
      schoolId: a.id, kind: 'TOPUP', parentId: t.parent.id, memberId: aina.id, memberName: 'Aina Contoh', amountSen: 1500,
      status: 'CREATED', createdAt: t0, payBy: t0 + 30 * MINUTE, paidAt: null, addBy: null, writeAttemptAt: null, writeResult: null,
      addedAt: null, addedByDevice: null, kioskTxn: null, balanceAfterOnCardSen: null, resolvedBy: null, resolutionNote: null,
    });
    assert.deepEqual(balances(t, aina), { walletSen: 0, waitingSen: 0 });
    assert.deepEqual(postingsOf(t, created), [], 'nothing is booked before the money arrives');
    checkBooks(t);

    ctx.clock.advance(5 * MINUTE);
    const paidOrder = topups.paymentCallback(callback(t, created));
    assert.equal(paidOrder.status, 'PAID');
    assert.equal(paidOrder.paidAt, t0 + 5 * MINUTE);
    assert.equal(paidOrder.addBy, t0 + 5 * MINUTE + 14 * DAY);
    const paidPosting = ledger.findByIdemKey(a.id, `TOPUP:${id}:PAID`);
    assert.equal(paidPosting.ref, id);
    assert.deepEqual(paidPosting.lines, [
      { kind: 'CASH_RECEIVED', memberId: null, side: 'DR', amountSen: 1500 },
      { kind: 'WAITING_TO_BE_ADDED', memberId: aina.id, side: 'CR', amountSen: 1500 },
    ]);
    assert.deepEqual(balances(t, aina), { walletSen: 0, waitingSen: 1500 });
    checkBooks(t);

    ctx.clock.advance(HOUR);
    assert.deepEqual(pending(t, aina), {
      member: { id: aina.id, name: 'Aina Contoh' },
      orders: [{ orderId: id, kind: 'TOPUP', amountSen: 1500 }],
      mirrorBalanceSen: 0,
      waitingSen: 1500,
    });
    const tried = topups.getOrder(a.id, id);
    assert.equal(tried.status, 'PAID');
    assert.equal(tried.writeAttemptAt, ctx.clock.now());
    assert.equal(tried.writeResult, 'UNCONFIRMED');

    ctx.clock.advance(2000);
    assert.deepEqual(confirm(t, created, { kioskTxn: 'KIOSK-01-000001', balanceAfterOnCardSen: 1500 }), {
      orderId: id,
      status: 'ADDED',
      duplicate: false,
    });
    const done = topups.getOrder(a.id, id);
    assert.equal(done.status, 'ADDED');
    assert.equal(done.addedAt, ctx.clock.now());
    assert.equal(done.addedByDevice, 'KIOSK-01');
    assert.equal(done.kioskTxn, 'KIOSK-01-000001');
    assert.equal(done.balanceAfterOnCardSen, 1500);
    assert.equal(done.writeResult, 'ADDED');
    assert.deepEqual(ledger.findByIdemKey(a.id, `TOPUP:${id}:ADDED`).lines, [
      { kind: 'WAITING_TO_BE_ADDED', memberId: aina.id, side: 'DR', amountSen: 1500 },
      { kind: 'STUDENT_WALLET', memberId: aina.id, side: 'CR', amountSen: 1500 },
    ]);
    assert.deepEqual(balances(t, aina), { walletSen: 1500, waitingSen: 0 });
    assert.deepEqual(postingsOf(t, created), [`TOPUP:${id}:PAID`, `TOPUP:${id}:ADDED`]);

    const statusEvents = eventsOf(ctx, 'topup.status');
    assert.deepEqual(statusEvents.map((e) => e.data), [
      { orderId: id, kind: 'TOPUP', status: 'CREATED', amountSen: 1500 },
      { orderId: id, kind: 'TOPUP', status: 'PAID', amountSen: 1500 },
      { orderId: id, kind: 'TOPUP', status: 'ADDED', amountSen: 1500 },
    ]);
    assert.ok(statusEvents.every((e) => e.school === 'smk-alpha'));
    assert.deepEqual(pending(t, aina).orders, [], 'nothing left to add');
    checkBooks(t);
  });
});

describe('createOrder', () => {
  test('payBy follows the school’s payment window', () => {
    const t = setup({ settings: { topup: { payWindowMinutes: 10 } } });
    const o = order(t);
    assert.equal(o.payBy, t.ctx.clock.now() + 10 * MINUTE);
    assert.equal(order(t, { member: t.eng }).payBy, t.ctx.clock.now() + 30 * MINUTE, 'school B keeps the default');
  });

  test('the same key and request returns the first order, even after the limit is used up, it was paid or the card lost', () => {
    const t = setup();
    const first = order(t, { amountSen: 20000, idemKey: 'phone-retry' });
    const rows = orderCount(t);
    const seen = eventsOf(t.ctx, 'topup.status').length;
    t.ctx.clock.advance(MINUTE);
    assert.deepEqual(order(t, { amountSen: 20000, idemKey: 'phone-retry' }), first);
    assert.equal(orderCount(t), rows);
    assert.equal(eventsOf(t.ctx, 'topup.status').length, seen, 'a repeat changes nothing');

    order(t, { amountSen: 10000 });
    assert.throws(() => order(t, { amountSen: 500 }), code('DAILY_LIMIT'));
    assert.deepEqual(order(t, { amountSen: 20000, idemKey: 'phone-retry' }), first, 'the first order already counts; its repeat is not refused');

    pay(t, first);
    assert.equal(order(t, { amountSen: 20000, idemKey: 'phone-retry' }).status, 'PAID');
    t.schools.markCardLost({ schoolId: t.a.id, uid: t.aina.card.uid, actor: 'test' });
    assert.equal(order(t, { amountSen: 20000, idemKey: 'phone-retry' }).id, first.id);
  });

  test('the same key with a different request is IDEMPOTENCY_KEY_REUSED (409)', () => {
    const t = setup();
    const first = order(t, { amountSen: 1500, idemKey: 'k1' });
    const rows = orderCount(t);
    assert.throws(() => order(t, { amountSen: 1600, idemKey: 'k1' }), code('IDEMPOTENCY_KEY_REUSED', 409));
    assert.throws(() => order(t, { member: t.badrul, amountSen: 1500, idemKey: 'k1' }), code('IDEMPOTENCY_KEY_REUSED', 409));
    // the same parent's key in another school: refused, without telling anything about the first order
    assert.throws(() => order(t, { member: t.eng, amountSen: 1500, idemKey: 'k1' }), (err) => {
      code('IDEMPOTENCY_KEY_REUSED', 409)(err);
      assert.equal(err.detail, undefined);
      assert.ok(!err.message.includes(first.id));
      return true;
    });
    assert.equal(orderCount(t), rows);
    // keys belong to the parent: another parent may use the same one
    const theirs = order(t, { parent: t.parent2, amountSen: 1500, idemKey: 'k1' });
    assert.notEqual(theirs.id, first.id);
    assert.equal(theirs.parentId, t.parent2.id);
  });

  test('IDEMPOTENCY_KEY_REQUIRED without a usable key', () => {
    const t = setup();
    for (const idemKey of [undefined, null, '', '   ', 42, 'k'.repeat(201)]) {
      assert.throws(
        () => t.topups.createOrder({ parentId: t.parent.id, schoolId: t.a.id, memberId: t.aina.id, amountSen: 1500, idemKey }),
        code('IDEMPOTENCY_KEY_REQUIRED', 400),
        String(idemKey),
      );
    }
    assert.equal(order(t, { idemKey: 'k'.repeat(200) }).status, 'CREATED');
    assert.equal(orderCount(t), 1);
  });

  test('NOT_LINKED (403) unless the school APPROVED a link between the parent and the member', () => {
    const t = setup();
    const fresh = (no, name, uid) => {
      const m = t.schools.addMember({ schoolId: t.a.id, memberNo: no, name });
      const card = t.schools.issueCard({ schoolId: t.a.id, memberId: m.id, uid, actor: 'test' });
      return { id: m.id, name, schoolId: t.a.id, card };
    };
    const waiting = fresh('A010', 'Farah Contoh', '04F1B2C3D4E5F6');
    link(t, waiting, t.parent, null); // PENDING
    const refused = fresh('A011', 'Gopal Contoh', '04F2B2C3D4E5F6');
    link(t, refused, t.parent, false); // REJECTED
    const tries = [
      { member: t.chandra }, // never linked
      { member: waiting },
      { member: refused },
      { member: t.badrul, parent: t.parent2 }, // linked to another parent only
    ];
    for (const args of tries) assert.throws(() => order(t, args), code('NOT_LINKED', 403), args.member.name);
    const call = (over) => () => t.topups.createOrder({ parentId: t.parent.id, schoolId: t.a.id, memberId: t.aina.id, amountSen: 1500, idemKey: `idem-${next()}`, ...over });
    assert.throws(call({ schoolId: t.b.id }), code('NOT_LINKED', 403), 'the child is in school A, not B');
    assert.throws(call({ memberId: t.eng.id }), code('NOT_LINKED', 403), 'a school B child asked through school A');
    assert.throws(call({ memberId: 'mem_nope' }), code('NOT_LINKED', 403));
    assert.throws(call({ schoolId: 'sch_nope' }), code('NOT_LINKED', 403));
    assert.throws(call({ parentId: 'par_nope' }), code('NOT_LINKED', 403));
    assert.throws(call({ parentId: undefined }), code('NOT_LINKED', 403));
    assert.throws(call({ memberId: undefined }), code('NOT_LINKED', 403));
    assert.equal(orderCount(t), 0);
    assert.equal(eventsOf(t.ctx, 'topup.status').length, 0);
  });

  test('CARD_NOT_ACTIVE (409) unless the member has an ACTIVE card', () => {
    const t = setup();
    assert.throws(() => order(t, { member: t.dewi }), code('CARD_NOT_ACTIVE', 409), 'no card at all');
    t.schools.markCardLost({ schoolId: t.a.id, uid: t.aina.card.uid, actor: 'test' });
    assert.throws(() => order(t), code('CARD_NOT_ACTIVE', 409), 'the card was reported lost');
    assert.equal(orderCount(t), 0);
    t.schools.issueCard({ schoolId: t.a.id, memberId: t.aina.id, uid: '04A1B2C3D4E5F7', actor: 'test' });
    assert.equal(order(t).status, 'CREATED', 'a replacement card makes top-ups possible again');
  });

  test('AMOUNT_OUT_OF_RANGE outside the school’s min and max; AMOUNT_INVALID for anything but whole sen', () => {
    const t = setup();
    for (const amountSen of [499, 20001, 0, -500]) {
      assert.throws(() => order(t, { amountSen }), (err) => {
        code('AMOUNT_OUT_OF_RANGE', 400)(err);
        assert.deepEqual(err.detail, { minSen: 500, maxSen: 20000, amountSen });
        return true;
      });
    }
    for (const amountSen of [15.5, '1500', null, undefined, NaN, Infinity]) {
      assert.throws(
        () => t.topups.createOrder({ parentId: t.parent.id, schoolId: t.a.id, memberId: t.aina.id, amountSen, idemKey: `idem-${next()}` }),
        code('AMOUNT_INVALID', 400),
        String(amountSen),
      );
    }
    assert.equal(orderCount(t), 0);
    assert.equal(order(t, { amountSen: 500 }).amountSen, 500);
    assert.equal(order(t, { amountSen: 20000 }).amountSen, 20000);

    t.schools.updateSchoolSettings(t.a.id, { topup: { minSen: 1000, maxSen: 5000 } }, 'test');
    assert.throws(() => order(t, { member: t.badrul, amountSen: 999 }), code('AMOUNT_OUT_OF_RANGE'));
    assert.throws(() => order(t, { member: t.badrul, amountSen: 5001 }), code('AMOUNT_OUT_OF_RANGE'));
    assert.equal(order(t, { member: t.badrul, amountSen: 1000 }).status, 'CREATED');
    assert.equal(order(t, { member: t.eng, amountSen: 20000 }).status, 'CREATED', 'school B keeps its own limits');
  });

  test('DAILY_LIMIT counts every parent’s CREATED, PAID and ADDED top-ups of the member today', () => {
    const t = setup();
    order(t, { amountSen: 10000 }); // CREATED
    paid(t, { parent: t.parent2, amountSen: 10000 }); // PAID, by the other parent
    added(t, { amountSen: 5000 }); // ADDED
    assert.throws(() => order(t, { amountSen: 5001 }), (err) => {
      code('DAILY_LIMIT', 400)(err);
      assert.deepEqual(err.detail, { limitSen: 30000, usedSen: 25000, remainingSen: 5000 });
      return true;
    });
    assert.equal(order(t, { amountSen: 5000 }).status, 'CREATED', 'up to the limit exactly');
    assert.throws(() => order(t, { amountSen: 500 }), code('DAILY_LIMIT'));
    assert.throws(() => order(t, { parent: t.parent2, amountSen: 500 }), code('DAILY_LIMIT'), 'the limit is the child’s, not the parent’s');

    // other members and other schools have their own limits; a school subsidy is not a top-up
    assert.equal(order(t, { member: t.badrul, amountSen: 20000 }).status, 'CREATED');
    assert.equal(order(t, { member: t.eng, amountSen: 20000 }).status, 'CREATED');
    t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.badrul.id, amountSen: 50000, actor: 'staff:test' });
    assert.equal(order(t, { member: t.badrul, amountSen: 10000 }).status, 'CREATED');
  });

  test('failed and cancelled top-ups do not count against the daily limit', () => {
    const t = setup();
    const failed = order(t, { amountSen: 20000 });
    pay(t, failed, { result: 'FAILED' });
    order(t, { amountSen: 20000 });
    t.ctx.clock.advance(31 * MINUTE);
    assert.equal(t.topups.runJobs().cancelled, 1);
    assert.equal(klDay(t.ctx.clock.now()), '2026-10-05', 'still the same day in Kuala Lumpur');
    assert.equal(order(t, { amountSen: 20000 }).status, 'CREATED');
    assert.equal(order(t, { amountSen: 10000 }).status, 'CREATED');
    assert.throws(() => order(t, { amountSen: 500 }), code('DAILY_LIMIT'));
  });

  test('the day is the Kuala Lumpur day: it turns at 00:00 KL (16:00 UTC), not at UTC midnight', () => {
    const t = setup({ startAt: Date.parse('2026-10-05T15:30:00.000Z') }); // 23:30 KL, Monday 5 October
    paid(t, { amountSen: 20000 });
    paid(t, { amountSen: 10000 });
    t.ctx.clock.advance(30 * MINUTE - 1); // 23:59:59.999 KL
    assert.equal(klDay(t.ctx.clock.now()), '2026-10-05');
    assert.throws(() => order(t, { amountSen: 500 }), code('DAILY_LIMIT'));
    t.ctx.clock.advance(1); // 00:00 KL on Tuesday 6 October, still 5 October in UTC
    assert.equal(klDay(t.ctx.clock.now()), '2026-10-06');
    assert.equal(paid(t, { amountSen: 20000 }).status, 'PAID');
    assert.equal(paid(t, { amountSen: 10000 }).status, 'PAID');
    assert.throws(() => order(t, { amountSen: 500 }), code('DAILY_LIMIT'));
    t.ctx.clock.advance(8 * HOUR + MINUTE); // 08:01 KL: a new day in UTC, the same day in Kuala Lumpur
    assert.equal(new Date(t.ctx.clock.now()).toISOString().slice(0, 10), '2026-10-06');
    assert.throws(() => order(t, { amountSen: 500 }), code('DAILY_LIMIT'));
  });

  test('the month is the Kuala Lumpur month', () => {
    const t = setup({
      startAt: Date.parse('2026-10-29T02:00:00.000Z'), // 10:00 KL, Thursday 29 October
      settings: { topup: { monthlyMaxSen: 50000 } },
    });
    paid(t, { amountSen: 20000 });
    paid(t, { amountSen: 10000 });
    t.ctx.clock.advance(DAY); // 30 October
    paid(t, { amountSen: 20000 });
    assert.throws(() => order(t, { amountSen: 500 }), (err) => {
      code('MONTHLY_LIMIT', 400)(err);
      assert.deepEqual(err.detail, { limitSen: 50000, usedSen: 50000, remainingSen: 0 });
      return true;
    });
    t.ctx.clock.advance(DAY); // 31 October: nothing yet today, but the month is used up
    assert.throws(() => order(t, { amountSen: 500 }), code('MONTHLY_LIMIT'));
    t.ctx.clock.advance(14 * HOUR - 1); // 23:59:59.999 KL on 31 October
    assert.equal(klMonth(t.ctx.clock.now()), '2026-10');
    assert.throws(() => order(t, { amountSen: 500 }), code('MONTHLY_LIMIT'));
    t.ctx.clock.advance(1); // 00:00 KL on 1 November, still 31 October in UTC
    assert.equal(klMonth(t.ctx.clock.now()), '2026-11');
    assert.equal(new Date(t.ctx.clock.now()).toISOString().slice(0, 10), '2026-10-31');
    assert.equal(order(t, { amountSen: 20000 }).status, 'CREATED');
  });

  test('the daily limit is checked before the monthly one', () => {
    const t = setup({ settings: { topup: { monthlyMaxSen: 25000 } } });
    paid(t, { amountSen: 20000 });
    paid(t, { amountSen: 5000 });
    assert.throws(() => order(t, { amountSen: 5001 }), code('DAILY_LIMIT'), 'over both limits');
    assert.throws(() => order(t, { amountSen: 5000 }), code('MONTHLY_LIMIT'), 'over the monthly limit only');
  });

  test('PARKED top-ups count against the monthly limit; refunded ones do not', () => {
    const t = setup({ settings: { topup: { addWindowDays: 1, monthlyMaxSen: 40000 } } });
    const unconfirmed = paid(t, { amountSen: 15000 });
    pending(t, t.aina); // the kiosk tried to write it and never confirmed
    const untried = paid(t, { amountSen: 15000 });
    t.ctx.clock.advance(DAY + 1);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 1, parked: 1 });
    assert.equal(getOrder(t, unconfirmed).status, 'PARKED');
    assert.equal(getOrder(t, untried).status, 'REFUNDED');
    // this month: 15000 parked; the refunded 15000 no longer counts
    assert.equal(order(t, { amountSen: 20000 }).status, 'CREATED');
    assert.throws(() => order(t, { amountSen: 5001 }), code('MONTHLY_LIMIT'));
    assert.equal(order(t, { amountSen: 5000 }).status, 'CREATED');
  });
});

describe('paymentCallback', () => {
  test('SUCCESS opens the school’s add window from the time the parent paid', () => {
    const t = setup({ settings: { topup: { addWindowDays: 7 } } });
    const t0 = t.ctx.clock.now();
    const o = order(t, { amountSen: 2500 });
    t.ctx.clock.advance(3 * MINUTE);
    const p = pay(t, o, { paidAt: new Date(t0 + 2 * MINUTE).toISOString() });
    assert.equal(p.paidAt, t0 + 2 * MINUTE, 'paidAt may be ISO-8601');
    assert.equal(p.addBy, t0 + 2 * MINUTE + 7 * DAY);
    const posting = t.ledger.findByIdemKey(t.a.id, `TOPUP:${o.id}:PAID`);
    assert.equal(posting.kind, 'TOPUP_PAID');
    assert.equal(posting.ref, o.id);
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'PAID']);
    assert.ok(eventsOf(t.ctx, 'topup.status').every((e) => e.school === 'smk-alpha'));
  });

  test('paidAt is kept between the order’s creation and now; a missing or unreadable one is now', () => {
    const t = setup();
    const now = () => t.ctx.clock.now();
    // [paidAt sent by the provider, paidAt kept], both from the order
    const cases = [
      [() => undefined, now],
      [() => 'yesterday', now],
      [() => now() + DAY, now], // in the future: cannot be
      [(o) => o.createdAt - DAY, (o) => o.createdAt], // before the order existed: cannot be
      [(o) => o.createdAt + 30 * 1000, (o) => o.createdAt + 30 * 1000],
      [(o) => new Date(o.createdAt + 45 * 1000).toISOString(), (o) => o.createdAt + 45 * 1000],
    ];
    for (const [sent, kept] of cases) {
      const o = order(t, { amountSen: 500 });
      t.ctx.clock.advance(MINUTE);
      const p = pay(t, o, { paidAt: sent(o) });
      assert.equal(p.paidAt, kept(o), String(sent(o)));
      assert.equal(p.addBy, p.paidAt + 14 * DAY);
    }
  });

  test('FAILED closes a CREATED order and books nothing; a repeat changes nothing', () => {
    const t = setup();
    const o = order(t);
    const failed = pay(t, o, { result: 'FAILED', paidAmountSen: 0 });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.paidAt, null);
    assert.equal(failed.addBy, null);
    assert.deepEqual(postingsOf(t, o), []);
    assert.deepEqual(pay(t, o, { result: 'FAILED', paidAmountSen: 0 }), failed);
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'FAILED']);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 0 });
  });

  test('a late FAILED never undoes a payment', () => {
    const t = setup();
    const p = paid(t);
    assert.deepEqual(pay(t, p, { result: 'FAILED', providerTxnId: 'MB-other' }), p);
    assert.deepEqual(statusesOf(t, p), ['CREATED', 'PAID']);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 1500 });
  });

  test('PAYMENT_AMOUNT_MISMATCH when the provider took another amount; the order keeps waiting for its payment', () => {
    const t = setup();
    const o = order(t, { amountSen: 1500 });
    for (const paidAmountSen of [1400, 1501, '1500', undefined, null]) {
      assert.throws(() => pay(t, o, { paidAmountSen }), code('PAYMENT_AMOUNT_MISMATCH', 400), String(paidAmountSen));
    }
    assert.equal(getOrder(t, o).status, 'CREATED');
    assert.deepEqual(postingsOf(t, o), []);
    assert.equal(pay(t, o).status, 'PAID', 'the right amount is still accepted');
    assert.throws(() => pay(t, o, { paidAmountSen: 1400 }), code('PAYMENT_AMOUNT_MISMATCH'), 'also on a repeat');
  });

  test('PAYMENT_SIGNATURE_INVALID (401) for anything the provider did not sign', () => {
    const t = setup();
    const o = order(t);
    const good = callback(t, o);
    const { signature: _drop, ...unsigned } = good;
    const forged = [
      { ...good, paidAmountSen: 1 },
      { ...good, result: 'FAILED' },
      { ...good, orderId: 'ord_other' },
      { ...good, note: 'added after signing' },
      unsigned,
      { ...good, signature: 42 },
      { ...good, signature: '' },
      { ...good, signature: signPayload('cc'.repeat(32), unsigned) }, // another secret
      { ...good, paidAt: NaN }, // not JSON: cannot have been signed
      null,
      undefined,
      'orderId=ord_x',
      [good],
    ];
    for (const payload of forged) {
      assert.throws(() => t.topups.paymentCallback(payload), code('PAYMENT_SIGNATURE_INVALID', 401));
    }
    assert.equal(getOrder(t, o).status, 'CREATED');
    assert.deepEqual(postingsOf(t, o), []);
    assert.equal(t.topups.paymentCallback(good).status, 'PAID');
  });

  test('ORDER_NOT_FOUND (404) for an unknown order, and for orders that are not top-ups', () => {
    const t = setup();
    const signed = (payload) => ({ ...payload, signature: signPayload(t.ctx.settings.providerSecret, payload) });
    const base = { provider: 'mock-bank', providerTxnId: 'MB-1', result: 'SUCCESS', paidAmountSen: 1000, paidAt: t.ctx.clock.now() };
    assert.throws(() => t.topups.paymentCallback(signed({ ...base, orderId: 'ord_nope' })), code('ORDER_NOT_FOUND', 404));
    assert.throws(() => t.topups.paymentCallback(signed({ ...base, orderId: undefined })), code('ORDER_NOT_FOUND', 404));
    const subsidy = t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 1000, actor: 'staff:test' });
    assert.throws(() => t.topups.paymentCallback(signed({ ...base, orderId: subsidy.id })), code('ORDER_NOT_FOUND', 404));
  });

  test('PAYMENT_INVALID for a signed callback without a usable result or provider transaction id', () => {
    const t = setup();
    const o = order(t);
    assert.throws(() => pay(t, o, { result: 'PENDING' }), code('PAYMENT_INVALID', 400));
    assert.throws(() => pay(t, o, { providerTxnId: undefined }), code('PAYMENT_INVALID', 400));
    assert.throws(() => pay(t, o, { providerTxnId: ' ' }), code('PAYMENT_INVALID', 400));
    assert.equal(getOrder(t, o).status, 'CREATED');
  });

  test('a repeated callback (same providerTxnId) returns the order unchanged, before and after the kiosk added it', () => {
    const t = setup();
    const o = order(t);
    const cb = callback(t, o);
    const first = t.topups.paymentCallback(cb);
    t.ctx.clock.advance(MINUTE);
    assert.deepEqual(t.topups.paymentCallback(cb), first);
    assert.deepEqual(postingsOf(t, o), [`TOPUP:${o.id}:PAID`]);
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'PAID']);
    pending(t, t.aina);
    confirm(t, o);
    const again = t.topups.paymentCallback(cb);
    assert.equal(again.status, 'ADDED');
    assert.deepEqual(again, getOrder(t, o));
    assert.deepEqual(postingsOf(t, o), [`TOPUP:${o.id}:PAID`, `TOPUP:${o.id}:ADDED`]);
    assert.deepEqual(balances(t, t.aina), { walletSen: 1500, waitingSen: 0 });
  });

  test('a second payment under another providerTxnId is ORDER_ALREADY_PAID (409)', () => {
    const t = setup();
    const p = paid(t);
    assert.throws(() => pay(t, p, { providerTxnId: 'MB-second' }), code('ORDER_ALREADY_PAID', 409));
    assert.deepEqual(postingsOf(t, p), [`TOPUP:${p.id}:PAID`]);
  });

  test('CANCELLED, then a late SUCCESS: the money still lands, with the add window from paidAt', () => {
    const t = setup();
    const t0 = t.ctx.clock.now();
    const o = order(t);
    t.ctx.clock.advance(30 * MINUTE);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 }, 'not cancelled at payBy exactly');
    t.ctx.clock.advance(1);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 1, refunded: 0, parked: 0 });
    assert.equal(getOrder(t, o).status, 'CANCELLED');
    t.ctx.clock.advance(10 * MINUTE);
    const late = pay(t, o, { paidAt: t0 + 29 * MINUTE });
    assert.equal(late.status, 'PAID');
    assert.equal(late.paidAt, t0 + 29 * MINUTE);
    assert.equal(late.addBy, t0 + 29 * MINUTE + 14 * DAY);
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'CANCELLED', 'PAID']);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 1500 });
    assert.deepEqual(pending(t, t.aina).orders, [{ orderId: o.id, kind: 'TOPUP', amountSen: 1500 }]);
  });

  test('FAILED, then a late SUCCESS: the money taken is not lost', () => {
    const t = setup();
    const o = order(t);
    pay(t, o, { result: 'FAILED', paidAmountSen: 0 });
    assert.equal(pay(t, o).status, 'PAID');
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'FAILED', 'PAID']);
  });

  test('after the add window a repeated callback still changes nothing, and another payment is still ORDER_ALREADY_PAID', () => {
    const t = setup();
    const stuck = paid(t, { amountSen: 1000 });
    pending(t, t.aina); // offered, never confirmed: parked
    const untried = paid(t, { member: t.badrul, amountSen: 2000 }); // never offered: refunded
    t.ctx.clock.advance(14 * DAY + 1);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 1, parked: 1 });
    for (const [o, status] of [[stuck, 'PARKED'], [untried, 'REFUNDED']]) {
      const before = getOrder(t, o);
      assert.equal(before.status, status);
      assert.deepEqual(pay(t, o, { paidAt: o.paidAt }), before, `repeat on ${status}`);
      assert.deepEqual(pay(t, o, { result: 'FAILED' }), before, `late FAILED on ${status}`);
      assert.throws(() => pay(t, o, { providerTxnId: 'MB-second' }), code('ORDER_ALREADY_PAID', 409), status);
    }
    assert.deepEqual(postingsOf(t, untried), [`TOPUP:${untried.id}:PAID`, `TOPUP:${untried.id}:REVERSAL`], 'refunded once');
    assert.deepEqual(statusesOf(t, untried), ['CREATED', 'PAID', 'EXPIRED', 'REFUNDED']);
  });

  test('a payment reported long after the add window ended is refunded by the next job run', () => {
    const t = setup();
    const o = order(t);
    t.ctx.clock.advance(31 * MINUTE);
    t.topups.runJobs();
    t.ctx.clock.advance(20 * DAY);
    const late = pay(t, o, { paidAt: o.createdAt + 10 * MINUTE });
    assert.equal(late.status, 'PAID');
    assert.ok(late.addBy < t.ctx.clock.now());
    assert.deepEqual(pending(t, t.aina).orders, [], 'too late for the kiosk');
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 1, parked: 0 });
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 0 });
  });
});

describe('kioskPending', () => {
  test('lists the member’s PAID orders oldest first, at most `max`, and marks only those UNCONFIRMED', () => {
    const t = setup();
    const { a, aina, topups } = t;
    const o1 = paid(t, { amountSen: 1000 });
    t.ctx.clock.advance(MINUTE);
    const s1 = topups.grantSubsidy({ schoolId: a.id, memberId: aina.id, amountSen: 700, actor: 'staff:test' });
    t.ctx.clock.advance(MINUTE);
    const o3 = order(t, { amountSen: 1200 }); // created before o2, paid after it
    t.ctx.clock.advance(MINUTE);
    const o2 = paid(t, { amountSen: 900 });
    t.ctx.clock.advance(MINUTE);
    pay(t, o3);
    assert.ok(getOrder(t, o3).paidAt > getOrder(t, o2).paidAt, 'oldest means created first, not paid first');
    const done = added(t, { member: t.badrul, amountSen: 500 });
    const other = paid(t, { member: t.badrul, amountSen: 800 });
    const unpaid = order(t, { amountSen: 600 });
    t.ctx.clock.advance(MINUTE);

    const p = pending(t, aina, { max: 3 });
    assert.deepEqual(p, {
      member: { id: aina.id, name: 'Aina Contoh' },
      orders: [
        { orderId: o1.id, kind: 'TOPUP', amountSen: 1000 },
        { orderId: s1.id, kind: 'SUBSIDY', amountSen: 700 },
        { orderId: o3.id, kind: 'TOPUP', amountSen: 1200 },
      ],
      mirrorBalanceSen: 0,
      waitingSen: 3800,
    });
    for (const o of [o1, s1, o3]) {
      const row = getOrder(t, o);
      assert.equal(row.writeAttemptAt, t.ctx.clock.now());
      assert.equal(row.writeResult, 'UNCONFIRMED');
    }
    for (const o of [o2, other, unpaid]) {
      assert.equal(getOrder(t, o).writeAttemptAt, null, 'not offered, so not marked');
      assert.equal(getOrder(t, o).writeResult, null);
    }
    assert.equal(getOrder(t, done).writeResult, 'ADDED');
    assert.deepEqual(pending(t, aina).orders.map((o) => o.orderId), [o1.id, s1.id, o3.id, o2.id]);
    assert.deepEqual(pending(t, t.badrul), {
      member: { id: t.badrul.id, name: 'Badrul Contoh' },
      orders: [{ orderId: other.id, kind: 'TOPUP', amountSen: 800 }],
      mirrorBalanceSen: 500,
      waitingSen: 800,
    });
  });

  test('offers 10 orders by default and never more than 50', () => {
    const t = setup();
    for (let i = 0; i < 55; i++) t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 100, actor: 'staff:test' });
    const count = (max) => pending(t, t.aina, { max }).orders.length;
    assert.equal(pending(t, t.aina).orders.length, 10);
    assert.equal(count(1), 1);
    assert.equal(count(50), 50);
    assert.equal(count(100), 50);
    assert.equal(count('5'), 5);
    for (const unusable of [0, -1, 2.5, 'many', null]) assert.equal(count(unusable), 10, String(unusable));
    assert.equal(pending(t, t.aina).waitingSen, 5500);
  });

  test('offers an order right up to addBy, and not after', () => {
    const t = setup();
    const o = paid(t);
    t.ctx.clock.advance(14 * DAY);
    assert.deepEqual(pending(t, t.aina).orders.map((x) => x.orderId), [o.id]);
    t.ctx.clock.advance(1);
    const p = pending(t, t.aina);
    assert.deepEqual(p.orders, []);
    assert.equal(p.waitingSen, 1500, 'the money waits until the job refunds or parks it');
  });

  test('CARD_NOT_FOUND (404) for a card this school does not know; CARD_NOT_ACTIVE (409) for a LOST card', () => {
    const t = setup();
    const o = paid(t);
    for (const cardDigest of ['f'.repeat(64), undefined, 42, t.eng.card.digest]) {
      assert.throws(() => pending(t, t.aina, { cardDigest }), code('CARD_NOT_FOUND', 404), String(cardDigest));
    }
    assert.throws(() => t.topups.kioskPending({ schoolId: t.b.id, kioskDeviceId: KIOSK.id, cardDigest: t.aina.card.digest }), code('CARD_NOT_FOUND', 404));
    t.schools.markCardLost({ schoolId: t.a.id, uid: t.aina.card.uid, actor: 'test' });
    assert.throws(() => pending(t, t.aina), code('CARD_NOT_ACTIVE', 409));
    assert.equal(getOrder(t, o).writeResult, null, 'nothing was offered to the lost card');
    const replacement = t.schools.issueCard({ schoolId: t.a.id, memberId: t.aina.id, uid: '04A1B2C3D4E5F7', actor: 'test' });
    assert.deepEqual(pending(t, t.aina, { cardDigest: replacement.digest }).orders.map((x) => x.orderId), [o.id]);
  });

  test('CARD_NOT_ACTIVE (409) for a RETIRED card too, and createOrder refuses its member', () => {
    const t = setup();
    const o = paid(t);
    // no service retires cards yet; the schema allows it
    t.ctx.db.run("UPDATE card SET status = 'RETIRED' WHERE school_id = ? AND id = ?", t.a.id, t.aina.card.id);
    assert.throws(() => pending(t, t.aina), code('CARD_NOT_ACTIVE', 409));
    assert.equal(getOrder(t, o).writeResult, null);
    assert.throws(() => order(t), code('CARD_NOT_ACTIVE', 409));
  });
});

describe('kioskConfirm', () => {
  test('the same kiosk and kioskTxn again is a duplicate: nothing is booked twice', () => {
    const t = setup();
    const o = paid(t);
    pending(t, t.aina);
    const first = confirm(t, o, { kioskTxn: 'KIOSK-01-000010' });
    assert.equal(first.duplicate, false);
    const addedAt = getOrder(t, o).addedAt;
    const seen = eventsOf(t.ctx, 'topup.status').length;
    t.ctx.clock.advance(MINUTE);
    assert.deepEqual(confirm(t, o, { kioskTxn: 'KIOSK-01-000010' }), { orderId: o.id, status: 'ADDED', duplicate: true });
    assert.equal(getOrder(t, o).addedAt, addedAt);
    assert.equal(eventsOf(t.ctx, 'topup.status').length, seen);
    assert.deepEqual(postingsOf(t, o), [`TOPUP:${o.id}:PAID`, `TOPUP:${o.id}:ADDED`]);
    assert.deepEqual(balances(t, t.aina), { walletSen: 1500, waitingSen: 0 });
    assert.equal(t.differences.countOpen(t.a.id), 0);
  });

  test('ADDED again under another kioskTxn is ORDER_ALREADY_ADDED (409) and opens DOUBLE_ADD_SUSPECTED', () => {
    const t = setup();
    const o = paid(t, { amountSen: 2000 });
    pending(t, t.aina);
    confirm(t, o, { kioskTxn: 'KIOSK-01-000001', balanceAfterOnCardSen: 2000 });
    const again = () => confirm(t, o, { kioskTxn: 'KIOSK-01-000002', balanceAfterOnCardSen: 4000 });
    assert.throws(again, code('ORDER_ALREADY_ADDED', 409));
    const [diff] = t.differences.list(t.a.id, { kind: 'DOUBLE_ADD_SUSPECTED' });
    assert.ok(diff, 'the difference survives the error');
    assert.equal(diff.ref, `${o.id}:KIOSK-01:KIOSK-01-000002`);
    assert.equal(diff.status, 'OPEN');
    assert.deepEqual(diff.detail, {
      orderId: o.id, orderKind: 'TOPUP', memberId: t.aina.id, amountSen: 2000, status: 'ADDED',
      addedByDevice: 'KIOSK-01', addedKioskTxn: 'KIOSK-01-000001', reportedByDevice: 'KIOSK-01', reportedKioskTxn: 'KIOSK-01-000002',
      balanceAfterOnCardSen: 4000, cardLast4: 'E5F6',
    });
    assert.ok(eventsOf(t.ctx, 'difference.opened').some((e) => e.data.kind === 'DOUBLE_ADD_SUSPECTED' && e.school === 'smk-alpha'));
    assert.throws(again, code('ORDER_ALREADY_ADDED', 409));
    assert.equal(t.differences.list(t.a.id).length, 1, 'the same report is flagged once');
    // the same txn number from another kiosk is another write
    assert.throws(() => confirm(t, o, { kioskDeviceCode: OTHER_KIOSK.code, kioskDeviceId: OTHER_KIOSK.id, kioskTxn: 'KIOSK-01-000001' }), code('ORDER_ALREADY_ADDED'));
    assert.equal(t.differences.list(t.a.id, { kind: 'DOUBLE_ADD_SUSPECTED' }).length, 2);
    const row = getOrder(t, o);
    assert.equal(row.kioskTxn, 'KIOSK-01-000001', 'the first write stays on record');
    assert.equal(row.balanceAfterOnCardSen, 2000);
    assert.deepEqual(balances(t, t.aina), { walletSen: 2000, waitingSen: 0 }, 'booked once');
  });

  test('ADDED after the order was refunded is ORDER_ALREADY_REFUNDED (409) and opens TOPUP_ADDED_AFTER_REFUND', () => {
    const t = setup();
    const o = paid(t);
    t.ctx.clock.advance(14 * DAY + 1);
    assert.equal(t.topups.runJobs().refunded, 1);
    assert.throws(() => confirm(t, o, { kioskTxn: 'KIOSK-01-000050' }), code('ORDER_ALREADY_REFUNDED', 409));
    assert.throws(() => confirm(t, o, { kioskTxn: 'KIOSK-01-000050' }), code('ORDER_ALREADY_REFUNDED', 409), 'the kiosk reports it again');
    assert.equal(t.differences.list(t.a.id).length, 1, 'the same report is flagged once');
    const [diff] = t.differences.list(t.a.id, { kind: 'TOPUP_ADDED_AFTER_REFUND' });
    assert.equal(diff.ref, `${o.id}:KIOSK-01:KIOSK-01-000050`);
    assert.equal(diff.detail.status, 'REFUNDED');
    assert.equal(diff.detail.orderId, o.id);
    assert.equal(getOrder(t, o).status, 'REFUNDED');
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 0 }, 'nothing booked for the refunded money');
    assert.equal(t.topups.kioskLookup({ schoolId: t.a.id, kioskDeviceCode: 'KIOSK-01', kioskTxn: 'KIOSK-01-000050' }), null);
    // a FAILED report about a refunded order changes nothing and opens nothing
    assert.deepEqual(confirm(t, o, { result: 'FAILED' }), { orderId: o.id, status: 'REFUNDED', duplicate: false });
    assert.equal(t.differences.list(t.a.id).length, 1);
  });

  test('FAILED notes the failed write; the order keeps waiting and is offered again', () => {
    const t = setup();
    const o = paid(t);
    pending(t, t.aina);
    const seen = eventsOf(t.ctx, 'topup.status').length;
    assert.deepEqual(
      t.topups.kioskConfirm({ schoolId: t.a.id, kioskDeviceId: KIOSK.id, kioskDeviceCode: KIOSK.code, orderId: o.id, result: 'FAILED', amountSen: 1500, cardDigest: t.aina.card.digest }),
      { orderId: o.id, status: 'PAID', duplicate: false },
      'a failed write needs no kiosk txn or card balance',
    );
    const row = getOrder(t, o);
    assert.equal(row.status, 'PAID');
    assert.equal(row.writeResult, 'FAILED');
    assert.equal(row.kioskTxn, null);
    assert.equal(eventsOf(t.ctx, 'topup.status').length, seen, 'not a status change');
    assert.deepEqual(postingsOf(t, o), [`TOPUP:${o.id}:PAID`]);
    assert.deepEqual(pending(t, t.aina).orders.map((x) => x.orderId), [o.id]);
    assert.equal(getOrder(t, o).writeResult, 'UNCONFIRMED', 'a new attempt');
    assert.equal(confirm(t, o).status, 'ADDED');
    // FAILED after ADDED never takes it back
    assert.deepEqual(confirm(t, o, { result: 'FAILED' }), { orderId: o.id, status: 'ADDED', duplicate: false });
    assert.equal(getOrder(t, o).writeResult, 'ADDED');
  });

  test('the card must be the order member’s (ORDER_CARD_MISMATCH) and the amount the order’s (ORDER_AMOUNT_MISMATCH)', () => {
    const t = setup();
    const o = paid(t);
    pending(t, t.aina);
    for (const cardDigest of [t.badrul.card.digest, t.eng.card.digest, 'f'.repeat(64), undefined]) {
      assert.throws(() => confirm(t, o, { cardDigest }), code('ORDER_CARD_MISMATCH', 400));
      assert.throws(() => confirm(t, o, { cardDigest, result: 'FAILED' }), code('ORDER_CARD_MISMATCH', 400));
    }
    for (const amountSen of [1499, 1501, '1500', undefined]) {
      assert.throws(() => confirm(t, o, { amountSen }), code('ORDER_AMOUNT_MISMATCH', 400), String(amountSen));
    }
    const row = getOrder(t, o);
    assert.equal(row.status, 'PAID');
    assert.equal(row.writeResult, 'UNCONFIRMED');
    assert.deepEqual(postingsOf(t, o), [`TOPUP:${o.id}:PAID`]);
  });

  test('ORDER_NOT_FOUND (404) for an unknown order or another school’s order', () => {
    const t = setup();
    const theirs = paid(t, { member: t.eng });
    assert.throws(() => confirm(t, { id: 'ord_nope', schoolId: t.a.id, memberId: t.aina.id, amountSen: 1500 }), code('ORDER_NOT_FOUND', 404));
    assert.throws(() => confirm(t, theirs, { schoolId: t.a.id, cardDigest: t.aina.card.digest }), code('ORDER_NOT_FOUND', 404));
    assert.equal(getOrder(t, theirs).status, 'PAID');
  });

  test('ORDER_NOT_PAID (409): a CREATED, CANCELLED or FAILED order has no money to add', () => {
    const t = setup();
    const created = order(t);
    const failed = order(t);
    pay(t, failed, { result: 'FAILED', paidAmountSen: 0 });
    const cancelled = order(t);
    t.ctx.clock.advance(31 * MINUTE);
    t.topups.runJobs();
    assert.equal(getOrder(t, created).status, 'CANCELLED');
    for (const o of [cancelled, failed, created]) {
      assert.throws(() => confirm(t, o), code('ORDER_NOT_PAID', 409));
      assert.deepEqual(postingsOf(t, o), []);
    }
  });

  test('CONFIRM_INVALID for a confirm that cannot be recorded', () => {
    const t = setup();
    const o = paid(t);
    pending(t, t.aina);
    const bad = [
      { result: 'DONE' },
      { result: undefined },
      { kioskTxn: undefined },
      { kioskTxn: '' },
      { kioskTxn: 'K'.repeat(65) },
      { kioskDeviceCode: undefined },
      { balanceAfterOnCardSen: -1 },
      { balanceAfterOnCardSen: 1.5 },
      { balanceAfterOnCardSen: undefined },
    ];
    for (const over of bad) assert.throws(() => confirm(t, o, over), code('CONFIRM_INVALID', 400), JSON.stringify(over));
    assert.equal(getOrder(t, o).status, 'PAID');
  });

  test('a kiosk txn names one write: using it for another order is KIOSK_TXN_REUSED (409)', () => {
    const t = setup();
    const o1 = paid(t, { amountSen: 1000 });
    const o2 = paid(t, { amountSen: 2000 });
    pending(t, t.aina);
    confirm(t, o1, { kioskTxn: 'KIOSK-01-000007' });
    assert.throws(() => confirm(t, o2, { kioskTxn: 'KIOSK-01-000007' }), code('KIOSK_TXN_REUSED', 409));
    assert.equal(getOrder(t, o2).status, 'PAID');
    assert.equal(confirm(t, o2, { kioskTxn: 'KIOSK-01-000007', kioskDeviceCode: OTHER_KIOSK.code }).status, 'ADDED', 'another kiosk numbers its own writes');
    assert.equal(t.topups.kioskLookup({ schoolId: t.a.id, kioskDeviceCode: 'KIOSK-01', kioskTxn: 'KIOSK-01-000007' }).orderId, o1.id);
    assert.equal(t.topups.kioskLookup({ schoolId: t.a.id, kioskDeviceCode: 'KIOSK-02', kioskTxn: 'KIOSK-01-000007' }).orderId, o2.id);
  });

  test('a write offered before addBy and confirmed after it is still added; the job then leaves it alone', () => {
    const t = setup();
    const o = paid(t);
    t.ctx.clock.advance(14 * DAY); // addBy exactly: still offered
    assert.deepEqual(pending(t, t.aina).orders.map((x) => x.orderId), [o.id]);
    t.ctx.clock.advance(3000); // the write and its confirm take a few seconds
    assert.deepEqual(confirm(t, o), { orderId: o.id, status: 'ADDED', duplicate: false });
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 });
    assert.deepEqual(balances(t, t.aina), { walletSen: 1500, waitingSen: 0 });
  });

  test('a write made before the card was reported lost is still recorded', () => {
    const t = setup();
    const o = paid(t);
    pending(t, t.aina);
    t.schools.markCardLost({ schoolId: t.a.id, uid: t.aina.card.uid, actor: 'test' });
    assert.equal(confirm(t, o).status, 'ADDED', 'the money is on that card');
    assert.deepEqual(balances(t, t.aina), { walletSen: 1500, waitingSen: 0 });
  });
});

describe('kioskLookup', () => {
  test('finds a recorded write by kiosk and kioskTxn, and nothing else', () => {
    const t = setup();
    const o = paid(t);
    const lookup = (over = {}) => t.topups.kioskLookup({ schoolId: t.a.id, kioskDeviceCode: 'KIOSK-01', kioskTxn: 'KIOSK-01-000002', ...over });
    pending(t, t.aina);
    assert.equal(lookup(), null, 'nothing confirmed yet');
    confirm(t, o, { result: 'FAILED', kioskTxn: 'KIOSK-01-000001' });
    assert.equal(lookup({ kioskTxn: 'KIOSK-01-000001' }), null, 'a failed write adds nothing');
    confirm(t, o, { kioskTxn: 'KIOSK-01-000002' });
    assert.deepEqual(lookup(), { orderId: o.id, status: 'ADDED' });
    assert.equal(lookup({ kioskDeviceCode: 'KIOSK-02' }), null);
    assert.equal(lookup({ schoolId: t.b.id }), null);
    assert.equal(lookup({ kioskTxn: 'KIOSK-01-000099' }), null);
    assert.equal(lookup({ kioskTxn: undefined }), null);
    assert.equal(t.topups.kioskLookup(), null);
  });
});

describe('runJobs', () => {
  test('cancels CREATED orders once payBy has passed, and only then', () => {
    const t = setup();
    const early = order(t);
    t.ctx.clock.advance(10 * MINUTE);
    const later = order(t);
    t.ctx.clock.advance(20 * MINUTE); // early.payBy exactly
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 });
    t.ctx.clock.advance(1);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 1, refunded: 0, parked: 0 });
    assert.equal(getOrder(t, early).status, 'CANCELLED');
    assert.equal(getOrder(t, later).status, 'CREATED');
    assert.deepEqual(statusesOf(t, early), ['CREATED', 'CANCELLED']);
    t.ctx.clock.advance(10 * MINUTE);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 1, refunded: 0, parked: 0 });
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 });
  });

  test('refunds a PAID order nobody added by addBy: EXPIRED, then REFUNDED with the payment reversed', () => {
    const t = setup();
    const o = paid(t, { amountSen: 2500 });
    const payment = t.ledger.findByIdemKey(t.a.id, `TOPUP:${o.id}:PAID`);
    t.ctx.clock.advance(14 * DAY);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 }, 'not at addBy exactly');
    t.ctx.clock.advance(1);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 1, parked: 0 });
    assert.equal(getOrder(t, o).status, 'REFUNDED');
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'PAID', 'EXPIRED', 'REFUNDED']);
    const refunds = eventsOf(t.ctx, 'topup.refunded');
    assert.equal(refunds.length, 1);
    assert.deepEqual(refunds[0].data, { orderId: o.id, kind: 'TOPUP', amountSen: 2500, parentId: t.parent.id });
    assert.equal(refunds[0].school, 'smk-alpha');
    const reversal = t.ledger.findByIdemKey(t.a.id, `TOPUP:${o.id}:REVERSAL`);
    assert.equal(reversal.reversalOf, payment.id);
    assert.equal(reversal.memo, 'refund sent to parent (mock)');
    assert.deepEqual(reversal.lines, [
      { kind: 'CASH_RECEIVED', memberId: null, side: 'CR', amountSen: 2500 },
      { kind: 'WAITING_TO_BE_ADDED', memberId: t.aina.id, side: 'DR', amountSen: 2500 },
    ]);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 0 });
    assert.equal(t.ledger.balance(t.a.id, 'CASH_RECEIVED'), 0);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 }, 'refunded once');
    assert.equal(eventsOf(t.ctx, 'topup.refunded').length, 1);
  });

  test('refunds after a failed write, but parks a write that was never confirmed (it may be on the card)', () => {
    const t = setup();
    const failedWrite = paid(t, { amountSen: 1000 });
    const unconfirmed = paid(t, { amountSen: 2000 });
    pending(t, t.aina);
    confirm(t, failedWrite, { result: 'FAILED' });
    const untried = paid(t, { amountSen: 3000 });
    t.ctx.clock.advance(14 * DAY + 1);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 2, parked: 1 });
    assert.equal(getOrder(t, failedWrite).status, 'REFUNDED');
    assert.equal(getOrder(t, untried).status, 'REFUNDED');
    assert.equal(getOrder(t, unconfirmed).status, 'PARKED');
    assert.deepEqual(statusesOf(t, unconfirmed), ['CREATED', 'PAID', 'PARKED']);
    assert.deepEqual(eventsOf(t.ctx, 'topup.refunded').map((e) => e.data.orderId), [failedWrite.id, untried.id]);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 2000 }, 'the parked money waits for a person');
    assert.deepEqual(postingsOf(t, unconfirmed), [`TOPUP:${unconfirmed.id}:PAID`]);
    assert.deepEqual(pending(t, t.aina).orders, [], 'a parked order is not offered at the kiosk');
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 });
  });

  test('covers every school, or just the one asked for', () => {
    const t = setup();
    const mine = order(t);
    const theirs = order(t, { member: t.eng });
    t.ctx.clock.advance(31 * MINUTE);
    assert.deepEqual(t.topups.runJobs({ schoolId: t.b.id }), { cancelled: 1, refunded: 0, parked: 0 });
    assert.equal(getOrder(t, theirs).status, 'CANCELLED');
    assert.equal(getOrder(t, mine).status, 'CREATED', 'school A was not asked');
    assert.deepEqual(t.topups.runJobs(), { cancelled: 1, refunded: 0, parked: 0 });
    assert.equal(getOrder(t, mine).status, 'CANCELLED');
    const cancels = eventsOf(t.ctx, 'topup.status').filter((e) => e.data.status === 'CANCELLED');
    assert.deepEqual(cancels.map((e) => [e.data.orderId, e.school]), [[theirs.id, 'smk-beta'], [mine.id, 'smk-alpha']]);
  });

  test('a school id that is not an id runs no school at all, never every school', () => {
    const t = setup();
    const mine = order(t);
    const theirs = order(t, { member: t.eng });
    t.ctx.clock.advance(31 * MINUTE);
    for (const schoolId of ['', null, 42, 'sch_nope']) {
      assert.deepEqual(t.topups.runJobs({ schoolId }), { cancelled: 0, refunded: 0, parked: 0 }, String(schoolId));
    }
    assert.equal(getOrder(t, mine).status, 'CREATED');
    assert.equal(getOrder(t, theirs).status, 'CREATED');
    assert.deepEqual(t.topups.runJobs(null), { cancelled: 2, refunded: 0, parked: 0 }, 'no options: every school');
  });
});

describe('resolveParked', () => {
  test('ADDED: a person saw the money on the card, so it is booked onto the wallet', () => {
    const t = setup();
    const o = parked(t, { amountSen: 1800 });
    t.ctx.clock.advance(HOUR);
    const r = t.topups.resolveParked({ schoolId: t.a.id, orderId: o.id, decision: 'ADDED', actor: 'staff:stf_finance', note: '  write found on the card  ' });
    assert.equal(r.status, 'ADDED');
    assert.equal(r.resolvedBy, 'staff:stf_finance');
    assert.equal(r.resolutionNote, 'write found on the card');
    assert.equal(r.addedAt, t.ctx.clock.now());
    assert.equal(r.writeResult, 'UNCONFIRMED', 'the kiosk itself never confirmed it');
    assert.equal(r.kioskTxn, null);
    assert.deepEqual(postingsOf(t, o), [`TOPUP:${o.id}:PAID`, `TOPUP:${o.id}:ADDED`]);
    assert.deepEqual(balances(t, t.aina), { walletSen: 1800, waitingSen: 0 });
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'PAID', 'PARKED', 'ADDED']);
    const [audit] = t.schools.listAudit(t.a.id, 1);
    assert.equal(audit.action, 'topup.resolve');
    assert.equal(audit.actor, 'staff:stf_finance');
    assert.deepEqual(audit.detail, { orderId: o.id, kind: 'TOPUP', decision: 'ADDED', amountSen: 1800, note: 'write found on the card' });

    // the kiosk's own late report of that write is taken as a repeat, and its details kept
    assert.deepEqual(confirm(t, o, { kioskTxn: 'KIOSK-01-000777', balanceAfterOnCardSen: 1800 }), { orderId: o.id, status: 'ADDED', duplicate: true });
    const row = getOrder(t, o);
    assert.equal(row.kioskTxn, 'KIOSK-01-000777');
    assert.equal(row.addedByDevice, 'KIOSK-01');
    assert.equal(row.writeResult, 'ADDED');
    assert.equal(row.balanceAfterOnCardSen, 1800);
    assert.equal(row.resolvedBy, 'staff:stf_finance');
    assert.equal(t.differences.countOpen(t.a.id), 0);
    assert.deepEqual(confirm(t, o, { kioskTxn: 'KIOSK-01-000777' }).duplicate, true);
    assert.throws(() => confirm(t, o, { kioskTxn: 'KIOSK-01-000778' }), code('ORDER_ALREADY_ADDED', 409), 'a second write is still suspicious');
    assert.equal(t.differences.list(t.a.id, { kind: 'DOUBLE_ADD_SUSPECTED' }).length, 1);
    assert.deepEqual(balances(t, t.aina), { walletSen: 1800, waitingSen: 0 });
  });

  test('REFUND: the payment is reversed and the parent refunded', () => {
    const t = setup();
    const o = parked(t, { amountSen: 1800 });
    const r = t.topups.resolveParked({ schoolId: t.a.id, orderId: o.id, decision: 'REFUND', actor: 'staff:stf_finance', note: 'card shows no write' });
    assert.equal(r.status, 'REFUNDED');
    assert.equal(r.resolvedBy, 'staff:stf_finance');
    assert.equal(r.resolutionNote, 'card shows no write');
    assert.deepEqual(statusesOf(t, o), ['CREATED', 'PAID', 'PARKED', 'REFUNDED']);
    assert.deepEqual(postingsOf(t, o), [`TOPUP:${o.id}:PAID`, `TOPUP:${o.id}:REVERSAL`]);
    assert.deepEqual(eventsOf(t.ctx, 'topup.refunded').map((e) => e.data), [{ orderId: o.id, kind: 'TOPUP', amountSen: 1800, parentId: t.parent.id }]);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 0 });
    assert.equal(t.schools.listAudit(t.a.id, 1)[0].detail.decision, 'REFUND');
    // if the kiosk then reports the write after all, a person must look again
    assert.throws(() => confirm(t, o), code('ORDER_ALREADY_REFUNDED', 409));
    assert.equal(t.differences.list(t.a.id, { kind: 'TOPUP_ADDED_AFTER_REFUND' }).length, 1);
  });

  test('the kiosk can still settle a PARKED order itself before a person decides', () => {
    const t = setup();
    const o = parked(t);
    assert.deepEqual(confirm(t, o, { result: 'FAILED' }), { orderId: o.id, status: 'PARKED', duplicate: false });
    assert.equal(getOrder(t, o).writeResult, 'FAILED');
    assert.deepEqual(confirm(t, o), { orderId: o.id, status: 'ADDED', duplicate: false });
    assert.deepEqual(balances(t, t.aina), { walletSen: 1500, waitingSen: 0 });
    assert.throws(
      () => t.topups.resolveParked({ schoolId: t.a.id, orderId: o.id, decision: 'REFUND', actor: 'staff:x' }),
      code('ORDER_NOT_PARKED', 409),
    );
  });

  test('ORDER_NOT_PARKED (409), ORDER_NOT_FOUND (404) and DECISION_INVALID', () => {
    const t = setup();
    const p = parked(t);
    const resolve = (over) => () => t.topups.resolveParked({ schoolId: t.a.id, orderId: p.id, decision: 'ADDED', actor: 'staff:x', ...over });
    for (const decision of ['MAYBE', undefined, 'added']) assert.throws(resolve({ decision }), code('DECISION_INVALID', 400));
    assert.throws(resolve({ orderId: 'ord_nope' }), code('ORDER_NOT_FOUND', 404));
    assert.throws(resolve({ schoolId: t.b.id }), code('ORDER_NOT_FOUND', 404), 'another school cannot decide it');
    assert.equal(getOrder(t, p).status, 'PARKED');
    const created = order(t);
    const paidOne = paid(t);
    const addedOne = added(t, { member: t.badrul });
    for (const o of [created, paidOne, addedOne]) assert.throws(resolve({ orderId: o.id }), code('ORDER_NOT_PARKED', 409));
    assert.equal(resolve()().status, 'ADDED');
    assert.throws(resolve({ decision: 'REFUND' }), code('ORDER_NOT_PARKED', 409), 'decided once');
  });
});

describe('grantSubsidy', () => {
  test('a SUBSIDY order is PAID at once and waits at the kiosk until addBy', () => {
    const t = setup();
    const now = t.ctx.clock.now();
    const s = t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 1000, actor: 'staff:stf_finance', note: 'Fictional meal fund' });
    assert.deepEqual(Object.keys(s).sort(), ORDER_KEYS);
    assert.equal(s.kind, 'SUBSIDY');
    assert.equal(s.status, 'PAID');
    assert.equal(s.parentId, null);
    assert.equal(s.memberName, 'Aina Contoh');
    assert.equal(s.payBy, null);
    assert.equal(s.paidAt, now);
    assert.equal(s.addBy, now + 14 * DAY);
    const posting = t.ledger.findByIdemKey(t.a.id, `SUBSIDY:${s.id}:GRANTED`);
    assert.equal(posting.kind, 'SUBSIDY_GRANTED');
    assert.equal(posting.memo, 'Fictional meal fund');
    assert.deepEqual(posting.lines, [
      { kind: 'SCHOOL_SUBSIDY', memberId: null, side: 'DR', amountSen: 1000 },
      { kind: 'WAITING_TO_BE_ADDED', memberId: t.aina.id, side: 'CR', amountSen: 1000 },
    ]);
    assert.equal(t.ledger.balance(t.a.id, 'SCHOOL_SUBSIDY'), 1000);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 1000 });
    assert.deepEqual(statusesOf(t, s), ['PAID']);
    const [audit] = t.schools.listAudit(t.a.id, 1);
    assert.equal(audit.action, 'subsidy.grant');
    assert.deepEqual(audit.detail, { orderId: s.id, memberId: t.aina.id, amountSen: 1000, note: 'Fictional meal fund' });
  });

  test('is added at the kiosk like a top-up', () => {
    const t = setup();
    const s = t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 1000, actor: 'staff:x' });
    assert.deepEqual(pending(t, t.aina).orders, [{ orderId: s.id, kind: 'SUBSIDY', amountSen: 1000 }]);
    assert.equal(confirm(t, s).status, 'ADDED');
    assert.deepEqual(t.ledger.findByIdemKey(t.a.id, `SUBSIDY:${s.id}:ADDED`).lines, [
      { kind: 'WAITING_TO_BE_ADDED', memberId: t.aina.id, side: 'DR', amountSen: 1000 },
      { kind: 'STUDENT_WALLET', memberId: t.aina.id, side: 'CR', amountSen: 1000 },
    ]);
    assert.deepEqual(balances(t, t.aina), { walletSen: 1000, waitingSen: 0 });
    assert.equal(t.ledger.balance(t.a.id, 'SCHOOL_SUBSIDY'), 1000, 'the school’s expense stays');
  });

  test('a subsidy not added within the school’s add window goes back to SCHOOL_SUBSIDY', () => {
    const t = setup({ settings: { topup: { addWindowDays: 7 } } });
    const s = t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 1000, actor: 'staff:x' });
    assert.equal(s.addBy, s.paidAt + 7 * DAY);
    t.ctx.clock.advance(7 * DAY + 1);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 1, parked: 0 });
    assert.equal(getOrder(t, s).status, 'REFUNDED');
    const reversal = t.ledger.findByIdemKey(t.a.id, `SUBSIDY:${s.id}:REVERSAL`);
    assert.equal(reversal.reversalOf, t.ledger.findByIdemKey(t.a.id, `SUBSIDY:${s.id}:GRANTED`).id);
    assert.deepEqual(reversal.lines, [
      { kind: 'SCHOOL_SUBSIDY', memberId: null, side: 'CR', amountSen: 1000 },
      { kind: 'WAITING_TO_BE_ADDED', memberId: t.aina.id, side: 'DR', amountSen: 1000 },
    ]);
    assert.equal(t.ledger.balance(t.a.id, 'SCHOOL_SUBSIDY'), 0);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 0 });
    assert.deepEqual(eventsOf(t.ctx, 'topup.refunded').map((e) => e.data), [{ orderId: s.id, kind: 'SUBSIDY', amountSen: 1000, parentId: null }]);
  });

  test('MEMBER_NOT_FOUND (404) outside the school; AMOUNT_INVALID unless whole positive sen', () => {
    const t = setup();
    const grant = (over) => () => t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 1000, actor: 'staff:x', ...over });
    assert.throws(grant({ memberId: 'mem_nope' }), code('MEMBER_NOT_FOUND', 404));
    assert.throws(grant({ memberId: t.eng.id }), code('MEMBER_NOT_FOUND', 404), 'a school B member');
    assert.throws(grant({ schoolId: 'sch_nope' }), code('MEMBER_NOT_FOUND', 404));
    for (const amountSen of [0, -1, 1.5, '1000', null, 1_000_000_001]) {
      assert.throws(grant({ amountSen }), code('AMOUNT_INVALID', 400), String(amountSen));
    }
    assert.equal(orderCount(t), 0);
    assert.equal(t.ledger.trialBalance(t.a.id).accounts.length, 0, 'no posting, not even an empty account');
  });
});

describe('createTransfer', () => {
  test('moves the whole mirror wallet into a TRANSFER for the replacement card; it never expires', () => {
    const t = setup();
    const { a, aina } = t;
    added(t, { amountSen: 2500 });
    purchase(t, aina, 300);
    assert.deepEqual(balances(t, aina), { walletSen: 2200, waitingSen: 0 });
    t.schools.markCardLost({ schoolId: a.id, uid: aina.card.uid, actor: 'test' });
    const newCard = t.schools.issueCard({ schoolId: a.id, memberId: aina.id, uid: '04A1B2C3D4E5F7', actor: 'test' });
    t.ctx.clock.advance(MINUTE);

    const tr = t.topups.createTransfer({ schoolId: a.id, memberId: aina.id, actor: 'staff:stf_office' });
    assert.deepEqual(Object.keys(tr).sort(), ORDER_KEYS);
    assert.equal(tr.kind, 'TRANSFER');
    assert.equal(tr.status, 'PAID');
    assert.equal(tr.amountSen, 2200);
    assert.equal(tr.parentId, null);
    assert.equal(tr.paidAt, t.ctx.clock.now());
    assert.equal(tr.addBy, null);
    const posting = t.ledger.findByIdemKey(a.id, `TRANSFER:${tr.id}:CREATED`);
    assert.equal(posting.kind, 'TRANSFER_CREATED');
    assert.deepEqual(posting.lines, [
      { kind: 'STUDENT_WALLET', memberId: aina.id, side: 'DR', amountSen: 2200 },
      { kind: 'WAITING_TO_BE_ADDED', memberId: aina.id, side: 'CR', amountSen: 2200 },
    ]);
    assert.deepEqual(balances(t, aina), { walletSen: 0, waitingSen: 2200 });
    assert.deepEqual(statusesOf(t, tr), ['PAID']);
    const [audit] = t.schools.listAudit(a.id, 1);
    assert.equal(audit.action, 'transfer.create');
    assert.deepEqual(audit.detail, { orderId: tr.id, memberId: aina.id, amountSen: 2200 });

    t.ctx.clock.advance(400 * DAY);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 });
    const p = t.topups.kioskPending({ schoolId: a.id, kioskDeviceId: KIOSK.id, cardDigest: newCard.digest });
    assert.deepEqual(p.orders, [{ orderId: tr.id, kind: 'TRANSFER', amountSen: 2200 }]);
    assert.equal(p.mirrorBalanceSen, 0);
    assert.equal(p.waitingSen, 2200);
    t.ctx.clock.advance(400 * DAY);
    assert.deepEqual(t.topups.runJobs(), { cancelled: 0, refunded: 0, parked: 0 }, 'not parked either, though the write is unconfirmed');
    assert.equal(getOrder(t, tr).status, 'PAID');

    assert.equal(confirm(t, tr, { cardDigest: newCard.digest }).status, 'ADDED');
    assert.deepEqual(postingsOf(t, tr), [`TRANSFER:${tr.id}:CREATED`, `TRANSFER:${tr.id}:ADDED`]);
    assert.deepEqual(balances(t, aina), { walletSen: 2200, waitingSen: 0 });
  });

  test('returns null when there is nothing to move', () => {
    const t = setup();
    assert.equal(t.topups.createTransfer({ schoolId: t.a.id, memberId: t.badrul.id, actor: 'staff:x' }), null, 'never had money');
    added(t, { amountSen: 1000 });
    purchase(t, t.aina, 1000);
    assert.equal(t.topups.createTransfer({ schoolId: t.a.id, memberId: t.aina.id, actor: 'staff:x' }), null, 'spent it all');
    purchase(t, t.aina, 200); // an offline purchase took the mirror below zero
    assert.equal(balances(t, t.aina).walletSen, -200);
    assert.equal(t.topups.createTransfer({ schoolId: t.a.id, memberId: t.aina.id, actor: 'staff:x' }), null);
    assert.equal(t.topups.listOrders({ schoolId: t.a.id, kind: 'TRANSFER' }).length, 0);
  });

  test('MEMBER_NOT_FOUND (404) outside the school', () => {
    const t = setup();
    added(t, { member: t.eng });
    assert.throws(() => t.topups.createTransfer({ schoolId: t.a.id, memberId: t.eng.id, actor: 'staff:x' }), code('MEMBER_NOT_FOUND', 404));
    assert.throws(() => t.topups.createTransfer({ schoolId: t.a.id, memberId: undefined, actor: 'staff:x' }), code('MEMBER_NOT_FOUND', 404));
    assert.deepEqual(balances(t, t.eng), { walletSen: 1500, waitingSen: 0 });
  });
});

describe('queries', () => {
  test('getOrder finds an order inside its own school only', () => {
    const t = setup();
    const o = order(t);
    assert.deepEqual(t.topups.getOrder(t.a.id, o.id), o);
    assert.equal(t.topups.getOrder(t.b.id, o.id), null);
    assert.equal(t.topups.getOrder(t.a.id, 'ord_nope'), null);
    assert.equal(t.topups.getOrder(undefined, o.id), null);
    assert.equal(t.topups.getOrder(t.a.id, undefined), null);
  });

  test('listOrders: newest first, by school or parent, filtered by member, status and kind', () => {
    const t = setup();
    const o1 = order(t);
    t.ctx.clock.advance(1);
    const o2 = paid(t, { member: t.badrul });
    t.ctx.clock.advance(1);
    const s = t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 1000, actor: 'staff:x' });
    t.ctx.clock.advance(1);
    const ob = paid(t, { member: t.eng });
    t.ctx.clock.advance(1);
    const o3 = order(t, { parent: t.parent2 });
    const ids = (filter) => t.topups.listOrders(filter).map((o) => o.id);
    assert.deepEqual(ids({ schoolId: t.a.id }), [o3.id, s.id, o2.id, o1.id]);
    assert.deepEqual(ids({ schoolId: t.b.id }), [ob.id]);
    assert.deepEqual(ids({ parentId: t.parent.id }), [ob.id, o2.id, o1.id], 'a parent’s own orders, across schools');
    assert.deepEqual(ids({ parentId: t.parent.id, schoolId: t.a.id }), [o2.id, o1.id]);
    assert.deepEqual(ids({ schoolId: t.a.id, memberId: t.aina.id }), [o3.id, s.id, o1.id]);
    assert.deepEqual(ids({ schoolId: t.a.id, status: 'PAID' }), [s.id, o2.id]);
    assert.deepEqual(ids({ schoolId: t.a.id, kind: 'SUBSIDY' }), [s.id]);
    assert.deepEqual(ids({ schoolId: t.a.id, limit: 2 }), [o3.id, s.id]);
    assert.deepEqual(ids({ schoolId: t.a.id, limit: '2' }), [o3.id, s.id], 'query-string text');
    assert.equal(ids({ schoolId: t.a.id, limit: 0 }).length, 4, 'an unusable limit falls back to 100');
    assert.deepEqual(t.topups.listOrders({ schoolId: t.a.id, memberId: t.badrul.id })[0], getOrder(t, o2));
  });

  test('listOrders needs a school or a parent, so it never lists every school’s orders', () => {
    const t = setup();
    order(t);
    order(t, { member: t.eng });
    assert.deepEqual(t.topups.listOrders(), []);
    assert.deepEqual(t.topups.listOrders({}), []);
    assert.deepEqual(t.topups.listOrders(null), []);
    assert.deepEqual(t.topups.listOrders({ memberId: t.aina.id }), []);
    assert.deepEqual(t.topups.listOrders({ status: 'CREATED', schoolId: '' }), []);
  });

  test('memberSummary keeps the wallet and the waiting money apart and lists the orders waiting', () => {
    const t = setup();
    added(t, { amountSen: 2000 });
    const stuck = parked(t, { amountSen: 1000 });
    t.ctx.clock.advance(MINUTE);
    const w = paid(t, { amountSen: 700 });
    t.ctx.clock.advance(MINUTE);
    const s = t.topups.grantSubsidy({ schoolId: t.a.id, memberId: t.aina.id, amountSen: 300, actor: 'staff:x' });
    order(t, { amountSen: 500 }); // not paid: not waiting
    const summary = t.topups.memberSummary(t.a.id, t.aina.id);
    assert.equal(summary.mirrorBalanceSen, 2000);
    assert.equal(summary.waitingSen, 2000);
    assert.deepEqual(summary.waitingOrders.map((o) => [o.id, o.status]), [[stuck.id, 'PARKED'], [w.id, 'PAID'], [s.id, 'PAID']]);
    assert.deepEqual(summary.waitingOrders[1], getOrder(t, w));
    assert.deepEqual(t.topups.memberSummary(t.a.id, t.badrul.id), { mirrorBalanceSen: 0, waitingSen: 0, waitingOrders: [] });
    assert.throws(() => t.topups.memberSummary(t.b.id, t.aina.id), code('MEMBER_NOT_FOUND', 404));
    assert.throws(() => t.topups.memberSummary(t.a.id, 'mem_nope'), code('MEMBER_NOT_FOUND', 404));
  });
});

describe('atomicity', () => {
  /**
   * Takes a posting key the module is about to use with an unrelated posting (reversed at once,
   * so every balance stays as it was), so the module's own posting under that key fails.
   */
  function occupy(t, schoolId, idemKey) {
    const { posting } = t.ledger.post({
      schoolId,
      idemKey,
      kind: 'TEST',
      lines: [
        { kind: 'CASH_RECEIVED', side: 'DR', amountSen: 1 },
        { kind: 'SALES_PAYABLE', side: 'CR', amountSen: 1 },
      ],
    });
    t.ledger.reverse({ schoolId, postingId: posting.id, idemKey: `${idemKey}:UNDO` });
  }

  test('a payment whose posting fails leaves the order CREATED and announces nothing', () => {
    const t = setup();
    const o = order(t);
    occupy(t, t.a.id, `TOPUP:${o.id}:PAID`);
    const seen = t.ctx.events.lastSeq();
    assert.throws(() => pay(t, o), code('IDEMPOTENCY_CONFLICT', 409));
    const row = getOrder(t, o);
    assert.equal(row.status, 'CREATED');
    assert.equal(row.paidAt, null);
    assert.equal(row.addBy, null);
    assert.deepEqual(t.ctx.events.since(seen), [], 'no topup.status, no ledger.posting');
  });

  test('a kiosk confirm whose posting fails records nothing: the order is still PAID and its write unconfirmed', () => {
    const t = setup();
    const o = paid(t);
    pending(t, t.aina);
    occupy(t, t.a.id, `TOPUP:${o.id}:ADDED`);
    const seen = t.ctx.events.lastSeq();
    assert.throws(() => confirm(t, o, { kioskTxn: 'KIOSK-01-000300' }), code('IDEMPOTENCY_CONFLICT', 409));
    const row = getOrder(t, o);
    assert.equal(row.status, 'PAID');
    assert.equal(row.writeResult, 'UNCONFIRMED');
    assert.equal(row.kioskTxn, null);
    assert.equal(t.topups.kioskLookup({ schoolId: t.a.id, kioskDeviceCode: 'KIOSK-01', kioskTxn: 'KIOSK-01-000300' }), null, 'so the kiosk sends it again');
    assert.deepEqual(t.ctx.events.since(seen), []);
    assert.deepEqual(balances(t, t.aina), { walletSen: 0, waitingSen: 1500 });
  });

  test('a refund or a person’s decision whose posting fails changes nothing', () => {
    const t = setup();
    const expiring = paid(t, { member: t.badrul });
    const stuck = parked(t);
    t.ctx.clock.advance(HOUR);
    const resolve = () => t.topups.resolveParked({ schoolId: t.a.id, orderId: stuck.id, decision: 'ADDED', actor: 'staff:x', note: 'seen on the card' });
    occupy(t, t.a.id, `TOPUP:${stuck.id}:ADDED`);
    const audits = t.schools.listAudit(t.a.id).length;
    const seen = t.ctx.events.lastSeq();
    assert.throws(resolve, code('IDEMPOTENCY_CONFLICT', 409));
    const row = getOrder(t, stuck);
    assert.equal(row.status, 'PARKED');
    assert.equal(row.resolvedBy, null);
    assert.equal(row.addedAt, null);
    assert.equal(t.schools.listAudit(t.a.id).length, audits, 'no audit entry for a decision that did not happen');
    assert.deepEqual(t.ctx.events.since(seen), []);

    // the job refunds orders one by one: the one that fails is left exactly as it was
    assert.equal(getOrder(t, expiring).status, 'REFUNDED', 'the parked() helper already ran the job');
    const late = paid(t, { member: t.badrul, amountSen: 1000 });
    occupy(t, t.a.id, `TOPUP:${late.id}:REVERSAL`);
    t.ctx.clock.advance(14 * DAY + 1);
    assert.throws(() => t.topups.runJobs(), code('IDEMPOTENCY_CONFLICT', 409));
    assert.equal(getOrder(t, late).status, 'PAID', 'not left EXPIRED');
    assert.deepEqual(statusesOf(t, late), ['CREATED', 'PAID']);
    assert.deepEqual(balances(t, t.badrul), { walletSen: 0, waitingSen: 1000 });
  });

  test('a caller’s transaction that rolls back takes the order and its events with it', () => {
    const t = setup();
    const seen = t.ctx.events.lastSeq();
    assert.throws(() => t.ctx.db.tx(() => {
      paid(t);
      throw new Error('the caller gave up');
    }), /the caller gave up/);
    assert.equal(orderCount(t), 0);
    assert.deepEqual(t.ctx.events.since(seen), [], 'nothing is announced for rows that were never written');
    t.ctx.db.tx(() => {
      paid(t);
      assert.equal(eventsOf(t.ctx, 'topup.status').length, 0, 'held back until the caller commits');
    });
    assert.deepEqual(eventsOf(t.ctx, 'topup.status').map((e) => e.data.status), ['CREATED', 'PAID']);
  });
});

describe('tenant isolation', () => {
  test('one school can never see or change another school’s orders', () => {
    const t = setup();
    const { a, b, aina, eng, topups } = t;
    const ours = paid(t, { member: aina });
    const theirs = paid(t, { member: eng });
    pending(t, eng);
    confirm(t, theirs, { kioskTxn: 'KIOSK-01-000100' });

    assert.equal(topups.getOrder(b.id, ours.id), null);
    assert.equal(topups.getOrder(a.id, theirs.id), null);
    assert.deepEqual(topups.listOrders({ schoolId: b.id }).map((o) => o.id), [theirs.id]);
    assert.ok(topups.listOrders({ schoolId: a.id }).every((o) => o.schoolId === a.id));
    assert.throws(() => topups.kioskPending({ schoolId: b.id, kioskDeviceId: KIOSK.id, cardDigest: aina.card.digest }), code('CARD_NOT_FOUND', 404));
    assert.throws(() => confirm(t, ours, { schoolId: b.id }), code('ORDER_NOT_FOUND', 404));
    assert.throws(() => confirm(t, theirs, { schoolId: b.id, cardDigest: aina.card.digest }), code('ORDER_CARD_MISMATCH'));
    assert.equal(topups.kioskLookup({ schoolId: a.id, kioskDeviceCode: 'KIOSK-01', kioskTxn: 'KIOSK-01-000100' }), null);
    assert.deepEqual(topups.kioskLookup({ schoolId: b.id, kioskDeviceCode: 'KIOSK-01', kioskTxn: 'KIOSK-01-000100' }), { orderId: theirs.id, status: 'ADDED' });
    assert.throws(() => topups.resolveParked({ schoolId: b.id, orderId: ours.id, decision: 'REFUND', actor: 'staff:x' }), code('ORDER_NOT_FOUND', 404));
    assert.throws(() => topups.memberSummary(b.id, aina.id), code('MEMBER_NOT_FOUND', 404));
    assert.throws(() => topups.grantSubsidy({ schoolId: b.id, memberId: aina.id, amountSen: 100, actor: 'staff:x' }), code('MEMBER_NOT_FOUND', 404));
    assert.throws(() => topups.createTransfer({ schoolId: a.id, memberId: eng.id, actor: 'staff:x' }), code('MEMBER_NOT_FOUND', 404));
    assert.throws(
      () => topups.createOrder({ parentId: t.parent.id, schoolId: b.id, memberId: aina.id, amountSen: 1500, idemKey: 'cross' }),
      code('NOT_LINKED', 403),
    );

    t.ctx.clock.advance(14 * DAY + 1);
    assert.deepEqual(topups.runJobs({ schoolId: b.id }), { cancelled: 0, refunded: 0, parked: 0 });
    assert.equal(getOrder(t, ours).status, 'PAID', 'school B’s jobs leave school A alone');
    assert.deepEqual(topups.runJobs({ schoolId: a.id }), { cancelled: 0, refunded: 1, parked: 0 });

    // each school's books hold only its own members and its own events
    const members = (schoolId) => t.ledger.trialBalance(schoolId).accounts.map((x) => x.memberId).filter(Boolean);
    assert.deepEqual([...new Set(members(a.id))], [aina.id]);
    assert.deepEqual([...new Set(members(b.id))], [eng.id]);
    for (const e of eventsOf(t.ctx, 'topup.status')) {
      assert.equal(e.school, e.data.orderId === theirs.id ? 'smk-beta' : 'smk-alpha');
    }
    assert.equal(eventsOf(t.ctx, 'topup.refunded')[0].school, 'smk-alpha');
  });
});
