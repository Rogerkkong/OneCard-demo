import { isLabError } from '../shared/errors.js';
import { formatRM } from '../shared/money.js';
import { DAY, HOUR, KL_OFFSET_MS, MINUTE, formatKL, parseIso } from '../shared/time.js';
import { KIOSK_FAULTS } from '../devices/kiosk.js';

// The PuTTY-style consoles of the lab (docs/DESIGN.md §8 "Machine and server consoles"): log in
// to any virtual machine, or to the virtual cloud server, and type commands as on a switch.
// One console serves telnet sessions (telnet.js) and the web Console tab alike: a session is
// only `{ target }`, so the web page can keep it on its side.
//
// Output is plain text: aligned columns, at most 100 characters a line, money as RM 0.00 and
// times as DD/MM/YYYY HH:MM in Kuala Lumpur, so it reads the same in PuTTY, a terminal and
// the browser.
//
// Simulation mode (DESIGN §11.5) is worked from onecard> and server#: switch it on, hold each
// traced flow at every hop, let the next hop go, and read a flow back step by step. Commands
// trace through the lab actions they call; a console line starts no trace of its own.

/** Longest line the console prints. */
export const MAX_LINE = 100;
/** Longest command line it reads. */
export const MAX_INPUT = 1000;
export const TOP_PROMPT = 'onecard>';
export const SERVER_PROMPT = 'server#';
export const UNKNOWN_COMMAND = '% Unknown command. Type help.';

const TYPE_NAMES = Object.freeze({ CANTEEN: 'canteen reader', WATER: 'water machine', KIOSK: 'top-up kiosk' });
const JOURNAL_DEFAULT = 10;
const LOG_DEFAULT = 10;
const LIST_MAX = 200;
const MAX_ADVANCE_DAYS = 400;
const UNITS = Object.freeze({ m: MINUTE, h: HOUR, d: DAY });
const UNIT_NAMES = Object.freeze({ m: 'minute', h: 'hour', d: 'day' });
const TRACES_LISTED = 20; // show traces: the most recent flows
const TRACES_SEARCHED = 200; // show trace <n>: every trace the lab keeps
// Simulation mode commands, at onecard> and server# (DESIGN §11.5).
const SIM_HELP = Object.freeze([
  ['simulation on|off', 'Simulation mode on, or back to realtime'],
  ['hold on|off', 'stop every traced flow at each hop (simulation mode)'],
  ['next', 'let the oldest held hop go on'],
  ['show held', 'what waits at a hop, oldest first'],
  ['show traces', 'the most recent flows: every action starts one'],
  ['show trace <n>', 'one flow step by step, e.g. show trace 3'],
]);
// Where a held hop waits, in a word for show held.
const WHERE_WORDS = Object.freeze({ machine: 'outbox', 'kiosk-http': 'kiosk call', platform: 'platform' });

// ---- text helpers ---------------------------------------------------------------------

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const v = (n) => `v${n}`;

/** One line, cut to MAX_LINE with a visible mark. */
function fit(line, width = MAX_LINE) {
  const s = String(line);
  return s.length <= width ? s : `${s.slice(0, width - 3)}...`;
}

/** Lab time (ms or ISO-8601) as DD/MM/YYYY HH:MM, Kuala Lumpur. */
function when(at) {
  const ms = typeof at === 'number' ? at : parseIso(at);
  return Number.isFinite(ms) ? formatKL(ms) : '-';
}

/**
 * Aligned columns, two spaces apart. `columns`: [{ title, max? }]; a cell longer than its
 * column's `max` is cut. The last column takes what is left of the line.
 */
function table(columns, rows) {
  const cells = rows.map((r) => r.map((c) => (c === null || c === undefined ? '-' : String(c))));
  const widths = columns.map((col, i) => Math.min(col.max ?? MAX_LINE, Math.max(col.title.length, ...cells.map((r) => r[i].length))));
  const line = (row) =>
    row
      .map((c, i) => {
        const cut = fit(c, widths[i]);
        return i === row.length - 1 ? cut : cut.padEnd(widths[i]);
      })
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.title)), ...cells.map(line)];
}

