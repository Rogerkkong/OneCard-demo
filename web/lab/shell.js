// The Console tab: the same PuTTY-style consoles as telnet port 2323, in the browser. The page
// keeps the session's target (null, 'server' or '<school>/<DEVICE>') and sends one line at a
// time to POST /api/lab/console. ↑/↓ bring back earlier commands.

import { h } from '/shared/api.js';
import { errorText } from './describe.js';
import { prefs, rich, setText } from './util.js';

const MAX_ENTRIES = 300;
const MAX_HISTORY = 50;

export function createShell(app, root) {
  const { t } = app;
  const q = (sel) => root.querySelector(sel);
  const title = q('#con-title');
  const hint = q('.con__hint');
  const intro = q('.con__intro');
  const out = q('.term__out');
  const form = q('.term__form');
  const promptEl = q('.term__prompt');
  const input = q('#term-in');
  const runBtn = q('.term__run');
  const clearBtn = q('[data-role="con-clear"]');
  const quickLabel = q('.con__quicklabel');
  const quickEl = q('.con__quicklist');

  let target = null;
  let prompt = 'onecard>';
  let running = false;
  const saved = prefs.get('console.history', []);
  const history = (Array.isArray(saved) ? saved : []).filter((x) => typeof x === 'string').slice(-MAX_HISTORY);
  let cursor = history.length;
  let draft = '';

  function scrollDown() {
    out.scrollTop = out.scrollHeight;
  }

  function append(echo, text, tone) {
    const entry = h('div', { class: `term__entry${tone ? ` term__entry--${tone}` : ''}` });
    if (echo !== null) entry.append(h('div', { class: 'term__echo' }, h('span', { class: 'term__p' }, echo.prompt), ' ', echo.line));
    if (text) entry.append(h('pre', { class: 'term__text' }, text));
    out.append(entry);
    while (out.children.length > MAX_ENTRIES) out.firstElementChild.remove();
    scrollDown();
  }

  async function run(line) {
    if (running) return;
    const text = line.trim();
    const echo = { prompt, line };
    if (text) {
      if (history[history.length - 1] !== text) history.push(text);
      while (history.length > MAX_HISTORY) history.shift();
      prefs.set('console.history', history);
    }
    cursor = history.length;
    draft = '';
    if (!text) {
      append(echo, '');
      return;
    }
    running = true;
    runBtn.disabled = true;
    input.setAttribute('aria-busy', 'true');
    try {
      const res = await app.call('/api/lab/console', { line: text, target });
      if (!res.ok) {
        append(echo, t('con.failed', { message: errorText(res.error, t) }), 'bad');
        return;
      }
      const answer = res.data;
      append(echo, answer.output ?? '', /^%/.test(answer.output ?? '') ? 'bad' : '');
      target = answer.target ?? null;
      prompt = answer.prompt ?? 'onecard>';
      if (answer.exit) {
        append(null, t('con.closed'), 'note');
        target = null;
        prompt = 'onecard>';
      }
    } finally {
      running = false;
      runBtn.disabled = false;
      input.removeAttribute('aria-busy');
      relabel();
    }
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (running) return; // keep what was typed until the previous command has answered
    const line = input.value;
    input.value = '';
    run(line);
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp') {
      if (cursor === 0) return;
      if (cursor === history.length) draft = input.value;
      cursor -= 1;
      input.value = history[cursor];
    } else if (ev.key === 'ArrowDown') {
      if (cursor >= history.length) return;
      cursor += 1;
      input.value = cursor === history.length ? draft : history[cursor];
    } else if (ev.key === 'Escape' && input.value) {
      input.value = '';
    } else {
      return;
    }
    ev.preventDefault();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });

  clearBtn.addEventListener('click', () => {
    out.replaceChildren();
    input.focus();
  });

  /** Commands worth a click at the current prompt. */
  function quickCommands() {
    if (target === 'server') return ['show status', 'show schools', 'show clients', 'jobs run', 'help', 'disconnect'];
    if (target) {
      const kiosk = /KIOSK/i.test(target);
      return ['show status', 'show journal', kiosk ? 'show config' : 'show prices', 'show log', 'help', 'disconnect'];
    }
    const first = app.state?.schools?.[0]?.devices?.[0];
    return ['help', 'machines', 'connect server', first ? `connect ${first.school}/${first.code}` : null, 'clock'].filter(Boolean);
  }

  function relabel() {
    setText(title, t('con.title'));
    const addr = app.state?.urls?.consoleAddress;
    if (addr) {
      const i = addr.lastIndexOf(':');
      setText(hint, t('con.hint', { host: addr.slice(0, i), port: addr.slice(i + 1) }));
    } else setText(hint, t('con.hintOff'));
    if (intro.dataset.lang !== app.i18n.lang) {
      intro.replaceChildren(...rich(t('con.intro')));
      intro.dataset.lang = app.i18n.lang;
    }
    setText(promptEl, prompt);
    input.setAttribute('aria-label', t('con.command', { prompt }));
    setText(runBtn, t('con.run'));
    setText(clearBtn, t('con.clear'));
    setText(quickLabel, t('con.quick'));
    const wanted = quickCommands();
    if (quickEl.dataset.sig !== wanted.join('|')) {
      quickEl.replaceChildren(
        ...wanted.map((cmd) => {
          const b = h('button', { type: 'button', class: 'chip chip--cmd mono' }, cmd);
          b.addEventListener('click', () => {
            run(cmd);
            input.focus();
          });
          return b;
        }),
      );
      quickEl.dataset.sig = wanted.join('|');
    }
  }

  /** Log in to a machine from its "More" menu. */
  async function connect(key) {
    if (running) return;
    await run(`connect ${key}`);
    input.focus();
  }

  relabel();
  return { relabel, connect, focus: () => input.focus() };
}
