import { LabError } from '../shared/errors.js';
import { newId, newCode } from '../shared/ids.js';
import { randomSecret, normalizeUid, cardDigest } from '../shared/crypto.js';
import { SCHOOL_CODE_RE } from '../shared/protocol.js';

// Schools and what belongs to them: staff, members (cardholders), cards, invitation
// codes, parent links and the audit trail. Parents are the one record that spans
// schools (a parent can have children in two schools); everything else is looked up
// with its school_id, so one school can never read or change another school's data.

/** Settings every school starts with. A school stores only what it changed. */
export const DEFAULT_SCHOOL_SETTINGS = deepFreeze({
  topup: { minSen: 500, maxSen: 20000, dailyMaxSen: 30000, monthlyMaxSen: 100000, payWindowMinutes: 30, addWindowDays: 14 },
});

// Allowed whole-number range for every setting a school may change.
const SETTINGS_RULES = {
  topup: {
    minSen: [1, 10_000_000],
    maxSen: [1, 10_000_000],
    dailyMaxSen: [1, 100_000_000],
    monthlyMaxSen: [1, 1_000_000_000],
    payWindowMinutes: [1, 7 * 24 * 60],
    addWindowDays: [1, 366],
  },
};

const SCHOOL_STATUSES = ['ACTIVE', 'SUSPENDED'];
const STAFF_ROLES = ['OFFICE', 'FINANCE', 'ADMIN'];
const MEMBER_GROUPS = ['STUDENT', 'STAFF'];
// Deliberately simple: something@domain.tld, no spaces. Real checking is the confirmation mail's job.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep merge for settings: plain objects merge key by key, anything else replaces.
 * `null` removes the key (so a school can go back to the default); `undefined` is skipped.
 */
function mergeSettings(base, patch) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeSettings(out[key], value);
    else out[key] = structuredClone(value);
  }
  return out;
}

/** Shape problems in a settings patch, as a list of messages (empty = fine). */
function settingsPatchProblems(patch) {
  if (!isPlainObject(patch)) return ['settings must be an object'];
  const problems = [];
  for (const [section, fields] of Object.entries(patch)) {
    if (fields === undefined || fields === null) continue;
    const rules = SETTINGS_RULES[section];
    if (!rules) {
      problems.push(`unknown settings section ${section}`);
      continue;
    }
    if (!isPlainObject(fields)) {
      problems.push(`${section} must be an object`);
      continue;
    }
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      const range = rules[field];
      if (!range) problems.push(`unknown setting ${section}.${field}`);
      else if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
        problems.push(`${section}.${field} must be a whole number from ${range[0]} to ${range[1]}`);
      }
    }
  }
  return problems;
}

/** Rules that need the whole (merged) settings. */
function effectiveSettingsProblems(settings) {
  const { minSen, maxSen } = settings.topup;
  return minSen > maxSen ? ['topup.minSen must not be more than topup.maxSen'] : [];
}

/** Stored override object after applying `patch`, or throws SETTINGS_INVALID. */
function applySettingsPatch(stored, patch) {
  const problems = settingsPatchProblems(patch);
  if (problems.length) throw new LabError('SETTINGS_INVALID', problems.join('; '), 400, problems);
  const next = mergeSettings(stored, patch);
  // drop sections that went back to all defaults, so the stored JSON stays minimal
  for (const [k, v] of Object.entries(next)) if (isPlainObject(v) && Object.keys(v).length === 0) delete next[k];
  const merged = mergeSettings(DEFAULT_SCHOOL_SETTINGS, next);
  const more = effectiveSettingsProblems(merged);
  if (more.length) throw new LabError('SETTINGS_INVALID', more.join('; '), 400, more);
  return next;
}

/** Trimmed text of `min`..`max` characters, or throws `code`. */
function text(value, { code, field, min = 1, max = 100 }) {
  const s = typeof value === 'string' ? value.trim() : null;
  if (s === null || s.length < min || s.length > max) {
    throw new LabError(code, `${field} must be text of ${min} to ${max} characters`);
  }
  return s;
}

