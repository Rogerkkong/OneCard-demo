import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { createHttpServer } from '../../src/http/server.js';
import { createKioskApi, KioskApiError } from '../../src/devices/kioskApi.js';
import { signRequest } from '../../src/shared/crypto.js';
import { DAY, MINUTE } from '../../src/shared/time.js';

// The kiosk's signed API (DESIGN §3 "Kiosk HTTP (signed)"): every refusal of a request, then a
// full pending → confirm → lookup round with the real kiosk client, and the admin-card packs and
// receipts. Machines, cards and members are the fictional demo seed; secrets are generated.

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
  const digestOf = (code, uid) => platform.services.schools.cardDigestFor(school(code).id, uid);
  /** The real kiosk client of a machine of the seed (or any codes and secret given). */
  const kioskApi = ({ code = 'smk-contoh', deviceCode = 'KIOSK-01', secret } = {}) =>
    createKioskApi({ baseUrl: url, schoolCode: code, deviceCode, secret: secret ?? device(code, deviceCode).secret, clock: ctx.clock, timeoutMs: 5000 });
  /**
   * A signed request built by hand, so each part can be spoiled after signing.
   * `spoil`: { path, body, headers } replace what is sent, not what was signed.
   */
  async function signed({ code = 'smk-contoh', deviceCode = 'KIOSK-01', secret, method = 'POST', path = '/api/kiosk/pending', body, timestamp, nonce, spoil = {} }) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const ts = String(timestamp ?? ctx.clock.now());
    const n = nonce ?? randomBytes(16).toString('hex');
    const key = secret ?? device(code, deviceCode)?.secret ?? 'ab'.repeat(32);
    const headers = {
      'x-lab-school': code,
      'x-lab-device': deviceCode,
      'x-lab-timestamp': ts,
      'x-lab-nonce': n,
      'x-lab-signature': signRequest({ secretHex: key, method, path, timestamp: ts, nonce: n, body: text }),
    };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(url + (spoil.path ?? path), {
      method,
      headers: { ...headers, ...spoil.headers },
      body: method === 'GET' ? undefined : (spoil.body ?? text),
    });
    return { status: res.status, data: await res.json().catch(() => null), nonce: n };
  }
  return { ctx, platform, seed, lab, url, school, member, device, digestOf, kioskApi, signed };
}

const refusedWith = (status, code) => (res) => {
  assert.equal(res.status, status, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code);
};

