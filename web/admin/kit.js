// Helpers shared by the school office (/admin/) and the operator console (/operator/): the
// "server unreachable" banner with its quiet retry, in-page dialogs (no window.confirm), error
// wording in both languages, tables, pills and the once-only secret box. They would live in
// /shared/ if that folder were ours to change; the operator console imports this file from
// /admin/kit.js and links /admin/admin.css for the matching styles.

import { get, post, h, toast } from '/shared/api.js';

/** Strings the kit itself shows. Each app merges these into its own dictionary. */
export const KIT_STRINGS = {
  en: {
    'kit.cancel': 'Cancel',
    'kit.close': 'Close',
    'kit.copy': 'Copy',
    'kit.copied': 'Copied to the clipboard.',
    'kit.copyFailed': 'Could not copy. Select the text and copy it by hand.',
    'kit.working': 'Working…',
    'kit.loading': 'Loading…',
    'kit.refresh': 'Refresh',
    'kit.tryAgain': 'Try again',
    'kit.loadFailed': 'Could not load this. {message}',
    'kit.notLoaded': 'Not loaded: the OneCard server cannot be reached.',
    'kit.required': 'Fill this in.',
    'kit.moneyInvalid': 'Enter an amount in ringgit, for example 12.50.',
    'kit.moneyZero': 'The amount must be more than RM 0.00.',
    'kit.never': 'never',
    'kit.none': 'None',
    'kit.yes': 'Yes',
    'kit.no': 'No',
    'kit.down.title': 'The OneCard server is unreachable',
    'kit.down.text':
      'Nothing can be loaded or saved right now. In the lab the cloud server has been switched off: switch it back on in the lab console. This page keeps trying every few seconds.',
    'kit.down.lab': 'Open the lab console',
    'kit.net.title': 'Cannot reach the lab',
    'kit.net.text': 'The browser cannot reach the lab server. Is the lab still running? This page keeps trying every few seconds.',
    'kit.back': 'The OneCard server is reachable again.',
    'kit.secret.title': 'Secret for {code}: shown only once',
    'kit.secret.warn':
      'Copy it now and keep it safe. OneCard never shows it again. The machine signs every message with it, so anyone who has it can pretend to be this machine.',
    'kit.secret.lab': 'In the lab the virtual machine already has its secret, so you do not need to type it anywhere.',
    'kit.secret.hide': 'I have copied it, hide the secret',
    'kit.secret.hidden': 'Secret hidden. It cannot be shown again.',
    'err.other': 'Something went wrong: {message} ({code})',
    'err.SERVER_DOWN': 'The OneCard server is unreachable. Switch the cloud server back on in the lab console, then try again.',
    'err.NETWORK': 'The browser cannot reach the lab server. Is the lab still running?',
    'err.NOT_SIGNED_IN': 'You are signed out. Sign in again.',
    'err.FORBIDDEN': 'Your role cannot do this.',
    'err.CROSS_ORIGIN': 'The server refused a request that did not come from this page. Reload the page and try again.',
    'err.BROKER_UNAVAILABLE': 'Saved, but the platform cannot reach the message broker, so the machines have not heard of it yet.',
    'err.BAD_JSON': 'The server could not read what was sent.',
    'err.BODY_TOO_LARGE': 'That is too large to send (the limit is 1 MB).',
    'err.INTERNAL': 'Something went wrong in the lab server. Try again; if it keeps happening, check the terminal that runs the lab.',
    'err.HTTP_404': 'Not found.',
  },
  zh: {
    'kit.cancel': '取消',
    'kit.close': '关闭',
    'kit.copy': '复制',
    'kit.copied': '已复制到剪贴板。',
    'kit.copyFailed': '无法复制。请选中文字后手动复制。',
    'kit.working': '处理中…',
    'kit.loading': '加载中…',
    'kit.refresh': '刷新',
    'kit.tryAgain': '重试',
    'kit.loadFailed': '无法加载。{message}',
    'kit.notLoaded': '未加载：连不上 OneCard 服务器。',
    'kit.required': '请填写这一项。',
    'kit.moneyInvalid': '请输入令吉金额，例如 12.50。',
    'kit.moneyZero': '金额必须大于 RM 0.00。',
    'kit.never': '从未',
    'kit.none': '没有',
    'kit.yes': '是',
    'kit.no': '否',
    'kit.down.title': '连不上 OneCard 服务器',
    'kit.down.text': '现在无法加载或保存任何资料。实验室里的云端服务器被关掉了：请在实验室控制台把它重新打开。本页每隔几秒会自动重试。',
    'kit.down.lab': '打开实验室控制台',
    'kit.net.title': '连不上实验室',
    'kit.net.text': '浏览器连不上实验室服务器。实验室还在运行吗？本页每隔几秒会自动重试。',
    'kit.back': '已重新连上 OneCard 服务器。',
    'kit.secret.title': '{code} 的密钥：只显示这一次',
    'kit.secret.warn': '请现在复制并妥善保管。OneCard 以后不会再显示它。机器用它为每条消息签名，谁拿到它就能冒充这台机器。',
    'kit.secret.lab': '在实验室里，虚拟机器已经有自己的密钥，你不需要在任何地方输入它。',
    'kit.secret.hide': '我已复制，隐藏密钥',
    'kit.secret.hidden': '密钥已隐藏，无法再次显示。',
    'err.other': '出错了：{message}（{code}）',
    'err.SERVER_DOWN': '连不上 OneCard 服务器。请在实验室控制台重新打开云端服务器，然后再试。',
    'err.NETWORK': '浏览器连不上实验室服务器。实验室还在运行吗？',
    'err.NOT_SIGNED_IN': '你已退出登录，请重新登录。',
    'err.FORBIDDEN': '你的角色不能做这件事。',
    'err.CROSS_ORIGIN': '服务器拒绝了不是来自本页的请求。请重新加载页面后再试。',
    'err.BROKER_UNAVAILABLE': '已保存，但平台连不上消息服务器（broker），机器还没收到。',
    'err.BAD_JSON': '服务器读不懂发送的内容。',
    'err.BODY_TOO_LARGE': '内容太大，无法发送（上限 1 MB）。',
    'err.INTERNAL': '实验室服务器出错了。请再试一次；如果一直这样，请看运行实验室的终端。',
    'err.HTTP_404': '找不到。',
  },
};

