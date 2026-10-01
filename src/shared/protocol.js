// The lab's own device protocol (documented in docs/DESIGN.md, "Device protocol").
// Topics:  lab/v1/{school}/{device}/records              device -> platform (sales, batches, read-backs, acks)
//          lab/v1/{school}/{device}/status               device -> platform (heartbeats)
//          lab/v1/{school}/{device}/commands/{kind}      platform -> device
//            kind: prices | settings | blocklist (retained) | blocklist-delta | control (not retained)
import { newUuid } from './ids.js';
import { parseIso } from './time.js';
import { isSen } from './money.js';

export const PROTOCOL_VERSION = '1.0';
export const TOPIC_ROOT = 'lab/v1';

export const SCHOOL_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const DEVICE_CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,30}[A-Z0-9])?$/;
export const DEVICE_TYPES = Object.freeze(['CANTEEN', 'WATER', 'KIOSK']);
export const CONFIG_KINDS = Object.freeze(['prices', 'settings', 'blocklist']);
export const COMMAND_KINDS = Object.freeze(['prices', 'settings', 'blocklist', 'blocklist-delta', 'control']);
export const RETAINED_COMMAND_KINDS = Object.freeze(['prices', 'settings', 'blocklist']);

/** Message types a device sends, and the channel each one must use. */
export const UP_TYPES = Object.freeze({
  'sale.recorded': 'records',
  'water.recorded': 'records',
  'journal.batch': 'records',
  'card.readback': 'records',
  'command.ack': 'records',
  'device.heartbeat': 'status',
});

/** Message types the platform sends, and the command kind (sub-topic) each one uses. */
export const DOWN_TYPES = Object.freeze({
  'config.prices': 'prices',
  'config.settings': 'settings',
  'blocklist.snapshot': 'blocklist',
  'blocklist.delta': 'blocklist-delta',
  'control.upload-journal': 'control',
  'control.heartbeat-now': 'control',
});

export const MAX_BATCH_RECORDS = 200;
export const CARD_RECORDS_KEPT = 20;

/** What a terminal shows when a card is refused. Never says why, to protect the student. */
export const SCREEN_CARD_UNAVAILABLE = 'Card unavailable, please contact the front desk';

export function topicFor(school, device, channel) {
  return `${TOPIC_ROOT}/${school}/${device}/${channel}`;
}

export function commandTopic(school, device, kind) {
  return `${TOPIC_ROOT}/${school}/${device}/commands/${kind}`;
}

/**
 * @returns {{school:string, device:string, channel:'records'|'status'|'commands', kind?:string} | null}
 */
export function parseTopic(topic) {
  if (typeof topic !== 'string') return null;
  const parts = topic.split('/');
  if (parts.length < 5 || `${parts[0]}/${parts[1]}` !== TOPIC_ROOT) return null;
  const [, , school, device, channel, kind, ...rest] = parts;
  if (!SCHOOL_CODE_RE.test(school) || !DEVICE_CODE_RE.test(device)) return null;
  if ((channel === 'records' || channel === 'status') && parts.length === 5) return { school, device, channel };
  if (channel === 'commands' && parts.length === 6 && COMMAND_KINDS.includes(kind) && rest.length === 0) {
    return { school, device, channel, kind };
  }
  return null;
}

/** Device transaction number: '<DEVICE>-<6 digits>', consecutive per device, never reused. */
export function deviceTxnNo(deviceCode, n) {
  return `${deviceCode}-${String(n).padStart(6, '0')}`;
}

export function parseDeviceTxnNo(txn) {
  const m = /^([A-Z0-9](?:[A-Z0-9-]{0,30}[A-Z0-9])?)-(\d{6,})$/.exec(String(txn));
  if (!m) return null;
  return { device: m[1], n: Number(m[2]) };
}

/** Envelope without signature; sign it with signEnvelope() from crypto.js. */
export function buildEnvelope({ school, device, seq, at, type, txn, body }) {
  const env = { v: PROTOCOL_VERSION, id: newUuid(), school, device, seq, at, type, body: body ?? {} };
  if (txn !== undefined && txn !== null) env.txn = txn;
  return env;
}

const fail = (code, message) => ({ ok: false, code, message });
const OK = Object.freeze({ ok: true });

/**
 * Structural checks on an envelope (not the signature). Codes:
 * ENVELOPE_INVALID, VERSION_UNSUPPORTED, UNKNOWN_TYPE.
 */
