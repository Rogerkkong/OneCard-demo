import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createSchools, DEFAULT_SCHOOL_SETTINGS } from '../../src/platform/schools.js';
import { cardDigest } from '../../src/shared/crypto.js';
import { MINUTE } from '../../src/shared/time.js';

// All names, codes and card numbers below are fictional.

/** assert.throws matcher for a LabError code (and optional HTTP status). */
const code = (c, status) => (err) => {
  assert.equal(err.name, 'LabError', `expected LabError ${c}, got ${err}`);
  assert.equal(err.code, c);
  if (status !== undefined) assert.equal(err.status, status);
  return true;
};

function setup() {
  const ctx = createTestCtx();
  const schools = createSchools(ctx);
  const a = schools.createSchool({ code: 'smk-alpha', name: 'SMK Alpha (fictional)' });
  const b = schools.createSchool({ code: 'smk-beta', name: 'SMK Beta (fictional)' });
  return { ctx, schools, a, b };
}

describe('schools', () => {
  let ctx, schools, a, b;
  beforeEach(() => ({ ctx, schools, a, b } = setup()));

  test('createSchool returns the DTO with default settings and never the card key', () => {
    assert.deepEqual(Object.keys(a).sort(), ['code', 'createdAt', 'id', 'name', 'settings', 'status']);
    assert.match(a.id, /^sch_/);
    assert.equal(a.code, 'smk-alpha');
    assert.equal(a.name, 'SMK Alpha (fictional)');
    assert.equal(a.status, 'ACTIVE');
    assert.equal(a.createdAt, ctx.clock.now());
    assert.deepEqual(a.settings, DEFAULT_SCHOOL_SETTINGS);
    for (const dto of [a, schools.getSchool(a.id), schools.getSchoolByCode('smk-alpha'), ...schools.listSchools()]) {
      assert.ok(!JSON.stringify(dto).includes(schools.schoolCardKey(dto.id)), 'card key leaked in a DTO');
      assert.ok(!('cardKey' in dto) && !('card_key' in dto));
    }
  });

  test('createSchool generates a separate 32-byte card key per school', () => {
    const ka = schools.schoolCardKey(a.id);
    const kb = schools.schoolCardKey(b.id);
    assert.match(ka, /^[0-9a-f]{64}$/);
    assert.match(kb, /^[0-9a-f]{64}$/);
    assert.notEqual(ka, kb);
    assert.equal(schools.schoolCardKey('sch_nope'), null);
    assert.equal(schools.schoolCardKey(undefined), null);
  });

  test('createSchool writes an audit row and emits an audit event with the school code', () => {
    const rows = schools.listAudit(a.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'school.create');
    const ev = eventsOf(ctx, 'audit').find((e) => e.data.action === 'school.create' && e.school === 'smk-alpha');
    assert.ok(ev);
  });

  test('createSchool refuses an invalid code', () => {
    for (const bad of ['SMK-ALPHA', '-smk', 'smk-', 'smk alpha', '', 'a'.repeat(33), 'smk_alpha', null, 42]) {
      assert.throws(() => schools.createSchool({ code: bad, name: 'X' }), code('SCHOOL_CODE_INVALID', 400), String(bad));
    }
  });

  test('createSchool refuses a taken code with SCHOOL_CODE_TAKEN (409)', () => {
    assert.throws(() => schools.createSchool({ code: 'smk-alpha', name: 'Another' }), code('SCHOOL_CODE_TAKEN', 409));
    assert.equal(schools.listSchools().length, 2);
  });

  test('createSchool needs a name', () => {
    assert.throws(() => schools.createSchool({ code: 'smk-gamma', name: '  ' }), code('NAME_INVALID'));
    assert.throws(() => schools.createSchool({ code: 'smk-gamma' }), code('NAME_INVALID'));
  });

  test('createSchool accepts a settings patch and deep-merges it with the defaults', () => {
    const c = schools.createSchool({ code: 'smk-gamma', name: 'Gamma', settings: { topup: { minSen: 1000 } } });
    assert.equal(c.settings.topup.minSen, 1000);
    assert.equal(c.settings.topup.maxSen, DEFAULT_SCHOOL_SETTINGS.topup.maxSen);
    assert.equal(c.settings.topup.addWindowDays, 14);
  });

  test('getSchool / getSchoolByCode return null when missing; listSchools lists all', () => {
    assert.equal(schools.getSchool('sch_missing'), null);
    assert.equal(schools.getSchool(undefined), null);
    assert.equal(schools.getSchoolByCode('smk-none'), null);
    assert.equal(schools.getSchoolByCode(undefined), null);
    assert.deepEqual(schools.getSchoolByCode('smk-beta'), b);
    assert.deepEqual(schools.listSchools().map((s) => s.code), ['smk-alpha', 'smk-beta']);
  });

  test('setSchoolStatus suspends and reactivates, with audit; bad input refused', () => {
    const s = schools.setSchoolStatus(a.id, 'SUSPENDED', 'staff:stf_test');
    assert.equal(s.status, 'SUSPENDED');
    assert.equal(schools.getSchool(a.id).status, 'SUSPENDED');
    assert.equal(schools.getSchool(b.id).status, 'ACTIVE');
    const row = schools.listAudit(a.id)[0];
    assert.equal(row.action, 'school.status');
    assert.equal(row.actor, 'staff:stf_test');
    assert.deepEqual(row.detail, { from: 'ACTIVE', to: 'SUSPENDED' });
    assert.equal(schools.setSchoolStatus(a.id, 'ACTIVE', 'x').status, 'ACTIVE');
    assert.throws(() => schools.setSchoolStatus(a.id, 'CLOSED', 'x'), code('SCHOOL_STATUS_INVALID'));
    assert.throws(() => schools.setSchoolStatus('sch_missing', 'ACTIVE', 'x'), code('SCHOOL_NOT_FOUND', 404));
  });

  test('setSchoolStatus to the same status writes no audit row', () => {
    const before = schools.listAudit(a.id).length;
    schools.setSchoolStatus(a.id, 'ACTIVE', 'x');
    assert.equal(schools.listAudit(a.id).length, before);
  });
});

