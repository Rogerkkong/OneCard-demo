// Machines: the school's canteen readers, water machines and top-up kiosk — whether each is
// switched on and online, which price list, settings and block list it holds, registering a new
// one (its secret is shown once), and the device log of refused or odd messages.

import { h, formatKL } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, openDialog, pill, secretBox, has } from './kit.js';

const DEVICE_CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,30}[A-Z0-9])?$/;
const STATUS_TONES = { ACTIVE: 'good', DISABLED: 'bad', MAINTENANCE: 'warn' };
const LEVEL_TONES = { INFO: 'info', WARN: 'warn', ERROR: 'bad' };
export const KINDS = ['prices', 'settings', 'blocklist'];

export const devicePill = (t, status) => pill(t(`devStatus.${status}`), STATUS_TONES[status] ?? '');
export const onlinePill = (t, online) => pill(t(online ? 'mac.online' : 'mac.offline'), online ? 'good' : '');

/** One cell of the versions table: what the machine holds, and whether that is the newest. */
function versionCell(t, s) {
  if (!s) return '—';
  const held = s.appliedVersion > 0 ? `v${s.appliedVersion}` : t('mac.verNone');
  return h(
    'div',
    { class: 'ver' },
    h('span', { class: 'ver__line' }, h('strong', { class: 'num' }, held), ' ', s.behind ? pill(t('mac.behind', { v: s.currentVersion }), 'warn') : pill(t('mac.upToDate'), 'good')),
    s.via ? h('span', { class: 'muted small' }, `${t(`stateVia.${s.via}`)} · ${formatKL(s.updatedAt)}`) : null,
  );
}

/**
 * Which version of each kind every machine holds (from GET /api/admin/devices/states).
 * @param {string[]} [kinds]  the columns to show (default all three)
 */
export function versionsTable(ctx, states, kinds = KINDS, devices = []) {
  const { t } = ctx;
  const byDevice = new Map();
  for (const s of states) {
    if (!byDevice.has(s.deviceCode)) byDevice.set(s.deviceCode, {});
    byDevice.get(s.deviceCode)[s.kind] = s;
  }
  const info = new Map(devices.map((d) => [d.code, d]));
  const codes = [...byDevice.keys()].sort();
  return dataTable({
    label: t('mac.versions'),
    head: [t('mac.machine'), ...kinds.map((k) => t(`kind.${k}`))],
    empty: t('mac.empty'),
    rows: codes.map((code) => {
      const d = info.get(code);
      return [
        h('span', { class: 'who' }, h('strong', { class: 'mono' }, code), d ? h('span', { class: 'muted small' }, [t(`devType.${d.type}`), ' · ', t(d.online ? 'mac.online' : 'mac.offline')]) : null),
        ...kinds.map((k) => versionCell(t, byDevice.get(code)[k])),
      ];
    }),
  });
}

