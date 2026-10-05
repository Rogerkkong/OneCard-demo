// Plain words for what the lab reports: the kind and one-line summary of every event in the
// message inspector, Chinese captions for machine screens, the lab-only reason of a refusal,
// what a fault did, and error messages. All of it is text; nothing here builds HTML.

import { formatRM } from '/shared/api.js';
import { STRINGS } from './strings.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Does the dictionary have this key? (t() would fall back to the key itself.) */
export const hasKey = (key) => Object.hasOwn(STRINGS.en, key);

/** The inspector's filter kinds, in the order the filter chips show them. */
export const KINDS = ['mqtt', 'platform', 'money', 'differences', 'cards', 'lab'];

const KIND_OF = {
  'mqtt.connect': 'mqtt',
  'mqtt.disconnect': 'mqtt',
  'mqtt.denied': 'mqtt',
  'mqtt.publish': 'mqtt',
  'intake.accepted': 'platform',
  'intake.duplicate': 'platform',
  'intake.refused': 'platform',
  'config.published': 'platform',
  'tenant.created': 'platform',
  'school.status': 'platform',
  'device.registered': 'platform',
  audit: 'platform',
  'purchase.received': 'money',
  'ledger.posting': 'money',
  'topup.status': 'money',
  'topup.refunded': 'money',
  'difference.opened': 'differences',
  'difference.resolved': 'differences',
  'card.issued': 'cards',
  'card.lost': 'cards',
  'card.found': 'cards',
  'card.write': 'cards',
  'admin-card.loaded': 'cards',
  'admin-card.applied': 'cards',
};

export function kindOf(e) {
  return KIND_OF[e.type] ?? 'lab';
}

/** Heartbeats a machine sends every few seconds (hidden unless asked for). */
export function isHeartbeat(e) {
  return (e.type === 'mqtt.publish' || e.type === 'intake.accepted') && e.data?.type === 'device.heartbeat';
}

/** Events that read as trouble get a red mark in the inspector. */
export function isTrouble(e) {
  if (e.type === 'intake.refused' || e.type === 'mqtt.denied' || e.type === 'difference.opened') return true;
  if (e.type === 'purchase.received') return e.data?.status === 'REFUSED' || (e.data?.differences?.length ?? 0) > 0;
  if (e.type === 'device.screen') return e.data?.tone === 'error';
  return false;
}

/** 'lab/v1/<school>/<DEVICE>/<channel…>' -> parts, or null. */
export function parseTopic(topic) {
  const m = /^lab\/v1\/([^/]+)\/([^/]+)\/(.+)$/.exec(String(topic ?? ''));
  return m ? { school: m[1], device: m[2], channel: m[3] } : null;
}

/** Does a publish go up (machine -> platform) or down (platform -> machine)? */
export function directionOf(topic) {
  const p = parseTopic(topic);
  if (!p) return null;
  return p.channel === 'records' || p.channel === 'status' ? 'up' : 'down';
}

/** The machine an event is about, if any. */
export function machineOf(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'mqtt.publish':
      return parseTopic(d.topic)?.device ?? '';
    case 'mqtt.connect':
    case 'mqtt.disconnect':
    case 'mqtt.denied': {
      const u = typeof d.username === 'string' ? d.username : '';
      const dot = u.indexOf('.');
      if (dot > 0) return u.slice(dot + 1);
      return e.type === 'mqtt.denied' ? parseTopic(d.topic)?.device ?? '' : '';
    }
    case 'purchase.received':
      return d.origin ?? '';
    case 'device.registered':
      return d.code ?? '';
    default:
      return typeof d.device === 'string' ? d.device : '';
  }
}

function who(username, t) {
  if (username === null || username === undefined || username === '') return t('ev.someone');
  if (username === 'platform') return t('ev.platform');
  if (username === 'viewer') return t('ev.viewer');
  return String(username);
}

const money = (sen) => (Number.isSafeInteger(sen) ? formatRM(sen) : '—');
/** A reference with a 64-hex card digest in it, shortened for one line (the details show it whole). */
const shortRef = (ref) => String(ref).replace(/\b([0-9a-f]{8})[0-9a-f]{56}\b/g, '$1…');
const sep = (t) => t('list.sep');

