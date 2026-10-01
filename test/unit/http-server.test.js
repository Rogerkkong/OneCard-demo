import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestCtx, waitFor } from '../helpers.js';
import { createPlatform } from '../../src/platform/platform.js';
import { seedDemo } from '../../src/lab/seed.js';
import { createHttpServer, importOptionalModule, MAX_BODY_BYTES } from '../../src/http/server.js';

// The server's own mechanics: static files, security headers, errors, body rules, sessions, the
// switched-off cloud server and the lab's event stream. Every school and person comes from the
// fictional demo seed; secrets are generated per test.

const REPO_WEB = new URL('../../web/', import.meta.url);
const LAB_ROUTES_EXIST = (() => {
  try {
    readFileSync(new URL('../../src/http/routes/lab.js', import.meta.url));
    return true;
  } catch {
    return false;
  }
})();

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  'cache-control': 'no-store',
};

/** A seeded lab and its HTTP server on a random port, closed when the test ends. */
async function startLab(t, options = {}) {
  const ctx = createTestCtx();
  const platform = createPlatform(ctx);
  const seed = seedDemo(platform);
  const lab = { ctx, platform, server: { up: true } };
  const server = createHttpServer({ lab, ...options });
  const { url, port } = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return { ctx, platform, seed, lab, server, url, port };
}

/** A browser-like client: keeps its cookies, sends JSON. */
function browser(url) {
  const jar = new Map();
  async function call(method, path, { json, body, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (json !== undefined) {
      h['content-type'] ??= 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(url + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      if (/;\s*max-age=0/i.test(c)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON (a page or a file)
    }
    return { status: res.status, headers: res.headers, data, text };
  }
  return { jar, call, get: (p, o) => call('GET', p, o), post: (p, json = {}, o = {}) => call('POST', p, { json, ...o }) };
}

/** A request exactly as written (fetch would tidy up the path). */
function raw(url, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Read an event stream: events (id + parsed data) and comment lines, as they arrive. */
function openStream(url, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url + path, { headers, agent: false }, (res) => {
      res.setEncoding('utf8');
      const stream = { res, events: [], comments: [], retry: null, ended: false, close: () => req.destroy() };
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) stream.comments.push(line);
            else if (line.startsWith('id: ')) event.id = line.slice(4);
            else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
            else if (line.startsWith('retry: ')) stream.retry = Number(line.slice(7));
          }
          if (event.data) stream.events.push(event);
        }
      });
      res.on('end', () => {
        stream.ended = true;
      });
      res.on('error', () => {});
      resolve(stream);
    });
    req.on('error', reject);
  });
}

function assertSecurityHeaders(headers, where) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
  for (const [k, v] of Object.entries(SECURITY)) assert.equal(get(k), v, `${k} on ${where}`);
}

const staffOf = (seed, schoolCode, role) => seed.schools.find((s) => s.code === schoolCode).staff.find((p) => p.role === role);

describe('http server: listening and closing', () => {
  test('listen() answers its url and port; close() stops it and may be called twice', async (t) => {
    const ctx = createTestCtx();
    const platform = createPlatform(ctx);
    seedDemo(platform);
    const server = createHttpServer({ lab: { ctx, platform, server: { up: true } } });
    const { url, port } = await server.listen(0, '127.0.0.1');
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.equal(server.url, url);
    assert.equal((await fetch(`${url}/api/admin/staff-options`)).status, 200);
    await server.close();
    await server.close();
    await assert.rejects(fetch(`${url}/`), TypeError);
  });

  test('createHttpServer needs a lab', () => {
    assert.throws(() => createHttpServer({}), TypeError);
    assert.throws(() => createHttpServer(), TypeError);
  });

  test('a wildcard listen address is reached on loopback', async (t) => {
    const { ctx, platform } = await startLab(t);
    const server = createHttpServer({ lab: { ctx, platform, server: { up: true } } });
    t.after(() => server.close());
    const { url, port } = await server.listen(0, '0.0.0.0');
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.equal((await fetch(`${url}/`)).status, 200);
  });

  test('importOptionalModule: null for a missing file, the module when it exists', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'onecard-http-mod-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(await importOptionalModule(pathToFileURL(join(dir, 'missing.js'))), null);
    writeFileSync(join(dir, 'here.js'), 'export const routes = () => [];\n');
    const mod = await importOptionalModule(pathToFileURL(join(dir, 'here.js')));
    assert.equal(typeof mod.routes, 'function');
    // a module that exists but cannot load is an error, not a missing module
    writeFileSync(join(dir, 'broken.js'), "import './nowhere.js';\n");
    await assert.rejects(importOptionalModule(pathToFileURL(join(dir, 'broken.js'))));
  });

  test('the lab routes module is optional', { skip: LAB_ROUTES_EXIST && 'src/http/routes/lab.js exists' }, async (t) => {
    const { url } = await startLab(t);
    const res = await fetch(`${url}/api/lab/state`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');
  });
});

