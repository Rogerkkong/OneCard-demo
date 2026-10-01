import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, validateEnvelopeShape, UP_TYPES, DOWN_TYPES } from '../../src/shared/protocol.js';

const envelope = (type) => ({
  ...buildEnvelope({ school: 'smk-alpha', device: 'CANTEEN-01', seq: 1, at: '2026-10-05T02:00:00.000Z', type, body: {} }),
  sig: 'x'.repeat(43),
});

test('every message type in the tables passes the shape check', () => {
  for (const type of [...Object.keys(UP_TYPES), ...Object.keys(DOWN_TYPES)]) {
    assert.deepEqual(validateEnvelopeShape(envelope(type)), { ok: true }, type);
  }
});

test('names inherited from Object are not message types', () => {
  for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'sale.unknown', '']) {
    const result = validateEnvelopeShape(envelope(type));
    assert.equal(result.ok, false, type);
    assert.equal(result.code, 'UNKNOWN_TYPE', type);
  }
});
