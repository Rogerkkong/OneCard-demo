// The lab console (/lab/): a Packet Tracer-like view of the whole virtual system. One virtual
// cloud server serves many schools; each school's site has its machines, cards and admin card.
// The device bar builds it further (build.js: drag a machine onto a school, a school onto the
// internet line) and cables are drawn by dragging their ends (cables.js).
// Data: GET /api/lab/state (polled, and refreshed when events arrive), the live event stream
// GET /api/lab/events, and the lab actions under /api/lab/* (they keep working while the
// virtual cloud server is switched off: they are the lab, not the product). The header's
// Realtime | Simulation switch and the Simulation tab (sim.js) are Packet Tracer's Simulation
// mode: replay any flow hop by hop, or hold live flows at each hop.

import { get, post, toast } from '/shared/api.js';
import { createI18n } from '/shared/i18n.js';
import { STRINGS } from './strings.js';
import { errorText, heldText, sentences } from './describe.js';
import { busy, downloadJson, prefs, rich, setHidden, setText, setTone } from './util.js';
import { createTopology } from './topology.js';
import { createTrays } from './tray.js';
import { createFaults } from './faults.js';
import { createClock } from './clock.js';
import { createInspector } from './inspector.js';
import { createShell } from './shell.js';
import { createSim } from './sim.js';
import { createBuild } from './build.js';
import { createCables } from './cables.js';

const i18n = createI18n(STRINGS);
const { t } = i18n;
const $ = (sel) => document.querySelector(sel);

let refreshTimer = null;
let refreshDue = 0;
let netDown = false;

// Answers that wait at a hop (Simulation mode, hold on) which the panel that asked cannot read:
// the clock panel gets them as a plain message instead.
const HELD_AS_MESSAGE = new Map([['/api/lab/clock/advance', 'sim.clockHeld']]);

// Events after which the picture on screen is out of date (the state is fetched again).
const REFRESH_ON = new Set([
  'device.screen',
  'device.cable',
  'card.write',
  'mqtt.connect',
  'mqtt.disconnect',
  'server.status',
  'broker.status',
  'lab.action',
  'lab.clock',
  'config.published',
  'card.issued',
  'card.lost',
  'card.found',
  'device.registered',
  'tenant.created',
  'school.status',
  'admin-card.loaded',
  'admin-card.applied',
  'intake.accepted',
  'purchase.received',
]);

