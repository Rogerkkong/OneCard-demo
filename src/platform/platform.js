import { randomBytes } from 'node:crypto';
import mqtt from 'mqtt';
import { LabError, isLabError } from '../shared/errors.js';
import { signEnvelope } from '../shared/crypto.js';
import {
  CONFIG_KINDS,
  DEVICE_CODE_RE,
  DOWN_TYPES,
  SCHOOL_CODE_RE,
  TOPIC_ROOT,
  buildEnvelope,
  commandTopic,
} from '../shared/protocol.js';
import { toIso } from '../shared/time.js';
import { createSchools } from './schools.js';
import { createDevices } from './devices.js';
import { createConfigs, DEFAULT_PRICES, DEFAULT_SETTINGS } from './configs.js';
import { createLedger } from './ledger.js';
import { createDifferences } from './differences.js';
import { createTopups } from './topups.js';
import { createSettlement } from './settlement.js';
import { createReconcile } from './reconcile.js';
import { createIntake } from './intake.js';

// The platform facade (docs/DESIGN.md §4.9): builds every service, keeps the platform's own
// MQTT connection, and runs the actions that span several services and the network: a lost
// card is blocked and the new block list goes out to the school's machines, a school is
// suspended and its machines are pushed off the broker, a new school is onboarded whole.
//
// Data changes are committed first, in one transaction; publishing comes after. When the
// broker cannot be reached an action still keeps its change and says `published: false`, so
// the office can see the machines did not hear of it yet. Publishing itself never queues
// silently: without a broker connection it fails with BROKER_UNAVAILABLE (503). Retained
// settings are published again after every (re)connect, because a restarted broker has lost
// them.

/** Client id of the platform's broker connection. Its session is kept (clean: false) across reconnects. */
export const PLATFORM_CLIENT_ID = 'onecard-platform';

// The platform's broker account (DESIGN §3 "Topics and broker accounts").
const PLATFORM_USERNAME = 'platform';
const UPLINK_FILTERS = Object.freeze([`${TOPIC_ROOT}/+/+/records`, `${TOPIC_ROOT}/+/+/status`]);
/** The command message carrying each retained kind. */
const CONFIG_COMMAND_TYPES = Object.freeze({ prices: 'config.prices', settings: 'config.settings', blocklist: 'blocklist.snapshot' });
const CONNECT_TIMEOUT_MS = 5000;
const PUBACK_TIMEOUT_MS = 5000;
const DEFAULT_RECONNECT_MS = 1000;
const MAX_TENANT_LIST = 100; // staff or machines named when onboarding a school
const MAX_DEMO_MEMBERS = 200;

// Demo members of a new school. Invented names: "Contoh", "Teladan", "Sampel" and "Ujian"
// are Malay for example, model, sample and test.
const DEMO_GIVEN_NAMES = Object.freeze([
  'Aina', 'Boon Keat', 'Chitra', 'Darwisy', 'Elaine', 'Farid', 'Gayathri', 'Hakimi', 'Ivy', 'Jun Wei',
  'Kamala', 'Luqman', 'Mei Xin', 'Naveen', 'Puteri', 'Qistina', 'Rajesh', 'Syafiq', 'Tze Yan', 'Umairah',
]);
const DEMO_FAMILY_NAMES = Object.freeze(['Contoh', 'Teladan', 'Sampel', 'Ujian']);
/** Name of the n-th demo member (1-based): every given name with one family name, then the next. */
const demoName = (n) =>
  `${DEMO_GIVEN_NAMES[(n - 1) % DEMO_GIVEN_NAMES.length]} ${DEMO_FAMILY_NAMES[Math.floor((n - 1) / DEMO_GIVEN_NAMES.length) % DEMO_FAMILY_NAMES.length]}`;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const brokerUnavailable = (reason) =>
  new LabError('BROKER_UNAVAILABLE', 'the platform is not connected to the MQTT broker', 503, reason ? { reason: String(reason).slice(0, 200) } : undefined);
const isBlockEntry = (e) => isPlainObject(e) && typeof e.card === 'string' && typeof e.last4 === 'string';
const isVersion = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * The whole platform: every service, the MQTT link to the broker and the cross-service actions.
 * @param {object} ctx  see docs/DESIGN.md "The context object"
 * @param {{ broker?: object | (() => object|null) }} [deps]  the broker from startBroker(), used to
 *   kick machines that are switched off; a function returning the current broker also works
 *   (the lab restarts its broker), and setBroker() replaces it later
 */
