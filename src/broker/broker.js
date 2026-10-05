import net from 'node:net';
import tls from 'node:tls';
import { Aedes } from 'aedes';
import { safeEqual } from '../shared/crypto.js';
import { DEVICE_CODE_RE, SCHOOL_CODE_RE, TOPIC_ROOT, parseTopic, topicFor } from '../shared/protocol.js';

// The lab's MQTT broker (aedes 1.x). The platform, every machine and a read-only viewer
// log in with their own account, and each account may use only its own topics
// (docs/DESIGN.md §3, "Topics and broker accounts"). Everything else is refused:
// anonymous logins, $SYS, '#' (except for the read-only viewer), and any topic outside an
// account's list.
//
// What a refused client sees (MQTT 3.1.1 has no other way to say no):
// - login: CONNACK 2 (wrong client id, or one whose live or kept session is another
//   account's), 4 (unknown user or wrong password), 5 (anonymous, or the device or its
//   school is switched off), 3 (device lookup failed)
// - subscribe: SUBACK 128 for that filter; the session carries on
// - publish: aedes closes the connection without a PUBACK (MQTT-3.3.5-2), so the message
//   reaches nobody. Note that mqtt.js resends unacknowledged QoS 1/2 messages after it
//   reconnects, so a client that keeps such a message is refused again on every reconnect.
//
// aedes acknowledges a QoS 1 message (PUBACK) before it passes it on to the subscribers, so
// close() first lets every message it has acknowledged reach them: the sender counts it as
// delivered (a machine marks the record sent), and a broker that closed in between would
// lose it with the platform's queue. While it closes, a machine's new message is refused
// without a PUBACK, so the machine keeps it and sends it again to the next broker.

/** Username of the platform's own broker account. */
export const PLATFORM_USERNAME = 'platform';

// CONNACK return codes (MQTT 3.1.1 §3.2.2.3).
const ID_REJECTED = 2;
const UNAVAILABLE = 3;
const BAD_LOGIN = 4;
const NOT_AUTHORIZED = 5;

// Payloads up to this size are parsed for the type/txn/id the lab console shows. A journal
// batch of 200 records stays well below it.
const PEEK_MAX_BYTES = 1024 * 1024;
// Longest type/txn/id copied into an event. Real ones are short (an envelope txn or id is at
// most 64 characters); a longer one is shown as null, so one message cannot copy up to a
// megabyte into the kept events and out to every lab console.
const PEEK_MAX_CHARS = 64;
// close() waits at most this long for the messages it acknowledged to be passed on (a pass
// normally takes a millisecond; one whose PUBACK could not even be sent never completes).
const DRAIN_MS = 1000;

/**
 * '<school>.<DEVICE>' -> { schoolCode, deviceCode }, or null when it is not a device login.
 * Neither code can contain a dot, so the first dot splits them.
 */
export function parseDeviceUsername(username) {
  if (typeof username !== 'string') return null;
  const dot = username.indexOf('.');
  if (dot < 0) return null;
  const schoolCode = username.slice(0, dot);
  const deviceCode = username.slice(dot + 1);
  return SCHOOL_CODE_RE.test(schoolCode) && DEVICE_CODE_RE.test(deviceCode) ? { schoolCode, deviceCode } : null;
}

/**
 * True when every topic the filter `wanted` can match is also matched by the filter
 * `allowed` ('+' is one level; '#' is the rest, including the parent level). An account
 * may subscribe to anything at least as narrow as one of its own filters.
 */
export function filterCovers(allowed, wanted) {
  const a = allowed.split('/');
  const w = wanted.split('/');
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '#') return true;
    if (i >= w.length || w[i] === '#') return false;
    if (a[i] !== '+' && a[i] !== w[i]) return false; // a '+' wanted under a literal is wider
  }
  return w.length === a.length;
}

// The accounts table of DESIGN §3. `subscribe` lists the widest filters each may use.
function platformAccount() {
  return {
    role: 'platform',
    username: PLATFORM_USERNAME,
    schoolCode: null,
    subscribe: [`${TOPIC_ROOT}/+/+/records`, `${TOPIC_ROOT}/+/+/status`],
  };
}