describe('school settings', () => {
  let ctx, schools, a, b;
  beforeEach(() => ({ ctx, schools, a, b } = setup()));

  test('DEFAULT_SCHOOL_SETTINGS matches the contract and is frozen', () => {
    assert.deepEqual(DEFAULT_SCHOOL_SETTINGS, {
      topup: { minSen: 500, maxSen: 20000, dailyMaxSen: 30000, monthlyMaxSen: 100000, payWindowMinutes: 30, addWindowDays: 14 },
    });
    assert.ok(Object.isFrozen(DEFAULT_SCHOOL_SETTINGS));
    assert.ok(Object.isFrozen(DEFAULT_SCHOOL_SETTINGS.topup));
  });

  test('schoolSettings returns a copy of defaults merged with stored values', () => {
    const s = schools.schoolSettings(a.id);
    assert.deepEqual(s, DEFAULT_SCHOOL_SETTINGS);
    s.topup.minSen = 1; // must not leak into the next read
    assert.equal(schools.schoolSettings(a.id).topup.minSen, 500);
    assert.throws(() => schools.schoolSettings('sch_missing'), code('SCHOOL_NOT_FOUND', 404));
  });

  test('updateSchoolSettings deep-merges, keeps other fields, and is per school', () => {
    const s1 = schools.updateSchoolSettings(a.id, { topup: { maxSen: 50000 } }, 'staff:x');
    assert.equal(s1.topup.maxSen, 50000);
    assert.equal(s1.topup.minSen, 500);
    const s2 = schools.updateSchoolSettings(a.id, { topup: { addWindowDays: 7 } }, 'staff:x');
    assert.equal(s2.topup.maxSen, 50000, 'earlier change kept');
    assert.equal(s2.topup.addWindowDays, 7);
    assert.deepEqual(schools.schoolSettings(a.id), s2);
    assert.deepEqual(schools.getSchool(a.id).settings, s2);
    assert.deepEqual(schools.schoolSettings(b.id), DEFAULT_SCHOOL_SETTINGS, 'other school untouched');
    assert.equal(schools.listAudit(a.id)[0].action, 'school.settings');
  });

  test('null in a patch resets a value to the default', () => {
    schools.updateSchoolSettings(a.id, { topup: { minSen: 800, maxSen: 9000 } }, 'x');
    const s = schools.updateSchoolSettings(a.id, { topup: { minSen: null } }, 'x');
    assert.equal(s.topup.minSen, 500);
    assert.equal(s.topup.maxSen, 9000);
    assert.deepEqual(schools.updateSchoolSettings(a.id, { topup: null }, 'x'), DEFAULT_SCHOOL_SETTINGS);
  });

  test('invalid settings are refused with SETTINGS_INVALID and nothing changes', () => {
    const bad = [
      'nope',
      { other: { x: 1 } },
      { topup: 5 },
      { topup: { minSen: 1.5 } },
      { topup: { minSen: 0 } },
      { topup: { maxSen: '100' } },
      { topup: { unknownField: 1 } },
      { topup: { minSen: 30000 } }, // more than the default maxSen
    ];
    for (const patch of bad) {
      assert.throws(() => schools.updateSchoolSettings(a.id, patch, 'x'), code('SETTINGS_INVALID'), JSON.stringify(patch));
    }
    assert.deepEqual(schools.schoolSettings(a.id), DEFAULT_SCHOOL_SETTINGS);
    assert.throws(() => schools.createSchool({ code: 'smk-x', name: 'X', settings: { topup: { minSen: -1 } } }), code('SETTINGS_INVALID'));
    assert.equal(schools.getSchoolByCode('smk-x'), null);
    assert.throws(() => schools.updateSchoolSettings('sch_missing', {}, 'x'), code('SCHOOL_NOT_FOUND', 404));
  });
});

