'use strict';
// The double-click start (docs/DESIGN.md §13). "Start OneCard Lab.command" (macOS),
// "Start OneCard Lab.bat" (Windows) and start-onecard-lab.sh (Linux) find Node.js and run this
// file, which:
//   1. checks the Node.js version (22.13 or newer), and if it is too old says so in English and
//      中文, opens the download page and waits for Enter;
//   2. installs the two libraries the lab uses when node_modules is missing, or package-lock.json
//      is newer than the last install (a git pull brought new ones);
//   3. starts the lab with --open and waits for it. Ctrl+C or closing the window stops it. A
//      problem keeps the window open with the message until Enter is pressed.
//
// It must still run on old Node.js versions, to tell them they are too old: no syntax newer than
// Node 6 (no async/await, ?., ??, object spread or `catch {}`); test/unit/desktop.test.js checks.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const MIN_NODE = [22, 13];
const DOWNLOAD_URL = 'https://nodejs.org/en/download';
const ROOT = path.resolve(__dirname, '..');
const NPM_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];
const PRESS_ENTER = 'Press Enter to close. / 按 Enter 关闭。';

/** [major, minor, patch] of 'v22.13.0' or '22.13.0'; null when it is not a version. */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether a Node.js version can run the lab: 22.13 or newer. */
function nodeVersionOk(version) {
  const v = parseVersion(version);
  if (!v) return false;
  return v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]);
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtime.getTime();
  } catch (e) {
    return null;
  }
}

function exists(file) {
  return mtimeOf(file) !== null;
}

/**
 * Whether the libraries must be installed before the lab can start, and why.
 * @param {string} root  the project folder
 * @returns {'missing'|'outdated'|null}  missing: no node_modules, or a dependency is not in it;
 *   outdated: package-lock.json is newer than node_modules/.package-lock.json (npm writes that
 *   file at every install), so a git pull or a new download brought other versions; null: ready
 */
function needsInstall(root) {
  const modules = path.join(root, 'node_modules');
  if (!exists(modules)) return 'missing';
  let dependencies = {};
  try {
    dependencies = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies || {};
  } catch (e) {
    // no readable package.json: the lab will say what is wrong when it starts
  }
  const names = Object.keys(dependencies);
  for (let i = 0; i < names.length; i += 1) {
    if (!exists(path.join(modules, names[i], 'package.json'))) return 'missing';
  }
  const installed = mtimeOf(path.join(modules, '.package-lock.json'));
  if (installed === null) return 'outdated'; // installed some other way: install it as npm does
  const lock = mtimeOf(path.join(root, 'package-lock.json'));
  return lock !== null && lock > installed ? 'outdated' : null;
}

/**
 * How to run `npm install` with the Node.js that runs this file: npm's own script next to it when
 * it is there (no shell, so folder names with spaces or Chinese characters stay intact), else npm
 * from PATH; on Windows that is npm.cmd, which Node only starts through a shell.
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
function npmInvocation(platform, execPath, fileExists) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.dirname(execPath);
  const npmCli =
    platform === 'win32'
      ? p.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : p.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fileExists(npmCli)) return { command: execPath, args: [npmCli].concat(NPM_ARGS), shell: false };
  // one command line: the arguments are fixed words, nothing to quote
  if (platform === 'win32') return { command: ['npm'].concat(NPM_ARGS).join(' '), args: [], shell: true };
  return { command: 'npm', args: NPM_ARGS.slice(), shell: false };
}

/** The environment with this Node.js first on PATH, so npm and its scripts use it too. */
function envWithNodeFirst(env, execPath, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const out = Object.assign({}, env);
  // Windows spells it Path; a second PATH key would leave which one wins to chance
  const key = Object.keys(out).filter((k) => k.toUpperCase() === 'PATH')[0] || 'PATH';
  out[key] = p.dirname(execPath) + p.delimiter + (out[key] || '');
  return out;
}

/** What starts the lab: this Node.js with src/main.js --open, plus the launcher's own arguments. */
function labArgs(root, argv) {
  return ['--disable-warning=ExperimentalWarning', path.join(root, 'src', 'main.js'), '--open'].concat(argv || []);
}

/** How to start again, in the words of each system. */
function again(platform) {
  return platform === 'win32' || platform === 'darwin'
    ? { en: 'double-click "Start OneCard Lab" again', zh: '再双击 "Start OneCard Lab"' }
    : { en: 'run ./start-onecard-lab.sh again', zh: '再运行 ./start-onecard-lab.sh' };
}