// The viewer may also use '#': nobody can publish outside lab/v1, so it carries the same
// traffic, and it is what MQTT Explorer subscribes to by default. $SYS stays refused.
function viewerAccount(username) {
  return { role: 'viewer', username, schoolCode: null, subscribe: [`${TOPIC_ROOT}/#`, '#'] };
}

function deviceAccount(username, { schoolCode, deviceCode }) {
  return {
    role: 'device',
    username,
    schoolCode,
    publish: [topicFor(schoolCode, deviceCode, 'records'), topicFor(schoolCode, deviceCode, 'status')],
    subscribe: [`${topicFor(schoolCode, deviceCode, 'commands')}/#`],
  };
}

function mayPublish(account, topic) {
  // parseTopic accepts only lab/v1/<school>/<DEVICE>/commands/<known kind>
  if (account.role === 'platform') return parseTopic(topic)?.channel === 'commands';
  if (account.role === 'device') return account.publish.includes(topic);
  return false; // the viewer only watches
}

function maySubscribe(account, filter) {
  if (typeof filter !== 'string' || filter === '' || filter.startsWith('$')) return false;
  return account.subscribe.some((allowed) => filterCovers(allowed, filter));
}

// An unset or empty configured secret never matches, not even an empty password.
function secretMatches(given, expected) {
  return typeof expected === 'string' && expected !== '' && safeEqual(given, expected);
}

function passwordText(password) {
  if (Buffer.isBuffer(password)) return password.toString('utf8');
  return typeof password === 'string' ? password : '';
}

const refusal = (code, reason) => ({ code, reason });

/** School code from 'lab/v1/<school>/...' (a topic or a filter), or null. */
function schoolOfTopic(topic) {
  if (typeof topic !== 'string') return null;
  const [root, version, school] = topic.split('/', 3);
  return `${root}/${version}` === TOPIC_ROOT && school !== undefined && SCHOOL_CODE_RE.test(school) ? school : null;
}

function byteLength(payload) {
  if (typeof payload === 'string') return Buffer.byteLength(payload);
  return Buffer.isBuffer(payload) ? payload.length : 0;
}

/**
 * `type`, `txn` and `id` of a protocol envelope, for the lab console; null for anything else.
 * The id is what Simulation mode follows a message by (docs/DESIGN.md §11.2).
 */
function peekEnvelope(payload) {
  const none = { type: null, txn: null, id: null };
  const size = byteLength(payload);
  if (size === 0 || size > PEEK_MAX_BYTES) return none;
  let value;
  try {
    value = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
  } catch {
    return none;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return none;
  const short = (v) => (typeof v === 'string' && v.length <= PEEK_MAX_CHARS ? v : null);
  return { type: short(value.type), txn: short(value.txn), id: short(value.id) };
}

/** Address clients should use: a wildcard listen address is reachable on loopback. */
function urlHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return net.isIPv6(host) ? `[${host}]` : host;
}

/**
 * Start the lab's MQTT broker on TCP, plus TLS when `tls` is given.
 *
 * @param {object} ctx  see docs/DESIGN.md "The context object" (uses events, settings, log)
 * @param {object} [options]
 * @param {string} [options.host]  listen address (default 127.0.0.1)
 * @param {number} [options.port]  MQTT port; 0 picks a free one (default 1883)
 * @param {{port?: number, key: string, cert: string}} [options.tls]  PEM key and certificate; port default 8883
 * @param {(username: string) => ({schoolCode: string, deviceCode: string, password: string, active: boolean}|null)}
 *   [options.resolveDevice]  finds a device login '<school>.<DEVICE>'; `active` is false when the device is
 *   not ACTIVE or its school is SUSPENDED. May also return a promise. Without it no device can log in.
 * @param {string} [options.platformPassword]  default ctx.settings.platformBrokerPassword
 * @param {{username: string, password: string} | null} [options.viewer]  default ctx.settings.viewer; null turns it off
 * @returns {Promise<{url: string, port: number, tlsUrl: string|null, tlsPort: number|null, aedes: Aedes,
 *   kick: (username: string) => number, clients: () => Array<{clientId: string, username: string|null}>,
 *   close: () => Promise<void>}>}  kick() returns how many connections it closed.
 */
