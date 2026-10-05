// The single-file desktop app's entry (docs/DESIGN.md §13). scripts/build-sea.mjs bundles this
// file, the lab and its two libraries into one CommonJS script and injects it, with the web apps
// as assets, into a copy of the Node.js binary. No Node.js needs to be installed to run it.
//
// At start it unpacks the web apps once per version into the OS temp folder, then runs the same
// command line as `npm start` with that folder as webRoot and --open by default (--no-open turns
// it off). createLab() passes the lab's own routes to the web server, so nothing here needs
// import.meta.url, which a CommonJS bundle does not have.

// First, before anything loads node:sqlite (the bundle keeps this order; the build checks it).
import './quiet-warnings.js';
import { getAsset } from 'node:sea';
import { basename } from 'node:path';
import { MANIFEST_KEY, unpackWebApps } from './assets.js';
import { finish, main } from '../cli.js';

const argv = process.argv.slice(2); // a single executable repeats its own path as argv[1]
const how = {
  defaultOpen: true,
  app: true,
  program: basename(process.execPath),
  // a double-clicked .exe gets a window that closes when it ends: keep a failure readable
  pauseOnError: process.platform === 'win32',
};

/** The web apps, unpacked; null after printing why they could not be. */
function webApps() {
  try {
    const manifest = JSON.parse(getAsset(MANIFEST_KEY, 'utf8'));
    return unpackWebApps({ manifest, readAsset: (key) => getAsset(key) });
  } catch (err) {
    process.stderr.write(`${err?.name === 'UnpackError' ? err.message : `OneCard Lab could not unpack its web apps: ${err?.stack ?? err}`}\n`);
    return null;
  }
}

// --help needs no web apps (and must work with a read-only temp folder)
const wantsHelp = argv.includes('--help') || argv.includes('-h');
const webRoot = wantsHelp ? undefined : webApps();
if (webRoot === null) finish(1, { pause: how.pauseOnError });
else main(argv, process.env, { ...how, webRoot });
