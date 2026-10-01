// Kuala Lumpur time helpers. Malaysia is UTC+8 all year (no daylight saving),
// so a fixed offset is exact.
export const KL_OFFSET_MS = 8 * 60 * 60 * 1000;
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 'YYYY-MM-DD' of the given instant in Kuala Lumpur. */
export function klDay(ms) {
  return new Date(ms + KL_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM' of the given instant in Kuala Lumpur. */
export function klMonth(ms) {
  return klDay(ms).slice(0, 7);
}

/** 'HH:MM' of the given instant in Kuala Lumpur. */
export function klTime(ms) {
  return new Date(ms + KL_OFFSET_MS).toISOString().slice(11, 16);
}

/** Minutes since midnight in Kuala Lumpur. */
export function klMinutes(ms) {
  const d = new Date(ms + KL_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 'DD/MM/YYYY HH:MM' in Kuala Lumpur, the format the product uses. */
export function formatKL(ms) {
  const iso = new Date(ms + KL_OFFSET_MS).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse 'HH:MM' (24-hour) to minutes since midnight; throws on bad input. */
export function parseHHMM(text) {
  const m = HHMM.exec(String(text));
  if (!m) throw new RangeError(`time must be HH:MM, got ${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isHHMM(text) {
  return HHMM.test(String(text));
}

/**
 * True when the instant falls inside one of the windows ({from, to} as 'HH:MM',
 * from inclusive, to exclusive, Kuala Lumpur time). No windows means no time limit.
 */
export function inWindows(ms, windows) {
  if (!windows || windows.length === 0) return true;
  const m = klMinutes(ms);
  return windows.some((w) => m >= parseHHMM(w.from) && m < parseHHMM(w.to));
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/;

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Strict ISO-8601 timestamp (with Z or an offset) to ms; NaN if invalid.
 * Impossible dates and times (30 February, 24:00, minute 60, offset +25:00) are invalid,
 * rather than silently rolled over to another moment as Date.parse would do.
 */
export function parseIso(text) {
  if (typeof text !== 'string') return NaN;
  const m = ISO.exec(text);
  if (!m) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return NaN;
  if (hour > 23 || minute > 59 || second > 59) return NaN;
  if (m[9] && (Number(m[10]) > 23 || Number(m[11]) > 59)) return NaN;
  return Date.parse(text);
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}
