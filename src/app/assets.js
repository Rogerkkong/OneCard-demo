import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The web apps of the single-file desktop app (docs/DESIGN.md §13). scripts/build-sea.mjs stores
// every file under web/ as a Node single-executable-application asset, plus a manifest (keys,
// sizes, a content hash). At start the app unpacks them once per version into
// <os temp>/onecard-lab-<version>-<hash>/web/ and serves that folder.
//
// The unpacked folder appears in one step: the files are written into a private temporary folder
// that is then renamed into place, so a copy starting at the same moment, or a crash half-way,
// never leaves a half-written folder that someone uses. A folder that is already there is used
// only if every file is still there with its size (temp cleaners delete old files) and it
// belongs to this user.

/** Asset key of the manifest; the web apps' keys are 'web/<path>'. */
export const MANIFEST_KEY = 'manifest.json';

/** Written into every unpacked folder: which manifest it was unpacked from. */
const MARKER = '.onecard-lab-manifest.json';

const KEY_RE = /^web\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The temp folder cannot be written (read-only, full, missing): worded for the person. */
export class UnpackError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UnpackError';
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * The manifest of a set of web files (the build makes it; the app checks against it).
 * @param {{ name?: string, version: string, files: Array<{ key: string, data: Uint8Array }> }} input
 *   keys like 'web/lab/index.html'
 * @returns {{ name: string, version: string, hash: string, files: Array<{ key: string, size: number, sha256: string }> }}
 *   `hash`: 16 hex characters over every key, size and content, so any change gets a new folder
 */