/** Merge dictionaries: later ones win. */
export function mergeStrings(...sets) {
  const out = { en: {}, zh: {} };
  for (const s of sets) {
    Object.assign(out.en, s.en);
    Object.assign(out.zh, s.zh);
  }
  return out;
}

/** True when the dictionary has the key (t() answers the key itself when it does not). */
export const has = (t, key) => t(key) !== key;

/** The message to show for an API error, in the current language. */
export function errorMessage(t, err) {
  const code = err?.code ?? 'INTERNAL';
  const key = `err.${code}`;
  if (has(t, key)) return t(key, err?.detail && typeof err.detail === 'object' && !Array.isArray(err.detail) ? err.detail : undefined);
  return t('err.other', { message: err?.message ?? String(err), code });
}

/** Problems listed by the server (CONFIG_INVALID and friends carry them in `detail`). */
export function errorDetails(err) {
  return Array.isArray(err?.detail) ? err.detail.filter((d) => typeof d === 'string').slice(0, 8) : [];
}

const isOutage = (err) => err?.code === 'SERVER_DOWN' || err?.code === 'NETWORK';

/**
 * Wrap get/post so every call goes through one error hook. `onError(err)` returns true when it
 * dealt with the error for the whole page (server down, signed out, school suspended); the
 * error is still thrown, marked `handled`, so the caller stops what it was doing.
 */
export function createApi(onError) {
  const run = async (promise) => {
    try {
      return await promise;
    } catch (err) {
      if (onError(err)) err.handled = true;
      throw err;
    }
  };
  return { get: (path) => run(get(path)), post: (path, body) => run(post(path, body ?? {})) };
}

/**
 * The full-width banner shown while the OneCard server cannot be reached (503 SERVER_DOWN, or
 * no answer at all). It retries quietly every few seconds with `probe()` and calls
 * `onRestored()` once the server answers anything else.
 */
