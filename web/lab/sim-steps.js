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
/** Somewhere on a school's network (a copy of a machine's login is not one of its machines). */
const netNode = (school) => (school ? { kind: 'net', school } : null);
/** A card's chip UID without the tray's copy suffix ('04A1…80-copy2' -> '04A1…80'). */
const chipUid = (uid) => String(uid ?? '').replace(/-copy\d*$/i, '').toUpperCase();

/**
 * The card a step is about, on the topology: the card the flow names (its subject, its lab.action)
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
 * The card a flow is about, from its subject (a tap, a card fault, a kiosk fault, a card of
 * another school): { school, uid } or null. The card's own school may be another one than the
 * machine's; the flow's lab.action says so too (cardSchool) once it comes.
 */
function cardOfFlow(trace) {
  if (trace?.kind !== 'tap' && trace?.kind !== 'fault') return null;
  const s = subjectOf(trace);
  const uid = word(s.uid);
  // a tap names the card's own school (cardSchool); a card fault names the card's school (school)
  const school = word(s.cardSchool) ?? word(s.school) ?? word(trace.school);
  return uid && school ? { school, uid } : null;
}

/** Why a broker login started or ended, from the kind of flow it belongs to (DESIGN §11.7). */
function loginWhyOfFlow(trace, event) {
  const s = subjectOf(trace);
  const fault = trace?.kind === 'fault' ? s.fault : null;
  const on = event === 'mqtt.connect';
  if (trace?.kind === 'server' || fault === 'server-down' || fault === 'server-up') {
    const up = trace.kind === 'server' ? s.up : fault === 'server-up';
    if (typeof up === 'boolean') return up ? (on ? 'serverOn' : null) : on ? null : 'serverOff';
  }
  if (trace?.kind === 'broker' || fault === 'broker-restart') return on ? 'brokerBack' : 'brokerRestart';
  if (trace?.kind === 'reboot') return on ? 'rebooted' : 'reboot';
  if (trace?.kind === 'cable' && typeof s.plugged === 'boolean') return s.plugged === on ? (on ? 'plugged' : 'cable') : null;
  if (trace?.kind === 'add-device' && on) return 'newMachine';
  return null;
}

/**
 * Who each broker login of a flow is, and why it starts or ends: seq -> { role?, why? }.
 * - why: the flow pulled this machine's cable or plugged it in, switched the server off or on,
 *   restarted the broker, rebooted the machine, added it (the events before it say so, else the
 *   kind of flow);
 * - role, in the cross-device fault only: a copy of a machine's login logs in with the machine's
 *   username and so knocks the real machine off ('knocked'), logs in ('copied'), is refused
 *   ('copied'), has its connection closed ('copiedClosed'); the machine comes back ('back').
 */
function loginsOf(events, trace) {
  const out = new Map();
  const cable = new Map(); // '<school>/<DEVICE>' -> 'cable' (pulled) | 'plugged'
  let down = null; // why every login of the flow ends: the server or the broker went down
  let up = null; // why every login of the flow starts: the server or the broker came back
  const s = subjectOf(trace);
  const copiedUser = trace?.kind === 'fault' && s.fault === 'cross-device-publish' && machineName(word(s.school) ?? trace.school, word(s.device) ?? trace.device)?.replace('/', '.');
  let copy = 'before'; // the copied login: before it, on, off (closed), the machine back
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'device.cable' && d.device) cable.set(`${e.school}/${d.device}`, d.plugged ? 'plugged' : 'cable');
    else if (e.type === 'server.status') {
      if (d.up) up = 'serverOn';
      else down = 'serverOff';
    } else if (e.type === 'broker.status') {
      if (!d.up && d.code === 'SERVER_OFF') down = 'serverOff';
      else if (!d.up && d.code === 'RESTARTING') down = 'brokerRestart';
      else if (d.up && d.code === 'SERVER_ON') up = 'serverOn';
      else if (d.up && d.code === 'RESTARTED') up = 'brokerBack';
    }
    if (e.type !== 'mqtt.connect' && e.type !== 'mqtt.disconnect' && e.type !== 'mqtt.denied') continue;
    const info = {};
    const user = typeof d.username === 'string' ? d.username : null;
    if (copiedUser && user === copiedUser) {
      if (copy === 'before' && e.type === 'mqtt.disconnect') info.role = 'knocked';
      else if (copy === 'before') {
        info.role = 'copied';
        if (e.type === 'mqtt.connect') copy = 'on';
      } else if (copy === 'on' && e.type === 'mqtt.disconnect') {
        info.role = 'copiedClosed';
        copy = 'off';
      } else if (copy === 'on') info.role = 'copied';
      else if (copy === 'off' && e.type === 'mqtt.connect') {
        info.role = 'back';
        copy = 'back';
      }
    }
    if (e.type !== 'mqtt.denied' && !info.role) {
      const on = e.type === 'mqtt.connect';
      const machine = machineOfLogin(user, e.school);
      const byCable = machine ? cable.get(`${machine.school}/${machine.device}`) : null;
      const why = (byCable === (on ? 'plugged' : 'cable') ? byCable : null) ?? (on ? up : down) ?? loginWhyOfFlow(trace, e.type);
      if (why) info.why = why;
    }
    if (info.role || info.why) out.set(e.seq, info);
  }
  return out;
}

