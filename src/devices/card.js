import { LabError } from '../shared/errors.js';
import { canonicalJson, cardMac, normalizeUid, safeEqual } from '../shared/crypto.js';
import { assertPositiveSen, assertSen, isSen } from '../shared/money.js';
import { CARD_RECORDS_KEPT, SCHOOL_CODE_RE } from '../shared/protocol.js';
import { parseIso } from '../shared/time.js';

// A virtual stored-value NFC card (docs/DESIGN.md §3 "Virtual card memory", §6).
// The chip holds the real balance: canteen readers and water machines charge it with no
// network at all, and only the kiosk adds money. The whole memory carries a MAC under the
// school card key, so only that school's machines can change it and a hand edit (the
// tamper fault) is caught at the next tap. A byte-for-byte copy keeps a valid MAC (the
// clone fault): only the platform can catch that, afterwards, from the card counter.
//
// Every change is all-or-nothing, like a real chip's atomic write: the new memory is built
// and signed on a copy and swapped in only when everything checked out.
//
// Memory: { uid, school, group, balanceSen, cardSeq, records: [record…] (last 20, newest
// last), writes: [{ orderId, amountSen, kioskTxn, at }] (last 10), listVersionOnCard, mac }

/** Kiosk top-ups the card remembers, so a kiosk can see a write it already made. */
export const CARD_WRITES_KEPT = 10;
export const HOLDER_GROUPS = Object.freeze(['STUDENT', 'STAFF']);
/** Lab faults for credit(): the machine loses power just before or just after the write. */
export const FAIL_MODES = Object.freeze(['power-cut-before-commit', 'power-cut-after-commit']);
export const CARD_ERROR_CODES = Object.freeze(['CARD_UNREADABLE', 'INSUFFICIENT_BALANCE', 'ALREADY_WRITTEN', 'WRONG_SCHOOL']);

const CARD_ERROR_STATUS = { CARD_UNREADABLE: 422, INSUFFICIENT_BALANCE: 409, ALREADY_WRITTEN: 409, WRONG_SCHOOL: 403 };
const CARD_ERROR_MESSAGES = {
  CARD_UNREADABLE: 'the card memory does not check out (wrong card key, or the card was edited)',
  INSUFFICIENT_BALANCE: 'not enough balance on the card',
  ALREADY_WRITTEN: 'this order is already written to the card',
  WRONG_SCHOOL: 'the card belongs to another school',
};
const MAX_REF_LENGTH = 64; // order ids and kiosk txn numbers; chip memory is small

/**
 * A card refused an operation; nothing on the card changed. `code` is one of
 * CARD_UNREADABLE, INSUFFICIENT_BALANCE, ALREADY_WRITTEN, WRONG_SCHOOL. Machines turn most
 * of these into SCREEN_CARD_UNAVAILABLE and never say why; the code is for logs and the
 * lab console. A LabError, so it maps to a clean API error if it ever reaches HTTP.
 */
export class CardError extends LabError {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {unknown} [detail]
   */
  constructor(code, message, detail) {
    super(code, message || CARD_ERROR_MESSAGES[code] || code, CARD_ERROR_STATUS[code] ?? 409, detail);
    this.name = 'CardError';
  }
}

/**
 * The machine lost power while writing the card (a lab fault). `committed` tells the lab
 * whether the write reached the chip; the machine itself cannot know and must read the
 * card again when it is back.
 */