describe('staff', () => {
  let schools, a, b;
  beforeEach(() => ({ schools, a, b } = setup()));

  test('addStaff, getStaff, listStaff per school and across schools', () => {
    const s1 = schools.addStaff({ schoolId: a.id, name: 'Puan Office', role: 'OFFICE' });
    const s2 = schools.addStaff({ schoolId: a.id, name: 'Encik Finance', role: 'FINANCE' });
    const s3 = schools.addStaff({ schoolId: b.id, name: 'Cikgu Admin', role: 'ADMIN' });
    assert.deepEqual(Object.keys(s1).sort(), ['id', 'name', 'role', 'schoolId']);
    assert.equal(s1.schoolId, a.id);
    assert.deepEqual(schools.getStaff(s2.id), s2);
    assert.equal(schools.getStaff('stf_missing'), null);
    assert.deepEqual(schools.listStaff(a.id).map((s) => s.id), [s1.id, s2.id]);
    assert.deepEqual(schools.listStaff(b.id).map((s) => s.id), [s3.id]);
    assert.equal(schools.listStaff().length, 3);
  });

  test('addStaff refuses a bad role, a missing name or school', () => {
    assert.throws(() => schools.addStaff({ schoolId: a.id, name: 'X', role: 'JANITOR' }), code('STAFF_ROLE_INVALID'));
    assert.throws(() => schools.addStaff({ schoolId: a.id, name: '', role: 'OFFICE' }), code('NAME_INVALID'));
    assert.throws(() => schools.addStaff({ schoolId: 'sch_missing', name: 'X', role: 'OFFICE' }), code('SCHOOL_NOT_FOUND', 404));
  });
});

describe('members', () => {
  let schools, a, b;
  beforeEach(() => ({ schools, a, b } = setup()));

  test('addMember with defaults; getMember and listMembers', () => {
    const m = schools.addMember({ schoolId: a.id, memberNo: 'S1001', name: 'Aina Test' });
    assert.deepEqual(Object.keys(m).sort(), ['card', 'className', 'group', 'id', 'memberNo', 'name', 'status']);
    assert.equal(m.className, '');
    assert.equal(m.group, 'STUDENT');
    assert.equal(m.status, 'ACTIVE');
    assert.equal(m.card, null);
    const t = schools.addMember({ schoolId: a.id, memberNo: 'T01', name: 'Cikgu Test', className: 'Staff room', group: 'STAFF' });
    assert.equal(t.group, 'STAFF');
    assert.deepEqual(schools.getMember(a.id, m.id), m);
    assert.deepEqual(schools.listMembers(a.id).map((x) => x.memberNo), ['S1001', 'T01']);
    assert.deepEqual(schools.listMembers(b.id), []);
  });

  test('a whole-number memberNo is stored as text', () => {
    const m = schools.addMember({ schoolId: a.id, memberNo: 1001, name: 'Num Test' });
    assert.equal(m.memberNo, '1001');
    assert.throws(() => schools.addMember({ schoolId: a.id, memberNo: '1001', name: 'Dup' }), code('MEMBER_NO_TAKEN', 409));
  });

  test('MEMBER_NO_TAKEN within a school; the same number is fine in another school', () => {
    schools.addMember({ schoolId: a.id, memberNo: 'S1', name: 'One' });
    assert.throws(() => schools.addMember({ schoolId: a.id, memberNo: 'S1', name: 'Two' }), code('MEMBER_NO_TAKEN', 409));
    assert.equal(schools.addMember({ schoolId: b.id, memberNo: 'S1', name: 'Other school' }).memberNo, 'S1');
  });

  test('addMember validation', () => {
    assert.throws(() => schools.addMember({ schoolId: a.id, memberNo: 'S1', name: 'X', group: 'PARENT' }), code('MEMBER_GROUP_INVALID'));
    assert.throws(() => schools.addMember({ schoolId: a.id, memberNo: '', name: 'X' }), code('MEMBER_NO_INVALID'));
    assert.throws(() => schools.addMember({ schoolId: a.id, memberNo: 'S1', name: '' }), code('NAME_INVALID'));
    assert.throws(() => schools.addMember({ schoolId: a.id, memberNo: 'S1', name: 'X', className: 'x'.repeat(41) }), code('CLASS_NAME_INVALID'));
    assert.throws(() => schools.addMember({ schoolId: 'sch_missing', memberNo: 'S1', name: 'X' }), code('SCHOOL_NOT_FOUND', 404));
  });

  test('tenant isolation: getMember of another school returns null', () => {
    const m = schools.addMember({ schoolId: a.id, memberNo: 'S1', name: 'Alpha kid' });
    assert.equal(schools.getMember(b.id, m.id), null);
    assert.equal(schools.getMember(a.id, 'mem_missing'), null);
    assert.equal(schools.getMember(undefined, m.id), null);
  });
});

