// The topology: the virtual cloud server at the top and, below it on the "internet" line, one
// site per school (tenant) with its machines, card tray and admin card. Each machine hangs on its
// school's network by its own cable; the cable's line shows the link (up, trying, pulled out)
// and lights up briefly when a message passes. Elements are patched in place on every refresh.

import { formatRM, formatTimeKL, h, toast } from '/shared/api.js';
import { directionOf, parseTopic, reasonText, screenCaption } from './describe.js';
import { hhmm, icon, reconcile, reducedMotion, setAttr, setHidden, setText, setTone } from './util.js';

const FLASH_MS = 900;

/** What a machine's link looks like and what its status pill says. */
function machineStatus(m, school, serverUp) {
  if (m.installed === false) return { key: 'm.status.installing', tone: 'info', link: 'off' };
  if (m.deviceStatus && m.deviceStatus !== 'ACTIVE') {
    return { key: `m.status.${m.deviceStatus}`, tone: 'bad', link: m.cablePlugged ? 'bad' : 'off' };
  }
  if (!m.cablePlugged) return { key: 'm.status.noNetwork', tone: '', link: 'off' };
  if (m.connected) return { key: 'm.status.connected', tone: 'good', link: 'up' };
  if (!serverUp) return { key: 'm.status.serverOff', tone: 'warn', link: 'bad' };
  if (school.status === 'SUSPENDED') return { key: 'm.status.suspended', tone: 'bad', link: 'bad' };
  return { key: 'm.status.connecting', tone: 'warn', link: 'wait' };
}

