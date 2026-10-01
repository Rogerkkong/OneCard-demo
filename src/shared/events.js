// In-memory event bus. The lab console shows these events live (server-sent events),
// and tests use them to see what happened. Keeps the most recent `keep` events.
//
// Event: { seq, at (ISO, lab clock), type, school (code or null), data }
export function createEventBus({ clock, keep = 1000 } = {}) {
  let seq = 0;
  const recent = [];
  const subscribers = new Set();
  return {
    /**
     * @param {string} type  e.g. 'mqtt.publish', 'intake.refused', 'ledger.posting'
     * @param {object} [data]
     * @param {string|null} [school] school code the event belongs to, if any
     */
    emit(type, data = {}, school = null) {
      const event = { seq: ++seq, at: clock ? clock.iso() : new Date().toISOString(), type, school, data };
      recent.push(event);
      if (recent.length > keep) recent.splice(0, recent.length - keep);
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch {
          // a broken subscriber must not break the emitter
        }
      }
      return event;
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
  };
}
