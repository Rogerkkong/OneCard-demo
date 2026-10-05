import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { format } from 'node:util';

// The lab's command line (docs/DESIGN.md §8 and §13). `npm start`, the double-click launchers
// (through src/main.js) and the single-file desktop app (src/app/sea-main.js) all come through
// main() → run(). Problems a person can fix — a port in use, a bad setting, a missing file —
// end in plain sentences, never in a stack trace.
//
// No top-level await here or below: the desktop app bundles this file into CommonJS.

/** How long --self-test may take before it gives up. */
export const SELF_TEST_TIMEOUT_MS = 60_000;
/** How long a stop (Ctrl+C) may take before the process ends anyway, ports and all. */
const STOP_GRACE_MS = 10_000;
/** How long to wait for whatever answers on a busy web port (is it a OneCard Lab?). */
const PROBE_TIMEOUT_MS = 2000;

/** A problem the person can fix: printed as it is, without a stack trace. */
export class CliError extends Error {
  /** @param {string} message @param {number} [exitCode] 1, or 2 for a wrong option */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * The --help text.
 * @param {{ app?: boolean, program?: string }} [how]  app: the single-file app, started as `program`
 */
export function helpText({ app = false, program = 'onecard-lab' } = {}) {
  const command = startCommand({ app, program });
  const windows = /\.exe$/i.test(command);
  const start = app
    ? `  Double-click ${program}, or start it in a terminal: ${command} [options]
  It opens the lab console in your web browser (--no-open: it does not).`
    : `  npm start                 this computer only
  npm run start:lan         also reachable from phones and computers on your network
  npm start -- --open       and open the lab console in your web browser
  npm start -- --help       this help`;
  return `OneCard Lab: the whole school card system as a virtual lab, on this computer.

Start it:
${start}

Options:
  --open        open the lab console in your web browser once the lab is up
  --no-open     do not open the browser
  --lan         listen on every network (0.0.0.0), not only this computer
  --self-test   start on free ports, check the web apps answer, stop again:
                exit code 0, or 1 with the reason
  --help, -h    show this help

Settings (environment variables):
  LAB_HTTP_PORT      web apps and APIs (default 8080)
  LAB_MQTT_PORT      MQTT broker (default 1883)
  LAB_CONSOLE_PORT   machine and server consoles for PuTTY / telnet (default 2323, 0 = off)
  LAB_HOST           address to listen on (default 127.0.0.1, this computer only;
                     --lan means 0.0.0.0)
  LAB_ALLOWED_HOSTS  host names the web apps answer to besides localhost and IP addresses
                     (comma-separated, e.g. mylaptop.local; * turns the check off)
  LAB_MQTT_TLS_CERT, LAB_MQTT_TLS_KEY
                     optional MQTT over TLS (make lab certificates with scripts/make-lab-certs.sh)
  LAB_MQTT_TLS_PORT  port of the TLS listener (default 8883)

${
    windows
      ? `For example, in PowerShell: $env:LAB_HTTP_PORT=8090; ${command}`
      : `For example: LAB_HTTP_PORT=8090 ${command}${app ? '' : `\n  (Windows PowerShell: $env:LAB_HTTP_PORT=8090; ${command})`}`
  }`;
}

/** How the person starts the lab again: `npm start`, or the desktop app's own name. */
export function startCommand({ app = false, program = 'onecard-lab' } = {}) {
  if (!app) return 'npm start';
  return /\.exe$/i.test(program) ? `.\\${program}` : `./${program}`;
}

/** "Start it with this setting" for the person's system and way of starting. */
function withSetting(name, value, command) {
  if (/\.exe$/i.test(command)) return `  (PowerShell) $env:${name}=${value}; ${command}`;
  if (command !== 'npm start') return `  ${name}=${value} ${command}`;
  return `  ${name}=${value} npm start\n  (Windows PowerShell: $env:${name}=${value}; npm start)`;
}

/**
 * Read the command-line options.
 * @param {string[]} argv  the arguments after the script (process.argv.slice(2))
 * @param {{ defaultOpen?: boolean }} [defaults]  the desktop app opens the browser by default
 * @returns {{ open: boolean, lan: boolean, selfTest: boolean, help: boolean }}
 * @throws {CliError} exit code 2 for an option it does not know
 */
export function parseArgs(argv = [], { defaultOpen = false } = {}) {
  const cli = { open: defaultOpen, lan: false, selfTest: false, help: false };
  for (const arg of argv) {
    if (arg === '--open') cli.open = true;
    else if (arg === '--no-open') cli.open = false;
    else if (arg === '--lan') cli.lan = true;
    else if (arg === '--self-test') cli.selfTest = true;
    else if (arg === '--help' || arg === '-h') cli.help = true;
    else throw new CliError(`Unknown option ${arg}. The options are: --open, --no-open, --lan, --self-test, --help.`, 2);
  }
  return cli;
}

/** A file named by a setting, or a plain message. */
function readSettingFile(env, name) {
  const file = env[name];
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    const why = err?.code === 'ENOENT' ? 'there is no such file' : err?.code === 'EISDIR' ? 'it is a folder' : err?.message;
    throw new CliError(`Could not read ${name} (${file}): ${why}.`);
  }
}

