# OneCard Lab — design and module contracts

OneCard Lab is a self-contained virtual lab for a school NFC card system: virtual chip
cards, canteen readers, water machines, a top-up kiosk and an admin card talk to a
cloud platform through a real MQTT broker and real HTTP, all in one Node.js process.
It is for trying the flows, testing failure cases and demonstrating the system before
any real hardware exists — the way Packet Tracer lets you build a network before
touching a switch.

Two things shape everything below:

- **It is SaaS: one system, many schools.** Each school is a tenant with its own data, staff, cards, machines,
  prices, keys and settings, all served by one platform. The platform operator (the company running the SaaS)
  onboards new schools, watches every tenant and can suspend one; school staff only ever see their own school.
- **Everything is virtual, including the server.** The cloud server (platform, database and MQTT broker — what
  would run on one cloud machine) is a node in the lab you can switch off or restart, just like the school
  machines and cards. Nothing needs real hardware or a real cloud account.

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
  device messages, card memory and files are ISO-8601 strings; in the database and in service DTOs (and so in the
  JSON the HTTP API returns) they are integer ms of the lab clock — the web apps format them.
- **Every query on school data filters by `school_id`.** A school id never comes from a request body or URL in the
  admin API — it comes from the signed-in staff session.
- Expected failures throw `LabError(code, message, status, detail?)` (`shared/errors.js`). Codes are listed per
  function below. Unexpected errors are bugs.
- Platform business logic is **synchronous** (SQLite via `node:sqlite` is synchronous). Wrap multi-step writes in
  `db.tx(() => ...)` (nesting is allowed; inner calls become savepoints). Only network edges (MQTT, HTTP) are async.
- Every module emits lab events through `ctx.events.emit(type, data, schoolCode)` so the lab console can show what
  happened. Event types are listed in §9. The bus is created with the database (`createEventBus({ clock, db })`):
  an event emitted inside a transaction is delivered only after the outermost commit and dropped on rollback, so
  services can emit wherever it reads best without ever announcing rows that were not written.
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
  events,    // src/shared/events.js: createEventBus({ clock, db }) — emit(type, data, schoolCode), subscribe(fn), since(seq)
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
| `src/platform/db.js` | `openDb(file)` and the whole schema (read it — it is the data model); `db.tx(fn)`, `db.afterCommit(fn)` |
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

### The virtual topology

```
 School site: smk-contoh            School site: sjkc-contoh         (more schools: onboarded by the operator)
  cards · CANTEEN-01/02 · WATER-01    cards · CANTEEN-01 · WATER-01
  KIOSK-01 · admin card               KIOSK-01 · admin card
        │ school network / 4G             │
        └──────────────┬──────────────────┘
                       │ internet
        ┌──────────────┴────────────────────────────┐
        │ Virtual cloud server (one per lab)        │
        │   MQTT broker · platform · database        │
        │   web: operator, school office, parent    │
        └───────────────────────────────────────────┘
```

The lab can switch the **cloud server off** (`server-down`): the broker stops and the platform's APIs answer
503 `SERVER_DOWN`, for every school at once. Readers and water machines keep selling offline; the kiosk adds
nothing; parents cannot pay; records wait in the machines' journals until the server is back (`server-up`),
then they upload and the platform republishes every retained setting. `broker-restart` restarts only the broker
(retained messages are lost, so the platform republishes them when it reconnects).

### Tenancy (SaaS)

