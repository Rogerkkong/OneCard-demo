import { LabError } from '../../shared/errors.js';
import { CONFIG_KINDS, DEVICE_CODE_RE } from '../../shared/protocol.js';
import { parseIso } from '../../shared/time.js';

// The top-up kiosk's signed API (docs/DESIGN.md §3 "Kiosk HTTP (signed)"). The server has
// already checked the request's signature, timestamp and nonce and that it comes from an ACTIVE
// kiosk of an ACTIVE school (`req.kiosk`, `req.school`), so every handler works in the kiosk's
// own school only.
//
// kioskConfirm runs outside any transaction of ours: when it refuses a write (409) it opens a
// difference for a person, and a rolled-back transaction around it would lose that difference.

const RECEIPT_RESULTS = Object.freeze(['APPLIED', 'ALREADY_APPLIED', 'REJECTED']);
const MAX_RECEIPTS = 500;
const MAX_ERROR_TEXT = 200;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What is wrong with one admin-card receipt, or null (shape as AdminCard.addReceipt writes it). */
function receiptProblem(r) {
  if (!isPlainObject(r)) return 'receipt must be an object';
  if (typeof r.device !== 'string' || !DEVICE_CODE_RE.test(r.device)) return 'device must be a device code';
  if (!CONFIG_KINDS.includes(r.kind)) return `kind must be one of ${CONFIG_KINDS.join(', ')}`;
  if (!Number.isSafeInteger(r.appliedVersion) || r.appliedVersion < 0) return 'appliedVersion must be a whole number, 0 or more';
  if (!RECEIPT_RESULTS.includes(r.result)) return `result must be one of ${RECEIPT_RESULTS.join(', ')}`;
  if (r.error !== undefined && r.error !== null && typeof r.error !== 'string') return 'error must be text';
  if (r.at !== undefined && Number.isNaN(parseIso(r.at))) return 'at must be an ISO-8601 timestamp';
  return null;
}

/**
 * @param {{ platform: object, ctx: object }} deps  see src/http/server.js
 * @returns {Array<{ method: string, path: string, auth: string, handler: Function }>}
 */
export function routes(deps) {
  const services = () => deps.platform.services;
  const actorOf = (req) => `device:${req.kiosk.device.code}`;

  return [
    {
      // A card was tapped: whose it is and what is waiting to be written on it.
      method: 'POST',
      path: '/api/kiosk/pending',
      auth: 'kiosk',
      handler: (req) =>
        services().topups.kioskPending({
          schoolId: req.school.id,
          kioskDeviceId: req.kiosk.device.id,
          cardDigest: req.body.card,
          max: req.body.max ?? undefined,
        }),
    },
    {
      // The kiosk reports one write (ADDED or FAILED) under its own kiosk txn number.
      method: 'POST',
      path: '/api/kiosk/confirm',
      auth: 'kiosk',
      handler: (req) => {
        const { orderId, result, amountSen, card, balanceAfterOnCardSen, kioskTxn } = req.body;
        return services().topups.kioskConfirm({
          schoolId: req.school.id,
          kioskDeviceId: req.kiosk.device.id,
          kioskDeviceCode: req.kiosk.device.code,
          orderId,
          result,
          amountSen,
          cardDigest: card,
          balanceAfterOnCardSen,
          kioskTxn,
        });
      },
    },
    {
      // After a confirm timed out the kiosk asks what the platform recorded, instead of writing again.
      method: 'GET',
      path: '/api/kiosk/confirm/:kioskTxn',
      auth: 'kiosk',
      handler: (req) => {
        const found = services().topups.kioskLookup({
          schoolId: req.school.id,
          kioskDeviceCode: req.kiosk.device.code,
          kioskTxn: req.params.kioskTxn,
        });
        if (!found) throw new LabError('KIOSK_TXN_NOT_FOUND', 'the platform has no confirm under this kiosk txn number', 404);
        return found;
      },
    },
    {
      // Loading the admin card: a new token (only ever goes up) and the school's current packs.
      method: 'GET',
      path: '/api/kiosk/packs',
      auth: 'kiosk',
      handler: (req) => {
        const { configs, schools } = services();
        const sid = req.school.id;
        return deps.ctx.db.tx(() => {
          const token = configs.nextAdminCardToken(sid);
          const packs = configs.packs(sid);
          schools.audit(sid, actorOf(req), 'admin-card.load', { token, packs: packs.map(({ kind, version }) => ({ kind, version })) });
          return { token, school: req.school.code, packs };
        });
      },
    },
    {
      // Receipts the offline machines wrote on the admin card: which version each one now runs.
      // Applied (or already applied) packs update the machine's list state, via ADMIN_CARD; a
      // refused pack goes to that machine's device log. Machines are looked up in the kiosk's
      // own school only.
      method: 'POST',
      path: '/api/kiosk/admin-card/receipts',
      auth: 'kiosk',
      handler: (req) => {
        const { configs, devices, schools } = services();
        const sid = req.school.id;
        const { token, receipts } = req.body;
        if (!Number.isSafeInteger(token) || token < 1) throw new LabError('RECEIPTS_INVALID', 'token must be the admin card token (1 or more)');
        if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS) {
          throw new LabError('RECEIPTS_INVALID', `receipts must be a list of at most ${MAX_RECEIPTS}`);
        }
        return deps.ctx.db.tx(() => {
          let recorded = 0;
          const skipped = [];
          for (const [index, r] of receipts.entries()) {
            const problem = receiptProblem(r);
            if (problem) {
              skipped.push({ index, reason: problem });
              continue;
            }
            const device = devices.getDeviceByCode(sid, r.device);
            if (!device) {
              skipped.push({ index, reason: `no machine ${r.device} in this school` });
              continue;
            }
            if (r.result === 'REJECTED') {
              const error = typeof r.error === 'string' ? r.error.slice(0, MAX_ERROR_TEXT) : null;
              devices.log({
                schoolId: sid,
                deviceId: device.id,
                level: 'WARN',
                code: 'ADMIN_CARD_REJECTED',
                message: `refused the ${r.kind} pack on the admin card${error ? ` (${error})` : ''}`,
                detail: { kind: r.kind, appliedVersion: r.appliedVersion, token, error },
              });
            } else {
              configs.recordListState({ deviceId: device.id, kind: r.kind, version: r.appliedVersion, via: 'ADMIN_CARD', schoolId: sid });
            }
            recorded += 1;
          }
          schools.audit(sid, actorOf(req), 'admin-card.receipts', { token, recorded, skipped: skipped.length });
          return { recorded, skipped };
        });
      },
    },
  ];
}
