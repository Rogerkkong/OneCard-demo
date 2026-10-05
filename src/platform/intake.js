import { isLabError } from '../shared/errors.js';
import { verifyEnvelopeSignature } from '../shared/crypto.js';
import { CONFIG_KINDS, MAX_BATCH_RECORDS, REFUSAL, UP_TYPES, parseTopic, validateEnvelopeShape } from '../shared/protocol.js';
import { parseIso } from '../shared/time.js';

// The platform's front door for machine messages (docs/DESIGN.md §3 "Intake pipeline",
// §4.8). Every message a machine publishes on its records or status topic comes through
// handle(), which checks it step by step in the pipeline's order, records it once, and hands
// it to the service that owns it. A message is ACCEPTED, a DUPLICATE of one already
// accepted, or REFUSED with a stable code that goes to the device log and the lab console.
// Nothing is ever replied over MQTT: a machine only learns that the broker has its message.
//
// A message refused by the checks is not recorded and does not use up its seq, so the
// machine can send it again once the problem is fixed (a school reactivated, a machine
// switched back on). Recording the message, claiming its seq and everything the message
// changes happen in one transaction: a message is either wholly in the books or not at all.
//
// Simulation mode (docs/DESIGN.md §11.2): once the envelope is read, the rest of the pipeline
// runs inside the event context { msgId: <envelope id> }, so every event it causes (purchase,
// ledger, differences, its own intake event) names the message, and the lab console can follow
// it hop by hop. Each intake event lists the pipeline steps the message went through (`checks`).

/** Largest message the platform reads; a full journal batch of 200 records stays well below it. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * The pipeline steps of DESIGN §3, in order, as the intake events list them (`checks`).
 * `recorded` is step 10: the message recorded and dispatched.
 */
export const INTAKE_STEPS = Object.freeze([
  'topic', 'device', 'envelope', 'topicMatch', 'signature', 'duplicate', 'sequence', 'gates', 'typeRules', 'recorded',
]);
// What an accepted card read-back's event tells about the snapshot check (never its message text).
const SNAPSHOT_EVENT_FIELDS = Object.freeze(['checked', 'match', 'cardSen', 'mirrorSen', 'unconfirmedSen', 'laterSen', 'code']);

const ACK_RESULTS = Object.freeze(['APPLIED', 'ALREADY_APPLIED', 'REJECTED']);
// Message types only one kind of machine may send (pipeline step 9).
const SENDER_TYPES = Object.freeze({ 'sale.recorded': 'CANTEEN', 'water.recorded': 'WATER', 'card.readback': 'KIOSK' });
// How the records of each message type reach settlement (purchase.via).
const RECORD_VIAS = Object.freeze({
  'sale.recorded': 'MQTT',
  'water.recorded': 'MQTT',
  'journal.batch': 'JOURNAL_BATCH',
  'card.readback': 'KIOSK_READBACK',
});
const MAX_LABEL = 64; // longest type, txn, id or code copied into results, events and the log
const MAX_MESSAGE_TEXT = 300;
const MAX_TOPIC_SHOWN = 200;
const INTERNAL_MESSAGE = 'the platform could not process this message';

const INSERT_MESSAGE = `
  INSERT INTO inbound_message (school_id, device_id, message_id, seq, type, received_at, result)
  VALUES (?, ?, ?, ?, ?, ?, 'ACCEPTED')
  ON CONFLICT (device_id, message_id) DO NOTHING`;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
/** Short text from a message (a type, txn or id), or null: a sender's long strings never reach the console. */
const short = (v, max = MAX_LABEL) => (typeof v === 'string' && v.length <= max ? v : null);

/** A message refused at one step of the pipeline; thrown to leave the pipeline, caught by handle(). */
class Refusal extends Error {
  constructor(code, message, detail = {}) {
    super(String(message ?? REFUSAL[code] ?? code).slice(0, MAX_MESSAGE_TEXT));
    this.code = code;
    this.detail = detail;
  }
}

/** The message id turned up while recording it; thrown so the seq claim is rolled back too. */
class AlreadyRecorded extends Error {}

