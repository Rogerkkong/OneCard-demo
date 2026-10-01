import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../../src/lab/lab.js';
import { createConsole, MAX_LINE, SERVER_PROMPT, TOP_PROMPT, UNKNOWN_COMMAND } from '../../src/lab/console.js';
import { waitFor } from '../helpers.js';

// The PuTTY-style console (DESIGN §8) against a real lab: the demo seed (fictional schools,
// people and cards), a broker and web server on random ports and the lab clock standing still.
// Tests run in order and build on each other (a sale, then its journal, then the log ...).

const NET = { timeout: 30_000 };
const AHMAD = '04A13B5C7D2E80'; // smk-contoh S1001, RM 30.00 on the card, RM 20.00 waiting
const LEE = '04B2194E6A3C81'; // smk-contoh S1002, RM 25.00
const ARJUN = '04C35D2F8B1A82'; // smk-contoh S1003, RM 40.00
const IRFAN = '04F6925CBE4D85'; // smk-contoh S1006, RM 0.00
const DATE_RE = /\b\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\b/;

const errors = [];
let lab;
let shell;
const outputs = []; // every answer, for the line-length check at the end

before(async () => {
  lab = createLab({
    clockMode: 'manual',
    httpPort: 0,
    mqttPort: 0,
    consolePort: 0,
    jobsMs: 0,
    log: (level, message, meta) => {
      if (level === 'error') errors.push({ message, meta });
    },
  });
  await lab.start();
  shell = createConsole(lab);
});

after(async () => {
  await lab?.stop();
});

/** A console session: run(line) -> { output, prompt, exit? }; `target` is the session's. */
function session(target = null) {
  const s = { target };
  const run = async (line) => {
    const answer = await shell.run(s, line);
    outputs.push(answer.output);
    return answer;
  };
  const out = async (line) => (await run(line)).output;
  return { s, run, out };
}

const lines = (text) => text.split('\n');
/** Does this card's chip balance equal its member's mirror? (other cards may still have records on their way) */
const cardMatches = (uid) => lab.checkBooks().schools.flatMap((x) => x.cards).find((c) => c.uid === uid)?.match === true;
/** The cells of an aligned table row (columns are two or more spaces apart). */
const cells = (row) => row.trim().split(/\s{2,}/);

test('the prompt follows connect, disconnect and exit, and exit at the top ends the session', NET, async () => {
  const { s, run } = session();
  assert.equal(shell.prompt(s), TOP_PROMPT);
  assert.equal((await run('')).prompt, TOP_PROMPT);
  let a = await run('connect server');
  assert.equal(a.prompt, SERVER_PROMPT);
  assert.equal(s.target, 'server');
  assert.match(a.output, /^Connected to the cloud server .*: up\. Type help\.$/);
  a = await run('connect smk-contoh/CANTEEN-01');
  assert.equal(a.prompt, 'smk-contoh/CANTEEN-01>');
  assert.equal(a.output, 'Connected to smk-contoh/CANTEEN-01, canteen reader. Type help.');
  // codes are typed in any case
  a = await run('CONNECT SJKC-CONTOH/kiosk-01');
  assert.equal(a.prompt, 'sjkc-contoh/KIOSK-01>');
  a = await run('disconnect');
  assert.equal(a.output, 'Disconnected from sjkc-contoh/KIOSK-01.');
  assert.equal(a.prompt, TOP_PROMPT);
  assert.equal((await run('disconnect')).output, '% Not connected to anything.');
  await run('connect server');
  a = await run('exit');
  assert.equal(a.output, 'Disconnected from the cloud server.');
  assert.equal(a.prompt, TOP_PROMPT);
  assert.equal(a.exit, undefined);
  a = await run('exit');
  assert.deepEqual(a, { output: 'Bye.', prompt: TOP_PROMPT, exit: true });
  assert.equal((await run('QUIT')).exit, true);
  assert.equal((await run('exit now')).output, '% Invalid input. Usage: exit');
});

