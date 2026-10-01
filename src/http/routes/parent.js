import { LabError } from '../../shared/errors.js';

// The parent app API (docs/DESIGN.md §7, parent rows). Parents are platform-wide (one login for
// children in several schools), but a parent only reaches a child through an APPROVED link the
// child's school issued: any other child, in any school, answers 404 exactly as if it did not
// exist. A suspended school blocks its own children only; the other schools' keep working.
//
// The balance and the money waiting at the kiosk are always two numbers, never one: waiting
// money is not on the card until the child taps at the school's top-up kiosk.

const MAX_LIST = 1000;

const count = (v, fallback, most) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, most) : fallback;
};

/** What a parent sees of an order: no staff notes, kiosk numbers or other parents' details. */
function parentOrder(order, parentId) {
  const mine = order.kind === 'TOPUP' && order.parentId === parentId;
  const out = {
    id: order.id,
    kind: order.kind,
    schoolId: order.schoolId,
    memberId: order.memberId,
    memberName: order.memberName,
    amountSen: order.amountSen,
    status: order.status,
    createdAt: order.createdAt,
    payBy: order.payBy,
    paidAt: order.paidAt,
    addBy: order.addBy,
    addedAt: order.addedAt,
    mine,
  };
  // an unpaid top-up of this parent can still be paid at the bank
  if (mine && order.status === 'CREATED') out.payUrl = `/pay/${order.id}`;
  return out;
}

/** What a parent sees of a purchase. */
function parentPurchase(p) {
  return {
    id: p.id,
    kind: p.kind,
    originDeviceCode: p.originDeviceCode,
    items: p.items,
    ml: p.ml,
    amountSen: p.amountSen,
    occurredAt: p.occurredAt,
    receivedAt: p.receivedAt,
  };
}

/**
 * @param {{ platform: object, ctx: object, sessions: object }} deps  see src/http/server.js
 * @returns {Array<{ method: string, path: string, auth: string, handler: Function }>}
 */