/**
 * The lab's options from the environment, exactly as `npm start` has always read them.
 * @param {object} env  process.env, or a test's own
 * @param {{ lan?: boolean }} [cli]
 * @returns {{ httpPort: number, mqttPort: number, consolePort: number, host: string,
 *   tls?: { port: number, cert: string, key: string } }}
 * @throws {CliError}
 */
export function labOptionsFromEnv(env = {}, { lan = false } = {}) {
  const port = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new CliError(`${name} must be a port number, got ${env[name]}`);
    return value;
  };
  const options = {
    httpPort: port('LAB_HTTP_PORT', 8080),
    mqttPort: port('LAB_MQTT_PORT', 1883),
    consolePort: port('LAB_CONSOLE_PORT', 2323),
    host: lan ? '0.0.0.0' : env.LAB_HOST || '127.0.0.1',
  };
  if (env.LAB_MQTT_TLS_CERT || env.LAB_MQTT_TLS_KEY) {
    if (!env.LAB_MQTT_TLS_CERT || !env.LAB_MQTT_TLS_KEY) throw new CliError('Set both LAB_MQTT_TLS_CERT and LAB_MQTT_TLS_KEY, or neither.');
    options.tls = {
      port: port('LAB_MQTT_TLS_PORT', 8883),
      cert: readSettingFile(env, 'LAB_MQTT_TLS_CERT'),
      key: readSettingFile(env, 'LAB_MQTT_TLS_KEY'),
    };
  }
  // Two of the lab's own listeners on one port can never start: say which, instead of "in use".
  const taken = new Map();
  for (const [which, value] of listeners(options)) {
    if (!value) continue; // 0: a free port (or, for the consoles, off)
    if (taken.has(value)) throw new CliError(`${PORTS[taken.get(value)].env} and ${PORTS[which].env} are both ${value}: give each its own port.`);
    taken.set(value, which);
  }
  return options;
}

// ---- the lab's ports -----------------------------------------------------------------------------

/** The lab's listeners: the setting that moves each one, and what it is for. */
const PORTS = {
  http: { env: 'LAB_HTTP_PORT', what: 'the web apps', uses: 'the web apps use' },
  mqtt: { env: 'LAB_MQTT_PORT', what: 'the MQTT broker', uses: 'the MQTT broker uses', usual: 'often another MQTT broker, such as Mosquitto' },
  mqttTls: { env: 'LAB_MQTT_TLS_PORT', what: 'MQTT over TLS', uses: 'MQTT over TLS uses' },
  console: { env: 'LAB_CONSOLE_PORT', what: 'the machine consoles', uses: 'the machine consoles use' },
};

