import { createServer, STATUS_CODES } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabError, isLabError } from '../shared/errors.js';
import { safeEqual, signRequest } from '../shared/crypto.js';
import { MINUTE } from '../shared/time.js';
import { LAB_OPERATOR, routes as operatorRoutes } from './routes/operator.js';
import { routes as adminRoutes } from './routes/admin.js';
import { routes as parentRoutes } from './routes/parent.js';
import { routes as payRoutes } from './routes/pay.js';
import { routes as kioskRoutes } from './routes/kiosk.js';

// The lab's web server (docs/DESIGN.md §7): the JSON APIs of the operator console, the school
// office, the parent app, the mock bank and the kiosk, the lab console's routes and live event
// stream, and the web apps under web/.
//
// Route modules (src/http/routes/*.js) only say what each endpoint does. This file owns what
// surrounds them: parsing, sessions, the kiosk's request signatures, mapping errors to answers,
// static files and server-sent events. A school id never comes from a request in the admin
// API: the staff session names the school, and route handlers get it as `req.school`.
//
// The virtual cloud server can be switched off in the lab (lab.server.up = false). Then every
// product route answers 503 SERVER_DOWN, while the lab's own routes (/api/lab/*), the event
// stream and the web apps keep working: the lab is the room the server stands in, not the product.

/** Largest request body accepted (DESIGN §7). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Session cookie of each kind of user. HttpOnly, SameSite=Lax, Path=/. */
export const SESSION_COOKIES = Object.freeze({ operator: 'lab_operator', staff: 'lab_staff', parent: 'lab_parent' });
/** The live event stream of the lab console (server-sent events). */
export const EVENTS_PATH = '/api/lab/events';

const AUTHS = new Set(['none', 'operator', 'staff', 'parent', 'kiosk']);
const BODY_KINDS = new Set(['json', 'form', 'none']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Methods that change something: a cross-origin page must not send them with our cookies. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const KIOSK_CLOCK_SKEW_MS = 5 * MINUTE; // DESIGN §3: more than 5 minutes from the lab clock is refused
const NONCE_RE = /^[\x21-\x7e]{16,64}$/; // printable ASCII, no spaces (DESIGN §3: 16-64 chars)
const TIMESTAMP_RE = /^\d{1,16}$/;
const DEFAULT_HEARTBEAT_MS = 15_000;
const STREAM_CHECK_MS = 1000; // how often a stream checks that the lab still has the same event bus
const MAX_STREAM_BACKLOG = 1024 * 1024; // a client this far behind is dropped; it reconnects and replays
const MAX_SESSIONS = 10_000;
// Bytes of an over-long body read and thrown away so the client can still read the 413;
// beyond this the connection is simply cut.
const MAX_DISCARD_BYTES = 16 * MAX_BODY_BYTES;

const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'",
  // the lab's data changes all the time and the web apps have no build step: never serve a stale copy
  'cache-control': 'no-store',
});

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
});

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));
const LAB_ROUTES_URL = new URL('./routes/lab.js', import.meta.url);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- route modules -------------------------------------------------------------------------

/**
 * Import a route module that may not have been written yet. Null only when the file itself is
 * missing; a file that exists but fails to load (a syntax error, a missing import of its own)
 * is an error, so a broken module is noticed at start-up instead of silently losing its routes.
 * @param {URL|string} url  file URL of the module
 * @returns {Promise<object|null>} the module namespace, or null
 */
export async function importOptionalModule(url) {
  try {
    return await import(url);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && !(await fileExists(url))) return null;
    throw err;
  }
}

async function fileExists(url) {
  try {
    await access(url instanceof URL ? url : new URL(url));
    return true;
  } catch {
    return false;
  }
}