const app = {
  i18n,
  t,
  /** The last GET /api/lab/state. */
  state: null,
  /** The picked card, '<school>/<uid>' (one selection for the whole page). */
  selected: null,

  select(key) {
    app.selected = key || null;
    render();
  },

  /**
   * POST to a lab route. The button (if any) shows `label` while it runs. Never throws.
   * In Simulation mode with hold on, an action whose flow waits at a hop answers early
   * ({ held: true, trace, item, ... }): the Simulation tab says so, and the answer comes back
   * with `held: true` (or, for a panel that cannot read it, as a HELD message).
   * @returns {Promise<{ ok: true, data: any, held?: true } | { ok: false, error: Error }>}
   */
  async call(path, body, button, label) {
    try {
      const data = await busy(button, button ? label ?? t('working') : null, () => post(path, body ?? {}));
      if (data && data.held === true) {
        sim.noteHeld(data, { open: path !== '/api/lab/console' });
        if (HELD_AS_MESSAGE.has(path)) {
          return { ok: false, error: { code: 'HELD', message: sentences(t(HELD_AS_MESSAGE.get(path)), heldText(data.item, t, { serverUp: app.state?.server?.up !== false })) } };
        }
        return { ok: true, data, held: true };
      }
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    } finally {
      app.refresh(60);
    }
  },

  fail(error) {
    toast(errorText(error, t), error?.code === 'HELD' ? 'info' : 'bad');
    if (error?.code === 'NETWORK') app.refresh(0);
  },

  download: downloadJson,

  async setServer(up, button) {
    const res = await app.call('/api/lab/server', { up }, button, t(up ? 'cloud.busyOn' : 'cloud.busyOff'));
    if (!res.ok) return app.fail(res.error);
    if (res.held) return toast(t(up ? 'sim.serverHeld' : 'sim.serverOffHeld'), 'info');
    if (!res.data.changed) toast(t(up ? 'toast.serverSameOn' : 'toast.serverSameOff'), 'info');
    else toast(t(up ? 'toast.serverOn' : 'toast.serverOff'), up ? 'good' : 'warn');
  },

  async restartBroker(button) {
    const res = await app.call('/api/lab/broker/restart', {}, button, t('cloud.busyRestart'));
    if (!res.ok) return app.fail(res.error);
    toast(t(res.held ? 'sim.brokerHeld' : 'toast.brokerRestarted'), res.held ? 'info' : 'good');
  },

  openConsole(key) {
    tabs.show('console');
    $('#side').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    shell.connect(key);
  },

  highlight(key) {
    topology.highlight(key);
  },

  beforeReset() {
    inspector.clear();
    sim.reset();
    app.selected = null;
  },

  /** 'realtime' or 'simulation' (Simulation mode, DESIGN §11). */
  simMode() {
    return sim.mode;
  },

  /** Show the Simulation tab (something waits at a hop). */
  openSim() {
    tabs.show('sim');
  },

  /** Fetch the state again soon; a burst of events leads to one fetch, never to an endless wait. */
  refresh(delay = 0) {
    const due = Date.now() + delay;
    if (refreshTimer !== null && refreshDue <= due) return;
    clearTimeout(refreshTimer);
    refreshDue = due;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      load();
    }, delay);
  },
};

// ---- modules -------------------------------------------------------------------------------

const trays = createTrays(app);
const topology = createTopology(app, { cloudEl: $('#cloud'), sitesEl: $('#sites'), trays });
const faults = createFaults(app, $('#faults'));
const clock = createClock(app, $('#clock'));
const inspector = createInspector(app, $('#panel-messages'));
const shell = createShell(app, $('#panel-console'));
const sim = createSim(app, {
  root: $('#panel-sim'),
  modeSwitch: $('#mode-switch'),
  topologyEl: $('#topology'),
  topology,
  showTab: (name) => tabs.show(name),
});
app.sim = sim;
createCables(app, { sitesEl: $('#sites'), topology, live: $('#build-live') });
const build = createBuild(app, { root: $('#build'), cloudEl: $('#cloud'), sitesEl: $('#sites'), topology, live: $('#build-live') });
/** "Add machine" on a school's site: the same dialog as the device bar, for that school. */
app.openAddMachine = (school, opener) => build.openAddMachine({ school, opener });

// ---- header, language, help, banners ---------------------------------------------------------------

const switcher = i18n.switcher();
$('#lang').append(switcher);

const tabs = (() => {
  const buttons = [...document.querySelectorAll('[role="tab"]')];
  const names = buttons.map((b) => b.dataset.tab);
  function show(name, focus = false) {
    for (const b of buttons) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      setHidden(document.getElementById(b.getAttribute('aria-controls')), !on);
      if (on && focus) b.focus();
    }
    prefs.set('tab', name);
    sim.shown(name === 'sim');
  }
  for (const b of buttons) {
    b.addEventListener('click', () => show(b.dataset.tab));
    b.addEventListener('keydown', (ev) => {
      const i = buttons.indexOf(b);
      let next = null;
      if (ev.key === 'ArrowRight') next = buttons[(i + 1) % buttons.length];
      else if (ev.key === 'ArrowLeft') next = buttons[(i - 1 + buttons.length) % buttons.length];
      else if (ev.key === 'Home') next = buttons[0];
      else if (ev.key === 'End') next = buttons[buttons.length - 1];
      if (!next) return;
      ev.preventDefault();
      show(next.dataset.tab, true);
    });
  }
  const saved = prefs.get('tab', 'messages');
  show(names.includes(saved) ? saved : 'messages');
  return { show };
})();

