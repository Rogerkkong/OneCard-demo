// Simulation mode (DESIGN §11.6): the one place that turns a lab event into a step of a flow:
// its layer, where it comes from and where it is on the topology (Packet Tracer's "last device"
// and "at device"), its verdict, one plain sentence, and the packet-detail sections that apply.
// Also the order of the hops on the wire, the names of the flows and the words for what waits
// at a hop. Text only: nothing here builds HTML. Every sentence goes through the page's i18n
// dictionary, so the steps are simply built again when the language changes.

import { formatRM, formatTimeKL } from '/shared/api.js';
import {
  RECORD_TYPES,
  brokerReason,
  callName,
  duration,
  errorText,
  explain,
  hasKey,
  heldText,
  messageName,
  parseTopic,
  reasonText,
  screenCaption,
  summarize,
} from './describe.js';

/** The layers of a step, in the order of the filter chips. */
export const LAYERS = Object.freeze(['card', 'machine', 'mqtt', 'http', 'platform', 'books', 'differences', 'lab']);

/** The platform's intake pipeline (DESIGN §3), in order. */
export const INTAKE_STEPS = Object.freeze([
  'topic', 'device', 'envelope', 'topicMatch', 'signature', 'duplicate', 'sequence', 'gates', 'typeRules', 'recorded',
]);

/** A tap's rules (DESIGN §3 "Terminal rules"), in the order the machine checks them. */
export const RULES = Object.freeze(['window', 'group', 'perPurchase', 'dailyTotal', 'dailyCount', 'tapGap', 'balance']);

// Work the platform does for a request or a message, after the hop that brought it.
const PLATFORM_WORK = new Set([
  'ledger.posting', 'topup.status', 'topup.refunded', 'purchase.received', 'difference.opened', 'difference.resolved',
  'audit', 'config.published', 'card.issued', 'card.lost', 'card.found',
]);


// ---- nodes of the topology -------------------------------------------------------------------
//
// { kind: 'card' | 'admincard' | 'machine' | 'net' | 'internet' | 'broker' | 'platform' | 'db', school?, device?, uid?, last4? }

const BROKER = Object.freeze({ kind: 'broker' });
const PLATFORM = Object.freeze({ kind: 'platform' });
const DB = Object.freeze({ kind: 'db' });

const machineNode = (school, device) => (school && device ? { kind: 'machine', school, device } : null);
const cardNode = (school, uid = null, last4 = null) => (school ? { kind: 'card', school, uid, last4 } : null);
const adminNode = (school) => (school ? { kind: 'admincard', school } : null);
const internetNode = (school) => ({ kind: 'internet', school: school ?? null });
/** A card's chip UID without the tray's copy suffix ('04A1…80-copy2' -> '04A1…80'). */
const chipUid = (uid) => String(uid ?? '').replace(/-copy\d*$/i, '').toUpperCase();

/**
 * The card a step is about, on the topology: the card the flow names (its title, its lab.action)
 * when the event matches it, so a copy of a card or another school's card is found in the right
 * tray; else the card the event itself names (its UID or the last 4 characters of it).
 */
function cardFor(ctx, school, { uid = null, last4 = null } = {}) {
  const c = ctx.card;
  if (c?.uid) {
    const same = uid ? chipUid(c.uid) === chipUid(uid) : last4 ? chipUid(c.uid).endsWith(String(last4).toUpperCase()) : true;
    if (same) return cardNode(c.school ?? school, c.uid, last4 ?? chipUid(c.uid).slice(-4));
  }
  return cardNode(school, uid, last4 ?? (uid ? chipUid(uid).slice(-4) : null));
}

/** Two nodes are the same place on the topology. */
export function sameNode(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'machine') return a.school === b.school && a.device === b.device;
  if (a.kind === 'card') return a.school === b.school && (a.uid ?? a.last4) === (b.uid ?? b.last4);
  if (a.kind === 'admincard' || a.kind === 'net' || a.kind === 'internet') return a.school === b.school;
  return true;
}

/** 'smk-contoh.CANTEEN-01' (a machine's broker login) -> its machine node, else null. */
function machineOfLogin(username, fallbackSchool) {
  if (typeof username !== 'string') return null;
  const dot = username.indexOf('.');
  if (dot <= 0) return null;
  return machineNode(username.slice(0, dot) || fallbackSchool, username.slice(dot + 1));
}

/** The name of a node, for the "last device" and "at device" columns. */
export function nodeName(n, t, { multiSchool = false } = {}) {
  if (!n) return '—';
  switch (n.kind) {
    case 'machine':
      return multiSchool ? `${n.school}/${n.device}` : n.device;
    case 'card':
      if (!n.last4 && !n.uid) return t('sim.node.cardAny');
      // a copy made by the lab's clone fault has the same chip UID as the card it copies
      return t(/-copy\d*$/i.test(String(n.uid ?? '')) ? 'sim.node.cardCopy' : 'sim.node.card', { last4: n.last4 ?? chipUid(n.uid).slice(-4) });
    case 'admincard':
      return t('sim.node.admincard');
    case 'net':
      return t('sim.node.net');
    case 'internet':
      return t('sim.node.internet');
    case 'broker':
      return t('sim.node.broker');
    case 'platform':
      return t('sim.node.platform');
    case 'db':
      return t('sim.node.db');
    default:
      return '—';
  }
}

// ---- the order of the hops ---------------------------------------------------------------------

/**
 * The events of a trace in the order of the hops on the wire. Events are kept in the order they
 * were emitted, which is not always the order things happened on the wire (the same rules as the
 * console's `show trace`, plus the kiosk's HTTP calls):
 * - the platform announces its verdict on a message (intake.*) only after the books have
 *   committed what the message caused: the verdict goes before that work (the events carrying the
 *   message's id just before it);
 * - the broker may report passing a message (mqtt.publish) after other sends: the pass goes right
 *   after the send it belongs to;
 * - the platform answers a kiosk call (http.kiosk) after the work the call caused: the answer's
 *   hop (the request arriving) goes before that work.
 * Nothing else moves; the raw order stays in each event's seq.
 */
export function hopOrder(events) {
  const isSend = (e) => (e.type === 'device.send' || e.type === 'platform.send') && typeof e.data?.msgId === 'string';
  const sent = new Set(events.filter(isSend).map((e) => e.data.msgId));
  const isPass = (e) => e.type === 'mqtt.publish' && sent.has(e.data?.msgId);
  const isVerdict = (e) => e.type.startsWith('intake.') && typeof e.msgId === 'string';
  const passes = new Map(); // msgId -> the broker's passes of it, in order
  for (const e of events) if (isPass(e)) passes.set(e.data.msgId, [...(passes.get(e.data.msgId) ?? []), e]);
  const out = [];
  for (const e of events) {
    if (isPass(e)) continue;
    if (isVerdict(e)) {
      let at = out.length;
      while (at > 0 && out[at - 1].msgId === e.msgId && !isVerdict(out[at - 1])) at -= 1;
      out.splice(at, 0, e);
      continue;
    }
    if (e.type === 'http.kiosk') {
      let at = out.length;
      while (at > 0 && PLATFORM_WORK.has(out[at - 1].type) && !out[at - 1].msgId && out[at - 1].school === e.school) at -= 1;
      out.splice(at, 0, e);
      continue;
    }
    out.push(e);
    if (isSend(e) && passes.has(e.data.msgId)) {
      out.push(...passes.get(e.data.msgId));
      passes.delete(e.data.msgId);
    }
  }
  // a pass whose send is not kept (the trace dropped it) stays where it was
  for (const rest of passes.values()) out.push(...rest);
  return out;
}

// ---- what one trace knows about its messages ----------------------------------------------------

/**
 * The card a flow is about, from its title ("Tap 04A1… on smk-contoh/CANTEEN-01", "Fault: copy
 * card 04A1… of smk-contoh", ...): { school, uid } or null. The card's school may be another
 * one than the machine's; the flow's lab.action says so (cardSchool) once it comes.
 */
function cardOfTitle(title) {
  const text = String(title ?? '');
  let m = /^Fault: a card of (\S+) \((\S+)\) on /.exec(text);
  if (m) return { school: m[1], uid: m[2] };
  m = /^Fault: (?:copy|edit) card (\S+) of (\S+?)(?: by hand)?$/.exec(text);
  if (m) return { school: m[2], uid: m[1] };
  m = /(?:^|, )[Tt]ap (\S+) on ([^/\s]+)\/\S+/.exec(text);
  if (m) return { school: m[2], uid: m[1] };
  return null;
}

/**
 * Everything the trace's events say about each message (by envelope id) and each held item,
 * and about the flow: the card it is about, its card re-reads, whether it is a forged message.
 */
