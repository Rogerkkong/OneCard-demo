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
