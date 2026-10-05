// Dragging with pointer events (DESIGN §12): mouse, pen and touch alike, never HTML5 drag and
// drop (which does not work on touch). A press waits for a small move before a drag starts, so a
// short press without moving stays a click (on the element pressed: the pointer is captured only
// once the drag starts) and a touch can still scroll the page. While dragging the element keeps
// the pointer (pointer capture), the page scrolls by itself near the top and bottom of the
// window, and Escape, the window losing focus or the browser taking the gesture over cancels it.
// Also the one overlay every drag draws on: a ghost under the pointer and a rubber-band line.

import { h } from '/shared/api.js';
import { reducedMotion } from './util.js';

const MOVE_MOUSE = 5; // px the pointer moves before a press becomes a drag
const MOVE_TOUCH = 10; // a finger wobbles more
const EDGE = 56; // px from the top or bottom of the window where the page scrolls by itself
const EDGE_SPEED = 18; // px per frame at the very edge

let layer = null;

/**
 * The drag overlay (fixed over the window, decorative: the page says what happens in words):
 * `ghost` follows the pointer, `band` is the rubber-band line (an SVG path in window coordinates).
 * @returns {{ el: HTMLElement, ghost: HTMLElement, band: SVGPathElement, plug: SVGRectElement }}
 */
export function dragLayer() {
  if (layer) return layer;
  const el = h('div', { class: 'drag-layer', 'aria-hidden': 'true', hidden: true });
  const ghost = h('div', { class: 'drag-ghost', hidden: true });
  // static markup only; the path and the plug are moved by setAttribute
  const svg = h('div', {
    class: 'drag-band',
    html: '<svg width="100%" height="100%" focusable="false"><path class="drag-band__line" d=""/><rect class="drag-band__plug" width="14" height="10" rx="2.5"/></svg>',
  });
  el.append(svg, ghost);
  document.body.append(el);
  layer = { el, ghost, band: svg.querySelector('path'), plug: svg.querySelector('rect'), svg };
  return layer;
}

/** Where the page shows from the top of the window: below the header and the device bar while they stick there. */
export function viewTop() {
  let top = 0;
  for (const id of ['lab-header', 'build']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    // a sticky bar covers the page only while it is stuck at its place
    if (r.top <= (parseFloat(cs.top) || 0) + 1) top = Math.max(top, r.bottom);
  }
  return top;
}

/**
 * Make an element draggable, or (with `selector`) every element matching it inside `el`, even
 * ones added later: a press on one of them starts it, and `point.target` says which.
 * @param {HTMLElement} el  what the person presses, or the container of what they press
 * @param {object} handlers
 * @param {(ev: PointerEvent, target: HTMLElement) => boolean} [handlers.canStart]  may this press become a drag?
 * @param {(point: {x:number,y:number,type:string,target:HTMLElement}) => object|null} handlers.start  begin: a session object, or null (no drag)
 * @param {(session: object, point: object) => void} handlers.move  the pointer moved (or the page scrolled under it)
 * @param {(session: object, point: object) => void} handlers.drop  let go
 * @param {(session: object, why: 'escape'|'lost') => void} handlers.cancel  Escape, or the gesture was taken away
 * @param {{ selector?: string }} [options]
 * @returns {{ cancel(): void, get active(): boolean }}
 */