export function routes(deps) {
  const services = () => deps.platform.services;

  /** The linked child of the URL, or 404; 403 when the child's school is suspended. */
  function requireChild(req) {
    const { schools } = services();
    const { schoolId, memberId } = req.params;
    // APPROVED links only; checked before anything else so an unlinked child reveals nothing
    if (!schools.isLinked(req.parent.id, schoolId, memberId)) throw new LabError('CHILD_NOT_FOUND', 'no such child linked to you', 404);
    const school = schools.getSchool(schoolId);
    if (school.status !== 'ACTIVE') throw new LabError('SCHOOL_SUSPENDED', `${school.name} is suspended on the platform`, 403);
    return { school, member: schools.getMember(schoolId, memberId) };
  }

  /**
   * The last time the platform heard about this child's card: the latest purchase that reached
   * it (whichever way) or the latest kiosk write. Null when it never heard anything. Per member,
   * like the mirror balance it dates: a replaced card's purchases are still in that balance.
   */
  function lastHeard(schoolId, memberId) {
    const { db } = deps.ctx;
    const purchase = db.get('SELECT max(received_at) AS t FROM purchase WHERE school_id = ? AND member_id = ?', schoolId, memberId)?.t ?? null;
    const write = db.get('SELECT max(added_at) AS t FROM topup_order WHERE school_id = ? AND member_id = ?', schoolId, memberId)?.t ?? null;
    if (purchase === null) return write;
    if (write === null) return purchase;
    return Math.max(purchase, write);
  }

  return [
    // ---- session (lab only: pick a demo parent or register; no passwords) ------------------
    {
      method: 'GET',
      path: '/api/parent/options',
      auth: 'none',
      handler: () => {
        const { schools } = services();
        return schools.listParents().map((p) => ({
          id: p.id,
          name: p.name,
          email: p.email,
          children: schools.parentChildren(p.id).map((c) => ({ schoolCode: c.schoolCode, schoolName: c.schoolName, name: c.name })),
        }));
      },
    },
    {
      method: 'POST',
      path: '/api/parent/login',
      auth: 'none',
      handler: (req) => {
        const parent = typeof req.body.parentId === 'string' ? services().schools.getParent(req.body.parentId) : null;
        if (!parent) throw new LabError('PARENT_NOT_FOUND', 'no such parent', 404);
        return { status: 200, body: { parent }, headers: deps.sessions.signIn('parent', parent.id, req) };
      },
    },
    {
      method: 'POST',
      path: '/api/parent/register',
      auth: 'none',
      handler: (req) => {
        const parent = services().schools.registerParent({ email: req.body.email, name: req.body.name });
        return { status: 201, body: { parent }, headers: deps.sessions.signIn('parent', parent.id, req) };
      },
    },
    {
      method: 'POST',
      path: '/api/parent/logout',
      auth: 'none',
      handler: (req) => ({ status: 200, body: { signedOut: true }, headers: deps.sessions.signOut('parent', req) }),
    },
    { method: 'GET', path: '/api/parent/me', auth: 'parent', handler: (req) => ({ parent: req.parent }) },

    // ---- children ----------------------------------------------------------------------------
    {
      method: 'POST',
      path: '/api/parent/invites/redeem',
      auth: 'parent',
      handler: (req) => {
        const link = services().schools.redeemInvite({ parentId: req.parent.id, code: req.body.code });
        return { status: 201, body: { link } };
      },
    },
    {
      // APPROVED children (in every school) and every link with its status, pending ones included.
      method: 'GET',
      path: '/api/parent/children',
      auth: 'parent',
      handler: (req) => {
        const { schools } = services();
        const statusOf = new Map(schools.listSchools().map((s) => [s.id, s.status]));
        const children = schools.parentChildren(req.parent.id).map((c) => ({
          linkId: c.linkId,
          schoolId: c.schoolId,
          schoolCode: c.schoolCode,
          schoolName: c.schoolName,
          schoolStatus: statusOf.get(c.schoolId) ?? null,
          memberId: c.memberId,
          name: c.name,
          className: c.className,
          // the card's last 4 characters are enough for a parent to recognise it
          card: c.card ? { last4: c.card.last4, status: c.card.status } : null,
        }));
        return { children, links: schools.parentLinks(req.parent.id) };
      },
    },
    {
      method: 'GET',
      path: '/api/parent/children/:schoolId/:memberId/balance',
      auth: 'parent',
      handler: (req) => {
        const { school, member } = requireChild(req);
        const { mirrorBalanceSen, waitingSen } = services().topups.memberSummary(school.id, member.id);
        return { mirrorBalanceSen, waitingSen, asOf: lastHeard(school.id, member.id) };
      },
    },
    {
      // This parent's own top-ups plus the school's subsidies and transfers for the child (not
      // another parent's top-ups), and the child's purchases.
      method: 'GET',
      path: '/api/parent/children/:schoolId/:memberId/history',
      auth: 'parent',
      handler: (req) => {
        const { school, member } = requireChild(req);
        const { topups, settlement } = services();
        const limit = count(req.query.limit, 100, MAX_LIST);
        const orders = topups
          .listOrders({ schoolId: school.id, memberId: member.id, limit: MAX_LIST })
          .filter((o) => o.kind !== 'TOPUP' || o.parentId === req.parent.id)
          .slice(0, limit)
          .map((o) => parentOrder(o, req.parent.id));
        const purchases = settlement.listPurchases(school.id, { memberId: member.id, limit }).map(parentPurchase);
        return { topups: orders, purchases };
      },
    },
    {
      // A new top-up waits for payment at the (mock) bank. The Idempotency-Key header makes a
      // retried request return the same order instead of a second one.
      method: 'POST',
      path: '/api/parent/children/:schoolId/:memberId/topups',
      auth: 'parent',
      handler: (req) => {
        const { school, member } = requireChild(req);
        const order = services().topups.createOrder({
          parentId: req.parent.id,
          schoolId: school.id,
          memberId: member.id,
          amountSen: req.body.amountSen,
          idemKey: req.headers['idempotency-key'],
        });
        return { status: 201, body: { order: parentOrder(order, req.parent.id), payUrl: `/pay/${order.id}` } };
      },
    },
    {
      method: 'GET',
      path: '/api/parent/topups',
      auth: 'parent',
      handler: (req) => {
        const { schools, topups } = services();
        const names = new Map(schools.listSchools().map((s) => [s.id, s.name]));
        return topups
          .listOrders({ parentId: req.parent.id, limit: count(req.query.limit, 100, MAX_LIST) })
          .map((o) => ({ ...parentOrder(o, req.parent.id), schoolName: names.get(o.schoolId) ?? null }));
      },
    },
  ];
}