test('help and ? list what works at each prompt, and the top one names the MQTT Explorer login', NET, async () => {
  const { out } = session();
  const top = await out('help');
  assert.equal(await out('?'), top);
  for (const cmd of ['machines', 'connect <school>/<DEVICE>', 'connect server', 'clock', 'help or ?', 'exit']) assert.ok(top.includes(cmd), cmd);
  assert.ok(!top.includes('show schools') && !top.includes('tap <uid>'));
  const port = new URL(lab.broker.url).port;
  assert.ok(top.includes(`MQTT Explorer: 127.0.0.1:${port}, viewer / viewer`), top);

  const { out: server } = session('server');
  const serverHelp = await server('help');
  for (const cmd of ['show schools', 'show clients', 'show status', 'server down | server up', 'broker restart', 'clock advance <n>m|h|d', 'jobs run']) {
    assert.ok(serverHelp.includes(cmd), cmd);
  }
  assert.ok(!serverHelp.includes('cable plug'));

  const machineHelp = async (target) => session(target).out('?');
  const canteen = await machineHelp('smk-contoh/CANTEEN-01');
  const water = await machineHelp('smk-contoh/WATER-01');
  const kiosk = await machineHelp('smk-contoh/KIOSK-01');
  for (const help of [canteen, water, kiosk]) {
    for (const cmd of ['show status | config | prices | blocklist', 'show journal [n]', 'show log [n]', 'cable plug | cable unplug', 'heartbeat', 'upload', 'export usb', 'reboot']) {
      assert.ok(help.includes(cmd), cmd);
    }
  }
  assert.ok(canteen.includes('tap <uid> <ITEM>[*qty] ...') && canteen.includes('admin-card tap') && !canteen.includes('pour'));
  assert.ok(water.includes('pour <uid> <ml>') && water.includes('admin-card tap') && !water.includes('tap <uid>'));
  assert.ok(kiosk.includes('tap <uid> [fault]') && kiosk.includes('admin-card load') && kiosk.includes('admin-card upload'));
  assert.ok(!kiosk.includes('admin-card tap') && !kiosk.includes('pour'));
  assert.match(canteen, /^Commands at smk-contoh\/CANTEEN-01> \(canteen reader\)/);
});

test('unknown commands, commands of another prompt and bad arguments answer like a switch', NET, async () => {
  const top = session();
  assert.equal(await top.out('bogus'), UNKNOWN_COMMAND);
  assert.equal(await top.out('show schools'), UNKNOWN_COMMAND);
  assert.equal(await top.out('tap 04A13B5C7D2E80 NASI-LEMAK'), UNKNOWN_COMMAND);
  assert.equal(await top.out('connect'), '% Incomplete command. Usage: connect server, or connect <school>/<DEVICE>');
  assert.match(await top.out('connect nowhere'), /^% Invalid input\. Usage: connect <school>\/<DEVICE>/);
  assert.equal(await top.out('connect smk-contoh/NOPE-01'), '% No machine smk-contoh/NOPE-01. Type machines to list them.');
  assert.match(await top.out('clock advance 1h'), /^% The lab clock is moved from the server: connect server/);
  assert.equal(await top.out('help me'), '% Invalid input. Type help.');

  const server = session('server');
  assert.equal(await server.out('tap 04A13B5C7D2E80'), UNKNOWN_COMMAND);
  assert.equal(await server.out('show'), '% Incomplete command. Usage: show schools | clients | status');
  assert.equal(await server.out('show money'), '% Invalid input. Usage: show schools | clients | status');
  assert.equal(await server.out('server'), '% Incomplete command. Usage: server down | server up');
  assert.equal(await server.out('server sideways'), '% Invalid input. Usage: server down | server up');
  assert.equal(await server.out('jobs'), '% Incomplete command. Usage: jobs run');
  assert.equal(await server.out('broker'), '% Incomplete command. Usage: broker restart');

  const canteen = session('smk-contoh/CANTEEN-01');
  assert.equal(await canteen.out('pour 04C35D2F8B1A82 650'), UNKNOWN_COMMAND);
  assert.equal(await canteen.out('admin-card load'), UNKNOWN_COMMAND);
  assert.match(await canteen.out('show'), /^% Incomplete command\. Usage: show status/);
  assert.match(await canteen.out('show everything'), /^% Invalid input\. Usage: show status/);
  assert.equal(await canteen.out('show journal x'), '% Invalid input. Usage: show journal [n], e.g. show journal 20');
  assert.equal(await canteen.out('show log 0'), '% Invalid input. Usage: show log [n], e.g. show log 20');
  assert.equal(await canteen.out('cable'), '% Incomplete command. Usage: cable plug | cable unplug');
  assert.equal(await canteen.out('cable chew'), '% Invalid input. Usage: cable plug | cable unplug');
  assert.match(await canteen.out('tap 04A13B5C7D2E80'), /^% Incomplete command\. Usage: tap <uid> <ITEM>\[\*qty\]/);
  // the lab's own refusals come back as one line starting with %
  assert.equal(await canteen.out('tap NOT-A-CARD NASI-LEMAK'), '% Card UID must be 8 to 20 hex characters (4 to 10 bytes).');
  assert.equal(await canteen.out('tap 04AAAAAAAAAAAA NASI-LEMAK'), '% There is no card 04AAAAAAAAAAAA in the lab.');
  assert.match(await canteen.out('tap 04A13B5C7D2E80 NASI-LEMAK*x'), /^% Item NASI-LEMAK\*x must look like NASI-LEMAK or TEH-TARIK\*2\.$/);

  const water = session('smk-contoh/WATER-01');
  assert.equal(await water.out('tap 04C35D2F8B1A82'), UNKNOWN_COMMAND);
  assert.match(await water.out('pour 04C35D2F8B1A82'), /^% Incomplete command\. Usage: pour <uid> <ml>/);
  assert.match(await water.out('pour 04C35D2F8B1A82 lots'), /^% Invalid input\. Usage: pour <uid> <ml>/);

  const kiosk = session('smk-contoh/KIOSK-01');
  assert.deepEqual(lines(await kiosk.out('tap 04A13B5C7D2E80 lightning')), [
    '% Invalid input. Usage: tap <uid> [fault]',
    '  fault: power-cut-before-commit, power-cut-after-commit, confirm-timeout',
  ]);
  assert.equal(await kiosk.out('admin-card tap'), UNKNOWN_COMMAND);
  assert.equal(await kiosk.out('admin-card'), '% Incomplete command. Type help for the admin-card commands here.');
});