export function validateEnvelopeShape(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return fail('ENVELOPE_INVALID', 'message is not a JSON object');
  if (typeof env.v !== 'string' || !/^\d+\.\d+$/.test(env.v)) return fail('ENVELOPE_INVALID', 'v must look like "1.0"');
  if (env.v.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) return fail('VERSION_UNSUPPORTED', `protocol ${env.v} is not supported`);
  if (typeof env.id !== 'string' || env.id.length < 8 || env.id.length > 64) return fail('ENVELOPE_INVALID', 'id must be a string of 8 to 64 characters');
  if (typeof env.school !== 'string' || !SCHOOL_CODE_RE.test(env.school)) return fail('ENVELOPE_INVALID', 'school code is invalid');
  if (typeof env.device !== 'string' || !DEVICE_CODE_RE.test(env.device)) return fail('ENVELOPE_INVALID', 'device code is invalid');
  if (!Number.isSafeInteger(env.seq) || env.seq < 1) return fail('ENVELOPE_INVALID', 'seq must be a positive whole number');
  if (Number.isNaN(parseIso(env.at))) return fail('ENVELOPE_INVALID', 'at must be an ISO-8601 timestamp');
  if (typeof env.type !== 'string') return fail('ENVELOPE_INVALID', 'type is missing');
  if (env.txn !== undefined && (typeof env.txn !== 'string' || env.txn.length > 64)) return fail('ENVELOPE_INVALID', 'txn must be a short string');
  if (!env.body || typeof env.body !== 'object' || Array.isArray(env.body)) return fail('ENVELOPE_INVALID', 'body must be an object');
  if (typeof env.sig !== 'string' || env.sig.length < 20) return fail('ENVELOPE_INVALID', 'sig is missing');
  // own properties only: 'toString' or '__proto__' must not pass as a known type
  if (!Object.hasOwn(UP_TYPES, env.type) && !Object.hasOwn(DOWN_TYPES, env.type)) {
    return fail('UNKNOWN_TYPE', `unknown message type ${env.type}`);
  }
  return OK;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;
const ITEM_CODE_RE = /^[A-Z0-9-]{1,24}$/;

/**
 * Checks one purchase record (sale or water). Code on failure: RECORD_INVALID.
 * See docs/DESIGN.md "Purchase record" for the fields.
 */
export function validateRecord(r) {
  const bad = (message) => fail('RECORD_INVALID', message);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('record is not an object');
  const parsed = parseDeviceTxnNo(r.txn);
  if (!parsed) return bad('txn must look like DEVICE-000123');
  if (typeof r.origin !== 'string' || !DEVICE_CODE_RE.test(r.origin)) return bad('origin device code is invalid');
  if (parsed.device !== r.origin) return bad('txn must start with the origin device code');
  if (r.kind !== 'SALE' && r.kind !== 'WATER') return bad('kind must be SALE or WATER');
  if (typeof r.card !== 'string' || !DIGEST_RE.test(r.card)) return bad('card must be a 64-character card digest');
  if (typeof r.last4 !== 'string' || !/^[0-9A-F]{4}$/.test(r.last4)) return bad('last4 must be 4 hex characters');
  if (!Number.isSafeInteger(r.cardSeq) || r.cardSeq < 1) return bad('cardSeq must be a positive whole number');
  for (const f of ['amountSen', 'balanceBeforeSen', 'balanceAfterSen']) {
    if (!isSen(r[f])) return bad(`${f} must be whole sen, 0 or more`);
  }
  if (!Number.isSafeInteger(r.priceVersion) || r.priceVersion < 1) return bad('priceVersion must be 1 or more');
  if (!Number.isSafeInteger(r.listVersion) || r.listVersion < 0) return bad('listVersion must be 0 or more');
  if (Number.isNaN(parseIso(r.at))) return bad('at must be an ISO-8601 timestamp');
  if (r.currency !== undefined && r.currency !== 'MYR') return bad('only MYR is accepted');
  if (r.kind === 'SALE') {
    if (!Array.isArray(r.items) || r.items.length === 0 || r.items.length > 20) return bad('a sale needs 1 to 20 items');
    for (const it of r.items) {
      if (!it || !ITEM_CODE_RE.test(String(it.code))) return bad('item code is invalid');
      if (!Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 99) return bad('item qty must be 1 to 99');
      if (!isSen(it.priceSen)) return bad('item priceSen must be whole sen');
    }
  } else {
    if (!Number.isSafeInteger(r.ml) || r.ml < 1 || r.ml > 20000) return bad('ml must be 1 to 20000');
    if (!isSen(r.perLitreSen) || r.perLitreSen < 1) return bad('perLitreSen must be 1 sen or more');
  }
  return OK;
}

/** Refusal codes the platform writes to the device log. */
export const REFUSAL = Object.freeze({
  TOPIC_INVALID: 'topic is not a lab/v1 device topic',
  UNKNOWN_DEVICE: 'no such school or device',
  ENVELOPE_INVALID: 'envelope is malformed',
  VERSION_UNSUPPORTED: 'protocol version not supported',
  UNKNOWN_TYPE: 'unknown message type',
  TOPIC_MISMATCH: 'school, device or channel in the envelope does not match the topic',
  SIGNATURE_INVALID: 'signature does not match',
  SEQUENCE_ROLLBACK: 'seq is not higher than the last accepted seq for this device',
  SCHOOL_SUSPENDED: 'school is suspended',
  DEVICE_DISABLED: 'device is not active',
  WRONG_DEVICE_TYPE: 'this device type may not send this message',
  COUNT_MISMATCH: 'batch count does not match the number of records',
  RECORD_INVALID: 'record is malformed',
  UNKNOWN_ORIGIN_DEVICE: 'the record names a machine this school does not have',
});
