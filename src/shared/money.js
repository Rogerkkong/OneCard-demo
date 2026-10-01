import { LabError } from './errors.js';

// All money is whole sen (1 ringgit = 100 sen). Never use floats for amounts.

export function isSen(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

export function assertSen(v, name = 'amount') {
  if (!isSen(v)) throw new LabError('AMOUNT_INVALID', `${name} must be a whole number of sen, 0 or more`);
  return v;
}

export function assertPositiveSen(v, name = 'amount') {
  if (!isSen(v) || v === 0) throw new LabError('AMOUNT_INVALID', `${name} must be a whole number of sen, more than 0`);
  return v;
}

/** 1250 -> 'RM 12.50', -100 -> '-RM 1.00' */
export function formatRM(sen) {
  const sign = sen < 0 ? '-' : '';
  const abs = Math.abs(sen);
  return `${sign}RM ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const RM_TEXT = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

/** '12.5' or '12.50' -> 1250. Throws AMOUNT_INVALID for anything else. */
export function parseRM(text) {
  const m = RM_TEXT.exec(String(text).trim());
  if (!m) throw new LabError('AMOUNT_INVALID', `not a ringgit amount: ${text}`);
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

/**
 * Water charge for `ml` millilitres at `perLitreSen` per litre:
 * round half up to the nearest sen, and at least `minChargeSen` for any water poured.
 * Integer arithmetic only.
 */
export function waterChargeSen(ml, perLitreSen, minChargeSen = 0) {
  if (!Number.isSafeInteger(ml) || ml < 0) throw new LabError('AMOUNT_INVALID', 'ml must be a whole number, 0 or more');
  assertSen(perLitreSen, 'perLitreSen');
  assertSen(minChargeSen, 'minChargeSen');
  if (ml === 0) return 0;
  const exact = Math.floor((ml * perLitreSen + 500) / 1000);
  return Math.max(exact, minChargeSen);
}

/** Largest number of ml affordable with `balanceSen` (before the minimum-charge rule). */
export function maxAffordableMl(balanceSen, perLitreSen, minChargeSen = 0) {
  assertSen(balanceSen, 'balanceSen');
  if (perLitreSen <= 0) return Number.MAX_SAFE_INTEGER;
  if (balanceSen < Math.max(minChargeSen, 1)) return 0;
  // largest ml with floor((ml*p + 500)/1000) <= balance  <=>  ml*p + 500 < (balance+1)*1000
  return Math.max(0, Math.floor(((balanceSen + 1) * 1000 - 500 - 1) / perLitreSen));
}