test('machines lists every machine of every school with cable, link, versions and location', NET, async () => {
  const text = await session().out('MACHINES');
  const rows = lines(text);
  assert.deepEqual(cells(rows[0]), ['SCHOOL', 'MACHINE', 'TYPE', 'CABLE', 'LINK', 'VERSIONS', 'UNSENT', 'LOCATION']);
  const body = rows.slice(1, -1).map(cells);
  assert.deepEqual(body.map((r) => `${r[0]}/${r[1]}`), [
    'smk-contoh/CANTEEN-01', 'smk-contoh/CANTEEN-02', 'smk-contoh/KIOSK-01', 'smk-contoh/WATER-01',
    'sjkc-contoh/CANTEEN-01', 'sjkc-contoh/KIOSK-01', 'sjkc-contoh/WATER-01',
  ]);
  assert.deepEqual(body[0], ['smk-contoh', 'CANTEEN-01', 'CANTEEN', 'in', 'up', 'P1 S1 B1', '0', 'Canteen counter A']);
  assert.deepEqual(body[1], ['smk-contoh', 'CANTEEN-02', 'CANTEEN', 'out', 'down', 'P1 S1 B1', '0', 'Canteen counter B (no network)']);
  assert.deepEqual(body[3].slice(2, 5), ['WATER', 'out', 'down']);
  // aligned: every column starts at the same place on every row
  const starts = (row) => [...row.matchAll(/(?:^|\s{2})(\S)/g)].map((m) => m.index + (m[0].length - 1));
  for (const row of rows.slice(1, -1)) assert.deepEqual(starts(row).slice(0, 7), starts(rows[0]).slice(0, 7));
  assert.match(rows.at(-1), /^7 machines\. VERSIONS: P prices, S settings, B block list/);
});

test('clock shows the lab time in Kuala Lumpur', NET, async () => {
  assert.equal(await session().out('clock'), 'Lab clock: 05/10/2026 10:00 (Kuala Lumpur, UTC+8), standing still until advanced.');
  assert.equal(await session('smk-contoh/WATER-01').out('clock'), 'Lab clock: 05/10/2026 10:00 (Kuala Lumpur, UTC+8), standing still until advanced.');
});