/** [which, port] of each listener the options ask for. */
function listeners(options) {
  return [
    ['http', options.httpPort],
    ['mqtt', options.mqttPort],
    ...(options.tls ? [['mqttTls', options.tls.port ?? 8883]] : []),
    ['console', options.consolePort],
  ];
}

/** The address the lab is reached on from this computer: a wildcard listen address is reachable on loopback. */
function reachableHost(host) {
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** The listen failure inside an error from lab.start() (the error itself, or one it was caused by). */
export function listenErrorOf(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    if (e.syscall === 'listen' || (typeof e.code === 'string' && /^EADDR(INUSE|NOTAVAIL)$/.test(e.code))) return e;
  }
  return null;
}

/**
 * Which of the lab's listeners a listen failure is about.
 * @returns {'http'|'mqtt'|'mqttTls'|'console'|null}
 */
export function whichPort(failure, options) {
  if (!failure || !Number.isInteger(failure.port) || failure.port === 0) return null;
  const hit = listeners(options).find(([, port]) => port === failure.port);
  return hit ? hit[0] : null;
}

/** A port to suggest instead of a busy one. */
const nextPort = (port) => (port >= 65535 ? 1024 : port + 1);

/**
 * What to do when a port the lab needs is in use (EADDRINUSE).
 * @param {object} situation
 * @param {'http'|'mqtt'|'mqttTls'|'console'|null} situation.which  the busy listener
 * @param {number} [situation.port]  the busy port
 * @param {boolean} situation.open  started with --open (double-click): nobody can type a setting
 * @param {boolean} situation.labAnswering  a OneCard Lab answers on the lab's web port
 * @param {string} [situation.command]  how the lab is started (startCommand()), for the example
 * @returns {{ action: 'already-running' } | { action: 'fallback', which: string } | { action: 'stop', message: string }}
 *   already-running: that lab is the one to use; fallback: take a free port and say so in the
 *   banner; stop: the message says what to change
 */
export function portBusyPlan({ which, port, open, labAnswering, command = 'npm start' }) {
  if (labAnswering) return { action: 'already-running' };
  if (!which) {
    return { action: 'stop', message: `A port the lab needs${port ? ` (${port})` : ''} is already in use by another program. Stop that program, or choose other ports (see --help).` };
  }
  if (open) return { action: 'fallback', which };
  const { env, what, usual } = PORTS[which];
  const instead = nextPort(port);
  return {
    action: 'stop',
    message:
      `Port ${port} (${what}) is already in use${usual ? `, ${usual}` : ' by another program'}.\n` +
      `Stop that program, or start the lab with another port, for example:\n` +
      withSetting(env, instead, command) +
      (which === 'console' ? `\n${env}=0 starts the lab without the machine consoles.` : ''),
  };
}

/** A free TCP port on `host`, for a listener where 0 does not mean "any free port". */
export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The same options with `which` moved to a free port. */
async function withFreePort(options, which, findFreePort) {
  if (which === 'http') return { ...options, httpPort: 0 };
  if (which === 'mqtt') return { ...options, mqttPort: 0 };
  if (which === 'mqttTls') return { ...options, tls: { ...options.tls, port: 0 } };
  // consolePort 0 means "no consoles", so pick a free port first
  return { ...options, consolePort: await findFreePort(options.host) };
}

/** The port of each listener the lab started, from start()'s answer. */
function startedPorts(started) {
  const portOf = (url) => (url ? Number(new URL(url).port) : null);
  return {
    http: portOf(started.httpUrl),
    mqtt: portOf(started.mqttUrl),
    mqttTls: portOf(started.mqttTlsUrl),
    console: started.consoleAddress ? Number(String(started.consoleAddress).split(':').pop()) : null,
  };
}

/** Banner notes for the listeners that moved to another port. */
function fallbackNotes(moved, started) {
  const now = startedPorts(started);
  return moved.map(({ which, from }) => {
    const { uses, usual } = PORTS[which];
    return `port ${from} was already in use${usual ? ` (${usual})` : ''},\n      so ${uses} port ${now[which]} this time.`;
  });
}