function packsText(packs, t) {
  if (!Array.isArray(packs) || packs.length === 0) return '—';
  return packs.map((p) => `${t(`kind.${p.kind}`)} v${p.version}`).join(sep(t));
}

function translatedOr(t, key, fallback) {
  return hasKey(key) ? t(key) : fallback;
}

function recordResults(results, t) {
  if (!Array.isArray(results) || results.length === 0) return '';
  if (results.length === 1) {
    const r = results[0];
    const diffs = r.differences?.length ? ` · ${r.differences.join(sep(t))}` : '';
    return `${t('colon')}${r.txn} ${translatedOr(t, `purchase.${r.status}`, r.status)}${r.code ? ` (${r.code})` : ''}${diffs}`;
  }
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const list = Object.entries(counts)
    .map(([status, n]) => `${n} ${translatedOr(t, `purchase.${status}`, status)}`)
    .join(sep(t));
  return `${t('colon')}${t('ev.records', { n: results.length, list })}`;
}

/** How far the clock moved, in plain words. */
export function duration(ms, t) {
  if (ms % DAY === 0) return ms === DAY ? t('dur.day') : t('dur.days', { n: ms / DAY });
  if (ms % HOUR === 0) return ms === HOUR ? t('dur.hour') : t('dur.hours', { n: ms / HOUR });
  return t('dur.minutes', { n: Math.round(ms / MINUTE) });
}

function labAction(d, t, lang) {
  switch (d.action) {
    case 'tap': {
      const screen = screenCaption(d.screen, t, lang) ?? d.screen ?? '';
      let s = t('ev.lab.tap', { uid: d.uid, device: d.device, screen });
      if (d.cardSchool) s += t('ev.lab.tapOther', { school: d.cardSchool });
      if (d.fault) s += t('ev.lab.tapFault', { fault: translatedOr(t, `fault.${d.fault}.title`, d.fault) });
      return s;
    }
    case 'usb.export':
      return t('ev.lab.usb', { device: d.device, count: d.count });
    case 'reboot':
      return t('ev.lab.reboot', { device: d.device });
    case 'jobs':
      return t('ev.lab.jobs', { cancelled: d.cancelled ?? 0, refunded: d.refunded ?? 0, parked: d.parked ?? 0, gaps: d.gaps ?? 0, lag: d.lag ?? 0 });
    case 'server-up':
      return t('ev.lab.serverUp') + (d.changed === false ? t('ev.lab.same') : '');
    case 'server-down':
      return t('ev.lab.serverDown') + (d.changed === false ? t('ev.lab.same') : '');
    case 'broker-restart':
      return t('ev.lab.brokerRestart');
    case 'reset':
      return t('ev.lab.reset');
    case 'fault': {
      let s = t('ev.lab.fault', { name: translatedOr(t, `fault.${d.type}.title`, d.type) });
      const bits = [d.device, d.uid, d.copy && `→ ${d.copy}`, d.txn, d.messageType, d.topic, d.platform].filter(Boolean);
      if (bits.length) s += ` · ${bits.join(' · ')}`;
      return s;
    }
    default:
      return String(d.action ?? '');
  }
}

/**
 * One line about an event, in the page's language.
 * @param {{ type: string, school: string|null, data: object }} e
 */
