import { newId } from '../shared/ids.js';
import { LabError } from '../shared/errors.js';

// Double-entry books that mirror every card balance (docs/DESIGN.md §2 "Ledger
// accounts" and §4.1). Balances are never stored: they are always summed from
// entry rows, so the books cannot drift from their own history. Every posting is
// balanced (total DR = total CR) and happens once per (school, idemKey), so a
// retried payment callback or a re-uploaded purchase can never post twice.

/** Account kinds from DESIGN.md §2: the normal side and whether each member has their own. */
export const ACCOUNT_KINDS = Object.freeze({
  CASH_RECEIVED: Object.freeze({ normal: 'DR', perMember: false }),
  STUDENT_WALLET: Object.freeze({ normal: 'CR', perMember: true }),
  WAITING_TO_BE_ADDED: Object.freeze({ normal: 'CR', perMember: true }),
  SCHOOL_SUBSIDY: Object.freeze({ normal: 'DR', perMember: false }),
  SALES_PAYABLE: Object.freeze({ normal: 'CR', perMember: false }),
});

// Trial balance lists accounts in the order of the table above (assets and
// expenses first, then liabilities), which reads like a paper ledger.
const KIND_ORDER = Object.keys(ACCOUNT_KINDS);
const SIDES = new Set(['DR', 'CR']);
const MAX_LINES = 100;
const MAX_KEY = 200; // idemKey, ref and ids
const MAX_KIND = 64;
const MAX_MEMO = 500;
/** Kind given to the posting that reverse() writes. */
const REVERSAL_KIND = 'REVERSAL';

const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const postingInvalid = (message, detail) => new LabError('POSTING_INVALID', message, 400, detail);
const accountInvalid = (message, detail) => new LabError('ACCOUNT_INVALID', message, 400, detail);

/**
 * Per-member kinds need a memberId; school-level kinds must not have one.
 * @returns {string|null} the memberId, normalised to null for school-level kinds
 */
function checkAccountRule(kind, memberId) {
  if (typeof kind !== 'string' || !Object.hasOwn(ACCOUNT_KINDS, kind)) {
    throw accountInvalid(`unknown account kind ${kind}`, { kind });
  }
  const member = memberId ?? null;
  if (ACCOUNT_KINDS[kind].perMember) {
    if (!isText(member, MAX_KEY)) throw accountInvalid(`${kind} is kept per member: a memberId is required`, { kind });
  } else if (member !== null) {
    throw accountInvalid(`${kind} is a school account: it takes no memberId`, { kind, memberId: member });
  }
  return member;
}

/**
 * Validates posting lines: shape first (POSTING_INVALID), then the account rules
 * (ACCOUNT_INVALID), then DR = CR (POSTING_UNBALANCED). Nothing is written yet.
 */
function normaliseLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > MAX_LINES) {
    throw postingInvalid(`a posting needs 2 to ${MAX_LINES} lines`);
  }
  const out = lines.map((line, i) => {
    const at = `line ${i + 1}`;
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw postingInvalid(`${at} is not an object`);
    if (!SIDES.has(line.side)) throw postingInvalid(`${at}: side must be DR or CR`);
    if (!Number.isSafeInteger(line.amountSen) || line.amountSen <= 0) {
      throw postingInvalid(`${at}: amountSen must be a whole number of sen, more than 0`);
    }
    if (typeof line.kind !== 'string' || line.kind.length === 0) throw postingInvalid(`${at}: account kind is missing`);
    if (line.memberId != null && typeof line.memberId !== 'string') throw postingInvalid(`${at}: memberId must be a string`);
    const memberId = checkAccountRule(line.kind, line.memberId);
    return { kind: line.kind, memberId, side: line.side, amountSen: line.amountSen };
  });
  let debitSen = 0;
  let creditSen = 0;
  for (const l of out) {
    if (l.side === 'DR') debitSen += l.amountSen;
    else creditSen += l.amountSen;
  }
  if (!Number.isSafeInteger(debitSen) || !Number.isSafeInteger(creditSen)) throw postingInvalid('posting total is too large');
  if (debitSen !== creditSen) {
    throw new LabError('POSTING_UNBALANCED', `debits (${debitSen} sen) do not equal credits (${creditSen} sen)`, 400, { debitSen, creditSen });
  }
  return out;
}