/**
 * GET a URL with a deadline, no keep-alive (nothing stays open afterwards).
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function httpGet(url, { timeoutMs = 5000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
        else req.destroy(new Error(`${url} answered more than ${maxBytes} bytes`));
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${url} within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end();
  });
}

/** Whether a OneCard Lab answers at `base` (GET /api/lab/state answers like one). */
export async function isLabAt(base, { get = httpGet } = {}) {
  try {
    const res = await get(`${base}/api/lab/state`, { timeoutMs: PROBE_TIMEOUT_MS });
    if (res.status !== 200) return false;
    const state = JSON.parse(res.body);
    return Array.isArray(state?.schools) && state.server !== null && typeof state.server === 'object';
  } catch {
    return false;
  }
}

/** A listen failure other than "in use", in plain words. */
function listenProblem(failure, which) {
  const port = failure.port;
  const setting = which ? PORTS[which] : null;
  if (failure.code === 'EACCES') {
    return new CliError(
      `Port ${port}${setting ? ` (${setting.what})` : ''} needs administrator rights on this computer. ` +
        `Use a port from 1024 to 65535${setting ? `, for example ${setting.env}=${port < 1024 ? 8000 + port : nextPort(port)}` : ''}.`,
    );
  }
  if (failure.code === 'EADDRNOTAVAIL') {
    return new CliError(
      `${failure.address ?? 'That address'} is not an address of this computer, so the lab cannot listen there. ` +
        'Check LAB_HOST (default 127.0.0.1; --lan listens on every network).',
    );
  }
  return new CliError(`The lab could not listen on ${failure.address ?? ''}${port ? `:${port}` : ''}: ${failure.message}`);
}

/**
 * Start the lab; when a port is in use, decide as portBusyPlan() says: use the lab that is
 * already running, move to a free port (with --open), or stop with a plain message.
 * @param {object} deps
 * @param {(options: object) => object} deps.createLab
 * @param {object} deps.options  createLab options (labOptionsFromEnv(), plus webRoot for the app)
 * @param {boolean} [deps.open]  started with --open
 * @param {(base: string) => Promise<boolean>} [deps.probe]  isLabAt()
 * @param {(host: string) => Promise<number>} [deps.findFreePort]  freePort()
 * @param {string} [deps.command]  how the lab is started (startCommand()), for the messages
 * @returns {Promise<{ lab: object, started: object, notes: string[] } | { alreadyRunning: string }>}
 *   alreadyRunning: the lab console address of the lab that runs already
 * @throws {CliError} a port problem the person must fix; other errors as they come
 */
export async function startWithFallbacks({ createLab, options, open = false, probe = isLabAt, findFreePort = freePort, command = 'npm start' }) {
  let current = { ...options };
  const moved = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const lab = createLab(current);
    try {
      const started = await lab.start();
      return { lab, started, notes: fallbackNotes(moved, started) };
    } catch (err) {
      const failure = listenErrorOf(err);
      if (!failure) throw err;
      const which = whichPort(failure, current);
      if (failure.code !== 'EADDRINUSE') throw listenProblem(failure, which);
      // Whatever is busy: if a OneCard Lab answers on our web port, that is the lab to use.
      const base = current.httpPort ? `http://${reachableHost(current.host)}:${current.httpPort}` : null;
      const labAnswering = base ? await probe(base) : false;
      const plan = portBusyPlan({ which, port: failure.port, open, labAnswering, command });
      if (plan.action === 'already-running') return { alreadyRunning: `${base}/lab/` };
      if (plan.action === 'stop') throw new CliError(plan.message);
      if (!moved.some((m) => m.which === which)) moved.push({ which, from: failure.port });
      current = await withFreePort(current, which, findFreePort);
    }
  }
  throw new CliError('The lab could not find free ports to listen on. Stop some other programs and start it again.');
}

// ---- the browser ---------------------------------------------------------------------------------

/**
 * How to open a URL in the default browser on each system.
 * @returns {{ command: string, args: string[], options: object }}
 */
