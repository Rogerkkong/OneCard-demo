import net from 'node:net';
import mqtt from 'mqtt';
import { openDb } from '../platform/db.js';
import { createPlatform } from '../platform/platform.js';
import { PLATFORM_USERNAME, parseDeviceUsername, startBroker } from '../broker/broker.js';
import { CanteenReader } from '../devices/canteen.js';
import { WaterMachine } from '../devices/water.js';
import { TopupKiosk } from '../devices/kiosk.js';
import { createKioskApi } from '../devices/kioskApi.js';
import { VirtualCard } from '../devices/card.js';
import { AdminCard } from '../devices/adminCard.js';
import { FIRMWARE_VERSION } from '../devices/terminal.js';
import { createClock, DEFAULT_LAB_START } from '../shared/clock.js';
import { createEventBus } from '../shared/events.js';
import { LabError, isLabError } from '../shared/errors.js';
import { brokerPassword, normalizeUid, randomSecret, signEnvelope, signPayload } from '../shared/crypto.js';
import { newId } from '../shared/ids.js';
import { formatRM, isSen } from '../shared/money.js';
import { CONFIG_KINDS, DEVICE_CODE_RE, DEVICE_TYPES, SCHOOL_CODE_RE, buildEnvelope, topicFor } from '../shared/protocol.js';
import { DAY, HOUR, MINUTE, formatKL } from '../shared/time.js';
import { START_PLAN, seedDemo } from './seed.js';
import { startConsoleServer } from './telnet.js';
import { MAX_SUBJECT_TEXT, createTracer } from './trace.js';
import { routes as labRoutes } from '../http/routes/lab.js';

// The lab (docs/DESIGN.md §8). One process holds the whole virtual system: the virtual cloud
// server (MQTT broker, platform with its database, the web apps) and every school's site (its
// canteen readers, water machines and kiosk, the members' cards and the school's admin card).
// The machines are the virtual hardware of src/devices: they reach the platform only through
// the broker and, for the kiosk, signed HTTP, as real hardware would.
//
// The lab is also the hand that works the hardware: it taps cards, pulls cables, carries the
// admin card, injects faults, moves the clock and switches the cloud server off. Each action
// goes through the machines and the platform's own paths, so whatever a fault does shows up
// where a school would see it (device log, refusal codes, differences), never silently.
//
// It follows the platform's events, so a school onboarded in the operator console comes alive
// at once: device.registered installs the machine, card.issued makes the card, tenant.created
// gives the school its admin card. The lab console builds the same way (DESIGN §12): adding a
// machine or a school registers it on the platform, and those events install it, its cable
// out until someone plugs it in.
//
// Simulation mode (DESIGN §11): every action runs in a trace of its own, so each event it
// causes, across the MQTT and HTTP hops, carries the trace id and the lab console can replay
// the flow. In simulation mode with "hold at each hop" on, a traced flow really waits at the
// hold points (a machine's outbox, the kiosk's API calls, the platform's inbox) until the
// person presses Next, and the action answers early ({ held: true, trace, ... }). Untraced
// traffic never waits, and with hold off nothing behaves differently. Every trace names what it
// is about (its subject, §11.7), and the broker's logins and logouts join the flow that caused
// them (contextFor below): a cable plug, the server switched off, a copied login.

/** Faults the lab can inject (DESIGN §8), besides the kiosk faults a tap takes. */
export const LAB_FAULTS = Object.freeze([
  'clone-card',
  'tamper-card',
  'duplicate-upload',
  'sequence-rollback',
  'forged-message',
  'cross-device-publish',
  'cross-school-card',
  'server-down',
  'server-up',
  'broker-restart',
]);
/** Faults of a kiosk tap (TopupKiosk), accepted by fault() too. */
export const KIOSK_TAP_FAULTS = Object.freeze(['power-cut-before-commit', 'power-cut-after-commit', 'confirm-timeout']);
/** Simulation mode (DESIGN §11.4): realtime (nothing waits) or simulation (hold at each hop can be switched on). */
export const SIM_MODES = Object.freeze(['realtime', 'simulation']);

/**
 * Why the broker went down or came up: every broker.status the lab emits carries a stable
 * `code` and, next to it, the English `reason` given here (DESIGN §11.7).
 * - LAB_START   up: the lab started
 * - LAB_STOP    down: the lab stopped
 * - LAB_RESET   down, then up again: a reset swapped the old demo's broker for a fresh one
 * - SERVER_OFF  down: the cloud server was switched off
 * - SERVER_ON   up: the cloud server was switched on
 * - RESTARTING  down: a broker restart took the old broker down
 * - RESTARTED   up: a broker restart brought the new broker up
 */
export const BROKER_STATUS_CODES = Object.freeze({
  LAB_START: 'lab started',
  LAB_STOP: 'lab stopped',
  LAB_RESET: 'reset',
  SERVER_OFF: 'server switched off',
  SERVER_ON: 'server switched on',
  RESTARTING: 'restart',
  RESTARTED: 'restarted',
});

/** Machines the lab console can add (DESIGN §12), as a trace title names them. */
const MACHINE_WORDS = Object.freeze({ CANTEEN: 'a canteen reader', WATER: 'a water machine', KIOSK: 'a top-up kiosk' });
/** Who the platform's audit trail says made a change the lab console made (DESIGN §12). */
const LAB_ACTOR = 'lab';
const MAX_LOCATION = 60; // a machine's location, as the add dialog takes it
const MAX_NEW_MACHINES = 12; // machines named when adding a school
const MAX_NEW_STUDENTS = 50;
const NEW_STUDENTS = 5; // demo students of a school added without saying how many
const NEW_MACHINES = Object.freeze(['CANTEEN', 'WATER', 'KIOSK']); // a school added without naming machines
// The staff of a school the lab console adds: one per role of the school office. Invented names.
const NEW_SCHOOL_STAFF = Object.freeze([
  Object.freeze({ name: 'Puan Deepa a/p Murugan', role: 'OFFICE' }),
  Object.freeze({ name: 'Encik Lim Chee Keong', role: 'FINANCE' }),
  Object.freeze({ name: 'Cikgu Aminah binti Yusof', role: 'ADMIN' }),
]);

// What a kiosk fault does, in the words of a trace title.
const KIOSK_FAULT_TITLES = Object.freeze({
  'power-cut-before-commit': 'power cut before the card write',
  'power-cut-after-commit': 'power cut after the card write',
  'confirm-timeout': 'the confirmation is lost',
});

const VIEWER = Object.freeze({ username: 'viewer', password: 'viewer' }); // public read-only broker login (README)
const HEARTBEAT_ONLINE_MS = 90_000;
const EVENTS_KEPT = 2000;
const MAX_CLOCK_STEP_MS = 400 * DAY;
const CONNECT_WAIT_MS = 15_000; // boot: plugged machines must be on the broker by then
const VERDICT_WAIT_MS = 3000; // a fault waits this long for the platform's answer
const THROWAWAY_WAIT_MS = 2000; // cross-device-publish: how long the copied login may stay on
const RECONNECT_WAIT_MS = 15_000; // machines retry 1 s doubling to 10 s
const LOGIN_GATE_MS = 3000; // a machine login waits this long for the platform to listen (machines give up after 5 s)
const COPY_SUFFIX_RE = /^(.*?)-copy(\d*)$/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** Poll `predicate` until it is truthy or `timeoutMs` passes. @returns {Promise<boolean>} */
async function waitUntil(predicate, timeoutMs, intervalMs = 20) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > until) return false;
    await sleep(intervalMs);
  }
}

function defaultLog(level, message, meta) {
  if (level !== 'error') return;
  try {
    console.error(`[lab] ${message}`, meta ?? '');
  } catch {
    // a broken console must not break the lab
  }
}

/** Address clients use for a listen address: a wildcard is reachable on loopback. */
function reachableHost(host) {
  if (host === '0.0.0.0' || host === '') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** The database the services hold; the lab swaps the connection underneath on reset(). */
function swappableDb(first) {
  let current = first;
  const db = {
    get raw() {
      return current.raw;
    },
    run: (sql, ...params) => current.run(sql, ...params),
    get: (sql, ...params) => current.get(sql, ...params),
    all: (sql, ...params) => current.all(sql, ...params),
    exec: (sql) => current.exec(sql),
    tx: (fn) => current.tx(fn),
    inTransaction: () => current.inTransaction(),
    afterCommit: (fn) => current.afterCommit(fn),
    close: () => current.close(),
  };
  return {
    db,
    swap(next) {
      const old = current;
      current = next;
      return old;
    },
  };
}

/** The lab clock the services hold; reset() starts a fresh one underneath (time only goes forward otherwise). */
function swappableClock(first) {
  let current = first;
  const clock = {
    get mode() {
      return current.mode;
    },
    now: () => current.now(),
    iso: () => current.iso(),
    advance: (ms) => current.advance(ms),
  };
  return {
    clock,
    swap(next) {
      current = next;
    },
  };
}

function labOptions(options) {
  const o = options ?? {};
  const port = (name, value, fallback) => {
    const v = value ?? fallback;
    if (!Number.isInteger(v) || v < 0 || v > 65535) throw new TypeError(`${name} must be a port number from 0 to 65535`);
    return v;
  };
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new TypeError('heartbeatMs must be a whole number of milliseconds');
  const jobsMs = o.jobsMs ?? 5000;
  if (!Number.isSafeInteger(jobsMs) || jobsMs < 0) throw new TypeError('jobsMs must be a whole number of milliseconds (0 = no timer)');
  const reconnectMs = o.reconnectMs ?? null; // null: the machines' own default
  if (reconnectMs !== null && (!Number.isSafeInteger(reconnectMs) || reconnectMs < 1 || reconnectMs > 60_000)) {
    throw new TypeError('reconnectMs must be a whole number of milliseconds, 1 to 60000');
  }
  if (o.tls != null && (!isPlainObject(o.tls) || !o.tls.key || !o.tls.cert)) throw new TypeError('tls needs { key, cert } (PEM) and optionally port');
  if (o.webRoot != null && (typeof o.webRoot !== 'string' || o.webRoot === '')) throw new TypeError('webRoot must be the folder of the web apps');
  return {
    httpPort: port('httpPort', o.httpPort, 8080),
    mqttPort: port('mqttPort', o.mqttPort, 1883),
    consolePort: port('consolePort', o.consolePort, 2323),
    host: typeof o.host === 'string' && o.host ? o.host : '127.0.0.1',
    clockMode: o.clockMode ?? 'real',
    startAt: o.startAt ?? DEFAULT_LAB_START,
    heartbeatMs,
    jobsMs,
    reconnectMs,
    tls: o.tls ?? null,
    // the web apps' folder; null: web/ next to the source (a single-file build passes its own)
    webRoot: o.webRoot ?? null,
    log: typeof o.log === 'function' ? o.log : defaultLog,
  };
}

const required = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new LabError('INPUT_INVALID', `${name} is required`, 400);
  return value.trim();
};

/**
 * A tray card id: a card UID, or a copy of one ('<UID>-copy', '<UID>-copy2', …).
 * @returns {{ base: string, suffix: string }}  base: the normalised UID; suffix: '' or '-copy…'
 */
function parseTrayUid(text) {
  const raw = required(text, 'uid');
  const m = COPY_SUFFIX_RE.exec(raw);
  const base = normalizeUid(m ? m[1] : raw); // CARD_UID_INVALID (400) for anything else
  return { base, suffix: m ? `-copy${m[2]}` : '' };
}

/** Items for a canteen tap: [{ code, qty }] or 'CODE*qty' strings. */
function parseItems(items) {
  const list = typeof items === 'string' ? items.trim().split(/\s+/) : items;
  if (!Array.isArray(list) || list.length === 0) {
    throw new LabError('INPUT_INVALID', 'a canteen tap needs items: [{ code, qty }] (for example NASI-LEMAK, TEH-TARIK*2)', 400);
  }
  return list.map((item) => {
    if (typeof item === 'string') {
      const m = /^([A-Za-z0-9-]+)(?:\*(\d{1,3}))?$/.exec(item.trim());
      if (!m) throw new LabError('INPUT_INVALID', `item ${item} must look like NASI-LEMAK or TEH-TARIK*2`, 400);
      return { code: m[1].toUpperCase(), qty: m[2] ? Number(m[2]) : 1 };
    }
    if (!isPlainObject(item) || typeof item.code !== 'string') throw new LabError('INPUT_INVALID', 'each item needs a code', 400);
    const qty = item.qty ?? 1;
    if (!Number.isSafeInteger(qty)) throw new LabError('INPUT_INVALID', 'item qty must be a whole number', 400);
    return { code: item.code.trim().toUpperCase(), qty };
  });
}

function parseMl(ml) {
  const n = typeof ml === 'string' && /^\d+$/.test(ml.trim()) ? Number(ml) : ml;
  if (!Number.isSafeInteger(n) || n < 1) throw new LabError('INPUT_INVALID', 'a water tap needs ml: a whole number of millilitres, 1 or more', 400);
  return n;
}

/** Text for a trace subject: at most 120 characters (DESIGN §11.7), a longer one cut with "…". */
const subjectText = (text) => (text.length <= MAX_SUBJECT_TEXT ? text : `${text.slice(0, MAX_SUBJECT_TEXT - 1)}…`);

/** A canteen order in a few words, as typed at a reader's console: 'NASI-LEMAK TEH-TARIK*2'. */
const itemsText = (items) => subjectText(items.map(({ code, qty }) => (qty === 1 ? code : `${code}*${qty}`)).join(' '));

/** CANTEEN, WATER or KIOSK (any case). Code: INPUT_INVALID (400). */
function machineType(type) {
  const kind = typeof type === 'string' ? type.trim().toUpperCase() : '';
  if (!DEVICE_TYPES.includes(kind)) throw new LabError('INPUT_INVALID', `type must be one of ${DEVICE_TYPES.join(', ')}`, 400);
  return kind;
}