test('server#: show schools, show clients and show status', NET, async () => {
  const { out } = session('server');
  const schools = lines(await out('show schools'));
  assert.deepEqual(cells(schools[0]), ['CODE', 'NAME', 'STATUS', 'MEMBERS', 'CARDS', 'ONLINE', 'SALES TODAY', 'WAITING', 'DIFFS']);
  // RM 30.00 waiting: S1001's RM 20.00 top-up and S1005's RM 10.00 subsidy
  assert.deepEqual(cells(schools[1]), ['smk-contoh', 'SMK Seri Contoh', 'ACTIVE', '7', '7', '2/4', 'RM 0.00', 'RM 30.00', '0']);
  assert.deepEqual(cells(schools[2]), ['sjkc-contoh', 'SJK(C) Contoh', 'ACTIVE', '4', '4', '3/3', 'RM 0.00', 'RM 10.00', '0']);
  assert.match(schools[3], /^2 schools on one platform\./);

  const clients = lines(await out('show clients'));
  assert.match(clients[0], /^Broker mqtt:\/\/127\.0\.0\.1:\d+: 6 connections$/);
  assert.deepEqual(clients.slice(1).map(cells), [
    ['SCHOOL', 'CONNECTIONS', 'CLIENTS'],
    ['(platform)', '1', 'onecard-platform'],
    ['sjkc-contoh', '3', 'CANTEEN-01, KIOSK-01, WATER-01'],
    ['smk-contoh', '2', 'CANTEEN-01, KIOSK-01'],
  ]);

  const status = await out('show status');
  assert.match(status, /^Cloud server {3}up$/m);
  assert.match(status, /^MQTT broker {4}up at mqtt:\/\/127\.0\.0\.1:\d+, 6 connections$/m);
  assert.match(status, /^Platform link {2}connected to the broker$/m);
  assert.match(status, /^Web apps {7}http:\/\/127\.0\.0\.1:\d+$/m);
  assert.match(status, /^Lab clock {6}05\/10\/2026 10:00 \(KL\), standing still until advanced$/m);
  assert.match(status, /^Schools {8}2 \(2 active\), 0 open differences$/m);
  assert.match(status, /^Jobs {11}only when run \(jobs run\)$/m);
});

test('a machine: show status, show config, show prices and show blocklist', NET, async () => {
  const { out } = session('smk-contoh/CANTEEN-01');
  const status = await out('show status');
  assert.match(status, /^smk-contoh\/CANTEEN-01 {2}canteen reader {2}Canteen counter A$/m);
  assert.match(status, /^Cable {8}plugged in$/m);
  assert.match(status, /^Broker link {2}up \(as smk-contoh\.CANTEEN-01\)$/m);
  assert.match(status, /^Platform {5}ACTIVE, online, last heartbeat 05\/10\/2026 10:00$/m);
  assert.match(status, /^Versions {5}prices v1, settings v1, block list v1 \(0 cards\)$/m);
  assert.match(status, /^Journal {6}0 records, 0 unsent$/m);
  assert.match(status, /^Screen {7}\(blank\)$/m);

  const config = await out('show config');
  assert.match(config, /^Prices {6}v1, effective 05\/10\/2026 10:00: 7 items, water RM 0\.20 a litre \(minimum RM 0\.05\)$/m);
  assert.match(config, /^ {2}Meal windows {3}06:30-18:30$/m);
  assert.match(config, /^ {2}Per purchase {3}up to RM 20\.00$/m);
  assert.match(config, /^ {2}Per day {8}up to RM 30\.00 and 10 purchases$/m);
  assert.match(config, /^ {2}Tap gap {8}3 s$/m);
  assert.match(config, /^Block list {2}v1: 0 cards$/m);

  const prices = lines(await out('show prices'));
  assert.equal(prices[0], 'Price list v1 on this machine (effective 05/10/2026 10:00)');
  assert.deepEqual(cells(prices[1]), ['CODE', 'ITEM', 'PRICE']);
  assert.deepEqual(cells(prices[2]), ['NASI-LEMAK', 'Nasi lemak', 'RM 3.50']);
  assert.deepEqual(cells(prices[5]), ['TEH-TARIK', 'Teh tarik', 'RM 1.80']);
  assert.equal(prices.at(-1), 'Water: RM 0.20 a litre, minimum RM 0.05');

  assert.equal(await out('show blocklist'), 'Block list v1 on this machine: 0 cards');
});

