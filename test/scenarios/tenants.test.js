import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// docs/SCENARIOS.md exercises 14 and 15 against a real lab (fictional seed, random ports, the lab
// clock standing still): one platform for many schools (onboarding a third one, the lines between
// tenants, suspending one), and the whole cloud server switched off, driven partly from a
// PuTTY-style console session over telnet.

const NET = { timeout: 90_000 };
const SMK = 'smk-contoh';
const SJKC = 'sjkc-contoh';
const NEW = 'smk-teladan';
const AHMAD = '04A13B5C7D2E80'; // smk S1001: RM 30.00
const LEE = '04B2194E6A3C81'; // smk S1002: RM 25.00
const JUNHAO = '0418B47ED06F87'; // sjkc P101: RM 20.00
const XINYI = '0429C58FE17A88'; // sjkc P102: RM 30.00
const UNAVAILABLE = 'Card unavailable, please contact the front desk';

let lab;
let base;
let started;
const errors = [];

/** A free TCP port for the consoles (PuTTY needs a fixed one; tests pick any). */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

before(async () => {
  lab = createLab({
    clockMode: 'manual',
    httpPort: 0,
    mqttPort: 0,
    consolePort: await freePort(),
    jobsMs: 0,
    log: (level, message, meta) => {
      if (level === 'error') errors.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
  });
  started = await lab.start();
  base = started.httpUrl;
});

after(async () => {
  await lab?.stop();
});

// ---- helpers (each scenario file keeps its own copy) --------------------------------------

/** A browser of one person: JSON calls with its own cookies. */
function browser() {
  const jar = new Map();
  async function call(method, path, { json, form, headers = {} } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // an HTML page (the mock bank) stays text
    }
    return { status: res.status, body: data, headers: res.headers };
  }
  return {
    get: (path, headers) => call('GET', path, { headers }),
    post: (path, json = {}, headers) => call('POST', path, { json, headers }),
    form: (path, fields) => call('POST', path, { form: fields }),
  };
}