/** A device code such as CANTEEN-03 (any case); null when left out. Code: INPUT_INVALID (400). */
function newMachineCode(code) {
  if (code === undefined || code === null || code === '') return null;
  const text = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!DEVICE_CODE_RE.test(text)) {
    throw new LabError('INPUT_INVALID', 'code must be upper-case letters, digits and dashes, e.g. CANTEEN-03', 400);
  }
  return text;
}

/** Where a machine stands, e.g. 'Canteen counter C': text of at most 60 characters ('' when left out). */
function newMachineLocation(location) {
  if (location === undefined || location === null) return '';
  if (typeof location !== 'string' || location.trim().length > MAX_LOCATION) {
    throw new LabError('INPUT_INVALID', `location must be text of at most ${MAX_LOCATION} characters`, 400);
  }
  return location.trim();
}

/**
 * The first free '<TYPE>-NN' code among `taken` (two digits, three past 99): the lowest number
 * no code of that type uses, however it was written (CANTEEN-3 and CANTEEN-003 both use 3).
 */
function freeMachineCode(type, taken) {
  const used = new Set();
  const numbered = new RegExp(`^${type}-(\\d{1,9})$`);
  for (const code of taken) {
    const m = numbered.exec(code);
    if (m) used.add(Number(m[1]));
  }
  for (let n = 1; ; n += 1) {
    const code = `${type}-${String(n).padStart(2, '0')}`;
    if (!used.has(n) && !taken.has(code)) return code;
  }
}

/** A promise, or anything that can be awaited like one. */
function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

/** A clock step in plain words for a trace title: '15 days', '1 h 30 min', '5 s'. */
function durationText(ms) {
  const parts = [];
  let left = ms;
  for (const [size, one, many] of [[DAY, 'day', 'days'], [HOUR, 'h', 'h'], [MINUTE, 'min', 'min'], [1000, 's', 's']]) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  if (left > 0) parts.push(`${left} ms`);
  return parts.join(' ');
}

/**
 * Build the lab. Nothing listens until start().
 * @param {object} [options]
 * @param {number} [options.httpPort]  web apps and APIs (default 8080; 0 picks a free port)
 * @param {number} [options.mqttPort]  MQTT broker (default 1883; 0 picks a free port, kept across restarts)
 * @param {number} [options.consolePort]  PuTTY/telnet consoles (default 2323; 0 = off)
 * @param {string} [options.host]  listen address (default 127.0.0.1)
 * @param {'real'|'manual'} [options.clockMode]  manual: the lab clock stands still until advanced (tests)
 * @param {number} [options.startAt]  lab time at start (default Mon 05/10/2026 10:00 KL)
 * @param {number} [options.heartbeatMs]  machine heartbeat period (default 15000)
 * @param {number} [options.jobsMs]  scheduled jobs period (default 5000; 0 = no timer)
 * @param {number} [options.reconnectMs]  a machine's first retry after losing the broker (default
 *   the machines' own, 1 s; it doubles up to 10 s): lower in tests that switch the server off
 * @param {{ port?: number, key: string, cert: string }} [options.tls]  optional MQTT TLS listener
 * @param {(level: string, message: string, meta?: object) => void} [options.log]  default: errors to stderr
 */
