import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { ACCOUNT_KINDS, createLedger } from '../../src/platform/ledger.js';
import { MINUTE } from '../../src/shared/time.js';

// Schools and members are inserted straight into the tables so these tests depend
// only on the schema, not on the schools service.
function seed(ctx) {
  const now = ctx.clock.now();
  const school = (id, code, name) =>
    ctx.db.run('INSERT INTO school (id, code, name, card_key, created_at) VALUES (?, ?, ?, ?, ?)', id, code, name, 'cc'.repeat(32), now);
  const member = (id, schoolId, no, name) =>
    ctx.db.run('INSERT INTO member (id, school_id, member_no, name, created_at) VALUES (?, ?, ?, ?, ?)', id, schoolId, no, name, now);
  school('sch_a', 'smk-contoh', 'SMK Seri Contoh');
  school('sch_b', 'sjkc-contoh', 'SJK(C) Contoh');
  member('mem_a1', 'sch_a', 'A001', 'Aina Contoh');
  member('mem_a2', 'sch_a', 'A002', 'Badrul Contoh');
  member('mem_b1', 'sch_b', 'B001', 'Chong Contoh');
}

const A = 'sch_a';
const B = 'sch_b';

/** Parent payment confirmed: DR CASH_RECEIVED / CR WAITING_TO_BE_ADDED(member). */
const paidLines = (memberId, amountSen) => [
  { kind: 'CASH_RECEIVED', side: 'DR', amountSen },
  { kind: 'WAITING_TO_BE_ADDED', memberId, side: 'CR', amountSen },
];
/** Kiosk added money: DR WAITING_TO_BE_ADDED(member) / CR STUDENT_WALLET(member). */
const addedLines = (memberId, amountSen) => [
  { kind: 'WAITING_TO_BE_ADDED', memberId, side: 'DR', amountSen },
  { kind: 'STUDENT_WALLET', memberId, side: 'CR', amountSen },
];
/** Purchase: DR STUDENT_WALLET(member) / CR SALES_PAYABLE. */
const purchaseLines = (memberId, amountSen) => [
  { kind: 'STUDENT_WALLET', memberId, side: 'DR', amountSen },
  { kind: 'SALES_PAYABLE', side: 'CR', amountSen },
];

const count = (ctx, table) => ctx.db.get(`SELECT count(*) AS n FROM ${table}`).n;

