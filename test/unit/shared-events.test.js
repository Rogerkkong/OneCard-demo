import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/platform/db.js';
import { createClock } from '../../src/shared/clock.js';
import { createEventBus } from '../../src/shared/events.js';

function setup() {
  const db = openDb(':memory:');
  const clock = createClock({ mode: 'manual' });
  const events = createEventBus({ clock, db });
  const seen = [];
  events.subscribe((e) => seen.push(e.type));
  return { db, events, seen };
}

test('outside a transaction an event is delivered at once', () => {
  const { db, events, seen } = setup();
  events.emit('a');
  assert.deepEqual(seen, ['a']);
  db.close();
});

test('inside a transaction events wait for the commit, in order', () => {
  const { db, events, seen } = setup();
  db.tx(() => {
    events.emit('a');
    db.tx(() => events.emit('b'));
    assert.deepEqual(seen, [], 'nothing is delivered before the commit');
    events.emit('c');
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual(events.since(0).map((e) => [e.seq, e.type]), [[1, 'a'], [2, 'b'], [3, 'c']]);
  db.close();
});

test('a rolled-back transaction delivers nothing', () => {
  const { db, events, seen } = setup();
  assert.throws(() =>
    db.tx(() => {
      events.emit('a');
      throw new Error('boom');
    }),
  );
  assert.deepEqual(seen, []);
  assert.equal(events.lastSeq(), 0);
  db.close();
});

test('a rolled-back savepoint drops only its own events', () => {
  const { db, events, seen } = setup();
  db.tx(() => {
    events.emit('outer-before');
    try {
      db.tx(() => {
        events.emit('inner');
        db.tx(() => events.emit('inner-inner'));
        throw new Error('inner fails');
      });
    } catch {
      // handled by the outer transaction
    }
    db.tx(() => events.emit('sibling'));
    events.emit('outer-after');
  });
  assert.deepEqual(seen, ['outer-before', 'sibling', 'outer-after']);
  db.close();
});

test('afterCommit outside a transaction runs at once; a throwing callback does not break the commit', () => {
  const { db, seen } = setup();
  let ran = 0;
  db.afterCommit(() => ran++);
  assert.equal(ran, 1);
  db.tx(() => {
    db.run('CREATE TABLE t (x INTEGER)');
    db.afterCommit(() => {
      throw new Error('subscriber bug');
    });
    db.afterCommit(() => ran++);
  });
  assert.equal(ran, 2, 'later callbacks still run');
  assert.deepEqual(db.all('SELECT * FROM t'), []);
  assert.deepEqual(seen, []);
  db.close();
});

// ---- context (Simulation mode, docs/DESIGN.md §11.1) -----------------------------------

/** A bus that keeps the whole events, not just their types. */
function traced() {
  const db = openDb(':memory:');
  const clock = createClock({ mode: 'manual' });
  const events = createEventBus({ clock, db });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  return { db, events, seen };
}

test('an event outside any context is exactly as before: no trace, no msgId', () => {
  const { db, events, seen } = traced();
  events.emit('a', { x: 1 }, 'smk-alpha');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['at', 'data', 'school', 'seq', 'type']);
  assert.equal(events.context(), null);
  db.close();
});

test('withContext: events carry the trace and msgId, also after awaits and timers', async () => {
  const { db, events, seen } = traced();
  const result = await events.withContext({ trace: 'tr_1' }, async () => {
    events.emit('first');
    await new Promise((r) => setTimeout(r, 5));
    events.emit('after-a-timer');
    await events.withContext({ msgId: 'm-1' }, async () => {
      await Promise.resolve();
      events.emit('inner');
      assert.deepEqual(events.context(), { trace: 'tr_1', msgId: 'm-1' });
    });
    events.emit('back-outside-the-inner');
    return 42;
  });
  assert.equal(result, 42);
  events.emit('after-the-run');
  assert.deepEqual(
    seen.map((e) => [e.type, e.trace ?? null, e.msgId ?? null]),
    [
      ['first', 'tr_1', null],
      ['after-a-timer', 'tr_1', null],
      ['inner', 'tr_1', 'm-1'],
      ['back-outside-the-inner', 'tr_1', null],
      ['after-the-run', null, null],
    ],
  );
  db.close();
});

test('withContext keeps only trace and msgId, and only non-empty strings', () => {
  const { db, events, seen } = traced();
  events.withContext({ trace: 'tr_2', msgId: '', school: 'x', extra: { a: 1 } }, () => events.emit('a'));
  events.withContext({ trace: 42 }, () => events.emit('b'));
  assert.deepEqual([seen[0].trace, 'msgId' in seen[0], 'school' in seen[0] && seen[0].school], ['tr_2', false, null]);
  assert.equal('trace' in seen[1], false);
  db.close();
});

test('the context is taken when the event is emitted, even when a transaction delays its delivery', () => {
  const { db, events, seen } = traced();
  db.tx(() => {
    events.withContext({ trace: 'tr_tx' }, () => events.emit('inside'));
    events.emit('untraced-in-the-same-transaction');
  });
  assert.deepEqual(seen.map((e) => [e.type, e.trace ?? null]), [['inside', 'tr_tx'], ['untraced-in-the-same-transaction', null]]);
  db.close();
});

test('untraced: a timer created inside it never inherits the surrounding trace', async () => {
  const { db, events, seen } = traced();
  let fired;
  const done = new Promise((r) => (fired = r));
  events.withContext({ trace: 'tr_3' }, () => {
    events.untraced(() => {
      // a long-lived resource made while a traced action runs (a heartbeat interval, an MQTT client)
      setTimeout(() => {
        events.emit('later-tick');
        fired();
      }, 5);
    });
    setTimeout(() => events.emit('traced-tick'), 1);
  });
  await done;
  await new Promise((r) => setTimeout(r, 5));
  const byType = Object.fromEntries(seen.map((e) => [e.type, e.trace ?? null]));
  assert.deepEqual(byType, { 'later-tick': null, 'traced-tick': 'tr_3' });
  db.close();
});

test('setEnricher: may add a trace before subscribers and since() see the event; a throwing one is ignored', () => {
  const { db, events, seen } = traced();
  events.setEnricher((e) => {
    if (e.data?.msgId === 'known') e.trace = 'tr_from_msg';
  });
  events.emit('a', { msgId: 'known' });
  events.emit('b', { msgId: 'other' });
  assert.deepEqual(seen.map((e) => e.trace ?? null), ['tr_from_msg', null]);
  assert.equal(events.since(0)[0].trace, 'tr_from_msg');
  events.setEnricher(() => {
    throw new Error('broken');
  });
  events.emit('c');
  assert.equal(seen.at(-1).type, 'c');
  events.setEnricher(null);
  assert.throws(() => events.setEnricher('nope'), TypeError);
  db.close();
});

test('parallel traced flows keep their own traces', async () => {
  const { db, events, seen } = traced();
  const flow = (trace, ms) =>
    events.withContext({ trace }, async () => {
      events.emit(`${trace}-start`);
      await new Promise((r) => setTimeout(r, ms));
      events.emit(`${trace}-end`);
    });
  await Promise.all([flow('tr_a', 10), flow('tr_b', 1)]);
  for (const e of seen) assert.equal(e.trace, e.type.slice(0, 4), e.type);
  db.close();
});