/**
 * Message intake for every school. `handle()` is synchronous and never throws.
 * @param {object} ctx  see docs/DESIGN.md "The context object"
 * @param {{ schools?: object, devices: object, configs: object, settlement: object, reconcile: object }} deps
 *   schools is accepted for the uniform signature (DESIGN §4.8); the school comes with the device from devices.resolveByCodes
 */
export function createIntake(ctx, { devices, configs, settlement, reconcile } = {}) {
  for (const [name, service] of Object.entries({ devices, configs, settlement, reconcile })) {
    if (!service) throw new TypeError(`createIntake needs the ${name} service`);
  }
  const { db, clock, events } = ctx;

  function note(level, message, meta) {
    try {
      ctx.log?.(level, message, meta);
    } catch {
      // a broken logger must not break intake
    }
  }

  /** Reporting (device log, events) must never turn into an exception of handle(). */
  function quietly(what, fn) {
    try {
      fn();
    } catch (err) {
      note('error', `intake could not ${what}`, { error: err?.message });
    }
  }

  // ---- the pipeline ----------------------------------------------------------------

  /** Run `fn` in the event context of one message (an older bus without contexts: just run it). */
  function inMessage(msgId, fn) {
    return typeof events?.withContext === 'function' ? events.withContext({ msgId }, fn) : fn();
  }

  /** The message passed this step of the pipeline (for the event's `checks`). */
  function pass(sender, step) {
    sender.passed = INTAKE_STEPS.indexOf(step) + 1;
  }

  /**
   * Steps 1-10 of DESIGN §3. `sender` collects what is known about the sender as the steps
   * go, so a refusal can be filed under the right machine and school, and how far the message
   * got (`passed`).
   */
  function run(topic, payload, sender) {
    // 1. A device topic, on the records or status channel.
    const where = parseTopic(topic);
    if (!where || (where.channel !== 'records' && where.channel !== 'status')) {
      throw new Refusal('TOPIC_INVALID', undefined, { topic: short(topic, MAX_TOPIC_SHOWN) });
    }
    // The codes the topic claims: the lab console files the event under that school, as the broker does.
    sender.schoolCode = where.school;
    sender.deviceCode = where.device;
    pass(sender, 'topic');

    // 2. A machine the platform knows. From here on a refusal goes to that machine's own log.
    const found = devices.resolveByCodes(where.school, where.device);
    if (!found) {
      throw new Refusal('UNKNOWN_DEVICE', `no machine ${where.device} in school ${where.school}`, { school: where.school, device: where.device });
    }
    sender.schoolId = found.school.id;
    sender.deviceId = found.device.id;
    pass(sender, 'device');

    // 3. JSON with the shape of an envelope.
    const env = readEnvelope(payload, sender);
    pass(sender, 'envelope');

    // The rest, and how it ends (accepted, duplicate or refused), carries the message id.
    return inMessage(env.id, () => {
      try {
        return checkAndRecord(where, found, env, sender);
      } catch (err) {
        return settle(sender, err);
      }
    });
  }

  /** Steps 4-10, for an envelope read from the topic `where` of the machine `found`. */
  function checkAndRecord(where, { school, device, secret }, env, sender) {
    // 4. The envelope names the topic's school and machine, and its type belongs on this channel.
    if (env.school !== where.school || env.device !== where.device) {
      throw new Refusal('TOPIC_MISMATCH', `the envelope names ${env.school}/${env.device} but came on the topic of ${where.school}/${where.device}`, {
        envelope: { school: env.school, device: env.device },
      });
    }
    const channel = own(UP_TYPES, env.type);
    if (channel !== where.channel) {
      throw new Refusal(
        'TOPIC_MISMATCH',
        channel ? `${env.type} belongs on the ${channel} topic, not ${where.channel}` : `${env.type} is not a message a machine sends`,
        { channel: where.channel },
      );
    }
    pass(sender, 'topicMatch');

    // 5. Signed with this machine's secret (the topic alone is only the broker's word).
    if (!verifyEnvelopeSignature(secret, env)) throw new Refusal('SIGNATURE_INVALID');
    pass(sender, 'signature');

    // 6. Already accepted: nothing else happens.
    const seen = recordedMessage(school.id, device.id, env.id);
    if (seen) return duplicate(sender, env, seen);
    pass(sender, 'duplicate');

    // 7. Sequence numbers only go up. Only read here: the seq is claimed when the message is recorded.
    if (env.seq <= device.lastSeq) {
      throw new Refusal('SEQUENCE_ROLLBACK', `seq ${env.seq} is not higher than ${device.lastSeq}, the last one accepted from this machine`, {
        seq: env.seq,
        lastSeq: device.lastSeq,
      });
    }
    pass(sender, 'sequence');

    // 8. Gates. A suspended school's whole message is refused; the machine keeps its records.
    if (school.status !== 'ACTIVE') throw new Refusal('SCHOOL_SUSPENDED');
    if (device.status !== 'ACTIVE') throw new Refusal('DEVICE_DISABLED', `the machine is ${device.status}`, { status: device.status });
    pass(sender, 'gates');

    // 9. Who may send what, and what the body must hold.
    checkTypeRules(env, device);
    pass(sender, 'typeRules');

    // 10. Record the message id and seq, then dispatch, in one transaction.
    let outcome;
    try {
      outcome = db.tx(() => {
        if (devices.claimSeq(device.id, env.seq) !== 'OK') {
          throw new Refusal('SEQUENCE_ROLLBACK', `seq ${env.seq} was overtaken by another message from this machine`, { seq: env.seq });
        }
        const { changes } = db.run(INSERT_MESSAGE, school.id, device.id, env.id, env.seq, env.type, clock.now());
        if (changes === 0) throw new AlreadyRecorded();
        const result = dispatch({ env, school, device });
        if (result.result !== 'ACCEPTED') {
          db.run(
            'UPDATE inbound_message SET result = ? WHERE school_id = ? AND device_id = ? AND message_id = ?',
            result.result, school.id, device.id, env.id,
          );
        }
        return result;
      });
    } catch (err) {
      if (err instanceof AlreadyRecorded) return duplicate(sender, env, recordedMessage(school.id, device.id, env.id));
      throw err;
    }
    // a message whose one record settlement refused was recorded, but ends refused at this step
    if (outcome.result === 'ACCEPTED') pass(sender, 'recorded');
    return finish(sender, env, outcome);
  }

  function recordedMessage(schoolId, deviceId, messageId) {
    return db.get(
      'SELECT received_at, result FROM inbound_message WHERE school_id = ? AND device_id = ? AND message_id = ?',
      schoolId, deviceId, messageId,
    );
  }

  /** Step 3: the payload as an envelope, or ENVELOPE_INVALID / VERSION_UNSUPPORTED / UNKNOWN_TYPE. */
  function readEnvelope(payload, sender) {
    let text;
    if (typeof payload === 'string') {
      if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) throw new Refusal('ENVELOPE_INVALID', `the message is larger than ${MAX_MESSAGE_BYTES} bytes`);
      text = payload;
    } else if (payload instanceof Uint8Array) {
      // a Buffer from mqtt.js, or any other byte array
      if (payload.byteLength > MAX_MESSAGE_BYTES) throw new Refusal('ENVELOPE_INVALID', `the message is larger than ${MAX_MESSAGE_BYTES} bytes`);
      text = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
    } else {
      throw new Refusal('ENVELOPE_INVALID', 'the message must be JSON text');
    }
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      throw new Refusal('ENVELOPE_INVALID', 'the message is not JSON');
    }
    if (isPlainObject(env)) {
      sender.type = short(env.type);
      sender.messageId = short(env.id);
      if (Number.isSafeInteger(env.seq)) sender.seq = env.seq;
    }
    // also UNKNOWN_TYPE for inherited names such as 'toString' (it looks types up as own properties)
    const shape = validateEnvelopeShape(env);
    if (!shape.ok) throw new Refusal(shape.code, shape.message);
    return env;
  }

  /** Step 9: WRONG_DEVICE_TYPE, the body each type needs (ENVELOPE_INVALID) and COUNT_MISMATCH. */
  function checkTypeRules(env, device) {
    const only = own(SENDER_TYPES, env.type);
    if (only && device.type !== only) {
      throw new Refusal('WRONG_DEVICE_TYPE', `${env.type} comes only from ${only} machines, and this one is a ${device.type}`, {
        deviceType: device.type,
        allowed: only,
      });
    }
    const { body } = env;
    switch (env.type) {
      case 'journal.batch': {
        if (!Array.isArray(body.records)) throw new Refusal('ENVELOPE_INVALID', 'a journal batch needs a records list');
        const n = body.records.length;
        if (body.count !== n) {
          const count = Number.isSafeInteger(body.count) ? body.count : null;
          throw new Refusal('COUNT_MISMATCH', `count says ${count ?? 'nothing usable'}, the batch carries ${n} records`, { count, records: n });
        }
        if (n < 1 || n > MAX_BATCH_RECORDS) throw new Refusal('ENVELOPE_INVALID', `a journal batch carries 1 to ${MAX_BATCH_RECORDS} records, not ${n}`);
        break;
      }
      case 'card.readback':
        // a card that was never used carries no records; the card's own fields are checked by reconcile
        if (!Array.isArray(body.records) || body.records.length > MAX_BATCH_RECORDS) {
          throw new Refusal('ENVELOPE_INVALID', `a card read-back needs a records list of at most ${MAX_BATCH_RECORDS} records`);
        }
        break;
      case 'command.ack':
        if (
          !short(body.command) ||
          !CONFIG_KINDS.includes(body.kind) ||
          !ACK_RESULTS.includes(body.result) ||
          !Number.isSafeInteger(body.appliedVersion) ||
          body.appliedVersion < 0
        ) {
          throw new Refusal(
            'ENVELOPE_INVALID',
            `an ack needs command, kind (${CONFIG_KINDS.join(', ')}), result (${ACK_RESULTS.join(', ')}) and appliedVersion`,
          );
        }
        break;
      default:
        // sale.recorded / water.recorded: settlement checks the record itself;
        // device.heartbeat: whatever it reports is taken as far as it is usable
        break;
    }
  }

  // ---- dispatch (inside the recording transaction) -----------------------------------

  /** @returns {{ result: 'ACCEPTED'|'REFUSED', code?: string, detail: object }} */
  function dispatch(scope) {
    switch (scope.env.type) {
      case 'device.heartbeat':
        return heartbeat(scope);
      case 'sale.recorded':
      case 'water.recorded':
        return singleRecord(scope);
      case 'journal.batch':
        return batch(scope);
      case 'card.readback':
        return readback(scope);
      case 'command.ack':
        return ack(scope);
      default:
        throw new Error(`no handler for ${scope.env.type}`); // step 4 lets only UP_TYPES through
    }
  }

  function heartbeat({ env, school, device }) {
    const { body } = env;
    devices.recordHeartbeat({ deviceId: device.id, at: env.at, fw: body.fw, health: body.health });
    const reported = isPlainObject(body.listVersions) ? body.listVersions : {};
    const listVersions = {};
    for (const kind of CONFIG_KINDS) {
      const version = reported[kind];
      // a heartbeat still counts when one version is unusable; that one is just not stored
      if (!Number.isSafeInteger(version) || version < 0) continue;
      configs.recordListState({ deviceId: device.id, kind, version, via: 'HEARTBEAT', schoolId: school.id });
      listVersions[kind] = version;
    }
    const detail = { listVersions };
    if (Number.isSafeInteger(body.journalUnsent) && body.journalUnsent >= 0) detail.journalUnsent = body.journalUnsent;
    return { result: 'ACCEPTED', detail };
  }

  /** sale.recorded / water.recorded: the message stands or falls with its one record. */
  function singleRecord(scope) {
    const r = receiveRecord(scope, scope.env.body.record, { alone: true });
    if (r.status === 'REFUSED') return { result: 'REFUSED', code: r.code, detail: { message: r.message, results: [r] } };
    return { result: 'ACCEPTED', detail: { results: [r] } };
  }

  /** Each record on its own: one bad record is refused alone, the others go in. */
  function batch(scope) {
    const { batchId, records } = scope.env.body;
    const results = records.map((record, index) => receiveRecord(scope, record, { index }));
    return { result: 'ACCEPTED', detail: { batchId: short(batchId), count: records.length, results } };
  }

  /**
   * What a card carries, read at the kiosk: its records first (purchases from offline machines
   * come home this way), then the card's balance against the mirror, which those records may
   * just have brought up to date. A snapshot that cannot be checked is noted in the machine's
   * log; the records already taken stay.
   */
  function readback(scope) {
    const { env, school, device } = scope;
    const { body } = env;
    const results = body.records.map((record, index) => receiveRecord(scope, record, { index }));
    let snapshot;
    try {
      // its own savepoint: a check that fails halfway leaves nothing behind
      const checked = db.tx(() =>
        reconcile.checkCardSnapshot({
          schoolId: school.id,
          cardDigest: body.card,
          balanceSen: body.balanceSen,
          cardSeq: body.cardSeq,
          // the kiosk top-ups the card itself lists (one written but never confirmed is on the card only)
          writes: body.writes ?? [],
          // when the card was read: the kiosk confirms this tap's top-ups over HTTP right after
          // the read-back, and the confirm can reach the books first (DESIGN §4.7)
          readAt: parseIso(env.at),
        }),
      );
      snapshot = { checked: true, ...checked };
    } catch (err) {
      const known = isLabError(err);
      if (!known) note('error', 'intake could not check a card snapshot', { school: school.code, device: device.code, error: err?.message, stack: err?.stack });
      const code = known ? err.code : 'INTERNAL';
      const message = known ? err.message : INTERNAL_MESSAGE;
      devices.log({
        schoolId: school.id,
        deviceId: device.id,
        level: known ? 'WARN' : 'ERROR',
        code,
        message: `card read-back: ${message}`,
        detail: { type: env.type, messageId: env.id, last4: short(body.last4) },
      });
      snapshot = { checked: false, code, message };
    }
    return { result: 'ACCEPTED', detail: { results, snapshot } };
  }

  function ack({ env, school, device }) {
    const { command, kind, result, appliedVersion, error } = env.body;
    const detail = { command, kind, ack: result, appliedVersion };
    if (result === 'REJECTED') {
      // the machine kept what it had; the office should see why
      const reason = short(error);
      devices.log({
        schoolId: school.id,
        deviceId: device.id,
        level: 'WARN',
        code: 'COMMAND_REJECTED',
        message: `the machine rejected the ${kind} command${reason ? ` (${reason})` : ''}; it runs version ${appliedVersion}`,
        detail: { command, kind, appliedVersion, error: reason },
      });
      return { result: 'ACCEPTED', detail: { ...detail, recorded: false } };
    }
    configs.recordListState({ deviceId: device.id, kind, version: appliedVersion, via: 'MQTT', schoolId: school.id });
    return { result: 'ACCEPTED', detail: { ...detail, recorded: true } };
  }

  /**
   * One purchase record to settlement. `alone`: the record is the whole message, so a failure
   * of the platform itself refuses the whole message (it can come again). In a batch or a
   * read-back such a failure costs only that record its place.
   */
  function receiveRecord({ env, school, device }, record, { index, alone = false }) {
    let outcome;
    try {
      // its own savepoint: a record that fails part-way leaves nothing behind, so "refused" is the whole truth
      outcome = db.tx(() => settlement.receive({ schoolId: school.id, uploaderDeviceId: device.id, via: RECORD_VIAS[env.type], record }));
    } catch (err) {
      if (alone) throw err;
      note('error', 'intake could not settle a record', { school: school.code, device: device.code, index, error: err?.message, stack: err?.stack });
      outcome = { status: 'REFUSED', code: 'INTERNAL', message: INTERNAL_MESSAGE, differences: [] };
    }
    const fields = isPlainObject(record) ? record : {};
    const result = {};
    if (index !== undefined) result.index = index;
    result.txn = short(fields.txn);
    result.origin = short(fields.origin);
    result.status = outcome.status;
    if (outcome.purchaseId) result.purchaseId = outcome.purchaseId;
    if (outcome.code) result.code = outcome.code;
    if (outcome.status === 'REFUSED') result.message = String(outcome.message ?? REFUSAL[outcome.code] ?? outcome.code).slice(0, MAX_MESSAGE_TEXT);
    result.differences = [...(outcome.differences ?? [])];
    if (outcome.status === 'REFUSED') {
      const detail = { type: env.type, messageId: env.id, txn: result.txn, origin: result.origin };
      if (index !== undefined) detail.index = index;
      if (env.type === 'journal.batch') detail.batchId = short(env.body.batchId);
      devices.log({
        schoolId: school.id,
        deviceId: device.id,
        level: outcome.code === 'INTERNAL' ? 'ERROR' : 'WARN',
        code: outcome.code,
        message: result.message,
        detail,
      });
    }
    return result;
  }

  // ---- answers ---------------------------------------------------------------------

  /** The record results as the lab console shows them. */
  const eventResults = (results) =>
    results.map((r) => {
      const e = { txn: r.txn, status: r.status };
      if (r.code) e.code = r.code;
      e.differences = [...r.differences];
      return e;
    });

  /**
   * The pipeline steps for an intake event: each step the message passed, then the step where
   * it stopped with `ok: false` and the code (a duplicate stops at `duplicate`, code DUPLICATE).
   * An accepted message passed all ten.
   * @returns {Array<{ step: string, ok: boolean, code?: string }>}
   */
  function checksOf(sender, code) {
    const passed = Math.min(sender.passed, INTAKE_STEPS.length);
    const checks = INTAKE_STEPS.slice(0, passed).map((step) => ({ step, ok: true }));
    if (code !== undefined && passed < INTAKE_STEPS.length) checks.push({ step: INTAKE_STEPS[passed], ok: false, code });
    return checks;
  }

  /** What the lab console shows of a read-back's snapshot check (DESIGN §11.2). */
  function eventSnapshot(snapshot) {
    const out = {};
    for (const key of SNAPSHOT_EVENT_FIELDS) if (snapshot[key] !== undefined) out[key] = snapshot[key];
    return out;
  }

  function finish(sender, env, outcome) {
    const data = { device: sender.deviceCode, type: env.type };
    if (outcome.code) data.code = outcome.code;
    data.msgId = env.id;
    data.checks = checksOf(sender, outcome.code);
    if (outcome.detail?.results) data.results = eventResults(outcome.detail.results);
    if (outcome.result === 'ACCEPTED' && isPlainObject(outcome.detail?.snapshot)) data.snapshot = eventSnapshot(outcome.detail.snapshot);
    quietly('announce a message', () => events.emit(outcome.result === 'ACCEPTED' ? 'intake.accepted' : 'intake.refused', data, sender.schoolCode));
    const answer = { result: outcome.result };
    if (outcome.code) answer.code = outcome.code;
    answer.type = env.type;
    answer.detail = outcome.detail;
    return answer;
  }

  function duplicate(sender, env, seen) {
    quietly('announce a duplicate', () =>
      events.emit('intake.duplicate', { device: sender.deviceCode, type: env.type, msgId: env.id, checks: checksOf(sender, 'DUPLICATE') }, sender.schoolCode),
    );
    return {
      result: 'DUPLICATE',
      type: env.type,
      detail: { messageId: env.id, firstReceivedAt: seen?.received_at ?? null, firstResult: seen?.result ?? null },
    };
  }

  /** What the device log keeps about a refused message (never the payload itself). */
  function logDetail(sender, extra = {}) {
    const detail = {};
    if (sender.type) detail.type = sender.type;
    if (sender.messageId) detail.messageId = sender.messageId;
    if (sender.seq !== undefined) detail.seq = sender.seq;
    return { ...detail, ...extra };
  }

  function refusedAnswer(sender, code, detail) {
    const answer = { result: 'REFUSED', code };
    if (sender.type) answer.type = sender.type;
    answer.detail = detail;
    return answer;
  }

  /** intake.refused data for a message that left the pipeline at a check (or failed in the platform). */
  function refusalEvent(sender, code) {
    const data = { device: sender.deviceCode ?? null, type: sender.type ?? null, code };
    // the id as far as it could be read: a message refused at the envelope step may still name one
    if (sender.messageId) data.msgId = sender.messageId;
    data.checks = checksOf(sender, code);
    return data;
  }

  /**
   * File a refusal: the machine's log (an unidentified sender's goes under no school, the lab
   * console's view of unknown senders), the lab console, and the answer.
   */
  function refused(sender, refusal) {
    quietly('log a refusal', () =>
      devices.log({
        schoolId: sender.schoolId ?? null,
        deviceId: sender.deviceId ?? null,
        level: 'WARN',
        code: refusal.code,
        message: refusal.message,
        detail: logDetail(sender, refusal.detail),
      }),
    );
    quietly('announce a refusal', () => events.emit('intake.refused', refusalEvent(sender, refusal.code), sender.schoolCode ?? null));
    note('warn', `intake refused a message: ${refusal.code}`, { school: sender.schoolCode, device: sender.deviceCode, type: sender.type });
    return refusedAnswer(sender, refusal.code, { message: refusal.message, ...refusal.detail });
  }

  /** A failure of the platform itself: nothing of the message was kept, so it can come again. */
  function internal(sender, err) {
    note('error', 'intake failed on a message', {
      school: sender.schoolCode,
      device: sender.deviceCode,
      type: sender.type,
      error: err?.message,
      stack: err?.stack,
    });
    quietly('log an internal error', () =>
      devices.log({
        schoolId: sender.schoolId ?? null,
        deviceId: sender.deviceId ?? null,
        level: 'ERROR',
        code: 'INTERNAL',
        message: INTERNAL_MESSAGE,
        detail: logDetail(sender, { error: String(err?.message ?? err).slice(0, 200) }),
      }),
    );
    quietly('announce an internal error', () => events.emit('intake.refused', refusalEvent(sender, 'INTERNAL'), sender.schoolCode ?? null));
    return refusedAnswer(sender, 'INTERNAL', { message: INTERNAL_MESSAGE });
  }

  /** How a message that left the pipeline with an error ends: refused, or failed in the platform. Never throws. */
  function settle(sender, err) {
    try {
      return err instanceof Refusal ? refused(sender, err) : internal(sender, err);
    } catch {
      return { result: 'REFUSED', code: 'INTERNAL', detail: { message: INTERNAL_MESSAGE } };
    }
  }

  return {
    /**
     * Take one message a machine published (DESIGN §3 "Intake pipeline", in that order).
     * Never throws: a failure of the platform itself is REFUSED with code INTERNAL and logged.
     * Every refusal goes to the device log (level WARN) and is announced as intake.refused;
     * accepted messages as intake.accepted, repeats as intake.duplicate
     * (`{ device, type, code?, msgId?, checks, results?, snapshot? }`, filed under the school code;
     * `msgId` once the envelope id could be read, `checks` the pipeline steps up to where the
     * message ended, `snapshot` on an accepted card.readback). Everything after the envelope is
     * read runs in the event context { msgId } (DESIGN §11.2).
     *
     * `detail`: for a refusal `{ message, ... }`; for a record-carrying message `{ results }`
     * (one entry per record: `{ index?, txn, origin, status, purchaseId?, code?, message?,
     * differences }`), plus `batchId`/`count` for a batch and `snapshot` for a card read-back;
     * `{ listVersions, journalUnsent? }` for a heartbeat; `{ command, kind, ack, appliedVersion,
     * recorded }` for an ack; `{ messageId, firstReceivedAt, firstResult }` for a duplicate.
     * A sale or water message whose one record settlement refuses is REFUSED with the record's
     * code (RECORD_INVALID, UNKNOWN_ORIGIN_DEVICE); a batch or read-back is ACCEPTED and each
     * refused record is listed and logged on its own.
     * @param {string} topic
     * @param {Buffer|Uint8Array|string} payload
     * @returns {{ result: 'ACCEPTED'|'DUPLICATE'|'REFUSED', code?: string, type?: string, detail?: object }}
     */
    handle(topic, payload) {
      const sender = { schoolId: null, schoolCode: null, deviceId: null, deviceCode: null, type: null, passed: 0 };
      try {
        return run(topic, payload, sender);
      } catch (err) {
        return settle(sender, err);
      }
    },
  };
}
