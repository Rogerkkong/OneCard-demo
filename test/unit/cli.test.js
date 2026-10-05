import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliError,
  SELF_TEST_TIMEOUT_MS,
  bannerText,
  helpText,
  isLabAt,
  labOptionsFromEnv,
  listenErrorOf,
  openCommand,
  openInBrowser,
  parseArgs,
  portBusyPlan,
  portTaken,
  run,
  selfTest,
  startCommand,
  startWithFallbacks,
  whichPort,
} from '../../src/cli.js';
import { createLab } from '../../src/lab/lab.js';

// The command line (DESIGN §13): options, settings, the browser, ports in use, --self-test.
// Network tests bind port 0 (or a port a test holds itself) and close everything they open.

const NET = { timeout: 60_000 };
const MAIN = fileURLToPath(new URL('../../src/main.js', import.meta.url));

/** A writable stream stand-in that keeps what was written. */
function sink() {
  const parts = [];
  return { write: (text) => parts.push(String(text)), get text() { return parts.join(''); } };
}

/** A TCP server holding a free port, like another program would. */
function holdPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

/** A web server on a free port; `lab: true` answers GET /api/lab/state like a OneCard Lab. */
function webServer({ lab = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (lab && req.url === '/api/lab/state') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ clock: {}, server: { up: true }, broker: {}, schools: [{ code: 'smk-contoh' }] }));
      } else {
        res.statusCode = 404;
        res.end('not here');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
      }),
    );
  });
}

/** createLab that remembers every lab it made, so a test can stop them. */
function recordingCreateLab() {
  const labs = [];
  const make = (options) => {
    const lab = createLab(options);
    labs.push(lab);
    return lab;
  };
  return { make, labs, stopAll: () => Promise.all(labs.map((l) => l.stop().catch(() => {}))) };
}

/** A lab stand-in whose start() fails like a listener that could not listen. */
function failingLab(code, port, address = '127.0.0.1') {
  return () => ({
    start: async () => {
      throw Object.assign(new Error(`listen ${code}: ${address}:${port}`), { code, syscall: 'listen', address, port });
    },
    stop: async () => {},
  });
}

const QUIET = { log: () => {} };

describe('options', () => {
  test('the defaults, --open/--no-open (the last one wins), --lan, --self-test, --help', () => {
    assert.deepEqual(parseArgs([]), { open: false, lan: false, selfTest: false, help: false });
    assert.deepEqual(parseArgs([], { defaultOpen: true }), { open: true, lan: false, selfTest: false, help: false });
    assert.equal(parseArgs(['--open']).open, true);
    assert.equal(parseArgs(['--no-open'], { defaultOpen: true }).open, false);
    assert.equal(parseArgs(['--open', '--no-open']).open, false);
    assert.equal(parseArgs(['--no-open', '--open']).open, true);
    assert.equal(parseArgs(['--lan']).lan, true);
    assert.equal(parseArgs(['--self-test']).selfTest, true);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
  });

  test('an unknown option is a plain error with exit code 2', () => {
    assert.throws(() => parseArgs(['--opne']), (err) => err instanceof CliError && err.exitCode === 2 && /Unknown option --opne/.test(err.message));
  });

  test('--help lists every option and setting', () => {
    const text = helpText();
    for (const word of ['--open', '--no-open', '--lan', '--self-test', '--help', 'npm start', 'LAB_HTTP_PORT', 'LAB_MQTT_PORT', 'LAB_CONSOLE_PORT', 'LAB_HOST', 'LAB_ALLOWED_HOSTS', 'LAB_MQTT_TLS_CERT', 'LAB_MQTT_TLS_KEY', 'LAB_MQTT_TLS_PORT']) {
      assert.ok(text.includes(word), word);
    }
    assert.match(helpText({ app: true, program: 'onecard-lab-mac-arm64' }), /\.\/onecard-lab-mac-arm64 \[options\]/);
    assert.match(helpText({ app: true, program: 'onecard-lab-win-x64.exe' }), /\.\\onecard-lab-win-x64\.exe \[options\]/);
  });
});

