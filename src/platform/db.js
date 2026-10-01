import { DatabaseSync } from 'node:sqlite';

// SQLite (built into Node 22) holds the platform's data. The lab runs it in memory
// by default, so every restart starts from a clean seed.
//
// Conventions: ids are TEXT with a prefix (see shared/ids.js); times are INTEGER ms
// since the epoch (lab clock); money is INTEGER sen; JSON is TEXT.
// Every school-owned table has school_id, and every query must filter by it.

const MIGRATIONS = [
  // V1: the whole lab schema
  `
  CREATE TABLE school (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
    card_key TEXT NOT NULL,
    admin_card_token INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE staff (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('OFFICE','FINANCE','ADMIN')),
    created_at INTEGER NOT NULL
  );

  -- Cardholders: students, and staff who pay with a card (holder_group).
  CREATE TABLE member (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    member_no TEXT NOT NULL,
    name TEXT NOT NULL,
    class_name TEXT NOT NULL DEFAULT '',
    holder_group TEXT NOT NULL DEFAULT 'STUDENT' CHECK (holder_group IN ('STUDENT','STAFF')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LEFT')),
    created_at INTEGER NOT NULL,
    UNIQUE (school_id, member_no)
  );

  CREATE TABLE card (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    uid TEXT NOT NULL,
    digest TEXT NOT NULL,
    member_id TEXT REFERENCES member(id),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOST','RETIRED')),
    issued_at INTEGER NOT NULL,
    lost_at INTEGER,
    lost_list_version INTEGER,
    UNIQUE (school_id, uid),
    UNIQUE (school_id, digest)
  );
  CREATE UNIQUE INDEX card_one_active_per_member ON card(school_id, member_id) WHERE status = 'ACTIVE';

  CREATE TABLE parent (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE invite (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    member_id TEXT NOT NULL REFERENCES member(id),
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','USED','REVOKED')),
    created_at INTEGER NOT NULL,
    used_by TEXT REFERENCES parent(id),
    used_at INTEGER
  );

  CREATE TABLE parent_link (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    parent_id TEXT NOT NULL REFERENCES parent(id),
    member_id TEXT NOT NULL REFERENCES member(id),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    UNIQUE (parent_id, member_id)
  );

  CREATE TABLE device (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    code TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('CANTEEN','WATER','KIOSK')),
    location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','MAINTENANCE')),
    secret TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at INTEGER,
    fw_version TEXT,
    health TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (school_id, code)
  );

  -- Versioned prices, device settings and block lists. One version space per (school, kind).
  CREATE TABLE config_version (
    school_id TEXT NOT NULL REFERENCES school(id),
    kind TEXT NOT NULL CHECK (kind IN ('prices','settings','blocklist')),
    version INTEGER NOT NULL CHECK (version >= 1),
    content TEXT NOT NULL,
    effective_from INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    PRIMARY KEY (school_id, kind, version)
  );

  -- Which version each device last reported (heartbeat/ack) or confirmed (admin-card receipt).
  CREATE TABLE device_list_state (
    device_id TEXT NOT NULL REFERENCES device(id),
    kind TEXT NOT NULL CHECK (kind IN ('prices','settings','blocklist')),
    applied_version INTEGER NOT NULL,
    via TEXT NOT NULL CHECK (via IN ('MQTT','ADMIN_CARD','HEARTBEAT','PROVISION')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, kind)
  );

  -- One row per accepted device message id (duplicate check).
  CREATE TABLE inbound_message (
    school_id TEXT NOT NULL REFERENCES school(id),
    device_id TEXT NOT NULL REFERENCES device(id),
    message_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (device_id, message_id)
  );

  CREATE TABLE device_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id TEXT,
    device_id TEXT,
    at INTEGER NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('INFO','WARN','ERROR')),
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT
  );

  -- Replay protection for signed kiosk HTTPS requests. Stored in the database so it
  -- would still work with more than one server.
  CREATE TABLE request_nonce (
    device_id TEXT NOT NULL REFERENCES device(id),
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, nonce)
  );

  -- Double-entry books. Balances are always computed from entries.
  CREATE TABLE account (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    kind TEXT NOT NULL CHECK (kind IN ('CASH_RECEIVED','STUDENT_WALLET','WAITING_TO_BE_ADDED','SCHOOL_SUBSIDY','SALES_PAYABLE')),
    member_id TEXT REFERENCES member(id),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX account_unique ON account(school_id, kind, ifnull(member_id, ''));

  CREATE TABLE posting (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    idem_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    memo TEXT,
    reversal_of TEXT REFERENCES posting(id),
    created_at INTEGER NOT NULL,
    UNIQUE (school_id, idem_key)
  );
  CREATE UNIQUE INDEX posting_reversed_once ON posting(reversal_of) WHERE reversal_of IS NOT NULL;

  CREATE TABLE entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    posting_id TEXT NOT NULL REFERENCES posting(id),
    account_id TEXT NOT NULL REFERENCES account(id),
    side TEXT NOT NULL CHECK (side IN ('DR','CR')),
    amount_sen INTEGER NOT NULL CHECK (amount_sen > 0)
  );
  CREATE INDEX entry_by_account ON entry(account_id);
  CREATE INDEX entry_by_posting ON entry(posting_id);

  -- Money waiting to be added to a card at the kiosk: parent top-ups, school
  -- subsidies, and balance transfers to a replacement card.
  CREATE TABLE topup_order (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    kind TEXT NOT NULL CHECK (kind IN ('TOPUP','SUBSIDY','TRANSFER')),
    parent_id TEXT REFERENCES parent(id),
    member_id TEXT NOT NULL REFERENCES member(id),
    amount_sen INTEGER NOT NULL CHECK (amount_sen > 0),
    status TEXT NOT NULL CHECK (status IN ('CREATED','PAID','ADDED','CANCELLED','FAILED','EXPIRED','REFUNDED','PARKED')),
    idem_key TEXT,
    request_hash TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    pay_by INTEGER,
    paid_at INTEGER,
    provider_txn_id TEXT,
    add_by INTEGER,
    write_attempt_at INTEGER,
    write_result TEXT CHECK (write_result IN ('UNCONFIRMED','FAILED','ADDED')),
    added_at INTEGER,
    added_by_device TEXT,
    kiosk_txn TEXT,
    card_id TEXT REFERENCES card(id),
    balance_after_on_card INTEGER,
    resolved_by TEXT,
    resolution_note TEXT,
    UNIQUE (parent_id, idem_key)
  );
  CREATE UNIQUE INDEX topup_kiosk_txn ON topup_order(school_id, added_by_device, kiosk_txn) WHERE kiosk_txn IS NOT NULL;
  CREATE INDEX topup_by_member ON topup_order(school_id, member_id, status);

  -- Canteen and water purchases reported by terminals (card balance is the money of
  -- record; posting them keeps the platform's mirror of each card balance).
  CREATE TABLE purchase (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    origin_device_code TEXT NOT NULL,
    device_txn TEXT NOT NULL,
    txn_number INTEGER NOT NULL,
    uploader_device_id TEXT REFERENCES device(id),
    via TEXT NOT NULL CHECK (via IN ('MQTT','JOURNAL_BATCH','KIOSK_READBACK','USB_IMPORT')),
    kind TEXT NOT NULL CHECK (kind IN ('SALE','WATER')),
    card_digest TEXT NOT NULL,
    card_id TEXT REFERENCES card(id),
    member_id TEXT REFERENCES member(id),
    amount_sen INTEGER NOT NULL CHECK (amount_sen >= 0),
    ml INTEGER,
    price_version INTEGER NOT NULL,
    list_version INTEGER NOT NULL,
    card_seq INTEGER NOT NULL,
    balance_before_sen INTEGER NOT NULL,
    balance_after_sen INTEGER NOT NULL,
    occurred_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('POSTED','FLAGGED')),
    posting_id TEXT REFERENCES posting(id),
    late INTEGER NOT NULL DEFAULT 0,
    raw TEXT NOT NULL,
    UNIQUE (school_id, origin_device_code, device_txn)
  );
  CREATE INDEX purchase_by_card_seq ON purchase(school_id, card_digest, card_seq);
  CREATE INDEX purchase_by_member ON purchase(school_id, member_id, occurred_at);

  -- Reconciliation differences for a person to review.
  CREATE TABLE difference (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES school(id),
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT,
    note TEXT,
    UNIQUE (school_id, kind, ref)
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  );
  `,
];

