import mqtt from 'mqtt';
import { brokerPassword, cardDigest, last4, signEnvelope, verifyEnvelopeSignature } from '../shared/crypto.js';
import { formatRM, isSen } from '../shared/money.js';
import {
  CONFIG_KINDS,
  DEVICE_CODE_RE,
  DEVICE_TYPES,
  DOWN_TYPES,
  MAX_BATCH_RECORDS,
  SCHOOL_CODE_RE,
  SCREEN_CARD_UNAVAILABLE,
  UP_TYPES,
  buildEnvelope,
  deviceTxnNo,
  parseTopic,
  topicFor,
  validateEnvelopeShape,
} from '../shared/protocol.js';
import { inWindows, isHHMM, klDay, parseHHMM, parseIso } from '../shared/time.js';
import { CardError, HOLDER_GROUPS } from './card.js';
import { verifyPack } from './adminCard.js';
import { exportJournal as journalFile } from './usb.js';

// The base of every virtual machine (docs/DESIGN.md §6), speaking the device protocol of §3.
//
// A terminal is a separate machine that reaches the platform only through the broker. Every
// purchase goes into its own journal first, so it sells with or without a network: online,
// the record goes out at once as sale.recorded / water.recorded; otherwise it waits for the
// next connection (journal.batch), a kiosk read-back or a USB export. A record counts as sent
// only once the broker acknowledged it (QoS 1 PUBACK). The platform drops repeats, so sending
// a record twice is harmless; losing one is not.
//
// Commands are signed by the platform with this machine's own secret. Anything that does not
// verify, or names another school or machine, is ignored. Prices, settings and the block list
// are each replaced whole, only by a newer version, and every decision is acknowledged.
//
// The card rules of a tap (DESIGN §3 "Terminal rules for a tap") live here too, as helpers the
// canteen reader and the water machine share.
//
// Simulation mode (DESIGN §11): every step a machine takes is a lab event (device.step,
// device.send, device.acked, device.received), emitted in the flow (trace) that caused it.
// The MQTT client and the heartbeat timer are made outside any flow, so their later callbacks
// never inherit one; a PUBACK or a command reaches its flow through the message id instead.
// The optional `gate` is the machine's outbox hold point: in simulation mode the lab can make
// a message wait there until the person presses Next.

/** Firmware version the virtual machines report in their heartbeats. */
export const FIRMWARE_VERSION = '1.0.0-lab';
/** Records a machine keeps in its journal; sent ones are dropped first to make room. */
export const JOURNAL_MAX_RECORDS = 5000;
/** Plain-message screens of the tap rules (card problems use SCREEN_CARD_UNAVAILABLE). */
export const SCREEN_CLOSED = 'Closed now';
export const SCREEN_NOT_ENOUGH_BALANCE = 'Not enough balance';
export const SCREEN_NOT_READY = 'Machine not ready, please contact the front desk';
export const SCREEN_JOURNAL_FULL = 'Machine memory full, please connect it to the network';
/** Screen tones: ok (paid, added), info, warn (a plain refusal), error (card or machine problem). */
export const SCREEN_TONES = Object.freeze(['info', 'ok', 'warn', 'error']);

const DEFAULT_HEARTBEAT_MS = 15_000;
// While the cable is plugged in, a lost broker is retried after RECONNECT_MS, doubling up to
// MAX_RECONNECT_MS: quick after a broker restart, quiet for a machine that is switched off.
const DEFAULT_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 10_000;
// A message with no PUBACK after this long (a half-open link) counts as not sent.
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
// A plug, server-up or broker restart owns the next post-connect routine only if the link is
// up within this long; a connection that comes much later is not that action's doing.
const DEFAULT_CONNECT_TRACE_MS = 30_000;
// A cable pull or switch-off owns the logout the broker reports for it if it comes within this long.
const DISCONNECT_TRACE_MS = 5000;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const COMMAND_IDS_KEPT = 1000; // envelope ids remembered to drop repeated commands
const JOURNAL_WARN_SHARE = 0.9; // heartbeat health turns WARN when this much of the journal is unsent
// Longest id, type or txn copied from a message into an event. Real ones are short; a forged
// or broken message could hold anything, and every event goes out to every lab console.
const MAX_EVENT_TEXT = 64;

/** The refusal of each tap rule (DESIGN §3), keyed by its name in the rules step (§11.2). */
const RULE_REFUSALS = Object.freeze({
  window: 'CLOSED',
  group: 'GROUP_NOT_ALLOWED',
  perPurchase: 'PER_PURCHASE_LIMIT',
  dailyTotal: 'DAILY_LIMIT',
  dailyCount: 'DAILY_COUNT',
  tapGap: 'TAP_GAP',
  balance: 'INSUFFICIENT_BALANCE',
});

// Sanity bounds for what a machine accepts as a price list or settings: generous next to the
// platform's own rules (configs.js), there only to keep the sums of a tap exact.
const MAX_PRICE_SEN = 10_000_000;
const MAX_LIMIT_SEN = 1_000_000_000;
const MAX_DAILY_COUNT = 10_000;
const MAX_TAP_GAP_SECONDS = 86_400;
const ITEM_CODE_RE = /^[A-Z0-9-]{1,24}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const LAST4_RE = /^[0-9A-F]{4}$/;
const HEX_KEY_RE = /^[0-9a-f]{32,}$/i; // same rule as shared/crypto.js

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isWhole = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const isTimerMs = (v) => isWhole(v, 1, MAX_TIMER_MS);
const shortText = (v) => (typeof v === 'string' && v.length <= MAX_EVENT_TEXT ? v : null);
const elapsedMs = (since) => Math.round(performance.now() - since);
const BROKER_PROTOCOLS = Object.freeze(['mqtt:', 'mqtts:', 'tcp:', 'tls:', 'ssl:', 'ws:', 'wss:']);

function isBrokerUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return BROKER_PROTOCOLS.includes(url.protocol) && url.hostname !== '';
  } catch {
    return false;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ---- config contents --------------------------------------------------------------
// Each returns a clean copy the machine can rely on, or null when the content is unusable.

function cleanPrices(content) {
  if (!isPlainObject(content) || !Array.isArray(content.items) || content.items.length === 0) return null;
  const codes = new Set();
  const items = [];
  for (const item of content.items) {
    if (!isPlainObject(item) || typeof item.code !== 'string' || !ITEM_CODE_RE.test(item.code) || codes.has(item.code)) return null;
    if (!isWhole(item.priceSen, 1, MAX_PRICE_SEN)) return null;
    codes.add(item.code);
    items.push({ code: item.code, name: typeof item.name === 'string' ? item.name : item.code, priceSen: item.priceSen });
  }
  const { water } = content;
  if (!isPlainObject(water) || !isWhole(water.perLitreSen, 1, MAX_PRICE_SEN) || !isWhole(water.minChargeSen, 0, MAX_PRICE_SEN)) return null;
  return { items, water: { perLitreSen: water.perLitreSen, minChargeSen: water.minChargeSen } };
}

function cleanSettings(content) {
  if (!isPlainObject(content)) return null;
  const { mealWindows, allowedGroups, perPurchaseMaxSen, dailyMaxSen, dailyMaxCount, tapGapSeconds } = content;
  const windowOk = (w) => isPlainObject(w) && isHHMM(w.from) && isHHMM(w.to) && parseHHMM(w.from) < parseHHMM(w.to);
  if (!Array.isArray(mealWindows) || !mealWindows.every(windowOk)) return null;
  if (!Array.isArray(allowedGroups) || allowedGroups.length === 0 || !allowedGroups.every((g) => HOLDER_GROUPS.includes(g))) return null;
  if (!isWhole(perPurchaseMaxSen, 1, MAX_LIMIT_SEN) || !isWhole(dailyMaxSen, 1, MAX_LIMIT_SEN)) return null;
  if (!isWhole(dailyMaxCount, 1, MAX_DAILY_COUNT) || !isWhole(tapGapSeconds, 0, MAX_TAP_GAP_SECONDS)) return null;
  return {
    mealWindows: mealWindows.map((w) => ({ from: w.from, to: w.to })),
    allowedGroups: [...new Set(allowedGroups)],
    perPurchaseMaxSen,
    dailyMaxSen,
    dailyMaxCount,
    tapGapSeconds,
  };
}

function cleanBlocklist(content) {
  if (!isPlainObject(content) || !Array.isArray(content.entries)) return null;
  const seen = new Set();
  const entries = [];
  for (const e of content.entries) {
    if (!isPlainObject(e) || typeof e.card !== 'string' || !DIGEST_RE.test(e.card)) return null;
    if (typeof e.last4 !== 'string' || !LAST4_RE.test(e.last4)) return null;
    if (seen.has(e.card)) continue;
    seen.add(e.card);
    entries.push({ card: e.card, last4: e.last4 });
  }
  return { entries };
}

const CLEANERS = { prices: cleanPrices, settings: cleanSettings, blocklist: cleanBlocklist };

/** The content part of a config command body; null when it cannot be one (a price list in another currency). */
function commandContent(kind, body) {
  if (kind === 'prices') {
    if (body.currency !== undefined && body.currency !== 'MYR') return null;
    return { items: body.items, water: body.water };
  }
  return body; // settings and block-list bodies carry their fields at the top level
}

const EMPTY_CONFIG = deepFreeze({
  prices: { version: 0, content: null, effectiveFrom: null },
  settings: { version: 0, content: null, effectiveFrom: null },
  blocklist: { version: 0, content: { entries: [] }, effectiveFrom: null },
});

/**
 * Base class of the virtual machines: broker connection, journal, commands, admin card and
 * the card rules of a tap. Subclasses: CanteenReader, WaterMachine, TopupKiosk.
 *
 * Methods whose names start with `_` are for those subclasses only.
 */
export class Terminal {
  /** The device type a subclass runs as (null: any type, given in options.device.type). */
  static deviceType = null;

  #school;
  #device;
  #brokerUrl;
  #clock;
  #events;
  #log;
  #fw;
  #heartbeatMs;
  #reconnectMs;
  #ackTimeoutMs;
  #connectTraceMs;
  #journalMax;
  #gate;

  #started = false;
  #cablePlugged;
  #client = null;
  #connecting = null; // first connection attempt of the current client, while it runs
  #online = Promise.resolve(); // what the machine does after each (re)connect
  #heartbeatTimer = null;
  // { context, at, used }: the flow that owns the next connection (its post-connect routine, used
  // once, and the broker's report of the login, linkContext('connect'))
  #connectContext = null;
  #disconnectContext = null; // { context, at }: the flow that pulled the cable or switched the machine off

  // Counters never go backwards for the life of the object (a reboot keeps them).
  #seq = 0;
  #txnCounter = 0;
  #batchCounter = 0;

  #journal = []; // [{ record, sent, inFlight }], oldest first
  #flushChain = Promise.resolve();
  #config = EMPTY_CONFIG;
  #blocked = new Set();
  #highestAdminToken = 0;
  #seenCommands = new Set();
  #lastScreen = null;

  /**
   * @param {object} options
   * @param {{ code: string, cardKey: string }} options.school  school code and card key (hex)
   * @param {{ code: string, type?: string, secret: string }} options.device  device code, type
   *   (CANTEEN, WATER, KIOSK; a subclass fills in its own) and secret (hex)
   * @param {string} [options.brokerUrl]  e.g. mqtt://127.0.0.1:1883; without it the machine has no network at all
   * @param {{ now(): number, iso(): string }} options.clock  the lab clock
   * @param {{ emit(type: string, data: object, school: string): void }} [options.events]  lab event bus
   * @param {number} [options.heartbeatMs]  heartbeat period while connected (default 15000)
   * @param {boolean} [options.cablePlugged]  network cable plugged in at start (default true)
   * @param {number} [options.reconnectMs]  first retry delay after losing the broker (default 1000, doubling up to 10 s)
   * @param {number} [options.ackTimeoutMs]  how long to wait for a PUBACK (default 10000)
   * @param {number} [options.connectTraceMs]  how long a plug (or traceNextConnect()) keeps its
   *   flow for the next post-connect routine (default 30000, real time)
   * @param {number} [options.journalMax]  journal size (default JOURNAL_MAX_RECORDS)
   * @param {string} [options.fw]  firmware version for heartbeats
   * @param {(level: string, message: string, meta?: object) => void} [options.log]  optional logger
   * @param {(info: object) => unknown} [options.gate]  the outbox hold point of Simulation mode
   *   (DESIGN §11.4): called before each publish with { kind: 'publish', device, school, type,
   *   msgId, seq, txn?, topic } (and by the kiosk before each API call with { kind: 'http',
   *   device, school, call, method, path }). A promise holds the message until it settles;
   *   anything else lets it go at once.
   * Malformed options are a TypeError.
   */
  constructor(options) {
    const {
      school,
      device,
      brokerUrl,
      clock,
      events,
      heartbeatMs = DEFAULT_HEARTBEAT_MS,
      cablePlugged = true,
      reconnectMs = DEFAULT_RECONNECT_MS,
      ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
      connectTraceMs = DEFAULT_CONNECT_TRACE_MS,
      journalMax = JOURNAL_MAX_RECORDS,
      fw = FIRMWARE_VERSION,
      log,
      gate,
    } = options ?? {};
    if (!isPlainObject(school) || typeof school.code !== 'string' || !SCHOOL_CODE_RE.test(school.code)) {
      throw new TypeError('school.code must be a school code such as smk-contoh');
    }
    if (typeof school.cardKey !== 'string' || !HEX_KEY_RE.test(school.cardKey)) {
      throw new TypeError('school.cardKey must be the school card key (hex, at least 16 bytes)');
    }
    const expected = new.target.deviceType;
    if (!isPlainObject(device) || typeof device.code !== 'string' || !DEVICE_CODE_RE.test(device.code)) {
      throw new TypeError('device.code must be a device code such as CANTEEN-01');
    }
    const type = device.type ?? expected;
    if (!DEVICE_TYPES.includes(type) || (expected && type !== expected)) {
      throw new TypeError(`device.type must be ${expected ?? DEVICE_TYPES.join(', ')}`);
    }
    if (typeof device.secret !== 'string' || !HEX_KEY_RE.test(device.secret)) {
      throw new TypeError('device.secret must be the device secret (hex, at least 16 bytes)');
    }
    if (brokerUrl != null && !isBrokerUrl(brokerUrl)) throw new TypeError('brokerUrl must be an MQTT URL such as mqtt://127.0.0.1:1883');
    if (!clock || typeof clock.now !== 'function' || typeof clock.iso !== 'function') throw new TypeError('clock must be the lab clock');
    if (events != null && typeof events.emit !== 'function') throw new TypeError('events must be the lab event bus');
    if (log != null && typeof log !== 'function') throw new TypeError('log must be a function');
    if (gate !== undefined && typeof gate !== 'function') throw new TypeError('gate must be a function (or left out)');
    for (const [name, value] of Object.entries({ heartbeatMs, reconnectMs, ackTimeoutMs, connectTraceMs })) {
      if (!isTimerMs(value)) throw new TypeError(`${name} must be a whole number of milliseconds, 1 to ${MAX_TIMER_MS}`);
    }
    if (!isWhole(journalMax, 1, Number.MAX_SAFE_INTEGER)) throw new TypeError('journalMax must be a whole number, 1 or more');
    if (typeof cablePlugged !== 'boolean') throw new TypeError('cablePlugged must be true or false');
    if (typeof fw !== 'string' || fw === '') throw new TypeError('fw must be a version string');

    this.#school = Object.freeze({ code: school.code, cardKey: school.cardKey });
    this.#device = Object.freeze({ code: device.code, type, secret: device.secret });
    this.#brokerUrl = brokerUrl ?? null;
    this.#clock = clock;
    this.#events = events ?? null;
    this.#log = log ?? null;
    this.#heartbeatMs = heartbeatMs;
    this.#reconnectMs = reconnectMs;
    this.#ackTimeoutMs = ackTimeoutMs;
    this.#connectTraceMs = connectTraceMs;
    this.#journalMax = journalMax;
    this.#fw = fw;
    this.#cablePlugged = cablePlugged;
    this.#gate = gate ?? null;
  }

  get schoolCode() {
    return this.#school.code;
  }

  get deviceCode() {
    return this.#device.code;
  }

  get deviceType() {
    return this.#device.type;
  }

  get cablePlugged() {
    return this.#cablePlugged;
  }

  /** True while the broker connection is up (the cable alone is not enough). */
  get connected() {
    return this.#client?.connected === true;
  }

  // ---- life cycle -------------------------------------------------------------------

  /**
   * Switch the machine on. With the cable plugged in it connects to the broker and resolves
   * once the first attempt is over: connected, subscribed, heartbeat sent and unsent records
   * uploaded, or the attempt failed (the machine keeps retrying in the background). Never
   * rejects for network problems.
   */
  async start() {
    this.#started = true;
    await this.#connect();
  }

  /** Switch the machine off: the connection ends at once. Counters and journal stay (a reboot). */
  async stop() {
    this.#started = false;
    this.#keepDisconnectContext();
    await this.#disconnect();
  }

  /**
   * Plug or unplug the network cable. Unplugging ends the connection at once and the machine
   * keeps working offline. Plugging reconnects: retained config arrives and unsent records go
   * up as journal.batch (resolves when that first attempt is over, as start()).
   * @param {boolean} plugged
   */
  async setCable(plugged) {
    if (typeof plugged !== 'boolean') throw new TypeError('plugged must be true or false');
    if (plugged !== this.#cablePlugged) {
      this.#cablePlugged = plugged;
      this._emit('device.cable', { device: this.#device.code, plugged });
    }
    if (plugged) {
      // The connection this plug brings up belongs to the flow that plugged it (DESIGN §11.3);
      // plugging a machine that is already online starts nothing.
      if (!this.connected) this.#keepConnectContext();
      await this.#connect();
    } else {
      this.#keepDisconnectContext();
      await this.#disconnect();
    }
  }

  /**
   * Let the next post-connect routine (heartbeat and journal upload) belong to the current
   * flow (events.context()), as after the server comes back or the broker restarts
   * (DESIGN §11.3). It counts only if that routine starts within connectTraceMs, and only the
   * first routine after this call uses it; later reconnects run in no flow.
   */
  traceNextConnect() {
    this.#keepConnectContext();
  }

  /**
   * The flow a broker login or logout of this machine belongs to (DESIGN §11.7), for the
   * broker's report of it (mqtt.connect, mqtt.disconnect):
   * - 'connect': the flow kept for the next connection by a cable plug or traceNextConnect().
   *   The post-connect routine does not use it up (the broker may report the login after it
   *   started); it lasts until connectTraceMs is over, or until that connection is lost.
   * - 'disconnect': the flow that pulled the cable or switched the machine off (setCable(false),
   *   stop()), for DISCONNECT_TRACE_MS (5 s), and only until the machine is connected again.
   * - anything else: null.
   * @param {string} kind
   * @returns {{ trace: string } | null} a copy
   */
  linkContext(kind) {
    let kept = null;
    if (kind === 'connect') {
      kept = this.#connectContext;
      if (kept && performance.now() - kept.at > this.#connectTraceMs) kept = null;
    } else if (kind === 'disconnect') {
      kept = this.#disconnectContext;
      if (kept && performance.now() - kept.at > DISCONNECT_TRACE_MS) kept = null;
    }
    const trace = kept?.context?.trace;
    return typeof trace === 'string' && trace !== '' ? { trace } : null;
  }

  #keepConnectContext() {
    const context = this.#context();
    this.#connectContext = context ? { context, at: performance.now(), used: false } : null;
  }

  #keepDisconnectContext() {
    const context = this.#context();
    this.#disconnectContext = context ? { context, at: performance.now() } : null;
  }

  /**
   * The kept flow for this post-connect routine, if still fresh, and only for the first
   * routine after it was kept. It stays for linkContext('connect') until it expires or the
   * connection ends (#onClose).
   */
  #takeConnectContext() {
    const kept = this.#connectContext;
    if (!kept || kept.used) return null;
    kept.used = true;
    return performance.now() - kept.at <= this.#connectTraceMs ? kept.context : null;
  }

  #commandFilter() {
    return `${topicFor(this.#school.code, this.#device.code, 'commands')}/#`;
  }

  #connect() {
    if (!this.#started || !this.#cablePlugged || !this.#brokerUrl) return Promise.resolve();
    if (this.#client) return this.#connecting ?? Promise.resolve();
    const username = `${this.#school.code}.${this.#device.code}`;
    // Made outside any flow: every later callback of the client (PUBACKs, commands,
    // reconnects) would otherwise run in the flow that happened to plug the cable in.
    const client = this.#untraced(() =>
      mqtt.connect(this.#brokerUrl, {
        clientId: username,
        username,
        password: brokerPassword(this.#device.secret),
        clean: true,
        reconnectPeriod: this.#reconnectMs,
        // A machine switched off by the school (CONNACK 5) keeps knocking, so it is back as
        // soon as it is switched on again.
        reconnectOnConnackError: true,
        connectTimeout: CONNECT_TIMEOUT_MS,
        // Subscribed again by #onConnect after every connect (clean session).
        resubscribe: false,
      }),
    );
    this.#client = client;
    client.on('error', (err) => this.#note('debug', 'mqtt client error', { error: err?.message }));
    client.on('message', (topic, payload) => this.#onMessage(client, topic, payload));
    client.on('connect', () => {
      client.options.reconnectPeriod = this.#reconnectMs;
      this.#online = this.#afterConnect(client);
    });
    client.on('reconnect', () => {
      const period = client.options.reconnectPeriod;
      if (period > 0) client.options.reconnectPeriod = Math.min(period * 2, Math.max(MAX_RECONNECT_MS, this.#reconnectMs));
    });
    client.on('close', () => this.#onClose(client));

    const first = new Promise((resolve) => {
      const done = () => {
        client.off('connect', onConnect);
        client.off('close', done);
        if (this.#connecting === first) this.#connecting = null;
        resolve();
      };
      const onConnect = () => this.#online.then(done, done);
      client.on('connect', onConnect);
      client.on('close', done);
    });
    this.#connecting = first;
    return first;
  }

  async #disconnect() {
    const client = this.#client;
    if (!client) return;
    this.#client = null;
    this.#connecting = null;
    this.#stopHeartbeat();
    // No retry; and with reconnectPeriod 0, end(true) fails every message still waiting for
    // its PUBACK, so each one counts as not sent.
    client.options.reconnectPeriod = 0;
    await new Promise((resolve) => client.end(true, () => resolve()));
  }

  /** The post-connect routine, in the flow kept for it (a fresh plug) or in none. */
  #afterConnect(client) {
    // connected again: a later logout is not the doing of the pull or switch-off before this
    this.#disconnectContext = null;
    const kept = this.#takeConnectContext();
    return this.#untraced(() => (kept ? this.#withContext(kept, () => this.#onConnect(client)) : this.#onConnect(client)));
  }

  /** After every (re)connect: subscribe to the commands, then heartbeat and upload what is unsent. */
  async #onConnect(client) {
    try {
      await client.subscribeAsync(this.#commandFilter(), { qos: 1 });
    } catch (err) {
      this.#note('warn', 'could not subscribe to commands', { error: err?.message });
    }
    if (client !== this.#client || !client.connected) return;
    this.#startHeartbeat(client);
    await this.heartbeat();
    await this.flushJournal();
  }

  #onClose(client) {
    // Take back every message still waiting for its PUBACK. mqtt.js would resend it after
    // reconnecting, with the seq it had then; a record not acknowledged stays unsent in the
    // journal and goes up again in the next batch, with a fresh envelope.
    for (const id of Object.keys(client.outgoing ?? {})) {
      try {
        client.removeOutgoingMessage(Number(id));
      } catch {
        // the client's store is already closed: nothing left to resend
      }
    }
    if (client === this.#client) {
      this.#stopHeartbeat();
      // The connection a plug or traceNextConnect() kept its flow for is over: a later login
      // (after a kick, say) is not that flow's doing (linkContext('connect')).
      if (this.#connectContext?.used) this.#connectContext = null;
    }
  }

  #startHeartbeat(client) {
    this.#stopHeartbeat();
    // Outside any flow, though a plug's routine starts it: periodic heartbeats belong to none.
    this.#heartbeatTimer = this.#untraced(() =>
      setInterval(() => {
        if (client === this.#client && client.connected) this.heartbeat().catch(() => {});
      }, this.#heartbeatMs),
    );
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  // ---- sending ----------------------------------------------------------------------

  /** The next device transaction number, e.g. 'KIOSK-01-000007' (consecutive, never reused). */
  nextTxn() {
    this.#txnCounter += 1;
    return deviceTxnNo(this.#device.code, this.#txnCounter);
  }

  /**
   * Sign and publish one message on this machine's own records or status topic (QoS 1).
   * In simulation mode the gate may hold it first (DESIGN §11.4); if the link is gone by the
   * time it is let go, it is not sent.
   * @param {string} type  a device message type (sale.recorded, journal.batch, card.readback, command.ack, device.heartbeat, ...)
   * @param {object} body
   * @param {{ txn?: string }} [options]  envelope txn: the record's txn or the batch id
   * @returns {Promise<boolean>} true once the broker acknowledged it; false when offline or
   *   the connection was lost first
   */
  async publishUp(type, body, { txn } = {}) {
    if (typeof type !== 'string' || !Object.hasOwn(UP_TYPES, type)) throw new TypeError(`${type} is not a message a machine sends`);
    if (!isPlainObject(body)) throw new TypeError('body must be an object');
    if (!this.#client?.connected) return this.#notSent(type, txn);
    const envelope = signEnvelope(
      this.#device.secret,
      buildEnvelope({
        school: this.#school.code,
        device: this.#device.code,
        seq: ++this.#seq,
        at: this.#clock.iso(),
        type,
        txn,
        body,
      }),
    );
    return this.#publish(topicFor(this.#school.code, this.#device.code, UP_TYPES[type]), envelope, { renumber: true });
  }

  /**
   * Publish an envelope exactly as given (lab faults: a forged signature, an old seq, a
   * repeated message id) on this machine's own records or status topic. Never on another
   * topic: the broker would cut the machine off, and mqtt.js would retry it after every
   * reconnect. The gate applies as for publishUp, but a held envelope keeps its seq.
   * @param {object} envelope
   * @returns {Promise<boolean>} as publishUp
   */
  async publishEnvelope(envelope) {
    if (!isPlainObject(envelope)) throw new TypeError('envelope must be an object');
    const channel = typeof envelope.type === 'string' && Object.hasOwn(UP_TYPES, envelope.type) ? UP_TYPES[envelope.type] : 'records';
    if (!this.#client?.connected) return this.#notSent(envelope.type, envelope.txn);
    return this.#publish(topicFor(this.#school.code, this.#device.code, channel), envelope, { renumber: false });
  }

  /**
   * The outbox: ask the gate, then publish on the link as it is by then. With no hold this
   * all happens at once, as it always did. A held message finds out afterwards whether the
   * link is still there; if something else went out meanwhile (a periodic heartbeat), a
   * message of publishUp takes the next seq, or the platform would refuse it as a rollback.
   */
  #publish(topic, envelope, { renumber }) {
    const info = { kind: 'publish', type: shortText(envelope.type), msgId: shortText(envelope.id), seq: envelope.seq };
    if (envelope.txn !== undefined) info.txn = envelope.txn;
    info.topic = topic;
    const held = this._hold(info);
    const go = () => {
      const client = this.#client;
      if (!client?.connected) return this.#notSent(envelope.type, envelope.txn);
      const out = held && renumber && this.#seq > envelope.seq ? this.#renumber(envelope) : envelope;
      return this.#send(client, topic, out);
    };
    return held ? held.then(go) : go();
  }

  /** The same message (same id) under the next seq, signed again. */
  #renumber(envelope) {
    const { sig: _sig, ...unsigned } = envelope;
    return signEnvelope(this.#device.secret, { ...unsigned, seq: ++this.#seq });
  }

  #send(client, topic, envelope) {
    const payload = JSON.stringify(envelope);
    const message = { msgId: shortText(envelope.id), type: shortText(envelope.type) };
    const sending = { device: this.#device.code, ...message, seq: Number.isSafeInteger(envelope.seq) ? envelope.seq : null };
    if (envelope.txn !== undefined) sending.txn = shortText(envelope.txn);
    sending.topic = topic;
    sending.bytes = Buffer.byteLength(payload);
    if (envelope.type === 'command.ack' && shortText(envelope.body?.command)) sending.inReplyTo = envelope.body.command;
    this._emit('device.send', sending);
    const started = performance.now();
    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      let timedOut = false;
      const callback = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#acked(message, err ? (timedOut ? 'timeout' : 'connection lost') : null, started);
        resolve(!err);
      };
      timer = setTimeout(() => {
        timedOut = true;
        // No PUBACK in time: take the message back, so it is neither resent nor counted.
        for (const [id, pending] of Object.entries(client.outgoing ?? {})) {
          if (pending?.cb === callback) {
            try {
              client.removeOutgoingMessage(Number(id));
            } catch {
              // already gone with its store
            }
          }
        }
        callback(new Error('no PUBACK in time'));
      }, this.#ackTimeoutMs);
      timer.unref?.();
      try {
        client.publish(topic, payload, { qos: 1 }, callback);
      } catch (err) {
        callback(err);
      }
    });
  }

  /**
   * device.acked: the PUBACK came, or did not (timeout, connection lost). Whatever flow
   * happens to run the callback (the socket, a timer, a cable pulled in another flow), the
   * event is emitted in none: the lab joins it to its message's flow by msgId (DESIGN §11.3).
   */
  #acked(message, reason, started) {
    const data = { device: this.#device.code, ...message, ok: !reason, ms: elapsedMs(started) };
    if (reason) data.reason = reason;
    this.#untraced(() => this._emit('device.acked', data));
  }

  /** device.step offline: a message not sent for lack of a broker link. @returns {false} */
  #notSent(type, txn) {
    const fields = { type: shortText(type) };
    if (txn !== undefined && txn !== null) fields.txn = shortText(txn);
    return this._offlineStep(fields);
  }

  /**
   * Send a device.heartbeat now: firmware, health, the versions it runs and how many records
   * are still unsent. Also sent on connect, every heartbeatMs, and on control.heartbeat-now.
   * @returns {Promise<boolean>} as publishUp
   */
  async heartbeat() {
    return this.publishUp('device.heartbeat', {
      fw: this.#fw,
      health: this.#health(),
      listVersions: this.#versions(),
      journalUnsent: this.#unsentCount(),
    });
  }

  // WARN when the machine cannot do its job (a reader or water machine without prices,
  // settings or a block list), or will soon have to refuse sales because its journal is
  // nearly full of unsent records. Sent records are only history, dropped to make room, so a
  // busy machine's journal is always close to full.
  #health() {
    const { prices, settings, blocklist } = this.#config;
    const sells = this.#device.type !== 'KIOSK';
    if (sells && (prices.version === 0 || settings.version === 0 || blocklist.version === 0)) return 'WARN';
    if (this.#unsentCount() >= this.#journalMax * JOURNAL_WARN_SHARE) return 'WARN';
    return 'OK';
  }

  #versions() {
    const { prices, settings, blocklist } = this.#config;
    return { prices: prices.version, settings: settings.version, blocklist: blocklist.version };
  }

  #unsentCount() {
    let n = 0;
    for (const e of this.#journal) if (!e.sent) n += 1;
    return n;
  }

  /**
   * Upload every unsent journal record as journal.batch messages of at most
   * MAX_BATCH_RECORDS (batch ids '<DEVICE>-B<n>'), marking each batch sent on its PUBACK.
   * One upload runs at a time; records already on their way are left out.
   * @returns {Promise<{ batches: number, records: number, unsent: number }>}
   */
  flushJournal() {
    const run = this.#flushChain.then(() => this.#flushOnce());
    this.#flushChain = run.catch(() => {});
    return run;
  }

  async #flushOnce() {
    let batches = 0;
    let records = 0;
    if (!this.connected && this.#journal.some((e) => !e.sent && !e.inFlight)) this.#notSent('journal.batch');
    while (this.connected) {
      const pending = this.#journal.filter((e) => !e.sent && !e.inFlight).slice(0, MAX_BATCH_RECORDS);
      if (pending.length === 0) break;
      this.#batchCounter += 1;
      const batchId = `${this.#device.code}-B${this.#batchCounter}`;
      for (const e of pending) e.inFlight = true;
      let sent = false;
      try {
        sent = await this.publishUp('journal.batch', { batchId, count: pending.length, records: pending.map((e) => e.record) }, { txn: batchId });
      } finally {
        for (const e of pending) {
          e.inFlight = false;
          if (sent) e.sent = true;
        }
      }
      if (!sent) break;
      batches += 1;
      records += pending.length;
    }
    return { batches, records, unsent: this.#unsentCount() };
  }

  // ---- commands ---------------------------------------------------------------------

  #onMessage(client, topic, payload) {
    if (client !== this.#client) return;
    try {
      const { envelope, ignored } = this.#acceptCommand(topic, payload);
      if (ignored) {
        this.#received(envelope, 'IGNORED', { reason: ignored });
        return;
      }
      // Everything the command makes the machine do (its ack, a heartbeat, an upload) carries
      // the command's id, so the lab can show it in the flow that sent the command.
      this.#withContext({ msgId: envelope.id }, () => this.#handleCommand(envelope)).catch((err) =>
        this.#note('warn', 'command failed', { type: envelope.type, error: err?.message }),
      );
    } catch (err) {
      this.#note('warn', 'command failed', { topic, error: err?.message });
    }
  }

  /**
   * The verified command, or why it is ignored: TOPIC_INVALID (not a command sub-topic of this
   * machine), UNREADABLE (not JSON, or not an envelope), TOPIC_MISMATCH (a command type on
   * another kind's sub-topic), WRONG_TARGET (names another school or machine),
   * SIGNATURE_INVALID, DUPLICATE (an id already handled).
   * @returns {{ envelope: object|null, ignored?: string }}  envelope: as read, if it was JSON
   */
  #acceptCommand(topic, payload) {
    let envelope = null;
    let readable = true;
    try {
      envelope = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
    } catch {
      readable = false;
    }
    const ignore = (reason, note) => {
      if (note) this.#note('info', 'command ignored', { topic, reason: note });
      return { envelope: isPlainObject(envelope) ? envelope : null, ignored: reason };
    };
    const school = this.#school.code;
    const device = this.#device.code;
    const where = parseTopic(topic);
    if (!where || where.channel !== 'commands' || where.school !== school || where.device !== device) {
      return ignore('TOPIC_INVALID', 'not a command topic of this machine');
    }
    if (!readable) return ignore('UNREADABLE', 'not JSON');
    if (!validateEnvelopeShape(envelope).ok) return ignore('UNREADABLE', 'malformed envelope');
    if (!Object.hasOwn(DOWN_TYPES, envelope.type) || DOWN_TYPES[envelope.type] !== where.kind) {
      return ignore('TOPIC_MISMATCH', 'not a command for this topic');
    }
    if (envelope.school !== school || envelope.device !== device) return ignore('WRONG_TARGET', 'names another school or machine');
    if (!verifyEnvelopeSignature(this.#device.secret, envelope)) return ignore('SIGNATURE_INVALID', 'signature does not verify');
    // Remembered only once verified, so a forgery can never block the real command's id.
    if (this.#seenCommands.has(envelope.id)) return ignore('DUPLICATE');
    this.#seenCommands.add(envelope.id);
    if (this.#seenCommands.size > COMMAND_IDS_KEPT) this.#seenCommands.delete(this.#seenCommands.values().next().value);
    return { envelope };
  }

  async #handleCommand(envelope) {
    switch (envelope.type) {
      case 'config.prices':
        return this.#applyConfigCommand('prices', envelope);
      case 'config.settings':
        return this.#applyConfigCommand('settings', envelope);
      case 'blocklist.snapshot':
        return this.#applyConfigCommand('blocklist', envelope);
      case 'blocklist.delta':
        return this.#applyDelta(envelope);
      case 'control.upload-journal':
        this.#received(envelope, 'APPLIED');
        return this.flushJournal();
      case 'control.heartbeat-now':
        this.#received(envelope, 'APPLIED');
        return this.heartbeat();
      default:
        // DOWN_TYPES has nothing else; kept so a new type cannot pass unseen
        this.#received(envelope, 'IGNORED', { reason: 'TOPIC_MISMATCH' });
        return null;
    }
  }

  /**
   * device.received: what the machine made of one message on its commands topic (DESIGN
   * §11.2). kind and version for config commands; reason for IGNORED (see #acceptCommand,
   * plus VERSION_MISMATCH / CONFIG_INVALID for a block-list delta) and REJECTED (the ack's error).
   */
  #received(envelope, result, { kind, version, reason } = {}) {
    const data = { device: this.#device.code, msgId: shortText(envelope?.id), type: shortText(envelope?.type) };
    if (kind) data.kind = kind;
    if (Number.isSafeInteger(version)) data.version = version;
    data.result = result;
    if (reason) data.reason = reason;
    this._emit('device.received', data);
  }

  #applyConfigCommand(kind, envelope) {
    const { body } = envelope;
    const { result, error } = this.#offer(kind, body.version, commandContent(kind, body), body.effectiveFrom);
    this.#received(envelope, result, { kind, version: body.version, reason: error });
    return this.#ack(envelope, kind, result, error);
  }

  /**
   * One config version offered by a command or an admin-card pack. Newer replaces the whole
   * table or list at once; the same is ALREADY_APPLIED; older is REJECTED (STALE_VERSION).
   * @returns {{ result: 'APPLIED'|'ALREADY_APPLIED'|'REJECTED', error?: string }}
   */
  #offer(kind, version, content, effectiveFrom) {
    const local = this.#config[kind].version;
    if (!Number.isSafeInteger(version) || version < 1) return { result: 'REJECTED', error: 'CONFIG_INVALID' };
    if (version < local) return { result: 'REJECTED', error: 'STALE_VERSION' };
    if (version === local) return { result: 'ALREADY_APPLIED' };
    const clean = CLEANERS[kind](content);
    if (!clean) return { result: 'REJECTED', error: 'CONFIG_INVALID' };
    this.#install(kind, version, clean, effectiveFrom);
    return { result: 'APPLIED' };
  }

  #install(kind, version, content, effectiveFrom = null) {
    const from = typeof effectiveFrom === 'string' || Number.isFinite(effectiveFrom) ? effectiveFrom : null;
    this.#config = Object.freeze({ ...this.#config, [kind]: deepFreeze({ version, content, effectiveFrom: from }) });
    if (kind === 'blocklist') this.#blocked = new Set(content.entries.map((e) => e.card));
  }

  // A delta only fits the exact version it was made from; any other is ignored, because the
  // retained snapshot on commands/blocklist brings the whole list anyway.
  #applyDelta(envelope) {
    const { fromVersion, toVersion, added, removed } = envelope.body;
    const current = this.#config.blocklist;
    const ignore = (reason) => {
      this.#received(envelope, 'IGNORED', { kind: 'blocklist', version: toVersion, reason });
      return null;
    };
    if (fromVersion !== current.version) return ignore('VERSION_MISMATCH');
    if (!Number.isSafeInteger(toVersion) || toVersion <= fromVersion) return ignore('CONFIG_INVALID');
    if (!Array.isArray(added) || !Array.isArray(removed) || !removed.every((d) => typeof d === 'string' && DIGEST_RE.test(d))) {
      return ignore('CONFIG_INVALID');
    }
    const gone = new Set(removed);
    const next = cleanBlocklist({ entries: [...current.content.entries.filter((e) => !gone.has(e.card)), ...added] });
    if (!next) return ignore('CONFIG_INVALID');
    this.#install('blocklist', toVersion, next);
    this.#received(envelope, 'APPLIED', { kind: 'blocklist', version: toVersion });
    return this.#ack(envelope, 'blocklist', 'APPLIED');
  }

  #ack(envelope, kind, result, error) {
    const body = { command: envelope.id, kind, result, appliedVersion: this.#config[kind].version };
    if (error) body.error = error;
    return this.publishUp('command.ack', body);
  }

  // ---- installation, admin card, USB ------------------------------------------------

  /**
   * Install configs the way a technician does at installation (no network needed). Each part
   * is optional and replaces what the machine has: prices and settings as
   * `{ version, content }` (configs.current()) or a command body `{ version, ...content }`;
   * the block list as `{ version, entries }` or `{ version, content: { entries } }`.
   * A part that is null, or at version 0 (configs.current() for a kind never published),
   * installs nothing. All parts are checked before any is installed; anything unusable is a
   * TypeError.
   * @param {{ prices?: object|null, settings?: object|null, blocklist?: object|null }} configs
   * @returns {{ prices: number, settings: number, blocklist: number }} the versions now installed
   */
  provision({ prices, settings, blocklist } = {}) {
    const parts = [];
    for (const [kind, part] of Object.entries({ prices, settings, blocklist })) {
      if (part == null) continue;
      if (!isPlainObject(part) || !Number.isSafeInteger(part.version) || part.version < 0) {
        throw new TypeError(`${kind} needs a version, 0 or more`);
      }
      if (part.version === 0) continue;
      const clean = CLEANERS[kind](isPlainObject(part.content) ? part.content : part);
      if (!clean) throw new TypeError(`${kind} content is not usable`);
      parts.push([kind, part.version, clean, part.effectiveFrom]);
    }
    for (const [kind, version, content, effectiveFrom] of parts) this.#install(kind, version, content, effectiveFrom);
    return this.#versions();
  }

  /**
   * Tap the school's admin card on this machine. Packs count only from a card whose token is
   * higher than any this machine has seen (else every pack is REJECTED / STALE_TOKEN). Then
   * each pack: wrong checksum REJECTED / BAD_CHECKSUM, older REJECTED / STALE_VERSION, same
   * ALREADY_APPLIED, newer APPLIED (the whole table or list at once). One receipt per pack is
   * written on the card, then the token is remembered. Another school's card is refused
   * without receipts.
   * @param {import('./adminCard.js').AdminCard} adminCard
   * @returns {{ results: object[] }} the receipts written
   */
  tapAdminCard(adminCard) {
    if (!adminCard || typeof adminCard.addReceipt !== 'function') throw new TypeError('adminCard must be an AdminCard');
    const memory = adminCard.memory;
    if (memory?.school !== this.#school.code) {
      this.screen(SCREEN_CARD_UNAVAILABLE, 'error');
      return { results: [] };
    }
    const { token } = memory;
    const fresh = Number.isSafeInteger(token) && token > this.#highestAdminToken;
    const results = [];
    for (const pack of Array.isArray(memory.packs) ? memory.packs : []) {
      if (!isPlainObject(pack) || !CONFIG_KINDS.includes(pack.kind)) continue;
      let outcome;
      if (!fresh) outcome = { result: 'REJECTED', error: 'STALE_TOKEN' };
      else if (!verifyPack(pack)) outcome = { result: 'REJECTED', error: 'BAD_CHECKSUM' };
      else outcome = this.#offer(pack.kind, pack.version, pack.content, null);
      results.push(
        adminCard.addReceipt({
          device: this.#device.code,
          kind: pack.kind,
          appliedVersion: this.#config[pack.kind].version,
          result: outcome.result,
          error: outcome.error,
          at: this.#clock.iso(),
        }),
      );
    }
    if (fresh) this.#highestAdminToken = token;
    const count = (result) => results.filter((r) => r.result === result).length;
    const applied = count('APPLIED');
    const rejected = count('REJECTED');
    this.screen(
      `Admin card read: ${applied} applied, ${count('ALREADY_APPLIED')} already applied, ${rejected} rejected`,
      rejected > 0 ? 'warn' : 'ok',
    );
    this._emit('admin-card.applied', { device: this.#device.code, token, results: results.map((r) => ({ ...r })) });
    return { results };
  }

  /**
   * The whole journal as a signed USB export file (usb.js), sent and unsent records alike.
   * Exporting does not mark anything sent: the platform drops records it already has.
   */
  exportJournal() {
    return journalFile({
      schoolCode: this.#school.code,
      deviceCode: this.#device.code,
      secret: this.#device.secret,
      records: this.#journal.map((e) => e.record),
      exportedAt: this.#clock.iso(),
    });
  }

  // ---- what the machine shows -------------------------------------------------------

  /**
   * Show a message on the machine's screen (emits device.screen).
   * @param {string} text
   * @param {'info'|'ok'|'warn'|'error'} [tone]
   * @returns {string} the text shown
   */
  screen(text, tone = 'info') {
    const shown = String(text);
    const t = SCREEN_TONES.includes(tone) ? tone : 'info';
    this.#lastScreen = { text: shown, tone: t, at: this.#clock.iso() };
    this._emit('device.screen', { device: this.#device.code, text: shown, tone: t });
    return shown;
  }

  /**
   * @returns {{ school: string, code: string, type: string, cablePlugged: boolean, connected: boolean,
   *   seq: number, txnCounter: number, journal: { total: number, unsent: number },
   *   versions: { prices: number, settings: number, blocklist: number }, blocklistSize: number,
   *   lastScreen: { text: string, tone: string, at: string } | null, highestAdminToken: number }}
   */
  get state() {
    return {
      school: this.#school.code,
      code: this.#device.code,
      type: this.#device.type,
      cablePlugged: this.#cablePlugged,
      connected: this.connected,
      seq: this.#seq,
      txnCounter: this.#txnCounter,
      journal: { total: this.#journal.length, unsent: this.#unsentCount() },
      versions: this.#versions(),
      blocklistSize: this.#blocked.size,
      lastScreen: this.#lastScreen ? { ...this.#lastScreen } : null,
      highestAdminToken: this.#highestAdminToken,
    };
  }

  /**
   * The configs the machine runs (a copy), for the machine console.
   * @returns {{ prices: { version: number, content: object|null, effectiveFrom: string|number|null },
   *   settings: object, blocklist: { version: number, content: { entries: object[] }, effectiveFrom: null } }}
   */
  get config() {
    return structuredClone(this.#config);
  }

  /**
   * Journal records with their sent flag (copies), oldest first.
   * @param {{ limit?: number }} [options]  only the newest `limit` records
   * @returns {Array<{ record: object, sent: boolean }>}
   */
  journal({ limit } = {}) {
    const entries = isWhole(limit, 0, Number.MAX_SAFE_INTEGER) ? this.#journal.slice(Math.max(0, this.#journal.length - limit)) : this.#journal;
    return entries.map((e) => ({ record: structuredClone(e.record), sent: e.sent }));
  }

  // ---- for subclasses: card rules and sales -----------------------------------------

  /** Emit a lab event with this machine's school. */
  _emit(type, data) {
    try {
      this.#events?.emit(type, data, this.#school.code);
    } catch {
      // a broken event bus must not break the machine
    }
  }

  /** device.step (DESIGN §11.2): one step the machine took, e.g. card.read, rules, journal, offline. */
  _step(step, ok, fields = {}) {
    this._emit('device.step', { device: this.#device.code, step, ok, ...fields });
  }

  /**
   * The card.read step: what the machine read from the chip, or why it cannot use the card
   * (CARD_UNREADABLE, WRONG_SCHOOL, BLOCKED; a blocked card was read, so its chip data is
   * shown too). The screen never says which.
   * @param {object|null} memory  the verified memory, null when it could not be read
   * @param {string} [reason]
   */
  _cardReadStep(memory, reason) {
    const chip = memory
      ? {
          last4: last4(memory.uid),
          balanceSen: memory.balanceSen,
          cardSeq: memory.cardSeq,
          records: memory.records.length,
          listVersionOnCard: memory.listVersionOnCard,
        }
      : {};
    this._step('card.read', !reason, reason ? { reason, ...chip } : chip);
  }

  /**
   * The offline step: something not sent for lack of a broker link. `fields`: { type, txn? }
   * for a message, or { call } for a kiosk API call the kiosk did not even try.
   * @returns {false}
   */
  _offlineStep(fields) {
    this._step('offline', false, fields);
    return false;
  }

  /**
   * A hold point of Simulation mode (DESIGN §11.4): ask the gate before a publish or a kiosk
   * API call. Without a gate, or when it answers anything but a promise, the caller goes on at
   * once (realtime code paths stay synchronous). A gate that throws or rejects is noted and
   * passed: it must never stop the machine.
   * @param {{ kind: 'publish'|'http' }} info  device and school are filled in
   * @returns {Promise<void>|null}  what to wait for (it never rejects), or null
   */
  _hold(info) {
    if (!this.#gate) return null;
    const { kind, ...rest } = info;
    try {
      const answer = this.#gate({ kind, device: this.#device.code, school: this.#school.code, ...rest });
      if (answer === null || (typeof answer !== 'object' && typeof answer !== 'function') || typeof answer.then !== 'function') return null;
      return Promise.resolve(answer).then(
        () => {},
        (err) => this.#note('warn', 'gate failed', { kind, error: err?.message }),
      );
    } catch (err) {
      this.#note('warn', 'gate failed', { kind, error: err?.message });
      return null;
    }
  }

  // The bus context (DESIGN §11.1). A machine with no bus, or an older one, just runs `fn`.
  #context() {
    try {
      return typeof this.#events?.context === 'function' ? this.#events.context() : null;
    } catch {
      return null;
    }
  }

  #untraced(fn) {
    return typeof this.#events?.untraced === 'function' ? this.#events.untraced(fn) : fn();
  }

  #withContext(patch, fn) {
    return typeof this.#events?.withContext === 'function' ? this.#events.withContext(patch, fn) : fn();
  }

  _iso() {
    return this.#clock.iso();
  }

  /** Show a refusal and return the tap result for it. */
  _refuse(reason, text, tone = 'warn') {
    return { ok: false, screen: this.screen(text, tone), reason };
  }

  /** The verified card memory (a copy). @throws {CardError} CARD_UNREADABLE, WRONG_SCHOOL */
  _readCard(card) {
    if (!card || typeof card.read !== 'function') throw new TypeError('card must be a VirtualCard');
    return card.read(this.#school.cardKey, { schoolCode: this.#school.code });
  }

  /** The card digest lists and records carry instead of the card number. */
  _digestOf(uid) {
    return cardDigest(this.#school.cardKey, this.#school.code, uid);
  }

  /** card.credit() with this school's key. @throws {CardError|PowerCutError} */
  _creditCard(card, { amountSen, write, failMode }) {
    return card.credit({ cardKey: this.#school.cardKey, amountSen, write, failMode, schoolCode: this.#school.code });
  }

  /** Note this machine's block-list version on the card (it never lowers it). */
  _setCardListVersion(card) {
    return card.setListVersion({ cardKey: this.#school.cardKey, version: this.#config.blocklist.version, schoolCode: this.#school.code });
  }

  /** Prices and settings (frozen) for a sale; null before both were received. */
  _sellingConfig() {
    const { prices, settings } = this.#config;
    return prices.content && settings.content ? { prices, settings } : null;
  }

  /**
   * Checks before any sale, in order: never received a block list (card unavailable, as
   * DESIGN says), no prices or settings yet, no room left in the journal.
   * @returns {object|null} the refusal, or null to go on
   */
  _saleGate() {
    if (this.#config.blocklist.version === 0) return this._refuse('NO_BLOCKLIST', SCREEN_CARD_UNAVAILABLE, 'error');
    if (!this._sellingConfig()) return this._refuse('NOT_READY', SCREEN_NOT_READY, 'error');
    if (!this.#journalHasRoom()) return this._refuse('JOURNAL_FULL', SCREEN_JOURNAL_FULL, 'error');
    return null;
  }

  /**
   * Read the card and check it may be used here: MAC, school, block list (the card.read
   * step). The screen never says which (SCREEN_CARD_UNAVAILABLE); `reason` is for the lab
   * console.
   * @returns {{ memory: object, digest: string, last4: string } | { refusal: object }}
   */
  _admitCard(card) {
    let memory;
    try {
      memory = this._readCard(card);
    } catch (err) {
      if (!(err instanceof CardError)) throw err;
      this._cardReadStep(null, err.code);
      return { refusal: this._refuse(err.code, SCREEN_CARD_UNAVAILABLE, 'error') };
    }
    const digest = this._digestOf(memory.uid);
    // An old list still blocks: it is complete for every card it names.
    if (this.#blocked.has(digest)) {
      this._cardReadStep(memory, 'BLOCKED');
      return { refusal: this._refuse('BLOCKED', SCREEN_CARD_UNAVAILABLE, 'error') };
    }
    this._cardReadStep(memory);
    return { memory, digest, last4: last4(memory.uid) };
  }

  /**
   * Today's (KL day) purchases on the card's own records, whichever machine made them, and
   * the time of its last record.
   * @returns {{ totalSen: number, count: number, lastAtMs: number|null }}
   */
  _dayStats(memory) {
    const now = this.#clock.now();
    const today = klDay(now);
    let totalSen = 0;
    let count = 0;
    for (const r of memory.records) {
      const at = parseIso(r?.at);
      if (Number.isNaN(at) || klDay(at) !== today) continue;
      count += 1;
      if (isSen(r.amountSen)) totalSen += r.amountSen;
    }
    const lastAt = parseIso(memory.records.at(-1)?.at);
    return { totalSen, count, lastAtMs: Number.isNaN(lastAt) ? null : lastAt };
  }

  /** Milliseconds the card still has to wait before the next purchase (0: none). */
  _tapGapLeftMs(day) {
    if (day.lastAtMs === null) return 0;
    const gapMs = this.#config.settings.content.tapGapSeconds * 1000;
    return Math.max(0, gapMs - (this.#clock.now() - day.lastAtMs));
  }

  /**
   * Refuse with the plain message of one tap rule.
   * @param {'CLOSED'|'GROUP_NOT_ALLOWED'|'PER_PURCHASE_LIMIT'|'DAILY_LIMIT'|'DAILY_COUNT'|'TAP_GAP'|'INSUFFICIENT_BALANCE'} reason
   * @param {{ memory?: object, day?: object, waitMs?: number }} [context]  TAP_GAP takes the
   *   wait its check measured, or works it out from `day`
   */
  _refuseRule(reason, { memory, day, waitMs } = {}) {
    const s = this.#config.settings.content;
    let text;
    switch (reason) {
      case 'CLOSED':
        text = SCREEN_CLOSED;
        break;
      case 'GROUP_NOT_ALLOWED':
        text = `${memory.group === 'STAFF' ? 'Staff' : 'Student'} cards are not accepted here`;
        break;
      case 'PER_PURCHASE_LIMIT':
        text = `Above the limit of ${formatRM(s.perPurchaseMaxSen)} per purchase`;
        break;
      case 'DAILY_LIMIT':
        text = `Daily limit of ${formatRM(s.dailyMaxSen)} reached`;
        break;
      case 'DAILY_COUNT':
        text = `Daily limit of ${s.dailyMaxCount} purchases reached`;
        break;
      case 'TAP_GAP':
        text = `Please wait ${Math.ceil((waitMs ?? this._tapGapLeftMs(day)) / 1000)} s and tap again`;
        break;
      case 'INSUFFICIENT_BALANCE':
        text = `${SCREEN_NOT_ENOUGH_BALANCE} · Balance ${formatRM(memory.balanceSen)}`;
        break;
      default:
        throw new TypeError(`unknown tap rule ${reason}`);
    }
    return this._refuse(reason, text, 'warn');
  }

  /**
   * Start checking the tap rules for one card. Each rule checked is recorded for the rules
   * step (DESIGN §11.2): `check(rule, ok, fields)` records one and says whether it passed (stop
   * at the first that fails, like the machine); `finish(amountSen, extra)` emits the step and
   * returns the refusal of the rule that failed, or null when every one passed.
   * @param {object} memory  the memory _admitCard read
   * @returns {{ check(rule: string, ok: boolean, fields?: object): boolean,
   *   finish(amountSen: number, extra?: object): object|null }}
   */
  _tapRules(memory) {
    const checks = [];
    let failed = null;
    return {
      check: (rule, ok, fields = {}) => {
        checks.push({ rule, ok, ...fields });
        if (!ok && !failed) failed = checks.at(-1);
        return ok;
      },
      finish: (amountSen, extra = {}) => {
        this._step('rules', !failed, { amountSen, ...extra, checks });
        return failed ? this._refuseRule(RULE_REFUSALS[failed.rule], { memory, waitMs: failed.waitMs }) : null;
      },
    };
  }

  /**
   * Window and holder group, the rules that do not depend on the amount.
   * @param {object} memory
   * @param {ReturnType<Terminal['_tapRules']>} rules
   * @returns {boolean} both passed
   */
  _checkWindowAndGroup(memory, rules) {
    const s = this.#config.settings.content;
    const open = inWindows(this.#clock.now(), s.mealWindows);
    return rules.check('window', open, { open }) && rules.check('group', s.allowedGroups.includes(memory.group), { group: memory.group });
  }

  /**
   * Every plain-message rule for a purchase of a known amount, in DESIGN order: window,
   * group, per purchase, daily total, daily count, tap gap, balance (the rules step).
   * @returns {object|null} the refusal, or null when the purchase may go ahead
   */
  _checkRules(memory, amountSen) {
    const s = this.#config.settings.content;
    const rules = this._tapRules(memory);
    const verdict = () => rules.finish(amountSen);
    if (!this._checkWindowAndGroup(memory, rules)) return verdict();
    if (!rules.check('perPurchase', amountSen <= s.perPurchaseMaxSen, { limitSen: s.perPurchaseMaxSen })) return verdict();
    const day = this._dayStats(memory);
    if (!rules.check('dailyTotal', day.totalSen + amountSen <= s.dailyMaxSen, { usedSen: day.totalSen, limitSen: s.dailyMaxSen })) {
      return verdict();
    }
    if (!rules.check('dailyCount', day.count < s.dailyMaxCount, { count: day.count, limit: s.dailyMaxCount })) return verdict();
    const waitMs = this._tapGapLeftMs(day);
    if (!rules.check('tapGap', waitMs === 0, { waitMs })) return verdict();
    rules.check('balance', memory.balanceSen >= amountSen, { balanceSen: memory.balanceSen });
    return verdict();
  }

  /**
   * Charge the card, journal the completed record, show `describe(record)`, then send the
   * record if online (sale.recorded / water.recorded) and mark it sent on its PUBACK.
   * The txn number is taken only when the card write succeeds, so numbers have no gaps.
   * @param {object} card
   * @param {object} memory  the memory _admitCard read
   * @param {object} purchase  kind, card, last4, amountSen, items | ml + perLitreSen, priceVersion
   * @param {(record: object) => string} describe  the success screen
   * @returns {Promise<{ ok: boolean, screen: string, record?: object, sent?: boolean, reason?: string }>}
   */
  async _sell(card, memory, purchase, describe) {
    const n = this.#txnCounter + 1;
    const record = {
      txn: deviceTxnNo(this.#device.code, n),
      origin: this.#device.code,
      ...purchase,
      listVersion: this.#config.blocklist.version,
      at: this.#clock.iso(),
      currency: 'MYR',
    };
    let debit;
    try {
      debit = card.debit({ cardKey: this.#school.cardKey, amountSen: purchase.amountSen, record, schoolCode: this.#school.code });
    } catch (err) {
      // The checks passed a moment ago, so only a card changed in between gets here.
      if (!(err instanceof CardError)) throw err;
      if (err.code === 'INSUFFICIENT_BALANCE') return this._refuseRule('INSUFFICIENT_BALANCE', { memory });
      return this._refuse(err.code, SCREEN_CARD_UNAVAILABLE, 'error');
    }
    this.#txnCounter = n;
    const entry = this.#addToJournal(debit.record);
    this._emit('card.write', {
      device: this.#device.code,
      uid: memory.uid,
      kind: 'debit',
      amountSen: purchase.amountSen,
      balanceAfterSen: debit.balanceAfterSen,
    });
    this._step('journal', true, { txn: debit.record.txn, unsent: this.#unsentCount() });
    const text = this.screen(describe(debit.record), 'ok');
    const sent = await this.#deliver(entry);
    return { ok: true, screen: text, record: structuredClone(debit.record), sent };
  }

  #journalHasRoom() {
    return this.#journal.length < this.#journalMax || this.#journal.some((e) => e.sent && !e.inFlight);
  }

  #addToJournal(record) {
    if (this.#journal.length >= this.#journalMax) {
      const oldestSent = this.#journal.findIndex((e) => e.sent && !e.inFlight);
      if (oldestSent >= 0) this.#journal.splice(oldestSent, 1);
    }
    const entry = { record: deepFreeze(record), sent: false, inFlight: false };
    this.#journal.push(entry);
    return entry;
  }

  async #deliver(entry) {
    const type = entry.record.kind === 'WATER' ? 'water.recorded' : 'sale.recorded';
    // the record waits in the journal for the next connection
    if (!this.connected) return this.#notSent(type, entry.record.txn);
    entry.inFlight = true;
    let sent = false;
    try {
      sent = await this.publishUp(type, { record: entry.record }, { txn: entry.record.txn });
    } finally {
      entry.inFlight = false;
      if (sent) entry.sent = true;
    }
    return sent;
  }

  #note(level, message, meta = {}) {
    try {
      this.#log?.(level, message, { school: this.#school.code, device: this.#device.code, ...meta });
    } catch {
      // a broken logger must not break the machine
    }
  }
}