/** Check one route definition and prepare it for matching. Malformed definitions are a TypeError. */
function compileRoute(route, source) {
  const where = `${source} route ${route?.method} ${route?.path}`;
  if (!isPlainObject(route)) throw new TypeError(`${source}: every route must be an object`);
  const method = typeof route.method === 'string' ? route.method.toUpperCase() : '';
  if (!METHODS.has(method)) throw new TypeError(`${where}: unsupported method`);
  if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.includes('?')) {
    throw new TypeError(`${where}: path must start with / and have no query`);
  }
  if (!AUTHS.has(route.auth)) throw new TypeError(`${where}: auth must be one of ${[...AUTHS].join(', ')}`);
  if (typeof route.handler !== 'function') throw new TypeError(`${where}: handler must be a function`);
  if (route.roles !== undefined && (!Array.isArray(route.roles) || !route.roles.every((r) => typeof r === 'string'))) {
    throw new TypeError(`${where}: roles must be a list of role names`);
  }
  const body = route.body ?? (method === 'GET' ? 'none' : 'json');
  if (!BODY_KINDS.has(body)) throw new TypeError(`${where}: body must be json, form or none`);
  const segments = route.path
    .split('/')
    .slice(1)
    .map((s) => (s.startsWith(':') && s.length > 1 ? { param: s.slice(1) } : { literal: s }));
  return { ...route, method, body, segments, source };
}

/** Params of `route` for the decoded path segments, or null when it does not match. */
function matchSegments(route, parts) {
  if (route.segments.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = route.segments[i];
    if (seg.literal !== undefined) {
      if (seg.literal !== parts[i]) return null;
    } else {
      if (parts[i] === '') return null;
      params[seg.param] = parts[i];
    }
  }
  return params;
}

/** True when `a` is more specific than `b`: at the first segment where they differ, a literal beats a param. */
function moreSpecific(a, b) {
  for (let i = 0; i < a.segments.length; i++) {
    const la = a.segments[i].literal !== undefined;
    const lb = b.segments[i].literal !== undefined;
    if (la !== lb) return la;
  }
  return false;
}

function createRouter(routeList) {
  const seen = new Set();
  for (const r of routeList) {
    const key = `${r.method} ${r.segments.map((s) => (s.literal !== undefined ? s.literal : ':')).join('/')}`;
    if (seen.has(key)) throw new TypeError(`${r.source}: route ${r.method} ${r.path} is defined twice`);
    seen.add(key);
  }
  return {
    /** @returns {{ route?: object, params?: object, allowed: string[] }} */
    match(method, parts) {
      let best = null;
      let bestParams = null;
      const allowed = new Set();
      for (const route of routeList) {
        const params = matchSegments(route, parts);
        if (!params) continue;
        allowed.add(route.method);
        if (route.method !== method) continue;
        if (!best || moreSpecific(route, best)) {
          best = route;
          bestParams = params;
        }
      }
      return best ? { route: best, params: bestParams, allowed: [...allowed] } : { allowed: [...allowed] };
    },
  };
}

// ---- sessions ------------------------------------------------------------------------------

/** Cookie pairs of a request, in order (a name may appear more than once). */
function parseCookies(header) {
  const out = [];
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return out;
}

/**
 * In-memory sessions: random tokens in HttpOnly cookies, one cookie per kind of user, so one
 * browser can be the operator, a staff member and a parent at once (the lab has three apps).
 * Lab only: there are no passwords, you pick who you are.
 */
function createSessions() {
  const store = new Map(); // token -> { role, id }

  const tokensOf = (role, headers) => {
    const name = SESSION_COOKIES[role];
    return parseCookies(headers?.cookie).filter(([k]) => k === name).map(([, v]) => v);
  };
  const cookie = (role, value, extra = '') => `${SESSION_COOKIES[role]}=${value}; Path=/; HttpOnly; SameSite=Lax${extra}`;
  const requireRole = (role) => {
    if (!Object.hasOwn(SESSION_COOKIES, role)) throw new TypeError(`unknown session role ${role}`);
  };

  return {
    /** The id signed in as `role` on this request, or null. */
    find(role, headers) {
      for (const token of tokensOf(role, headers)) {
        const s = store.get(token);
        if (s && s.role === role) return s.id;
      }
      return null;
    },
    /** Start a new session (any earlier one of this browser for the role ends). @returns the Set-Cookie headers */
    signIn(role, id, req) {
      requireRole(role);
      for (const token of tokensOf(role, req?.headers)) store.delete(token);
      const token = randomBytes(32).toString('base64url');
      store.set(token, { role, id });
      // oldest first (Map order): a lab never needs more, and the map cannot grow without bound
      while (store.size > MAX_SESSIONS) store.delete(store.keys().next().value);
      return { 'set-cookie': cookie(role, token) };
    },
    /** End this browser's session for `role`. @returns the Set-Cookie headers that clear the cookie */
    signOut(role, req) {
      requireRole(role);
      for (const token of tokensOf(role, req?.headers)) store.delete(token);
      return { 'set-cookie': cookie(role, '', '; Max-Age=0') };
    },
    clear() {
      store.clear();
    },
  };
}