export class PowerCutError extends LabError {
  /**
   * @param {boolean} [committed]
   * @param {string} [message]
   */
  constructor(committed = false, message) {
    const what = committed ? 'after the card write was committed' : 'before the card write was committed';
    super('POWER_CUT', message || `power cut ${what}`, 503, { committed });
    this.name = 'PowerCutError';
    this.committed = committed;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRef = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_REF_LENGTH;

// Deep copy of plain JSON, in the caller's key order. canonicalJson throws TypeError for
// anything else (a function, a symbol, a Date, NaN): the chip holds only what its MAC covers.
function jsonCopy(value) {
  canonicalJson(value);
  return JSON.parse(JSON.stringify(value));
}

// Same rule as shared/crypto.js. A missing or malformed key is a bug in the machine, not a
// bad card, so it throws TypeError instead of passing as "card unreadable".
function requireCardKey(cardKey) {
  if (typeof cardKey !== 'string' || !/^[0-9a-f]{32,}$/i.test(cardKey)) {
    throw new TypeError('cardKey must be the school card key (hex, at least 16 bytes)');
  }
}

/** The memory with a fresh MAC over everything else. */
function sign(cardKey, memory) {
  const { mac: _old, ...rest } = memory;
  return { ...rest, mac: cardMac(cardKey, rest) };
}

function macMatches(cardKey, memory) {
  const { mac, ...rest } = memory;
  if (typeof mac !== 'string') return false;
  try {
    return safeEqual(mac, cardMac(cardKey, rest));
  } catch {
    return false; // memory that is not plain JSON was never written by a machine
  }
}

// A MAC proves who wrote the memory, not that the fields are usable; checking them keeps
// the arithmetic below safe whatever a restored memory holds.
function wellFormed(m) {
  return (
    typeof m.uid === 'string' &&
    typeof m.school === 'string' &&
    HOLDER_GROUPS.includes(m.group) &&
    isSen(m.balanceSen) &&
    Number.isSafeInteger(m.cardSeq) &&
    m.cardSeq >= 0 &&
    Array.isArray(m.records) &&
    Array.isArray(m.writes) &&
    Number.isSafeInteger(m.listVersionOnCard) &&
    m.listVersionOnCard >= 0
  );
}

// Lets fromMemory() build a card without a key; never visible outside this module.
const FROM_MEMORY = Symbol('VirtualCard.fromMemory');

export class VirtualCard {
  /** The chip memory. Replaced whole on every change, never edited in place. */
  #memory;

  /**
   * A new blank card: balance 0, card counter 0, signed with the school card key.
   * @param {{ uid: string, schoolCode: string, group?: 'STUDENT'|'STAFF', cardKey: string }} args
   * Codes: CARD_UID_INVALID (LabError); a bad school code, group or key is a TypeError.
   */
  constructor(args) {
    const options = args ?? {};
    if (options[FROM_MEMORY]) {
      this.#memory = options[FROM_MEMORY];
      return;
    }
    const { uid, schoolCode, group = 'STUDENT', cardKey } = options;
    const cleanUid = normalizeUid(uid);
    if (typeof schoolCode !== 'string' || !SCHOOL_CODE_RE.test(schoolCode)) {
      throw new TypeError('schoolCode must be a school code such as smk-contoh');
    }
    if (!HOLDER_GROUPS.includes(group)) throw new TypeError(`group must be one of ${HOLDER_GROUPS.join(', ')}`);
    requireCardKey(cardKey);
    this.#memory = sign(cardKey, {
      uid: cleanUid,
      school: schoolCode,
      group,
      balanceSen: 0,
      cardSeq: 0,
      records: [],
      writes: [],
      listVersionOnCard: 0,
    });
  }

  /**
   * A card holding exactly this memory, MAC included and nothing re-signed (restoring a
   * card, or making a copy). The memory is only checked when a machine reads it.
   * @param {object} memory
   * @returns {VirtualCard}
   */
  static fromMemory(memory) {
    if (!isPlainObject(memory) || typeof memory.uid !== 'string' || typeof memory.school !== 'string') {
      throw new TypeError('card memory must be an object with uid and school');
    }
    return new VirtualCard({ [FROM_MEMORY]: structuredClone(memory) });
  }

