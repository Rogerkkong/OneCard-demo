import { LabError } from '../../shared/errors.js';
import { signPayload } from '../../shared/crypto.js';
import { formatRM } from '../../shared/money.js';

// The mock payment provider ("Mock Bank") and the platform's callback endpoint for it
// (docs/DESIGN.md §7). The bank page is plain HTML with two forms (the CSP allows no scripts):
// Pay and Decline. The bank then tells the platform what happened the way a real provider
// would: a signed server-to-server POST to /api/payments/callback, made as a real HTTP request
// to this server so the callback path is exercised, and sends the parent back to the app.
//
// Only the parent who made an order can open or pay it. The bank finds the order through the
// parent's own orders, so no session, another parent or an unknown id is a plain 404.

const PROVIDER = 'MOCKBANK';
const CALLBACK_PATH = '/api/payments/callback';
const PARENT_APP = '/parent/';
const CALLBACK_TIMEOUT_MS = 5000;
// Statuses in which each answer still changes the order (topups.paymentCallback): a successful
// payment also lands on an order the platform gave up on; a decline only on one still waiting.
const PAYABLE = new Set(['CREATED', 'CANCELLED', 'FAILED']);
const DECLINABLE = new Set(['CREATED']);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 'SUCCESS' or 'FAILED' from the form or JSON (Pay / Decline are accepted too). */
function bankResult(value) {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (v === 'SUCCESS' || v === 'PAY' || v === 'PAID') return 'SUCCESS';
  if (v === 'FAILED' || v === 'DECLINE' || v === 'DECLINED') return 'FAILED';
  throw new LabError('RESULT_INVALID', 'result must be SUCCESS (pay) or FAILED (decline)');
}

const STATUS_TEXT = {
  PAID: ['This top-up is already paid.', '这笔充值已经付款。'],
  ADDED: ['This top-up is already paid and added to the card.', '这笔充值已经付款，也已加到卡上。'],
  PARKED: ['This top-up is already paid.', '这笔充值已经付款。'],
  REFUNDED: ['This top-up was paid and has been refunded.', '这笔充值已付款，后来已退款。'],
  EXPIRED: ['This top-up was paid and has been refunded.', '这笔充值已付款，后来已退款。'],
  FAILED: ['This payment was declined. Start a new top-up in the parent app.', '这笔付款被拒绝了。请在家长网页重新充值。'],
  CANCELLED: ['This payment link has expired. Start a new top-up in the parent app.', '付款链接已过期。请在家长网页重新充值。'],
};

/** The bank's page for one order: amount, school, child, and Pay / Decline while it waits for payment. */
function bankPage({ order, school }) {
  const amount = formatRM(order.amountSen);
  const action = `/pay/${encodeURIComponent(order.id)}`;
  const form = (result, label, zh, cls) =>
    `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="result" value="${result}">` +
    `<button type="submit" class="${cls}">${escapeHtml(label)} <span lang="zh-Hans">· ${zh}</span></button></form>`;
  const waiting = order.status === 'CREATED';
  const [en, zh] = STATUS_TEXT[order.status] ?? ['This top-up cannot be paid here.', '这笔充值不能在这里付款。'];
  const actions = waiting
    ? `<div class="actions">${form('SUCCESS', `Pay ${amount}`, '付款', 'pay')}${form('FAILED', 'Decline', '拒绝', 'decline')}</div>`
    : `<p class="status" role="status">${escapeHtml(en)}<br><span lang="zh-Hans">${escapeHtml(zh)}</span></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock Bank · ${escapeHtml(amount)}</title>
<style>
  :root { color-scheme: light dark; --bg: #e9eef6; --card: #ffffff; --ink: #172033; --muted: #56627a; --line: #cfd8e6;
    --brand: #23408e; --brand-ink: #ffffff; --decline-ink: #8d1f1f; --ribbon: #fff3c4; --ribbon-ink: #5a4500; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e131c; --card: #171f2c; --ink: #e6ecf6; --muted: #9aa8bd; --line: #2b3648;
    --brand: #7f9ff0; --brand-ink: #0b1220; --decline-ink: #f2a3a3; --ribbon: #3d3410; --ribbon-ink: #f5dc85; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; padding: 24px 16px; background: var(--bg); color: var(--ink);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif; }
  main { max-width: 420px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
  .bank { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .logo { font-weight: 700; font-size: 20px; color: var(--brand); letter-spacing: 0.02em; }
  .ribbon { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--ribbon); color: var(--ribbon-ink); }
  h1 { font-size: 18px; margin: 0 0 12px; }
  dl { margin: 0 0 20px; display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .amount { font-size: 28px; font-weight: 700; }
  .actions { display: grid; gap: 10px; }
  form { margin: 0; }
  button { width: 100%; min-height: 48px; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer; }
  button:focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }
  .pay { background: var(--brand); color: var(--brand-ink); border: 1px solid var(--brand); }
  .decline { background: transparent; color: var(--decline-ink); border: 1px solid var(--line); }
  .status { padding: 12px; border: 1px solid var(--line); border-radius: 10px; }
  .note { margin: 20px 0 0; font-size: 13px; color: var(--muted); }
  a { color: var(--brand); }
</style>
</head>
<body>
<main>
  <div class="bank"><span class="logo">Mock Bank</span><span class="ribbon">LAB · not real money · 不是真钱</span></div>
  <h1>Pay OneCard <span lang="zh-Hans">· 付款给 OneCard</span></h1>
  <dl>
    <dt>Merchant</dt><dd>OneCard · ${escapeHtml(school.name)}</dd>
    <dt>For</dt><dd>${escapeHtml(order.memberName)}</dd>
    <dt>Amount</dt><dd class="amount">${escapeHtml(amount)}</dd>
    <dt>Reference</dt><dd>${escapeHtml(order.id)}</dd>
  </dl>
  ${actions}
  <p class="note">The lab's pretend bank: nothing is charged anywhere. <span lang="zh-Hans">实验室的模拟银行，不会真的扣钱。</span>
  <a href="${PARENT_APP}">Back to the parent app · 回到家长网页</a></p>
</main>
</body>
</html>
`;
}

