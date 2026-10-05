import { newId } from '../shared/ids.js';

// Traces for Simulation mode (docs/DESIGN.md §11.3): every lab action and product request
// starts one, and every event it causes carries its id, even across the MQTT and HTTP hops.
// Inside the lab process the id rides on the event bus context (AsyncLocalStorage). A message
// crosses a network socket, where that context cannot follow, so the tracer links it by
// message id: the machine's device.send (inside the trace) registers the envelope id, and the
// broker's and platform's events about that message (carrying the same id) join the trace.
// The lab console replays a trace step by step from the events kept here.

/** What a trace id looks like (an x-lab-trace header must match it). */
export const TRACE_ID_RE = /^tr_[A-Za-z0-9_-]{4,64}$/;

/** How many message ids the tracer remembers: far more than any flow sends before it is replayed. */
export const MAX_MESSAGE_IDS = 5000;

const MAX_KIND = 40;
const MAX_TITLE = 200;
const MAX_CODE = 64;

const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/**
 * @param {object} events  the lab event bus (createEventBus): withContext, emit, subscribe, setEnricher
 * @param {{ clock: { now(): number }, keepTraces?: number, keepEvents?: number }} options
 *   keepTraces: the most recent traces kept (default 200); keepEvents: events kept per trace (default 500)
 */
export function createTracer(events, { clock, keepTraces = 200, keepEvents = 500 } = {}) {
  for (const name of ['withContext', 'emit', 'subscribe', 'setEnricher']) {
    if (typeof events?.[name] !== 'function') throw new TypeError(`createTracer needs the lab event bus (missing ${name})`);
  }
  if (!clock || typeof clock.now !== 'function') throw new TypeError('createTracer needs the lab clock');
  for (const [name, value] of Object.entries({ keepTraces, keepEvents })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a whole number, 1 or more`);
  }

  let counter = 0;
  const traces = new Map(); // id -> trace, oldest first
  const messageTraces = new Map(); // message id -> trace id, oldest first

  function remember(messageId, traceId) {
    if (typeof messageId !== 'string' || messageId === '' || messageId.length > MAX_CODE) return;
    messageTraces.delete(messageId); // a message sent again (a fault repeating it) belongs to the newer flow
    messageTraces.set(messageId, traceId);
    if (messageTraces.size > MAX_MESSAGE_IDS) messageTraces.delete(messageTraces.keys().next().value);
  }

  /** The trace a message belongs to, if it is one the tracer still keeps. */
  function traceOfMessage(messageId) {
    if (typeof messageId !== 'string') return null;
    const id = messageTraces.get(messageId);
    return id && traces.has(id) ? id : null;
  }

  function enrich(event) {
    if (!event.trace) {
      const linked =
        traceOfMessage(event.msgId) ??
        traceOfMessage(event.data?.msgId) ??
        // a command.ack answers a command the platform sent in some flow
        traceOfMessage(event.data?.inReplyTo);
      if (linked) event.trace = linked;
    }
    if (event.trace && traces.has(event.trace)) remember(event.data?.msgId, event.trace);
  }

  function record(event) {
    const trace = event.trace ? traces.get(event.trace) : undefined;
    if (!trace) return;
    trace.lastAt = clock.now();
    trace.count += 1;
    trace.events.push(event);
    // keep the beginning of the flow (what started it) and its most recent steps
    if (trace.events.length > keepEvents) trace.events.splice(1, 1);
  }

  events.setEnricher(enrich);
  const unsubscribe = events.subscribe(record);

  const summary = (t) => ({
    id: t.id,
    n: t.n,
    kind: t.kind,
    title: t.title,
    school: t.school,
    device: t.device,
    at: t.at,
    lastAt: t.lastAt,
    events: t.count,
  });

  /**
   * Start a trace and announce it (sim.trace, the trace's first event).
   * @param {{ kind: string, title: string, school?: string|null, device?: string|null }} meta
   *   kind: tap, cable, fault, server, request, ...; title: what the person did, in plain words
   * @returns {string} the trace id
   */
  function begin(meta) {
    const { kind, title, school = null, device = null } = meta ?? {};
    if (!isText(kind, MAX_KIND)) throw new TypeError(`trace kind must be text of at most ${MAX_KIND} characters`);
    if (!isText(title, MAX_TITLE * 4)) throw new TypeError('trace title must be text');
    if (school !== null && !isText(school, MAX_CODE)) throw new TypeError('trace school must be a school code or null');
    if (device !== null && !isText(device, MAX_CODE)) throw new TypeError('trace device must be a device code or null');
    const id = newId('tr');
    counter += 1;
    const now = clock.now();
    const trace = {
      id,
      n: counter,
      kind: kind.trim(),
      title: title.trim().slice(0, MAX_TITLE),
      school,
      device,
      at: now,
      lastAt: now,
      count: 0,
      events: [],
    };
    traces.set(id, trace);
    while (traces.size > keepTraces) traces.delete(traces.keys().next().value);
    const announced = { id, n: trace.n, kind: trace.kind, title: trace.title };
    if (device) announced.device = device;
    events.withContext({ trace: id }, () => events.emit('sim.trace', announced, school));
    return id;
  }

  return {
    begin,

    /**
     * Start a trace and run `fn` inside it: every event `fn` causes, now or after an await,
     * carries the trace id.
     * @template T
     * @param {object} meta  as begin()
     * @param {() => T} fn
     * @returns {{ trace: string, result: T }}
     */
    run(meta, fn) {
      if (typeof fn !== 'function') throw new TypeError('run needs a function');
      const id = begin(meta);
      return { trace: id, result: events.withContext({ trace: id }, fn) };
    },

    /** True for a trace the tracer still keeps. */
    has(id) {
      return typeof id === 'string' && traces.has(id);
    },

    /** The trace a message (envelope id) belongs to, or null. */
    traceOfMessage,

    /**
     * Recent traces, newest first.
     * @returns {Array<{ id, n, kind, title, school, device, at, lastAt, events }>} at/lastAt: lab clock ms; events: how many
     */
    list({ limit = 50 } = {}) {
      const max = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, keepTraces) : 50;
      return [...traces.values()].slice(-max).reverse().map(summary);
    },

    /** One trace and its events in order, or null. */
    get(id) {
      const trace = typeof id === 'string' ? traces.get(id) : undefined;
      if (!trace) return null;
      return { trace: summary(trace), events: trace.events.slice() };
    },

    /** Forget every trace (a lab reset); numbering starts again at 1. */
    clear() {
      traces.clear();
      messageTraces.clear();
      counter = 0;
    },

    /** Stop following the bus. */
    close() {
      unsubscribe();
      events.setEnricher(null);
      traces.clear();
      messageTraces.clear();
    },
  };
}