describe('settings from the environment', () => {
  test('the defaults and every variable, read as npm start always has', () => {
    assert.deepEqual(labOptionsFromEnv({}), { httpPort: 8080, mqttPort: 1883, consolePort: 2323, host: '127.0.0.1' });
    assert.deepEqual(labOptionsFromEnv({ LAB_HTTP_PORT: '8090', LAB_MQTT_PORT: '1884', LAB_CONSOLE_PORT: '0', LAB_HOST: '192.168.1.20' }), {
      httpPort: 8090,
      mqttPort: 1884,
      consolePort: 0,
      host: '192.168.1.20',
    });
    assert.equal(labOptionsFromEnv({ LAB_HOST: '10.0.0.5' }, { lan: true }).host, '0.0.0.0');
    assert.equal(labOptionsFromEnv({ LAB_HTTP_PORT: '' }).httpPort, 0); // as before: empty is 0, a free port
  });

  test('a bad port keeps its old message', () => {
    assert.throws(() => labOptionsFromEnv({ LAB_HTTP_PORT: 'abc' }), (err) => err instanceof CliError && err.message === 'LAB_HTTP_PORT must be a port number, got abc');
    assert.throws(() => labOptionsFromEnv({ LAB_MQTT_PORT: '70000' }), /LAB_MQTT_PORT must be a port number, got 70000/);
  });

  test('two listeners on one port are named', () => {
    assert.throws(() => labOptionsFromEnv({ LAB_MQTT_PORT: '8080' }), (err) => err instanceof CliError && /LAB_HTTP_PORT and LAB_MQTT_PORT are both 8080/.test(err.message));
    // 0 is "any free port" (or no consoles), never a clash
    assert.equal(labOptionsFromEnv({ LAB_HTTP_PORT: '0', LAB_MQTT_PORT: '0', LAB_CONSOLE_PORT: '0' }).httpPort, 0);
  });

  test('TLS: both files or neither, read with a plain message when missing', () => {
    assert.throws(() => labOptionsFromEnv({ LAB_MQTT_TLS_CERT: 'x.crt' }), { message: 'Set both LAB_MQTT_TLS_CERT and LAB_MQTT_TLS_KEY, or neither.' });
    assert.throws(
      () => labOptionsFromEnv({ LAB_MQTT_TLS_CERT: '/no/such/server.crt', LAB_MQTT_TLS_KEY: '/no/such/server.key' }),
      (err) => err instanceof CliError && /Could not read LAB_MQTT_TLS_CERT \(\/no\/such\/server\.crt\): there is no such file/.test(err.message),
    );
    const dir = mkdtempSync(join(tmpdir(), 'cli-tls-'));
    try {
      writeFileSync(join(dir, 'server.crt'), 'CERT');
      writeFileSync(join(dir, 'server.key'), 'KEY');
      const options = labOptionsFromEnv({ LAB_MQTT_TLS_CERT: join(dir, 'server.crt'), LAB_MQTT_TLS_KEY: join(dir, 'server.key'), LAB_MQTT_TLS_PORT: '8884' });
      assert.deepEqual(options.tls, { port: 8884, cert: 'CERT', key: 'KEY' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('opening the browser', () => {
  const url = 'http://127.0.0.1:8080/lab/';

  test('the command of each system', () => {
    assert.deepEqual(openCommand(url, 'darwin'), { command: 'open', args: [url], options: {} });
    assert.deepEqual(openCommand(url, 'win32'), { command: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true } });
    assert.deepEqual(openCommand(url, 'linux'), { command: 'xdg-open', args: [url], options: {} });
    assert.equal(openCommand(url, 'freebsd').command, 'xdg-open');
  });

  test('detached, and nothing that goes wrong reaches the caller', () => {
    const calls = [];
    const child = Object.assign(new EventEmitter(), { unref: () => calls.push('unref') });
    assert.equal(
      openInBrowser(url, {
        platform: 'linux',
        spawnFn: (command, args, options) => {
          calls.push({ command, args, options });
          return child;
        },
      }),
      true,
    );
    assert.equal(calls[0].command, 'xdg-open');
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.ok(calls.includes('unref'));
    child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })); // no browser: ignored
    assert.equal(openInBrowser(url, { spawnFn: () => { throw new Error('EPERM'); } }), false);
  });

  test('a missing opener command for real: no throw, no crash', async () => {
    const child = openInBrowser(url, { platform: 'linux', spawnFn: (c, a, o) => spawn('no-such-opener-onecard', a, o) });
    assert.equal(child, true);
    await new Promise((r) => setTimeout(r, 50)); // the ENOENT 'error' event comes now
  });

  test('only addresses of the lab itself', () => {
    let spawned = false;
    const spawnFn = () => { spawned = true; return new EventEmitter(); };
    assert.equal(openInBrowser('http://127.0.0.1:8080/lab/&calc', { platform: 'win32', spawnFn }), false);
    assert.equal(openInBrowser('file:///etc/passwd', { spawnFn }), false);
    assert.equal(spawned, false);
  });
});

describe('ports in use: the decision', () => {
  test('which listener a failure is about', () => {
    const options = { httpPort: 8080, mqttPort: 1883, consolePort: 2323, tls: { port: 8883 } };
    assert.equal(whichPort({ port: 8080 }, options), 'http');
    assert.equal(whichPort({ port: 1883 }, options), 'mqtt');
    assert.equal(whichPort({ port: 8883 }, options), 'mqttTls');
    assert.equal(whichPort({ port: 2323 }, options), 'console');
    assert.equal(whichPort({ port: 9999 }, options), null);
    assert.equal(whichPort({}, options), null);
  });

  test('the listen failure inside an error, also as its cause', () => {
    const failure = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', syscall: 'listen', port: 1883 });
    assert.equal(listenErrorOf(failure), failure);
    assert.equal(listenErrorOf(new Error('wrapped', { cause: failure })), failure);
    assert.equal(listenErrorOf(new Error('something else')), null);
    assert.equal(listenErrorOf(undefined), null);
  });

  test('a OneCard Lab answering wins; --open moves to a free port; otherwise a message naming the setting', () => {
    assert.deepEqual(portBusyPlan({ which: 'mqtt', port: 1883, open: false, labAnswering: true }), { action: 'already-running' });
    assert.deepEqual(portBusyPlan({ which: 'http', port: 8080, open: true, labAnswering: true }), { action: 'already-running' });
    for (const which of ['http', 'mqtt', 'mqttTls', 'console']) {
      assert.deepEqual(portBusyPlan({ which, port: 4000, open: true, labAnswering: false }), { action: 'fallback', which });
    }
    const mqtt = portBusyPlan({ which: 'mqtt', port: 1883, open: false, labAnswering: false });
    assert.equal(mqtt.action, 'stop');
    assert.match(mqtt.message, /Port 1883 \(the MQTT broker\) is already in use, often another MQTT broker, such as Mosquitto/);
    assert.match(mqtt.message, /LAB_MQTT_PORT=1884 npm start/);
    assert.match(mqtt.message, /\$env:LAB_MQTT_PORT=1884; npm start/);
    assert.match(portBusyPlan({ which: 'http', port: 8080, open: false, labAnswering: false }).message, /Port 8080 \(the web apps\) is already in use by another program[\s\S]*LAB_HTTP_PORT=8081/);
    assert.match(portBusyPlan({ which: 'console', port: 2323, open: false, labAnswering: false }).message, /LAB_CONSOLE_PORT=2324[\s\S]*LAB_CONSOLE_PORT=0 starts the lab without the machine consoles/);
    assert.match(portBusyPlan({ which: 'mqttTls', port: 8883, open: false, labAnswering: false }).message, /LAB_MQTT_TLS_PORT=8884/);
    assert.equal(portBusyPlan({ which: null, port: 5000, open: true, labAnswering: false }).action, 'stop');
  });

  test('the example fits the way the lab was started', () => {
    assert.equal(startCommand(), 'npm start');
    assert.equal(startCommand({ app: true, program: 'onecard-lab-mac-arm64' }), './onecard-lab-mac-arm64');
    assert.equal(startCommand({ app: true, program: 'onecard-lab-win-x64.exe' }), '.\\onecard-lab-win-x64.exe');
    const mac = portBusyPlan({ which: 'mqtt', port: 1883, open: false, labAnswering: false, command: './onecard-lab-mac-arm64' }).message;
    assert.match(mac, /\n {2}LAB_MQTT_PORT=1884 \.\/onecard-lab-mac-arm64$/);
    assert.doesNotMatch(mac, /npm start|PowerShell/);
    const win = portBusyPlan({ which: 'http', port: 8080, open: false, labAnswering: false, command: '.\\onecard-lab-win-x64.exe' }).message;
    assert.match(win, /\(PowerShell\) \$env:LAB_HTTP_PORT=8081; \.\\onecard-lab-win-x64\.exe$/);
  });

  test('Windows refusing a port above 1024 (EACCES: kept for Hyper-V, WSL or Docker) is a taken port, not a rights problem', async () => {
    assert.equal(portTaken({ code: 'EADDRINUSE', port: 1883 }), true);
    assert.equal(portTaken({ code: 'EACCES', port: 1883 }), true);
    assert.equal(portTaken({ code: 'EACCES', port: 80 }), false); // below 1024: administrator rights (next test)
    assert.equal(portTaken({ code: 'EADDRNOTAVAIL', port: 8080 }), false);
    const plan = portBusyPlan({ which: 'mqtt', port: 1883, open: false, labAnswering: false, refused: true });
    assert.match(plan.message, /^Port 1883 \(the MQTT broker\) cannot be used on this computer: another program holds it, or Windows keeps it \(Hyper-V, WSL and Docker reserve some ports\)\.\n/);
    assert.match(plan.message, /LAB_MQTT_PORT=1884 npm start/);
    // a lab whose MQTT port Windows refuses: a plain message, or with --open a free port and a note
    const refusing = (options) => ({
      start: async () => {
        if (options.mqttPort === 1883) {
          throw Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:1883'), { code: 'EACCES', syscall: 'listen', address: '127.0.0.1', port: 1883 });
        }
        return { httpUrl: 'http://127.0.0.1:8080', mqttUrl: 'mqtt://127.0.0.1:50123' };
      },
      stop: async () => {},
    });
    const options = { httpPort: 8080, mqttPort: 1883, consolePort: 0, host: '127.0.0.1' };
    const probe = async () => false;
    await assert.rejects(startWithFallbacks({ createLab: refusing, options, probe }), (err) => err instanceof CliError && /^Port 1883 \(the MQTT broker\) cannot be used/.test(err.message));
    const { notes } = await startWithFallbacks({ createLab: refusing, options, open: true, probe });
    assert.deepEqual(notes, ['port 1883 could not be used (another program holds it, or Windows keeps it),\n      so the MQTT broker uses port 50123 this time.']);
  });

  test('other listen failures in plain words', async () => {
    const options = { httpPort: 80, mqttPort: 0, consolePort: 0, host: '127.0.0.1' };
    await assert.rejects(startWithFallbacks({ createLab: failingLab('EACCES', 80), options }), (err) =>
      err instanceof CliError && /Port 80 \(the web apps\) needs administrator rights/.test(err.message) && /LAB_HTTP_PORT=8080/.test(err.message),
    );
    await assert.rejects(startWithFallbacks({ createLab: failingLab('EADDRNOTAVAIL', 8080, '192.168.99.99'), options: { ...options, httpPort: 8080 } }), (err) =>
      err instanceof CliError && /192\.168\.99\.99 is not an address of this computer/.test(err.message) && /LAB_HOST/.test(err.message),
    );
  });

  test('anything else is not a port problem and goes on as it is', async () => {
    const boom = new Error('seed failed');
    const createLab = () => ({ start: async () => { throw boom; }, stop: async () => {} });
    await assert.rejects(startWithFallbacks({ createLab, options: { httpPort: 0, mqttPort: 0, consolePort: 0 } }), (err) => err === boom);
  });
});

describe('ports in use: a real lab', NET, () => {
  test('MQTT port taken: without --open a plain message, with --open a free port and a banner note', async () => {
    const held = await holdPort();
    const labs = recordingCreateLab();
    try {
      const options = { httpPort: 0, mqttPort: held.port, consolePort: 0, host: '127.0.0.1', ...QUIET };
      await assert.rejects(startWithFallbacks({ createLab: labs.make, options, open: false }), (err) => err instanceof CliError && err.message.includes(`Port ${held.port} (the MQTT broker)`) && err.message.includes('LAB_MQTT_PORT'));
      const { lab, started, notes } = await startWithFallbacks({ createLab: labs.make, options, open: true });
      const port = Number(new URL(started.mqttUrl).port);
      assert.notEqual(port, held.port);
      assert.equal(notes.length, 1);
      assert.match(notes[0], new RegExp(`port ${held.port} was already in use \\(often another MQTT broker, such as Mosquitto\\),\\n\\s+so the MQTT broker uses port ${port} this time\\.`));
      const banner = bannerText({ started, viewer: lab.ctx.settings.viewer, host: '127.0.0.1', notes, opened: true });
      assert.match(banner, new RegExp(`Note: port ${held.port} was already in use`));
      assert.match(banner, /Close it, or press Ctrl\+C, to stop\.$/);
    } finally {
      await labs.stopAll();
      await held.close();
    }
  });

  test('console port taken: with --open the consoles move to a free port', async () => {
    const held = await holdPort();
    const labs = recordingCreateLab();
    try {
      const options = { httpPort: 0, mqttPort: 0, consolePort: held.port, host: '127.0.0.1', ...QUIET };
      await assert.rejects(startWithFallbacks({ createLab: labs.make, options }), /LAB_CONSOLE_PORT/);
      const { started, notes } = await startWithFallbacks({ createLab: labs.make, options, open: true });
      const port = Number(started.consoleAddress.split(':').pop());
      assert.ok(port > 0 && port !== held.port);
      assert.match(notes[0], new RegExp(`so the machine consoles use port ${port} this time`));
    } finally {
      await labs.stopAll();
      await held.close();
    }
  });

  test('web port taken by another program: a message, or with --open a free port', async () => {
    const other = await webServer();
    const labs = recordingCreateLab();
    try {
      const options = { httpPort: other.port, mqttPort: 0, consolePort: 0, host: '127.0.0.1', ...QUIET };
      await assert.rejects(startWithFallbacks({ createLab: labs.make, options }), (err) => /\(the web apps\) is already in use by another program/.test(err.message) && /LAB_HTTP_PORT/.test(err.message));
      const { started, notes } = await startWithFallbacks({ createLab: labs.make, options, open: true });
      assert.notEqual(Number(new URL(started.httpUrl).port), other.port);
      assert.match(notes[0], /so the web apps use port \d+ this time/);
    } finally {
      await labs.stopAll();
      await other.close();
    }
  });

  test('web port taken by a OneCard Lab: that lab is the one to use', async () => {
    const running = await webServer({ lab: true });
    const labs = recordingCreateLab();
    try {
      const options = { httpPort: running.port, mqttPort: 0, consolePort: 0, host: '127.0.0.1', ...QUIET };
      for (const open of [false, true]) {
        assert.deepEqual(await startWithFallbacks({ createLab: labs.make, options, open }), { alreadyRunning: `http://127.0.0.1:${running.port}/lab/` });
      }
      assert.equal(await isLabAt(`http://127.0.0.1:${running.port}`), true);
    } finally {
      await labs.stopAll();
      await running.close();
    }
  });

  test('isLabAt: no for a closed port, a web page or another JSON', async () => {
    const held = await holdPort();
    const page = await webServer();
    try {
      assert.equal(await isLabAt(`http://127.0.0.1:${held.port}`), false);
      assert.equal(await isLabAt(`http://127.0.0.1:${page.port}`), false);
      assert.equal(await isLabAt('http://127.0.0.1:1', { get: async () => ({ status: 200, body: '{"schools":[]}' }) }), false);
    } finally {
      await held.close();
      await page.close();
    }
  });
});

describe('run()', NET, () => {
  test('--help: 0; an unknown option: 2; a bad setting: 1, one plain line each', async () => {
    const out = sink();
    const err = sink();
    assert.equal(await run(['--help'], {}, { out, err }), 0);
    assert.match(out.text, /LAB_HTTP_PORT/);
    assert.equal(await run(['--bogus'], {}, { out, err }), 2);
    assert.equal(await run([], { LAB_HTTP_PORT: 'x' }, { out, err }), 1);
    assert.match(err.text, /Unknown option --bogus/);
    assert.match(err.text, /LAB_HTTP_PORT must be a port number, got x/);
    assert.doesNotMatch(err.text, /\n\s+at /); // no stack trace
  });

  test('with --open: the banner says so and the lab console opens', async () => {
    const labs = recordingCreateLab();
    const out = sink();
    const opened = [];
    try {
      const code = await run(['--open'], { LAB_HTTP_PORT: '0', LAB_MQTT_PORT: '0', LAB_CONSOLE_PORT: '0' }, {
        out,
        err: sink(),
        openUrl: (url) => opened.push(url),
        loadLab: async () => labs.make,
        handleSignals: false,
      });
      assert.equal(code, null); // running
      const httpUrl = out.text.match(/Lab console {5}(http:\/\/127\.0\.0\.1:\d+)\/lab\//)[1];
      assert.deepEqual(opened, [`${httpUrl}/lab/`]);
      assert.match(out.text, /The lab console opens in your web browser/);
    } finally {
      await labs.stopAll();
    }
  });

  test('without --open the banner is the one npm start has always printed', async () => {
    const labs = recordingCreateLab();
    const out = sink();
    const opened = [];
    try {
      assert.equal(await run([], { LAB_HTTP_PORT: '0', LAB_MQTT_PORT: '0', LAB_CONSOLE_PORT: '0' }, { out, err: sink(), openUrl: (u) => opened.push(u), loadLab: async () => labs.make, handleSignals: false }), null);
      assert.deepEqual(opened, []);
      assert.match(out.text, /^\nOneCard Lab is running \(lab data only — nothing here is real\)\.\n\n {2}Lab console {5}http/);
      assert.match(out.text, /\nPress Ctrl\+C to stop\.\n$/);
      assert.doesNotMatch(out.text, /Note:/);
    } finally {
      await labs.stopAll();
    }
  });

  test('a lab already running: with --open open it and exit 0, without say so and exit 1', async () => {
    const running = await webServer({ lab: true });
    const labs = recordingCreateLab();
    const env = { LAB_HTTP_PORT: String(running.port), LAB_MQTT_PORT: '0', LAB_CONSOLE_PORT: '0' };
    try {
      const opened = [];
      const out = sink();
      assert.equal(await run(['--open'], env, { out, err: sink(), openUrl: (u) => opened.push(u), loadLab: async () => labs.make, handleSignals: false }), 0);
      assert.deepEqual(opened, [`http://127.0.0.1:${running.port}/lab/`]);
      assert.match(out.text, /OneCard Lab is already running on this computer/);
      const err = sink();
      assert.equal(await run([], env, { out: sink(), err, openUrl: (u) => opened.push(u), loadLab: async () => labs.make, handleSignals: false }), 1);
      assert.match(err.text, /OneCard Lab is already running on this computer: http:\/\/127\.0\.0\.1:\d+\/lab\//);
      assert.equal(opened.length, 1);
      assert.doesNotMatch(err.text, /EADDRINUSE/); // the broker's own log line is not shown while starting
    } finally {
      await labs.stopAll();
      await running.close();
    }
  });
});

describe('--self-test', NET, () => {
  test('passes with the real lab', async () => {
    const result = await selfTest({ createLab });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /^Self-test passed: .*\(2 schools, \d+ machines\)/);
    assert.equal(SELF_TEST_TIMEOUT_MS, 60_000);
  });

  test('fails with the reason: no start, a missing page, no answer in time', async () => {
    const noStart = await selfTest({ createLab: () => ({ start: async () => { throw new Error('the broker did not start'); }, stop: async () => {} }) });
    assert.deepEqual(noStart, { ok: false, message: 'Self-test failed: the broker did not start' });
    const empty = mkdtempSync(join(tmpdir(), 'cli-web-'));
    try {
      const missing = await selfTest({ createLab: (o) => createLab({ ...o, ...QUIET }), webRoot: empty });
      assert.equal(missing.ok, false);
      assert.match(missing.message, /\/lab\/ answered 404/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    let stopped = false;
    const stuck = await selfTest({ createLab: () => ({ start: () => new Promise(() => {}), stop: async () => { stopped = true; } }), timeoutMs: 100 });
    assert.deepEqual(stuck, { ok: false, message: 'Self-test failed: no answer within 100 ms (while starting the lab)' });
    assert.equal(stopped, true);
  });
});

describe('src/main.js', NET, () => {
  /** Run src/main.js; resolves with its exit code and output. */
  function main(args, { env = {}, until, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], {
        env: { ...process.env, LAB_HTTP_PORT: '0', LAB_MQTT_PORT: '0', LAB_CONSOLE_PORT: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`src/main.js ${args.join(' ')} did not end within ${timeoutMs} ms\n${stdout}${stderr}`));
      }, timeoutMs);
      child.stdout.on('data', (d) => {
        stdout += d;
        if (until?.test(stdout)) child.kill('SIGTERM');
      });
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  test('--self-test exits 0 with one line, within the timeout', async () => {
    const { code, stdout, stderr } = await main(['--self-test'], { timeoutMs: SELF_TEST_TIMEOUT_MS + 5000 });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Self-test passed: [^\n]+\n$/);
  });

  test('--help exits 0; an unknown option exits 2 without a stack trace', async () => {
    assert.equal((await main(['--help'])).code, 0);
    const wrong = await main(['--opne']);
    assert.equal(wrong.code, 2);
    assert.equal(wrong.stderr, 'Unknown option --opne. The options are: --open, --no-open, --lan, --self-test, --help.\n');
  });

  test('--open without any browser to open: the lab still starts, and a stop request stops it', { skip: process.platform === 'win32' && 'SIGTERM ends a Windows process without a handler' }, async () => {
    const { code, stdout } = await main(['--open'], { env: { PATH: '' }, until: /Close it, or press Ctrl\+C, to stop\./ });
    assert.match(stdout, /OneCard Lab is running/);
    assert.match(stdout, /Stopping the lab…/);
    assert.equal(code, 0);
  });
});