/** The messages, in English and 中文. */
const messages = {
  tooOld(found, platform) {
    const next = again(platform);
    const need = MIN_NODE.join('.');
    return [
      '',
      `OneCard Lab needs Node.js ${need} or newer, and this computer has Node.js ${found}.`,
      `Install the LTS version from ${DOWNLOAD_URL} (the page is opening now),`,
      `then ${next.en}.`,
      '',
      `OneCard Lab 需要 Node.js ${need} 或更新的版本，这台电脑上的是 Node.js ${found}。`,
      `请从 ${DOWNLOAD_URL} 安装 LTS 版本（网页正在打开），`,
      `装好后${next.zh}。`,
    ].join('\n');
  },
  installing(reason) {
    return reason === 'missing'
      ? 'First start: downloading the two libraries the lab uses (needs the internet, about a minute)…\n' +
          '第一次启动：正在下载实验室用的两个库（需要网络，大约一分钟）……'
      : 'The lab was updated: updating the libraries it uses (needs the internet)…\n' +
          '实验室更新了：正在更新它用的库（需要网络）……';
  },
  installFailed(platform) {
    const next = again(platform);
    return [
      '',
      'Could not download the libraries the lab needs (npm install failed, see above).',
      `Check the internet connection, then ${next.en}.`,
      '无法下载实验室需要的库（npm install 失败，见上面的信息）。',
      `请检查网络连接，然后${next.zh}。`,
    ].join('\n');
  },
  starting:
    'Starting OneCard Lab: the lab console opens in your web browser. Keep this window open while you\n' +
    'use the lab; close it, or press Ctrl+C, to stop the lab.\n' +
    '正在启动 OneCard Lab：实验室控制台会在浏览器里打开。用实验室的时候不要关这个窗口；关掉它或按 Ctrl+C 就会停止实验室。',
  stopped: '\nThe lab stopped because of the problem above.\n实验室因为上面的问题停止了。',
  cannotRun(what, err) {
    return `\nCould not start ${what}: ${err && err.message}\n无法启动 ${what}：${err && err.message}`;
  },
};

function say(text) {
  process.stdout.write(`${text}\n`);
}

/** `fn` that runs only the first time: a child that fails to start may report 'error' and 'exit'. */
function once(fn) {
  let done = false;
  return function () {
    if (done) return;
    done = true;
    fn.apply(null, arguments);
  };
}

/** Signals that mean someone stopped the lab (Ctrl+C, a closed window, kill), not that it broke. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'];

/** Open a page in the default browser, detached; a missing browser changes nothing. */
function openInBrowser(url, platform) {
  let command = 'xdg-open';
  let args = [url];
  const options = { detached: true, stdio: 'ignore', windowsHide: true };
  if (platform === 'darwin') command = 'open';
  if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url];
    options.windowsVerbatimArguments = true;
  }
  try {
    const child = childProcess.spawn(command, args, options);
    child.on('error', () => {});
    child.unref();
  } catch (e) {
    // the message above has the address
  }
}

/** End with `code`; with a person at the keyboard, only after Enter, so the window stays readable. */
function closeAfterEnter(code) {
  if (!process.stdin.isTTY) {
    process.exit(code);
    return;
  }
  say(`\n${PRESS_ENTER}`);
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}

/** Start the lab and stay until it ends. */
function startLab(argv) {
  say(messages.starting);
  const child = childProcess.spawn(process.execPath, labArgs(ROOT, argv), { cwd: ROOT, stdio: 'inherit' });
  const running = () => child.exitCode === null && child.signalCode === null;
  if (process.platform === 'win32') {
    // Ctrl+C reaches the lab in the same window; wait for it to stop instead of leaving first
    process.on('SIGINT', () => {});
  } else {
    // Ctrl+C and a closed window reach the lab too; a stop meant for this process alone is passed
    // on, so no lab is left behind holding the ports
    ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
      process.on(signal, () => {
        if (running()) child.kill(signal);
      });
    });
  }
  const ended = once((code, signal, err) => {
    if (err) {
      say(messages.cannotRun('Node.js', err));
      closeAfterEnter(1);
    } else if (code === 0 || STOP_SIGNALS.indexOf(signal) >= 0) {
      process.exit(0); // stopped: Ctrl+C, a closed window, or the lab that was already running opened
    } else {
      say(messages.stopped);
      closeAfterEnter(code || 1);
    }
  });
  child.on('error', (err) => ended(null, null, err));
  child.on('exit', (code, signal) => ended(code, signal, null));
}

/** npm install, then `done(ok)`. */
function install(callback) {
  const done = once(callback);
  const how = npmInvocation(process.platform, process.execPath, exists);
  const child = childProcess.spawn(how.command, how.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: how.shell,
    env: envWithNodeFirst(process.env, process.execPath, process.platform),
  });
  child.on('error', (err) => {
    say(messages.cannotRun('npm', err));
    done(false);
  });
  child.on('exit', (code) => done(code === 0));
}

function main(argv) {
  if (!nodeVersionOk(process.versions.node)) {
    say(messages.tooOld(process.versions.node, process.platform));
    openInBrowser(DOWNLOAD_URL, process.platform);
    closeAfterEnter(1);
    return;
  }
  const reason = needsInstall(ROOT);
  if (!reason) {
    startLab(argv);
    return;
  }
  say(messages.installing(reason));
  install((ok) => {
    const still = ok ? needsInstall(ROOT) : 'failed';
    if (still === 'outdated') {
      // installed, and npm wrote its file in the same instant as package-lock.json (or not at all):
      // mark the install as newer, so the next start does not install again
      try {
        const now = new Date();
        fs.utimesSync(path.join(ROOT, 'node_modules', '.package-lock.json'), now, now);
      } catch (e) {
        // not there: the next start installs once more, which is harmless
      }
    } else if (still) {
      say(messages.installFailed(process.platform));
      closeAfterEnter(1);
      return;
    }
    startLab(argv);
  });
}

module.exports = { MIN_NODE, NPM_ARGS, DOWNLOAD_URL, parseVersion, nodeVersionOk, needsInstall, npmInvocation, envWithNodeFirst, labArgs, messages };

if (require.main === module) main(process.argv.slice(2));
