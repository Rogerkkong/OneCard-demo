import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createSchools } from '../../src/platform/schools.js';
import { createDevices, NONCE_TTL_MS } from '../../src/platform/devices.js';
import { brokerPassword } from '../../src/shared/crypto.js';
import { REFUSAL } from '../../src/shared/protocol.js';
import { MINUTE, toIso } from '../../src/shared/time.js';

// All school and device names below are fictional.

/** assert.throws matcher for a LabError code (and optional HTTP status). */
const code = (c, status) => (err) => {
  assert.equal(err.name, 'LabError', `expected LabError ${c}, got ${err}`);
  assert.equal(err.code, c);
  if (status !== undefined) assert.equal(err.status, status);
  return true;
};

const DTO_KEYS = ['code', 'createdAt', 'fwVersion', 'health', 'id', 'lastHeartbeatAt', 'lastSeq', 'location', 'online', 'schoolId', 'status', 'type'];

// Every test opens its own in-memory database; close each one when the test ends.
const opened = [];
afterEach(() => {
  for (const ctx of opened.splice(0)) ctx.db.close();
});

function setup(ctxOptions) {
  const ctx = createTestCtx(ctxOptions);
  opened.push(ctx);
  const schools = createSchools(ctx);
  const devices = createDevices(ctx);
  const a = schools.createSchool({ code: 'smk-alpha', name: 'SMK Alpha (fictional)' });
  const b = schools.createSchool({ code: 'smk-beta', name: 'SMK Beta (fictional)' });
  return { ctx, schools, devices, a, b };
}

const nonce = (n) => `nonce-${String(n).padStart(16, '0')}`;

