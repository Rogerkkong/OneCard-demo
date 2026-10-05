import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UnpackError, checkManifest, isComplete, makeManifest, unpackFolder, unpackWebApps } from '../../src/app/assets.js';
import { appFileName, checkBundleOrder, webFiles } from '../../scripts/build-sea.mjs';

// The double-click desktop app (DESIGN §13): the web apps unpacked from the single-file app, the
// SQLite warning filter, the launchers' shared script (scripts/launch.cjs) and the build's
// helpers. Nothing here builds the app: esbuild and postject are not needed.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ASSETS = join(ROOT, 'src', 'app', 'assets.js');
const launch = createRequire(import.meta.url)('../../scripts/launch.cjs');

const tempDir = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

/** A fake set of web files and an asset source that counts its reads. */
function fakeAssets(count = 30) {
  const data = new Map();
  for (let i = 0; i < count; i += 1) {
    const app = ['lab', 'admin', 'parent'][i % 3];
    data.set(`web/${app}/file-${i}.js`, Buffer.from(`// file ${i}\n${'x'.repeat(i * 97)}\n`));
  }
  data.set('web/lab/index.html', Buffer.from('<!doctype html><html><body>lab 实验室</body></html>'));
  const manifest = makeManifest({ version: '0.1.0', files: [...data].map(([key, d]) => ({ key, data: d })) });
  const reads = { count: 0 };
  const readAsset = (key) => {
    reads.count += 1;
    const d = data.get(key);
    if (!d) throw new Error(`no asset ${key}`);
    return d.buffer.slice(d.byteOffset, d.byteOffset + d.length); // an ArrayBuffer, as node:sea gives
  };
  return { data, manifest, readAsset, reads };
}

/** Every file of the manifest is in `root` (…/web) with its content. */
function assertUnpacked(webRoot, data) {
  for (const [key, d] of data) assert.deepEqual(readFileSync(join(webRoot, '..', ...key.split('/'))), d, key);
}

describe('the manifest', () => {
  test('keys, sizes and a content hash that changes with any content', () => {
    const a = makeManifest({ version: '1.2.3', files: [{ key: 'web/b.js', data: Buffer.from('b') }, { key: 'web/a/x.css', data: Buffer.from('aa') }] });
    assert.equal(a.name, 'onecard-lab');
    assert.deepEqual(a.files.map((f) => [f.key, f.size]), [['web/a/x.css', 2], ['web/b.js', 1]]);
    assert.match(a.hash, /^[0-9a-f]{16}$/);
    const same = makeManifest({ version: '1.2.3', files: [{ key: 'web/a/x.css', data: Buffer.from('aa') }, { key: 'web/b.js', data: Buffer.from('b') }] });
    assert.equal(same.hash, a.hash); // the order of the files does not matter
    const changed = makeManifest({ version: '1.2.3', files: [{ key: 'web/a/x.css', data: Buffer.from('ab') }, { key: 'web/b.js', data: Buffer.from('b') }] });
    assert.notEqual(changed.hash, a.hash);
    assert.equal(unpackFolder(a, '/t'), join('/t', `onecard-lab-1.2.3-${a.hash}`));
  });

  test('keys must be files under web/: nothing outside it, nothing twice', () => {
    const ok = { name: 'onecard-lab', version: '1.0.0', hash: 'abc', files: [{ key: 'web/lab/index.html', size: 1 }] };
    assert.equal(checkManifest(ok), ok);
    for (const key of ['web/../evil.js', '../x', '/etc/passwd', 'web\\lab\\x.js', 'lab/index.html', 'web/', 'web//x.js', 'web/.hidden', 'C:/x']) {
      assert.throws(() => checkManifest({ ...ok, files: [{ key, size: 1 }] }), TypeError, key);
    }
    assert.throws(() => checkManifest({ ...ok, files: [{ key: 'web/A.js', size: 1 }, { key: 'web/a.js', size: 1 }] }), /listed twice/);
    assert.throws(() => checkManifest({ ...ok, version: '../1' }), TypeError);
    assert.throws(() => checkManifest({ ...ok, files: [] }), TypeError);
    assert.throws(() => checkManifest({ ...ok, files: [{ key: 'web/a.js', size: -1 }] }), TypeError);
  });
});

