import { LabError } from '../shared/errors.js';
import { canonicalJson, sha256hex } from '../shared/crypto.js';
import { CONFIG_KINDS } from '../shared/protocol.js';
import { isHHMM, parseHHMM, parseIso } from '../shared/time.js';

// What the platform tells a school's terminals (docs/DESIGN.md §4.4): the canteen
// price list, the device settings (meal windows and spending limits) and the block
// list of lost cards. Every change is a new version in its own (school, kind) number
// space, so a terminal can say exactly what it runs and the office can see which
// machines are behind.
//
// The block list is stored as a full snapshot per version: any version can be sent
// whole (retained MQTT message, admin card) and the change between two versions is
// worked out from their snapshots. It holds card digests and last4 only, never card
// numbers, so a copy of the list is no help in making a card.

/** How a device's list version reached the platform (device_list_state.via). */
export const LIST_STATE_VIAS = Object.freeze(['MQTT', 'ADMIN_CARD', 'HEARTBEAT', 'PROVISION']);

const ITEM_CODE_RE = /^[A-Z0-9-]{1,24}$/;
const MAX_ITEMS = 50;
const MAX_ITEM_NAME = 40;
const MAX_MEAL_WINDOWS = 6;
const HOLDER_GROUPS = Object.freeze(['STUDENT', 'STAFF']);
// [min, max, unit] of every whole-number field (DESIGN.md §4.4).
const PRICE_RULE = [1, 100_000, 'sen'];
const WATER_RULES = { perLitreSen: [1, 10_000, 'sen'], minChargeSen: [0, 10_000, 'sen'] };
const SETTINGS_RULES = {
  perPurchaseMaxSen: [1, 100_000, 'sen'],
  dailyMaxSen: [1, 1_000_000, 'sen'],
  dailyMaxCount: [1, 100, ''],
  tapGapSeconds: [0, 600, 'seconds'],
};
/** Kinds publish() takes; the block list only changes card by card (blockCard / unblockCard). */
const PUBLISH_KINDS = Object.freeze(['prices', 'settings']);
/** Admin-card packs, in the order DESIGN.md §4.4 lists them. */
const PACK_KINDS = Object.freeze(['blocklist', 'prices', 'settings']);
const DEFAULT_HISTORY = 20;
const MAX_HISTORY = 1000;
// Times leave the platform as ISO-8601 strings (config.prices / config.settings bodies), and
// parseIso() only reads 4-digit years, so 9999-12-31T23:59:59.999Z is the last usable instant.
const MAX_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
// Line breaks and other control characters would break terminal screens and console lines.
const CONTROL_CHAR_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}

/** The lab's first price list: a made-up Malaysian school canteen menu, in sen. */
export const DEFAULT_PRICES = deepFreeze({
  items: [
    { code: 'NASI-LEMAK', name: 'Nasi lemak', priceSen: 350 },
    { code: 'MEE-GORENG', name: 'Mee goreng', priceSen: 400 },
    { code: 'ROTI-CANAI', name: 'Roti canai', priceSen: 150 },
    { code: 'TEH-TARIK', name: 'Teh tarik', priceSen: 180 },
    { code: 'MILO-AIS', name: 'Milo ais', priceSen: 220 },
    { code: 'AIR-SIRAP', name: 'Air sirap', priceSen: 120 },
    { code: 'BUAH', name: 'Fruit', priceSen: 100 },
  ],
  water: { perLitreSen: 20, minChargeSen: 5 },
});

/** First device settings: open 06:30-18:30 KL time, RM 20 a purchase, RM 30 and 10 purchases a day. */
export const DEFAULT_SETTINGS = deepFreeze({
  mealWindows: [{ from: '06:30', to: '18:30' }],
  allowedGroups: ['STUDENT', 'STAFF'],
  perPurchaseMaxSen: 2000,
  dailyMaxSen: 3000,
  dailyMaxCount: 10,
  tapGapSeconds: 3,
});