function ok(res, status = 200) {
  assert.equal(res.status, status, `HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A school office browser signed in as that school's staff member of `role`. */
async function staff(schoolCode, role) {
  const b = browser();
  const options = ok(await b.get('/api/admin/staff-options'));
  const who = options.find((s) => s.schoolCode === schoolCode && s.role === role);
  ok(await b.post('/api/admin/login', { staffId: who.id }));
  return b;
}

/** A parent app browser signed in as the demo parent with this name. */
async function parent(name) {
  const b = browser();
  const who = ok(await b.get('/api/parent/options')).find((p) => p.name === name);
  ok(await b.post('/api/parent/login', { parentId: who.id }));
  return b;
}

async function child(p, name) {
  const { children } = ok(await p.get('/api/parent/children'));
  const found = children.find((c) => c.name.startsWith(name));
  assert.ok(found, `${name} among ${children.map((c) => c.name)}`);
  return found;
}

const balanceOf = async (p, c) => ok(await p.get(`/api/parent/children/${c.schoolId}/${c.memberId}/balance`));

let topupNo = 0;
/** A parent tops up a child and pays at the mock bank (the bank page, then its Pay form). */
async function topUpAndPay(p, c, amountSen) {
  const { order, payUrl } = ok(await p.post(`/api/parent/children/${c.schoolId}/${c.memberId}/topups`, { amountSen }, { 'idempotency-key': `scenario-${++topupNo}` }), 201);
  assert.equal(order.status, 'CREATED');
  const page = await p.get(payUrl);
  assert.equal(page.status, 200);
  assert.match(page.body, /Mock Bank/);
  const paid = await p.form(payUrl, { result: 'SUCCESS' });
  assert.equal(paid.status, 303);
  assert.equal(paid.headers.get('location'), '/parent/');
  return order;
}

async function member(office, memberNo) {
  const found = ok(await office.get('/api/admin/members')).find((m) => m.memberNo === memberNo);
  assert.ok(found, memberNo);
  return found;
}

const tap = (deviceCode, uid, more = {}) => lab.tap({ schoolCode: SMK, deviceCode, uid, ...more });
const items = (...codes) => codes.map((code) => ({ code, qty: 1 }));
const eventsSince = (mark, type, match = () => true) => lab.ctx.events.since(mark).filter((e) => e.type === type && match(e));

/**
 * The end of every exercise: bring every record home (cables in, journals uploaded), then
 * every school's books balance and every card holds what its mirror says.
 */
async function booksBalance() {
  for (const m of lab.terminals.values()) {
    if (!m.cablePlugged) await lab.setCable({ schoolCode: m.schoolCode, deviceCode: m.deviceCode, plugged: true });
  }
  await waitFor(() => [...lab.terminals.values()].every((m) => m.connected && m.state.journal.unsent === 0), {
    timeout: 20_000,
    message: 'every machine connected with its journal uploaded',
  });
  await waitFor(() => lab.checkBooks().ok, { message: 'every card equal to its mirror' });
  for (const s of lab.checkBooks().schools) assert.equal(s.balanced, true, `${s.code} trial balance`);
  assert.deepEqual(errors, []);
}

const machine = (school, code) => lab.terminals.get(`${school}/${code}`);
const machinesOf = (school) => [...lab.terminals.values()].filter((m) => m.schoolCode === school);

async function operator() {
  const b = browser();
  ok(await b.post('/api/operator/login'));
  return b;
}

/** How many purchases with this txn the school's books hold (exactly once is the rule). */
async function copiesOf(finance, txn) {
  return ok(await finance.get('/api/admin/purchases?limit=1000')).filter((p) => p.txn === txn).length;
}

/** A telnet session on the lab's console port, the way PuTTY or nc talks to it. */
async function telnet(address) {
  const [host, port] = address.split(':');
  const socket = net.connect(Number(port), host);
  let text = '';
  let closed = false;
  socket.setEncoding('utf8');
  socket.on('data', (d) => {
    text += d;
  });
  socket.on('close', () => {
    closed = true;
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  await waitFor(() => text.endsWith('onecard> '), { message: 'the banner and prompt' });
  return {
    get closed() {
      return closed;
    },
    /** Type a line; resolves with what the console printed before its next prompt. */
    async type(line, prompt) {
      const from = text.length;
      socket.write(`${line}\r\n`);
      await waitFor(() => text.length > from && text.endsWith(`${prompt} `), { timeout: 20_000, message: `the answer to "${line}"` });
      return text.slice(from, text.length - prompt.length - 1).replace(/\r\n/g, '\n').replace(/\n$/, '');
    },
    /** Type exit at the top prompt: the server says goodbye and closes the connection. */
    async exit() {
      const from = text.length;
      socket.write('exit\r\n');
      await waitFor(() => closed, { message: 'the session to end' });
      return text.slice(from).replace(/\r\n/g, '\n');
    },
    end: () => socket.destroy(),
  };
}

// ---- the exercises -------------------------------------------------------------------------

test('14. One system, many schools (SaaS tenants)', NET, async () => {
  const op = await operator();
  const before = ok(await op.get('/api/operator/schools'));
  assert.deepEqual(before.map((s) => [s.code, s.name, s.status, s.devices.total]), [
    [SMK, 'SMK Seri Contoh', 'ACTIVE', 4],
    [SJKC, 'SJK(C) Contoh', 'ACTIVE', 3],
  ]);
  assert.ok(before.every((s) => 'todaySalesSen' in s && 'openDifferences' in s));

  // onboard a third school: staff, a canteen reader, a water machine, a kiosk and demo students
  const created = ok(await op.post('/api/operator/schools', {
    code: NEW,
    name: 'SMK Teladan (fictional)',
    staff: [{ name: 'Aminah Teladan', role: 'ADMIN' }],
    devices: [
      { code: 'CANTEEN-01', type: 'CANTEEN', location: 'Dewan makan' },
      { code: 'WATER-01', type: 'WATER', location: 'Blok B' },
      { code: 'KIOSK-01', type: 'KIOSK', location: 'Pejabat' },
    ],
    demoMembers: 3,
  }), 201);
  assert.deepEqual(created.devices.map((d) => d.code), ['CANTEEN-01', 'WATER-01', 'KIOSK-01']);
  assert.ok(created.devices.every((d) => /^[0-9a-f]{64}$/.test(d.secret)), 'secrets shown once');

  // the lab: the new site with its machines and cards, straight away
  const site = lab.state().schools.find((s) => s.code === NEW);
  assert.deepEqual(site.devices.map((d) => [d.code, d.location]).sort(), [['CANTEEN-01', 'Dewan makan'], ['KIOSK-01', 'Pejabat'], ['WATER-01', 'Blok B']]);
  assert.equal(site.cards.length, 3);
  assert.ok(site.cards.every((c) => c.balanceSen === 0 && c.platformStatus === 'ACTIVE'));
  assert.equal(site.adminCard.school, NEW);
  await waitFor(() => machine(NEW, 'CANTEEN-01').connected && machine(NEW, 'KIOSK-01').connected, { message: 'the new machines online' });
  assert.equal(machine(NEW, 'WATER-01').cablePlugged, false, 'water points come without a network cable');
  assert.deepEqual(machine(NEW, 'CANTEEN-01').state.versions, { prices: 1, settings: 1, blocklist: 1 });

  // it gets the default prices and settings
  const head = await staff(NEW, 'ADMIN');
  const theirs = ok(await head.get('/api/admin/configs'));
  const ours = ok(await (await staff(SMK, 'OFFICE')).get('/api/admin/configs'));
  assert.deepEqual(theirs.prices.content, ours.prices.content);
  assert.deepEqual(theirs.settings.content, ours.settings.content);

  // a card there works like the other schools: its demo cards start empty, the school adds money
  const card = site.cards[0];
  const tapNew = (deviceCode, more = {}) => lab.tap({ schoolCode: NEW, deviceCode, uid: card.uid, ...more });
  assert.match((await tapNew('CANTEEN-01', { items: items('NASI-LEMAK') })).screen, /^Not enough balance · Balance RM 0\.00$/);
  ok(await head.post('/api/admin/subsidies', { memberId: card.memberId, amountSen: 1000, note: 'welcome' }), 201);
  assert.equal((await tapNew('KIOSK-01')).screen, 'Added RM 10.00 · Balance RM 10.00');
  assert.equal((await tapNew('CANTEEN-01', { items: items('NASI-LEMAK') })).screen, 'Paid RM 3.50 · Balance RM 6.50');
  await waitFor(async () => ok(await op.get('/api/operator/schools')).find((s) => s.code === NEW).todaySalesSen === 350, { message: 'the sale in the overview' });

  // the lines between tenants
  const smkOffice = await staff(SMK, 'OFFICE');
  const sjkcMembers = ok(await (await staff(SJKC, 'OFFICE')).get('/api/admin/members'));
  const smkMembers = ok(await smkOffice.get('/api/admin/members'));
  assert.ok(!smkMembers.some((m) => sjkcMembers.some((x) => x.id === m.id || x.name === m.name)), 'nothing from the other schools');
  for (const id of [sjkcMembers[0].id, card.memberId]) {
    const guessed = await smkOffice.get(`/api/admin/members/${id}`);
    assert.deepEqual([guessed.status, guessed.body.error.code], [404, 'MEMBER_NOT_FOUND'], 'not even by guessing an id');
  }
  const foreign = await lab.fault({ type: 'cross-school-card', schoolCode: SJKC, uid: JUNHAO, toSchoolCode: SMK });
  assert.deepEqual([foreign.refused, foreign.screen, foreign.reason], [true, UNAVAILABLE, 'WRONG_SCHOOL']);
  const crossing = await lab.fault({ type: 'cross-device-publish', schoolCode: SMK, deviceCode: 'CANTEEN-01', toSchoolCode: SJKC });
  assert.deepEqual([crossing.ok, crossing.topic, crossing.brokerRefused, crossing.reachedPlatform], [true, 'lab/v1/sjkc-contoh/CANTEEN-01/records', true, false]);
  const lks = await parent('Lee Kah Seng');
  const { children } = ok(await lks.get('/api/parent/children'));
  assert.deepEqual(children.map((c) => [c.name, c.schoolCode]).sort(), [['Lee Jun Hao', SJKC], ['Lee Mei Ling', SMK]]);
  const ahmadIds = (await child(await parent('Rahman bin Yusof'), 'Ahmad Faiz'));
  const nosy = await lks.get(`/api/parent/children/${ahmadIds.schoolId}/${ahmadIds.memberId}/balance`);
  assert.equal(nosy.status, 404, "nobody else's");

  // the operator suspends one school: its machines go, its people are blocked, the others carry on
  ok(await op.post(`/api/operator/schools/${SJKC}/status`, { status: 'SUSPENDED' }));
  await waitFor(() => machinesOf(SJKC).every((m) => !m.connected), { message: 'the suspended school\'s machines disconnected' });
  assert.ok([...machinesOf(SMK), ...machinesOf(NEW)].filter((m) => m.cablePlugged).every((m) => m.connected));
  const sjkcStaff = ok(await browser().get('/api/admin/staff-options')).find((s) => s.schoolCode === SJKC);
  const refused = await browser().post('/api/admin/login', { staffId: sjkcStaff.id });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'SCHOOL_SUSPENDED']);
  const junhao = children.find((c) => c.schoolCode === SJKC);
  const meiling = children.find((c) => c.schoolCode === SMK);
  assert.equal((await lks.get(`/api/parent/children/${junhao.schoolId}/${junhao.memberId}/balance`)).status, 403);
  assert.equal((await lks.get(`/api/parent/children/${meiling.schoolId}/${meiling.memberId}/balance`)).status, 200);
  const kept = await lab.tap({ schoolCode: SJKC, deviceCode: 'CANTEEN-01', uid: XINYI, items: items('MILO-AIS') });
  assert.deepEqual([kept.ok, kept.sent], [true, false], 'the reader keeps selling and keeps its record');
  const smkSale = await lab.tap({ schoolCode: SMK, deviceCode: 'CANTEEN-01', uid: LEE, items: items('MILO-AIS') });
  assert.equal(smkSale.sent, true, 'the other schools are untouched');
  // reactivated: its machines send what they kept
  ok(await op.post(`/api/operator/schools/${SJKC}/status`, { status: 'ACTIVE' }));
  await waitFor(() => machinesOf(SJKC).every((m) => m.connected) && machine(SJKC, 'CANTEEN-01').state.journal.unsent === 0, {
    timeout: 20_000,
    message: 'the school\'s machines back with their records',
  });
  assert.equal(await copiesOf(await staff(SJKC, 'FINANCE'), kept.record.txn), 1);
  await booksBalance();
});

test('a machine registered and a card issued in a school office come alive in the lab at once', NET, async () => {
  const office = await staff(SMK, 'OFFICE');
  const created = ok(await office.post('/api/admin/devices', { code: 'canteen-03', type: 'CANTEEN', location: 'Kantin guru' }), 201);
  assert.equal(created.device.code, 'CANTEEN-03');
  assert.match(created.secret, /^[0-9a-f]{64}$/);
  await waitFor(() => machine(SMK, 'CANTEEN-03')?.connected, { message: 'the new reader on the broker' });
  assert.deepEqual(machine(SMK, 'CANTEEN-03').state.versions, { prices: 1, settings: 1, blocklist: 1 }, 'installed with the current settings');
  const row = lab.state().schools.find((x) => x.code === SMK).devices.find((d) => d.code === 'CANTEEN-03');
  assert.deepEqual([row.location, row.cablePlugged, row.deviceStatus], ['Kantin guru', true, 'ACTIVE']);
  // a new member with a card: the blank card is in the tray, and the new reader knows the school's cards
  const { member, card } = ok(await office.post('/api/admin/members', { memberNo: 'S1099', name: 'Nadia binti Contoh', className: '2 Dinamik', cardUid: '04ABCDEF012345' }), 201);
  assert.equal(card.uid, '04ABCDEF012345');
  const tray = lab.state().schools.find((x) => x.code === SMK).cards.find((c) => c.uid === '04ABCDEF012345');
  assert.deepEqual([tray.member, tray.balanceSen, tray.platformStatus], [member.name, 0, 'ACTIVE']);
  const empty = await lab.tap({ schoolCode: SMK, deviceCode: 'CANTEEN-03', uid: '04ABCDEF012345', items: items('BUAH') });
  assert.match(empty.screen, /^Not enough balance/);
  const paid = await lab.tap({ schoolCode: SMK, deviceCode: 'CANTEEN-03', uid: AHMAD, items: items('BUAH') });
  assert.deepEqual([paid.ok, paid.sent], [true, true]);
  await booksBalance();
});

test('15. The cloud server goes down (from a telnet console session)', NET, async () => {
  await lab.reset();
  assert.match(started.consoleAddress, /^127\.0\.0\.1:\d+$/);
  const tn = await telnet(started.consoleAddress);
  try {
    assert.match(await tn.type('connect server', 'server#'), /^Connected to the cloud server .*: up\. Type help\.$/);
    // 1. switch the cloud server off: every school loses it at the same moment
    assert.match(await tn.type('server down', 'server#'), /^Cloud server switched off: the broker stopped/);
    assert.equal(lab.server.up, false);
    await waitFor(() => [...lab.terminals.values()].every((m) => !m.connected), { message: 'every machine of every school offline' });
    assert.equal(lab.state().broker.up, false);

    // 2. readers and water machines keep selling; their records wait in their journals
    const sale = await lab.tap({ schoolCode: SMK, deviceCode: 'CANTEEN-01', uid: AHMAD, items: items('NASI-LEMAK') });
    assert.deepEqual([sale.screen, sale.sent], ['Paid RM 3.50 · Balance RM 26.50', false]);
    const pour = await lab.tap({ schoolCode: SJKC, deviceCode: 'WATER-01', uid: JUNHAO, ml: 500 });
    assert.deepEqual([pour.screen, pour.sent], ['Poured 500 ml · Paid RM 0.10 · Balance RM 19.90', false]);

    // 3. the kiosk adds nothing; parents cannot pay; the school office cannot load
    const kiosk = await lab.tap({ schoolCode: SMK, deviceCode: 'KIOSK-01', uid: AHMAD });
    assert.deepEqual([kiosk.screen, kiosk.reason], ['Cannot reach the platform, please come back later', 'OFFLINE']);
    const rahman = browser();
    for (const res of [await rahman.get('/api/parent/options'), await rahman.post('/api/parent/login', { parentId: 'x' }), await browser().get('/api/admin/staff-options')]) {
      assert.deepEqual([res.status, res.body.error.code], [503, 'SERVER_DOWN']);
    }
    assert.equal((await browser().get('/api/lab/state')).body.server.up, false, 'the lab console itself still works');
    const web = ok(await browser().post('/api/lab/console', { line: 'show status', target: 'server' }));
    assert.deepEqual([web.target, web.prompt], ['server', 'server#']);
    assert.match(web.output, /^Cloud server {3}switched OFF/);

    // 4. switch it back on: machines reconnect and upload what they kept (each record once), and
    //    the platform sends every machine its prices, settings and block list again
    const upMark = lab.ctx.events.lastSeq();
    assert.match(await tn.type('server up', 'server#'), /^Cloud server switched on: broker up at mqtt:\/\/127\.0\.0\.1:\d+, platform connected\./);
    const retained = () => eventsSince(upMark, 'mqtt.publish', (e) => e.data.from === 'platform' && e.data.retained);
    await waitFor(() => retained().length === 7 * 3, { message: 'every retained setting for the 7 machines' });
    await waitFor(() => [...lab.terminals.values()].filter((m) => m.cablePlugged).every((m) => m.connected && m.state.journal.unsent === 0), {
      timeout: 20_000,
      message: 'the machines back with their journals uploaded',
    });
    const smkFinance = await staff(SMK, 'FINANCE');
    const sjkcFinance = await staff(SJKC, 'FINANCE');
    await waitFor(async () => (await copiesOf(smkFinance, sale.record.txn)) === 1 && (await copiesOf(sjkcFinance, pour.record.txn)) === 1, {
      message: 'the kept records in the books',
    });

    // 5. restart only the broker, with a sale made while it is away: retained messages are put back,
    //    the machines come back, and the sale reaches the platform exactly once
    const restartMark = lab.ctx.events.lastSeq();
    const restarting = tn.type('broker restart', 'server#');
    await waitFor(() => !machine(SMK, 'CANTEEN-01').connected, { message: 'CANTEEN-01 losing the broker' });
    await lab.advanceClock(5000);
    const during = await lab.tap({ schoolCode: SMK, deviceCode: 'CANTEEN-01', uid: LEE, items: items('TEH-TARIK') });
    assert.deepEqual([during.ok, during.sent], [true, false]);
    assert.match(await restarting, /^MQTT broker restarted: its retained messages were lost\.\nThe platform reconnected at once/);
    await waitFor(() => eventsSince(restartMark, 'mqtt.publish', (e) => e.data.from === 'platform' && e.data.retained).length >= 7 * 3, {
      message: 'the retained settings put back',
    });
    await waitFor(() => [...lab.terminals.values()].filter((m) => m.cablePlugged).every((m) => m.connected && m.state.journal.unsent === 0), {
      timeout: 20_000,
      message: 'the machines back after the restart',
    });
    await waitFor(async () => (await copiesOf(smkFinance, during.record.txn)) === 1, { message: 'the sale made during the restart' });
    assert.equal(await copiesOf(smkFinance, sale.record.txn), 1, 'and the earlier one still once');
    // the school office: every machine with a network on the current versions again (acknowledged over MQTT)
    const office = await staff(SMK, 'OFFICE');
    await waitFor(async () => ok(await office.get('/api/admin/devices/states')).filter((s) => ['CANTEEN-01', 'KIOSK-01'].includes(s.deviceCode)).every((s) => !s.behind && s.via === 'MQTT'), {
      message: 'the versions acknowledged again',
    });

    assert.equal(await tn.type('exit', 'onecard>'), 'Disconnected from the cloud server.');
    assert.equal(await tn.exit(), 'Bye.\n');
    assert.equal(tn.closed, true);
  } finally {
    tn.end();
  }
  await booksBalance();
});