export function summarize(e, t, lang) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'mqtt.connect':
      return t('ev.mqtt.connect', { who: who(d.username, t) });
    case 'mqtt.disconnect':
      return t('ev.mqtt.disconnect', { who: who(d.username, t) });
    case 'mqtt.denied': {
      const action = translatedOr(t, `ev.action.${d.action}`, d.action ?? '');
      return d.topic
        ? t('ev.mqtt.denied.topic', { action, who: who(d.username, t), topic: d.topic })
        : t('ev.mqtt.denied', { action, who: who(d.username, t) });
    }
    case 'mqtt.publish': {
      const type = d.type ?? '?';
      const dir = directionOf(d.topic);
      let s;
      if (dir === 'down' && d.from === 'platform') s = t('ev.mqtt.down', { type, topic: d.topic });
      else if (dir === 'up' && typeof d.from === 'string' && d.from.includes('.')) s = t('ev.mqtt.up', { type, topic: d.topic });
      else s = t('ev.mqtt.other', { from: who(d.from, t), type, topic: d.topic });
      const extra = [d.txn, d.retained ? t('ev.retained') : null, Number.isFinite(d.bytes) ? t('ev.bytes', { n: d.bytes }) : null].filter(Boolean);
      return extra.length ? `${s} · ${extra.join(' · ')}` : s;
    }
    case 'intake.accepted':
      return t('ev.intake.accepted', { type: d.type ?? '?' }) + recordResults(d.results, t);
    case 'intake.duplicate':
      return t('ev.intake.duplicate', { type: d.type ?? '?' });
    case 'intake.refused':
      return t('ev.intake.refused', {
        type: d.type ?? '?',
        code: d.code ?? '?',
        why: translatedOr(t, `refusal.${d.code}`, t('refusal.other')),
      });
    case 'purchase.received': {
      let s = t('ev.purchase', {
        txn: d.txn ?? '?',
        amount: money(d.amountSen),
        status: translatedOr(t, `purchase.${d.status}`, d.status ?? ''),
        via: translatedOr(t, `via.${d.via}`, d.via ?? ''),
      });
      if (d.code) s += ` (${d.code})`;
      if (Array.isArray(d.differences) && d.differences.length) s += t('ev.purchase.diffs', { list: d.differences.join(sep(t)) });
      return s;
    }
    case 'ledger.posting': {
      const lines = (Array.isArray(d.lines) ? d.lines : [])
        .map((l) => `${l.side === 'DR' ? t('ev.dr') : t('ev.cr')} ${translatedOr(t, `acct.${l.kind}`, l.kind)}`)
        .join(' / ');
      return t('ev.ledger', { kind: d.kind ?? '', amount: money(d.amountSen), lines });
    }
    case 'topup.status':
      return t('ev.topup.status', {
        kind: translatedOr(t, `order.${d.kind}`, d.kind ?? ''),
        amount: money(d.amountSen),
        status: translatedOr(t, `topup.${d.status}`, d.status ?? ''),
      });
    case 'topup.refunded':
      return t(d.kind === 'TOPUP' ? 'ev.topup.refunded' : 'ev.topup.returned', {
        kind: translatedOr(t, `order.${d.kind}`, d.kind ?? ''),
        amount: money(d.amountSen),
      });
    case 'config.published':
      return t('ev.config', { kind: translatedOr(t, `kind.${d.kind}`, d.kind ?? ''), version: d.version });
    case 'card.issued':
      return t('ev.card.issued', { uid: d.uid });
    case 'card.lost':
      return t('ev.card.lost', { uid: d.uid, version: d.blockListVersion });
    case 'card.found':
      return t('ev.card.found', { uid: d.uid, version: d.blockListVersion });
    case 'card.write':
      return t(d.kind === 'credit' ? 'ev.card.credit' : 'ev.card.debit', {
        uid: d.uid,
        amount: money(d.amountSen),
        balance: money(d.balanceAfterSen),
      });
    case 'device.screen':
      return t('ev.screen', { text: screenCaption(d.text, t, lang) ?? d.text ?? '' });
    case 'device.cable':
      return t(d.plugged ? 'ev.cable.in' : 'ev.cable.out');
    case 'admin-card.loaded':
      return t('ev.admin.loaded', { token: d.token, packs: packsText(d.packs, t) });
    case 'admin-card.applied': {
      const results = Array.isArray(d.results) ? d.results : [];
      const n = (r) => results.filter((x) => x.result === r).length;
      return t('ev.admin.applied', { applied: n('APPLIED'), already: n('ALREADY_APPLIED'), rejected: n('REJECTED') });
    }
    case 'difference.opened':
      return `${t('ev.diff.opened', { kind: translatedOr(t, `diff.${d.kind}`, d.kind ?? '') })}${d.ref ? ` · ${shortRef(d.ref)}` : ''}`;
    case 'difference.resolved':
      return `${t('ev.diff.resolved', { kind: translatedOr(t, `diff.${d.kind}`, d.kind ?? '') })}${d.by ? ` · ${d.by}` : ''}`;
    case 'audit':
      return t('ev.audit', { actor: typeof d.actor === 'string' ? d.actor : JSON.stringify(d.actor ?? ''), action: d.action ?? '' });
    case 'lab.action':
      return labAction(d, t, lang);
    case 'lab.clock':
      return t('ev.lab.clock', { by: duration(d.advancedMs ?? 0, t), kl: d.kl ?? '' });
    case 'tenant.created':
      return t('ev.tenant', { name: d.name ?? '', code: d.code ?? e.school ?? '' });
    case 'school.status':
      return t('ev.school.status', { code: d.code ?? e.school ?? '', from: d.from ?? '?', status: d.status ?? '?' });
    case 'device.registered': {
      const s = t('ev.device.registered', { code: d.code ?? '', type: translatedOr(t, `type.${d.type}`, d.type ?? '') });
      return d.location ? `${s} · ${d.location}` : s;
    }
    case 'server.status':
      return t(d.up ? 'ev.server.up' : 'ev.server.down');
    case 'broker.status':
      return d.up ? t('ev.broker.up', { url: d.url ?? '' }) : t('ev.broker.down', { reason: d.reason ?? '' });
    default:
      return '';
  }
}

