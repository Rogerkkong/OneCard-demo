import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx } from '../helpers.js';
import { createSchools } from '../../src/platform/schools.js';
import { createDevices } from '../../src/platform/devices.js';
import { createConfigs } from '../../src/platform/configs.js';
import { seedDemo, DEMO_SCHOOLS, DEMO_PARENTS, START_PLAN } from '../../src/lab/seed.js';
import { cardDigest } from '../../src/shared/crypto.js';

// The seed only needs these three services; the full platform facade is not required.
function fakePlatform(ctx) {
  const schools = createSchools(ctx);
  return { services: { schools, devices: createDevices(ctx), configs: createConfigs(ctx, { schools }) } };
}

test('seeds two schools with staff, members with cards, machines and versioned settings', () => {
  const ctx = createTestCtx();
  const platform = fakePlatform(ctx);
  const out = seedDemo(platform);
  const { schools, devices, configs } = platform.services;

  assert.deepEqual(out.schools.map((s) => s.code), ['smk-contoh', 'sjkc-contoh']);
  for (const [i, s] of out.schools.entries()) {
    const spec = DEMO_SCHOOLS[i];
    assert.deepEqual(s.staff.map((p) => p.role).sort(), ['ADMIN', 'FINANCE', 'OFFICE']);
    assert.equal(s.members.length, spec.members.length);
    for (const m of s.members) {
      const card = schools.activeCardForMember(s.id, m.id);
      assert.equal(card.uid, m.cardUid);
      assert.equal(card.digest, cardDigest(s.cardKey, s.code, m.cardUid));
    }
    assert.deepEqual(s.devices.map((d) => d.code), spec.devices.map((d) => d.code));
    for (const d of s.devices) {
      assert.match(d.secret, /^[0-9a-f]{64}$/);
      assert.equal(devices.getDeviceByCode(s.id, d.code).type, d.type);
    }
    // a machine refuses every card until it holds a block list, so every school starts with version 1
    assert.equal(configs.current(s.id, 'prices').version, 1);
    assert.equal(configs.current(s.id, 'settings').version, 1);
    assert.deepEqual(configs.currentBlockList(s.id), { version: 1, entries: [] });
    assert.deepEqual(configs.packs(s.id).map((p) => [p.kind, p.version]).sort(), [['blocklist', 1], ['prices', 1], ['settings', 1]]);
  }
  ctx.db.close();
});

test('parents are linked (approved) to their children, across schools where needed', () => {
  const ctx = createTestCtx();
  const platform = fakePlatform(ctx);
  const out = seedDemo(platform);
  const { schools } = platform.services;
  assert.equal(out.parents.length, DEMO_PARENTS.length);
  const lee = out.parents.find((p) => p.name === 'Lee Kah Seng');
  const children = schools.parentChildren(lee.id);
  assert.deepEqual(children.map((c) => c.schoolCode).sort(), ['sjkc-contoh', 'smk-contoh']);
  for (const p of out.parents) assert.match(p.email, /@example\.com$/);
  ctx.db.close();
});

test('leaves one open invitation per school and a start plan that names real members', () => {
  const ctx = createTestCtx();
  const out = seedDemo(fakePlatform(ctx));
  for (const s of out.schools) {
    assert.match(s.openInvite.code, /^[23456789A-HJ-NP-Z]{8}$/);
    assert.ok(s.members.some((m) => m.memberNo === s.openInvite.memberNo));
  }
  for (const step of START_PLAN) {
    const s = out.schools.find((x) => x.code === step.school);
    assert.ok(s && s.members.some((m) => m.memberNo === step.memberNo), `${step.school}/${step.memberNo}`);
  }
  ctx.db.close();
});
