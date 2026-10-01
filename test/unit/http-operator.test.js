import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { createHttpServer } from '../../src/http/server.js';

// The SaaS operator's API. The schools, staff and machines are the fictional demo seed plus a
// fictional third school onboarded in the tests.

async function startLab(t) {
  const ctx = createTestCtx();
  const platform = createPlatform(ctx);
  const seed = seedDemo(platform);
  const lab = { ctx, platform, server: { up: true } };
  const server = createHttpServer({ lab });
  const { url } = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return { ctx, platform, seed, lab, url };
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
  return { jar, get: (p) => call('GET', p), post: (p, json = {}) => call('POST', p, { json }) };
}

async function operator(url) {
  const b = browser(url);
  const res = await b.post('/api/operator/login');
  assert.equal(res.status, 200);
  return b;
}

const staffOf = (seed, schoolCode, role) => seed.schools.find((s) => s.code === schoolCode).staff.find((p) => p.role === role);

const THIRD_SCHOOL = {
  code: 'smk-teladan',
  name: 'SMK Teladan (fictional)',
  staff: [
    { name: 'Rosnah Teladan', role: 'ADMIN' },
    { name: 'Yap Teladan', role: 'OFFICE' },
  ],
  devices: [
    { code: 'CANTEEN-01', type: 'CANTEEN', location: 'Canteen' },
    { code: 'WATER-01', type: 'WATER', location: 'Hall' },
    { code: 'KIOSK-01', type: 'KIOSK', location: 'Office' },
  ],
  demoMembers: 3,
};

describe('operator session', () => {
  test('login, me, logout; the one operator account', async (t) => {
    const { url } = await startLab(t);
    const b = browser(url);
    assert.equal((await b.get('/api/operator/me')).status, 401);
    const login = await b.post('/api/operator/login');
    assert.deepEqual(login.data, { operator: { id: 'operator', name: 'OneCard platform operator' } });
    assert.deepEqual((await b.get('/api/operator/me')).data, { operator: { id: 'operator', name: 'OneCard platform operator' } });
    assert.equal((await b.post('/api/operator/logout')).status, 200);
    const after = await b.get('/api/operator/me');
    assert.equal(after.status, 401);
    assert.equal(after.data.error.code, 'NOT_SIGNED_IN');
  });

  test('staff and parents are not the operator, and the operator is not a school\'s staff', async (t) => {
    const { url, seed } = await startLab(t);
    const staff = browser(url);
    await staff.post('/api/admin/login', { staffId: staffOf(seed, 'smk-contoh', 'ADMIN').id });
    assert.equal((await staff.get('/api/operator/schools')).status, 401);
    const parent = browser(url);
    await parent.post('/api/parent/login', { parentId: seed.parents[0].id });
    assert.equal((await parent.get('/api/operator/health')).status, 401);
    const op = await operator(url);
    assert.equal((await op.get('/api/admin/members')).status, 401);
    assert.equal((await op.get('/api/admin/overview')).status, 401);
  });
});

