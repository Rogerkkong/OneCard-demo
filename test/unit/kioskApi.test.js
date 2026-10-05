import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createKioskApi, KIOSK_CALLS, KioskApiError, kioskRoute } from '../../src/devices/kioskApi.js';
import { LabError } from '../../src/shared/errors.js';
import { hmacB64url, randomSecret, requestSigningString, safeEqual, signRequest } from '../../src/shared/crypto.js';
import { createClock } from '../../src/shared/clock.js';

// All school codes, members and order ids below are fictional; secrets are generated.

const SCHOOL = 'smk-alpha';
const DEVICE = 'KIOSK-01';
const SECRET = randomSecret();
const CARD = 'ab'.repeat(32);
/** respond() returns this to leave the request unanswered (for timeouts). */
const HANG = Symbol('hang');

/**
 * A stand-in for the platform's kiosk routes. It checks every header and recomputes the
 * signature over what really arrived (method, req.url with its query, raw body text), the
 * way the platform does, records each request and answers with `respond(request)`:
 * `{ status, json }`, `{ status, text, headers }`, HANG, or a function `(res) => void` that
 * writes a broken answer by hand.
 */
async function startFakePlatform({ clock, secret = SECRET }) {
  const requests = [];
  const nonces = new Set();
  let respond = () => ({ status: 200, json: {} });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const h = req.headers;
      const problems = [];
      if (h['x-lab-school'] !== SCHOOL) problems.push('x-lab-school');
      if (h['x-lab-device'] !== DEVICE) problems.push('x-lab-device');
      if (h['x-lab-timestamp'] !== String(clock.now())) problems.push('x-lab-timestamp');
      const nonce = h['x-lab-nonce'];
      if (typeof nonce !== 'string' || !/^[\x21-\x7e]{16,64}$/.test(nonce)) problems.push('x-lab-nonce');
      else if (nonces.has(nonce)) problems.push('nonce reused');
      else nonces.add(nonce);
      const signing = { method: req.method, path: req.url, timestamp: h['x-lab-timestamp'], nonce, body };
      const expected = signRequest({ secretHex: secret, ...signing });
      if (expected !== hmacB64url(secret, requestSigningString(signing))) problems.push('signing helpers disagree');
      if (!safeEqual(h['x-lab-signature'], expected)) problems.push('x-lab-signature');
      const seen = { method: req.method, url: req.url, headers: h, body, problems };
      requests.push(seen);
      if (problems.length > 0) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'SIGNATURE_INVALID', message: problems.join(', ') } }));
        return;
      }
      const answer = await respond(seen);
      if (answer === HANG) return;
      if (typeof answer === 'function') {
        answer(res);
        return;
      }
      if ('json' in answer) {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.json));
      } else {
        res.writeHead(answer.status, answer.headers ?? {});
        res.end(answer.text ?? '');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    set respond(fn) {
      respond = fn;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const errorAnswer = (status, code, message, detail) => () => ({ status, json: { error: { code, message, detail } } });

/** A kiosk API for this test school and kiosk. */
const apiFor = (baseUrl, clock, options = {}) =>
  createKioskApi({ baseUrl, schoolCode: SCHOOL, deviceCode: DEVICE, secret: SECRET, clock, ...options });

/** A confirm as the kiosk sends it after writing one order to the card. */
const confirmation = (overrides = {}) => ({
  orderId: 'ord_1',
  result: 'ADDED',
  amountSen: 2000,
  card: CARD,
  balanceAfterOnCardSen: 5000,
  kioskTxn: 'KIOSK-01-000007',
  ...overrides,
});

/** assert.rejects matcher for a KioskApiError. */
const apiError = (code, status) => (err) => {
  assert.ok(err instanceof KioskApiError, `expected KioskApiError ${code}, got ${err}`);
  assert.equal(err.code, code);
  if (status !== undefined) assert.equal(err.status, status);
  return true;
};

describe('createKioskApi options', () => {
  const clock = createClock({ mode: 'manual' });
  const good = { baseUrl: 'http://127.0.0.1:8080', schoolCode: SCHOOL, deviceCode: DEVICE, secret: SECRET, clock };

  test('returns the five kiosk calls', () => {
    const api = createKioskApi(good);
    for (const name of ['pending', 'confirm', 'lookup', 'packs', 'receipts']) assert.equal(typeof api[name], 'function');
  });

  test('refuses malformed options', () => {
    const bad = [
      { baseUrl: undefined },
      { baseUrl: 'not a url' },
      { baseUrl: 'ftp://127.0.0.1' },
      { baseUrl: 'http://127.0.0.1:8080/?school=smk-alpha' },
      { baseUrl: 'http://127.0.0.1:8080/#top' },
      { baseUrl: 'http://kiosk:pw@127.0.0.1:8080' },
      { schoolCode: 'SMK-ALPHA' },
      { deviceCode: 'kiosk-01' },
      { secret: 'not-hex' },
      { secret: 'ab'.repeat(8) },
      { clock: undefined },
      { clock: { now: 5 } },
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: Number.NaN },
      { timeoutMs: '100' },
      // Node timers take whole ms up to 2^31 - 1: a fraction would make every call fail and a
      // longer timeout would fire after 1 ms, both as a false NETWORK error.
      { timeoutMs: 1000.5 },
      { timeoutMs: 2 ** 31 },
      { timeoutMs: 3_000_000_000 },
      { timeoutMs: Number.POSITIVE_INFINITY },
    ];
    for (const change of bad) assert.throws(() => createKioskApi({ ...good, ...change }), TypeError, String(change.timeoutMs ?? JSON.stringify(change)));
    assert.throws(() => createKioskApi(), TypeError);
  });

  test('accepts any whole timeout from 1 ms to 2^31 - 1 ms', () => {
    for (const timeoutMs of [1, 5000, 2 ** 31 - 1]) assert.doesNotThrow(() => createKioskApi({ ...good, timeoutMs }));
  });

  test('online and headers must be functions, or left out', () => {
    for (const online of [true, false, null, 'yes', {}]) assert.throws(() => createKioskApi({ ...good, online }), TypeError, `online ${online}`);
    for (const headers of [{ 'x-lab-trace': 'tr_1' }, null, 'x-lab-trace', 1]) assert.throws(() => createKioskApi({ ...good, headers }), TypeError, `headers ${headers}`);
    assert.doesNotThrow(() => createKioskApi({ ...good, online: () => true, headers: () => ({}) }));
  });

  test('kioskRoute names the method and path of each call, as they are sent', () => {
    assert.deepEqual(KIOSK_CALLS, ['pending', 'confirm', 'lookup', 'packs', 'receipts']);
    assert.deepEqual(KIOSK_CALLS.filter((c) => c !== 'lookup').map((c) => [c, kioskRoute(c)]), [
      ['pending', { method: 'POST', path: '/api/kiosk/pending' }],
      ['confirm', { method: 'POST', path: '/api/kiosk/confirm' }],
      ['packs', { method: 'GET', path: '/api/kiosk/packs' }],
      ['receipts', { method: 'POST', path: '/api/kiosk/admin-card/receipts' }],
    ]);
    assert.deepEqual(kioskRoute('lookup', 'KIOSK-01-000007'), { method: 'GET', path: '/api/kiosk/confirm/KIOSK-01-000007' });
    assert.deepEqual(kioskRoute('lookup', 'K 1/2'), { method: 'GET', path: '/api/kiosk/confirm/K%201%2F2' });
    for (const bad of [['refund'], ['toString'], [undefined], ['lookup', '..'], ['lookup', undefined]]) {
      assert.throws(() => kioskRoute(...bad), TypeError, String(bad));
    }
  });
});

describe('signed kiosk requests', () => {
  const clock = createClock({ mode: 'manual' });
  let platform;
  let api;

  before(async () => {
    platform = await startFakePlatform({ clock });
    api = apiFor(platform.url, clock);
  });
  after(() => platform.close());
  beforeEach(() => {
    platform.requests.length = 0;
    platform.respond = () => ({ status: 200, json: {} });
  });

  test('pending: POST with every header and a signature over the exact body text', async () => {
    const answer = {
      member: { id: 'mem_1', name: 'Pelajar Contoh' },
      orders: [{ orderId: 'ord_1', kind: 'TOPUP', amountSen: 2000 }],
      mirrorBalanceSen: 3000,
      waitingSen: 2000,
    };
    platform.respond = () => ({ status: 200, json: answer });
    assert.deepEqual(await api.pending({ card: CARD, max: 5 }), answer);
    assert.equal(platform.requests.length, 1);
    const [req] = platform.requests;
    assert.deepEqual(req.problems, []);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/kiosk/pending');
    assert.equal(req.body, JSON.stringify({ card: CARD, max: 5 }));
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['x-lab-school'], SCHOOL);
    assert.equal(req.headers['x-lab-device'], DEVICE);
    assert.equal(req.headers['x-lab-timestamp'], String(clock.now()));
    assert.match(req.headers['x-lab-nonce'], /^[0-9a-f]{32}$/);
    const signed = { method: 'POST', path: '/api/kiosk/pending', timestamp: String(clock.now()), nonce: req.headers['x-lab-nonce'], body: req.body };
    assert.equal(req.headers['x-lab-signature'], signRequest({ secretHex: SECRET, ...signed }));
    assert.equal(req.headers['x-lab-signature'], hmacB64url(SECRET, requestSigningString(signed)));
  });

  test('pending without max sends only the card', async () => {
    await api.pending({ card: CARD });
    assert.equal(platform.requests[0].body, JSON.stringify({ card: CARD }));
  });

  test('confirm: POST with the whole confirmation', async () => {
    platform.respond = () => ({ status: 200, json: { orderId: 'ord_1', status: 'ADDED', duplicate: false } });
    const sent = confirmation();
    assert.deepEqual(await api.confirm(sent), { orderId: 'ord_1', status: 'ADDED', duplicate: false });
    const [req] = platform.requests;
    assert.deepEqual(req.problems, []);
    assert.equal(req.url, '/api/kiosk/confirm');
    assert.deepEqual(JSON.parse(req.body), sent);
  });

  test('lookup: GET with an empty body, signed as ""', async () => {
    platform.respond = () => ({ status: 200, json: { orderId: 'ord_1', status: 'ADDED' } });
    assert.deepEqual(await api.lookup('KIOSK-01-000007'), { orderId: 'ord_1', status: 'ADDED' });
    const [req] = platform.requests;
    assert.deepEqual(req.problems, []);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/kiosk/confirm/KIOSK-01-000007');
    assert.equal(req.body, '');
    assert.equal(req.headers['content-type'], undefined);
  });

  test('lookup: 404 means the platform never recorded it, so null', async () => {
    platform.respond = errorAnswer(404, 'NOT_FOUND', 'no confirm with that kiosk txn');
    assert.equal(await api.lookup('KIOSK-01-000008'), null);
  });

  test('lookup: the txn is escaped into one path segment, and the escaped path is what gets signed', async () => {
    platform.respond = () => ({ status: 200, json: { orderId: 'ord_2', status: 'PAID' } });
    await api.lookup('K 1/2?x#y');
    const [req] = platform.requests;
    assert.equal(req.url, '/api/kiosk/confirm/K%201%2F2%3Fx%23y');
    assert.deepEqual(req.problems, []);
  });

  test('lookup: a txn that cannot be one path segment is refused before anything is sent', async () => {
    for (const txn of [undefined, '', '.', '..', 'K'.repeat(65), 42]) {
      await assert.rejects(api.lookup(txn), TypeError, String(txn));
    }
    assert.equal(platform.requests.length, 0);
  });

  test('packs: GET the token and the packs', async () => {
    const answer = { token: 4, school: SCHOOL, packs: [{ kind: 'prices', version: 2, content: { items: [] }, checksum: 'c'.repeat(64) }] };
    platform.respond = () => ({ status: 200, json: answer });
    assert.deepEqual(await api.packs(), answer);
    const [req] = platform.requests;
    assert.deepEqual(req.problems, []);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/kiosk/packs');
    assert.equal(req.body, '');
  });

  test('receipts: POST, signed over the UTF-8 body text (non-ASCII error text included)', async () => {
    platform.respond = () => ({ status: 200, json: { recorded: 2 } });
    const receipts = [
      { device: 'CANTEEN-02', kind: 'prices', appliedVersion: 2, result: 'APPLIED', at: clock.iso() },
      { device: 'WATER-01', kind: 'blocklist', appliedVersion: 3, result: 'REJECTED', error: '校验和不符 (checksum)', at: clock.iso() },
    ];
    assert.deepEqual(await api.receipts({ token: 4, receipts }), { recorded: 2 });
    const [req] = platform.requests;
    assert.deepEqual(req.problems, []);
    assert.equal(req.url, '/api/kiosk/admin-card/receipts');
    assert.deepEqual(JSON.parse(req.body), { token: 4, receipts });
  });

  test('timestamps come from the lab clock, not the wall clock', async () => {
    await api.packs();
    clock.advance(3 * 24 * 60 * 60 * 1000);
    await api.packs();
    const [first, second] = platform.requests;
    assert.deepEqual(second.problems, []);
    assert.equal(Number(second.headers['x-lab-timestamp']) - Number(first.headers['x-lab-timestamp']), 3 * 24 * 60 * 60 * 1000);
    assert.equal(second.headers['x-lab-timestamp'], String(clock.now()));
  });

  test('every request has a fresh nonce', async () => {
    await api.packs();
    await api.packs();
    await api.pending({ card: CARD });
    const nonces = platform.requests.map((r) => r.headers['x-lab-nonce']);
    assert.equal(new Set(nonces).size, 3);
    for (const r of platform.requests) assert.deepEqual(r.problems, []);
  });

  test('the signature binds the path with its query, and the body', async () => {
    platform.respond = () => ({ status: 200, json: { ok: true } });
    await api.request('POST', '/api/kiosk/pending?max=3', { card: CARD });
    const [req] = platform.requests;
    assert.equal(req.url, '/api/kiosk/pending?max=3');
    assert.deepEqual(req.problems, []);
    const parts = { secretHex: SECRET, method: 'POST', timestamp: req.headers['x-lab-timestamp'], nonce: req.headers['x-lab-nonce'] };
    assert.notEqual(req.headers['x-lab-signature'], signRequest({ ...parts, path: '/api/kiosk/pending', body: req.body }));
    assert.notEqual(req.headers['x-lab-signature'], signRequest({ ...parts, path: req.url, body: JSON.stringify({ card: CARD, max: 50 }) }));
    assert.notEqual(req.headers['x-lab-signature'], signRequest({ ...parts, method: 'PUT', path: req.url, body: req.body }));
  });

  test('a path prefix in baseUrl is part of the signed path', async () => {
    const prefixed = apiFor(`${platform.url}/platform/`, clock);
    platform.respond = () => ({ status: 200, json: { token: 1, school: SCHOOL, packs: [] } });
    await prefixed.packs();
    const [req] = platform.requests;
    assert.equal(req.url, '/platform/api/kiosk/packs');
    assert.deepEqual(req.problems, []);
  });

  test('a kiosk with the wrong secret is refused by the platform (SIGNATURE_INVALID)', async () => {
    const impostor = apiFor(platform.url, clock, { secret: randomSecret() });
    await assert.rejects(impostor.pending({ card: CARD }), apiError('SIGNATURE_INVALID', 401));
    assert.deepEqual(platform.requests[0].problems, ['x-lab-signature']);
  });

  test('request() refuses a body on GET and a path that is not absolute', async () => {
    await assert.rejects(api.request('GET', '/api/kiosk/packs', {}), TypeError);
    await assert.rejects(api.request('POST', 'api/kiosk/pending', {}), TypeError);
    assert.equal(platform.requests.length, 0);
  });

  test("headers(): the lab's extra headers go out with every request, asked afresh each time", async () => {
    let trace = 'tr_first';
    const traced = apiFor(platform.url, clock, { headers: () => ({ 'X-Lab-Trace': trace, 'x-lab-note': 'lab' }) });
    await traced.pending({ card: CARD });
    trace = 'tr_second';
    await traced.lookup('KIOSK-01-000017');
    assert.deepEqual(platform.requests.map((r) => [r.headers['x-lab-trace'], r.headers['x-lab-note']]), [['tr_first', 'lab'], ['tr_second', 'lab']]);
    for (const r of platform.requests) assert.deepEqual(r.problems, []);
  });

  test('headers() can never replace the signing headers, accept or content-type, in any spelling; odd values are left out', async () => {
    const forged = 'f'.repeat(43);
    const pushy = apiFor(platform.url, clock, {
      headers: () => ({
        'x-lab-signature': forged,
        'X-Lab-Nonce': 'a'.repeat(32),
        'X-LAB-TIMESTAMP': '1',
        'x-lab-school': 'smk-other',
        'x-lab-device': 'KIOSK-99',
        Accept: 'text/html',
        'Content-Type': 'text/plain',
        'content-length': '1',
        host: 'evil.example',
        'x-lab-trace': 'tr_kept',
        'x-number': 42, // only strings
        'x-split': 'a\r\nx-injected: yes', // no line breaks
        'bad name': 'x', // not a header name
      }),
    });
    await pushy.confirm(confirmation({ kioskTxn: 'KIOSK-01-000018' }));
    const [req] = platform.requests;
    assert.deepEqual(req.problems, []); // signed by the kiosk, checked by the platform
    assert.notEqual(req.headers['x-lab-signature'], forged);
    assert.equal(req.headers['x-lab-school'], SCHOOL);
    assert.equal(req.headers['x-lab-device'], DEVICE);
    assert.equal(req.headers.accept, 'application/json');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['x-lab-trace'], 'tr_kept');
    for (const name of ['x-number', 'x-split', 'x-injected', 'bad name']) assert.equal(req.headers[name], undefined, name);
    assert.deepEqual(JSON.parse(req.body), confirmation({ kioskTxn: 'KIOSK-01-000018' }));
  });

  test('a headers() that throws or answers something else adds nothing, and the request still goes', async () => {
    const answers = [
      () => {
        throw new Error('lab bug');
      },
      () => 'x-lab-trace: tr_1',
      () => null,
      () => [['x-lab-trace', 'tr_1']],
    ];
    for (const headers of answers) await apiFor(platform.url, clock, { headers }).packs();
    assert.equal(platform.requests.length, answers.length);
    for (const r of platform.requests) {
      assert.deepEqual(r.problems, []);
      assert.equal(r.headers['x-lab-trace'], undefined);
    }
  });
});