/** "label   value" lines with the labels aligned. */
function pairs(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

function helpList(title, rows) {
  // aligned on the commands that have a description; a long one without stays on its own
  const width = Math.max(...rows.filter(([, what]) => what).map(([cmd]) => cmd.length));
  return [title, ...rows.map(([cmd, what]) => (what ? `  ${cmd.padEnd(width)}  ${what}` : `  ${cmd}`))];
}

/** A positive whole number of at most LIST_MAX, the default when missing, or null when malformed. */
function countArg(text, fallback) {
  if (text === undefined) return fallback;
  if (!/^\d{1,4}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? Math.min(n, LIST_MAX) : null;
}

// ---- the steps of a trace (show trace <n>) ---------------------------------------------

/** Lab time (ISO-8601) as HH:MM:SS, Kuala Lumpur: steps of one flow are seconds apart. */
function clockTime(at) {
  const ms = parseIso(at);
  return Number.isFinite(ms) ? new Date(ms + KL_OFFSET_MS).toISOString().slice(11, 19) : '-';
}

/**
 * The steps in the order of the hops. Events are kept in the order they were emitted, and
 * the broker reports passing a message (mqtt.publish) only once it has delivered it, often
 * after the platform has handled it: each pass is shown right after the send it belongs to.
 */
function hopOrder(events) {
  const isSend = (e) => (e.type === 'device.send' || e.type === 'platform.send') && typeof e.data?.msgId === 'string';
  const sent = new Set(events.filter(isSend).map((e) => e.data.msgId));
  const isPass = (e) => e.type === 'mqtt.publish' && sent.has(e.data?.msgId);
  const passes = new Map(); // msgId -> the broker's passes of it, in order
  for (const e of events.filter(isPass)) passes.set(e.data.msgId, [...(passes.get(e.data.msgId) ?? []), e]);
  const out = [];
  for (const e of events) {
    if (isPass(e)) continue;
    out.push(e);
    if (isSend(e) && passes.has(e.data.msgId)) {
      out.push(...passes.get(e.data.msgId));
      passes.delete(e.data.msgId);
    }
  }
  return out;
}

const money = (sen) => (Number.isSafeInteger(sen) ? formatRM(sen) : '-');

function deviceStepText(d) {
  const dev = d.device ?? '-';
  switch (d.step) {
    case 'card.read':
      if (!d.ok) return `${dev} cannot use the card: ${d.reason ?? 'refused'}`;
      return `${dev} read card ..${d.last4}: ${money(d.balanceSen)}, counter ${d.cardSeq}, ${plural(d.records ?? 0, 'record')}`;
    case 'rules': {
      const failed = Array.isArray(d.checks) ? d.checks.find((c) => !c.ok) : null;
      return failed ? `${dev} rules: ${failed.rule} failed (${money(d.amountSen)})` : `${dev} rules passed for ${money(d.amountSen)}`;
    }
    case 'journal':
      return `${dev} saved ${d.txn} in its journal (${d.unsent} unsent)`;
    case 'offline':
      return `${dev} has no network: ${d.type ?? d.call ?? 'it'} not sent`;
    default:
      return `${dev} ${d.step}: ${d.ok ? 'ok' : 'failed'}`;
  }
}

function labActionText(d) {
  if (d.ok === false && d.code) return `${d.action} failed: ${d.code}`;
  switch (d.action) {
    case 'tap':
      return `done: tap on ${d.device}, ${d.ok ? 'ok' : `refused (${d.reason ?? 'no'})`}`;
    case 'fault':
      return `done: fault ${d.type}`;
    case 'server-up':
    case 'server-down':
      return `done: cloud server ${d.action === 'server-up' ? 'on' : 'off'}${d.changed === false ? ' (already)' : ''}`;
    default:
      return `done: ${d.action}${d.device ? ` on ${d.device}` : ''}`;
  }
}

/** Short `key=value` pairs of the plain fields, for event types without a summary of their own. */
function plainFields(d) {
  return Object.entries(d ?? {})
    .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 6)
    .map(([key, value]) => `${key}=${typeof value === 'string' && !Number.isNaN(parseIso(value)) && /T\d/.test(value) ? when(value) : value}`)
    .join(' ');
}

/** What became of the records of one message: 'POSTED', or '3 POSTED, 1 DUPLICATE'. */
function recordResults(results) {
  const counts = new Map();
  for (const r of results) counts.set(r?.status, (counts.get(r?.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => (results.length === 1 ? `${status}` : `${n} ${status}`)).join(', ');
}

/** One step of a flow in plain words (show trace <n>). */
function stepText(e) {
  const d = e.data ?? {};
  const dev = d.device ?? '-';
  switch (e.type) {
    case 'sim.trace':
      return d.title ?? '';
    case 'sim.held':
      return `waits at the ${WHERE_WORDS[d.where] ?? d.where}: ${d.type ?? d.call ?? 'a message'} of ${dev}`;
    case 'sim.released':
      return 'goes on (next)';
    case 'device.step':
      return deviceStepText(d);
    case 'device.send':
      return `${dev} sends ${d.type} (seq ${d.seq}${d.txn ? `, ${d.txn}` : ''})`;
    case 'device.acked':
      return d.ok ? `${dev}: the broker took ${d.type} (${d.ms} ms)` : `${dev}: ${d.type} not acknowledged (${d.reason})`;
    case 'device.received':
      return `${dev} got ${d.type ?? 'a command'}${d.version ? ` v${d.version}` : ''}: ${d.result}${d.reason ? ` (${d.reason})` : ''}`;
    case 'device.http':
      return `${dev} ${d.method} ${d.path}: ${d.status === 0 ? 'no answer' : d.status}${d.code ? ` ${d.code}` : ''}`;
    case 'device.screen':
      return `${dev} shows "${d.text}"`;
    case 'device.cable':
      return `${dev} cable ${d.plugged ? 'plugged in' : 'pulled out'}`;
    case 'card.write':
      return `${dev} ${d.kind === 'debit' ? 'took' : 'added'} ${money(d.amountSen)}: the card now holds ${money(d.balanceAfterSen)}`;
    case 'mqtt.publish':
      return `the broker passes ${d.type ?? 'a message'} from ${d.from ?? '-'}${d.retained ? ' (retained)' : ''}`;
    case 'mqtt.denied':
      return `the broker refuses ${d.action} by ${d.username ?? 'someone'}: ${d.reason ?? ''}`;
    case 'intake.accepted': {
      const results = Array.isArray(d.results) && d.results.length > 0 ? `: ${recordResults(d.results)}` : '';
      const snap = d.snapshot?.checked ? (d.snapshot.match ? ', card = books' : `, card differs (${d.snapshot.code ?? 'mismatch'})`) : '';
      return `the platform accepts ${d.type} from ${dev}${results}${snap}`;
    }
    case 'intake.refused':
      return `the platform refuses ${d.type ?? 'a message'} from ${dev}: ${d.code}`;
    case 'intake.duplicate':
      return `the platform has ${d.type} from ${dev} already: counted once`;
    case 'purchase.received':
      return `purchase ${d.txn}: ${d.status} ${money(d.amountSen)}${d.code ? ` (${d.code})` : ''}`;
    case 'ledger.posting':
      return `books: ${d.kind} ${money(d.amountSen)}`;
    case 'topup.status':
      return `top-up ${d.orderId}: ${d.status} ${money(d.amountSen)}`;
    case 'platform.send':
      return `the platform sends ${d.type} to ${dev}${d.retained ? ' (retained)' : ''}`;
    case 'http.kiosk':
      return `the platform answers ${d.method} ${d.path} of ${dev}: ${d.status}${d.code ? ` ${d.code}` : ''}`;
    case 'config.published':
      return `${d.kind} v${d.version} published`;
    case 'server.status':
      return `the cloud server is ${d.up ? 'on' : 'off'}`;
    case 'broker.status':
      return `the MQTT broker is ${d.up ? 'up' : 'down'}`;
    case 'lab.clock':
      return `the lab clock now shows ${when(d.now)}`;
    case 'lab.action':
      return labActionText(d);
    default:
      return plainFields(d);
  }
}

const machineKeyOf = (text) => {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(text);
  return m ? `${m[1].toLowerCase()}/${m[2].toUpperCase()}` : null;
};

/**
 * The console. `run(session, line)` runs one command line and resolves with what to print and
 * the prompt to show next; it updates `session.target` (null, 'server' or '<school>/<DEVICE>')
 * on connect, disconnect and exit, and sets `exit: true` when the session should end.
 * It never rejects: a problem is printed as a line starting with %.
 * @param {object} lab  the lab (createLab)
 * @returns {{ run(session: { target: string|null }, line: string): Promise<{ output: string, prompt: string, exit?: boolean }>,
 *   prompt(session: { target: string|null }): string, banner(): string }}
 */
export function createConsole(lab) {
  const platform = () => lab.platform;
  const services = () => lab.platform.services;
  const machineOf = (key) => lab.terminals.get(key) ?? null;

  function prompt(session) {
    const target = session?.target ?? null;
    if (target === 'server') return SERVER_PROMPT;
    if (target && machineOf(target)) return `${target}>`;
    return TOP_PROMPT;
  }

  function brokerAddress() {
    const url = lab.broker?.url ?? lab.urls?.mqttUrl ?? 'mqtt://127.0.0.1:1883';
    try {
      const u = new URL(url);
      return `${u.hostname}:${u.port}`;
    } catch {
      return '127.0.0.1:1883';
    }
  }

  function viewerHint() {
    const viewer = lab.ctx.settings.viewer;
    return `MQTT Explorer: ${brokerAddress()}, ${viewer.username} / ${viewer.password} (read-only: every machine's messages, live)`;
  }

  function banner() {
    return [
      'OneCard Lab: consoles of the virtual machines and the virtual cloud server',
      'Lab data only: every school, person, card and key here is fictional.',
      'Type "machines" to list the machines, "connect smk-contoh/CANTEEN-01" to log in to one,',
      '"connect server" for the cloud server, and "help" (or ?) for the commands.',
      '',
    ].join('\n');
  }

  // ---- anywhere ------------------------------------------------------------------------

  function help(session) {
    const tail = [
      ['disconnect, exit', 'back to onecard>'],
      ['machines, connect ..., clock, help', ''],
    ];
    if (session.target === null) {
      return [
        ...helpList(`Commands at ${TOP_PROMPT}`, [
          ['machines', 'every machine of every school, online or not'],
          ['connect <school>/<DEVICE>', 'log in to a machine, e.g. connect smk-contoh/CANTEEN-01'],
          ['connect server', 'log in to the virtual cloud server'],
          ['clock', 'the lab clock'],
          ...SIM_HELP,
          ['help or ?', 'this list'],
          ['exit', 'close this session'],
        ]),
        viewerHint(),
      ];
    }
    if (session.target === 'server') {
      return helpList(`Commands at ${SERVER_PROMPT}`, [
        ['show schools', 'every school (tenant) on this server'],
        ['show clients', 'broker connections per school'],
        ['show status', 'server, broker, platform link and clock'],
        ['server down | server up', 'switch the whole cloud server off or on'],
        ['broker restart', 'restart only the MQTT broker (its retained messages are lost)'],
        ['clock advance <n>m|h|d', 'move the lab clock forward, e.g. clock advance 15d'],
        ['jobs run', 'run the scheduled jobs now (refunds, parking, reconciliation)'],
        ...SIM_HELP,
        ...tail,
      ]);
    }
    const machine = machineOf(session.target);
    const rows = [
      ['show status | config | prices | blocklist', ''],
      ['show journal [n]', `the last n records (default ${JOURNAL_DEFAULT}), sent or unsent`],
      ['show log [n]', "the platform's device log for this machine"],
      ['cable plug | cable unplug', 'plug in or pull out the network cable'],
      ['heartbeat', 'send a heartbeat now'],
      ['upload', 'upload the unsent records now'],
      ['export usb', 'copy the journal to a USB stick (a signed file)'],
      ['reboot', 'switch off and on again (counters survive)'],
    ];
    if (machine.deviceType === 'CANTEEN') {
      rows.push(['tap <uid> <ITEM>[*qty] ...', 'sell, e.g. tap 04A13B5C7D2E80 NASI-LEMAK TEH-TARIK*2']);
    } else if (machine.deviceType === 'WATER') {
      rows.push(['pour <uid> <ml>', 'pour water, e.g. pour 04C35D2F8B1A82 650']);
    } else {
      rows.push(['tap <uid> [fault]', 'add waiting money; fault: power-cut-before-commit,']);
      rows.push(['', 'power-cut-after-commit or confirm-timeout']);
      rows.push(['admin-card load', "load the school's admin card (newest lists, a fresh token)"]);
      rows.push(['admin-card upload', 'upload the receipts machines wrote on the admin card']);
    }
    if (machine.deviceType !== 'KIOSK') rows.push(['admin-card tap', "read the school's admin card (lists and prices)"]);
    rows.push(['next | show held', 'let a held hop go on, or list them (simulation mode)']);
    return helpList(`Commands at ${session.target}> (${TYPE_NAMES[machine.deviceType]})`, [...rows, ...tail]);
  }

  function machines() {
    const state = lab.state();
    const rows = [];
    for (const school of state.schools) {
      for (const d of school.devices) {
        const link = d.connected ? 'up' : 'down';
        rows.push([
          school.code,
          d.code,
          d.type,
          d.cablePlugged ? 'in' : 'out',
          d.deviceStatus && d.deviceStatus !== 'ACTIVE' ? `${link} (${d.deviceStatus})` : link,
          d.versions ? `P${d.versions.prices} S${d.versions.settings} B${d.versions.blocklist}` : '-',
          d.journal ? d.journal.unsent : '-',
          d.location || '-',
        ]);
      }
    }
    if (rows.length === 0) return ['No machines yet.'];
    return [
      ...table(
        [{ title: 'SCHOOL', max: 16 }, { title: 'MACHINE', max: 14 }, { title: 'TYPE' }, { title: 'CABLE' }, { title: 'LINK', max: 18 },
          { title: 'VERSIONS' }, { title: 'UNSENT' }, { title: 'LOCATION' }],
        rows,
      ),
      `${plural(rows.length, 'machine')}. VERSIONS: P prices, S settings, B block list. Log in: connect <school>/<DEVICE>`,
    ];
  }

  function connect(session, args) {
    if (args.length === 0) return '% Incomplete command. Usage: connect server, or connect <school>/<DEVICE>';
    if (args.length > 1) return '% Invalid input. Usage: connect server, or connect <school>/<DEVICE>';
    if (args[0].toLowerCase() === 'server') {
      session.target = 'server';
      return `Connected to the cloud server (MQTT broker, platform, database): ${lab.server.up ? 'up' : 'switched OFF'}. Type help.`;
    }
    const key = machineKeyOf(args[0]);
    if (!key) return '% Invalid input. Usage: connect <school>/<DEVICE>, e.g. connect smk-contoh/CANTEEN-01';
    const machine = machineOf(key);
    if (!machine) return `% No machine ${key}. Type machines to list them.`;
    session.target = key;
    return `Connected to ${key}, ${TYPE_NAMES[machine.deviceType]}. Type help.`;
  }

  function leave(session) {
    if (session.target === null) return '% Not connected to anything.';
    const was = session.target === 'server' ? 'the cloud server' : session.target;
    session.target = null;
    return `Disconnected from ${was}.`;
  }

  function clockLine() {
    const c = lab.state().clock;
    const how = c.mode === 'manual' ? 'standing still until advanced' : 'running';
    return `Lab clock: ${c.kl} (Kuala Lumpur, UTC+8), ${how}.`;
  }

  // ---- server# -----------------------------------------------------------------------------

  function requireServerOn(what) {
    return lab.server.up ? null : `% The cloud server is switched off: ${what}. Type server up.`;
  }

  function showSchools() {
    const off = requireServerOn('its database cannot be read');
    if (off) return off;
    const rows = platform().operatorOverview().map((s) => [
      s.code,
      s.name,
      s.status,
      s.members,
      s.cards,
      `${s.devices.online}/${s.devices.total}`,
      formatRM(s.todaySalesSen),
      formatRM(s.waitingSen),
      s.openDifferences,
    ]);
    return [
      ...table(
        [{ title: 'CODE', max: 16 }, { title: 'NAME', max: 20 }, { title: 'STATUS' }, { title: 'MEMBERS' }, { title: 'CARDS' },
          { title: 'ONLINE' }, { title: 'SALES TODAY' }, { title: 'WAITING' }, { title: 'DIFFS' }],
        rows,
      ),
      `${plural(rows.length, 'school')} on one platform. ONLINE: machines heard from in the last 90 s.`,
    ];
  }

  function showClients() {
    const off = requireServerOn('there is no broker');
    if (off) return off;
    const clients = lab.broker ? lab.broker.clients() : [];
    const groups = new Map();
    for (const c of clients) {
      const username = c.username ?? '';
      const dot = username.indexOf('.');
      const [group, name] = dot > 0 ? [username.slice(0, dot), username.slice(dot + 1)]
        : username === 'platform' ? ['(platform)', c.clientId] : [`(${username || 'unknown'})`, c.clientId];
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(name);
    }
    const rows = [...groups.entries()]
      .sort(([a], [b]) => (a.startsWith('(') === b.startsWith('(') ? a.localeCompare(b) : a.startsWith('(') ? -1 : 1))
      .map(([group, names]) => [group, names.length, names.sort().join(', ')]);
    return [
      `Broker ${lab.broker?.url ?? '-'}: ${plural(clients.length, 'connection')}`,
      ...table([{ title: 'SCHOOL', max: 20 }, { title: 'CONNECTIONS' }, { title: 'CLIENTS' }], rows),
    ];
  }

  function showServerStatus() {
    const s = lab.state();
    const lines = [
      ['Cloud server', s.server.up ? 'up' : 'switched OFF (the web apps answer 503 except the lab console)'],
      ['MQTT broker', s.broker.up ? `up at ${s.broker.url}, ${plural(s.broker.clients, 'connection')}` : `down (${s.broker.url})`],
      ['Platform link', s.platform.connected ? 'connected to the broker' : 'not connected'],
      ['Web apps', s.urls?.httpUrl ?? '-'],
      ['Consoles', s.urls?.consoleAddress ? `${s.urls.consoleAddress} (PuTTY: connection type Telnet)` : 'web Console tab only'],
      ['Lab clock', `${s.clock.kl} (KL), ${s.clock.mode === 'manual' ? 'standing still until advanced' : 'running'}`],
    ];
    if (s.server.up) {
      const active = s.schools.filter((x) => x.status === 'ACTIVE').length;
      const open = platform().operatorOverview().reduce((sum, x) => sum + x.openDifferences, 0);
      lines.push(['Schools', `${s.schools.length} (${active} active), ${plural(open, 'open difference')}`]);
    }
    lines.push(['Jobs', lab.jobsMs > 0 ? `every ${lab.jobsMs / 1000} s while the server is up` : 'only when run (jobs run)']);
    return pairs(lines);
  }

  async function serverSwitch(up) {
    const result = await lab.setServer({ up });
    if (result.held) return heldLines(result, `Switching the cloud server ${up ? 'on' : 'off'}.`);
    if (!result.changed) return `% The cloud server is already ${up ? 'on' : 'off'}.`;
    if (!up) {
      return [
        'Cloud server switched off: the broker stopped, the platform is offline and the web apps answer 503.',
        'Readers and water machines keep selling offline; the kiosk adds nothing until the server is back.',
      ];
    }
    return [
      `Cloud server switched on: broker up at ${result.broker.url}, platform connected.`,
      'The platform sent every machine its prices, settings and block list again.',
      'Machines with a cable reconnect by themselves within a few seconds and upload what they kept.',
    ];
  }

  async function brokerRestart() {
    const result = await lab.restartBroker();
    if (result.held) return heldLines(result, 'Restarting the MQTT broker.');
    return [
      'MQTT broker restarted: its retained messages were lost.',
      result.platformReconnected
        ? 'The platform reconnected at once and published every retained setting again.'
        : 'The platform is not listening on the new broker yet; it keeps trying every second.',
      'Machines with a cable reconnect by themselves within a few seconds.',
    ];
  }

  function jobsLine(jobs) {
    return `Jobs ran: ${jobs.cancelled} cancelled, ${jobs.refunded} refunded, ${jobs.parked} parked; ` +
      `reconciliation found ${plural(jobs.gaps, 'gap')} and ${plural(jobs.lag, 'old block list')}.`;
  }

  async function clockAdvance(args) {
    const text = args.join('');
    const m = /^(\d{1,6})([mhd])$/i.exec(text);
    if (!text) return '% Incomplete command. Usage: clock advance <n>m|h|d, e.g. clock advance 15d';
    if (!m) return '% Invalid input. Usage: clock advance <n>m|h|d, e.g. clock advance 90m, 1h or 15d';
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = n * UNITS[unit];
    if (n < 1 || ms > MAX_ADVANCE_DAYS * DAY) return `% Invalid input: from 1 minute to ${MAX_ADVANCE_DAYS} days.`;
    const result = await lab.advanceClock(ms);
    // the machines' heartbeats at the new time wait at their outboxes; the jobs run after them
    if (result.held) return heldLines(result, `Lab clock moved forward ${plural(n, UNIT_NAMES[unit])}: now ${result.clock?.kl ?? '-'} (KL).`);
    return [
      `Lab clock moved forward ${plural(n, UNIT_NAMES[unit])}: now ${result.clock.kl} (KL).`,
      result.jobs ? jobsLine(result.jobs) : 'The jobs did not run: the cloud server is off.',
    ];
  }

  function jobsRun() {
    const off = requireServerOn('nothing runs on it');
    if (off) return off;
    const result = lab.runJobs();
    const rows = result.schools.map((s) => [s.code, s.cancelled, s.refunded, s.parked, s.gaps, s.lag, s.errors ? 'failed' : 'ok']);
    return [
      `Jobs ran for ${plural(result.schools.length, 'active school')}:`,
      ...table(
        [{ title: 'SCHOOL', max: 20 }, { title: 'CANCELLED' }, { title: 'REFUNDED' }, { title: 'PARKED' }, { title: 'GAPS' },
          { title: 'OLD LISTS' }, { title: 'RESULT' }],
        rows,
      ),
    ];
  }

  async function serverCommand(words) {
    const [cmd, arg] = [words[0].toLowerCase(), words[1]?.toLowerCase()];
    if (cmd === 'show') {
      const usage = 'Usage: show schools | clients | status | held | traces | trace <n>';
      if (!arg) return `% Incomplete command. ${usage}`;
      if (words.length > 2) return `% Invalid input. ${usage}`;
      if (arg === 'schools') return showSchools();
      if (arg === 'clients') return showClients();
      if (arg === 'status') return showServerStatus();
      return `% Invalid input. ${usage}`;
    }
    if (cmd === 'server') {
      if (words.length === 2 && (arg === 'down' || arg === 'up')) return serverSwitch(arg === 'up');
      return words.length === 1 ? '% Incomplete command. Usage: server down | server up' : '% Invalid input. Usage: server down | server up';
    }
    if (cmd === 'broker') {
      if (words.length === 2 && arg === 'restart') return brokerRestart();
      return words.length === 1 ? '% Incomplete command. Usage: broker restart' : '% Invalid input. Usage: broker restart';
    }
    if (cmd === 'clock' && arg === 'advance') return clockAdvance(words.slice(2));
    if (cmd === 'jobs') {
      if (words.length === 2 && arg === 'run') return jobsRun();
      return words.length === 1 ? '% Incomplete command. Usage: jobs run' : '% Invalid input. Usage: jobs run';
    }
    return UNKNOWN_COMMAND;
  }

  // ---- Simulation mode (DESIGN §11.5) ------------------------------------------------------

  /** '#3' for a trace the lab keeps, '-' for one it no longer does. */
  function traceNumber(id) {
    const found = lab.tracer?.list({ limit: TRACES_SEARCHED }).find((t) => t.id === id);
    return found ? `#${found.n}` : '-';
  }

  /** A held hop in plain words: what waits, and where. */
  function describeHeld(item) {
    const machine = `${item?.school ?? '-'}/${item?.device ?? '-'}`;
    if (item?.where === 'kiosk-http') return `the ${item.call ?? 'API'} call of ${machine}`;
    if (item?.where === 'platform') return `${item.type ?? 'a message'} from ${machine} at the platform's inbox`;
    return `${item?.type ?? 'a message'} in the outbox of ${machine}`;
  }

  /** What an action answers when its flow is held at a hop: it goes on with next. */
  function heldLines(result, first) {
    return [
      ...(first ? [first] : []),
      `Held at a hop: ${describeHeld(result.item)} (trace ${traceNumber(result.trace)}).`,
      'Type next to let it go on (show held lists what waits); the rest of the flow follows.',
    ];
  }

  /** After hold off or realtime: what still waits (the platform's hops, while the server is off). */
  function stillWaiting(state) {
    const n = state.held.length;
    return n > 0 ? [`${plural(n, 'message')} still ${n === 1 ? 'waits' : 'wait'} at the platform until the cloud server is on again.`] : [];
  }

  function simulationSwitch(words) {
    const arg = words[1]?.toLowerCase();
    if (words.length !== 2 || (arg !== 'on' && arg !== 'off')) {
      return words.length === 1 ? '% Incomplete command. Usage: simulation on|off' : '% Invalid input. Usage: simulation on|off';
    }
    const before = lab.simState();
    if (arg === 'on') {
      if (before.mode === 'simulation') return 'Simulation mode is already on.';
      lab.setSim({ mode: 'simulation' });
      return [
        'Simulation mode on: every action and request is traced (show traces, show trace <n>).',
        'Type hold on to stop each traced flow at every hop.',
      ];
    }
    if (before.mode === 'realtime') return 'Already in realtime mode: nothing waits at the hops.';
    const after = lab.setSim({ mode: 'realtime' });
    const freed = before.held.length - after.held.length;
    return [`Realtime mode: nothing waits at the hops any more${freed > 0 ? ` (${plural(freed, 'held hop')} let go)` : ''}.`, ...stillWaiting(after)];
  }

  function holdSwitch(words) {
    const arg = words[1]?.toLowerCase();
    if (words.length !== 2 || (arg !== 'on' && arg !== 'off')) {
      return words.length === 1 ? '% Incomplete command. Usage: hold on|off' : '% Invalid input. Usage: hold on|off';
    }
    const before = lab.simState();
    if (arg === 'on') {
      if (before.mode !== 'simulation') return '% Hold works only in simulation mode: type simulation on first.';
      if (before.hold) return 'Hold at each hop is already on.';
      lab.setSim({ hold: true });
      return [
        "Hold at each hop on: every traced flow waits at each hop (a machine's outbox, the kiosk's",
        "API calls, the platform's inbox). Type next to let the oldest go on.",
      ];
    }
    if (!before.hold) return 'Hold is already off.';
    const after = lab.setSim({ hold: false });
    const freed = before.held.length - after.held.length;
    return [`Hold off: flows run through again${freed > 0 ? `; ${plural(freed, 'held hop')} let go` : ''}.`, ...stillWaiting(after)];
  }

  function nextHop() {
    const { released, waiting } = lab.simNext();
    const rest = waiting === 0 ? 'Nothing else waits.' : `${waiting} still ${waiting === 1 ? 'waits' : 'wait'} (show held).`;
    if (released) return [`Let go: ${describeHeld(released)} (trace ${traceNumber(released.trace)}).`, rest];
    if (waiting > 0) {
      return `% Nothing can go on now: ${plural(waiting, 'message')} ${waiting === 1 ? 'waits' : 'wait'} at the platform ` +
        'while the cloud server is off (server up).';
    }
    return lab.simState().hold ? 'Nothing waits at a hop.' : 'Nothing waits at a hop (hold is off).';
  }

  function showHeld() {
    const { mode, hold, held } = lab.simState();
    const how = `Mode ${mode}, hold ${hold ? 'on' : 'off'}.`;
    if (held.length === 0) return `Nothing waits at a hop. ${how}`;
    const rows = held.map((h, i) => [i + 1, WHERE_WORDS[h.where] ?? h.where, `${h.school ?? '-'}/${h.device ?? '-'}`, h.type ?? h.call ?? '-',
      traceNumber(h.trace), when(h.at)]);
    const lines = [
      `${plural(held.length, 'hop')} waiting, oldest first: next lets the oldest go on. ${how}`,
      ...table([{ title: '#' }, { title: 'WHERE' }, { title: 'MACHINE', max: 28 }, { title: 'WHAT', max: 20 }, { title: 'TRACE' }, { title: 'SINCE' }], rows),
    ];
    if (!lab.server.up && held.some((h) => h.where === 'platform')) lines.push("The platform's hops wait until the cloud server is on again.");
    return lines;
  }

  function showTraces() {
    const list = lab.tracer.list({ limit: TRACES_LISTED });
    if (list.length === 0) return 'No traces yet: every lab action, and every change made in the web apps, starts one.';
    return [
      'The most recent flows, newest first (show trace <n> for the steps):',
      ...table(
        [{ title: '#' }, { title: 'KIND', max: 10 }, { title: 'TITLE', max: 46 }, { title: 'EVENTS' }, { title: 'STARTED' }],
        list.map((t) => [`#${t.n}`, t.kind, t.title, t.events, when(t.at)]),
      ),
    ];
  }

  function showTrace(arg, extra) {
    const usage = 'Usage: show trace <n>, e.g. show trace 3';
    if (arg === undefined) return `% Incomplete command. ${usage}`;
    if (extra || !/^#?\d{1,6}$/.test(arg)) return `% Invalid input. ${usage}`;
    const n = Number(arg.replace('#', ''));
    const found = lab.tracer.list({ limit: TRACES_SEARCHED }).find((t) => t.n === n);
    const kept = found ? lab.tracer.get(found.id) : null;
    if (!kept) return `% No trace #${n}: show traces lists the ones the lab keeps.`;
    const { trace, events } = kept;
    const steps = hopOrder(events);
    const count = trace.events > events.length
      ? `${trace.events} events, the first and the last ${events.length - 1} kept`
      : plural(trace.events, 'event');
    return [
      `Trace #${trace.n} (${trace.kind}): ${trace.title}`,
      `${count}, started ${when(trace.at)}. TIME is the lab clock (KL).`,
      ...table([{ title: '#' }, { title: 'TIME' }, { title: 'TYPE', max: 19 }, { title: 'WHAT' }],
        steps.map((e, i) => [i + 1, clockTime(e.at), e.type, stepText(e)])),
    ];
  }

  /** The Simulation mode commands of onecard> and server#, or null for any other line. */
  function simCommand(words) {
    const cmd = words[0].toLowerCase();
    const arg = words[1]?.toLowerCase();
    if (cmd === 'simulation') return simulationSwitch(words);
    if (cmd === 'hold') return holdSwitch(words);
    if (cmd === 'next') return words.length > 1 ? '% Invalid input. Usage: next' : nextHop();
    if (cmd === 'show' && arg === 'held') return words.length > 2 ? '% Invalid input. Usage: show held' : showHeld();
    if (cmd === 'show' && arg === 'traces') return words.length > 2 ? '% Invalid input. Usage: show traces' : showTraces();
    if (cmd === 'show' && arg === 'trace') return showTrace(words[2], words.length > 3);
    return null;
  }

  // ---- a machine's prompt ------------------------------------------------------------------

  function codes(key) {
    const slash = key.indexOf('/');
    return { schoolCode: key.slice(0, slash), deviceCode: key.slice(slash + 1) };
  }

  function machineRow(key) {
    const { schoolCode, deviceCode } = codes(key);
    const school = lab.state().schools.find((s) => s.code === schoolCode);
    return school?.devices.find((d) => d.code === deviceCode) ?? null;
  }

  function showStatus(key) {
    const m = machineRow(key);
    const machine = machineOf(key);
    if (!m) return `% ${key} is not on the platform any more.`;
    const versions = m.versions;
    const screen = m.lastScreen ? `${m.lastScreen.text} (${when(m.lastScreen.at)})` : '(blank)';
    const platformView = [m.deviceStatus ?? '-', m.online ? 'online' : 'offline'];
    if (m.lastHeartbeatAt) platformView.push(`last heartbeat ${when(m.lastHeartbeatAt)}`);
    const lines = [
      `${key}  ${TYPE_NAMES[machine.deviceType]}  ${m.location || ''}`.trimEnd(),
      ...pairs([
        ['Cable', m.cablePlugged ? 'plugged in' : 'unplugged (no network)'],
        ['Broker link', m.connected ? `up (as ${codes(key).schoolCode}.${codes(key).deviceCode})` : 'down'],
        ['Platform', platformView.join(', ')],
        ['Versions', `prices ${v(versions.prices)}, settings ${v(versions.settings)}, block list ${v(versions.blocklist)} (${plural(m.blocklistSize, 'card')})`],
        ['Journal', `${plural(m.journal.total, 'record')}, ${m.journal.unsent} unsent`],
        ['Counters', `seq ${m.seq}, txn ${m.txnCounter}, admin-card token ${m.highestAdminToken}`],
        ['Screen', screen],
        ...(m.lastResult ? [['Last action', resultLine(m.lastResult)]] : []),
      ]),
    ];
    return lines;
  }

  function resultLine(r) {
    const outcome = r.ok ? 'ok' : `refused${r.reason ? ` (${r.reason}${r.error ? `: ${r.error}` : ''})` : ''}`;
    return `${r.action}: ${outcome}, ${when(r.at)}`;
  }

  function showConfig(key) {
    const { prices, settings, blocklist } = machineOf(key).config;
    const lines = [];
    if (prices.version > 0 && prices.content) {
      const w = prices.content.water;
      lines.push(`Prices      ${v(prices.version)}, effective ${when(prices.effectiveFrom)}: ${plural(prices.content.items.length, 'item')}, ` +
        `water ${formatRM(w.perLitreSen)} a litre (minimum ${formatRM(w.minChargeSen)})`);
    } else {
      lines.push('Prices      none yet');
    }
    if (settings.version > 0 && settings.content) {
      const s = settings.content;
      lines.push(`Settings    ${v(settings.version)}, effective ${when(settings.effectiveFrom)}`);
      lines.push(...pairs([
        ['  Meal windows', s.mealWindows.length ? s.mealWindows.map((x) => `${x.from}-${x.to}`).join(', ') : 'none (open all day)'],
        ['  Holder groups', s.allowedGroups.join(', ')],
        ['  Per purchase', `up to ${formatRM(s.perPurchaseMaxSen)}`],
        ['  Per day', `up to ${formatRM(s.dailyMaxSen)} and ${plural(s.dailyMaxCount, 'purchase')}`],
        ['  Tap gap', `${s.tapGapSeconds} s`],
      ]));
    } else {
      lines.push('Settings    none yet');
    }
    lines.push(blocklist.version > 0
      ? `Block list  ${v(blocklist.version)}: ${plural(blocklist.content.entries.length, 'card')}`
      : 'Block list  none yet (every card is refused until one arrives)');
    return lines;
  }

  function showPrices(key) {
    const { prices } = machineOf(key).config;
    if (!(prices.version > 0) || !prices.content) return '% This machine has no price list yet.';
    const w = prices.content.water;
    return [
      `Price list ${v(prices.version)} on this machine (effective ${when(prices.effectiveFrom)})`,
      ...table([{ title: 'CODE' }, { title: 'ITEM', max: 40 }, { title: 'PRICE' }], prices.content.items.map((i) => [i.code, i.name, formatRM(i.priceSen)])),
      `Water: ${formatRM(w.perLitreSen)} a litre, minimum ${formatRM(w.minChargeSen)}`,
    ];
  }

  function showBlocklist(key) {
    const { blocklist } = machineOf(key).config;
    if (!(blocklist.version > 0)) return 'No block list yet: the machine refuses every card until one arrives.';
    const entries = blocklist.content.entries;
    const head = `Block list ${v(blocklist.version)} on this machine: ${plural(entries.length, 'card')}`;
    if (entries.length === 0) return head;
    return [head, ...table([{ title: 'LAST4' }, { title: 'CARD DIGEST' }], entries.map((e) => [e.last4, e.card]))];
  }

  function showJournal(key, arg) {
    const n = countArg(arg, JOURNAL_DEFAULT);
    if (n === null) return '% Invalid input. Usage: show journal [n], e.g. show journal 20';
    const machine = machineOf(key);
    const { total, unsent } = machine.state.journal;
    if (total === 0) return 'The journal is empty: no purchase made on this machine yet.';
    const entries = machine.journal({ limit: n });
    const rows = entries.map(({ record: r, sent }) => [
      r.txn,
      when(r.at),
      r.kind === 'WATER' ? `${r.ml} ml` : (r.items ?? []).map((i) => (i.qty > 1 ? `${i.code}*${i.qty}` : i.code)).join(' '),
      formatRM(r.amountSen),
      r.last4,
      formatRM(r.balanceAfterSen),
      sent ? 'sent' : 'unsent',
    ]);
    return [
      `Journal: ${plural(total, 'record')}, ${unsent} unsent (the last ${entries.length}, newest last)`,
      ...table(
        [{ title: 'TXN', max: 24 }, { title: 'TIME' }, { title: 'WHAT', max: 24 }, { title: 'AMOUNT' }, { title: 'CARD' },
          { title: 'BALANCE' }, { title: 'SENT' }],
        rows,
      ),
    ];
  }

  function showLog(key, arg) {
    const n = countArg(arg, LOG_DEFAULT);
    if (n === null) return '% Invalid input. Usage: show log [n], e.g. show log 20';
    const off = requireServerOn("the platform's device log cannot be read");
    if (off) return off;
    const { schoolCode, deviceCode } = codes(key);
    const { schools, devices } = services();
    const school = schools.getSchoolByCode(schoolCode);
    const device = school ? devices.getDeviceByCode(school.id, deviceCode) : null;
    if (!device) return `% ${key} is not on the platform.`;
    const entries = devices.listLog(school.id, { deviceId: device.id, limit: n }).reverse();
    if (entries.length === 0) return `The platform's device log for ${key} is empty.`;
    return [
      `Device log for ${key} on the platform (the last ${entries.length}, newest last)`,
      ...table([{ title: 'TIME' }, { title: 'LEVEL' }, { title: 'CODE', max: 24 }, { title: 'MESSAGE' }], entries.map((e) => [when(e.at), e.level, e.code, e.message])),
    ];
  }

  async function cable(key, arg) {
    if (arg !== 'plug' && arg !== 'unplug') return arg ? '% Invalid input. Usage: cable plug | cable unplug' : '% Incomplete command. Usage: cable plug | cable unplug';
    const machine = machineOf(key);
    const plugged = arg === 'plug';
    const before = machine.state;
    if (before.cablePlugged === plugged && (!plugged || before.connected)) return `The cable is already ${plugged ? 'plugged in' : 'out'}.`;
    const result = await lab.setCable({ ...codes(key), plugged });
    // plugged in: its first heartbeat (and then its upload) waits at the outbox
    if (result.held) return heldLines(result, plugged ? 'Cable plugged in: connected to the broker.' : 'Cable pulled out.');
    const after = result.machine;
    if (!plugged) return 'Cable pulled out: the machine keeps working offline; its records wait in the journal.';
    if (after.connected) {
      const uploaded = before.journal.unsent - after.journal.unsent;
      return `Cable plugged in: connected to the broker, heartbeat sent${uploaded > 0 ? `, ${plural(uploaded, 'unsent record')} uploaded` : ''}.`;
    }
    if (after.deviceStatus && after.deviceStatus !== 'ACTIVE') return `Cable plugged in, but the broker refuses this machine: it is ${after.deviceStatus} in the school office.`;
    if (!lab.server.up) return 'Cable plugged in, but the cloud server is off. The machine keeps trying by itself.';
    return 'Cable plugged in, but the broker did not take the login (is the school suspended?). The machine keeps trying.';
  }

  async function heartbeat(key) {
    const result = await lab.heartbeat(codes(key));
    if (result.held) return heldLines(result, 'Heartbeat signed.');
    const { sent, machine } = result;
    if (!sent) return '% Not connected to the broker: no heartbeat sent.';
    const ver = machine.versions;
    return `Heartbeat sent: prices ${v(ver.prices)}, settings ${v(ver.settings)}, block list ${v(ver.blocklist)}, ${machine.journal.unsent} unsent.`;
  }

  async function upload(key) {
    const result = await lab.upload(codes(key));
    if (result.held) return heldLines(result, 'Upload started.');
    if (!result.connected) return `% Not connected to the broker: ${plural(result.unsent, 'record')} ${result.unsent === 1 ? 'waits' : 'wait'} in the journal.`;
    if (result.records === 0) return result.unsent === 0 ? 'Nothing to upload: every record is sent.' : `% The upload did not go through: ${result.unsent} unsent.`;
    return `Uploaded ${plural(result.records, 'record')} in ${plural(result.batches, 'batch', 'batches')}; ${result.unsent} unsent.`;
  }

  function exportUsb(key) {
    const file = lab.exportUsb(codes(key));
    return [
      `Journal copied to USB: ${plural(file.count, 'record')}, file ${file.format} signed by ${file.device}.`,
      'Import the file in the school office (import journal); the web lab console downloads it.',
    ];
  }

  async function reboot(key) {
    const result = await lab.reboot(codes(key));
    // switched on again: its first heartbeat after the restart waits at the outbox
    if (result.held) return heldLines(result, 'Rebooted.');
    const { machine } = result;
    return `Rebooted. Counters kept: seq ${machine.seq}, txn ${machine.txnCounter}; journal ${plural(machine.journal.total, 'record')} ` +
      `(${machine.journal.unsent} unsent). Broker link ${machine.connected ? 'up' : 'down'}.`;
  }

  function lastBalance(result) {
    const c = result.card;
    return `Card ${c.uid} now holds ${formatRM(c.balanceSen)} (card counter ${c.cardSeq}).`;
  }

  function why(result) {
    if (result.ok || !result.reason) return [];
    return [`(lab: refused because ${result.reason}${result.error ? `, platform answered ${result.error}` : ''}; the screen never says why)`];
  }

  function saleLines(result) {
    // paid on the card already; the record waits at a hop on its way to the platform
    if (result.held) return [`Screen: ${result.screen}`, ...heldLines(result)];
    const lines = [`Screen: ${result.screen}`];
    if (result.ok && result.record) {
      lines.push(lastBalance(result));
      lines.push(`Record ${result.record.txn} ${result.sent ? 'sent to the platform' : 'waits in the journal (no network)'}.`);
    }
    return [...lines, ...why(result)];
  }

  async function sell(key, args) {
    const usage = '% Incomplete command. Usage: tap <uid> <ITEM>[*qty] ..., e.g. tap 04A13B5C7D2E80 NASI-LEMAK TEH-TARIK*2';
    if (args.length < 2) return usage;
    const result = await lab.tap({ ...codes(key), uid: args[0], items: args.slice(1) });
    return saleLines(result);
  }

  async function pour(key, args) {
    if (args.length < 2) return '% Incomplete command. Usage: pour <uid> <ml>, e.g. pour 04C35D2F8B1A82 650';
    if (args.length > 2 || !/^\d{1,6}$/.test(args[1])) return '% Invalid input. Usage: pour <uid> <ml>, e.g. pour 04C35D2F8B1A82 650';
    const result = await lab.tap({ ...codes(key), uid: args[0], ml: Number(args[1]) });
    return saleLines(result);
  }

  async function kioskTap(key, args) {
    if (args.length === 0) return '% Incomplete command. Usage: tap <uid> [fault]';
    const fault = args[1]?.toLowerCase();
    if (args.length > 2 || (fault !== undefined && !KIOSK_FAULTS.includes(fault))) {
      return ['% Invalid input. Usage: tap <uid> [fault]', `  fault: ${KIOSK_FAULTS.join(', ')}`];
    }
    const result = await lab.tap({ ...codes(key), uid: args[0], ...(fault ? { fault } : {}) });
    if (result.held) return heldLines(result, `Card ${result.card?.uid ?? args[0]} read.`);
    const lines = [`Screen: ${result.screen}`];
    for (const a of result.added ?? []) {
      lines.push(`  added ${formatRM(a.amountSen)}  order ${a.orderId}  ${a.kioskTxn}  ${a.confirmed ? 'confirmed' : 'NOT confirmed yet'}`);
    }
    for (const r of result.reconfirmed ?? []) lines.push(`  earlier write ${r.kioskTxn} (order ${r.orderId}) reported again: ${r.result}`);
    if (result.interrupted) {
      const i = result.interrupted;
      lines.push(`(lab: power cut on order ${i.orderId}, ${formatRM(i.amountSen)}: the write ${i.committed ? 'DID reach the card' : 'did not reach the card'})`);
    } else {
      lines.push(...why(result));
    }
    if (result.readback) lines.push(`Read-back: the card's balance and ${plural(result.readback.records.length, 'record')} went to the platform.`);
    lines.push(lastBalance(result));
    return lines;
  }

  async function adminCard(key, machine, arg) {
    if (!arg) return '% Incomplete command. Type help for the admin-card commands here.';
    const ids = codes(key);
    if (machine.deviceType === 'KIOSK' && arg === 'load') {
      const r = await lab.adminCardLoad(ids);
      if (r.held) return heldLines(r);
      const lines = [`Screen: ${r.screen}`, ...why(r)];
      if (r.ok) lines.push(`Admin card now carries ${r.adminCard.packs.map((p) => `${p.kind} ${v(p.version)}`).join(', ')} (token ${r.adminCard.token}).`);
      return lines;
    }
    if (machine.deviceType === 'KIOSK' && arg === 'upload') {
      const r = await lab.adminCardUpload(ids);
      if (r.held) return heldLines(r);
      return [`Screen: ${r.screen}`, ...why(r)];
    }
    if (machine.deviceType !== 'KIOSK' && arg === 'tap') {
      const r = await lab.adminCardTap(ids);
      const lines = [`Screen: ${r.screen}`];
      if (r.results.length > 0) {
        lines.push(...table([{ title: 'KIND' }, { title: 'VERSION' }, { title: 'RESULT' }, { title: 'WHY' }],
          r.results.map((x) => [x.kind, v(x.appliedVersion), x.result, x.error ?? ''])));
        lines.push('Receipts are on the admin card: upload them at the kiosk (admin-card upload).');
      }
      return lines;
    }
    return UNKNOWN_COMMAND;
  }

  async function machineCommand(key, words) {
    const machine = machineOf(key);
    const cmd = words[0].toLowerCase();
    const arg = words[1]?.toLowerCase();
    switch (cmd) {
      case 'show': {
        const usage = 'Usage: show status | config | prices | blocklist | journal [n] | log [n] | held';
        if (!arg) return `% Incomplete command. ${usage}`;
        const extra = words.length > 2;
        if (arg === 'journal') return words.length > 3 ? '% Invalid input. Usage: show journal [n]' : showJournal(key, words[2]);
        if (arg === 'log') return words.length > 3 ? '% Invalid input. Usage: show log [n]' : showLog(key, words[2]);
        if (extra) return `% Invalid input. ${usage}`;
        if (arg === 'status') return showStatus(key);
        if (arg === 'config') return showConfig(key);
        if (arg === 'prices') return showPrices(key);
        if (arg === 'blocklist') return showBlocklist(key);
        // a flow started here can be stepped from here (simulation mode)
        if (arg === 'held') return showHeld();
        return `% Invalid input. ${usage}`;
      }
      case 'next':
        return words.length > 1 ? '% Invalid input. Usage: next' : nextHop();
      case 'cable':
        return words.length > 2 ? '% Invalid input. Usage: cable plug | cable unplug' : cable(key, arg);
      case 'heartbeat':
        return words.length > 1 ? '% Invalid input. Usage: heartbeat' : heartbeat(key);
      case 'upload':
        return words.length > 1 ? '% Invalid input. Usage: upload' : upload(key);
      case 'export':
        if (arg === 'usb' && words.length === 2) return exportUsb(key);
        return arg ? '% Invalid input. Usage: export usb' : '% Incomplete command. Usage: export usb';
      case 'reboot':
        return words.length > 1 ? '% Invalid input. Usage: reboot' : reboot(key);
      case 'tap':
        if (machine.deviceType === 'CANTEEN') return sell(key, words.slice(1));
        if (machine.deviceType === 'KIOSK') return kioskTap(key, words.slice(1));
        return UNKNOWN_COMMAND;
      case 'pour':
        return machine.deviceType === 'WATER' ? pour(key, words.slice(1)) : UNKNOWN_COMMAND;
      case 'admin-card':
        return words.length > 2 ? '% Invalid input. Type help for the admin-card commands here.' : adminCard(key, machine, arg);
      default:
        return UNKNOWN_COMMAND;
    }
  }

  // ---- one command line -----------------------------------------------------------------------

  async function dispatch(session, words) {
    const cmd = words[0].toLowerCase();
    switch (cmd) {
      case 'help':
      case '?':
        return words.length > 1 ? '% Invalid input. Type help.' : help(session);
      case 'machines':
        return words.length > 1 ? '% Invalid input. Usage: machines' : machines();
      case 'connect':
        return connect(session, words.slice(1));
      case 'disconnect':
        return words.length > 1 ? '% Invalid input. Usage: disconnect' : leave(session);
      case 'clock':
        if (words.length === 1) return clockLine();
        if (session.target === 'server') return serverCommand(words);
        return words[1].toLowerCase() === 'advance' ? '% The lab clock is moved from the server: connect server, then clock advance <n>m|h|d.' : '% Invalid input. Usage: clock';
      default:
        break;
    }
    if (session.target === null || session.target === 'server') {
      const answer = simCommand(words);
      if (answer !== null) return answer;
    }
    if (session.target === 'server') return serverCommand(words);
    if (session.target) return machineCommand(session.target, words);
    return UNKNOWN_COMMAND;
  }

  function finish(output) {
    const lines = (Array.isArray(output) ? output : [output]).flatMap((x) => String(x ?? '').split('\n'));
    return lines.map((l) => fit(l)).join('\n');
  }

  /**
   * Run one command line.
   * @param {{ target: string|null }} session  updated by connect / disconnect / exit
   * @param {string} line
   * @returns {Promise<{ output: string, prompt: string, exit?: boolean }>}
   */
  async function run(session, line) {
    const s = session ?? { target: null };
    if (s.target === undefined) s.target = null;
    // a machine that is gone (or a target the web page made up) leaves the session at the top
    if (s.target !== null && s.target !== 'server' && !machineOf(s.target)) s.target = null;
    const text = typeof line === 'string' ? line : '';
    if (text.length > MAX_INPUT) return { output: '% Line too long.', prompt: prompt(s) };
    // control characters never reach a command (a terminal's stray escape sequence, a tab)
    const words = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { output: '', prompt: prompt(s) };
    const cmd = words[0].toLowerCase();
    if (cmd === 'exit' || cmd === 'quit' || cmd === 'logout') {
      if (words.length > 1) return { output: '% Invalid input. Usage: exit', prompt: prompt(s) };
      if (s.target !== null) return { output: finish(leave(s)), prompt: prompt(s) };
      return { output: 'Bye.', prompt: prompt(s), exit: true };
    }
    try {
      const output = await dispatch(s, words);
      return { output: finish(output), prompt: prompt(s) };
    } catch (err) {
      if (isLabError(err)) return { output: finish(`% ${capital(err.message)}${err.message.endsWith('.') ? '' : '.'}`), prompt: prompt(s) };
      try {
        lab.ctx.log?.('error', 'console command failed', { line: text, error: err?.message, stack: err?.stack });
      } catch {
        // a broken logger must not break the console
      }
      return { output: finish(`% Internal error: ${err?.message ?? err}`), prompt: prompt(s) };
    }
  }

  return { run, prompt, banner };
}