/**
 * @param {{ platform: object, ctx: object, server: { url: string|null } }} deps  see src/http/server.js
 * @returns {Array<{ method: string, path: string, auth: string, body?: string, handler: Function }>}
 */
export function routes(deps) {
  const services = () => deps.platform.services;

  /** The signed-in parent's own top-up with this id, and its school; 404 for anyone else's. */
  function parentsOrder(req) {
    const { topups, schools } = services();
    const id = req.params.orderId;
    const order = req.parent
      ? topups.listOrders({ parentId: req.parent.id, kind: 'TOPUP', limit: 1000 }).find((o) => o.id === id)
      : undefined;
    if (!order) throw new LabError('ORDER_NOT_FOUND', 'there is no such payment for you', 404);
    const school = schools.getSchool(order.schoolId);
    if (school.status !== 'ACTIVE') throw new LabError('SCHOOL_SUSPENDED', `${school.name} is suspended on the platform`, 403);
    return { order, school };
  }

  /**
   * Tell the platform the bank's answer, as the provider does: a signed callback over HTTP.
   * Skipped when it would change nothing (a second click on Pay), so the parent never sees a
   * refusal for an order that is already settled.
   * @returns {Promise<{ orderId: string, status: string }>}
   */
  async function deliver(order, result) {
    if (!(result === 'SUCCESS' ? PAYABLE : DECLINABLE).has(order.status)) return { orderId: order.id, status: order.status };
    const base = deps.server?.url;
    if (!base) throw new LabError('PAYMENT_DELIVERY_FAILED', 'the bank does not know where the platform is', 502);
    const { ctx } = deps;
    const payload = {
      orderId: order.id,
      provider: PROVIDER,
      // one provider transaction per order: a repeated callback is recognised as the same payment
      providerTxnId: `MB-${order.id}`,
      result,
      paidAmountSen: order.amountSen,
      paidAt: ctx.clock.iso(),
    };
    const body = JSON.stringify({ ...payload, signature: signPayload(ctx.settings.providerSecret, payload) });
    let res;
    let answer = null;
    try {
      res = await fetch(`${base}${CALLBACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      answer = await res.json().catch(() => null);
    } catch {
      throw new LabError('PAYMENT_DELIVERY_FAILED', 'the bank could not reach the OneCard platform', 502);
    }
    if (!res.ok) {
      const e = answer?.error;
      throw new LabError(
        typeof e?.code === 'string' ? e.code : 'PAYMENT_DELIVERY_FAILED',
        typeof e?.message === 'string' ? e.message : `the platform answered HTTP ${res.status}`,
        res.status >= 400 ? res.status : 502,
        e?.detail,
      );
    }
    return { orderId: answer?.orderId ?? order.id, status: answer?.status ?? order.status };
  }

  return [
    {
      method: 'GET',
      path: '/pay/:orderId',
      auth: 'none',
      handler: (req) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: bankPage(parentsOrder(req)) }),
    },
    {
      // The bank page's forms (form-encoded, field `result`), then back to the parent app.
      method: 'POST',
      path: '/pay/:orderId',
      auth: 'none',
      body: 'form',
      handler: async (req) => {
        const { order } = parentsOrder(req);
        await deliver(order, bankResult(req.body.result));
        return { status: 303, headers: { location: PARENT_APP } };
      },
    },
    {
      // The same for a script: { result } -> { redirect }.
      method: 'POST',
      path: '/api/pay/:orderId/complete',
      auth: 'none',
      handler: async (req) => {
        const { order } = parentsOrder(req);
        const done = await deliver(order, bankResult(req.body.result));
        return { redirect: PARENT_APP, orderId: done.orderId, status: done.status };
      },
    },
    {
      // The provider's signed server-to-server callback (topups.paymentCallback checks the signature).
      method: 'POST',
      path: CALLBACK_PATH,
      auth: 'none',
      handler: (req) => {
        const order = services().topups.paymentCallback(req.body);
        return { orderId: order.id, status: order.status };
      },
    },
  ];
}