export function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url], options: {} };
  if (platform === 'win32') {
    // start's first quoted argument is the window title; verbatim, so Node does not escape the ""
    return { command: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true } };
  }
  return { command: 'xdg-open', args: [url], options: {} };
}

/**
 * Open a URL in the default browser, detached. Never throws and never waits: a missing browser
 * or command only means the person opens the address the banner shows.
 * @returns {boolean} whether an opener was started
 */
export function openInBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  // our own addresses only (http://127.0.0.1:8080/lab/): nothing a shell could read as a command
  if (typeof url !== 'string' || !/^https?:\/\/[A-Za-z0-9.:[\]/_-]+$/.test(url)) return false;
  const { command, args, options } = openCommand(url, platform);
  try {
    const child = spawnFn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
    child?.on?.('error', () => {});
    child?.unref?.();
    return Boolean(child);
  } catch {
    return false;
  }
}

// ---- self-test -----------------------------------------------------------------------------------

/**
 * Start the lab on free ports, fetch /lab/ and /api/lab/state, stop it (DESIGN §13).
 * @param {object} deps
 * @param {(options: object) => object} deps.createLab
 * @param {string} [deps.webRoot]  the desktop app's unpacked web apps
 * @param {number} [deps.timeoutMs]  default 60 s
 * @returns {Promise<{ ok: boolean, message: string }>} one line either way
 */