describe('cards', () => {
  let ctx, schools, a, b, m, m2;
  beforeEach(() => {
    ({ ctx, schools, a, b } = setup());
    m = schools.addMember({ schoolId: a.id, memberNo: 'S1', name: 'Card Holder' });
    m2 = schools.addMember({ schoolId: a.id, memberNo: 'S2', name: 'Second Holder' });
  });

  test('issueCard normalises the UID and computes a stable digest with the school key', () => {
    const card = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04:a1:b2:c3', actor: 'staff:x' });
    assert.deepEqual(Object.keys(card).sort(), ['digest', 'id', 'issuedAt', 'last4', 'lostAt', 'lostListVersion', 'memberId', 'schoolId', 'status', 'uid']);
    assert.equal(card.uid, '04A1B2C3');
    assert.equal(card.last4, 'B2C3');
    assert.equal(card.status, 'ACTIVE');
    assert.equal(card.memberId, m.id);
    assert.equal(card.schoolId, a.id);
    assert.equal(card.issuedAt, ctx.clock.now());
    assert.equal(card.lostAt, null);
    assert.equal(card.lostListVersion, null);
    const expected = cardDigest(schools.schoolCardKey(a.id), 'smk-alpha', '04A1B2C3');
    assert.equal(card.digest, expected);
    assert.match(card.digest, /^[0-9a-f]{64}$/);
    // stable: the same answer from every way of asking
    assert.equal(schools.cardDigestFor(a.id, '04a1b2c3'), expected);
    assert.equal(schools.cardDigestFor(a.id, '04-A1-B2-C3'), expected);
    assert.equal(schools.getCardByUid(a.id, '04 a1 b2 c3').digest, expected);
    const audit = schools.listAudit(a.id)[0];
    assert.equal(audit.action, 'card.issue');
    assert.ok(!JSON.stringify(audit).includes('04A1B2C3'), 'audit carries last4 only');
  });

  test('the same UID in two schools gives different digests', () => {
    const mb = schools.addMember({ schoolId: b.id, memberNo: 'S1', name: 'Beta Holder' });
    const ca = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04A1B2C3D4E5F6', actor: 'x' });
    const cb = schools.issueCard({ schoolId: b.id, memberId: mb.id, uid: '04A1B2C3D4E5F6', actor: 'x' });
    assert.notEqual(ca.digest, cb.digest);
    assert.throws(() => schools.cardDigestFor('sch_missing', '04A1B2C3'), code('SCHOOL_NOT_FOUND', 404));
  });

  test('issueCard errors: CARD_UID_TAKEN, MEMBER_HAS_ACTIVE_CARD, MEMBER_NOT_FOUND, CARD_UID_INVALID', () => {
    schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04A1B2C3', actor: 'x' });
    assert.throws(() => schools.issueCard({ schoolId: a.id, memberId: m2.id, uid: '04a1b2c3', actor: 'x' }), code('CARD_UID_TAKEN', 409));
    assert.throws(() => schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04FFFFFF', actor: 'x' }), code('MEMBER_HAS_ACTIVE_CARD', 409));
    assert.throws(() => schools.issueCard({ schoolId: a.id, memberId: 'mem_missing', uid: '04EEEEEE', actor: 'x' }), code('MEMBER_NOT_FOUND', 404));
    // a member of another school is not found here either
    const mb = schools.addMember({ schoolId: b.id, memberNo: 'B1', name: 'Beta' });
    assert.throws(() => schools.issueCard({ schoolId: a.id, memberId: mb.id, uid: '04EEEEEE', actor: 'x' }), code('MEMBER_NOT_FOUND', 404));
    for (const bad of ['xyz', '04A1B2', '04A1B2C', '', null]) {
      assert.throws(() => schools.issueCard({ schoolId: a.id, memberId: m2.id, uid: bad, actor: 'x' }), code('CARD_UID_INVALID'), String(bad));
    }
    assert.equal(schools.listCards(a.id).length, 1);
  });

  test('one ACTIVE card per member', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    assert.throws(() => schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000002', actor: 'x' }), code('MEMBER_HAS_ACTIVE_CARD'));
    schools.markCardLost({ schoolId: a.id, uid: c1.uid, actor: 'x' });
    const c2 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000002', actor: 'x' });
    assert.equal(schools.activeCardForMember(a.id, m.id).id, c2.id);
    assert.equal(schools.listCards(a.id).filter((c) => c.memberId === m.id && c.status === 'ACTIVE').length, 1);
  });

  test('lookups: getCardByUid, getCardByDigest, getCard, activeCardForMember, listCards', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    const c2 = schools.issueCard({ schoolId: a.id, memberId: m2.id, uid: '04000002', actor: 'x' });
    assert.deepEqual(schools.getCardByUid(a.id, '04000001'), c1);
    assert.deepEqual(schools.getCardByDigest(a.id, c2.digest), c2);
    assert.deepEqual(schools.getCard(a.id, c1.id), c1);
    assert.deepEqual(schools.activeCardForMember(a.id, m2.id), c2);
    assert.deepEqual(schools.listCards(a.id).map((c) => c.id), [c1.id, c2.id]);
    assert.equal(schools.getCardByUid(a.id, '04999999'), null);
    assert.equal(schools.getCardByUid(a.id, 'not-a-uid'), null);
    assert.equal(schools.getCardByDigest(a.id, 'f'.repeat(64)), null);
    assert.equal(schools.getCard(a.id, 'crd_missing'), null);
    assert.equal(schools.activeCardForMember(a.id, 'mem_missing'), null);
  });

  test('tenant isolation: another school cannot see the cards', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    assert.equal(schools.getCard(b.id, c1.id), null);
    assert.equal(schools.getCardByUid(b.id, c1.uid), null);
    assert.equal(schools.getCardByDigest(b.id, c1.digest), null);
    assert.equal(schools.activeCardForMember(b.id, m.id), null);
    assert.deepEqual(schools.listCards(b.id), []);
    assert.throws(() => schools.markCardLost({ schoolId: b.id, uid: c1.uid, actor: 'x' }), code('CARD_NOT_FOUND', 404));
    assert.throws(() => schools.setLostListVersion(b.id, c1.id, 1), code('CARD_NOT_FOUND', 404));
    assert.equal(schools.getCard(a.id, c1.id).status, 'ACTIVE');
  });

  test('listMembers and getMember show the member card summary', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    assert.deepEqual(schools.getMember(a.id, m.id).card, { uid: '04000001', last4: '0001', status: 'ACTIVE' });
    const list = schools.listMembers(a.id);
    assert.deepEqual(list.find((x) => x.id === m.id).card, { uid: '04000001', last4: '0001', status: 'ACTIVE' });
    assert.equal(list.find((x) => x.id === m2.id).card, null);
    // with no ACTIVE card, the newest card shows (so the office can see it is LOST)
    schools.markCardLost({ schoolId: a.id, uid: c1.uid, actor: 'x' });
    assert.equal(schools.getMember(a.id, m.id).card.status, 'LOST');
    // an ACTIVE card wins over a newer LOST one
    ctx.clock.advance(MINUTE);
    schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000002', actor: 'x' });
    assert.equal(schools.getMember(a.id, m.id).card.uid, '04000002');
    assert.equal(schools.listMembers(a.id).find((x) => x.id === m.id).card.status, 'ACTIVE');
  });

  test('markCardLost: ACTIVE -> LOST with lostAt = now; again is CARD_NOT_ACTIVE (409)', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    ctx.clock.advance(5 * MINUTE);
    const lost = schools.markCardLost({ schoolId: a.id, uid: '04-00-00-01', actor: 'staff:x' });
    assert.equal(lost.id, c1.id);
    assert.equal(lost.status, 'LOST');
    assert.equal(lost.lostAt, ctx.clock.now());
    assert.equal(lost.lostListVersion, null);
    assert.equal(schools.activeCardForMember(a.id, m.id), null);
    assert.equal(schools.listAudit(a.id)[0].action, 'card.lost');
    assert.throws(() => schools.markCardLost({ schoolId: a.id, uid: c1.uid, actor: 'x' }), code('CARD_NOT_ACTIVE', 409));
    assert.throws(() => schools.markCardLost({ schoolId: a.id, uid: '04999999', actor: 'x' }), code('CARD_NOT_FOUND', 404));
  });

  test('setLostListVersion stores the block-list version on the card', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    schools.markCardLost({ schoolId: a.id, uid: c1.uid, actor: 'x' });
    const card = schools.setLostListVersion(a.id, c1.id, 7);
    assert.equal(card.lostListVersion, 7);
    assert.equal(schools.getCard(a.id, c1.id).lostListVersion, 7);
    assert.throws(() => schools.setLostListVersion(a.id, c1.id, -1), code('LIST_VERSION_INVALID'));
    assert.throws(() => schools.setLostListVersion(a.id, c1.id, 1.5), code('LIST_VERSION_INVALID'));
    assert.throws(() => schools.setLostListVersion(a.id, 'crd_missing', 1), code('CARD_NOT_FOUND', 404));
  });

  test('markCardFound: LOST -> ACTIVE and clears the lost fields', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    schools.markCardLost({ schoolId: a.id, uid: c1.uid, actor: 'x' });
    schools.setLostListVersion(a.id, c1.id, 3);
    const found = schools.markCardFound({ schoolId: a.id, uid: c1.uid, actor: 'staff:x' });
    assert.equal(found.status, 'ACTIVE');
    assert.equal(found.lostAt, null);
    assert.equal(found.lostListVersion, null);
    assert.equal(schools.activeCardForMember(a.id, m.id).id, c1.id);
    assert.equal(schools.listAudit(a.id)[0].action, 'card.found');
  });

  test('markCardFound errors: CARD_NOT_LOST for an ACTIVE card; MEMBER_HAS_ACTIVE_CARD after replacement', () => {
    const c1 = schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000001', actor: 'x' });
    assert.throws(() => schools.markCardFound({ schoolId: a.id, uid: c1.uid, actor: 'x' }), code('CARD_NOT_LOST', 409));
    schools.markCardLost({ schoolId: a.id, uid: c1.uid, actor: 'x' });
    schools.issueCard({ schoolId: a.id, memberId: m.id, uid: '04000002', actor: 'x' });
    assert.throws(() => schools.markCardFound({ schoolId: a.id, uid: c1.uid, actor: 'x' }), code('MEMBER_HAS_ACTIVE_CARD', 409));
    assert.equal(schools.getCard(a.id, c1.id).status, 'LOST', 'unchanged after the refusal');
    assert.throws(() => schools.markCardFound({ schoolId: a.id, uid: '04999999', actor: 'x' }), code('CARD_NOT_FOUND', 404));
  });
});

