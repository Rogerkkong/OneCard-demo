// The lab clock is the only source of "now" for platform and devices.
// - real mode: follows wall-clock time from `startAt`, plus any time added with advance()
// - manual mode: stands still until advance() is called (used by tests)
// Time only moves forward.

export const DEFAULT_LAB_START = Date.parse('2026-10-05T02:00:00.000Z'); // Mon 05/10/2026 10:00 in Kuala Lumpur

export function createClock({ startAt = DEFAULT_LAB_START, mode = 'real' } = {}) {
  if (mode !== 'real' && mode !== 'manual') throw new RangeError(`unknown clock mode ${mode}`);
  const realStart = Date.now();
  let offset = 0;
  let manualNow = startAt;
  return {
    mode,
    /** @returns {number} milliseconds since the Unix epoch */
    now() {
      return mode === 'manual' ? manualNow : startAt + (Date.now() - realStart) + offset;
    },
    /** @returns {string} ISO-8601 UTC timestamp */
    iso() {
      return new Date(this.now()).toISOString();
    },
    /** Move the clock forward by `ms` milliseconds. */
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance() needs a non-negative number of milliseconds');
      if (mode === 'manual') manualNow += ms;
      else offset += ms;
      return this.now();
    },
  };
}
