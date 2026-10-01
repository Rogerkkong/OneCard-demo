import { canonicalJson, hmacB64url, safeEqual } from '../shared/crypto.js';
import { DEVICE_CODE_RE, SCHOOL_CODE_RE } from '../shared/protocol.js';
import { parseIso } from '../shared/time.js';

// USB export of a machine's journal (docs/DESIGN.md §6): the way records leave a machine
// that has no network, besides kiosk read-backs and plugging the cable in. Staff copy the
// file to a stick and import it in the school office. The file is signed with the
// machine's own secret, so the platform can tell an untouched export from an edited one;
// the records inside are still checked one by one on import, like any other upload.
//
// File: { format, school, device, exportedAt, count, records, sig }
// sig = hmacB64url(device secret, canonicalJson(file without sig)), so it survives any
// re-formatting of the JSON on the way.

export const JOURNAL_FORMAT = 'onecard-lab-journal/1';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const matches = (re) => (v) => typeof v === 'string' && re.test(v);
const isSchoolCode = matches(SCHOOL_CODE_RE);
const isDeviceCode = matches(DEVICE_CODE_RE);
const isHexSecret = matches(/^[0-9a-f]{32,}$/i); // same rule as shared/crypto.js

// Deep copy of plain JSON. canonicalJson throws TypeError for anything else (a function, a
// Date, NaN): the file holds exactly the records its signature covers.
function jsonCopy(value) {
  canonicalJson(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Build the signed export file of a machine's journal records.
 * @param {{ schoolCode: string, deviceCode: string, secret: string, records: object[], exportedAt: string }} args
 *   secret: the device secret (hex); exportedAt: ISO-8601 (lab clock)
 * @returns {{ format: string, school: string, device: string, exportedAt: string, count: number, records: object[], sig: string }}
 *   Malformed arguments (records that are not plain JSON objects included) are a TypeError.
 */
export function exportJournal({ schoolCode, deviceCode, secret, records, exportedAt } = {}) {
  if (!isSchoolCode(schoolCode)) throw new TypeError('schoolCode must be a school code such as smk-contoh');
  if (!isDeviceCode(deviceCode)) throw new TypeError('deviceCode must be a device code such as CANTEEN-02');
  if (!isHexSecret(secret)) throw new TypeError('secret must be the device secret (hex, at least 16 bytes)');
  if (!Array.isArray(records) || !records.every(isPlainObject)) throw new TypeError('records must be an array of record objects');
  if (Number.isNaN(parseIso(exportedAt))) throw new TypeError('exportedAt must be an ISO-8601 timestamp');
  const file = {
    format: JOURNAL_FORMAT,
    school: schoolCode,
    device: deviceCode,
    exportedAt,
    count: records.length,
    records: jsonCopy(records),
  };
  return { ...file, sig: hmacB64url(secret, canonicalJson(file)) };
}

/**
 * True when the file is a journal export signed with this device secret and not changed
 * since. Never throws: anything malformed (or a malformed secret) is simply false.
 * The file comes from a request body, so the importer refuses a file whose `school` is not
 * the signed-in staff member's school, looks `file.device` up in that school only, verifies
 * with that device's secret, then checks each record like any other upload.
 * @param {unknown} file
 * @param {string} secret  device secret (hex)
 * @returns {boolean}
 */
export function verifyJournalFile(file, secret) {
  if (!isPlainObject(file) || typeof file.sig !== 'string') return false;
  const { sig, ...rest } = file;
  if (rest.format !== JOURNAL_FORMAT) return false;
  if (!isSchoolCode(rest.school) || !isDeviceCode(rest.device)) return false;
  if (Number.isNaN(parseIso(rest.exportedAt))) return false;
  if (!Array.isArray(rest.records) || rest.count !== rest.records.length) return false;
  try {
    return safeEqual(sig, hmacB64url(secret, canonicalJson(rest)));
  } catch {
    return false;
  }
}