export function traceContext(events, trace = null) {
  const messages = new Map();
  const held = new Map();
  const schools = new Set();
  const reads = new Set(); // machines that have read the card in this flow
  const rereads = new Set(); // seq of each card read after an earlier one by the same machine
  let card = cardOfTitle(trace?.title);
  for (const e of events) {
    if (e.school) schools.add(e.school);
    const d = e.data ?? {};
    if (e.type === 'sim.held' && typeof d.id === 'string') held.set(d.id, d);
    if (e.type === 'device.step' && d.step === 'card.read') {
      const key = `${e.school}/${d.device}`;
      if (reads.has(key)) rereads.add(e.seq);
      reads.add(key);
    }
    // a tap's lab.action names the card and, when it is another school's, that school
    if (e.type === 'lab.action' && d.action === 'tap' && typeof d.uid === 'string') card = { school: d.cardSchool ?? e.school, uid: d.uid };
    const id = typeof d.msgId === 'string' && d.msgId !== '' ? d.msgId : null;
    if (!id) continue;
    const m = messages.get(id) ?? { msgId: id };
    switch (e.type) {
      case 'device.send':
        Object.assign(m, { type: d.type, seq: d.seq, txn: d.txn ?? m.txn, topic: d.topic, bytes: d.bytes, sentAt: e.at, device: d.device, school: e.school });
        if (d.inReplyTo) m.inReplyTo = d.inReplyTo;
        break;
      case 'platform.send':
        Object.assign(m, { type: d.type, topic: d.topic, device: d.device, school: e.school, retained: d.retained, sentAt: e.at, byPlatform: true });
        break;
      case 'mqtt.publish':
        m.type ??= d.type;
        m.topic ??= d.topic;
        m.txn ??= d.txn ?? undefined;
        m.bytes ??= d.bytes;
        m.school ??= e.school;
        Object.assign(m, { qos: d.qos, retained: d.retained, from: d.from, passedAt: e.at });
        break;
      case 'device.acked':
        m.acked = { ok: d.ok, ms: d.ms, reason: d.reason };
        m.type ??= d.type;
        break;
      case 'intake.accepted':
      case 'intake.refused':
      case 'intake.duplicate':
        m.intake = { type: e.type, checks: d.checks, code: d.code, results: d.results, snapshot: d.snapshot };
        m.type ??= d.type;
        m.device ??= d.device;
        m.school ??= e.school;
        // the platform found the signature wrong: whoever sent it did not have the machine's secret
        if (Array.isArray(d.checks) && d.checks.some((c) => c?.step === 'signature' && c.ok === false)) m.forged = true;
        break;
      case 'device.received':
        m.received = { result: d.result, reason: d.reason, kind: d.kind, version: d.version, device: d.device };
        m.type ??= d.type;
        break;
      case 'mqtt.denied':
        // the broker refused this publish (a login publishing on another machine's topic)
        m.denied = { username: d.username, topic: d.topic };
        m.topic ??= d.topic;
        break;
      case 'sim.held':
        m.type ??= d.type;
        m.txn ??= d.txn;
        m.topic ??= d.topic;
        m.device ??= d.device;
        m.school ??= d.school;
        break;
      default:
        break;
    }
    messages.set(id, m);
  }
  return {
    messages,
    held,
    multiSchool: schools.size > 1,
    card,
    rereads,
    // the lab's forged-message fault: its message is not signed with the machine's secret
    forgedFlow: /^Fault: forged message as /.test(String(trace?.title ?? '')),
    // the broker's own refusal is a step of this flow (mqtt.denied carries the message's id)
    denied: events.some((e) => e.type === 'mqtt.denied'),
    // heartbeats are routine (hidden unless asked for) in a flow of many machines (the clock, the
    // server, the broker); in one machine's flow its heartbeat is part of what happens
    routineBeats: !trace?.device,
  };
}

// ---- small text helpers ------------------------------------------------------------------------

const money = (sen) => (Number.isSafeInteger(sen) ? formatRM(sen) : '—');
const tr = (t, key, fallback) => (hasKey(key) ? t(key) : fallback);
const code = (v) => ({ text: String(v ?? '—'), mono: true });
// A sentence keeps a space around each value for codes such as CANTEEN-01 ("{who} 离开 broker"),
// but not between two Chinese characters (who = 平台): that space goes, only at a value's edge.
const CJK = '\u3000-\u303f\u4e00-\u9fff\uff00-\uffef';
const CJK_START = new RegExp(`^[${CJK}]`);
const CJK_END = new RegExp(`[${CJK}]$`);
const GAP_AFTER = new RegExp(`\u0001 (?=[${CJK}])`, 'g');
const GAP_BEFORE = new RegExp(`(?<=[${CJK}]) \u0002`, 'g');
function fill(t, key, vars) {
  const marked = {};
  for (const [name, v] of Object.entries(vars ?? {})) {
    marked[name] = typeof v === 'string' && v !== '' ? `${CJK_START.test(v) ? '\u0002' : ''}${v}${CJK_END.test(v) ? '\u0001' : ''}` : v;
  }
  return t(key, marked).replace(GAP_AFTER, '').replace(GAP_BEFORE, '').replace(/[\u0001\u0002]/g, '');
}

/** 'HH:MM:SS.mmm' (KL) from an ISO time: steps of one flow are milliseconds apart. */
export function preciseTime(iso) {
  const base = formatTimeKL(iso);
  const ms = /\.(\d{3})Z$/.exec(String(iso ?? ''));
  return ms ? `${base}.${ms[1]}` : base;
}

function httpStatusText(status, t) {
  if (status === 0) return t('sim.http.none');
  if (hasKey(`sim.http.${status}`)) return `${status} ${t(`sim.http.${status}`)}`;
  return String(status ?? '—');
}

function channelOf(topic) {
  return parseTopic(topic)?.channel ?? '';
}

/** What a held item is, in a few words ("the sale", "the call: what is waiting for the card"). */
function heldWhat(item, t) {
  if (!item) return t('msg.unknown');
  if (item.where === 'kiosk-http') return t('held.call', { call: callName(item.call, t) });
  return t('held.msg', { what: messageName(item.type, t) });
}

/** Where an item waits, in two or three words (the waiting list). */
export function heldWhere(item, t) {
  if (item?.where === 'kiosk-http') return t('sim.where.kiosk-http');
  if (item?.where === 'platform') return t('sim.where.platform');
  return t('sim.where.machine');
}

/** What an item is, for the waiting list: the message type or the kiosk call. */
export function heldSubject(item) {
  if (item?.where === 'kiosk-http') return `${item.method ?? ''} ${item.path ?? item.call ?? ''}`.trim();
  return item?.type ?? '—';
}

// ---- traces: their names -------------------------------------------------------------------------

// The lab's trace titles (src/lab/lab.js, src/http/server.js), translated with the same values.
const TITLE_PATTERNS = [
  [/^Tap (\S+) on (\S+) for (\d+) ml$/, 'tt.tapWater', (m) => ({ uid: m[1], machine: m[2], ml: m[3] })],
  [/^Tap (\S+) on (\S+)$/, 'tt.tap', (m) => ({ uid: m[1], machine: m[2] })],
  [/^Fault: power cut before the card write, tap (\S+) on (\S+)$/, 'tt.cutBefore', (m) => ({ uid: m[1], machine: m[2] })],
  [/^Fault: power cut after the card write, tap (\S+) on (\S+)$/, 'tt.cutAfter', (m) => ({ uid: m[1], machine: m[2] })],
  [/^Fault: the confirmation is lost, tap (\S+) on (\S+)$/, 'tt.confirmLost', (m) => ({ uid: m[1], machine: m[2] })],
  [/^Plug in the cable of (\S+)$/, 'tt.plug', (m) => ({ machine: m[1] })],
  [/^Pull the cable of (\S+)$/, 'tt.pull', (m) => ({ machine: m[1] })],
  [/^Load the admin card of (\S+) at (\S+)$/, 'tt.adminLoad', (m) => ({ school: m[1], machine: m[2] })],
  [/^Upload the admin card receipts of (\S+) at (\S+)$/, 'tt.adminUpload', (m) => ({ school: m[1], machine: m[2] })],
  [/^Tap the admin card of (\S+) on (\S+)$/, 'tt.adminTap', (m) => ({ school: m[1], machine: m[2] })],
  [/^Export the journal of (\S+) to USB$/, 'tt.usb', (m) => ({ machine: m[1] })],
  [/^Heartbeat now from (\S+)$/, 'tt.heartbeat', (m) => ({ machine: m[1] })],
  [/^Upload the unsent records of (\S+)$/, 'tt.upload', (m) => ({ machine: m[1] })],
  [/^Reboot (\S+)$/, 'tt.reboot', (m) => ({ machine: m[1] })],
  [/^Move the lab clock forward (.+)$/, 'tt.clock', (m, t, lang) => ({ by: durationWords(m[1], t, lang) })],
  [/^Run the scheduled jobs now$/, 'tt.jobs'],
  [/^Switch the cloud server on$/, 'tt.serverOn'],
  [/^Switch the cloud server off$/, 'tt.serverOff'],
  [/^Restart the MQTT broker$/, 'tt.broker'],
  [/^Fault: copy card (\S+) of (\S+)$/, 'tt.clone', (m) => ({ uid: m[1], school: m[2] })],
  [/^Fault: edit card (\S+) of (\S+) by hand$/, 'tt.tamper', (m) => ({ uid: m[1], school: m[2] })],
  [/^Fault: duplicate upload from (\S+)$/, 'tt.duplicate', (m) => ({ machine: m[1] })],
  [/^Fault: sequence rollback on (\S+)$/, 'tt.rollback', (m) => ({ machine: m[1] })],
  [/^Fault: forged message as (\S+)$/, 'tt.forged', (m) => ({ machine: m[1] })],
  [/^Fault: (\S+) publishes on the topic of (\S+)$/, 'tt.crossDevice', (m) => ({ machine: m[1], target: m[2] })],
  [/^Fault: a card of (\S+) \((\S+)\) on (\S+)$/, 'tt.crossSchool', (m) => ({ school: m[1], uid: m[2], machine: m[3] })],
  [/^Fault: switch the cloud server off$/, 'tt.faultServerOff'],
  [/^Fault: switch the cloud server on$/, 'tt.faultServerOn'],
  [/^Fault: restart the MQTT broker$/, 'tt.faultBroker'],
  [/^(School office|Operator console|Parent app|Mock bank): (\S+) (.+)$/, 'tt.request', (m, t) => ({ area: areaName(m[1], t), method: m[2], path: m[3] })],
];

