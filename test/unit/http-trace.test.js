import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestCtx } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { createHttpServer } from '../../src/http/server.js';
import { signRequest } from '../../src/shared/crypto.js';

// Simulation mode on the web server (docs/DESIGN.md §11.3): a person's action in the office,
// operator console, parent app or mock bank (a non-GET request) is a trace of its own, and a
// request naming a trace the lab knows (x-lab-trace) joins it. The lab's tracer is a small
// fake here: the server only needs has(id) and run(meta, fn). Schools, staff and parents are
// the fictional demo seed.

/** A tracer as the server sees it: runs `fn` in a new trace, and knows the traces it started (or was told of). */
function fakeTracer(events) {
  let n = 0;
  const known = new Set();
  const runs = [];
  const asked = [];
  return {
    known,
    runs,
    asked,
    has(id) {
      asked.push(id);
      return known.has(id);
    },
    run(meta, fn) {
      const id = `tr_fake${String(++n).padStart(4, '0')}`;
      known.add(id);
      runs.push({ id, meta });
      return { trace: id, result: events.withContext({ trace: id }, fn) };
    },
  };
}

async function startLab(t, { tracer = true } = {}) {
  const ctx = createTestCtx();
  const platform = createPlatform(ctx);
  const seed = seedDemo(platform);
  const lab = { ctx, platform, server: { up: true }, runJobs: () => ({ ran: true, context: ctx.events.context() }) };
  if (tracer) lab.tracer = fakeTracer(ctx.events);
  const server = createHttpServer({ lab });
  const { url } = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const school = (code) => seed.schools.find((s) => s.code === code);
  const staff = (code, role) => school(code).staff.find((p) => p.role === role);
  const member = (code, memberNo) => school(code).members.find((m) => m.memberNo === memberNo);
  /** A signed kiosk request of smk-contoh's KIOSK-01 (DESIGN §3), with extra headers. */
  async function kiosk(method, path, { body, headers = {} } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(ctx.clock.now());
    const nonce = randomBytes(16).toString('hex');
    const secret = school('smk-contoh').devices.find((d) => d.code === 'KIOSK-01').secret;
    const res = await fetch(url + path, {
      method,
      headers: {
        'x-lab-school': 'smk-contoh',
        'x-lab-device': 'KIOSK-01',
        'x-lab-timestamp': timestamp,
        'x-lab-nonce': nonce,
        'x-lab-signature': signRequest({ secretHex: secret, method, path, timestamp, nonce, body: text }),
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: method === 'GET' ? undefined : text,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  return { ctx, platform, seed, lab, url, tracer: lab.tracer, school, staff, member, kiosk };
}

/** A browser-like client: keeps its cookies, sends JSON. */
function browser(url) {
  const jar = new Map();
  async function call(method, path, { json, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) {
      h['content-type'] ??= 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(url + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, data };
  }
  return { get: (p, o) => call('GET', p, o), post: (p, json = {}, o = {}) => call('POST', p, { json, ...o }) };
}

/** The events since `mark`, as [type, trace or null]. */
const tracesSince = (ctx, mark) => ctx.events.since(mark).map((e) => [e.type, e.trace ?? null]);

describe('request traces', () => {
  test('each non-GET request of the office, operator console and parent app is a trace of its own, with a plain title', async (t) => {
    const { ctx, url, tracer, staff, member, school } = await startLab(t);
    const office = browser(url);
    assert.equal((await office.post('/api/admin/login', { staffId: staff('smk-contoh', 'FINANCE').id })).status, 200);
    // signing in: no staff session yet, so no school
    assert.deepEqual(tracer.runs.map((r) => r.meta), [{ kind: 'request', title: 'School office: POST /api/admin/login' }]);
    assert.equal((await office.get('/api/admin/me')).status, 200);
    assert.equal(tracer.runs.length, 1, 'reading starts no trace');

    const mark = ctx.events.lastSeq();
    const grant = await office.post('/api/admin/subsidies', { memberId: member('smk-contoh', 'S1001').id, amountSen: 500, note: 'trip' });
    assert.equal(grant.status, 201);
    const run = tracer.runs.at(-1);
    assert.deepEqual(run.meta, { kind: 'request', title: 'School office: POST /api/admin/subsidies', school: 'smk-contoh' });
    // everything the request caused carries its trace
    const caused = tracesSince(ctx, mark);
    assert.ok(caused.some(([type]) => type === 'ledger.posting') && caused.some(([type]) => type === 'topup.status'), JSON.stringify(caused));
    assert.ok(caused.every(([, trace]) => trace === run.id), JSON.stringify(caused));
    // and nothing after it
    ctx.events.emit('lab.action', {}, null);
    assert.equal(ctx.events.since(0).at(-1).trace, undefined);

    const operator = browser(url);
    assert.equal((await operator.post('/api/operator/login')).status, 200);
    assert.deepEqual(tracer.runs.at(-1).meta, { kind: 'request', title: 'Operator console: POST /api/operator/login' });
    const smk = school('smk-contoh');
    assert.equal((await operator.post(`/api/operator/schools/${smk.code}/status`, { status: 'SUSPENDED' })).status, 200);
    assert.deepEqual(tracer.runs.at(-1).meta, { kind: 'request', title: 'Operator console: POST /api/operator/schools/smk-contoh/status' });
    const parent = browser(url);
    await parent.post('/api/parent/login', { parentId: 'par_nobody' });
    assert.deepEqual(tracer.runs.at(-1).meta, { kind: 'request', title: 'Parent app: POST /api/parent/login' });
    assert.equal(tracer.runs.length, 5);
  });

  test('a refused request is still the person\'s action and gets its trace; a switched-off server answers before any', async (t) => {
    const { ctx, url, lab, tracer, member } = await startLab(t);
    const nobody = browser(url);
    const refused = await nobody.post('/api/admin/subsidies', { memberId: member('smk-contoh', 'S1001').id, amountSen: 500 });
    assert.equal(refused.status, 401);
    assert.deepEqual(tracer.runs.map((r) => r.meta.title), ['School office: POST /api/admin/subsidies']);
    lab.server.up = false;
    assert.equal((await nobody.post('/api/admin/login', { staffId: 'stf_nobody' })).status, 503);
    assert.equal(tracer.runs.length, 1);
    lab.server.up = true;
    assert.equal(ctx.events.since(0).filter((e) => e.trace).length, 0, 'nothing happened in those traces');
  });

  test('the lab\'s own routes, GET requests and kiosk requests start no trace of the server\'s', async (t) => {
    const { url, tracer, kiosk } = await startLab(t);
    const b = browser(url);
    assert.equal((await b.get('/api/admin/staff-options')).status, 200);
    // the lab traces its own actions: its routes neither start a trace here nor join one named to them
    tracer.known.add('tr_known0001');
    const jobs = await b.post('/api/lab/jobs/run', {}, { headers: { 'x-lab-trace': 'tr_known0001' } });
    assert.deepEqual(jobs.data, { ran: true, context: null });
    assert.equal((await kiosk('GET', '/api/kiosk/packs')).status, 200);
    assert.equal((await kiosk('POST', '/api/kiosk/pending', { body: { card: 'ab'.repeat(32) } })).status, 404);
    assert.deepEqual(tracer.runs, []);
  });

  test('without a tracer nothing changes: no trace on any event', async (t) => {
    const { ctx, url, staff, member } = await startLab(t, { tracer: false });
    const office = browser(url);
    await office.post('/api/admin/login', { staffId: staff('smk-contoh', 'FINANCE').id });
    assert.equal((await office.post('/api/admin/subsidies', { memberId: member('smk-contoh', 'S1001').id, amountSen: 500 })).status, 201);
    assert.ok(ctx.events.since(0).every((e) => !('trace' in e)));
  });

  test('a tracer that fails does not cost the person their request', async (t) => {
    const { ctx, url, lab, staff, member } = await startLab(t);
    const logs = [];
    ctx.log = (level, message, meta) => logs.push({ level, message, meta });
    lab.tracer = {
      has: () => {
        throw new Error('has broke');
      },
      run: () => {
        throw new Error('run broke');
      },
    };
    const office = browser(url);
    assert.equal((await office.post('/api/admin/login', { staffId: staff('smk-contoh', 'FINANCE').id }, { headers: { 'x-lab-trace': 'tr_whatever01' } })).status, 200);
    assert.equal((await office.post('/api/admin/subsidies', { memberId: member('smk-contoh', 'S1001').id, amountSen: 500 })).status, 201);
    assert.ok(logs.some((l) => l.level === 'warn' && l.meta.error === 'run broke'));
    assert.ok(ctx.events.since(0).every((e) => !('trace' in e)));
  });
});

describe('x-lab-trace', () => {
  test('a well-formed id the tracer knows is joined; anything else is ignored', async (t) => {
    const { ctx, url, tracer, staff, member, kiosk } = await startLab(t);
    const office = browser(url);
    await office.post('/api/admin/login', { staffId: staff('smk-contoh', 'FINANCE').id });
    tracer.known.add('tr_known0001');
    tracer.asked.length = 0;
    const grant = (headers) => office.post('/api/admin/subsidies', { memberId: member('smk-contoh', 'S1001').id, amountSen: 100 }, { headers });

    // joined: no new trace, everything in the named one
    const runs = tracer.runs.length;
    let mark = ctx.events.lastSeq();
    assert.equal((await grant({ 'x-lab-trace': 'tr_known0001' })).status, 201);
    assert.equal(tracer.runs.length, runs);
    assert.ok(tracesSince(ctx, mark).every(([, trace]) => trace === 'tr_known0001'), JSON.stringify(tracesSince(ctx, mark)));

    // well formed but unknown: asked, then ignored (the request starts its own trace as usual)
    mark = ctx.events.lastSeq();
    assert.equal((await grant({ 'x-lab-trace': 'tr_unknown01' })).status, 201);
    assert.equal(tracer.runs.length, runs + 1);
    assert.ok(tracesSince(ctx, mark).every(([, trace]) => trace === tracer.runs.at(-1).id));
    assert.deepEqual(tracer.asked, ['tr_known0001', 'tr_unknown01']);

    // not a trace id at all: never even looked up
    const malformed = ['tr_abc', 'TR_known0001', 'tr_known0001 x', 'tr_kn/own0001', 'tr_known0001, tr_known0001', `tr_${'a'.repeat(65)}`, 'known0001'];
    for (const value of malformed) {
      mark = ctx.events.lastSeq();
      assert.equal((await grant({ 'x-lab-trace': value })).status, 201, value);
      assert.ok(tracesSince(ctx, mark).every(([, trace]) => trace === tracer.runs.at(-1).id), value);
    }
    assert.equal(tracer.runs.length, runs + 1 + malformed.length);
    assert.deepEqual(tracer.asked, ['tr_known0001', 'tr_unknown01']);

    // a kiosk call from the lab names the tap's trace: the platform's side of it joins the flow
    tracer.known.add('tr_kiosktap01');
    mark = ctx.events.lastSeq();
    assert.equal((await kiosk('GET', '/api/kiosk/packs', { headers: { 'x-lab-trace': 'tr_kiosktap01' } })).status, 200);
    const caused = tracesSince(ctx, mark);
    assert.deepEqual(caused.map(([type]) => type).sort(), ['audit', 'http.kiosk']);
    assert.ok(caused.every(([, trace]) => trace === 'tr_kiosktap01'));
    mark = ctx.events.lastSeq();
    await kiosk('GET', '/api/kiosk/packs', { headers: { 'x-lab-trace': 'tr_notknown01' } });
    assert.ok(tracesSince(ctx, mark).every(([, trace]) => trace === null), 'an unknown trace is not joined, and a kiosk call starts none');
  });
});

describe('the server itself', () => {
  test('listens untraced: no request inherits the trace of the flow that started the server', async (t) => {
    const ctx = createTestCtx();
    const platform = createPlatform(ctx);
    seedDemo(platform);
    const server = createHttpServer({ lab: { ctx, platform, server: { up: true } } });
    const { url } = await ctx.events.withContext({ trace: 'tr_startup01' }, () => server.listen(0, '127.0.0.1'));
    t.after(() => server.close());
    const res = await fetch(`${url}/api/kiosk/pending`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    const [report] = ctx.events.since(0).filter((e) => e.type === 'http.kiosk');
    assert.deepEqual([report.data.status, 'trace' in report], [401, false]);
  });
});