// ---- validation -------------------------------------------------------------

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** What was given, for a problem message: 'missing' or 'got …' (short, never a whole object). */
function given(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'got null';
  if (Array.isArray(value)) return `got a list of ${value.length}`;
  if (typeof value === 'string') return `got ${JSON.stringify(value.length > 32 ? `${value.slice(0, 32)}…` : value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `got ${String(value)}`;
  return `got ${typeof value === 'object' ? 'an object' : `a ${typeof value}`}`;
}

/** CONFIG_INVALID with every problem in `detail`; the message shows the first few. */
function configInvalid(subject, problems) {
  const more = problems.length > 3 ? `; and ${problems.length - 3} more` : '';
  return new LabError('CONFIG_INVALID', `${subject}: ${problems.slice(0, 3).join('; ')}${more}`, 400, problems);
}

function checkWhole(problems, value, path, [min, max, unit]) {
  if (Number.isSafeInteger(value) && value >= min && value <= max) return;
  problems.push(`${path} must be a whole number${unit ? ` of ${unit}` : ''} from ${min} to ${max} (${given(value)})`);
}

// Unknown fields are refused rather than dropped: a typo such as "perLiterSen" must not
// quietly publish a price list without the field the office meant to set.
function checkFields(problems, obj, allowed, where) {
  const extra = Object.keys(obj).filter((k) => obj[k] !== undefined && !allowed.includes(k));
  if (extra.length === 0) return;
  const names = extra.slice(0, 5).map((k) => JSON.stringify(k)).join(', ');
  const more = extra.length > 5 ? ` and ${extra.length - 5} more` : '';
  problems.push(`${where}: unknown field${extra.length > 1 ? 's' : ''} ${names}${more} (allowed: ${allowed.join(', ')})`);
}

const isTime = (v) => typeof v === 'string' && isHHMM(v);

/**
 * Check a price list and return the clean copy to store. Item codes are trimmed and
 * upper-cased (office input), names trimmed. Every problem is reported at once.
 * Shape: `{ items: [{ code, name, priceSen }] (1-50, codes unique), water: { perLitreSen, minChargeSen } }`.
 * @param {unknown} content
 * @returns {{ items: Array<{ code: string, name: string, priceSen: number }>, water: { perLitreSen: number, minChargeSen: number } }}
 * @throws {LabError} CONFIG_INVALID (400), `detail` = list of problems
 */
export function validatePrices(content) {
  const subject = 'invalid price list';
  if (!isPlainObject(content)) throw configInvalid(subject, [`the price list must be an object { items, water } (${given(content)})`]);
  const problems = [];
  checkFields(problems, content, ['items', 'water'], 'price list');

  const items = [];
  const list = content.items;
  // A list that is too long is reported as one problem, not one per entry.
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) {
    problems.push(`items must be a list of 1 to ${MAX_ITEMS} items (${given(list)})`);
  } else {
    const firstUse = new Map();
    // index loops, not forEach: forEach skips the holes of a sparse array, which would pass unchecked
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const at = `items[${i}]`;
      if (!isPlainObject(item)) {
        problems.push(`${at} must be an object { code, name, priceSen } (${given(item)})`);
        continue;
      }
      checkFields(problems, item, ['code', 'name', 'priceSen'], at);
      const code = typeof item.code === 'string' ? item.code.trim().toUpperCase() : null;
      if (code === null || !ITEM_CODE_RE.test(code)) {
        problems.push(`${at}.code must be 1 to 24 characters of A-Z, 0-9 and "-" (${given(item.code)})`);
      } else if (firstUse.has(code)) {
        problems.push(`${at}.code ${code} is already used by items[${firstUse.get(code)}]`);
      } else {
        firstUse.set(code, i);
      }
      const name = typeof item.name === 'string' ? item.name.trim() : null;
      if (name === null || name.length < 1 || name.length > MAX_ITEM_NAME) {
        problems.push(`${at}.name must be text of 1 to ${MAX_ITEM_NAME} characters (${given(item.name)})`);
      } else if (CONTROL_CHAR_RE.test(name)) {
        problems.push(`${at}.name must not contain line breaks, tabs or other control characters (${given(item.name)})`);
      }
      checkWhole(problems, item.priceSen, `${at}.priceSen`, PRICE_RULE);
      items.push({ code, name, priceSen: item.priceSen });
    }
  }

  const water = content.water;
  if (!isPlainObject(water)) {
    problems.push(`water must be an object { perLitreSen, minChargeSen } (${given(water)})`);
  } else {
    checkFields(problems, water, Object.keys(WATER_RULES), 'water');
    for (const [field, rule] of Object.entries(WATER_RULES)) checkWhole(problems, water[field], `water.${field}`, rule);
  }

  if (problems.length) throw configInvalid(subject, problems);
  return { items, water: { perLitreSen: water.perLitreSen, minChargeSen: water.minChargeSen } };
}

/**
 * Check device settings and return the clean copy to store. Every problem is reported at once.
 * Shape: `{ mealWindows: [{ from: 'HH:MM', to: 'HH:MM' }] (0-6, from < to), allowedGroups: non-empty
 * subset of STUDENT/STAFF, perPurchaseMaxSen 1..100000, dailyMaxSen 1..1000000, dailyMaxCount 1..100,
 * tapGapSeconds 0..600 }`. No meal windows means no time limit.
 * @param {unknown} content
 * @returns {{ mealWindows: Array<{ from: string, to: string }>, allowedGroups: string[], perPurchaseMaxSen: number,
 *   dailyMaxSen: number, dailyMaxCount: number, tapGapSeconds: number }}
 * @throws {LabError} CONFIG_INVALID (400), `detail` = list of problems
 */
export function validateSettings(content) {
  const subject = 'invalid device settings';
  if (!isPlainObject(content)) throw configInvalid(subject, [`the settings must be an object (${given(content)})`]);
  const problems = [];
  checkFields(problems, content, ['mealWindows', 'allowedGroups', ...Object.keys(SETTINGS_RULES)], 'settings');

  const mealWindows = [];
  const windows = content.mealWindows;
  if (!Array.isArray(windows) || windows.length > MAX_MEAL_WINDOWS) {
    problems.push(`mealWindows must be a list of 0 to ${MAX_MEAL_WINDOWS} windows (${given(windows)})`);
  } else {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const at = `mealWindows[${i}]`;
      if (!isPlainObject(w)) {
        problems.push(`${at} must be an object { from, to } (${given(w)})`);
        continue;
      }
      checkFields(problems, w, ['from', 'to'], at);
      if (!isTime(w.from)) problems.push(`${at}.from must be a 24-hour time "HH:MM" (${given(w.from)})`);
      if (!isTime(w.to)) problems.push(`${at}.to must be a 24-hour time "HH:MM" (${given(w.to)})`);
      // `to` is exclusive and a window cannot run past midnight (shared/time.js inWindows)
      if (isTime(w.from) && isTime(w.to) && parseHHMM(w.from) >= parseHHMM(w.to)) {
        problems.push(`${at}: from (${w.from}) must be earlier than to (${w.to})`);
      }
      mealWindows.push({ from: w.from, to: w.to });
    }
  }

  const groups = content.allowedGroups;
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > HOLDER_GROUPS.length) {
    problems.push(`allowedGroups must list 1 to ${HOLDER_GROUPS.length} of ${HOLDER_GROUPS.join(', ')}, each once (${given(groups)})`);
  } else {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!HOLDER_GROUPS.includes(g)) problems.push(`allowedGroups[${i}] must be one of ${HOLDER_GROUPS.join(', ')} (${given(g)})`);
      else if (groups.indexOf(g) !== i) problems.push(`allowedGroups[${i}]: ${g} is listed twice`);
    }
  }

  for (const [field, rule] of Object.entries(SETTINGS_RULES)) checkWhole(problems, content[field], field, rule);

  if (problems.length) throw configInvalid(subject, problems);
  return {
    mealWindows,
    allowedGroups: [...groups],
    perPurchaseMaxSen: content.perPurchaseMaxSen,
    dailyMaxSen: content.dailyMaxSen,
    dailyMaxCount: content.dailyMaxCount,
    tapGapSeconds: content.tapGapSeconds,
  };
}

// ---- helpers for the service -------------------------------------------------

const isId = (v) => typeof v === 'string' && v.length > 0;
/** SQLite cannot bind `undefined`; null matches no row, so a bad id simply finds nothing. */
const asId = (v) => (isId(v) ? v : null);

function requireKind(kind) {
  if (CONFIG_KINDS.includes(kind)) return kind;
  throw configInvalid('invalid config request', [`kind must be one of ${CONFIG_KINDS.join(', ')} (${given(kind)})`]);
}

/** Lab-clock ms from ms or an ISO-8601 string; null when not given (meaning now). */
function effectiveFromMs(value) {
  if (value === undefined || value === null) return null;
  const ms = typeof value === 'string' ? parseIso(value) : value;
  if (Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_ISO_MS) return ms;
  throw configInvalid('invalid config request', [
    `effectiveFrom must be lab-clock milliseconds or an ISO-8601 timestamp, from 1970 to the end of 9999 (${given(value)})`,
  ]);
}

/** Who made a version, as stored in config_version.created_by (same forms the audit accepts). */
function actorText(actor) {
  if (typeof actor === 'string' && actor.trim()) return actor.trim().slice(0, 120);
  if (actor && typeof actor === 'object' && (actor.id || actor.name)) {
    return [actor.name, actor.id && `(${actor.id})`].filter(Boolean).join(' ').slice(0, 120);
  }
  return null;
}

const packChecksum = (content) => sha256hex(canonicalJson(content));

/**
 * @typedef {{ card: string, last4: string }} BlockEntry  card = 64-hex card digest
 * @typedef {{ kind: string, version: number, content: object, effectiveFrom: number, createdAt: number }} ConfigVersion
 */

/**
 * Versioned prices, settings and block lists, admin-card packs and tokens, and the
 * versions each device reported. All functions are synchronous.
 * @param {object} ctx  see docs/DESIGN.md "The context object"
 * @param {{ schools?: { audit?: Function } }} [deps]  the schools service, used for the audit trail when given
 */
export function createConfigs(ctx, { schools } = {}) {
  const { db, clock, events } = ctx;

  const audit = (schoolId, actor, action, detail) => {
    if (typeof schools?.audit === 'function') schools.audit(schoolId, actor, action, detail);
  };

  function requireSchool(schoolId) {
    const row = isId(schoolId) ? db.get('SELECT id, code FROM school WHERE id = ?', schoolId) : undefined;
    if (!row) throw new LabError('SCHOOL_NOT_FOUND', 'no such school', 404);
    return row;
  }

  /** @returns {ConfigVersion} */
  const versionDto = (row) => ({
    kind: row.kind,
    version: row.version,
    content: JSON.parse(row.content),
    effectiveFrom: row.effective_from,
    createdAt: row.created_at,
  });

  // Every school starts from an empty block list, version 0, before any card is blocked.
  const emptyBlockList = () => ({ kind: 'blocklist', version: 0, content: { entries: [] } });

  const latestRow = (schoolId, kind) =>
    db.get('SELECT * FROM config_version WHERE school_id = ? AND kind = ? ORDER BY version DESC LIMIT 1', asId(schoolId), kind);

  const versionRow = (schoolId, kind, version) =>
    db.get('SELECT * FROM config_version WHERE school_id = ? AND kind = ? AND version = ?', asId(schoolId), kind, version);

  /** @returns {BlockEntry[]} */
  const entriesOf = (row) => (row ? JSON.parse(row.content).entries : []);

  /** Highest version of every kind in the school (0 when none). */
  function currentVersions(schoolId) {
    const out = Object.fromEntries(CONFIG_KINDS.map((k) => [k, 0]));
    for (const r of db.all('SELECT kind, max(version) AS v FROM config_version WHERE school_id = ? GROUP BY kind', asId(schoolId))) {
      out[r.kind] = r.v;
    }
    return out;
  }

  /**
   * Store the next version of (school, kind). Must run inside db.tx: reading the highest
   * number and writing the next one together is what keeps versions strictly increasing.
   */
  function insertVersion(schoolId, kind, content, effectiveFrom, actor) {
    const { v } = db.get('SELECT coalesce(max(version), 0) AS v FROM config_version WHERE school_id = ? AND kind = ?', schoolId, kind);
    const version = v + 1;
    db.run(
      'INSERT INTO config_version (school_id, kind, version, content, effective_from, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      schoolId, kind, version, JSON.stringify(content), effectiveFrom, clock.now(), actorText(actor),
    );
    return version;
  }

  /**
   * Publish a new price list or settings version.
   * Codes: CONFIG_INVALID (400; also for a kind other than prices/settings or a bad
   * effectiveFrom), SCHOOL_NOT_FOUND (404).
   * @param {{ schoolId: string, kind: 'prices'|'settings', content: object, effectiveFrom?: number|string, actor?: unknown }} args
   *   effectiveFrom: lab-clock ms or ISO-8601, default now
   * @returns {{ kind: string, version: number, content: object, effectiveFrom: number }}
   */
  function publish({ schoolId, kind, content, effectiveFrom, actor } = {}) {
    if (!PUBLISH_KINDS.includes(kind)) {
      throw configInvalid('invalid config request', [
        `kind must be prices or settings (${given(kind)}); the block list changes through blockCard and unblockCard`,
      ]);
    }
    const clean = kind === 'prices' ? validatePrices(content) : validateSettings(content);
    const from = effectiveFromMs(effectiveFrom);
    const { school, version, effective } = db.tx(() => {
      const school = requireSchool(schoolId);
      const effective = from ?? clock.now();
      const version = insertVersion(schoolId, kind, clean, effective, actor);
      audit(schoolId, actor, 'config.publish', { kind, version });
      return { school, version, effective };
    });
    // Announced after our own transaction (or savepoint) has succeeded.
    events.emit('config.published', { kind, version }, school.code);
    return { kind, version, content: clean, effectiveFrom: effective };
  }

  /**
   * The newest version of a kind, or null. The block list is never null: with no
   * versions it is `{ kind: 'blocklist', version: 0, content: { entries: [] } }`.
   * Codes: CONFIG_INVALID for an unknown kind.
   * @returns {ConfigVersion | { kind: 'blocklist', version: 0, content: { entries: [] } } | null}
   */
  function current(schoolId, kind) {
    requireKind(kind);
    const row = latestRow(schoolId, kind);
    if (row) return versionDto(row);
    return kind === 'blocklist' ? emptyBlockList() : null;
  }

  /**
   * One version (settlement checks a record's priceVersion with it), or null if it was
   * never issued. Block-list version 0 is the empty list every school starts from.
   * Codes: CONFIG_INVALID for an unknown kind.
   */
  function getVersion(schoolId, kind, version) {
    requireKind(kind);
    if (!Number.isSafeInteger(version) || version < 0) return null;
    if (version === 0) return kind === 'blocklist' ? emptyBlockList() : null;
    const row = versionRow(schoolId, kind, version);
    return row ? versionDto(row) : null;
  }

  /**
   * Versions of a kind, newest first. `limit` may be the query string's text; anything
   * unusable means 20. Codes: CONFIG_INVALID for an unknown kind.
   * @returns {ConfigVersion[]}
   */
  function history(schoolId, kind, limit = DEFAULT_HISTORY) {
    requireKind(kind);
    const asked = Number(limit);
    const n = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, MAX_HISTORY) : DEFAULT_HISTORY;
    return db
      .all('SELECT * FROM config_version WHERE school_id = ? AND kind = ? ORDER BY version DESC LIMIT ?', asId(schoolId), kind, n)
      .map(versionDto);
  }

  // ---- block list ------------------------------------------------------------

  /** Shared by blockCard (block = true) and unblockCard (block = false). */
  function changeBlockList({ schoolId, cardId, actor } = {}, block) {
    const result = db.tx(() => {
      const school = requireSchool(schoolId);
      // the card must be this school's: one school can never list or free another school's card
      const card = isId(cardId) ? db.get('SELECT id, uid, digest FROM card WHERE school_id = ? AND id = ?', schoolId, cardId) : undefined;
      if (!card) throw new LabError('CARD_NOT_FOUND', 'no such card in this school', 404);
      const latest = latestRow(schoolId, 'blocklist');
      const entries = entriesOf(latest);
      const listed = entries.some((e) => e.card === card.digest);
      if (listed === block) return { school, version: latest?.version ?? 0, changed: false };
      const entry = { card: card.digest, last4: String(card.uid).slice(-4).toUpperCase() };
      const content = block
        ? { entries: [...entries, entry], added: [entry], removed: [] }
        : { entries: entries.filter((e) => e.card !== card.digest), added: [], removed: [card.digest] };
      const version = insertVersion(schoolId, 'blocklist', content, clock.now(), actor);
      audit(schoolId, actor, block ? 'blocklist.block' : 'blocklist.unblock', { cardId: card.id, last4: entry.last4, version });
      return { school, version, changed: true };
    });
    if (result.changed) events.emit('config.published', { kind: 'blocklist', version: result.version }, result.school.code);
    return { version: result.version, changed: result.changed };
  }

  /**
   * Put a card on the school's block list as a new version. Already listed: no new
   * version, `changed: false` and the current version.
   * Codes: SCHOOL_NOT_FOUND (404), CARD_NOT_FOUND (404, also for another school's card).
   * @param {{ schoolId: string, cardId: string, actor?: unknown }} args
   * @returns {{ version: number, changed: boolean }}
   */
  function blockCard(args) {
    return changeBlockList(args, true);
  }

  /**
   * Take a card off the block list as a new version. Not listed: no new version,
   * `changed: false` and the current version (0 if the school never had a list).
   * Codes: SCHOOL_NOT_FOUND (404), CARD_NOT_FOUND (404).
   * @param {{ schoolId: string, cardId: string, actor?: unknown }} args
   * @returns {{ version: number, changed: boolean }}
   */
  function unblockCard(args) {
    return changeBlockList(args, false);
  }

  /** @returns {{ version: number, entries: BlockEntry[] }} version 0 and no entries before the first block */
  function currentBlockList(schoolId) {
    const row = latestRow(schoolId, 'blocklist');
    return { version: row ? row.version : 0, entries: entriesOf(row) };
  }

  /**
   * Net change from `fromVersion` to the current version, worked out from the two
   * snapshots: a card blocked and freed again in between is in neither list. Version 0
   * is the empty list. Null when `fromVersion` was never issued (the device then needs
   * the whole snapshot).
   * @returns {{ fromVersion: number, toVersion: number, added: BlockEntry[], removed: string[] } | null}
   */
  function blockListDelta(schoolId, fromVersion) {
    if (!Number.isSafeInteger(fromVersion) || fromVersion < 0) return null;
    const to = latestRow(schoolId, 'blocklist');
    const toVersion = to ? to.version : 0;
    if (fromVersion > toVersion) return null;
    let before = [];
    if (fromVersion > 0) {
      const from = versionRow(schoolId, 'blocklist', fromVersion);
      if (!from) return null;
      before = entriesOf(from);
    }
    const after = entriesOf(to);
    const wasListed = new Set(before.map((e) => e.card));
    const isListed = new Set(after.map((e) => e.card));
    return {
      fromVersion,
      toVersion,
      added: after.filter((e) => !wasListed.has(e.card)).map((e) => ({ card: e.card, last4: e.last4 })),
      removed: before.filter((e) => !isListed.has(e.card)).map((e) => e.card),
    };
  }

  // ---- admin card --------------------------------------------------------------

  /**
   * What an admin card carries for offline terminals: the newest version of each kind
   * that has one (blocklist, prices, settings), with `checksum = sha256hex(canonicalJson(content))`
   * so a terminal can refuse a damaged pack. The block-list pack holds `{ entries }` only.
   * @returns {Array<{ kind: string, version: number, content: object, checksum: string }>}
   */
  function packs(schoolId) {
    const out = [];
    for (const kind of PACK_KINDS) {
      const row = latestRow(schoolId, kind);
      if (!row) continue;
      const stored = JSON.parse(row.content);
      const content = kind === 'blocklist' ? { entries: stored.entries } : stored;
      out.push({ kind, version: row.version, content, checksum: packChecksum(content) });
    }
    return out;
  }

  /**
   * The next admin-card token of the school (stored, strictly increasing). Terminals only
   * take packs from a card whose token is higher than any they have seen, so an old card
   * cannot roll them back. Codes: SCHOOL_NOT_FOUND (404).
   * @returns {number}
   */
  function nextAdminCardToken(schoolId) {
    return db.tx(() => {
      requireSchool(schoolId);
      db.run('UPDATE school SET admin_card_token = admin_card_token + 1 WHERE id = ?', schoolId);
      return db.get('SELECT admin_card_token AS token FROM school WHERE id = ?', schoolId).token;
    });
  }

  // ---- device list state -------------------------------------------------------

  const stateDto = (row) => ({
    deviceId: row.device_id,
    kind: row.kind,
    appliedVersion: row.applied_version,
    via: row.via,
    updatedAt: row.updated_at,
  });

  /**
   * Store the version a device runs for one kind. Heartbeats, acks and provisioning say
   * what the device runs now, so they always replace the stored version. Admin-card
   * receipts reach the platform later (when the card is back at a kiosk), so a receipt
   * never lowers a version the device has reported since.
   * `schoolId` is optional: when given, the device must belong to that school.
   * Codes: CONFIG_INVALID (bad kind, version or via), DEVICE_NOT_FOUND (404).
   * @param {{ deviceId: string, kind: string, version: number, via: string, schoolId?: string }} args
   * @returns {{ deviceId: string, kind: string, appliedVersion: number, via: string, updatedAt: number }} the stored state
   */
  function recordListState({ deviceId, kind, version, via, schoolId } = {}) {
    const problems = [];
    if (!CONFIG_KINDS.includes(kind)) problems.push(`kind must be one of ${CONFIG_KINDS.join(', ')} (${given(kind)})`);
    if (!Number.isSafeInteger(version) || version < 0) problems.push(`version must be a whole number, 0 or more (${given(version)})`);
    if (!LIST_STATE_VIAS.includes(via)) problems.push(`via must be one of ${LIST_STATE_VIAS.join(', ')} (${given(via)})`);
    if (problems.length) throw configInvalid('invalid list state', problems);
    return db.tx(() => {
      const device =
        schoolId == null
          ? db.get('SELECT id FROM device WHERE id = ?', asId(deviceId))
          : db.get('SELECT id FROM device WHERE school_id = ? AND id = ?', asId(schoolId), asId(deviceId));
      if (!device) throw new LabError('DEVICE_NOT_FOUND', 'no such device', 404);
      db.run(
        `INSERT INTO device_list_state (device_id, kind, applied_version, via, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (device_id, kind) DO UPDATE SET
           applied_version = excluded.applied_version, via = excluded.via, updated_at = excluded.updated_at
         WHERE excluded.via <> 'ADMIN_CARD' OR excluded.applied_version >= device_list_state.applied_version`,
        device.id, kind, version, via, clock.now(),
      );
      return stateDto(db.get('SELECT * FROM device_list_state WHERE device_id = ? AND kind = ?', device.id, kind));
    });
  }

  /**
   * One row per device of the school and kind (prices, settings, blocklist), by device
   * code. A kind the device never reported has appliedVersion 0, via and updatedAt null.
   * `behind` is true when the device runs an older version than the current one.
   * @returns {Array<{ deviceId: string, deviceCode: string, kind: string, appliedVersion: number, via: string|null,
   *   updatedAt: number|null, currentVersion: number, behind: boolean }>}
   */
  function listStates(schoolId) {
    const devices = db.all('SELECT id, code FROM device WHERE school_id = ? ORDER BY code', asId(schoolId));
    if (devices.length === 0) return [];
    const states = new Map();
    for (const s of db.all(
      'SELECT s.* FROM device_list_state s JOIN device d ON d.id = s.device_id WHERE d.school_id = ?',
      asId(schoolId),
    )) {
      states.set(`${s.device_id}/${s.kind}`, s);
    }
    const latest = currentVersions(schoolId);
    return devices.flatMap((d) =>
      CONFIG_KINDS.map((kind) => {
        const s = states.get(`${d.id}/${kind}`);
        const appliedVersion = s ? s.applied_version : 0;
        return {
          deviceId: d.id,
          deviceCode: d.code,
          kind,
          appliedVersion,
          via: s ? s.via : null,
          updatedAt: s ? s.updated_at : null,
          currentVersion: latest[kind],
          behind: appliedVersion < latest[kind],
        };
      }),
    );
  }

  return {
    publish,
    current,
    getVersion,
    history,
    blockCard,
    unblockCard,
    currentBlockList,
    blockListDelta,
    packs,
    nextAdminCardToken,
    recordListState,
    listStates,
  };
}