export async function selfTest({ createLab, webRoot, timeoutMs = SELF_TEST_TIMEOUT_MS, get = httpGet }) {
  const began = performance.now();
  let step = 'starting the lab';
  let lab = null;
  const work = (async () => {
    lab = createLab({ httpPort: 0, mqttPort: 0, consolePort: 0, host: '127.0.0.1', ...(webRoot ? { webRoot } : {}) });
    const started = await lab.start();
    step = 'loading /lab/';
    const page = await get(`${started.httpUrl}/lab/`);
    if (page.status !== 200) throw new Error(`/lab/ answered ${page.status} instead of 200`);
    if (!/^text\/html/i.test(page.headers['content-type'] ?? '') || !/<html/i.test(page.body)) {
      throw new Error('/lab/ did not answer with the lab console page (HTML)');
    }
    step = 'loading /api/lab/state';
    const res = await get(`${started.httpUrl}/api/lab/state`);
    if (res.status !== 200) throw new Error(`/api/lab/state answered ${res.status} instead of 200`);
    let state;
    try {
      state = JSON.parse(res.body);
    } catch {
      throw new Error('/api/lab/state did not answer JSON');
    }
    const schools = Array.isArray(state?.schools) ? state.schools : [];
    if (schools.length === 0) throw new Error('/api/lab/state lists no school');
    step = 'stopping the lab';
    const running = lab;
    lab = null;
    await running.stop();
    return { schools: schools.length, machines: schools.reduce((n, s) => n + (Array.isArray(s.devices) ? s.devices.length : 0), 0) };
  })();
  let timer = null;
  const deadline = new Promise((resolve, reject) => {
    const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
    timer = setTimeout(() => reject(new Error(`no answer within ${limit} (while ${step})`)), timeoutMs);
  });
  try {
    const { schools, machines } = await Promise.race([work, deadline]);
    const seconds = ((performance.now() - began) / 1000).toFixed(1);
    return {
      ok: true,
      message: `Self-test passed: the lab started, served /lab/ and /api/lab/state (${schools} schools, ${machines} machines) and stopped, in ${seconds} s.`,
    };
  } catch (err) {
    work.catch(() => {}); // the race's loser must not become an unhandled rejection
    if (lab) {
      const stopping = lab.stop().catch(() => {});
      let wait = null;
      await Promise.race([stopping, new Promise((resolve) => (wait = setTimeout(resolve, 5000)))]);
      clearTimeout(wait);
    }
    return { ok: false, message: `Self-test failed: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- running -------------------------------------------------------------------------------------

/** This computer's own network addresses, for opening the lab on a phone. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/**
 * What the lab prints once it is up. Without notes and --open it is the banner `npm start` has
 * always printed.
 */
export function bannerText({ started, viewer, host, notes = [], opened = false }) {
  const mqttPortShown = new URL(started.mqttUrl).port;
  const httpPortShown = new URL(started.httpUrl).port;
  const localOnly = host === '127.0.0.1' || host === 'localhost';
  const tail = opened
    ? 'The lab console opens in your web browser (if it does not, open the Lab console address above).\n' +
      'Keep this window open: it is the lab. Close it, or press Ctrl+C, to stop.'
    : 'Press Ctrl+C to stop.';
  return `
OneCard Lab is running (lab data only — nothing here is real).

  Lab console     ${started.httpUrl}/lab/
  Operator        ${started.httpUrl}/operator/
  School office   ${started.httpUrl}/admin/
  Parent app      ${started.httpUrl}/parent/

  MQTT broker     ${started.mqttUrl}${started.mqttTlsUrl ? `\n  MQTT over TLS   ${started.mqttTlsUrl}` : ''}
  Read-only login ${viewer.username} / ${viewer.password}
  Watch traffic   mosquitto_sub -h 127.0.0.1 -p ${mqttPortShown} -u ${viewer.username} -P ${viewer.password} -t 'lab/v1/#' -v
                  (or MQTT Explorer with the same login)
${started.consoleAddress ? `
  Consoles        PuTTY: Telnet to ${started.consoleAddress.replace(':', ' port ')} (Mac/Linux: nc ${started.consoleAddress.replace(':', ' ')})
                  then type: machines · connect smk-contoh/CANTEEN-01 · show status
` : ''}${localOnly ? '' : `
  On a phone on the same Wi-Fi: ${lanAddresses().map((ip) => `http://${ip}:${httpPortShown}/parent/`).join('  or  ') || '(no network address found)'}
  Note: listening on ${host}. Other computers on your network can reach the lab,
  and the lab has no passwords. Only do this on a network you trust.
`}
${notes.map((note) => `Note: ${note}\n`).join('')}${tail}`;
}

/** Ctrl+C or a stop request: stop the lab, then end the process. */
function stopOnSignals(lab, say) {
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    say('\nStopping the lab…');
    // a stop that hangs must not keep the ports (and the window) busy
    setTimeout(() => process.exit(1), STOP_GRACE_MS).unref();
    try {
      await lab.stop();
    } finally {
      process.exit(0);
    }
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * The lab's logger: errors to stderr as the lab's default does, except a port problem while the
 * lab starts, which run() explains itself (the broker also logs it as a listener error).
 */
function startLogger(write) {
  let starting = true;
  const log = (level, message, meta) => {
    if (level !== 'error') return;
    if (starting && /^listen E(ADDRINUSE|ACCES|ADDRNOTAVAIL)\b/.test(String(meta?.error ?? ''))) return;
    try {
      write(format(`[lab] ${message}`, meta ?? ''));
    } catch {
      // a closed window must not break the lab
    }
  };
  return { log, started: () => (starting = false) };
}

/** The text for an error run() did not expect: the details first, the plain sentence last. */
function problemText(err) {
  if (err instanceof CliError || err?.name === 'UnpackError') return err.message;
  if (/^ERR_(OSSL|TLS)/.test(String(err?.code ?? ''))) {
    return `The MQTT TLS certificate or key could not be used (LAB_MQTT_TLS_CERT, LAB_MQTT_TLS_KEY): ${err.message}`;
  }
  return `${err?.stack ?? err}\n\nOneCard Lab could not start: ${err?.message ?? err}`;
}

/**
 * Run the command line.
 * @param {string[]} argv  process.argv.slice(2)
 * @param {object} env  process.env
 * @param {object} [how]
 * @param {string} [how.webRoot]  the web apps' folder (the desktop app's unpacked copy)
 * @param {boolean} [how.defaultOpen]  open the browser unless --no-open (the desktop app)
 * @param {boolean} [how.app]  the single-file app (for --help), started as `how.program`
 * @param {{ write(text: string): unknown }} [how.out]  default process.stdout
 * @param {{ write(text: string): unknown }} [how.err]  default process.stderr
 * @param {(url: string) => unknown} [how.openUrl]  default openInBrowser
 * @param {() => Promise<Function>} [how.loadLab]  resolves to createLab (tests pass their own)
 * @param {boolean} [how.handleSignals]  stop on SIGINT/SIGTERM (default true)
 * @returns {Promise<number|null>} the exit code, or null while the lab runs (it stops on Ctrl+C)
 */
export async function run(argv = [], env = {}, how = {}) {
  const {
    webRoot,
    defaultOpen = false,
    app = false,
    program,
    out = process.stdout,
    err = process.stderr,
    openUrl = (url) => openInBrowser(url),
    loadLab = async () => (await import('./lab/lab.js')).createLab,
    handleSignals = true,
  } = how;
  const say = (text) => out.write(`${text}\n`);
  const complain = (text) => err.write(`${text}\n`);
  try {
    const cli = parseArgs(argv, { defaultOpen });
    if (cli.help) {
      say(helpText({ app, program }));
      return 0;
    }
    const createLab = await loadLab();
    if (cli.selfTest) {
      const result = await selfTest({ createLab, webRoot });
      (result.ok ? say : complain)(result.message);
      return result.ok ? 0 : 1;
    }
    const logger = startLogger(complain);
    const options = { ...labOptionsFromEnv(env, { lan: cli.lan }), ...(webRoot ? { webRoot } : {}), log: logger.log };
    const command = startCommand({ app, program });
    const outcome = await startWithFallbacks({ createLab, options, open: cli.open, command });
    logger.started();
    if (outcome.alreadyRunning) {
      if (cli.open) {
        say(`OneCard Lab is already running on this computer: ${outcome.alreadyRunning}\nOpening it in your web browser.`);
        openUrl(outcome.alreadyRunning);
        return 0;
      }
      complain(
        `OneCard Lab is already running on this computer: ${outcome.alreadyRunning}\n` +
          'Use that one, or stop it first (Ctrl+C in its window). A second lab needs other ports: see --help.',
      );
      return 1;
    }
    const { lab, started, notes } = outcome;
    // before the banner: whoever reads it may press Ctrl+C at once
    if (handleSignals) stopOnSignals(lab, say);
    say(bannerText({ started, viewer: lab.ctx.settings.viewer, host: options.host, notes, opened: cli.open }));
    if (cli.open) openUrl(`${started.httpUrl}/lab/`);
    return null;
  } catch (error) {
    complain(problemText(error));
    return error instanceof CliError ? error.exitCode : 1;
  }
}

/** End the process once what was written has left (pipes are written asynchronously on macOS and Windows). */
function exitWhenWritten(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

/**
 * End the program. With `pause` (and a person at the keyboard), first wait for Enter: a window
 * that a double-click opened on Windows closes the moment the program ends, message and all.
 * @param {number} code  exit code
 * @param {{ pause?: boolean }} [how]
 */
export async function finish(code, { pause = false } = {}) {
  if (pause && process.stdin.isTTY) {
    process.stdout.write('\nPress Enter to close. / 按 Enter 关闭。\n');
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once('data', resolve);
      process.stdin.once('end', resolve);
    });
  }
  exitWhenWritten(code);
}

/**
 * The whole program: run(), then end the process with its exit code, unless the lab runs.
 * Same arguments as run(), plus `how.pauseOnError` (the desktop app on Windows): wait for Enter
 * before a failure closes the window.
 */
export async function main(argv, env, how = {}) {
  let code;
  try {
    code = await run(argv, env, how);
  } catch (err) {
    process.stderr.write(`${problemText(err)}\n`);
    code = 1;
  }
  if (code !== null) await finish(code, { pause: Boolean(how.pauseOnError) && code !== 0 });
}
