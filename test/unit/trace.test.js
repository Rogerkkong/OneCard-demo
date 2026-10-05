import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCtx } from '../helpers.js';
import { createTracer, MAX_MESSAGE_IDS, MAX_SUBJECT_KEYS, MAX_SUBJECT_TEXT, TRACE_ID_RE } from '../../src/lab/trace.js';

// Traces (docs/DESIGN.md §11.3): a flow's events carry one trace id, also across the MQTT
// hop, where the tracer links a message's later events by its envelope id.

function setup(options = {}) {
  const ctx = createTestCtx();
  const tracer = createTracer(ctx.events, { clock: ctx.clock, ...options });
  return { ctx, events: ctx.events, tracer };
}

const typesOf = (tracer, id) => tracer.get(id).events.map((e) => e.type);

test('needs the event bus and the clock', () => {
  const ctx = createTestCtx();
  assert.throws(() => createTracer({}, { clock: ctx.clock }), /event bus/);
  assert.throws(() => createTracer(ctx.events, {}), /clock/);
  assert.throws(() => createTracer(ctx.events, { clock: ctx.clock, keepTraces: 0 }), /keepTraces/);
  assert.throws(() => createTracer(ctx.events, { clock: ctx.clock, keepEvents: 1.5 }), /keepEvents/);
  ctx.db.close();
});

test('begin announces the trace inside it; run tags everything the action causes, also after awaits', async () => {
  const { ctx, events, tracer } = setup();
  const { trace, result } = tracer.run({ kind: 'tap', title: 'Tap 04A1 on CANTEEN-01', school: 'smk-alpha', device: 'CANTEEN-01' }, async () => {
    events.emit('card.write', { device: 'CANTEEN-01' }, 'smk-alpha');
    await new Promise((r) => setTimeout(r, 2));
    events.emit('device.screen', { device: 'CANTEEN-01' }, 'smk-alpha');
    return 'done';
  });
  assert.match(trace, TRACE_ID_RE);
  assert.equal(await result, 'done');
  events.emit('mqtt.connect', {}, 'smk-alpha'); // after the action: not part of it
  assert.deepEqual(typesOf(tracer, trace), ['sim.trace', 'card.write', 'device.screen']);
  const [announce] = tracer.get(trace).events;
  assert.deepEqual(announce.data, { id: trace, n: 1, kind: 'tap', title: 'Tap 04A1 on CANTEEN-01', device: 'CANTEEN-01', subject: {} });
  assert.equal(announce.school, 'smk-alpha');
  assert.equal(announce.trace, trace);
  ctx.db.close();
});

test('a message sent inside a trace brings its later events along, wherever they are emitted', () => {
  const { ctx, events, tracer } = setup();
  const { trace } = tracer.run({ kind: 'tap', title: 'Tap' }, () => {
    events.emit('device.send', { device: 'CANTEEN-01', msgId: 'm-1', type: 'sale.recorded' }, 'smk-alpha');
  });
  // outside any context: the broker (by data.msgId) and the platform (by its msgId context)
  events.emit('mqtt.publish', { msgId: 'm-1', topic: 't' }, 'smk-alpha');
  events.withContext({ msgId: 'm-1' }, () => {
    events.emit('intake.accepted', { device: 'CANTEEN-01' }, 'smk-alpha');
    events.emit('ledger.posting', { amountSen: 350 }, 'smk-alpha');
  });
  events.emit('device.acked', { msgId: 'm-1', ok: true }, 'smk-alpha');
  // someone else's message stays out
  events.emit('mqtt.publish', { msgId: 'm-other' }, 'smk-alpha');
  assert.deepEqual(typesOf(tracer, trace), ['sim.trace', 'device.send', 'mqtt.publish', 'intake.accepted', 'ledger.posting', 'device.acked']);
  assert.equal(tracer.traceOfMessage('m-1'), trace);
  assert.equal(tracer.traceOfMessage('m-other'), null);
  ctx.db.close();
});

test('a command sent in a flow brings the machine\'s acknowledgement and its handling along', () => {
  const { ctx, events, tracer } = setup();
  const { trace } = tracer.run({ kind: 'request', title: 'School office: POST /api/admin/configs/prices' }, () => {
    events.emit('platform.send', { msgId: 'cmd-1', type: 'config.prices' }, 'smk-alpha');
  });
  // the machine takes the command and acknowledges it from its own (untraced) connection
  events.emit('device.received', { msgId: 'cmd-1', result: 'APPLIED' }, 'smk-alpha');
  events.emit('device.send', { msgId: 'ack-1', type: 'command.ack', inReplyTo: 'cmd-1' }, 'smk-alpha');
  events.withContext({ msgId: 'ack-1' }, () => events.emit('intake.accepted', { type: 'command.ack' }, 'smk-alpha'));
  assert.deepEqual(typesOf(tracer, trace), ['sim.trace', 'platform.send', 'device.received', 'device.send', 'intake.accepted']);
  ctx.db.close();
});