// ---- small helpers -------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Address to use for a listen address: a wildcard one is reachable on loopback. */
function urlHost(host) {
  if (host === '0.0.0.0' || host === '' || host === undefined || host === null) return '127.0.0.1';
  if (host === '::') return '[::1]';
  return isIPv6(host) ? `[${host}]` : host;
}

/** The query string as an object (the first value of a repeated key). */
function queryObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) {
    if (k === '__proto__' || Object.hasOwn(out, k)) continue;
    out[k] = v;
  }
  return out;
}

/** Media type and charset of a Content-Type header ('' when missing). */
function contentTypeOf(header) {
  if (typeof header !== 'string' || header.trim() === '') return { type: '', charset: null };
  const [type, ...params] = header.split(';');
  let charset = null;
  for (const p of params) {
    const [k, v] = p.split('=').map((s) => s?.trim().toLowerCase());
    if (k === 'charset') charset = (v ?? '').replace(/^"|"$/g, '');
  }
  return { type: type.trim().toLowerCase(), charset };
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A handler's `{ status, body, headers }` answer, as opposed to a plain value to send as JSON. */
function isReply(value) {
  if (!isPlainObject(value)) return false;
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) return false;
  return Object.keys(value).every((k) => k === 'status' || k === 'body' || k === 'headers');
}

const PAGE_TITLES = {
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Not allowed',
  404: 'Not found',
  405: 'Not allowed here',
  409: 'Conflict',
  413: 'Too large',
  415: 'Unsupported content',
  500: 'Something went wrong',
  502: 'Bad gateway',
  503: 'Server unavailable',
};