test('a canteen reader sells with tap, and show journal lists the record', NET, async () => {
  const { out } = session('smk-contoh/CANTEEN-01');
  const sale = lines(await out(`tap ${AHMAD.toLowerCase()} nasi-lemak TEH-TARIK*2`));
  assert.deepEqual(sale, [
    'Screen: Paid RM 7.10 · Balance RM 22.90',
    `Card ${AHMAD} now holds RM 22.90 (card counter 3).`,
    'Record CANTEEN-01-000001 sent to the platform.',
  ]);
  // the same card again at once: the tap gap (3 s) refuses it, and the lab says why
  const again = lines(await out(`tap ${AHMAD} BUAH`));
  assert.deepEqual(again, ['Screen: Please wait 3 s and tap again', '(lab: refused because TAP_GAP; the screen never says why)']);
  const journal = lines(await out('show journal'));
  assert.equal(journal[0], 'Journal: 1 record, 0 unsent (the last 1, newest last)');
  assert.deepEqual(cells(journal[1]), ['TXN', 'TIME', 'WHAT', 'AMOUNT', 'CARD', 'BALANCE', 'SENT']);
  assert.deepEqual(cells(journal[2]), ['CANTEEN-01-000001', '05/10/2026 10:00', 'NASI-LEMAK TEH-TARIK*2', 'RM 7.10', '2E80', 'RM 22.90', 'sent']);
  assert.equal(await session('smk-contoh/CANTEEN-02').out('show journal'), 'The journal is empty: no purchase made on this machine yet.');
  await waitFor(() => lab.checkBooks().ok, { message: 'the sale in the books' });
});

test('show log shows the platform\'s device log for the machine', NET, async () => {
  const { out } = session('smk-contoh/CANTEEN-01');
  assert.equal(await out('show log'), "The platform's device log for smk-contoh/CANTEEN-01 is empty.");
  const forged = await lab.fault({ type: 'forged-message', schoolCode: 'smk-contoh', deviceCode: 'CANTEEN-01' });
  assert.equal(forged.ok, true, forged.summary);
  const log = lines(await out('show log 5'));
  assert.equal(log[0], 'Device log for smk-contoh/CANTEEN-01 on the platform (the last 1, newest last)');
  assert.deepEqual(cells(log[1]), ['TIME', 'LEVEL', 'CODE', 'MESSAGE']);
  assert.deepEqual(cells(log[2]), ['05/10/2026 10:00', 'WARN', 'SIGNATURE_INVALID', 'signature does not match']);
});

test('cable unplug and plug, heartbeat and upload, offline and online', NET, async () => {
  const { out } = session('smk-contoh/CANTEEN-01');
  assert.equal(await out('cable plug'), 'The cable is already plugged in.');
  assert.match(await out('heartbeat'), /^Heartbeat sent: prices v1, settings v1, block list v1, 0 unsent\.$/);
  assert.equal(await out('upload'), 'Nothing to upload: every record is sent.');
  assert.equal(await out('cable unplug'), 'Cable pulled out: the machine keeps working offline; its records wait in the journal.');
  assert.equal(await out('cable unplug'), 'The cable is already out.');
  await lab.advanceClock(5000);
  assert.deepEqual(lines(await out(`tap ${LEE} ROTI-CANAI`)).slice(-1), ['Record CANTEEN-01-000002 waits in the journal (no network).']);
  assert.equal(await out('heartbeat'), '% Not connected to the broker: no heartbeat sent.');
  assert.equal(await out('upload'), '% Not connected to the broker: 1 record waits in the journal.');
  assert.match(await out('show status'), /^Journal {6}2 records, 1 unsent$/m);
  assert.equal(await out('cable plug'), 'Cable plugged in: connected to the broker, heartbeat sent, 1 unsent record uploaded.');
  assert.match(await out('show status'), /^Journal {6}2 records, 0 unsent$/m);
  await waitFor(() => lab.checkBooks().ok, { message: 'the offline sale in the books' });
});

test('export usb copies the journal, and reboot keeps the counters', NET, async () => {
  const { out } = session('smk-contoh/CANTEEN-01');
  assert.deepEqual(lines(await out('export usb')), [
    'Journal copied to USB: 2 records, file onecard-lab-journal/1 signed by CANTEEN-01.',
    'Import the file in the school office (import journal); the web lab console downloads it.',
  ]);
  const before = lab.terminals.get('smk-contoh/CANTEEN-01').state;
  const text = await out('reboot');
  const m = /^Rebooted\. Counters kept: seq (\d+), txn 2; journal 2 records \(0 unsent\)\. Broker link up\.$/.exec(text);
  assert.ok(m, text);
  // the counters went on from where they were: a reboot sends its heartbeat with the next seq
  assert.ok(Number(m[1]) > before.seq);
  assert.equal(lab.terminals.get('smk-contoh/CANTEEN-01').state.txnCounter, before.txnCounter);
});

