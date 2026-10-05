import { AsyncLocalStorage } from 'node:async_hooks';

// In-memory event bus. The lab console shows these events live (server-sent events),
// and tests use them to see what happened. Keeps the most recent `keep` events.
//
// Event: { seq, at (ISO, lab clock), type, school (code or null), data, trace?, msgId? }
//
// Given the database (`db`), an event emitted inside a transaction is held back until
// the outermost transaction commits, and dropped if it rolls back: the console never
// shows a posting, difference or card that was not actually written.
//
// Simulation mode (docs/DESIGN.md §11.1): a context follows the code that runs inside
// withContext() across awaits, and every event emitted there carries its `trace` and
// `msgId`. Long-lived resources (MQTT clients, servers, intervals) are created untraced, so
// their later callbacks never inherit the trace of whatever happened to create them.

const CONTEXT_KEYS = Object.freeze(['trace', 'msgId']);

/** Only the known fields, and only non-empty strings: nothing else rides along. */
function cleanContext(value) {
  const out = {};
  if (value && typeof value === 'object') {
    for (const key of CONTEXT_KEYS) {
      if (typeof value[key] === 'string' && value[key] !== '') out[key] = value[key];
    }
  }
  return out;
}

export function createEventBus({ clock, keep = 1000, db } = {}) {
  let seq = 0;
  const recent = [];
  const subscribers = new Set();
  const store = new AsyncLocalStorage();
  let enricher = null;

  function deliver(type, data, school, context) {
    const event = { seq: ++seq, at: clock ? clock.iso() : new Date().toISOString(), type, school, data };
    if (context.trace) event.trace = context.trace;
    if (context.msgId) event.msgId = context.msgId;
    if (enricher) {
      try {
        enricher(event);
      } catch {
        // a broken enricher must not break the emitter
      }
    }
    recent.push(event);
    if (recent.length > keep) recent.splice(0, recent.length - keep);
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        // a broken subscriber must not break the emitter
      }
    }
  }

  return {
    /**
     * @param {string} type  e.g. 'mqtt.publish', 'intake.refused', 'ledger.posting'
     * @param {object} [data]
     * @param {string|null} [school] school code the event belongs to, if any
     */
    emit(type, data = {}, school = null) {
      // the context of the code that emitted it, even when delivery waits for a commit
      const context = { ...(store.getStore() ?? {}) };
      if (db && db.inTransaction()) db.afterCommit(() => deliver(type, data, school, context));
      else deliver(type, data, school, context);
    },
    /** @returns {() => void} unsubscribe */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** Events with seq greater than `afterSeq`, optionally only one school's. */
    since(afterSeq = 0, school = undefined) {
      return recent.filter((e) => e.seq > afterSeq && (school === undefined || e.school === null || e.school === school));
    },
    lastSeq() {
      return seq;
    },

    /**
     * Run `fn` with the current context plus `patch` ({ trace?, msgId? }); events it emits,
     * now or after any await, carry those fields.
     * @template T
     * @param {{ trace?: string, msgId?: string }} patch
     * @param {() => T} fn
     * @returns {T}
     */
    withContext(patch, fn) {
      return store.run({ ...(store.getStore() ?? {}), ...cleanContext(patch) }, fn);
    },
    /** The current context ({ trace?, msgId? }), or null outside any. */
    context() {
      const current = store.getStore();
      return current && Object.keys(current).length > 0 ? { ...current } : null;
    },
    /**
     * Run `fn` with no context: for MQTT clients, servers and timers that outlive the
     * action that creates them.
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    untraced(fn) {
      return store.run({}, fn);
    },
    /**
     * `fn(event)` sees every event before it is kept and sent out, and may add `trace`
     * (the lab's tracer links a message's later events to the flow that sent it).
     * @param {((event: object) => void) | null} fn
     */
    setEnricher(fn) {
      if (fn !== null && typeof fn !== 'function') throw new TypeError('the enricher must be a function or null');
      enricher = fn;
    },
  };
}