// Order-insensitive comparison: the same lines listed in another order are the same posting.
const lineKey = (l) => JSON.stringify([l.kind, l.memberId ?? null, l.side, l.amountSen]);
function sameLines(a, b) {
  if (a.length !== b.length) return false;
  const ka = a.map(lineKey).sort();
  const kb = b.map(lineKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

function optionalMemo(memo) {
  if (memo === null || memo === undefined) return null;
  if (typeof memo !== 'string') throw postingInvalid('memo must be a string');
  // Memos often carry a staff note; keep the first part rather than refuse the money movement.
  return memo.slice(0, MAX_MEMO);
}

const ENTRY_LINES_SQL = `
  SELECT e.posting_id, a.kind, a.member_id, e.side, e.amount_sen
  FROM entry e JOIN account a ON a.id = e.account_id
  WHERE a.school_id = ? AND e.posting_id = ?
  ORDER BY e.id`;

// One cached statement for any number of postings (json_each), instead of a new
// "IN (?, ?, …)" statement per page size.
const ENTRY_LINES_MANY_SQL = `
  SELECT e.posting_id, a.kind, a.member_id, e.side, e.amount_sen
  FROM entry e JOIN account a ON a.id = e.account_id
  WHERE a.school_id = ? AND e.posting_id IN (SELECT value FROM json_each(?))
  ORDER BY e.id`;

const SUMS = `
  coalesce(sum(CASE WHEN e.side = 'DR' THEN e.amount_sen END), 0) AS dr,
  coalesce(sum(CASE WHEN e.side = 'CR' THEN e.amount_sen END), 0) AS cr`;

/** Balance on the account's normal side: DR-normal is DR − CR, CR-normal is CR − DR. */
const onNormalSide = (kind, dr, cr) => (ACCOUNT_KINDS[kind].normal === 'DR' ? dr - cr : cr - dr);

const lineDto = (row) => ({ kind: row.kind, memberId: row.member_id ?? null, side: row.side, amountSen: row.amount_sen });

/**
 * The school's double-entry books. All functions are synchronous.
 * @param {{ db: object, clock: { now(): number }, events: { emit: Function } }} ctx
 */
export function createLedger(ctx) {
  const { db, clock, events } = ctx;
  const schoolCode = (schoolId) => db.get('SELECT code FROM school WHERE id = ?', schoolId)?.code ?? null;

  const findAccount = (schoolId, kind, memberId) =>
    db.get("SELECT * FROM account WHERE school_id = ? AND kind = ? AND ifnull(member_id, '') = ?", schoolId, kind, memberId ?? '');

  const accountDto = (row) => ({
    id: row.id,
    schoolId: row.school_id,
    kind: row.kind,
    memberId: row.member_id ?? null,
    createdAt: row.created_at,
  });

  const postingDto = (row, lines) => ({
    id: row.id,
    schoolId: row.school_id,
    idemKey: row.idem_key,
    kind: row.kind,
    ref: row.ref ?? null,
    memo: row.memo ?? null,
    reversalOf: row.reversal_of ?? null,
    createdAt: row.created_at,
    lines,
  });

  const loadPosting = (row) => row && postingDto(row, db.all(ENTRY_LINES_SQL, row.school_id, row.id).map(lineDto));

  const announce = (posting) => {
    const amountSen = posting.lines.reduce((sum, l) => (l.side === 'DR' ? sum + l.amountSen : sum), 0);
    events.emit(
      'ledger.posting',
      {
        id: posting.id,
        idemKey: posting.idemKey,
        kind: posting.kind,
        ref: posting.ref,
        reversalOf: posting.reversalOf,
        amountSen,
        lines: posting.lines,
      },
      schoolCode(posting.schoolId),
    );
  };

  /**
   * The account for (school, kind, member), created on first use.
   * Per-member kinds require a memberId of that school; others forbid one (ACCOUNT_INVALID).
   * @returns {{ id: string, schoolId: string, kind: string, memberId: string|null, createdAt: number }}
   */
  function account(schoolId, kind, memberId = null) {
    if (!isText(schoolId, MAX_KEY)) throw accountInvalid('schoolId is required');
    const member = checkAccountRule(kind, memberId);
    const existing = findAccount(schoolId, kind, member);
    if (existing) return accountDto(existing);
    // Checked only on creation: an existing account already passed these checks.
    if (!db.get('SELECT id FROM school WHERE id = ?', schoolId)) throw accountInvalid('no such school', { schoolId });
    if (member !== null && !db.get('SELECT id FROM member WHERE school_id = ? AND id = ?', schoolId, member)) {
      throw accountInvalid('no such member in this school', { memberId: member });
    }
    const id = newId('acc');
    db.run(
      'INSERT INTO account (id, school_id, kind, member_id, created_at) VALUES (?, ?, ?, ?, ?)',
      id, schoolId, kind, member, clock.now(),
    );
    return accountDto(findAccount(schoolId, kind, member));
  }

  /**
   * Write one balanced posting, once per (schoolId, idemKey).
   * A repeat with the same lines returns the existing posting (`created: false`);
   * with different lines it is IDEMPOTENCY_CONFLICT (409).
   * @param {{ schoolId: string, idemKey: string, kind: string, ref?: string|null, memo?: string|null,
   *   lines: Array<{ kind: string, memberId?: string|null, side: 'DR'|'CR', amountSen: number }> }} args
   * @returns {{ posting: object, created: boolean }}
   */
  function post(args) {
    const { schoolId, idemKey, kind, ref = null, memo = null, lines } = args ?? {};
    if (!isText(schoolId, MAX_KEY)) throw postingInvalid('schoolId is required');
    if (!isText(idemKey, MAX_KEY)) throw postingInvalid(`idemKey must be 1 to ${MAX_KEY} characters`);
    if (!isText(kind, MAX_KIND)) throw postingInvalid(`posting kind must be 1 to ${MAX_KIND} characters`);
    if (ref !== null && !isText(ref, MAX_KEY)) throw postingInvalid(`ref must be 1 to ${MAX_KEY} characters, or null`);
    const memoText = optionalMemo(memo);
    const wanted = normaliseLines(lines);

    const result = db.tx(() => {
      const existing = db.get('SELECT * FROM posting WHERE school_id = ? AND idem_key = ?', schoolId, idemKey);
      if (existing) {
        const posting = loadPosting(existing);
        if (!sameLines(posting.lines, wanted)) {
          throw new LabError('IDEMPOTENCY_CONFLICT', `idemKey ${idemKey} was already used for a different posting`, 409, { postingId: existing.id });
        }
        return { posting, created: false };
      }
      // Accounts are created inside the transaction too, so a failure leaves no empty accounts behind.
      const accountIds = wanted.map((l) => account(schoolId, l.kind, l.memberId).id);
      const id = newId('pst');
      db.run(
        'INSERT INTO posting (id, school_id, idem_key, kind, ref, memo, reversal_of, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
        id, schoolId, idemKey, kind, ref, memoText, clock.now(),
      );
      wanted.forEach((l, i) => {
        db.run('INSERT INTO entry (posting_id, account_id, side, amount_sen) VALUES (?, ?, ?, ?)', id, accountIds[i], l.side, l.amountSen);
      });
      return { posting: getPosting(schoolId, id), created: true };
    });
    // Emitted after our own transaction (or savepoint) succeeded, never for a repeat.
    if (result.created) announce(result.posting);
    return result;
  }

  /**
   * Undo a posting with a new posting whose every side is flipped (`reversalOf = postingId`).
   * Codes: POSTING_NOT_FOUND (404), CANNOT_REVERSE_REVERSAL (409), ALREADY_REVERSED (409),
   * IDEMPOTENCY_CONFLICT (409) when idemKey already names an unrelated posting.
   * @param {{ schoolId: string, postingId: string, idemKey: string, memo?: string|null }} args
   * @returns {{ posting: object, created: boolean }}
   */
  function reverse(args) {
    const { schoolId, postingId, idemKey, memo = null } = args ?? {};
    if (!isText(schoolId, MAX_KEY)) throw postingInvalid('schoolId is required');
    if (!isText(postingId, MAX_KEY)) throw postingInvalid('postingId is required');
    if (!isText(idemKey, MAX_KEY)) throw postingInvalid(`idemKey must be 1 to ${MAX_KEY} characters`);
    const memoText = optionalMemo(memo);

    const result = db.tx(() => {
      const original = db.get('SELECT * FROM posting WHERE school_id = ? AND id = ?', schoolId, postingId);
      if (!original) throw new LabError('POSTING_NOT_FOUND', 'no such posting', 404, { postingId });
      const sameKey = db.get('SELECT * FROM posting WHERE school_id = ? AND idem_key = ?', schoolId, idemKey);
      if (sameKey) {
        if (sameKey.reversal_of === original.id) return { posting: loadPosting(sameKey), created: false };
        throw new LabError('IDEMPOTENCY_CONFLICT', `idemKey ${idemKey} was already used for a different posting`, 409, { postingId: sameKey.id });
      }
      if (original.reversal_of !== null) {
        throw new LabError('CANNOT_REVERSE_REVERSAL', 'a reversal cannot itself be reversed; post a new entry instead', 409, { postingId });
      }
      const earlier = db.get('SELECT id, idem_key FROM posting WHERE school_id = ? AND reversal_of = ?', schoolId, original.id);
      if (earlier) {
        throw new LabError('ALREADY_REVERSED', 'this posting was already reversed', 409, { postingId, reversalId: earlier.id, idemKey: earlier.idem_key });
      }
      const entries = db.all(
        `SELECT e.account_id, e.side, e.amount_sen FROM entry e JOIN account a ON a.id = e.account_id
         WHERE a.school_id = ? AND e.posting_id = ? ORDER BY e.id`,
        schoolId, original.id,
      );
      const id = newId('pst');
      db.run(
        'INSERT INTO posting (id, school_id, idem_key, kind, ref, memo, reversal_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, schoolId, idemKey, REVERSAL_KIND, original.ref, memoText, original.id, clock.now(),
      );
      for (const e of entries) {
        db.run(
          'INSERT INTO entry (posting_id, account_id, side, amount_sen) VALUES (?, ?, ?, ?)',
          id, e.account_id, e.side === 'DR' ? 'CR' : 'DR', e.amount_sen,
        );
      }
      return { posting: getPosting(schoolId, id), created: true };
    });
    if (result.created) announce(result.posting);
    return result;
  }

  /**
   * Integer sen on the account's normal side (DR-normal: DR − CR; CR-normal: CR − DR).
   * A missing account is 0. May be negative (e.g. a mirror wallet that went below zero).
   */
  function balance(schoolId, kind, memberId = null) {
    if (!isText(schoolId, MAX_KEY)) throw accountInvalid('schoolId is required');
    const member = checkAccountRule(kind, memberId);
    const row = db.get(
      `SELECT ${SUMS} FROM account a JOIN entry e ON e.account_id = a.id
       WHERE a.school_id = ? AND a.kind = ? AND ifnull(a.member_id, '') = ?`,
      schoolId, kind, member ?? '',
    );
    return onNormalSide(kind, row.dr, row.cr);
  }

  /** The member's mirror wallet and the money waiting to be added at the kiosk, kept apart. */
  function memberBalances(schoolId, memberId) {
    return {
      walletSen: balance(schoolId, 'STUDENT_WALLET', memberId),
      waitingSen: balance(schoolId, 'WAITING_TO_BE_ADDED', memberId),
    };
  }

  /**
   * Every account of the school with its debit and credit totals. `balanced` is false
   * only if the books were written outside post()/reverse().
   */
  function trialBalance(schoolId) {
    const rows = db.all(
      `SELECT a.id, a.kind, a.member_id, m.name AS member_name, ${SUMS}
       FROM account a
       LEFT JOIN member m ON m.id = a.member_id AND m.school_id = a.school_id
       LEFT JOIN entry e ON e.account_id = a.id
       WHERE a.school_id = ?
       GROUP BY a.id`,
      schoolId,
    );
    const accounts = rows
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        memberId: r.member_id ?? null,
        memberName: r.member_name ?? null,
        debitSen: r.dr,
        creditSen: r.cr,
        balanceSen: onNormalSide(r.kind, r.dr, r.cr),
      }))
      .sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
          (a.memberName ?? '').localeCompare(b.memberName ?? '') ||
          (a.memberId ?? '').localeCompare(b.memberId ?? '') ||
          a.id.localeCompare(b.id),
      );
    const totals = { debitSen: 0, creditSen: 0 };
    for (const a of accounts) {
      totals.debitSen += a.debitSen;
      totals.creditSen += a.creditSen;
    }
    return { accounts, totals, balanced: totals.debitSen === totals.creditSen };
  }

  /**
   * Newest first (lab-clock time, then the order they were written).
   * `memberId` keeps only postings that touch one of that member's accounts.
   */
  function postings(schoolId, { limit = 50, memberId } = {}) {
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 50;
    const rows = memberId
      ? db.all(
          `SELECT p.* FROM posting p
           WHERE p.school_id = ? AND EXISTS (
             SELECT 1 FROM entry e JOIN account a ON a.id = e.account_id
             WHERE e.posting_id = p.id AND a.school_id = p.school_id AND a.member_id = ?)
           ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
          schoolId, memberId, n,
        )
      : db.all('SELECT p.* FROM posting p WHERE p.school_id = ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?', schoolId, n);
    if (rows.length === 0) return [];
    const linesByPosting = new Map(rows.map((r) => [r.id, []]));
    for (const e of db.all(ENTRY_LINES_MANY_SQL, schoolId, JSON.stringify(rows.map((r) => r.id)))) {
      linesByPosting.get(e.posting_id).push(lineDto(e));
    }
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      ref: r.ref ?? null,
      memo: r.memo ?? null,
      reversalOf: r.reversal_of ?? null,
      createdAt: r.created_at,
      lines: linesByPosting.get(r.id),
    }));
  }

  /** Posting DTO, or null if there is no such posting in this school. */
  function getPosting(schoolId, id) {
    if (typeof schoolId !== 'string' || typeof id !== 'string') return null;
    return loadPosting(db.get('SELECT * FROM posting WHERE school_id = ? AND id = ?', schoolId, id)) ?? null;
  }

  /** Posting DTO for (schoolId, idemKey), or null. */
  function findByIdemKey(schoolId, idemKey) {
    if (typeof schoolId !== 'string' || typeof idemKey !== 'string') return null;
    return loadPosting(db.get('SELECT * FROM posting WHERE school_id = ? AND idem_key = ?', schoolId, idemKey)) ?? null;
  }

  return { account, post, reverse, balance, memberBalances, trialBalance, postings, getPosting, findByIdemKey };
}