describe('operator: tenants', () => {
  test('GET schools lists every school with its numbers', async (t) => {
    const { url, seed } = await startLab(t);
    const op = await operator(url);
    const res = await op.get('/api/operator/schools');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.map((s) => s.code), ['smk-contoh', 'sjkc-contoh']);
    const smk = res.data[0];
    assert.equal(smk.id, seed.schools[0].id);
    assert.equal(smk.name, 'SMK Seri Contoh');
    assert.equal(smk.status, 'ACTIVE');
    assert.equal(smk.members, 7);
    assert.equal(smk.cards, 7);
    assert.deepEqual(smk.devices, { total: 4, online: 0 });
    for (const field of ['todaySalesSen', 'waitingSen', 'openDifferences', 'createdAt']) assert.equal(typeof smk[field], 'number', field);
  });

  test('onboarding a school: machines and their secrets once, default settings, its own staff only see it', async (t) => {
    const { url, platform, ctx } = await startLab(t);
    const op = await operator(url);
    const res = await op.post('/api/operator/schools', THIRD_SCHOOL);
    assert.equal(res.status, 201);
    assert.equal(res.data.school.code, 'smk-teladan');
    assert.equal(res.data.school.name, 'SMK Teladan (fictional)');
    assert.equal(res.data.school.status, 'ACTIVE');
    assert.deepEqual(res.data.devices.map((d) => [d.code, d.type, d.location]), [
      ['CANTEEN-01', 'CANTEEN', 'Canteen'],
      ['WATER-01', 'WATER', 'Hall'],
      ['KIOSK-01', 'KIOSK', 'Office'],
    ]);
    for (const d of res.data.devices) assert.match(d.secret, /^[0-9a-f]{64}$/);
    assert.equal(res.data.members, 3);
    assert.equal(res.data.published, false, 'no broker in this test');
    assert.deepEqual(res.data.staff.map((s) => s.role), ['ADMIN', 'OFFICE']);
    assert.equal(eventsOf(ctx, 'tenant.created').length, 1);
    assert.equal(eventsOf(ctx, 'device.registered').filter((e) => e.school === 'smk-teladan').length, 3);

    const list = await op.get('/api/operator/schools');
    assert.deepEqual(list.data.map((s) => s.code), ['smk-contoh', 'sjkc-contoh', 'smk-teladan']);
    const school = platform.services.schools.getSchoolByCode('smk-teladan');
    assert.equal(platform.services.configs.current(school.id, 'prices').version, 1);
    assert.equal(platform.services.configs.current(school.id, 'blocklist').version, 1);

    // its staff sign in to the school office and see only their school; the secrets are not shown again
    const staff = browser(url);
    await staff.post('/api/admin/login', { staffId: res.data.staff[0].id });
    const me = await staff.get('/api/admin/me');
    assert.equal(me.data.school.code, 'smk-teladan');
    const devices = await staff.get('/api/admin/devices');
    assert.deepEqual(devices.data.map((d) => d.code), ['CANTEEN-01', 'KIOSK-01', 'WATER-01']);
    assert.doesNotMatch(devices.text, /secret/i);
    for (const d of res.data.devices) assert.equal(devices.text.includes(d.secret), false);
    const members = await staff.get('/api/admin/members');
    assert.equal(members.data.length, 3);
  });

  test('onboarding refusals: a taken code, a bad code, a bad list', async (t) => {
    const { url, platform } = await startLab(t);
    const op = await operator(url);
    const taken = await op.post('/api/operator/schools', { code: 'smk-contoh', name: 'Again' });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.error.code, 'SCHOOL_CODE_TAKEN');
    const bad = await op.post('/api/operator/schools', { code: 'Not A Code', name: 'Bad' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'SCHOOL_CODE_INVALID');
    const badMachine = await op.post('/api/operator/schools', { code: 'smk-sampel', name: 'Sampel', devices: [{ code: 'X', type: 'TOASTER' }] });
    assert.equal(badMachine.status, 400);
    assert.equal(badMachine.data.error.code, 'DEVICE_TYPE_INVALID');
    assert.equal(platform.services.schools.getSchoolByCode('smk-sampel'), null, 'nothing half-made');
    const badCount = await op.post('/api/operator/schools', { code: 'smk-ujian', name: 'Ujian', demoMembers: 'many' });
    assert.equal(badCount.status, 400);
    assert.equal(badCount.data.error.code, 'TENANT_INVALID');
  });

  test('suspending a school blocks its staff and its parents only; reactivating lets them back', async (t) => {
    const { url, seed, ctx } = await startLab(t);
    const op = await operator(url);
    const sjkcStaff = browser(url);
    await sjkcStaff.post('/api/admin/login', { staffId: staffOf(seed, 'sjkc-contoh', 'OFFICE').id });
    const smkStaff = browser(url);
    await smkStaff.post('/api/admin/login', { staffId: staffOf(seed, 'smk-contoh', 'OFFICE').id });
    const leeKahSeng = seed.parents.find((p) => p.name === 'Lee Kah Seng');
    const parent = browser(url);
    await parent.post('/api/parent/login', { parentId: leeKahSeng.id });
    const children = (await parent.get('/api/parent/children')).data.children;
    const smkChild = children.find((c) => c.schoolCode === 'smk-contoh');
    const sjkcChild = children.find((c) => c.schoolCode === 'sjkc-contoh');

    const suspend = await op.post('/api/operator/schools/sjkc-contoh/status', { status: 'SUSPENDED' });
    assert.equal(suspend.status, 200);
    assert.equal(suspend.data.status, 'SUSPENDED');
    assert.equal(suspend.data.code, 'sjkc-contoh');
    assert.equal(eventsOf(ctx, 'school.status').at(-1).data.status, 'SUSPENDED');

    const blocked = await sjkcStaff.get('/api/admin/me');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'SCHOOL_SUSPENDED');
    const relogin = await browser(url).post('/api/admin/login', { staffId: staffOf(seed, 'sjkc-contoh', 'ADMIN').id });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.data.error.code, 'SCHOOL_SUSPENDED');
    assert.equal((await smkStaff.get('/api/admin/me')).status, 200, 'the other school carries on');

    const sjkcBalance = await parent.get(`/api/parent/children/${sjkcChild.schoolId}/${sjkcChild.memberId}/balance`);
    assert.equal(sjkcBalance.status, 403);
    assert.equal(sjkcBalance.data.error.code, 'SCHOOL_SUSPENDED');
    assert.equal((await parent.get(`/api/parent/children/${smkChild.schoolId}/${smkChild.memberId}/balance`)).status, 200);
    const list = (await parent.get('/api/parent/children')).data.children;
    assert.equal(list.find((c) => c.schoolCode === 'sjkc-contoh').schoolStatus, 'SUSPENDED');

    const overview = await op.get('/api/operator/schools');
    assert.equal(overview.data.find((s) => s.code === 'sjkc-contoh').status, 'SUSPENDED');

    const back = await op.post('/api/operator/schools/sjkc-contoh/status', { status: 'ACTIVE' });
    assert.equal(back.data.status, 'ACTIVE');
    assert.equal((await sjkcStaff.get('/api/admin/me')).status, 200);
    assert.equal((await parent.get(`/api/parent/children/${sjkcChild.schoolId}/${sjkcChild.memberId}/balance`)).status, 200);
  });

  test('status refusals: unknown school 404, unknown status 400', async (t) => {
    const { url } = await startLab(t);
    const op = await operator(url);
    const unknown = await op.post('/api/operator/schools/no-such-school/status', { status: 'SUSPENDED' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.error.code, 'SCHOOL_NOT_FOUND');
    const bad = await op.post('/api/operator/schools/smk-contoh/status', { status: 'CLOSED' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'SCHOOL_STATUS_INVALID');
  });
});

