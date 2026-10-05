// The Simulation envelope on the topology (DESIGN §11.6). The current step's message travels
// from its from-node to its to-node along the lines the topology already draws: card ↔
// machine, machine → its cable → the school network → the internet line → the cloud server,
// and inside the cloud between the broker, the platform and the database, in the colour of the
// step's layer. A refusal shows a red ✗ where the message stopped; a held item parks at its hold
// point with a pause badge (every item that waits gets a small marker there). It is decorative
// (aria-hidden): the Simulation tab's event list says the same in words. With reduced motion
// nothing travels: the from- and to-nodes are outlined instead.

import { h } from '/shared/api.js';
import { reducedMotion } from './util.js';
import { sameNode } from './sim-steps.js';
import { viewTop } from './drag.js';

const wide = window.matchMedia('(min-width: 1024px)');
const ENV_W = 28;
const ENV_H = 22;
const USER_SCROLL_QUIET_MS = 3000; // after the person scrolled, the page leaves the scrolling to them
const SVG = (inner, w, hgt) =>
  `<svg viewBox="0 0 ${w} ${hgt}" width="${w}" height="${hgt}" focusable="false" aria-hidden="true">${inner}</svg>`;
const ENVELOPE = SVG('<rect class="sim-env__paper" x="1.5" y="1.5" width="25" height="19" rx="3"/><path class="sim-env__flap" d="M2.5 3.5 14 12.5 25.5 3.5"/>', 28, 22);
const PAUSE = SVG('<rect x="3" y="2.5" width="2.6" height="7" rx="0.8"/><rect x="6.4" y="2.5" width="2.6" height="7" rx="0.8"/>', 12, 12);
const CROSS = SVG('<path d="M5 5l8 8M13 5l-8 8"/>', 18, 18);

/**
 * @param {object} app  the page (app.t)
 * @param {{ topologyEl: HTMLElement, topology: { machineEl(key: string): HTMLElement|undefined, partEl(name: string): HTMLElement|undefined }, onOpen?: () => void }} deps
 */