test('a message sent again in a later flow joins the later flow', () => {
  const { ctx, events, tracer } = setup();
  const first = tracer.run({ kind: 'tap', title: 'Tap' }, () => events.emit('device.send', { msgId: 'm-1' })).trace;
  const again = tracer.run({ kind: 'fault', title: 'Send the same message again' }, () => events.emit('device.send', { msgId: 'm-1' })).trace;
  events.emit('intake.duplicate', {}, null);
  events.withContext({ msgId: 'm-1' }, () => events.emit('intake.duplicate', {}, null));
  assert.deepEqual(typesOf(tracer, first), ['sim.trace', 'device.send']);
  assert.deepEqual(typesOf(tracer, again), ['sim.trace', 'device.send', 'intake.duplicate']);
  ctx.db.close();
});

test('nested runs are separate traces; the outer one carries on after the inner one', () => {
  const { ctx, events, tracer } = setup();
  let inner;
  const { trace: outer } = tracer.run({ kind: 'console', title: 'Console' }, () => {
    events.emit('a');
    inner = tracer.run({ kind: 'tap', title: 'Tap' }, () => events.emit('b')).trace;
    events.emit('c');
  });
  assert.deepEqual(typesOf(tracer, outer), ['sim.trace', 'a', 'c']);
  assert.deepEqual(typesOf(tracer, inner), ['sim.trace', 'b']);
  ctx.db.close();
});

test('list: newest first with counts; get: null for unknown ids; numbering restarts after clear', () => {
  const { ctx, events, tracer } = setup();
  const a = tracer.run({ kind: 'tap', title: 'First', school: 'smk-alpha', device: 'CANTEEN-01' }, () => events.emit('x')).trace;
  ctx.clock.advance(1000);
  const b = tracer.run({ kind: 'cable', title: 'Second' }, () => {}).trace;
  const list = tracer.list();
  assert.deepEqual(list.map((t) => [t.id, t.n, t.kind, t.title, t.events]), [[b, 2, 'cable', 'Second', 1], [a, 1, 'tap', 'First', 2]]);
  assert.equal(list[1].school, 'smk-alpha');
  assert.equal(list[1].device, 'CANTEEN-01');
  assert.equal(list[0].at, ctx.clock.now());
  assert.deepEqual(tracer.list({ limit: 1 }).map((t) => t.id), [b]);
  assert.equal(tracer.get('tr_nope'), null);
  assert.equal(tracer.get(42), null);
  assert.equal(tracer.has(a), true);
  assert.equal(tracer.has('tr_nope'), false);
  tracer.clear();
  assert.deepEqual(tracer.list(), []);
  assert.equal(tracer.has(a), false);
  assert.equal(tracer.run({ kind: 'tap', title: 'Again' }, () => {}).trace !== a, true);
  assert.equal(tracer.list()[0].n, 1);
  ctx.db.close();
});

test('keeps the most recent traces, and per trace its first event and most recent steps', () => {
  const { ctx, events, tracer } = setup({ keepTraces: 2, keepEvents: 4 });
  const ids = [1, 2, 3].map((i) => tracer.run({ kind: 'tap', title: `T${i}` }, () => events.emit('device.send', { msgId: `m-${i}` })).trace);
  assert.equal(tracer.has(ids[0]), false);
  assert.deepEqual(tracer.list().map((t) => t.title), ['T3', 'T2']);
  // a dropped trace's message no longer links anything
  events.emit('mqtt.publish', { msgId: 'm-1' });
  assert.equal(events.since(0).at(-1).trace, undefined);
  const long = tracer.run({ kind: 'tap', title: 'Long' }, () => {
    for (let i = 0; i < 10; i++) events.emit(`step-${i}`);
  }).trace;
  const kept = tracer.get(long);
  assert.deepEqual(kept.events.map((e) => e.type), ['sim.trace', 'step-7', 'step-8', 'step-9']);
  assert.equal(kept.trace.events, 11, 'the count says how many there were');
  ctx.db.close();
});