/** One sentence on what an event type means. */
export function explain(type, t) {
  return translatedOr(t, `evx.${type}`, t('evx.other'));
}

// ---- machine screens --------------------------------------------------------------------------

const RM = '(-?RM [\\d,]+\\.\\d{2})';
const SCREEN_PATTERNS = [
  [new RegExp(`^Paid ${RM} · Balance ${RM}$`), 'scr.paid', (m) => ({ a: m[1], b: m[2] })],
  [new RegExp(`^Poured (\\d+) ml · Paid ${RM} · Balance ${RM}$`), 'scr.poured', (m) => ({ ml: m[1], a: m[2], b: m[3] })],
  [new RegExp(`^Poured (\\d+) of (\\d+) ml · Paid ${RM} · Balance ${RM}$`), 'scr.pouredPart', (m) => ({ ml: m[1], req: m[2], a: m[3], b: m[4] })],
  [new RegExp(`^Added ${RM} · Balance ${RM}$`), 'scr.added', (m) => ({ a: m[1], b: m[2] })],
  [new RegExp(`^Nothing to add · Balance ${RM}$`), 'scr.nothing', (m) => ({ b: m[1] })],
  [/^Card unavailable, please contact the front desk$/, 'scr.unavailable'],
  [/^Closed now$/, 'scr.closed'],
  [new RegExp(`^Not enough balance · Balance ${RM}$`), 'scr.notEnough', (m) => ({ b: m[1] })],
  [/^Please wait (\d+) s and tap again$/, 'scr.wait', (m) => ({ n: m[1] })],
  [new RegExp(`^Daily limit of ${RM} reached$`), 'scr.dailyAmount', (m) => ({ a: m[1] })],
  [/^Daily limit of (\d+) purchases reached$/, 'scr.dailyCount', (m) => ({ n: m[1] })],
  [new RegExp(`^Above the limit of ${RM} per purchase$`), 'scr.perPurchase', (m) => ({ a: m[1] })],
  [/^Student cards are not accepted here$/, 'scr.groupStudent'],
  [/^Staff cards are not accepted here$/, 'scr.groupStaff'],
  [/^Machine not ready, please contact the front desk$/, 'scr.notReady'],
  [/^Machine memory full, please connect it to the network$/, 'scr.memoryFull'],
  [/^Cannot reach the platform, please come back later$/, 'scr.noPlatform'],
  [/^Power cut while adding money, please tap again$/, 'scr.powerCut'],
  [/^Admin card loaded · token (\d+) · (\d+) packs?$/, 'scr.adminLoaded', (m) => ({ n: m[1], k: m[2] })],
  [/^Admin card receipts uploaded · (\d+)$/, 'scr.adminUploaded', (m) => ({ n: m[1] })],
  [/^No receipts on the admin card$/, 'scr.adminNone'],
  [/^Admin card read: (\d+) applied, (\d+) already applied, (\d+) rejected$/, 'scr.adminRead', (m) => ({ a: m[1], b: m[2], c: m[3] })],
  [/^Admin card could not be loaded$/, 'scr.adminBad'],
  [/^Starting…$/, 'scr.starting'],
  [/^Ready$/, 'scr.ready'],
  [/^Unknown item (.+)$/, 'scr.unknownItem', (m) => ({ x: m[1] })],
  [/^Choose 1 to (\d+) items$/, 'scr.chooseItems', (m) => ({ n: m[1] })],
  [/^Quantity must be 1 to (\d+)$/, 'scr.qty', (m) => ({ n: m[1] })],
  [/^Choose how much water to pour$/, 'scr.chooseWater'],
];

