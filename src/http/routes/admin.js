import { LabError } from '../../shared/errors.js';
import { DIFFERENCE_KINDS } from '../../platform/differences.js';
import { verifyJournalFile } from '../../devices/usb.js';

// The school office API (docs/DESIGN.md §7, admin rows). Every handler works inside the school
// of the signed-in staff member (`req.school`, from the session): a school id is never read from
// the request, and an id of another school's member, card, device, order, link or difference is
// simply not found, exactly as if it did not exist, because every service lookup is scoped to
// the school it is given.
//
// Roles (DESIGN §7): OFFICE runs members, cards, parents, machines, prices and settings and the
// journal import; FINANCE runs top-ups, subsidies, the books, differences and reports; ADMIN does
// everything in the school. Reading the member list and a member's page is open to every role,
// because finance staff pick the member when they grant a subsidy.

const OFFICE = Object.freeze(['OFFICE', 'ADMIN']);
const FINANCE = Object.freeze(['FINANCE', 'ADMIN']);
const ANY_ROLE = Object.freeze(['OFFICE', 'FINANCE', 'ADMIN']);
const ADMIN = Object.freeze(['ADMIN']);

const DIFFERENCE_STATUSES = Object.freeze(['OPEN', 'RESOLVED']);
const RECEIVE_STATUSES = Object.freeze(['POSTED', 'FLAGGED', 'DUPLICATE', 'REFUSED']);
const MAX_REFUSED_SHOWN = 50;
const MAX_NOTE = 500;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const given = (v) => v !== undefined && v !== null && v !== '';
/** A JSON null means "not given", like a missing field. */
const optional = (v) => (v === null ? undefined : v);
/** A count from the query string: a positive whole number up to `most`, otherwise `fallback`. */
const count = (v, fallback, most) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, most) : fallback;
};

/** How a staff member appears in audit trails and on decisions: "Name (stf_…)". */
export function actorOf(staff) {
  return `${staff.name} (${staff.id})`;
}

/** Every member's mirror wallet and waiting money, from one trial balance instead of two queries per member. */
function balancesByMember(ledger, schoolId) {
  const out = new Map();
  for (const a of ledger.trialBalance(schoolId).accounts) {
    if (!a.memberId) continue;
    const b = out.get(a.memberId) ?? { mirrorBalanceSen: 0, waitingSen: 0 };
    if (a.kind === 'STUDENT_WALLET') b.mirrorBalanceSen = a.balanceSen;
    else if (a.kind === 'WAITING_TO_BE_ADDED') b.waitingSen = a.balanceSen;
    out.set(a.memberId, b);
  }
  return out;
}

/** Money waiting at the kiosk for the whole school. */
function waitingSenOf(ledger, schoolId) {
  return ledger
    .trialBalance(schoolId)
    .accounts.filter((a) => a.kind === 'WAITING_TO_BE_ADDED')
    .reduce((sum, a) => sum + a.balanceSen, 0);
}

/** A card as the office sees it: everything but the card digest, which only machines need. */
const officeCard = ({ digest: _digest, ...card }) => card;

/** A difference with the plain explanation of its kind (EN and 中文) for the office. */
const explained = (d) => ({ ...d, explanation: Object.hasOwn(DIFFERENCE_KINDS, d.kind) ? { ...DIFFERENCE_KINDS[d.kind] } : null });

/** A price list or settings body: `{ content, effectiveFrom? }`, or the content itself (with an optional effectiveFrom). */
function configBody(body) {
  if (isPlainObject(body.content)) return { content: body.content, effectiveFrom: optional(body.effectiveFrom) };
  const { effectiveFrom, ...content } = body;
  return { content, effectiveFrom: optional(effectiveFrom) };
}

function noteOf(note) {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string') throw new LabError('NOTE_INVALID', 'note must be text');
  return note.trim().slice(0, MAX_NOTE);
}

/**
 * @param {{ platform: object, ctx: object, sessions: object }} deps  see src/http/server.js
 * @returns {Array<{ method: string, path: string, auth: string, roles?: string[], handler: Function }>}
 */