test('remembers a bounded number of message ids, forgetting the oldest', () => {
  const { ctx, events, tracer } = setup();
  const { trace } = tracer.run({ kind: 'upload', title: 'Many messages' }, () => {
    for (let i = 0; i <= MAX_MESSAGE_IDS; i++) events.emit('device.send', { msgId: `m-${i}` });
  });
  assert.equal(tracer.traceOfMessage('m-0'), null);
  assert.equal(tracer.traceOfMessage(`m-${MAX_MESSAGE_IDS}`), trace);
  ctx.db.close();
});

test('a subject names what the flow is about: in sim.trace, list() and get(), {} when none, a copy every time', () => {
  const { ctx, tracer } = setup();
  const subject = { uid: '04A1B2C3D4E5F6', cardSchool: 'smk-alpha', school: 'smk-alpha', device: 'CANTEEN-01', items: 'NASI-LEMAK TEH-TARIK*2' };
  const given = { ...subject };
  const tap = tracer.run({ kind: 'tap', title: 'Tap', school: 'smk-alpha', device: 'CANTEEN-01', subject: given }, () => {}).trace;
  given.uid = 'changed afterwards'; // the tracer keeps its own copy
  const jobs = tracer.run({ kind: 'jobs', title: 'Run the jobs' }, () => {}).trace;
  const clock = tracer.run({ kind: 'clock', title: 'Clock', subject: { ms: 60_000, held: false } }, () => {}).trace;

  assert.deepEqual(tracer.get(tap).events[0].data.subject, subject, 'sim.trace carries it');
  assert.deepEqual(tracer.get(tap).trace.subject, subject);
  assert.deepEqual(tracer.get(jobs).events[0].data.subject, {}, 'always there: {} when none');
  assert.deepEqual(tracer.list().map((t) => [t.kind, t.subject]), [['clock', { ms: 60_000, held: false }], ['jobs', {}], ['tap', subject]]);
  // what a reader gets is a copy
  tracer.list()[0].subject.ms = 1;
  tracer.get(clock).trace.subject.ms = 2;
  assert.equal(tracer.get(clock).trace.subject.ms, 60_000);
  assert.equal(tracer.takesSubject, true, 'server.js gives request subjects to a tracer that says so');
  ctx.db.close();
});

test('a subject is a flat object of a few short names, each a short text, a number or true/false; anything else is a TypeError', () => {
  const { ctx, tracer } = setup();
  const meta = (subject) => ({ kind: 'tap', title: 'Tap', subject });
  const full = Object.fromEntries(Array.from({ length: MAX_SUBJECT_KEYS }, (_, i) => [`k${i}`, i]));
  const longest = 'x'.repeat(MAX_SUBJECT_TEXT);
  for (const ok of [{}, full, { path: longest, empty: '', zero: 0, negative: -1.5, yes: true, no: false }, Object.assign(Object.create(null), { a: 1 })]) {
    assert.doesNotThrow(() => tracer.begin(meta(ok)), JSON.stringify(ok));
  }
  const bad = [
    null,
    'smk-alpha',
    42,
    ['school'],
    new Map([['school', 'smk-alpha']]),
    new Date(0),
    { ...full, one: 'too many' },
    { path: `${longest}x` },
    { nested: { school: 'smk-alpha' } },
    { list: ['a'] },
    { nothing: null },
    { missing: undefined },
    { nan: Number.NaN },
    { inf: Number.POSITIVE_INFINITY },
    { big: 10n },
    { fn: () => {} },
    { 'not an identifier': 1 },
    { '1st': 1 },
    { _hidden: 1 },
    { [`k${'x'.repeat(32)}`]: 1 },
    { [Symbol('s')]: 1 },
  ];
  for (const subject of bad) assert.throws(() => tracer.begin(meta(subject)), TypeError, String(subject?.toString?.() ?? subject));
  assert.equal(tracer.list().length, 4, 'a refused subject starts no trace');
  ctx.db.close();
});

test('bad trace descriptions are TypeErrors; close stops following the bus', () => {
  const { ctx, events, tracer } = setup();
  for (const meta of [null, {}, { kind: '', title: 'x' }, { kind: 'tap', title: '  ' }, { kind: 'x'.repeat(41), title: 't' }, { kind: 'tap', title: 't', school: 5 }]) {
    assert.throws(() => tracer.begin(meta), TypeError, JSON.stringify(meta));
  }
  assert.throws(() => tracer.run({ kind: 'tap', title: 't' }), TypeError);
  const { trace } = tracer.run({ kind: 'tap', title: 'Before close' }, () => events.emit('device.send', { msgId: 'm-1' }));
  tracer.close();
  events.emit('mqtt.publish', { msgId: 'm-1' });
  assert.equal(events.since(0).at(-1).trace, undefined, 'no enricher after close');
  assert.equal(tracer.has(trace), false);
  ctx.db.close();
});