describe('parents', () => {
  let schools;
  beforeEach(() => ({ schools } = setup()));

  test('registerParent stores the email in lower case', () => {
    const p = schools.registerParent({ email: '  Ibu.Test@Example.COM ', name: 'Ibu Test' });
    assert.deepEqual(Object.keys(p).sort(), ['email', 'id', 'name']);
    assert.equal(p.email, 'ibu.test@example.com');
    assert.deepEqual(schools.getParent(p.id), p);
    assert.deepEqual(schools.getParentByEmail('IBU.TEST@example.com'), p);
    assert.equal(schools.getParentByEmail('nobody@example.com'), null);
    assert.equal(schools.getParent('par_missing'), null);
  });

  test('EMAIL_TAKEN ignores case', () => {
    schools.registerParent({ email: 'bapa@example.com', name: 'Bapa' });
    assert.throws(() => schools.registerParent({ email: 'BAPA@Example.com', name: 'Again' }), code('EMAIL_TAKEN', 409));
    assert.equal(schools.listParents().length, 1);
  });

  test('EMAIL_INVALID for things that are not an email address', () => {
    for (const bad of ['', 'plain', 'no@domain', '@example.com', 'a b@example.com', 'a@@example.com', 'a@example.', 'a@.com', null, 7]) {
      assert.throws(() => schools.registerParent({ email: bad, name: 'X' }), code('EMAIL_INVALID'), String(bad));
    }
    assert.throws(() => schools.registerParent({ email: 'ok@example.com', name: '' }), code('NAME_INVALID'));
  });

  test('listParents', () => {
    schools.registerParent({ email: 'one@example.com', name: 'One' });
    schools.registerParent({ email: 'two@example.com', name: 'Two' });
    assert.deepEqual(schools.listParents().map((p) => p.name), ['One', 'Two']);
  });
});

