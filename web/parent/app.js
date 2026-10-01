// The parent app's entry: who is signed in, coming back from the bank, and a small hash router.
//
//   #/                          your children (and link a child)
//   #/signin                    pick a demo parent or create one (lab only, no passwords)
//   #/child/<school>/<member>   one child: card balance, waiting money, history
//   #/child/<school>/<member>/topup
//   #/payment/<order>           what happened at the bank

import {
  i18n, t, state, hooks, call, store, sessionHint, renderBanner, h, icon, loadError, skeleton, PENDING_PAYMENT, isOfflineError,
} from './core.js';
import { signinView } from './signin.js';
import { homeView } from './home.js';
import { childView } from './child.js';
import { topupView, paymentView } from './topup.js';

const ID = '([A-Za-z0-9_-]{1,64})';
const ROUTES = [
  { re: /^#?\/?$/, view: homeView },
  { re: /^#\/signin$/, view: signinView, open: true },
  { re: new RegExp(`^#/child/${ID}/${ID}$`), view: childView },
  { re: new RegExp(`^#/child/${ID}/${ID}/topup$`), view: topupView },
  { re: new RegExp(`^#/payment/${ID}$`), view: paymentView },
];

const main = document.getElementById('main');
let generation = 0;
let cleanups = [];
/** The open page's own way to catch up when the server is back (instead of being drawn again). */
let onReconnect = null;
/** false until the server has told us who is signed in (it may be off when the page opens). */
let sessionKnown = false;
/** false while the page is first opening: focus then stays at the top, so Tab reaches "Skip to content" first. */
let booted = false;

function match() {
  const hash = location.hash || '#/';
  for (const route of ROUTES) {
    const m = route.re.exec(hash);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}

function setHash(hash) {
  history.replaceState(null, '', hash);
}

async function render({ soft = false } = {}) {
  const gen = ++generation;
  const moveFocus = !soft && booted;
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // a view's clean-up must not stop the next view
    }
  }
  onReconnect = null;
  renderAccount();

  if (!sessionKnown) {
    // the server could not say who is signed in yet (it may be off or unreachable): wait for it
    main.replaceChildren(state.offline
      ? h('div', { class: 'narrow waiting' },
        h('span', { class: 'spinner spinner--big', 'aria-hidden': 'true' }),
        h('h1', { tabindex: '-1' }, t('waitingServer')),
        h('p', { class: 'muted' }, t('waitingServerText')))
      : h('div', { class: 'narrow' }, h('h1', { class: 'sr-only', tabindex: '-1' }, t('appTitle')), skeleton(4)));
    return;
  }
  let found = match();
  if (!found) {
    setHash('#/');
    found = match();
  }
  if (!state.parent && !found.route.open) {
    setHash('#/signin');
    found = match();
  } else if (state.parent && found.route.open) {
    setHash('#/');
    found = match();
  }

  const view = {
    main,
    soft,
    alive: () => gen === generation,
    go: (hash) => {
      if (location.hash === hash) render();
      else location.hash = hash;
    },
    refresh: (opts) => render(opts),
    /** Called instead of drawing the page again when the server answers again after being off. */
    onReconnect: (fn) => {
      onReconnect = fn;
    },
    /** Run fn every ms while this page is open and visible, and as soon as it becomes visible again. */
    poll: (ms, fn) => {
      const tick = () => {
        if (gen === generation && document.visibilityState === 'visible' && !state.offline) fn();
      };
      const timer = setInterval(tick, ms);
      const onVisible = () => {
        if (document.visibilityState === 'visible') tick();
      };
      document.addEventListener('visibilitychange', onVisible);
      cleanups.push(() => {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      });
    },
  };

  if (!soft) window.scrollTo(0, 0);
  const running = found.route.view(view, found.params.map(decodeURIComponent));
  // a new page: move focus to its heading so screen readers announce it
  if (moveFocus) requestAnimationFrame(() => view.alive() && focusHeading());
  try {
    await running;
  } catch (err) {
    console.error(err);
    if (view.alive()) main.replaceChildren(loadError(err, () => render()));
  }
  if (moveFocus && view.alive() && (document.activeElement === document.body || !document.activeElement || !main.contains(document.activeElement))) {
    focusHeading();
  }
}

function focusHeading() {
  const heading = main.querySelector('h1');
  if (heading) heading.focus({ preventScroll: true });
}

// ---- who is signed in -----------------------------------------------------------------------

async function checkSession() {
  if (!sessionHint.get()) {
    // never signed in on this browser (or signed out): no need to ask
    state.parent = null;
    sessionKnown = true;
    return;
  }
  try {
    const { parent } = await call('/api/parent/me');
    state.parent = parent;
    sessionKnown = true;
  } catch (err) {
    if (err.code === 'NOT_SIGNED_IN') {
      state.parent = null;
      sessionHint.set(false);
      sessionKnown = true;
    } else if (!isOfflineError(err)) {
      // something unexpected: show the sign-in page, which explains errors on its own
      state.parent = null;
      sessionKnown = true;
    }
  }
}

/** Back from the bank (it always returns to /parent/): show what happened to that payment. */
function checkReturnFromBank() {
  const pending = store.get(PENDING_PAYMENT);
  if (pending && typeof pending.orderId === 'string' && state.parent) setHash(`#/payment/${encodeURIComponent(pending.orderId)}`);
}

async function signOut() {
  try {
    await call('/api/parent/logout', { method: 'POST' });
  } catch {
    // the session cookie is cleared on the server's next answer anyway; forget it here too
  }
  forget();
  setHash('#/signin');
  render();
}

function forget() {
  state.parent = null;
  state.family = null;
  sessionHint.set(false);
  store.clear();
}

hooks.signedOut = () => {
  forget();
  setHash('#/signin');
  render();
};

hooks.refresh = async (opts) => {
  if (opts?.reconnect && sessionKnown && onReconnect) {
    onReconnect();
    return;
  }
  if (!sessionKnown) {
    await checkSession();
    if (sessionKnown) checkReturnFromBank();
    render();
    return;
  }
  render(opts);
};

// ---- header and footer ----------------------------------------------------------------------

function renderAccount() {
  const box = document.getElementById('account');
  if (!state.parent) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren(
    h('span', { class: 'account__who' }, icon('person'), t('signedInAs', { name: state.parent.name })),
    h('button', { type: 'button', class: 'btn btn--small', onclick: signOut }, t('signOut')),
  );
}

// ---- start ----------------------------------------------------------------------------------

document.getElementById('lang').append(i18n.switcher());
i18n.apply();
i18n.onChange(() => {
  renderBanner();
  render({ soft: true });
});
window.addEventListener('hashchange', () => render());
// The session cookie is shared by every tab: if another tab signed in as someone else (or signed
// out), catch up when this tab is looked at again instead of showing one parent's name with
// another parent's children.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !sessionKnown || !state.parent || state.offline) return;
  try {
    const { parent } = await call('/api/parent/me');
    if (parent.id !== state.parent.id) {
      state.parent = parent;
      state.family = null;
      store.clear();
      setHash('#/');
      render();
    }
  } catch {
    // signed out elsewhere: call() has already gone back to the picker; offline: the banner says so
  }
});
// coming back with the browser's Back button may restore this page from memory without reloading it
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  checkReturnFromBank();
  render();
});

render();
await checkSession();
if (sessionKnown) checkReturnFromBank();
render();
booted = true;