describe('http server: static files', () => {
  /** A web root of our own: <tmp>/web, with a secret next to it that must never be served. */
  function makeWebRoot(t) {
    const top = mkdtempSync(join(tmpdir(), 'onecard-http-web-'));
    t.after(() => rmSync(top, { recursive: true, force: true }));
    const web = join(top, 'web');
    mkdirSync(join(web, 'lab'), { recursive: true });
    mkdirSync(join(web, 'img'));
    mkdirSync(join(web, 'empty'));
    writeFileSync(join(top, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>root</title>');
    writeFileSync(join(web, 'lab', 'index.html'), '<!doctype html><title>lab</title>');
    writeFileSync(join(web, 'lab', 'app.js'), 'export {};\n');
    writeFileSync(join(web, 'lab', 'app.css'), 'body {}\n');
    writeFileSync(join(web, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(web, 'img', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(web, 'data.json'), '{"a":1}');
    writeFileSync(join(web, 'site.webmanifest'), '{}');
    writeFileSync(join(web, 'blob.bin'), 'x');
    writeFileSync(join(web, '.hidden'), 'hidden');
    symlinkSync(join(top, 'secret.txt'), join(web, 'link.txt'));
    return web;
  }

  test('the repository web/ folder: / is index.html, shared files with their content types, HEAD', async (t) => {
    const { url } = await startLab(t);
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await index.text(), readFileSync(new URL('index.html', REPO_WEB), 'utf8'));
    assertSecurityHeaders(index.headers, 'GET /');

    const js = await fetch(`${url}/shared/api.js`);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await js.text(), readFileSync(new URL('shared/api.js', REPO_WEB), 'utf8'));
    const css = await fetch(`${url}/shared/style.css`);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    await css.arrayBuffer();

    const head = await raw(url, { method: 'HEAD', path: '/landing.js' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(Number(head.headers['content-length']), readFileSync(new URL('landing.js', REPO_WEB)).length);
    assert.equal(head.headers['cache-control'], 'no-store');
  });

  test('index pages, content types, no directory listings, no hidden files', async (t) => {
    const { url } = await startLab(t, { webRoot: makeWebRoot(t) });
    const get = (path) => raw(url, { path });

    assert.equal((await get('/')).text, '<!doctype html><title>root</title>');
    const lab = await get('/lab/');
    assert.equal(lab.status, 200);
    assert.equal(lab.text, '<!doctype html><title>lab</title>');
    const bare = await get('/lab?x=1');
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, '/lab/?x=1');
    assert.equal((await get('/lab/index.html')).status, 200);

    const types = {
      '/lab/app.js': 'text/javascript; charset=utf-8',
      '/lab/app.css': 'text/css; charset=utf-8',
      '/img/logo.svg': 'image/svg+xml',
      '/img/pic.png': 'image/png',
      '/data.json': 'application/json; charset=utf-8',
      '/site.webmanifest': 'application/manifest+json; charset=utf-8',
      '/blob.bin': 'application/octet-stream',
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers['content-type'], type, path);
      assertSecurityHeaders(res.headers, path);
    }

    // a folder without index.html is not listed, with or without the slash
    for (const path of ['/img/', '/img', '/empty/', '/empty', '/lab/app.js/', '/nothing-here', '/.hidden', '/lab/.hidden']) {
      const res = await get(path);
      assert.equal(res.status, 404, path);
      assert.match(res.headers['content-type'], /^text\/html/, path);
      assert.doesNotMatch(res.text, /logo\.svg|pic\.png/, path);
    }
  });

  test('path traversal never leaves the web folder', async (t) => {
    const { url } = await startLab(t, { webRoot: makeWebRoot(t) });
    const attempts = [
      '/../secret.txt',
      '/lab/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/lab/..%2f..%2fsecret.txt',
      '/lab/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/..%5csecret.txt',
      '/lab/..%5c..%5csecret.txt',
      '/secret.txt%00.html',
      '/lab%00/index.html',
      '//secret.txt',
      '/link.txt', // a symbolic link to a file outside
      '/lab//../../secret.txt',
    ];
    for (const path of attempts) {
      const res = await raw(url, { path });
      assert.ok(res.status === 404 || res.status === 400, `${path} -> ${res.status}`);
      assert.doesNotMatch(res.text, /TOP-SECRET-OUTSIDE/, path);
    }
    const malformed = await raw(url, { path: '/%E0%A4%A' });
    assert.equal(malformed.status, 400);
  });

  test('POST to a page path is not found; the static files have no other methods', async (t) => {
    const { url } = await startLab(t);
    const res = await raw(url, { method: 'POST', path: '/index.html', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404);
  });
});

describe('http server: errors and bodies', () => {
  test('API errors are JSON { error: { code, message } } with security headers', async (t) => {
    const { url } = await startLab(t);
    const res = await fetch(`${url}/api/no/such/thing`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assertSecurityHeaders(res.headers, '404');
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(typeof body.error.message, 'string');
  });

  test('a wrong method is 405 with Allow', async (t) => {
    const { url } = await startLab(t);
    const put = await fetch(`${url}/api/operator/login`, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'POST');
    assert.equal((await put.json()).error.code, 'METHOD_NOT_ALLOWED');
    const del = await fetch(`${url}/api/admin/members`, { method: 'DELETE' });
    assert.equal(del.status, 405);
    assert.deepEqual(del.headers.get('allow').split(', ').sort(), ['GET', 'POST']);
    const head = await fetch(`${url}/api/admin/staff-options`, { method: 'HEAD' });
    assert.equal(head.status, 405);
  });

  test('bad JSON is 400 BAD_JSON; the body must be a JSON object in UTF-8', async (t) => {
    const { url } = await startLab(t);
    const post = (body) => fetch(`${url}/api/parent/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    for (const body of ['{"parentId":', 'not json', '[1,2]', '"text"', 'null', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])]) {
      const res = await post(body);
      assert.equal(res.status, 400, String(body));
      assert.equal((await res.json()).error.code, 'BAD_JSON', String(body));
    }
    // an empty body is an empty object: the handler answers, not the parser
    const empty = await post('');
    assert.equal(empty.status, 404);
    assert.equal((await empty.json()).error.code, 'PARENT_NOT_FOUND');
  });

  test('JSON routes refuse other content types with 415, so an HTML form cannot post to them', async (t) => {
    const { url } = await startLab(t);
    const post = (headers, body) => fetch(`${url}/api/parent/login`, { method: 'POST', headers, body });
    const cases = [
      [{ 'content-type': 'text/plain' }, '{"parentId":"x"}'],
      [{ 'content-type': 'application/x-www-form-urlencoded' }, 'parentId=x'],
      [{ 'content-type': 'multipart/form-data; boundary=zz' }, '--zz--'],
      [{ 'content-type': 'application/json; charset=latin1' }, '{"parentId":"x"}'],
      [{ 'content-type': 'text/plain' }, ''],
      [{}, '{"parentId":"x"}'], // a body without a content type
    ];
    for (const [headers, body] of cases) {
      const res = await post(headers, body);
      assert.equal(res.status, 415, JSON.stringify(headers));
      assert.equal((await res.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const ok = await post({ 'content-type': 'Application/JSON; charset=UTF-8' }, '{"parentId":"nobody"}');
    assert.equal(ok.status, 404);
  });

  test('a body over 1 MB is 413; exactly 1 MB is fine', async (t) => {
    const { url } = await startLab(t);
    const post = (body) => fetch(`${url}/api/parent/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const tooBig = await post(`{"pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`);
    assert.equal(tooBig.status, 413);
    assert.equal((await tooBig.json()).error.code, 'BODY_TOO_LARGE');
    const prefix = '{"email":"pad.parent@example.com","name":"Pad Parent","pad":"';
    const fits = prefix + 'y'.repeat(MAX_BODY_BYTES - prefix.length - 2) + '"}';
    assert.equal(Buffer.byteLength(fits), MAX_BODY_BYTES);
    const res = await post(fits);
    assert.equal(res.status, 201);
  });

  test('an unexpected error is 500 INTERNAL: logged, never shown', async (t) => {
    const { url, lab, platform, ctx } = await startLab(t);
    const logs = [];
    ctx.log = (level, message, meta) => logs.push({ level, message, meta });
    lab.platform = {
      ...platform,
      operatorOverview() {
        throw new TypeError('kaboom in /secret/path/module.js');
      },
    };
    const b = browser(url);
    await b.post('/api/operator/login');
    const res = await b.get('/api/operator/schools');
    assert.equal(res.status, 500);
    assert.equal(res.data.error.code, 'INTERNAL');
    assert.doesNotMatch(res.text, /kaboom|secret\/path|at .*\.js/);
    const logged = logs.find((l) => l.level === 'error');
    assert.ok(logged, 'the error is logged');
    assert.match(logged.meta.error, /kaboom/);
    assert.match(logged.meta.stack, /TypeError/);
  });

  test('a browser page of another origin cannot post with our cookies; the same origin can', async (t) => {
    const { url, port } = await startLab(t);
    const evil = await raw(url, { method: 'POST', path: '/api/operator/login', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(evil.status, 403);
    assert.equal(JSON.parse(evil.text).error.code, 'CROSS_ORIGIN');
    assert.equal(evil.headers['set-cookie'], undefined);
    const sameSiteOtherPort = await raw(url, { method: 'POST', path: '/api/operator/login', headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(sameSiteOtherPort.status, 403);
    const nullOrigin = await raw(url, { method: 'POST', path: '/api/operator/login', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(nullOrigin.status, 403);
    const same = await raw(url, { method: 'POST', path: '/api/operator/login', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(same.status, 200);
    // reading is not changing anything
    const read = await raw(url, { path: '/api/admin/staff-options', headers: { origin: 'http://evil.example' } });
    assert.equal(read.status, 200);
  });
});

describe('http server: sessions', () => {
  test('one browser can be operator, staff and parent at once; cookies are HttpOnly, SameSite=Lax, Path=/', async (t) => {
    const { url, seed } = await startLab(t);
    const b = browser(url);
    const op = await b.post('/api/operator/login');
    const staff = await b.post('/api/admin/login', { staffId: staffOf(seed, 'smk-contoh', 'OFFICE').id });
    const parent = await b.post('/api/parent/login', { parentId: seed.parents[0].id });
    for (const [res, name] of [[op, 'lab_operator'], [staff, 'lab_staff'], [parent, 'lab_parent']]) {
      assert.equal(res.status, 200, name);
      const [cookie] = res.headers.getSetCookie();
      assert.match(cookie, new RegExp(`^${name}=[A-Za-z0-9_-]{40,}; `));
      assert.match(cookie, /; HttpOnly/);
      assert.match(cookie, /; SameSite=Lax/);
      assert.match(cookie, /; Path=\//);
    }
    assert.deepEqual([...b.jar.keys()].sort(), ['lab_operator', 'lab_parent', 'lab_staff']);
    assert.equal((await b.get('/api/operator/me')).data.operator.name, 'OneCard platform operator');
    assert.equal((await b.get('/api/admin/me')).data.staff.name, 'Nur Aisyah');
    assert.equal((await b.get('/api/parent/me')).data.parent.name, 'Rahman bin Yusof');

    const out = await b.post('/api/admin/logout');
    assert.match(out.headers.getSetCookie()[0], /^lab_staff=; .*Max-Age=0/);
    assert.equal((await b.get('/api/admin/me')).status, 401);
    assert.equal((await b.get('/api/operator/me')).status, 200);
    assert.equal((await b.get('/api/parent/me')).status, 200);
  });

  test('no session, a made-up token or a replaced token is 401 NOT_SIGNED_IN', async (t) => {
    const { url, seed } = await startLab(t);
    const anon = browser(url);
    for (const path of ['/api/operator/me', '/api/admin/me', '/api/parent/me']) {
      const res = await anon.get(path);
      assert.equal(res.status, 401, path);
      assert.equal(res.data.error.code, 'NOT_SIGNED_IN');
    }
    const forged = await fetch(`${url}/api/admin/me`, { headers: { cookie: 'lab_staff=made-up-token-made-up-token-made-up-token' } });
    assert.equal(forged.status, 401);

    const b = browser(url);
    await b.post('/api/parent/login', { parentId: seed.parents[0].id });
    const old = b.jar.get('lab_parent');
    await b.post('/api/parent/login', { parentId: seed.parents[1].id });
    assert.notEqual(b.jar.get('lab_parent'), old);
    assert.equal((await b.get('/api/parent/me')).data.parent.name, 'Lee Kah Seng');
    const stale = await fetch(`${url}/api/parent/me`, { headers: { cookie: `lab_parent=${old}` } });
    assert.equal(stale.status, 401, 'signing in again ends the earlier session');
    // a cookie of one role is not a session of another
    const swapped = await fetch(`${url}/api/admin/me`, { headers: { cookie: `lab_staff=${b.jar.get('lab_parent')}` } });
    assert.equal(swapped.status, 401);
  });
});

describe('http server: the virtual cloud server switched off', () => {
  test('product routes answer 503 SERVER_DOWN; the lab, its event stream and the web apps keep working', async (t) => {
    const { url, lab, seed } = await startLab(t);
    const b = browser(url);
    await b.post('/api/admin/login', { staffId: staffOf(seed, 'smk-contoh', 'ADMIN').id });
    lab.server.up = false;
    const product = [
      ['GET', '/api/operator/schools'],
      ['POST', '/api/operator/login'],
      ['GET', '/api/admin/staff-options'],
      ['GET', '/api/admin/me'],
      ['GET', '/api/parent/options'],
      ['POST', '/api/kiosk/pending'],
      ['POST', '/api/payments/callback'],
      ['GET', '/api/no/such/route'],
    ];
    for (const [method, path] of product) {
      const res = await b.call(method, path, method === 'POST' ? { json: {} } : {});
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal(res.data.error.code, 'SERVER_DOWN', `${method} ${path}`);
      assertSecurityHeaders(res.headers, path);
    }
    const page = await b.get('/pay/ord_whatever');
    assert.equal(page.status, 503);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(page.text, /SERVER_DOWN/);
    assert.doesNotMatch(page.text, /<script/i);

    assert.equal((await b.get('/')).status, 200);
    assert.equal((await b.get('/shared/api.js')).status, 200);
    const stream = await openStream(url, '/api/lab/events');
    t.after(() => stream.close());
    assert.equal(stream.res.statusCode, 200);
    if (LAB_ROUTES_EXIST) assert.notEqual((await b.get('/api/lab/state')).status, 503, 'the lab routes stay on');

    lab.server.up = true;
    assert.equal((await b.get('/api/admin/me')).status, 200, 'the session survived');
  });
});

describe('http server: the lab event stream (server-sent events)', () => {
  test('streams new events as id + JSON data, with security headers', async (t) => {
    const { url, ctx } = await startLab(t);
    const stream = await openStream(url, '/api/lab/events');
    t.after(() => stream.close());
    assert.equal(stream.res.headers['content-type'], 'text/event-stream; charset=utf-8');
    assertSecurityHeaders(stream.res.headers, 'event stream');
    const before = ctx.events.lastSeq();
    ctx.events.emit('lab.action', { n: 1 }, 'smk-contoh');
    ctx.events.emit('lab.action', { n: 2 }, null);
    await waitFor(() => stream.events.length >= 2, { message: 'two events' });
    assert.equal(stream.events.length, 2, 'only new events without since or Last-Event-ID');
    assert.deepEqual(stream.events.map((e) => Number(e.id)), [before + 1, before + 2]);
    assert.deepEqual(stream.events.map((e) => e.data.data.n), [1, 2]);
    assert.equal(stream.events[0].data.type, 'lab.action');
    assert.equal(stream.events[0].data.school, 'smk-contoh');
    assert.equal(stream.events[0].data.seq, before + 1);
    assert.equal(typeof stream.events[0].data.at, 'string');
    assert.ok(stream.retry > 0);
  });

  test('replays after Last-Event-ID or ?since=, and a reconnect resumes where it stopped', async (t) => {
    const { url, ctx } = await startLab(t);
    const first = ctx.events.lastSeq() + 1;
    for (let n = 1; n <= 3; n++) ctx.events.emit('lab.action', { n }, null);

    const resumed = await openStream(url, '/api/lab/events?since=0', { 'last-event-id': String(first) });
    t.after(() => resumed.close());
    await waitFor(() => resumed.events.length >= 2, { message: 'replay after Last-Event-ID' });
    assert.deepEqual(resumed.events.map((e) => e.data.data.n), [2, 3], 'Last-Event-ID wins over ?since=');
    ctx.events.emit('lab.action', { n: 4 }, null);
    await waitFor(() => resumed.events.length >= 3, { message: 'a live event after the replay' });
    assert.equal(resumed.events[2].data.data.n, 4);

    const since = await openStream(url, `/api/lab/events?since=${first + 1}`);
    t.after(() => since.close());
    await waitFor(() => since.events.length >= 2, { message: 'replay after since' });
    assert.deepEqual(since.events.map((e) => e.data.data.n), [3, 4]);

    const all = await openStream(url, '/api/lab/events?since=0');
    t.after(() => all.close());
    await waitFor(() => all.events.length >= first + 3, { message: 'everything the bus keeps' });
    assert.equal(Number(all.events[0].id), 1, 'the seed events too');
    const ids = all.events.map((e) => Number(e.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'in order');
    assert.equal(new Set(ids).size, ids.length, 'each once');
  });

  test('?school= keeps that school and the lab-wide events; an id from an older bus starts over', async (t) => {
    const { url, ctx } = await startLab(t);
    const mark = ctx.events.lastSeq();
    ctx.events.emit('lab.action', { n: 1 }, 'smk-contoh');
    ctx.events.emit('lab.action', { n: 2 }, 'sjkc-contoh');
    ctx.events.emit('lab.action', { n: 3 }, null);
    const one = await openStream(url, `/api/lab/events?since=${mark}&school=sjkc-contoh`);
    t.after(() => one.close());
    await waitFor(() => one.events.length >= 2, { message: 'school events' });
    assert.deepEqual(one.events.map((e) => e.data.data.n), [2, 3]);

    const reset = await openStream(url, '/api/lab/events', { 'last-event-id': '999999' });
    t.after(() => reset.close());
    await waitFor(() => reset.events.length > 0, { message: 'replay from the start' });
    assert.equal(Number(reset.events[0].id), 1);
  });

  test('sends heartbeat comments and cleans up when the client goes away', async (t) => {
    const { url, ctx } = await startLab(t, { heartbeatMs: 25 });
    // count live subscriptions on the lab's bus
    const bus = ctx.events;
    let live = 0;
    ctx.events = {
      ...bus,
      subscribe(fn) {
        live += 1;
        const off = bus.subscribe(fn);
        return () => {
          live -= 1;
          off();
        };
      },
    };
    const stream = await openStream(url, '/api/lab/events');
    await waitFor(() => stream.comments.some((c) => c.startsWith(': heartbeat')), { message: 'a heartbeat' });
    assert.equal(live, 1);
    stream.close();
    await waitFor(() => live === 0, { message: 'the subscription to end' });
  });

  test('a lab that replaces its event bus ends the stream, so the browser reconnects to the new one', async (t) => {
    const { url, ctx } = await startLab(t, { heartbeatMs: 25 });
    const stream = await openStream(url, '/api/lab/events');
    t.after(() => stream.close());
    ctx.events = { ...ctx.events };
    await waitFor(() => stream.ended, { message: 'the stream to end' });
  });

  test('close() ends open streams', async (t) => {
    const { url, server } = await startLab(t);
    const stream = await openStream(url, '/api/lab/events');
    await server.close();
    await waitFor(() => stream.ended || stream.res.destroyed, { message: 'the stream to end' });
  });

  test('only GET', async (t) => {
    const { url } = await startLab(t);
    const res = await fetch(`${url}/api/lab/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 405);
  });
});
