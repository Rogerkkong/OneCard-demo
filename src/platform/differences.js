import { newId } from '../shared/ids.js';
import { LabError } from '../shared/errors.js';

// Reconciliation differences: things a person at the school office has to look at.
// Any service may open one. Opening the same (school, kind, ref) twice is a no-op.

export const DIFFERENCE_KINDS = Object.freeze({
  MISSING_RECORDS: { en: 'A purchase the platform never received (gap in a machine’s transaction numbers)', zh: '平台没收到的消费（机器流水号有缺口）' },
  DUPLICATE_CONFLICT: { en: 'Same transaction number uploaded twice with different content', zh: '同一流水号上传了两次，内容不同' },
  UNKNOWN_CARD: { en: 'Purchase from a card this school does not know', zh: '本校不认识的卡的消费' },
  PRICE_VERSION_UNKNOWN: { en: 'Record names a price list version that was never issued', zh: '记录里的价格版本平台没发过' },
  PRICE_MISMATCH: { en: 'Amount does not match the price list version the machine used', zh: '金额和机器所用价格版本对不上' },
  BALANCE_CONTINUITY: { en: 'Balance before minus amount does not equal balance after', zh: '扣前余额减金额不等于扣后余额' },
  BALANCE_MISMATCH: { en: 'Card balance does not match the platform’s mirror balance', zh: '卡上余额和平台镜像余额对不上' },
  MIRROR_NEGATIVE: { en: 'Mirror balance went below zero', zh: '镜像余额变成负数' },
  SPENT_AFTER_LOST_REPORT: { en: 'Card used after it was reported lost', zh: '挂失后卡还被使用' },
  CARD_CLONE_SUSPECTED: { en: 'Two different purchases carry the same card counter (possible copied card)', zh: '两笔不同消费带同一个卡计数（可能是复制卡）' },
  OLD_BLOCK_LIST: { en: 'Machine is still on an old block list', zh: '机器还在用旧的黑名单' },
  TOPUP_ADDED_AFTER_REFUND: { en: 'Kiosk reports adding money that was already refunded', zh: '充值机回报已加的钱其实已退款' },
  DOUBLE_ADD_SUSPECTED: { en: 'The same top-up was reported added by a different write', zh: '同一笔充值被另一次写卡回报已加' },
});

/** Who resolved it, as text (the same rule as the audit trail). */
function actorText(actor) {
  if (typeof actor === 'string' && actor.trim()) return actor.trim().slice(0, 120);
  if (actor && typeof actor === 'object' && (actor.id || actor.name)) {
    return [actor.name, actor.id && `(${actor.id})`].filter(Boolean).join(' ').slice(0, 120);
  }
  return 'system';
}

const MAX_LIST = 1000;

export function createDifferences(ctx) {
  const { db, clock, events } = ctx;
  const schoolCode = (schoolId) => db.get('SELECT code FROM school WHERE id = ?', schoolId)?.code ?? null;
  const toDto = (row) =>
    row && {
      id: row.id,
      kind: row.kind,
      ref: row.ref,
      detail: JSON.parse(row.detail),
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? null,
      resolvedBy: row.resolved_by ?? null,
      note: row.note ?? null,
    };

  return {
    KINDS: DIFFERENCE_KINDS,

    /** @returns {{difference: object, created: boolean}} */
    open({ schoolId, kind, ref, detail = {} }) {
      // own properties only: 'toString' is not a kind
      if (typeof kind !== 'string' || !Object.hasOwn(DIFFERENCE_KINDS, kind)) {
        throw new LabError('DIFFERENCE_KIND_INVALID', `unknown difference kind ${kind}`, 500);
      }
      const existing = db.get('SELECT * FROM difference WHERE school_id = ? AND kind = ? AND ref = ?', schoolId, kind, String(ref));
      if (existing) return { difference: toDto(existing), created: false };
      const id = newId('dif');
      db.run(
        'INSERT INTO difference (id, school_id, kind, ref, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, schoolId, kind, String(ref), JSON.stringify(detail), clock.now(),
      );
      const difference = toDto(db.get('SELECT * FROM difference WHERE id = ?', id));
      events.emit('difference.opened', { id, kind, ref: String(ref), detail }, schoolCode(schoolId));
      return { difference, created: true };
    },

    get(schoolId, id) {
      return toDto(db.get('SELECT * FROM difference WHERE school_id = ? AND id = ?', schoolId, id)) ?? null;
    },

    /** Newest first. `limit` is 1–1000 (anything else means 200); filters must be strings. */
    list(schoolId, { status, kind, limit = 200 } = {}) {
      const where = ['school_id = ?'];
      const params = [typeof schoolId === 'string' ? schoolId : null];
      if (typeof status === 'string' && status) { where.push('status = ?'); params.push(status); }
      if (typeof kind === 'string' && kind) { where.push('kind = ?'); params.push(kind); }
      const max = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, MAX_LIST) : 200;
      return db
        .all(`SELECT * FROM difference WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id LIMIT ?`, ...params, max)
        .map(toDto);
    },

    countOpen(schoolId) {
      return db.get("SELECT count(*) AS n FROM difference WHERE school_id = ? AND status = 'OPEN'", schoolId).n;
    },

    /**
     * Mark a difference RESOLVED with who did it and a note (at most 500 characters). The
     * caller writes the audit entry (schools.audit) in the same transaction.
     * Codes: DIFFERENCE_NOT_FOUND (404, also for another school's id), DIFFERENCE_ALREADY_RESOLVED (409).
     */
    resolve({ schoolId, id, actor, note = '' } = {}) {
      const who = actorText(actor);
      return db.tx(() => {
        const row = db.get(
          'SELECT * FROM difference WHERE school_id = ? AND id = ?',
          typeof schoolId === 'string' ? schoolId : null, typeof id === 'string' ? id : null,
        );
        if (!row) throw new LabError('DIFFERENCE_NOT_FOUND', 'no such difference', 404);
        if (row.status === 'RESOLVED') throw new LabError('DIFFERENCE_ALREADY_RESOLVED', 'this difference is already resolved', 409);
        db.run(
          "UPDATE difference SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, note = ? WHERE id = ?",
          clock.now(), who, String(note ?? '').slice(0, 500), row.id,
        );
        events.emit('difference.resolved', { id: row.id, kind: row.kind, by: who }, schoolCode(row.school_id));
        return toDto(db.get('SELECT * FROM difference WHERE id = ?', row.id));
      });
    },
  };
}
