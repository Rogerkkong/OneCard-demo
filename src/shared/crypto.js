import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LabError } from './errors.js';

// Secrets are hex strings. HMAC keys are the raw bytes of that hex.

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` object
 * values skipped. Only plain JSON values are allowed (no NaN/Infinity).
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects are allowed');
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function keyBytes(secretHex) {
  if (typeof secretHex !== 'string' || !/^[0-9a-f]{32,}$/i.test(secretHex)) {
    throw new TypeError('secret must be a hex string of at least 16 bytes');
  }
  return Buffer.from(secretHex, 'hex');
}

export function hmacHex(secretHex, data) {
  return createHmac('sha256', keyBytes(secretHex)).update(data).digest('hex');
}

/** HMAC-SHA256, base64url without padding. */
export function hmacB64url(secretHex, data) {
  return createHmac('sha256', keyBytes(secretHex)).update(data).digest('base64url');
}

/** Constant-time string comparison; false when lengths differ. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

/** A separate key for each purpose, derived from one secret. */
export function deriveKey(secretHex, label) {
  return hmacHex(secretHex, `onecard-lab:${label}`);
}

/** Card UIDs are hex (4, 7 or 10 bytes on real NFC cards). Normalised to upper case, no separators. */
export function normalizeUid(uid) {
  const s = String(uid ?? '').replace(/[\s:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{8,20}$/.test(s) || s.length % 2 !== 0) {
    throw new LabError('CARD_UID_INVALID', 'card UID must be 8 to 20 hex characters (4 to 10 bytes)');
  }
  return s;
}

export function last4(uid) {
  return normalizeUid(uid).slice(-4);
}

/**
 * Keyed card digest ("card reference"): lists and records carry this instead of the
 * card number. HMAC over "school code | card UID" with a key only the school's
 * machines and the platform hold. 64 hex characters.
 */
export function cardDigest(cardKeyHex, schoolCode, uid) {
  return hmacHex(deriveKey(cardKeyHex, 'card-ref'), `${String(schoolCode).toLowerCase()}|${normalizeUid(uid)}`);
}

/** MAC over the card's chip memory; only machines holding the school card key can produce it. */
export function cardMac(cardKeyHex, memoryWithoutMac) {
  return hmacB64url(deriveKey(cardKeyHex, 'card-mac'), canonicalJson(memoryWithoutMac));
}

/** Password a device uses to log in to the broker (separate from its signing key). */
export function brokerPassword(deviceSecretHex) {
  return deriveKey(deviceSecretHex, 'broker-login');
}

/** Sign an MQTT envelope: sig = HMAC(device secret, canonicalJson(envelope without sig)). */
export function signEnvelope(secretHex, envelope) {
  const { sig: _ignored, ...rest } = envelope;
  return { ...rest, sig: hmacB64url(secretHex, canonicalJson(rest)) };
}

export function verifyEnvelopeSignature(secretHex, envelope) {
  if (!envelope || typeof envelope.sig !== 'string') return false;
  const { sig, ...rest } = envelope;
  let expected;
  try {
    expected = hmacB64url(secretHex, canonicalJson(rest));
  } catch {
    return false;
  }
  return safeEqual(sig, expected);
}

/**
 * String a kiosk signs for each HTTPS request:
 * METHOD \n path(with query) \n timestamp(ms) \n nonce \n sha256hex(body)
 */
export function requestSigningString({ method, path, timestamp, nonce, body = '' }) {
  return `${String(method).toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${sha256hex(body)}`;
}

export function signRequest({ secretHex, method, path, timestamp, nonce, body = '' }) {
  return hmacB64url(secretHex, requestSigningString({ method, path, timestamp, nonce, body }));
}

/** Signature the mock payment provider puts on its callbacks. */
export function signPayload(secretHex, payloadWithoutSignature) {
  return hmacB64url(secretHex, canonicalJson(payloadWithoutSignature));
}
