# OneCard Lab — design and module contracts

OneCard Lab is a self-contained virtual lab for a school NFC card system: virtual chip
cards, canteen readers, water machines, a top-up kiosk and an admin card talk to a
cloud platform through a real MQTT broker and real HTTP, all in one Node.js process.
It is for trying the flows, testing failure cases and demonstrating the system before
any real hardware exists — the way Packet Tracer lets you build a network before
touching a switch.

This lab is an independent, public reference implementation. It follows the public
description of the OneCard flows (canteen, water, parent top-up, lost card, prices and
heartbeat, device security, record catch-up). Its protocol, keys and data are its own
and are not those of any production system. **Never put real keys, real school data or
non-public integration documents in this repository.**

This document is the contract between modules. Each module must match the function
names, arguments, return shapes and error codes below exactly, so modules written
separately fit together.

---

## 1. Ground rules

- Node.js ≥ 22.13, ES modules (`"type": "module"`), plain JavaScript with JSDoc. No TypeScript, no build step.
- Runtime dependencies: only `aedes` (MQTT broker) and `mqtt` (MQTT client). Everything else uses Node built-ins
  (`node:sqlite`, `node:http`, `node:crypto`, `node:test`).
- **Money is always whole sen** (`amountSen`, integer). RM 12.50 = `1250`. Never floats. Water volume is whole
  millilitres (`ml`).
- **Time comes only from the lab clock** (`ctx.clock.now()`, ms since epoch). Never call `Date.now()` in platform
  or device logic. Days and months for limits are Kuala Lumpur days (`shared/time.js`, UTC+8). Timestamps in
  messages and APIs are ISO-8601 strings; in the database they are integer ms.
- **Every query on school data filters by `school_id`.** A school id never comes from a request body or URL in the
  admin API — it comes from the signed-in staff session.
- Expected failures throw `LabError(code, message, status, detail?)` (`shared/errors.js`). Codes are listed per
  function below. Unexpected errors are bugs.
- Platform business logic is **synchronous** (SQLite via `node:sqlite` is synchronous). Wrap multi-step writes in
  `db.tx(() => ...)` (nesting is allowed; inner calls become savepoints). Only network edges (MQTT, HTTP) are async.
- Every module emits lab events through `ctx.events.emit(type, data, schoolCode)` so the lab console can show what
  happened. Event types are listed in §9.
- Comments: explain *why*, briefly. Match the style of `src/shared/*`.
- Tests: `node:test` + `node:assert/strict`, files under `test/unit/<module>.test.js` and
  `test/scenarios/<name>.test.js`. Use `createTestCtx()` and `waitFor()` from `test/helpers.js`. Network tests bind
  port `0` (random) and close everything they open.

### The context object `ctx`

Every service factory takes `ctx`:

```js
ctx = {
  db,        // src/platform/db.js wrapper: run/get/all/exec/tx/inTransaction/close
  clock,     // src/shared/clock.js: now(), iso(), advance(ms)
  events,    // src/shared/events.js: emit(type, data, schoolCode), subscribe(fn), since(seq)
  settings: {
    providerSecret,          // hex secret of the mock payment provider
    platformBrokerPassword,  // password of the platform's own broker account
    viewer: { username, password }, // read-only broker account for MQTT Explorer etc.
    heartbeatOnlineMs,       // a device counts as online if its last heartbeat is newer than this (default 90000)
  },
  log(level, message, meta), // optional console logger
}
```

### Shared modules (already written — use them, do not change their behaviour)

| Module | Provides |
|---|---|
| `src/shared/errors.js` | `LabError`, `isLabError` |
| `src/shared/ids.js` | `newId(prefix)`, `newUuid()`, `newCode(len)` |
| `src/shared/clock.js` | `createClock({startAt, mode:'real'|'manual'})`, `DEFAULT_LAB_START` |
| `src/shared/time.js` | `klDay`, `klMonth`, `klTime`, `klMinutes`, `formatKL`, `parseHHMM`, `isHHMM`, `inWindows`, `parseIso`, `toIso`, `MINUTE/HOUR/DAY` |
| `src/shared/money.js` | `isSen`, `assertSen`, `assertPositiveSen`, `formatRM`, `parseRM`, `waterChargeSen(ml, perLitreSen, minChargeSen)`, `maxAffordableMl(balanceSen, perLitreSen, minChargeSen)` |
| `src/shared/events.js` | `createEventBus({clock, keep})` |
| `src/shared/crypto.js` | `canonicalJson`, `sha256hex`, `hmacHex`, `hmacB64url`, `safeEqual`, `randomSecret`, `deriveKey`, `normalizeUid`, `last4`, `cardDigest(cardKey, schoolCode, uid)`, `cardMac(cardKey, memoryWithoutMac)`, `brokerPassword(deviceSecret)`, `signEnvelope`, `verifyEnvelopeSignature`, `requestSigningString`, `signRequest`, `signPayload` |
| `src/shared/protocol.js` | topics, envelope build/validate, `validateRecord`, device txn numbers, `REFUSAL`, `SCREEN_CARD_UNAVAILABLE`, constants |
| `src/platform/db.js` | `openDb(file)` and the whole schema (read it — it is the data model) |
| `src/platform/differences.js` | `createDifferences(ctx)`, `DIFFERENCE_KINDS` |

---

## 2. System picture

```
 Lab console / School office / Parent app  (browser, web/)
                 │ HTTP JSON + server-sent events
 ┌───────────────┴─────────────────────────────────────────────────────────┐
 │ src/http  ── routes ──► platform facade (src/platform/platform.js)      │
 │                          services: schools, devices, configs, ledger,   │
 │                          topups, settlement, reconcile, differences,    │
 │                          intake                                         │
 │ src/broker (aedes) ◄── MQTT (TCP) ──► platform MQTT client              │
 │        ▲  ▲  ▲                                                          │
 │        │  │  └── TopupKiosk ── HTTP (signed) ──► /api/kiosk/*           │
 │        │  └───── WaterMachine                                           │
 │        └──────── CanteenReader      (src/devices: virtual hardware)     │
 │   VirtualCard × N, AdminCard × schools  (held by the lab, src/lab)      │
 └─────────────────────────────────────────────────────────────────────────┘
```

The virtual devices run in the same process but behave like separate machines: they
only reach the platform through the broker (MQTT over TCP) and, for the kiosk, through
signed HTTP. Anyone can watch the traffic with MQTT Explorer or `mosquitto_sub` using the
read-only `viewer` account.

### Money model (card as wallet)

- The **card's chip holds the real balance** (stored-value card). Canteen readers and water machines charge the
  card directly and can work with no network at all.
- The platform keeps a **mirror** of every card balance in double-entry books, and a **journal** of every purchase
  that reaches it. Differences are flagged for a person.