/**
 * Everything the trace's events say about each message (by envelope id) and each held item,
 * and about the flow: the card it is about, its card re-reads, whether it is a forged message,
 * who its broker logins are and why they start or end.
 */
export function traceContext(events, trace = null) {
  const messages = new Map();
  const held = new Map();
  const schools = new Set();
  const reads = new Set(); // machines that have read the card in this flow
  const rereads = new Set(); // seq of each card read after an earlier one by the same machine
  let card = cardOfFlow(trace);
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
        // the cross-device fault's copy of a machine's login sent it, not the machine itself
        if (d.copiedLogin === true) m.copied = true;
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
    logins: loginsOf(events, trace),
    // the lab's forged-message fault: its message is not signed with the machine's secret
    forgedFlow: trace?.kind === 'fault' && subjectOf(trace).fault === 'forged-message',
    // the broker's own refusal is a step of this flow (mqtt.denied carries the message's id)
    denied: events.some((e) => e.type === 'mqtt.denied'),
    // heartbeats are routine (hidden unless asked for) in a flow of many machines (the clock, the
    // server, the broker); in one machine's flow (adding one is one too) its heartbeat is part of what happens
    routineBeats: !trace?.device && trace?.kind !== 'add-device',
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
  if (!item) return t('held.msg', { what: t('msg.unknown') });
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
//
// Every flow names what it is about in its `subject` (DESIGN §11.7): its title and its line in the
// picker are built here from its kind and subject, in the page's language. The English title the
// lab writes is only the last resort, for a kind (or a subject) this page does not know.

/** The web apps of a request flow (subject.area) -> the key of their name. */
const AREAS = { admin: 'office', operator: 'operator', parent: 'parent', pay: 'bank' };
/** A kiosk tap made to fail (a fault of kind 'fault' that is also a tap) -> its title. */
const KIOSK_FAULT_TITLES = { 'power-cut-before-commit': 'tt.cutBefore', 'power-cut-after-commit': 'tt.cutAfter', 'confirm-timeout': 'tt.confirmLost' };
/** A machine's own flows -> their title. */
const MACHINE_TITLES = { usb: 'tt.usb', heartbeat: 'tt.heartbeat', upload: 'tt.upload', reboot: 'tt.reboot' };
const ADMIN_TITLES = { load: 'tt.adminLoad', tap: 'tt.adminTap', upload: 'tt.adminUpload' };
const ADD_TITLES = { CANTEEN: 'tt.addCanteen', WATER: 'tt.addWater', KIOSK: 'tt.addKiosk' };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Text, or null for anything else (an empty string too). */
const word = (v) => (typeof v === 'string' && v !== '' ? v : null);
/** A flow's subject: what the lab sent, {} when it sent none (an older lab). */
const subjectOf = (trace) => (trace?.subject && typeof trace.subject === 'object' ? trace.subject : {});
/** 'smk-contoh/CANTEEN-01', as the lab names a machine in a title; null without both. */
const machineName = (school, device) => (word(school) && word(device) ? `${school}/${device}` : null);

/** How far the clock moved, in a few words: '15 days', '1 hour 30 minutes'. */
export function clockWords(ms, t) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  const parts = [];
  let left = ms;
  for (const [size, one, many] of [[DAY, 'dur.day', 'dur.days'], [HOUR, 'dur.hour', 'dur.hours'], [MINUTE, 'dur.minute', 'dur.minutes'], [SECOND, 'dur.second', 'dur.seconds']]) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) parts.push(t(n === 1 ? one : many, { n }));
  }
  if (left > 0) parts.push(t('dur.ms', { n: left }));
  return parts.join(' ');
}