export function createSimAnim(app, { topologyEl, topology, onOpen }) {
  const layer = h('div', { class: 'sim-layer', 'aria-hidden': 'true', hidden: true });
  const parks = h('div', { class: 'sim-parks' });
  const drop = h('div', { class: 'sim-drop', hidden: true });
  drop.innerHTML = CROSS; // static markup
  const env = h('div', { class: 'sim-env', hidden: true, title: app.t('sim.env.title') });
  env.innerHTML = ENVELOPE; // static markup
  const badge = h('span', { class: 'sim-env__badge', hidden: true });
  badge.innerHTML = PAUSE; // static markup
  env.append(badge);
  layer.append(parks, drop, env);
  topologyEl.append(layer);
  env.addEventListener('click', () => onOpen?.());

  let active = false;
  let shown = null; // { step, at: node where the envelope rests, drop: node|null }
  let restAt = null; // where the envelope is now (a node)
  let motion = null; // the running Animation
  let dropTimer = null;
  let held = [];
  let lit = []; // [element, class] outlined for the current step
  let programmaticUntil = 0;
  let userScrolledAt = -Infinity;

  // ---- where things are --------------------------------------------------------------------

  const base = () => topologyEl.getBoundingClientRect();
  const siteOf = (school) => (school ? document.getElementById(`site-${school}`) : null);

  function nodeEl(n) {
    if (!n) return null;
    switch (n.kind) {
      case 'machine':
        return topology.machineEl(`${n.school}/${n.device}`) ?? siteOf(n.school);
      case 'card': {
        const site = siteOf(n.school);
        if (!site) return null;
        const items = [...site.querySelectorAll('.tray__cards > li')];
        // the card itself (a copy has a tray key of its own), else one ending in those 4 characters
        const found =
          (n.uid ? items.find((li) => li.dataset.key === n.uid) : null) ??
          (n.last4 ? items.find((li) => String(li.dataset.key ?? '').toUpperCase().endsWith(String(n.last4).toUpperCase())) : null);
        return found ?? site.querySelector('.tray');
      }
      case 'admincard':
        return siteOf(n.school)?.querySelector('.admincard__visual') ?? siteOf(n.school);
      case 'net':
        return siteOf(n.school)?.querySelector('.site__gw') ?? siteOf(n.school);
      case 'internet':
        return topologyEl.querySelector('.internet');
      case 'broker':
      case 'platform':
      case 'db':
        return topology.partEl(n.kind) ?? topologyEl.querySelector('.cloud');
      default:
        return null;
    }
  }

  /** A rectangle relative to the topology section. */
  function box(el, b = base()) {
    const r = el.getBoundingClientRect();
    return { left: r.left - b.left, top: r.top - b.top, right: r.right - b.left, bottom: r.bottom - b.top, width: r.width, height: r.height };
  }
  const mid = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  /**
   * Where the envelope sits at a node: on its top-right corner, like a badge, so it never hides
   * a machine's screen or a label. The internet line and the school network are points on a line.
   */
  function pointOf(n, b = base()) {
    const el = nodeEl(n);
    if (!el || !el.isConnected) return null;
    if (n.kind === 'internet') {
      const site = siteOf(n.school);
      const trunk = trunkX(b);
      return site ? { x: trunk, y: box(site, b).top + 31.5 } : { x: trunk, y: box(el, b).top + 40 };
    }
    if (n.kind === 'net') {
      const icon = el.querySelector('.site__gwicon');
      return mid(box(icon ?? el, b));
    }
    const r = box(el, b);
    // a small target (a card, the admin card) carries it on its top edge
    return { x: r.right - Math.min(10, r.width / 4), y: r.top + Math.min(4, r.height / 4) };
  }

  function trunkX(b = base()) {
    const internet = topologyEl.querySelector('.internet');
    return internet ? box(internet, b).left + 1.5 : 31.5;
  }

  /**
   * The way up from a node of a school's site to the cloud server's door, following the lines
   * the topology draws (null for a node inside the cloud).
   */
  function chainUp(n, b) {
    if (!n || !['machine', 'net', 'internet'].includes(n.kind)) return null;
    const site = siteOf(n.school);
    const internet = topologyEl.querySelector('.internet');
    const cloud = topologyEl.querySelector('.cloud');
    if (!site || !internet || !cloud) return null;
    const s = box(site, b);
    const branchY = s.top + 31.5;
    const trunk = trunkX(b);
    const top = box(internet, b).top;
    const door = { x: trunk, y: Math.min(top, box(cloud, b).bottom) - 6 };
    const upper = [{ x: trunk, y: branchY }, { x: trunk, y: top }, door];
    if (n.kind === 'internet') return upper;
    const gwEl = site.querySelector('.site__gwicon') ?? site.querySelector('.site__gw');
    const gw = gwEl ? mid(box(gwEl, b)) : { x: s.left + 24, y: s.top + 60 };
    const fromGw = [gw, { x: gw.x, y: branchY }, ...upper];
    if (n.kind === 'net') return fromGw;
    const m = nodeEl(n);
    if (!m || !m.classList.contains('machine')) return fromGw;
    const inside = pointOf(n, b);
    const cable = m.querySelector('.machine__cable');
    const net = m.closest('.site__net');
    if (!cable || !net) return [inside, ...fromGw];
    const c = box(cable, b);
    const railX = box(net, b).left + 1;
    const cableX = c.left + 1.5;
    return [inside, { x: cableX, y: c.bottom }, { x: cableX, y: c.top }, { x: railX, y: c.top }, { x: railX, y: gw.y }, ...fromGw];
  }

  /** The waypoints from one node to another (a straight line where no cable joins them). */
  function route(a, b) {
    const bx = base();
    const pa = pointOf(a, bx);
    const pb = pointOf(b, bx);
    if (!pa || !pb) return pb ? [pb] : pa ? [pa] : [];
    if (a.kind === 'card' || b.kind === 'card' || a.kind === 'admincard' || b.kind === 'admincard') return clean([pa, pb]);
    const ua = chainUp(a, bx);
    const ub = chainUp(b, bx);
    if (!ua && !ub) return clean([pa, pb]);
    if (ua && !ub) return clean([...ua, pb]);
    if (!ua && ub) return clean([pa, ...ub.reverse()]);
    // both on the sites' side: up to where their ways meet, then down
    const key = (p) => `${Math.round(p.x)}:${Math.round(p.y)}`;
    const onB = new Map(ub.map((p, i) => [key(p), i]));
    const meet = ua.findIndex((p) => onB.has(key(p)));
    if (meet >= 0) return clean([...ua.slice(0, meet + 1), ...ub.slice(0, onB.get(key(ua[meet]))).reverse()]);
    return clean([...ua, ...ub.reverse()]);
  }

  function clean(points) {
    const out = [];
    for (const p of points) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const last = out[out.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) out.push(p);
    }
    return out;
  }

  const lengthOf = (pts) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
  const place = (el, p, w, hgt) => {
    el.style.transform = `translate(${Math.round(p.x - w / 2)}px, ${Math.round(p.y - hgt / 2)}px)`;
  };

  // ---- the page scrolls to the envelope, gently --------------------------------------------

  window.addEventListener(
    'scroll',
    () => {
      if (performance.now() > programmaticUntil) userScrolledAt = performance.now();
    },
    { passive: true },
  );
  for (const type of ['wheel', 'touchmove']) {
    window.addEventListener(type, () => (userScrolledAt = performance.now()), { passive: true });
  }

  /**
   * Bring a hop into view: both its ends when they fit on the screen together, else where it
   * arrives; as little scrolling as that takes. Not while the person scrolls the page themselves,
   * and never on a narrow screen, where the tabs sit under the map (unless they ask: force).
   */
  function reveal(nodes, { force = false } = {}) {
    const b = base();
    const points = nodes.filter(Boolean).map((n) => pointOf(n, b)).filter(Boolean);
    if (!points.length) return;
    if (!force) {
      if (!wide.matches || performance.now() - userScrolledAt < USER_SCROLL_QUIET_MS) return;
      if (document.querySelector('dialog[open]')) return;
    }
    // below the sticky header and device bar
    const top = viewTop() + 24;
    const bottom = window.innerHeight - 24;
    const ys = points.map((p) => b.top + p.y);
    const end = ys[ys.length - 1];
    let lo = Math.min(...ys) - 48;
    let hi = Math.max(...ys) + 48;
    if (hi - lo > bottom - top) {
      lo = end - 80;
      hi = end + 80;
    }
    let delta = 0;
    if (force) delta = (lo + hi) / 2 - (top + bottom) / 2;
    else if (lo < top) delta = lo - top;
    else if (hi > bottom) delta = hi - bottom;
    if (Math.abs(delta) < 4) return;
    programmaticUntil = performance.now() + 1200;
    window.scrollBy({ top: delta, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  // ---- outlines ------------------------------------------------------------------------------

  function unlight() {
    for (const [el, cls] of lit) el.classList.remove(cls, 'sim-lit');
    lit = [];
  }

  function light(n, cls, layerName) {
    const el = nodeEl(n);
    if (!el) return;
    el.classList.add(cls, 'sim-lit');
    el.dataset.simLayer = layerName;
    lit.push([el, cls]);
  }

  // ---- the current step -------------------------------------------------------------------------

  function stopMotion() {
    if (motion) {
      motion.cancel();
      motion = null;
    }
    clearTimeout(dropTimer);
  }

  /**
   * Show a step: the envelope travels from its from-node to its to-node (or to where it was
   * dropped). @returns {number} how long it takes (ms), so playback can wait for it
   */
  function show(step, { speed = 1, animate = true, reveal: scroll = true } = {}) {
    stopMotion();
    unlight();
    drop.hidden = true;
    shown = null;
    if (!active || !step) {
      env.hidden = true;
      restAt = null;
      return 0;
    }
    const target = step.drop && !sameNode(step.drop, step.to) ? step.drop : step.to ?? step.from;
    if (!target) {
      env.hidden = true;
      restAt = null;
      return 0;
    }
    env.dataset.layer = step.layer;
    env.dataset.verdict = step.verdict;
    badge.hidden = !step.parked;
    env.classList.toggle('is-parked', Boolean(step.parked));
    env.title = step.title;
    shown = { step, at: target, drop: step.drop ?? null };
    renderParks();

    const travels = step.from && !sameNode(step.from, target);
    // a step that names where it comes from but sends nothing (a broker login ending) does not travel
    const still = reducedMotion.matches || !animate || step.still === true;
    light(target, 'sim-at', step.layer);
    if (still && travels) light(step.from, 'sim-from', step.layer);
    if (scroll) reveal(travels ? [step.from, target] : [target]);

    const end = pointOf(target);
    if (!end) {
      env.hidden = true;
      restAt = null;
      return 0;
    }
    const finish = () => {
      motion = null;
      place(env, end, ENV_W, ENV_H);
      restAt = target;
      if (shown?.drop) showDrop(shown.drop);
    };
    env.hidden = false;
    if (still || !travels) {
      // nothing travels: the envelope appears where the step happens (a short fade in when it moves)
      const moved = !restAt || !sameNode(restAt, target);
      place(env, end, ENV_W, ENV_H);
      if (moved && !still) {
        motion = env.animate([{ opacity: 0, transform: env.style.transform + ' scale(0.6)' }, { opacity: 1, transform: env.style.transform }], {
          duration: 180 / speed,
          easing: 'ease-out',
        });
        motion.onfinish = finish;
      } else finish();
      return still ? 0 : Math.round(200 / speed);
    }
    const points = route(step.from, target);
    if (points.length < 2) {
      finish();
      return 0;
    }
    const total = lengthOf(points);
    const duration = Math.round(Math.min(1600, Math.max(480, 300 + total * 0.7)) / speed);
    let walked = 0;
    const frames = points.map((p, i) => {
      if (i > 0) walked += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
      return { transform: `translate(${Math.round(p.x - ENV_W / 2)}px, ${Math.round(p.y - ENV_H / 2)}px)`, offset: total ? walked / total : i / (points.length - 1) };
    });
    frames[frames.length - 1].offset = 1;
    // a message that starts somewhere else than where the envelope was: it fades in there first
    const fresh = !restAt || !sameNode(restAt, step.from);
    for (const [i, f] of frames.entries()) f.opacity = fresh && i === 0 ? 0.2 : 1;
    // the resting place is set first, so nothing flickers back when the animation ends
    place(env, end, ENV_W, ENV_H);
    motion = env.animate(frames, { duration, easing: 'ease-in-out' });
    motion.onfinish = finish;
    return duration;
  }

  function showDrop(n) {
    const p = pointOf(n);
    if (!p) return;
    place(drop, { x: p.x + ENV_W / 2, y: p.y - ENV_H / 2 }, 18, 18);
    drop.hidden = false;
  }

  // ---- items waiting at a hop -------------------------------------------------------------------

  function renderParks() {
    const groups = new Map();
    // the item the current step parks shows on the envelope itself
    const onEnvelope = shown?.step?.parked ? shown.step.heldId : null;
    for (const item of held) {
      if (item.id === onEnvelope) continue;
      const n = item.where === 'platform' ? { kind: 'platform' } : { kind: 'machine', school: item.school, device: item.device };
      const key = n.kind === 'platform' ? 'platform' : `${n.school}/${n.device}`;
      const g = groups.get(key) ?? { n, count: 0 };
      g.count += 1;
      groups.set(key, g);
    }
    const b = base();
    const keep = new Set();
    for (const [key, g] of groups) {
      keep.add(key);
      let el = parks.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (!el) {
        el = h('span', { class: 'sim-park', dataset: { key } });
        el.innerHTML = PAUSE; // static markup
        el.append(h('span', { class: 'sim-park__n' }));
        parks.append(el);
      }
      el.lastChild.textContent = g.count > 1 ? String(g.count) : '';
      const target = nodeEl(g.n);
      if (!target) {
        el.hidden = true;
        continue;
      }
      // a machine's on its top edge, left of the envelope's corner; a cloud part's at its foot
      const r = box(target, b);
      el.hidden = false;
      const at = g.n.kind === 'machine' ? { x: r.left + 40, y: r.top - 9 } : { x: r.right - 26, y: r.bottom - 9 };
      el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    }
    for (const el of [...parks.children]) if (!keep.has(el.dataset.key)) el.remove();
  }

  // ---- the page changed -------------------------------------------------------------------------

  /** Put everything back where it belongs after the topology was drawn again (or resized). */
  function relayout() {
    if (!active) return;
    renderParks();
    if (motion || !shown) return;
    const p = pointOf(shown.at);
    if (p) place(env, p, ENV_W, ENV_H);
    else env.hidden = true;
    if (shown.drop && !drop.hidden) showDrop(shown.drop);
    // the outlined elements may have been replaced (a reset rebuilds the topology)
    if (lit.some(([el]) => !el.isConnected)) {
      const { step } = shown;
      unlight();
      light(shown.at, 'sim-at', step.layer);
    }
  }

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 60);
  }).observe(topologyEl);

  return {
    show,
    relayout,
    /** Show or hide the whole layer (it shows while the Simulation tab or mode is in use). */
    setActive(on) {
      active = Boolean(on);
      layer.hidden = !active;
      if (!active) {
        stopMotion();
        unlight();
        env.hidden = true;
        drop.hidden = true;
        restAt = null;
        shown = null;
      } else renderParks();
    },
    /** The items waiting at a hop, oldest first (DESIGN §11.4). */
    setHeld(items) {
      held = Array.isArray(items) ? items : [];
      if (active) renderParks();
    },
    /** Scroll a node into view now (the person asked for it). */
    reveal: (n) => reveal([n], { force: true }),
    relang() {
      env.title = shown?.step?.title ?? app.t('sim.env.title');
    },
  };
}