describe('invites and links', () => {
  let ctx, schools, a, b, ma, mb, parent, parent2;
  beforeEach(() => {
    ({ ctx, schools, a, b } = setup());
    ma = schools.addMember({ schoolId: a.id, memberNo: 'S1', name: 'Alpha Child', className: '4 Bestari' });
    mb = schools.addMember({ schoolId: b.id, memberNo: 'S1', name: 'Beta Child', className: '2 Merah' });
    parent = schools.registerParent({ email: 'parent@example.com', name: 'Test Parent' });
    parent2 = schools.registerParent({ email: 'other@example.com', name: 'Other Parent' });
  });

  const approveVia = (schoolId, memberId, parentId) => {
    const inv = schools.createInvite({ schoolId, memberId, actor: 'staff:x' });
    const link = schools.redeemInvite({ parentId, code: inv.code });
    return schools.decideLink({ schoolId, linkId: link.id, approve: true, actor: 'staff:x' });
  };

  test('createInvite returns an 8-character code; listInvites shows it', () => {
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'staff:x' });
    assert.deepEqual(Object.keys(inv).sort(), ['code', 'id', 'memberId', 'status']);
    assert.match(inv.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    assert.equal(inv.status, 'OPEN');
    assert.equal(inv.memberId, ma.id);
    const list = schools.listInvites(a.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].code, inv.code);
    assert.equal(list[0].memberName, 'Alpha Child');
    assert.deepEqual(schools.listInvites(b.id), []);
    assert.equal(schools.listAudit(a.id)[0].action, 'invite.create');
  });

  test('createInvite for a member of another school is MEMBER_NOT_FOUND', () => {
    assert.throws(() => schools.createInvite({ schoolId: a.id, memberId: mb.id, actor: 'x' }), code('MEMBER_NOT_FOUND', 404));
    assert.throws(() => schools.createInvite({ schoolId: a.id, memberId: 'mem_missing', actor: 'x' }), code('MEMBER_NOT_FOUND', 404));
  });

  test('redeemInvite creates a PENDING link and uses up the invite', () => {
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    ctx.clock.advance(MINUTE);
    const link = schools.redeemInvite({ parentId: parent.id, code: inv.code });
    assert.deepEqual(Object.keys(link).sort(), ['createdAt', 'id', 'memberId', 'memberName', 'parentEmail', 'parentId', 'parentName', 'status']);
    assert.equal(link.status, 'PENDING');
    assert.equal(link.parentId, parent.id);
    assert.equal(link.parentName, 'Test Parent');
    assert.equal(link.parentEmail, 'parent@example.com');
    assert.equal(link.memberId, ma.id);
    assert.equal(link.memberName, 'Alpha Child');
    assert.equal(link.createdAt, ctx.clock.now());
    const listed = schools.listInvites(a.id)[0];
    assert.equal(listed.status, 'USED');
    assert.equal(listed.usedAt, ctx.clock.now());
    // a used code is invalid, for anyone
    assert.throws(() => schools.redeemInvite({ parentId: parent2.id, code: inv.code }), code('INVITE_INVALID', 404));
  });

  test('codes are accepted in lower case and with spaces or dashes', () => {
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const typed = `${inv.code.slice(0, 4)}-${inv.code.slice(4)}`.toLowerCase();
    assert.equal(schools.redeemInvite({ parentId: parent.id, code: ` ${typed} ` }).status, 'PENDING');
  });

  test('INVITE_INVALID for an unknown code; PARENT_NOT_FOUND for an unknown parent', () => {
    assert.throws(() => schools.redeemInvite({ parentId: parent.id, code: 'ZZZZZZZZ' }), code('INVITE_INVALID', 404));
    assert.throws(() => schools.redeemInvite({ parentId: parent.id, code: '' }), code('INVITE_INVALID', 404));
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    assert.throws(() => schools.redeemInvite({ parentId: 'par_missing', code: inv.code }), code('PARENT_NOT_FOUND', 404));
    assert.equal(schools.listInvites(a.id)[0].status, 'OPEN', 'invite not used up by a refused redemption');
  });

  test('LINK_EXISTS (409) when the parent already has a pending or approved link; the invite stays open', () => {
    const inv1 = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const link = schools.redeemInvite({ parentId: parent.id, code: inv1.code });
    const inv2 = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    assert.throws(() => schools.redeemInvite({ parentId: parent.id, code: inv2.code }), code('LINK_EXISTS', 409));
    schools.decideLink({ schoolId: a.id, linkId: link.id, approve: true, actor: 'x' });
    assert.throws(() => schools.redeemInvite({ parentId: parent.id, code: inv2.code }), code('LINK_EXISTS', 409));
    assert.equal(schools.listInvites(a.id).find((i) => i.id === inv2.id).status, 'OPEN');
    // another parent can still use it
    assert.equal(schools.redeemInvite({ parentId: parent2.id, code: inv2.code }).status, 'PENDING');
  });

  test('after a REJECTED link a new invite opens the same link again as PENDING', () => {
    const inv1 = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const link = schools.redeemInvite({ parentId: parent.id, code: inv1.code });
    schools.decideLink({ schoolId: a.id, linkId: link.id, approve: false, actor: 'x' });
    const inv2 = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const again = schools.redeemInvite({ parentId: parent.id, code: inv2.code });
    assert.equal(again.id, link.id);
    assert.equal(again.status, 'PENDING');
    assert.equal(schools.decideLink({ schoolId: a.id, linkId: link.id, approve: true, actor: 'x' }).status, 'APPROVED');
  });

  test('decideLink approves or rejects once; LINK_ALREADY_DECIDED after', () => {
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const link = schools.redeemInvite({ parentId: parent.id, code: inv.code });
    const approved = schools.decideLink({ schoolId: a.id, linkId: link.id, approve: true, actor: 'staff:office' });
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.id, link.id);
    const audit = schools.listAudit(a.id)[0];
    assert.equal(audit.action, 'link.approve');
    assert.equal(audit.actor, 'staff:office');
    assert.throws(() => schools.decideLink({ schoolId: a.id, linkId: link.id, approve: false, actor: 'x' }), code('LINK_ALREADY_DECIDED', 409));
    assert.throws(() => schools.decideLink({ schoolId: a.id, linkId: link.id, approve: true, actor: 'x' }), code('LINK_ALREADY_DECIDED', 409));

    const inv2 = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const link2 = schools.redeemInvite({ parentId: parent2.id, code: inv2.code });
    const rejected = schools.decideLink({ schoolId: a.id, linkId: link2.id, approve: false, actor: 'x' });
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(schools.listAudit(a.id)[0].action, 'link.reject');
  });

  test('decideLink errors: LINK_NOT_FOUND (also for another school), LINK_DECISION_INVALID', () => {
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const link = schools.redeemInvite({ parentId: parent.id, code: inv.code });
    assert.throws(() => schools.decideLink({ schoolId: b.id, linkId: link.id, approve: true, actor: 'x' }), code('LINK_NOT_FOUND', 404));
    assert.throws(() => schools.decideLink({ schoolId: a.id, linkId: 'lnk_missing', approve: true, actor: 'x' }), code('LINK_NOT_FOUND', 404));
    assert.throws(() => schools.decideLink({ schoolId: a.id, linkId: link.id, approve: 'yes', actor: 'x' }), code('LINK_DECISION_INVALID'));
    assert.equal(schools.listLinks(a.id)[0].status, 'PENDING');
  });

  test('listLinks per school, filtered by status', () => {
    const l1 = approveVia(a.id, ma.id, parent.id);
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const l2 = schools.redeemInvite({ parentId: parent2.id, code: inv.code });
    assert.deepEqual(schools.listLinks(a.id).map((l) => l.id), [l1.id, l2.id]);
    assert.deepEqual(schools.listLinks(a.id, { status: 'PENDING' }).map((l) => l.id), [l2.id]);
    assert.deepEqual(schools.listLinks(a.id, { status: 'APPROVED' }).map((l) => l.id), [l1.id]);
    assert.deepEqual(schools.listLinks(b.id), []);
    const row = schools.listLinks(a.id)[1];
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'memberId', 'memberName', 'parentEmail', 'parentId', 'parentName', 'status']);
  });

  test('isLinked is true only for an APPROVED link in that school', () => {
    const inv = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const link = schools.redeemInvite({ parentId: parent.id, code: inv.code });
    assert.equal(schools.isLinked(parent.id, a.id, ma.id), false, 'PENDING grants nothing');
    schools.decideLink({ schoolId: a.id, linkId: link.id, approve: true, actor: 'x' });
    assert.equal(schools.isLinked(parent.id, a.id, ma.id), true);
    assert.equal(schools.isLinked(parent.id, b.id, ma.id), false, 'wrong school');
    assert.equal(schools.isLinked(parent2.id, a.id, ma.id), false, 'other parent');
    assert.equal(schools.isLinked(undefined, a.id, ma.id), false);

    const inv2 = schools.createInvite({ schoolId: a.id, memberId: ma.id, actor: 'x' });
    const l2 = schools.redeemInvite({ parentId: parent2.id, code: inv2.code });
    schools.decideLink({ schoolId: a.id, linkId: l2.id, approve: false, actor: 'x' });
    assert.equal(schools.isLinked(parent2.id, a.id, ma.id), false, 'REJECTED grants nothing');
  });

  test('parentChildren lists APPROVED children across two schools, with card summary', () => {
    schools.issueCard({ schoolId: a.id, memberId: ma.id, uid: '04AA0001', actor: 'x' });
    const la = approveVia(a.id, ma.id, parent.id);
    ctx.clock.advance(MINUTE);
    const lb = approveVia(b.id, mb.id, parent.id);
    // a pending link to a third child does not show
    const mc = schools.addMember({ schoolId: a.id, memberNo: 'S2', name: 'Pending Child' });
    const inv = schools.createInvite({ schoolId: a.id, memberId: mc.id, actor: 'x' });
    schools.redeemInvite({ parentId: parent.id, code: inv.code });

    const kids = schools.parentChildren(parent.id);
    assert.equal(kids.length, 2);
    assert.deepEqual(kids[0], {
      linkId: la.id,
      schoolId: a.id,
      schoolCode: 'smk-alpha',
      schoolName: 'SMK Alpha (fictional)',
      memberId: ma.id,
      name: 'Alpha Child',
      className: '4 Bestari',
      card: { uid: '04AA0001', last4: '0001', status: 'ACTIVE' },
    });
    assert.equal(kids[1].linkId, lb.id);
    assert.equal(kids[1].schoolCode, 'smk-beta');
    assert.equal(kids[1].card, null);
    assert.deepEqual(schools.parentChildren(parent2.id), []);
    assert.deepEqual(schools.parentChildren('par_missing'), []);
  });

  test('parentLinks lists every link of the parent with its status', () => {
    approveVia(a.id, ma.id, parent.id);
    const inv = schools.createInvite({ schoolId: b.id, memberId: mb.id, actor: 'x' });
    const lb = schools.redeemInvite({ parentId: parent.id, code: inv.code });
    schools.decideLink({ schoolId: b.id, linkId: lb.id, approve: false, actor: 'x' });
    const links = schools.parentLinks(parent.id);
    assert.deepEqual(links.map((l) => [l.schoolCode, l.name, l.status]), [
      ['smk-alpha', 'Alpha Child', 'APPROVED'],
      ['smk-beta', 'Beta Child', 'REJECTED'],
    ]);
    assert.equal(links[1].linkId, lb.id);
    assert.deepEqual(schools.parentLinks(parent2.id), []);
  });
});

