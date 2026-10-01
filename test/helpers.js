// Shared test helpers. Tests use node:test (`node --test`), no extra libraries.
import { openDb } from '../src/platform/db.js';
import { createClock } from '../src/shared/clock.js';
import { createEventBus } from '../src/shared/events.js';

/**
 * A fresh platform context: in-memory database, manual clock (stands still until
 * advanced), event bus, and lab settings.
 */
export function createTestCtx({ startAt } = {}) {
  const clock = createClock({ mode: 'manual', ...(startAt ? { startAt } : {}) });
  const db = openDb(':memory:');
  // events emitted inside a transaction are delivered after it commits (see events.js)
  const events = createEventBus({ clock, keep: 5000, db });
  return {
    db,
    clock,
    events,
    settings: {
      providerSecret: 'aa'.repeat(32),
      platformBrokerPassword: 'bb'.repeat(32),
      viewer: { username: 'viewer', password: 'viewer' },
      heartbeatOnlineMs: 90_000,
    },
    log: () => {},
  };
}

/** Poll `predicate` until it returns a truthy value (returned) or the timeout passes. */
export async function waitFor(predicate, { timeout = 3000, interval = 10, message = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Events of a type recorded so far. */
export function eventsOf(ctx, type) {
  return ctx.events.since(0).filter((e) => e.type === type);
}