/**
 * Audit rows and link decisions store who did it as text. Callers pass a string
 * ('staff:stf_x', 'system', …); a staff object is accepted too so nothing is lost.
 */
function actorText(actor) {
  if (typeof actor === 'string' && actor.trim()) return actor.trim().slice(0, 120);
  if (actor && typeof actor === 'object' && (actor.id || actor.name)) {
    return [actor.name, actor.id && `(${actor.id})`].filter(Boolean).join(' ').slice(0, 120);
  }
  return 'system';
}

const isId = (v) => typeof v === 'string' && v.length > 0;

/**
 * Schools, staff, members, cards, parents, invites, links and audit.
 * All functions are synchronous; multi-step writes run in one transaction.
 */
export function createSchools(ctx) {
  const { db, clock, events } = ctx;

  // ---- rows -> DTOs --------------------------------------------------------

  const storedSettings = (row) => JSON.parse(row.settings || '{}');
  const effectiveSettings = (row) => mergeSettings(DEFAULT_SCHOOL_SETTINGS, storedSettings(row));

  const schoolDto = (row) =>
    row
      ? { id: row.id, code: row.code, name: row.name, status: row.status, settings: effectiveSettings(row), createdAt: row.created_at }
      : null;

  const staffDto = (row) => (row ? { id: row.id, schoolId: row.school_id, name: row.name, role: row.role } : null);

  const cardDto = (row) =>
    row
      ? {
          id: row.id,
          schoolId: row.school_id,
          uid: row.uid,
          last4: row.uid.slice(-4),
          digest: row.digest,
          memberId: row.member_id ?? null,
          status: row.status,
          issuedAt: row.issued_at,
          lostAt: row.lost_at ?? null,
          lostListVersion: row.lost_list_version ?? null,
        }
      : null;

  const cardSummary = (row) => (row ? { uid: row.uid, last4: row.uid.slice(-4), status: row.status } : null);

  // The card shown next to a member: the ACTIVE one, otherwise the newest one,
  // so the office (and a parent) can see that the card is LOST.
  const CARD_PREFERENCE = "ORDER BY (status = 'ACTIVE') DESC, issued_at DESC, rowid DESC";

  const memberCard = (schoolId, memberId) =>
    cardSummary(db.get(`SELECT uid, status FROM card WHERE school_id = ? AND member_id = ? ${CARD_PREFERENCE} LIMIT 1`, schoolId, memberId));

  const memberDto = (row, card) => ({
    id: row.id,
    memberNo: row.member_no,
    name: row.name,
    className: row.class_name,
    group: row.holder_group,
    status: row.status,
    card,
  });

  const parentDto = (row) => (row ? { id: row.id, email: row.email, name: row.name } : null);

  const inviteDto = (row) => ({ id: row.id, code: row.code, memberId: row.member_id, status: row.status });

  const LINK_SELECT = `
    SELECT l.*, p.name AS parent_name, p.email AS parent_email, m.name AS member_name
    FROM parent_link l
    JOIN parent p ON p.id = l.parent_id
    JOIN member m ON m.id = l.member_id AND m.school_id = l.school_id`;

  const linkDto = (row) =>
    row
      ? {
          id: row.id,
          parentId: row.parent_id,
          parentName: row.parent_name,
          parentEmail: row.parent_email,
          memberId: row.member_id,
          memberName: row.member_name,
          status: row.status,
          createdAt: row.created_at,
        }
      : null;

  const getLink = (schoolId, linkId) => linkDto(db.get(`${LINK_SELECT} WHERE l.school_id = ? AND l.id = ?`, schoolId, linkId));

  // ---- lookups that throw -------------------------------------------------

  const schoolRow = (id) => (isId(id) ? db.get('SELECT * FROM school WHERE id = ?', id) : undefined);

  function requireSchool(schoolId) {
    const row = schoolRow(schoolId);
    if (!row) throw new LabError('SCHOOL_NOT_FOUND', 'no such school', 404);
    return row;
  }

  function requireMember(schoolId, memberId) {
    const row = isId(memberId) ? db.get('SELECT * FROM member WHERE school_id = ? AND id = ?', schoolId, memberId) : undefined;
    if (!row) throw new LabError('MEMBER_NOT_FOUND', 'no such member in this school', 404);
    return row;
  }

  function requireCardByUid(schoolId, uid) {
    const row = db.get('SELECT * FROM card WHERE school_id = ? AND uid = ?', schoolId, normalizeUid(uid));
    if (!row) throw new LabError('CARD_NOT_FOUND', 'no such card in this school', 404);
    return row;
  }

  const codeOf = (schoolId) => (isId(schoolId) ? db.get('SELECT code FROM school WHERE id = ?', schoolId)?.code ?? null : null);

  const cardRowById = (schoolId, cardId) => db.get('SELECT * FROM card WHERE school_id = ? AND id = ?', schoolId, cardId);

  // ---- audit ---------------------------------------------------------------

  /**
   * Append to the school's audit trail and show it in the lab console.
   * @returns {{id:number, schoolId:string|null, actor:string, action:string, detail:unknown, at:number}}
   */
  function audit(schoolId, actor, action, detail = null) {
    const at = clock.now();
    const who = actorText(actor);
    const what = String(action);
    const { lastInsertRowid } = db.run(
      'INSERT INTO audit (school_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)',
      schoolId ?? null, who, what, detail == null ? null : JSON.stringify(detail), at,
    );
    events.emit('audit', { actor: who, action: what, detail: detail ?? null }, codeOf(schoolId));
    return { id: Number(lastInsertRowid), schoolId: schoolId ?? null, actor: who, action: what, detail: detail ?? null, at };
  }

  return {
    // ---- schools -----------------------------------------------------------

    /** @returns school DTO (never the card key) */
    createSchool({ code, name, settings } = {}) {
      if (typeof code !== 'string' || !SCHOOL_CODE_RE.test(code)) {
        throw new LabError('SCHOOL_CODE_INVALID', 'school code must be lower-case letters, digits and dashes (e.g. smk-contoh)');
      }
      const cleanName = text(name, { code: 'NAME_INVALID', field: 'school name' });
      const stored = settings === undefined ? {} : applySettingsPatch({}, settings);
      return db.tx(() => {
        if (db.get('SELECT 1 FROM school WHERE code = ?', code)) {
          throw new LabError('SCHOOL_CODE_TAKEN', `school code ${code} is already used`, 409);
        }
        const id = newId('sch');
        // Each school gets its own card key: card digests and card MACs of one school mean nothing in another.
        db.run(
          'INSERT INTO school (id, code, name, card_key, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          id, code, cleanName, randomSecret(), JSON.stringify(stored), clock.now(),
        );
        audit(id, 'system', 'school.create', { code, name: cleanName });
        return schoolDto(schoolRow(id));
      });
    },

    getSchool(id) {
      return schoolDto(schoolRow(id));
    },

    /** @returns school DTO, or null if no school has this code */
    getSchoolByCode(code) {
      if (typeof code !== 'string') return null;
      return schoolDto(db.get('SELECT * FROM school WHERE code = ?', code));
    },

    listSchools() {
      return db.all('SELECT * FROM school ORDER BY created_at, rowid').map(schoolDto);
    },

    /** ACTIVE or SUSPENDED. A suspended school's devices are refused by intake and the broker. */
    setSchoolStatus(schoolId, status, actor) {
      if (!SCHOOL_STATUSES.includes(status)) throw new LabError('SCHOOL_STATUS_INVALID', `status must be one of ${SCHOOL_STATUSES.join(', ')}`);
      return db.tx(() => {
        const row = requireSchool(schoolId);
        if (row.status !== status) {
          db.run('UPDATE school SET status = ? WHERE id = ?', status, schoolId);
          audit(schoolId, actor, 'school.status', { from: row.status, to: status });
        }
        return schoolDto(schoolRow(schoolId));
      });
    },

    /** Defaults deep-merged with what the school changed. */
    schoolSettings(schoolId) {
      return effectiveSettings(requireSchool(schoolId));
    },

    /**
     * Deep-merge `patch` into the school's settings (`null` resets a value to the default).
     * @returns the school's settings after the change
     */
    updateSchoolSettings(schoolId, patch, actor) {
      return db.tx(() => {
        const row = requireSchool(schoolId);
        const next = applySettingsPatch(storedSettings(row), patch);
        db.run('UPDATE school SET settings = ? WHERE id = ?', JSON.stringify(next), schoolId);
        audit(schoolId, actor, 'school.settings', { patch });
        return effectiveSettings(schoolRow(schoolId));
      });
    },

    /** Platform-internal: the school's card key (for digests and card MACs). Never send it to a browser. */
    schoolCardKey(schoolId) {
      return schoolRow(schoolId)?.card_key ?? null;
    },

    // ---- staff -------------------------------------------------------------

    addStaff({ schoolId, name, role } = {}) {
      requireSchool(schoolId);
      const cleanName = text(name, { code: 'NAME_INVALID', field: 'staff name' });
      if (!STAFF_ROLES.includes(role)) throw new LabError('STAFF_ROLE_INVALID', `role must be one of ${STAFF_ROLES.join(', ')}`);
      const id = newId('stf');
      db.run('INSERT INTO staff (id, school_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)', id, schoolId, cleanName, role, clock.now());
      return staffDto(db.get('SELECT * FROM staff WHERE id = ?', id));
    },

    getStaff(id) {
      return isId(id) ? staffDto(db.get('SELECT * FROM staff WHERE id = ?', id)) : null;
    },

    /** One school's staff, or every school's (the lab's "who are you?" picker). */
    listStaff(schoolId) {
      if (schoolId === undefined || schoolId === null) return db.all('SELECT * FROM staff ORDER BY created_at, rowid').map(staffDto);
      return db.all('SELECT * FROM staff WHERE school_id = ? ORDER BY created_at, rowid', schoolId).map(staffDto);
    },

    // ---- members -----------------------------------------------------------

    addMember({ schoolId, memberNo, name, className = '', group = 'STUDENT' } = {}) {
      requireSchool(schoolId);
      // member numbers are text ('S1001'); a whole number from a spreadsheet import is accepted as text too
      const no = text(Number.isSafeInteger(memberNo) ? String(memberNo) : memberNo, { code: 'MEMBER_NO_INVALID', field: 'member number', max: 32 });
      const cleanName = text(name, { code: 'NAME_INVALID', field: 'member name' });
      const cls = text(className ?? '', { code: 'CLASS_NAME_INVALID', field: 'class name', min: 0, max: 40 });
      if (!MEMBER_GROUPS.includes(group)) throw new LabError('MEMBER_GROUP_INVALID', `group must be one of ${MEMBER_GROUPS.join(', ')}`);
      return db.tx(() => {
        if (db.get('SELECT 1 FROM member WHERE school_id = ? AND member_no = ?', schoolId, no)) {
          throw new LabError('MEMBER_NO_TAKEN', `member number ${no} is already used in this school`, 409);
        }
        const id = newId('mem');
        db.run(
          'INSERT INTO member (id, school_id, member_no, name, class_name, holder_group, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, schoolId, no, cleanName, cls, group, clock.now(),
        );
        return memberDto(db.get('SELECT * FROM member WHERE id = ?', id), null);
      });
    },

    /** @returns member DTO, or null if the member is not in that school */
    getMember(schoolId, memberId) {
      if (!isId(schoolId) || !isId(memberId)) return null;
      const row = db.get('SELECT * FROM member WHERE school_id = ? AND id = ?', schoolId, memberId);
      return row ? memberDto(row, memberCard(schoolId, memberId)) : null;
    },

    listMembers(schoolId) {
      // one query for all cards instead of one per member; first row per member wins
      const cards = new Map();
      for (const c of db.all(`SELECT member_id, uid, status FROM card WHERE school_id = ? AND member_id IS NOT NULL ${CARD_PREFERENCE}`, schoolId)) {
        if (!cards.has(c.member_id)) cards.set(c.member_id, cardSummary(c));
      }
      return db
        .all('SELECT * FROM member WHERE school_id = ? ORDER BY member_no, rowid', schoolId)
        .map((row) => memberDto(row, cards.get(row.id) ?? null));
    },

    // ---- cards -------------------------------------------------------------

    /** Issue a card to a member. A member has at most one ACTIVE card. */
    issueCard({ schoolId, memberId, uid, actor } = {}) {
      const cleanUid = normalizeUid(uid);
      return db.tx(() => {
        const school = requireSchool(schoolId);
        requireMember(schoolId, memberId);
        if (db.get('SELECT 1 FROM card WHERE school_id = ? AND uid = ?', schoolId, cleanUid)) {
          throw new LabError('CARD_UID_TAKEN', 'this card is already registered in this school', 409);
        }
        if (db.get("SELECT 1 FROM card WHERE school_id = ? AND member_id = ? AND status = 'ACTIVE'", schoolId, memberId)) {
          throw new LabError('MEMBER_HAS_ACTIVE_CARD', 'this member already has an active card; report it lost first', 409);
        }
        const id = newId('crd');
        db.run(
          'INSERT INTO card (id, school_id, uid, digest, member_id, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
          id, schoolId, cleanUid, cardDigest(school.card_key, school.code, cleanUid), memberId, clock.now(),
        );
        // the audit trail carries last4, not the whole card number
        audit(schoolId, actor, 'card.issue', { cardId: id, last4: cleanUid.slice(-4), memberId });
        return cardDto(cardRowById(schoolId, id));
      });
    },

    getCardByUid(schoolId, uid) {
      let cleanUid;
      try {
        cleanUid = normalizeUid(uid);
      } catch {
        return null; // a malformed UID cannot belong to any card
      }
      return isId(schoolId) ? cardDto(db.get('SELECT * FROM card WHERE school_id = ? AND uid = ?', schoolId, cleanUid)) ?? null : null;
    },

    getCardByDigest(schoolId, digest) {
      if (!isId(schoolId) || typeof digest !== 'string') return null;
      return cardDto(db.get('SELECT * FROM card WHERE school_id = ? AND digest = ?', schoolId, digest)) ?? null;
    },

    getCard(schoolId, cardId) {
      if (!isId(schoolId) || !isId(cardId)) return null;
      return cardDto(cardRowById(schoolId, cardId)) ?? null;
    },

    activeCardForMember(schoolId, memberId) {
      if (!isId(schoolId) || !isId(memberId)) return null;
      return cardDto(db.get("SELECT * FROM card WHERE school_id = ? AND member_id = ? AND status = 'ACTIVE'", schoolId, memberId)) ?? null;
    },

    listCards(schoolId) {
      return db.all('SELECT * FROM card WHERE school_id = ? ORDER BY issued_at, rowid', schoolId).map(cardDto);
    },

    /** ACTIVE -> LOST. The caller blocks the card and stores the block-list version with setLostListVersion(). */
    markCardLost({ schoolId, uid, actor } = {}) {
      return db.tx(() => {
        const row = requireCardByUid(schoolId, uid);
        if (row.status !== 'ACTIVE') throw new LabError('CARD_NOT_ACTIVE', `card is ${row.status}, not ACTIVE`, 409);
        db.run("UPDATE card SET status = 'LOST', lost_at = ?, lost_list_version = NULL WHERE id = ?", clock.now(), row.id);
        audit(schoolId, actor, 'card.lost', { cardId: row.id, last4: row.uid.slice(-4), memberId: row.member_id });
        return cardDto(cardRowById(schoolId, row.id));
      });
    },

    /** The block-list version that first carried this lost card (to judge later purchases). */
    setLostListVersion(schoolId, cardId, version) {
      if (!Number.isSafeInteger(version) || version < 0) throw new LabError('LIST_VERSION_INVALID', 'version must be a whole number, 0 or more');
      const row = isId(schoolId) && isId(cardId) ? cardRowById(schoolId, cardId) : undefined;
      if (!row) throw new LabError('CARD_NOT_FOUND', 'no such card in this school', 404);
      db.run('UPDATE card SET lost_list_version = ? WHERE school_id = ? AND id = ?', version, schoolId, cardId);
      return cardDto(cardRowById(schoolId, cardId));
    },

    /** LOST -> ACTIVE, unless the member got a replacement card in the meantime. */
    markCardFound({ schoolId, uid, actor } = {}) {
      return db.tx(() => {
        const row = requireCardByUid(schoolId, uid);
        if (row.status !== 'LOST') throw new LabError('CARD_NOT_LOST', `card is ${row.status}, not LOST`, 409);
        if (
          row.member_id &&
          db.get("SELECT 1 FROM card WHERE school_id = ? AND member_id = ? AND status = 'ACTIVE' AND id <> ?", schoolId, row.member_id, row.id)
        ) {
          throw new LabError('MEMBER_HAS_ACTIVE_CARD', 'the member already has a replacement card', 409);
        }
        // the lost-report fields only mean something while the card is LOST; the audit trail keeps the history
        db.run("UPDATE card SET status = 'ACTIVE', lost_at = NULL, lost_list_version = NULL WHERE id = ?", row.id);
        audit(schoolId, actor, 'card.found', { cardId: row.id, last4: row.uid.slice(-4), memberId: row.member_id });
        return cardDto(cardRowById(schoolId, row.id));
      });
    },

    /** Digest that lists and records carry for this card, whether or not the card is registered. */
    cardDigestFor(schoolId, uid) {
      const school = requireSchool(schoolId);
      return cardDigest(school.card_key, school.code, uid);
    },

    // ---- parents -----------------------------------------------------------

    registerParent({ email, name } = {}) {
      const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) throw new LabError('EMAIL_INVALID', 'please enter a valid email address');
      const cleanName = text(name, { code: 'NAME_INVALID', field: 'name' });
      return db.tx(() => {
        if (db.get('SELECT 1 FROM parent WHERE email = ?', cleanEmail)) {
          throw new LabError('EMAIL_TAKEN', 'this email address is already registered', 409);
        }
        const id = newId('par');
        db.run('INSERT INTO parent (id, email, name, created_at) VALUES (?, ?, ?, ?)', id, cleanEmail, cleanName, clock.now());
        return parentDto(db.get('SELECT * FROM parent WHERE id = ?', id));
      });
    },

    getParent(id) {
      return isId(id) ? parentDto(db.get('SELECT * FROM parent WHERE id = ?', id)) : null;
    },

    getParentByEmail(email) {
      if (typeof email !== 'string') return null;
      return parentDto(db.get('SELECT * FROM parent WHERE email = ?', email.trim().toLowerCase()));
    },

    listParents() {
      return db.all('SELECT * FROM parent ORDER BY created_at, rowid').map(parentDto);
    },

    // ---- invites -----------------------------------------------------------

    /** A one-time code the school gives a parent to ask for a link to this member. */
    createInvite({ schoolId, memberId, actor } = {}) {
      return db.tx(() => {
        requireSchool(schoolId);
        requireMember(schoolId, memberId);
        let code = newCode(8);
        // codes are unique across schools; a clash is very unlikely, so just draw again
        while (db.get('SELECT 1 FROM invite WHERE code = ?', code)) code = newCode(8);
        const id = newId('inv');
        db.run('INSERT INTO invite (id, school_id, member_id, code, created_at) VALUES (?, ?, ?, ?, ?)', id, schoolId, memberId, code, clock.now());
        audit(schoolId, actor, 'invite.create', { inviteId: id, memberId });
        return inviteDto(db.get('SELECT * FROM invite WHERE id = ?', id));
      });
    },

    /** Invite DTOs plus memberName, createdAt and usedAt for the office list. Newest first. */
    listInvites(schoolId) {
      return db
        .all(
          `SELECT i.*, m.name AS member_name FROM invite i JOIN member m ON m.id = i.member_id AND m.school_id = i.school_id
           WHERE i.school_id = ? ORDER BY i.created_at DESC, i.rowid DESC`,
          schoolId,
        )
        .map((row) => ({ ...inviteDto(row), memberName: row.member_name, createdAt: row.created_at, usedAt: row.used_at ?? null }));
    },

    /**
     * A parent enters an invitation code: the invite is used up and a PENDING link
     * waits for the school office. A link the office REJECTED earlier is opened again,
     * because the school chose to hand out a new code.
     */
    redeemInvite({ parentId, code } = {}) {
      return db.tx(() => {
        const parent = isId(parentId) ? db.get('SELECT * FROM parent WHERE id = ?', parentId) : undefined;
        if (!parent) throw new LabError('PARENT_NOT_FOUND', 'no such parent', 404);
        // people type codes with spaces, dashes or in lower case
        const clean = String(code ?? '').replace(/[\s-]/g, '').toUpperCase();
        const invite = clean ? db.get('SELECT * FROM invite WHERE code = ?', clean) : undefined;
        if (!invite || invite.status !== 'OPEN') throw new LabError('INVITE_INVALID', 'this invitation code is not valid or was already used', 404);
        const schoolId = invite.school_id;
        const now = clock.now();
        const existing = db.get('SELECT * FROM parent_link WHERE school_id = ? AND parent_id = ? AND member_id = ?', schoolId, parentId, invite.member_id);
        let linkId;
        if (existing && existing.status !== 'REJECTED') {
          throw new LabError('LINK_EXISTS', `you already have a ${existing.status.toLowerCase()} link to this child`, 409);
        } else if (existing) {
          linkId = existing.id;
          db.run(
            "UPDATE parent_link SET status = 'PENDING', created_at = ?, decided_at = NULL, decided_by = NULL WHERE school_id = ? AND id = ?",
            now, schoolId, linkId,
          );
        } else {
          linkId = newId('lnk');
          db.run(
            'INSERT INTO parent_link (id, school_id, parent_id, member_id, created_at) VALUES (?, ?, ?, ?, ?)',
            linkId, schoolId, parentId, invite.member_id, now,
          );
        }
        db.run("UPDATE invite SET status = 'USED', used_by = ?, used_at = ? WHERE school_id = ? AND id = ?", parentId, now, schoolId, invite.id);
        audit(schoolId, `parent:${parentId}`, 'invite.redeem', { inviteId: invite.id, linkId, memberId: invite.member_id });
        return getLink(schoolId, linkId);
      });
    },

    // ---- links -------------------------------------------------------------

    /** Oldest first, so the office works through the queue in order. */
    listLinks(schoolId, { status } = {}) {
      if (status) return db.all(`${LINK_SELECT} WHERE l.school_id = ? AND l.status = ? ORDER BY l.created_at, l.rowid`, schoolId, status).map(linkDto);
      return db.all(`${LINK_SELECT} WHERE l.school_id = ? ORDER BY l.created_at, l.rowid`, schoolId).map(linkDto);
    },

    /** The office approves or rejects a PENDING link. A decision is final. */
    decideLink({ schoolId, linkId, approve, actor } = {}) {
      if (typeof approve !== 'boolean') throw new LabError('LINK_DECISION_INVALID', 'approve must be true or false');
      return db.tx(() => {
        const row = isId(schoolId) && isId(linkId) ? db.get('SELECT * FROM parent_link WHERE school_id = ? AND id = ?', schoolId, linkId) : undefined;
        if (!row) throw new LabError('LINK_NOT_FOUND', 'no such link in this school', 404);
        if (row.status !== 'PENDING') throw new LabError('LINK_ALREADY_DECIDED', `this link was already ${row.status.toLowerCase()}`, 409);
        const status = approve ? 'APPROVED' : 'REJECTED';
        const who = actorText(actor);
        db.run('UPDATE parent_link SET status = ?, decided_at = ?, decided_by = ? WHERE school_id = ? AND id = ?', status, clock.now(), who, schoolId, linkId);
        audit(schoolId, who, approve ? 'link.approve' : 'link.reject', { linkId, parentId: row.parent_id, memberId: row.member_id });
        return getLink(schoolId, linkId);
      });
    },

    /** A parent's APPROVED children, across every school. */
    parentChildren(parentId) {
      if (!isId(parentId)) return [];
      return db
        .all(
          `SELECT l.id AS link_id, l.school_id, s.code AS school_code, s.name AS school_name, m.id AS member_id, m.name, m.class_name
           FROM parent_link l
           JOIN school s ON s.id = l.school_id
           JOIN member m ON m.id = l.member_id AND m.school_id = l.school_id
           WHERE l.parent_id = ? AND l.status = 'APPROVED'
           ORDER BY l.created_at, l.rowid`,
          parentId,
        )
        .map((r) => ({
          linkId: r.link_id,
          schoolId: r.school_id,
          schoolCode: r.school_code,
          schoolName: r.school_name,
          memberId: r.member_id,
          name: r.name,
          className: r.class_name,
          card: memberCard(r.school_id, r.member_id),
        }));
    },

    /**
     * Every link of a parent with its status (the parent app shows pending ones too).
     * No class or card details: those are only for APPROVED links (parentChildren).
     */
    parentLinks(parentId) {
      if (!isId(parentId)) return [];
      return db
        .all(
          `SELECT l.*, s.code AS school_code, s.name AS school_name, m.name AS member_name
           FROM parent_link l
           JOIN school s ON s.id = l.school_id
           JOIN member m ON m.id = l.member_id AND m.school_id = l.school_id
           WHERE l.parent_id = ?
           ORDER BY l.created_at, l.rowid`,
          parentId,
        )
        .map((r) => ({
          linkId: r.id,
          schoolId: r.school_id,
          schoolCode: r.school_code,
          schoolName: r.school_name,
          memberId: r.member_id,
          name: r.member_name,
          status: r.status,
          createdAt: r.created_at,
          decidedAt: r.decided_at ?? null,
        }));
    },

    /** True only for an APPROVED link: pending or rejected links grant nothing. */
    isLinked(parentId, schoolId, memberId) {
      if (!isId(parentId) || !isId(schoolId) || !isId(memberId)) return false;
      return !!db.get(
        "SELECT 1 FROM parent_link WHERE school_id = ? AND parent_id = ? AND member_id = ? AND status = 'APPROVED'",
        schoolId, parentId, memberId,
      );
    },

    // ---- audit -------------------------------------------------------------

    audit,

    /** Newest first. */
    listAudit(schoolId, limit = 100) {
      const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
      return db
        .all('SELECT * FROM audit WHERE school_id = ? ORDER BY id DESC LIMIT ?', schoolId, n)
        .map((r) => ({ id: r.id, schoolId: r.school_id, actor: r.actor, action: r.action, detail: r.detail == null ? null : JSON.parse(r.detail), at: r.at }));
    },
  };
}