describe('audit', () => {
  let ctx, schools, a, b;
  beforeEach(() => ({ ctx, schools, a, b } = setup()));

  test('audit writes a row and emits an audit event with the school code', () => {
    ctx.clock.advance(MINUTE);
    const row = schools.audit(a.id, 'staff:stf_1', 'test.action', { n: 1 });
    assert.equal(row.action, 'test.action');
    assert.equal(row.actor, 'staff:stf_1');
    assert.deepEqual(row.detail, { n: 1 });
    assert.equal(row.at, ctx.clock.now());
    assert.deepEqual(schools.listAudit(a.id)[0], row);
    const ev = eventsOf(ctx, 'audit').at(-1);
    assert.equal(ev.school, 'smk-alpha');
    assert.deepEqual(ev.data, { actor: 'staff:stf_1', action: 'test.action', detail: { n: 1 } });
  });

  test('actor may be a staff object; missing actor is "system"', () => {
    assert.equal(schools.audit(a.id, { id: 'stf_1', name: 'Puan Test' }, 'x.y').actor, 'Puan Test (stf_1)');
    assert.equal(schools.audit(a.id, undefined, 'x.z').actor, 'system');
    assert.equal(schools.audit(a.id, 'staff:x', 'x.w').detail, null);
  });

  test('listAudit: newest first, limit, and per school', () => {
    for (let i = 0; i < 5; i++) schools.audit(a.id, 'x', `step.${i}`);
    schools.audit(b.id, 'x', 'beta.only');
    const rows = schools.listAudit(a.id, 3);
    assert.deepEqual(rows.map((r) => r.action), ['step.4', 'step.3', 'step.2']);
    assert.ok(schools.listAudit(a.id).every((r) => r.schoolId === a.id));
    assert.ok(!schools.listAudit(a.id).some((r) => r.action === 'beta.only'));
    assert.equal(schools.listAudit(b.id)[0].action, 'beta.only');
  });
});
