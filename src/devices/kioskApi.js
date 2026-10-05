import { randomBytes } from 'node:crypto';
import { LabError } from '../shared/errors.js';
import { signRequest } from '../shared/crypto.js';
import { DEVICE_CODE_RE, SCHOOL_CODE_RE } from '../shared/protocol.js';

// The kiosk's client for the platform's signed kiosk API (docs/DESIGN.md §3 "Kiosk HTTP
// (signed)"). The kiosk is the only machine that can put money on a card, so every request
// carries the school and device codes, a lab-clock timestamp, a fresh random nonce and
// signRequest() over the method, the exact path with its query, the timestamp, the nonce
// and the exact body text, under the kiosk's own secret. The platform refuses an edited,
// delayed or replayed request.
//
// Errors are KioskApiError: the platform's own error code for an answer that is not 2xx,
// NETWORK when there was no answer in time. The kiosk decides what that means (with no
// network it writes nothing; a lost confirm is looked up by the same kiosk txn).
//
// The lab can say the network is down (`online`, e.g. the kiosk's cable is out or the cloud
// server is switched off) and add headers of its own (`headers`, e.g. x-lab-trace for
// Simulation mode, DESIGN §11.3); those never replace the signed ones.

const NONCE_BYTES = 16; // 32 hex characters, inside the 16-64 the platform accepts
const MAX_TXN_LENGTH = 64;
/** Status of a NETWORK error: there was no answer, so it reads as "service unavailable". */
const NO_ANSWER_STATUS = 503;
/** Status of an answer that is not one (a 2xx that is not JSON, a redirect): "bad gateway". */
const BAD_ANSWER_STATUS = 502;
// Node timers hold whole milliseconds up to 2^31 - 1: AbortSignal.timeout() refuses a
// fraction, and a longer delay fires after 1 ms, so either would turn every call into NETWORK.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Method and path of each kiosk call (DESIGN §3); lookup adds the kiosk txn to the path. */
const ROUTES = Object.freeze({
  pending: Object.freeze({ method: 'POST', path: '/api/kiosk/pending' }),
  confirm: Object.freeze({ method: 'POST', path: '/api/kiosk/confirm' }),
  lookup: Object.freeze({ method: 'GET', path: '/api/kiosk/confirm' }),
  packs: Object.freeze({ method: 'GET', path: '/api/kiosk/packs' }),
  receipts: Object.freeze({ method: 'POST', path: '/api/kiosk/admin-card/receipts' }),
});
/** The calls of the kiosk API, as the kiosk names them in its events. */
export const KIOSK_CALLS = Object.freeze(Object.keys(ROUTES));

// Headers the lab's own may never set: what is signed or describes the signed body, and what
// frames the request on the wire.
const RESERVED_HEADERS = new Set([
  'accept',
  'content-type',
  'x-lab-school',
  'x-lab-device',
  'x-lab-timestamp',
  'x-lab-nonce',
  'x-lab-signature',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/; // an HTTP token
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]{0,1024}$/; // no line breaks or NUL, Latin-1 only (fetch)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const matches = (re) => (v) => typeof v === 'string' && re.test(v);
const isSchoolCode = matches(SCHOOL_CODE_RE);
const isDeviceCode = matches(DEVICE_CODE_RE);
const isHexSecret = matches(/^[0-9a-f]{32,}$/i); // same rule as shared/crypto.js

/**
 * A kiosk API call failed. `code` is the platform's error code from the JSON body
 * (e.g. SIGNATURE_INVALID, REPLAY, ORDER_ALREADY_ADDED, SERVER_DOWN), `NETWORK` when the
 * platform could not be reached in time (detail.timedOut says which), `BAD_RESPONSE` for a
 * 2xx answer that is not JSON, or `HTTP_<status>` when an answer has no code.
 * `status` is always an error status, as on any LabError, because the error may reach an API
 * response: the platform's own 4xx/5xx, 503 for NETWORK, and 502 for an answer that is not
 * one (BAD_RESPONSE, or a redirect, which is never followed), with the platform's status in
 * detail.httpStatus.
 */
export class KioskApiError extends LabError {
  /**
   * @param {string} code
   * @param {number} status  HTTP error status (see above)
   * @param {string} [message]
   * @param {unknown} [detail]
   */
  constructor(code, status, message, detail) {
    super(code, message, status, detail);
    this.name = 'KioskApiError';
  }
}

function baseOf(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl must be an http(s) URL such as http://127.0.0.1:8080');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.search || u.hash || u.username || u.password) {
    throw new TypeError('baseUrl must be a plain http(s) URL such as http://127.0.0.1:8080');
  }
  // A path prefix (platform behind a proxy) is kept; API paths are appended to it.
  return u.origin + u.pathname.replace(/\/+$/, '');
}

