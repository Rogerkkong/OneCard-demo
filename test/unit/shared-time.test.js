import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIso, klDay, klTime, inWindows } from '../../src/shared/time.js';

test('parseIso accepts real ISO-8601 instants, with Z or an offset', () => {
  assert.equal(parseIso('2026-10-05T02:00:00Z'), Date.UTC(2026, 9, 5, 2));
  assert.equal(parseIso('2026-10-05T10:00:00.250+08:00'), Date.UTC(2026, 9, 5, 2, 0, 0, 250));
  assert.equal(parseIso('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29));
});

test('parseIso refuses impossible dates and times instead of rolling them over', () => {
  for (const bad of [
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z', // 2026 is not a leap year
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-10-05T24:00:00Z',
    '2026-10-05T23:60:00Z',
    '2026-10-05T23:59:60Z',
    '2026-10-05T10:00:00+25:00',
    '2026-10-05T10:00:00+08:60',
    '2026-10-05 10:00:00Z',
    '2026-10-05T10:00Z',
    'yesterday',
    '',
  ]) {
    assert.ok(Number.isNaN(parseIso(bad)), bad);
  }
  assert.ok(Number.isNaN(parseIso(1759629600000)));
  assert.ok(Number.isNaN(parseIso(null)));
});

test('Kuala Lumpur day and time follow UTC+8', () => {
  const ms = Date.UTC(2026, 9, 5, 16, 0); // 00:00 on 6 October in KL
  assert.equal(klDay(ms), '2026-10-06');
  assert.equal(klTime(ms), '00:00');
  assert.equal(klDay(ms - 1), '2026-10-05');
  assert.equal(inWindows(Date.UTC(2026, 9, 5, 4, 30), [{ from: '12:00', to: '13:00' }]), true);
  assert.equal(inWindows(Date.UTC(2026, 9, 5, 5, 0), [{ from: '12:00', to: '13:00' }]), false);
  assert.equal(inWindows(Date.UTC(2026, 9, 5, 5, 0), []), true);
});