describe('unpacking the web apps', () => {
  test('once: the files land in <temp>/onecard-lab-<version>-<hash>/web, and the next start reuses them', () => {
    const tmp = tempDir('unpack');
    try {
      const { data, manifest, readAsset, reads } = fakeAssets();
      const root = unpackWebApps({ manifest, readAsset, tmpDir: tmp });
      assert.equal(root, join(unpackFolder(manifest, tmp), 'web'));
      assertUnpacked(root, data);
      assert.equal(reads.count, data.size);
      assert.equal(unpackWebApps({ manifest, readAsset, tmpDir: tmp }), root);
      assert.equal(reads.count, data.size); // nothing read or written again
      assert.deepEqual(readdirSync(tmp), [`onecard-lab-0.1.0-${manifest.hash}`]); // no temporary folder left
      if (process.platform !== 'win32') assert.equal(statSync(join(root, '..')).mode & 0o777, 0o700); // only this user's
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a half-written folder from a crash is never used; a damaged one is replaced', () => {
    const tmp = tempDir('unpack');
    try {
      const { data, manifest, readAsset } = fakeAssets();
      const final = unpackFolder(manifest, tmp);
      // a crash half-way leaves a .part- folder behind: it is not the folder, and stays untouched
      mkdirSync(join(`${final}.part-AbC123`, 'web', 'lab'), { recursive: true });
      writeFileSync(join(`${final}.part-AbC123`, 'web', 'lab', 'index.html'), 'half');
      const root = unpackWebApps({ manifest, readAsset, tmpDir: tmp });
      assert.equal(root, join(final, 'web'));
      assertUnpacked(root, data);
      // a temp cleaner deleted a file: the folder is incomplete and is unpacked again
      rmSync(join(root, 'lab', 'index.html'));
      assert.equal(isComplete(final, manifest), false);
      assert.equal(unpackWebApps({ manifest, readAsset, tmpDir: tmp }), root);
      assertUnpacked(root, data);
      // a file cut short is noticed too
      writeFileSync(join(root, 'admin', 'file-1.js'), 'short');
      assert.equal(unpackWebApps({ manifest, readAsset, tmpDir: tmp }), root);
      assertUnpacked(root, data);
      assert.deepEqual(readdirSync(tmp).sort(), [`onecard-lab-0.1.0-${manifest.hash}`, `onecard-lab-0.1.0-${manifest.hash}.part-AbC123`]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a folder of that name that others may write to is not used: this start gets its own copy', { skip: process.platform === 'win32' && 'the temp folder is private on Windows' }, () => {
    const tmp = tempDir('unpack');
    try {
      const { data, manifest, readAsset } = fakeAssets();
      const final = unpackFolder(manifest, tmp);
      mkdirSync(join(final, 'web', 'lab'), { recursive: true });
      writeFileSync(join(final, 'web', 'lab', 'index.html'), '<script>planted</script>');
      chmodSync(final, 0o777);
      const root = unpackWebApps({ manifest, readAsset, tmpDir: tmp });
      assert.notEqual(root, join(final, 'web'));
      assert.ok(root.startsWith(`${final}.part-`));
      assertUnpacked(root, data);
      assert.equal(readFileSync(join(final, 'web', 'lab', 'index.html'), 'utf8'), '<script>planted</script>'); // left alone
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a temp folder that cannot be written: a plain error', () => {
    const tmp = tempDir('unpack');
    try {
      const notAFolder = join(tmp, 'file');
      writeFileSync(notAFolder, '');
      const { manifest, readAsset } = fakeAssets(3);
      assert.throws(
        () => unpackWebApps({ manifest, readAsset, tmpDir: notAFolder }),
        (err) => err instanceof UnpackError && err.message.startsWith(`Could not unpack the web apps into ${notAFolder}: the folder does not exist.`) && /TMPDIR|TEMP/.test(err.message),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a damaged asset in the app is an error of the build, not of the disk', () => {
    const tmp = tempDir('unpack');
    try {
      const { manifest } = fakeAssets(3);
      assert.throws(() => unpackWebApps({ manifest, readAsset: () => new ArrayBuffer(1), tmpDir: tmp }), (err) => !(err instanceof UnpackError) && /is damaged/.test(err.message));
      assert.deepEqual(readdirSync(tmp), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('copies starting at the same moment all get the same complete folder', { timeout: 60_000 }, async () => {
    const tmp = tempDir('unpack');
    try {
      const at = Date.now() + 700; // every copy waits for this moment, then unpacks
      const code = `
        import { makeManifest, unpackWebApps } from ${JSON.stringify(pathToFileURL(ASSETS).href)};
        const files = [];
        for (let i = 0; i < 120; i += 1) files.push({ key: 'web/app' + (i % 4) + '/f' + i + '.js', data: Buffer.from('x'.repeat(5000 + i)) });
        const manifest = makeManifest({ version: '9.9.9', files });
        const byKey = new Map(files.map((f) => [f.key, f.data]));
        while (Date.now() < ${at}) {}
        process.stdout.write(unpackWebApps({ manifest, readAsset: (k) => byKey.get(k), tmpDir: process.argv[1] }));
      `;
      const runs = Array.from({ length: 4 }, () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', code, tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('close', (status) => resolve({ status, out, err }));
        }),
      );
      const results = await Promise.all(runs);
      for (const r of results) assert.equal(r.status, 0, r.err);
      const roots = new Set(results.map((r) => r.out));
      assert.equal(roots.size, 1, [...roots].join(', '));
      const [root] = roots;
      assert.match(root, /onecard-lab-9\.9\.9-[0-9a-f]{16}[\\/]web$/);
      assert.equal(readdirSync(tmp).length, 1, readdirSync(tmp).join(', ')); // no temporary folder left behind
      assert.equal(readdirSync(join(root, 'app0')).length, 30);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('the SQLite warning filter', () => {
  test('drops only node:sqlite\'s notice; other warnings still show', () => {
    const quiet = new URL('../../src/app/quiet-warnings.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import ${JSON.stringify(quiet)}; await import('node:sqlite'); process.emitWarning('something else', 'ExperimentalWarning');`],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLite/);
    assert.match(result.stderr, /ExperimentalWarning: something else/);
  });

  test('the app imports it before anything else', () => {
    const source = readFileSync(join(ROOT, 'src', 'app', 'sea-main.js'), 'utf8');
    const imports = [...source.matchAll(/^import .*?['"]([^'"]+)['"];$/gm)].map((m) => m[1]);
    assert.equal(imports[0], './quiet-warnings.js');
  });
});

describe('the build (scripts/build-sea.mjs), without building', () => {
  test('one file name per system and processor', () => {
    assert.equal(appFileName('darwin', 'arm64'), 'onecard-lab-mac-arm64');
    assert.equal(appFileName('darwin', 'x64'), 'onecard-lab-mac-x64');
    assert.equal(appFileName('win32', 'x64'), 'onecard-lab-win-x64.exe');
    assert.equal(appFileName('linux', 'x64'), 'onecard-lab-linux-x64');
  });

  test('every file under web/ becomes an asset key; dotfiles stay out', () => {
    const dir = tempDir('web');
    try {
      mkdirSync(join(dir, 'lab'));
      writeFileSync(join(dir, 'lab', 'index.html'), 'x');
      writeFileSync(join(dir, 'lab', '.DS_Store'), 'x');
      writeFileSync(join(dir, 'a.css'), 'x');
      assert.deepEqual(webFiles(dir).map(([key]) => key), ['web/a.css', 'web/lab/index.html']);
      const real = webFiles(join(ROOT, 'web')).map(([key]) => key);
      assert.ok(real.includes('web/lab/index.html') && real.includes('web/shared/api.js'));
      checkManifest(makeManifest({ version: '0.1.0', files: webFiles(join(ROOT, 'web')).map(([key, path]) => ({ key, data: readFileSync(path) })) }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the bundle order check', () => {
    const filter = 'process.emitWarning = function emitWarningExceptSqlite(warning, ...rest) {};';
    checkBundleOrder(`var init_db = __esm({\n  "src/platform/db.js"() {\n    import_node_sqlite = require("node:sqlite");\n  }\n});\n${filter}`);
    checkBundleOrder(`${filter}\nvar import_node_sqlite = require("node:sqlite");`);
    assert.throws(() => checkBundleOrder(`var import_node_sqlite = require("node:sqlite");\n${filter}`), /before it installs/);
    assert.throws(() => checkBundleOrder('var x = 1;'), /no SQLite warning filter/);
  });
});

describe('the launchers (scripts/launch.cjs)', () => {
  test('Node.js 22.13 or newer', () => {
    assert.deepEqual(launch.parseVersion('v22.13.0'), [22, 13, 0]);
    assert.equal(launch.parseVersion('banana'), null);
    for (const v of ['22.13.0', 'v22.13.1', '22.20.0', '23.0.0', '24.11.1', '30.1.2']) assert.equal(launch.nodeVersionOk(v), true, v);
    for (const v of ['22.12.0', 'v22.9.9', '21.99.0', '20.18.0', '18.20.4', '8.17.0', '', undefined, 'v22']) assert.equal(launch.nodeVersionOk(v), false, String(v));
  });

  test('install when node_modules is missing, a library is missing, or package-lock.json is newer', () => {
    const root = tempDir('launch');
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { aedes: '1', mqtt: '1' } }));
      writeFileSync(join(root, 'package-lock.json'), '{}');
      assert.equal(launch.needsInstall(root), 'missing');
      mkdirSync(join(root, 'node_modules', 'aedes'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'aedes', 'package.json'), '{}');
      assert.equal(launch.needsInstall(root), 'missing'); // mqtt is not there (a failed install)
      mkdirSync(join(root, 'node_modules', 'mqtt'));
      writeFileSync(join(root, 'node_modules', 'mqtt', 'package.json'), '{}');
      assert.equal(launch.needsInstall(root), 'outdated'); // not installed by npm (no .package-lock.json)
      const hidden = join(root, 'node_modules', '.package-lock.json');
      writeFileSync(hidden, '{}');
      const t = Date.now() / 1000;
      utimesSync(join(root, 'package-lock.json'), t - 100, t - 100);
      utimesSync(hidden, t - 50, t - 50);
      assert.equal(launch.needsInstall(root), null); // installed after the last change
      utimesSync(join(root, 'package-lock.json'), t, t); // a git pull brought a new package-lock.json
      assert.equal(launch.needsInstall(root), 'outdated');
      utimesSync(hidden, t, t); // the same instant is not newer
      assert.equal(launch.needsInstall(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('npm: its own script next to this Node.js when it is there, else npm (on Windows through a shell)', () => {
    const args = ['install', '--omit=dev', '--no-audit', '--no-fund'];
    assert.deepEqual(launch.NPM_ARGS, args);
    const win = 'C:\\Program Files\\nodejs\\node.exe';
    const winCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    assert.deepEqual(launch.npmInvocation('win32', win, (f) => f === winCli), { command: win, args: [winCli, ...args], shell: false });
    assert.deepEqual(launch.npmInvocation('win32', win, () => false), { command: 'npm install --omit=dev --no-audit --no-fund', args: [], shell: true });
    const mac = '/Users/aminah/.nvm/versions/node/v22.13.0/bin/node';
    const macCli = '/Users/aminah/.nvm/versions/node/v22.13.0/lib/node_modules/npm/bin/npm-cli.js';
    assert.deepEqual(launch.npmInvocation('darwin', mac, (f) => f === macCli), { command: mac, args: [macCli, ...args], shell: false });
    assert.deepEqual(launch.npmInvocation('linux', '/opt/homebrew/Cellar/node/24.1.0/bin/node', () => false), { command: 'npm', args, shell: false });
  });

  test('this Node.js goes first on PATH, under the name the system uses', () => {
    const win = launch.envWithNodeFirst({ Path: 'C:\\Windows', OTHER: '1' }, 'C:\\Program Files\\nodejs\\node.exe', 'win32');
    assert.deepEqual(win, { Path: 'C:\\Program Files\\nodejs;C:\\Windows', OTHER: '1' });
    assert.equal(launch.envWithNodeFirst({ PATH: '/usr/bin' }, '/opt/node/bin/node', 'linux').PATH, '/opt/node/bin:/usr/bin');
  });

  test('the lab starts with --open, plus the launcher\'s own arguments', () => {
    const args = launch.labArgs('/x', ['--lan']);
    assert.deepEqual(args, ['--disable-warning=ExperimentalWarning', join('/x', 'src', 'main.js'), '--open', '--lan']);
  });

  test('a stop is not a problem: Ctrl+C (on Windows also while the lab starts), a closed window, kill', () => {
    for (const [code, signal] of [[0, null], [null, 'SIGINT'], [null, 'SIGTERM'], [null, 'SIGHUP'], [null, 'SIGKILL'], [0xc000013a, null]]) {
      assert.equal(launch.stoppedOnPurpose(code, signal), true, `${code} ${signal}`);
    }
    for (const code of [1, 2, 0xc0000005]) assert.equal(launch.stoppedOnPurpose(code, null), false, String(code));
  });

  test('the macOS/Linux launcher takes a Node.js that is new enough, also when an older one comes first on PATH', { skip: process.platform === 'win32' && 'a shell script' }, () => {
    const dir = tempDir('launcher');
    try {
      // stand-ins for node: the launcher's version check is `node -e …`, exit code 0 = new enough
      const fakeNode = (folder, label, newEnough) => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'node'), `#!/bin/sh\n[ "$1" = -e ] && exit ${newEnough ? 0 : 1}\necho "${label}: $*"\n`, { mode: 0o755 });
      };
      fakeNode(join(dir, 'old'), 'old node on PATH', false);
      fakeNode(join(dir, 'new'), 'new node on PATH', true);
      fakeNode(join(dir, 'home', '.volta', 'bin'), 'Volta node', true);
      const start = (path) =>
        spawnSync('/bin/bash', [join(ROOT, 'start-onecard-lab.sh'), '--lan'], { encoding: 'utf8', env: { HOME: join(dir, 'home'), PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
      const behindOld = start(`${join(dir, 'old')}:/usr/bin:/bin`);
      assert.equal(behindOld.stdout, 'Volta node: scripts/launch.cjs --lan\n', behindOld.stderr);
      const onPath = start(`${join(dir, 'new')}:/usr/bin:/bin`);
      assert.equal(onPath.stdout, 'new node on PATH: scripts/launch.cjs --lan\n', onPath.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the messages are in English and 中文', () => {
    const tooOld = launch.messages.tooOld('18.19.0', 'darwin');
    assert.match(tooOld, /needs Node\.js 22\.13 or newer, and this computer has Node\.js 18\.19\.0/);
    assert.match(tooOld, /需要 Node\.js 22\.13 或更新的版本/);
    assert.match(tooOld, /https:\/\/nodejs\.org\/en\/download/);
    assert.match(tooOld, /double-click "Start OneCard Lab" again/);
    assert.match(launch.messages.tooOld('18.19.0', 'linux'), /run \.\/start-onecard-lab\.sh again/);
    for (const text of [launch.messages.installing('missing'), launch.messages.installing('outdated'), launch.messages.installFailed('win32'), launch.messages.starting, launch.messages.stopped]) {
      assert.match(text, /[A-Za-z]/);
      assert.match(text, /[\u4e00-\u9fff]/);
    }
  });

  test('old Node.js versions can read it, so they can say they are too old', () => {
    const code = readFileSync(join(ROOT, 'scripts', 'launch.cjs'), 'utf8').replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const [what, re] of [
      ['optional chaining', /\?\.(?!\d)/],
      ['??', /\?\?/],
      ['async functions', /\basync\b/],
      ['await', /\bawait\b/],
      ['catch without a binding', /catch\s*\{/],
      ['spread', /\.\.\.[A-Za-z_[{(]/],
      ['class fields', /^\s*#\w/m],
      ['import', /^\s*import\b/m],
    ]) {
      assert.doesNotMatch(code, re, what);
    }
  });

  test('on a too-old Node.js it says so and ends (nobody at the keyboard: no wait)', { skip: !existsSync('/opt/node20/bin/node') && 'no Node.js 20 at /opt/node20 on this computer' }, () => {
    const result = spawnSync('/opt/node20/bin/node', [join(ROOT, 'scripts', 'launch.cjs')], { encoding: 'utf8', env: { ...process.env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /needs Node\.js 22\.13 or newer, and this computer has Node\.js 20\./);
    assert.match(result.stdout, /这台电脑上的是 Node\.js 20\./);
  });
});

describe('the launcher files', () => {
  const read = (name) => readFileSync(join(ROOT, name));

  test('the shell launchers are executable and use LF; the .bat uses CRLF', { skip: process.platform === 'win32' && 'no executable bit on Windows' }, () => {
    for (const name of ['Start OneCard Lab.command', 'start-onecard-lab.sh']) {
      assert.equal(statSync(join(ROOT, name)).mode & 0o111, 0o111, name);
      assert.equal(read(name).includes(0x0d), false, `${name} has CR`);
    }
    const bat = read('Start OneCard Lab.bat').toString('utf8');
    assert.equal(bat.split('\r\n').length, bat.split('\n').length, 'every .bat line ends in CRLF');
    assert.notEqual(bat.charCodeAt(0), 0xfeff, 'no byte order mark: cmd.exe would read it as part of @echo');
    // cmd.exe reads the lines before `chcp 65001` in the console's code page: ASCII only there
    assert.match(bat.slice(0, bat.indexOf('chcp 65001')), /^[\x00-\x7f]*$/);
  });

  test('.gitattributes keeps those line endings in every checkout', () => {
    const attributes = read('.gitattributes').toString('utf8');
    for (const line of ['*.bat text eol=crlf', '*.sh text eol=lf', '*.command text eol=lf']) assert.ok(attributes.includes(line), line);
  });
});