// A kiosk txn number becomes one path segment. Escaped, so '/' or '?' cannot change the
// route; '.' and '..' would still be read as directories, so they are refused.
function txnSegment(kioskTxn) {
  if (typeof kioskTxn !== 'string' || kioskTxn.length === 0 || kioskTxn.length > MAX_TXN_LENGTH || /^\.+$/.test(kioskTxn)) {
    throw new TypeError(`kioskTxn must be a string of 1 to ${MAX_TXN_LENGTH} characters`);
  }
  return encodeURIComponent(kioskTxn);
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Method and path of a kiosk API call as the kiosk sends it (without a baseUrl prefix).
 * @param {'pending'|'confirm'|'lookup'|'packs'|'receipts'} call
 * @param {string} [kioskTxn]  lookup only
 * @returns {{ method: string, path: string }}
 * @throws {TypeError} for an unknown call, or a kiosk txn that cannot be one path segment
 */
export function kioskRoute(call, kioskTxn) {
  const route = typeof call === 'string' && Object.hasOwn(ROUTES, call) ? ROUTES[call] : null;
  if (!route) throw new TypeError(`${call} is not a kiosk API call`);
  return { method: route.method, path: call === 'lookup' ? `${route.path}/${txnSegment(kioskTxn)}` : route.path };
}

/**
 * The extra headers the lab asks for: string values with a valid name, never one of the
 * reserved headers, names in lower case (so two spellings cannot both go out). A function that
 * throws or answers something else adds nothing: these headers are hints, never a reason for
 * a top-up to fail.
 */
function extraHeaders(headers) {
  if (!headers) return {};
  let given;
  try {
    given = headers();
  } catch {
    return {};
  }
  const out = {};
  if (!isPlainObject(given)) return out;
  for (const [name, value] of Object.entries(given)) {
    if (typeof value !== 'string' || !HEADER_NAME_RE.test(name) || !HEADER_VALUE_RE.test(value)) continue;
    const key = name.toLowerCase();
    if (!RESERVED_HEADERS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Signed client for one kiosk.
 * @param {{ baseUrl: string, schoolCode: string, deviceCode: string, secret: string,
 *   clock: { now(): number }, timeoutMs?: number, online?: () => boolean,
 *   headers?: () => Record<string, string> }} options
 *   baseUrl: the platform's HTTP address; secret: the kiosk's device secret (hex);
 *   clock: the lab clock (timestamps); timeoutMs: real time allowed per request, a whole
 *   number of milliseconds from 1 to 2^31 - 1; online: asked before every request, false
 *   fails it at once as NETWORK (nothing is sent); headers: extra headers for every request
 *   (string values only; the signing headers, accept and content-type stay the kiosk's own).
 *   Malformed options are a TypeError.
 * @returns {{
 *   pending(args: { card: string, max?: number }): Promise<{ member: { id: string, name: string },
 *     orders: Array<{ orderId: string, kind: string, amountSen: number }>, mirrorBalanceSen: number, waitingSen: number }>,
 *   confirm(args: { orderId: string, result: 'ADDED'|'FAILED', amountSen: number, card: string,
 *     balanceAfterOnCardSen: number, kioskTxn: string }): Promise<{ orderId: string, status: string, duplicate: boolean }>,
 *   lookup(kioskTxn: string): Promise<{ orderId: string, status: string } | null>,
 *   packs(): Promise<{ token: number, school: string,
 *     packs: Array<{ kind: string, version: number, content: object, checksum: string }> }>,
 *   receipts(args: { token: number, receipts: object[] }): Promise<{ recorded: number }>,
 *   request(method: string, path: string, body?: unknown): Promise<unknown>,
 * }}
 *   Every method rejects with KioskApiError (see above).
 */
export function createKioskApi({ baseUrl, schoolCode, deviceCode, secret, clock, timeoutMs = 5000, online, headers } = {}) {
  const base = baseOf(baseUrl);
  if (!isSchoolCode(schoolCode)) throw new TypeError('schoolCode must be a school code such as smk-contoh');
  if (!isDeviceCode(deviceCode)) throw new TypeError('deviceCode must be a device code such as KIOSK-01');
  if (!isHexSecret(secret)) throw new TypeError('secret must be the kiosk device secret (hex, at least 16 bytes)');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock must be the lab clock');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be a whole number of milliseconds, 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (online !== undefined && typeof online !== 'function') throw new TypeError('online must be a function answering true or false');
  if (headers !== undefined && typeof headers !== 'function') throw new TypeError('headers must be a function answering extra headers');

  async function send(method, path, body, { nullOn404 = false } = {}) {
    const verb = String(method).toUpperCase();
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('path must start with /');
    if ((verb === 'GET' || verb === 'HEAD') && body !== undefined) throw new TypeError(`${verb} requests have no body`);
    // No network (the kiosk's cable is out, the server is off): nothing goes out, as with no answer.
    if (online && online() === false) {
      throw new KioskApiError('NETWORK', NO_ANSWER_STATUS, 'cannot reach the platform (no network)', { timedOut: false, offline: true });
    }
    const url = new URL(base + path);
    // Sign exactly what goes on the wire: the URL parser may re-encode the path.
    const signedPath = url.pathname + url.search;
    const text = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(clock.now()));
    const nonce = randomBytes(NONCE_BYTES).toString('hex');
    const sent = {
      ...extraHeaders(headers),
      accept: 'application/json',
      'x-lab-school': schoolCode,
      'x-lab-device': deviceCode,
      'x-lab-timestamp': timestamp,
      'x-lab-nonce': nonce,
      'x-lab-signature': signRequest({ secretHex: secret, method: verb, path: signedPath, timestamp, nonce, body: text }),
    };
    if (body !== undefined) sent['content-type'] = 'application/json';
    // Real time, not the lab clock: it bounds how long the kiosk waits for the network,
    // and covers the whole answer (a confirm cut off half-way is not an answer).
    const signal = AbortSignal.timeout(timeoutMs);

    // Only the network is in here, so everything caught really is NETWORK.
    let res;
    let raw;
    try {
      res = await fetch(url, {
        method: verb,
        headers: sent,
        body: body === undefined ? undefined : text,
        signal,
        // Following a redirect would send this signed request somewhere it was not signed for.
        redirect: 'manual',
      });
      raw = await res.text();
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError';
      const message = timedOut
        ? `no answer from the platform within ${timeoutMs} ms`
        : `cannot reach the platform (${err?.cause?.code ?? err?.message ?? 'network error'})`;
      throw new KioskApiError('NETWORK', NO_ANSWER_STATUS, message, { timedOut });
    }

    const data = parseJson(raw);
    if (res.status >= 200 && res.status < 300) {
      if (data === undefined) {
        throw new KioskApiError('BAD_RESPONSE', BAD_ANSWER_STATUS, 'the platform answered with something that is not JSON', {
          httpStatus: res.status,
        });
      }
      return data;
    }
    if (nullOn404 && res.status === 404) return null;
    const error = isPlainObject(data) && isPlainObject(data.error) ? data.error : {};
    const code = typeof error.code === 'string' && error.code ? error.code : `HTTP_${res.status}`;
    const message = typeof error.message === 'string' && error.message ? error.message : `the platform answered HTTP ${res.status}`;
    if (res.status < 400) throw new KioskApiError(code, BAD_ANSWER_STATUS, message, { httpStatus: res.status });
    throw new KioskApiError(code, res.status, message, error.detail);
  }

  /** One of the kiosk calls, on its route. */
  function call(name, body, { kioskTxn, nullOn404 } = {}) {
    const { method, path } = kioskRoute(name, kioskTxn);
    return send(method, path, body, { nullOn404 });
  }

  return {
    /** POST /api/kiosk/pending: the member and the orders waiting to be added to this card (digest). */
    async pending({ card, max } = {}) {
      return call('pending', { card, max });
    },

    /** POST /api/kiosk/confirm: report one write (ADDED or FAILED) under its kiosk txn number. */
    async confirm({ orderId, result, amountSen, card, balanceAfterOnCardSen, kioskTxn } = {}) {
      return call('confirm', { orderId, result, amountSen, card, balanceAfterOnCardSen, kioskTxn });
    },

    /** GET /api/kiosk/confirm/<kioskTxn>: what the platform recorded for a confirm; null if nothing (404). */
    async lookup(kioskTxn) {
      return call('lookup', undefined, { kioskTxn, nullOn404: true });
    },

    /** GET /api/kiosk/packs: a new admin-card token and the school's current packs. */
    async packs() {
      return call('packs');
    },

    /** POST /api/kiosk/admin-card/receipts: upload the receipts the offline machines wrote on the admin card. */
    async receipts({ token, receipts } = {}) {
      return call('receipts', { token, receipts });
    },

    /** Any signed request (path from the API root, query included); the methods above use it. */
    async request(method, path, body) {
      return send(method, path, body);
    },
  };
}