/** A tap: on which machine, which card (another school's?), what it bought or poured. */
function tapWords(s, trace, t) {
  const uid = word(s.uid);
  const school = word(s.school) ?? word(trace.school);
  const device = word(s.device) ?? word(trace.device);
  const machine = machineName(school, device);
  if (!uid || !machine) return null;
  let title;
  if (KIOSK_FAULT_TITLES[s.fault]) title = t(KIOSK_FAULT_TITLES[s.fault], { uid, machine });
  else if (Number.isSafeInteger(s.ml)) title = t('tt.tapWater', { uid, machine, ml: s.ml });
  else if (word(s.items)) title = t('tt.tapItems', { uid, machine, items: s.items });
  else title = t('tt.tap', { uid, machine });
  const cardSchool = word(s.cardSchool);
  if (cardSchool && cardSchool !== school) title = t('tt.otherCard', { title, school: cardSchool });
  return { title, kind: t('sim.kind.tap'), short: device };
}

/** A fault: its own title, named in the picker by the fault and where it happens. */
function faultWords(s, trace, t) {
  const fault = word(s.fault);
  if (!fault) return null;
  const school = word(s.school) ?? word(trace.school);
  const device = word(s.device) ?? word(trace.device);
  const machine = machineName(school, device);
  const uid = word(s.uid);
  let title = null;
  switch (fault) {
    case 'clone-card':
    case 'tamper-card':
      if (uid && school) title = t(fault === 'clone-card' ? 'tt.clone' : 'tt.tamper', { uid, school });
      break;
    case 'duplicate-upload':
    case 'sequence-rollback':
    case 'forged-message': {
      const key = { 'duplicate-upload': 'tt.duplicate', 'sequence-rollback': 'tt.rollback', 'forged-message': 'tt.forged' }[fault];
      if (machine) title = t(key, { machine });
      break;
    }
    case 'cross-device-publish': {
      const target = machineName(word(s.toSchool) ?? school, word(s.toDevice));
      if (machine && target) title = t('tt.crossDevice', { machine, target });
      break;
    }
    case 'cross-school-card': {
      // a card of one school (cardSchool) tapped on a machine of another (school, device)
      const cardSchool = word(s.cardSchool);
      if (uid && cardSchool && machine) title = t('tt.crossSchool', { school: cardSchool, uid, machine });
      break;
    }
    case 'server-down':
      title = t('tt.faultServerOff');
      break;
    case 'server-up':
      title = t('tt.faultServerOn');
      break;
    case 'broker-restart':
      title = t('tt.faultBroker');
      break;
    default:
      if (KIOSK_FAULT_TITLES[fault] && uid && machine) title = t(KIOSK_FAULT_TITLES[fault], { uid, machine });
      break;
  }
  const name = tr(t, `fault.${fault}.title`, fault);
  // a fault this page knows by name but not by its fields: still named in the page's words
  title ??= hasKey(`fault.${fault}.title`) ? t('tt.fault', { name }) : null;
  if (!title) return null;
  // named in the picker by where it happens: the machine, or the card a card fault is about
  const where = device ?? (uid ? `··${chipUid(uid).slice(-4)}` : null);
  return { title, kind: t('sim.kind.fault'), short: where ? t('sim.subject.faultAt', { name, device: where }) : name };
}

/**
 * What a flow is called, from its kind and subject: { title, kind, short } (kind and short make
 * the picker's line), or null when this page does not know the kind or the subject lacks a field.
 * `names(code)`: a school's name, when the page knows it.
 */