export function createTopology(app, { cloudEl, sitesEl, trays }) {
  const { t } = app;
  const machineEls = new Map(); // '<school>/<DEVICE>' -> element
  const lastMessage = new Map(); // '<school>/<DEVICE>' -> { dir, type, at }
  const known = new Set(); // school codes seen, so a new tenant can be pointed out
  let firstRender = true;

  // ---- the cloud server node -------------------------------------------------------------

  const cloud = (() => {
    const part = (name, iconName) => {
      const label = h('span', { class: 'part__label' });
      const value = h('span', { class: 'part__value' });
      const el = h('li', { class: `part part--${name}` }, icon(iconName, 'part__icon'), h('span', { class: 'part__text' }, label, value));
      return { el, label, value };
    };
    const title = h('h2', { id: 'cloud-title', class: 'cloud__title' });
    const sub = h('p', { class: 'cloud__sub muted' });
    const status = h('span', { class: 'pill cloud__status' });
    const broker = part('broker', 'broker');
    const platform = part('platform', 'platform');
    const db = part('db', 'db');
    const clients = h('p', { class: 'cloud__clients' });
    const switchBtn = h('button', { type: 'button', class: 'btn' });
    const restartBtn = h('button', { type: 'button', class: 'btn' });
    const restartNote = h('p', { class: 'cloud__note muted' });
    cloudEl.append(
      h('header', { class: 'cloud__head' }, icon('cloud', 'cloud__icon'), h('div', { class: 'cloud__titles' }, title, sub), status),
      h('ul', { class: 'cloud__parts' }, broker.el, platform.el, db.el),
      clients,
      h('div', { class: 'row cloud__actions' }, switchBtn, restartBtn),
      restartNote,
    );
    switchBtn.addEventListener('click', () => app.setServer(!app.state?.server?.up, switchBtn));
    restartBtn.addEventListener('click', () => app.restartBroker(restartBtn));
    return { title, sub, status, broker, platform, db, clients, switchBtn, restartBtn, restartNote };
  })();

  function renderCloud(state) {
    const up = Boolean(state.server?.up);
    const b = state.broker ?? {};
    cloudEl.classList.toggle('is-down', !up);
    setText(cloud.title, t('cloud.title'));
    setText(cloud.sub, t('cloud.sub'));
    setText(cloud.status, up ? t('cloud.on') : t('cloud.off'));
    setTone(cloud.status, 'pill--', up ? 'good' : 'bad');

    setText(cloud.broker.label, t('cloud.broker'));
    setText(cloud.broker.value, b.up ? t('cloud.broker.up', { n: b.clients ?? 0 }) : t('cloud.broker.down'));
    cloud.broker.el.classList.toggle('is-down', !b.up);
    setText(cloud.platform.label, t('cloud.platform'));
    const linked = Boolean(state.platform?.connected);
    setText(cloud.platform.value, linked ? t('cloud.platform.on') : t('cloud.platform.off'));
    cloud.platform.el.classList.toggle('is-down', !linked);
    setText(cloud.db.label, t('cloud.db'));
    setText(cloud.db.value, up ? t('cloud.db.on', { n: state.schools?.length ?? 0 }) : t('cloud.db.off'));
    cloud.db.el.classList.toggle('is-down', !up);

    const entries = Object.entries(b.bySchool ?? {}).map(([who, n]) => `${who === '(platform)' ? t('cloud.clients.platform') : who} ${n}`);
    setText(cloud.clients, t('cloud.clients', { list: entries.length ? entries.join(' · ') : t('cloud.clients.none') }));
    setHidden(cloud.clients, !b.up);

    if (!cloud.switchBtn.disabled) setText(cloud.switchBtn, up ? t('cloud.switchOff') : t('cloud.switchOn'));
    setTone(cloud.switchBtn, 'btn--', up ? 'danger' : 'primary');
    if (!cloud.restartBtn.hasAttribute('aria-busy')) {
      setText(cloud.restartBtn, t('cloud.restart'));
      cloud.restartBtn.disabled = !up;
    }
    setText(cloud.restartNote, up ? t('fault.broker-restart.text') : t('cloud.restartOff'));
  }

  // ---- machines ------------------------------------------------------------------------------

  function menuButton(labelKey, onClick) {
    const b = h('button', { type: 'button', class: 'menu__item', dataset: { label: labelKey } });
    b.addEventListener('click', (ev) => {
      ev.currentTarget.closest('details')?.removeAttribute('open');
      onClick();
    });
    return b;
  }

  function createMachine(m) {
    const key = `${m.school}/${m.code}`;
    const id = `m-${m.school}-${m.code}`;
    const r = {};
    r.cable = h('span', { class: 'machine__cable', 'aria-hidden': 'true' }, h('span', { class: 'machine__plug' }));
    r.status = h('span', { class: 'pill machine__status' });
    r.type = h('p', { class: 'machine__type' });
    r.screenLabel = h('span', { class: 'sr-only' });
    r.screenText = h('span', { class: 'lcd__text' });
    r.screenTime = h('span', { class: 'lcd__time', 'aria-hidden': 'true' });
    r.lcd = h('div', { class: 'lcd', role: 'status', 'aria-atomic': 'true' }, r.screenLabel, r.screenText, r.screenTime);
    r.caption = h('p', { class: 'lcd__caption', lang: 'zh-Hans', hidden: true });
    r.why = h('p', { class: 'machine__why', hidden: true });
    r.note = h('p', { class: 'machine__note' });
    const fact = (name) => {
      const dt = h('dt');
      const dd = h('dd');
      r[`${name}Dt`] = dt;
      r[`${name}Dd`] = dd;
      return h('div', { class: `fact fact--${name}` }, dt, dd);
    };
    r.facts = h('dl', { class: 'facts' }, fact('cable'), fact('platform'), fact('versions'), fact('journal'), fact('msg'));
    r.tapBtn = h('button', { type: 'button', class: 'btn btn--primary btn--small machine__tap' });
    r.tapBtn.addEventListener('click', () => trays.openTap(key, r.tapBtn));
    r.cableBtn = h('button', { type: 'button', class: 'btn btn--small machine__cablebtn' });
    r.cableBtn.addEventListener('click', () => toggleCable(key, r.cableBtn));
    r.moreSummary = h('summary', { class: 'btn btn--small menu__button' });
    const items = [menuButton('m.export', () => exportUsb(key))];
    if (m.type === 'KIOSK') {
      items.push(menuButton('m.adminLoad', () => trays.adminCard('load', m.school)));
      items.push(menuButton('m.adminUpload', () => trays.adminCard('upload', m.school)));
    } else if (m.type === 'CANTEEN' || m.type === 'WATER') {
      items.push(menuButton('m.adminTap', () => trays.adminCard('tap', m.school, m.code)));
    }
    items.push(menuButton('m.heartbeat', () => consoleAction(key, 'heartbeat')));
    items.push(menuButton('m.upload', () => consoleAction(key, 'upload')));
    items.push(menuButton('m.reboot', () => consoleAction(key, 'reboot')));
    items.push(menuButton('m.console', () => app.openConsole(key)));
    r.menuItems = items;
    r.more = h('details', { class: 'menu' }, r.moreSummary, h('div', { class: 'menu__list' }, items));
    r.actions = h('div', { class: 'machine__actions' }, r.tapBtn, r.cableBtn, r.more);
    r.title = h('h4', { class: 'machine__code', id: `${id}-title` }, m.code);

    const el = h(
      'article',
      { class: `machine machine--${String(m.type).toLowerCase()}`, id, 'aria-labelledby': `${id}-title` },
      r.cable,
      h('header', { class: 'machine__head' }, icon(m.type, 'machine__icon'), r.title, r.status),
      r.type,
      r.lcd,
      r.caption,
      r.why,
      r.note,
      r.facts,
      r.actions,
    );
    el._r = r;
    machineEls.set(key, el);
    return el;
  }

  function updateMachine(el, m, school, state) {
    const r = el._r;
    const key = `${m.school}/${m.code}`;
    const s = machineStatus(m, school, Boolean(state.server?.up));
    el.dataset.link = s.link;
    setText(r.status, t(s.key));
    setTone(r.status, 'pill--', s.tone);
    setText(r.type, [t(`type.${m.type}`), m.location].filter(Boolean).join(' · '));

    // the screen: the machine's own text; a Chinese caption under it in Chinese
    const screen = m.lastScreen;
    const text = screen?.text ?? 'Ready';
    setText(r.screenLabel, `${t('m.screen', { code: m.code })}: `);
    setText(r.screenText, text);
    setText(r.screenTime, screen?.at ? hhmm(Date.parse(screen.at)) : '');
    r.lcd.dataset.tone = screen ? screen.tone : 'idle';
    const caption = screenCaption(text, t, app.i18n.lang);
    setText(r.caption, caption ?? '');
    setHidden(r.caption, !caption);
    const last = m.lastResult;
    const why = last && !last.ok && last.reason && screen && last.screen === screen.text ? reasonText(last.reason, t) : '';
    setText(r.why, why ? t('m.why', { reason: why }) : '');
    setHidden(r.why, !why);

    let note = '';
    if (m.type === 'KIOSK') note = t('m.note.KIOSK');
    else if (m.type === 'WATER' && m.prices?.water) {
      note = t('m.note.WATER', { perLitre: formatRM(m.prices.water.perLitreSen), min: formatRM(m.prices.water.minChargeSen) });
    } else if (m.type === 'CANTEEN' && m.prices) note = t('m.note.CANTEEN', { version: m.prices.version, items: m.prices.items?.length ?? 0 });
    setText(r.note, note);
    setHidden(r.note, !note);

    setText(r.cableDt, t('m.cable'));
    setText(r.cableDd, m.cablePlugged ? t('m.cable.in') : t('m.cable.out'));
    setText(r.platformDt, t('m.platform'));
    const heard = m.lastHeartbeatAt ? hhmm(m.lastHeartbeatAt) : null;
    setText(r.platformDd, heard ? t(m.online ? 'm.platform.online' : 'm.platform.offline', { time: heard }) : t('m.platform.never'));
    setText(r.versionsDt, t('m.versions'));
    const v = m.versions ?? {};
    setText(r.versionsDd, m.versions ? t('m.versions.value', { p: v.prices ?? 0, s: v.settings ?? 0, b: v.blocklist ?? 0 }) : '—');
    setText(r.journalDt, t('m.journal'));
    setText(r.journalDd, m.journal ? t('m.journal.value', { unsent: m.journal.unsent, total: m.journal.total }) : '—');
    r.journalDd.classList.toggle('is-waiting', (m.journal?.unsent ?? 0) > 0);
    setText(r.msgDt, t('m.lastMsg'));
    const lm = lastMessage.get(key);
    setText(r.msgDd, lm ? t(lm.dir === 'down' ? 'm.lastMsg.down' : 'm.lastMsg.up', { type: lm.type, time: formatTimeKL(lm.at) }) : t('m.lastMsg.none'));

    const installed = m.installed !== false;
    setText(r.tapBtn, t('m.tap'));
    r.tapBtn.disabled = !installed;
    if (!r.cableBtn.hasAttribute('aria-busy')) {
      setText(r.cableBtn, m.cablePlugged ? t('m.pull') : t('m.plug'));
      r.cableBtn.disabled = !installed;
    }
    setAttr(r.cableBtn, 'aria-pressed', m.cablePlugged ? 'true' : 'false');
    setText(r.moreSummary, t('m.more'));
    setAttr(r.moreSummary, 'aria-label', t('m.moreLabel', { code: m.code }));
    for (const b of r.menuItems) setText(b, t(b.dataset.label));
    setHidden(r.more, !installed);
  }

  // ---- sites ---------------------------------------------------------------------------------

  function createSite(s) {
    const r = {};
    r.title = h('h3', { class: 'site__title', id: `site-${s.code}-title` });
    r.code = h('span', { class: 'site__code mono' }, s.code);
    r.counts = h('p', { class: 'site__counts muted' });
    r.status = h('span', { class: 'pill site__status' });
    r.newPill = h('span', { class: 'pill pill--info site__new', hidden: true });
    r.gw = h('span', { class: 'site__gw' }, icon('router', 'site__gwicon'), h('span', { class: 'site__gwlabel' }));
    r.note = h('p', { class: 'site__note', hidden: true });
    r.net = h('div', { class: 'site__net' });
    r.empty = h('p', { class: 'site__empty muted', hidden: true });
    r.tray = trays.createTray(s.code);
    r.admin = trays.createAdmin(s.code);
    const el = h(
      'article',
      { class: 'site', id: `site-${s.code}`, 'aria-labelledby': `site-${s.code}-title`, tabindex: '-1' },
      h(
        'header',
        { class: 'site__head' },
        icon('school', 'site__icon'),
        h('div', { class: 'site__titles' }, h('div', { class: 'site__titleline' }, r.title, r.code), r.counts),
        h('div', { class: 'site__pills' }, r.newPill, r.status),
      ),
      r.note,
      r.gw,
      r.net,
      r.empty,
      r.tray,
      r.admin,
    );
    el._r = r;
    if (!firstRender && !known.has(s.code)) {
      el.classList.add('site--new');
      setHidden(r.newPill, false);
      toast(t('ev.tenant', { name: s.name, code: s.code }), 'info');
      setTimeout(() => {
        el.classList.remove('site--new');
        setHidden(r.newPill, true);
      }, 30_000);
    }
    known.add(s.code);
    return el;
  }

  function updateSite(el, s, state) {
    const r = el._r;
    setText(r.title, s.name);
    const connected = s.devices.filter((d) => d.connected).length;
    setText(r.counts, t('site.counts', { machines: s.devices.length, connected, cards: s.cards.length }));
    setText(r.status, t(`site.status.${s.status}`));
    setTone(r.status, 'pill--', s.status === 'ACTIVE' ? 'good' : 'bad');
    setText(r.newPill, t('site.new'));
    setText(r.gw.lastChild, t('site.network'));
    setText(r.note, s.status === 'SUSPENDED' ? t('site.suspended') : '');
    setHidden(r.note, s.status !== 'SUSPENDED');
    el.classList.toggle('is-suspended', s.status === 'SUSPENDED');
    reconcile(r.net, s.devices, (d) => d.code, createMachine, (mEl, d) => updateMachine(mEl, d, s, state));
    setText(r.empty, t('site.noMachines'));
    setHidden(r.empty, s.devices.length > 0);
    trays.updateTray(r.tray, s, state);
    trays.updateAdmin(r.admin, s, state);
  }

  function render(state) {
    renderCloud(state);
    sitesEl.classList.toggle('is-down', !state.server?.up);
    sitesEl.dataset.label = t('cloud.internet');
    reconcile(sitesEl, state.schools ?? [], (s) => s.code, createSite, (el, s) => updateSite(el, s, state));
    // forget machines that are gone (a lab reset rebuilds everything)
    for (const [key, el] of machineEls) if (!el.isConnected) machineEls.delete(key);
    firstRender = false;
  }

  // ---- machine actions -----------------------------------------------------------------------

  const machineOfKey = (key) => {
    const [school, code] = key.split('/');
    const s = app.state?.schools?.find((x) => x.code === school);
    return { school, code, m: s?.devices.find((d) => d.code === code) ?? null };
  };

  async function toggleCable(key, button) {
    const { school, code, m } = machineOfKey(key);
    if (!m) return;
    const plugged = !m.cablePlugged;
    const res = await app.call('/api/lab/cable', { schoolCode: school, deviceCode: code, plugged }, button);
    if (!res.ok) return app.fail(res.error);
    const after = res.data.machine;
    if (!plugged) toast(t('toast.cableOut', { code }), 'info');
    else toast(t(after?.connected ? 'toast.cableIn' : 'toast.cableInWait', { code }), after?.connected ? 'good' : 'warn');
  }

  async function exportUsb(key) {
    const { school, code } = machineOfKey(key);
    const res = await app.call('/api/lab/usb/export', { schoolCode: school, deviceCode: code });
    if (!res.ok) return app.fail(res.error);
    const file = res.data;
    const stamp = String(file.exportedAt ?? '').replace(/[^0-9]/g, '').slice(0, 12);
    const name = `${file.school}-${file.device}-journal-${stamp || 'export'}.json`.replace(/[^A-Za-z0-9._-]/g, '_');
    app.download(name, file);
    toast(t('toast.exported', { code, file: name, count: file.count ?? 0 }), 'good');
  }

  /** Heartbeat, upload and reboot have no route of their own: they go through the console. */
  async function consoleAction(key, command) {
    const { code, m } = machineOfKey(key);
    if ((command === 'heartbeat' || command === 'upload') && m && !m.connected) {
      toast(t('toast.notConnected', { code }), 'warn');
      return;
    }
    const res = await app.call('/api/lab/console', { line: command, target: key });
    if (!res.ok) return app.fail(res.error);
    const output = String(res.data.output ?? '').trim();
    if (output.startsWith('%')) {
      toast(t('toast.consoleSaid', { code, output: output.replace(/^%\s*/, '') }), 'warn');
      return;
    }
    if (command === 'heartbeat') toast(t('toast.heartbeat', { code }), 'good');
    else if (command === 'upload') toast(t(output.startsWith('Nothing') ? 'toast.uploadNone' : 'toast.upload', { code }), 'good');
    else toast(t('toast.reboot', { code }), 'good');
  }

  // ---- live events: screens and messages on the links ------------------------------------------

  function flash(key, dir) {
    const el = machineEls.get(key);
    if (!el) return;
    el.classList.add('is-talking');
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => el.classList.remove('is-talking'), FLASH_MS);
    if (!reducedMotion.matches && dir) {
      const dot = h('span', { class: `packet packet--${dir}`, 'aria-hidden': 'true' });
      el._r.cable.append(dot);
      setTimeout(() => dot.remove(), FLASH_MS);
    }
  }

  function pulsePart(part, tone) {
    const el = cloud[part]?.el;
    if (!el) return;
    el.dataset.pulse = tone;
    clearTimeout(el._pulseTimer);
    el._pulseTimer = setTimeout(() => delete el.dataset.pulse, FLASH_MS);
  }

  function onEvent(e) {
    const d = e.data ?? {};
    if (e.type === 'mqtt.publish') {
      const p = parseTopic(d.topic);
      pulsePart('broker', 'ok');
      if (!p) return;
      const key = `${p.school}/${p.device}`;
      const dir = directionOf(d.topic);
      lastMessage.set(key, { dir, type: d.type ?? '?', at: e.at });
      flash(key, dir);
      const el = machineEls.get(key);
      if (el) setText(el._r.msgDd, t(dir === 'down' ? 'm.lastMsg.down' : 'm.lastMsg.up', { type: d.type ?? '?', time: formatTimeKL(e.at) }));
    } else if (e.type === 'mqtt.denied') {
      pulsePart('broker', 'bad');
    } else if (e.type.startsWith('intake.')) {
      pulsePart('platform', e.type === 'intake.refused' ? 'bad' : e.type === 'intake.duplicate' ? 'warn' : 'ok');
      if (e.school && d.device) flash(`${e.school}/${d.device}`, null);
    } else if (e.type === 'ledger.posting' || e.type === 'purchase.received') {
      pulsePart('db', 'ok');
    } else if (e.type === 'device.screen' && e.school && d.device) {
      // show the new screen at once; the next state refresh confirms it
      const el = machineEls.get(`${e.school}/${d.device}`);
      if (!el) return;
      const r = el._r;
      setText(r.screenText, d.text ?? '');
      setText(r.screenTime, hhmm(Date.parse(e.at)));
      r.lcd.dataset.tone = d.tone ?? 'info';
      const caption = screenCaption(d.text, t, app.i18n.lang);
      setText(r.caption, caption ?? '');
      setHidden(r.caption, !caption);
      setHidden(r.why, true);
      r.lcd.classList.remove('is-new');
      void r.lcd.offsetWidth; // restart the highlight
      r.lcd.classList.add('is-new');
      clearTimeout(r.lcd._newTimer);
      r.lcd._newTimer = setTimeout(() => r.lcd.classList.remove('is-new'), 1500);
    }
  }

  /** Point at a machine after an action (scrolls it into view if needed). */
  function highlight(key) {
    const el = machineEls.get(key);
    if (!el) return;
    el.classList.add('is-acted');
    setTimeout(() => el.classList.remove('is-acted'), 1600);
  }

  return { render, onEvent, highlight, machineElement: (key) => machineEls.get(key) ?? null };
}