function rejects(fn, code, status) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'LabError', `expected a LabError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

let ctx;
let ledger;
beforeEach(() => {
  ctx = createTestCtx();
  seed(ctx);
  ledger = createLedger(ctx);
});

describe('ACCOUNT_KINDS', () => {
  test('matches the accounts table in DESIGN.md §2', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(ACCOUNT_KINDS)), {
      CASH_RECEIVED: { normal: 'DR', perMember: false },
      STUDENT_WALLET: { normal: 'CR', perMember: true },
      WAITING_TO_BE_ADDED: { normal: 'CR', perMember: true },
      SCHOOL_SUBSIDY: { normal: 'DR', perMember: false },
      SALES_PAYABLE: { normal: 'CR', perMember: false },
    });
  });

  test('cannot be changed at run time', () => {
    assert.ok(Object.isFrozen(ACCOUNT_KINDS));
    assert.ok(Object.isFrozen(ACCOUNT_KINDS.CASH_RECEIVED));
  });
});

describe('account()', () => {
  test('is created on first use and reused afterwards', () => {
    const first = ledger.account(A, 'CASH_RECEIVED');
    assert.match(first.id, /^acc_/);
    assert.equal(first.schoolId, A);
    assert.equal(first.kind, 'CASH_RECEIVED');
    assert.equal(first.memberId, null);
    assert.equal(first.createdAt, ctx.clock.now());
    ctx.clock.advance(MINUTE);
    assert.deepEqual(ledger.account(A, 'CASH_RECEIVED', null), first);
    assert.deepEqual(ledger.account(A, 'CASH_RECEIVED', undefined), first);
    assert.equal(count(ctx, 'account'), 1);
  });

  test('per-member kinds keep one account per member', () => {
    const w1 = ledger.account(A, 'STUDENT_WALLET', 'mem_a1');
    const w2 = ledger.account(A, 'STUDENT_WALLET', 'mem_a2');
    const q1 = ledger.account(A, 'WAITING_TO_BE_ADDED', 'mem_a1');
    assert.equal(w1.memberId, 'mem_a1');
    assert.notEqual(w1.id, w2.id);
    assert.notEqual(w1.id, q1.id);
    assert.equal(ledger.account(A, 'STUDENT_WALLET', 'mem_a1').id, w1.id);
  });

  test('each school has its own school-level accounts', () => {
    assert.notEqual(ledger.account(A, 'SALES_PAYABLE').id, ledger.account(B, 'SALES_PAYABLE').id);
  });

  test('per-member kinds require a memberId (ACCOUNT_INVALID)', () => {
    rejects(() => ledger.account(A, 'STUDENT_WALLET'), 'ACCOUNT_INVALID', 400);
    rejects(() => ledger.account(A, 'WAITING_TO_BE_ADDED', null), 'ACCOUNT_INVALID');
    rejects(() => ledger.account(A, 'WAITING_TO_BE_ADDED', ''), 'ACCOUNT_INVALID');
    rejects(() => ledger.account(A, 'STUDENT_WALLET', 42), 'ACCOUNT_INVALID');
  });

  test('school-level kinds forbid a memberId (ACCOUNT_INVALID)', () => {
    for (const kind of ['CASH_RECEIVED', 'SCHOOL_SUBSIDY', 'SALES_PAYABLE']) {
      rejects(() => ledger.account(A, kind, 'mem_a1'), 'ACCOUNT_INVALID');
    }
  });

  test('unknown kinds, unknown schools and members of another school are refused', () => {
    rejects(() => ledger.account(A, 'PETTY_CASH'), 'ACCOUNT_INVALID');
    rejects(() => ledger.account(A, 'toString'), 'ACCOUNT_INVALID');
    rejects(() => ledger.account(A, undefined), 'ACCOUNT_INVALID');
    rejects(() => ledger.account('sch_nope', 'CASH_RECEIVED'), 'ACCOUNT_INVALID');
    rejects(() => ledger.account(undefined, 'CASH_RECEIVED'), 'ACCOUNT_INVALID');
    rejects(() => ledger.account(A, 'STUDENT_WALLET', 'mem_nope'), 'ACCOUNT_INVALID');
    // mem_b1 exists, but in school B: school A must not be able to open an account for them
    rejects(() => ledger.account(A, 'STUDENT_WALLET', 'mem_b1'), 'ACCOUNT_INVALID');
    assert.equal(count(ctx, 'account'), 0);
  });
});

describe('post()', () => {
  test('writes a balanced posting with its entries and returns the DTO', () => {
    const { posting, created } = ledger.post({
      schoolId: A,
      idemKey: 'TOPUP:ord_1:PAID',
      kind: 'TOPUP_PAID',
      ref: 'ord_1',
      memo: 'Parent payment confirmed',
      lines: paidLines('mem_a1', 1250),
    });
    assert.equal(created, true);
    assert.match(posting.id, /^pst_/);
    assert.deepEqual(posting, {
      id: posting.id,
      schoolId: A,
      idemKey: 'TOPUP:ord_1:PAID',
      kind: 'TOPUP_PAID',
      ref: 'ord_1',
      memo: 'Parent payment confirmed',
      reversalOf: null,
      createdAt: ctx.clock.now(),
      lines: [
        { kind: 'CASH_RECEIVED', memberId: null, side: 'DR', amountSen: 1250 },
        { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'CR', amountSen: 1250 },
      ],
    });
    assert.equal(count(ctx, 'posting'), 1);
    assert.equal(count(ctx, 'entry'), 2);
    assert.equal(count(ctx, 'account'), 2);
    assert.deepEqual(ledger.getPosting(A, posting.id), posting);
    assert.deepEqual(ledger.findByIdemKey(A, 'TOPUP:ord_1:PAID'), posting);
  });

  test('ref and memo default to null', () => {
    const { posting } = ledger.post({ schoolId: A, idemKey: 'K1', kind: 'TEST', lines: paidLines('mem_a1', 100) });
    assert.equal(posting.ref, null);
    assert.equal(posting.memo, null);
  });

  test('a posting may have more than two lines', () => {
    const { posting } = ledger.post({
      schoolId: A,
      idemKey: 'MULTI',
      kind: 'TEST',
      lines: [
        { kind: 'CASH_RECEIVED', side: 'DR', amountSen: 700 },
        { kind: 'SCHOOL_SUBSIDY', side: 'DR', amountSen: 300 },
        { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'CR', amountSen: 600 },
        { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a2', side: 'CR', amountSen: 400 },
      ],
    });
    assert.equal(posting.lines.length, 4);
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a1'), 600);
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a2'), 400);
    assert.equal(ledger.trialBalance(A).balanced, true);
  });

  test('emits ledger.posting with the school code', () => {
    const { posting } = ledger.post({ schoolId: A, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', ref: 'ord_1', lines: paidLines('mem_a1', 500) });
    const events = eventsOf(ctx, 'ledger.posting');
    assert.equal(events.length, 1);
    assert.equal(events[0].school, 'smk-contoh');
    assert.equal(events[0].data.id, posting.id);
    assert.equal(events[0].data.idemKey, 'TOPUP:ord_1:PAID');
    assert.equal(events[0].data.kind, 'TOPUP_PAID');
    assert.equal(events[0].data.amountSen, 500);
    assert.deepEqual(events[0].data.lines, posting.lines);

    ledger.post({ schoolId: B, idemKey: 'X', kind: 'TOPUP_PAID', lines: paidLines('mem_b1', 100) });
    assert.equal(eventsOf(ctx, 'ledger.posting')[1].school, 'sjkc-contoh');
  });

  test('debits that do not equal credits are POSTING_UNBALANCED', () => {
    rejects(
      () =>
        ledger.post({
          schoolId: A,
          idemKey: 'U1',
          kind: 'TEST',
          lines: [
            { kind: 'CASH_RECEIVED', side: 'DR', amountSen: 1000 },
            { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'CR', amountSen: 999 },
          ],
        }),
      'POSTING_UNBALANCED',
      400,
    );
    rejects(
      () =>
        ledger.post({
          schoolId: A,
          idemKey: 'U2',
          kind: 'TEST',
          lines: [
            { kind: 'CASH_RECEIVED', side: 'DR', amountSen: 100 },
            { kind: 'SCHOOL_SUBSIDY', side: 'DR', amountSen: 100 },
          ],
        }),
      'POSTING_UNBALANCED',
    );
    assert.equal(count(ctx, 'posting'), 0);
    assert.equal(count(ctx, 'account'), 0);
    assert.equal(eventsOf(ctx, 'ledger.posting').length, 0);
  });

  test('malformed postings are POSTING_INVALID', () => {
    const good = paidLines('mem_a1', 100);
    const base = { schoolId: A, idemKey: 'BAD', kind: 'TEST', lines: good };
    const cases = {
      'no arguments': undefined,
      'lines missing': { ...base, lines: undefined },
      'lines not an array': { ...base, lines: { 0: good[0], 1: good[1] } },
      'no lines': { ...base, lines: [] },
      'one line': { ...base, lines: [good[0]] },
      'line not an object': { ...base, lines: [good[0], 'CR 100'] },
      'line is null': { ...base, lines: [good[0], null] },
      'side lower case': { ...base, lines: [good[0], { ...good[1], side: 'cr' }] },
      'side missing': { ...base, lines: [good[0], { ...good[1], side: undefined }] },
      'amount zero': { ...base, lines: [{ ...good[0], amountSen: 0 }, { ...good[1], amountSen: 0 }] },
      'amount negative': { ...base, lines: [{ ...good[0], amountSen: -100 }, { ...good[1], amountSen: -100 }] },
      'amount not whole sen': { ...base, lines: [{ ...good[0], amountSen: 12.5 }, { ...good[1], amountSen: 12.5 }] },
      'amount as text': { ...base, lines: [{ ...good[0], amountSen: '100' }, { ...good[1], amountSen: '100' }] },
      'amount too large': {
        ...base,
        lines: [{ ...good[0], amountSen: 2 ** 53 }, { ...good[1], amountSen: 2 ** 53 }],
      },
      'account kind missing': { ...base, lines: [good[0], { ...good[1], kind: undefined }] },
      'memberId not text': { ...base, lines: [good[0], { ...good[1], memberId: 7 }] },
      'schoolId missing': { ...base, schoolId: undefined },
      'idemKey missing': { ...base, idemKey: undefined },
      'idemKey empty': { ...base, idemKey: '' },
      'idemKey not text': { ...base, idemKey: 12 },
      'posting kind missing': { ...base, kind: undefined },
      'ref not text': { ...base, ref: 5 },
      'memo not text': { ...base, memo: { note: 'x' } },
    };
    for (const [name, args] of Object.entries(cases)) {
      assert.throws(
        () => ledger.post(args),
        (err) => err.code === 'POSTING_INVALID' && err.status === 400,
        name,
      );
    }
    assert.equal(count(ctx, 'posting'), 0);
    assert.equal(count(ctx, 'entry'), 0);
    assert.equal(count(ctx, 'account'), 0);
  });

  test('lines must respect the per-member account rules (ACCOUNT_INVALID)', () => {
    const post = (lines) => () => ledger.post({ schoolId: A, idemKey: 'ACC', kind: 'TEST', lines });
    rejects(post([{ kind: 'CASH_RECEIVED', side: 'DR', amountSen: 100 }, { kind: 'WAITING_TO_BE_ADDED', side: 'CR', amountSen: 100 }]), 'ACCOUNT_INVALID');
    rejects(
      post([{ kind: 'CASH_RECEIVED', memberId: 'mem_a1', side: 'DR', amountSen: 100 }, { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'CR', amountSen: 100 }]),
      'ACCOUNT_INVALID',
    );
    rejects(post([{ kind: 'BANK', side: 'DR', amountSen: 100 }, { kind: 'SALES_PAYABLE', side: 'CR', amountSen: 100 }]), 'ACCOUNT_INVALID');
    rejects(post(purchaseLines('mem_nope', 100)), 'ACCOUNT_INVALID');
    assert.equal(count(ctx, 'posting'), 0);
    assert.equal(count(ctx, 'account'), 0);
  });

  test('a long memo is shortened, not refused', () => {
    const { posting } = ledger.post({ schoolId: A, idemKey: 'MEMO', kind: 'TEST', memo: 'x'.repeat(600), lines: paidLines('mem_a1', 100) });
    assert.equal(posting.memo.length, 500);
  });
});

describe('post() idempotency', () => {
  test('the same idemKey with the same lines returns the existing posting', () => {
    const first = ledger.post({ schoolId: A, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', ref: 'ord_1', lines: paidLines('mem_a1', 1000) });
    ctx.clock.advance(5 * MINUTE);
    const again = ledger.post({ schoolId: A, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', ref: 'ord_1', lines: paidLines('mem_a1', 1000) });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.deepEqual(again.posting, first.posting);
    assert.equal(count(ctx, 'posting'), 1);
    assert.equal(count(ctx, 'entry'), 2);
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a1'), 1000);
    // a repeat is not news: only the first one is announced
    assert.equal(eventsOf(ctx, 'ledger.posting').length, 1);
  });

  test('the same lines in another order (and memberId null vs absent) count as the same', () => {
    const first = ledger.post({ schoolId: A, idemKey: 'K', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 1000) });
    const [dr, cr] = paidLines('mem_a1', 1000);
    const again = ledger.post({ schoolId: A, idemKey: 'K', kind: 'TOPUP_PAID', lines: [cr, { ...dr, memberId: null }] });
    assert.equal(again.created, false);
    assert.equal(again.posting.id, first.posting.id);
  });

  test('the same idemKey with different lines is IDEMPOTENCY_CONFLICT (409)', () => {
    const first = ledger.post({ schoolId: A, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 1000) });
    const conflicts = [paidLines('mem_a1', 1001), paidLines('mem_a2', 1000), addedLines('mem_a1', 1000), [...paidLines('mem_a1', 1000), ...paidLines('mem_a1', 1)]];
    for (const lines of conflicts) {
      assert.throws(
        () => ledger.post({ schoolId: A, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', lines }),
        (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409 && err.detail.postingId === first.posting.id,
      );
    }
    assert.equal(count(ctx, 'posting'), 1);
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a1'), 1000);
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a2'), 0);
  });

  test('idemKeys are per school: the same key in two schools makes two postings', () => {
    const a = ledger.post({ schoolId: A, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 1000) });
    const b = ledger.post({ schoolId: B, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', lines: paidLines('mem_b1', 300) });
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.notEqual(a.posting.id, b.posting.id);
    assert.equal(ledger.findByIdemKey(A, 'TOPUP:ord_1:PAID').id, a.posting.id);
    assert.equal(ledger.findByIdemKey(B, 'TOPUP:ord_1:PAID').id, b.posting.id);
  });
});

describe('reverse()', () => {
  let paid;
  beforeEach(() => {
    paid = ledger.post({ schoolId: A, idemKey: 'TOPUP:ord_1:PAID', kind: 'TOPUP_PAID', ref: 'ord_1', lines: paidLines('mem_a1', 2000) }).posting;
    ctx.clock.advance(14 * 24 * 60 * MINUTE);
  });

  test('writes a new posting with every side flipped', () => {
    const { posting, created } = ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TOPUP:ord_1:REVERSAL', memo: 'Not added in time: refunded' });
    assert.equal(created, true);
    assert.notEqual(posting.id, paid.id);
    assert.equal(posting.schoolId, A);
    assert.equal(posting.idemKey, 'TOPUP:ord_1:REVERSAL');
    assert.equal(posting.reversalOf, paid.id);
    assert.equal(posting.ref, 'ord_1');
    assert.equal(posting.memo, 'Not added in time: refunded');
    assert.equal(posting.createdAt, ctx.clock.now());
    assert.equal(typeof posting.kind, 'string');
    assert.deepEqual(posting.lines, [
      { kind: 'CASH_RECEIVED', memberId: null, side: 'CR', amountSen: 2000 },
      { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'DR', amountSen: 2000 },
    ]);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 0);
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a1'), 0);
    assert.deepEqual(ledger.getPosting(A, posting.id), posting);
    assert.deepEqual(ledger.findByIdemKey(A, 'TOPUP:ord_1:REVERSAL'), posting);

    const events = eventsOf(ctx, 'ledger.posting');
    assert.equal(events.length, 2);
    assert.equal(events[1].school, 'smk-contoh');
    assert.equal(events[1].data.id, posting.id);
    assert.equal(events[1].data.reversalOf, paid.id);
  });

  test('memo is optional', () => {
    const { posting } = ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'R' });
    assert.equal(posting.memo, null);
  });

  test('the same idemKey again returns the existing reversal', () => {
    const first = ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TOPUP:ord_1:REVERSAL' });
    ctx.clock.advance(MINUTE);
    const again = ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TOPUP:ord_1:REVERSAL' });
    assert.equal(again.created, false);
    assert.deepEqual(again.posting, first.posting);
    assert.equal(count(ctx, 'posting'), 2);
    assert.equal(count(ctx, 'entry'), 4);
    assert.equal(eventsOf(ctx, 'ledger.posting').length, 2);
  });

  test('reversing again under another idemKey is ALREADY_REVERSED (409)', () => {
    const first = ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TOPUP:ord_1:REVERSAL' });
    assert.throws(
      () => ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TOPUP:ord_1:REVERSAL-2' }),
      (err) => err.code === 'ALREADY_REVERSED' && err.status === 409 && err.detail.reversalId === first.posting.id,
    );
    assert.equal(count(ctx, 'posting'), 2);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 0);
  });

  test('a reversal cannot be reversed (CANNOT_REVERSE_REVERSAL)', () => {
    const { posting: reversal } = ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TOPUP:ord_1:REVERSAL' });
    rejects(() => ledger.reverse({ schoolId: A, postingId: reversal.id, idemKey: 'UNDO-REVERSAL' }), 'CANNOT_REVERSE_REVERSAL');
    assert.equal(count(ctx, 'posting'), 2);
  });

  test('an unknown posting is POSTING_NOT_FOUND (404)', () => {
    rejects(() => ledger.reverse({ schoolId: A, postingId: 'pst_nope', idemKey: 'R' }), 'POSTING_NOT_FOUND', 404);
  });

  test("another school's posting is POSTING_NOT_FOUND", () => {
    rejects(() => ledger.reverse({ schoolId: B, postingId: paid.id, idemKey: 'R' }), 'POSTING_NOT_FOUND', 404);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 2000);
    assert.equal(count(ctx, 'posting'), 1);
  });

  test('an idemKey already used by an unrelated posting is IDEMPOTENCY_CONFLICT', () => {
    ledger.post({ schoolId: A, idemKey: 'TAKEN', kind: 'TEST', lines: paidLines('mem_a2', 100) });
    rejects(() => ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TAKEN' }), 'IDEMPOTENCY_CONFLICT', 409);
    rejects(() => ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'TOPUP:ord_1:PAID' }), 'IDEMPOTENCY_CONFLICT', 409);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 2100);
  });

  test('bad arguments are POSTING_INVALID', () => {
    rejects(() => ledger.reverse(), 'POSTING_INVALID');
    rejects(() => ledger.reverse({ schoolId: A, postingId: paid.id }), 'POSTING_INVALID');
    rejects(() => ledger.reverse({ schoolId: A, idemKey: 'R' }), 'POSTING_INVALID');
    rejects(() => ledger.reverse({ postingId: paid.id, idemKey: 'R' }), 'POSTING_INVALID');
    rejects(() => ledger.reverse({ schoolId: A, postingId: paid.id, idemKey: 'R', memo: 5 }), 'POSTING_INVALID');
  });

  test('a multi-line posting is reversed line by line', () => {
    const { posting: p } = ledger.post({
      schoolId: A,
      idemKey: 'MULTI',
      kind: 'TEST',
      lines: [
        { kind: 'SCHOOL_SUBSIDY', side: 'DR', amountSen: 300 },
        { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'CR', amountSen: 100 },
        { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a2', side: 'CR', amountSen: 200 },
      ],
    });
    const { posting: r } = ledger.reverse({ schoolId: A, postingId: p.id, idemKey: 'MULTI:REVERSAL' });
    assert.deepEqual(
      r.lines,
      p.lines.map((l) => ({ ...l, side: l.side === 'DR' ? 'CR' : 'DR' })),
    );
    assert.equal(ledger.balance(A, 'SCHOOL_SUBSIDY'), 0);
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a2'), 0);
  });
});

describe('balances', () => {
  test('are on each account’s normal side', () => {
    ledger.post({ schoolId: A, idemKey: 'TOPUP:o1:PAID', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 2000) });
    ledger.post({ schoolId: A, idemKey: 'SUBSIDY:o2:GRANTED', kind: 'SUBSIDY_GRANTED', lines: [
      { kind: 'SCHOOL_SUBSIDY', side: 'DR', amountSen: 500 },
      { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'CR', amountSen: 500 },
    ] });
    ledger.post({ schoolId: A, idemKey: 'TOPUP:o1:ADDED', kind: 'TOPUP_ADDED', lines: addedLines('mem_a1', 2000) });
    ledger.post({ schoolId: A, idemKey: 'PURCHASE:CANTEEN-01:CANTEEN-01-000001', kind: 'PURCHASE', lines: purchaseLines('mem_a1', 350) });

    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 2000); // DR-normal asset
    assert.equal(ledger.balance(A, 'SCHOOL_SUBSIDY'), 500); // DR-normal expense
    assert.equal(ledger.balance(A, 'STUDENT_WALLET', 'mem_a1'), 1650); // CR-normal liability
    assert.equal(ledger.balance(A, 'WAITING_TO_BE_ADDED', 'mem_a1'), 500);
    assert.equal(ledger.balance(A, 'SALES_PAYABLE'), 350);
    assert.deepEqual(ledger.memberBalances(A, 'mem_a1'), { walletSen: 1650, waitingSen: 500 });
  });

  test('may be negative', () => {
    // a purchase reported before the matching top-up reached the books
    ledger.post({ schoolId: A, idemKey: 'PURCHASE:CANTEEN-01:CANTEEN-01-000001', kind: 'PURCHASE', lines: purchaseLines('mem_a1', 400) });
    assert.equal(ledger.balance(A, 'STUDENT_WALLET', 'mem_a1'), -400);
    assert.deepEqual(ledger.memberBalances(A, 'mem_a1'), { walletSen: -400, waitingSen: 0 });
    // a DR-normal account credited more than it was debited
    ledger.post({ schoolId: A, idemKey: 'ODD', kind: 'TEST', lines: [
      { kind: 'SALES_PAYABLE', side: 'DR', amountSen: 900 },
      { kind: 'CASH_RECEIVED', side: 'CR', amountSen: 900 },
    ] });
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), -900);
    assert.equal(ledger.balance(A, 'SALES_PAYABLE'), 400 - 900);
  });

  test('are 0 for an account that does not exist yet, without creating it', () => {
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 0);
    assert.equal(ledger.balance(A, 'STUDENT_WALLET', 'mem_a2'), 0);
    assert.deepEqual(ledger.memberBalances(A, 'mem_a2'), { walletSen: 0, waitingSen: 0 });
    assert.equal(count(ctx, 'account'), 0);
  });

  test('are 0 for an account that exists with no entries', () => {
    ledger.account(A, 'STUDENT_WALLET', 'mem_a2');
    assert.equal(ledger.balance(A, 'STUDENT_WALLET', 'mem_a2'), 0);
  });

  test('follow the account rules (ACCOUNT_INVALID)', () => {
    rejects(() => ledger.balance(A, 'STUDENT_WALLET'), 'ACCOUNT_INVALID');
    rejects(() => ledger.balance(A, 'CASH_RECEIVED', 'mem_a1'), 'ACCOUNT_INVALID');
    rejects(() => ledger.balance(A, 'NOPE'), 'ACCOUNT_INVALID');
    rejects(() => ledger.memberBalances(A, null), 'ACCOUNT_INVALID');
  });

  test('are computed from entries, so a direct entry row changes them', () => {
    ledger.post({ schoolId: A, idemKey: 'K', kind: 'TEST', lines: paidLines('mem_a1', 1000) });
    const acc = ledger.account(A, 'CASH_RECEIVED');
    const pst = ledger.findByIdemKey(A, 'K');
    ctx.db.run("INSERT INTO entry (posting_id, account_id, side, amount_sen) VALUES (?, ?, 'DR', 1)", pst.id, acc.id);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 1001);
  });
});

describe('trialBalance()', () => {
  test('lists every account with debit, credit and normal-side totals', () => {
    ledger.post({ schoolId: A, idemKey: 'TOPUP:o1:PAID', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 2000) });
    ledger.post({ schoolId: A, idemKey: 'TOPUP:o1:ADDED', kind: 'TOPUP_ADDED', lines: addedLines('mem_a1', 2000) });
    ledger.post({ schoolId: A, idemKey: 'PURCHASE:W:W-000001', kind: 'PURCHASE', lines: purchaseLines('mem_a1', 300) });
    ledger.post({ schoolId: A, idemKey: 'PURCHASE:W:W-000002', kind: 'PURCHASE', lines: purchaseLines('mem_a2', 50) });
    ledger.account(A, 'SCHOOL_SUBSIDY'); // exists, never used

    const tb = ledger.trialBalance(A);
    assert.equal(tb.balanced, true);
    assert.deepEqual(tb.totals, { debitSen: 2000 + 2000 + 300 + 50, creditSen: 2000 + 2000 + 300 + 50 });

    const byKey = new Map(tb.accounts.map((a) => [`${a.kind}/${a.memberId ?? ''}`, a]));
    assert.equal(tb.accounts.length, 6);
    for (const a of tb.accounts) {
      assert.deepEqual(Object.keys(a).sort(), ['balanceSen', 'creditSen', 'debitSen', 'id', 'kind', 'memberId', 'memberName']);
      assert.match(a.id, /^acc_/);
    }
    assert.deepEqual(
      { ...byKey.get('CASH_RECEIVED/'), id: undefined },
      { id: undefined, kind: 'CASH_RECEIVED', memberId: null, memberName: null, debitSen: 2000, creditSen: 0, balanceSen: 2000 },
    );
    assert.deepEqual(
      { ...byKey.get('STUDENT_WALLET/mem_a1'), id: undefined },
      { id: undefined, kind: 'STUDENT_WALLET', memberId: 'mem_a1', memberName: 'Aina Contoh', debitSen: 300, creditSen: 2000, balanceSen: 1700 },
    );
    assert.deepEqual(
      { ...byKey.get('STUDENT_WALLET/mem_a2'), id: undefined },
      { id: undefined, kind: 'STUDENT_WALLET', memberId: 'mem_a2', memberName: 'Badrul Contoh', debitSen: 50, creditSen: 0, balanceSen: -50 },
    );
    assert.equal(byKey.get('WAITING_TO_BE_ADDED/mem_a1').balanceSen, 0);
    assert.equal(byKey.get('SALES_PAYABLE/').balanceSen, 350);
    assert.deepEqual(
      { ...byKey.get('SCHOOL_SUBSIDY/'), id: undefined },
      { id: undefined, kind: 'SCHOOL_SUBSIDY', memberId: null, memberName: null, debitSen: 0, creditSen: 0, balanceSen: 0 },
    );
    assert.equal(byKey.get('CASH_RECEIVED/').id, ledger.account(A, 'CASH_RECEIVED').id);
  });

  test('stays balanced through reversals', () => {
    const { posting } = ledger.post({ schoolId: A, idemKey: 'P', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 700) });
    ledger.reverse({ schoolId: A, postingId: posting.id, idemKey: 'P:REVERSAL' });
    const tb = ledger.trialBalance(A);
    assert.deepEqual(tb.totals, { debitSen: 1400, creditSen: 1400 });
    assert.equal(tb.balanced, true);
    assert.ok(tb.accounts.every((a) => a.balanceSen === 0));
  });

  test('is empty and balanced for a school with no books yet', () => {
    assert.deepEqual(ledger.trialBalance(B), { accounts: [], totals: { debitSen: 0, creditSen: 0 }, balanced: true });
  });

  test('reports balanced: false when entries were written outside post()', () => {
    const { posting } = ledger.post({ schoolId: A, idemKey: 'P', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 700) });
    const acc = ledger.account(A, 'CASH_RECEIVED');
    ctx.db.run("INSERT INTO entry (posting_id, account_id, side, amount_sen) VALUES (?, ?, 'DR', 5)", posting.id, acc.id);
    const tb = ledger.trialBalance(A);
    assert.deepEqual(tb.totals, { debitSen: 705, creditSen: 700 });
    assert.equal(tb.balanced, false);
  });
});

describe('postings()', () => {
  test('lists newest first with their lines', () => {
    const p1 = ledger.post({ schoolId: A, idemKey: 'TOPUP:o1:PAID', kind: 'TOPUP_PAID', ref: 'o1', memo: 'paid', lines: paidLines('mem_a1', 1000) }).posting;
    ctx.clock.advance(MINUTE);
    const p2 = ledger.post({ schoolId: A, idemKey: 'TOPUP:o1:ADDED', kind: 'TOPUP_ADDED', ref: 'o1', lines: addedLines('mem_a1', 1000) }).posting;
    ctx.clock.advance(MINUTE);
    const p3 = ledger.post({ schoolId: A, idemKey: 'PURCHASE:C:C-000001', kind: 'PURCHASE', lines: purchaseLines('mem_a2', 250) }).posting;

    const list = ledger.postings(A);
    assert.deepEqual(list.map((p) => p.id), [p3.id, p2.id, p1.id]);
    assert.deepEqual(list[2], {
      id: p1.id,
      kind: 'TOPUP_PAID',
      ref: 'o1',
      memo: 'paid',
      reversalOf: null,
      createdAt: p1.createdAt,
      lines: [
        { kind: 'CASH_RECEIVED', memberId: null, side: 'DR', amountSen: 1000 },
        { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_a1', side: 'CR', amountSen: 1000 },
      ],
    });
    assert.deepEqual(list[0].lines, p3.lines);
    assert.ok(list[0].createdAt > list[1].createdAt);
  });

  test('postings made at the same lab time come newest written first', () => {
    const ids = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(ledger.post({ schoolId: A, idemKey: `SAME:${i}`, kind: 'TEST', lines: paidLines('mem_a1', i) }).posting.id);
    }
    assert.deepEqual(ledger.postings(A).map((p) => p.id), ids.reverse());
  });

  test('limit keeps the newest ones and defaults to 50', () => {
    for (let i = 1; i <= 55; i++) {
      ledger.post({ schoolId: A, idemKey: `L:${i}`, kind: 'TEST', lines: paidLines('mem_a1', i) });
      ctx.clock.advance(1000);
    }
    assert.equal(ledger.postings(A).length, 50);
    const three = ledger.postings(A, { limit: 3 });
    assert.deepEqual(three.map((p) => p.lines[0].amountSen), [55, 54, 53]);
    assert.equal(ledger.postings(A, { limit: '2' }).length, 2);
    assert.equal(ledger.postings(A, { limit: 0 }).length, 50);
    assert.equal(ledger.postings(A, { limit: 100 }).length, 55);
  });

  test('memberId keeps only postings that touch that member', () => {
    const p1 = ledger.post({ schoolId: A, idemKey: 'A1', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 100) }).posting;
    ctx.clock.advance(MINUTE);
    const p2 = ledger.post({ schoolId: A, idemKey: 'A2', kind: 'TOPUP_PAID', lines: paidLines('mem_a2', 200) }).posting;
    ctx.clock.advance(MINUTE);
    const p3 = ledger.post({ schoolId: A, idemKey: 'A3', kind: 'PURCHASE', lines: purchaseLines('mem_a1', 50) }).posting;
    ctx.clock.advance(MINUTE);
    const r = ledger.reverse({ schoolId: A, postingId: p2.id, idemKey: 'A2:REVERSAL' }).posting;

    assert.deepEqual(ledger.postings(A, { memberId: 'mem_a1' }).map((p) => p.id), [p3.id, p1.id]);
    const forA2 = ledger.postings(A, { memberId: 'mem_a2' });
    assert.deepEqual(forA2.map((p) => p.id), [r.id, p2.id]);
    assert.equal(forA2[0].reversalOf, p2.id);
    // all lines of a matching posting are shown, not only the member's own
    assert.equal(forA2[1].lines.length, 2);
    assert.deepEqual(ledger.postings(A, { memberId: 'mem_a1', limit: 1 }).map((p) => p.id), [p3.id]);
    assert.deepEqual(ledger.postings(A, { memberId: 'mem_nope' }), []);
  });

  test('is empty for a school with no postings', () => {
    assert.deepEqual(ledger.postings(B), []);
  });
});

describe('getPosting() and findByIdemKey()', () => {
  test('return null when there is no such posting', () => {
    assert.equal(ledger.getPosting(A, 'pst_nope'), null);
    assert.equal(ledger.findByIdemKey(A, 'NOPE'), null);
    assert.equal(ledger.getPosting(A, undefined), null);
    assert.equal(ledger.findByIdemKey(undefined, 'NOPE'), null);
  });
});

describe('all or nothing', () => {
  test('a line that fails after earlier lines were prepared leaves nothing behind', () => {
    // line 1 would create the CASH_RECEIVED account; line 2 names a member of another school
    rejects(
      () =>
        ledger.post({
          schoolId: A,
          idemKey: 'HALF',
          kind: 'TEST',
          lines: [
            { kind: 'CASH_RECEIVED', side: 'DR', amountSen: 100 },
            { kind: 'WAITING_TO_BE_ADDED', memberId: 'mem_b1', side: 'CR', amountSen: 100 },
          ],
        }),
      'ACCOUNT_INVALID',
    );
    assert.equal(count(ctx, 'account'), 0);
    assert.equal(count(ctx, 'posting'), 0);
    assert.equal(count(ctx, 'entry'), 0);
    assert.equal(eventsOf(ctx, 'ledger.posting').length, 0);
    assert.equal(ctx.db.inTransaction(), false);
  });

  /** A ledger whose database fails on the n-th entry insert, like a disk error mid-posting. */
  function ledgerFailingOnEntry(n) {
    let inserts = 0;
    const db = {
      ...ctx.db,
      run(sql, ...params) {
        if (sql.includes('INSERT INTO entry') && ++inserts === n) throw new Error('simulated disk error');
        return ctx.db.run(sql, ...params);
      },
    };
    return createLedger({ ...ctx, db });
  }

  test('a crash between entry rows of a posting leaves nothing behind', () => {
    const broken = ledgerFailingOnEntry(2);
    assert.throws(() => broken.post({ schoolId: A, idemKey: 'CRASH', kind: 'TEST', lines: paidLines('mem_a1', 100) }), /simulated disk error/);
    assert.equal(count(ctx, 'posting'), 0);
    assert.equal(count(ctx, 'entry'), 0);
    assert.equal(count(ctx, 'account'), 0);
    assert.equal(eventsOf(ctx, 'ledger.posting').length, 0);
    // the key is still free: a retry works and writes the posting once
    const retry = ledger.post({ schoolId: A, idemKey: 'CRASH', kind: 'TEST', lines: paidLines('mem_a1', 100) });
    assert.equal(retry.created, true);
    assert.equal(count(ctx, 'entry'), 2);
  });

  test('a crash in the middle of a reversal leaves nothing behind', () => {
    const { posting } = ledger.post({ schoolId: A, idemKey: 'P', kind: 'TEST', lines: paidLines('mem_a1', 100) });
    const broken = ledgerFailingOnEntry(2);
    assert.throws(() => broken.reverse({ schoolId: A, postingId: posting.id, idemKey: 'P:REVERSAL' }), /simulated disk error/);
    assert.equal(count(ctx, 'posting'), 1);
    assert.equal(count(ctx, 'entry'), 2);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 100);
    assert.equal(ledger.findByIdemKey(A, 'P:REVERSAL'), null);
    // not marked as reversed: a retry succeeds
    assert.equal(ledger.reverse({ schoolId: A, postingId: posting.id, idemKey: 'P:REVERSAL' }).created, true);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 0);
  });

  test('a posting inside a caller transaction that fails later is rolled back with it', () => {
    assert.throws(() =>
      ctx.db.tx(() => {
        ledger.post({ schoolId: A, idemKey: 'OUTER', kind: 'TEST', lines: paidLines('mem_a1', 100) });
        throw new Error('caller failed afterwards');
      }),
    );
    assert.equal(ledger.findByIdemKey(A, 'OUTER'), null);
    assert.equal(count(ctx, 'entry'), 0);
  });

  test('a failed posting inside a caller transaction does not undo the caller’s other work', () => {
    const kept = ctx.db.tx(() => {
      const ok = ledger.post({ schoolId: A, idemKey: 'FIRST', kind: 'TEST', lines: paidLines('mem_a1', 100) });
      assert.throws(() => ledger.post({ schoolId: A, idemKey: 'FIRST', kind: 'TEST', lines: paidLines('mem_a1', 999) }));
      return ok.posting.id;
    });
    assert.equal(ledger.getPosting(A, kept).id, kept);
    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 100);
  });
});

describe('tenant isolation', () => {
  test("school A's books never appear in school B", () => {
    const a1 = ledger.post({ schoolId: A, idemKey: 'TOPUP:o1:PAID', kind: 'TOPUP_PAID', lines: paidLines('mem_a1', 1500) }).posting;
    ledger.post({ schoolId: A, idemKey: 'PURCHASE:C:C-000001', kind: 'PURCHASE', lines: purchaseLines('mem_a1', 200) });
    const b1 = ledger.post({ schoolId: B, idemKey: 'TOPUP:o9:PAID', kind: 'TOPUP_PAID', lines: paidLines('mem_b1', 400) }).posting;

    assert.deepEqual(ledger.postings(B).map((p) => p.id), [b1.id]);
    assert.ok(!ledger.postings(A).some((p) => p.id === b1.id));
    assert.deepEqual(ledger.postings(B, { memberId: 'mem_a1' }), []);
    assert.equal(ledger.getPosting(B, a1.id), null);
    assert.equal(ledger.findByIdemKey(B, 'TOPUP:o1:PAID'), null);

    assert.equal(ledger.balance(A, 'CASH_RECEIVED'), 1500);
    assert.equal(ledger.balance(B, 'CASH_RECEIVED'), 400);
    assert.equal(ledger.balance(B, 'SALES_PAYABLE'), 0);
    assert.equal(ledger.balance(B, 'STUDENT_WALLET', 'mem_a1'), 0);
    assert.deepEqual(ledger.memberBalances(B, 'mem_a1'), { walletSen: 0, waitingSen: 0 });

    const tbB = ledger.trialBalance(B);
    assert.deepEqual(tbB.totals, { debitSen: 400, creditSen: 400 });
    assert.deepEqual(tbB.accounts.map((a) => a.memberId).filter(Boolean), ['mem_b1']);
    const tbA = ledger.trialBalance(A);
    assert.deepEqual(tbA.totals, { debitSen: 1700, creditSen: 1700 });
    assert.ok(tbA.accounts.every((a) => a.memberId !== 'mem_b1'));
  });

  test("school B cannot post to school A's members", () => {
    rejects(() => ledger.post({ schoolId: B, idemKey: 'X', kind: 'TEST', lines: paidLines('mem_a1', 100) }), 'ACCOUNT_INVALID');
    assert.equal(count(ctx, 'posting'), 0);
  });
});
