// Cables you draw (DESIGN §12), like Packet Tracer's connections: press a machine's cable end
// and drag it. A pulled-out cable's dangling end dropped on its school's network line plugs it
// in; a plugged cable's end dragged off the line and let go pulls it out. While dragging, a
// rubber-band line follows the pointer from the machine and the school's network line lights up
// (more strongly while the end is over it, where it snaps on). While the lab does it, the cable
// shows the change it is waiting for; if the lab refuses, it snaps back and a toast says why.
// The Plug/Pull buttons stay the keyboard's way (topology.js).

import { toast } from '/shared/api.js';
import { draggable, dragLayer } from './drag.js';
import { setText } from './util.js';

const NEAR_MOUSE = 14; // px from the line that still counts as on it
const NEAR_TOUCH = 24; // a finger covers more

/** The point of segment s nearest to p. */
function closest(p, s) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = dx * dx + dy * dy;
  const k = len ? Math.max(0, Math.min(1, ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len)) : 0;
  return { x: s.x1 + k * dx, y: s.y1 + k * dy };
}

/**
 * @param {object} app  the page: t, state, call()
 * @param {{ sitesEl: HTMLElement, topology: { setCable(key: string, plugged: boolean): Promise<boolean> }, live: HTMLElement }} deps
 *   live: a polite live region for what a drag does
 */