export function createPlatform(ctx, deps = {}) {
  const { db, clock, events } = ctx;

  const schools = createSchools(ctx);
  const devices = createDevices(ctx);
  const configs = createConfigs(ctx, { schools });
  const ledger = createLedger(ctx);
  const differences = createDifferences(ctx);
  const topups = createTopups(ctx, { ledger, schools, differences });
  const settlement = createSettlement(ctx, { ledger, schools, configs, devices, differences });
  const reconcile = createReconcile(ctx, { ledger, schools, configs, devices, differences });
  const intake = createIntake(ctx, { schools, devices, configs, settlement, reconcile });
  const services = Object.freeze({ schools, devices, configs, ledger, topups, settlement, reconcile, differences, intake });

  let brokerRef = deps?.broker ?? null;
  let client = null; // the platform's MQTT client, while connectMqtt() is in force
  let clientUrl = null;
  // The client whose connection has the machines' topics subscribed: from then on what a machine
  // publishes reaches intake, or waits for it at the broker. A fresh broker drops it before.
  let subscribedClient = null;
  let linkQueue = Promise.resolve(); // connectMqtt / disconnectMqtt run one at a time, in call order
  const commandSeqs = new Map(); // device id -> last seq the platform used towards it
  const inFlight = new Set(); // publishes waiting for their PUBACK

  function note(level, message, meta) {
    try {
      ctx.log?.(level, message, meta);
    } catch {
      // a broken logger must not break the platform
    }
  }

  function requireSchool(schoolId) {
    const school = schools.getSchool(schoolId);
    if (!school) throw new LabError('SCHOOL_NOT_FOUND', 'no such school', 404);
    return school;
  }

  // ---- broker: kicking machines --------------------------------------------------------

  function currentBroker() {
    try {
      return (typeof brokerRef === 'function' ? brokerRef() : brokerRef) ?? null;
    } catch {
      return null;
    }
  }

  /** Disconnect a machine's broker sessions now. @returns {number} connections closed (0 without a broker) */
  function kick(schoolCode, deviceCode) {
    const broker = currentBroker();
    if (typeof broker?.kick !== 'function') return 0;
    try {
      return Number(broker.kick(`${schoolCode}.${deviceCode}`)) || 0;
    } catch (err) {
      note('warn', 'could not kick a machine off the broker', { school: schoolCode, device: deviceCode, error: err?.message });
      return 0;
    }
  }

  // ---- MQTT: publishing ------------------------------------------------------------------

  function requireConnected() {
    if (!client?.connected) throw brokerUnavailable('not connected');
    return client;
  }

  /**
   * One QoS 1 publish, resolved on its PUBACK. A message the broker never acknowledged (the
   * link dropped, or no answer in time) fails with BROKER_UNAVAILABLE and is taken back, so
   * mqtt.js does not quietly send it again after reconnecting.
   */
  function publishRaw(c, topic, payload, retain) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const entry = { client: c, fail: (err) => settle(err) };
      const settle = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        inFlight.delete(entry);
        if (err) reject(isLabError(err) ? err : brokerUnavailable(err?.message));
        else resolve();
      };
      const callback = (err) => settle(err);
      timer = setTimeout(() => {
        // settled first: taking the message back calls `callback` at once with "Message removed"
        settle(new Error('no PUBACK from the broker in time'));
        for (const [id, pending] of Object.entries(c.outgoing ?? {})) {
          if (pending?.cb !== callback) continue;
          try {
            c.removeOutgoingMessage(Number(id));
          } catch {
            // the client's store is already closed: nothing left to resend
          }
        }
      }, PUBACK_TIMEOUT_MS);
      timer.unref?.();
      inFlight.add(entry);
      try {
        c.publish(topic, payload, { qos: 1, retain }, callback);
      } catch (err) {
        settle(err);
      }
    });
  }

  /** Fail every publish of `c` still waiting for its PUBACK (the connection is gone), and take them back. */
  function failInFlight(c, reason) {
    for (const entry of [...inFlight]) if (entry.client === c) entry.fail(new Error(reason));
    for (const id of Object.keys(c.outgoing ?? {})) {
      try {
        c.removeOutgoingMessage(Number(id)); // so mqtt.js does not resend it after reconnecting
      } catch {
        // the client's store is already closed
      }
    }
  }

  function nextCommandSeq(deviceId) {
    const seq = (commandSeqs.get(deviceId) ?? 0) + 1;
    commandSeqs.set(deviceId, seq);
    return seq;
  }

  /** Sign a command with the machine's own secret and publish it on the kind's own sub-topic. */
  async function sendCommand(c, school, device, type, body, retain) {
    const found = devices.resolveByCodes(school.code, device.code);
    if (!found) throw new LabError('DEVICE_NOT_FOUND', 'no such device in this school', 404);
    const envelope = signEnvelope(
      found.secret,
      buildEnvelope({ school: school.code, device: device.code, seq: nextCommandSeq(device.id), at: clock.iso(), type, body }),
    );
    await publishRaw(c, commandTopic(school.code, device.code, DOWN_TYPES[type]), JSON.stringify(envelope), retain);
    return envelope;
  }

  /** Wait for every publish; the first failure is the result. */
  async function settleAll(promises) {
    const results = await Promise.allSettled(promises);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map((r) => r.value);
  }

  /** The machines a command goes to: one named machine, or every ACTIVE machine of the school. */
  function targetDevices(school, deviceCode) {
    if (deviceCode !== undefined && deviceCode !== null) {
      const device = devices.getDeviceByCode(school.id, deviceCode);
      if (!device) throw new LabError('DEVICE_NOT_FOUND', 'no such device in this school', 404);
      return [device];
    }
    return devices.listDevices(school.id).filter((d) => d.status === 'ACTIVE');
  }

  /** Command body of a config version (DESIGN §3 "Message types"): times as ISO-8601 text. */
  function configBody(kind, current) {
    const { version, content } = current;
    if (kind === 'prices') {
      return { version, effectiveFrom: toIso(current.effectiveFrom), currency: 'MYR', items: content.items, water: content.water };
    }
    if (kind === 'settings') {
      const { mealWindows, allowedGroups, perPurchaseMaxSen, dailyMaxSen, dailyMaxCount, tapGapSeconds } = content;
      return { version, effectiveFrom: toIso(current.effectiveFrom), mealWindows, allowedGroups, perPurchaseMaxSen, dailyMaxSen, dailyMaxCount, tapGapSeconds };
    }
    return { version, entries: content.entries };
  }

  /**
   * Publish the current prices, settings or block list, signed per machine, RETAINED on the
   * kind's own sub-topic, to every ACTIVE machine of the school (or the one named). Nothing to
   * send (no version yet, no machine) is not an error.
   * Codes: CONFIG_INVALID (unknown kind), SCHOOL_NOT_FOUND (404), DEVICE_NOT_FOUND (404),
   * BROKER_UNAVAILABLE (503).
   * @param {string} schoolId
   * @param {'prices'|'settings'|'blocklist'} kind
   * @param {{ deviceCode?: string }} [options]
   * @returns {Promise<{ kind: string, version: number, devices: string[] }>} the machines it went to
   */
  async function publishConfig(schoolId, kind, options = {}) {
    const { deviceCode } = options ?? {};
    if (!CONFIG_KINDS.includes(kind)) throw new LabError('CONFIG_INVALID', `kind must be one of ${CONFIG_KINDS.join(', ')}`, 400);
    const school = requireSchool(schoolId);
    const targets = targetDevices(school, deviceCode);
    const current = configs.current(school.id, kind);
    const version = current?.version ?? 0;
    // a machine refuses version 0, and a school without any version has nothing to say yet
    if (version < 1 || targets.length === 0) return { kind, version, devices: [] };
    const c = requireConnected();
    const body = configBody(kind, current);
    // every PUBLISH is handed to the client before the first await, so a later call always lands after this one
    await settleAll(targets.map((device) => sendCommand(c, school, device, CONFIG_COMMAND_TYPES[kind], body, true)));
    return { kind, version, devices: targets.map((d) => d.code) };
  }

  /**
   * Publish a block-list change (configs.blockListDelta) to every ACTIVE machine of the
   * school, not retained: a machine on exactly `fromVersion` applies it at once, any other
   * waits for the retained snapshot. A null delta, or one that changes nothing, sends nothing.
   * Codes: SCHOOL_NOT_FOUND (404), DELTA_INVALID (400), BROKER_UNAVAILABLE (503).
   * @returns {Promise<{ fromVersion: number|null, toVersion: number|null, devices: string[] }>}
   */
  async function publishBlockListDelta(schoolId, delta) {
    const school = requireSchool(schoolId);
    if (delta === null || delta === undefined) return { fromVersion: null, toVersion: null, devices: [] };
    if (
      !isPlainObject(delta) || !isVersion(delta.fromVersion) || !isVersion(delta.toVersion) ||
      !Array.isArray(delta.added) || !delta.added.every(isBlockEntry) ||
      !Array.isArray(delta.removed) || !delta.removed.every((d) => typeof d === 'string')
    ) {
      throw new LabError('DELTA_INVALID', 'delta must be { fromVersion, toVersion, added: [{ card, last4 }], removed: [card] }', 400);
    }
    const { fromVersion, toVersion } = delta;
    const targets = targetDevices(school);
    if (toVersion <= fromVersion || targets.length === 0) return { fromVersion, toVersion, devices: [] };
    const c = requireConnected();
    const body = { fromVersion, toVersion, added: delta.added.map(({ card, last4 }) => ({ card, last4 })), removed: [...delta.removed] };
    await settleAll(targets.map((device) => sendCommand(c, school, device, 'blocklist.delta', body, false)));
    return { fromVersion, toVersion, devices: targets.map((d) => d.code) };
  }

  /**
   * Tell one machine to upload its journal or send a heartbeat now (not retained).
   * `type` is 'control.upload-journal' or 'control.heartbeat-now' ('upload-journal' and
   * 'heartbeat-now' work too).
   * Codes: CONTROL_INVALID (400), SCHOOL_NOT_FOUND (404), DEVICE_NOT_FOUND (404), BROKER_UNAVAILABLE (503).
   * @returns {Promise<{ deviceCode: string, type: string, messageId: string }>}
   */
  async function sendControl(schoolId, deviceCode, type) {
    const fullType = typeof type === 'string' && !type.startsWith('control.') ? `control.${type}` : type;
    if (typeof fullType !== 'string' || !Object.hasOwn(DOWN_TYPES, fullType) || DOWN_TYPES[fullType] !== 'control') {
      throw new LabError('CONTROL_INVALID', 'type must be control.upload-journal or control.heartbeat-now', 400);
    }
    const school = requireSchool(schoolId);
    const [device] = targetDevices(school, deviceCode ?? '');
    const c = requireConnected();
    const envelope = await sendCommand(c, school, device, fullType, {}, false);
    return { deviceCode: device.code, type: fullType, messageId: envelope.id };
  }

  /** Run a publish whose failure must not undo a committed change. @returns {Promise<boolean>} published */
  async function attempt(what, fn) {
    try {
      await fn();
      return true;
    } catch (err) {
      const brokerDown = isLabError(err) && err.code === 'BROKER_UNAVAILABLE';
      note(brokerDown ? 'warn' : 'error', `could not publish ${what}`, { error: err?.message, code: err?.code });
      return false;
    }
  }

  /** The block list after a card was blocked or freed: the retained snapshot, then the change. */
  function publishBlockListChange(schoolId, change) {
    return attempt('the block list', async () => {
      await publishConfig(schoolId, 'blocklist');
      if (change.changed) await publishBlockListDelta(schoolId, configs.blockListDelta(schoolId, change.version - 1));
    });
  }

  /** Every retained setting of the school, to the machines named (all ACTIVE ones when none are named). */
  function publishSchoolSettings(schoolId, deviceCodes) {
    const jobs = (codes) =>
      codes === undefined
        ? CONFIG_KINDS.map((kind) => publishConfig(schoolId, kind))
        : CONFIG_KINDS.flatMap((kind) => codes.map((deviceCode) => publishConfig(schoolId, kind, { deviceCode })));
    return attempt('the retained settings', () => settleAll(jobs(deviceCodes)));
  }

  /** Settings for machines that just appeared: only "if connected", as they find them retained anyway. */
  async function publishToNewMachines(schoolId, deviceCodes) {
    if (deviceCodes.length === 0) return true;
    if (!client?.connected) return false;
    return publishSchoolSettings(schoolId, deviceCodes);
  }

  /** After every (re)connect: every retained setting, for every ACTIVE machine of every ACTIVE school. */
  async function republishAll() {
    const jobs = [];
    for (const school of schools.listSchools()) {
      if (school.status !== 'ACTIVE') continue;
      for (const kind of CONFIG_KINDS) jobs.push(publishConfig(school.id, kind));
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) note('warn', 'could not republish every retained setting', { failed: failed.length, error: failed[0].reason?.message });
    return failed.length === 0;
  }

  // ---- MQTT: the connection -------------------------------------------------------------

  /** Device messages go straight to intake, which never throws. */
  function onMessage(topic, payload) {
    try {
      intake.handle(topic, payload);
    } catch (err) {
      note('error', 'intake threw', { topic, error: err?.message });
    }
  }

  /** On every (re)connect: subscribe, then republish the retained settings. @returns {Promise<boolean>} subscribed */
  async function whenConnected(c) {
    try {
      await c.subscribeAsync([...UPLINK_FILTERS], { qos: 1 });
    } catch (err) {
      note('error', 'the platform could not subscribe to the machines\' topics', { error: err?.message });
      return false;
    }
    if (c !== client || !c.connected) return false;
    subscribedClient = c;
    await republishAll();
    return true;
  }

  /** Resolves on the first CONNACK, rejects on the first failure (no retries counted). */
  function firstConnection(c) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        c.off('connect', onConnect);
        c.off('error', onError);
        c.off('close', onClose);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('the connection closed before the broker accepted the login'));
      };
      c.on('connect', onConnect);
      c.on('error', onError);
      c.on('close', onClose);
    });
  }

  const endClient = (c) =>
    new Promise((resolve) => {
      try {
        c.end(true, () => resolve());
      } catch {
        resolve();
      }
    });

  /** Run link changes one after another: two overlapping connects would otherwise leave a client behind. */
  function serialized(fn) {
    const run = linkQueue.then(fn);
    linkQueue = run.catch(() => {});
    return run;
  }

  /**
   * Connect to the broker as the platform account, subscribe to every machine's records and
   * status (QoS 1) and feed each message to intake. Resolves once connected, subscribed and the
   * retained settings are republished; replaces any earlier connection. The client reconnects
   * by itself after a broker restart, and republishes again each time. One platform per
   * broker: two platforms with the same client id would keep taking the session from each other.
   * Codes: BROKER_URL_INVALID (400), BROKER_UNAVAILABLE (503: refused, unreachable, the
   * subscription was refused, or the link was closed meanwhile).
   * @param {string} brokerUrl  e.g. mqtt://127.0.0.1:1883
   * @param {{ clientId?: string, reconnectMs?: number }} [options]
   * @returns {Promise<{ url: string, clientId: string }>}
   */
  function connectMqtt(brokerUrl, options = {}) {
    if (typeof brokerUrl !== 'string' || brokerUrl === '') {
      return Promise.reject(new LabError('BROKER_URL_INVALID', 'brokerUrl must be an MQTT URL such as mqtt://127.0.0.1:1883', 400));
    }
    return serialized(() => openLink(brokerUrl, options));
  }

  async function openLink(brokerUrl, options) {
    const { clientId = PLATFORM_CLIENT_ID, reconnectMs = DEFAULT_RECONNECT_MS } = options ?? {};
    await dropLink();
    let c;
    try {
      c = mqtt.connect(brokerUrl, {
        username: PLATFORM_USERNAME,
        password: ctx.settings?.platformBrokerPassword,
        clientId,
        // the broker keeps the platform's session, so records sent while its link is down wait for it
        clean: false,
        reconnectPeriod: reconnectMs,
        connectTimeout: CONNECT_TIMEOUT_MS,
        resubscribe: false, // whenConnected subscribes after every connect
      });
    } catch (err) {
      throw new LabError('BROKER_URL_INVALID', `cannot connect to ${brokerUrl}: ${err?.message}`, 400);
    }
    client = c;
    clientUrl = brokerUrl;
    let ready = Promise.resolve(false);
    c.on('error', (err) => note('debug', 'platform mqtt client error', { error: err?.message }));
    c.on('message', onMessage);
    c.on('connect', () => {
      ready = whenConnected(c).catch((err) => {
        note('error', 'the platform could not finish connecting', { error: err?.message });
        return false;
      });
    });
    c.on('close', () => {
      if (subscribedClient === c) subscribedClient = null;
      failInFlight(c, 'the connection to the broker closed');
    });

    const giveUp = async (reason) => {
      if (client === c) {
        client = null;
        clientUrl = null;
      }
      failInFlight(c, reason);
      await endClient(c);
      return brokerUnavailable(reason);
    };
    try {
      await firstConnection(c);
    } catch (err) {
      throw await giveUp(err?.message ?? 'cannot reach the broker');
    }
    const subscribed = await ready;
    if (client !== c) throw brokerUnavailable('the connection was closed while connecting');
    if (!subscribed) throw await giveUp('the broker refused the subscription to the machines\' topics');
    return { url: brokerUrl, clientId };
  }

  /** End the platform's broker connection (no reconnecting). Publishes still in flight fail. */
  function disconnectMqtt() {
    return serialized(dropLink);
  }

  async function dropLink() {
    const c = client;
    client = null;
    clientUrl = null;
    if (!c) return;
    failInFlight(c, 'the platform disconnected from the broker');
    await endClient(c);
  }

  // ---- orchestrations ---------------------------------------------------------------------

  /**
   * Report a card lost: mark it LOST, put it on the block list, store the block-list version
   * that first carries it, then publish the snapshot and the change. Emits card.lost.
   * Codes: SCHOOL_NOT_FOUND, CARD_NOT_FOUND (404), CARD_NOT_ACTIVE (409), CARD_UID_INVALID.
   * @returns {Promise<object>} card DTO plus `published`
   */
  async function reportCardLost({ schoolId, uid, actor } = {}) {
    const school = requireSchool(schoolId);
    const { card, change } = db.tx(() => {
      const lost = schools.markCardLost({ schoolId: school.id, uid, actor });
      const blocked = configs.blockCard({ schoolId: school.id, cardId: lost.id, actor });
      const stored = schools.setLostListVersion(school.id, lost.id, blocked.version);
      events.emit('card.lost', { uid: stored.uid, memberId: stored.memberId, blockListVersion: blocked.version }, school.code);
      return { card: stored, change: blocked };
    });
    const published = await publishBlockListChange(school.id, change);
    return { ...card, published };
  }

  /**
   * A lost card turned up: ACTIVE again and off the block list, then publish. Emits card.found.
   * Codes: SCHOOL_NOT_FOUND, CARD_NOT_FOUND (404), CARD_NOT_LOST (409), MEMBER_HAS_ACTIVE_CARD (409).
   * @returns {Promise<object>} card DTO plus `published`
   */
  async function markCardFound({ schoolId, uid, actor } = {}) {
    const school = requireSchool(schoolId);
    const { card, change } = db.tx(() => {
      const found = schools.markCardFound({ schoolId: school.id, uid, actor });
      const unblocked = configs.unblockCard({ schoolId: school.id, cardId: found.id, actor });
      events.emit('card.found', { uid: found.uid, memberId: found.memberId, blockListVersion: unblocked.version }, school.code);
      return { card: found, change: unblocked };
    });
    const published = await publishBlockListChange(school.id, change);
    return { ...card, published };
  }

  /**
   * Give a member a new card: the old ACTIVE card is reported lost first (blocked), the new one
   * issued, and the member's whole mirror balance moved into a TRANSFER order that waits at
   * the kiosk for the new card. One transaction; then the block list is published.
   * `oldCard` is the card reported lost now, or else the member's newest earlier card (null if none).
   * Codes: SCHOOL_NOT_FOUND, MEMBER_NOT_FOUND (404), CARD_UID_INVALID, CARD_UID_TAKEN (409).
   * @returns {Promise<{ oldCard: object|null, newCard: object, transferOrder: object|null, published: boolean }>}
   */
  async function replaceCard({ schoolId, memberId, newUid, actor } = {}) {
    const school = requireSchool(schoolId);
    const out = db.tx(() => {
      if (!schools.getMember(school.id, memberId)) throw new LabError('MEMBER_NOT_FOUND', 'no such member in this school', 404);
      const active = schools.activeCardForMember(school.id, memberId);
      let oldCard = null;
      let change = null;
      if (active) {
        const lost = schools.markCardLost({ schoolId: school.id, uid: active.uid, actor });
        change = configs.blockCard({ schoolId: school.id, cardId: lost.id, actor });
        oldCard = schools.setLostListVersion(school.id, lost.id, change.version);
        events.emit('card.lost', { uid: oldCard.uid, memberId, blockListVersion: change.version }, school.code);
      } else {
        oldCard = schools.listCards(school.id).filter((c) => c.memberId === memberId).at(-1) ?? null;
      }
      const newCard = schools.issueCard({ schoolId: school.id, memberId, uid: newUid, actor });
      events.emit('card.issued', { uid: newCard.uid, memberId }, school.code);
      const transferOrder = topups.createTransfer({ schoolId: school.id, memberId, actor });
      schools.audit(school.id, actor, 'card.replace', {
        memberId,
        oldCardId: oldCard?.id ?? null,
        newCardId: newCard.id,
        last4: newCard.last4,
        transferOrderId: transferOrder?.id ?? null,
        amountSen: transferOrder?.amountSen ?? 0,
      });
      return { oldCard, newCard, transferOrder, change };
    });
    const published = out.change ? await publishBlockListChange(school.id, out.change) : true;
    return { oldCard: out.oldCard, newCard: out.newCard, transferOrder: out.transferOrder, published };
  }

  async function publishKind(kind, { schoolId, content, effectiveFrom, actor } = {}) {
    const config = configs.publish({ schoolId, kind, content, effectiveFrom, actor });
    const published = await attempt(kind, () => publishConfig(schoolId, kind));
    return { ...config, published };
  }

  /**
   * Store a new price list version and publish it. Codes: CONFIG_INVALID (400), SCHOOL_NOT_FOUND (404).
   * @returns {Promise<{ kind, version, content, effectiveFrom, published }>}
   */
  function publishPrices(args) {
    return publishKind('prices', args);
  }

  /**
   * Store new device settings and publish them. Codes: CONFIG_INVALID (400), SCHOOL_NOT_FOUND (404).
   * @returns {Promise<{ kind, version, content, effectiveFrom, published }>}
   */
  function publishSettings(args) {
    return publishKind('settings', args);
  }

  /**
   * Switch a machine on or off. Not ACTIVE: it is kicked off the broker (and cannot log in
   * again). ACTIVE again: it gets the current retained settings, which it missed while off.
   * Codes: DEVICE_STATUS_INVALID, SCHOOL_NOT_FOUND (404), DEVICE_NOT_FOUND (404).
   * @returns {Promise<object>} device DTO plus `kicked` (connections closed) and `published`
   */
  async function setDeviceStatus({ schoolId, code, status, actor } = {}) {
    const school = requireSchool(schoolId);
    const device = devices.setDeviceStatus({ schoolId: school.id, code, status, actor });
    if (device.status !== 'ACTIVE') return { ...device, kicked: kick(school.code, device.code), published: true };
    const published = await publishSchoolSettings(school.id, [device.code]);
    return { ...device, kicked: 0, published };
  }

  /**
   * Suspend or reactivate a school (an operator action). SUSPENDED: every machine of the school
   * is kicked off the broker, and only that school's. ACTIVE again: its retained settings are
   * published again (a broker restart while it was suspended skipped it). Emits school.status
   * when the status changes.
   * Codes: SCHOOL_STATUS_INVALID, SCHOOL_NOT_FOUND (404).
   * @returns {Promise<object>} school DTO plus `kicked` and `published`
   */
  async function setSchoolStatus({ schoolId, status, actor } = {}) {
    const before = requireSchool(schoolId);
    const school = schools.setSchoolStatus(before.id, status, actor);
    if (school.status !== before.status) events.emit('school.status', { code: school.code, status: school.status, from: before.status }, school.code);
    if (school.status === 'SUSPENDED') {
      let kicked = 0;
      for (const device of devices.listDevices(school.id)) kicked += kick(school.code, device.code);
      return { ...school, kicked, published: true };
    }
    const published = before.status === 'ACTIVE' ? true : await publishSchoolSettings(school.id);
    return { ...school, kicked: 0, published };
  }

  /**
   * Register a machine (the secret is returned once). Emits device.registered
   * `{ code, type, location }`, then publishes the current retained settings to it if the
   * platform is connected (otherwise the next connect does).
   * Codes: SCHOOL_NOT_FOUND (404), DEVICE_CODE_INVALID, DEVICE_TYPE_INVALID, DEVICE_CODE_TAKEN (409).
   * @returns {Promise<{ device: object, secret: string, published: boolean }>}
   */
  async function registerDevice({ schoolId, code, type, location = '', actor } = {}) {
    const school = requireSchool(schoolId);
    const { device, secret } = devices.registerDevice({ schoolId: school.id, code, type, location, actor });
    events.emit('device.registered', { code: device.code, type: device.type, location: device.location }, school.code);
    const published = await publishToNewMachines(school.id, [device.code]);
    return { device, secret, published };
  }

  /**
   * Issue a card to a member and announce it (card.issued `{ uid, memberId }`: the lab makes
   * the physical virtual card). Codes: as schools.issueCard, plus SCHOOL_NOT_FOUND (404).
   * @returns card DTO
   */
  function issueCard({ schoolId, memberId, uid, actor } = {}) {
    const school = requireSchool(schoolId);
    const card = schools.issueCard({ schoolId: school.id, memberId, uid, actor });
    events.emit('card.issued', { uid: card.uid, memberId: card.memberId }, school.code);
    return card;
  }

  /** A random 7-byte card UID starting 04 (like real NFC cards), unused in the school. */
  function demoUid(schoolId, taken) {
    for (;;) {
      const uid = `04${randomBytes(6).toString('hex').toUpperCase()}`;
      if (!taken.has(uid) && !schools.getCardByUid(schoolId, uid)) {
        taken.add(uid);
        return uid;
      }
    }
  }

  /**
   * Onboard a school in one go (an operator action, one transaction): the school, its staff,
   * the default price list and settings, an empty block list (machines refuse every card
   * without one), its machines (each emitting device.registered) and optionally `demoMembers`
   * fictional members with new cards (each emitting card.issued). Emits tenant.created
   * `{ code, name }`, then publishes the retained settings to the new machines if connected.
   * Codes: TENANT_INVALID (400), SCHOOL_CODE_INVALID, SCHOOL_CODE_TAKEN (409), NAME_INVALID,
   * STAFF_ROLE_INVALID, DEVICE_CODE_INVALID, DEVICE_TYPE_INVALID, DEVICE_CODE_TAKEN (409).
   * @param {{ code: string, name: string, staff?: Array<{ name: string, role: string }>,
   *   devices?: Array<{ code: string, type: string, location?: string }>, demoMembers?: number, actor?: unknown }} args
   * @returns {Promise<{ school: object, staff: object[], devices: Array<{ device: object, secret: string }>,
   *   members: object[], published: boolean }>}
   */
  async function createTenant({ code, name, staff, devices: machines, demoMembers = 0, actor } = {}) {
    const staffList = staff ?? [];
    const machineList = machines ?? [];
    if (!Array.isArray(staffList) || staffList.length > MAX_TENANT_LIST) {
      throw new LabError('TENANT_INVALID', `staff must be a list of at most ${MAX_TENANT_LIST} { name, role }`, 400);
    }
    if (!Array.isArray(machineList) || machineList.length > MAX_TENANT_LIST) {
      throw new LabError('TENANT_INVALID', `devices must be a list of at most ${MAX_TENANT_LIST} { code, type, location }`, 400);
    }
    if (!Number.isSafeInteger(demoMembers) || demoMembers < 0 || demoMembers > MAX_DEMO_MEMBERS) {
      throw new LabError('TENANT_INVALID', `demoMembers must be a whole number from 0 to ${MAX_DEMO_MEMBERS}`, 400);
    }
    const out = db.tx(() => {
      const created = schools.createSchool({ code, name });
      const sid = created.id;
      const staffDtos = staffList.map((p) => schools.addStaff({ schoolId: sid, name: p?.name, role: p?.role }));
      configs.publish({ schoolId: sid, kind: 'prices', content: DEFAULT_PRICES, actor });
      configs.publish({ schoolId: sid, kind: 'settings', content: DEFAULT_SETTINGS, actor });
      configs.ensureBlockList({ schoolId: sid, actor });
      const registered = machineList.map((m) => {
        const r = devices.registerDevice({ schoolId: sid, code: m?.code, type: m?.type, location: m?.location ?? '', actor });
        events.emit('device.registered', { code: r.device.code, type: r.device.type, location: r.device.location }, created.code);
        return r;
      });
      const taken = new Set();
      const members = [];
      for (let i = 1; i <= demoMembers; i++) {
        const member = schools.addMember({
          schoolId: sid,
          memberNo: `D${String(i).padStart(3, '0')}`,
          name: demoName(i),
          className: `${((i - 1) % 6) + 1} Contoh`,
        });
        const card = schools.issueCard({ schoolId: sid, memberId: member.id, uid: demoUid(sid, taken), actor });
        events.emit('card.issued', { uid: card.uid, memberId: member.id }, created.code);
        members.push(schools.getMember(sid, member.id));
      }
      schools.audit(sid, actor, 'tenant.create', {
        code: created.code,
        name: created.name,
        staff: staffDtos.length,
        devices: registered.map((r) => r.device.code),
        demoMembers,
      });
      events.emit('tenant.created', { code: created.code, name: created.name }, created.code);
      return { school: schools.getSchool(sid), staff: staffDtos, devices: registered, members };
    });
    const published = await publishToNewMachines(out.school.id, out.devices.map((r) => r.device.code));
    return { ...out, published };
  }

  /** Money waiting at the kiosk for the whole school (every member's WAITING_TO_BE_ADDED). */
  function waitingSen(schoolId) {
    return ledger
      .trialBalance(schoolId)
      .accounts.filter((a) => a.kind === 'WAITING_TO_BE_ADDED')
      .reduce((sum, a) => sum + a.balanceSen, 0);
  }

  /**
   * The SaaS operator's view: one row per school (tenant), oldest first.
   * @returns {Array<{ id, code, name, status, members, cards, devices: { total, online }, todaySalesSen,
   *   waitingSen, openDifferences, createdAt }>}  members and cards count ACTIVE ones
   */
  function operatorOverview() {
    return schools.listSchools().map((school) => {
      const machines = devices.listDevices(school.id);
      return {
        id: school.id,
        code: school.code,
        name: school.name,
        status: school.status,
        members: db.get("SELECT count(*) AS n FROM member WHERE school_id = ? AND status = 'ACTIVE'", school.id).n,
        cards: db.get("SELECT count(*) AS n FROM card WHERE school_id = ? AND status = 'ACTIVE'", school.id).n,
        devices: { total: machines.length, online: machines.filter((d) => d.online).length },
        todaySalesSen: settlement.salesReport(school.id).totalSen,
        waitingSen: waitingSen(school.id),
        openDifferences: differences.countOpen(school.id),
        createdAt: school.createdAt,
      };
    });
  }

  /**
   * The scheduled jobs: top-up deadlines (topups.runJobs) and reconciliation scans
   * (reconcile.run), once per ACTIVE school (a suspended school's orders wait). Each job of
   * each school runs on its own: a failure is logged, reported in that school's row, and the
   * rest carry on. `schoolId` limits the run to that one school (if it is ACTIVE).
   * @param {{ schoolId?: string }} [options]
   * @returns {{ cancelled, refunded, parked, gaps, lag, schools: Array<{ schoolId, code, cancelled, refunded,
   *   parked, gaps, lag, errors? }> }}
   */
  function runJobs(options = {}) {
    const { schoolId } = options ?? {};
    const totals = { cancelled: 0, refunded: 0, parked: 0, gaps: 0, lag: 0 };
    const rows = [];
    for (const school of schools.listSchools()) {
      if (school.status !== 'ACTIVE') continue;
      if (schoolId !== undefined && schoolId !== null && school.id !== schoolId) continue;
      const row = { schoolId: school.id, code: school.code, cancelled: 0, refunded: 0, parked: 0, gaps: 0, lag: 0 };
      const errors = [];
      const job = (name, fn) => {
        try {
          Object.assign(row, fn());
        } catch (err) {
          errors.push({ job: name, code: err?.code ?? 'INTERNAL', message: String(err?.message ?? err).slice(0, 200) });
          note('error', `jobs: ${name} failed`, { school: school.code, error: err?.message, stack: err?.stack });
        }
      };
      job('topups', () => {
        const { cancelled, refunded, parked } = topups.runJobs({ schoolId: school.id });
        return { cancelled, refunded, parked };
      });
      job('reconcile', () => {
        const { gaps, lag } = reconcile.run(school.id);
        return { gaps, lag };
      });
      if (errors.length > 0) row.errors = errors;
      for (const key of Object.keys(totals)) totals[key] += row[key];
      rows.push(row);
    }
    return { ...totals, schools: rows };
  }

  // ---- for the lab ----------------------------------------------------------------------------

  /**
   * The broker's `resolveDevice` (DESIGN §5): '<school>.<DEVICE>' -> its login, with `active`
   * false when the machine is not ACTIVE or its school is SUSPENDED; null for anything else.
   * @returns {{ schoolCode: string, deviceCode: string, password: string, active: boolean } | null}
   */
  function resolveBrokerDevice(username) {
    if (typeof username !== 'string') return null;
    const dot = username.indexOf('.');
    if (dot < 0) return null;
    const schoolCode = username.slice(0, dot);
    const deviceCode = username.slice(dot + 1);
    if (!SCHOOL_CODE_RE.test(schoolCode) || !DEVICE_CODE_RE.test(deviceCode)) return null;
    const found = devices.resolveByCodes(schoolCode, deviceCode);
    if (!found) return null;
    const { password } = devices.brokerCredentials(schoolCode, deviceCode, found.secret);
    return { schoolCode, deviceCode, password, active: found.device.status === 'ACTIVE' && found.school.status === 'ACTIVE' };
  }

  return {
    services,
    connectMqtt,
    disconnectMqtt,
    /**
     * The platform's own broker link. `subscribed`: the machines' records and status topics are
     * subscribed on this connection (after every reconnect too), so what a machine publishes now
     * reaches intake or waits for it at the broker. A freshly started broker drops what machines
     * publish before that moment, although it acknowledges it to them.
     * @returns {{ connected: boolean, subscribed: boolean, url: string|null }}
     */
    mqttStatus: () => {
      const connected = client?.connected === true;
      return { connected, subscribed: connected && subscribedClient === client, url: clientUrl };
    },
    /** Use another broker for kicks (the lab restarted it); a function returning the broker works too. */
    setBroker(broker) {
      brokerRef = broker ?? null;
    },
    resolveBrokerDevice,
    publishConfig,
    publishBlockListDelta,
    sendControl,
    reportCardLost,
    markCardFound,
    replaceCard,
    publishPrices,
    publishSettings,
    setDeviceStatus,
    setSchoolStatus,
    registerDevice,
    issueCard,
    createTenant,
    operatorOverview,
    runJobs,
  };
}
