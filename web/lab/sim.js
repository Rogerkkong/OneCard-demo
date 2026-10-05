// The Simulation tab (DESIGN §11.6): Packet Tracer's Simulation mode for OneCard. Every lab
// action and product request is a trace (a flow); this tab replays one hop by hop: a trace
// picker (newest first, followed by itself), playback (first, back, play/pause, forward, last,
// speed), Packet Tracer's event list (# · time · last device · at device · type · what
// happened) with layer filters, the packet details of the current step, and the envelope on the
// topology (sim-anim.js). Live stepping: the header's Realtime | Simulation switch, "Hold at
// each hop", the items waiting at a hop, Next hop and Release all.
// Data: GET /api/lab/sim (mode, hold, held, traces), GET /api/lab/sim/traces/:id (a flow's
// events), the live event stream (every event carries its trace), POST /api/lab/sim{,/next,/release}.

import { get, h, toast } from '/shared/api.js';
import { callName, errorText, heldText, messageName } from './describe.js';
import { createSimAnim } from './sim-anim.js';
import { renderDetails } from './sim-details.js';
import { LAYERS, buildSteps, heldSubject, heldWhere, nodeName, preciseTime, sameNode, traceLabel, traceTitle } from './sim-steps.js';
import { hhmm, prefs, reconcile, reducedMotion, setAttr, setHidden, setText, setTone } from './util.js';

const MAX_ROWS = 200; // rows in the list at once; "show earlier" and "show later" add more
const MAX_EVENTS = 1500; // events kept for the chosen flow (the lab keeps 500 per trace)
const MAX_TRACES = 200; // the lab keeps the most recent 200
const LIST_LIMIT = 50; // flows asked for at once (GET /api/lab/sim?limit=)
const SPEEDS = [0.5, 1, 2];
const DWELL_MS = 600; // how long a step stays before the next one plays, at 1×
const TRACE_LIST_STALE_MS = 15_000;
// following a live flow that runs this many steps ahead (a burst: the server back on, the clock
// moved): the cursor jumps to a few steps before its newest instead of playing each one
const CATCH_UP_AFTER = 12;
const CATCH_UP_TO = 4;
const USER_SCROLL_QUIET_MS = 3000; // after the person scrolled the list, it is theirs for a while
const narrow = window.matchMedia('(max-width: 1023px)');

/**
 * @param {object} app  the page: t, i18n, call(), fail(), state
 * @param {{ root: HTMLElement, modeSwitch: HTMLElement, topologyEl: HTMLElement, topology: object, showTab: (name: string) => void }} deps
 */