export function createCables(app, { sitesEl, topology, live }) {
  const { t } = app;
  const pending = new Set(); // machines whose cable change the lab is doing now

  const machineOf = (key) => {
    const i = key.indexOf('/');
    const school = app.state?.schools?.find((s) => s.code === key.slice(0, i));
    return school?.devices.find((d) => d.code === key.slice(i + 1)) ?? null;
  };

  /** Where the school network line is now, in window coordinates: its segments and the router. */
  function lineOf(net, site) {
    const n = net.getBoundingClientRect();
    const cs = getComputedStyle(net);
    const rail = parseFloat(cs.borderLeftWidth) || 2;
    const bus = parseFloat(cs.getPropertyValue('--bus')) || 34;
    const gap = parseFloat(cs.getPropertyValue('--gap')) || 14;
    const segs = [{ x1: n.left + rail / 2, y1: n.top, x2: n.left + rail / 2, y2: n.bottom }];
    for (const m of net.querySelectorAll(':scope > .machine')) {
      // the line over each row of machines (each machine draws its part of it)
      const r = m.getBoundingClientRect();
      const y = r.top - bus + 2;
      segs.push({ x1: r.left - gap - 1, y1: y, x2: r.right + 1, y2: y });
    }
    const gwEl = site.querySelector('.site__gwicon') ?? site.querySelector('.site__gw');
    return { segs, gw: gwEl?.getBoundingClientRect() ?? null };
  }

  /** The point of the line nearest to p and how far it is (the router counts as the line too). */
  function nearest(p, line) {
    let best = null;
    for (const s of line.segs) {
      const q = closest(p, s);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (!best || d < best.d) best = { x: q.x, y: q.y, d };
    }
    const g = line.gw;
    if (g && p.x >= g.left - 4 && p.x <= g.right + 4 && p.y >= g.top - 4 && p.y <= g.bottom + 4) {
      best = { x: g.left + g.width / 2, y: g.top + g.height / 2, d: 0 };
    }
    return best;
  }

  /** Where the cable leaves the machine (the rubber band starts there). */
  function baseOf(el) {
    const cable = el.querySelector('.machine__cable');
    const m = el.getBoundingClientRect();
    const c = cable?.getBoundingClientRect();
    return { x: c ? c.left + c.width / 2 : m.left + 30, y: m.top };
  }

  function say(text) {
    setText(live, '');
    // a new text is announced even when it repeats the last one
    requestAnimationFrame(() => setText(live, text));
  }

  // ---- drawing ----------------------------------------------------------------------------------

  function draw(s, p) {
    const layer = dragLayer();
    const base = baseOf(s.el);
    const end = s.snap ?? p;
    // a cable hangs a little: a soft curve, never a straight stick
    const sag = Math.min(60, Math.hypot(end.x - base.x, end.y - base.y) / 4);
    const mx = (base.x + end.x) / 2;
    const my = Math.max(base.y, end.y) + sag * 0.35;
    layer.band.setAttribute('d', `M ${base.x.toFixed(1)} ${base.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`);
    layer.plug.setAttribute('x', (end.x - 7).toFixed(1));
    layer.plug.setAttribute('y', (end.y - 5).toFixed(1));
    layer.svg.classList.toggle('is-on', Boolean(s.snap));
  }

  function clear(s) {
    const layer = dragLayer();
    layer.el.hidden = true;
    layer.svg.hidden = true;
    layer.svg.classList.remove('is-on');
    s.el.classList.remove('is-cable-dragging');
    s.net.classList.remove('is-cable-target', 'is-cable-over');
  }

  // ---- the gesture ------------------------------------------------------------------------------

  draggable(
    sitesEl,
    {
      canStart: (ev, handle) => !pending.has(handle.dataset.machine ?? ''),
      start(p) {
        const key = p.target.dataset.machine;
        const el = p.target.closest('.machine');
        const net = el?.closest('.site__net');
        const site = el?.closest('.site');
        const m = key ? machineOf(key) : null;
        if (!el || !net || !site || !m || m.installed === false) return null;
        const layer = dragLayer();
        layer.el.hidden = false;
        layer.svg.hidden = false;
        layer.ghost.hidden = true;
        el.classList.add('is-cable-dragging');
        net.classList.add('is-cable-target');
        say(t(m.cablePlugged ? 'cable.live.pull' : 'cable.live.plug', { code: m.code }));
        return { key, el, net, site, code: m.code, plugged: Boolean(m.cablePlugged), near: p.type === 'touch' ? NEAR_TOUCH : NEAR_MOUSE, snap: null };
      },
      move(s, p) {
        if (!s.el.isConnected) return;
        const hit = nearest(p, lineOf(s.net, s.site));
        s.snap = hit && hit.d <= s.near ? hit : null;
        s.net.classList.toggle('is-cable-over', Boolean(s.snap));
        draw(s, p);
      },
      async drop(s) {
        clear(s);
        if (!s.el.isConnected) return;
        const plug = !s.plugged && Boolean(s.snap);
        const pull = s.plugged && !s.snap;
        if (!plug && !pull) {
          // let go where nothing changes: the cable goes back as it was
          if (!s.plugged) toast(t('cable.missed', { code: s.code }), 'info');
          say(t('cable.live.same', { code: s.code }));
          return;
        }
        pending.add(s.key);
        // the cable shows the change the lab is making; the state refresh after it draws it for real
        s.el.dataset.pending = plug ? 'plug' : 'pull';
        try {
          const done = await topology.setCable(s.key, plug);
          if (!done) say(t('cable.live.failed', { code: s.code }));
        } finally {
          pending.delete(s.key);
          delete s.el.dataset.pending;
          app.refresh(0);
        }
      },
      cancel(s, why) {
        clear(s);
        if (why === 'escape') say(t('cable.live.cancelled', { code: s.code }));
      },
    },
    { selector: '.machine__end' },
  );

  // a click on the cable end (no drag) says how it works
  sitesEl.addEventListener('click', (ev) => {
    const handle = ev.target.closest?.('.machine__end');
    if (!handle || pending.has(handle.dataset.machine ?? '')) return;
    const m = machineOf(handle.dataset.machine ?? '');
    if (m) toast(t(m.cablePlugged ? 'cable.hintPull' : 'cable.hintPlug', { code: m.code }), 'info');
  });

  return {
    /** Is the lab changing this machine's cable now ('<school>/<DEVICE>')? */
    busy: (key) => pending.has(key),
  };
}