function flowWords(trace, t, names = null) {
  if (!trace) return null;
  const s = subjectOf(trace);
  const school = word(s.school) ?? word(trace.school);
  const device = word(s.device) ?? word(trace.device);
  const machine = machineName(school, device);
  switch (trace.kind) {
    case 'tap':
      return tapWords(s, trace, t);
    case 'fault':
      return faultWords(s, trace, t);
    case 'cable':
      if (!machine || typeof s.plugged !== 'boolean') return null;
      return {
        title: t(s.plugged ? 'tt.plug' : 'tt.pull', { machine }),
        kind: t('sim.kind.cable'),
        short: t(s.plugged ? 'sim.subject.cableIn' : 'sim.subject.cableOut', { device }),
      };
    case 'admin-card':
      if (!machine || !ADMIN_TITLES[s.op]) return null;
      return { title: t(ADMIN_TITLES[s.op], { school, machine }), kind: t('sim.kind.admin-card'), short: t(`sim.subject.admin.${s.op}`, { device }) };
    case 'usb':
    case 'heartbeat':
    case 'upload':
    case 'reboot':
      if (!machine) return null;
      return { title: t(MACHINE_TITLES[trace.kind], { machine }), kind: t(`sim.kind.${trace.kind}`), short: device };
    case 'clock': {
      const by = clockWords(s.ms, t);
      if (!by) return null;
      return { title: t('tt.clock', { by }), kind: t('sim.kind.clock'), short: `+${by}` };
    }
    case 'jobs':
      return { title: t('tt.jobs'), kind: t('sim.kind.jobs'), short: t('sim.subject.jobs') };
    case 'server':
      if (typeof s.up !== 'boolean') return null;
      return { title: t(s.up ? 'tt.serverOn' : 'tt.serverOff'), kind: t('sim.kind.server'), short: t(s.up ? 'sim.subject.on' : 'sim.subject.off') };
    case 'broker':
      return { title: t('tt.broker'), kind: t('sim.kind.broker'), short: t('sim.subject.restart') };
    case 'request': {
      const area = AREAS[s.area] ? t(`sim.area.${AREAS[s.area]}`) : null;
      const method = word(s.method);
      const path = word(s.path);
      if (!area || !method || !path) return null;
      return { title: t('tt.request', { area, method, path }), kind: area, short: `${method} ${path}` };
    }
    case 'add-device': {
      const code = word(s.code);
      if (!word(s.school) || !code || !ADD_TITLES[s.type]) return null;
      return { title: t(ADD_TITLES[s.type], { code, school: s.school }), kind: t('sim.kind.add-device'), short: code };
    }
    case 'add-school': {
      const code = word(s.code);
      if (!code) return null;
      const name = names?.(code) ?? null;
      return { title: name ? t('tt.addSchoolNamed', { name, code }) : t('tt.addSchool', { code }), kind: t('sim.kind.add-school'), short: code };
    }
    default:
      return null;
  }
}

/**
 * A flow's title in the page's language, from its kind and subject; the lab's English title for
 * a kind or subject this page does not know.
 * @param {{ kind?: string, title?: string, subject?: object, school?: string|null, device?: string|null }} trace  a summary
 */
export function traceTitle(trace, t, { names = null } = {}) {
  return flowWords(trace, t, names)?.title ?? String(trace?.title ?? '');
}

