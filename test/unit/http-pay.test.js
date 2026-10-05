import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx, eventsOf } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { createHttpServer } from '../../src/http/server.js';
import { signPayload } from '../../src/shared/crypto.js';
import { MINUTE } from '../../src/shared/time.js';

// The mock bank and the platform's payment callback, end to end over real HTTP: a parent tops
// up, opens the bank page, pays or declines, and the bank's signed callback reaches the platform
// as a real request. Parents and children are the fictional demo seed.

async function startLab(t) {
  const ctx = createTestCtx();
  const platform = createPlatform(ctx);
  const seed = seedDemo(platform);
  const lab = { ctx, platform, server: { up: true } };
  const server = createHttpServer({ lab });
  const { url, port } = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const school = (code) => seed.schools.find((s) => s.code === code);
  const member = (code, memberNo) => school(code).members.find((m) => m.memberNo === memberNo);
  const parent = (name) => seed.parents.find((p) => p.name === name);
  const signIn = async (name) => {
    const b = browser(url);
    await b.post('/api/parent/login', { json: { parentId: parent(name).id } });
    return b;
  };
  /** Rahman tops up Ahmad Faiz (or `name` tops up the given child) through the parent API. */
  const topUp = async (b, { code = 'smk-contoh', memberNo = 'S1001', amountSen = 1500, key = 'pay-test' } = {}) => {
    const res = await b.post(`/api/parent/children/${school(code).id}/${member(code, memberNo).id}/topups`, {
      json: { amountSen },
      headers: { 'idempotency-key': key },
    });
    assert.equal(res.status, 201, res.text);
    return res.data;
  };
  return { ctx, platform, seed, lab, url, port, school, member, parent, signIn, topUp };
}

function browser(url) {
  const jar = new Map();
  async function call(method, path, { json, form, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) {
      h['content-type'] ??= 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      h['content-type'] ??= 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(url + path, { method, headers: h, body, redirect: 'manual' });
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
      // a page
    }
    return { status: res.status, headers: res.headers, data, text };
  }
  return { jar, get: (p, o) => call('GET', p, o), post: (p, o = {}) => call('POST', p, o) };
}

/** Record every fetch the server itself makes (the bank's callback) while `fn` runs. */
async function watchingFetch(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body, headers: { ...(init?.headers ?? {}) } });
    return original(input, init);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

