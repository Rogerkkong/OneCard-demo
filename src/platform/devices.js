import { LabError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { randomSecret, brokerPassword } from '../shared/crypto.js';
import { DEVICE_CODE_RE, DEVICE_TYPES, REFUSAL } from '../shared/protocol.js';
import { parseIso, MINUTE } from '../shared/time.js';
import { createSchools } from './schools.js';

// Terminals of a school (canteen readers, water machines, top-up kiosks): their
// registration and secret, status, last heartbeat, the message sequence they have
// reached, replay protection for kiosk requests, and the device log.
//
// The device secret signs every message both ways and derives the broker password.
// It is returned once by registerDevice() and otherwise only to platform code through
// resolveByCodes(); no DTO ever carries it.

export const DEVICE_STATUSES = Object.freeze(['ACTIVE', 'DISABLED', 'MAINTENANCE']);
export const LOG_LEVELS = Object.freeze(['INFO', 'WARN', 'ERROR']);
/** How long a kiosk request nonce is remembered (lab time). Longer than the ±5 min timestamp window. */
export const NONCE_TTL_MS = 10 * MINUTE;
const DEFAULT_HEARTBEAT_ONLINE_MS = 90_000;
const NONCE_RE = /^[\x21-\x7e]{16,64}$/; // printable ASCII, no spaces (DESIGN §3: 16-64 chars)
const MAX_LOCATION = 80;
const MAX_LOG_MESSAGE = 500;

const isId = (v) => typeof v === 'string' && v.length > 0;

/** Office input may be typed in lower case; stored codes are always upper case. */
const cleanCode = (code) => (typeof code === 'string' ? code.trim().toUpperCase() : '');

/** Lab-clock ms from a number or an ISO-8601 string; NaN when it is neither. */
function toMs(at) {
  if (typeof at === 'number') return Number.isFinite(at) ? at : NaN;
  if (typeof at === 'string') return parseIso(at);
  return NaN;
}

/**
 * Devices of every school. All functions are synchronous.
 * @param {object} ctx  see docs/DESIGN.md "The context object"
 */
export function createDevices(ctx) {
  const { db, clock } = ctx;
  // Same school DTOs and audit trail as the schools service; createSchools only builds closures.
  const schools = createSchools(ctx);

  const onlineWindowMs = () => {
    const ms = ctx.settings?.heartbeatOnlineMs;
    return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_HEARTBEAT_ONLINE_MS;
  };

  /** Device row -> DTO. `online` is computed now, from the lab clock. */
  const deviceDto = (row) => {
    if (!row) return null;
    const last = row.last_heartbeat_at ?? null;
    return {
      id: row.id,
      schoolId: row.school_id,
      code: row.code,
      type: row.type,
      location: row.location,
      status: row.status,
      lastSeq: row.last_seq,
      lastHeartbeatAt: last,
      fwVersion: row.fw_version ?? null,
      health: row.health ?? null,
      online: last !== null && clock.now() - last <= onlineWindowMs(),
      createdAt: row.created_at,
    };
  };

  const rowById = (schoolId, deviceId) =>
    isId(schoolId) && isId(deviceId) ? db.get('SELECT * FROM device WHERE school_id = ? AND id = ?', schoolId, deviceId) : undefined;

  const rowByCode = (schoolId, code) =>
    isId(schoolId) && code ? db.get('SELECT * FROM device WHERE school_id = ? AND code = ?', schoolId, code) : undefined;

  // claimSeq, useNonce and recordHeartbeat take only a device id (the contract): they are
  // platform-internal and the id comes from resolveByCodes(), never from a request body.
  // Device ids are random and globally unique, so the id alone names one device of one school.
  function requireDeviceById(deviceId) {
    const row = isId(deviceId) ? db.get('SELECT * FROM device WHERE id = ?', deviceId) : undefined;
    if (!row) throw new LabError('DEVICE_NOT_FOUND', 'no such device', 404);
    return row;
  }

  const logDto = (r) => ({
    id: r.id,
    schoolId: r.school_id ?? null,
    deviceId: r.device_id ?? null,
    deviceCode: r.device_code ?? null,
    at: r.at,
    level: r.level,
    code: r.code,
    message: r.message,
    detail: r.detail == null ? null : JSON.parse(r.detail),
  });

  // The join keeps to the same school, so a log row can never name another school's device.
  const LOG_SELECT = `
    SELECT l.*, d.code AS device_code
    FROM device_log l
    LEFT JOIN device d ON d.id = l.device_id AND d.school_id = l.school_id`;

  return {
    /**
     * Register a terminal. The secret is returned here once; keep it in the machine.
     * @returns {{device: object, secret: string}}
     */
    registerDevice({ schoolId, code, type, location = '', actor } = {}) {
      const deviceCode = cleanCode(code);
      if (!DEVICE_CODE_RE.test(deviceCode)) {
        throw new LabError('DEVICE_CODE_INVALID', 'device code must be upper-case letters, digits and dashes (e.g. CANTEEN-01)');
      }
      const deviceType = typeof type === 'string' ? type.trim().toUpperCase() : '';
      if (!DEVICE_TYPES.includes(deviceType)) {
        throw new LabError('DEVICE_TYPE_INVALID', `device type must be one of ${DEVICE_TYPES.join(', ')}`);
      }
      const place = location == null ? '' : typeof location === 'string' ? location.trim() : null;
      if (place === null || place.length > MAX_LOCATION) {
        throw new LabError('LOCATION_INVALID', `location must be text of at most ${MAX_LOCATION} characters`);
      }
      return db.tx(() => {
        if (!schools.getSchool(schoolId)) throw new LabError('SCHOOL_NOT_FOUND', 'no such school', 404);
        if (rowByCode(schoolId, deviceCode)) {
          throw new LabError('DEVICE_CODE_TAKEN', `device code ${deviceCode} is already used in this school`, 409);
        }
        const id = newId('dev');
        const secret = randomSecret(32);
        db.run(
          'INSERT INTO device (id, school_id, code, type, location, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, schoolId, deviceCode, deviceType, place, secret, clock.now(),
        );
        // never the secret in the audit trail: the audit is shown in the office and the lab console
        schools.audit(schoolId, actor, 'device.register', { deviceId: id, code: deviceCode, type: deviceType, location: place });
        return { device: deviceDto(rowById(schoolId, id)), secret };
      });
    },

    /** @returns device DTO, or null if the device is not in that school */
    getDevice(schoolId, deviceId) {
      return deviceDto(rowById(schoolId, deviceId));
    },

    getDeviceByCode(schoolId, code) {
      return deviceDto(rowByCode(schoolId, cleanCode(code)));
    },

    listDevices(schoolId) {
      return db.all('SELECT * FROM device WHERE school_id = ? ORDER BY code', schoolId).map(deviceDto);
    },

    /**
     * Platform-internal (intake, broker login, kiosk request check): the school, the device
     * and the device secret for the codes in a topic, username or kiosk header.
     * Codes must match exactly; they are identities, not office input.
     * @returns {{school: object, device: object, secret: string} | null}
     */
    resolveByCodes(schoolCode, deviceCode) {
      if (typeof schoolCode !== 'string' || typeof deviceCode !== 'string') return null;
      const school = schools.getSchoolByCode(schoolCode);
      if (!school) return null;
      const row = rowByCode(school.id, deviceCode);
      if (!row) return null;
      return { school, device: deviceDto(row), secret: row.secret };
    },

    /** ACTIVE, DISABLED or MAINTENANCE. The facade kicks a device off the broker when it is not ACTIVE. */
    setDeviceStatus({ schoolId, code, status, actor } = {}) {
      if (!DEVICE_STATUSES.includes(status)) {
        throw new LabError('DEVICE_STATUS_INVALID', `status must be one of ${DEVICE_STATUSES.join(', ')}`);
      }
      return db.tx(() => {
        const row = rowByCode(schoolId, cleanCode(code));
        if (!row) throw new LabError('DEVICE_NOT_FOUND', 'no such device in this school', 404);
        if (row.status !== status) {
          db.run('UPDATE device SET status = ? WHERE school_id = ? AND id = ?', status, schoolId, row.id);
          schools.audit(schoolId, actor, 'device.status', { deviceId: row.id, code: row.code, from: row.status, to: status });
        }
        return deviceDto(rowById(schoolId, row.id));
      });
    },

    /**
     * Store a heartbeat. `at` is lab-clock ms or an ISO string (the envelope's `at`); missing
     * means now. A time ahead of the platform clock is taken as now, so a device with a fast
     * clock cannot look online for longer than it is; an older heartbeat than the one stored
     * (late delivery) changes nothing.
     * @returns device DTO
     */
    recordHeartbeat({ deviceId, at, fw, health } = {}) {
      return db.tx(() => {
        const row = requireDeviceById(deviceId);
        const now = clock.now();
        const given = toMs(at);
        const atMs = Number.isNaN(given) ? now : Math.min(given, now);
        if (row.last_heartbeat_at != null && atMs < row.last_heartbeat_at) return deviceDto(row);
        const fwText = typeof fw === 'string' && fw.trim() ? fw.trim().slice(0, 64) : null;
        const healthText = typeof health === 'string' && health.trim() ? health.trim().slice(0, 16) : null;
        db.run(
          'UPDATE device SET last_heartbeat_at = ?, fw_version = coalesce(?, fw_version), health = coalesce(?, health) WHERE school_id = ? AND id = ?',
          atMs, fwText, healthText, row.school_id, row.id,
        );
        return deviceDto(rowById(row.school_id, row.id));
      });
    },

    /**
     * Device-to-platform seq must strictly increase. One UPDATE does the compare and the
     * store, so two messages racing for the same seq cannot both win.
     * @returns {'OK'|'ROLLBACK'}
     */
    claimSeq(deviceId, seq) {
      if (!Number.isSafeInteger(seq)) throw new LabError('SEQ_INVALID', 'seq must be a whole number');
      const { changes } = db.run('UPDATE device SET last_seq = ? WHERE id = ? AND last_seq < ?', seq, deviceId, seq);
      if (changes > 0) return 'OK';
      requireDeviceById(deviceId);
      return 'ROLLBACK';
    },

    /**
     * Replay protection for signed kiosk requests: true the first time a device uses a
     * nonce, false if it used it in the last 10 minutes of lab time.
     */
    useNonce(deviceId, nonce) {
      if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
        throw new LabError('NONCE_INVALID', 'nonce must be 16 to 64 printable characters', 401);
      }
      return db.tx(() => {
        requireDeviceById(deviceId);
        const now = clock.now();
        // purge first, so a nonce whose 10 minutes are over counts as fresh again
        db.run('DELETE FROM request_nonce WHERE expires_at <= ?', now);
        const { changes } = db.run(
          'INSERT INTO request_nonce (device_id, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT (device_id, nonce) DO NOTHING',
          deviceId, nonce, now + NONCE_TTL_MS,
        );
        return changes > 0;
      });
    },

    /**
     * Append to the device log (refused messages, notable device events). `schoolId` and
     * `deviceId` may be null when the sender could not be identified.
     * @returns the log entry
     */
    log({ schoolId = null, deviceId = null, level = 'INFO', code, message, detail } = {}) {
      if (!LOG_LEVELS.includes(level)) throw new LabError('LOG_LEVEL_INVALID', `level must be one of ${LOG_LEVELS.join(', ')}`);
      if (typeof code !== 'string' || !code.trim() || code.length > 64) {
        throw new LabError('LOG_CODE_INVALID', 'log code must be text of 1 to 64 characters');
      }
      if (deviceId != null) {
        // a log row must name a device of its own school, or the office would see another school's device
        if (schoolId == null || !rowById(schoolId, deviceId)) throw new LabError('DEVICE_NOT_FOUND', 'no such device in this school', 404);
      }
      const text = String(message ?? REFUSAL[code] ?? code).slice(0, MAX_LOG_MESSAGE);
      const { lastInsertRowid } = db.run(
        'INSERT INTO device_log (school_id, device_id, at, level, code, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
        schoolId ?? null, deviceId ?? null, clock.now(), level, code, text, detail == null ? null : JSON.stringify(detail),
      );
      return logDto(db.get(`${LOG_SELECT} WHERE l.id = ?`, Number(lastInsertRowid)));
    },

    /**
     * Newest first. `schoolId` null lists entries no school could be found for
     * (the lab console's view of unknown senders).
     */
    listLog(schoolId, { deviceId, limit = 100 } = {}) {
      const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
      const where = [schoolId == null ? 'l.school_id IS NULL' : 'l.school_id = ?'];
      const params = schoolId == null ? [] : [schoolId];
      if (deviceId) {
        where.push('l.device_id = ?');
        params.push(deviceId);
      }
      return db.all(`${LOG_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`, ...params, n).map(logDto);
    },

    /** Broker login of a device: username '<school>.<DEVICE>', password derived from its secret. */
    brokerCredentials(schoolCode, deviceCode, secret) {
      return { username: `${schoolCode}.${deviceCode}`, password: brokerPassword(secret) };
    },
  };
}
