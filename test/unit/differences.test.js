import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createSchools } from '../../src/platform/schools.js';
import { createDifferences, DIFFERENCE_KINDS } from '../../src/platform/differences.js';

// Two fictional schools; every difference belongs to exactly one of them.

const code = (c, status) => (err) => {
  assert.equal(err.code, c, err.message);
  if (status !== undefined) assert.equal(err.status, status);
  return true;
};

let ctx, differences, a, b;
beforeEach(() => {
  ctx = createTestCtx();
  const schools = createSchools(ctx);
  differences = createDifferences(ctx);
  a = schools.createSchool({ code: 'smk-alpha', name: 'SMK Alpha (fictional)' });
  b = schools.createSchool({ code: 'smk-beta', name: 'SMK Beta (fictional)' });
});
afterEach(() => ctx.db.close());

test('opening the same school, kind and ref twice is one difference', () => {
  const first = differences.open({ schoolId: a.id, kind: 'MISSING_RECORDS', ref: 'CANTEEN-01:5-7', detail: { count: 3 } });
  const again = differences.open({ schoolId: a.id, kind: 'MISSING_RECORDS', ref: 'CANTEEN-01:5-7', detail: { count: 99 } });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.difference.id, first.difference.id);
  assert.deepEqual(again.difference.detail, { count: 3 });
  // the same ref in another school is that school's own difference
  assert.equal(differences.open({ schoolId: b.id, kind: 'MISSING_RECORDS', ref: 'CANTEEN-01:5-7' }).created, true);
  assert.deepEqual(eventsOf(ctx, 'difference.opened').map((e) => e.school), ['smk-alpha', 'smk-beta']);
});

test('only the listed kinds can be opened', () => {
  for (const kind of ['toString', 'constructor', '__proto__', 'NOT_A_KIND', '', 42, undefined]) {
    assert.throws(() => differences.open({ schoolId: a.id, kind, ref: 'x' }), code('DIFFERENCE_KIND_INVALID', 500), String(kind));
  }
  for (const kind of Object.keys(DIFFERENCE_KINDS)) {
    assert.equal(differences.open({ schoolId: a.id, kind, ref: kind }).created, true, kind);
  }
});

test('list: newest first, filtered, and a limit kept between 1 and 1000', () => {
  for (let i = 1; i <= 5; i++) {
    differences.open({ schoolId: a.id, kind: 'MISSING_RECORDS', ref: `CANTEEN-01:${i}-${i}` });
    ctx.clock.advance(1000);
  }
  differences.open({ schoolId: b.id, kind: 'MISSING_RECORDS', ref: 'CANTEEN-01:1-1' });
  const all = differences.list(a.id);
  assert.deepEqual(all.map((d) => d.ref), ['CANTEEN-01:5-5', 'CANTEEN-01:4-4', 'CANTEEN-01:3-3', 'CANTEEN-01:2-2', 'CANTEEN-01:1-1']);
  assert.equal(differences.list(a.id, { limit: 2 }).length, 2);
  for (const limit of [0, -1, 1.5, '2', null, Number.NaN, Infinity]) {
    assert.equal(differences.list(a.id, { limit }).length, 5, String(limit));
  }
  assert.equal(differences.list(a.id, { limit: 10 ** 9 }).length, 5);
  assert.equal(differences.list(a.id, { kind: 'BALANCE_MISMATCH' }).length, 0);
  assert.equal(differences.list(a.id, { status: 'OPEN' }).length, 5);
  // filters that are not strings are ignored, never bound into SQL
  assert.equal(differences.list(a.id, { status: ['OPEN'], kind: { x: 1 } }).length, 5);
  assert.deepEqual(differences.list(undefined), []);
});

test('resolve: once, by a person named as text, only within the school', () => {
  const { difference } = differences.open({ schoolId: a.id, kind: 'BALANCE_MISMATCH', ref: 'card:3' });
  // another school's staff cannot see it or resolve it
  assert.throws(() => differences.resolve({ schoolId: b.id, id: difference.id, actor: 'staff:stf_b' }), code('DIFFERENCE_NOT_FOUND', 404));
  assert.equal(differences.get(b.id, difference.id), null);

  const resolved = differences.resolve({ schoolId: a.id, id: difference.id, actor: { id: 'stf_a', name: 'Tan Wei Ming' }, note: 'x'.repeat(600) });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolvedBy, 'Tan Wei Ming (stf_a)');
  assert.equal(resolved.note.length, 500);
  assert.equal(resolved.resolvedAt, ctx.clock.now());
  assert.equal(differences.countOpen(a.id), 0);
  assert.deepEqual(eventsOf(ctx, 'difference.resolved').map((e) => [e.school, e.data.by]), [['smk-alpha', 'Tan Wei Ming (stf_a)']]);

  assert.throws(() => differences.resolve({ schoolId: a.id, id: difference.id, actor: 'staff:stf_a' }), code('DIFFERENCE_ALREADY_RESOLVED', 409));
  assert.throws(() => differences.resolve({ schoolId: a.id, id: 'dif_missing' }), code('DIFFERENCE_NOT_FOUND', 404));
  assert.throws(() => differences.resolve(), code('DIFFERENCE_NOT_FOUND', 404));
});
