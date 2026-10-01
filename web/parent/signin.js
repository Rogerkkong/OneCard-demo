// Sign in: lab only, no passwords. Pick a demo parent (GET /api/parent/options) or create one
// (POST /api/parent/register). Either way the server sets the session cookie.

import { call, h, t, state, sessionHint, avatar, icon, notice, errorText, loadError, skeleton, setTitle, busy } from './core.js';

export async function signinView(view) {
  setTitle(t('signinTitle'));
  const list = h('ul', { class: 'pick-list', 'aria-busy': 'true' }, h('li', {}, skeleton(4)));
  const listMsg = h('div', { class: 'form-msg', role: 'alert' });

  view.main.replaceChildren(
    h('div', { class: 'signin' },
      h('section', { class: 'signin__intro' },
        h('h1', { tabindex: '-1' }, t('signinTitle')),
        h('p', { class: 'lede' }, t('signinLede')),
        notice('info', t('labNoticeTitle'), t('labNoticeText'))),
      h('section', { class: 'panel signin__demo', 'aria-labelledby': 'demo-h' },
        h('h2', { id: 'demo-h' }, t('demoParents')),
        listMsg,
        list),
      h('section', { class: 'panel signin__new', 'aria-labelledby': 'new-h' },
        h('h2', { id: 'new-h' }, t('newParentTitle')),
        h('p', { class: 'muted' }, t('newParentText')),
        registerForm())),
  );

  async function loadParents() {
    list.setAttribute('aria-busy', 'true');
    try {
      const parents = await call('/api/parent/options');
      if (!view.alive()) return;
      list.replaceChildren(...parents.map((p) => h('li', {}, parentButton(p))));
    } catch (err) {
      if (!view.alive()) return;
      list.replaceChildren(h('li', {}, loadError(err, loadParents)));
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  function parentButton(p) {
    const kids = p.children.length
      ? p.children.map((c) => h('span', { class: 'pick__kid' }, c.name, ' ', h('span', { class: 'pick__school' }, `· ${c.schoolName}`)))
      : [h('span', { class: 'pick__kid muted' }, t('noChildrenYet'))];
    const button = h('button', { type: 'button', class: 'pick' },
      avatar(p.name),
      h('span', { class: 'pick__text' },
        h('span', { class: 'pick__name' }, p.name),
        h('span', { class: 'pick__email' }, p.email),
        ...kids),
      icon('chevron', 'pick__go'));
    button.addEventListener('click', async () => {
      listMsg.replaceChildren();
      const done = busy(button, t('signingIn'));
      try {
        const { parent } = await call('/api/parent/login', { method: 'POST', body: { parentId: p.id } });
        signedIn(parent);
      } catch (err) {
        done();
        if (!view.alive()) return;
        listMsg.replaceChildren(notice('bad', null, errorText(err)));
        if (err.code === 'PARENT_NOT_FOUND') loadParents();
      }
    });
    return button;
  }

  function registerForm() {
    const name = h('input', { id: 'reg-name', name: 'name', autocomplete: 'name', maxlength: '100', required: true });
    const email = h('input', { id: 'reg-email', name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: '254', required: true, 'aria-describedby': 'reg-email-hint', spellcheck: 'false' });
    const msg = h('div', { class: 'form-msg', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, t('createParent'));
    const form = h('form', { class: 'form', novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'reg-name' }, t('yourName')), name),
      h('div', { class: 'field' },
        h('label', { for: 'reg-email' }, t('yourEmail')),
        email,
        h('p', { class: 'hint', id: 'reg-email-hint' }, t('emailHint'))),
      msg,
      submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.replaceChildren();
      const n = name.value.trim();
      const m = email.value.trim();
      if (!n) return fieldError(name, t('errNameRequired'));
      if (!m || !m.includes('@')) return fieldError(email, t('errEmailRequired'));
      const done = busy(submit, t('creating'));
      try {
        const { parent } = await call('/api/parent/register', { method: 'POST', body: { name: n, email: m } });
        signedIn(parent);
      } catch (err) {
        done();
        if (!view.alive()) return;
        const target = err.code === 'NAME_INVALID' ? name : err.code === 'EMAIL_INVALID' || err.code === 'EMAIL_TAKEN' ? email : null;
        if (target) fieldError(target, errorText(err));
        else msg.replaceChildren(notice('bad', null, errorText(err)));
      }
    });

    function fieldError(input, text) {
      input.setAttribute('aria-invalid', 'true');
      msg.replaceChildren(notice('bad', null, text));
      input.focus();
      input.addEventListener('input', () => input.removeAttribute('aria-invalid'), { once: true });
    }
    return form;
  }

  function signedIn(parent) {
    state.parent = parent;
    state.family = null;
    sessionHint.set(true);
    view.go('#/');
  }

  await loadParents();
}