export function makeManifest({ name = 'onecard-lab', version, files }) {
  const list = files
    .map(({ key, data }) => ({ key, size: data.length, sha256: sha256(data) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const hash = sha256(list.map((f) => `${f.key}\0${f.size}\0${f.sha256}\n`).join('')).slice(0, 16);
  return checkManifest({ name, version, hash, files: list });
}

/**
 * Check a manifest before its keys become file paths.
 * @returns {object} the manifest
 */
export function checkManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') throw new TypeError('the manifest must be an object');
  const { name, version, hash, files } = manifest;
  for (const [field, value] of [['name', name], ['version', version], ['hash', hash]]) {
    if (typeof value !== 'string' || !LABEL_RE.test(value)) throw new TypeError(`manifest ${field} must be letters, digits, dots and dashes`);
  }
  if (!Array.isArray(files) || files.length === 0) throw new TypeError('the manifest lists no files');
  const seen = new Set();
  for (const file of files) {
    // no '..', no absolute paths, nothing outside web/
    if (typeof file?.key !== 'string' || !KEY_RE.test(file.key) || file.key.split('/').includes('..')) {
      throw new TypeError(`manifest key ${JSON.stringify(file?.key)} is not a web/ file path`);
    }
    // case-insensitive: Windows and macOS would write both names into one file
    if (seen.has(file.key.toLowerCase())) throw new TypeError(`manifest key ${file.key} is listed twice`);
    seen.add(file.key.toLowerCase());
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new TypeError(`manifest size of ${file.key} must be a whole number`);
  }
  return manifest;
}

/** The folder a manifest unpacks into, inside `tmpDir`. */
export function unpackFolder(manifest, tmpDir = tmpdir()) {
  return join(tmpDir, `${manifest.name}-${manifest.version}-${manifest.hash}`);
}

const fileOf = (root, key) => join(root, ...key.split('/'));

/**
 * Safe to serve from: on Windows and macOS the temp folder is the user's own; on Linux /tmp is
 * shared, so the folder must be this user's and writable by nobody else.
 */
function trusted(stat) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
  return stat.uid === process.getuid() && (stat.mode & 0o022) === 0;
}

/** Whether `folder` holds every file of the manifest, with its size, and may be used. */
export function isComplete(folder, manifest) {
  try {
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || !trusted(stat)) return false;
    const marker = JSON.parse(readFileSync(join(folder, MARKER), 'utf8'));
    if (marker?.hash !== manifest.hash || marker?.version !== manifest.version) return false;
    for (const file of manifest.files) {
      const s = statSync(fileOf(folder, file.key));
      if (!s.isFile() || s.size !== file.size) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A short synchronous pause (start-up code): lets a Windows virus scanner let go of new files. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// What renaming onto a folder that is already there (or busy, on Windows) fails with.
const RACE_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY']);

/**
 * Put the complete `staging` folder in place as `final`, racing other copies of the app.
 * @returns {string} the folder to serve: `final`, or a private complete copy when `final` cannot be used
 */
function publish(staging, final, manifest) {
  const discard = (folder) => rmSync(folder, { recursive: true, force: true });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      renameSync(staging, final);
      return final;
    } catch (err) {
      if (!RACE_CODES.has(err?.code)) return staging;
    }
    // Another copy got there first: use its folder (it was complete when it was renamed).
    if (isComplete(final, manifest)) {
      discard(staging);
      return final;
    }
    let stat = null;
    try {
      stat = lstatSync(final);
    } catch {
      // not there: on Windows a virus scanner may hold a file of the new folder for a moment
    }
    if (stat && !trusted(stat)) return staging; // someone else's folder of that name: serve ours
    if (!stat) {
      pause(50 * attempt);
      continue;
    }
    // A damaged copy (a temp cleaner took some of its files): move it aside and take its place.
    const aside = `${final}.old-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(final, aside);
    } catch {
      pause(50 * attempt); // moved by another copy, or busy on Windows
      continue;
    }
    if (!isComplete(aside, manifest)) {
      discard(aside);
      continue;
    }
    // ...unless another copy had just put a good one there: give it back (it may be serving it).
    try {
      renameSync(aside, final);
    } catch {
      discard(staging);
      return aside;
    }
  }
  return staging;
}

/** An asset as bytes, checked against the manifest. */
function assetBytes(readAsset, file) {
  const data = readAsset(file.key);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length !== file.size) throw new Error(`the app's copy of ${file.key} is damaged (${bytes.length} bytes, expected ${file.size})`);
  return bytes;
}

/**
 * Unpack the web apps once per version and return the folder to serve (`…/web`).
 * @param {object} options
 * @param {object} options.manifest  from makeManifest(), as stored in the app
 * @param {(key: string) => ArrayBuffer|Uint8Array} options.readAsset  e.g. node:sea getAsset
 * @param {string} [options.tmpDir]  default: the OS temp folder
 * @returns {string} the web root
 * @throws {UnpackError} when the temp folder cannot be written (read-only, full, missing)
 */
export function unpackWebApps({ manifest, readAsset, tmpDir = tmpdir() }) {
  checkManifest(manifest);
  const final = unpackFolder(manifest, tmpDir);
  if (isComplete(final, manifest)) return join(final, 'web');

  // Read first: a missing or damaged asset is a problem of the build, not of the disk.
  const files = manifest.files.map((file) => ({ file, bytes: assetBytes(readAsset, file) }));
  let staging = null;
  try {
    // private (0700) and a name nobody else uses: a crash leaves it behind, never half in use
    staging = mkdtempSync(`${final}.part-`);
    for (const { file, bytes } of files) {
      const target = fileOf(staging, file.key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    writeFileSync(join(staging, MARKER), JSON.stringify({ name: manifest.name, version: manifest.version, hash: manifest.hash }));
  } catch (err) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    throw new UnpackError(
      `Could not unpack the web apps into ${tmpDir}: ${reason(err)}. Free some disk space, or set ` +
        `${process.platform === 'win32' ? 'TEMP' : 'TMPDIR'} to a folder you can write to, and start the app again.`,
      err,
    );
  }
  return join(publish(staging, final, manifest), 'web');
}

function reason(err) {
  switch (err?.code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'the disk is full';
    case 'EACCES':
    case 'EPERM':
      return 'no permission to write there';
    case 'EROFS':
      return 'the folder is read-only';
    case 'ENOENT':
    case 'ENOTDIR':
      return 'the folder does not exist';
    default:
      return err?.message ?? String(err);
  }
}