| Layer | How schools are kept apart |
|---|---|
| Data | Every school-owned row has `school_id`; every query filters by it; the admin API takes the school from the staff session only |
| People | Staff belong to one school. Parents are platform-wide but see a child only through an APPROVED link that school issued. The operator account sees every school but cannot act as a school's staff |
| Cards | Each school has its own card key, so the same card UID gives a different card digest in each school, and a card from one school is refused by another school's machines |
| Machines | Device codes are unique per school; each machine logs in to the broker as `<school>.<DEVICE>` and the ACL limits it to its own topics; kiosk requests are signed with that machine's own secret |
| Settings | Prices, device settings, block lists and their version numbers, top-up limits and windows are all per school |
| Lifecycle | The operator onboards a school (staff, machines, default prices and settings) and can suspend it: a suspended school's machines are disconnected, its uploads refused and its staff and parents blocked, without touching other schools |

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
| Viewer | `ctx.settings.viewer.username` | `ctx.settings.viewer.password` | nothing | `lab/v1/#`, or `#` (the same traffic, since nothing is published elsewhere; MQTT Explorer's default); never `$SYS` |

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
  `ensureBlockList({ schoolId, actor })` → `{ version, changed }` — gives a school with no block list an empty one as
  version 1 (machines refuse every card until they hold *some* list, so every new school needs this; does nothing if a list exists);
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
  CREATED, CANCELLED or FAILED → PAID (`paidAt`, `addBy = paidAt + addWindowDays`) and post `TOPUP:<id>:PAID`: when the provider says the money was taken, it must land (or be refunded later by the jobs), even after a cancel or a decline. The mock bank itself never sends SUCCESS for a FAILED order (a decline is final there), so a parent cannot use declined orders to pass the daily or monthly limits. A repeat callback for a PAID/ADDED order with the same providerTxnId returns the order unchanged.
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

- `checkCardSnapshot({ schoolId, cardDigest, balanceSen, cardSeq, writes?, readAt? })` → `{ match, mirrorSen, cardSen, unconfirmedSen, laterSen }`; on mismatch open `BALANCE_MISMATCH` (ref `<digest>:<cardSeq>`, detail the amounts and a hint). Two kinds of kiosk top-up are in flight when a read-back is checked, and each is left out of one side:
  - `unconfirmedSen` (card side): `writes` is the read-back's list of kiosk top-ups on the card (at most 50 `{ orderId, amountSen }`). A write whose order this member still has as `PAID` or `PARKED`, for the same amount, reached the card but was never confirmed (a kiosk power cut after the write).
  - `laterSen` (books side): `readAt` is when the card was read (the read-back envelope's `at`, ms). Top-ups confirmed as written to this same card (`card_id`) at or after `readAt` and not among its `writes` were written after the read: the kiosk writes and confirms this tap's top-ups right after the read-back, and the confirm (HTTP) can reach the books before the read-back (MQTT; the broker acknowledges a message before delivering it). Orders a person marked ADDED have no card and are never left out.
  - The comparison is `balanceSen − unconfirmedSen === mirrorSen − laterSen`. A malformed list or time is `SNAPSHOT_INVALID`.
- `scanGaps(schoolId)` → number of new differences: for each origin device, missing numbers between the lowest and highest txn number received → `MISSING_RECORDS` (ref `<origin>:<from>-<to>`).
- `scanListLag(schoolId, { maxAgeMs = 24 h })` → number of new differences: devices whose applied block-list version is below the current version when the current version is older than `maxAgeMs` → `OLD_BLOCK_LIST` (ref `<deviceCode>:<currentVersion>`).
- `run(schoolId)` → `{ gaps, lag }`.

### 4.8 `intake.js` — `createIntake(ctx, { schools, devices, configs, settlement, reconcile })`

- `handle(topic, payload)` (payload: Buffer or string) → `{ result: 'ACCEPTED'|'DUPLICATE'|'REFUSED', code?, type?, detail? }`. Never throws. Implements §3 "Intake pipeline".
  Dispatch: `device.heartbeat` → `devices.recordHeartbeat` + `configs.recordListState(..., via 'HEARTBEAT')` for each reported kind;
  `sale.recorded`/`water.recorded` → `settlement.receive(via 'MQTT')`; `journal.batch` → each record `settlement.receive(via 'JOURNAL_BATCH')`;
  `card.readback` → each record `settlement.receive(via 'KIOSK_READBACK')`, then `reconcile.checkCardSnapshot` (passing `body.writes` and `readAt` = the envelope's `at` in ms);
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
  `async replaceCard({ schoolId, memberId, newUid, actor })` → `{ oldCard, reportedLost, newCard, transferOrder, published }` (old ACTIVE card reported lost first, `reportedLost: true`; with no ACTIVE card, `oldCard` is the newest earlier card and `reportedLost: false`; new card issued; transfer of the mirror balance);
  `async publishPrices({ schoolId, content, actor })`, `async publishSettings({ schoolId, content, actor })` → config (store + publish);
  `async setDeviceStatus({ schoolId, code, status, actor })` → device (kick it from the broker when not ACTIVE);
  `async setSchoolStatus({ schoolId, status, actor })` (operator only; kick all its devices when SUSPENDED; emits `school.status`);
  `async registerDevice({ schoolId, code, type, location, actor })` → `{ device, secret }` (emits `device.registered` with `{ code, type, location }`, then publishes the current retained settings to it);
  `issueCard({ schoolId, memberId, uid, actor })` → card (emits `card.issued`);
  `async createTenant({ code, name, staff = [], devices = [], demoMembers = 0, actor })` → `{ school, staff, devices: [{ device, secret }], members }` —
  onboards a school in one go: school, staff accounts, the default price list and settings, an empty block list (`ensureBlockList`), its machines (each emitting
  `device.registered`) and optionally `demoMembers` fictional members with new cards (random 7-byte UIDs starting `04`,
  each emitting `card.issued`). Emits `tenant.created` `{ code, name }`;
  `operatorOverview()` → one row per school: `{ id, code, name, status, members, cards, devices:{ total, online }, todaySalesSen, waitingSen, openDifferences, createdAt }`;
  `runJobs()` → topups.runJobs + reconcile.run for every ACTIVE school.
- After (re)connecting to the broker, the platform republishes every retained setting for every ACTIVE device of every ACTIVE school (a restarted broker has lost them).
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

Route modules live in `src/http/routes/{operator,admin,parent,pay,kiosk,lab}.js`. Each exports `routes(deps)` returning
`[{ method, path, auth, roles?, handler }]`, where `deps = { lab, platform: lab.platform, ctx: lab.ctx }`, `path` uses
`:param` segments (e.g. `'/api/admin/members/:id'`), `auth` is `'none' | 'operator' | 'staff' | 'parent' | 'kiosk'`, and
`handler(req)` receives `{ params, query, body, rawBody, headers, operator, staff, school, parent, kiosk }` (the session or
kiosk identity filled in by the server for the route's `auth`) and returns a JSON-able value (200), or
`{ status, body, headers }` for anything else (e.g. 201, redirects, HTML pages). `server.js` owns parsing, sessions,
kiosk signature checks, error mapping, static files under `web/` and the SSE stream; route files own the endpoints.
Errors: `{ error: { code, message, detail? } }` with the LabError status (500 + code `INTERNAL` for bugs).
Sessions: in-memory, HTTP-only cookies `lab_operator`, `lab_staff` and `lab_parent`. **Lab only: there are no
passwords; you pick who you are.** The admin API takes the school from the staff session, never from the request.

Every response carries the security headers (CSP `default-src 'self'`, nosniff, no-referrer, DENY framing, no-store).
A POST that a browser marks as coming from another page is refused 403 `CROSS_ORIGIN`. Requests whose Host is not
`localhost`, `*.localhost`, an IP address or a name in `LAB_ALLOWED_HOSTS` get 421 `HOST_NOT_ALLOWED` (against DNS
rebinding: the lab has no passwords).

While the lab's cloud server is switched off, every route except `/api/lab/*` and static files answers 503
`SERVER_DOWN`. Staff of a SUSPENDED school get 403 `SCHOOL_SUSPENDED` from the admin API; parents get the same for
that school's children (other schools' children keep working).

Roles: OFFICE (members, cards, invites, links, devices, prices/settings, journal import), FINANCE (top-ups,
parked orders, subsidies, ledger, differences, reports), ADMIN (everything in the school). Others → 403 `FORBIDDEN`.
Suspending or reactivating a school is an **operator** action, not a school action.

| Area | Endpoints |
|---|---|
| Operator session | `POST /api/operator/login` (the lab's one operator account), `POST /api/operator/logout`, `GET /api/operator/me` |
| Operator (SaaS owner) | `GET /api/operator/schools` (`platform.operatorOverview()`), `POST /api/operator/schools {code, name, staff, devices, demoMembers}` → `{ school, devices:[{ code, type, secret }] }` (secrets shown once), `POST /api/operator/schools/:code/status {status}`, `GET /api/operator/health` → `{ server, broker:{ clients, bySchool }, schools }` |
| Staff session | `GET /api/admin/staff-options`, `POST /api/admin/login {staffId}`, `POST /api/admin/logout`, `GET /api/admin/me` |
| Overview | `GET /api/admin/overview` → `{ school, today:{ salesSen, purchases }, devices:{ total, online }, waitingSen, openDifferences, parkedOrders }` |
| Members & cards | `GET/POST /api/admin/members`, `GET /api/admin/members/:id` (with balances, orders, purchases), `GET/POST /api/admin/cards`, `POST /api/admin/cards/:uid/report-lost`, `POST /api/admin/cards/:uid/found`, `POST /api/admin/members/:id/replace-card {newUid}` |
| Parents | `GET/POST /api/admin/invites`, `GET /api/admin/links`, `POST /api/admin/links/:id/approve`, `POST /api/admin/links/:id/reject` |
| Devices | `GET/POST /api/admin/devices` (POST returns the secret once), `POST /api/admin/devices/:code/status {status}`, `GET /api/admin/devices/states`, `GET /api/admin/device-log` |
| Prices & settings | `GET /api/admin/configs`, `POST /api/admin/configs/prices`, `POST /api/admin/configs/settings`, `GET /api/admin/blocklist` |
| Top-ups | `GET /api/admin/topups`, `GET /api/admin/topups/parked`, `POST /api/admin/topups/:id/resolve {decision, note}`, `POST /api/admin/subsidies {memberId, amountSen, note}` |
| Books | `GET /api/admin/ledger/trial-balance`, `GET /api/admin/ledger/postings`, `GET /api/admin/purchases`, `GET /api/admin/reports/sales?day=` |
| Reconciliation | `GET /api/admin/differences?status=`, `POST /api/admin/differences/:id/resolve {note}`, `POST /api/admin/imports/journal` (USB file) |
| Other | `GET /api/admin/audit`, `POST /api/admin/jobs/run` |
| Parent session | `GET /api/parent/options`, `POST /api/parent/login {parentId}`, `POST /api/parent/register {email, name}`, `POST /api/parent/logout`, `GET /api/parent/me` |
| Parent | `POST /api/parent/invites/redeem {code}`, `GET /api/parent/children` (+ pending links), `GET /api/parent/children/:schoolId/:memberId/balance` → `{ mirrorBalanceSen, waitingSen, asOf }`, `GET …/history` → `{ topups, purchases }`, `POST …/topups {amountSen}` (header `Idempotency-Key`) → `{ order, payUrl }`, `GET /api/parent/topups` |
| Mock payment provider | `GET /pay/:orderId` (bank page), `POST /api/pay/:orderId/complete {result}` → provider sends a signed callback to `POST /api/payments/callback` |
| Kiosk | §3 |
| Lab | `GET /api/lab/state`, `GET /api/lab/events` (server-sent events; `?since=`, `?school=`), `POST /api/lab/tap`, `POST /api/lab/cable`, `POST /api/lab/admin-card/load|tap|upload`, `POST /api/lab/usb/export`, `POST /api/lab/fault`, `POST /api/lab/clock/advance {ms}`, `POST /api/lab/jobs/run`, `POST /api/lab/server {up}`, `POST /api/lab/broker/restart`, `POST /api/lab/console {line, target}`, `POST /api/lab/reset` |

---

## 8. Lab (src/lab/) and entry point

`createLab({ httpPort = 8080, mqttPort = 1883, host = '127.0.0.1', clockMode = 'real', startAt, heartbeatMs = 15000, jobsMs = 5000, tls })`
→ `lab` with `async start()` → `{ httpUrl, mqttUrl, mqttTlsUrl? }` (`mqttTlsUrl` only when `tls` is given), `async stop()`, `ctx` (with `ctx.settings.viewer`), `platform`, `broker`,
`terminals` (Map `'<school>/<DEVICE>'` → machine), `cards` (Map `'<school>/<UID>'` → VirtualCard), `adminCards` (Map school code → AdminCard),
and the actions used by `/api/lab/*`: `tap({ schoolCode, deviceCode, uid, items, ml, fault })`, `setCable({ schoolCode, deviceCode, plugged })`,
`adminCardLoad({ schoolCode })`, `adminCardTap({ schoolCode, deviceCode })`, `adminCardUpload({ schoolCode })`, `exportUsb({ schoolCode, deviceCode })`,
`fault({ type, … })`, `advanceClock(ms)`, `setServer({ up })`, `restartBroker()`, `state()`, `async reset()`.

The lab follows the platform's events so new tenants come alive without a restart: on `device.registered` it builds
and starts the virtual machine (kiosks and canteen readers plugged in, water machines not; machines without a
network are provisioned with the current settings, recorded with `via 'PROVISION'`), on `card.issued` it makes the
physical virtual card (balance 0), and on `tenant.created` it gives the school an admin card. So onboarding a third
school in the operator console gives you its machines and cards in the lab console straight away.

`state()` → `{ clock, server: { up }, broker: { up, url, clients }, schools: [{ code, name, status, devices: [machine state + location + online], cards: [{ uid, member, balanceSen, cardSeq, platformStatus, copy? }], adminCard }] }`.

### Machine and server consoles (PuTTY-style)

Every virtual machine, and the virtual cloud server, has a text console, like logging in to a switch. Reach it
three ways: the **Console** tab in the lab console (web), **PuTTY** (connection type *Telnet* or *Raw*, host
`127.0.0.1`, port `2323`), or `telnet 127.0.0.1 2323` / `nc 127.0.0.1 2323` on Mac and Linux.

- `src/lab/console.js` — `createConsole(lab)` → `{ run(session, line) → { output, prompt } }`, plain text in and
  out (lines ≤ 100 characters). `session` is `{ target: null | 'server' | '<school>/<DEVICE>' }` and is updated by
  `connect`/`disconnect`. Unknown commands answer `% Unknown command. Type help.`, like a switch.
- `src/lab/telnet.js` — `startConsoleServer(lab, { host, port = 2323 })` → `{ port, close() }`: a line-based TCP
  server that ignores Telnet negotiation bytes (so PuTTY in Telnet mode works), prints a banner and prompts such as
  `onecard>`, `server#` and `smk-contoh/CANTEEN-01>`. `createLab` takes `consolePort` (default 2323, `0` turns it
  off; env `LAB_CONSOLE_PORT`) and `start()` also returns `consoleAddress` (`'127.0.0.1:2323'`).
- `POST /api/lab/console { line, target }` → `{ output, target, prompt }` for the web Console tab.

Commands (case-insensitive; `?` or `help` lists what works at the current prompt):

| Where | Commands |
|---|---|
| Anywhere | `help`, `machines` (every machine of every school, online or not), `connect server`, `connect <school>/<DEVICE>`, `disconnect`, `clock`, `exit` |
| `server#` | `show schools`, `show clients` (broker connections per school), `show status`, `server down`, `server up`, `broker restart`, `clock advance <n>m|h|d`, `jobs run` |
| Any machine | `show status`, `show config`, `show prices`, `show blocklist`, `show journal [n]` (sent/unsent), `show log [n]` (the platform's device log for it), `cable plug`, `cable unplug`, `heartbeat`, `upload`, `export usb`, `reboot` (counters survive) |
| Canteen reader | `tap <uid> <ITEM>[*qty] …` — e.g. `tap 04A13B5C7D2E80 NASI-LEMAK TEH-TARIK*2` |
| Water machine | `pour <uid> <ml>` |
| Kiosk | `tap <uid>`, `admin-card load`, `admin-card upload` |
| Reader or water machine | `admin-card tap` |

Faults: `clone-card {schoolCode, uid}` (creates a copy with uid suffix shown as "copy"), `tamper-card {schoolCode, uid, balanceSen}`,
`duplicate-upload {schoolCode, deviceCode}` (re-sends the last record), `sequence-rollback {schoolCode, deviceCode}`,
`forged-message {schoolCode, deviceCode}` (bad signature), `cross-device-publish {schoolCode, deviceCode}` (tries another device's topic; the broker refuses),
`cross-school-card {schoolCode, uid, toSchoolCode, deviceCode}` (taps one school's card on another school's machine; refused),
`server-down` / `server-up` (the whole cloud server), `broker-restart`, and the kiosk faults passed to `tap`.

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
`audit`, `lab.action`, `lab.clock`, `tenant.created`, `school.status`, `device.registered`, `server.status`, `broker.status`,
and for Simulation mode (§11): `device.step`, `device.send`, `device.acked`, `device.received`, `device.http`, `platform.send`,
`http.kiosk`, `sim.trace`, `sim.held`, `sim.released`, `sim.mode`. Events may carry top-level `trace` and `msgId` (§11.1).

---

## 10. Web apps (web/)

Plain HTML, CSS and JavaScript modules, no build step, served by the lab server. English by default with Chinese
(中文) available. `web/shared/` holds the API helper, i18n helper and base styles; each app keeps its own strings.
- `web/lab/` — the lab console: the whole virtual topology — the cloud server node (switch it off, restart the
  broker) and every school's site with its machines — plus the card tray, tap with item/volume choice, cable
  switches, admin-card loading and tapping, faults, lab clock and the live message inspector (filter by school),
  and the Simulation tab (§11.6): step-by-step replay of every flow with packet details, and live hold at each hop.
- `web/operator/` — the SaaS operator console: every tenant with its status and health, onboard a new school
  (staff, machines, demo members), suspend or reactivate a school, broker connections per school.
- `web/admin/` — school office: overview, members and cards, parents, devices, prices and settings, top-ups,
  books, reconciliation, audit.
- `web/parent/` — parent app, phone first: sign in or register with an invitation code, balance and waiting amount
  side by side (never added together), top up with the mock bank, history.

---

## 11. Simulation mode (Packet Tracer-like)

Packet Tracer's "simulation mode" for OneCard: follow one flow hop by hop — card → machine → broker → platform →
books — and break things between hops. Two parts:

- **Traces** (always on). Every lab action and every product request starts a *trace*. Every event it causes,
  across the MQTT and HTTP hops, carries the trace id, so the lab console can replay the flow step by step.
- **Live stepping** (opt-in). In simulation mode with *hold at each hop* on, a traced flow really waits at fixed
  hold points until the person presses Next. Meanwhile they can pull a cable or switch the server off and see what
  the system does about it.

With hold off (the default, and always in realtime mode) nothing behaves differently: traces only add fields to
events. Every existing test keeps passing unchanged.

### 11.1 Event context (`src/shared/events.js`)

The bus gets an `AsyncLocalStorage` context, one per bus:
- `bus.withContext(patch, fn)` → runs `fn` (sync or async) with context `{ ...current, ...patch }` and returns what
  `fn` returns. Fields: `trace` (string), `msgId` (string).
- `bus.context()` → the current context object, or `null`.
- `bus.untraced(fn)` → runs `fn` with an empty context. **Long-lived resources must be created untraced**: MQTT
  clients (machines, platform), the broker, servers, intervals. Otherwise every later callback of that resource
  would inherit the trace that happened to create it.
- `emit(type, data, school)` captures the context **at emit time** (before the after-commit deferral). The event
  object gains `trace` and/or `msgId` top-level fields only when the context has them:
  `{ seq, at, type, school, data, trace?, msgId? }`. Untraced events are exactly as before.
- `bus.setEnricher(fn | null)` → `fn(event)` runs in `deliver()` before the event is kept and fanned out; it may
  set `event.trace`. A throwing enricher is ignored.

### 11.2 Who emits what (new events and fields)

Machines (`src/devices/terminal.js` and subclasses), filed under the machine's school, `device` = machine code:
- `device.step` `{ device, step, ok, … }`:
  - `step: 'card.read'` `{ last4, balanceSen, cardSeq, records, listVersionOnCard }` (records: how many) when a
    card is read for a tap (reader, water, kiosk). A card that cannot be used: `ok: false, reason` (CARD_UNREADABLE,
    WRONG_SCHOOL, BLOCKED) — the screen still says only "Card unavailable".
  - `step: 'rules'` `{ amountSen, checks: [{ rule, ok, … }] }`: the tap rules in DESIGN order, stopping at the
    first one that fails, like the machine: `window` `{ open }`, `group` `{ group }`, `perPurchase`
    `{ limitSen }`, `dailyTotal` `{ usedSen, limitSen }`, `dailyCount` `{ count, limit }`, `tapGap`
    `{ waitMs }`, `balance` `{ balanceSen }`. (The block list is part of `card.read`.)
  - `step: 'journal'` `{ txn, unsent }`: the completed record is saved in the machine's journal.
  - `step: 'offline'` `{ type, txn? }`: a message was not sent because the machine has no broker link (a record
    waits in the journal).
- `device.send` `{ device, msgId, type, seq, txn?, topic, bytes, inReplyTo? }` just before the signed QoS 1
  publish. `inReplyTo` is the command's envelope id when the message is a `command.ack`.
- `device.acked` `{ device, msgId, type, ok, ms, reason? }` when the PUBACK comes (`ok: true`) or does not
  (`ok: false`, reason `'timeout'` or `'connection lost'`).
- `device.received` `{ device, msgId, type, kind?, version?, result }` for each command the machine takes from its
  commands topic: `result` APPLIED, ALREADY_APPLIED, REJECTED, or IGNORED (bad signature, another machine's).
- `device.http` `{ device, call, method, path, status, ok, code?, ms }` after each kiosk API call (`call`:
  pending, confirm, lookup, packs, receipts; `status` 0 when the network failed).

Broker (`src/broker/broker.js`): `mqtt.publish` gains `msgId` (the envelope id, or null) and `qos`.

Platform:
- `intake.js` runs everything after step 3 (envelope read) inside `withContext({ msgId: env.id })`, so every
  event of the services it calls (purchase, ledger, differences, top-ups, configs) carries the message id.
  `intake.accepted`, `intake.refused` and `intake.duplicate` gain `msgId` (when known) and
  `checks: [{ step, ok, code? }]` — the pipeline steps in order up to where the message ended: `topic`, `device`,
  `envelope`, `topicMatch`, `signature`, `duplicate`, `sequence`, `gates`, `typeRules`, `recorded`. An accepted
  `card.readback` also carries `snapshot` `{ checked, match?, cardSen?, mirrorSen?, unconfirmedSen?, laterSen?,
  code? }`.
- `platform.js` emits `platform.send` `{ msgId, topic, type, device, retained }` before publishing a command,
  inside the caller's context.
- `server.js` emits `http.kiosk` `{ device, method, path, status, code? }` for every kiosk API request.

### 11.3 Traces (`src/lab/trace.js`)

`createTracer(events, { clock, keepTraces = 200, keepEvents = 500 })` → tracer:
- `begin({ kind, title, school?, device? })` → trace id `'tr_…'`; emits `sim.trace`
  `{ id, n, kind, title, device? }` inside the new trace, so it is the trace's first event. `n` counts from 1.
- `run(meta, fn)` → `begin(meta)`, then `events.withContext({ trace: id }, fn)`; returns `{ trace: id, result }`
  where `result` is what `fn` returns (a promise if `fn` is async).
- `has(id)`, `list({ limit = 50 })` → newest first `[{ id, n, kind, title, school, device, at, events,
  lastAt }]` (events: how many), `get(id)` → `{ trace, events }`.
- It installs the bus enricher. An event without a trace whose `msgId` (top level or `data.msgId`) is known gets that
  message's trace. A `device.send` with `inReplyTo` gets the command's trace. Every traced event that carries
  `data.msgId` registers that id with its trace. The id map is bounded to the last 5000 ids.
- The tracer keeps the events of each trace (after enrichment), for replay.

The lab (`src/lab/lab.js`) runs every action inside `tracer.run(...)`, with a plain title such as
"Tap 04A13B5C7D2E80 on CANTEEN-01":
- tap, cable plug and pull
- admin card load, tap and upload
- USB export, heartbeat, upload, reboot
- clock advance, run jobs
- server up and down, broker restart
- every fault
- console commands that act

After a cable plug, the first post-connect routine (heartbeat and journal upload) belongs to the plug's trace: the
Terminal keeps the context it was plugged in for **at most 30 s**. After server up or broker restart, likewise for
every plugged machine, via `machine.traceNextConnect()`, which keeps `events.context()` for 30 s.
`server.js` runs:
- every non-GET request under `/api/admin`, `/api/operator`, `/api/parent` and `/api/pay`, and the mock bank's
  form posts, inside a new trace (kind `request`, title such as "School office: POST /api/admin/configs/prices").
  This applies only when the lab has a tracer.
- a kiosk request carrying `x-lab-trace` inside that trace, if `lab.tracer.has(id)`. The lab's kiosk API client
  sends this header from `events.context()`. The mock bank's server-to-server callback forwards it too.

### 11.4 Live stepping

Lab state: `sim = { mode: 'realtime'|'simulation', hold: boolean, held: [item…] }`. Defaults: realtime, hold off.

A held item is `{ id, trace, where, device, school, type?, msgId?, call?, at }`, with `where` one of `machine`,
`kiosk-http` or `platform`.

Hold points apply only to events inside a trace started by a person, and only when `mode === 'simulation' &&
hold`:
1. **Machine outbox.** The `Terminal` option `gate(info)` is called after the signed envelope is built and before
   it is published: `info = { kind: 'publish', device, school, type, msgId, seq, txn?, topic }`. If it returns a
   promise, the machine waits for it, then checks its link again. With no link it emits `device.step` offline and
   returns false; a record stays unsent in the journal. The seq is used up, which is harmless.
2. **Kiosk HTTP.** `TopupKiosk` calls the same gate before each API call: `info = { kind: 'http', call, method,
   path }`. After release the call runs. It fails as NETWORK when the server is off, or when the kiosk's cable is
   out: `createKioskApi({ …, online: () => boolean, headers: () => object })`.
3. **Platform inbox.** `platform.setInboxGate(fn | null)`: `fn({ topic, school, device, type, msgId })` may
   return a promise to hold the message, which is already acknowledged to the broker ("stored by the platform").
   Messages from one machine are processed in arrival order: a held message also holds back later messages from
   the same machine, and only those.

Rules:
- A gate that returns `undefined` changes nothing; realtime code paths stay synchronous.
- `sim.held` `{ id, where, device, type?, msgId?, call? }` is emitted inside the item's trace when it starts to
  wait, and `sim.released` `{ id }` when it is released. `sim.mode` `{ mode, hold }` is emitted when the mode
  changes.
- `simNext()` releases the oldest releasable item. A `platform` item is releasable only while the server is up.
  It returns `{ released: item|null, waiting: n }`.
- `simRelease()` releases all items in order. Turning hold off, switching to realtime, reset and stop release
  everything.
- An action that gets held answers early, as soon as its trace holds something: `{ held: true, trace, …partial }`
  (a tap includes the machine's screen). The rest arrives as events; the action's `lab.action` event is emitted
  when it completes.

As built (additions to the above):
- A held item also carries, when known, `txn`, `topic`, `method`, `path`. `sim.held` carries the whole item.
- Every action answer carries `trace`. An early answer also carries the held `item`.
- An action that fails after it answered early reports a `lab.action` with `ok: false, code, message` inside its trace.
- A machine message is held only while the lab is running. Command acks are never held at the machine, only at the
  platform.
- `setSim` refuses contradictory or empty requests (`hold: true` with realtime) with `INPUT_INVALID`.
- The lab's kiosk API client treats the kiosk as offline while its cable is out **or** the virtual cloud server is
  off. A switched-off server answers nothing, so the call fails as NETWORK, status 0, with no `http.kiosk`.
- A `publishUp` message that was held and then overtaken (for example by a heartbeat) goes out with the next seq,
  re-signed, with the same message id.
- `device.acked` is emitted untraced and joins its flow by `data.msgId`. Commands are handled inside
  `withContext({ msgId: <command id> })`.
- `createLab` gains option `reconnectMs` (the machines' first broker retry; tests use 200).
- `mqtt.denied` for a refused publish carries `msgId` (the envelope id, when the payload is one), so the
  refusal joins the sender's flow. The cross-device-publish fault announces its copied login's publish as
  `device.send` in the fault's trace.
- `POST /api/lab/console`: a line whose action was held at a hop also answers `held: true`, `trace` and
  `item` (the action's early answer), next to `output`, `target` and `prompt`.
- Hold off or realtime while the server is off: what waits at the platform goes on by itself once the
  server is back (with whatever reached the platform while it came up). Switching the server off or
  restarting the broker passes on every message the broker already acknowledged before it closes.

### 11.5 Lab API

Routes, all with auth `none`:
- `GET /api/lab/sim` → `{ mode, hold, held, traces }` (traces: `tracer.list()`).
- `GET /api/lab/sim/traces/:id` → `{ trace, events }`, or 404 `TRACE_NOT_FOUND`.
- `POST /api/lab/sim {mode?, hold?}` → the new sim state (400 `INPUT_INVALID`).
- `POST /api/lab/sim/next` → `{ released, waiting }`.
- `POST /api/lab/sim/release` → `{ released: n }`.

`state()` gains `sim: { mode, hold, held }`. The lab object exposes `tracer`, `simState()`, `setSim()`,
`simNext()` and `simRelease()`.

Console, at `onecard>` and `server#`:
- `simulation on|off`
- `hold on|off`
- `next`
- `show held`
- `show traces`
- `show trace <n>`: one line per step

### 11.6 The lab console (web/lab/)

- **Mode switch.** A *Realtime | Simulation* switch in the header, with a new **Simulation** tab next to
  Messages and Console.
- **Simulation tab:**
  - a trace picker (newest first: "#3 · Tap · CANTEEN-01 · 10:02"); the newest trace is followed automatically
  - playback: ⏮ first, ◀ back, ▶ play/⏸ pause (speed 0.5× / 1× / 2×), next ▶, ⏭ last
  - the *Hold at each hop (live)* switch, with the waiting items and a **Next hop** button
  - Packet Tracer's event list: # · time · last device · at device · type · what happened
- **Packet details.** Clicking a step opens the details, organised in layers:
  - *What happened* (one plain sentence)
  - *Card* (chip data)
  - *Machine checks* (rules ✓/✗)
  - *Message* (envelope fields)
  - *Security* (signature: HMAC-SHA256 with the machine's own secret, checked by the platform)
  - *MQTT* (topic, QoS 1, acknowledgement, the broker's access rule)
  - *Platform checks* (the pipeline steps ✓/✗)
  - *Books* (posting lines)
  - *Raw JSON*
- **Topology.** The current step's envelope travels on the topology from its *from* node to its *to* node (card,
  machine, school network, broker, platform, database, kiosk ↔ platform for HTTP). A refusal shows a red ✗ where
  the message was dropped. A held item parks its envelope at the hold point with a pause badge. With reduced
  motion: no travel, only highlights.
- **Text.** Event → step mapping (layer, from, to, verdict, text) lives in `web/lab/sim-steps.js`. Every string is
  in EN and 中文.

### 11.7 Follow-ups: broker logins, reason codes, flow subjects

- **Broker logins join their flow.** `startBroker(ctx, { …, contextFor })`: `contextFor(username, event)` with event
  `'connect'`, `'disconnect'` or `'denied'` returns `{ trace }` or `null`. The broker emits `mqtt.connect`,
  `mqtt.disconnect` and `mqtt.denied` inside `events.withContext(...)` of that answer. Without the hook it behaves
  as before.
- `Terminal#linkContext(kind)`:
  - `'connect'`: the context the machine keeps for its next connect (set by a cable plug or `traceNextConnect()`).
    It is not used up and stays until it expires.
  - `'disconnect'`: the context in which `setCable(false)` or `stop()` was called, kept 5 s.
  - Otherwise `null`.
- The lab's `contextFor`:
  - the platform account: the context of the server or broker action running at that moment;
  - a machine: `machine.linkContext(event)`, else, while the lab is closing or opening the broker, the server-off /
    server-on / broker-restart action's context;
  - anything else: `null`.
- `broker.status` gains `code`, a stable reason code next to the English `reason`, e.g. `SERVER_OFF`, `SERVER_ON`,
  `RESTARTING`, `RESTARTED`, `LAB_STOP`, `LAB_RESET`. The exact list is in lab.js and documented there.
- `sim.trace` data and the trace summaries (`tracer.list()`, `GET /api/lab/sim`) gain `subject`: a flat object
  (≤ 12 keys; values are short strings, numbers or booleans) naming what the flow is about, so the page never has
  to read it out of the English title:

  | kind | subject |
  |---|---|
  | tap | `{ uid, cardSchool, school, device, items?, ml?, fault? }` |
  | cable | `{ school, device, plugged }` |
  | admin-card | `{ school, device, op }` |
  | usb, heartbeat, upload, reboot | `{ school, device }` |
  | clock | `{ ms }` |
  | jobs | `{}` |
  | server | `{ up }` |
  | broker | `{}` |
  | fault | `{ fault, school?, device?, uid?, toSchool?, toDevice? }` |
  | request | `{ area, method, path, school? }` |
  | add-device | `{ school, type, code }` (§12) |
  | add-school | `{ code }` (§12) |

  `tracer.begin({ …, subject })` validates it (a TypeError for anything else).
- The cross-device-publish fault's `device.send` carries `copiedLogin: true`.

**As built:**
- **The broker hook.** An answer that is not a plain `{ trace }` is ignored, and a hook that throws is logged as a
  warning; neither changes the login. A `contextFor` that is not a function is a TypeError at start.
- **The lab's `contextFor` order:**
  1. the copied login of a running cross-device-publish fault (its throwaway client uses a real machine's
     username) → the fault's flow;
  2. the machine's own `linkContext(event)`;
  3. for the lab's own machines and the platform only: the server-off, server-on or broker-restart action that is
     opening or closing the broker right now;
  4. anyone else (the viewer, a made-up machine name) → `null`.

  Only a trace the tracer still knows is returned.
- **`linkContext('disconnect')`** also ends as soon as the machine is connected again. So pull, plug and then
  server off within 5 s puts the server-off logout in the server-off flow, not in the pull's.
- **`linkContext('connect')`** is no longer used up by the post-connect routine. It stays until `connectTraceMs`
  runs out, or until the connection it was kept for is lost (a failed attempt keeps it). So a machine thrown off
  and let back in soon after a plug has its new login in no old flow.
- **`linkContext('denied')`** is `null`, as the contract says. So a plugged machine that the broker refuses (its
  school is suspended) has its `mqtt.denied` in no flow; mapping it to the connect flow is a possible follow-up.
- **The copied login's flow** replays as: the real machine is knocked off → the copied login comes in → it sends
  (`copiedLogin: true`) → the broker refuses it (`mqtt.denied`: the topic is not allowed; the platform never gets
  the message) → the copied login leaves → the real machine is back.
- **`broker.status` codes** (`BROKER_STATUS_CODES` in lab.js; every event has one, `up: true` too):

  | code | reason |
  |---|---|
  | `LAB_START` | lab started |
  | `LAB_STOP` | lab stopped |
  | `LAB_RESET` | reset (both the down and the up of a reset) |
  | `SERVER_OFF` | server switched off |
  | `SERVER_ON` | server switched on |
  | `RESTARTING` | restart |
  | `RESTARTED` | restarted |

  The English reasons did not change.
- **Subject rules.**
  - Keys match `/^[A-Za-z][A-Za-z0-9_]{0,31}$/`.
  - `tracer.begin` stores a frozen copy; readers get copies.
  - `sim.trace`, `list()`, `get().trace`, `GET /api/lab/sim` and `/api/lab/sim/traces/:id` always carry it.
- **Tap subjects.** `items` is a short text such as `'ROTI-CANAI TEH-TARIK*2'`; a water tap carries `ml`.
- **Fault subjects:**
  - cross-school card and kiosk tap faults: the tap shape plus `fault`, where school and device are the machine's;
  - cross-device publish: `{ fault, school, device, toSchool, toDevice }`;
  - clone and tamper: `{ fault, school, uid }`;
  - server and broker faults: `{ fault }`.
- **Request subjects.** `area` is `admin`, `operator`, `parent` or `pay`. `path` has no query string and is cut to
  120 characters with "…". `school` is set when the office session names one.

---

## 12. Building by drag and drop (lab console)

Packet Tracer's way of building a network, for OneCard: drag a machine onto a school and draw its cable.

Lab API (auth `none`, inside a trace):
- `POST /api/lab/devices { schoolCode, type, code?, location?, cablePlugged? }` adds a machine.
  - It registers the machine on the platform (the facade's `registerDevice`, actor `lab`) and installs the virtual
    machine with its cable **unplugged** unless `cablePlugged: true`.
  - Trace kind `add-device`, title e.g. "Add a canteen reader CANTEEN-03 to smk-contoh".
  - `type` is CANTEEN, WATER or KIOSK. `code` defaults to the next free `<CANTEEN|WATER|KIOSK>-NN` of that school.
  - Answer `{ machine, trace }`, where `machine` is the same view as in `state()`. The machine's secret never leaves
    the lab.
  - Codes: `INPUT_INVALID` (400), `SCHOOL_NOT_FOUND` (404), `DEVICE_CODE_TAKEN` (409),
    `SCHOOL_SUSPENDED` (409).
- `POST /api/lab/schools { name, code, machines?, students? }` onboards a school.
  - `machines` is `[{ type, code?, location? }]`, default canteen reader, water machine and kiosk. `students` is
    0–50, default 5.
  - It uses the facade's `createTenant` (actor `lab`; three fictional staff, one per role). The machines are
    installed with their cables unplugged.
  - Trace kind `add-school`.
  - Answer `{ school: { code, name }, machines: [machine…], trace }`.
  - Codes: `INPUT_INVALID` (400), `SCHOOL_CODE_TAKEN` (409).
- `GET /api/lab/devices/next-code?schoolCode&type` → `{ code }`, the suggestion the add dialog fills in.

The page (`web/lab/`):
- **Device palette**, like Packet Tracer's device bar: canteen reader, water machine, top-up kiosk, school.
- **Dragging.** Pointer events (mouse, pen and touch; not HTML5 drag and drop, which does not work on touch). Drag a
  machine onto a school's site, or a school onto the internet line or the cloud. Drop zones highlight. Dropping opens
  a small dialog (code pre-filled, location; for a school: name, code, number of demo students, machines). **Add**
  calls the API.
- **Cables.** A new machine shows a dangling cable. Press its end and drag it to the school network line to plug it
  in (`POST /api/lab/cable { plugged: true }`); drag a plugged cable's end off the line to pull it. A rubber-band
  line follows the pointer, and the line highlights when the end is over it.
- **Without dragging.** Every drag has a button that does the same: "Add machine" on each site, "Add school" by the
  palette, and the existing Plug/Pull buttons. The keyboard reaches all of them; Escape cancels a drag.
- **In Simulation.** The new machine's registration, cable plug, broker login and first heartbeat are a flow the
  Simulation tab can replay.

**As built (API):**
- **Answers.** Both adds answer 200, like the other `/api/lab` actions.
- **Server off.** While the cloud server is switched off, both adds answer `SERVER_DOWN` (409), because
  registering needs the platform. `next-code` still answers.
- **Error codes.**
  - Add machine: `INPUT_INVALID` (400), `SCHOOL_NOT_FOUND` (404), `SERVER_DOWN` (409), `SCHOOL_SUSPENDED` (409),
    `DEVICE_CODE_TAKEN` (409).
  - Add school: `INPUT_INVALID` (400), `SCHOOL_CODE_INVALID` (400), `NAME_INVALID` (400), `SERVER_DOWN` (409),
    `SCHOOL_CODE_TAKEN` (409).
  - Both: `LAB_BUSY` (503) when a reset overtakes the add between registering and installing, and
    `LAB_NOT_RUNNING` while the lab stops.
  - The platform's other refusals pass through as they are.
- **Input.**
  - `type` and `code` are accepted in any case; add-school lower-cases its code.
  - The school code and name are checked before any trace starts, so a bad request leaves no flow behind.
  - `students` or `machines` sent as `null` means the default.
  - A machine code given twice in one add-school is `INPUT_INVALID`.
  - A location is at most 60 characters.
- **Next code.** `next-code` picks the lowest free number of that type, counting the platform's devices and the
  lab's machines: `CANTEEN-3` and `CANTEEN-003` both count as 3. Two digits, three past 99.
- **Plugged in.** With `cablePlugged: true`, the machine is installed with its cable out and then plugged in inside
  the same add-device flow. That one flow holds:
  - the registration;
  - the config publish;
  - `device.cable` and `mqtt.connect`;
  - the first heartbeat.

  With *Hold at each hop* on, the add answers early: `{ held: true, trace, item, machine }`.
- **Settings acks.** A new machine acknowledges the settings it got at registration. Those acks join its
  add-device flow, even when its cable is plugged in later in a flow of its own.
- **Cable at install.** A pending cable choice per machine makes the install leave the cable out. An operator's
  or school office's registration keeps today's cable (plugged in for readers and kiosks).
- **A new school's staff.** Three invented staff, one per office role (OFFICE, FINANCE, ADMIN). The audit trail
  shows the actor as `lab`.
- **`lab.action` events:**
  - `{ action: 'add-device', device, type, cablePlugged }`
  - `{ action: 'add-school', school, machines, students }`
- **Console.** The `onecard>` prompt has the same two actions:
  - `add machine <school> canteen|water|kiosk [CODE]` (cable out);
  - `add school <code> <name…>` (three machines, cables out, five students).

  `show trace` also prints broker logins and logouts, registrations, onboarding, card issue, the broker's reason
  and the copied login in plain lines.

**As built (page):**
- **Files.** `web/lab/build.js` holds the device bar, the palette drags and the two dialogs; `cables.js` the cable
  drawing; `drag.js` the pointer-drag helper and its overlay.
- **The device bar** ("Add to the lab") sticks under the header. It is a `role=toolbar` (arrow keys, Home, End);
  on a phone it is one row that scrolls sideways. Its items have `touch-action: pan-x`, so a sideways swipe scrolls
  the bar and any other move drags.
- **Drags.** Pointer capture starts only once the pointer has moved, so a short press stays a click. A click opens
  the dialog with the school chosen last time, which the person can change.
  - Near the top or bottom edge the page scrolls by itself.
  - A suspended school is dimmed, and a drop there is refused in plain words.
- **Dialogs** are `<dialog>` elements. The page fills in its own code guess, then the one from `next-code`. Input is
  checked on the page first, and every server code is shown in plain words next to its field.
- **The school network line** is drawn taller (34 px instead of 24) so an unplugged cable can visibly dangle below
  it.
- **Simulation steps.**
  - The copied login of the cross-device fault is not a machine on the map, so its steps start from the school's
    network.
  - A broker logout names the machine as the last device, but nothing travels: often nothing is sent at all (the
    cable is out, or the broker stopped). The envelope appears at the broker.
  - `device.registered`, `tenant.created` and `card.issued` have their own steps, with an "On the platform"
    section in the details.

---

## 13. Desktop app (double-click to start)

- **Launchers** in the repository root:
  - `Start OneCard Lab.command` (macOS; Finder opens it in Terminal)
  - `Start OneCard Lab.bat` (Windows)
  - `start-onecard-lab.sh` (Linux)

  Each one goes to its own folder and checks Node.js ≥ 22.13. If Node is missing it says so plainly and opens the
  nodejs.org download page. It runs `npm install` the first time (no `node_modules` yet), then starts the lab with
  `--open`. Closing the window, or Ctrl+C, stops the lab.
- **`--open`.** `npm start -- --open` opens the lab console in the default browser once the lab is up (`open`,
  `cmd /c start ""`, `xdg-open`). A missing browser never fails the start.
- **Single-file app** (no Node.js needed):
  - **Build.** `npm run build:app` (`scripts/build-sea.mjs`) bundles the lab into one CommonJS file with esbuild (a
    dev dependency), with the web apps as Node single-executable-application assets. It then injects that into a
    copy of the running Node binary (postject, a dev dependency; on macOS, ad-hoc `codesign`). Output:
    `dist/onecard-lab-<os>-<arch>[.exe]`.
  - **Start.** At start it unpacks the web apps once per version into the OS temp folder, passes `webRoot` (createLab
    passes its own `labRoutes`), then runs like `npm start -- --open`.
  - **Self-test.** `--self-test` starts the lab on free ports, fetches `/lab/` and `/api/lab/state`, stops, and
    exits 0 or 1.
- **GitHub Actions** (`.github/workflows/desktop.yml`):
  - Triggers: pull requests (paths `src/**`, `web/**`, `scripts/**`, `package*.json`, the workflow itself), manual
    dispatch, and tags `v*`.
  - Matrix: ubuntu-latest, windows-latest, macos-latest (arm64), macos-15-intel (x64; GitHub retired macos-13).
  - Steps: `npm ci`, `npm test` (ubuntu only), `npm run build:app`, `--self-test`, upload the file
    (`actions/upload-artifact@v6`; the release job downloads with `actions/download-artifact@v7`).
  - A tag, or a dispatch with `release: true`, publishes a GitHub Release with the zipped apps.
- **Unsigned.** The downloads are not code-signed:
  - macOS 14 and earlier: open the first time with right-click → Open; macOS 15 and later: see "As built" below
  - Windows SmartScreen: More info → Run anyway

**As built:**
- **Start code.** `src/main.js` only checks the Node.js version, without top-level await, so old Node versions
  print the plain message. It then imports `src/cli.js`, which holds `run(argv, env, how)`. The single-file app's
  entry (`src/app/sea-main.js`) calls the same `run()`.
- **Options:** `--open`, `--no-open`, `--lan`, `--self-test` and `--help` (`-h`). An unknown option exits 2.
  Without `--open`, the banners of `npm start` and `npm run start:lan` are unchanged.
- **A busy port (EADDRINUSE; on Windows also EACCES for ports from 1024 up, which Hyper-V, WSL or Docker may
  reserve, or another program may hold exclusively):**
  - **A lab is already running.** The lab first asks `GET /api/lab/state` on its own web port. If a OneCard Lab
    answers, it says "OneCard Lab is already running". With `--open` it opens that lab and exits 0; without, it
    exits 1.
  - **With `--open` (a double-click):** a busy web, MQTT or console port moves to a free port, with a note in the
    banner.
  - **Without `--open`:** one plain line naming the setting to change (`LAB_HTTP_PORT`, `LAB_MQTT_PORT` — "often
    another MQTT broker, such as Mosquitto" — `LAB_CONSOLE_PORT` or `LAB_MQTT_TLS_PORT`).
  - **Other start failures.** Two settings with the same port, a port below 1024 that needs administrator rights, an
    address that is not this computer's, and unreadable TLS files each give one plain line too.
- **Self-test.** It runs on free ports with the consoles off. It checks `/lab/` (200, HTML) and `/api/lab/state`
  (200, at least one school), always exits, and gives up after 60 s.
- **Launchers.** The three shell files are thin; `scripts/launch.cjs` does the work.
  - It is written in Node 6 syntax, so an old Node prints its "too old" message in English and 中文.
  - Finding Node: when `node` is not on PATH, or the one on PATH is older than 22.13, the macOS and Linux launchers
    look in nvm, Volta, fnm, asdf, `/opt/homebrew/bin`, `/usr/local/bin` and `/opt/local/bin`, and take the first
    Node that is new enough (else the one on PATH, and the "too old" message). The Windows launcher also looks in
    `%ProgramFiles%\nodejs` and `NVM_SYMLINK`.
  - Installing: it runs `npm install --omit=dev --no-audit --no-fund` when `node_modules` or a dependency is
    missing, or when `package-lock.json` is newer than `node_modules/.package-lock.json`. npm runs from the
    `npm-cli.js` next to that Node, without a shell, so folder names with spaces or Chinese characters work.
  - On failure the window stays open ("Press Enter to close"). Ctrl+C or closing the window stops the lab, and a
    stop sent to the launcher alone is passed on to the lab. Ctrl+C on Windows while the lab is still starting counts
    as a stop, not a failure.
  - The `.bat` goes to its folder with `pushd "%~dp0"` (it works in a network folder, `\\server\share`) and
    `popd` on every exit.
  - Line endings and modes: `.gitattributes` keeps the `.bat` CRLF and the `.command` / `.sh` LF; both of those
    are stored as executable (100755).
- **Single-file app.**
  - The bundle leaves out three optional native helpers that the libraries only try to load
    (`bufferutil`, `utf-8-validate`, `supports-color`).
  - The build fails on any esbuild warning except the known lazy `import.meta` in `src/http/server.js`. It ends by
    running the new app's `--self-test` and fails on any ExperimentalWarning.
  - The assets are every file under `web/` plus a manifest (keys, sizes, a content hash). They are unpacked into a
    private temporary folder and then renamed to `<temp>/onecard-lab-<version>-<hash>/web/`. A complete folder is
    reused, and a damaged one is replaced. A folder other users can write to, or a leftover `.part-` folder, is
    never used.
- **Downloads.**
  - Files downloaded from an Actions run lose their executable bit, so macOS and Linux need `chmod +x` once.
  - The Release ZIPs keep the bit.
  - A dispatch with `release: true` tags `desktop-<run number>`.
  - Pull requests also run the workflow for changes under `test/**` and to the launchers.
- **Unsigned apps on macOS 15 (Sequoia) and later.** Right-click → Open is gone. Open the file once, then System
  Settings → Privacy & Security → **Open Anyway**, or in Terminal `xattr -d com.apple.quarantine <file>`.