- Money only gets **onto** a card at the **top-up kiosk**, which must be online and uses signed HTTP. An MQTT
  message can never add money.
- Parents pay online; the money **waits on the platform** ("waiting to be added") until the student taps at the
  kiosk. Money never added is refunded after the school's add window.

### Ledger accounts

| Kind | Normal side | Per member | Meaning |
|---|---|---|---|
| `CASH_RECEIVED` | DR (asset) | no | Money the school has actually received |
| `STUDENT_WALLET` | CR (liability) | yes | Mirror of the money on the member's card |
| `WAITING_TO_BE_ADDED` | CR (liability) | yes | Paid or granted, not on the card yet |
| `SCHOOL_SUBSIDY` | DR (expense) | no | Subsidies the school gives |
| `SALES_PAYABLE` | CR (liability) | no | Canteen and water sales owed to the operators (the lab's addition; the four public account kinds have no purchase entry) |

Postings (`idemKey` in brackets makes each one happen once):

| Event | Lines | idemKey |
|---|---|---|
| Parent payment confirmed | DR CASH_RECEIVED / CR WAITING_TO_BE_ADDED(member) | `TOPUP:<orderId>:PAID` |
| Subsidy granted | DR SCHOOL_SUBSIDY / CR WAITING_TO_BE_ADDED(member) | `SUBSIDY:<orderId>:GRANTED` |
| Balance moved to replacement card | DR STUDENT_WALLET(member) / CR WAITING_TO_BE_ADDED(member) | `TRANSFER:<orderId>:CREATED` |
| Kiosk added money to card | DR WAITING_TO_BE_ADDED(member) / CR STUDENT_WALLET(member) | `<KIND>:<orderId>:ADDED` |
| Unadded top-up/subsidy expired | reversal of the PAID/GRANTED posting | `<KIND>:<orderId>:REVERSAL` |
| Purchase reported (amount > 0) | DR STUDENT_WALLET(member) / CR SALES_PAYABLE | `PURCHASE:<origin>:<txn>` |

---

## 3. Device protocol (MQTT + kiosk HTTP)

### Topics and broker accounts

```
lab/v1/{school}/{device}/records            device → platform  (QoS 1, not retained)
lab/v1/{school}/{device}/status             device → platform  (QoS 1, not retained)
lab/v1/{school}/{device}/commands/prices    platform → device  (QoS 1, RETAINED)
lab/v1/{school}/{device}/commands/settings  platform → device  (QoS 1, RETAINED)
lab/v1/{school}/{device}/commands/blocklist platform → device  (QoS 1, RETAINED full snapshot)
lab/v1/{school}/{device}/commands/blocklist-delta  platform → device (QoS 1, not retained)
lab/v1/{school}/{device}/commands/control   platform → device  (QoS 1, not retained)
```

Each retained kind has **its own sub-topic**, so publishing one never overwrites another.
School codes are lower-case (`smk-contoh`), device codes upper-case (`CANTEEN-01`).

| Account | Username | Password | May publish | May subscribe |
|---|---|---|---|---|
| Platform | `platform` | `ctx.settings.platformBrokerPassword` | `lab/v1/+/+/commands/#` | `lab/v1/+/+/records`, `lab/v1/+/+/status` |
| Device | `<school>.<DEVICE>` (client id must equal the username) | `brokerPassword(device.secret)` | only its own `records` and `status` | only its own `commands/#` |
| Viewer | `ctx.settings.viewer.username` | `ctx.settings.viewer.password` | nothing | `lab/v1/#` |

Anonymous logins, `$SYS/#`, `#` and any other topic are refused. A device whose status
is not `ACTIVE`, or whose school is `SUSPENDED`, cannot log in, and is disconnected
("kicked") when it is switched off.

### Envelope

```json
{
  "v": "1.0",
  "id": "8c1b…(uuid)",
  "school": "smk-contoh",
  "device": "CANTEEN-01",
  "seq": 42,
  "at": "2026-10-05T02:15:00.000Z",
  "type": "sale.recorded",
  "txn": "CANTEEN-01-000017",
  "body": { },
  "sig": "base64url HMAC-SHA256"
}
```

- `sig = hmacB64url(device.secret, canonicalJson(envelope without sig))` — `signEnvelope()` /
  `verifyEnvelopeSignature()` in `shared/crypto.js`. Commands from the platform are signed with the **same device
  secret**, so a device can check they really came from the platform. (A lab simplification: one shared key per
  device.)
- Device → platform: `seq` strictly increases per device and survives restarts. Platform → device: `seq` is the
  platform's own counter per device; devices do **not** check its order, they only de-duplicate by `id`.
- `txn`: the device transaction number for a single record, or the batch id for a batch.

### Purchase record

Used in `sale.recorded` / `water.recorded` bodies (`body.record`), in `journal.batch` (`body.records[]`), in
`card.readback` (`body.records[]`) and in USB export files. Validated by `validateRecord()`.

```json
{
  "txn": "CANTEEN-01-000017",        // '<origin>-<6+ digits>', consecutive per origin device, never reused
  "origin": "CANTEEN-01",            // the machine that made the sale (kept when relayed by the kiosk)
  "kind": "SALE",                    // SALE | WATER
  "card": "<64 hex card digest>",
  "last4": "C3D4",
  "cardSeq": 12,                     // the card's own transaction counter after this debit
  "amountSen": 350,
  "items": [{ "code": "NASI-LEMAK", "qty": 1, "priceSen": 350 }],   // SALE only
  "ml": 650, "perLitreSen": 20,      // WATER only
  "priceVersion": 3,
  "listVersion": 5,                  // block-list version the machine had at the time
  "balanceBeforeSen": 2000,
  "balanceAfterSen": 1650,
  "at": "2026-10-05T02:15:00.000Z",
  "currency": "MYR"                  // optional; anything else is refused
}
```

### Message types

| type | channel | sender | body |
|---|---|---|---|
| `sale.recorded` | records | CANTEEN | `{ record }` (envelope `txn` = record.txn) |
| `water.recorded` | records | WATER | `{ record }` |
| `journal.batch` | records | any | `{ batchId, count, records: [record…] }` (1–200 records; `count` must equal `records.length`; envelope `txn` = batchId) |
| `card.readback` | records | KIOSK | `{ card, last4, balanceSen, cardSeq, listVersionOnCard, records: [record…], writes: [{orderId, amountSen, kioskTxn, at}] }` |
| `command.ack` | records | any | `{ command: <command envelope id>, kind: 'prices'|'settings'|'blocklist', result: 'APPLIED'|'REJECTED'|'ALREADY_APPLIED', appliedVersion, error? }` |
| `device.heartbeat` | status | any | `{ fw, health: 'OK'|'WARN', listVersions: { prices, settings, blocklist }, journalUnsent }` |
| `config.prices` | commands/prices | platform | `{ version, effectiveFrom, currency:'MYR', items:[{code,name,priceSen}], water:{perLitreSen, minChargeSen} }` |
| `config.settings` | commands/settings | platform | `{ version, effectiveFrom, mealWindows:[{from,to}], allowedGroups:[…], perPurchaseMaxSen, dailyMaxSen, dailyMaxCount, tapGapSeconds }` |
| `blocklist.snapshot` | commands/blocklist | platform | `{ version, entries:[{card, last4}] }` |
| `blocklist.delta` | commands/blocklist-delta | platform | `{ fromVersion, toVersion, added:[{card,last4}], removed:[card] }` |
| `control.upload-journal` | commands/control | platform | `{}` — upload every unsent journal record now |
| `control.heartbeat-now` | commands/control | platform | `{}` |

### Intake pipeline (platform side, in this order)

1. Topic must parse (`parseTopic`) and be `records` or `status` → else `TOPIC_INVALID`.
2. School and device must exist → else `UNKNOWN_DEVICE`.
3. JSON parse + `validateEnvelopeShape` → `ENVELOPE_INVALID` / `VERSION_UNSUPPORTED` / `UNKNOWN_TYPE`.
4. Envelope `school`/`device` must equal the topic's, and `UP_TYPES[type]` must equal the topic channel → `TOPIC_MISMATCH`.
5. Signature with the device secret → `SIGNATURE_INVALID`.
6. Duplicate check: `(device, message id)` already in `inbound_message` → result `DUPLICATE` (not an error; nothing else happens).
7. Sequence: `seq` must be greater than `device.last_seq` → `SEQUENCE_ROLLBACK` (clear code, written to the device log).
8. Gates: school `SUSPENDED` → `SCHOOL_SUSPENDED` (a whole batch is refused; the device keeps its records); device not `ACTIVE` → `DEVICE_DISABLED`.
9. Type rules: `sale.recorded` only from CANTEEN, `water.recorded` only from WATER, `card.readback` only from KIOSK → `WRONG_DEVICE_TYPE`; batch `count` mismatch → `COUNT_MISMATCH`.
10. Record the message id and seq, then dispatch. Each record in a batch is handled on its own: one bad record is refused alone.

Every refusal is written to `device_log` (level `WARN`) and emitted as `intake.refused`. Nothing is
replied over MQTT for records.

### Kiosk HTTP (signed)

Headers on every `/api/kiosk/*` request:

```
x-lab-school: smk-contoh
x-lab-device: KIOSK-01
x-lab-timestamp: <ms, lab clock>
x-lab-nonce: <random, 16-64 chars>
x-lab-signature: signRequest({ secretHex: device.secret, method, path, timestamp, nonce, body })
```

`path` includes the query string; `body` is the exact request body text (`''` for GET). The platform refuses
(401 `SIGNATURE_INVALID`) a bad signature, a timestamp more than 5 minutes from the lab clock, or a nonce already
used by that device in the last 10 minutes (409 `REPLAY`). The device must exist, be `ACTIVE`, be type `KIOSK`,
and its school must be `ACTIVE` (403 `DEVICE_DISABLED` / `SCHOOL_SUSPENDED` / `WRONG_DEVICE_TYPE`).

| Method & path | Body → Response |
|---|---|
| `POST /api/kiosk/pending` | `{ card, max? }` → `{ member:{id,name}, orders:[{orderId, kind, amountSen}], mirrorBalanceSen, waitingSen }` |
| `POST /api/kiosk/confirm` | `{ orderId, result:'ADDED'|'FAILED', amountSen, card, balanceAfterOnCardSen, kioskTxn }` → `{ orderId, status, duplicate }` |
| `GET /api/kiosk/confirm/<kioskTxn>` | → `{ orderId, status }` or 404 |
| `GET /api/kiosk/packs` | → `{ token, school, packs:[{kind, version, content, checksum}] }` |
| `POST /api/kiosk/admin-card/receipts` | `{ token, receipts:[{device, kind, appliedVersion, result, error?, at}] }` → `{ recorded }` |

Rules for the kiosk: it reads the card before every write; it writes each order all-or-nothing; if a confirm
times out it looks the result up by the same `kioskTxn` and never writes again under a new number; with no network
it writes nothing and asks the student to come back later.

### Admin card

Memory: `{ school, token, loadedAt, packs:[{kind, version, content, checksum}], receipts:[…] }`.
`checksum = sha256hex(canonicalJson(content))`. The token comes from the platform and only ever goes up per school.
A terminal applies a pack only if the checksum is right, the version is **not lower** than its own, and the
admin-card token is **higher** than the highest token it has seen; it replaces the whole list/price table at once,
then writes a receipt `{ device, kind, appliedVersion, result:'APPLIED'|'ALREADY_APPLIED'|'REJECTED', error?, at }`.

### Virtual card memory

```json
{ "uid": "04A1B2C3", "school": "smk-contoh", "group": "STUDENT", "balanceSen": 2000, "cardSeq": 7,
  "records": [record…],            // the last 20 purchases, newest last (full records)
  "writes": [{ "orderId", "amountSen", "kioskTxn", "at" }],   // the last 10 kiosk top-ups
  "listVersionOnCard": 5, "mac": "…" }
```

`mac = cardMac(school.card_key, memory without mac)`. Machines of the school hold the card key; a card whose MAC
does not check out is refused as "card unavailable". Copying a card copies a valid MAC (the clone fault); editing it
by hand breaks the MAC (the tamper fault).

### Terminal rules for a tap (canteen and water)

Refuse with `SCREEN_CARD_UNAVAILABLE` (never say why) when: the terminal has never received a block list
(version 0); the MAC is wrong; the card belongs to another school; the card digest is on the block list. Refuse
with a plain message when: outside `mealWindows` ("Closed now"); holder group not in `allowedGroups`; amount above
`perPurchaseMaxSen`; today's (KL day) total on the card's records plus this amount above `dailyMaxSen`; today's
count reaches `dailyMaxCount`; less than `tapGapSeconds` since the card's last record; balance too low ("Not enough
balance"). An old but complete block list still blocks.

---

## 4. Platform services (src/platform/)

All factories return plain objects of synchronous functions unless marked async.

### 4.1 `ledger.js` — `createLedger(ctx)`

Exports `ACCOUNT_KINDS` (table in §2: `{ normal:'DR'|'CR', perMember:boolean }`) and `createLedger`.

- `account(schoolId, kind, memberId = null)` → account row (created on first use). Per-member kinds require a memberId, others forbid it (`ACCOUNT_INVALID`).
- `post({ schoolId, idemKey, kind, ref = null, memo = null, lines })` → `{ posting, created }`.
  `lines: [{ kind, memberId?, side: 'DR'|'CR', amountSen }]`. Rules: at least 2 lines; every amount a positive
  integer; total DR = total CR (`POSTING_UNBALANCED`); bad shapes `POSTING_INVALID`. Same `(schoolId, idemKey)` with
  the same lines → returns the existing posting, `created:false`; different lines → `IDEMPOTENCY_CONFLICT` (409).
  Runs in `db.tx`. Emits `ledger.posting`.
- `reverse({ schoolId, postingId, idemKey, memo })` → `{ posting, created }`: a new posting with every side flipped,
  `reversal_of = postingId`. Unknown posting `POSTING_NOT_FOUND` (404); reversing a reversal `CANNOT_REVERSE_REVERSAL`;
  already reversed under another idemKey `ALREADY_REVERSED` (409); same idemKey again → existing, `created:false`.
- `balance(schoolId, kind, memberId = null)` → integer sen on the account's normal side (DR-normal: DR−CR; CR-normal: CR−DR). Missing account → 0. May be negative.
- `memberBalances(schoolId, memberId)` → `{ walletSen, waitingSen }`.
- `trialBalance(schoolId)` → `{ accounts:[{ id, kind, memberId, memberName, debitSen, creditSen, balanceSen }], totals:{ debitSen, creditSen }, balanced }`.
- `postings(schoolId, { limit = 50, memberId } = {})` → newest first: `[{ id, kind, ref, memo, reversalOf, createdAt, lines:[{ kind, memberId, side, amountSen }] }]`.
- `getPosting(schoolId, id)`, `findByIdemKey(schoolId, idemKey)` → posting DTO or null.

Posting DTO: `{ id, schoolId, idemKey, kind, ref, memo, reversalOf, createdAt, lines }`.

### 4.2 `schools.js` — `createSchools(ctx)`

Default school settings (`DEFAULT_SCHOOL_SETTINGS`, exported):
`{ topup: { minSen: 500, maxSen: 20000, dailyMaxSen: 30000, monthlyMaxSen: 100000, payWindowMinutes: 30, addWindowDays: 14 } }`.

- Schools: `createSchool({ code, name, settings? })` (code must match `SCHOOL_CODE_RE`, `SCHOOL_CODE_TAKEN`) → school;
  `getSchool(id)`, `getSchoolByCode(code)` (null if none), `listSchools()`, `setSchoolStatus(schoolId, status, actor)`,
  `schoolSettings(schoolId)` (defaults deep-merged with stored), `updateSchoolSettings(schoolId, patch, actor)`.
  School DTO: `{ id, code, name, status, settings, createdAt }` (never the card key). `schoolCardKey(schoolId)` returns the key for platform-internal use.
- Staff: `addStaff({ schoolId, name, role })`, `getStaff(id)`, `listStaff(schoolId?)` → `{ id, schoolId, name, role }`.
- Members: `addMember({ schoolId, memberNo, name, className = '', group = 'STUDENT' })` (`MEMBER_NO_TAKEN`),
  `getMember(schoolId, memberId)` (null if not in that school), `listMembers(schoolId)` →
  `[{ id, memberNo, name, className, group, status, card: { uid, last4, status } | null }]`.
- Cards: `issueCard({ schoolId, memberId, uid, actor })` (`CARD_UID_TAKEN`, `MEMBER_HAS_ACTIVE_CARD`, `MEMBER_NOT_FOUND`)
  → card DTO `{ id, schoolId, uid, last4, digest, memberId, status, issuedAt, lostAt, lostListVersion }`;
  `getCardByUid(schoolId, uid)`, `getCardByDigest(schoolId, digest)`, `getCard(schoolId, cardId)`,
  `activeCardForMember(schoolId, memberId)`, `listCards(schoolId)`;
  `markCardLost({ schoolId, uid, actor })` (`CARD_NOT_ACTIVE` 409) → card (status LOST, lostAt now);
  `setLostListVersion(schoolId, cardId, version)`; `markCardFound({ schoolId, uid, actor })` (only LOST →
  ACTIVE; `CARD_NOT_LOST`; `MEMBER_HAS_ACTIVE_CARD` if replaced meanwhile) → card;
  `cardDigestFor(schoolId, uid)`.
- Parents: `registerParent({ email, name })` (`EMAIL_TAKEN`, `EMAIL_INVALID`) → `{ id, email, name }`; `getParent(id)`,
  `getParentByEmail(email)`, `listParents()`.
- Invites: `createInvite({ schoolId, memberId, actor })` → `{ id, code, memberId, status }`; `listInvites(schoolId)`;
  `redeemInvite({ parentId, code })` → link DTO (status PENDING; marks invite USED) (`INVITE_INVALID` 404, `LINK_EXISTS` 409).
- Links: `listLinks(schoolId, { status } = {})` → `[{ id, parentId, parentName, parentEmail, memberId, memberName, status, createdAt }]`;
  `decideLink({ schoolId, linkId, approve, actor })` (`LINK_NOT_FOUND`, `LINK_ALREADY_DECIDED`) → link DTO;
  `parentChildren(parentId)` → APPROVED links across schools:
  `[{ linkId, schoolId, schoolCode, schoolName, memberId, name, className, card: { uid, last4, status } | null }]`;
  `parentLinks(parentId)` → all links with status; `isLinked(parentId, schoolId, memberId)` → boolean (APPROVED only).
- Audit: `audit(schoolId, actor, action, detail)`; `listAudit(schoolId, limit = 100)`.

### 4.3 `devices.js` — `createDevices(ctx)`

- `registerDevice({ schoolId, code, type, location = '', actor })` → `{ device, secret }` (secret shown once)
  (`DEVICE_CODE_INVALID`, `DEVICE_TYPE_INVALID`, `DEVICE_CODE_TAKEN`).
- Device DTO: `{ id, schoolId, code, type, location, status, lastSeq, lastHeartbeatAt, fwVersion, health, online, createdAt }`
  (`online` = lastHeartbeatAt within `ctx.settings.heartbeatOnlineMs`). Never includes the secret.
- `getDevice(schoolId, deviceId)`, `getDeviceByCode(schoolId, code)`, `listDevices(schoolId)`.
- `resolveByCodes(schoolCode, deviceCode)` → `{ school, device, secret }` or null (platform-internal: intake, broker auth, kiosk auth).
- `setDeviceStatus({ schoolId, code, status, actor })` → device.
- `recordHeartbeat({ deviceId, at, fw, health })`.
- `claimSeq(deviceId, seq)` → `'OK'` (and stores it) or `'ROLLBACK'`.
- `useNonce(deviceId, nonce)` → true if fresh (stored for 10 minutes of lab time), false if already used. Purges expired nonces.
- `log({ schoolId, deviceId, level, code, message, detail })`; `listLog(schoolId, { deviceId, limit = 100 } = {})`.
- `brokerCredentials(schoolCode, deviceCode, secret)` → `{ username: '<school>.<DEVICE>', password }`.

### 4.4 `configs.js` — `createConfigs(ctx, { schools })`

Exports `DEFAULT_PRICES`, `DEFAULT_SETTINGS`, `validatePrices(content)`, `validateSettings(content)`.

- Price content: `{ items:[{ code /^[A-Z0-9-]{1,24}$/ unique, name 1–40 chars, priceSen 1..100000 }] (1–50 items), water:{ perLitreSen 1..10000, minChargeSen 0..10000 } }`.
- Settings content: `{ mealWindows:[{ from:'HH:MM', to:'HH:MM' }] (0–6, from < to), allowedGroups: non-empty subset of ['STUDENT','STAFF'], perPurchaseMaxSen 1..100000, dailyMaxSen 1..1000000, dailyMaxCount 1..100, tapGapSeconds 0..600 }`.
  Invalid → `CONFIG_INVALID` (400, detail = list of problems).
- `publish({ schoolId, kind: 'prices'|'settings', content, effectiveFrom?, actor })` → `{ kind, version, content, effectiveFrom }` (version = previous + 1 per school and kind).
- `current(schoolId, kind)` → `{ kind, version, content, effectiveFrom, createdAt }` or null. For `blocklist` with no versions: `{ kind, version: 0, content: { entries: [] } }`.
- `getVersion(schoolId, kind, version)` → same shape or null; `history(schoolId, kind, limit = 20)`.
- Block list (stored as a full snapshot per version: `{ entries:[{card,last4}], added:[{card,last4}], removed:[card] }`):
  `blockCard({ schoolId, cardId, actor })` → `{ version, changed }` (no new version if already listed);
  `unblockCard({ schoolId, cardId, actor })` → `{ version, changed }`;
  `currentBlockList(schoolId)` → `{ version, entries }`;
  `blockListDelta(schoolId, fromVersion)` → `{ fromVersion, toVersion, added, removed }` (net change), or null if `fromVersion` is unknown.
- Admin card: `packs(schoolId)` → `[{ kind, version, content, checksum }]` for `blocklist` (content `{entries}`), `prices`, `settings` (only kinds that have a version); `nextAdminCardToken(schoolId)` → integer (stored, strictly increasing).
- Device state: `recordListState({ deviceId, kind, version, via })`; `listStates(schoolId)` →
  `[{ deviceId, deviceCode, kind, appliedVersion, via, updatedAt, currentVersion, behind }]` (one row per device and kind, including kinds never reported: appliedVersion 0).
- Emits `config.published` `{ kind, version }`.

### 4.5 `topups.js` — `createTopups(ctx, { ledger, schools, differences })`

Order DTO: `{ id, schoolId, kind, parentId, memberId, memberName, amountSen, status, createdAt, payBy, paidAt, addBy, writeAttemptAt, writeResult, addedAt, addedByDevice, kioskTxn, balanceAfterOnCardSen, resolvedBy, resolutionNote }`.

- `createOrder({ parentId, schoolId, memberId, amountSen, idemKey })` → order (CREATED, `payBy = now + payWindowMinutes`).
  Checks: `IDEMPOTENCY_KEY_REQUIRED`; `NOT_LINKED` (403) unless an APPROVED link; `CARD_NOT_ACTIVE` (409) unless the member has an ACTIVE card;
  `AMOUNT_OUT_OF_RANGE` outside school min/max; `DAILY_LIMIT` / `MONTHLY_LIMIT` counting the member's orders of kind TOPUP in CREATED, PAID, ADDED, PARKED for the KL day/month.
  Same `(parentId, idemKey)` + same request → the existing order; different request → `IDEMPOTENCY_KEY_REUSED` (409).
- `paymentCallback(payload)` where `payload = { orderId, provider, providerTxnId, result:'SUCCESS'|'FAILED', paidAmountSen, paidAt, signature }`
  and `signature = signPayload(ctx.settings.providerSecret, payload without signature)` → order.
  `PAYMENT_SIGNATURE_INVALID` (401); `ORDER_NOT_FOUND` (404). FAILED: CREATED → FAILED. SUCCESS: `PAYMENT_AMOUNT_MISMATCH` if amounts differ;
  CREATED or CANCELLED → PAID (`paidAt`, `addBy = paidAt + addWindowDays`) and post `TOPUP:<id>:PAID`. A repeat callback for a PAID/ADDED order with the same providerTxnId returns the order unchanged.
- `kioskPending({ schoolId, kioskDeviceId, cardDigest, max = 10 })` → `{ member:{ id, name }, orders:[{ orderId, kind, amountSen }], mirrorBalanceSen, waitingSen }`.
  `CARD_NOT_FOUND` (404); `CARD_NOT_ACTIVE` (409) for LOST/RETIRED cards. Orders: the member's PAID orders not past `addBy`, oldest first, at most `max` (1–50).
  Marks them `writeAttemptAt = now, writeResult = 'UNCONFIRMED'`.
- `kioskConfirm({ schoolId, kioskDeviceId, kioskDeviceCode, orderId, result, amountSen, cardDigest, balanceAfterOnCardSen, kioskTxn })` → `{ orderId, status, duplicate }`.
  `ORDER_NOT_FOUND`; `ORDER_CARD_MISMATCH` (card's member ≠ order member); `ORDER_AMOUNT_MISMATCH`.
  ADDED on PAID or PARKED → ADDED, post `<KIND>:<id>:ADDED`, store device, kioskTxn, card, balance. ADDED again with the same device + kioskTxn → `duplicate:true`.
  ADDED with another kioskTxn → `ORDER_ALREADY_ADDED` (409) and open difference `DOUBLE_ADD_SUSPECTED`. ADDED on EXPIRED/REFUNDED → `ORDER_ALREADY_REFUNDED` (409) and open
  `TOPUP_ADDED_AFTER_REFUND`. FAILED on PAID/PARKED → `writeResult = 'FAILED'`, status unchanged.
- `kioskLookup({ schoolId, kioskDeviceCode, kioskTxn })` → `{ orderId, status }` or null.
- `grantSubsidy({ schoolId, memberId, amountSen, actor, note })` → order (kind SUBSIDY, PAID, `addBy = now + addWindowDays`), posts `SUBSIDY:<id>:GRANTED`.
- `createTransfer({ schoolId, memberId, actor })` → order (kind TRANSFER, PAID, `addBy = null`: never expires) for the member's whole mirror wallet balance, posting `TRANSFER:<id>:CREATED`; null if the balance is 0 or less.
- `runJobs()` → `{ cancelled, refunded, parked }`: CREATED past `payBy` → CANCELLED; PAID past `addBy` with writeResult null or FAILED → EXPIRED → REFUNDED
  (reverse the PAID/GRANTED posting; emit `topup.refunded` "refund sent to parent (mock)"); PAID past `addBy` with writeResult UNCONFIRMED → PARKED (may already be on the card).
- `resolveParked({ schoolId, orderId, decision: 'ADDED'|'REFUND', actor, note })` (`ORDER_NOT_PARKED` 409) → order.
- `getOrder(schoolId, id)`, `listOrders({ schoolId, parentId, memberId, status, kind, limit = 100 })`.
- `memberSummary(schoolId, memberId)` → `{ mirrorBalanceSen, waitingSen, waitingOrders:[order] }`.
- Emits `topup.status` `{ orderId, kind, status, amountSen }` on every status change.

### 4.6 `settlement.js` — `createSettlement(ctx, { ledger, schools, configs, devices, differences })`

- `receive({ schoolId, uploaderDeviceId, via, record })` → `{ status: 'POSTED'|'FLAGGED'|'DUPLICATE'|'REFUSED', purchaseId?, code?, differences: [kind] }`. Never throws for business problems. Steps:
  1. `validateRecord` → REFUSED `RECORD_INVALID`. Origin device must exist in the school → REFUSED `UNKNOWN_ORIGIN_DEVICE`.
  2. `(school, origin, txn)` already stored: same content (canonical JSON of the record) → DUPLICATE; different → open `DUPLICATE_CONFLICT` (ref `<origin>:<txn>`), DUPLICATE with `code: 'CONFLICT'`.
  3. Card digest unknown → store FLAGGED (no member, no posting), open `UNKNOWN_CARD`.
  4. Price check against `configs.getVersion(school, 'prices', priceVersion)`: unknown → `PRICE_VERSION_UNKNOWN`; SALE: each item's priceSen must equal the version's and the sum of qty × price must equal amountSen; WATER: perLitreSen must equal the version's and `amountSen === waterChargeSen(ml, perLitreSen, minChargeSen)` → else `PRICE_MISMATCH`. (Record is still posted: the card was really charged.)
  5. `balanceBeforeSen − amountSen === balanceAfterSen` → else `BALANCE_CONTINUITY`.
  6. Another stored purchase with the same card digest and cardSeq → `CARD_CLONE_SUSPECTED` (ref `<digest>:<cardSeq>`).
  7. Card LOST and `at ≥ lostAt` → `SPENT_AFTER_LOST_REPORT` with detail `{ listVersionOnMachine, lostListVersion, machineHadUpdatedList }`.
  8. Post `PURCHASE:<origin>:<txn>` (if amount > 0) and store the purchase POSTED. If the member's wallet is now below 0 → `MIRROR_NEGATIVE` (ref `<memberId>:<txn>`).
  `late = 1` when `via` is not `MQTT` or the record arrives more than 24 h after `at`. Emits `purchase.received`.
- `listPurchases(schoolId, { limit = 100, memberId, deviceCode } = {})` → `[{ id, originDeviceCode, txn, via, kind, memberId, memberName, amountSen, ml, items, priceVersion, listVersion, occurredAt, receivedAt, status, late }]`.
- `salesReport(schoolId, { day } = {})` (KL day, default today) → `{ day, totalSen, count, byDevice:[{ deviceCode, kind, count, totalSen }], byItem:[{ code, qty, totalSen }] }`.

### 4.7 `reconcile.js` — `createReconcile(ctx, { ledger, schools, configs, devices, differences })`

- `checkCardSnapshot({ schoolId, cardDigest, balanceSen, cardSeq })` → `{ match, mirrorSen, cardSen }`; on mismatch open `BALANCE_MISMATCH` (ref `<digest>:<cardSeq>`, detail both amounts and a hint).
- `scanGaps(schoolId)` → number of new differences: for each origin device, missing numbers between the lowest and highest txn number received → `MISSING_RECORDS` (ref `<origin>:<from>-<to>`).
- `scanListLag(schoolId, { maxAgeMs = 24 h })` → number of new differences: devices whose applied block-list version is below the current version when the current version is older than `maxAgeMs` → `OLD_BLOCK_LIST` (ref `<deviceCode>:<currentVersion>`).
- `run(schoolId)` → `{ gaps, lag }`.

### 4.8 `intake.js` — `createIntake(ctx, { schools, devices, configs, settlement, reconcile })`

- `handle(topic, payload)` (payload: Buffer or string) → `{ result: 'ACCEPTED'|'DUPLICATE'|'REFUSED', code?, type?, detail? }`. Never throws. Implements §3 "Intake pipeline".
  Dispatch: `device.heartbeat` → `devices.recordHeartbeat` + `configs.recordListState(..., via 'HEARTBEAT')` for each reported kind;
  `sale.recorded`/`water.recorded` → `settlement.receive(via 'MQTT')`; `journal.batch` → each record `settlement.receive(via 'JOURNAL_BATCH')`;
  `card.readback` → each record `settlement.receive(via 'KIOSK_READBACK')`, then `reconcile.checkCardSnapshot`;
  `command.ack` with result APPLIED/ALREADY_APPLIED → `configs.recordListState(..., via 'MQTT')`.
  Emits `intake.accepted` / `intake.duplicate` / `intake.refused` `{ device, type, code?, results? }`.

### 4.9 `platform.js` — `createPlatform(ctx, { broker? })` (the facade)

Builds every service: `platform.services = { schools, devices, configs, ledger, topups, settlement, reconcile, differences, intake }`.

- `async connectMqtt(brokerUrl)` — connects as `platform`, subscribes to `lab/v1/+/+/records` and `lab/v1/+/+/status` (QoS 1), feeds each message to `intake.handle`. `async disconnectMqtt()`.
- `async publishConfig(schoolId, kind, { deviceCode } = {})` — publishes the current `prices`/`settings`/`blocklist` snapshot, signed per device, **retained**, to every ACTIVE device of the school (or one device). `async publishBlockListDelta(schoolId, delta)` (not retained).
- `async sendControl(schoolId, deviceCode, type)`.
- Orchestrations (each also writes audit and emits events):
  `async reportCardLost({ schoolId, uid, actor })` → card (mark LOST, block, store `lostListVersion`, publish snapshot + delta);
  `async markCardFound({ schoolId, uid, actor })` → card (unblock, publish);
  `async replaceCard({ schoolId, memberId, newUid, actor })` → `{ oldCard, newCard, transferOrder }` (old ACTIVE card reported lost first; new card issued; transfer of the mirror balance);
  `async publishPrices({ schoolId, content, actor })`, `async publishSettings({ schoolId, content, actor })` → config (store + publish);
  `async setDeviceStatus({ schoolId, code, status, actor })` → device (kick it from the broker when not ACTIVE);
  `async setSchoolStatus({ schoolId, status, actor })` (kick all its devices when SUSPENDED);
  `registerDevice(...)` (pass-through); `runJobs()` → topups.runJobs + reconcile.run for every school.
- Emits `card.issued` `{ uid, memberId }` when a card is issued through the facade (the lab listens to create the physical virtual card), and `card.lost`, `card.found`.

---

## 5. Broker (src/broker/broker.js)

`async startBroker(ctx, { host = '127.0.0.1', port = 1883, tls, resolveDevice, platformPassword, viewer })` →
`{ url, port, tlsUrl, tlsPort, aedes, kick(username), clients(), close() }`.

- `resolveDevice(username)` → `{ schoolCode, deviceCode, password, active }` or null — supplied by the lab from the
  devices service (`active` is false if the device is not ACTIVE or its school is SUSPENDED).
- `tls`: optional `{ port, key, cert }` (PEM strings) — adds a TLS listener.
- Uses aedes 1.x (`import { Aedes } from 'aedes'; const aedes = await Aedes.createBroker()`; `net.createServer(aedes.handle)`).
- Implements the accounts table in §3 with `authenticate`, `authorizePublish`, `authorizeSubscribe`. Device client id must equal its username.
- Emits `mqtt.connect` `{ username, clientId }`, `mqtt.disconnect`, `mqtt.denied` `{ username, action:'connect'|'publish'|'subscribe', topic? }`, and `mqtt.publish` `{ from, topic, type, txn, retained, bytes }` (type/txn read from the JSON payload if possible). Use the school code from the topic as the event's school.

---

## 6. Virtual hardware (src/devices/)

- `card.js` — `class VirtualCard`:
  `constructor({ uid, schoolCode, group = 'STUDENT', cardKey })` (new card, balance 0, signed);
  `static fromMemory(memory)`; getter `memory` (deep copy); `uid`, `schoolCode`;
  `read(cardKey)` → verified memory copy, throws `CardError('CARD_UNREADABLE')` if the MAC is wrong;
  `debit({ cardKey, amountSen, record })` → `{ record, balanceBeforeSen, balanceAfterSen, cardSeq }` — atomic: checks MAC and balance (`CardError('INSUFFICIENT_BALANCE')`), increments cardSeq, **fills in** the record's `cardSeq`, `balanceBeforeSen`, `balanceAfterSen` (the caller passes the record without them), appends the completed record (keeps the last 20) and returns it;
  `credit({ cardKey, amountSen, write: { orderId, kioskTxn, at }, failMode })` → `{ balanceBeforeSen, balanceAfterSen, cardSeq }` — atomic; also increments cardSeq (every change to the card does); keeps the last 10 writes; `CardError('ALREADY_WRITTEN')` if that orderId is already in `writes`; `failMode: 'power-cut-before-commit'` throws `PowerCutError` with nothing changed, `'power-cut-after-commit'` commits then throws `PowerCutError`;
  Card errors: `CardError` has a `code`: `CARD_UNREADABLE`, `INSUFFICIENT_BALANCE`, `ALREADY_WRITTEN`, `WRONG_SCHOOL`.
  `setListVersion({ cardKey, version })`; `clone()` → new VirtualCard with identical memory; `tamper({ balanceSen })` (changes the balance without a new MAC).
  Export `CardError`, `PowerCutError`.
- `adminCard.js` — `class AdminCard`: `constructor({ schoolCode })`, `load({ token, packs, loadedAt })`, `addReceipt(r)`, `takeReceipts()`, `memory`. Export `verifyPack(pack)` → boolean (checksum).
- `usb.js` — `exportJournal({ schoolCode, deviceCode, secret, records, exportedAt })` → file object
  `{ format: 'onecard-lab-journal/1', school, device, exportedAt, count, records, sig }` (sig = HMAC over the rest, canonical JSON); `verifyJournalFile(file, secret)` → boolean.
- `kioskApi.js` — `createKioskApi({ baseUrl, schoolCode, deviceCode, secret, clock, timeoutMs = 5000 })` → `{ pending, confirm, lookup, packs, receipts }` matching §3, signing every request; throws `KioskApiError(code, status)` (network failure: code `NETWORK`).
- `terminal.js` — `class Terminal` (base for all three machines):
  `constructor({ school: { code, cardKey }, device: { code, type, secret }, brokerUrl, clock, events, heartbeatMs = 15000, cablePlugged = true })`;
  `async start()`, `async stop()`, `async setCable(plugged)` (unplug = disconnect now, keep working offline; plug = reconnect, receive retained config, upload unsent records as `journal.batch`);
  `provision({ prices, settings, blocklist })` (versions + contents, as at installation);
  `get state()` → `{ school, code, type, cablePlugged, connected, seq, txnCounter, journal:{ total, unsent }, versions:{ prices, settings, blocklist }, blocklistSize, lastScreen, highestAdminToken }`;
  `nextTxn()`, `async publishUp(type, body, { txn })` → true if the broker acknowledged (QoS 1), false if offline;
  `async heartbeat()`; `async flushJournal()`; `exportJournal()` → USB file (all records);
  `tapAdminCard(adminCard)` → `{ results:[receipt] }`; `screen(text, tone = 'info')` → emits `device.screen`.
  Handles commands: verify signature with its secret; `config.prices`/`config.settings`/`blocklist.snapshot` apply if version > local (ack APPLIED) or equal (ALREADY_APPLIED), lower → REJECTED; `blocklist.delta` applies only if `fromVersion === local` (else ignored — the retained snapshot covers it); `control.*`.
  Sequence numbers and txn counters never go backwards (kept in memory for the life of the device object).
- `canteen.js` — `class CanteenReader extends Terminal`: `async tap(card, { items:[{ code, qty }] })` → `{ ok, screen, record? }`.
- `water.js` — `class WaterMachine extends Terminal`: `async tap(card, { ml })` → `{ ok, screen, record?, pouredMl }` (pours at most what the balance pays for).
- `kiosk.js` — `class TopupKiosk extends Terminal` (needs `api` from `createKioskApi` in its constructor options):
  `async tap(card, { fault } = {})` → `{ ok, screen, added:[{ orderId, amountSen }], readback:{ records, balanceSen } }` following §3 kiosk rules
  (`fault`: `'power-cut-before-commit'` | `'power-cut-after-commit'` | `'confirm-timeout'`);
  `async loadAdminCard(adminCard)`; `async uploadAdminCardReceipts(adminCard)`.

---

## 7. HTTP API (src/http/)

`createHttpServer({ lab })` → `{ listen(port, host) → Promise<{url,port}>, close() }`. JSON in and out, max body 1 MB.
Errors: `{ error: { code, message, detail? } }` with the LabError status (500 + code `INTERNAL` for bugs).
Sessions: in-memory, HTTP-only cookies `lab_staff` and `lab_parent`. **Lab only: there are no passwords; you
pick who you are.** The admin API takes the school from the staff session, never from the request.

Roles: OFFICE (members, cards, invites, links, devices, prices/settings, journal import), FINANCE (top-ups,
parked orders, subsidies, ledger, differences, reports), ADMIN (everything, plus school status). Others → 403 `FORBIDDEN`.

| Area | Endpoints |
|---|---|
| Staff session | `GET /api/admin/staff-options`, `POST /api/admin/login {staffId}`, `POST /api/admin/logout`, `GET /api/admin/me` |
| Overview | `GET /api/admin/overview` → `{ school, today:{ salesSen, purchases }, devices:{ total, online }, waitingSen, openDifferences, parkedOrders }` |
| Members & cards | `GET/POST /api/admin/members`, `GET /api/admin/members/:id` (with balances, orders, purchases), `GET/POST /api/admin/cards`, `POST /api/admin/cards/:uid/report-lost`, `POST /api/admin/cards/:uid/found`, `POST /api/admin/members/:id/replace-card {newUid}` |
| Parents | `GET/POST /api/admin/invites`, `GET /api/admin/links`, `POST /api/admin/links/:id/approve`, `POST /api/admin/links/:id/reject` |
| Devices | `GET/POST /api/admin/devices` (POST returns the secret once), `POST /api/admin/devices/:code/status {status}`, `GET /api/admin/devices/states`, `GET /api/admin/device-log` |
| Prices & settings | `GET /api/admin/configs`, `POST /api/admin/configs/prices`, `POST /api/admin/configs/settings`, `GET /api/admin/blocklist` |
| Top-ups | `GET /api/admin/topups`, `GET /api/admin/topups/parked`, `POST /api/admin/topups/:id/resolve {decision, note}`, `POST /api/admin/subsidies {memberId, amountSen, note}` |
| Books | `GET /api/admin/ledger/trial-balance`, `GET /api/admin/ledger/postings`, `GET /api/admin/purchases`, `GET /api/admin/reports/sales?day=` |
| Reconciliation | `GET /api/admin/differences?status=`, `POST /api/admin/differences/:id/resolve {note}`, `POST /api/admin/imports/journal` (USB file) |
| Other | `GET /api/admin/audit`, `POST /api/admin/school/status {status}` (ADMIN), `POST /api/admin/jobs/run` |
| Parent session | `GET /api/parent/options`, `POST /api/parent/login {parentId}`, `POST /api/parent/register {email, name}`, `POST /api/parent/logout`, `GET /api/parent/me` |
| Parent | `POST /api/parent/invites/redeem {code}`, `GET /api/parent/children` (+ pending links), `GET /api/parent/children/:schoolId/:memberId/balance` → `{ mirrorBalanceSen, waitingSen, asOf }`, `GET …/history` → `{ topups, purchases }`, `POST …/topups {amountSen}` (header `Idempotency-Key`) → `{ order, payUrl }`, `GET /api/parent/topups` |
| Mock payment provider | `GET /pay/:orderId` (bank page), `POST /api/pay/:orderId/complete {result}` → provider sends a signed callback to `POST /api/payments/callback` |
| Kiosk | §3 |
| Lab | `GET /api/lab/state`, `GET /api/lab/events` (server-sent events; `?since=`), `POST /api/lab/tap`, `POST /api/lab/cable`, `POST /api/lab/admin-card/load|tap|upload`, `POST /api/lab/usb/export`, `POST /api/lab/fault`, `POST /api/lab/clock/advance {ms}`, `POST /api/lab/reset` |

---

## 8. Lab (src/lab/) and entry point

`createLab({ httpPort = 8080, mqttPort = 1883, host = '127.0.0.1', clockMode = 'real', startAt, heartbeatMs = 15000, jobsMs = 5000, tls })`
→ `lab` with `async start()` → `{ httpUrl, mqttUrl }`, `async stop()`, `ctx`, `platform`, `broker`,
`terminals` (Map `'<school>/<DEVICE>'` → machine), `cards` (Map `'<school>/<UID>'` → VirtualCard), `adminCards` (Map school code → AdminCard),
and the actions used by `/api/lab/*`: `tap({ schoolCode, deviceCode, uid, items, ml, fault })`, `setCable({ schoolCode, deviceCode, plugged })`,
`adminCardLoad({ schoolCode })`, `adminCardTap({ schoolCode, deviceCode })`, `adminCardUpload({ schoolCode })`, `exportUsb({ schoolCode, deviceCode })`,
`fault({ type, … })`, `advanceClock(ms)`, `state()`, `async reset()`.

Faults: `clone-card {schoolCode, uid}` (creates a copy with uid suffix shown as "copy"), `tamper-card {schoolCode, uid, balanceSen}`,
`duplicate-upload {schoolCode, deviceCode}` (re-sends the last record), `sequence-rollback {schoolCode, deviceCode}`,
`forged-message {schoolCode, deviceCode}` (bad signature), `cross-device-publish {schoolCode, deviceCode}` (tries another device's topic; the broker refuses), and the kiosk faults passed to `tap`.

Seed (`src/lab/seed.js`): two fictional schools — `smk-contoh` ("SMK Seri Contoh") and `sjkc-contoh` ("SJK(C) Contoh") —
with staff (OFFICE, FINANCE, ADMIN), 6+ members with cards, three demo parents (one with children in both schools),
devices (`CANTEEN-01` online, `CANTEEN-02` offline, `WATER-01` offline, `KIOSK-01` online in the first school; `CANTEEN-01`,
`WATER-01`, `KIOSK-01` in the second), a price list and settings, every terminal provisioned at install, and starting
balances created through the real flows so every card balance equals its mirror balance. Some members also have
top-ups waiting at the kiosk.

`src/main.js` starts the lab from environment variables (`LAB_HTTP_PORT`, `LAB_MQTT_PORT`, `LAB_HOST`, `LAB_MQTT_TLS_KEY`/`_CERT`)
and prints the URLs and broker accounts.

---

## 9. Lab events

`mqtt.connect`, `mqtt.disconnect`, `mqtt.denied`, `mqtt.publish`, `intake.accepted`, `intake.duplicate`, `intake.refused`,
`purchase.received`, `ledger.posting`, `topup.status`, `topup.refunded`, `config.published`, `card.issued`, `card.lost`, `card.found`,
`card.write`, `device.screen`, `device.cable`, `admin-card.loaded`, `admin-card.applied`, `difference.opened`, `difference.resolved`,
`audit`, `lab.action`, `lab.clock`.

---

## 10. Web apps (web/)

Plain HTML, CSS and JavaScript modules, no build step, served by the lab server. English by default with Chinese
(中文) available. `web/shared/` holds the API helper, i18n helper and base styles; each app keeps its own strings.
- `web/lab/` — the lab console: topology of a school's machines and the cloud, card tray, tap with item/volume
  choice, cable switches, admin-card loading and tapping, faults, lab clock, live message inspector.
- `web/admin/` — school office: overview, members and cards, parents, devices, prices and settings, top-ups,
  books, reconciliation, audit.
- `web/parent/` — parent app, phone first: sign in or register with an invitation code, balance and waiting amount
  side by side (never added together), top up with the mock bank, history.