export function createConnectionWatch({ t, host, probe, onRestored, intervalMs = 4000 }) {
  let state = 'up'; // 'up' | 'SERVER_DOWN' | 'NETWORK'
  let timer = null;
  const banner = h('div', { class: 'conn-banner', role: 'alert', hidden: true });
  host.append(banner);

  function render() {
    banner.replaceChildren();
    if (state === 'up') {
      banner.hidden = true;
      return;
    }
    const net = state === 'NETWORK';
    banner.append(
      h(
        'div',
        { class: 'conn-banner__inner' },
        h('span', { class: 'conn-banner__dot', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'conn-banner__text' },
          h('strong', {}, t(net ? 'kit.net.title' : 'kit.down.title')),
          h('span', {}, t(net ? 'kit.net.text' : 'kit.down.text')),
        ),
        net ? null : h('a', { class: 'btn btn--small', href: '/lab/' }, t('kit.down.lab')),
      ),
    );
    banner.hidden = false;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
  }

  async function tick() {
    try {
      await probe();
    } catch (err) {
      if (isOutage(err)) {
        if (err.code !== state) {
          state = err.code;
          render();
        }
        schedule();
        return;
      }
      // any other answer (even "signed out") means the server is back
    }
    state = 'up';
    render();
    toast(t('kit.back'), 'good');
    onRestored();
  }

  return {
    /** @returns {boolean} true if `err` is an outage (the banner is now showing) */
    report(err) {
      if (!isOutage(err)) return false;
      if (state === 'up') {
        state = err.code;
        render();
        schedule();
      }
      return true;
    },
    get down() {
      return state !== 'up';
    },
    render,
  };
}

// ---- dialogs ------------------------------------------------------------------------------

const openDialogs = new Set();
let dialogSeq = 0;

/** Is any dialog open? Auto-refresh waits, so the button that opened it stays on the page. */
export const dialogOpen = () => openDialogs.size > 0;

/** Close every open dialog (on sign-out or when the session is gone). */
export function closeAllDialogs() {
  for (const close of [...openDialogs]) close();
}

function fieldControl(f, id) {
  const common = { id, name: f.name, autocomplete: f.autocomplete ?? 'off' };
  if (f.type === 'textarea') return h('textarea', { ...common, rows: f.rows ?? 3, maxlength: f.maxLength, placeholder: f.placeholder }, f.value ?? '');
  if (f.type === 'select') {
    return h(
      'select',
      common,
      (f.options ?? []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label)),
    );
  }
  return h('input', {
    ...common,
    type: 'text',
    value: f.value ?? '',
    placeholder: f.placeholder,
    maxlength: f.maxLength,
    inputmode: f.type === 'money' ? 'decimal' : f.inputmode,
    spellcheck: f.spellcheck === false ? 'false' : undefined,
    class: f.mono ? 'mono' : undefined,
  });
}

/**
 * An in-page dialog (a real <dialog>, so Escape closes it and focus stays inside). `action`
 * runs when the person confirms: if it throws, the error is shown in the dialog and it stays
 * open; if it succeeds, the dialog closes and the promise resolves with its result.
 * Fields: { name, label, type: 'text'|'textarea'|'money'|'select', required, value, hint,
 * placeholder, options, maxLength, mono, validate(value) → message|null }. Money fields give sen.
 * @returns {Promise<unknown|null>} the action's result, or null when cancelled
 */