/**
 * The Chinese caption for a machine screen (the machine itself shows English), or null in
 * English or for a text this page does not know.
 */
export function screenCaption(text, t, lang) {
  if (lang !== 'zh' || typeof text !== 'string') return null;
  for (const [re, key, vars] of SCREEN_PATTERNS) {
    const m = re.exec(text);
    if (m) return t(key, vars ? vars(m) : undefined);
  }
  return null;
}

/** The lab-only reason of a refusal, in plain words, with its code. */
export function reasonText(code, t) {
  if (!code) return '';
  return hasKey(`reason.${code}`) ? `${t(`reason.${code}`)} (${code})` : code;
}

// ---- what a fault did ------------------------------------------------------------------------

/**
 * A fault's answer in plain words.
 * @returns {{ text: string, tone: 'good'|'warn'|'bad'|'info' }}
 */
export function faultResult(type, r, t, lang) {
  // Simulation mode with hold on: the fault's flow waits at a hop and goes on with Next hop
  if (r?.held === true) return { tone: 'info', text: heldText(r.item, t) };
  switch (type) {
    case 'clone-card':
      return { tone: 'good', text: t('fr.clone', { from: r.copyOf, copy: r.uid, balance: money(r.card?.balanceSen), n: r.card?.cardSeq }) };
    case 'tamper-card':
      return { tone: 'good', text: t('fr.tamper', { uid: r.uid, balance: money(r.card?.balanceSen) }) };
    case 'duplicate-upload':
      return r.ok
        ? { tone: 'good', text: t('fr.dup.ok', { txn: r.txn }) }
        : { tone: 'warn', text: t('fr.dup.other', { txn: r.txn, status: r.platform?.status ?? '—' }) };
    case 'sequence-rollback':
      return r.ok ? { tone: 'good', text: t('fr.seq.ok', { seq: r.seq, last: r.lastSeq }) } : { tone: 'warn', text: t('fr.seq.wait') };
    case 'forged-message':
      return r.ok
        ? { tone: 'good', text: t('fr.forged.ok', { type: r.messageType }) }
        : { tone: 'warn', text: t('fr.forged.other', { type: r.messageType, code: r.platform?.code ?? '—' }) };
    case 'cross-device-publish': {
      if (!r.loggedIn) return { tone: 'good', text: t('fr.cross.login', { from: r.from }) };
      if (!r.ok) return { tone: 'bad', text: t('fr.cross.bad', { from: r.from, topic: r.topic }) };
      let text = t('fr.cross.ok', { from: r.from, topic: r.topic });
      if (Number.isFinite(r.machineOfflineMs)) text += ` ${t('fr.cross.offline', { s: Math.max(1, Math.round(r.machineOfflineMs / 1000)) })}`;
      return { tone: 'good', text };
    }
    case 'cross-school-card': {
      const from = r.card?.school ?? '';
      const screen = screenCaption(r.screen, t, lang) ?? r.screen;
      return r.refused
        ? { tone: 'good', text: t('fr.crossSchool.refused', { from, machine: r.machine, screen }) }
        : { tone: 'bad', text: t('fr.crossSchool.accepted', { from, machine: r.machine }) };
    }
    case 'server-down':
    case 'server-up':
      if (r.changed === false) return { tone: 'info', text: t('fr.server.same', { state: t(r.server?.up ? 'state.on' : 'state.off') }) };
      return { tone: 'good', text: t(type === 'server-down' ? 'fr.server.off' : 'fr.server.on') };
    case 'broker-restart':
      return { tone: 'good', text: t('fr.broker') };
    default:
      return kioskResult(type, r, t, lang);
  }
}