const AREAS = { 'School office': 'office', 'Operator console': 'operator', 'Parent app': 'parent', 'Mock bank': 'bank' };
const areaName = (area, t) => (AREAS[area] ? t(`sim.area.${AREAS[area]}`) : area);

/** '1 h 30 min' (the lab's duration words) in the page's language (English as the lab wrote it). */
function durationWords(text, t, lang) {
  if (lang !== 'zh') return String(text);
  const unitOf = { day: 'day', days: 'day', h: 'h', min: 'min', s: 's', ms: 'ms' };
  return String(text).replace(/(\d+) (days?|h|min|ms|s)\b/g, (_, n, unit) => t(`sim.unit.${unitOf[unit]}`, { n }));
}

/** A trace's title in the page's language (the lab writes it in English). */
export function traceTitle(title, t, lang) {
  const text = String(title ?? '');
  for (const [re, key, vars] of TITLE_PATTERNS) {
    const m = re.exec(text);
    if (m) return t(key, vars ? vars(m, t, lang) : undefined);
  }
  return text;
}

/** The trace picker's line: "#3 · Tap · CANTEEN-01 · 10:02". */
export function traceLabel(summary, t, hhmm, lang) {
  if (!summary) return '';
  let kind = tr(t, `sim.kind.${summary.kind}`, summary.kind);
  let subject = summary.device ?? null;
  const title = String(summary.title ?? '');
  if (summary.kind === 'request') {
    const m = /^(School office|Operator console|Parent app|Mock bank): (\S+) (.+)$/.exec(title);
    if (m) {
      kind = areaName(m[1], t);
      subject = `${m[2]} ${m[3]}`;
    }
  } else if (summary.kind === 'server') subject = t(/ off$/.test(title) ? 'sim.subject.off' : 'sim.subject.on');
  else if (summary.kind === 'broker') subject = t('sim.subject.restart');
  else if (summary.kind === 'jobs') subject = t('sim.subject.jobs');
  else if (summary.kind === 'clock') {
    const m = /forward (.+)$/.exec(title);
    if (m) subject = `+${durationWords(m[1], t, lang)}`;
  }
  // a flow of no machine (the server, the clock, a fault on the cloud) is named by what it did
  if (!subject) return t('sim.trace.optionTitle', { n: summary.n, title: traceTitle(summary.title, t, lang), time: hhmm(summary.at) });
  return t('sim.trace.option', { n: summary.n, kind, subject, time: hhmm(summary.at) });
}

// ---- one event, one step ----------------------------------------------------------------------

/**
 * @typedef {object} Step
 * @property {string} layer    one of LAYERS
 * @property {object|null} from  where the step comes from (null: nothing travels)
 * @property {object|null} to    where it is when the step ends
 * @property {object|null} drop  where a refused or lost message stops (the ✗)
 * @property {'ok'|'warn'|'bad'} verdict
 * @property {string} title    one plain sentence, in the page's language
 * @property {string} titleKey its i18n key
 * @property {boolean} heartbeat  a routine heartbeat (hidden unless asked for)
 * @property {boolean} parked  the step is a hold: the envelope waits here
 * @property {string|null} msgId  the message the step is about
 * @property {object[]} sections  the packet-detail sections that apply (built when first read)
 */

/**
 * The step of one event. `ctx`: { t, lang, trace (summary), messages, held, multiSchool,
 * isHeld(id) } (traceContext() plus the page's i18n).
 * @returns {Step}
 */