describe('mock bank: paying', () => {
  test('top-up → bank page → Pay → the order is PAID and the money waits for the kiosk', async (t) => {
    const { signIn, topUp, lab, url, school, member } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const { order, payUrl } = await topUp(b, { amountSen: 1500 });
    assert.equal(payUrl, `/pay/${order.id}`);

    const page = await b.get(payUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(page.text, /Mock Bank/);
    assert.match(page.text, /RM 15\.00/);
    assert.match(page.text, /SMK Seri Contoh/);
    assert.match(page.text, /Ahmad Faiz bin Rahman/);
    assert.equal(page.text.includes(school('smk-contoh').id), false, 'the school by name, never its id');
    assert.doesNotMatch(page.text, /<script/i);
    const forms = page.text.match(/<form method="post" action="\/pay\/[^"]+">/g);
    assert.equal(forms.length, 2, 'Pay and Decline');
    assert.match(page.text, /name="result" value="SUCCESS"/);
    assert.match(page.text, /name="result" value="FAILED"/);

    // another site cannot post the form for the parent
    const forged = await b.post(payUrl, { form: { result: 'SUCCESS' }, headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' } });
    assert.equal(forged.status, 403);
    assert.equal(lab.platform.services.topups.getOrder(school('smk-contoh').id, order.id).status, 'CREATED');

    // the browser posts the Pay form with the headers a browser sends: with our Referrer-Policy
    // (no-referrer) a same-origin form post carries Origin: null
    const { result: paid, calls } = await watchingFetch(() =>
      b.post(payUrl, { form: { result: 'SUCCESS' }, headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } }),
    );
    assert.equal(paid.status, 303);
    assert.equal(paid.headers.get('location'), '/parent/');
    const callback = calls.find((c) => c.url === `${url}/api/payments/callback`);
    assert.ok(callback, 'the bank called the platform over HTTP');
    const sent = JSON.parse(callback.body);
    assert.equal(sent.orderId, order.id);
    assert.equal(sent.provider, 'MOCKBANK');
    assert.equal(sent.result, 'SUCCESS');
    assert.equal(sent.paidAmountSen, 1500);
    const { signature, ...signed } = sent;
    assert.equal(signature, signPayload(lab.ctx.settings.providerSecret, signed));
    assert.equal(callback.headers['x-lab-trace'], undefined, 'outside any trace the callback names none');

    const { topups, ledger } = lab.platform.services;
    const smk = school('smk-contoh').id;
    const stored = topups.getOrder(smk, order.id);
    assert.equal(stored.status, 'PAID');
    assert.ok(stored.addBy > stored.paidAt);
    assert.ok(ledger.findByIdemKey(smk, `TOPUP:${order.id}:PAID`), 'debit cash received / credit waiting to be added');
    assert.equal(eventsOf(lab.ctx, 'topup.status').at(-1).data.status, 'PAID');
    const balance = await b.get(`/api/parent/children/${smk}/${member('smk-contoh', 'S1001').id}/balance`);
    assert.deepEqual([balance.data.mirrorBalanceSen, balance.data.waitingSen], [0, 1500]);

    // a second click changes nothing and still goes back to the app; a browser without
    // Sec-Fetch-Site posts the bank's form with Origin: null alone, and the form takes it
    const again = await b.post(payUrl, { form: { result: 'SUCCESS' }, headers: { origin: 'null' } });
    assert.equal(again.status, 303);
    assert.equal(lab.platform.services.ledger.postings(smk, { limit: 1000 }).filter((p) => p.ref === order.id).length, 1);
    const after = await b.get(payUrl);
    assert.match(after.text, /already paid/);
    assert.doesNotMatch(after.text, /<form/);
  });

  test('Decline: the order FAILED, nothing waits; the bank page says so', async (t) => {
    const { signIn, topUp, lab, school } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const { order, payUrl } = await topUp(b);
    const declined = await b.post(payUrl, { form: { result: 'FAILED' } });
    assert.equal(declined.status, 303);
    assert.equal(declined.headers.get('location'), '/parent/');
    const smk = school('smk-contoh').id;
    assert.equal(lab.platform.services.topups.getOrder(smk, order.id).status, 'FAILED');
    assert.equal(lab.platform.services.ledger.findByIdemKey(smk, `TOPUP:${order.id}:PAID`), null);
    const page = await b.get(payUrl);
    assert.match(page.text, /declined/);
    assert.doesNotMatch(page.text, /<form/);
    const list = await b.get('/api/parent/topups');
    assert.equal(list.data[0].status, 'FAILED');
  });

  test('a decline is final: paying the declined order later changes nothing, so the daily limit holds', async (t) => {
    const { signIn, topUp, lab, school } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const smk = school('smk-contoh').id;
    const { topups, ledger } = lab.platform.services;
    // RM 200 twice in a day: the second fits under the RM 300 daily limit only because the first was declined
    const first = await topUp(b, { amountSen: 20000, key: 'final-1' });
    assert.equal((await b.post(first.payUrl, { form: { result: 'FAILED' } })).status, 303);
    const second = await topUp(b, { amountSen: 20000, key: 'final-2' });
    assert.equal((await b.post(second.payUrl, { form: { result: 'SUCCESS' } })).status, 303);
    // the declined order's bank page is still open in another tab: Pay there, then by script
    const late = await b.post(first.payUrl, { form: { result: 'SUCCESS' } });
    assert.equal(late.status, 303);
    assert.equal(late.headers.get('location'), '/parent/');
    const api = await b.post(`/api/pay/${first.order.id}/complete`, { json: { result: 'SUCCESS' } });
    assert.deepEqual(api.data, { redirect: '/parent/', orderId: first.order.id, status: 'FAILED' });
    assert.equal(topups.getOrder(smk, first.order.id).status, 'FAILED');
    assert.equal(ledger.findByIdemKey(smk, `TOPUP:${first.order.id}:PAID`), null);
    assert.equal(topups.getOrder(smk, second.order.id).status, 'PAID');
  });

  test('a late payment still lands: Pay on a page left open past the pay window', async (t) => {
    const { signIn, topUp, lab, school } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const { order, payUrl } = await topUp(b, { amountSen: 1500 });
    lab.ctx.clock.advance(31 * MINUTE);
    lab.platform.runJobs();
    const smk = school('smk-contoh').id;
    assert.equal(lab.platform.services.topups.getOrder(smk, order.id).status, 'CANCELLED');
    assert.equal((await b.post(payUrl, { form: { result: 'SUCCESS' } })).status, 303);
    assert.equal(lab.platform.services.topups.getOrder(smk, order.id).status, 'PAID', 'the bank took the money, so it must land');
  });

  test('POST /api/pay/:orderId/complete does the same for a script and answers { redirect }', async (t) => {
    const { signIn, topUp, lab, school } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const { order } = await topUp(b, { amountSen: 2000 });
    const res = await b.post(`/api/pay/${order.id}/complete`, { json: { result: 'SUCCESS' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { redirect: '/parent/', orderId: order.id, status: 'PAID' });
    assert.equal(lab.platform.services.topups.getOrder(school('smk-contoh').id, order.id).status, 'PAID');
    const second = await b.post(`/api/pay/${order.id}/complete`, { json: { result: 'pay' } });
    assert.deepEqual(second.data, { redirect: '/parent/', orderId: order.id, status: 'PAID' });
    const bad = await b.post(`/api/pay/${order.id}/complete`, { json: { result: 'MAYBE' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'RESULT_INVALID');
  });
});

describe('mock bank: who may pay', () => {
  test('no session, another parent or an unknown order: a plain 404 page (JSON for /api)', async (t) => {
    const { signIn, topUp, url } = await startLab(t);
    const rahman = await signIn('Rahman bin Yusof');
    const { order, payUrl } = await topUp(rahman);
    const lee = await signIn('Lee Kah Seng');
    const nobody = browser(url);
    for (const [who, b] of [['no session', nobody], ['another parent', lee]]) {
      const page = await b.get(payUrl);
      assert.equal(page.status, 404, who);
      assert.match(page.headers.get('content-type'), /^text\/html/, who);
      assert.doesNotMatch(page.text, /RM 15\.00|Ahmad/, who);
      const post = await b.post(payUrl, { form: { result: 'SUCCESS' } });
      assert.equal(post.status, 404, who);
      const api = await b.post(`/api/pay/${order.id}/complete`, { json: { result: 'SUCCESS' } });
      assert.equal(api.status, 404, who);
      assert.equal(api.data.error.code, 'ORDER_NOT_FOUND', who);
    }
    assert.equal((await rahman.get('/pay/ord_nonexistent')).status, 404);
    assert.equal((await rahman.get(payUrl)).status, 200, 'still payable by its parent');
  });

  test('the bank form takes form-encoded data only; the JSON route JSON only', async (t) => {
    const { signIn, topUp } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const { order, payUrl } = await topUp(b);
    const json = await b.post(payUrl, { json: { result: 'SUCCESS' } });
    assert.equal(json.status, 415);
    assert.match(json.headers.get('content-type'), /^text\/html/);
    const form = await b.post(`/api/pay/${order.id}/complete`, { form: { result: 'SUCCESS' } });
    assert.equal(form.status, 415);
    const missing = await b.post(payUrl, { form: {} });
    assert.equal(missing.status, 400);
  });

  test('a suspended school\'s orders cannot be paid; a switched-off server cannot take payments', async (t) => {
    const { signIn, topUp, lab, school } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const { payUrl } = await topUp(b);
    lab.server.up = false;
    const down = await b.get(payUrl);
    assert.equal(down.status, 503);
    assert.match(down.text, /SERVER_DOWN/);
    lab.server.up = true;
    await lab.platform.setSchoolStatus({ schoolId: school('smk-contoh').id, status: 'SUSPENDED', actor: 'test' });
    const suspended = await b.get(payUrl);
    assert.equal(suspended.status, 403);
    assert.match(suspended.text, /SCHOOL_SUSPENDED/);
  });
});

describe('payment callback (provider to platform)', () => {
  test('a signed callback pays the order; a bad signature is 401, an unknown order 404, a wrong amount 400', async (t) => {
    const { signIn, topUp, url, lab, school } = await startLab(t);
    const b = await signIn('Rahman bin Yusof');
    const { order } = await topUp(b, { amountSen: 1000 });
    const callback = (payload) =>
      fetch(`${url}/api/payments/callback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const signed = (p) => ({ ...p, signature: signPayload(lab.ctx.settings.providerSecret, p) });
    const base = { orderId: order.id, provider: 'MOCKBANK', providerTxnId: 'BANK-1', result: 'SUCCESS', paidAmountSen: 1000, paidAt: lab.ctx.clock.iso() };

    const forged = await callback({ ...base, signature: signPayload('cd'.repeat(32), base) });
    assert.equal(forged.status, 401);
    assert.equal((await forged.json()).error.code, 'PAYMENT_SIGNATURE_INVALID');
    const unsigned = await callback(base);
    assert.equal(unsigned.status, 401);
    const unknown = await callback(signed({ ...base, orderId: 'ord_unknown' }));
    assert.equal(unknown.status, 404);
    const wrongAmount = await callback(signed({ ...base, paidAmountSen: 999 }));
    assert.equal(wrongAmount.status, 400);
    assert.equal((await wrongAmount.json()).error.code, 'PAYMENT_AMOUNT_MISMATCH');

    const ok = await callback(signed(base));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { orderId: order.id, status: 'PAID' });
    const repeat = await callback(signed(base));
    assert.deepEqual(await repeat.json(), { orderId: order.id, status: 'PAID' });
    const other = await callback(signed({ ...base, providerTxnId: 'BANK-2' }));
    assert.equal(other.status, 409);
    assert.equal(lab.platform.services.topups.getOrder(school('smk-contoh').id, order.id).status, 'PAID');
  });
});

describe('payment callback in Simulation mode', () => {
  /** The lab's tracer as the server sees it (has, run): each run is a new trace. */
  function fakeTracer(events) {
    let n = 0;
    const known = new Set();
    const runs = [];
    return {
      runs,
      has: (id) => known.has(id),
      run(meta, fn) {
        const id = `tr_bank${String(++n).padStart(4, '0')}`;
        known.add(id);
        runs.push({ id, meta });
        return { trace: id, result: events.withContext({ trace: id }, fn) };
      },
    };
  }

  test('the bank\'s callback names the trace of the parent\'s Pay, and the payment lands in that trace', async (t) => {
    const { signIn, topUp, lab, url, school } = await startLab(t);
    lab.tracer = fakeTracer(lab.ctx.events);
    const b = await signIn('Rahman bin Yusof');
    const { order, payUrl } = await topUp(b, { amountSen: 1500, key: 'traced-1' });
    const mark = lab.ctx.events.lastSeq();
    const { result: paid, calls } = await watchingFetch(() => b.post(payUrl, { form: { result: 'SUCCESS' } }));
    assert.equal(paid.status, 303);
    const payRun = lab.tracer.runs.at(-1);
    assert.deepEqual(payRun.meta, {
      kind: 'request',
      title: `Mock bank: POST /pay/${order.id}`,
      subject: { area: 'pay', method: 'POST', path: `/pay/${order.id}` },
    });
    const callback = calls.find((c) => c.url === `${url}/api/payments/callback`);
    assert.equal(callback.headers['x-lab-trace'], payRun.id);
    // the callback joined the parent's flow: the order paid and its posting are part of it
    const caused = lab.ctx.events.since(mark);
    assert.ok(caused.some((e) => e.type === 'topup.status' && e.data.status === 'PAID'), JSON.stringify(caused.map((e) => e.type)));
    assert.ok(caused.some((e) => e.type === 'ledger.posting'));
    assert.ok(caused.every((e) => e.trace === payRun.id), JSON.stringify(caused.map((e) => [e.type, e.trace])));
    assert.equal(lab.platform.services.topups.getOrder(school('smk-contoh').id, order.id).status, 'PAID');

    // the same through the script route
    const second = await topUp(b, { amountSen: 700, key: 'traced-2' });
    const { calls: scriptCalls } = await watchingFetch(() => b.post(`/api/pay/${second.order.id}/complete`, { json: { result: 'SUCCESS' } }));
    const scriptRun = lab.tracer.runs.at(-1);
    assert.equal(scriptRun.meta.title, `Mock bank: POST /api/pay/${second.order.id}/complete`);
    assert.equal(scriptCalls.find((c) => c.url === `${url}/api/payments/callback`).headers['x-lab-trace'], scriptRun.id);
  });
});