export function draggable(el, { canStart, start, move, drop, cancel }, { selector = null } = {}) {
  let pending = null; // { id, x, y, type, target } between the press and the drag
  let session = null; // the running drag
  let last = null; // the last pointer position
  let frame = 0;
  let armed = false; // the page scrolls by itself only once the pointer has been away from the edges
  let swallowClick = false;

  // the click that ends a drag is not a click on the element
  el.addEventListener(
    'click',
    (ev) => {
      if (!swallowClick) return;
      swallowClick = false;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    },
    true,
  );
  // nor is a click while dragging (Enter or Space on the pressed button would open its dialog mid-drag)
  function onDragClick(ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }

  const point = (ev) => ({ x: ev.clientX, y: ev.clientY, type: ev.pointerType || 'mouse' });

  function release(id) {
    try {
      if (id !== undefined && el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
    } catch {
      // the pointer is already gone
    }
  }

  function end() {
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onDragClick, true);
    window.removeEventListener('blur', onAway);
    document.removeEventListener('visibilitychange', onAway);
    document.documentElement.classList.remove('is-dragging');
    session = null;
    unwatch();
  }

  // A press that is not a drag yet is followed on the window: its click must still go to what
  // was pressed, which capturing the pointer this early would change (to the capturing element).
  function watch() {
    window.addEventListener('pointermove', onPendingMove, true);
    window.addEventListener('pointerup', onPendingEnd, true);
    window.addEventListener('pointercancel', onPendingEnd, true);
    // a context menu or another window takes the press: its button-up never comes here
    window.addEventListener('contextmenu', unwatch, true);
    window.addEventListener('blur', unwatch);
  }
  function unwatch() {
    pending = null;
    window.removeEventListener('pointermove', onPendingMove, true);
    window.removeEventListener('pointerup', onPendingEnd, true);
    window.removeEventListener('pointercancel', onPendingEnd, true);
    window.removeEventListener('contextmenu', unwatch, true);
    window.removeEventListener('blur', unwatch);
  }
  function onPendingEnd(ev) {
    // a short press without moving: the click that follows does what a click does
    if (pending && ev.pointerId === pending.id) unwatch();
  }
  function onPendingMove(ev) {
    if (!pending || ev.pointerId !== pending.id) return;
    // no button down any more (its button-up went elsewhere): the press is over, no drag
    if (ev.buttons === 0) {
      unwatch();
      return;
    }
    const p = point(ev);
    const far = Math.hypot(p.x - pending.x, p.y - pending.y) >= (p.type === 'touch' ? MOVE_TOUCH : MOVE_MOUSE);
    if (!far) return;
    const { id, x, y, target } = pending;
    unwatch();
    const begun = start({ ...p, startX: x, startY: y, target });
    if (!begun) return;
    session = begun;
    session.pointerId = id;
    try {
      el.setPointerCapture(id);
    } catch {
      // the pointer is already gone: the drag ends with the events that still come
    }
    last = p;
    armed = false;
    document.documentElement.classList.add('is-dragging');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onDragClick, true);
    // the window loses focus (Cmd+Tab, another tab): the drag is called off, not left hanging
    window.addEventListener('blur', onAway);
    document.addEventListener('visibilitychange', onAway);
    move(session, p);
    frame = requestAnimationFrame(edgeScroll);
  }

  function onAway() {
    if (!session || (document.visibilityState === 'visible' && document.hasFocus())) return;
    stop();
  }

  /** Call the running drag off: the gesture was taken away. */
  function stop() {
    const s = session;
    const id = s.pointerId;
    end();
    release(id);
    cancel(s, 'lost');
  }

  function onKey(ev) {
    if (ev.key !== 'Escape' || !session) return;
    ev.preventDefault();
    ev.stopPropagation();
    const s = session;
    const id = s.pointerId;
    end();
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 400);
    release(id);
    cancel(s, 'escape');
  }

  /**
   * Near the top or bottom of the window the page scrolls, and what is under the pointer changes.
   * Not while the pointer is still near where it started (the device bar sits at the top edge).
   */
  function edgeScroll() {
    frame = 0;
    if (!session || !last) return;
    const top = viewTop();
    const bottom = window.innerHeight;
    if (!armed && last.y > top + EDGE && last.y < bottom - EDGE) armed = true;
    let dy = 0;
    if (armed && last.y < top + EDGE) dy = -Math.ceil(EDGE_SPEED * Math.min(1, (top + EDGE - last.y) / EDGE));
    else if (armed && last.y > bottom - EDGE) dy = Math.ceil(EDGE_SPEED * Math.min(1, (last.y - (bottom - EDGE)) / EDGE));
    if (dy !== 0) {
      const before = window.scrollY;
      window.scrollBy({ top: reducedMotion.matches ? Math.sign(dy) * Math.min(Math.abs(dy), 8) : dy, behavior: 'instant' });
      if (window.scrollY !== before) move(session, last);
    }
    frame = requestAnimationFrame(edgeScroll);
  }

  el.addEventListener('pointerdown', (ev) => {
    if (session || pending) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const target = selector ? ev.target.closest?.(selector) : el;
    if (!target || !el.contains(target)) return;
    if (target.disabled || (canStart && !canStart(ev, target))) return;
    pending = { id: ev.pointerId, ...point(ev), target };
    watch();
  });

  el.addEventListener('pointermove', (ev) => {
    if (!session || ev.pointerId !== session.pointerId) return;
    // the button came up where this page did not see it: nothing is held any more
    if (ev.buttons === 0) {
      stop();
      return;
    }
    last = point(ev);
    ev.preventDefault();
    move(session, last);
  });

  el.addEventListener('pointerup', (ev) => {
    if (!session || ev.pointerId !== session.pointerId) return;
    const s = session;
    const p = point(ev);
    end();
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 400);
    release(ev.pointerId);
    drop(s, p);
  });

  const lost = (ev) => {
    if (!session || ev.pointerId !== session.pointerId) return;
    const s = session;
    end();
    cancel(s, 'lost');
  };
  el.addEventListener('pointercancel', lost);
  el.addEventListener('lostpointercapture', (ev) => {
    // only this element's own capture: a touched child loses its implicit capture to it when the
    // drag starts (and capture also ends after pointerup, when the drag has already ended)
    if (ev.target === el && session && ev.pointerId === session.pointerId) lost(ev);
  });

  return {
    /** Stop a running drag from outside (the page is reset, the element goes away). */
    cancel() {
      if (session) stop();
    },
    get active() {
      return Boolean(session);
    },
  };
}