export function openDialog({ t, title, body, fields = [], confirmLabel, tone = 'primary', action, parseMoney, focusCancel = false }) {
  return new Promise((resolve) => {
    const id = `dlg${++dialogSeq}`;
    const opener = document.activeElement;
    let busy = false;
    const errorBox = h('p', { class: 'dlg__error', role: 'alert', hidden: true });
    const controls = new Map();
    const fieldEls = fields.map((f, i) => {
      const fid = `${id}-f${i}`;
      const control = fieldControl(f, fid);
      const msg = h('span', { class: 'field-error', id: `${fid}-err`, hidden: true });
      const hint = f.hint ? h('span', { class: 'field-hint', id: `${fid}-hint` }, f.hint) : null;
      if (hint) control.setAttribute('aria-describedby', `${fid}-hint`);
      controls.set(f.name, { f, control, msg });
      return h('div', { class: 'field' }, h('label', { for: fid }, f.label), control, hint, msg);
    });
    const cancelBtn = h('button', { type: 'button', class: 'btn', autofocus: focusCancel || undefined }, t('kit.cancel'));
    const okBtn = h(
      'button',
      { type: 'submit', class: `btn ${tone === 'danger' ? 'btn--danger-solid' : tone === 'accent' ? 'btn--accent' : 'btn--primary'}` },
      confirmLabel,
    );
    const form = h(
      'form',
      { class: 'dlg__form', novalidate: true },
      h('h2', { class: 'dlg__title', id: `${id}-title` }, title),
      body ? h('div', { class: 'dlg__body', id: `${id}-body` }, body) : null,
      fieldEls.length ? h('div', { class: 'dlg__fields' }, fieldEls) : null,
      errorBox,
      h('div', { class: 'dlg__actions' }, cancelBtn, okBtn),
    );
    const dlg = h('dialog', { class: 'dlg', 'aria-labelledby': `${id}-title`, 'aria-describedby': body ? `${id}-body` : undefined }, form);

    function finish(result) {
      if (!dlg.isConnected) return;
      openDialogs.delete(close);
      dlg.close();
      dlg.remove();
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      resolve(result);
    }
    const close = () => finish(null);
    openDialogs.add(close);

    cancelBtn.addEventListener('click', () => {
      if (!busy) finish(null);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault(); // we remove the element ourselves
      if (!busy) finish(null);
    });

    function readValues() {
      const values = {};
      let firstBad = null;
      for (const [name, { f, control, msg }] of controls) {
        const raw = control.value;
        let value = typeof raw === 'string' ? raw.trim() : raw;
        let problem = null;
        if (f.required && value === '') problem = t('kit.required');
        else if (f.type === 'money' && value !== '') {
          const sen = parseMoney(value);
          if (sen === null) problem = t('kit.moneyInvalid');
          else if (sen <= 0) problem = t('kit.moneyZero');
          else value = sen;
        }
        if (!problem && f.validate) problem = f.validate(value);
        msg.textContent = problem ?? '';
        msg.hidden = !problem;
        control.setAttribute('aria-invalid', problem ? 'true' : 'false');
        if (problem) control.setAttribute('aria-describedby', `${msg.id}${f.hint ? ` ${control.id}-hint` : ''}`);
        else if (f.hint) control.setAttribute('aria-describedby', `${control.id}-hint`);
        if (problem && !firstBad) firstBad = control;
        values[name] = value;
      }
      if (firstBad) {
        firstBad.focus();
        return null;
      }
      return values;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const values = readValues();
      if (!values) return;
      errorBox.hidden = true;
      busy = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      const label = okBtn.textContent;
      okBtn.textContent = t('kit.working');
      try {
        const result = action ? await action(values) : true;
        finish(result ?? true);
      } catch (err) {
        busy = false;
        okBtn.disabled = false;
        cancelBtn.disabled = false;
        okBtn.textContent = label;
        if (!dlg.isConnected) return;
        const details = errorDetails(err);
        errorBox.replaceChildren(errorMessage(t, err), ...(details.length ? [h('ul', {}, details.map((d) => h('li', {}, d)))] : []));
        errorBox.hidden = false;
      }
    });

    document.body.append(dlg);
    dlg.showModal();
    const first = fields.length ? controls.get(fields[0].name).control : focusCancel ? cancelBtn : okBtn;
    first.focus();
  });
}

// ---- small pieces --------------------------------------------------------------------------

/** A status pill. tone: 'good' | 'warn' | 'bad' | 'info' | '' (neutral) */
export function pill(text, tone = '') {
  return h('span', { class: tone ? `pill pill--${tone}` : 'pill' }, text);
}

/** Wide tables scroll inside their own box; the box takes keyboard focus only when it overflows. */
const overflowWatch =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        for (const { target } of entries) {
          if (target.scrollWidth > target.clientWidth + 1) target.setAttribute('tabindex', '0');
          else target.removeAttribute('tabindex');
        }
      })
    : null;

/**
 * A table in its own scrolling box.
 * @param {{ label: string, head: Array<string|{label:string, num?:boolean}>, rows: Array<Array<unknown>|HTMLElement>, empty?: string, compact?: boolean }} opts
 */
export function dataTable({ label, head, rows, empty, compact }) {
  const cols = head.map((c) => (typeof c === 'string' ? { label: c } : c));
  const cell = (tag, c, value) => {
    const attrs = { class: colClass(c) };
    if (tag === 'th') attrs.scope = 'col';
    return h(tag, attrs, value);
  };
  const body = rows.length
    ? rows.map((r) => (r instanceof HTMLElement ? r : h('tr', {}, r.map((v, i) => cell('td', cols[i] ?? {}, v)))))
    : [h('tr', {}, h('td', { colspan: cols.length, class: 'empty' }, empty ?? ''))];
  const table = h(
    'table',
    { class: [compact ? 'table--compact' : null, `cols-${cols.length}`].filter(Boolean).join(' ') },
    h('thead', {}, h('tr', {}, cols.map((c) => cell('th', c, c.label)))),
    h('tbody', {}, body),
  );
  const wrap = h('div', { class: 'table-wrap', role: 'region', 'aria-label': label }, table);
  overflowWatch?.observe(wrap);
  return wrap;
}