describe('kiosk API errors', () => {
  const clock = createClock({ mode: 'manual' });
  let platform;
  let api;

  before(async () => {
    platform = await startFakePlatform({ clock });
    api = apiFor(platform.url, clock);
  });
  after(() => platform.close());
  beforeEach(() => {
    platform.requests.length = 0;
  });

  test("a non-2xx answer is a KioskApiError with the platform's code, status, message and detail", async () => {
    platform.respond = errorAnswer(409, 'ORDER_ALREADY_ADDED', 'this order was added by another write', { orderId: 'ord_9' });
    const refused = api.confirm(confirmation({ orderId: 'ord_9', amountSen: 500, balanceAfterOnCardSen: 900, kioskTxn: 'KIOSK-01-000009' }));
    await assert.rejects(refused, (err) => {
      apiError('ORDER_ALREADY_ADDED', 409)(err);
      assert.ok(err instanceof LabError);
      assert.equal(err.name, 'KioskApiError');
      assert.equal(err.message, 'this order was added by another write');
      assert.deepEqual(err.detail, { orderId: 'ord_9' });
      return true;
    });
  });

  test('every kiosk refusal keeps its code and status', async () => {
    const cases = [
      [401, 'SIGNATURE_INVALID'],
      [409, 'REPLAY'],
      [403, 'DEVICE_DISABLED'],
      [403, 'SCHOOL_SUSPENDED'],
      [403, 'WRONG_DEVICE_TYPE'],
      [409, 'CARD_NOT_ACTIVE'],
      [400, 'BODY_INVALID'],
      [503, 'SERVER_DOWN'],
    ];
    for (const [status, code] of cases) {
      platform.respond = errorAnswer(status, code, `refused: ${code}`);
      await assert.rejects(api.pending({ card: CARD }), apiError(code, status));
      await assert.rejects(api.packs(), apiError(code, status));
    }
  });

  test('a 404 from anything but lookup is an error, not null', async () => {
    platform.respond = errorAnswer(404, 'CARD_NOT_FOUND', 'no such card');
    await assert.rejects(api.pending({ card: CARD }), apiError('CARD_NOT_FOUND', 404));
  });

  test('a lookup refused for another reason is an error, not null', async () => {
    platform.respond = errorAnswer(503, 'SERVER_DOWN', 'the cloud server is switched off');
    await assert.rejects(api.lookup('KIOSK-01-000010'), apiError('SERVER_DOWN', 503));
  });

  test('an error answer without a code becomes HTTP_<status>', async () => {
    platform.respond = () => ({ status: 502, text: '<html>Bad gateway</html>', headers: { 'content-type': 'text/html' } });
    await assert.rejects(api.packs(), apiError('HTTP_502', 502));
    platform.respond = () => ({ status: 500, json: { oops: true } });
    await assert.rejects(api.packs(), apiError('HTTP_500', 500));
    platform.respond = () => ({ status: 400, json: { error: { message: 'no code' } } });
    await assert.rejects(api.packs(), (err) => apiError('HTTP_400', 400)(err) && err.message === 'no code');
  });

  // The error may reach an API response (it is a LabError), so its status is never a success:
  // an answer that is not one is 502, with what the platform really answered in the detail.
  test('a 2xx answer that is not JSON is BAD_RESPONSE (502, httpStatus in the detail)', async () => {
    for (const [status, text] of [[200, 'OK'], [200, ''], [201, '<html></html>']]) {
      platform.respond = () => ({ status, text });
      await assert.rejects(api.packs(), (err) => {
        apiError('BAD_RESPONSE', 502)(err);
        assert.deepEqual(err.detail, { httpStatus: status });
        return true;
      });
    }
  });

  test('redirects are not followed (the signature is for this path only): HTTP_302, status 502', async () => {
    platform.respond = () => ({ status: 302, headers: { location: '/somewhere-else' } });
    await assert.rejects(api.packs(), (err) => {
      apiError('HTTP_302', 502)(err);
      assert.deepEqual(err.detail, { httpStatus: 302 });
      return true;
    });
    // A redirect from lookup is not "never recorded" either.
    await assert.rejects(api.lookup('KIOSK-01-000015'), apiError('HTTP_302', 502));
    assert.equal(platform.requests.length, 2);
    assert.deepEqual(platform.requests.map((r) => r.url), ['/api/kiosk/packs', '/api/kiosk/confirm/KIOSK-01-000015']);
  });

  test('no answer within timeoutMs is NETWORK (timedOut), also for lookup', async () => {
    const impatient = apiFor(platform.url, clock, { timeoutMs: 100 });
    platform.respond = () => HANG;
    const started = Date.now();
    const confirm = impatient.confirm(confirmation({ orderId: 'ord_3', kioskTxn: 'KIOSK-01-000011' }));
    await assert.rejects(confirm, (err) => {
      apiError('NETWORK', 503)(err);
      assert.deepEqual(err.detail, { timedOut: true });
      return true;
    });
    assert.ok(Date.now() - started < 2000, 'gave up long after timeoutMs');
    // A lookup that gets no answer must not look like "never recorded".
    await assert.rejects(impatient.lookup('KIOSK-01-000011'), apiError('NETWORK'));
    assert.equal(platform.requests.length, 2);
  });

  test('a confirm answer that stalls half-way is NETWORK (timedOut), never a result', async () => {
    const impatient = apiFor(platform.url, clock, { timeoutMs: 100 });
    // The status line, headers and the start of the body arrive, then nothing more.
    platform.respond = () => (res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
      res.write('{"orderId":"ord_4","status":');
    };
    await assert.rejects(impatient.confirm(confirmation({ orderId: 'ord_4', kioskTxn: 'KIOSK-01-000013' })), (err) => {
      apiError('NETWORK', 503)(err);
      assert.deepEqual(err.detail, { timedOut: true });
      return true;
    });
  });

  test('a connection dropped half-way through the answer is NETWORK (not timed out)', async () => {
    platform.respond = () => (res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
      res.write('{"orderId":"ord_5","status":', () => res.destroy());
    };
    await assert.rejects(api.confirm(confirmation({ orderId: 'ord_5', kioskTxn: 'KIOSK-01-000014' })), (err) => {
      apiError('NETWORK', 503)(err);
      assert.deepEqual(err.detail, { timedOut: false });
      return true;
    });
    assert.equal(platform.requests.length, 1);
  });

  test('a platform that cannot be reached is NETWORK', async () => {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    const offline = apiFor(`http://127.0.0.1:${port}`, clock, { timeoutMs: 2000 });
    await assert.rejects(offline.pending({ card: CARD }), (err) => {
      apiError('NETWORK', 503)(err);
      assert.deepEqual(err.detail, { timedOut: false });
      return true;
    });
    await assert.rejects(offline.lookup('KIOSK-01-000012'), apiError('NETWORK'));
  });

  test('online() false: NETWORK at once, nothing sent; asked again for every request', async () => {
    let up = false;
    let asked = 0;
    const cut = apiFor(platform.url, clock, {
      online: () => {
        asked += 1;
        return up;
      },
    });
    platform.respond = () => ({ status: 200, json: { token: 1, school: SCHOOL, packs: [] } });
    for (const call of [() => cut.pending({ card: CARD }), () => cut.confirm(confirmation()), () => cut.lookup('KIOSK-01-000016'), () => cut.packs()]) {
      await assert.rejects(call(), (err) => {
        apiError('NETWORK', 503)(err);
        assert.deepEqual(err.detail, { timedOut: false, offline: true });
        return true;
      });
    }
    assert.deepEqual([asked, platform.requests.length], [4, 0]);
    up = true;
    assert.deepEqual(await cut.packs(), { token: 1, school: SCHOOL, packs: [] });
    assert.deepEqual(platform.requests[0].problems, []);
    // a bad argument is still a bad argument, network or not
    up = false;
    await assert.rejects(cut.lookup('..'), TypeError);
  });

  test('KioskApiError(code, status, message) can be built directly', () => {
    const err = new KioskApiError('NETWORK', 503, 'cable unplugged');
    assert.equal(err.code, 'NETWORK');
    assert.equal(err.status, 503);
    assert.equal(err.message, 'cable unplugged');
    assert.equal(new KioskApiError('REPLAY', 409).message, 'REPLAY');
  });
});