describe('registerDevice', () => {
  let ctx, schools, devices, a, b;
  beforeEach(() => ({ ctx, schools, devices, a, b } = setup()));

  test('returns the device DTO and the secret once', () => {
    const { device, secret } = devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', location: 'Canteen block A', actor: 'staff:x' });
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(device).sort(), DTO_KEYS);
    assert.match(device.id, /^dev_/);
    assert.equal(device.schoolId, a.id);
    assert.equal(device.code, 'CANTEEN-01');
    assert.equal(device.type, 'CANTEEN');
    assert.equal(device.location, 'Canteen block A');
    assert.equal(device.status, 'ACTIVE');
    assert.equal(device.lastSeq, 0);
    assert.equal(device.lastHeartbeatAt, null);
    assert.equal(device.fwVersion, null);
    assert.equal(device.health, null);
    assert.equal(device.online, false);
    assert.equal(device.createdAt, ctx.clock.now());
  });

  test('each device gets its own secret, and no DTO or audit row carries it', () => {
    const r1 = devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' });
    const r2 = devices.registerDevice({ schoolId: a.id, code: 'KIOSK-01', type: 'KIOSK', actor: 'x' });
    assert.notEqual(r1.secret, r2.secret);
    const everything = JSON.stringify([
      r1.device,
      devices.getDevice(a.id, r1.device.id),
      devices.getDeviceByCode(a.id, 'CANTEEN-01'),
      devices.listDevices(a.id),
      devices.resolveByCodes('smk-alpha', 'CANTEEN-01').device,
      schools.listAudit(a.id),
      eventsOf(ctx, 'audit'),
    ]);
    assert.ok(!everything.includes(r1.secret));
    assert.ok(!everything.includes(r2.secret));
    assert.ok(!everything.includes('"secret"'));
  });

  test('writes an audit row with the school code on the event', () => {
    const { device } = devices.registerDevice({ schoolId: a.id, code: 'WATER-01', type: 'WATER', actor: 'staff:stf_1' });
    const row = schools.listAudit(a.id)[0];
    assert.equal(row.action, 'device.register');
    assert.equal(row.actor, 'staff:stf_1');
    assert.equal(row.detail.deviceId, device.id);
    assert.equal(row.detail.code, 'WATER-01');
    const ev = eventsOf(ctx, 'audit').at(-1);
    assert.equal(ev.school, 'smk-alpha');
    assert.equal(ev.data.action, 'device.register');
  });

  test('office input in lower case is stored upper case; location defaults to empty', () => {
    const { device } = devices.registerDevice({ schoolId: a.id, code: ' water-02 ', type: 'water', actor: 'x' });
    assert.equal(device.code, 'WATER-02');
    assert.equal(device.type, 'WATER');
    assert.equal(device.location, '');
  });

  test('DEVICE_CODE_INVALID', () => {
    for (const bad of ['', '-CANTEEN', 'CANTEEN-', 'CANTEEN 01', 'CANTEEN_01', 'X'.repeat(33), null, 7]) {
      assert.throws(() => devices.registerDevice({ schoolId: a.id, code: bad, type: 'CANTEEN', actor: 'x' }), code('DEVICE_CODE_INVALID', 400), String(bad));
    }
  });

  test('DEVICE_TYPE_INVALID', () => {
    for (const bad of ['PRINTER', '', null, undefined]) {
      assert.throws(() => devices.registerDevice({ schoolId: a.id, code: 'X-01', type: bad, actor: 'x' }), code('DEVICE_TYPE_INVALID', 400), String(bad));
    }
  });

  test('DEVICE_CODE_TAKEN (409) within a school; the same code is fine in another school', () => {
    devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' });
    assert.throws(() => devices.registerDevice({ schoolId: a.id, code: 'canteen-01', type: 'WATER', actor: 'x' }), code('DEVICE_CODE_TAKEN', 409));
    const other = devices.registerDevice({ schoolId: b.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' });
    assert.equal(other.device.schoolId, b.id);
    assert.equal(devices.listDevices(a.id).length, 1);
  });

  test('SCHOOL_NOT_FOUND and LOCATION_INVALID', () => {
    assert.throws(() => devices.registerDevice({ schoolId: 'sch_missing', code: 'X-01', type: 'KIOSK', actor: 'x' }), code('SCHOOL_NOT_FOUND', 404));
    assert.throws(() => devices.registerDevice({ schoolId: a.id, code: 'X-01', type: 'KIOSK', location: 'x'.repeat(81), actor: 'x' }), code('LOCATION_INVALID'));
    assert.throws(() => devices.registerDevice({ schoolId: a.id, code: 'X-01', type: 'KIOSK', location: 5, actor: 'x' }), code('LOCATION_INVALID'));
  });
});

describe('lookups and tenant isolation', () => {
  let devices, schools, a, b, canteen, kioskB;
  beforeEach(() => {
    ({ devices, schools, a, b } = setup());
    canteen = devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' });
    devices.registerDevice({ schoolId: a.id, code: 'WATER-01', type: 'WATER', actor: 'x' });
    devices.registerDevice({ schoolId: a.id, code: 'KIOSK-01', type: 'KIOSK', actor: 'x' });
    kioskB = devices.registerDevice({ schoolId: b.id, code: 'KIOSK-01', type: 'KIOSK', actor: 'x' });
  });

  test('getDevice, getDeviceByCode, listDevices (sorted by code)', () => {
    assert.deepEqual(devices.getDevice(a.id, canteen.device.id), canteen.device);
    assert.deepEqual(devices.getDeviceByCode(a.id, 'CANTEEN-01'), canteen.device);
    assert.deepEqual(devices.getDeviceByCode(a.id, 'canteen-01'), canteen.device);
    assert.deepEqual(devices.listDevices(a.id).map((d) => d.code), ['CANTEEN-01', 'KIOSK-01', 'WATER-01']);
    assert.deepEqual(devices.listDevices(b.id).map((d) => d.code), ['KIOSK-01']);
    assert.equal(devices.getDevice(a.id, 'dev_missing'), null);
    assert.equal(devices.getDeviceByCode(a.id, 'NOPE-01'), null);
    assert.equal(devices.getDeviceByCode(a.id, undefined), null);
  });

  test('another school cannot see or change the device', () => {
    assert.equal(devices.getDevice(b.id, canteen.device.id), null);
    assert.equal(devices.getDeviceByCode(b.id, 'CANTEEN-01'), null);
    assert.equal(devices.getDevice(undefined, canteen.device.id), null);
    // a missing school id lists nothing instead of crashing the query
    assert.deepEqual(devices.listDevices(undefined), []);
    assert.deepEqual(devices.listDevices(''), []);
    // same code, different school: each school sees its own
    assert.equal(devices.getDeviceByCode(b.id, 'KIOSK-01').id, kioskB.device.id);
    assert.notEqual(devices.getDeviceByCode(a.id, 'KIOSK-01').id, kioskB.device.id);
    assert.throws(() => devices.setDeviceStatus({ schoolId: b.id, code: 'CANTEEN-01', status: 'DISABLED', actor: 'x' }), code('DEVICE_NOT_FOUND', 404));
    assert.equal(devices.getDevice(a.id, canteen.device.id).status, 'ACTIVE');
  });

  test('resolveByCodes returns the school DTO (with status), the device and its secret', () => {
    const r = devices.resolveByCodes('smk-alpha', 'CANTEEN-01');
    assert.deepEqual(Object.keys(r).sort(), ['device', 'school', 'secret']);
    assert.deepEqual(r.school, schools.getSchool(a.id));
    assert.equal(r.school.status, 'ACTIVE');
    assert.ok(!JSON.stringify(r.school).includes(schools.schoolCardKey(a.id)), 'no card key in the school DTO');
    assert.deepEqual(r.device, canteen.device);
    assert.equal(r.secret, canteen.secret);
    // the same device code in the other school resolves to that school's device
    const rb = devices.resolveByCodes('smk-beta', 'KIOSK-01');
    assert.equal(rb.device.id, kioskB.device.id);
    assert.equal(rb.secret, kioskB.secret);
    // status changes show through
    schools.setSchoolStatus(a.id, 'SUSPENDED', 'x');
    devices.setDeviceStatus({ schoolId: a.id, code: 'CANTEEN-01', status: 'DISABLED', actor: 'x' });
    const r2 = devices.resolveByCodes('smk-alpha', 'CANTEEN-01');
    assert.equal(r2.school.status, 'SUSPENDED');
    assert.equal(r2.device.status, 'DISABLED');
  });

  test('resolveByCodes returns null for unknown or mismatched codes (exact match only)', () => {
    assert.equal(devices.resolveByCodes('smk-none', 'CANTEEN-01'), null);
    assert.equal(devices.resolveByCodes('smk-alpha', 'CANTEEN-99'), null);
    assert.equal(devices.resolveByCodes('smk-beta', 'CANTEEN-01'), null, 'device of another school');
    assert.equal(devices.resolveByCodes('smk-alpha', 'canteen-01'), null, 'codes are identities, not office input');
    assert.equal(devices.resolveByCodes('SMK-ALPHA', 'CANTEEN-01'), null);
    assert.equal(devices.resolveByCodes(undefined, 'CANTEEN-01'), null);
    assert.equal(devices.resolveByCodes('smk-alpha', null), null);
  });
});

describe('setDeviceStatus', () => {
  let devices, schools, a;
  beforeEach(() => {
    ({ devices, schools, a } = setup());
    devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' });
  });

  test('changes the status and writes an audit row', () => {
    const d = devices.setDeviceStatus({ schoolId: a.id, code: 'CANTEEN-01', status: 'MAINTENANCE', actor: 'staff:x' });
    assert.equal(d.status, 'MAINTENANCE');
    const row = schools.listAudit(a.id)[0];
    assert.equal(row.action, 'device.status');
    assert.deepEqual([row.detail.from, row.detail.to], ['ACTIVE', 'MAINTENANCE']);
    assert.equal(devices.setDeviceStatus({ schoolId: a.id, code: 'canteen-01', status: 'DISABLED', actor: 'x' }).status, 'DISABLED');
    assert.equal(devices.setDeviceStatus({ schoolId: a.id, code: 'CANTEEN-01', status: 'ACTIVE', actor: 'x' }).status, 'ACTIVE');
  });

  test('same status again writes no audit row', () => {
    const before = schools.listAudit(a.id).length;
    devices.setDeviceStatus({ schoolId: a.id, code: 'CANTEEN-01', status: 'ACTIVE', actor: 'x' });
    assert.equal(schools.listAudit(a.id).length, before);
  });

  test('DEVICE_STATUS_INVALID and DEVICE_NOT_FOUND', () => {
    assert.throws(() => devices.setDeviceStatus({ schoolId: a.id, code: 'CANTEEN-01', status: 'BROKEN', actor: 'x' }), code('DEVICE_STATUS_INVALID'));
    assert.throws(() => devices.setDeviceStatus({ schoolId: a.id, code: 'NOPE-01', status: 'ACTIVE', actor: 'x' }), code('DEVICE_NOT_FOUND', 404));
  });
});

describe('recordHeartbeat and the online flag', () => {
  let ctx, devices, a, dev;
  beforeEach(() => {
    ({ ctx, devices, a } = setup());
    dev = devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' }).device;
  });

  test('online while the last heartbeat is within heartbeatOnlineMs (90 s), using the lab clock', () => {
    const t0 = ctx.clock.now();
    const d = devices.recordHeartbeat({ deviceId: dev.id, at: t0, fw: 'lab-1.0.0', health: 'OK' });
    assert.equal(d.lastHeartbeatAt, t0);
    assert.equal(d.fwVersion, 'lab-1.0.0');
    assert.equal(d.health, 'OK');
    assert.equal(d.online, true);
    ctx.clock.advance(90_000);
    assert.equal(devices.getDevice(a.id, dev.id).online, true, 'exactly 90 s is still within');
    ctx.clock.advance(1);
    assert.equal(devices.getDevice(a.id, dev.id).online, false);
    assert.equal(devices.listDevices(a.id)[0].online, false);
    devices.recordHeartbeat({ deviceId: dev.id, at: ctx.clock.now(), fw: 'lab-1.0.0', health: 'WARN' });
    const back = devices.getDevice(a.id, dev.id);
    assert.equal(back.online, true);
    assert.equal(back.health, 'WARN');
  });

  test('uses ctx.settings.heartbeatOnlineMs, and 90000 when it is missing', () => {
    ctx.settings.heartbeatOnlineMs = 1000;
    devices.recordHeartbeat({ deviceId: dev.id });
    ctx.clock.advance(1001);
    assert.equal(devices.getDevice(a.id, dev.id).online, false);

    delete ctx.settings.heartbeatOnlineMs;
    devices.recordHeartbeat({ deviceId: dev.id });
    ctx.clock.advance(90_000);
    assert.equal(devices.getDevice(a.id, dev.id).online, true);
    ctx.clock.advance(1);
    assert.equal(devices.getDevice(a.id, dev.id).online, false);
  });

  test('at may be an ISO string (the envelope time); missing at means now', () => {
    ctx.clock.advance(MINUTE);
    const iso = toIso(ctx.clock.now() - 10_000);
    assert.equal(devices.recordHeartbeat({ deviceId: dev.id, at: iso }).lastHeartbeatAt, ctx.clock.now() - 10_000);
    ctx.clock.advance(1000);
    assert.equal(devices.recordHeartbeat({ deviceId: dev.id }).lastHeartbeatAt, ctx.clock.now());
    ctx.clock.advance(1000);
    assert.equal(devices.recordHeartbeat({ deviceId: dev.id, at: 'not a time' }).lastHeartbeatAt, ctx.clock.now());
  });

  test('a time ahead of the lab clock counts as now', () => {
    const d = devices.recordHeartbeat({ deviceId: dev.id, at: ctx.clock.now() + 3_600_000 });
    assert.equal(d.lastHeartbeatAt, ctx.clock.now());
    ctx.clock.advance(90_001);
    assert.equal(devices.getDevice(a.id, dev.id).online, false);
  });

  test('an older heartbeat than the stored one changes nothing; fw is kept when not reported', () => {
    ctx.clock.advance(MINUTE);
    const now = ctx.clock.now();
    devices.recordHeartbeat({ deviceId: dev.id, at: now, fw: 'lab-2.0.0', health: 'OK' });
    const d = devices.recordHeartbeat({ deviceId: dev.id, at: now - 30_000, fw: 'lab-1.0.0', health: 'WARN' });
    assert.equal(d.lastHeartbeatAt, now);
    assert.equal(d.fwVersion, 'lab-2.0.0');
    assert.equal(d.health, 'OK');
    ctx.clock.advance(1000);
    const d2 = devices.recordHeartbeat({ deviceId: dev.id, health: 'WARN' });
    assert.equal(d2.fwVersion, 'lab-2.0.0');
    assert.equal(d2.health, 'WARN');
  });

  test('DEVICE_NOT_FOUND for an unknown device', () => {
    assert.throws(() => devices.recordHeartbeat({ deviceId: 'dev_missing', at: ctx.clock.now() }), code('DEVICE_NOT_FOUND', 404));
    assert.throws(() => devices.recordHeartbeat({}), code('DEVICE_NOT_FOUND', 404));
  });
});

describe('claimSeq', () => {
  let devices, a, dev, other;
  beforeEach(() => {
    ({ devices, a } = setup());
    dev = devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' }).device;
    other = devices.registerDevice({ schoolId: a.id, code: 'WATER-01', type: 'WATER', actor: 'x' }).device;
  });

  test('stores seq only when it is higher than the last one; otherwise ROLLBACK', () => {
    assert.equal(devices.claimSeq(dev.id, 1), 'OK');
    assert.equal(devices.getDevice(a.id, dev.id).lastSeq, 1);
    assert.equal(devices.claimSeq(dev.id, 1), 'ROLLBACK', 'same seq again');
    assert.equal(devices.claimSeq(dev.id, 5), 'OK', 'gaps are fine');
    assert.equal(devices.claimSeq(dev.id, 3), 'ROLLBACK');
    assert.equal(devices.claimSeq(dev.id, 0), 'ROLLBACK');
    assert.equal(devices.claimSeq(dev.id, -1), 'ROLLBACK');
    assert.equal(devices.getDevice(a.id, dev.id).lastSeq, 5, 'a rollback does not store');
    assert.equal(devices.claimSeq(dev.id, 6), 'OK');
    assert.equal(devices.getDevice(a.id, dev.id).lastSeq, 6);
  });

  test('sequences are per device', () => {
    devices.claimSeq(dev.id, 100);
    assert.equal(devices.claimSeq(other.id, 1), 'OK');
    assert.equal(devices.getDevice(a.id, other.id).lastSeq, 1);
  });

  test('SEQ_INVALID and DEVICE_NOT_FOUND', () => {
    for (const bad of [1.5, '2', null, undefined, NaN]) {
      assert.throws(() => devices.claimSeq(dev.id, bad), code('SEQ_INVALID'), String(bad));
    }
    assert.throws(() => devices.claimSeq('dev_missing', 1), code('DEVICE_NOT_FOUND', 404));
    assert.throws(() => devices.claimSeq(undefined, 1), code('DEVICE_NOT_FOUND', 404));
    assert.throws(() => devices.claimSeq(null, 1), code('DEVICE_NOT_FOUND', 404));
  });
});

describe('useNonce', () => {
  let ctx, devices, a, kiosk, other;
  beforeEach(() => {
    ({ ctx, devices, a } = setup());
    kiosk = devices.registerDevice({ schoolId: a.id, code: 'KIOSK-01', type: 'KIOSK', actor: 'x' }).device;
    other = devices.registerDevice({ schoolId: a.id, code: 'KIOSK-02', type: 'KIOSK', actor: 'x' }).device;
  });

  const nonceRows = () => ctx.db.get('SELECT count(*) AS n FROM request_nonce').n;

  test('fresh once, then reused', () => {
    assert.equal(devices.useNonce(kiosk.id, nonce(1)), true);
    assert.equal(devices.useNonce(kiosk.id, nonce(1)), false);
    assert.equal(devices.useNonce(kiosk.id, nonce(2)), true);
    assert.equal(devices.useNonce(other.id, nonce(1)), true, 'nonces are per device');
    assert.equal(devices.useNonce(other.id, nonce(1)), false);
  });

  test('remembered for 10 minutes of lab time, the boundary included, then purged', () => {
    assert.equal(NONCE_TTL_MS, 10 * MINUTE);
    devices.useNonce(kiosk.id, nonce(1));
    ctx.clock.advance(10 * MINUTE - 1);
    assert.equal(devices.useNonce(kiosk.id, nonce(1)), false, 'still remembered just before 10 minutes');
    devices.useNonce(kiosk.id, nonce(2)); // stored at 10 min - 1 ms
    ctx.clock.advance(1);
    // a request stamped 5 minutes ahead still passes the ±5 min timestamp check now, so this is a replay
    assert.equal(devices.useNonce(kiosk.id, nonce(1)), false, 'still a replay at exactly 10 minutes');
    assert.equal(nonceRows(), 2);
    ctx.clock.advance(1);
    assert.equal(devices.useNonce(kiosk.id, nonce(1)), true, 'fresh again once the 10 minutes are over');
    // the expired row was purged and stored again; nonce(2) is still there
    assert.equal(nonceRows(), 2);
    assert.equal(devices.useNonce(kiosk.id, nonce(2)), false);
    ctx.clock.advance(10 * MINUTE + 1);
    devices.useNonce(other.id, nonce(3));
    assert.equal(nonceRows(), 1, "another device's call purges every expired nonce, of every device");
  });

  test('NONCE_INVALID and DEVICE_NOT_FOUND', () => {
    for (const bad of ['short', 'x'.repeat(65), 'has spaces in the nonce', '', null, 12345678901234567]) {
      assert.throws(() => devices.useNonce(kiosk.id, bad), code('NONCE_INVALID', 401), String(bad));
    }
    assert.throws(() => devices.useNonce('dev_missing', nonce(1)), code('DEVICE_NOT_FOUND', 404));
    assert.equal(nonceRows(), 0);
  });
});

describe('device log', () => {
  let ctx, devices, a, b, dev, dev2, devB;
  beforeEach(() => {
    ({ ctx, devices, a, b } = setup());
    dev = devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' }).device;
    dev2 = devices.registerDevice({ schoolId: a.id, code: 'WATER-01', type: 'WATER', actor: 'x' }).device;
    devB = devices.registerDevice({ schoolId: b.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' }).device;
  });

  test('log writes an entry; the message defaults to the REFUSAL text', () => {
    ctx.clock.advance(MINUTE);
    const e = devices.log({ schoolId: a.id, deviceId: dev.id, level: 'WARN', code: 'SEQUENCE_ROLLBACK', detail: { seq: 3, lastSeq: 5 } });
    assert.deepEqual(e, {
      id: e.id,
      schoolId: a.id,
      deviceId: dev.id,
      deviceCode: 'CANTEEN-01',
      at: ctx.clock.now(),
      level: 'WARN',
      code: 'SEQUENCE_ROLLBACK',
      message: REFUSAL.SEQUENCE_ROLLBACK,
      detail: { seq: 3, lastSeq: 5 },
    });
    const custom = devices.log({ schoolId: a.id, deviceId: dev.id, code: 'BOOT', message: 'terminal started' });
    assert.equal(custom.level, 'INFO');
    assert.equal(custom.message, 'terminal started');
    assert.equal(custom.detail, null);
    assert.equal(devices.log({ schoolId: a.id, code: 'CUSTOM_CODE' }).message, 'CUSTOM_CODE');
  });

  test('listLog: newest first, filter by device, limit, per school', () => {
    devices.log({ schoolId: a.id, deviceId: dev.id, level: 'WARN', code: 'SIGNATURE_INVALID' });
    devices.log({ schoolId: a.id, deviceId: dev2.id, level: 'ERROR', code: 'RECORD_INVALID' });
    devices.log({ schoolId: a.id, deviceId: dev.id, level: 'INFO', code: 'NOTE', message: 'third' });
    devices.log({ schoolId: b.id, deviceId: devB.id, level: 'WARN', code: 'TOPIC_MISMATCH' });
    assert.deepEqual(devices.listLog(a.id).map((e) => e.code), ['NOTE', 'RECORD_INVALID', 'SIGNATURE_INVALID']);
    assert.deepEqual(devices.listLog(a.id, { deviceId: dev.id }).map((e) => e.code), ['NOTE', 'SIGNATURE_INVALID']);
    assert.deepEqual(devices.listLog(a.id, { limit: 1 }).map((e) => e.code), ['NOTE']);
    assert.deepEqual(devices.listLog(b.id).map((e) => e.code), ['TOPIC_MISMATCH']);
    // another school's device id finds nothing in this school
    assert.deepEqual(devices.listLog(a.id, { deviceId: devB.id }), []);
    // null options or an empty device filter mean "every device of the school"
    assert.equal(devices.listLog(a.id, null).length, 3);
    assert.equal(devices.listLog(a.id, { deviceId: '' }).length, 3);
  });

  test('entries without a school (unknown sender) are listed with schoolId null only', () => {
    devices.log({ level: 'WARN', code: 'UNKNOWN_DEVICE', detail: { topic: 'lab/v1/smk-none/X-01/records' } });
    const rows = devices.listLog(null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].schoolId, null);
    assert.equal(rows[0].deviceId, null);
    assert.equal(rows[0].message, REFUSAL.UNKNOWN_DEVICE);
    assert.deepEqual(devices.listLog(a.id), []);
  });

  test('log errors: LOG_LEVEL_INVALID, LOG_CODE_INVALID, DEVICE_NOT_FOUND for a device of another school', () => {
    assert.throws(() => devices.log({ schoolId: a.id, deviceId: dev.id, level: 'DEBUG', code: 'X' }), code('LOG_LEVEL_INVALID'));
    assert.throws(() => devices.log({ schoolId: a.id, deviceId: dev.id, level: 'INFO' }), code('LOG_CODE_INVALID'));
    assert.throws(() => devices.log({ schoolId: a.id, deviceId: devB.id, code: 'X' }), code('DEVICE_NOT_FOUND', 404));
    assert.throws(() => devices.log({ deviceId: dev.id, code: 'X' }), code('DEVICE_NOT_FOUND', 404));
    assert.deepEqual(devices.listLog(a.id), []);
  });
});

describe('brokerCredentials', () => {
  test('username <school>.<DEVICE>, password derived from the secret', () => {
    const { devices, a } = setup();
    const { secret } = devices.registerDevice({ schoolId: a.id, code: 'CANTEEN-01', type: 'CANTEEN', actor: 'x' });
    const creds = devices.brokerCredentials('smk-alpha', 'CANTEEN-01', secret);
    assert.deepEqual(creds, { username: 'smk-alpha.CANTEEN-01', password: brokerPassword(secret) });
    assert.notEqual(creds.password, secret, 'the signing key is never the broker password');
    assert.match(creds.password, /^[0-9a-f]{64}$/);
    // stable for the same secret, different for another
    assert.equal(devices.brokerCredentials('smk-alpha', 'CANTEEN-01', secret).password, creds.password);
    assert.notEqual(devices.brokerCredentials('smk-alpha', 'CANTEEN-01', 'cd'.repeat(32)).password, creds.password);
  });
});