/** Column classes: { num } right-aligns, { nowrap } keeps short values on one line. */
function colClass(c = {}) {
  return [c.num ? 'num' : null, c.nowrap ? 'nw' : null, c.class ?? null].filter(Boolean).join(' ') || undefined;
}

/** A table row whose cells follow the same column rules as dataTable (for rows with classes). */
export function row(cells, attrs = {}, head = []) {
  return h('tr', attrs, cells.map((v, i) => h('td', { class: colClass(typeof head[i] === 'string' ? {} : head[i]) }, v)));
}

/** '2026-10-20' -> '20/10/2026' (a KL day from the API). */
export function formatDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

/** Copy text; falls back to a hidden textarea where the Clipboard API is not allowed (plain http on a LAN). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'sr-only', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function copyButton(t, text, label) {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn btn--small',
      onclick: async () => {
        const ok = await copyText(text);
        toast(t(ok ? 'kit.copied' : 'kit.copyFailed'), ok ? 'good' : 'warn');
      },
    },
    label ?? t('kit.copy'),
  );
}

/**
 * A machine secret, shown once with a clear warning, a copy button and a way to hide it for good.
 * @param {(key: string, vars?: object) => string} t
 */
export function secretBox(t, { code, secret, lab = true }) {
  const box = h('div', { class: 'secret' });
  const value = h('code', { class: 'secret__value' }, secret);
  const hide = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, t('kit.secret.hide'));
  hide.addEventListener('click', () => {
    box.replaceChildren(h('p', { class: 'muted' }, t('kit.secret.hidden')));
  });
  box.append(
    h('p', { class: 'secret__title' }, t('kit.secret.title', { code })),
    h('p', { class: 'secret__warn' }, t('kit.secret.warn')),
    h('div', { class: 'secret__row' }, value, copyButton(t, secret)),
    lab ? h('p', { class: 'secret__note' }, t('kit.secret.lab')) : null,
    h('div', {}, hide),
  );
  return box;
}

/** A labelled number for overview tiles; a link when `href` is given. */
export function tile({ label, value, sub, href, tone = '' }) {
  const inner = [
    h('span', { class: 'tile__head' }, h('span', { class: 'tile__label' }, label), href ? h('span', { class: 'tile__go', 'aria-hidden': 'true' }, '→') : null),
    h('span', { class: 'tile__value num' }, value),
    sub ? h('span', { class: 'tile__sub' }, sub) : null,
  ];
  const cls = `tile${tone ? ` tile--${tone}` : ''}${href ? ' tile--link' : ''}`;
  return href ? h('a', { class: cls, href }, ...inner) : h('div', { class: cls }, ...inner);
}

/** Section heading with a description and actions on the right. Focus moves to the heading on navigation. */
export function sectionHead({ title, text, actions = [] }) {
  return h(
    'div',
    { class: 'section-head' },
    h('div', { class: 'section-head__text' }, h('h2', { tabindex: '-1', class: 'view-title' }, title), text ? h('p', { class: 'muted' }, text) : null),
    actions.length ? h('div', { class: 'section-head__actions' }, actions) : null,
  );
}

/** A panel with a heading. */
export function panel(title, ...children) {
  return h('section', { class: 'panel stack' }, title ? h('h3', { class: 'panel__title' }, title) : null, ...children);
}

/** Load-error or not-loaded note with a retry button. */
export function loadProblem(t, err, retry) {
  const text = err?.handled && (err.code === 'SERVER_DOWN' || err.code === 'NETWORK') ? t('kit.notLoaded') : t('kit.loadFailed', { message: errorMessage(t, err) });
  return h('div', { class: 'notice notice--bad', role: 'status' }, h('p', {}, text), retry ? h('button', { type: 'button', class: 'btn btn--small', onclick: retry }, t('kit.tryAgain')) : null);
}

/** Call `fn` every `ms` while the page is visible; returns a stop function. */
export function every(ms, fn) {
  let stopped = false;
  let timer = null;
  const loop = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (!stopped && document.visibilityState === 'visible') {
        try {
          await fn();
        } catch {
          // a failed refresh is reported by the api hook; keep the loop going
        }
      }
      loop();
    }, ms);
  };
  loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Is focus (or an open control) inside `el`? Auto-refresh leaves such regions alone. */
export const busyInside = (el) => !!el && (el.contains(document.activeElement) || !!el.querySelector('[data-busy="1"]'));

/** camelCase or snake_case key -> 'Words like this' (fallback label for detail objects). */
export function humanKey(key) {
  const s = String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