/** The trace picker's line: "#3 · Tap · CANTEEN-01 · 10:02". */
export function traceLabel(summary, t, hhmm, { names = null } = {}) {
  if (!summary) return '';
  const words = flowWords(summary, t, names);
  if (words) return t('sim.trace.option', { n: summary.n, kind: words.kind, subject: words.short, time: hhmm(summary.at) });
  return t('sim.trace.optionTitle', { n: summary.n, title: String(summary.title ?? ''), time: hhmm(summary.at) });
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
 * @property {boolean} [still]  it names where it comes from, but nothing travels (a broker login ending)
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
      const trace = ctx.trace ?? { kind: d.kind, title: d.title, school, device: d.device ?? null, subject: d.subject };
      step.to = traceNode(trace, ctx);
      say('st.trace', { title: traceTitle(trace, t, { names: ctx.names }) });
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
      if (d.copiedLogin === true) {
        // the cross-device fault: a copy of this machine's broker login sends, not the machine;
        // the copy is somewhere on the school's network, not one of the machines on the map
        step.to = netNode(school);
        step.verdict = 'warn';
        step.note = t('st.send.copiedNote', { device: dev ?? '—' });
        const target = p ? (school && p.school !== school ? `${p.school}/${p.device}` : p.device) : d.topic ?? '—';
        say('st.send.copied', { ...vars, target });
      } else if (p && dev && (p.device !== dev || (school && p.school !== school))) {
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
    case 'mqtt.disconnect':
      loginStep(step, e, ctx, say);
      break;
    case 'mqtt.denied': {
      step.layer = 'mqtt';
      const p = parseTopic(d.topic);
      const copied = ctx.logins?.get(e.seq)?.role === 'copied';
      step.from = copied ? netNode(school) : (machineOfLogin(d.username, school) ?? (p ? machineNode(p.school, p.device) : null));
      step.to = BROKER;
      step.drop = BROKER;
      step.verdict = 'bad';
      const vars = { action: tr(t, `ev.action.${d.action}`, d.action ?? ''), who: loginName(d.username, ctx, school), topic: d.topic ?? '' };
      if (copied) say(d.topic ? 'st.denied.copiedTopic' : 'st.denied.copied', { ...vars, device: machineOfLogin(d.username, school)?.device ?? vars.who });
      else say(d.topic ? 'st.denied.topic' : 'st.denied', vars);
      step.kinds = [step.msgId ? 'message' : null, 'mqtt'];
      break;
    }
    case 'broker.status': {
      step.layer = 'mqtt';
      step.to = BROKER;
      step.verdict = d.up ? 'ok' : 'warn';
      const reason = brokerReason(d, t);
      if (d.up) say(reason ? 'st.broker.upWhy' : 'st.broker.up', { reason });
      else say(reason ? 'st.broker.down' : 'st.broker.downPlain', { reason });
      break;
    }

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
    case 'device.registered':
      // a new machine (DESIGN §12): the platform knows it now; the lab installs it at the school
      step.layer = 'platform';
      step.from = PLATFORM;
      step.to = DB;
      say('st.registered', { code: d.code ?? '—', type: tr(t, `type.${d.type}`, d.type ?? '—'), school: school ?? '—' });
      step.note = t('st.registeredNote');
      step.kinds = ['record'];
      break;
    case 'tenant.created':
      step.layer = 'platform';
      step.from = PLATFORM;
      step.to = DB;
      say('st.tenant', { name: d.name ?? '—', code: d.code ?? school ?? '—' });
      step.note = t('st.tenantNote');
      step.kinds = ['record'];
      break;
    case 'card.issued':
      step.layer = 'platform';
      step.from = PLATFORM;
      step.to = DB;
      say('st.issued', { uid: d.uid ?? '—' });
      step.note = t('st.issuedNote');
      step.kinds = ['record'];
      break;
    case 'card.lost':
    case 'card.found':
    case 'school.status':
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
  const s = subjectOf(trace);
  // a machine being added: where it is installed
  if (trace.kind === 'add-device' && word(s.school) && word(s.code)) return machineNode(s.school, s.code);
  const fault = trace.kind === 'fault' ? s.fault : null;
  if (ctx.card && (fault === 'clone-card' || fault === 'tamper-card')) return cardFor(ctx, ctx.card.school);
  if (trace.kind === 'broker' || fault === 'broker-restart') return BROKER;
  if (['server', 'jobs', 'request', 'add-school'].includes(trace.kind) || fault === 'server-down' || fault === 'server-up') return PLATFORM;
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
  const named = (name) => t(start ? `sim.who.${name}` : `ev.${name}`);
  if (username === null || username === undefined || username === '') return named('someone');
  if (username === 'platform') return named('platform');
  if (username === 'viewer') return named('viewer');
  const machine = machineOfLogin(username, school);
  return machine ? nodeName(machine, t, { multiSchool: ctx.multiSchool }) : String(username);
}

/**
 * A broker login starting or ending (mqtt.connect, mqtt.disconnect, DESIGN §11.7): between the
 * machine (or the platform) and the broker. A login travels to the broker; one that ends travels
 * nowhere (often nothing is sent: a cable is pulled, the broker stops), it is shown at the broker.
 * The copy of a machine's login (the cross-device fault) is not one of the machines on the map:
 * it comes from the school's network.
 */
function loginStep(step, e, ctx, say) {
  const { t } = ctx;
  const d = e.data ?? {};
  const on = e.type === 'mqtt.connect';
  const info = ctx.logins?.get(e.seq) ?? {};
  const machine = machineOfLogin(d.username, e.school ?? null);
  const who = loginName(d.username, ctx, e.school ?? null, { start: true });
  step.layer = 'mqtt';
  step.from = d.username === 'platform' ? PLATFORM : machine;
  step.to = BROKER;
  step.verdict = on ? 'ok' : 'warn';
  step.still = !on;
  step.kinds = ['login'];
  const why = info.why ? t(`why.${info.why}`) : '';
  const device = machine?.device ?? who;
  switch (info.role) {
    case 'copied':
      step.from = netNode(e.school ?? null);
      step.verdict = 'warn';
      say('st.on.copied', { device });
      return;
    case 'copiedClosed':
      step.from = netNode(e.school ?? null);
      say('st.off.copied', { device });
      return;
    case 'knocked':
      say('st.off.knocked', { who, device });
      return;
    case 'back':
      say('st.on.back', { who });
      return;
    default:
      break;
  }
  if (on) say(why ? 'st.on.why' : 'st.on', { who, why });
  else say(why ? 'st.off.why' : 'st.off', { who, why });
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
      return e.type === 'mqtt.denied' && e.data?.action === 'connect' ? loginSection(e, ctx) : mqttSection(e, msg, ctx);
    case 'login':
      return loginSection(e, ctx);
    case 'record':
      return recordSection(e, ctx);
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
  // the cross-device fault's copied login sent it: not one of the machine's own messages
  if (m.copied) rows.push([t('pd.msg.sender'), t('pd.msg.copiedLogin', { device: m.device ?? '—' })]);
  // a message waiting at the machine's hold point has not been sent yet
  if (m.sentAt && e.type !== 'sim.held') rows.push([t(m.byPlatform ? 'pd.msg.sentPlatform' : m.copied ? 'pd.msg.sentCopy' : 'pd.msg.sent'), preciseTime(m.sentAt)]);
  if (Number.isFinite(m.bytes)) rows.push([t('pd.msg.size'), t('pd.msg.bytes', { n: m.bytes })]);
  return { id: 'message', rows, note: t(m.byPlatform ? 'pd.msg.notePlatform' : m.copied ? 'pd.msg.noteCopied' : 'pd.msg.note') };
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
  let signs = isForged(m.msgId ?? d.msgId, ctx) ? 'pd.sec.forged' : 'pd.sec.machineSigns';
  if (m.copied) signs = 'pd.sec.copiedSigns';
  return {
    id: 'security',
    rows: [
      [t('pd.sec.signature'), t(signs, { device: m.copied ? m.device ?? device : device })],
      [t('pd.sec.secret'), t(m.copied ? 'pd.sec.secretCopied' : 'pd.sec.secretHow', { device: m.copied ? m.device ?? device : device })],
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
  // the copied login of the cross-device fault publishes once, unconfirmed (QoS 0)
  const qos = m.qos ?? d.qos ?? (m.copied ? 0 : 1);
  rows.push([t('pd.mqtt.qos'), t(qos === 0 ? 'pd.mqtt.qos0' : 'pd.mqtt.qos1', { qos })]);
  rows.push([t('pd.mqtt.retained'), t((m.retained ?? d.retained) ? 'pd.mqtt.retainedYes' : 'pd.mqtt.retainedNo')]);
  if (m.from) rows.push([t('pd.mqtt.login'), code(m.from)]);
  else if (m.copied && m.school && m.device) rows.push([t('pd.mqtt.login'), t('pd.mqtt.loginCopied', { login: `${m.school}.${m.device}` })]);
  rows.push([t('pd.mqtt.rule'), t(down ? 'pd.mqtt.ruleDown' : 'pd.mqtt.ruleUp')]);
  const checks = [];
  if (m.passedAt || e.type === 'mqtt.publish') checks.push({ state: 'ok', label: t('pd.mqtt.allowed'), value: t('pd.mqtt.passed') });
  else if (m.denied) {
    // refused by the broker: no acknowledgement ever comes
    checks.push({ state: 'bad', label: t('pd.mqtt.allowed'), value: t('pd.mqtt.refused') });
    return { id: 'mqtt', rows, checks };
  }
  if (!down && !m.byPlatform && !m.copied) {
    const a = m.acked ?? (e.type === 'device.acked' ? d : null);
    if (a) checks.push({ state: a.ok ? 'ok' : 'warn', label: t('pd.mqtt.puback'), value: a.ok ? t('pd.mqtt.pubackMs', { ms: a.ms ?? '—' }) : tr(t, `sim.ackReason.${a.reason}`, a.reason ?? '—') });
    else checks.push({ state: 'skip', label: t('pd.mqtt.puback'), value: t('pd.sec.notYet') });
  }
  return { id: 'mqtt', rows, checks };
}

/**
 * A broker login (DESIGN §11.7): its username and client id, who it is, why it starts or ends,
 * and the broker's check of it.
 */
function loginSection(e, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  const info = ctx.logins?.get(e.seq) ?? {};
  const machine = machineOfLogin(d.username, e.school ?? null);
  const rows = [[t('pd.mqtt.login'), code(d.username ?? '—')]];
  if (d.clientId) rows.push([t('pd.mqtt.client'), code(d.clientId)]);
  let who = null;
  if (info.role === 'copied' || info.role === 'copiedClosed') who = t('pd.login.copied', { device: machine?.device ?? '—' });
  else if (d.username === 'platform') who = t('pd.login.platform');
  else if (d.username === 'viewer') who = t('pd.login.viewer');
  else if (machine) who = t('pd.login.machine', { device: machine.device, school: machine.school });
  if (who) rows.push([t('pd.login.who'), who]);
  const why = info.role ? t(`pd.login.role.${info.role}`) : info.why ? t(`why.${info.why}`) : null;
  if (why) rows.push([t('pd.login.why'), why]);
  const checks = [];
  if (e.type === 'mqtt.connect') checks.push({ state: 'ok', label: t('pd.login.check'), value: t('pd.login.allowed') });
  else if (e.type === 'mqtt.denied') checks.push({ state: 'bad', label: t('pd.login.check'), value: t('pd.login.refused') });
  return { id: 'mqtt', rows, checks, note: machine ? t('pd.login.note') : null };
}

/** What the platform now keeps for something new: a machine, a school, a card (DESIGN §12). */
function recordSection(e, ctx) {
  const { t } = ctx;
  const d = e.data ?? {};
  if (e.type === 'device.registered') {
    const rows = [
      [t('pd.rec.machine'), code(d.code ?? '—')],
      [t('pd.rec.type'), tr(t, `type.${d.type}`, d.type ?? '—')],
      [t('pd.rec.school'), code(e.school ?? '—')],
    ];
    if (d.location) rows.push([t('pd.rec.location'), d.location]);
    rows.push([t('pd.rec.login'), code(e.school && d.code ? `${e.school}.${d.code}` : '—')]);
    rows.push([t('pd.rec.secret'), t('pd.rec.secretHow', { device: d.code ?? '—' })]);
    return { id: 'record', rows };
  }
  if (e.type === 'tenant.created') {
    return {
      id: 'record',
      rows: [
        [t('pd.rec.school'), code(d.code ?? e.school ?? '—')],
        [t('pd.rec.name'), d.name ?? '—'],
        [t('pd.rec.cardKey'), t('pd.rec.cardKeyHow')],
      ],
    };
  }
  if (e.type === 'card.issued') {
    return {
      id: 'record',
      rows: [
        [t('pd.rec.card'), code(d.uid ?? '—')],
        [t('pd.rec.school'), code(e.school ?? '—')],
        [t('pd.rec.balance'), money(0)],
      ],
    };
  }
  return null;
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

/**
 * The sentence of one event seen on its own (the Messages tab): what its step of a flow says.
 * `trace`: its flow's summary when known (its sim.trace event); `held`: waiting items by id (from
 * sim.held), so a sim.released can say what went on.
 */
export function eventSentence(e, { t, lang, trace = null, held = null }) {
  const ctx = { t, lang, ...traceContext([e], trace) };
  const item = e.type === 'sim.released' ? held?.get(e.data?.id) : null;
  if (item) ctx.held.set(item.id, item);
  return stepOf(e, ctx).title;
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