  /** Deep copy of the whole chip memory, MAC included, unverified: what anyone can dump from the chip. */
  get memory() {
    return structuredClone(this.#memory);
  }

  get uid() {
    return this.#memory.uid;
  }

  get schoolCode() {
    return this.#memory.school;
  }

  /** Raw chip values for display (lab console). Machines use read(), which checks the MAC. */
  get group() {
    return this.#memory.group;
  }

  get balanceSen() {
    return this.#memory.balanceSen;
  }

  get cardSeq() {
    return this.#memory.cardSeq;
  }

  toJSON() {
    return this.memory;
  }

  /**
   * What a machine holding the school card key reads: the verified memory (a copy).
   * @param {string} cardKey  the school card key (hex)
   * @param {{ schoolCode?: string }} [options]  the reading machine's school, to tell a card
   *   of another school (WRONG_SCHOOL) from a damaged one; without it such a card is simply
   *   CARD_UNREADABLE, because its MAC was made with another school's key
   * @returns {object} memory copy
   * @throws {CardError} WRONG_SCHOOL, CARD_UNREADABLE
   */
  read(cardKey, { schoolCode } = {}) {
    return structuredClone(this.#verified(cardKey, schoolCode));
  }

  /**
   * Charge the card for a purchase, all or nothing. The caller passes the record without
   * cardSeq, balanceBeforeSen and balanceAfterSen; the card fills them in (and amountSen if
   * missing), keeps the completed record (the last CARD_RECORDS_KEPT) and returns it.
   * An amount of 0 is allowed (a very small pour can cost nothing) and still counts as a change.
   * @param {{ cardKey: string, amountSen: number, record: object, schoolCode?: string }} args
   * @returns {{ record: object, balanceBeforeSen: number, balanceAfterSen: number, cardSeq: number }}
   * @throws {CardError} WRONG_SCHOOL, CARD_UNREADABLE, INSUFFICIENT_BALANCE. A bad amount, or a
   *   record.amountSen that differs from amountSen, is LabError AMOUNT_INVALID. A record that is
   *   not a plain JSON object is a TypeError.
   */
  debit({ cardKey, amountSen, record, schoolCode } = {}) {
    assertSen(amountSen, 'amountSen');
    if (!isPlainObject(record)) throw new TypeError('record must be an object');
    if (record.amountSen !== undefined && record.amountSen !== amountSen) {
      throw new LabError('AMOUNT_INVALID', 'record.amountSen must equal amountSen');
    }
    // Copied before the card is touched, so a record the chip cannot hold changes nothing.
    const purchase = jsonCopy(record);
    const current = this.#verified(cardKey, schoolCode);
    if (current.balanceSen < amountSen) {
      throw new CardError('INSUFFICIENT_BALANCE', undefined, { balanceSen: current.balanceSen, amountSen });
    }
    const draft = structuredClone(current);
    const balanceBeforeSen = draft.balanceSen;
    const balanceAfterSen = balanceBeforeSen - amountSen;
    draft.balanceSen = balanceAfterSen;
    draft.cardSeq += 1;
    const completed = { ...purchase, amountSen, cardSeq: draft.cardSeq, balanceBeforeSen, balanceAfterSen };
    draft.records = [...draft.records, completed].slice(-CARD_RECORDS_KEPT);
    this.#memory = sign(cardKey, draft);
    return { record: structuredClone(completed), balanceBeforeSen, balanceAfterSen, cardSeq: draft.cardSeq };
  }

  /**
   * Add a kiosk top-up to the card, all or nothing. The write is remembered (the last
   * CARD_WRITES_KEPT) so the same order is never added twice.
   * `failMode` (lab fault): 'power-cut-before-commit' throws PowerCutError with nothing
   * changed; 'power-cut-after-commit' writes the card, then throws PowerCutError.
   * The card checks come first: a write the card would refuse anyway is refused, not cut.
   * @param {{ cardKey: string, amountSen: number, write: { orderId: string, kioskTxn: string, at: string },
   *   failMode?: 'power-cut-before-commit'|'power-cut-after-commit', schoolCode?: string }} args
   * @returns {{ balanceBeforeSen: number, balanceAfterSen: number, cardSeq: number }}
   * @throws {CardError} WRONG_SCHOOL, CARD_UNREADABLE, ALREADY_WRITTEN (detail.write: the earlier write)
   * @throws {PowerCutError}
   */
  credit({ cardKey, amountSen, write, failMode, schoolCode } = {}) {
    assertPositiveSen(amountSen, 'amountSen');
    if (!isPlainObject(write)) throw new TypeError('write must be { orderId, kioskTxn, at }');
    const { orderId, kioskTxn, at } = write;
    if (!isRef(orderId)) throw new TypeError(`write.orderId must be a string of 1 to ${MAX_REF_LENGTH} characters`);
    if (!isRef(kioskTxn)) throw new TypeError(`write.kioskTxn must be a string of 1 to ${MAX_REF_LENGTH} characters`);
    if (Number.isNaN(parseIso(at))) throw new TypeError('write.at must be an ISO-8601 timestamp');
    if (write.amountSen !== undefined && write.amountSen !== amountSen) {
      throw new LabError('AMOUNT_INVALID', 'write.amountSen must equal amountSen');
    }
    if (failMode != null && !FAIL_MODES.includes(failMode)) {
      throw new RangeError(`failMode must be one of ${FAIL_MODES.join(', ')}`);
    }
    const current = this.#verified(cardKey, schoolCode);
    const earlier = current.writes.find((w) => isPlainObject(w) && w.orderId === orderId);
    if (earlier) throw new CardError('ALREADY_WRITTEN', undefined, { write: structuredClone(earlier) });
    const balanceBeforeSen = current.balanceSen;
    const balanceAfterSen = balanceBeforeSen + amountSen;
    if (!Number.isSafeInteger(balanceAfterSen)) throw new LabError('AMOUNT_INVALID', 'the card balance would be too large');
    const draft = structuredClone(current);
    draft.balanceSen = balanceAfterSen;
    draft.cardSeq += 1;
    draft.writes = [...draft.writes, { orderId, amountSen, kioskTxn, at }].slice(-CARD_WRITES_KEPT);
    const signed = sign(cardKey, draft);
    if (failMode === 'power-cut-before-commit') throw new PowerCutError(false);
    this.#memory = signed;
    if (failMode === 'power-cut-after-commit') throw new PowerCutError(true);
    return { balanceBeforeSen, balanceAfterSen, cardSeq: draft.cardSeq };
  }

  /**
   * Note on the card the block-list version of the machine that wrote it. The card keeps
   * the highest version it has seen: a machine with an older list does not lower it, and
   * the same version again is not a change (no new cardSeq).
   * @param {{ cardKey: string, version: number, schoolCode?: string }} args
   * @returns {{ listVersionOnCard: number, cardSeq: number, changed: boolean }}
   * @throws {CardError} WRONG_SCHOOL, CARD_UNREADABLE
   */
  setListVersion({ cardKey, version, schoolCode } = {}) {
    if (!Number.isSafeInteger(version) || version < 0) throw new RangeError('version must be a whole number, 0 or more');
    const current = this.#verified(cardKey, schoolCode);
    if (version <= current.listVersionOnCard) {
      return { listVersionOnCard: current.listVersionOnCard, cardSeq: current.cardSeq, changed: false };
    }
    const draft = structuredClone(current);
    draft.listVersionOnCard = version;
    draft.cardSeq += 1;
    this.#memory = sign(cardKey, draft);
    return { listVersionOnCard: version, cardSeq: draft.cardSeq, changed: true };
  }

  /** A byte-for-byte copy (the clone fault): same memory, same valid MAC, its own chip from now on. */
  clone() {
    return VirtualCard.fromMemory(this.#memory);
  }

  /**
   * Edit the balance by hand, without the card key (the tamper fault). The MAC no longer
   * matches, so every machine refuses the card from now on.
   * @param {{ balanceSen: number }} args  Codes: AMOUNT_INVALID
   * @returns {object} the edited memory (copy)
   */
  tamper({ balanceSen } = {}) {
    assertSen(balanceSen, 'balanceSen');
    this.#memory = { ...structuredClone(this.#memory), balanceSen };
    return this.memory;
  }

  /** The live memory once the key, the school and the MAC check out. Callers must not edit it. */
  #verified(cardKey, schoolCode) {
    requireCardKey(cardKey);
    const m = this.#memory;
    if (schoolCode != null && m.school !== schoolCode) throw new CardError('WRONG_SCHOOL', undefined, { cardSchool: m.school });
    if (!macMatches(cardKey, m) || !wellFormed(m)) throw new CardError('CARD_UNREADABLE');
    return m;
  }
}