export function createSim(app, { root, modeSwitch, topologyEl, topology, showTab }) {
  const { t } = app;
  const q = (sel) => root.querySelector(sel);
  const el = {
    title: q('#sim-title'),
    modePill: q('.sim__modepill'),
    intro: q('.sim__intro'),
    traceLabel: q('.sim__tracelabel'),
    traceSelect: q('#sim-trace'),
    follow: q('#sim-follow'),
    followText: q('.sim__followtext'),
    traceTitle: q('.sim__tracetitle'),
    holdTitle: q('#sim-hold-title'),
    hold: q('#sim-hold'),
    holdLabel: q('.switch__label'),
    holdHint: q('.sim__holdhint'),
    next: q('[data-role="sim-next"]'),
    release: q('[data-role="sim-release"]'),
    notice: q('.sim__notice'),
    waitingBox: q('.sim__waitingbox'),
    waitingTitle: q('.sim__waitingtitle'),
    waiting: q('.sim__waiting'),
    playLabel: q('#sim-play-label'),
    playButtons: [...root.querySelectorAll('[data-play]')],
    playBtn: q('[data-play="play"]'),
    speedLabel: q('.sim__speedlabel'),
    speed: q('#sim-speed'),
    stepOf: q('.sim__stepof'),
    filters: q('.sim__filters'),
    filtersTitle: q('.sim__filterstitle'),
    filtersState: q('.sim__filtersstate'),
    layersLabel: q('#sim-layers-label'),
    layers: q('.sim__layers'),
    beats: q('#sim-beats'),
    beatsText: q('.sim__beatstext'),
    head: q('.sim__head'),
    earlier: q('.sim__earlier'),
    later: q('.sim__later'),
    list: q('#sim-list'),
    listLabel: q('#sim-list-label'),
    empty: q('.sim__empty'),
    emptyText: q('.sim__emptytext'),
    showAll: q('.sim__showall'),
    live: q('#sim-live'),
    details: q('#sim-details'),
    detailsTitle: q('#sim-details-title'),
    detailsMap: q('[data-role="sim-map"]'),
    detailsClose: q('[data-role="sim-close"]'),
    sections: q('.sim__sections'),
  };

  const savedLayers = [].concat(prefs.get('sim.layers', LAYERS)).filter((l) => LAYERS.includes(l));
  const s = {
    mode: 'realtime',
    hold: false,
    held: [], // waiting items, oldest first
    released: new Set(), // ids let go (a state fetched before that must not bring them back)
    heldSeenAt: new Map(), // id -> when its sim.held event arrived (performance.now())
    traces: [], // summaries, newest first
    tracesAt: 0,
    traceId: null,
    followTrace: prefs.get('sim.follow', true) !== false,
    events: [],
    seqs: new Set(),
    steps: [],
    visible: [],
    loading: false,
    gone: false,
    cursor: null, // seq of the current step
    running: false, // the cursor moves on by itself (play, or keeping up with a live flow)
    replay: false, // the person pressed play: every step plays, none is skipped
    startAt: null, // a held item's id: the chosen flow starts where that item was let go
    quiet: false, // the flow being fetched was chosen by the page itself: no scrolling to it
    speed: SPEEDS.includes(Number(prefs.get('sim.speed', 1))) ? Number(prefs.get('sim.speed', 1)) : 1,
    layers: new Set(savedLayers.length ? savedLayers : LAYERS),
    beats: prefs.get('sim.heartbeats', false) === true,
    // the rows drawn, [windowFrom, windowTo) of the visible steps, when the person asked for more
    // ("show earlier", "show later"); null: at most MAX_ROWS, the newest, or around the cursor
    windowFrom: null,
    windowTo: null,
    lastEventAt: 0, // when the chosen flow last got a step from the event stream (performance.now())
    detailsOpen: false,
    tabShown: false,
    busy: false,
    serverUp: true, // the cloud server (what waits at the platform goes on only while it is on)
  };

  let timer = null; // the next automatic step
  let atEnd = false; // the timer only checks whether a followed flow has finished
  let flushTimer = null; // a burst of new events is drawn once
  let loadToken = 0;

  const anim = createSimAnim(app, { topologyEl, topology, onOpen: () => openDetails({ scroll: true, focus: false, showTab: true }) });

  // ---- small helpers ----------------------------------------------------------------------------

  const currentTrace = () => s.traces.find((x) => x.id === s.traceId) ?? null;
  /** A school's name, from the lab's state (a flow names a school by its code). */
  const schoolName = (code) => app.state?.schools?.find((x) => x.code === code)?.name ?? null;
  /** The chosen flow's summary when the list does not have it (yet): from its sim.trace event. */
  function chosenSummary() {
    const e = s.events.find((x) => x.type === 'sim.trace');
    const d = e?.data ?? {};
    return { id: s.traceId, n: d.n ?? '?', kind: d.kind ?? '', title: d.title ?? '', subject: d.subject ?? {}, school: e?.school ?? null, device: d.device ?? null, at: e ? Date.parse(e.at) : NaN };
  }
  const stepAt = (seq) => s.steps.find((x) => x.seq === seq) ?? null;
  const visibleIndex = (seq) => s.visible.findIndex((x) => x.seq === seq);
  const isRealtime = () => s.mode !== 'simulation';
  /** What waits, in words, with the tip that fits the server's state now. */
  const heldWords = (item) => heldText(item, t, { serverUp: s.serverUp });
  const dwell = () => (reducedMotion.matches ? 1100 : DWELL_MS) / s.speed;

  // routine heartbeats only (flows of many machines, sim-steps.js): a machine's own flow shows its heartbeat
  const showBeats = () => s.beats;

  function isVisible(step) {
    if (!s.layers.has(step.layer)) return false;
    if (step.heartbeat && !showBeats()) return false;
    return true;
  }

  // ---- the chosen flow: its steps --------------------------------------------------------------

  function rebuild() {
    const trace = currentTrace() ?? (s.traceId ? chosenSummary() : null);
    s.steps = buildSteps(s.events, { t, lang: app.i18n.lang, trace, names: schoolName, isHeld: (id) => s.held.some((x) => x.id === id) });
    s.visible = s.steps.filter(isVisible);
    // the current step may be filtered out: keep the nearest visible one before it
    if (s.cursor !== null && visibleIndex(s.cursor) < 0) {
      const all = s.steps.findIndex((x) => x.seq === s.cursor);
      const before = s.visible.filter((x) => s.steps.indexOf(x) <= all);
      s.cursor = before.length ? before[before.length - 1].seq : (s.visible[0]?.seq ?? null);
    }
  }

  function addEvents(list) {
    let added = 0;
    for (const e of list) {
      if (!e || typeof e.seq !== 'number' || s.seqs.has(e.seq)) continue;
      s.seqs.add(e.seq);
      s.events.push(e);
      added += 1;
    }
    if (added) {
      s.events.sort((a, b) => a.seq - b.seq);
      // like the lab: keep what started the flow and its most recent steps
      while (s.events.length > MAX_EVENTS) s.seqs.delete(s.events.splice(1, 1)[0].seq);
    }
    return added;
  }

  /**
   * Show a flow. live: keep up with its steps as they come; first: its sim.trace event (a flow
   * that just started); toEnd: start at its newest step; at: a held item's id, start where it
   * was let go (and keep up from there); quiet: the page chose it by itself (it opened, the
   * demo was reset), so the page does not scroll to its first step.
   */
  async function choose(id, { live = false, first = null, toEnd = false, at = null, quiet = false } = {}) {
    stopTimer();
    s.traceId = id;
    s.events = [];
    s.seqs = new Set();
    s.steps = [];
    s.visible = [];
    s.cursor = null;
    s.gone = false;
    s.windowFrom = null;
    s.windowTo = null;
    s.running = live;
    s.replay = false;
    s.startAt = at;
    s.quiet = quiet;
    s.lastEventAt = live ? performance.now() : 0;
    if (first) addEvents([first]);
    rebuild();
    render();
    // the previous flow's envelope goes at once (this flow's shows when its first step does)
    anim.show(null);
    if (!id) return;
    if (!first) await load(id, { toEnd });
    else kick();
  }

  /** Nothing is chosen, or the chosen flow is gone: a flow that starts or waits is the one to show. */
  const wantsNewest = () => s.followTrace || !s.traceId || s.gone;

  async function load(id, { toEnd = false } = {}) {
    const token = ++loadToken;
    s.loading = true;
    renderList();
    try {
      const res = await get(`/api/lab/sim/traces/${encodeURIComponent(id)}`);
      if (token !== loadToken || s.traceId !== id) return;
      if (res?.trace) upsertTrace(res.trace);
      addEvents(Array.isArray(res?.events) ? res.events : []);
      s.loading = false;
      rebuild();
      const start = s.startAt ? releaseStep(s.startAt) : null;
      const reveal = !s.quiet;
      s.startAt = null;
      s.quiet = false;
      if (s.cursor === null && start) {
        // where the item was let go; what follows plays (or, with nothing new, stays)
        s.cursor = start.seq;
        showCurrent({ animate: false });
      } else if (s.cursor === null && s.visible.length) {
        if (toEnd) {
          s.cursor = s.visible[s.visible.length - 1].seq;
          // at the newest step of a flow that still goes on (something of it waits): keep up with it
          if (!isFinished()) s.running = true;
          showCurrent({ animate: false, reveal });
        } else if (!s.running) {
          s.cursor = s.visible[0].seq;
          showCurrent({ animate: reveal, reveal });
        }
      }
      render();
      kick();
    } catch (err) {
      if (token !== loadToken || s.traceId !== id) return;
      s.loading = false;
      if (err?.code === 'TRACE_NOT_FOUND') {
        forgetFlow();
        render();
        if (s.followTrace) refresh({ choose: true });
        return;
      }
      if (err?.code !== 'NETWORK') toast(errorText(err, t), 'bad');
      render();
    }
  }

  /** The lab no longer keeps the chosen flow (newer flows, a reset, a restart): what was shown of it goes too. */
  function forgetFlow() {
    stopTimer();
    s.gone = true;
    s.traces = s.traces.filter((x) => x.id !== s.traceId);
    s.events = [];
    s.seqs = new Set();
    s.cursor = null;
    s.running = false;
    s.replay = false;
    rebuild();
    anim.show(null);
  }

  /** The step where a held item was let go (else where it waited), or the next visible one. */
  function releaseStep(heldId) {
    const held = (type) => s.steps.findIndex((x) => x.e.type === type && x.e.data?.id === heldId);
    let i = held('sim.released');
    if (i < 0) i = held('sim.held');
    return i < 0 ? null : (s.steps.slice(i).find(isVisible) ?? null);
  }

  // ---- traces (the picker) --------------------------------------------------------------------

  function upsertTrace(summary) {
    if (!summary?.id) return;
    const i = s.traces.findIndex((x) => x.id === summary.id);
    if (i >= 0) s.traces[i] = { ...s.traces[i], ...summary };
    else {
      s.traces.push(summary);
      s.traces.sort((a, b) => b.n - a.n || b.at - a.at);
      if (s.traces.length > MAX_TRACES) s.traces.length = MAX_TRACES;
    }
  }

  /** GET /api/lab/sim: the mode, what waits, and the newest flows (pick: show the newest, quietly). */
  async function refresh({ choose: pick = false } = {}) {
    try {
      const requestedAt = performance.now();
      const res = await get(`/api/lab/sim?limit=${LIST_LIMIT}`);
      applySim(res, requestedAt);
      const fresh = Array.isArray(res.traces) ? res.traces : [];
      // fewer flows than asked for: these are all the lab keeps
      const complete = fresh.length < LIST_LIMIT;
      const known = new Map(fresh.map((x) => [x.id, x]));
      for (const x of s.traces) {
        if (known.has(x.id)) continue;
        // a flow the event stream announced after this list was asked for stays; so does the chosen
        // flow when the list stops before it (anything else is gone: a reset, a restart of the lab)
        if ((x.seenAt ?? 0) > requestedAt || (x.id === s.traceId && !complete)) known.set(x.id, x);
      }
      s.traces = [...known.values()].sort((a, b) => b.n - a.n || b.at - a.at).slice(0, MAX_TRACES);
      s.tracesAt = performance.now();
      if (s.traceId && complete && !s.gone && !s.traces.some((x) => x.id === s.traceId)) forgetFlow();
      if (pick || !s.traceId || (s.gone && s.followTrace)) {
        const newest = s.traces[0]?.id ?? null;
        // a flow that waits at a hop (the page was reloaded meanwhile): show where it waits
        const waits = s.held.find((x) => x.trace === newest) ?? null;
        if (newest !== s.traceId || s.gone) await choose(newest, { toEnd: Boolean(waits), quiet: true });
        else render();
        if (waits) setNotice(heldWords(waits), 'warn', waits.id);
      } else render();
    } catch (err) {
      if (err?.code !== 'NETWORK') toast(errorText(err, t), 'bad');
    }
  }

  // ---- what waits at a hop -----------------------------------------------------------------------

  function setHeld(list) {
    s.held = list;
    anim.setHeld(s.held);
    // a notice about what waits is out of date once that item (or everything) went on
    const about = el.notice.dataset.item;
    if (el.notice.classList.contains('sim__notice--warn') && (!list.length || (about && !list.some((x) => x.id === about)))) setNotice('');
    renderHold();
    // open details say whether their item still waits: draw them again
    if (s.detailsOpen) flushSoon();
  }

  function addHeld(item) {
    if (!item?.id || s.released.has(item.id) || s.held.some((x) => x.id === item.id)) return;
    s.heldSeenAt.set(item.id, performance.now());
    setHeld([...s.held, item]);
  }

  function dropHeld(id) {
    if (!id) return;
    s.released.add(id);
    if (s.released.size > 2000) s.released.delete(s.released.values().next().value);
    s.heldSeenAt.delete(id);
    if (s.held.some((x) => x.id === id)) setHeld(s.held.filter((x) => x.id !== id));
  }

  /** The lab's sim state (GET /api/lab/state's sim, or an answer of POST /api/lab/sim). */
  function applySim(sim, requestedAt = 0) {
    if (!sim) return;
    const modeChanged = sim.mode !== s.mode;
    if (sim.mode === 'realtime' || sim.mode === 'simulation') s.mode = sim.mode;
    if (typeof sim.hold === 'boolean') s.hold = sim.hold;
    if (Array.isArray(sim.held)) {
      const fromLab = sim.held.filter((x) => x?.id && !s.released.has(x.id));
      const ids = new Set(fromLab.map((x) => x.id));
      // an item announced after this state was asked for is still waiting
      const newer = s.held.filter((x) => !ids.has(x.id) && (s.heldSeenAt.get(x.id) ?? 0) > requestedAt && requestedAt > 0);
      setHeld([...fromLab, ...newer]);
    }
    if (modeChanged) {
      renderMode();
      updateActive();
    }
  }

  // ---- playback ------------------------------------------------------------------------------

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
    atEnd = false;
  }

  function schedule(ms) {
    stopTimer();
    timer = setTimeout(tick, Math.max(0, ms));
  }

  /** One automatic step forward (play, or keeping up with a live flow). */
  function tick() {
    timer = null;
    atEnd = false;
    if (!s.running) return;
    const i = s.cursor === null ? -1 : visibleIndex(s.cursor);
    const next = s.visible[i + 1];
    if (!next) {
      // at the end: a live flow carries on when its next steps come (kick); a finished one stops
      if (isFinished()) {
        s.running = false;
        s.replay = false;
      } else {
        atEnd = true;
        timer = setTimeout(tick, 2600);
      }
      renderPlayback();
      return;
    }
    if (!active()) {
      // nothing to watch: keep up at once, without the animation
      s.cursor = s.visible[s.visible.length - 1].seq;
      renderCursor();
      return;
    }
    if (!s.replay && s.visible.length - 1 - i > CATCH_UP_AFTER) {
      // a burst of steps in a live flow: catch up with its newest, then play on
      s.cursor = s.visible[s.visible.length - CATCH_UP_TO].seq;
      showCurrent({ animate: false });
      renderCursor();
      schedule(dwell());
      return;
    }
    s.cursor = next.seq;
    const ms = showCurrent({ animate: true });
    renderCursor();
    schedule(ms + dwell());
  }

  /** New steps arrived, or play was pressed: move on unless already scheduled. */
  function kick() {
    // a flow being fetched starts where load() puts it
    if (s.loading || !s.running || (timer && !atEnd)) return;
    schedule(s.cursor === null ? 0 : 60);
  }

  /** Show the current step on the topology. reveal: scroll the page to it if needed (wide screens). */
  function showCurrent({ animate = true, reveal = true } = {}) {
    const step = stepAt(s.cursor);
    if (!step) {
      anim.show(null);
      return 0;
    }
    // a message let go at the platform is checked where it waited: nothing travels again
    const i = s.steps.indexOf(step);
    const prev = i > 0 ? s.steps[i - 1] : null;
    const stays = prev && (prev.e.type === 'sim.released' || prev.parked) && step.to && sameNode(prev.to, step.to);
    const shown = stays ? { ...step, from: null } : step;
    return anim.show(shown, { speed: s.speed, animate, reveal });
  }

  /** Go to a step because the person asked (a click, a key, a playback button). */
  function goTo(seq, { announce = true } = {}) {
    if (seq === null || seq === undefined) return;
    stopTimer();
    s.cursor = seq;
    s.replay = false;
    // stepping to the newest step keeps up with the flow again; stepping back stops there
    s.running = visibleIndex(seq) === s.visible.length - 1 && s.visible.length > 0 && !isFinished();
    showCurrent({ animate: true });
    renderCursor({ user: true });
    if (announce && document.activeElement !== el.list) {
      const step = stepAt(seq);
      setText(el.live, step ? t('sim.announce', { n: step.n, m: s.steps.length, what: step.title }) : '');
    }
  }

  /** The flow looks finished: nothing of it waits at a hop, and nothing new came for a while. */
  function isFinished() {
    if (!s.steps.length) return false;
    if (s.held.some((x) => x.trace === s.traceId)) return false;
    return performance.now() - s.lastEventAt > 2500;
  }

  function step(delta) {
    if (!s.visible.length) return;
    const i = s.cursor === null ? -1 : visibleIndex(s.cursor);
    const next = s.visible[Math.max(0, Math.min(s.visible.length - 1, i + delta))];
    if (next && next.seq !== s.cursor) goTo(next.seq);
  }

  function play() {
    if (s.running) {
      s.running = false;
      s.replay = false;
      stopTimer();
      renderPlayback();
      return;
    }
    if (!s.visible.length) return;
    // at the end, play starts the flow again
    if (s.cursor === null || visibleIndex(s.cursor) >= s.visible.length - 1) {
      s.cursor = null;
      s.windowFrom = null;
      s.windowTo = null;
    }
    s.running = true;
    s.replay = true;
    renderPlayback();
    schedule(0);
  }

  // ---- rendering ---------------------------------------------------------------------------------

  function render() {
    renderMode();
    renderTraces();
    renderHold();
    renderFilters();
    renderList();
    renderPlayback();
    renderDetailsPanel();
  }

  function renderMode() {
    for (const b of modeSwitch.querySelectorAll('[data-mode]')) {
      setAttr(b, 'aria-pressed', String(b.dataset.mode === s.mode));
      setText(b, t(b.dataset.mode === 'simulation' ? 'sim.mode.simulation' : 'sim.mode.realtime'));
    }
    setText(modeSwitch.querySelector('.mode-switch__label'), t('sim.mode.label'));
    modeSwitch.classList.toggle('is-sim', s.mode === 'simulation');
    setText(el.modePill, t(isRealtime() ? 'sim.pill.realtime' : 'sim.pill.simulation'));
    setTone(el.modePill, 'pill--', isRealtime() ? '' : 'info');
    setText(el.intro, t(isRealtime() ? 'sim.intro.realtime' : 'sim.intro.simulation'));
  }

  function renderTraces() {
    setText(el.title, t('sim.title'));
    setText(el.traceLabel, t('sim.trace.label'));
    setText(el.followText, t('sim.follow'));
    el.follow.checked = s.followTrace;
    const list = [...s.traces];
    if (s.traceId && !list.some((x) => x.id === s.traceId) && !s.gone) list.push(chosenSummary());
    const shown = s.traceId && !s.gone && list.some((x) => x.id === s.traceId);
    const options = list.map((x) => [x.id, traceLabel(x, t, hhmm, { names: schoolName })]);
    // the picker never names another flow than the one shown: with none shown, it asks for one
    if (!options.length) options.push(['', t('sim.trace.none')]);
    else if (!shown) options.unshift(['', t('sim.trace.pick')]);
    const sig = JSON.stringify(options);
    if (el.traceSelect.dataset.sig !== sig) {
      el.traceSelect.replaceChildren(...options.map(([value, text]) => h('option', { value, disabled: value === '' && list.length > 0 }, text)));
      el.traceSelect.dataset.sig = sig;
    }
    el.traceSelect.value = shown ? s.traceId : '';
    el.traceSelect.disabled = !list.length;
    const tr = currentTrace() ?? (shown ? chosenSummary() : null);
    let line = '';
    if (s.gone) line = t('sim.trace.gone');
    else if (tr) line = t('sim.trace.line', { title: traceTitle(tr, t, { names: schoolName }), n: s.steps.length });
    setText(el.traceTitle, line);
    el.traceTitle.classList.toggle('is-gone', s.gone);
  }

  /**
   * The line under the hold switch: what hold does; while something waits the notice and the list
   * say what to do, unless nothing can go on (only the platform's inbox waits and the server is
   * off): then it says why Next hop is greyed, when the notice does not say so already.
   */
  function renderHint() {
    const n = s.held.length;
    const stuck = n > 0 && s.held.every((x) => x.where === 'platform') && !s.serverUp;
    const said = !el.notice.hidden && el.notice.classList.contains('sim__notice--warn') && s.held.some((x) => x.id === el.notice.dataset.item && x.where === 'platform');
    const show = stuck && !said;
    setText(el.holdHint, t(show ? 'sim.next.stuck' : s.hold ? 'sim.hold.on' : isRealtime() ? 'sim.hold.offRealtime' : 'sim.hold.off'));
    el.holdHint.classList.toggle('is-stuck', show);
    setHidden(el.holdHint, n > 0 && !show);
  }

  function renderHold() {
    setText(el.holdTitle, t('sim.hold.title'));
    setText(el.holdLabel, t('sim.hold'));
    setAttr(el.hold, 'aria-checked', String(s.hold));
    el.hold.classList.toggle('is-on', s.hold);
    el.hold.disabled = s.busy;
    const n = s.held.length;
    // what waits at the platform goes on only while the cloud server is on
    const releasable = s.held.filter((x) => x.where !== 'platform' || s.serverUp).length;
    renderHint();
    if (!el.next.hasAttribute('aria-busy')) setText(el.next, n ? t('sim.next.count', { n }) : t('sim.next'));
    el.next.disabled = releasable === 0 || s.busy;
    if (!el.release.hasAttribute('aria-busy')) setText(el.release, t('sim.release'));
    el.release.disabled = releasable === 0 || s.busy;
    // nothing to let go and nothing will wait: the buttons give their room to the steps
    setHidden(el.next.parentElement, n === 0 && !s.hold);
    setText(el.waitingTitle, t('sim.waiting.title', { n }));
    setHidden(el.waitingBox, n === 0);
    root.classList.toggle('has-waiting', n > 0);
    const traceN = (id) => s.traces.find((x) => x.id === id)?.n ?? '?';
    reconcile(
      el.waiting,
      s.held,
      (x) => x.id,
      (item) => {
        const b = h('button', { type: 'button', class: 'wait__btn' });
        b.addEventListener('click', () => openHeld(item));
        return h('li', { class: 'wait' }, b);
      },
      (li, item) => {
        const b = li.firstElementChild;
        li.classList.toggle('is-platform', item.where === 'platform');
        li.classList.toggle('is-current', item.trace === s.traceId);
        const where = heldWhere(item, t);
        const machine = item.school && item.device ? `${item.school}/${item.device}` : '—';
        const what = heldSubject(item);
        const parts = [where, machine, what, t('sim.flowN', { n: traceN(item.trace) })];
        if (b.dataset.sig !== parts.join('|')) {
          b.replaceChildren(
            h('span', { class: 'wait__where' }, where),
            h('span', { class: 'wait__machine mono' }, machine),
            h('span', { class: 'wait__what mono' }, what),
            h('span', { class: 'wait__flow num' }, parts[3]),
          );
          b.dataset.sig = parts.join('|');
        }
        const label = t('sim.waiting.item', { where, machine, what, flow: parts[3] });
        setAttr(b, 'aria-label', label);
        setAttr(b, 'title', label);
      },
    );
  }

  function renderFilters() {
    setText(el.filtersTitle, t('sim.filters'));
    setText(el.layersLabel, t('sim.layers'));
    if (!el.layers.dataset.built) {
      for (const layer of LAYERS) {
        const b = h('button', { type: 'button', class: `chip chip--layer`, dataset: { layer }, 'aria-pressed': 'true' }, h('span', { class: 'chip__dot', 'aria-hidden': 'true' }), h('span', { class: 'chip__text' }));
        b.addEventListener('click', () => {
          if (s.layers.has(layer)) s.layers.delete(layer);
          else s.layers.add(layer);
          prefs.set('sim.layers', [...s.layers]);
          refilter();
        });
        el.layers.append(b);
      }
      el.layers.dataset.built = '1';
    }
    for (const b of el.layers.querySelectorAll('[data-layer]')) {
      setAttr(b, 'aria-pressed', String(s.layers.has(b.dataset.layer)));
      setText(b.lastChild, t(`sim.layer.${b.dataset.layer}`));
    }
    el.beats.checked = s.beats;
    setText(el.beatsText, t('sim.heartbeats'));
    const off = LAYERS.filter((l) => !s.layers.has(l)).map((l) => t(`sim.layer.${l}`));
    const state = off.length === 0 ? t('sim.filters.all') : t('sim.filters.hidden', { list: off.join(t('list.sep')) });
    setText(el.filtersState, `${state}${t('list.sep')}${t(s.beats ? 'sim.filters.beatsOn' : 'sim.filters.beatsOff')}`);
    for (const span of el.head.querySelectorAll('[data-key]')) setText(span, t(span.dataset.key));
  }

  function refilter() {
    s.visible = s.steps.filter(isVisible);
    if (s.cursor !== null && visibleIndex(s.cursor) < 0) rebuild();
    s.windowFrom = null;
    s.windowTo = null;
    renderFilters();
    renderList();
    renderPlayback();
  }

  function rowLabel(step) {
    const opts = { multiSchool: step.multiSchool };
    const travels = Boolean(step.from && step.to && !sameNode(step.from, step.to));
    const last = travels ? nodeName(step.from, t, opts) : '—';
    const at = nodeName(step.to ?? step.from, t, opts);
    return { last, at, travels };
  }

  function createRow(step) {
    const li = h('li', { role: 'option', class: 'step', id: `sim-step-${step.seq}`, 'aria-selected': 'false' });
    li._r = {
      n: h('span', { class: 'step__n num' }),
      time: h('span', { class: 'step__time num' }),
      last: h('span', { class: 'step__last' }),
      at: h('span', { class: 'step__at' }),
      type: h('span', { class: 'step__type' }),
      what: h('span', { class: 'step__what' }),
    };
    const r = li._r;
    li.append(r.n, r.time, r.last, r.at, r.type, r.what);
    li.addEventListener('click', () => {
      goTo(Number(li.dataset.key), { announce: false });
      openDetails({ scroll: narrow.matches, focus: false });
    });
    return li;
  }

  function updateRow(li, step) {
    const r = li._r;
    li.className = `step step--${step.layer} step--${step.verdict}${step.seq === s.cursor ? ' is-current' : ''}`;
    setText(r.n, step.n);
    setText(r.time, preciseTime(step.e.at));
    const { last, at, travels } = rowLabel(step);
    setText(r.last, last);
    setText(r.at, at);
    if (r.type.dataset.type !== step.e.type) {
      const parts = String(step.e.type).split('.');
      r.type.replaceChildren(
        h('span', { class: 'step__dot', 'aria-hidden': 'true' }),
        h('span', {}, ...parts.flatMap((p, i) => (i < parts.length - 1 ? [`${p}.`, h('wbr')] : [p]))),
      );
      r.type.dataset.type = step.e.type;
    }
    setText(r.what, step.title);
    setAttr(li, 'aria-selected', String(step.seq === s.cursor));
    setAttr(li, 'aria-label', t(travels ? 'sim.row' : 'sim.rowAt', { n: step.n, time: preciseTime(step.e.at), last, at, type: step.e.type, what: step.title, verdict: t(`sim.verdict.${step.verdict}`) }));
  }

  /**
   * Which rows to draw (a long flow is never drawn whole): what the person asked for, else the
   * newest MAX_ROWS, else (the cursor is further back) MAX_ROWS from a little before the cursor.
   */
  function listWindow() {
    const n = s.visible.length;
    const ci = s.cursor === null ? -1 : visibleIndex(s.cursor);
    let from = s.windowFrom;
    let to = s.windowTo;
    if (from === null || to === null || (ci >= 0 && (ci < from || ci >= to))) {
      // the person's window no longer shows the cursor: back to the automatic one
      s.windowFrom = null;
      s.windowTo = null;
      to = n;
      from = Math.max(0, n - MAX_ROWS);
      if (ci >= 0 && ci < from) {
        from = Math.max(0, ci - 20);
        to = Math.min(n, from + MAX_ROWS);
      }
    }
    return { ci, from: Math.max(0, Math.min(from, n)), to: Math.min(to, n) };
  }

  function renderList() {
    setText(el.listLabel, t('sim.list.label'));
    const vis = s.visible;
    const { ci, from, to } = listWindow();
    const rows = vis.slice(from, to);
    reconcile(el.list, rows, (x) => String(x.seq), createRow, updateRow);
    setText(el.earlier, from > 0 ? t('sim.earlier', { n: Math.min(from, MAX_ROWS), total: from }) : '');
    setHidden(el.earlier, from === 0);
    el.earlier.dataset.from = String(from);
    el.earlier.dataset.to = String(to);
    const after = vis.length - to;
    setText(el.later, after > 0 ? t('sim.later', { n: Math.min(after, MAX_ROWS), total: after }) : '');
    setHidden(el.later, after <= 0);

    let empty = '';
    let showAll = false;
    if (s.loading && !s.events.length) empty = t('sim.empty.loading');
    else if (s.gone) empty = ''; // the line under the picker says so (once is enough)
    else if (!s.traceId) empty = t('sim.empty.none');
    else if (s.steps.length && !vis.length) {
      empty = s.steps.every((x) => x.heartbeat || !s.layers.has(x.layer)) && s.steps.some((x) => x.heartbeat) && !s.beats ? t('sim.empty.beats') : t('sim.empty.filtered');
      showAll = true;
    }
    setText(el.emptyText, empty);
    setText(el.showAll, t('sim.showAll'));
    setHidden(el.showAll, !showAll);
    setHidden(el.empty, !empty);
    setHidden(el.list, !rows.length);
    // no rows: the message takes their place, under no column titles
    setHidden(el.list.parentElement, !rows.length);
    setHidden(el.head, !rows.length);
    setAttr(el.list, 'aria-activedescendant', ci >= 0 ? `sim-step-${s.cursor}` : null);
    keepCurrentInView();
  }

  // The person scrolling the list themselves (wheel, touch, its scrollbar): for a while the list
  // is theirs (playback and new steps do not scroll it), until they move the cursor themselves.
  // A scroll event alone says nothing: the list also scrolls when it grows or shrinks.
  let listScrolledAt = -Infinity;
  const personScrolled = () => {
    listScrolledAt = performance.now();
  };
  el.list.addEventListener('wheel', personScrolled, { passive: true });
  el.list.addEventListener('touchmove', personScrolled, { passive: true });
  el.list.addEventListener('pointerdown', (ev) => {
    if (ev.target === el.list) personScrolled(); // its scrollbar
  });

  /**
   * Scroll the list (only the list, never the page) so the current row shows. user: the person
   * moved the cursor (always scrolls); otherwise not while they scroll the list themselves.
   */
  function keepCurrentInView({ user = false } = {}) {
    if (!user && performance.now() - listScrolledAt < USER_SCROLL_QUIET_MS) return;
    const row = s.cursor === null ? null : document.getElementById(`sim-step-${s.cursor}`);
    if (!row || el.list.hidden) return;
    const top = row.offsetParent === el.list ? row.offsetTop : row.offsetTop - el.list.offsetTop;
    const bottom = top + row.offsetHeight;
    const view = el.list.clientHeight;
    if (view <= 0) return;
    let to = null;
    if (top < el.list.scrollTop) to = Math.max(0, top - 8);
    else if (bottom > el.list.scrollTop + view) to = Math.min(top - 8, bottom - view + 8);
    if (to === null || Math.abs(to - el.list.scrollTop) < 1) return;
    el.list.scrollTop = to;
  }
  // the list grows or shrinks (the details open, something starts to wait): the current row stays in sight
  new ResizeObserver(() => keepCurrentInView()).observe(el.list);

  function renderCursor({ user = false } = {}) {
    for (const li of el.list.querySelectorAll('.step.is-current')) {
      if (li.dataset.key !== String(s.cursor)) {
        li.classList.remove('is-current');
        setAttr(li, 'aria-selected', 'false');
      }
    }
    if (s.cursor !== null && visibleIndex(s.cursor) >= 0 && !document.getElementById(`sim-step-${s.cursor}`)) renderList();
    const row = s.cursor === null ? null : document.getElementById(`sim-step-${s.cursor}`);
    if (row) {
      row.classList.add('is-current');
      setAttr(row, 'aria-selected', 'true');
    }
    setAttr(el.list, 'aria-activedescendant', row ? row.id : null);
    keepCurrentInView({ user });
    renderPlayback();
    renderDetailsPanel();
  }

  function renderPlayback() {
    setText(el.playLabel, t('sim.play.label'));
    const n = s.visible.length;
    const i = s.cursor === null ? -1 : visibleIndex(s.cursor);
    const labels = { first: t('sim.first'), back: t('sim.back'), fwd: t('sim.fwd'), last: t('sim.last') };
    for (const b of el.playButtons) {
      const what = b.dataset.play;
      if (what === 'play') continue;
      setText(b.lastChild, labels[what]);
      setAttr(b, 'title', labels[what]);
      b.disabled = n === 0 || ((what === 'first' || what === 'back') && i <= 0) || ((what === 'fwd' || what === 'last') && i >= n - 1);
    }
    const playing = s.running;
    setText(el.playBtn.lastChild, playing ? t('sim.pause') : t('sim.play'));
    setAttr(el.playBtn, 'title', playing ? t('sim.pause') : t('sim.play'));
    setAttr(el.playBtn, 'aria-pressed', String(playing));
    el.playBtn.disabled = n === 0;
    setText(el.speedLabel, t('sim.speed'));
    el.speed.value = String(s.speed);
    const step = stepAt(s.cursor);
    const hidden = s.steps.length - n;
    let text = step ? t('sim.stepOf', { n: step.n, m: s.steps.length }) : s.steps.length ? t('sim.stepNone', { m: s.steps.length }) : t('sim.noSteps');
    if (hidden > 0) text += ` · ${t('sim.hiddenCount', { n: hidden })}`;
    setText(el.stepOf, text);
  }

  // ---- packet details ------------------------------------------------------------------------

  function openDetails({ scroll = false, focus = false, showTab: open = false } = {}) {
    if (s.cursor === null && s.visible.length) s.cursor = s.visible[0].seq;
    if (s.cursor === null) return;
    if (open) showTab('sim');
    s.detailsOpen = true;
    renderDetailsPanel();
    if (scroll) el.details.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    if (focus) el.detailsTitle.focus({ preventScroll: !scroll });
  }

  function closeDetails() {
    const had = el.details.contains(document.activeElement);
    s.detailsOpen = false;
    renderDetailsPanel();
    if (had) el.list.focus();
  }

  function renderDetailsPanel() {
    const step = s.detailsOpen ? stepAt(s.cursor) : null;
    const was = el.details.hidden;
    setHidden(el.details, !step);
    root.classList.toggle('has-details', Boolean(step));
    // the list just got shorter (or taller): the current row stays in sight
    if (was !== el.details.hidden) keepCurrentInView();
    if (!step) {
      if (el.sections.dataset.seq) {
        el.sections.replaceChildren();
        delete el.sections.dataset.seq;
      }
      return;
    }
    setText(el.detailsTitle, t('pd.title', { n: step.n }));
    setText(el.detailsMap, t('pd.showOnMap'));
    setText(el.detailsClose, t('close'));
    el.detailsMap.hidden = !(step.to ?? step.from);
    const sig = `${step.seq}|${app.i18n.lang}|${s.steps.length}|${s.held.length}`;
    if (el.sections.dataset.seq === sig) return;
    const scrollTop = el.details.scrollTop;
    const same = el.sections.dataset.seq?.split('|')[0] === String(step.seq);
    renderDetails(el.sections, step, { t });
    el.sections.dataset.seq = sig;
    el.details.scrollTop = same ? scrollTop : 0;
  }

  // ---- the hold point items: what the person can do ----------------------------------------------

  let noticeTimer = null;
  /** What waits in the chosen flow, said once a burst of holds has settled (the oldest first). */
  function noticeSoon() {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      const first = s.held.find((x) => x.trace === s.traceId);
      if (first) setNotice(heldWords(first), 'warn', first.id);
    }, 120);
  }

  /** The live-stepping notice; `itemId`: the waiting item it is about (it goes when that item does). */
  function setNotice(text, tone = 'info', itemId = null) {
    setText(el.notice, text ?? '');
    setTone(el.notice, 'sim__notice--', tone);
    setHidden(el.notice, !text);
    if (itemId) el.notice.dataset.item = itemId;
    else delete el.notice.dataset.item;
    renderHint();
  }

  /** A waiting item was clicked: show its flow at the step where it waits. */
  function openHeld(item) {
    s.followTrace = s.followTrace && item.trace === s.traces[0]?.id;
    prefs.set('sim.follow', s.followTrace);
    if (s.traceId !== item.trace) {
      choose(item.trace, { toEnd: true });
    } else {
      const at = s.steps.find((x) => x.e.type === 'sim.held' && x.e.data?.id === item.id);
      if (at && isVisible(at)) goTo(at.seq);
    }
    setNotice(heldWords(item), 'warn', item.id);
  }

  async function next() {
    const res = await app.call('/api/lab/sim/next', {}, el.next, '');
    if (!res.ok) return app.fail(res.error);
    const { released, waiting } = res.data ?? {};
    if (released) {
      dropHeld(released.id);
      const rest = waiting > 0 ? t('sim.next.rest', { n: waiting }) : t('sim.next.none');
      setNotice(t('sim.next.done', { what: heldOneLine(released), rest }), 'good');
      followRelease(released);
    } else if (waiting > 0) setNotice(t('sim.next.stuck'), 'warn');
    else setNotice(t('sim.next.nothing'), 'info');
  }

  function heldOneLine(item) {
    const what = item.where === 'kiosk-http' ? t('held.call', { call: callName(item.call, t) }) : t('held.msg', { what: messageName(item.type, t) });
    return t('sim.next.item', { what, where: heldWhere(item, t), machine: item.device ?? '—', n: s.traces.find((x) => x.id === item.trace)?.n ?? '?' });
  }

  /** After Next hop: the flow that goes on is the one to watch, from where it waited. */
  function followRelease(item) {
    if (item.trace === s.traceId) {
      if (!s.running) {
        // jump to where it waited, then keep up with what follows
        const at = s.steps.find((x) => x.e.type === 'sim.held' && x.e.data?.id === item.id);
        const target = at && isVisible(at) ? at : s.visible[s.visible.length - 1];
        if (target && target.seq !== s.cursor) {
          s.cursor = target.seq;
          showCurrent({ animate: false });
        }
        s.running = true;
        s.replay = false;
        renderCursor();
        kick();
      }
    } else if (wantsNewest()) choose(item.trace, { live: true, at: item.id });
  }

  async function releaseAll() {
    const res = await app.call('/api/lab/sim/release', {}, el.release, '');
    if (!res.ok) return app.fail(res.error);
    const n = res.data?.released ?? 0;
    setNotice(n ? t('sim.release.done', { n }) : t('sim.next.stuck'), n ? 'good' : 'warn');
    if (n && !s.running && s.traceId) {
      s.running = true;
      kick();
      renderPlayback();
    }
  }

  async function toggleHold() {
    const want = !s.hold;
    const body = want && isRealtime() ? { mode: 'simulation', hold: true } : { hold: want };
    const before = s.held.length;
    s.busy = true;
    renderHold();
    const res = await app.call('/api/lab/sim', body, null);
    s.busy = false;
    if (!res.ok) {
      renderHold();
      return app.fail(res.error);
    }
    applySim(res.data);
    renderHold();
    if (want) {
      setNotice(t('sim.hold.nowOn'), 'info');
      if (body.mode) toast(t('sim.toast.simulation'), 'info');
    } else {
      const freed = Math.max(0, before - (res.data?.held?.length ?? 0));
      setNotice(freed ? t('sim.hold.nowOffFreed', { n: freed }) : t('sim.hold.nowOff'), 'info');
    }
  }

  async function setMode(mode, button) {
    if (mode === s.mode || s.busy) return;
    const before = s.held.length;
    s.busy = true;
    renderHold();
    const res = await app.call('/api/lab/sim', { mode }, button, '');
    s.busy = false;
    if (!res.ok) {
      renderHold();
      return app.fail(res.error);
    }
    applySim(res.data);
    render();
    if (mode === 'simulation') {
      showTab('sim');
      toast(t('sim.toast.simulation'), 'info');
    } else {
      const freed = Math.max(0, before - (res.data?.held?.length ?? 0));
      toast(freed ? t('sim.toast.realtimeFreed', { n: freed }) : t('sim.toast.realtime'), 'info');
    }
  }

  // ---- wiring -----------------------------------------------------------------------------------

  for (const b of modeSwitch.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode, b));
  el.hold.addEventListener('click', toggleHold);
  el.next.addEventListener('click', next);
  el.release.addEventListener('click', releaseAll);
  el.follow.addEventListener('change', () => {
    s.followTrace = el.follow.checked;
    prefs.set('sim.follow', s.followTrace);
    if (s.followTrace && s.traces[0] && s.traces[0].id !== s.traceId) choose(s.traces[0].id);
  });
  el.traceSelect.addEventListener('change', () => {
    const id = el.traceSelect.value;
    if (!id || id === s.traceId) return;
    // picking an older flow stops following the newest one; picking the newest follows again
    s.followTrace = id === s.traces[0]?.id;
    prefs.set('sim.follow', s.followTrace);
    choose(id);
  });
  for (const b of el.playButtons) {
    b.addEventListener('click', () => {
      const what = b.dataset.play;
      if (what === 'play') play();
      else if (what === 'first') goTo(s.visible[0]?.seq ?? null);
      else if (what === 'last') goTo(s.visible[s.visible.length - 1]?.seq ?? null);
      else step(what === 'back' ? -1 : 1);
    });
  }
  el.speed.addEventListener('change', () => {
    const v = Number(el.speed.value);
    s.speed = SPEEDS.includes(v) ? v : 1;
    prefs.set('sim.speed', s.speed);
  });
  el.beats.addEventListener('change', () => {
    s.beats = el.beats.checked;
    prefs.set('sim.heartbeats', s.beats);
    refilter();
  });
  el.showAll.addEventListener('click', () => {
    s.layers = new Set(LAYERS);
    s.beats = true;
    prefs.set('sim.layers', LAYERS);
    prefs.set('sim.heartbeats', true);
    refilter();
  });
  el.earlier.addEventListener('click', () => {
    s.windowFrom = Math.max(0, Number(el.earlier.dataset.from ?? 0) - MAX_ROWS);
    s.windowTo = Number(el.earlier.dataset.to ?? s.visible.length);
    renderList();
  });
  el.later.addEventListener('click', () => {
    s.windowFrom = Number(el.earlier.dataset.from ?? 0);
    s.windowTo = Math.min(s.visible.length, Number(el.earlier.dataset.to ?? 0) + MAX_ROWS);
    renderList();
  });
  el.detailsClose.addEventListener('click', closeDetails);
  el.detailsMap.addEventListener('click', () => {
    const step = stepAt(s.cursor);
    if (step) anim.reveal(step.drop ?? step.to ?? step.from);
  });

  // keys: ← → step and space plays or pauses while the panel has the focus; in the list also
  // ↑ ↓, Home, End and Enter (the details); Escape closes the details
  root.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const target = ev.target;
    const inList = target === el.list;
    if (ev.key === 'Escape' && s.detailsOpen && (el.details.contains(target) || inList)) {
      ev.preventDefault();
      closeDetails();
      return;
    }
    // form fields, the raw JSON's toggle and its text keep their own keys
    if (target.closest('input, select, textarea, summary, .pd__json')) return;
    let handled = true;
    if (ev.key === 'ArrowRight' || (inList && ev.key === 'ArrowDown')) step(1);
    else if (ev.key === 'ArrowLeft' || (inList && ev.key === 'ArrowUp')) step(-1);
    else if (inList && ev.key === 'PageDown') step(10);
    else if (inList && ev.key === 'PageUp') step(-10);
    else if (inList && ev.key === 'Home') goTo(s.visible[0]?.seq ?? null);
    else if (inList && ev.key === 'End') goTo(s.visible[s.visible.length - 1]?.seq ?? null);
    else if (inList && ev.key === 'Enter') openDetails({ scroll: narrow.matches, focus: true });
    else if (ev.key === ' ' && (inList || target === root || target === el.detailsTitle)) play();
    else handled = false;
    if (handled) ev.preventDefault();
  });

  // ---- the envelope shows while the tab or the mode is in use ------------------------------------

  const active = () => s.tabShown || s.mode === 'simulation';
  let wasActive = false;
  function updateActive() {
    const on = active();
    if (on === wasActive) return;
    wasActive = on;
    anim.setActive(on);
    if (on) {
      anim.setHeld(s.held);
      showCurrent({ animate: false, reveal: false });
      kick();
    }
  }

  // ---- the event stream ------------------------------------------------------------------------

  function flushSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      rebuild();
      renderTraces();
      renderList();
      renderPlayback();
      renderDetailsPanel();
      kick();
    }, 30);
  }

  function onEvent(e) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'sim.mode':
        applySim({ mode: d.mode, hold: d.hold });
        renderHold();
        break;
      case 'sim.held':
        addHeld(d);
        if (d.trace === s.traceId) noticeSoon();
        break;
      case 'sim.released':
        dropHeld(d.id);
        break;
      case 'lab.action':
        if (d.action === 'reset' && !e.trace) resetAll(true);
        break;
      case 'sim.trace':
        // seenAt: announced by the stream now (a list asked for earlier does not have it yet)
        upsertTrace({ id: d.id, n: d.n, kind: d.kind, title: d.title, subject: d.subject ?? {}, school: e.school ?? null, device: d.device ?? null, at: Date.parse(e.at), lastAt: Date.parse(e.at), events: 1, seenAt: performance.now() });
        if (wantsNewest()) {
          choose(d.id, { live: true, first: e });
          return;
        }
        renderTraces();
        break;
      default:
        break;
    }
    if (e.trace && e.trace === s.traceId && e.type !== 'sim.trace') {
      if (addEvents([e])) {
        s.lastEventAt = performance.now();
        flushSoon();
      }
    }
  }

  function resetAll(reload) {
    stopTimer();
    s.traces = [];
    s.traceId = null;
    s.events = [];
    s.seqs = new Set();
    s.steps = [];
    s.visible = [];
    s.cursor = null;
    s.running = false;
    s.gone = false;
    s.released.clear();
    s.heldSeenAt.clear();
    s.detailsOpen = false;
    setHeld([]);
    setNotice('');
    anim.show(null);
    render();
    if (reload) refresh({ choose: true });
  }

  // ---- first draw -----------------------------------------------------------------------------

  render();
  refresh({ choose: true });

  return {
    onEvent,
    /** The polled lab state: mode, hold and what waits. `requestedAt`: when that state was asked for. */
    update(state, requestedAt) {
      if (state?.sim) applySim(state.sim, requestedAt);
      const up = state?.server?.up !== false;
      if (state && up !== s.serverUp) {
        s.serverUp = up;
        // a notice about what waits says what to do now that the server is on (or off)
        const item = el.notice.dataset.item ? s.held.find((x) => x.id === el.notice.dataset.item) : null;
        if (item && el.notice.classList.contains('sim__notice--warn')) setNotice(heldWords(item), 'warn', item.id);
      }
      renderMode();
      renderHold();
      anim.relayout();
    },
    /** The Simulation tab was shown or hidden. */
    shown(on) {
      s.tabShown = Boolean(on);
      updateActive();
      if (on) {
        if (performance.now() - s.tracesAt > TRACE_LIST_STALE_MS) refresh();
        keepCurrentInView();
      }
    },
    relang() {
      rebuild();
      el.traceSelect.dataset.sig = '';
      render();
      anim.relang();
    },
    /** An action answered early because its flow waits at a hop ({ held: true, trace, item }). */
    noteHeld(answer, { open = true } = {}) {
      const item = answer?.item ?? null;
      if (item) addHeld(item);
      // (an item let go before its answer came is not news any more)
      if (!item || !s.released.has(item.id)) setNotice(heldWords(item), 'warn', item?.id ?? null);
      if (open) showTab('sim');
      if (answer?.trace && answer.trace !== s.traceId && wantsNewest()) choose(answer.trace, { live: true });
    },
    /** Ask the lab what waits now; @returns the newest item of that machine ('<school>/<DEVICE>'), if any. */
    async syncHeld(key) {
      try {
        const requestedAt = performance.now();
        const res = await get('/api/lab/sim?limit=5');
        applySim(res, requestedAt);
        for (const x of res.traces ?? []) upsertTrace(x);
        renderTraces();
        const mine = s.held.filter((x) => `${x.school}/${x.device}` === key);
        const item = mine[mine.length - 1] ?? null;
        if (item) setNotice(heldWords(item), 'warn', item.id);
        return item;
      } catch {
        return null;
      }
    },
    /**
     * The stream (re)connected: what happened meanwhile is fetched again. The list first: the
     * chosen flow may be gone (the lab was reset or restarted meanwhile), and then the newest is
     * shown instead; else the chosen flow's steps are fetched again.
     */
    async resync() {
      const before = s.traceId;
      await refresh();
      if (s.traceId && s.traceId === before && !s.gone) load(s.traceId, { toEnd: s.running });
    },
    /** The person reset the demo from this page. */
    reset: () => resetAll(false),
    /** 'realtime' or 'simulation'. */
    get mode() {
      return s.mode;
    },
    relayout: () => anim.relayout(),
  };
}