describe('operator: health', () => {
  test('server up, the platform link, broker connections per school and the number of schools', async (t) => {
    const { url, lab } = await startLab(t);
    const op = await operator(url);
    const without = await op.get('/api/operator/health');
    assert.equal(without.status, 200);
    assert.deepEqual(without.data.server, { up: true });
    assert.deepEqual(without.data.broker, { up: false, clients: 0, bySchool: { 'smk-contoh': 0, 'sjkc-contoh': 0 }, other: 0 });
    assert.equal(without.data.schools, 2);
    assert.equal(without.data.platform.mqtt.connected, false);

    // the lab's broker (startBroker) reports its logged-in clients
    lab.broker = {
      clients: () => [
        { clientId: 'onecard-platform', username: 'platform' },
        { clientId: 'smk-contoh.CANTEEN-01', username: 'smk-contoh.CANTEEN-01' },
        { clientId: 'smk-contoh.KIOSK-01', username: 'smk-contoh.KIOSK-01' },
        { clientId: 'sjkc-contoh.KIOSK-01', username: 'sjkc-contoh.KIOSK-01' },
        { clientId: 'mqtt-explorer', username: 'viewer' },
      ],
    };
    const withBroker = await op.get('/api/operator/health');
    assert.deepEqual(withBroker.data.broker, { up: true, clients: 5, bySchool: { 'smk-contoh': 2, 'sjkc-contoh': 1 }, other: 2 });

    // a broker that is shutting down
    lab.broker = {
      clients() {
        throw new Error('closed');
      },
    };
    assert.equal((await op.get('/api/operator/health')).data.broker.up, false);
  });
});
