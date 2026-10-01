import { canonicalJson, safeEqual, sha256hex } from '../shared/crypto.js';
import { CONFIG_KINDS, DEVICE_CODE_RE, SCHOOL_CODE_RE } from '../shared/protocol.js';
import { parseIso } from '../shared/time.js';
import { CardError } from './card.js';

// The school's admin card (docs/DESIGN.md §3 "Admin card"): how new prices, settings and
// block lists reach machines with no network. The kiosk loads it with the platform's
// current packs and a fresh token; staff tap it on each offline machine, which applies
// what is newer and writes a receipt on the card; back at the kiosk the receipts are
// uploaded, so the office sees which machine runs which version.
//
// The card only carries packs, it does not judge them: each machine checks the checksum
// (verifyPack), the version and the token itself, so a damaged or old card cannot change it.
//
// Memory: { school, token, loadedAt, packs: [{ kind, version, content, checksum }], receipts: [...] }

export const RECEIPT_RESULTS = Object.freeze(['APPLIED', 'ALREADY_APPLIED', 'REJECTED']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep copy of plain JSON. canonicalJson throws TypeError for anything else (a function, a
// Date, NaN): packs arrive as JSON, so such content is a bug, not a damaged pack.
function jsonCopy(value) {
  canonicalJson(value);
  return JSON.parse(JSON.stringify(value));
}

/** The checksum a pack carries: sha256hex(canonicalJson(content)), independent of key order. */
export function packChecksum(content) {
  return sha256hex(canonicalJson(content));
}

/**
 * True when the pack's checksum matches its content. Never throws: anything malformed is
 * simply not a good pack. Kind, version and token are each machine's own checks.
 * @param {{ kind?: string, version?: number, content: unknown, checksum: string }} pack
 * @returns {boolean}
 */
export function verifyPack(pack) {
  if (!isPlainObject(pack) || typeof pack.checksum !== 'string' || pack.content === undefined) return false;
  try {
    return safeEqual(pack.checksum, packChecksum(pack.content));
  } catch {
    return false; // content that is not plain JSON cannot have come from the platform
  }
}

function checkPacks(packs) {
  if (!Array.isArray(packs)) throw new TypeError('packs must be an array');
  const kinds = new Set();
  for (const p of packs) {
    if (!isPlainObject(p) || !CONFIG_KINDS.includes(p.kind)) {
      throw new TypeError(`each pack needs a kind (${CONFIG_KINDS.join(', ')})`);
    }
    // One pack per kind: a machine must not have to guess which of two lists is meant.
    if (kinds.has(p.kind)) throw new TypeError(`more than one ${p.kind} pack`);
    kinds.add(p.kind);
    if (!Number.isSafeInteger(p.version) || p.version < 0) throw new TypeError(`${p.kind} pack version must be a whole number, 0 or more`);
    if (!isPlainObject(p.content)) throw new TypeError(`${p.kind} pack content must be an object`);
    if (typeof p.checksum !== 'string') throw new TypeError(`${p.kind} pack checksum must be a string`);
  }
}

export class AdminCard {
  #memory;

  /**
   * A blank admin card for one school: token 0, no packs, no receipts.
   * @param {{ schoolCode: string }} args
   */
  constructor({ schoolCode } = {}) {
    if (typeof schoolCode !== 'string' || !SCHOOL_CODE_RE.test(schoolCode)) {
      throw new TypeError('schoolCode must be a school code such as smk-contoh');
    }
    this.#memory = { school: schoolCode, token: 0, loadedAt: null, packs: [], receipts: [] };
  }

  /** Deep copy of the card memory. */
  get memory() {
    return structuredClone(this.#memory);
  }

  get schoolCode() {
    return this.#memory.school;
  }

  get token() {
    return this.#memory.token;
  }

  /**
   * Write the platform's packs onto the card (the kiosk does this). Replaces the token and
   * every pack at once; receipts not uploaded yet stay on the card. Checksums are not
   * judged here (machines do that). `school`, when given (the packs response carries it),
   * must be this card's school.
   * @param {{ token: number, packs: Array<{ kind: string, version: number, content: object, checksum: string }>,
   *   loadedAt: string, school?: string }} args
   * @returns {object} the new memory (copy)
   * @throws {CardError} WRONG_SCHOOL; a malformed token, pack (content that is not plain JSON
   *   included) or time is a TypeError
   */
  load({ token, packs, loadedAt, school } = {}) {
    if (school != null && school !== this.#memory.school) {
      throw new CardError('WRONG_SCHOOL', 'these packs belong to another school', { cardSchool: this.#memory.school });
    }
    if (!Number.isSafeInteger(token) || token < 1) throw new TypeError('token must be a whole number, 1 or more');
    checkPacks(packs);
    if (Number.isNaN(parseIso(loadedAt))) throw new TypeError('loadedAt must be an ISO-8601 timestamp');
    this.#memory = {
      ...this.#memory,
      token,
      loadedAt,
      packs: packs.map(({ kind, version, content, checksum }) => ({ kind, version, content: jsonCopy(content), checksum })),
    };
    return this.memory;
  }

  /**
   * A machine writes on the card what it did with one pack.
   * @param {{ device: string, kind: string, appliedVersion: number, result: 'APPLIED'|'ALREADY_APPLIED'|'REJECTED',
   *   error?: string, at: string }} r
   * @returns {object} the stored receipt (copy); a malformed receipt is a TypeError
   */
  addReceipt(r) {
    if (!isPlainObject(r)) throw new TypeError('receipt must be an object');
    const { device, kind, appliedVersion, result, error, at } = r;
    if (typeof device !== 'string' || !DEVICE_CODE_RE.test(device)) {
      throw new TypeError('receipt device must be a device code such as CANTEEN-01');
    }
    if (!CONFIG_KINDS.includes(kind)) throw new TypeError(`receipt kind must be one of ${CONFIG_KINDS.join(', ')}`);
    if (!Number.isSafeInteger(appliedVersion) || appliedVersion < 0) {
      throw new TypeError('receipt appliedVersion must be a whole number, 0 or more');
    }
    if (!RECEIPT_RESULTS.includes(result)) throw new TypeError(`receipt result must be one of ${RECEIPT_RESULTS.join(', ')}`);
    if (error != null && typeof error !== 'string') throw new TypeError('receipt error must be text');
    if (Number.isNaN(parseIso(at))) throw new TypeError('receipt at must be an ISO-8601 timestamp');
    const receipt = { device, kind, appliedVersion, result };
    if (typeof error === 'string') receipt.error = error;
    receipt.at = at;
    this.#memory = { ...this.#memory, receipts: [...this.#memory.receipts, receipt] };
    return { ...receipt };
  }

  /**
   * Hand over every receipt, oldest first, and clear them from the card (the kiosk uploads
   * them). If the upload fails, the kiosk puts them back with addReceipt().
   * @returns {object[]}
   */
  takeReceipts() {
    const { receipts } = this.#memory;
    this.#memory = { ...this.#memory, receipts: [] };
    return receipts; // the card no longer holds this array
  }
}