export function stepOf(e, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  const school = e.school ?? null;
  const dev = d.device ?? null;
  const here = machineNode(school, dev);
  const step = {
    layer: 'lab',
    from: null,
    to: null,
    drop: null,
    verdict: 'ok',
    titleKey: 'st.other',
    vars: {},
    heartbeat: false,
    parked: false,
    msgId: typeof d.msgId === 'string' ? d.msgId : typeof e.msgId === 'string' ? e.msgId : null,
    kinds: [], // which detail sections apply, besides "what happened" and the raw JSON
  };
  const say = (key, vars = {}) => {
    step.titleKey = key;
    step.vars = vars;
  };
  // a routine heartbeat: hidden unless asked for (in a flow of many machines only)
  const isBeat = d.type === 'device.heartbeat' && ctx.routineBeats !== false;

  switch (e.type) {
    // ---- the lab and live stepping --------------------------------------------------------
    case 'sim.trace': {
      step.to = traceNode(ctx.trace ?? { kind: d.kind, title: d.title, school, device: d.device ?? null }, ctx);
      say('st.trace', { title: traceTitle(d.title, t, ctx.lang) });
      break;
    }
    case 'sim.held': {
      const at = heldNode(d);
      step.to = at;
      step.from = d.where === 'platform' ? BROKER : null;
      step.verdict = 'warn';
      step.parked = true;
      step.heldId = d.id;
      step.msgId = d.msgId ?? null;
      say('st.held', { text: heldText(d, t, { tip: false }) });
      step.kinds = ['held', d.msgId ? 'message' : null, d.where === 'kiosk-http' ? 'http' : null];
      break;
    }
    case 'sim.released': {
      const item = ctx.held.get(d.id) ?? null;
      step.to = item ? heldNode(item) : null;
      step.msgId = item?.msgId ?? null;
      say('st.released', { what: heldWhat(item, t) });
      step.kinds = item ? ['held', item.msgId ? 'message' : null] : [];
      break;
    }
    case 'sim.mode':
      say('st.mode', { mode: t(d.mode === 'simulation' ? 'sim.mode.simulation' : 'sim.mode.realtime'), hold: t(d.hold ? 'state.on' : 'state.off') });
      break;
    case 'lab.action':
      labActionStep(step, e, ctx, say);
      break;
    case 'lab.clock':
      say('st.clock', { by: duration(d.advancedMs ?? 0, t), kl: d.kl ?? '' });
      break;
    case 'server.status':
      step.to = PLATFORM;
      step.verdict = d.up ? 'ok' : 'warn';
      say(d.up ? 'st.server.up' : 'st.server.down');
      break;

    // ---- the card and the machine ---------------------------------------------------------
    case 'device.step':
      deviceStep(step, e, ctx, say, here);
      break;
    case 'card.write': {
      step.layer = 'card';
      step.from = here;
      step.to = cardFor(ctx, school, { uid: d.uid });
      say(d.kind === 'credit' ? 'st.card.credit' : 'st.card.debit', { device: dev ?? '—', amount: money(d.amountSen), balance: money(d.balanceAfterSen) });
      step.kinds = ['card'];
      break;
    }
    case 'device.screen': {
      step.layer = 'machine';
      step.to = here;
      step.verdict = d.tone === 'error' ? 'bad' : d.tone === 'warn' ? 'warn' : 'ok';
      say('st.screen', { device: dev ?? '—', text: screenCaption(d.text, t, ctx.lang) ?? d.text ?? '' });
      break;
    }
    case 'device.cable':
      step.layer = 'machine';
      step.to = here;
      step.verdict = d.plugged ? 'ok' : 'warn';
      say(d.plugged ? 'st.cable.in' : 'st.cable.out', { device: dev ?? '—' });
      break;
    case 'admin-card.loaded': {
      step.layer = 'card';
      step.from = here;
      step.to = adminNode(school);
      const packs = Array.isArray(d.packs) ? d.packs.map((p) => `${tr(t, `kind.${p.kind}`, p.kind)} v${p.version}`).join(t('list.sep')) : '—';
      say('st.admin.loaded', { device: dev ?? '—', token: d.token ?? '—', packs });
      step.kinds = ['card'];
      break;
    }
    case 'admin-card.applied': {
      step.layer = 'card';
      step.from = adminNode(school);
      step.to = here;
      const results = Array.isArray(d.results) ? d.results : [];
      const n = (r) => results.filter((x) => x.result === r).length;
      step.verdict = n('REJECTED') > 0 ? 'warn' : 'ok';
      say('st.admin.applied', { device: dev ?? '—', applied: n('APPLIED'), already: n('ALREADY_APPLIED'), rejected: n('REJECTED') });
      step.kinds = ['card'];
      break;
    }

    // ---- MQTT ---------------------------------------------------------------------------------
    case 'device.send': {
      step.layer = 'mqtt';
      step.to = here;
      step.heartbeat = isBeat;
      const vars = { device: dev ?? '—', type: d.type ?? '—', seq: d.seq ?? '—', bytes: d.bytes ?? '—' };
      const p = parseTopic(d.topic);
      if (p && dev && (p.device !== dev || (school && p.school !== school))) {
        // the lab's cross-device fault: a copy of this machine's login publishes on another machine's topic
        step.verdict = 'warn';
        step.note = t('st.send.otherTopicNote');
        say('st.send.otherTopic', { ...vars, target: school && p.school !== school ? `${p.school}/${p.device}` : p.device });
      } else if (isForged(d.msgId, ctx)) {
        // the lab's forged-message fault goes out on the machine's own connection, unsigned by it
        step.verdict = 'warn';
        step.note = t('st.send.forgedNote');
        say('st.send.forged', vars);
      } else if (d.inReplyTo) say('st.send.ack', vars);
      else say('st.send', vars);
      step.kinds = ['message', 'security', 'mqtt'];
      break;
    }
    case 'mqtt.publish': {
      step.layer = 'mqtt';
      step.heartbeat = isBeat;
      const p = parseTopic(d.topic);
      const up = p && (p.channel === 'records' || p.channel === 'status');
      step.to = BROKER;
      if (d.from === 'platform') {
        step.from = PLATFORM;
        say(d.retained ? 'st.publish.downRetained' : 'st.publish.down', { type: d.type ?? '—', device: p?.device ?? '—' });
      } else if (up) {
        step.from = machineOfLogin(d.from, p.school) ?? machineNode(p.school, p.device);
        say('st.publish.up', { type: d.type ?? '—', device: step.from?.device ?? p.device, channel: tr(t, `sim.channel.${p.channel}`, p.channel) });
      } else {
        say('st.publish.other', { who: loginName(d.from, ctx, school), type: d.type ?? '—', topic: d.topic ?? '—' });
      }
      step.kinds = ['message', 'mqtt'];
      break;
    }
    case 'device.acked': {
      step.layer = 'mqtt';
      step.heartbeat = isBeat;
      step.from = BROKER;
      step.to = here;
      if (d.ok) say('st.acked', { type: d.type ?? '—', ms: d.ms ?? '—', device: dev ?? '—' });
      else {
        step.verdict = 'warn';
        say('st.acked.fail', { type: d.type ?? '—', device: dev ?? '—', reason: tr(t, `sim.ackReason.${d.reason}`, d.reason ?? '—') });
      }
      step.kinds = ['message', 'mqtt'];
      break;
    }
    case 'platform.send':
      step.layer = 'mqtt';
      step.to = PLATFORM;
      say(d.retained ? 'st.platform.sendRetained' : 'st.platform.send', { type: d.type ?? '—', device: d.device ?? '—' });
      step.kinds = ['message', 'security', 'mqtt'];
      break;
    case 'device.received':
      receivedStep(step, e, ctx, say, here);
      break;
    case 'mqtt.connect':
    case 'mqtt.disconnect': {
      step.layer = 'mqtt';
      const who = machineOfLogin(d.username, school);
      step.from = d.username === 'platform' ? PLATFORM : who;
      step.to = BROKER;
      step.verdict = e.type === 'mqtt.connect' ? 'ok' : 'warn';
      say(e.type === 'mqtt.connect' ? 'st.connect' : 'st.disconnect', { who: loginName(d.username, ctx, school, { start: true }) });
      break;
    }
    case 'mqtt.denied': {
      step.layer = 'mqtt';
      const p = parseTopic(d.topic);
      step.from = machineOfLogin(d.username, school) ?? (p ? machineNode(p.school, p.device) : null);
      step.to = BROKER;
      step.drop = BROKER;
      step.verdict = 'bad';
      say(d.topic ? 'st.denied.topic' : 'st.denied', { action: tr(t, `ev.action.${d.action}`, d.action ?? ''), who: loginName(d.username, ctx, school), topic: d.topic ?? '' });
      step.kinds = [step.msgId ? 'message' : null, 'mqtt'];
      break;
    }
    case 'broker.status':
      step.layer = 'mqtt';
      step.to = BROKER;
      step.verdict = d.up ? 'ok' : 'warn';
      if (d.up) say('st.broker.up');
      else if (d.reason) say('st.broker.down', { reason: brokerReason(d.reason, t) });
      else say('st.broker.downPlain');
      break;

    // ---- HTTP (the kiosk) -------------------------------------------------------------------------
    case 'http.kiosk': {
      step.layer = 'http';
      step.from = here;
      step.to = PLATFORM;
      const vars = { device: dev ?? '—', method: d.method ?? '', path: d.path ?? '', status: httpStatusText(d.status, t), code: d.code ?? '' };
      if (d.status >= 400 && !(d.status === 404 && /^\/api\/kiosk\/confirm\//.test(d.path ?? ''))) {
        step.verdict = 'bad';
        step.drop = PLATFORM;
        say('st.kiosk.refused', vars);
      } else say('st.kiosk.ok', vars);
      step.kinds = ['http', 'security'];
      break;
    }
    case 'device.http':
      httpStep(step, e, ctx, say, here);
      break;

    // ---- the platform -------------------------------------------------------------------------
    case 'intake.accepted':
    case 'intake.duplicate':
    case 'intake.refused':
      intakeStep(step, e, ctx, say, here);
      break;
    case 'config.published':
      step.layer = 'platform';
      step.from = PLATFORM;
      step.to = DB;
      say('st.config', { kind: tr(t, `kind.${d.kind}`, d.kind ?? ''), version: d.version ?? '—' });
      break;
    case 'audit':
      step.layer = 'platform';
      step.from = PLATFORM;
      step.to = DB;
      // the actor as the audit trail keeps it: "Name (stf_…)", or "device:KIOSK-01" (shown as the machine)
      say('st.audit', { actor: typeof d.actor === 'string' ? d.actor.replace(/^device:/, '') : JSON.stringify(d.actor ?? ''), action: d.action ?? '' });
      break;
    case 'card.issued':
    case 'card.lost':
    case 'card.found':
    case 'tenant.created':
    case 'school.status':
    case 'device.registered':
      step.layer = 'platform';
      step.from = PLATFORM;
      step.to = DB;
      step.verdict = e.type === 'card.lost' ? 'warn' : 'ok';
      say('st.summary', { text: summarize(e, t, ctx.lang) });
      break;

    // ---- the books and differences -------------------------------------------------------------
    case 'purchase.received': {
      step.layer = 'books';
      step.from = PLATFORM;
      step.to = DB;
      const vars = { txn: d.txn ?? '—', amount: money(d.amountSen), code: d.code ?? '', diffs: diffList(d.differences, t) };
      if (d.status === 'POSTED') say('st.purchase.posted', vars);
      else if (d.status === 'DUPLICATE') {
        // a kiosk read-back always brings the card's own copy of records the platform has
        step.verdict = d.via === 'KIOSK_READBACK' ? 'ok' : 'warn';
        say(d.via === 'KIOSK_READBACK' ? 'st.purchase.copy' : 'st.purchase.dup', vars);
      } else if (d.status === 'FLAGGED') {
        step.verdict = 'warn';
        say('st.purchase.flagged', vars);
      } else if (d.status === 'REFUSED') {
        step.verdict = 'bad';
        step.drop = PLATFORM;
        step.to = PLATFORM;
        say('st.purchase.refused', vars);
      } else say('st.summary', { text: summarize(e, t, ctx.lang) });
      if (d.status === 'POSTED' && Array.isArray(d.differences) && d.differences.length) {
        step.verdict = 'warn';
        say('st.purchase.flagged', vars);
      }
      step.kinds = ['books'];
      break;
    }
    case 'ledger.posting': {
      step.layer = 'books';
      step.from = PLATFORM;
      step.to = DB;
      const lines = (Array.isArray(d.lines) ? d.lines : [])
        .map((l) => `${l.side === 'DR' ? t('ev.dr') : t('ev.cr')} ${tr(t, `acct.${l.kind}`, l.kind)}`)
        .join(' / ');
      say('st.ledger', { amount: money(d.amountSen), lines, kind: tr(t, `post.${d.kind}`, d.kind ?? '') });
      step.kinds = ['books'];
      break;
    }
    case 'topup.status':
      step.layer = 'books';
      step.from = PLATFORM;
      step.to = DB;
      step.verdict = ['FAILED', 'CANCELLED', 'EXPIRED', 'PARKED'].includes(d.status) ? 'warn' : 'ok';
      say('st.topup', {
        kind: tr(t, `order.${d.kind}`, d.kind ?? ''),
        amount: money(d.amountSen),
        status: tr(t, `topup.${d.status}`, d.status ?? ''),
      });
      step.kinds = ['books'];
      break;
    case 'topup.refunded':
      step.layer = 'books';
      step.from = PLATFORM;
      step.to = DB;
      step.verdict = 'warn';
      say('st.summary', { text: summarize(e, t, ctx.lang) });
      step.kinds = ['books'];
      break;
    case 'difference.opened':
    case 'difference.resolved':
      step.layer = 'differences';
      step.from = PLATFORM;
      step.to = DB;
      step.verdict = e.type === 'difference.opened' ? 'bad' : 'ok';
      say(e.type === 'difference.opened' ? 'st.diff.opened' : 'st.diff.resolved', { kind: tr(t, `diff.${d.kind}`, d.kind ?? ''), by: d.by ?? '' });
      break;

    default: {
      // a type this page does not know yet: still a step, with its plain fields
      const text = summarize(e, t, ctx.lang) || plainFields(d);
      say('st.other', { type: e.type, text });
      break;
    }
  }

  step.title = fill(t, step.titleKey, step.vars);
  const kinds = ['what', ...step.kinds.filter(Boolean), 'raw'];
  delete step.kinds;
  let built = null;
  Object.defineProperty(step, 'sections', {
    enumerable: true,
    get() {
      built ??= kinds.map((kind) => sectionOf(kind, step, e, ctx)).filter(Boolean);
      return built;
    },
  });
  return step;
}

/**
 * Where a trace begins on the topology: its machine, the card a card fault is about, or the cloud
 * server for the server's own flows and the web apps' requests (nothing for the lab clock).
 */
function traceNode(trace, ctx) {
  if (trace.device && trace.school) return machineNode(trace.school, trace.device);
  const title = String(trace.title ?? '');
  if (ctx.card && /^Fault: (?:copy|edit) card /.test(title)) return cardFor(ctx, ctx.card.school);
  if (trace.kind === 'broker' || /^Fault: restart the MQTT broker/.test(title)) return BROKER;
  if (['server', 'jobs', 'request'].includes(trace.kind) || /^Fault: switch the cloud server/.test(title)) return PLATFORM;
  return null;
}

/** Was this message forged (the lab's fault), not signed with its machine's secret? */
function isForged(msgId, ctx) {
  return ctx.forgedFlow === true || ctx.messages?.get(msgId)?.forged === true;
}

function heldNode(item) {
  if (item.where === 'platform') return PLATFORM;
  return machineNode(item.school, item.device);
}

/**
 * Who a broker login is, in words: a machine by its name, the platform, the viewer, or the login
 * itself. `start`: the words begin a sentence.
 */
function loginName(username, ctx, school, { start = false } = {}) {
  const { t } = ctx;
  const word = (name) => t(start ? `sim.who.${name}` : `ev.${name}`);
  if (username === null || username === undefined || username === '') return word('someone');
  if (username === 'platform') return word('platform');
  if (username === 'viewer') return word('viewer');
  const machine = machineOfLogin(username, school);
  return machine ? nodeName(machine, t, { multiSchool: ctx.multiSchool }) : String(username);
}

function diffList(list, t) {
  return (Array.isArray(list) ? list : []).map((k) => tr(t, `diff.${k}`, k)).join(t('list.sep'));
}

function plainFields(d) {
  return Object.entries(d ?? {})
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

function deviceStep(step, e, ctx, say, here) {
  const { t } = ctx;
  const d = e.data ?? {};
  const dev = d.device ?? '—';
  switch (d.step) {
    case 'card.read':
      step.layer = 'card';
      step.from = cardFor(ctx, e.school, { last4: d.last4 ?? null });
      step.to = here;
      if (d.ok) {
        // the kiosk reads the card again before each write
        say(ctx.rereads?.has(e.seq) ? 'st.card.reread' : 'st.card.read', { device: dev, last4: d.last4 ?? '—', balance: money(d.balanceSen), counter: d.cardSeq ?? '—' });
      } else {
        step.verdict = 'bad';
        step.drop = here;
        say('st.card.refused', { device: dev, reason: reasonText(d.reason, t) });
      }
      step.kinds = ['card', 'machine'];
      break;
    case 'rules': {
      step.layer = 'machine';
      step.to = here;
      const checks = Array.isArray(d.checks) ? d.checks : [];
      const failed = checks.find((c) => !c.ok);
      if (failed) {
        step.verdict = 'bad';
        step.drop = here;
        say('st.rules.fail', { device: dev, amount: money(d.amountSen), why: ruleText(failed, d, t, false) });
      } else say('st.rules.ok', { device: dev, amount: money(d.amountSen), n: checks.length });
      step.kinds = ['machine'];
      break;
    }
    case 'journal':
      step.layer = 'machine';
      step.to = here;
      say('st.journal', { device: dev, txn: d.txn ?? '—', unsent: d.unsent ?? '—' });
      break;
    case 'offline': {
      step.layer = 'machine';
      step.to = here;
      step.verdict = 'warn';
      step.heartbeat = d.type === 'device.heartbeat' && ctx.routineBeats !== false;
      if (d.call) say('st.offline.call', { device: dev, call: callName(d.call, t) });
      else if (d.type === 'card.readback') say('st.offline.readback', { device: dev });
      else if (d.type === 'device.heartbeat') say('st.offline.heartbeat', { device: dev });
      else if (RECORD_TYPES.has(d.type)) say('st.offline.record', { device: dev, what: messageName(d.type, t), txn: d.txn ?? '' });
      else say('st.offline.other', { device: dev, type: d.type ?? '—' });
      step.kinds = d.type ? ['message'] : [];
      break;
    }
    default:
      step.layer = 'machine';
      step.to = here;
      step.verdict = d.ok === false ? 'warn' : 'ok';
      say('st.step', { device: dev, step: d.step ?? '—', result: t(d.ok === false ? 'sim.result.no' : 'sim.result.ok') });
      break;
  }
}

function receivedStep(step, e, ctx, say, here) {
  const { t } = ctx;
  const d = e.data ?? {};
  const dev = d.device ?? '—';
  step.layer = 'machine';
  step.from = BROKER;
  step.to = here;
  const kind = tr(t, `kind.${d.kind}`, d.kind ?? '');
  const vars = { device: dev, kind, version: d.version ?? '—', type: d.type ?? '—', reason: d.reason ? tr(t, `sim.reason.${d.reason}`, d.reason) : '—' };
  if (d.result === 'APPLIED' && !d.kind) say('st.received.control', { device: dev, what: tr(t, `sim.control.${d.type}`, d.type ?? '—') });
  else if (d.result === 'APPLIED') say('st.received.applied', vars);
  else if (d.result === 'ALREADY_APPLIED') say('st.received.already', vars);
  else if (d.result === 'IGNORED' && d.reason === 'DUPLICATE') say('st.received.dup', vars);
  else if (d.result === 'IGNORED' && d.reason === 'VERSION_MISMATCH') {
    step.verdict = 'warn';
    say('st.received.skip', vars);
  } else if (d.result === 'REJECTED' || d.result === 'IGNORED') {
    step.verdict = 'bad';
    step.drop = here;
    say(d.result === 'REJECTED' ? 'st.received.rejected' : 'st.received.ignored', vars);
  } else say('st.summary', { text: `${dev}: ${d.type ?? ''} ${d.result ?? ''}` });
  step.kinds = ['message', 'security', 'machine'];
}

function httpStep(step, e, ctx, say, here) {
  const { t } = ctx;
  const d = e.data ?? {};
  const vars = { device: d.device ?? '—', call: callName(d.call, t), status: httpStatusText(d.status, t), code: d.code ?? '', ms: d.ms ?? '—', path: d.path ?? '' };
  step.layer = 'http';
  step.from = PLATFORM;
  step.to = here;
  if (d.status === 0 || d.code === 'NETWORK') {
    // no answer: the request never got through (the lab's lost confirmation is lost on its way
    // to the platform, which never sees it); the ✗ is on the way between kiosk and platform
    step.verdict = 'bad';
    step.from = here;
    step.to = PLATFORM;
    step.drop = internetNode(e.school);
    say(d.fault === 'confirm-timeout' ? 'st.http.lost' : 'st.http.network', vars);
  } else if (d.ok && d.status === 404) say('st.http.notFound', vars);
  else if (d.ok) say('st.http.ok', vars);
  else {
    step.verdict = 'bad';
    say('st.http.refused', vars);
  }
  step.kinds = ['http', 'security'];
}

function intakeStep(step, e, ctx, say, here) {
  const { t } = ctx;
  const d = e.data ?? {};
  step.layer = 'platform';
  step.from = BROKER;
  step.to = PLATFORM;
  step.heartbeat = d.type === 'device.heartbeat' && e.type !== 'intake.refused' && ctx.routineBeats !== false;
  step.msgId = d.msgId ?? e.msgId ?? null;
  const vars = { type: d.type ?? '—', device: d.device ?? '—', code: d.code ?? '—', why: tr(t, `refusal.${d.code}`, t('refusal.other')) };
  if (e.type === 'intake.refused') {
    step.verdict = 'bad';
    step.drop = PLATFORM;
    say('st.intake.refused', vars);
  } else if (e.type === 'intake.duplicate') {
    step.verdict = 'warn';
    say('st.intake.duplicate', vars);
  } else {
    const results = Array.isArray(d.results) ? d.results : [];
    let tail = '';
    if (results.length === 1) tail = t('st.intake.one', { txn: results[0].txn ?? '—', status: tr(t, `purchase.${results[0].status}`, results[0].status ?? '') });
    else if (results.length > 1) {
      const counts = {};
      for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const list = Object.entries(counts).map(([s, n]) => `${n} ${tr(t, `purchase.${s}`, s)}`).join(t('list.sep'));
      tail = t('st.intake.many', { n: results.length, list });
    }
    const snap = d.snapshot;
    if (snap?.checked) tail += t(snap.match ? 'st.intake.snapMatch' : 'st.intake.snapDiffer', { code: snap.code ?? '' });
    if (results.some((r) => r.status === 'FLAGGED' || r.status === 'REFUSED') || (snap?.checked && !snap.match)) step.verdict = 'warn';
    say('st.intake.accepted', { ...vars, tail });
  }
  step.kinds = ['platform', 'message', 'security'];
}

function labActionStep(step, e, ctx, say) {
  const { t } = ctx;
  const d = e.data ?? {};
  step.layer = 'lab';
  step.to = machineNode(e.school, d.device) ?? (d.action === 'server-up' || d.action === 'server-down' || d.action === 'jobs' ? PLATFORM : null);
  if (d.ok === false && d.code) {
    step.verdict = 'bad';
    const why = errorText({ code: d.code, message: d.message ?? d.code }, t);
    say('st.lab.failed', { why: why.charAt(0).toUpperCase() + why.slice(1) });
    return;
  }
  if (d.action === 'fault' && d.type === 'cross-device-publish' && d.refused && ctx.denied) {
    // the broker's refusal is a step of its own (mqtt.denied): this is the lab's word on it, at
    // the broker, with nothing travelling or refused a second time
    step.to = BROKER;
    say('st.lab.crossDevice', { device: d.device ?? '—', topic: d.topic ?? '—' });
    return;
  }
  if (d.action === 'fault' && d.type === 'cross-device-publish') {
    // (a lab whose mqtt.denied carries no message id: the lab's answer is where the flow shows the refusal)
    step.from = step.to;
    step.to = BROKER;
    step.layer = 'mqtt';
    if (d.refused) {
      step.verdict = 'bad';
      step.drop = BROKER;
      say('st.lab.crossDevice', { device: d.device ?? '—', topic: d.topic ?? '—' });
    } else say('st.lab.crossDeviceNot', { device: d.device ?? '—', topic: d.topic ?? '—' });
    return;
  }
  if (d.action === 'fault' && (d.type === 'tamper-card' || d.type === 'clone-card')) {
    // a card fault happens in the card tray: the copy appears next to the card it copies
    const card = cardFor(ctx, e.school, { uid: d.uid ?? null });
    if (d.type === 'clone-card' && d.copy) {
      step.from = card;
      step.to = cardNode(card?.school ?? e.school, d.copy, chipUid(d.copy).slice(-4));
    } else step.to = card;
  }
  if (d.ok === false) step.verdict = 'warn';
  say('st.lab.done', { text: summarize(e, t, ctx.lang) });
}

// ---- tap rules in words -------------------------------------------------------------------------

/** One rule check in words: what the machine compared (ok) or why it refused (not ok). */
function ruleText(c, d, t, forList = true) {
  const amount = money(d.amountSen);
  const ok = c.ok;
  switch (c.rule) {
    case 'window':
      return t(ok ? 'rule.window.ok' : 'rule.window.no');
    case 'group':
      return t(ok ? 'rule.group.ok' : 'rule.group.no', { group: tr(t, `group.${c.group}`, c.group ?? '—') });
    case 'perPurchase':
      return t(ok ? 'rule.perPurchase.ok' : 'rule.perPurchase.no', { amount, limit: money(c.limitSen) });
    case 'dailyTotal':
      return t(ok ? 'rule.dailyTotal.ok' : 'rule.dailyTotal.no', { used: money(c.usedSen), amount, limit: money(c.limitSen) });
    case 'dailyCount':
      return t(ok ? 'rule.dailyCount.ok' : 'rule.dailyCount.no', { count: c.count ?? '—', limit: c.limit ?? '—' });
    case 'tapGap':
      return t(ok ? 'rule.tapGap.ok' : 'rule.tapGap.no', { s: Math.max(1, Math.ceil((c.waitMs ?? 0) / 1000)) });
    case 'balance':
      return t(ok ? 'rule.balance.ok' : 'rule.balance.no', { balance: money(c.balanceSen), amount });
    default:
      return forList ? `${c.rule}: ${ok ? '✓' : '✗'}` : String(c.rule);
  }
}

// ---- packet details --------------------------------------------------------------------------
//
// A section: { id, rows?: [[label, value]], checks?: [{ state: 'ok'|'bad'|'warn'|'skip', label, value? }],
// lines?: [{ side, account, amount }], text?, note?, json? }. A value is text, or { text, mono }.

function sectionOf(kind, step, e, ctx) {
  const { t } = ctx;
  const msg =step.msgId ? ctx.messages.get(step.msgId) ?? null : null;
  switch (kind) {
    case 'what':
      return { id: 'what', text: step.title, note: step.note ?? explain(e.type, t) };
    case 'raw':
      return { id: 'raw', json: JSON.stringify(e, null, 2), seq: e.seq };
    case 'held':
      return heldSection(e, ctx);
    case 'card':
      return cardSection(e, t);
    case 'machine':
      return machineSection(e, ctx);
    case 'message':
      return messageSection(e, msg, ctx);
    case 'security':
      return securitySection(e, msg, ctx);
    case 'mqtt':
      return mqttSection(e, msg, ctx);
    case 'http':
      return httpSection(e, ctx);
    case 'platform':
      return platformSection(e, t);
    case 'books':
      return booksSection(e, t);
    default:
      return null;
  }
}

function heldSection(e, ctx) {
  const { t } = ctx;
  const item = e.type === 'sim.held' ? e.data : ctx.held.get(e.data?.id);
  if (!item) return null;
  const whereKey = `pd.held.where.${item.where}`;
  const rows = [
    [t('pd.held.where'), hasKey(whereKey) ? t(whereKey, { device: item.device ?? '—' }) : String(item.where ?? '—')],
    [t('pd.held.what'), code(heldSubject(item))],
    [t('pd.held.since'), formatTimeKL(item.at)],
    [t('pd.held.now'), ctx.isHeld?.(item.id) ? t('pd.held.waiting') : t('pd.held.gone')],
  ];
  return { id: 'held', rows };
}

function cardSection(e, t) {
  const d = e.data ?? {};
  if (e.type === 'device.step' && d.step === 'card.read') {
    if (!d.ok) {
      const rows = [[t('pd.card.result'), reasonText(d.reason, t)]];
      if (d.last4) rows.unshift([t('pd.card.card'), code(`··${d.last4}`)]);
      if (Number.isSafeInteger(d.balanceSen)) rows.push([t('pd.card.balance'), money(d.balanceSen)]);
      rows.push([t('pd.card.screen'), t('pd.card.unavailable')]);
      return { id: 'card', rows };
    }
    return {
      id: 'card',
      rows: [
        [t('pd.card.card'), code(`··${d.last4 ?? '—'}`)],
        [t('pd.card.balance'), money(d.balanceSen)],
        [t('pd.card.counter'), String(d.cardSeq ?? '—')],
        [t('pd.card.records'), String(d.records ?? '—')],
        [t('pd.card.list'), d.listVersionOnCard === undefined ? '—' : `v${d.listVersionOnCard}`],
        [t('pd.card.mac'), t('pd.card.macOk')],
      ],
    };
  }
  if (e.type === 'card.write') {
    const sign = d.kind === 'credit' ? '+' : '−';
    return {
      id: 'card',
      rows: [
        [t('pd.card.card'), code(d.uid ?? '—')],
        [t('pd.card.change'), `${sign}${money(d.amountSen)}`],
        [t('pd.card.after'), money(d.balanceAfterSen)],
        [t('pd.card.by'), code(d.device ?? '—')],
        [t('pd.card.how'), t(d.kind === 'credit' ? 'pd.card.credit' : 'pd.card.debit')],
      ],
    };
  }
  if (e.type === 'admin-card.loaded') {
    const packs = Array.isArray(d.packs) ? d.packs : [];
    return {
      id: 'card',
      rows: [
        [t('pd.admin.token'), String(d.token ?? '—')],
        ...packs.map((p) => [tr(t, `kind.${p.kind}`, p.kind), `v${p.version}`]),
      ],
    };
  }
  if (e.type === 'admin-card.applied') {
    const results = Array.isArray(d.results) ? d.results : [];
    return {
      id: 'card',
      checks: results.map((r) => ({
        state: r.result === 'REJECTED' ? 'bad' : 'ok',
        label: `${tr(t, `kind.${r.kind}`, r.kind)} v${r.appliedVersion ?? '—'}`,
        value: `${tr(t, `result.${r.result}`, r.result)}${r.error ? ` (${r.error})` : ''}`,
      })),
    };
  }
  return null;
}

function machineSection(e, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  if (e.type === 'device.step' && d.step === 'rules') {
    const checks = Array.isArray(d.checks) ? d.checks : [];
    const done = new Set(checks.map((c) => c.rule));
    const list = checks.map((c) => ({ state: c.ok ? 'ok' : 'bad', label: t(`rule.${c.rule}`), value: ruleText(c, d, t) }));
    // the rules after a refusal are not checked: the machine stops at the first one that fails
    for (const rule of RULES) if (!done.has(rule) && checks.some((c) => !c.ok)) list.push({ state: 'skip', label: t(`rule.${rule}`), value: t('pd.notChecked') });
    return { id: 'machine', checks: list, note: Number.isSafeInteger(d.ml) ? t('pd.rules.ml', { ml: d.ml }) : null };
  }
  if (e.type === 'device.step' && d.step === 'card.read') {
    // the machine checks the card in this order and stops at the first that fails
    const failAt = d.ok ? -1 : CARD_CHECKS.findIndex(([reason]) => reason === d.reason);
    return {
      id: 'machine',
      checks: staged(CARD_CHECKS, failAt, () => 'bad', ([, key]) => t(key), t),
      note: d.ok ? null : reasonText(d.reason, t),
    };
  }
  if (e.type === 'device.received') {
    const stages = d.kind || COMMAND_CHECKS[3][1].includes(d.reason) || d.result === 'REJECTED' ? COMMAND_CHECKS : COMMAND_CHECKS.slice(0, 3);
    let failAt = stages.findIndex(([, reasons]) => reasons.includes(d.reason));
    if (d.result === 'REJECTED') failAt = 3;
    const checks = staged(stages, failAt, () => (d.reason === 'DUPLICATE' || d.reason === 'VERSION_MISMATCH' ? 'warn' : 'bad'), ([key]) => t(key, { version: d.version ?? '—' }), t);
    if (d.kind && failAt < 0) checks[3].value = tr(t, `result.${d.result}`, d.result ?? '');
    return { id: 'machine', checks, note: d.reason ? `${tr(t, `sim.reason.${d.reason}`, d.reason)} (${d.reason})` : null };
  }
  return null;
}

// What a machine checks on a card, in order: [the refusal it gives, the check's name].
const CARD_CHECKS = [
  ['WRONG_SCHOOL', 'pd.cardcheck.school'],
  ['CARD_UNREADABLE', 'pd.cardcheck.mac'],
  ['BLOCKED', 'pd.cardcheck.blocked'],
];
// What a machine checks on a command, in order: [the check's name, the reasons it ignores it for].
const COMMAND_CHECKS = [
  ['pd.recv.target', ['TOPIC_INVALID', 'UNREADABLE', 'TOPIC_MISMATCH', 'WRONG_TARGET']],
  ['pd.recv.signature', ['SIGNATURE_INVALID']],
  ['pd.recv.repeat', ['DUPLICATE']],
  ['pd.recv.version', ['VERSION_MISMATCH', 'CONFIG_INVALID', 'STALE_VERSION']],
];

/** Checks made in order until one fails: passed ✓, the failing one, the rest not checked. */
function staged(stages, failAt, failState, label, t) {
  return stages.map((stage, i) => {
    if (failAt < 0 || i < failAt) return { state: 'ok', label: label(stage) };
    if (i === failAt) return { state: failState(stage), label: label(stage) };
    return { state: 'skip', label: label(stage), value: t('pd.notChecked') };
  });
}

function messageSection(e, msg, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  const m = msg ?? {};
  const type = m.type ?? d.type ?? null;
  if (!type && !m.msgId) return null;
  const topic = parseTopic(m.topic ?? d.topic);
  const rows = [[t('pd.msg.type'), code(type ?? '—')]];
  if (m.msgId) rows.push([t('pd.msg.id'), code(m.msgId)]);
  rows.push([t('pd.msg.school'), code(topic?.school ?? m.school ?? e.school ?? '—')]);
  rows.push([t('pd.msg.machine'), code(topic?.device ?? m.device ?? d.device ?? '—')]);
  if (m.seq !== undefined) rows.push([t('pd.msg.seq'), String(m.seq)]);
  const txn = m.txn ?? d.txn;
  if (txn) rows.push([t('pd.msg.txn'), code(txn)]);
  if (m.inReplyTo) rows.push([t('pd.msg.reply'), code(m.inReplyTo)]);
  // a message waiting at the machine's hold point has not been sent yet
  if (m.sentAt && e.type !== 'sim.held') rows.push([t(m.byPlatform ? 'pd.msg.sentPlatform' : 'pd.msg.sent'), preciseTime(m.sentAt)]);
  if (Number.isFinite(m.bytes)) rows.push([t('pd.msg.size'), t('pd.msg.bytes', { n: m.bytes })]);
  return { id: 'message', rows, note: t(m.byPlatform ? 'pd.msg.notePlatform' : 'pd.msg.note') };
}

function securitySection(e, msg, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  if (e.type === 'http.kiosk' || e.type === 'device.http') {
    const status = d.status;
    const refused = status === 401 || status === 409 || d.code === 'SIGNATURE_INVALID' || d.code === 'REPLAY';
    const answered = Number.isFinite(status) && status > 0;
    return {
      id: 'security',
      rows: [
        [t('pd.sec.http'), t('pd.sec.httpHow', { device: d.device ?? '—' })],
        [t('pd.sec.replay'), t('pd.sec.replayHow')],
      ],
      checks: [{ state: !answered ? 'skip' : refused ? 'bad' : 'ok', label: t('pd.sec.checkedPlatform'), value: !answered ? t('pd.sec.noAnswer') : refused ? d.code ?? String(status) : t('pd.sec.valid') }],
    };
  }
  const m = msg ?? {};
  const device = m.device ?? d.device ?? parseTopic(m.topic ?? d.topic)?.device ?? '—';
  if (m.byPlatform || e.type === 'platform.send' || e.type === 'device.received') {
    const r = m.received ?? (e.type === 'device.received' ? d : null);
    const bad = r?.result === 'IGNORED' && r.reason === 'SIGNATURE_INVALID';
    return {
      id: 'security',
      rows: [
        [t('pd.sec.signature'), t('pd.sec.platformSigns', { device })],
        [t('pd.sec.secret'), t('pd.sec.secretHow', { device })],
      ],
      checks: [{ state: !r ? 'skip' : bad ? 'bad' : 'ok', label: t('pd.sec.checkedMachine', { device }), value: !r ? t('pd.sec.notYet') : bad ? 'SIGNATURE_INVALID' : t('pd.sec.valid') }],
    };
  }
  const sig = (m.intake?.checks ?? (e.type.startsWith('intake.') ? d.checks : null))?.find?.((c) => c.step === 'signature') ?? null;
  return {
    id: 'security',
    rows: [
      [t('pd.sec.signature'), t(isForged(m.msgId ?? d.msgId, ctx) ? 'pd.sec.forged' : 'pd.sec.machineSigns', { device })],
      [t('pd.sec.secret'), t('pd.sec.secretHow', { device })],
    ],
    checks: [{
      state: !sig ? 'skip' : sig.ok ? 'ok' : 'bad',
      label: t('pd.sec.checkedPlatform'),
      value: !sig ? t(m.intake || m.denied ? 'pd.sec.notReached' : 'pd.sec.notYet') : sig.ok ? t('pd.sec.valid') : sig.code ?? 'SIGNATURE_INVALID',
    }],
  };
}

function mqttSection(e, msg, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  const m = msg ?? {};
  const topicText = m.topic ?? d.topic ?? null;
  const channel = channelOf(topicText);
  const down = channel.startsWith('commands');
  const rows = [];
  if (topicText) rows.push([t('pd.mqtt.topic'), code(topicText)]);
  if (e.type === 'mqtt.denied') {
    rows.push([t('pd.mqtt.login'), code(d.username ?? '—')]);
    rows.push([t('pd.mqtt.rule'), t('pd.mqtt.ruleUp')]);
    return { id: 'mqtt', rows, checks: [{ state: 'bad', label: t('pd.mqtt.allowed'), value: t('pd.mqtt.refused') }] };
  }
  rows.push([t('pd.mqtt.qos'), t('pd.mqtt.qos1', { qos: m.qos ?? d.qos ?? 1 })]);
  rows.push([t('pd.mqtt.retained'), t((m.retained ?? d.retained) ? 'pd.mqtt.retainedYes' : 'pd.mqtt.retainedNo')]);
  if (m.from) rows.push([t('pd.mqtt.login'), code(m.from)]);
  rows.push([t('pd.mqtt.rule'), t(down ? 'pd.mqtt.ruleDown' : 'pd.mqtt.ruleUp')]);
  const checks = [];
  if (m.passedAt || e.type === 'mqtt.publish') checks.push({ state: 'ok', label: t('pd.mqtt.allowed'), value: t('pd.mqtt.passed') });
  else if (m.denied) {
    // refused by the broker: no acknowledgement ever comes
    checks.push({ state: 'bad', label: t('pd.mqtt.allowed'), value: t('pd.mqtt.refused') });
    return { id: 'mqtt', rows, checks };
  }
  if (!down && !m.byPlatform) {
    const a = m.acked ?? (e.type === 'device.acked' ? d : null);
    if (a) checks.push({ state: a.ok ? 'ok' : 'warn', label: t('pd.mqtt.puback'), value: a.ok ? t('pd.mqtt.pubackMs', { ms: a.ms ?? '—' }) : tr(t, `sim.ackReason.${a.reason}`, a.reason ?? '—') });
    else checks.push({ state: 'skip', label: t('pd.mqtt.puback'), value: t('pd.sec.notYet') });
  }
  return { id: 'mqtt', rows, checks };
}

function httpSection(e, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  if (e.type === 'sim.held') {
    return {
      id: 'http',
      rows: [
        [t('pd.http.call'), `${callName(d.call, t)} (${d.call ?? '—'})`],
        [t('pd.http.request'), code(`${d.method ?? ''} ${d.path ?? ''}`.trim() || '—')],
        [t('pd.http.answer'), t('pd.http.notSent')],
      ],
    };
  }
  const rows = [];
  if (d.call) rows.push([t('pd.http.call'), `${callName(d.call, t)} (${d.call})`]);
  rows.push([t('pd.http.request'), code(`${d.method ?? ''} ${d.path ?? ''}`.trim() || '—')]);
  rows.push([t('pd.http.answer'), `${httpStatusText(d.status, t)}${d.code ? ` · ${d.code}` : ''}`]);
  if (Number.isFinite(d.ms)) rows.push([t('pd.http.time'), t('pd.http.ms', { ms: d.ms })]);
  rows.push([t('pd.http.kiosk'), code(d.device ?? '—')]);
  if (d.fault) rows.push([t('pd.http.fault'), tr(t, `fault.${d.fault}.title`, d.fault)]);
  return { id: 'http', rows, note: t('pd.http.note') };
}

function platformSection(e, t) {
  const d = e.data ?? {};
  const given = Array.isArray(d.checks) ? d.checks : [];
  const byStep = new Map(given.map((c) => [c.step, c]));
  const checks = INTAKE_STEPS.map((s) => {
    const c = byStep.get(s);
    if (!c) return { state: 'skip', label: t(`intake.${s}`), value: t('pd.notChecked') };
    if (c.ok) return { state: 'ok', label: t(`intake.${s}`) };
    return { state: c.code === 'DUPLICATE' ? 'warn' : 'bad', label: t(`intake.${s}`), value: `${c.code ?? '—'}${hasKey(`refusal.${c.code}`) ? ` · ${t(`refusal.${c.code}`)}` : c.code === 'DUPLICATE' ? ` · ${t('pd.intake.dup')}` : ''}` };
  });
  const rows = [];
  for (const r of Array.isArray(d.results) ? d.results : []) {
    const diffs = Array.isArray(r.differences) && r.differences.length ? ` · ${diffList(r.differences, t)}` : '';
    rows.push([code(r.txn ?? '—'), `${tr(t, `purchase.${r.status}`, r.status ?? '')}${r.code ? ` (${r.code})` : ''}${diffs}`]);
  }
  const s = d.snapshot;
  if (s?.checked) {
    rows.push([t('pd.intake.snapshot'), s.match
      ? t('pd.intake.snapMatch', { card: money(s.cardSen), books: money(s.mirrorSen) })
      : t('pd.intake.snapDiffer', { card: money(s.cardSen), books: money(s.mirrorSen), code: s.code ?? '' })]);
    if (s.unconfirmedSen) rows.push([t('pd.intake.unconfirmed'), money(s.unconfirmedSen)]);
    if (s.laterSen) rows.push([t('pd.intake.later'), money(s.laterSen)]);
  }
  return { id: 'platform', checks, rows: rows.length ? rows : null, checksFirst: true };
}

function booksSection(e, t) {
  const d = e.data ?? {};
  if (e.type === 'ledger.posting') {
    return {
      id: 'books',
      rows: [
        [t('pd.books.kind'), `${tr(t, `post.${d.kind}`, d.kind ?? '—')}`],
        [t('pd.books.key'), code(d.idemKey ?? '—')],
        [t('pd.books.amount'), money(d.amountSen)],
      ],
      lines: (Array.isArray(d.lines) ? d.lines : []).map((l) => ({
        side: l.side,
        account: `${tr(t, `acct.${l.kind}`, l.kind)}${l.memberId ? ` · ${t('pd.books.member')}` : ''}`,
        amount: money(l.amountSen),
      })),
    };
  }
  if (e.type === 'purchase.received') {
    const rows = [
      [t('pd.books.txn'), code(d.txn ?? '—')],
      [t('pd.books.amount'), money(d.amountSen)],
      [t('pd.books.status'), `${tr(t, `purchase.${d.status}`, d.status ?? '')}${d.code ? ` (${d.code})` : ''}`],
      [t('pd.books.via'), tr(t, `via.${d.via}`, d.via ?? '—')],
    ];
    if (Array.isArray(d.differences) && d.differences.length) rows.push([t('pd.books.diffs'), diffList(d.differences, t)]);
    return { id: 'books', rows };
  }
  if (e.type === 'topup.status' || e.type === 'topup.refunded') {
    return {
      id: 'books',
      rows: [
        [t('pd.books.order'), code(d.orderId ?? '—')],
        [t('pd.books.orderKind'), tr(t, `order.${d.kind}`, d.kind ?? '—')],
        [t('pd.books.amount'), money(d.amountSen)],
        [t('pd.books.status'), e.type === 'topup.refunded' ? tr(t, 'topup.REFUNDED', 'REFUNDED') : tr(t, `topup.${d.status}`, d.status ?? '—')],
      ],
    };
  }
  return null;
}

// ---- a whole trace ------------------------------------------------------------------------------

/**
 * Every step of a trace, in hop order, numbered from 1.
 * @param {object[]} events  the trace's events (any order; sorted by seq here)
 * @param {{ t: Function, lang: string, trace?: object, isHeld?: (id: string) => boolean }} options
 * @returns {Array<Step & { n: number, seq: number, e: object }>}
 */
export function buildSteps(events, options) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const ctx = { ...options, ...traceContext(sorted, options?.trace ?? null) };
  return hopOrder(sorted).map((e, i) => Object.assign(stepOf(e, ctx), { n: i + 1, seq: e.seq, e, multiSchool: ctx.multiSchool }));
}