describe('kiosk API: request checks', () => {
  test('a well-signed request passes', async (t) => {
    const { signed, digestOf, member } = await startLab(t);
    const res = await signed({ body: { card: digestOf('smk-contoh', member('smk-contoh', 'S1001').cardUid) } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.member.name, 'Ahmad Faiz bin Rahman');
  });

  test('unsigned, badly signed, changed after signing: 401 SIGNATURE_INVALID', async (t) => {
    const { signed, digestOf, member, device, ctx, url } = await startLab(t);
    const body = { card: digestOf('smk-contoh', member('smk-contoh', 'S1001').cardUid) };
    const check = refusedWith(401, 'SIGNATURE_INVALID');
    // no signature headers at all
    const bare = await fetch(`${url}/api/kiosk/pending`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(bare.status, 401);
    assert.equal((await bare.json()).error.code, 'SIGNATURE_INVALID');
    for (const header of ['x-lab-timestamp', 'x-lab-nonce', 'x-lab-signature']) {
      check(await signed({ body, spoil: { headers: { [header]: '' } } }));
    }
    // signed with another secret (another machine's)
    check(await signed({ body, secret: device('smk-contoh', 'CANTEEN-01').secret }));
    check(await signed({ body, spoil: { headers: { 'x-lab-signature': 'A'.repeat(43) } } }));
    // the body changed after signing
    check(await signed({ body, spoil: { body: JSON.stringify({ card: body.card, max: 50 }) } }));
    check(await signed({ body, spoil: { body: `${JSON.stringify(body)} ` } }));
    // the path or its query changed after signing
    check(await signed({ body, path: '/api/kiosk/pending?x=1', spoil: { path: '/api/kiosk/pending?x=2' } }));
    check(await signed({ body, path: '/api/kiosk/pending?x=1', spoil: { path: '/api/kiosk/pending' } }));
    check(await signed({ method: 'GET', path: '/api/kiosk/confirm/KIOSK-01-000001', spoil: { path: '/api/kiosk/confirm/KIOSK-01-000002' } }));
    check(await signed({ method: 'GET', path: '/api/kiosk/packs', spoil: { headers: { 'x-lab-timestamp': String(ctx.clock.now() + 1) } } }));
    // malformed timestamp and nonce
    check(await signed({ body, timestamp: 'yesterday' }));
    check(await signed({ body, nonce: 'short' }));
    check(await signed({ body, nonce: 'has spaces in it but is long enough' }));
  });

  test('the signature covers the body bytes as sent, not their decoded text', async (t) => {
    const { url, ctx, device } = await startLab(t);
    const secret = device('smk-contoh', 'KIOSK-01').secret;
    // a GET with a body (nothing reads it, but it is signed like any other): send raw bytes
    const send = (signedBody, sentBytes) =>
      new Promise((resolve, reject) => {
        const timestamp = String(ctx.clock.now());
        const nonce = randomBytes(16).toString('hex');
        const u = new URL(url);
        const headers = {
          'x-lab-school': 'smk-contoh',
          'x-lab-device': 'KIOSK-01',
          'x-lab-timestamp': timestamp,
          'x-lab-nonce': nonce,
          'x-lab-signature': signRequest({ secretHex: secret, method: 'GET', path: '/api/kiosk/packs', timestamp, nonce, body: signedBody }),
          'content-length': sentBytes.length,
        };
        const req = http.request({ host: u.hostname, port: u.port, method: 'GET', path: '/api/kiosk/packs', headers, agent: false }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        req.on('error', reject);
        req.end(sentBytes);
      });
    // 0xFE is not UTF-8: read as text it becomes U+FFFD, the same text as 0xFF or the bytes EF BF BD
    refusedWith(401, 'SIGNATURE_INVALID')(await send('\uFFFD', Buffer.from([0xfe])));
    refusedWith(401, 'SIGNATURE_INVALID')(await send(Buffer.from([0xff]), Buffer.from([0xfe])));
    assert.equal((await send(Buffer.from([0xfe]), Buffer.from([0xfe]))).status, 200, 'the bytes that were signed pass');
  });

  test('a timestamp more than 5 minutes from the lab clock is refused, either way', async (t) => {
    const { signed, ctx } = await startLab(t);
    const body = { card: 'ab'.repeat(32) };
    const now = ctx.clock.now();
    refusedWith(401, 'SIGNATURE_INVALID')(await signed({ body, timestamp: now - 5 * MINUTE - 1 }));
    refusedWith(401, 'SIGNATURE_INVALID')(await signed({ body, timestamp: now + 5 * MINUTE + 1 }));
    // exactly 5 minutes is still fine (the card is unknown, so the request itself was accepted)
    refusedWith(404, 'CARD_NOT_FOUND')(await signed({ body, timestamp: now - 5 * MINUTE }));
    refusedWith(404, 'CARD_NOT_FOUND')(await signed({ body, timestamp: now + 5 * MINUTE }));
  });

  test('a nonce used again is 409 REPLAY, even with a fresh signature; it is fine again after 10 minutes', async (t) => {
    const { signed, ctx } = await startLab(t);
    const body = { card: 'ab'.repeat(32) };
    const first = await signed({ body });
    assert.equal(first.status, 404);
    refusedWith(409, 'REPLAY')(await signed({ body, nonce: first.nonce }));
    refusedWith(409, 'REPLAY')(await signed({ method: 'GET', path: '/api/kiosk/packs', nonce: first.nonce }));
    ctx.clock.advance(10 * MINUTE + 1);
    assert.equal((await signed({ body, nonce: first.nonce })).status, 404);
  });

  test('unknown school or machine 401 like a bad signature; a machine that is not a kiosk 403; a switched-off kiosk or suspended school 403', async (t) => {
    const { signed, lab, school, device } = await startLab(t);
    const body = { card: 'ab'.repeat(32) };
    // an unsigned caller cannot tell a real school and machine from made-up ones
    const real = await signed({ body, secret: 'ab'.repeat(32) });
    refusedWith(401, 'SIGNATURE_INVALID')(real);
    for (const made of [{ deviceCode: 'KIOSK-09' }, { code: 'no-such-school' }, { code: 'no-such-school', deviceCode: 'KIOSK-09' }]) {
      const res = await signed({ body, ...made, secret: 'ab'.repeat(32) });
      refusedWith(401, 'SIGNATURE_INVALID')(res);
      assert.deepEqual(res.data, real.data, JSON.stringify(made));
    }
    // CANTEEN-01 signs with its own secret, but only a kiosk may use the kiosk API
    refusedWith(403, 'WRONG_DEVICE_TYPE')(await signed({ body, deviceCode: 'CANTEEN-01' }));

    const smk = school('smk-contoh').id;
    await lab.platform.setDeviceStatus({ schoolId: smk, code: 'KIOSK-01', status: 'DISABLED', actor: 'test' });
    refusedWith(403, 'DEVICE_DISABLED')(await signed({ body }));
    await lab.platform.setDeviceStatus({ schoolId: smk, code: 'KIOSK-01', status: 'ACTIVE', actor: 'test' });
    await lab.platform.setSchoolStatus({ schoolId: smk, status: 'SUSPENDED', actor: 'test' });
    refusedWith(403, 'SCHOOL_SUSPENDED')(await signed({ body }));
    // the other school's kiosk carries on
    assert.equal((await signed({ body, code: 'sjkc-contoh' })).status, 404);

    // refusals of a known machine are in its device log
    const log = lab.platform.services.devices.listLog(smk, { deviceId: device('smk-contoh', 'KIOSK-01').id });
    assert.deepEqual(log.map((l) => l.code).slice(0, 2), ['SCHOOL_SUSPENDED', 'DEVICE_DISABLED']);
  });

  test('a kiosk only reaches its own school: another school\'s card is unknown to it', async (t) => {
    const { kioskApi, digestOf, member } = await startLab(t);
    const smkKiosk = kioskApi();
    const sjkcCard = digestOf('sjkc-contoh', member('sjkc-contoh', 'P101').cardUid);
    await assert.rejects(smkKiosk.pending({ card: sjkcCard }), (err) => err instanceof KioskApiError && err.code === 'CARD_NOT_FOUND' && err.status === 404);
  });

  test('the switched-off cloud server answers 503 SERVER_DOWN before any check', async (t) => {
    const { kioskApi, lab, signed } = await startLab(t);
    lab.server.up = false;
    await assert.rejects(kioskApi().packs(), (err) => err.code === 'SERVER_DOWN' && err.status === 503);
    const res = await signed({ body: { card: 'ab'.repeat(32) } });
    refusedWith(503, 'SERVER_DOWN')(res);
    lab.server.up = true;
    // the nonce was not used up while the server was off
    assert.equal((await signed({ body: { card: 'ab'.repeat(32) }, nonce: res.nonce })).status, 404);
  });
});

describe('kiosk API: a full round with the kiosk client', () => {
  test('pending → confirm → confirm again (duplicate) → lookup', async (t) => {
    const { kioskApi, lab, school, member, digestOf } = await startLab(t);
    const smk = school('smk-contoh').id;
    const wong = member('smk-contoh', 'S1005');
    const { topups, ledger } = lab.platform.services;
    const subsidy = topups.grantSubsidy({ schoolId: smk, memberId: wong.id, amountSen: 1000, actor: 'test' });
    const api = kioskApi();
    const card = digestOf('smk-contoh', wong.cardUid);

    const pending = await api.pending({ card, max: 10 });
    assert.deepEqual(pending, {
      member: { id: wong.id, name: 'Wong Jia Hui' },
      orders: [{ orderId: subsidy.id, kind: 'SUBSIDY', amountSen: 1000 }],
      mirrorBalanceSen: 0,
      waitingSen: 1000,
    });
    assert.equal(topups.getOrder(smk, subsidy.id).writeResult, 'UNCONFIRMED');

    assert.equal(await api.lookup('KIOSK-01-000001'), null, 'nothing recorded under this number yet');
    const confirm = { orderId: subsidy.id, result: 'ADDED', amountSen: 1000, card, balanceAfterOnCardSen: 1000, kioskTxn: 'KIOSK-01-000001' };
    assert.deepEqual(await api.confirm(confirm), { orderId: subsidy.id, status: 'ADDED', duplicate: false });
    assert.deepEqual(await api.confirm(confirm), { orderId: subsidy.id, status: 'ADDED', duplicate: true });
    assert.deepEqual(await api.lookup('KIOSK-01-000001'), { orderId: subsidy.id, status: 'ADDED' });
    assert.deepEqual(ledger.memberBalances(smk, wong.id), { walletSen: 1000, waitingSen: 0 });

    // another kiosk number for the same order: a suspected double add, kept as a difference
    await assert.rejects(api.confirm({ ...confirm, kioskTxn: 'KIOSK-01-000002' }), (err) => err.code === 'ORDER_ALREADY_ADDED' && err.status === 409);
    const differences = lab.platform.services.differences.list(smk, { kind: 'DOUBLE_ADD_SUSPECTED' });
    assert.equal(differences.length, 1, 'the difference survives the refused request');
    // another kiosk of another school cannot look this one up
    assert.equal(await kioskApi({ code: 'sjkc-contoh' }).lookup('KIOSK-01-000001'), null);
    assert.deepEqual((await api.pending({ card })).orders, []);
  });

  test('confirm refusals: a refunded order (difference kept), a FAILED write, a wrong amount, an unknown order', async (t) => {
    const { kioskApi, lab, school, member, digestOf, ctx } = await startLab(t);
    const smk = school('smk-contoh').id;
    const irfan = member('smk-contoh', 'S1006');
    const { topups, differences } = lab.platform.services;
    const api = kioskApi();
    const card = digestOf('smk-contoh', irfan.cardUid);
    const order = topups.grantSubsidy({ schoolId: smk, memberId: irfan.id, amountSen: 700, actor: 'test' });

    assert.deepEqual(await api.confirm({ orderId: order.id, result: 'FAILED', amountSen: 700, card, balanceAfterOnCardSen: 0, kioskTxn: 'KIOSK-01-000005' }), {
      orderId: order.id,
      status: 'PAID',
      duplicate: false,
    });
    await assert.rejects(
      api.confirm({ orderId: order.id, result: 'ADDED', amountSen: 701, card, balanceAfterOnCardSen: 701, kioskTxn: 'KIOSK-01-000006' }),
      (err) => err.code === 'ORDER_AMOUNT_MISMATCH',
    );
    await assert.rejects(
      api.confirm({ orderId: 'ord_unknown', result: 'ADDED', amountSen: 700, card, balanceAfterOnCardSen: 700, kioskTxn: 'KIOSK-01-000007' }),
      (err) => err.code === 'ORDER_NOT_FOUND' && err.status === 404,
    );
    ctx.clock.advance(15 * DAY);
    lab.platform.runJobs({ schoolId: smk });
    assert.equal(topups.getOrder(smk, order.id).status, 'REFUNDED');
    await assert.rejects(
      api.confirm({ orderId: order.id, result: 'ADDED', amountSen: 700, card, balanceAfterOnCardSen: 700, kioskTxn: 'KIOSK-01-000008' }),
      (err) => err.code === 'ORDER_ALREADY_REFUNDED' && err.status === 409,
    );
    assert.equal(differences.list(smk, { kind: 'TOPUP_ADDED_AFTER_REFUND' }).length, 1);
  });

  test('a lost card is refused at pending', async (t) => {
    const { kioskApi, lab, school, member, digestOf } = await startLab(t);
    const lee = member('smk-contoh', 'S1002');
    await lab.platform.reportCardLost({ schoolId: school('smk-contoh').id, uid: lee.cardUid, actor: 'test' });
    await assert.rejects(kioskApi().pending({ card: digestOf('smk-contoh', lee.cardUid) }), (err) => err.code === 'CARD_NOT_ACTIVE' && err.status === 409);
  });
});

describe('kiosk API: admin card', () => {
  test('packs: a token that only goes up, the school, and the current packs', async (t) => {
    const { kioskApi, lab, school } = await startLab(t);
    const api = kioskApi();
    const first = await api.packs();
    assert.equal(first.school, 'smk-contoh');
    assert.equal(first.token, 1);
    assert.deepEqual(first.packs.map((p) => [p.kind, p.version]), [['blocklist', 1], ['prices', 1], ['settings', 1]]);
    for (const p of first.packs) assert.match(p.checksum, /^[0-9a-f]{64}$/);
    const second = await api.packs();
    assert.equal(second.token, 2);
    const other = await kioskApi({ code: 'sjkc-contoh' }).packs();
    assert.equal(other.school, 'sjkc-contoh');
    assert.equal(other.token, 1, 'tokens are per school');
    const audit = lab.platform.services.schools.listAudit(school('smk-contoh').id, 2);
    assert.deepEqual(audit.map((a) => [a.actor, a.action]), [['device:KIOSK-01', 'admin-card.load'], ['device:KIOSK-01', 'admin-card.load']]);
  });

  test('receipts: applied versions are recorded via ADMIN_CARD, refusals go to the device log', async (t) => {
    const { kioskApi, lab, school, device, signed } = await startLab(t);
    const smk = school('smk-contoh').id;
    const api = kioskApi();
    const { token } = await api.packs();
    const at = lab.ctx.clock.iso();
    const answer = await api.receipts({
      token,
      receipts: [
        { device: 'CANTEEN-02', kind: 'blocklist', appliedVersion: 1, result: 'APPLIED', at },
        { device: 'CANTEEN-02', kind: 'prices', appliedVersion: 1, result: 'ALREADY_APPLIED', at },
        { device: 'WATER-01', kind: 'settings', appliedVersion: 0, result: 'REJECTED', error: 'BAD_CHECKSUM', at },
        { device: 'CANTEEN-77', kind: 'prices', appliedVersion: 1, result: 'APPLIED', at },
        { device: 'CANTEEN-02', kind: 'menu', appliedVersion: 1, result: 'APPLIED', at },
      ],
    });
    assert.equal(answer.recorded, 3);
    assert.deepEqual(answer.skipped.map((s) => s.index), [3, 4]);
    const states = lab.platform.services.configs.listStates(smk).filter((s) => s.deviceCode === 'CANTEEN-02');
    const byKind = Object.fromEntries(states.map((s) => [s.kind, [s.appliedVersion, s.via]]));
    assert.deepEqual(byKind, { prices: [1, 'ADMIN_CARD'], settings: [0, null], blocklist: [1, 'ADMIN_CARD'] });
    const log = lab.platform.services.devices.listLog(smk, { deviceId: device('smk-contoh', 'WATER-01').id });
    assert.equal(log[0].code, 'ADMIN_CARD_REJECTED');
    assert.match(log[0].message, /BAD_CHECKSUM/);

    // a machine of another school is not this kiosk's to report
    const sjkc = await kioskApi({ code: 'sjkc-contoh' }).receipts({
      token: 1,
      receipts: [{ device: 'CANTEEN-02', kind: 'prices', appliedVersion: 1, result: 'APPLIED', at }],
    });
    assert.equal(sjkc.recorded, 0, 'CANTEEN-02 is not a machine of SJK(C) Contoh');
    refusedWith(400, 'RECEIPTS_INVALID')(await signed({ path: '/api/kiosk/admin-card/receipts', body: { token: 0, receipts: [] } }));
    refusedWith(400, 'RECEIPTS_INVALID')(await signed({ path: '/api/kiosk/admin-card/receipts', body: { token: 1, receipts: 'all of them' } }));
  });
});

describe('kiosk API: every request is reported as http.kiosk (Simulation mode)', () => {
  const reports = (ctx) => eventsOf(ctx, 'http.kiosk').map((e) => [e.school, e.data]);
  const pending = { method: 'POST', path: '/api/kiosk/pending' };

  test('an answered request: the kiosk, method, path (no query) and status, plus the code of an error', async (t) => {
    const { signed, ctx, digestOf, member } = await startLab(t);
    const card = digestOf('smk-contoh', member('smk-contoh', 'S1001').cardUid);
    assert.equal((await signed({ body: { card } })).status, 200);
    assert.equal((await signed({ body: { card: 'ab'.repeat(32) } })).status, 404);
    assert.equal((await signed({ method: 'GET', path: '/api/kiosk/packs' })).status, 200);
    assert.equal((await signed({ body: { card }, path: '/api/kiosk/pending?max=1' })).status, 200);
    assert.equal((await signed({ code: 'sjkc-contoh', method: 'GET', path: '/api/kiosk/confirm/KIOSK-01-000009' })).status, 404);
    assert.deepEqual(reports(ctx), [
      ['smk-contoh', { device: 'KIOSK-01', ...pending, status: 200 }],
      ['smk-contoh', { device: 'KIOSK-01', ...pending, status: 404, code: 'CARD_NOT_FOUND' }],
      ['smk-contoh', { device: 'KIOSK-01', method: 'GET', path: '/api/kiosk/packs', status: 200 }],
      ['smk-contoh', { device: 'KIOSK-01', ...pending, status: 200 }],
      ['sjkc-contoh', { device: 'KIOSK-01', method: 'GET', path: '/api/kiosk/confirm/KIOSK-01-000009', status: 404, code: 'KIOSK_TXN_NOT_FOUND' }],
    ]);
    assert.ok(eventsOf(ctx, 'http.kiosk').every((e) => !('trace' in e)), 'no trace unless the request names one the lab knows');
  });

  test('a refused request is reported too, under the codes it claims when they are codes at all', async (t) => {
    const { signed, ctx, url } = await startLab(t);
    const body = { card: 'ab'.repeat(32) };
    const first = await signed({ body });
    refusedWith(409, 'REPLAY')(await signed({ body, nonce: first.nonce }));
    refusedWith(401, 'SIGNATURE_INVALID')(await signed({ body, secret: 'ab'.repeat(32) }));
    refusedWith(403, 'WRONG_DEVICE_TYPE')(await signed({ body, deviceCode: 'CANTEEN-01' }));
    refusedWith(401, 'SIGNATURE_INVALID')(await signed({ body, code: 'no-such-school', secret: 'ab'.repeat(32) }));
    const junk = await fetch(`${url}/api/kiosk/pending`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lab-school': 'Not A School', 'x-lab-device': 'kiosk 01' },
      body: JSON.stringify(body),
    });
    assert.equal(junk.status, 401);
    const wrongType = await fetch(`${url}/api/kiosk/pending`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'card' });
    assert.equal(wrongType.status, 415);
    assert.deepEqual(reports(ctx), [
      ['smk-contoh', { device: 'KIOSK-01', ...pending, status: 404, code: 'CARD_NOT_FOUND' }],
      ['smk-contoh', { device: 'KIOSK-01', ...pending, status: 409, code: 'REPLAY' }],
      ['smk-contoh', { device: 'KIOSK-01', ...pending, status: 401, code: 'SIGNATURE_INVALID' }],
      ['smk-contoh', { device: 'CANTEEN-01', ...pending, status: 403, code: 'WRONG_DEVICE_TYPE' }],
      ['no-such-school', { device: 'KIOSK-01', ...pending, status: 401, code: 'SIGNATURE_INVALID' }],
      [null, { device: null, ...pending, status: 401, code: 'SIGNATURE_INVALID' }],
      [null, { device: null, ...pending, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }],
    ]);
  });

  test('a switched-off server reports nothing (the request never reached it); other APIs are no kiosk requests', async (t) => {
    const { signed, ctx, lab, url } = await startLab(t);
    lab.server.up = false;
    refusedWith(503, 'SERVER_DOWN')(await signed({ body: { card: 'ab'.repeat(32) } }));
    lab.server.up = true;
    assert.equal((await fetch(`${url}/api/admin/staff-options`)).status, 200);
    assert.equal((await fetch(`${url}/api/kiosk/nowhere`, { method: 'POST' })).status, 404);
    assert.deepEqual(eventsOf(ctx, 'http.kiosk'), []);
  });
});