export async function renderMachines(ctx, el) {
  const { t, api } = ctx;
  el.append(
    sectionHead({
      title: t('nav.machines'),
      text: t('mac.lede'),
      actions: [
        h('button', { type: 'button', class: 'btn btn--primary', onclick: () => register() }, t('mac.register')),
        h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh')),
      ],
    }),
  );
  const listBox = h('div', {}, h('p', { class: 'muted' }, t('kit.loading')));
  const versionsBox = h('div');
  const logSelect = h('select', { id: 'log-device' }, h('option', { value: '' }, t('mac.logAll')));
  const logBox = h('div');
  logSelect.addEventListener('change', () => loadLog());
  el.append(
    panel(t('mac.list'), listBox),
    panel(t('mac.versions'), h('p', { class: 'muted small' }, t('mac.versionsText')), versionsBox),
    panel(
      t('mac.log'),
      h('p', { class: 'muted small' }, t('mac.logText')),
      h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'log-device' }, t('mac.logFilter')), logSelect)),
      logBox,
    ),
  );

  let devices = [];
  let loaded = false;

  async function changeStatus(d) {
    const out = await openDialog({
      t,
      title: t('mac.statusTitle', { code: d.code }),
      body: [h('p', {}, t('mac.statusBody')), h('p', { class: 'muted small' }, t('mac.statusNow', { status: t(`devStatus.${d.status}`) }))],
      fields: [
        {
          name: 'status',
          label: t('mac.statusLabel'),
          type: 'select',
          value: d.status,
          options: ['ACTIVE', 'MAINTENANCE', 'DISABLED'].map((s) => ({ value: s, label: t(`devStatusLong.${s}`) })),
        },
      ],
      confirmLabel: t('mac.statusConfirm'),
      action: (v) => api.post(`/api/admin/devices/${encodeURIComponent(d.code)}/status`, { status: v.status }),
    });
    if (!out) return;
    let text;
    if (out.status === 'ACTIVE') text = t(out.published ? 'mac.statusOn' : 'mac.statusOnNotSent', { code: out.code });
    else text = t('mac.statusOff', { code: out.code, status: t(`devStatus.${out.status}`), n: out.kicked ?? 0 });
    ctx.flash(h('strong', {}, text), out.status === 'ACTIVE' && out.published ? 'good' : 'info');
    load();
  }

  async function register() {
    const out = await openDialog({
      t,
      title: t('mac.registerTitle'),
      body: h('p', {}, t('mac.registerBody')),
      fields: [
        {
          name: 'code',
          label: t('mac.code'),
          required: true,
          mono: true,
          maxLength: 32,
          placeholder: 'CANTEEN-03',
          hint: t('mac.codeHint'),
          validate: (v) => (DEVICE_CODE_RE.test(v.toUpperCase()) ? (devices.some((d) => d.code === v.toUpperCase()) ? t('err.DEVICE_CODE_TAKEN') : null) : t('mac.codeInvalid')),
        },
        {
          name: 'type',
          label: t('mac.type'),
          type: 'select',
          value: 'CANTEEN',
          options: ['CANTEEN', 'WATER', 'KIOSK'].map((x) => ({ value: x, label: t(`devType.${x}`) })),
        },
        { name: 'location', label: t('mac.location'), maxLength: 80, placeholder: t('mac.locationHint') },
      ],
      confirmLabel: t('mac.registerConfirm'),
      action: (v) => api.post('/api/admin/devices', { code: v.code.toUpperCase(), type: v.type, location: v.location }),
    });
    if (!out) return;
    ctx.flash(
      h(
        'div',
        { class: 'stack' },
        h('p', {}, h('strong', {}, t('mac.registered', { code: out.device.code, type: t(`devType.${out.device.type}`) }))),
        secretBox(t, { code: out.device.code, secret: out.secret }),
        h('p', { class: 'muted small' }, t(out.published ? 'mac.registeredSent' : 'mac.registeredNotSent')),
      ),
      'warn',
    );
    load();
  }

  function drawList() {
    const head = [t('mac.machine'), t('mac.location'), t('mac.switched'), t('mac.connection'), t('mac.heartbeat'), t('mac.software'), t('mac.change')];
    listBox.replaceChildren(
      dataTable({
        label: t('mac.list'),
        head,
        empty: t('mac.empty'),
        rows: devices.map((d) => [
          h('span', { class: 'who' }, h('strong', { class: 'mono' }, d.code), h('span', { class: 'muted small' }, t(`devType.${d.type}`))),
          d.location || '—',
          devicePill(t, d.status),
          onlinePill(t, d.online),
          d.lastHeartbeatAt ? formatKL(d.lastHeartbeatAt) : t('kit.never'),
          d.fwVersion ? h('span', { class: 'who' }, h('span', { class: 'mono small' }, d.fwVersion), d.health ? h('span', { class: 'muted small' }, d.health) : null) : '—',
          h('button', { type: 'button', class: 'btn btn--small', onclick: () => changeStatus(d) }, t('mac.changeButton')),
        ]),
      }),
    );
    const keep = logSelect.value;
    logSelect.replaceChildren(h('option', { value: '' }, t('mac.logAll')), ...devices.map((d) => h('option', { value: d.code, selected: d.code === keep }, d.code)));
  }

  async function loadLog() {
    const code = logSelect.value;
    let entries;
    try {
      entries = await api.get(`/api/admin/device-log?limit=100${code ? `&device=${encodeURIComponent(code)}` : ''}`);
    } catch (err) {
      if (ctx.alive() && !logBox.querySelector('table')) logBox.replaceChildren(loadProblem(t, err, loadLog));
      return;
    }
    if (!ctx.alive()) return;
    logBox.replaceChildren(
      dataTable({
        label: t('mac.log'),
        head: [t('mac.logAt'), t('mac.machine'), t('mac.logLevel'), t('mac.logWhat')],
        empty: t('mac.logEmpty'),
        rows: entries.map((e) => [
          formatKL(e.at),
          h('span', { class: 'mono' }, e.deviceCode ?? '—'),
          pill(t(`level.${e.level}`), LEVEL_TONES[e.level] ?? ''),
          h(
            'span',
            { class: 'who' },
            h('span', {}, has(t, `log.${e.code}`) ? t(`log.${e.code}`) : e.message),
            h('span', { class: 'muted small' }, h('code', {}, e.code), e.detail?.type ? ` · ${e.detail.type}` : ''),
          ),
        ]),
      }),
    );
  }

  async function load() {
    let states;
    try {
      [devices, states] = await Promise.all([api.get('/api/admin/devices'), api.get('/api/admin/devices/states')]);
    } catch (err) {
      if (ctx.alive() && !loaded) listBox.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    loaded = true;
    drawList();
    versionsBox.replaceChildren(versionsTable(ctx, states, KINDS, devices));
    await loadLog();
  }

  ctx.poll(10000, load);
  await load();
}