test('a water machine pours, refuses an empty card, and reads the admin card', NET, async () => {
  const { out } = session('smk-contoh/WATER-01');
  assert.deepEqual(lines(await out(`pour ${ARJUN} 650`)), [
    'Screen: Poured 650 ml · Paid RM 0.13 · Balance RM 39.87',
    `Card ${ARJUN} now holds RM 39.87 (card counter 3).`,
    'Record WATER-01-000001 waits in the journal (no network).',
  ]);
  assert.deepEqual(lines(await out(`pour ${IRFAN} 250`)), [
    'Screen: Not enough balance · Balance RM 0.00',
    '(lab: refused because INSUFFICIENT_BALANCE; the screen never says why)',
  ]);
  // the admin card is loaded at the kiosk, read by the offline machine, and its receipts go back
  const kiosk = session('smk-contoh/KIOSK-01');
  assert.deepEqual(lines(await kiosk.out('admin-card load')), [
    'Screen: Admin card loaded · token 1 · 3 packs',
    'Admin card now carries blocklist v1, prices v1, settings v1 (token 1).',
  ]);
  const read = lines(await out('admin-card tap'));
  assert.equal(read[0], 'Screen: Admin card read: 0 applied, 3 already applied, 0 rejected');
  assert.deepEqual(cells(read[1]), ['KIND', 'VERSION', 'RESULT', 'WHY']);
  assert.deepEqual(read.slice(2, 5).map(cells), [
    ['blocklist', 'v1', 'ALREADY_APPLIED'],
    ['prices', 'v1', 'ALREADY_APPLIED'],
    ['settings', 'v1', 'ALREADY_APPLIED'],
  ]);
  assert.equal(read[5], 'Receipts are on the admin card: upload them at the kiosk (admin-card upload).');
  assert.equal(await kiosk.out('admin-card upload'), 'Screen: Admin card receipts uploaded · 3');
  assert.equal(await kiosk.out('admin-card upload'), 'Screen: No receipts on the admin card');
});

test('a kiosk adds waiting money, takes its faults, and reads back the card', NET, async () => {
  const { out } = session('smk-contoh/KIOSK-01');
  // Ahmad Faiz has RM 20.00 waiting; a power cut before the write adds nothing
  const cut = lines(await out(`tap ${AHMAD} power-cut-before-commit`));
  assert.equal(cut[0], 'Screen: Power cut while adding money, please tap again');
  assert.match(cut[1], /^\(lab: power cut on order ord_\w+, RM 20\.00: the write did not reach the card\)$/);
  assert.equal(cut.at(-1), `Card ${AHMAD} now holds RM 22.90 (card counter 3).`);
  const added = lines(await out(`tap ${AHMAD}`));
  assert.equal(added[0], 'Screen: Added RM 20.00 · Balance RM 42.90');
  assert.match(added[1], /^ {2}added RM 20\.00 {2}order ord_\w+ {2}KIOSK-01-\d{6} {2}confirmed$/);
  assert.equal(added.at(-2), "Read-back: the card's balance and 1 record went to the platform.");
  assert.equal(added.at(-1), `Card ${AHMAD} now holds RM 42.90 (card counter 4).`);
  assert.deepEqual(lines(await out(`tap ${LEE}`)).slice(0, 1), ['Screen: Nothing to add · Balance RM 23.50']);
  // Arjun's water sale is still in WATER-01's journal, so only the cards used here are compared
  await waitFor(() => cardMatches(AHMAD) && cardMatches(LEE), { message: 'the kiosk write in the books' });
});