export function createLab(options = {}) {
  const config = labOptions(options);
  const dbRef = swappableDb(openDb(':memory:'));
  const clockRef = swappableClock(createClock({ startAt: config.startAt, mode: config.clockMode }));
  const clock = clockRef.clock;
  const db = dbRef.db;
  // db first: events emitted inside a transaction are delivered after the commit
  const events = createEventBus({ clock, db, keep: EVENTS_KEPT });
  // every action and product request starts a trace (DESIGN §11.3); server.js reads lab.tracer
  const tracer = createTracer(events, { clock });
  const ctx = {
    db,
    clock,
    events,
    settings: {
      providerSecret: randomSecret(),
      platformBrokerPassword: randomSecret(),
      viewer: { ...VIEWER },
      heartbeatOnlineMs: HEARTBEAT_ONLINE_MS,
    },
    log: config.log,
  };

  let broker = null; // the running broker, null while the server is down (or mid-restart)
  const platform = createPlatform(ctx, { broker: () => broker });

  let phase = 'new'; // new | starting | running | resetting | stopping | stopped
  let serverUp = false; // the virtual cloud server: broker + platform + the product APIs
  let brokerPort = config.mqttPort;
  let tlsPort = config.tls?.port ?? 8883;
  let http = null;
  let httpUrl = null;
  let consoleServer = null;
  let jobsTimer = null;
  let unsubscribe = null;
  let seedInfo = null;
  let lock = Promise.resolve();
  const background = new Set(); // machines being installed after a platform event

  const terminals = new Map(); // '<school>/<DEVICE>' -> machine
  const cards = new Map(); // '<school>/<UID>' (copies: '<school>/<UID>-copy…') -> VirtualCard
  const copies = new Map(); // tray key of a copy -> tray key of the card it copies
  const adminCards = new Map(); // school code -> AdminCard
  const lastResults = new Map(); // machine key -> what its last tap or action came to (for state())
  // Building (DESIGN §12): the cable a machine the lab console is adding gets when the platform's
  // device.registered installs it (machine key -> plugged). Any other new machine gets the usual
  // one: kiosks and readers plugged in, water machines not.
  const cableAtInstall = new Map();
  const installs = new Map(); // machine key -> its installation (installRegistered), while it runs

  // Broker logins and logouts join their flow (DESIGN §11.7; contextFor below).
  let brokerFlow = null; // { trace } of the server or broker action that opens or closes the broker now
  const loginFlows = new Map(); // broker username -> trace of the fault logging in with it

  // Simulation mode (DESIGN §11.4): the mode, whether traced flows wait at each hop, and what waits.
  const sim = { mode: 'realtime', hold: false };
  const held = []; // [{ item, release }], oldest first
  const holdWatchers = new Map(); // trace id -> callbacks of the actions racing their first hold

  const services = () => platform.services;
  const loopback = reachableHost(config.host);
  const machineBrokerUrl = () => `mqtt://${loopback}:${brokerPort}`;
  const machineKey = (schoolCode, deviceCode) => `${String(schoolCode).trim().toLowerCase()}/${String(deviceCode).trim().toUpperCase()}`;

  function note(level, message, meta) {
    try {
      ctx.log?.(level, message, meta);
    } catch {
      // a broken logger must not break the lab
    }
  }

  function emit(type, data, schoolCode = null) {
    events.emit(type, data, schoolCode);
  }

  /** Start, stop, reset and the server switches run one at a time. */
  function exclusive(fn) {
    const run = lock.then(fn);
    lock = run.catch(() => {});
    return run;
  }

  // ---- Simulation mode: traces and live stepping (DESIGN §11.3, §11.4) -------------------
  //
  // Each action begins its trace before it starts (act()), so even a hold reached before its
  // first await belongs to it. The gates hold only a flow of a trace the tracer knows, and only
  // in simulation mode with hold on; everything else (periodic heartbeats, the jobs timer,
  // automatic reconnects, untraced command acks at the machine) passes, synchronously.

  const holding = () => phase === 'running' && sim.mode === 'simulation' && sim.hold;

  /** Emit in exactly this trace (not in the caller's message context). */
  function emitInTrace(trace, type, data, schoolCode) {
    events.untraced(() => events.withContext({ trace }, () => emit(type, data, schoolCode)));
  }

  /**
   * Hold one hop of a traced flow until the person lets it go: a held item, announced as
   * sim.held inside its trace. @returns {Promise<void>} what the gate hands back to wait for
   */
  function hold({ trace, where, device, school, ...more }) {
    const item = { id: newId('held'), trace, where, device: device ?? null, school: school ?? null };
    for (const key of ['type', 'msgId', 'call', 'txn', 'topic', 'method', 'path']) {
      if (typeof more[key] === 'string' && more[key] !== '') item[key] = more[key];
    }
    item.at = clock.now();
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    held.push({ item, release });
    emitInTrace(trace, 'sim.held', { ...item }, item.school);
    for (const notify of [...(holdWatchers.get(trace) ?? [])]) {
      try {
        notify(item);
      } catch (err) {
        note('error', 'a held action could not be told', { error: err?.message });
      }
    }
    return waiting;
  }

  /** Let one held item go on (sim.released inside its trace first, so the replay reads in order). */
  function letGo(entry) {
    const at = held.indexOf(entry);
    if (at < 0) return false; // already let go (a reset, a stop)
    held.splice(at, 1);
    emitInTrace(entry.item.trace, 'sim.released', { id: entry.item.id }, entry.item.school);
    entry.release();
    return true;
  }

  // A message held at the platform's inbox is with the platform: it goes on only while the
  // platform runs, i.e. while the cloud server is on.
  const releasable = (entry) => entry.item.where !== 'platform' || serverUp;

  /** The hold point of every machine's outbox and of the kiosk's API calls (Terminal option gate). */
  function machineGate(info) {
    if (!holding()) return undefined;
    const trace = events.context()?.trace;
    if (!trace || !tracer.has(trace)) return undefined;
    if (info?.kind === 'http') {
      return hold({ trace, where: 'kiosk-http', device: info.device, school: info.school, call: info.call, method: info.method, path: info.path });
    }
    return hold({ trace, where: 'machine', device: info?.device, school: info?.school, type: info?.type, msgId: info?.msgId, txn: info?.txn, topic: info?.topic });
  }

  /** The hold point of the platform's inbox: a message whose flow the tracer knows (by its id). */
  function inboxGate(info) {
    if (!holding()) return undefined;
    const trace = tracer.traceOfMessage(info?.msgId);
    if (!trace) return undefined;
    return hold({ trace, where: 'platform', device: info.device, school: info.school, type: info.type, msgId: info.msgId, topic: info.topic });
  }

  /**
   * The inbox gate is installed only while hold is on: the platform reads every message's type
   * and id for its gate, and with no gate a message goes to intake exactly as in realtime.
   * Messages already held keep waiting for their release either way.
   */
  function syncInboxGate() {
    platform.setInboxGate(sim.hold ? inboxGate : null);
  }

  /** Call `notify(item)` when this trace holds something. @returns {() => void} stop watching */
  function watchHolds(trace, notify) {
    let set = holdWatchers.get(trace);
    if (!set) holdWatchers.set(trace, (set = new Set()));
    set.add(notify);
    return () => {
      set.delete(notify);
      if (set.size === 0 && holdWatchers.get(trace) === set) holdWatchers.delete(trace);
    };
  }

  /**
   * Run one lab action in a trace of its own (DESIGN §11.3). An async action races its first
   * hold (§11.4): held first, it answers `{ held: true, trace, item, ...partial(item) }` at once
   * and finishes in the background (its lab.action event comes when it does; a failure then is
   * logged and reported as lab.action { ok: false }). Otherwise it answers as always, with
   * `trace` added to an object answer (unless `tag` is false: a USB file stays the file).
   * @param {{ kind: string, title: string, school?: string|null, device?: string|null }} meta
   * @param {() => unknown} fn
   * @param {{ partial?: (item: object) => object, tag?: boolean, action?: object }} [options]
   *   action: what lab.action says of a late failure (default { action: meta.kind })
   */
  function act(meta, fn, { partial, tag = true, action } = {}) {
    const trace = tracer.begin(meta);
    const tagged = (value) => (tag && isPlainObject(value) && !Object.hasOwn(value, 'trace') ? { ...value, trace } : value);
    let firstHold;
    const heldFirst = new Promise((resolve) => {
      firstHold = resolve;
    });
    // watching before the action starts: a hop can hold it before its first await
    const stopWatching = watchHolds(trace, (item) => firstHold(item));
    let outcome;
    try {
      outcome = events.withContext({ trace }, fn);
    } catch (err) {
      stopWatching();
      throw err;
    }
    if (!isThenable(outcome)) {
      stopWatching();
      return tagged(outcome);
    }
    return new Promise((resolve, reject) => {
      let answered = false;
      heldFirst.then((item) => {
        if (answered) return;
        answered = true;
        let extra = {};
        try {
          extra = partial ? partial(item) : {};
        } catch (err) {
          note('warn', 'could not describe a held action', { trace, error: err?.message });
        }
        resolve({ held: true, trace, ...extra, item: { ...item } });
      });
      Promise.resolve(outcome).then(
        (value) => {
          stopWatching();
          if (answered) return;
          answered = true;
          resolve(tagged(value));
        },
        (err) => {
          stopWatching();
          if (!answered) {
            answered = true;
            reject(err);
            return;
          }
          // the person already has the early answer: the failure goes to the log and the trace
          note(isLabError(err) ? 'info' : 'error', `${meta.title}: failed after it was held`, { trace, error: err?.message });
          const data = { ...(action ?? { action: meta.kind }), ok: false, code: isLabError(err) ? err.code : 'INTERNAL' };
          data.message = String(err?.message ?? err).slice(0, 200);
          emitInTrace(trace, 'lab.action', data, meta.school ?? null);
        },
      );
    });
  }

  /** @returns {{ mode: 'realtime'|'simulation', hold: boolean, held: object[] }} copies; held: oldest first */
  function simState() {
    return { mode: sim.mode, hold: sim.hold, held: held.map((e) => ({ ...e.item })) };
  }

  function announceMode() {
    events.untraced(() => emit('sim.mode', { mode: sim.mode, hold: sim.hold }));
  }

  /** Let every releasable item go on, oldest first. @returns {number} how many */
  function releaseReleasable() {
    let n = 0;
    for (const entry of held.filter(releasable)) if (letGo(entry)) n += 1;
    return n;
  }

  /**
   * Switch Simulation mode (DESIGN §11.4): `mode` 'realtime' | 'simulation', `hold` true | false
   * (hold only in simulation mode; realtime turns it off). Turning hold off, or going back to
   * realtime, lets everything releasable go on. Emits sim.mode when something changed.
   * Code: INPUT_INVALID (400).
   * @param {{ mode?: string, hold?: boolean }} args
   * @returns {{ mode: string, hold: boolean, held: object[] }} the new state
   */
  function setSim(args = {}) {
    if (!isPlainObject(args)) throw new LabError('INPUT_INVALID', 'give { mode, hold }', 400);
    const { mode, hold: wantHold } = args;
    if (mode === undefined && wantHold === undefined) {
      throw new LabError('INPUT_INVALID', "give mode ('realtime' or 'simulation'), hold (true or false), or both", 400);
    }
    if (mode !== undefined && !SIM_MODES.includes(mode)) throw new LabError('INPUT_INVALID', "mode must be 'realtime' or 'simulation'", 400);
    if (wantHold !== undefined && typeof wantHold !== 'boolean') throw new LabError('INPUT_INVALID', 'hold must be true or false', 400);
    const nextMode = mode ?? sim.mode;
    if (nextMode === 'realtime' && wantHold === true) {
      throw new LabError('INPUT_INVALID', 'hold at each hop works only in simulation mode: switch to simulation first', 400);
    }
    const nextHold = nextMode === 'simulation' && (wantHold ?? sim.hold);
    const changed = nextMode !== sim.mode || nextHold !== sim.hold;
    sim.mode = nextMode;
    sim.hold = nextHold;
    syncInboxGate();
    if (changed) announceMode();
    if (!sim.hold) releaseReleasable();
    return simState();
  }

  /**
   * Let the oldest releasable item go on (a platform item only while the server is up).
   * @returns {{ released: object|null, waiting: number }}  waiting: items still held
   */
  function simNext() {
    const entry = held.find(releasable);
    if (entry) letGo(entry);
    return { released: entry ? { ...entry.item } : null, waiting: held.length };
  }

  /** Let every releasable item go on, oldest first. @returns {{ released: number }} */
  function simRelease() {
    return { released: releaseReleasable() };
  }

  /** Reset and stop: realtime again, and everything goes on (a platform item too: nothing may wait for ever). */
  function backToRealtime() {
    const changed = sim.mode !== 'realtime' || sim.hold;
    sim.mode = 'realtime';
    sim.hold = false;
    syncInboxGate();
    if (changed) announceMode();
    for (const entry of [...held]) letGo(entry);
  }

  function requireRunning() {
    if (phase === 'running') return;
    if (phase === 'starting' || phase === 'resetting') {
      throw new LabError('LAB_BUSY', 'the lab is setting up the demo, try again in a moment', 503);
    }
    throw new LabError('LAB_NOT_RUNNING', 'the lab is not running', 503);
  }

  function requireServerUp() {
    if (!serverUp || !broker) throw new LabError('SERVER_DOWN', 'the cloud server is switched off: switch it on first', 409);
  }

  /** The next event after `afterSeq` that matches, or null after `timeoutMs`. */
  function nextEvent(predicate, afterSeq, timeoutMs = VERDICT_WAIT_MS) {
    const seen = events.since(afterSeq).find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stop();
        resolve(value);
      };
      const stop = events.subscribe((e) => {
        if (e.seq > afterSeq && predicate(e)) finish(e);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
    });
  }

  // ---- the virtual cloud server: broker and platform link ------------------------------

  /**
   * A machine may log in only once the platform listens on this broker again. A fresh broker
   * acknowledges what a machine uploads and drops it when nobody has subscribed yet, so a
   * machine that came back before the platform would lose its journal. The login waits a moment
   * (the platform reconnects within milliseconds), else it is refused and the machine retries.
   */
  async function machineLogin(username) {
    if (!platform.mqttStatus().subscribed && !(await waitUntil(() => platform.mqttStatus().subscribed, LOGIN_GATE_MS))) return null;
    return platform.resolveBrokerDevice(username);
  }

  /** `{ trace }` of the current flow, or null outside one. */
  function currentFlow() {
    const trace = events.context()?.trace;
    return typeof trace === 'string' ? { trace } : null;
  }

  /**
   * The broker's contextFor (DESIGN §11.7): the flow a login, logout or refusal belongs to, so
   * the broker reports it in that flow. First the copied login of a fault while it runs; then a
   * machine's own (a cable plug or pull, a reboot, the next connect a server action keeps for
   * it); then, for the machines and the platform, the server or broker action opening or
   * closing the broker right now. Anyone else (the viewer, a made-up machine name) is in no flow.
   * @param {string|null} username
   * @param {'connect'|'disconnect'|'denied'} event
   * @returns {{ trace: string } | null}
   */
  function brokerContextFor(username, event) {
    if (typeof username !== 'string') return null;
    const known = (flow) => (typeof flow?.trace === 'string' && tracer.has(flow.trace) ? { trace: flow.trace } : null);
    const copied = known(loginFlows.has(username) ? { trace: loginFlows.get(username) } : null);
    if (copied) return copied;
    if (username !== PLATFORM_USERNAME) {
      const codes = parseDeviceUsername(username);
      const machine = codes ? terminals.get(machineKey(codes.schoolCode, codes.deviceCode)) : undefined;
      if (!machine) return null; // not one of the lab's machines
      const own = known(machine.linkContext(event));
      if (own) return own;
    }
    return known(brokerFlow);
  }

  /** Start the broker. @param {keyof BROKER_STATUS_CODES} code  why (broker.status) */
  async function openBroker(code) {
    const tls = config.tls ? { key: config.tls.key, cert: config.tls.cert, port: tlsPort } : undefined;
    // Untraced: the broker outlives the action that starts it, and its connection handler
    // would otherwise hand that action's trace to every later login (DESIGN §11.1).
    const started = await events.untraced(() =>
      startBroker(ctx, {
        host: config.host,
        port: brokerPort,
        tls,
        resolveDevice: machineLogin,
        platformPassword: ctx.settings.platformBrokerPassword,
        viewer: ctx.settings.viewer,
        contextFor: brokerContextFor,
      }),
    );
    // a restarted broker comes back on the same port, so machines and MQTT Explorer find it again
    brokerPort = started.port;
    if (started.tlsPort) tlsPort = started.tlsPort;
    broker = started;
    emit('broker.status', { up: true, url: started.url, tlsUrl: started.tlsUrl, reason: BROKER_STATUS_CODES[code], code });
    return started;
  }

  /** Stop the broker. @param {keyof BROKER_STATUS_CODES} code  why (broker.status) */
  async function closeBroker(code) {
    const b = broker;
    if (!b) return;
    broker = null;
    emit('broker.status', { up: false, url: b.url, reason: BROKER_STATUS_CODES[code], code });
    await b.close();
  }

  function brokerStatus() {
    const clients = broker ? broker.clients() : [];
    const bySchool = {};
    for (const c of clients) {
      const dot = typeof c.username === 'string' ? c.username.indexOf('.') : -1;
      const where = dot > 0 ? c.username.slice(0, dot) : c.username === 'platform' ? '(platform)' : `(${c.username ?? 'other'})`;
      bySchool[where] = (bySchool[where] ?? 0) + 1;
    }
    return {
      up: Boolean(broker),
      url: broker?.url ?? `mqtt://${loopback}:${brokerPort}`,
      tlsUrl: broker?.tlsUrl ?? null,
      clients: clients.length,
      bySchool,
      viewer: { username: ctx.settings.viewer.username, password: ctx.settings.viewer.password },
    };
  }

  // ---- the physical world: machines, cards, admin cards --------------------------------

  /** Install a machine as a technician would: build it, provision the current settings, record them. */
  function installMachine({ schoolCode, schoolId, cardKey, device, secret, cablePlugged }) {
    const key = machineKey(schoolCode, device.code);
    if (terminals.has(key)) return terminals.get(key);
    const options = {
      school: { code: schoolCode, cardKey },
      device: { code: device.code, type: device.type, secret },
      brokerUrl: machineBrokerUrl(),
      clock,
      events,
      heartbeatMs: config.heartbeatMs,
      cablePlugged,
      log: ctx.log,
      gate: machineGate,
    };
    if (config.reconnectMs !== null) options.reconnectMs = config.reconnectMs;
    let machine;
    if (device.type === 'CANTEEN') machine = new CanteenReader(options);
    else if (device.type === 'WATER') machine = new WaterMachine(options);
    else {
      let kiosk = null; // the API is built first: the kiosk takes it in its constructor
      const api = createKioskApi({
        baseUrl: httpUrl,
        schoolCode,
        deviceCode: device.code,
        secret,
        clock,
        // No network without the kiosk's cable, and none while the cloud server is off: a
        // switched-off server answers nothing (NETWORK), as DESIGN §11.4 says. The lab's web
        // server keeps running for the lab console, but its 503 is not the platform talking.
        // Nor for a kiosk a reset has taken away: a visit it still finishes (one let go by the
        // reset) must not reach the new demo's platform.
        online: () => serverUp && kiosk?.cablePlugged === true && terminals.get(key) === kiosk,
        // the flow a call belongs to, so the platform's side of it joins the trace (DESIGN §11.3)
        headers: () => {
          const trace = events.context()?.trace;
          return trace ? { 'x-lab-trace': trace } : {};
        },
      });
      machine = new TopupKiosk({ ...options, api });
      kiosk = machine;
    }
    // Terminal.provision skips a kind never published (version 0); what it installed is recorded
    const { configs } = services();
    const installed = machine.provision({
      prices: configs.current(schoolId, 'prices'),
      settings: configs.current(schoolId, 'settings'),
      blocklist: configs.current(schoolId, 'blocklist'),
    });
    for (const kind of CONFIG_KINDS) {
      if (installed[kind] > 0) configs.recordListState({ deviceId: device.id, kind, version: installed[kind], via: 'PROVISION', schoolId });
    }
    terminals.set(key, machine);
    return machine;
  }

  /** A machine the platform has just registered (operator onboarding, school office, the lab console). */
  async function installRegistered(schoolCode, deviceCode) {
    if (typeof schoolCode !== 'string' || typeof deviceCode !== 'string') return;
    if (terminals.has(machineKey(schoolCode, deviceCode))) return;
    const { devices, schools } = services();
    const found = devices.resolveByCodes(schoolCode, deviceCode);
    if (!found) return;
    const preferred = cableAtInstall.get(machineKey(found.school.code, found.device.code));
    const machine = installMachine({
      schoolCode: found.school.code,
      schoolId: found.school.id,
      cardKey: schools.schoolCardKey(found.school.id),
      device: found.device,
      secret: found.secret,
      // kiosks and canteen readers come with a network cable, water points do not (DESIGN §8);
      // a machine the lab console adds comes with its cable out (§12)
      cablePlugged: typeof preferred === 'boolean' ? preferred : found.device.type !== 'WATER',
    });
    await machine.start();
  }

  /** installRegistered, remembered while it runs: the lab console's add waits for it (DESIGN §12). */
  function install(schoolCode, deviceCode) {
    const key = typeof schoolCode === 'string' && typeof deviceCode === 'string' ? machineKey(schoolCode, deviceCode) : null;
    const running = installRegistered(schoolCode, deviceCode);
    if (key && !installs.has(key)) {
      const settled = running.catch(() => {}).finally(() => {
        if (installs.get(key) === settled) installs.delete(key);
      });
      installs.set(key, settled);
    }
    return running;
  }

  function addCard(schoolCode, uid, group, cardKey) {
    const key = `${schoolCode}/${uid}`;
    if (!cards.has(key)) cards.set(key, new VirtualCard({ uid, schoolCode, group, cardKey }));
    return cards.get(key);
  }

  /** The physical card of a card the platform has just issued: blank, balance 0. */
  function addIssuedCard(schoolCode, uid, memberId) {
    if (typeof schoolCode !== 'string' || typeof uid !== 'string') return;
    const { schools } = services();
    const school = schools.getSchoolByCode(schoolCode);
    if (!school) return;
    const member = schools.getMember(school.id, memberId);
    addCard(school.code, uid, member?.group ?? 'STUDENT', schools.schoolCardKey(school.id));
  }

  function addAdminCard(schoolCode) {
    if (typeof schoolCode === 'string' && !adminCards.has(schoolCode)) adminCards.set(schoolCode, new AdminCard({ schoolCode }));
  }

  function track(promise) {
    const p = promise
      .catch((err) => note('error', 'the lab could not install a new machine', { error: err?.message }))
      .finally(() => background.delete(p));
    background.add(p);
  }

  /** New tenants come alive without a restart (DESIGN §8). */
  function onPlatformEvent(e) {
    if (phase !== 'starting' && phase !== 'running' && phase !== 'resetting') return;
    try {
      if (e.type === 'device.registered') track(install(e.school, e.data?.code));
      else if (e.type === 'card.issued') addIssuedCard(e.school, e.data?.uid, e.data?.memberId);
      else if (e.type === 'tenant.created') addAdminCard(e.school);
    } catch (err) {
      note('error', `the lab could not follow ${e.type}`, { error: err?.message });
    }
  }

  // ---- building the demo -----------------------------------------------------------------

  async function buildWorld() {
    for (const s of seedInfo.schools) {
      addAdminCard(s.code);
      for (const m of s.members) addCard(s.code, m.cardUid, m.group, s.cardKey);
    }
    const machines = [];
    for (const s of seedInfo.schools) {
      for (const d of s.devices) {
        machines.push(
          installMachine({
            schoolCode: s.code,
            schoolId: s.id,
            cardKey: s.cardKey,
            device: { id: d.id, code: d.code, type: d.type },
            secret: d.secret,
            cablePlugged: d.cablePlugged,
          }),
        );
      }
    }
    await Promise.all(machines.map((m) => m.start()));
    const plugged = machines.filter((m) => m.cablePlugged);
    if (!(await waitUntil(() => plugged.every((m) => m.connected), CONNECT_WAIT_MS))) {
      const missing = plugged.filter((m) => !m.connected).map((m) => `${m.schoolCode}/${m.deviceCode}`);
      throw new Error(`lab: these machines could not connect to the broker: ${missing.join(', ')}`);
    }
    await runStartPlan();
    const books = checkBooks();
    const problems = [];
    for (const s of books.schools) {
      if (!s.balanced) problems.push(`${s.code}: the trial balance does not balance`);
      for (const c of s.cards) {
        if (!c.match) problems.push(`${s.code} card ${c.uid}: ${formatRM(c.cardSen)} on the card, ${formatRM(c.mirrorSen)} in the books`);
      }
      if (s.openDifferences > 0) problems.push(`${s.code}: ${s.openDifferences} difference(s) opened while the demo was set up`);
    }
    if (problems.length > 0) throw new Error(`lab: the starting balances do not add up:\n  ${problems.join('\n  ')}`);
  }

  /** A parent's top-up, paid at the mock bank: the provider's signed callback, as the bank sends it. */
  function paidTopup(school, member, amountSen, label) {
    const { topups } = services();
    const parent = seedInfo.parents.find((p) => p.children.some(([code, no]) => code === school.code && no === member.memberNo));
    if (!parent) throw new Error(`lab: START_PLAN tops up ${school.code}/${member.memberNo}, who has no parent in the seed`);
    const order = topups.createOrder({
      parentId: parent.id,
      schoolId: school.id,
      memberId: member.id,
      amountSen,
      idemKey: `demo-${school.code}-${member.memberNo}-${label}`,
    });
    const payload = {
      orderId: order.id,
      provider: 'MOCKBANK',
      providerTxnId: `DEMO-${order.id}`,
      result: 'SUCCESS',
      paidAmountSen: amountSen,
      paidAt: clock.iso(),
    };
    const paid = topups.paymentCallback({ ...payload, signature: signPayload(ctx.settings.providerSecret, payload) });
    if (paid.status !== 'PAID') throw new Error(`lab: the demo payment for ${member.memberNo} is ${paid.status}, not PAID`);
    return paid;
  }

  /** Starting money through the real flows (seed.js START_PLAN), so every card equals its mirror. */
  async function runStartPlan() {
    const mark = events.lastSeq();
    let readbacks = 0;
    for (const step of START_PLAN) {
      const school = seedInfo.schools.find((s) => s.code === step.school);
      const member = school?.members.find((m) => m.memberNo === step.memberNo);
      if (!member) throw new Error(`lab: START_PLAN names ${step.school}/${step.memberNo}, which the seed does not have`);
      if (step.added) {
        paidTopup(school, member, step.added, 'added');
        const kiosk = [...terminals.values()].find((m) => m.schoolCode === school.code && m.deviceType === 'KIOSK');
        if (!kiosk) throw new Error(`lab: ${school.code} has no kiosk to add the starting money`);
        const result = await kiosk.tap(cards.get(`${school.code}/${member.cardUid}`));
        readbacks += 1;
        const addedSen = (result.added ?? []).filter((a) => a.confirmed).reduce((sum, a) => sum + a.amountSen, 0);
        if (!result.ok || addedSen !== step.added) {
          throw new Error(`lab: the kiosk did not add ${formatRM(step.added)} for ${member.memberNo}: ${result.reason ?? result.screen}`);
        }
      }
      if (step.waiting) paidTopup(school, member, step.waiting, 'waiting');
      if (step.subsidy) {
        services().topups.grantSubsidy({ schoolId: school.id, memberId: member.id, amountSen: step.subsidy, actor: 'seed', note: 'demo school subsidy' });
      }
    }
    // the broker acknowledges a read-back before the platform has it: let intake catch up
    await waitUntil(
      () => events.since(mark).filter((e) => e.type === 'intake.accepted' && e.data?.type === 'card.readback').length >= readbacks,
      5000,
    );
  }

  /** Sum of the card's kiosk writes whose orders the platform still holds as PAID or PARKED (not confirmed yet). */
  function unconfirmedOnCard(schoolId, memberId, writes) {
    const { topups } = services();
    let total = 0;
    for (const w of Array.isArray(writes) ? writes : []) {
      const order = topups.getOrder(schoolId, w?.orderId);
      if (order && order.memberId === memberId && (order.status === 'PAID' || order.status === 'PARKED') && order.amountSen === w.amountSen) {
        total += order.amountSen;
      }
    }
    return total;
  }

  /**
   * The books against the cards: every school's trial balance, and every ACTIVE card's chip
   * balance against its member's mirror (kiosk writes not confirmed yet left out). Copies and
   * cards whose security code no longer checks out (tampered) are listed but not compared.
   * Only meaningful once every record has reached the platform.
   * @returns {{ ok: boolean, schools: Array<{ code, balanced, totals, openDifferences,
   *   cards: Array<{ uid, member, cardSen, unconfirmedSen, mirrorSen, match }>, skipped: string[] }> }}
   */
  function checkBooks() {
    const { schools, ledger, differences } = services();
    let ok = true;
    const out = [];
    for (const school of schools.listSchools()) {
      const tb = ledger.trialBalance(school.id);
      const cardKey = schools.schoolCardKey(school.id);
      const rows = [];
      const skipped = [];
      for (const [key, card] of cards) {
        if (!key.startsWith(`${school.code}/`)) continue;
        const uid = key.slice(school.code.length + 1);
        if (copies.has(key)) {
          skipped.push(uid);
          continue;
        }
        const registered = schools.getCardByUid(school.id, card.uid);
        if (!registered || registered.status !== 'ACTIVE' || !registered.memberId) continue;
        let memory;
        try {
          memory = card.read(cardKey);
        } catch {
          skipped.push(uid); // tampered: its balance means nothing any more
          continue;
        }
        const mirrorSen = ledger.balance(school.id, 'STUDENT_WALLET', registered.memberId);
        const unconfirmedSen = unconfirmedOnCard(school.id, registered.memberId, memory.writes);
        const match = memory.balanceSen - unconfirmedSen === mirrorSen;
        if (!match) ok = false;
        const member = schools.getMember(school.id, registered.memberId);
        rows.push({ uid, member: member?.name ?? null, cardSen: memory.balanceSen, unconfirmedSen, mirrorSen, match });
      }
      if (!tb.balanced) ok = false;
      out.push({
        code: school.code,
        balanced: tb.balanced,
        totals: tb.totals,
        openDifferences: differences.countOpen(school.id),
        cards: rows,
        skipped,
      });
    }
    return { ok, schools: out };
  }

  // ---- life cycle ------------------------------------------------------------------------

  function startJobs() {
    if (config.jobsMs === 0 || jobsTimer) return;
    // untraced: each run of the timer is nobody's action
    jobsTimer = events.untraced(() =>
      setInterval(() => {
        if (phase !== 'running' || !serverUp) return; // nothing runs on a switched-off server
        try {
          platform.runJobs();
        } catch (err) {
          note('error', 'scheduled jobs failed', { error: err?.message });
        }
      }, config.jobsMs),
    );
    jobsTimer.unref?.();
  }

  function urls() {
    const out = { httpUrl, mqttUrl: `mqtt://${loopback}:${brokerPort}` };
    if (config.tls) out.mqttTlsUrl = `mqtts://${loopback}:${tlsPort}`;
    if (consoleServer) out.consoleAddress = `${loopback}:${consoleServer.port}`;
    return out;
  }

  async function teardown() {
    if (jobsTimer) clearInterval(jobsTimer);
    jobsTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    await Promise.allSettled([...background]);
    const closing = [];
    if (consoleServer) closing.push(consoleServer.close());
    consoleServer = null;
    await Promise.allSettled([...closing, ...[...terminals.values()].map((m) => m.stop())]);
    if (http) await http.close().catch((err) => note('error', 'the web server did not close cleanly', { error: err?.message }));
    http = null;
    await platform.disconnectMqtt().catch(() => {});
    await closeBroker('LAB_STOP').catch(() => {});
    serverUp = false;
    try {
      db.close();
    } catch {
      // already closed
    }
  }

  /**
   * Start everything: broker, platform link, web apps, consoles, every machine, card and admin
   * card, then the starting money through the real flows. Fails loudly (and closes what it
   * opened) if any part does not come up or the starting balances do not add up.
   * @returns {Promise<{ httpUrl: string, mqttUrl: string, mqttTlsUrl?: string, consoleAddress?: string }>}
   */
  function start() {
    // Untraced: the servers, clients and timers made here outlive any flow (DESIGN §11.1).
    return exclusive(() =>
      events.untraced(async () => {
        if (phase !== 'new') throw new LabError('LAB_ALREADY_STARTED', 'this lab was already started', 409);
        phase = 'starting';
        try {
          unsubscribe = events.subscribe(onPlatformEvent);
          seedInfo = seedDemo(platform);
          await openBroker('LAB_START');
          await platform.connectMqtt(broker.url);
          serverUp = true;
          emit('server.status', { up: true });
          // loaded here, so the lab's modules load (and the console tests run) on their own
          const { createHttpServer } = await import('../http/server.js');
          http = createHttpServer({ lab, labRoutes, ...(config.webRoot ? { webRoot: config.webRoot } : {}) });
          const listening = await http.listen(config.httpPort, config.host);
          httpUrl = `http://${loopback}:${listening.port}`;
          if (config.consolePort !== 0) consoleServer = await startConsoleServer(lab, { host: config.host, port: config.consolePort });
          await buildWorld();
          startJobs();
          phase = 'running';
          return urls();
        } catch (err) {
          phase = 'stopping';
          await teardown();
          tracer.close();
          phase = 'stopped';
          throw err;
        }
      }),
    );
  }

  /** Stop everything and close every port, client and timer. Nothing stays held. */
  function stop() {
    // released before waiting for the lock: nothing may wait for a Next that never comes
    backToRealtime();
    return exclusive(async () => {
      // and again: hold may have been switched on, and something held, while stop() waited
      backToRealtime();
      if (phase === 'stopped') return;
      if (phase === 'new') {
        phase = 'stopped';
        tracer.close();
        db.close();
        return;
      }
      phase = 'stopping';
      await teardown();
      tracer.close();
      phase = 'stopped';
    });
  }

  /**
   * Start the demo again from scratch, without closing the web apps or consoles: a fresh
   * database, clock and broker, the seed, every machine and card, the starting money. Back in
   * realtime with nothing held, and no traces (they were of the old demo).
   */
  function reset() {
    backToRealtime();
    return exclusive(() => events.untraced(() => resetNow()));
  }

  async function resetNow() {
    requireRunning();
    // again: hold may have been switched on, and something held, while reset() waited for the lab
    backToRealtime();
    phase = 'resetting';
    tracer.clear();
    try {
      await Promise.allSettled([...background]);
      await Promise.allSettled([...terminals.values()].map((m) => m.stop()));
      terminals.clear();
      cards.clear();
      copies.clear();
      adminCards.clear();
      lastResults.clear();
      await platform.disconnectMqtt();
      // a fresh broker too: no retained message of the old demo is left behind
      await closeBroker('LAB_RESET');
      dbRef.swap(openDb(':memory:')).close();
      clockRef.swap(createClock({ startAt: config.startAt, mode: config.clockMode }));
      seedInfo = seedDemo(platform);
      await openBroker('LAB_RESET');
      await platform.connectMqtt(broker.url);
      if (!serverUp) {
        serverUp = true;
        emit('server.status', { up: true });
      }
      await buildWorld();
      emit('lab.action', { action: 'reset' });
      return urls();
    } finally {
      phase = 'running';
    }
  }

  // ---- lookups for the actions ---------------------------------------------------------------

  function findMachine(schoolCode, deviceCode) {
    const key = machineKey(required(schoolCode, 'schoolCode'), required(deviceCode, 'deviceCode'));
    const machine = terminals.get(key);
    if (!machine) throw new LabError('MACHINE_NOT_FOUND', `there is no machine ${key} in the lab`, 404);
    return machine;
  }

  /**
   * A card in a school's tray. `preferSchool`: look there first, then in the one other tray
   * holding that UID (any card can be carried to any machine). `onlySchool`: that tray only.
   * @returns {{ key: string, uid: string, schoolCode: string, card: VirtualCard }}
   */
  function findCard({ onlySchool, preferSchool }, uid) {
    const { base, suffix } = parseTrayUid(uid);
    const id = `${base}${suffix}`;
    const own = onlySchool ?? preferSchool;
    if (own != null) {
      const school = required(own, 'schoolCode').toLowerCase();
      const card = cards.get(`${school}/${id}`);
      if (card) return { key: `${school}/${id}`, uid: id, schoolCode: school, card };
      if (onlySchool != null) throw new LabError('CARD_NOT_FOUND', `there is no card ${id} in the card tray of ${school}`, 404);
    }
    const matches = [...cards.keys()].filter((k) => k.endsWith(`/${id}`));
    if (matches.length !== 1) {
      throw new LabError('CARD_NOT_FOUND', matches.length ? `card ${id} is in more than one school's tray: name the school` : `there is no card ${id} in the lab`, 404);
    }
    return { key: matches[0], uid: id, schoolCode: matches[0].slice(0, matches[0].indexOf('/')), card: cards.get(matches[0]) };
  }

  function requireAdminCard(schoolCode) {
    const code = required(schoolCode, 'schoolCode').toLowerCase();
    const card = adminCards.get(code);
    if (!card) throw new LabError('ADMIN_CARD_NOT_FOUND', `school ${code} has no admin card in the lab`, 404);
    return card;
  }

  function schoolKiosk(schoolCode, deviceCode) {
    if (deviceCode != null && deviceCode !== '') {
      const machine = findMachine(schoolCode, deviceCode);
      if (machine.deviceType !== 'KIOSK') throw new LabError('WRONG_MACHINE_TYPE', 'the admin card is loaded and emptied at a kiosk', 400);
      return machine;
    }
    const code = required(schoolCode, 'schoolCode').toLowerCase();
    const kiosk = [...terminals.values()].find((m) => m.schoolCode === code && m.deviceType === 'KIOSK');
    if (!kiosk) throw new LabError('MACHINE_NOT_FOUND', `school ${code} has no kiosk`, 404);
    return kiosk;
  }

  function cardSummary(found) {
    return { uid: found.uid, school: found.schoolCode, balanceSen: found.card.balanceSen, cardSeq: found.card.cardSeq };
  }

  function adminCardSummary(schoolCode) {
    const card = adminCards.get(schoolCode);
    if (!card) return null;
    const m = card.memory;
    return {
      school: m.school,
      token: m.token,
      loadedAt: m.loadedAt,
      packs: m.packs.map((p) => ({ kind: p.kind, version: p.version })),
      receipts: m.receipts,
    };
  }

  /** What a machine's last action came to; the screen never says why, the lab may. */
  function remember(machine, action, result) {
    // a flow of a machine a reset has taken away (let go by the reset) ends in the old demo
    if (terminals.get(machineKey(machine.schoolCode, machine.deviceCode)) !== machine) return;
    const entry = { action, ok: Boolean(result?.ok), at: clock.iso() };
    if (result?.reason) entry.reason = result.reason;
    if (result?.error) entry.error = result.error;
    if (result?.screen) entry.screen = result.screen;
    lastResults.set(machineKey(machine.schoolCode, machine.deviceCode), entry);
  }

  function machineView(machine) {
    const { devices } = services();
    const s = machine.state;
    const school = services().schools.getSchoolByCode(machine.schoolCode);
    const d = school ? devices.getDeviceByCode(school.id, machine.deviceCode) : null;
    const prices = machine.config.prices;
    return {
      ...s,
      // the machine's own price list (an offline one may run an old version): what a tap can choose from
      prices: prices.content ? { version: prices.version, items: prices.content.items, water: prices.content.water } : null,
      location: d?.location ?? '',
      deviceStatus: d?.status ?? null,
      online: d?.online ?? false,
      lastHeartbeatAt: d?.lastHeartbeatAt ?? null,
      lastResult: lastResults.get(machineKey(machine.schoolCode, machine.deviceCode)) ?? null,
    };
  }

  // ---- actions ---------------------------------------------------------------------------
  //
  // Each action first checks what it was given (a request that never started leaves no
  // trace), then runs in a trace of its own (act()). The *Now functions do the work, so one
  // action can use another inside its own trace (a cross-school card is a tap, a server fault
  // switches the server) without starting a second one.

  const keyOf = (machine) => machineKey(machine.schoolCode, machine.deviceCode);
  const traceOf = (machine) => ({ school: machine.schoolCode, device: machine.deviceCode });
  /** What a machine's flow is about (DESIGN §11.7): the machine, and more for some kinds. */
  const machineSubject = (machine, more = {}) => ({ school: machine.schoolCode, device: machine.deviceCode, ...more });
  /** What a machine action held at a hop answers early: the machine as it is now. */
  const machinePartial = (machine) => () => ({ machine: machineView(machine) });

  /** Check a tap: the machine, the card, what is bought or poured, the kiosk fault. */
  function prepareTap(args) {
    const { schoolCode, deviceCode, uid, items, ml, fault, cardSchoolCode } = args ?? {};
    const machine = findMachine(schoolCode, deviceCode);
    const found = cardSchoolCode != null ? findCard({ onlySchool: cardSchoolCode }, uid) : findCard({ preferSchool: machine.schoolCode }, uid);
    if (fault != null && machine.deviceType !== 'KIOSK') {
      throw new LabError('FAULT_INVALID', 'power cuts and lost confirmations are kiosk faults: tap the card on a kiosk', 400);
    }
    if (fault != null && !KIOSK_TAP_FAULTS.includes(fault)) {
      throw new LabError('FAULT_INVALID', `fault must be one of ${KIOSK_TAP_FAULTS.join(', ')}`, 400);
    }
    let order = {};
    if (machine.deviceType === 'CANTEEN') order = { items: parseItems(items) };
    else if (machine.deviceType === 'WATER') order = { ml: parseMl(ml) };
    else if (fault != null) order = { fault };
    return { machine, found, order, fault: fault ?? null };
  }

  /** The tap itself, in the caller's trace. */
  async function tapNow({ machine, found, order, fault }) {
    const result = await machine.tap(found.card, order);
    remember(machine, fault ? `tap (${fault})` : 'tap', result);
    const data = { action: 'tap', device: machine.deviceCode, uid: found.uid, ok: result.ok, screen: result.screen };
    if (found.schoolCode !== machine.schoolCode) data.cardSchool = found.schoolCode;
    if (result.reason) data.reason = result.reason;
    if (fault) data.fault = fault;
    emit('lab.action', data, machine.schoolCode);
    return { ...result, machine: keyOf(machine), card: cardSummary(found) };
  }

  /**
   * What the machine has shown in this flow so far (null: nothing yet). Its last screen may be
   * an earlier visitor's: a kiosk shows nothing until the end of a visit.
   */
  function screenOf(trace) {
    const shown = (tracer.get(trace)?.events ?? []).filter((e) => e.type === 'device.screen');
    return shown.at(-1)?.data?.text ?? null;
  }

  /** A tap held at a hop: what the machine has shown in this flow, and the card as it is now. */
  const tapPartial = ({ machine, found }) => (item) => ({ machine: keyOf(machine), screen: screenOf(item.trace), card: cardSummary(found) });

  /** What a tap's flow is about: the card (and its school), the machine, what is bought or poured, a kiosk fault. */
  function tapSubject({ machine, found, order, fault }) {
    const subject = { uid: found.uid, cardSchool: found.schoolCode, ...machineSubject(machine) };
    if (order.items) subject.items = itemsText(order.items);
    if (order.ml !== undefined) subject.ml = order.ml;
    if (fault) subject.fault = fault;
    return subject;
  }

  function tapTitle({ machine, found, order, fault }) {
    if (fault) return `Fault: ${KIOSK_FAULT_TITLES[fault]}, tap ${found.uid} on ${keyOf(machine)}`;
    if (order.ml !== undefined) return `Tap ${found.uid} on ${keyOf(machine)} for ${order.ml} ml`;
    return `Tap ${found.uid} on ${keyOf(machine)}`;
  }

  /**
   * Tap a card on a machine: a canteen sale (`items`), a pour (`ml`) or a kiosk visit (`fault`
   * optional). The card comes from the machine's school's tray, or from `cardSchoolCode`'s.
   * @returns {Promise<object>} the machine's answer plus `machine` and `card` (balance after);
   *   held at a hop: `{ held: true, trace, item, machine, screen, card }`
   */
  async function tap(args = {}) {
    requireRunning();
    const prepared = prepareTap(args);
    const { machine, fault } = prepared;
    const meta = { kind: fault ? 'fault' : 'tap', title: tapTitle(prepared), ...traceOf(machine), subject: tapSubject(prepared) };
    return act(meta, () => tapNow(prepared), {
      partial: tapPartial(prepared),
      action: fault ? { action: 'tap', device: machine.deviceCode, fault } : { action: 'tap', device: machine.deviceCode },
    });
  }

  /** Plug or pull a machine's network cable. */
  async function setCable(args = {}) {
    requireRunning();
    const { schoolCode, deviceCode, plugged } = args ?? {};
    if (typeof plugged !== 'boolean') throw new LabError('INPUT_INVALID', 'plugged must be true or false', 400);
    const machine = findMachine(schoolCode, deviceCode);
    const title = plugged ? `Plug in the cable of ${keyOf(machine)}` : `Pull the cable of ${keyOf(machine)}`;
    // a plug's first heartbeat and upload belong to this trace (the machine keeps it, DESIGN §11.3)
    return act(
      { kind: 'cable', title, ...traceOf(machine), subject: machineSubject(machine, { plugged }) },
      async () => {
        await machine.setCable(plugged);
        return { machine: machineView(machine) };
      },
      { partial: machinePartial(machine) },
    );
  }

  /** An admin-card action held at a hop: what the machine has shown in this flow, and the admin card as it is now. */
  const adminCardPartial = (card, machine) => (item) => ({
    machine: keyOf(machine),
    screen: screenOf(item.trace),
    adminCard: adminCardSummary(card.schoolCode),
  });

  async function adminCardUploadNow(card, kiosk) {
    const result = await kiosk.uploadAdminCardReceipts(card);
    remember(kiosk, 'admin-card upload', result);
    return { ...result, machine: keyOf(kiosk), adminCard: adminCardSummary(card.schoolCode) };
  }

  /** Load the school's admin card at its kiosk (the newest packs and a fresh token). */
  async function adminCardLoad(args = {}) {
    requireRunning();
    const { schoolCode, deviceCode } = args ?? {};
    const card = requireAdminCard(schoolCode);
    const kiosk = schoolKiosk(card.schoolCode, deviceCode);
    return act(
      {
        kind: 'admin-card',
        title: `Load the admin card of ${card.schoolCode} at ${keyOf(kiosk)}`,
        ...traceOf(kiosk),
        subject: machineSubject(kiosk, { op: 'load' }),
      },
      async () => {
        const result = await kiosk.loadAdminCard(card);
        remember(kiosk, 'admin-card load', result);
        return { ...result, machine: keyOf(kiosk), adminCard: adminCardSummary(card.schoolCode) };
      },
      { partial: adminCardPartial(card, kiosk), action: { action: 'admin-card load', device: kiosk.deviceCode } },
    );
  }

  /** Hand the admin card's receipts over at the kiosk, which uploads them. */
  async function adminCardUpload(args = {}) {
    requireRunning();
    const { schoolCode, deviceCode } = args ?? {};
    const card = requireAdminCard(schoolCode);
    const kiosk = schoolKiosk(card.schoolCode, deviceCode);
    return act(
      {
        kind: 'admin-card',
        title: `Upload the admin card receipts of ${card.schoolCode} at ${keyOf(kiosk)}`,
        ...traceOf(kiosk),
        subject: machineSubject(kiosk, { op: 'upload' }),
      },
      () => adminCardUploadNow(card, kiosk),
      { partial: adminCardPartial(card, kiosk), action: { action: 'admin-card upload', device: kiosk.deviceCode } },
    );
  }

  /** Tap the admin card on a reader or water machine; at a kiosk the tap hands over the receipts. */
  async function adminCardTap(args = {}) {
    requireRunning();
    const { schoolCode, deviceCode } = args ?? {};
    const card = requireAdminCard(schoolCode);
    const machine = findMachine(card.schoolCode, deviceCode);
    const meta = {
      kind: 'admin-card',
      title: `Tap the admin card of ${card.schoolCode} on ${keyOf(machine)}`,
      ...traceOf(machine),
      subject: machineSubject(machine, { op: 'tap' }),
    };
    if (machine.deviceType === 'KIOSK') {
      return act(meta, () => adminCardUploadNow(card, machine), {
        partial: adminCardPartial(card, machine),
        action: { action: 'admin-card upload', device: machine.deviceCode },
      });
    }
    return act(meta, () => {
      const { results } = machine.tapAdminCard(card);
      const screen = machine.state.lastScreen?.text ?? '';
      const answer = { ok: true, screen, results };
      remember(machine, 'admin-card tap', answer);
      return { ...answer, machine: keyOf(machine), adminCard: adminCardSummary(card.schoolCode) };
    });
  }

  /** The machine's whole journal as its signed USB export file (to import in the school office). */
  function exportUsb(args = {}) {
    requireRunning();
    const { schoolCode, deviceCode } = args ?? {};
    const machine = findMachine(schoolCode, deviceCode);
    // the answer is the file itself: no trace field in it
    return act(
      { kind: 'usb', title: `Export the journal of ${keyOf(machine)} to USB`, ...traceOf(machine), subject: machineSubject(machine) },
      () => {
        const file = machine.exportJournal();
        emit('lab.action', { action: 'usb.export', device: machine.deviceCode, count: file.count }, machine.schoolCode);
        return file;
      },
      { tag: false },
    );
  }

  /** Send a heartbeat now. @returns {Promise<{ sent: boolean, machine: object }>} */
  async function heartbeat(args = {}) {
    requireRunning();
    const machine = findMachine(args?.schoolCode, args?.deviceCode);
    return act(
      { kind: 'heartbeat', title: `Heartbeat now from ${keyOf(machine)}`, ...traceOf(machine), subject: machineSubject(machine) },
      async () => {
        const sent = await machine.heartbeat();
        return { sent, machine: machineView(machine) };
      },
      { partial: machinePartial(machine) },
    );
  }

  /** Upload every unsent journal record now. */
  async function upload(args = {}) {
    requireRunning();
    const machine = findMachine(args?.schoolCode, args?.deviceCode);
    return act(
      { kind: 'upload', title: `Upload the unsent records of ${keyOf(machine)}`, ...traceOf(machine), subject: machineSubject(machine) },
      async () => {
        const connected = machine.connected;
        const outcome = await machine.flushJournal();
        return { connected, ...outcome, machine: machineView(machine) };
      },
      { partial: machinePartial(machine) },
    );
  }

  /** Switch a machine off and on again; its counters and journal survive (DESIGN §6). */
  async function reboot(args = {}) {
    requireRunning();
    const machine = findMachine(args?.schoolCode, args?.deviceCode);
    return act(
      { kind: 'reboot', title: `Reboot ${keyOf(machine)}`, ...traceOf(machine), subject: machineSubject(machine) },
      async () => {
        await machine.stop();
        machine.screen('Starting…', 'info');
        // its first heartbeat and upload after the restart belong to the reboot (DESIGN §11.3)
        if (machine.cablePlugged) machine.traceNextConnect();
        await machine.start();
        machine.screen('Ready', 'info');
        emit('lab.action', { action: 'reboot', device: machine.deviceCode }, machine.schoolCode);
        return { machine: machineView(machine) };
      },
      { partial: machinePartial(machine), action: { action: 'reboot', device: machine.deviceCode } },
    );
  }

  /** Move the lab clock forward; connected machines report in and the jobs run (if the server is on). */
  async function advanceClock(ms) {
    requireRunning();
    const step = typeof ms === 'string' && /^\d+$/.test(ms.trim()) ? Number(ms) : ms;
    if (!Number.isSafeInteger(step) || step < 1 || step > MAX_CLOCK_STEP_MS) {
      throw new LabError('INPUT_INVALID', 'ms must be a whole number of milliseconds, up to 400 days', 400);
    }
    return act({ kind: 'clock', title: `Move the lab clock forward ${durationText(step)}`, subject: { ms: step } }, () => advanceClockNow(step), {
      partial: () => ({ clock: clockView() }),
    });
  }

  async function advanceClockNow(step) {
    clock.advance(step);
    emit('lab.clock', { advancedMs: step, now: clock.iso(), kl: formatKL(clock.now()) });
    // machines would have sent heartbeats all along; one now keeps them "online" at the new time
    const mark = events.lastSeq();
    const connected = [...terminals.values()].filter((m) => m.connected);
    const sent = await Promise.all(connected.map((m) => m.heartbeat().catch(() => false)));
    const reporting = connected.filter((m, i) => sent[i]);
    // the broker acknowledges a heartbeat before the platform has it: wait (briefly) for intake
    await waitUntil(() => {
      const heard = new Set(
        events.since(mark).filter((e) => e.type.startsWith('intake.') && e.data?.type === 'device.heartbeat').map((e) => `${e.school}/${e.data.device}`),
      );
      return reporting.every((m) => heard.has(`${m.schoolCode}/${m.deviceCode}`));
    }, 2000);
    const jobs = serverUp ? platform.runJobs() : null;
    return { clock: clockView(), jobs };
  }

  /** The scheduled jobs, now (top-up deadlines and reconciliation of every ACTIVE school). */
  function runJobs() {
    requireRunning();
    if (!serverUp) throw new LabError('SERVER_DOWN', 'the cloud server is switched off: nothing runs on it', 409);
    return act({ kind: 'jobs', title: 'Run the scheduled jobs now', subject: {} }, () => {
      const result = platform.runJobs();
      const { cancelled, refunded, parked, gaps, lag } = result;
      emit('lab.action', { action: 'jobs', cancelled, refunded, parked, gaps, lag });
      return result;
    });
  }

  /** A server or broker action held at a hop (a plugged machine's first heartbeat): the server as it is now. */
  const serverPartial = () => ({ server: { up: serverUp }, broker: brokerStatus() });

  /** Every plugged machine's next post-connect routine belongs to the current flow (DESIGN §11.3). */
  function traceNextConnects() {
    for (const m of terminals.values()) if (m.cablePlugged) m.traceNextConnect();
  }

  /**
   * Take the broker down, then the platform's link. In this order the broker never takes a
   * message it cannot deliver: with the platform gone first, it would still acknowledge a
   * machine's record (which then counts it as sent) and queue it for the platform's session,
   * a queue that dies with the broker. The platform stays on until the broker has closed, so
   * it receives what the broker acknowledged (passed on before it closes, see broker.js).
   */
  async function closeBrokerAndLink(code) {
    try {
      await closeBroker(code);
    } finally {
      await platform.disconnectMqtt();
    }
  }

  /**
   * Run `fn`, which opens or closes the broker, with the logins and logouts that causes in the
   * current flow: the platform's, and every machine's that has no flow of its own (contextFor).
   */
  async function inBrokerFlow(fn) {
    brokerFlow = currentFlow();
    try {
      return await fn();
    } finally {
      brokerFlow = null;
    }
  }

  /** The server switch itself, in the caller's trace. */
  function switchServer(up) {
    return exclusive(async () => {
      requireRunning();
      const changed = up !== serverUp;
      if (changed && !up) {
        serverUp = false;
        emit('server.status', { up: false });
        await inBrokerFlow(() => closeBrokerAndLink('SERVER_OFF'));
      } else if (changed) {
        // messages that waited at the platform's door while it was off: they go on once it is back
        const parked = held.filter((e) => e.item.where === 'platform');
        traceNextConnects();
        await inBrokerFlow(async () => {
          await openBroker('SERVER_ON');
          // inside this trace: the platform's first subscribe and republish belong to it
          await platform.connectMqtt(broker.url);
        });
        serverUp = true;
        emit('server.status', { up: true });
        for (const entry of parked) letGo(entry);
        // Hold may have gone off while the server came up. What reached the platform's door
        // meanwhile could not go on then (the server was not on yet); it goes on now.
        if (!holding()) releaseReleasable();
      }
      emit('lab.action', { action: up ? 'server-up' : 'server-down', changed });
      return { changed, server: { up: serverUp }, broker: brokerStatus() };
    });
  }

  /**
   * Switch the whole virtual cloud server off or on (DESIGN §2). Off: the broker stops, the
   * platform leaves it and the product APIs answer 503; machines keep working offline.
   * On: a broker on the same port, the platform back on it (republishing every retained
   * setting); plugged machines reconnect by themselves and upload what they kept. Messages
   * held at the platform's inbox while it was off go on as soon as it is back.
   */
  function setServer(args = {}) {
    const { up } = args ?? {};
    if (typeof up !== 'boolean') return Promise.reject(new LabError('INPUT_INVALID', 'up must be true or false', 400));
    const meta = { kind: 'server', title: up ? 'Switch the cloud server on' : 'Switch the cloud server off', subject: { up } };
    return act(meta, () => switchServer(up), {
      partial: serverPartial,
      action: { action: up ? 'server-up' : 'server-down' },
    });
  }

  function restartBrokerNow() {
    return exclusive(async () => {
      requireRunning();
      requireServerUp();
      await inBrokerFlow(async () => {
        await closeBrokerAndLink('RESTARTING');
        traceNextConnects();
        await openBroker('RESTARTED');
        await platform.connectMqtt(broker.url);
      });
      emit('lab.action', { action: 'broker-restart' });
      return { platformReconnected: platform.mqttStatus().subscribed, broker: brokerStatus() };
    });
  }

  /**
   * Restart only the broker: its retained messages are lost, and the platform, back on the new
   * broker, publishes them again. The old broker goes first (it must not acknowledge what it
   * can no longer deliver); the platform leaves it and reconnects at once (not on its own retry
   * a second later), so no machine uploads to a broker nobody listens on.
   */
  function restartBroker() {
    return act({ kind: 'broker', title: 'Restart the MQTT broker', subject: {} }, () => restartBrokerNow(), {
      partial: serverPartial,
      action: { action: 'broker-restart' },
    });
  }

  // ---- faults ----------------------------------------------------------------------------

  /**
   * Run a fault in its own trace (kind fault, "Fault: <what>"). Its subject (DESIGN §11.7) names
   * the fault and what it works on: the school and machine of `where`, plus `about` (uid,
   * toSchool, toDevice; a tap that is a fault brings the whole tap subject).
   */
  function faultAct(type, what, where, fn, partial, about = {}) {
    const { school = null, device = null } = where ?? {};
    const subject = { fault: type };
    if (school) subject.school = school;
    if (device) subject.device = device;
    return act({ kind: 'fault', title: `Fault: ${what}`, school, device, subject: { ...subject, ...about } }, fn, {
      // the held item goes through: a tap's partial reads the flow's screen from it
      partial: (item) => ({ fault: type, ...(partial ? partial(item) : {}) }),
      action: device ? { action: 'fault', type, device } : { action: 'fault', type },
    });
  }

  function cloneCard({ schoolCode, uid } = {}) {
    const found = findCard({ preferSchool: schoolCode }, uid);
    return faultAct('clone-card', `copy card ${found.uid} of ${found.schoolCode}`, { school: found.schoolCode }, () => {
      const base = found.uid.replace(COPY_SUFFIX_RE, '$1');
      let n = 1;
      const copyId = (i) => `${base}-copy${i === 1 ? '' : i}`;
      while (cards.has(`${found.schoolCode}/${copyId(n)}`)) n += 1;
      const id = copyId(n);
      const key = `${found.schoolCode}/${id}`;
      cards.set(key, found.card.clone());
      copies.set(key, found.key);
      emit('lab.action', { action: 'fault', type: 'clone-card', uid: found.uid, copy: id }, found.schoolCode);
      return {
        fault: 'clone-card',
        ok: true,
        uid: id,
        copyOf: found.uid,
        card: cardSummary({ ...found, uid: id, card: cards.get(key) }),
        summary: `Card ${found.uid} copied byte for byte as ${id}: same balance ${formatRM(found.card.balanceSen)}, same counter ` +
          `${found.card.cardSeq}, valid security code. Spend on both and the platform finds two purchases with one card counter.`,
      };
    }, undefined, { uid: found.uid });
  }

  function tamperCard({ schoolCode, uid, balanceSen } = {}) {
    const found = findCard({ preferSchool: schoolCode }, uid);
    const target = balanceSen ?? found.card.balanceSen + 10_000;
    if (!isSen(target)) throw new LabError('INPUT_INVALID', 'balanceSen must be whole sen, 0 or more', 400);
    return faultAct('tamper-card', `edit card ${found.uid} of ${found.schoolCode} by hand`, { school: found.schoolCode }, () => {
      found.card.tamper({ balanceSen: target });
      emit('lab.action', { action: 'fault', type: 'tamper-card', uid: found.uid, balanceSen: target }, found.schoolCode);
      return {
        fault: 'tamper-card',
        ok: true,
        uid: found.uid,
        card: cardSummary(found),
        summary: `Card ${found.uid} edited by hand to show ${formatRM(target)}. Its security code no longer matches, ` +
          'so every machine refuses it (Card unavailable).',
      };
    }, undefined, { uid: found.uid });
  }

  function requireConnected(machine) {
    if (!machine.connected) {
      throw new LabError('MACHINE_OFFLINE', `${machine.schoolCode}/${machine.deviceCode} is not connected to the broker: plug its cable in first`, 409);
    }
  }

  /** A machine fault held at a hop: which machine. */
  const faultMachine = (machine) => () => ({ machine: keyOf(machine) });

  async function duplicateUpload({ schoolCode, deviceCode } = {}) {
    const machine = findMachine(schoolCode, deviceCode);
    const [last] = machine.journal({ limit: 1 });
    if (!last) throw new LabError('NOTHING_TO_SEND', `${machine.deviceCode} has no record to send again`, 409);
    requireConnected(machine);
    const { record } = last;
    return faultAct('duplicate-upload', `duplicate upload from ${keyOf(machine)}`, traceOf(machine), async () => {
      const mark = events.lastSeq();
      const sent = await machine.publishUp(record.kind === 'WATER' ? 'water.recorded' : 'sale.recorded', { record }, { txn: record.txn });
      if (!sent) throw new LabError('MACHINE_OFFLINE', 'the broker did not take the message: the machine lost its connection', 409);
      const verdict = await nextEvent(
        (e) => e.type === 'purchase.received' && e.school === machine.schoolCode && e.data?.txn === record.txn,
        mark,
      );
      const status = verdict?.data?.status ?? null;
      emit('lab.action', { action: 'fault', type: 'duplicate-upload', device: machine.deviceCode, txn: record.txn, platform: status }, machine.schoolCode);
      return {
        fault: 'duplicate-upload',
        ok: status === 'DUPLICATE',
        txn: record.txn,
        platform: verdict ? { status, code: verdict.data.code ?? null } : null,
        summary: status === 'DUPLICATE'
          ? `Record ${record.txn} sent again in a new message: the platform answered DUPLICATE, so it still counts once.`
          : `Record ${record.txn} sent again: the platform answered ${status ?? 'nothing yet'}.`,
      };
    }, faultMachine(machine));
  }

  /** The platform's refusal of a message of this type from this machine (the machine's own traffic goes on meanwhile). */
  function refusalOf(machine, type, mark, code) {
    return nextEvent(
      (e) => e.type === 'intake.refused' && e.school === machine.schoolCode && e.data?.device === machine.deviceCode &&
        e.data?.type === type && (code === undefined || e.data?.code === code),
      mark,
    );
  }

  async function sequenceRollback({ schoolCode, deviceCode } = {}) {
    const machine = findMachine(schoolCode, deviceCode);
    requireConnected(machine);
    const found = services().devices.resolveByCodes(machine.schoolCode, machine.deviceCode);
    const lastSeq = found?.device.lastSeq ?? 0;
    if (lastSeq < 1) throw new LabError('NOTHING_TO_ROLL_BACK', 'the platform has not accepted a message from this machine yet', 409);
    return faultAct('sequence-rollback', `sequence rollback on ${keyOf(machine)}`, traceOf(machine), async () => {
      // properly signed and new, but numbered behind what the platform already accepted (a replayed or restored machine)
      const seq = Math.max(1, lastSeq - 1);
      const s = machine.state;
      const envelope = signEnvelope(
        found.secret,
        buildEnvelope({
          school: machine.schoolCode,
          device: machine.deviceCode,
          seq,
          at: clock.iso(),
          type: 'device.heartbeat',
          body: { fw: FIRMWARE_VERSION, health: 'OK', listVersions: s.versions, journalUnsent: s.journal.unsent },
        }),
      );
      const mark = events.lastSeq();
      if (!(await machine.publishEnvelope(envelope))) throw new LabError('MACHINE_OFFLINE', 'the broker did not take the message', 409);
      const verdict = await refusalOf(machine, 'device.heartbeat', mark, 'SEQUENCE_ROLLBACK');
      emit('lab.action', { action: 'fault', type: 'sequence-rollback', device: machine.deviceCode, seq, lastSeq }, machine.schoolCode);
      return {
        fault: 'sequence-rollback',
        ok: Boolean(verdict),
        seq,
        lastSeq,
        platform: verdict ? { result: 'REFUSED', code: 'SEQUENCE_ROLLBACK' } : null,
        summary: verdict
          ? `A signed message with seq ${seq} (the platform had already accepted ${lastSeq}) was refused with SEQUENCE_ROLLBACK; ` +
            'see the device log in the school office.'
          : 'The message was sent, but the platform has not answered yet.',
      };
    }, faultMachine(machine));
  }

  async function forgedMessage({ schoolCode, deviceCode } = {}) {
    const machine = findMachine(schoolCode, deviceCode);
    requireConnected(machine);
    return faultAct('forged-message', `forged message as ${keyOf(machine)}`, traceOf(machine), async () => {
      const found = services().devices.resolveByCodes(machine.schoolCode, machine.deviceCode);
      const at = clock.iso();
      const record = (kind) => ({
        txn: `${machine.deviceCode}-999999`,
        origin: machine.deviceCode,
        kind,
        card: '0'.repeat(64),
        last4: '0000',
        cardSeq: 1,
        amountSen: kind === 'SALE' ? 5000 : 100,
        ...(kind === 'SALE' ? { items: [{ code: 'NASI-LEMAK', qty: 1, priceSen: 5000 }] } : { ml: 5000, perLitreSen: 20 }),
        priceVersion: 1,
        listVersion: 1,
        balanceBeforeSen: 5000,
        balanceAfterSen: kind === 'SALE' ? 0 : 4900,
        at,
        currency: 'MYR',
      });
      const [type, body] =
        machine.deviceType === 'CANTEEN' ? ['sale.recorded', { record: record('SALE') }]
          : machine.deviceType === 'WATER' ? ['water.recorded', { record: record('WATER') }]
            : ['device.heartbeat', { fw: FIRMWARE_VERSION, health: 'OK', listVersions: machine.state.versions, journalUnsent: 0 }];
      // signed with a key that is not the machine's: someone without its secret
      const envelope = signEnvelope(
        randomSecret(),
        buildEnvelope({ school: machine.schoolCode, device: machine.deviceCode, seq: (found?.device.lastSeq ?? 0) + 1, at, type, txn: body.record?.txn, body }),
      );
      const mark = events.lastSeq();
      if (!(await machine.publishEnvelope(envelope))) throw new LabError('MACHINE_OFFLINE', 'the broker did not take the message', 409);
      const verdict = await refusalOf(machine, type, mark);
      const code = verdict?.data?.code ?? null;
      emit('lab.action', { action: 'fault', type: 'forged-message', device: machine.deviceCode, messageType: type, platform: code }, machine.schoolCode);
      return {
        fault: 'forged-message',
        ok: code === 'SIGNATURE_INVALID',
        messageType: type,
        platform: verdict ? { result: 'REFUSED', code } : null,
        summary: code === 'SIGNATURE_INVALID'
          ? `A ${type} not signed with the machine's secret was refused with SIGNATURE_INVALID; see the device log in the school office.`
          : `A forged ${type} was sent; the platform ${code ? `refused it with ${code}` : 'has not refused it'}.`,
      };
    }, faultMachine(machine));
  }

  /**
   * Log in as one machine with a separate, throwaway client (its real login, as a copied
   * machine would) and publish once on another machine's topic. The broker requires the
   * client id to be the username, so this login takes over the real machine's session, which
   * comes back by itself about a second later. QoS 0 and no reconnect: mqtt.js would resend a
   * QoS 1 publish forever. Never the machine's own client.
   */
  async function crossDevicePublish({ schoolCode, deviceCode, toSchoolCode, toDeviceCode } = {}) {
    requireServerUp();
    const machine = findMachine(schoolCode, deviceCode);
    const { devices, schools } = services();
    const from = devices.resolveByCodes(machine.schoolCode, machine.deviceCode);
    const targetSchool = (toSchoolCode ?? machine.schoolCode).trim().toLowerCase();
    const school = schools.getSchoolByCode(targetSchool);
    if (!school) throw new LabError('SCHOOL_NOT_FOUND', `there is no school ${targetSchool}`, 404);
    const others = devices.listDevices(school.id).map((d) => d.code);
    let targetDevice = toDeviceCode ? String(toDeviceCode).trim().toUpperCase() : null;
    if (!targetDevice) {
      targetDevice = targetSchool !== machine.schoolCode && others.includes(machine.deviceCode)
        ? machine.deviceCode
        : others.find((c) => targetSchool !== machine.schoolCode || c !== machine.deviceCode) ?? null;
    }
    if (!targetDevice || (targetSchool === machine.schoolCode && targetDevice === machine.deviceCode)) {
      throw new LabError('INPUT_INVALID', 'name another machine to publish to (toDeviceCode, toSchoolCode)', 400);
    }
    const what = `${keyOf(machine)} publishes on the topic of ${targetSchool}/${targetDevice}`;
    // toDeviceCode is taken as given (whatever it is, the broker refuses the publish); the
    // subject cuts it to fit (subjectText)
    return faultAct('cross-device-publish', what, traceOf(machine), async () => {
      const username = `${machine.schoolCode}.${machine.deviceCode}`;
      const topic = topicFor(targetSchool, targetDevice, 'records');
      const wasConnected = machine.connected;
      const envelope = signEnvelope(
        from.secret,
        buildEnvelope({
          school: targetSchool,
          device: targetDevice,
          seq: 1,
          at: clock.iso(),
          type: 'device.heartbeat',
          body: { fw: FIRMWARE_VERSION, health: 'OK', listVersions: {}, journalUnsent: 0 },
        }),
      );
      const payload = JSON.stringify(envelope);
      // the copied login's send, announced in this fault's flow as a machine announces its own:
      // the broker's refusal names the message (mqtt.denied msgId) and joins the flow by it
      const sending = {
        device: machine.deviceCode,
        msgId: envelope.id,
        type: envelope.type,
        seq: envelope.seq,
        topic,
        bytes: Buffer.byteLength(payload),
        copiedLogin: true, // not the machine's own client (DESIGN §11.7)
      };
      const flow = events.context()?.trace ?? null;
      const mark = events.lastSeq();
      const loginsSinceMark = () => events.since(mark).filter((e) => e.type === 'mqtt.connect' && e.data?.username === username).length;
      // While the fault runs, the broker's logins, logouts and refusals of this username are in its
      // flow (contextFor): the copied login, the real machine knocked off, the refused publish, the
      // copied login leaving and the real machine coming back.
      if (flow) loginFlows.set(username, flow);
      let throwaway;
      let denied = null;
      let delivered = false;
      let offlineMs = null;
      try {
        throwaway = await new Promise((resolve) => {
          const outcome = { loggedIn: false, published: false, closedByBroker: false, error: null, loggedInAt: null };
          const client = mqtt.connect(broker.url, {
            clientId: username,
            username,
            password: brokerPassword(from.secret),
            clean: true,
            reconnectPeriod: 0,
            connectTimeout: 3000,
          });
          let timer = null;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            client.end(true, () => resolve(outcome));
          };
          client.on('error', (err) => {
            outcome.error = err?.code ?? err?.message ?? 'error';
          });
          client.on('connect', () => {
            outcome.loggedIn = true;
            outcome.loggedInAt = Date.now();
            // Taking over a session, the broker answers the login before it reports it (mqtt.connect):
            // the publish waits for that report, so the flow reads login, send, refusal.
            waitUntil(() => loginsSinceMark() >= 1, 1000).then(() => {
              if (done) return;
              if (flow) emitInTrace(flow, 'device.send', sending, machine.schoolCode);
              else emit('device.send', sending, machine.schoolCode);
              client.publish(topic, payload, { qos: 0 });
              outcome.published = true;
              timer = setTimeout(finish, THROWAWAY_WAIT_MS);
              timer.unref?.();
            });
          });
          client.on('close', () => {
            if (outcome.loggedIn) outcome.closedByBroker = true;
            finish();
          });
        });
        denied = throwaway.published
          ? await nextEvent((e) => e.type === 'mqtt.denied' && e.data?.action === 'publish' && e.data?.username === username && e.data?.topic === topic, mark, 1000)
          : null;
        delivered = events.since(mark).some((e) => e.type === 'mqtt.publish' && e.data?.from === username && e.data?.topic === topic);
        if (throwaway.loggedIn && wasConnected && machine.cablePlugged) {
          const back = await waitUntil(() => machine.connected, RECONNECT_WAIT_MS);
          offlineMs = back ? Date.now() - throwaway.loggedInAt : null;
          // the broker may report the machine's login a moment after the machine has its answer
          if (back) await waitUntil(() => loginsSinceMark() >= 2, 1000);
        }
      } finally {
        if (flow && loginFlows.get(username) === flow) loginFlows.delete(username);
      }
      const ok = Boolean(denied) && !delivered;
      emit('lab.action', { action: 'fault', type: 'cross-device-publish', device: machine.deviceCode, topic, refused: Boolean(denied) }, machine.schoolCode);
      let summary;
      if (!throwaway.loggedIn) {
        summary = `The broker refused the login of ${username} (${throwaway.error ?? 'connection closed'}): nothing was published.`;
      } else if (ok) {
        summary = `Logged in as ${username} and published to ${topic}: the broker refused the publish and closed that ` +
          'connection; nothing reached the platform.' +
          (offlineMs !== null ? ` The copied login knocked the real ${machine.deviceCode} off the broker for about ${Math.max(1, Math.round(offlineMs / 1000))} s.` : '');
      } else {
        summary = `Published to ${topic} as ${username}: the broker did NOT refuse it.`;
      }
      return {
        fault: 'cross-device-publish',
        ok,
        from: username,
        topic,
        loggedIn: throwaway.loggedIn,
        brokerRefused: Boolean(denied),
        connectionClosed: throwaway.closedByBroker,
        reachedPlatform: delivered,
        machineOfflineMs: offlineMs,
        summary,
      };
    }, faultMachine(machine), { toSchool: targetSchool, toDevice: subjectText(targetDevice) });
  }

  async function crossSchoolCard({ schoolCode, uid, toSchoolCode, deviceCode, items, ml } = {}) {
    const fromSchool = required(schoolCode, 'schoolCode').toLowerCase();
    const toSchool = required(toSchoolCode, 'toSchoolCode').toLowerCase();
    if (fromSchool === toSchool) throw new LabError('INPUT_INVALID', 'toSchoolCode must be another school', 400);
    const machine = deviceCode
      ? findMachine(toSchool, deviceCode)
      : [...terminals.values()].find((m) => m.schoolCode === toSchool && m.deviceType === 'CANTEEN');
    if (!machine) throw new LabError('MACHINE_NOT_FOUND', `school ${toSchool} has no canteen reader: name a machine`, 404);
    let order = {};
    if (machine.deviceType === 'CANTEEN') {
      const first = machine.config.prices.content?.items?.[0]?.code ?? 'NASI-LEMAK';
      order = { items: items ?? [{ code: first, qty: 1 }] };
    } else if (machine.deviceType === 'WATER') {
      order = { ml: ml ?? 250 };
    }
    const prepared = prepareTap({ schoolCode: toSchool, deviceCode: machine.deviceCode, uid, cardSchoolCode: fromSchool, ...order });
    const what = `a card of ${fromSchool} (${prepared.found.uid}) on ${keyOf(machine)}`;
    // a tap that is a fault: its subject is the tap's (the card of one school, the machine of the other)
    return faultAct('cross-school-card', what, traceOf(machine), async () => {
      const result = await tapNow(prepared);
      return {
        ...result,
        fault: 'cross-school-card',
        refused: !result.ok,
        summary: result.ok
          ? `A ${fromSchool} card was ACCEPTED by ${toSchool}/${machine.deviceCode}: that must never happen.`
          : `A ${fromSchool} card on ${toSchool}/${machine.deviceCode}: "${result.screen}" (the card means nothing to another school's machines).`,
      };
    }, tapPartial(prepared), tapSubject(prepared));
  }

  /** One of LAB_FAULTS, or a kiosk tap fault (`{ type, schoolCode, deviceCode, uid }`). Each runs in its own trace. */
  async function fault(args = {}) {
    requireRunning();
    const { type, ...rest } = args ?? {};
    switch (type) {
      case 'clone-card':
        return cloneCard(rest);
      case 'tamper-card':
        return tamperCard(rest);
      case 'duplicate-upload':
        return duplicateUpload(rest);
      case 'sequence-rollback':
        return sequenceRollback(rest);
      case 'forged-message':
        return forgedMessage(rest);
      case 'cross-device-publish':
        return crossDevicePublish(rest);
      case 'cross-school-card':
        return crossSchoolCard(rest);
      case 'server-down':
      case 'server-up': {
        const up = type === 'server-up';
        return faultAct(type, up ? 'switch the cloud server on' : 'switch the cloud server off', null, async () => ({
          fault: type,
          ...(await switchServer(up)),
        }), serverPartial);
      }
      case 'broker-restart':
        return faultAct(type, 'restart the MQTT broker', null, async () => ({ fault: type, ...(await restartBrokerNow()) }), serverPartial);
      default:
        if (KIOSK_TAP_FAULTS.includes(type)) return { ...(await tap({ ...rest, fault: type })), fault: type };
        throw new LabError('FAULT_INVALID', `fault type must be one of ${[...LAB_FAULTS, ...KIOSK_TAP_FAULTS].join(', ')}`, 400);
    }
  }

  // ---- building (DESIGN §12) -----------------------------------------------------------------
  //
  // The lab console's device palette: add a machine to a school, or a whole school, the way the
  // school office and the operator do it. The platform registers it, and its device.registered
  // events install the virtual machines as for any new machine, except that a machine added here
  // comes with its cable out: the person draws the cable (or asks for it plugged in, which the
  // add then does in its own flow, so the registration, the plug, the broker login and the first
  // heartbeat replay as one flow).

  /** A school to build on, by its code. Codes: INPUT_INVALID (400), SCHOOL_NOT_FOUND (404). */
  function schoolToBuild(schoolCode) {
    const code = required(schoolCode, 'schoolCode').toLowerCase();
    const school = SCHOOL_CODE_RE.test(code) ? services().schools.getSchoolByCode(code) : null;
    if (!school) throw new LabError('SCHOOL_NOT_FOUND', `there is no school ${code}`, 404);
    return school;
  }

  /** Every device code a school uses: on the platform, and in the lab. */
  function codesOf(school) {
    const taken = new Set(services().devices.listDevices(school.id).map((d) => d.code));
    for (const m of terminals.values()) if (m.schoolCode === school.code) taken.add(m.deviceCode);
    return taken;
  }

  /**
   * The code the add dialog suggests: the school's next free '<TYPE>-NN' (CANTEEN-03).
   * Codes: INPUT_INVALID (400), SCHOOL_NOT_FOUND (404).
   * @param {{ schoolCode: string, type: 'CANTEEN'|'WATER'|'KIOSK' }} args
   * @returns {{ code: string }}
   */
  function nextDeviceCode(args = {}) {
    requireRunning();
    const { schoolCode, type } = isPlainObject(args) ? args : {};
    const kind = machineType(type);
    return { code: freeMachineCode(kind, codesOf(schoolToBuild(schoolCode))) };
  }

  /**
   * Add a machine to a school: registered on the platform (as the lab), installed by the
   * platform's device.registered with its cable out, then plugged in if `cablePlugged`, all in one
   * flow (kind add-device). Answers once the machine is installed and started (and, plugged in,
   * once its first connection attempt is over).
   * Codes: INPUT_INVALID (400), SCHOOL_NOT_FOUND (404), SERVER_DOWN (409: registering needs the
   * cloud server), SCHOOL_SUSPENDED (409), DEVICE_CODE_TAKEN (409); the platform's refusals as they are.
   * @param {{ schoolCode: string, type: string, code?: string, location?: string, cablePlugged?: boolean }} args
   *   code: default the next free one; location: at most 60 characters
   * @returns {Promise<{ machine: object, trace: string }>} machine: the view state() gives (never the
   *   secret); held at a hop (its first heartbeat): `{ held: true, trace, item, machine }`
   */
  async function addDevice(args = {}) {
    requireRunning();
    if (!isPlainObject(args)) throw new LabError('INPUT_INVALID', 'give { schoolCode, type, code?, location?, cablePlugged? }', 400);
    const { schoolCode, type, code, location, cablePlugged = false } = args;
    const kind = machineType(type);
    const wanted = newMachineCode(code);
    const place = newMachineLocation(location);
    if (cablePlugged !== null && typeof cablePlugged !== 'boolean') throw new LabError('INPUT_INVALID', 'cablePlugged must be true or false', 400);
    const school = schoolToBuild(schoolCode);
    requireServerUp();
    if (school.status !== 'ACTIVE') {
      throw new LabError('SCHOOL_SUSPENDED', `${school.code} is suspended on the platform: reactivate it in the operator console first`, 409);
    }
    const taken = codesOf(school);
    const deviceCode = wanted ?? freeMachineCode(kind, taken);
    if (taken.has(deviceCode)) throw new LabError('DEVICE_CODE_TAKEN', `device code ${deviceCode} is already used in ${school.code}`, 409);
    const key = machineKey(school.code, deviceCode);
    return act(
      {
        kind: 'add-device',
        title: `Add ${MACHINE_WORDS[kind]} ${deviceCode} to ${school.code}`,
        school: school.code,
        device: deviceCode,
        subject: { school: school.code, type: kind, code: deviceCode },
      },
      () => addDeviceNow({ school, kind, deviceCode, place, plug: cablePlugged === true }),
      {
        // held at a hop (its first heartbeat, once plugged in): the machine as it is now
        partial: () => ({ machine: terminals.has(key) ? machineView(terminals.get(key)) : null }),
        action: { action: 'add-device', device: deviceCode },
      },
    );
  }

  async function addDeviceNow({ school, kind, deviceCode, place, plug }) {
    const key = machineKey(school.code, deviceCode);
    cableAtInstall.set(key, false); // installed with its cable out; plugged in below, in this flow
    try {
      await platform.registerDevice({ schoolId: school.id, code: deviceCode, type: kind, location: place, actor: LAB_ACTOR });
      await installs.get(key); // device.registered installs and starts it
    } finally {
      cableAtInstall.delete(key);
    }
    const machine = terminals.get(key);
    if (!machine) {
      requireRunning(); // a reset (or stop) took it away meanwhile: LAB_BUSY or LAB_NOT_RUNNING (503)
      throw new Error(`the lab could not install ${key}`);
    }
    if (plug) await machine.setCable(true);
    emit('lab.action', { action: 'add-device', device: deviceCode, type: kind, cablePlugged: machine.cablePlugged }, school.code);
    return { machine: machineView(machine) };
  }

  /**
   * The machines of a school being added: `[{ type, code?, location? }]` (at most 12), or a canteen
   * reader, a water machine and a kiosk; a code left out is the next free one of its type.
   * Code: INPUT_INVALID (400).
   * @returns {Array<{ type: string, code: string, location: string }>}
   */
  function newSchoolMachines(machines) {
    const given = machines === undefined || machines === null ? NEW_MACHINES.map((type) => ({ type })) : machines;
    if (!Array.isArray(given) || given.length > MAX_NEW_MACHINES) {
      throw new LabError('INPUT_INVALID', `machines must be a list of at most ${MAX_NEW_MACHINES} { type, code?, location? }`, 400);
    }
    const list = given.map((m) => {
      if (!isPlainObject(m)) throw new LabError('INPUT_INVALID', 'each machine must be { type, code?, location? }', 400);
      return { type: machineType(m.type), code: newMachineCode(m.code), location: newMachineLocation(m.location) };
    });
    const taken = new Set();
    for (const m of list) {
      if (m.code === null) continue;
      if (taken.has(m.code)) throw new LabError('INPUT_INVALID', `machine code ${m.code} is given twice`, 400);
      taken.add(m.code);
    }
    for (const m of list) {
      if (m.code !== null) continue;
      m.code = freeMachineCode(m.type, taken);
      taken.add(m.code);
    }
    return list;
  }

  /**
   * Onboard a school from the lab console, as the operator does: the platform's createTenant (as
   * the lab) with three fictional staff, one per office role, its machines (cables out) and
   * `students` demo students with new cards. The platform's events install the machines, put the
   * cards in the tray and give the school its admin card. One flow (kind add-school).
   * Codes: INPUT_INVALID (400), SCHOOL_CODE_INVALID (400), NAME_INVALID (400), SERVER_DOWN (409),
   * SCHOOL_CODE_TAKEN (409); the platform's refusals as they are.
   * @param {{ name: string, code: string, machines?: Array<{ type: string, code?: string, location?: string }>,
   *   students?: number }} args  students: 0 to 50 (default 5)
   * @returns {Promise<{ school: { code: string, name: string }, machines: object[], trace: string }>}
   *   machines: the views state() gives, in the order asked
   */
  async function addSchool(args = {}) {
    requireRunning();
    if (!isPlainObject(args)) throw new LabError('INPUT_INVALID', 'give { name, code, machines?, students? }', 400);
    const { name, code, machines } = args;
    const students = args.students ?? NEW_STUDENTS;
    if (typeof code !== 'string') throw new LabError('INPUT_INVALID', 'code is required: the school code, e.g. smk-baru', 400);
    if (typeof name !== 'string') throw new LabError('INPUT_INVALID', 'name is required: the school name, e.g. SMK Baru', 400);
    const schoolCode = code.trim().toLowerCase();
    const schoolName = name.trim();
    // the platform's own checks, here too: a request that cannot start leaves no trace
    if (!SCHOOL_CODE_RE.test(schoolCode)) {
      throw new LabError('SCHOOL_CODE_INVALID', 'school code must be lower-case letters, digits and dashes (e.g. smk-contoh)', 400);
    }
    if (schoolName.length < 1 || schoolName.length > 100) throw new LabError('NAME_INVALID', 'school name must be text of 1 to 100 characters', 400);
    if (!Number.isSafeInteger(students) || students < 0 || students > MAX_NEW_STUDENTS) {
      throw new LabError('INPUT_INVALID', `students must be a whole number from 0 to ${MAX_NEW_STUDENTS}`, 400);
    }
    const list = newSchoolMachines(machines);
    requireServerUp();
    if (services().schools.getSchoolByCode(schoolCode)) throw new LabError('SCHOOL_CODE_TAKEN', `school code ${schoolCode} is already used`, 409);
    return act(
      { kind: 'add-school', title: `Add the school ${schoolName} (${schoolCode})`, school: schoolCode, subject: { code: schoolCode } },
      () => addSchoolNow({ schoolCode, schoolName, list, students }),
      { action: { action: 'add-school', school: schoolCode } },
    );
  }

  async function addSchoolNow({ schoolCode, schoolName, list, students }) {
    const keys = list.map((m) => machineKey(schoolCode, m.code));
    for (const key of keys) cableAtInstall.set(key, false); // every machine comes with its cable out
    let out;
    try {
      out = await platform.createTenant({
        code: schoolCode,
        name: schoolName,
        staff: NEW_SCHOOL_STAFF.map((p) => ({ ...p })),
        devices: list.map(({ type, code, location }) => ({ code, type, location })),
        demoMembers: students,
        actor: LAB_ACTOR,
      });
      await Promise.all(keys.map((key) => installs.get(key))); // device.registered installs and starts them
    } finally {
      for (const key of keys) cableAtInstall.delete(key);
    }
    const views = keys.map((key) => {
      const machine = terminals.get(key);
      if (!machine) {
        requireRunning(); // a reset (or stop) took it away meanwhile: LAB_BUSY or LAB_NOT_RUNNING (503)
        throw new Error(`the lab could not install ${key}`);
      }
      return machineView(machine);
    });
    emit('lab.action', { action: 'add-school', school: out.school.code, machines: views.length, students: out.members.length }, out.school.code);
    return { school: { code: out.school.code, name: out.school.name }, machines: views };
  }

  // ---- what the lab console shows -----------------------------------------------------------

  function clockView() {
    const now = clock.now();
    return { now, iso: clock.iso(), kl: formatKL(now), mode: clock.mode };
  }

  /**
   * The whole lab for the lab console (DESIGN §8): clock, server, broker, Simulation mode
   * (§11.5: mode, hold, what is held), and every school's machines (state, location, platform
   * view, last result), cards (chip balance, counter, member, platform status, copy) and admin card.
   */
  function state() {
    const base = {
      phase,
      clock: clockView(),
      server: { up: serverUp },
      broker: brokerStatus(),
      platform: { connected: platform.mqttStatus().connected },
      sim: simState(),
      urls: phase === 'stopped' ? null : urls(),
      schools: [],
    };
    if (phase === 'stopped' || phase === 'new') return base;
    const { schools, devices } = services();
    for (const school of schools.listSchools()) {
      const cardKey = schools.schoolCardKey(school.id);
      const machines = devices.listDevices(school.id).map((d) => {
        const machine = terminals.get(machineKey(school.code, d.code));
        if (machine) return machineView(machine);
        // registered but not installed (yet): only what the platform knows
        return { school: school.code, code: d.code, type: d.type, installed: false, cablePlugged: false, connected: false,
          location: d.location, deviceStatus: d.status, online: d.online, lastHeartbeatAt: d.lastHeartbeatAt, lastResult: null };
      });
      const tray = [];
      for (const [key, card] of cards) {
        if (!key.startsWith(`${school.code}/`)) continue;
        const uid = key.slice(school.code.length + 1);
        const registered = schools.getCardByUid(school.id, card.uid);
        const member = registered?.memberId ? schools.getMember(school.id, registered.memberId) : null;
        let readable = true;
        try {
          card.read(cardKey);
        } catch {
          readable = false;
        }
        const memory = card.memory;
        tray.push({
          uid,
          chipUid: card.uid,
          last4: card.uid.slice(-4),
          copy: copies.has(key),
          copyOf: copies.has(key) ? copies.get(key).slice(school.code.length + 1) : null,
          member: member?.name ?? null,
          memberNo: member?.memberNo ?? null,
          memberId: member?.id ?? null,
          group: card.group,
          balanceSen: card.balanceSen,
          cardSeq: card.cardSeq,
          listVersionOnCard: memory.listVersionOnCard,
          records: memory.records.length,
          readable,
          platformStatus: registered?.status ?? null,
        });
      }
      base.schools.push({ code: school.code, name: school.name, status: school.status, devices: machines, cards: tray, adminCard: adminCardSummary(school.code) });
    }
    return base;
  }

  const serverView = Object.freeze({
    get up() {
      return serverUp;
    },
  });

  const lab = {
    get ctx() {
      return ctx;
    },
    platform,
    /** The running broker (startBroker()), or null while the cloud server is off. */
    get broker() {
      return broker;
    },
    /** The virtual cloud server: `up` is false while it is switched off (product APIs answer 503). */
    server: serverView,
    terminals,
    cards,
    adminCards,
    get phase() {
      return phase;
    },
    /** Same shape as start()'s answer (null before start). */
    get urls() {
      return httpUrl ? urls() : null;
    },
    get jobsMs() {
      return config.jobsMs;
    },
    start,
    stop,
    reset,
    state,
    checkBooks,
    tap,
    setCable,
    adminCardLoad,
    adminCardTap,
    adminCardUpload,
    exportUsb,
    heartbeat,
    upload,
    reboot,
    fault,
    advanceClock,
    runJobs,
    setServer,
    restartBroker,
    // building (DESIGN §12)
    nextDeviceCode,
    addDevice,
    addSchool,
    /** The traces of every action and product request (src/lab/trace.js; server.js reads it on every request). */
    tracer,
    simState,
    setSim,
    simNext,
    simRelease,
    /** Is this tray card a copy (clone-card)? */
    isCopy: (schoolCode, uid) => copies.has(`${String(schoolCode).toLowerCase()}/${uid}`),
  };
  return lab;
}