// jump links to the tabs open the tab they point at
for (const a of document.querySelectorAll('[data-jump-tab]')) {
  a.addEventListener('click', () => tabs.show(a.dataset.jumpTab));
}

const help = $('#help');
help.open = prefs.get('help.open', false) === true;
help.addEventListener('toggle', () => prefs.set('help.open', help.open));

function renderHelp() {
  const s = app.state;
  const mqtt = (() => {
    try {
      const u = new URL(s?.broker?.url ?? 'mqtt://127.0.0.1:1883');
      return { host: u.hostname, port: u.port || '1883' };
    } catch {
      return { host: '127.0.0.1', port: '1883' };
    }
  })();
  const consoleAddr = s?.urls?.consoleAddress ?? null;
  const cHost = consoleAddr ? consoleAddr.slice(0, consoleAddr.lastIndexOf(':')) : '127.0.0.1';
  const cPort = consoleAddr ? consoleAddr.slice(consoleAddr.lastIndexOf(':') + 1) : '2323';
  const viewer = s?.broker?.viewer ?? { username: 'viewer', password: 'viewer' };
  const sig = JSON.stringify([i18n.lang, mqtt, consoleAddr, viewer]);
  const body = $('#help-body');
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  const p = (key, vars) => {
    const el = document.createElement('p');
    el.append(...rich(t(key, vars)));
    return el;
  };
  const li = (key, vars) => {
    const el = document.createElement('li');
    el.append(...rich(t(key, vars)));
    return el;
  };
  const steps = document.createElement('ol');
  steps.className = 'help__steps';
  steps.append(li('help.s1'), li('help.s2'), li('help.s3'), li('help.s4'), li('help.s5'), li('help.s6'), li('help.s7'));
  const outside = document.createElement('h3');
  outside.textContent = t('help.outside');
  const tool = (titleKey, ...paras) => {
    const section = document.createElement('section');
    section.className = 'help__tool';
    const h4 = document.createElement('h4');
    h4.textContent = t(titleKey);
    section.append(h4, ...paras);
    return section;
  };
  const putty = consoleAddr
    ? tool('help.putty.title', p('help.putty.text', { host: cHost, port: cPort }), p('help.putty.nc', { host: cHost, port: cPort }))
    : tool('help.putty.title', p('help.putty.text', { host: cHost, port: cPort }), p('help.putty.nc', { host: cHost, port: cPort }), p('help.putty.off'));
  const tools = document.createElement('div');
  tools.className = 'help__tools';
  tools.append(
    putty,
    tool('help.mqtt.title', p('help.mqtt.text', { host: mqtt.host, port: mqtt.port, user: viewer.username, pass: viewer.password })),
    tool('help.phone.title', p('help.phone.text')),
  );
  body.replaceChildren(p('help.intro'), steps, p('help.exercises'), outside, tools);
}

function renderHeader() {
  const s = app.state;
  const pill = $('#hdr-server');
  if (!s) {
    setHidden(pill, true);
    return;
  }
  setHidden(pill, false);
  setText(pill, t(s.server?.up ? 'hdr.server.up' : 'hdr.server.down'));
  setTone(pill, 'pill--', s.server?.up ? 'good' : 'bad');
}

function renderJump() {
  const list = $('#jump-schools');
  const schools = app.state?.schools ?? [];
  const sig = schools.map((s) => `${s.code}:${s.name}`).join('|');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.replaceChildren(
    ...schools.map((s) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#site-${s.code}`;
      a.textContent = s.name;
      li.append(a);
      return li;
    }),
  );
}