export async function startBroker(ctx, {
  host = '127.0.0.1',
  port = 1883,
  tls: tlsOptions = null,
  resolveDevice = () => null,
  platformPassword = ctx.settings?.platformBrokerPassword,
  viewer = ctx.settings?.viewer,
} = {}) {
  if (typeof resolveDevice !== 'function') throw new TypeError('resolveDevice must be a function');
  if (tlsOptions && (!tlsOptions.key || !tlsOptions.cert)) throw new TypeError('tls needs a PEM key and cert');
  const { events } = ctx;
  const log = (level, message, meta) => {
    try {
      ctx.log?.(level, message, meta);
    } catch {
      // a broken logger must not break the broker
    }
  };

  const accounts = new WeakMap(); // aedes client -> the account it logged in with
  // QoS 1 messages from clients that aedes has acknowledged but not yet passed on (see close()).
  const passingOn = new Set();
  let draining = false; // close() has begun: a machine's new message is refused
  let drained = null; // ends close()'s wait once passingOn is empty
  // kick() voids logins already under way, whose device lookup may predate the switch-off.
  let loginSeq = 0;
  const kickedUpTo = new Map(); // username -> last login attempt started before kick()
  const kickedSince = (account) => account.attempt <= (kickedUpTo.get(account.username) ?? 0);
  // Client id -> account of its session: the live one, or one a clean:false login left
  // behind. A login with that id resumes (or, if clean, wipes) the session, its
  // subscriptions and the QoS 1 messages queued for it, so it must be the same account.
  // Viewer sessions are not listed: that login is public, so they guard nothing, and the
  // platform must be able to take back an id the viewer sits on.
  const sessionOwners = new Map();
  let aedes = null;

  /**
   * Emit mqtt.denied (its school from the topic, else from a device username) and log why. A
   * refused publish of an envelope names its id (msgId), so the refusal joins the sender's flow.
   */
  function refuse({ username, action, topic, reason, clientId, msgId }) {
    const data = { username, action };
    if (topic !== undefined) data.topic = topic;
    if (typeof msgId === 'string') data.msgId = msgId;
    events.emit('mqtt.denied', data, schoolOfTopic(topic) ?? parseDeviceUsername(username)?.schoolCode ?? null);
    log('warn', `broker refused ${action}`, { username, clientId, topic, reason });
  }

  /** -> { account } or { code, reason } */
  async function checkLogin(clientId, username, password) {
    if (typeof username !== 'string' || username === '') return refusal(NOT_AUTHORIZED, 'anonymous login');
    let account;
    const codes = parseDeviceUsername(username);
    if (username === PLATFORM_USERNAME) {
      if (!secretMatches(password, platformPassword)) return refusal(BAD_LOGIN, 'wrong password');
      account = platformAccount();
    } else if (codes) {
      const device = await resolveDevice(username);
      if (!device) return refusal(BAD_LOGIN, 'unknown device');
      if (!secretMatches(password, device.password)) return refusal(BAD_LOGIN, 'wrong password');
      if (clientId !== username) return refusal(ID_REJECTED, 'a device must use its username as client id');
      if (device.active !== true) return refusal(NOT_AUTHORIZED, 'device or its school is switched off');
      account = deviceAccount(username, codes);
    } else if (typeof viewer?.username === 'string' && username === viewer.username) {
      if (!secretMatches(password, viewer.password)) return refusal(BAD_LOGIN, 'wrong password');
      account = viewerAccount(username);
    } else {
      return refusal(BAD_LOGIN, 'unknown user');
    }
    // A login that reuses a session's client id closes that session (MQTT-3.1.4-2) and
    // inherits or wipes what it kept. Device ids belong to their devices, and only the same
    // account may take a session over, live or kept (see sessionOwners), so the public
    // viewer login can neither push anyone off nor take the platform's queued records.
    if (account.role !== 'device' && parseDeviceUsername(clientId)) {
      return refusal(ID_REJECTED, 'this client id belongs to a device');
    }
    const owner = sessionOwners.get(clientId);
    if (owner && owner.username !== account.username) {
      return refusal(ID_REJECTED, 'this client id has a session of another account');
    }
    return { account };
  }

  function authenticate(client, username, password, callback) {
    const attempt = ++loginSeq;
    const clientId = client.id;
    checkLogin(clientId, username, passwordText(password))
      .catch((err) => {
        log('error', 'broker login check failed', { username, error: err?.message });
        return refusal(UNAVAILABLE, 'device lookup failed');
      })
      .then((outcome) => {
        if (outcome.account) outcome.account.attempt = attempt;
        if (outcome.account && kickedSince(outcome.account)) {
          outcome = refusal(NOT_AUTHORIZED, 'kicked while logging in');
        }
        if (outcome.account) {
          accounts.set(client, outcome.account);
          callback(null, true);
          return;
        }
        const who = typeof username === 'string' && username !== '' ? username : null;
        refuse({ username: who, action: 'connect', reason: outcome.reason, clientId });
        const err = new Error(`login refused: ${outcome.reason}`);
        err.returnCode = outcome.code;
        callback(err, false);
      });
  }

  // mqtt.publish is announced the moment the broker accepts a message. aedes's own 'publish'
  // event comes only once the message is stored, acknowledged and passed on, often after the
  // platform has handled it, which would put the broker's hop last in a Simulation-mode replay.
  const announced = new WeakSet(); // packets announced on acceptance (the 'publish' event skips them)

  function announcePublish(packet, client) {
    const account = client ? accounts.get(client) : undefined;
    const { type, txn, id } = peekEnvelope(packet.payload);
    events.emit(
      'mqtt.publish',
      {
        from: account?.username ?? client?.id ?? null,
        topic: packet.topic,
        type,
        txn,
        // the envelope id links this hop to the flow that sent the message (Simulation mode)
        msgId: id,
        qos: Number.isInteger(packet.qos) ? packet.qos : 0,
        retained: Boolean(packet.retain),
        bytes: byteLength(packet.payload),
      },
      schoolOfTopic(packet.topic) ?? account?.schoolCode ?? null,
    );
  }

  function authorizePublish(client, packet, callback) {
    // client is null only for a stored will of a broker that is gone; nobody vouches for it
    const account = client ? accounts.get(client) : undefined;
    if (draining && account?.role !== 'platform') {
      // closing: no PUBACK, so the sender keeps the message (the platform's link stays, to
      // receive what is still being passed on)
      log('debug', 'broker closing: publish refused', { username: account?.username ?? null, topic: packet.topic });
      callback(new Error('the broker is closing'));
      return;
    }
    if (account && mayPublish(account, packet.topic)) {
      // A QoS 2 resend is published again only if the first copy never arrived: then the
      // 'publish' event announces it.
      if (!(packet.qos === 2 && packet.dup)) {
        announced.add(packet);
        announcePublish(packet, client);
      }
      // acknowledged before it is passed on: close() waits for it (QoS 2 is passed on first)
      if (packet.qos === 1) passingOn.add(packet);
      callback(null);
      return;
    }
    const username = account?.username ?? null;
    refuse({ username, action: 'publish', topic: packet.topic, reason: 'topic not allowed', clientId: client?.id, msgId: peekEnvelope(packet.payload).id });
    callback(new Error(`not allowed to publish to ${packet.topic}`));
  }

  function authorizeSubscribe(client, subscription, callback) {
    const account = accounts.get(client);
    if (account && maySubscribe(account, subscription.topic)) {
      callback(null, subscription);
      return;
    }
    const username = account?.username ?? null;
    refuse({ username, action: 'subscribe', topic: subscription.topic, reason: 'filter not allowed', clientId: client.id });
    callback(null, null); // a negated subscription: SUBACK 128 for this filter only
  }

  aedes = await Aedes.createBroker({ authenticate, authorizePublish, authorizeSubscribe });

  // 'client' and 'clientDisconnect' come in pairs, and only for logins that succeeded.
  aedes.on('client', (client) => {
    const account = accounts.get(client);
    if (account && account.role !== 'viewer') sessionOwners.set(client.id, account);
    events.emit('mqtt.connect', { username: account?.username ?? null, clientId: client.id }, account?.schoolCode ?? null);
    // kick() came after this login was checked but before aedes registered it (it was
    // setting up the session, or closing an older one with the same id): close it now.
    if (account && kickedSince(account)) client.close();
  });
  aedes.on('clientDisconnect', (client) => {
    const account = accounts.get(client);
    // a clean session ends with its connection; a clean:false one stays with its account
    if (client.clean && sessionOwners.get(client.id) === account) sessionOwners.delete(client.id);
    events.emit('mqtt.disconnect', { username: account?.username ?? null, clientId: client.id }, account?.schoolCode ?? null);
  });
  // Fires once per published message, with the retain flag as sent. Messages from clients were
  // announced when authorizePublish accepted them; this covers the ones the server sends itself.
  aedes.on('publish', (packet, client) => {
    // passed on to every subscriber: nothing of it is left for close() to wait for
    if (passingOn.delete(packet) && passingOn.size === 0) drained?.();
    if (typeof packet.topic !== 'string' || packet.topic.startsWith('$')) return; // the broker's own $SYS chatter
    if (announced.has(packet)) return;
    announcePublish(packet, client);
  });
  aedes.on('clientError', (client, err) => log('debug', 'mqtt client error', { clientId: client?.id, error: err?.message }));
  aedes.on('connectionError', (client, err) => log('debug', 'mqtt connection error', { error: err?.message }));
  // Without a listener an aedes 'error' (a persistence failure) would crash the process.
  aedes.on('error', (err) => log('error', 'mqtt broker error', { error: err?.message }));

  const servers = [];
  const sockets = new Set(); // aedes closes logged-in clients only; close() ends the rest
  let closing = null;

  function serve(server) {
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('error', (err) => log('error', 'mqtt listener error', { error: err.message }));
    if (server instanceof tls.Server) {
      server.on('tlsClientError', (err) => log('debug', 'mqtt TLS handshake failed', { error: err.message }));
    }
    return server;
  }

  function listen(server, listenPort) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, host, () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
  }

  function close() {
    closing ??= (async () => {
      // Stop accepting first; each server reports closed once its last socket is gone.
      const stopped = servers.map((server) => new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve())));
      // Then pass on what was acknowledged already, before the connections go (file header).
      draining = true;
      if (passingOn.size > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, DRAIN_MS);
          drained = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      await new Promise((resolve) => aedes.close(() => resolve()));
      for (const socket of sockets) socket.destroy(); // still waiting for CONNECT, or mid-handshake
      await Promise.all(stopped);
    })();
    return closing;
  }

  let plainPort;
  let tlsPort = null;
  try {
    plainPort = await listen(serve(net.createServer(aedes.handle)), port);
    if (tlsOptions) {
      const secure = serve(tls.createServer({ key: tlsOptions.key, cert: tlsOptions.cert }, aedes.handle));
      tlsPort = await listen(secure, tlsOptions.port ?? 8883);
    }
  } catch (err) {
    await close();
    throw err;
  }

  const shownHost = urlHost(host);
  return {
    url: `mqtt://${shownHost}:${plainPort}`,
    port: plainPort,
    tlsUrl: tlsPort === null ? null : `mqtts://${shownHost}:${tlsPort}`,
    tlsPort,
    aedes,

    /**
     * Disconnect every session of `username` now (a machine switched off, a school
     * suspended). Its logins already under way are refused, or closed the moment aedes
     * registers them; only logins that start after the kick are judged afresh.
     * @returns {number} how many registered connections it closed
     */
    kick(username) {
      kickedUpTo.set(username, loginSeq);
      let kicked = 0;
      for (const client of Object.values(aedes.clients)) {
        if (!client.closed && accounts.get(client)?.username === username) {
          client.close();
          kicked++;
        }
      }
      return kicked;
    },

    /** Connected (logged-in) clients. */
    clients() {
      return Object.values(aedes.clients)
        .filter((client) => !client.closed)
        .map((client) => ({ clientId: client.id, username: accounts.get(client)?.username ?? null }));
    },

    close,
  };
}
