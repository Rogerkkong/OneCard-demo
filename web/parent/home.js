// Home: one card per linked child (in any school, each showing its school), the link
// requests still waiting for a school, and "Link a child" with an invitation code.

import {
  call, h, t, state, loadFamily, childKey, childPath, avatar, icon, notice, errorText, loadError, skeleton,
  moneyTiles, schoolLine, cardLine, setTitle, busy, when,
} from './core.js';

const POLL_MS = 20000;

export async function homeView(view) {
  setTitle(t('yourChildren'));
  const balances = new Map(); // childKey -> { data } | { err }
  let shownSig = '';

  const kids = h('div', { class: 'kids', 'aria-busy': 'true' }, skeletonCard(), skeletonCard());
  const pendingBox = h('div', { class: 'pending-box' });
  const summary = h('p', { class: 'muted home__summary' });

  view.main.replaceChildren(
    h('div', { class: 'home' },
      h('div', { class: 'home__main' },
        h('div', { class: 'hello' },
          h('p', { class: 'hello__name' }, t('hello', { name: state.parent.name })),
          h('h1', { tabindex: '-1' }, t('yourChildren')),
          summary),
        kids),
      h('aside', { class: 'home__side' }, pendingBox, linkPanel())),
  );

  async function load({ quiet = false } = {}) {
    try {
      const family = await loadFamily();
      const active = family.children.filter((c) => c.schoolStatus === 'ACTIVE');
      const answers = await Promise.allSettled(
        active.map((c) => call(`/api/parent/children/${encodeURIComponent(c.schoolId)}/${encodeURIComponent(c.memberId)}/balance`)),
      );
      balances.clear();
      active.forEach((c, i) => {
        const a = answers[i];
        balances.set(childKey(c.schoolId, c.memberId), a.status === 'fulfilled' ? { data: a.value } : { err: a.reason });
      });
      if (!view.alive()) return;
      draw(family);
    } catch (err) {
      if (!view.alive() || quiet) return;
      kids.removeAttribute('aria-busy');
      kids.replaceChildren(loadError(err, () => load()));
    }
  }

  function draw(family) {
    // redraw only when something changed, so a refresh never moves the reader's place
    const sig = JSON.stringify([family, [...balances].map(([k, v]) => [k, v.data ?? v.err?.code]), document.documentElement.lang]);
    if (sig === shownSig) return;
    shownSig = sig;
    kids.removeAttribute('aria-busy');

    const schools = new Set(family.children.map((c) => c.schoolId));
    const count = family.children.length;
    summary.textContent =
      schools.size > 1 ? t('kidsInSchools', { kids: count, schools: schools.size })
        : count > 1 ? t('kidsAtSchool', { kids: count, school: family.children[0].schoolName })
          : '';
    summary.hidden = !summary.textContent;

    if (!family.children.length) {
      kids.replaceChildren(
        h('div', { class: 'panel empty' },
          icon('person', 'empty__icon'),
          h('h2', {}, t('noChildrenTitle')),
          h('p', { class: 'muted' }, t(family.links.some((l) => l.status === 'PENDING') ? 'noChildrenPending' : 'noChildrenText'))),
      );
    } else {
      kids.replaceChildren(...family.children.map(kidCard));
    }
    drawPending(family.links);
  }

  function kidCard(c) {
    const b = balances.get(childKey(c.schoolId, c.memberId));
    let money;
    if (c.schoolStatus !== 'ACTIVE' || b?.err?.code === 'SCHOOL_SUSPENDED') {
      money = notice('warn', null, t('schoolPausedShort'));
    } else if (b?.data) {
      money = moneyTiles(b.data, { compact: true });
    } else if (b?.err) {
      money = notice('warn', null, errorText(b.err));
    } else {
      money = skeleton(2);
    }
    return h('article', { class: 'panel kid' },
      h('div', { class: 'kid__head' },
        avatar(c.name),
        h('div', { class: 'kid__who' },
          h('h2', { class: 'kid__name' }, h('a', { class: 'kid__link', href: childPath(c) }, c.name)),
          schoolLine(c.schoolName),
          c.className ? h('p', { class: 'kid__class' }, t('classOf', { name: c.className })) : null)),
      money,
      h('div', { class: 'kid__foot' },
        cardLine(c.card),
        h('span', { class: 'kid__open', 'aria-hidden': 'true' }, t('open'), icon('chevron'))));
  }

  function drawPending(links) {
    const waiting = links.filter((l) => l.status !== 'APPROVED');
    if (!waiting.length) {
      pendingBox.replaceChildren();
      return;
    }
    pendingBox.replaceChildren(
      h('section', { class: 'panel pending', 'aria-labelledby': 'pending-h' },
        h('h2', { id: 'pending-h' }, t('pendingTitle')),
        h('p', { class: 'muted' }, t('pendingText')),
        h('ul', { class: 'pending__list' },
          ...waiting.map((l) =>
            h('li', { class: 'pending__item' },
              avatar(l.name, 'avatar--small'),
              h('div', { class: 'pending__who' },
                h('p', { class: 'pending__name' }, l.name),
                schoolLine(l.schoolName),
                h('p', { class: 'pending__when' }, t('sentOn', { time: when(l.createdAt) })),
                l.status === 'REJECTED' ? h('p', { class: 'pending__why' }, t('rejectedText')) : null),
              h('span', { class: `pill ${l.status === 'REJECTED' ? 'pill--bad' : 'pill--warn'}` },
                t(l.status === 'REJECTED' ? 'rejectedStatus' : 'pendingStatus')))))),
    );
  }

  function linkPanel() {
    const input = h('input', {
      id: 'invite-code', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
      maxlength: '20', 'aria-describedby': 'invite-hint', placeholder: t('codePlaceholder'), class: 'code-input',
    });
    const msg = h('div', { class: 'form-msg', role: 'alert' });
    const done = h('div', { class: 'form-msg', role: 'status', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, icon('link'), t('linkSubmit'));
    const form = h('form', { class: 'form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'invite-code' }, t('codeLabel')),
        input),
      msg,
      submit,
      done);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.replaceChildren();
      done.replaceChildren();
      const code = input.value.trim();
      if (!code) {
        input.setAttribute('aria-invalid', 'true');
        msg.replaceChildren(notice('bad', null, t('errCodeRequired')));
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
      const restore = busy(submit, t('linkSending'));
      try {
        const known = new Set((state.family?.links ?? []).map((l) => l.linkId));
        const { link } = await call('/api/parent/invites/redeem', { method: 'POST', body: { code } });
        restore();
        if (!view.alive()) return;
        input.value = '';
        await load({ quiet: true });
        const mine = state.family?.links.find((l) => l.linkId === link.id);
        const vars = { child: link.memberName, school: mine?.schoolName ?? '' };
        const text = known.has(link.id) ? t('linkAgain', vars) : t('linkSent', vars);
        done.replaceChildren(notice('good', null, text));
      } catch (err) {
        restore();
        if (!view.alive()) return;
        input.setAttribute('aria-invalid', 'true');
        msg.replaceChildren(notice('bad', null, errorText(err)));
        input.focus();
      }
    });
    return h('section', { class: 'panel linkbox', 'aria-labelledby': 'link-h' },
      h('h2', { id: 'link-h' }, icon('link'), t('linkTitle')),
      h('p', { class: 'muted', id: 'invite-hint' }, t('linkText')),
      form);
  }

  await load();
  view.poll(POLL_MS, () => load({ quiet: true }));
}

function skeletonCard() {
  return h('div', { class: 'panel kid kid--loading', 'aria-hidden': 'true' }, skeleton(2), h('div', { class: 'money money--compact' }, h('div', { class: 'tile skel-tile' }), h('div', { class: 'tile skel-tile' })));
}