/**
 * Open (or create) the database and apply migrations.
 * @param {string} [file] path, or ':memory:' (default)
 */
export function openDb(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);');
  const current = raw.prepare('SELECT max(version) AS v FROM schema_version').get().v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    raw.exec('BEGIN');
    try {
      raw.exec(MIGRATIONS[i]);
      raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }
  return wrap(raw);
}

function wrap(raw) {
  const cache = new Map();
  let depth = 0;
  let savepointSeq = 0;
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    raw,
    /** INSERT/UPDATE/DELETE. @returns {{changes:number, lastInsertRowid:number|bigint}} */
    run(sql, ...params) {
      return stmt(sql).run(...params);
    },
    /** First row or undefined. */
    get(sql, ...params) {
      return stmt(sql).get(...params);
    },
    /** All rows. */
    all(sql, ...params) {
      return stmt(sql).all(...params);
    },
    exec(sql) {
      raw.exec(sql);
    },
    /**
     * Run `fn` in a transaction: all of it is written or none of it is.
     * Nested calls use savepoints, so services can call each other freely.
     * `fn` must be synchronous.
     */
    tx(fn) {
      if (depth === 0) {
        raw.exec('BEGIN IMMEDIATE');
        depth++;
        try {
          const result = fn();
          if (result && typeof result.then === 'function') throw new Error('db.tx() callback must be synchronous');
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        } finally {
          depth--;
        }
      }
      const name = `sp${++savepointSeq}`;
      raw.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('db.tx() callback must be synchronous');
        raw.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        raw.exec(`ROLLBACK TO ${name}`);
        raw.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth--;
      }
    },
    inTransaction() {
      return depth > 0;
    },
    close() {
      raw.close();
    },
  };
}