test('server#: clock advance and jobs run', NET, async () => {
  const { out } = session('server');
  assert.equal(await out('clock advance'), '% Incomplete command. Usage: clock advance <n>m|h|d, e.g. clock advance 15d');
  assert.match(await out('clock advance soon'), /^% Invalid input\. Usage: clock advance <n>m\|h\|d/);
  assert.equal(await out('clock advance 0d'), '% Invalid input: from 1 minute to 400 days.');
  assert.equal(await out('clock advance 401d'), '% Invalid input: from 1 minute to 400 days.');
  assert.deepEqual(lines(await out('clock advance 90m')), [
    'Lab clock moved forward 90 minutes: now 05/10/2026 11:30 (KL).',
    'Jobs ran: 0 cancelled, 0 refunded, 0 parked; reconciliation found 0 gaps and 0 old block lists.',
  ]);
  assert.match(await out('clock advance 1 h'), /^Lab clock moved forward 1 hour: now 05\/10\/2026 12:30 \(KL\)\./);
  const jobs = lines(await out('jobs run'));
  assert.equal(jobs[0], 'Jobs ran for 2 active schools:');
  assert.deepEqual(cells(jobs[1]), ['SCHOOL', 'CANCELLED', 'REFUNDED', 'PARKED', 'GAPS', 'OLD LISTS', 'RESULT']);
  assert.deepEqual(cells(jobs[2]), ['smk-contoh', '0', '0', '0', '0', '0', 'ok']);
});

test('server#: server down and up, and broker restart', NET, async () => {
  const { out } = session('server');
  assert.equal(await out('server up'), '% The cloud server is already on.');
  assert.deepEqual(lines(await out('server down')), [
    'Cloud server switched off: the broker stopped, the platform is offline and the web apps answer 503.',
    'Readers and water machines keep selling offline; the kiosk adds nothing until the server is back.',
  ]);
  assert.equal(lab.server.up, false);
  assert.equal(await out('server down'), '% The cloud server is already off.');
  assert.equal(await out('show schools'), '% The cloud server is switched off: its database cannot be read. Type server up.');
  assert.equal(await out('show clients'), '% The cloud server is switched off: there is no broker. Type server up.');
  assert.equal(await out('jobs run'), '% The cloud server is switched off: nothing runs on it. Type server up.');
  assert.match(await out('broker restart'), /^% The cloud server is switched off: switch it on first\.$/);
  assert.match(await out('show status'), /^Cloud server {3}switched OFF/m);
  assert.match(await out('clock advance 1m'), /\nThe jobs did not run: the cloud server is off\.$/);
  // a machine works on: its own commands, but not the platform's device log
  await waitFor(() => !lab.terminals.get('smk-contoh/CANTEEN-01').connected && !lab.terminals.get('smk-contoh/KIOSK-01').connected, {
    message: 'the machines to notice the broker is gone',
  });
  const canteen = session('smk-contoh/CANTEEN-01');
  assert.equal(await canteen.out('show log'), "% The cloud server is switched off: the platform's device log cannot be read. Type server up.");
  assert.match(await canteen.out('show status'), /^Broker link {2}down$/m);
  const kiosk = session('smk-contoh/KIOSK-01');
  assert.equal((await kiosk.out(`tap ${AHMAD}`)).split('\n')[0], 'Screen: Cannot reach the platform, please come back later');

  assert.deepEqual(lines(await out('server up')).slice(1), [
    'The platform sent every machine its prices, settings and block list again.',
    'Machines with a cable reconnect by themselves within a few seconds and upload what they kept.',
  ]);
  assert.equal(lab.server.up, true);
  await waitFor(() => lab.terminals.get('smk-contoh/CANTEEN-01').connected, { timeout: 15_000, message: 'CANTEEN-01 back on the broker' });
  assert.deepEqual(lines(await out('broker restart')), [
    'MQTT broker restarted: its retained messages were lost.',
    'The platform reconnected at once and published every retained setting again.',
    'Machines with a cable reconnect by themselves within a few seconds.',
  ]);
  await waitFor(() => [...lab.terminals.values()].filter((m) => m.cablePlugged).every((m) => m.connected), {
    timeout: 15_000,
    message: 'every plugged machine back on the broker',
  });
});

test('every line the console printed fits in 100 characters, with money as RM 0.00 and times as DD/MM/YYYY HH:MM', NET, () => {
  assert.ok(outputs.length > 80);
  for (const text of outputs) {
    for (const line of lines(text)) assert.ok(line.length <= MAX_LINE, `too long (${line.length}): ${line}`);
    assert.doesNotMatch(text, /RM \d+\.\d(?!\d)|RM\d/, 'money is RM 0.00');
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no ISO times');
  }
  assert.ok(outputs.some((t) => DATE_RE.test(t)));
  assert.deepEqual(errors, []);
});