export function routes(deps) {
  const services = () => deps.platform.services;
  const staffRoute = (method, path, roles, handler) => ({ method, path, auth: 'staff', roles, handler });

  return [
    // ---- session (lab only: pick who you are) --------------------------------------------
    {
      method: 'GET',
      path: '/api/admin/staff-options',
      auth: 'none',
      handler: () => {
        const { schools } = services();
        const bySchool = new Map(schools.listSchools().map((s) => [s.id, s]));
        return schools.listStaff().map((p) => {
          const s = bySchool.get(p.schoolId);
          return { id: p.id, name: p.name, role: p.role, schoolId: p.schoolId, schoolCode: s?.code ?? null, schoolName: s?.name ?? null, schoolStatus: s?.status ?? null };
        });
      },
    },
    {
      method: 'POST',
      path: '/api/admin/login',
      auth: 'none',
      handler: (req) => {
        const { schools } = services();
        const staff = typeof req.body.staffId === 'string' ? schools.getStaff(req.body.staffId) : null;
        if (!staff) throw new LabError('STAFF_NOT_FOUND', 'no such staff member', 404);
        const school = schools.getSchool(staff.schoolId);
        if (school.status !== 'ACTIVE') throw new LabError('SCHOOL_SUSPENDED', 'this school is suspended on the platform', 403);
        return { status: 200, body: { staff, school }, headers: deps.sessions.signIn('staff', staff.id, req) };
      },
    },
    {
      method: 'POST',
      path: '/api/admin/logout',
      auth: 'none',
      handler: (req) => ({ status: 200, body: { signedOut: true }, headers: deps.sessions.signOut('staff', req) }),
    },
    staffRoute('GET', '/api/admin/me', ANY_ROLE, (req) => ({ staff: req.staff, school: req.school })),

    // ---- overview --------------------------------------------------------------------------
    staffRoute('GET', '/api/admin/overview', ANY_ROLE, (req) => {
      const { settlement, devices, differences, topups, ledger } = services();
      const sid = req.school.id;
      const sales = settlement.salesReport(sid);
      const machines = devices.listDevices(sid);
      return {
        school: req.school,
        today: { day: sales.day, salesSen: sales.totalSen, purchases: sales.count },
        devices: { total: machines.length, online: machines.filter((d) => d.online).length },
        waitingSen: waitingSenOf(ledger, sid),
        openDifferences: differences.countOpen(sid),
        parkedOrders: topups.listOrders({ schoolId: sid, status: 'PARKED', limit: 1000 }).length,
      };
    }),

    // ---- members and cards -------------------------------------------------------------------
    staffRoute('GET', '/api/admin/members', ANY_ROLE, (req) => {
      const { schools, ledger } = services();
      const balances = balancesByMember(ledger, req.school.id);
      return schools.listMembers(req.school.id).map((m) => ({ ...m, ...(balances.get(m.id) ?? { mirrorBalanceSen: 0, waitingSen: 0 }) }));
    }),
    staffRoute('POST', '/api/admin/members', OFFICE, (req) => {
      const { schools } = services();
      const sid = req.school.id;
      const actor = actorOf(req.staff);
      const { memberNo, name, className, group, cardUid } = req.body;
      // One transaction: a card UID that is refused leaves no member behind.
      const out = deps.ctx.db.tx(() => {
        const member = schools.addMember({ schoolId: sid, memberNo, name, className: optional(className), group: optional(group) });
        schools.audit(sid, actor, 'member.add', { memberId: member.id, memberNo: member.memberNo });
        const card = given(cardUid) ? deps.platform.issueCard({ schoolId: sid, memberId: member.id, uid: cardUid, actor }) : null;
        return { member: schools.getMember(sid, member.id), card };
      });
      return { status: 201, body: out };
    }),
    staffRoute('GET', '/api/admin/members/:id', ANY_ROLE, (req) => {
      const { schools, topups, settlement } = services();
      const sid = req.school.id;
      const member = schools.getMember(sid, req.params.id);
      if (!member) throw new LabError('MEMBER_NOT_FOUND', 'no such member in this school', 404);
      const summary = topups.memberSummary(sid, member.id);
      return {
        member,
        balances: { mirrorBalanceSen: summary.mirrorBalanceSen, waitingSen: summary.waitingSen },
        waitingOrders: summary.waitingOrders,
        orders: topups.listOrders({ schoolId: sid, memberId: member.id, limit: 100 }),
        purchases: settlement.listPurchases(sid, { memberId: member.id, limit: 100 }),
        cards: schools.listCards(sid).filter((c) => c.memberId === member.id).map(officeCard),
        links: schools.listLinks(sid).filter((l) => l.memberId === member.id),
      };
    }),
    staffRoute('POST', '/api/admin/members/:id/replace-card', OFFICE, async (req) => {
      const out = await deps.platform.replaceCard({ schoolId: req.school.id, memberId: req.params.id, newUid: req.body.newUid, actor: actorOf(req.staff) });
      return { ...out, oldCard: out.oldCard && officeCard(out.oldCard), newCard: officeCard(out.newCard) };
    }),
    staffRoute('GET', '/api/admin/cards', OFFICE, (req) => {
      const { schools } = services();
      const members = new Map(schools.listMembers(req.school.id).map((m) => [m.id, m]));
      return schools.listCards(req.school.id).map((c) => {
        const m = members.get(c.memberId);
        return { ...officeCard(c), memberName: m?.name ?? null, memberNo: m?.memberNo ?? null };
      });
    }),
    staffRoute('POST', '/api/admin/cards', OFFICE, (req) => {
      const card = deps.platform.issueCard({ schoolId: req.school.id, memberId: req.body.memberId, uid: req.body.uid, actor: actorOf(req.staff) });
      return { status: 201, body: officeCard(card) };
    }),
    staffRoute('POST', '/api/admin/cards/:uid/report-lost', OFFICE, async (req) =>
      officeCard(await deps.platform.reportCardLost({ schoolId: req.school.id, uid: req.params.uid, actor: actorOf(req.staff) })),
    ),
    staffRoute('POST', '/api/admin/cards/:uid/found', OFFICE, async (req) =>
      officeCard(await deps.platform.markCardFound({ schoolId: req.school.id, uid: req.params.uid, actor: actorOf(req.staff) })),
    ),

    // ---- parents ---------------------------------------------------------------------------
    staffRoute('GET', '/api/admin/invites', OFFICE, (req) => services().schools.listInvites(req.school.id)),
    staffRoute('POST', '/api/admin/invites', OFFICE, (req) => {
      const invite = services().schools.createInvite({ schoolId: req.school.id, memberId: req.body.memberId, actor: actorOf(req.staff) });
      return { status: 201, body: invite };
    }),
    staffRoute('GET', '/api/admin/links', OFFICE, (req) =>
      services().schools.listLinks(req.school.id, { status: given(req.query.status) ? String(req.query.status).toUpperCase() : undefined }),
    ),
    staffRoute('POST', '/api/admin/links/:id/approve', OFFICE, (req) =>
      services().schools.decideLink({ schoolId: req.school.id, linkId: req.params.id, approve: true, actor: actorOf(req.staff) }),
    ),
    staffRoute('POST', '/api/admin/links/:id/reject', OFFICE, (req) =>
      services().schools.decideLink({ schoolId: req.school.id, linkId: req.params.id, approve: false, actor: actorOf(req.staff) }),
    ),

    // ---- machines --------------------------------------------------------------------------
    staffRoute('GET', '/api/admin/devices', OFFICE, (req) => services().devices.listDevices(req.school.id)),
    staffRoute('POST', '/api/admin/devices', OFFICE, async (req) => {
      const { code, type, location } = req.body;
      // The secret is in this answer once and never again (devices never return it).
      const out = await deps.platform.registerDevice({ schoolId: req.school.id, code, type, location: optional(location), actor: actorOf(req.staff) });
      return { status: 201, body: out };
    }),
    staffRoute('POST', '/api/admin/devices/:code/status', OFFICE, (req) =>
      deps.platform.setDeviceStatus({ schoolId: req.school.id, code: req.params.code, status: req.body.status, actor: actorOf(req.staff) }),
    ),
    staffRoute('GET', '/api/admin/devices/states', OFFICE, (req) => services().configs.listStates(req.school.id)),
    staffRoute('GET', '/api/admin/device-log', OFFICE, (req) => {
      const { devices } = services();
      const sid = req.school.id;
      const { device, deviceId, limit } = req.query;
      let machine = null;
      if (given(device)) machine = devices.getDeviceByCode(sid, device);
      else if (given(deviceId)) machine = devices.getDevice(sid, deviceId);
      if ((given(device) || given(deviceId)) && !machine) throw new LabError('DEVICE_NOT_FOUND', 'no such device in this school', 404);
      return devices.listLog(sid, { deviceId: machine?.id, limit: count(limit, 100, 1000) });
    }),

    // ---- prices, settings and the block list -------------------------------------------------
    staffRoute('GET', '/api/admin/configs', OFFICE, (req) => {
      const { configs } = services();
      const sid = req.school.id;
      const versions = (kind) => configs.history(sid, kind, 10).map(({ version, effectiveFrom, createdAt }) => ({ version, effectiveFrom, createdAt }));
      return {
        prices: configs.current(sid, 'prices'),
        settings: configs.current(sid, 'settings'),
        blocklist: { version: configs.currentBlockList(sid).version },
        history: { prices: versions('prices'), settings: versions('settings'), blocklist: versions('blocklist') },
      };
    }),
    staffRoute('POST', '/api/admin/configs/prices', OFFICE, async (req) => {
      const { content, effectiveFrom } = configBody(req.body);
      const out = await deps.platform.publishPrices({ schoolId: req.school.id, content, effectiveFrom, actor: actorOf(req.staff) });
      return { status: 201, body: out };
    }),
    staffRoute('POST', '/api/admin/configs/settings', OFFICE, async (req) => {
      const { content, effectiveFrom } = configBody(req.body);
      const out = await deps.platform.publishSettings({ schoolId: req.school.id, content, effectiveFrom, actor: actorOf(req.staff) });
      return { status: 201, body: out };
    }),
    staffRoute('GET', '/api/admin/blocklist', OFFICE, (req) => {
      const { configs, schools } = services();
      const sid = req.school.id;
      const list = configs.currentBlockList(sid);
      const current = configs.current(sid, 'blocklist');
      // last4 and the cardholder only: the office never needs the card digest itself
      const entries = list.entries.map((e) => {
        const card = schools.getCardByDigest(sid, e.card);
        const member = card?.memberId ? schools.getMember(sid, card.memberId) : null;
        return { last4: e.last4, cardStatus: card?.status ?? null, memberId: member?.id ?? null, memberName: member?.name ?? null };
      });
      return { version: list.version, createdAt: current?.createdAt ?? null, entries };
    }),

    // ---- top-ups and subsidies -------------------------------------------------------------
    staffRoute('GET', '/api/admin/topups', FINANCE, (req) => {
      const { status, kind, memberId, limit } = req.query;
      return services().topups.listOrders({ schoolId: req.school.id, status, kind, memberId, limit: count(limit, 100, 1000) });
    }),
    staffRoute('GET', '/api/admin/topups/parked', FINANCE, (req) =>
      services().topups.listOrders({ schoolId: req.school.id, status: 'PARKED', limit: 1000 }),
    ),
    staffRoute('POST', '/api/admin/topups/:id/resolve', FINANCE, (req) =>
      services().topups.resolveParked({
        schoolId: req.school.id,
        orderId: req.params.id,
        decision: req.body.decision,
        actor: actorOf(req.staff),
        note: noteOf(req.body.note),
      }),
    ),
    staffRoute('POST', '/api/admin/subsidies', FINANCE, (req) => {
      const { memberId, amountSen, note } = req.body;
      const order = services().topups.grantSubsidy({ schoolId: req.school.id, memberId, amountSen, actor: actorOf(req.staff), note: noteOf(note) });
      return { status: 201, body: order };
    }),

    // ---- books -------------------------------------------------------------------------------
    staffRoute('GET', '/api/admin/ledger/trial-balance', FINANCE, (req) => services().ledger.trialBalance(req.school.id)),
    staffRoute('GET', '/api/admin/ledger/postings', FINANCE, (req) =>
      services().ledger.postings(req.school.id, { limit: count(req.query.limit, 50, 1000), memberId: req.query.memberId }),
    ),
    staffRoute('GET', '/api/admin/purchases', FINANCE, (req) =>
      services().settlement.listPurchases(req.school.id, {
        limit: count(req.query.limit, 100, 1000),
        memberId: req.query.memberId,
        deviceCode: req.query.device ?? req.query.deviceCode,
      }),
    ),
    staffRoute('GET', '/api/admin/reports/sales', FINANCE, (req) => services().settlement.salesReport(req.school.id, { day: req.query.day })),

    // ---- reconciliation ----------------------------------------------------------------------
    staffRoute('GET', '/api/admin/differences', FINANCE, (req) => {
      const { status, kind, limit } = req.query;
      const wanted = given(status) ? String(status).toUpperCase() : undefined;
      if (wanted !== undefined && !DIFFERENCE_STATUSES.includes(wanted)) {
        throw new LabError('FILTER_INVALID', `status must be ${DIFFERENCE_STATUSES.join(' or ')}`);
      }
      return services()
        .differences.list(req.school.id, { status: wanted, kind: given(kind) ? String(kind) : undefined, limit: count(limit, 200, 1000) })
        .map(explained);
    }),
    staffRoute('POST', '/api/admin/differences/:id/resolve', FINANCE, (req) => {
      const { differences, schools } = services();
      const sid = req.school.id;
      const actor = actorOf(req.staff);
      const note = noteOf(req.body.note);
      return deps.ctx.db.tx(() => {
        const resolved = differences.resolve({ schoolId: sid, id: req.params.id, actor, note });
        schools.audit(sid, actor, 'difference.resolve', { differenceId: resolved.id, kind: resolved.kind, ref: resolved.ref, note });
        return explained(resolved);
      });
    }),
    // A machine's journal brought on a USB stick (DESIGN §6 usb.js): the file must be of this
    // school, its machine is looked up in this school only, and the file must carry that
    // machine's signature. Then each record is settled like any other upload.
    staffRoute('POST', '/api/admin/imports/journal', OFFICE, (req) => {
      const { devices, settlement, schools } = services();
      const school = req.school;
      const file = isPlainObject(req.body.file) ? req.body.file : req.body;
      if (typeof file.school !== 'string' || typeof file.device !== 'string' || !Array.isArray(file.records)) {
        throw new LabError('JOURNAL_INVALID', 'this is not a machine journal export (it needs school, device and records)');
      }
      if (file.school !== school.code) throw new LabError('JOURNAL_WRONG_SCHOOL', 'this file was exported by a machine of another school');
      const found = devices.resolveByCodes(school.code, file.device);
      if (!found) throw new LabError('DEVICE_NOT_FOUND', 'no machine with this code in your school', 404);
      if (!verifyJournalFile(file, found.secret)) {
        throw new LabError('JOURNAL_SIGNATURE_INVALID', 'the file does not match its signature: it was changed after the export, or another machine made it');
      }
      const counts = Object.fromEntries(RECEIVE_STATUSES.map((s) => [s, 0]));
      const differencesFound = {};
      const refused = [];
      let conflicts = 0;
      for (const [index, record] of file.records.entries()) {
        // a USB file has no uploading machine: staff brought it (settlement.receive JSDoc)
        const result = settlement.receive({ schoolId: school.id, uploaderDeviceId: null, via: 'USB_IMPORT', record });
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        if (result.code === 'CONFLICT') conflicts += 1;
        for (const kind of result.differences ?? []) differencesFound[kind] = (differencesFound[kind] ?? 0) + 1;
        if (result.status === 'REFUSED' && refused.length < MAX_REFUSED_SHOWN) {
          refused.push({ index, txn: typeof record?.txn === 'string' ? record.txn.slice(0, 64) : null, code: result.code, message: result.message ?? null });
        }
      }
      const total = file.records.length;
      schools.audit(school.id, actorOf(req.staff), 'journal.import', { device: found.device.code, exportedAt: file.exportedAt, total, counts });
      return { school: school.code, device: found.device.code, exportedAt: file.exportedAt, total, counts, conflicts, differences: differencesFound, refused };
    }),

    // ---- other -------------------------------------------------------------------------------
    staffRoute('GET', '/api/admin/audit', ADMIN, (req) => services().schools.listAudit(req.school.id, count(req.query.limit, 100, 1000))),
    staffRoute('POST', '/api/admin/jobs/run', ADMIN, (req) => deps.platform.runJobs({ schoolId: req.school.id })),
  ];
}