function renderBanners() {
  const s = app.state;
  // while the lab cannot be reached, what the page shows is the last known picture
  $('#main').classList.toggle('is-stale', netDown);
  setHidden($('#banner-net'), !netDown);
  setHidden($('#banner-down'), netDown || !s || s.server?.up !== false);
  setHidden($('#banner-busy'), netDown || !s || s.phase === 'running');
}
$('#banner-down button').addEventListener('click', (ev) => app.setServer(true, ev.currentTarget));

function render(requestedAt = 0) {
  const s = app.state;
  renderBanners();
  renderHeader();
  if (!s) return;
  if (app.selected) {
    const i = app.selected.indexOf('/');
    const school = s.schools?.find((x) => x.code === app.selected.slice(0, i));
    if (!school?.cards.some((c) => c.uid === app.selected.slice(i + 1))) app.selected = null;
  }
  topology.render(s);
  build.update(s);
  faults.update(s);
  clock.update(s);
  inspector.update(s);
  shell.relabel();
  sim.update(s, requestedAt);
  renderHelp();
  renderJump();
}

i18n.onChange(() => {
  document.title = t('doc.title');
  switcher.setAttribute('aria-label', t('lang.label'));
  render();
  inspector.relang();
  sim.relang();
  build.relang();
});
document.title = t('doc.title');
switcher.setAttribute('aria-label', t('lang.label'));
i18n.apply();

// the sticky right column and the device bar sit under the header, whatever its height; what
// the page scrolls to sits under both
const header = $('#lab-header');
new ResizeObserver(() => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`)).observe(header);
const bar = $('#build');
new ResizeObserver(() => document.documentElement.style.setProperty('--build-h', `${bar.offsetHeight}px`)).observe(bar);

// ---- the state: polled, and fetched again when events say it changed ------------------------------

let loading = false;
let loadAgain = false;
let pollTimer = null;

async function load() {
  if (loading) {
    loadAgain = true;
    return;
  }
  loading = true;
  try {
    const requestedAt = performance.now();
    const s = await get('/api/lab/state');
    const wasDown = netDown;
    netDown = false;
    app.state = s;
    render(requestedAt);
    if (wasDown) toast(t('toast.back'), 'good');
  } catch {
    // the lab process itself is unreachable (its own routes never answer 503 SERVER_DOWN)
    if (!netDown) {
      netDown = true;
      renderBanners();
    }
  } finally {
    loading = false;
    if (loadAgain) {
      loadAgain = false;
      load();
    }
  }
}

function pollDelay() {
  if (document.hidden) return 10_000;
  if (netDown) return 3000;
  const s = app.state;
  if (!s || s.phase !== 'running') return 1000;
  // machines coming back after the server or broker restarted: watch them reconnect
  const coming = s.server?.up && s.schools.some((x) => x.status === 'ACTIVE' && x.devices.some((d) => d.cablePlugged && !d.connected && (d.deviceStatus ?? 'ACTIVE') === 'ACTIVE'));
  return coming ? 1000 : 2500;
}

async function poll() {
  await load();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, pollDelay());
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

// ---- the live event stream -----------------------------------------------------------------------

let stream = null;
let streamLost = false;
function connectEvents() {
  stream?.close();
  stream = new EventSource('/api/lab/events');
  stream.addEventListener('open', () => {
    inspector.setLive('live');
    // whatever happened while the stream was away: the Simulation tab asks for it again
    if (streamLost) sim.resync();
    streamLost = false;
  });
  stream.addEventListener('error', () => {
    inspector.setLive('reconnecting');
    streamLost = true;
    // the browser retries by itself unless the stream was refused; then try again later
    if (stream.readyState === EventSource.CLOSED) setTimeout(connectEvents, 3000);
  });
  stream.addEventListener('message', (m) => {
    let e;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    if (!e || typeof e.type !== 'string') return;
    inspector.add(e);
    topology.onEvent(e);
    sim.onEvent(e);
    if (REFRESH_ON.has(e.type)) app.refresh(150);
  });
}

connectEvents();
poll();