/** A kiosk tap, with or without a fault, in plain words. */
export function kioskResult(fault, r, t, lang) {
  const screen = screenCaption(r.screen, t, lang) ?? r.screen ?? '';
  if (r.interrupted) {
    const amount = money(r.interrupted.amountSen);
    return r.interrupted.committed
      ? { tone: 'warn', text: t('fr.kiosk.after', { amount }) }
      : { tone: 'warn', text: t('fr.kiosk.before', { amount }) };
  }
  if (!r.ok) return { tone: 'bad', text: t('fr.kiosk.refused', { screen, reason: reasonText(r.reason, t) }) };
  const added = Array.isArray(r.added) ? r.added : [];
  const again = (Array.isArray(r.reconfirmed) ? r.reconfirmed : []).map((x) => x.kioskTxn).filter(Boolean);
  const tail = again.length ? ` ${t('fr.kiosk.reconfirmed', { txn: again.join(t('list.sep')) })}` : '';
  if (fault && added.length === 0 && !again.length) return { tone: 'warn', text: t('fr.kiosk.nothing') };
  if (fault === 'confirm-timeout' && added[0]) {
    return { tone: 'good', text: t('fr.kiosk.timeout', { txn: added[0].kioskTxn, amount: money(added[0].amountSen) }) + tail };
  }
  if (again.length) return { tone: 'good', text: t('fr.kiosk.shows', { screen }) + tail };
  return { tone: added.length ? 'good' : 'info', text: screen };
}

// ---- Simulation mode: what waits at a hop --------------------------------------------------------

/** Messages whose hold the person can test by pulling the cable (records the journal keeps). */
export const RECORD_TYPES = new Set(['sale.recorded', 'water.recorded', 'journal.batch', 'card.readback']);

/** A plain name for a message type ('sale.recorded' -> 'the sale'), or the type itself. */
export function messageName(type, t) {
  return hasKey(`msg.${type}`) ? t(`msg.${type}`) : (type ?? t('msg.unknown'));
}

/** A plain name for a kiosk call ('pending' -> 'the question what is waiting for the card'). */
export function callName(call, t) {
  return hasKey(`call.${call}`) ? t(`call.${call}`) : (call ?? '—');
}

/**
 * What waits at a hop (a held item, DESIGN §11.4) in plain words, with what to try next: "The
 * sale is waiting inside CANTEEN-01. Press Next hop, or pull the cable first and see what happens."
 * @param {{ tip?: boolean }} [options]  tip: add the second sentence
 */
export function heldText(item, t, { tip = true } = {}) {
  if (!item) return t('held.unknown');
  const device = item.device ?? '—';
  let text;
  let tipKey = 'held.tip.next';
  if (item.where === 'kiosk-http') {
    text = t(hasKey(`held.kiosk.${item.call}`) ? `held.kiosk.${item.call}` : 'held.kiosk.other', { device, call: item.call ?? '—' });
    tipKey = 'held.tip.server';
  } else if (item.where === 'platform') {
    text = t('held.platform', { what: messageName(item.type, t), device });
    tipKey = 'held.tip.server';
  } else {
    text = t('held.machine', { what: messageName(item.type, t), device });
    if (RECORD_TYPES.has(item.type)) tipKey = 'held.tip.cable';
  }
  return tip ? `${text} ${t(tipKey)}` : text;
}

// ---- errors -------------------------------------------------------------------------------------

/** An API error in plain words (the lab's own message for codes this page does not know). */
export function errorText(err, t) {
  const code = err?.code ?? 'INTERNAL';
  const message = err?.message ?? String(err);
  if (hasKey(`err.${code}`)) return t(`err.${code}`, { message });
  return t('err.other', { message, code });
}
