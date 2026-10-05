// npm run build:app — the single-file desktop app (docs/DESIGN.md §13) for this computer's system
// and processor, made from the Node.js binary that runs this script:
//   1. bundle src/app/sea-main.js and everything it imports into one CommonJS file (esbuild);
//   2. every file under web/ becomes an asset, plus a manifest (keys, sizes, a content hash);
//   3. `node --experimental-sea-config` turns those into the app's blob;
//   4. copy this Node.js binary to dist/onecard-lab-<win|mac|linux>-<arm64|x64>[.exe] and inject
//      the blob (postject); on macOS remove the signature first and sign it ad hoc afterwards.
//
// Build with the official Node.js binary (nodejs.org, nvm, Volta, actions/setup-node). Homebrew's
// node is linked against other Homebrew libraries, so its copy would not start on a computer
// without them. esbuild and postject are dev dependencies: `npm install` (not --omit=dev) first.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_KEY, makeManifest } from '../src/app/assets.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORK = join(ROOT, 'dist', 'sea'); // the bundle, manifest, config and blob (kept for a look)

/** The sentinel Node.js looks for to know a blob was injected (Node's SEA documentation). */
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Requires that are optional inside the libraries (in try/catch) and stay out of the bundle. */
export const OPTIONAL_REQUIRES = [
  'bufferutil', // ws: faster masking, falls back to JavaScript
  'utf-8-validate', // ws: faster UTF-8 checks, falls back to JavaScript
  'supports-color', // debug (used by mqtt): colours only
];

/**
 * esbuild warnings that are expected, with why they are harmless. Anything else stops the build:
 * in a single executable, require() loads only Node's built-in modules, so a surprise in the
 * bundle shows up only when the app runs on someone's computer.
 */
const EXPECTED_WARNINGS = [
  // server.js works out web/ and routes/lab.js from import.meta.url only when it is given no
  // webRoot or labRoutes; the app passes webRoot, and createLab() passes its own labRoutes.
  { id: 'empty-import-meta', file: 'src/http/server.js' },
];

/** dist/ file name of the app for a platform and processor. */
export function appFileName(platform = process.platform, arch = process.arch) {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform] ?? platform;
  return `onecard-lab-${os}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

/** Every file under `folder`, as [key, path] with keys like 'web/lab/index.html'; dotfiles are skipped. */
export function webFiles(folder, prefix = 'web') {
  const out = [];
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue; // .DS_Store and friends
    const path = join(folder, entry.name);
    if (entry.isDirectory()) out.push(...webFiles(path, `${prefix}/${entry.name}`));
    else if (entry.isFile()) out.push([`${prefix}/${entry.name}`, path]);
  }
  return out;
}

/**
 * The SQLite warning filter must run before node:sqlite is required. The bundle evaluates the
 * entry's imports in order, so the filter is the first module evaluated; esbuild wraps the lab
 * (imported lazily by src/cli.js) in functions that run later, so their indented require() of
 * node:sqlite waits. A require at the start of a line runs when the bundle loads: it must come
 * after the filter. (The build also runs the app once and fails on any ExperimentalWarning.)
 */
export function checkBundleOrder(code) {
  const filter = code.indexOf('process.emitWarning = function emitWarningExceptSqlite');
  if (filter < 0) throw new Error('the bundle has no SQLite warning filter (src/app/quiet-warnings.js)');
  const eager = /^var \w+ = require\(["']node:sqlite["']\);?$/m.exec(code);
  if (eager && eager.index < filter) throw new Error('the bundle requires node:sqlite before it installs the SQLite warning filter');
}

/** Run the new app's --self-test: it must pass without a word of ExperimentalWarning. */
function selfTest(target) {
  const result = spawnSync(target, ['--self-test'], { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
  const said = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) throw new Error(`the app could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`the app's self-test failed:\n${said}`);
  if (/ExperimentalWarning/.test(said)) throw new Error(`the app printed a warning:\n${said}`);
  console.log(said);
}

/** Run a command; stop the build if it fails. */
function sh(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit code ${result.status})`);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`building the app needs Node.js 22.13 or newer (this is ${process.versions.node})`);
  const node = readFileSync(process.execPath);
  if (!node.includes(`${SEA_FUSE}:0`)) {
    throw new Error(`this Node.js binary (${process.execPath}) cannot be made into a single-file app: it has no unused SEA fuse. Use the official build from nodejs.org.`);
  }
  const { build } = await import('esbuild');
  const { inject } = (await import('postject')).default;
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // 1. One CommonJS file. Node's built-ins (node:sqlite, node:sea, …) stay require()s.
  const bundleFile = join(WORK, 'onecard-lab.cjs');
  const bundled = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/app/sea-main.js'],
    outfile: bundleFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: OPTIONAL_REQUIRES,
    charset: 'utf8',
    logLevel: 'silent',
  });
  const unexpected = [];
  for (const w of bundled.warnings) {
    const file = (w.location?.file ?? '').replaceAll('\\', '/');
    const where = w.location ? `${file}:${w.location.line}` : '(bundle)';
    if (EXPECTED_WARNINGS.some((e) => e.id === w.id && e.file === file)) console.log(`  expected: ${where} ${w.text}`);
    else unexpected.push(`  ${where} ${w.text} [${w.id}]`);
  }
  if (unexpected.length) {
    throw new Error(`esbuild warned about something new:\n${unexpected.join('\n')}\nCheck it works in the app, then list it in EXPECTED_WARNINGS with the reason.`);
  }
  checkBundleOrder(readFileSync(bundleFile, 'utf8'));
  console.log(`Bundled ${relative(ROOT, bundleFile)} (${mb(statSync(bundleFile).size)})`);

  // 2. The web apps and their manifest.
  const files = webFiles(join(ROOT, 'web'));
  const manifest = makeManifest({ version, files: files.map(([key, path]) => ({ key, data: readFileSync(path) })) });
  const manifestFile = join(WORK, 'manifest.json');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Web apps: ${files.length} files, ${mb(manifest.files.reduce((n, f) => n + f.size, 0))}, content hash ${manifest.hash}`);

  // 3. The blob.
  const blobFile = join(WORK, 'sea-prep.blob');
  const configFile = join(WORK, 'sea-config.json');
  const config = {
    main: bundleFile,
    output: blobFile,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false, // import() does not work with a code cache
    assets: { [MANIFEST_KEY]: manifestFile, ...Object.fromEntries(files) },
  };
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  sh(process.execPath, ['--experimental-sea-config', configFile]);

  // 4. A copy of this Node.js with the blob inside.
  const target = join(ROOT, 'dist', appFileName());
  rmSync(target, { force: true });
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);
  const mac = process.platform === 'darwin';
  if (mac) sh('codesign', ['--remove-signature', target]);
  await inject(target, 'NODE_SEA_BLOB', readFileSync(blobFile), {
    sentinelFuse: SEA_FUSE,
    ...(mac ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  if (mac) sh('codesign', ['--sign', '-', target]);
  selfTest(target);
  const shown = relative(ROOT, target).split(sep).join('/');
  console.log(`Built ${shown} (${mb(statSync(target).size)}) from Node.js ${process.versions.node}.`);
}

// Run when started as a script (tests import the helpers above without building anything).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`The app was not built: ${err?.message ?? err}`);
    process.exit(1);
  });
}