/** A plain error page for the routes people open in a browser (no scripts: the CSP forbids inline ones anyway). */
function errorPage(status, code, message) {
  const title = PAGE_TITLES[status] ?? STATUS_CODES[status] ?? 'Error';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · OneCard Lab</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f6f3; --card: #fff; --ink: #1d2420; --muted: #5d665f; --line: #d9dfd8; --accent: #1f7a4d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121614; --card: #1b201d; --ink: #e8ede9; --muted: #9ba59e; --line: #2c342f; --accent: #6fd3a0; } }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 480px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 8px 0; }
  .code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <p class="code">${status} · ${escapeHtml(code)}</p>
  <p><a href="/">OneCard Lab home</a></p>
</main>
</body>
</html>
`;
}

// ---- the server ----------------------------------------------------------------------------

/**
 * The lab's HTTP server (DESIGN §7).
 * @param {object} options
 * @param {{ ctx: object, platform: object, broker?: object, server?: { up: boolean } }} options.lab
 *   the lab: ctx and platform are read on every request (the lab may replace them on reset);
 *   `server.up` false switches the product off (503 SERVER_DOWN)
 * @param {string} [options.webRoot]  folder of the web apps (default: the repository's web/)
 * @param {number} [options.heartbeatMs]  comment line sent on idle event streams (default 15 s)
 * @returns {{ listen(port?: number, host?: string): Promise<{ url: string, port: number }>,
 *   close(): Promise<void>, readonly url: string|null }}
 *   `url` is the address the server can reach itself on (the mock bank posts its callbacks there)
 */
export function createHttpServer({ lab, webRoot = DEFAULT_WEB_ROOT, heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
  if (!lab || typeof lab !== 'object') throw new TypeError('createHttpServer needs { lab }');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new TypeError('heartbeatMs must be a whole number of ms');
  const root = resolve(webRoot);
  const sessions = createSessions();
  const streams = new Set(); // open event streams: each has end()
  let selfUrl = null;
  let router = null;
  let closing = null;

  const ctx = () => lab.ctx;
  const platform = () => lab.platform;
  const serverUp = () => lab.server?.up !== false;

  function note(level, message, meta) {
    try {
      const log = ctx()?.log;
      if (typeof log === 'function') log(level, message, meta);
      else if (level === 'error') console.error(`[http] ${message}`, meta ?? '');
    } catch {
      // a broken logger must not break a request
    }
  }

  // What every route module gets (DESIGN §7). platform and ctx are read when used, so a lab
  // that rebuilds its platform on reset is followed; sessions and the server's own address are
  // for the routes that sign people in and for the mock bank's server-to-server callback.
  const deps = {
    lab,
    get platform() {
      return lab.platform;
    },
    get ctx() {
      return lab.ctx;
    },
    sessions: {
      signIn: (role, id, req) => sessions.signIn(role, id, req),
      signOut: (role, req) => sessions.signOut(role, req),
    },
    server: {
      get url() {
        return selfUrl;
      },
    },
  };

  const ownModules = [
    ['operator', operatorRoutes],
    ['admin', adminRoutes],
    ['parent', parentRoutes],
    ['pay', payRoutes],
    ['kiosk', kioskRoutes],
  ];

  async function buildRouter() {
    const list = [];
    const add = (source, make) => {
      const defined = make(deps);
      if (!Array.isArray(defined)) throw new TypeError(`${source}: routes() must return a list`);
      for (const r of defined) list.push(compileRoute(r, `routes/${source}.js`));
    };
    for (const [source, make] of ownModules) add(source, make);
    // The lab's own routes come from another module that may not exist yet.
    const labModule = await importOptionalModule(LAB_ROUTES_URL);
    if (!labModule) note('info', 'src/http/routes/lab.js is not there: no /api/lab routes besides the event stream');
    else if (typeof labModule.routes !== 'function') note('warn', 'src/http/routes/lab.js has no routes() export');
    else add('lab', labModule.routes);
    return createRouter(list);
  }

  // ---- identities ----------------------------------------------------------------------

  function operatorOf(headers) {
    return sessions.find('operator', headers) === LAB_OPERATOR.id ? { ...LAB_OPERATOR } : null;
  }

  function staffOf(headers) {
    const id = sessions.find('staff', headers);
    if (!id) return null;
    const { schools } = platform().services;
    const staff = schools.getStaff(id);
    const school = staff ? schools.getSchool(staff.schoolId) : null;
    return staff && school ? { staff, school } : null;
  }

  function parentOf(headers) {
    const id = sessions.find('parent', headers);
    return id ? platform().services.schools.getParent(id) : null;
  }

  const NOT_SIGNED_IN = {
    operator: 'sign in as the platform operator first',
    staff: 'sign in to the school office first',
    parent: 'sign in to the parent app first',
  };

  /**
   * Check a kiosk request (DESIGN §3 "Kiosk HTTP (signed)"): the signature over the exact
   * method, path with query, timestamp, nonce and body text under that kiosk's own secret, a
   * timestamp within 5 minutes of the lab clock, a nonce not used in the last 10 minutes, and
   * an ACTIVE kiosk of an ACTIVE school. The signature is checked before anything is said about
   * the machine, so an unsigned caller learns nothing about its status.
   * @returns {{ school: object, device: object }} never the secret
   */
  function verifyKiosk(req, rawPath, rawBody) {
    const h = req.headers;
    const schoolCode = h['x-lab-school'];
    const deviceCode = h['x-lab-device'];
    const timestamp = h['x-lab-timestamp'];
    const nonce = h['x-lab-nonce'];
    const signature = h['x-lab-signature'];
    const unsigned = (message) => new LabError('SIGNATURE_INVALID', message, 401);
    if (![schoolCode, deviceCode, timestamp, nonce, signature].every((v) => typeof v === 'string' && v !== '')) {
      throw unsigned('kiosk requests need the x-lab-school, x-lab-device, x-lab-timestamp, x-lab-nonce and x-lab-signature headers');
    }
    if (!TIMESTAMP_RE.test(timestamp)) throw unsigned('x-lab-timestamp must be lab-clock milliseconds');
    if (!NONCE_RE.test(nonce)) throw unsigned('x-lab-nonce must be 16 to 64 printable characters');
    const { devices } = platform().services;
    const found = devices.resolveByCodes(schoolCode, deviceCode);
    if (!found) throw new LabError('UNKNOWN_DEVICE', 'no such school or device', 401);
    const refuse = (err) => {
      try {
        devices.log({
          schoolId: found.school.id,
          deviceId: found.device.id,
          level: 'WARN',
          code: err.code,
          message: `kiosk request refused: ${err.message}`,
          detail: { method: req.method, path: rawPath.slice(0, 200) },
        });
      } catch (logErr) {
        note('warn', 'could not write the device log', { error: logErr?.message });
      }
      return err;
    };
    const expected = signRequest({ secretHex: found.secret, method: req.method, path: rawPath, timestamp, nonce, body: rawBody });
    if (!safeEqual(signature, expected)) throw refuse(unsigned('the request signature does not match'));
    if (Math.abs(Number(timestamp) - ctx().clock.now()) > KIOSK_CLOCK_SKEW_MS) {
      throw refuse(unsigned('the request timestamp is more than 5 minutes from the lab clock'));
    }
    if (!devices.useNonce(found.device.id, nonce)) throw refuse(new LabError('REPLAY', 'this request was already received (nonce used before)', 409));
    if (found.device.type !== 'KIOSK') throw refuse(new LabError('WRONG_DEVICE_TYPE', 'only a top-up kiosk may use the kiosk API', 403));
    if (found.school.status !== 'ACTIVE') throw refuse(new LabError('SCHOOL_SUSPENDED', 'this school is suspended on the platform', 403));
    if (found.device.status !== 'ACTIVE') throw refuse(new LabError('DEVICE_DISABLED', 'this kiosk is switched off', 403));
    return { school: found.school, device: found.device };
  }

  /** Who is asking, as the route's `auth` requires. Routes with auth 'none' get whoever is signed in. */
  function identify(route, req, rawPath, rawBody) {
    const who = { operator: null, staff: null, school: null, parent: null, kiosk: null };
    switch (route.auth) {
      case 'operator':
        who.operator = operatorOf(req.headers);
        if (!who.operator) throw new LabError('NOT_SIGNED_IN', NOT_SIGNED_IN.operator, 401);
        break;
      case 'staff': {
        const found = staffOf(req.headers);
        if (!found) throw new LabError('NOT_SIGNED_IN', NOT_SIGNED_IN.staff, 401);
        if (found.school.status !== 'ACTIVE') throw new LabError('SCHOOL_SUSPENDED', 'your school is suspended on the platform', 403);
        if (route.roles && !route.roles.includes(found.staff.role)) {
          throw new LabError('FORBIDDEN', `your role (${found.staff.role}) cannot do this; it needs ${route.roles.join(' or ')}`, 403, {
            role: found.staff.role,
            needs: route.roles,
          });
        }
        who.staff = found.staff;
        who.school = found.school;
        break;
      }
      case 'parent':
        who.parent = parentOf(req.headers);
        if (!who.parent) throw new LabError('NOT_SIGNED_IN', NOT_SIGNED_IN.parent, 401);
        break;
      case 'kiosk': {
        const kiosk = verifyKiosk(req, rawPath, rawBody);
        who.kiosk = kiosk;
        who.school = kiosk.school;
        break;
      }
      default: {
        who.operator = operatorOf(req.headers);
        const found = staffOf(req.headers);
        if (found) {
          who.staff = found.staff;
          who.school = found.school;
        }
        who.parent = parentOf(req.headers);
      }
    }
    return who;
  }

  // ---- bodies ----------------------------------------------------------------------------

  /**
   * The raw body, at most MAX_BODY_BYTES. An over-long body is refused with 413; what is left of
   * it is read and dropped (up to a bound) so the client can still read the answer.
   */
  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      const declared = Number(req.headers['content-length']);
      let size = 0;
      let failed = false;
      const chunks = [];
      const tooLarge = () => {
        failed = true;
        chunks.length = 0;
        reject(new LabError('BODY_TOO_LARGE', `the request body must be at most ${MAX_BODY_BYTES} bytes`, 413));
      };
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) tooLarge();
      req.on('data', (chunk) => {
        size += chunk.length;
        if (failed) {
          if (size > MAX_DISCARD_BYTES) req.socket?.destroy();
          return;
        }
        if (size > MAX_BODY_BYTES) tooLarge();
        else chunks.push(chunk);
      });
      req.on('end', () => {
        if (!failed) resolveBody(Buffer.concat(chunks));
      });
      req.on('error', (err) => {
        if (!failed) {
          failed = true;
          reject(err);
        }
      });
    });
  }

  /** Parse the body the route expects. JSON routes take application/json only, so a cross-site HTML form cannot post to them. */
  function parseBody(route, req, raw) {
    if (route.body === 'none') return {};
    const { type, charset } = contentTypeOf(req.headers['content-type']);
    const expected = route.body === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
    if ((type !== '' || raw.length > 0) && type !== expected) {
      throw new LabError('UNSUPPORTED_MEDIA_TYPE', `this endpoint takes ${expected}`, 415);
    }
    if (charset && charset !== 'utf-8' && charset !== 'utf8') throw new LabError('UNSUPPORTED_MEDIA_TYPE', 'the body must be UTF-8', 415);
    if (raw.length === 0) return {};
    let text;
    try {
      text = utf8.decode(raw);
    } catch {
      throw new LabError('BAD_JSON', 'the request body is not valid UTF-8', 400);
    }
    if (route.body === 'form') return queryObject(new URLSearchParams(text));
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new LabError('BAD_JSON', 'the request body is not valid JSON', 400);
    }
    if (!isPlainObject(value)) throw new LabError('BAD_JSON', 'the request body must be a JSON object', 400);
    return value;
  }

  /** A browser page of another origin must not change anything with our cookies (SameSite=Lax lets same-site pages through). */
  function checkOrigin(req) {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin === undefined) return; // not a browser (the kiosk, the bank's callback, tests)
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.host === req.headers.host;
    } catch {
      ok = false;
    }
    if (!ok) throw new LabError('CROSS_ORIGIN', 'requests from another web site are not accepted', 403);
  }

  // ---- answers ---------------------------------------------------------------------------

  function send(res, status, body, headers = {}) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) {
      const name = k.toLowerCase();
      if (Object.hasOwn(SECURITY_HEADERS, name) || name === 'content-length') continue; // ours, always
      if (v !== undefined && v !== null) res.setHeader(name, v);
    }
    if (body === null || body === undefined || status === 204 || status === 304) {
      res.end();
      return;
    }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.setHeader('content-length', buf.length);
    res.end(buf);
  }

  const sendJson = (res, status, value, headers = {}) =>
    send(res, status, JSON.stringify(value), { ...headers, 'content-type': 'application/json; charset=utf-8' });

  function sendResult(res, result) {
    if (result === undefined) return send(res, 204, null);
    if (!isReply(result)) return sendJson(res, 200, result);
    const headers = {};
    for (const [k, v] of Object.entries(result.headers ?? {})) headers[k.toLowerCase()] = v;
    const { body } = result;
    if (body === undefined || body === null) return send(res, result.status, null, headers);
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      headers['content-type'] ??= 'text/plain; charset=utf-8';
      return send(res, result.status, body, headers);
    }
    return send(res, result.status, JSON.stringify(body), { ...headers, 'content-type': headers['content-type'] ?? 'application/json; charset=utf-8' });
  }

  /** Map an error to an answer: a LabError keeps its code and status; anything else is a bug, logged, never shown. */
  function fail(req, res, asPage, err, extraHeaders = {}) {
    let status;
    let error;
    if (isLabError(err)) {
      status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 400;
      error = { code: err.code, message: err.message };
      if (err.detail !== undefined) error.detail = err.detail;
      if (status >= 500 && err.code !== 'SERVER_DOWN') note('warn', `http ${status} ${err.code}`, { method: req.method, path: req.url, message: err.message });
    } else {
      status = 500;
      error = { code: 'INTERNAL', message: 'something went wrong in the lab server; the details are in its log' };
      note('error', 'http request failed', { method: req.method, path: req.url, error: err?.message, stack: err?.stack });
    }
    const headers = { ...extraHeaders };
    if (status === 413) headers.connection = 'close'; // the rest of the body is not wanted
    if (asPage) return send(res, status, errorPage(status, error.code, error.message), { ...headers, 'content-type': 'text/html; charset=utf-8' });
    return sendJson(res, status, { error }, headers);
  }

  // ---- static files ----------------------------------------------------------------------

  const BAD_SEGMENT = /[\\/\0:]/;

  async function serveStatic(req, res, url, parts) {
    const notFound = () => fail(req, res, true, new LabError('NOT_FOUND', 'there is no such page in the lab', 404));
    // No hidden files, no "." or "..", no separators smuggled in encoded, no empty segment except a final "/".
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '' && i === parts.length - 1) continue;
      if (p === '' || p.startsWith('.') || BAD_SEGMENT.test(p)) return notFound();
    }
    let file = resolve(root, ...parts.filter((p) => p !== ''));
    if (file !== root && !file.startsWith(root + sep)) return notFound();
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      const index = join(file, 'index.html');
      const indexInfo = await stat(index).catch(() => null);
      if (!indexInfo?.isFile()) return notFound(); // no directory listings
      if (!url.pathname.endsWith('/')) {
        // relative links in the page need the trailing slash
        return send(res, 301, null, { location: `${url.pathname}/${url.search}` });
      }
      file = index;
      info = indexInfo;
    } else if (url.pathname.endsWith('/')) {
      return notFound();
    }
    if (!info?.isFile()) return notFound();
    // a symbolic link must not lead out of the web folder
    const [real, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    if (!real.startsWith(realRoot + sep)) return notFound();
    res.statusCode = 200;
    res.setHeader('content-type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('content-length', info.size);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise((done) => {
      const stream = createReadStream(real);
      stream.on('error', (err) => {
        note('error', 'could not read a web file', { file: real, error: err.message });
        res.destroy();
        done();
      });
      res.on('close', done);
      stream.pipe(res);
    });
  }

  // ---- server-sent events ----------------------------------------------------------------

  const seqOf = (text) => (typeof text === 'string' && /^\d{1,15}$/.test(text.trim()) ? Number(text.trim()) : null);

  /**
   * GET /api/lab/events: every lab event as `id: <seq>` + `data: <JSON>`. Replays what the bus
   * still holds after Last-Event-ID (a reconnecting EventSource) or ?since=; otherwise starts with
   * the next event. ?school=<code> keeps that school's events and the lab-wide ones.
   */
  function streamEvents(req, res, url) {
    const bus = ctx()?.events;
    if (!bus || typeof bus.subscribe !== 'function') throw new LabError('EVENTS_UNAVAILABLE', 'the lab has no event bus', 503);
    const school = url.searchParams.get('school') || undefined;
    let after = seqOf(req.headers['last-event-id']) ?? seqOf(url.searchParams.get('since') ?? undefined) ?? bus.lastSeq();
    // An id beyond the bus's last one belongs to an earlier bus (the lab was reset): start over.
    if (after > bus.lastSeq()) after = 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let open = true;
    let last = after;
    let idle = 0;
    let timer = null;
    let unsubscribe = () => {};
    const stream = {
      end() {
        if (!open) return;
        open = false;
        clearInterval(timer);
        unsubscribe();
        streams.delete(stream);
        res.end();
      },
    };
    const write = (text) => {
      if (!open) return;
      res.write(text);
      // a client that stopped reading is dropped rather than buffered for ever; it reconnects and replays
      if (res.writableLength > MAX_STREAM_BACKLOG) stream.end();
    };
    const deliver = (event) => {
      if (!open || !event || event.seq <= last) return;
      if (school !== undefined && event.school !== null && event.school !== school) return;
      let data;
      try {
        data = JSON.stringify(event);
      } catch {
        return; // not JSON (never from the lab's own services): skip it rather than break the stream
      }
      last = event.seq;
      idle = 0;
      write(`id: ${event.seq}\ndata: ${data}\n\n`);
    };

    streams.add(stream);
    res.on('close', () => stream.end());
    write('retry: 2000\n\n');
    // Replay and subscribe in one synchronous step: no event can slip in between.
    for (const event of bus.since(after, school)) deliver(event);
    if (!open) return; // dropped while replaying (the client is not reading)
    unsubscribe = bus.subscribe(deliver);
    const tick = Math.min(STREAM_CHECK_MS, heartbeatMs);
    timer = setInterval(() => {
      // the lab replaced its event bus (reset): end, so the browser reconnects to the new one
      if (ctx()?.events !== bus) return stream.end();
      idle += tick;
      if (idle >= heartbeatMs) {
        idle = 0;
        write(': heartbeat\n\n');
      }
    }, tick);
    timer.unref?.();
  }

  // ---- requests --------------------------------------------------------------------------

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const rawPath = req.url ?? '';
    let url;
    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
      return fail(req, res, false, new LabError('BAD_PATH', 'the request path must start with a single /', 400));
    }
    try {
      url = new URL(rawPath, 'http://lab.invalid');
    } catch {
      return fail(req, res, false, new LabError('BAD_PATH', 'the request path is not valid', 400));
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const isLab = url.pathname === '/api/lab' || url.pathname.startsWith('/api/lab/');
    const asPage = !isApi;
    try {
      let parts;
      try {
        parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
      } catch {
        throw new LabError('BAD_PATH', 'the request path is not valid', 400);
      }

      // The lab's event stream is part of the server, and stays on while the product is off.
      if (url.pathname === EVENTS_PATH) {
        if (req.method !== 'GET') throw new LabError('METHOD_NOT_ALLOWED', 'use GET', 405);
        return streamEvents(req, res, url);
      }

      const found = router.match(req.method, parts);
      if (!found.route) {
        if (!isApi && (req.method === 'GET' || req.method === 'HEAD')) return await serveStatic(req, res, url, parts);
        if (isApi && !isLab && !serverUp()) throw serverDown();
        if (found.allowed.length > 0) {
          return fail(req, res, asPage, new LabError('METHOD_NOT_ALLOWED', `use ${found.allowed.join(' or ')}`, 405), {
            allow: found.allowed.join(', '),
          });
        }
        throw new LabError('NOT_FOUND', isApi ? 'there is no such API endpoint' : 'there is no such page in the lab', 404);
      }

      const { route, params } = found;
      if (!isLab && !serverUp()) throw serverDown();
      checkOrigin(req);
      if (route.body !== 'none' && req.method !== 'GET') {
        // the media type is known before a single byte is read
        const { type } = contentTypeOf(req.headers['content-type']);
        const expected = route.body === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
        if (type !== '' && type !== expected) throw new LabError('UNSUPPORTED_MEDIA_TYPE', `this endpoint takes ${expected}`, 415);
      }
      const raw = await readBody(req);
      const rawBody = raw.length === 0 ? '' : raw.toString('utf8');
      const body = parseBody(route, req, raw);
      const who = identify(route, req, rawPath, rawBody);
      const result = await route.handler({
        method: req.method,
        path: url.pathname,
        params,
        query: queryObject(url.searchParams),
        body,
        rawBody,
        headers: req.headers,
        ...who,
      });
      return sendResult(res, result);
    } catch (err) {
      return fail(req, res, asPage, err);
    }
  }

  const serverDown = () =>
    new LabError('SERVER_DOWN', 'the OneCard cloud server is switched off in the lab; switch it back on in the lab console', 503);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      note('error', 'http request failed', { method: req.method, path: req.url, error: err?.message, stack: err?.stack });
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: 'something went wrong in the lab server' } });
      else res.destroy();
    });
  });

  // Requests Node cannot even parse still get an answer with our headers.
  server.on('clientError', (err, socket) => {
    if (err?.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    const status = err?.code === 'HPE_HEADER_OVERFLOW' ? 431 : err?.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    const body = JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'the request could not be read' } });
    const head = Object.entries(SECURITY_HEADERS)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${head}content-type: application/json; charset=utf-8\r\n` +
        `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  });

  let ready = null;

  return {
    /**
     * Load the routes and start listening.
     * @param {number} [port]  0 picks a free port (default 0)
     * @param {string} [host]  listen address (default 127.0.0.1)
     * @returns {Promise<{ url: string, port: number }>}
     */
    async listen(port = 0, host = '127.0.0.1') {
      if (closing) throw new Error('this server was closed');
      ready ??= buildRouter();
      router = await ready;
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      const actualPort = server.address().port;
      selfUrl = `http://${urlHost(host)}:${actualPort}`;
      return { url: selfUrl, port: actualPort };
    },

    /** Stop: end the event streams, close every connection, stop listening. Safe to call twice. */
    close() {
      closing ??= (async () => {
        for (const stream of [...streams]) stream.end();
        sessions.clear();
        if (!server.listening) return;
        const stopped = new Promise((done) => server.close(() => done()));
        server.closeAllConnections();
        await stopped;
      })();
      return closing;
    },

    get url() {
      return selfUrl;
    },
  };
}
