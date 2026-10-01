// Parents: a parent links to a child with an invitation code from the school, and the office
// approves each request before the parent sees the child or can top up.

import { h, formatKL } from '/shared/api.js';
import { sectionHead, panel, dataTable, loadProblem, openDialog, pill, row } from './kit.js';
import { showInviteCode } from './member.js';

const LINK_TONES = { PENDING: 'warn', APPROVED: 'good', REJECTED: '' };
const INVITE_TONES = { OPEN: 'info', USED: '', REVOKED: '' };

export async function renderParents(ctx, el) {
  const { t, api } = ctx;
  el.append(
    sectionHead({
      title: t('nav.parents'),
      text: t('par.lede'),
      actions: [
        h('button', { type: 'button', class: 'btn btn--primary', onclick: () => newInvite() }, t('par.newInvite')),
        h('button', { type: 'button', class: 'btn btn--small', onclick: () => load() }, t('kit.refresh')),
      ],
    }),
  );
  const pendingBox = h('div', {}, h('p', { class: 'muted' }, t('kit.loading')));
  const decidedBox = h('div');
  const invitesBox = h('div');
  el.append(
    panel(t('par.pending'), h('p', { class: 'muted small' }, t('par.pendingText')), pendingBox),
    panel(t('par.invites'), h('p', { class: 'muted small' }, t('par.invitesText')), invitesBox),
    panel(t('par.decided'), decidedBox),
  );

  let loaded = false;

  async function decide(link, approve) {
    const vars = { parent: link.parentName, email: link.parentEmail, child: link.memberName };
    const done = await openDialog({
      t,
      title: t(approve ? 'par.approveTitle' : 'par.rejectTitle', vars),
      body: h('p', {}, t(approve ? 'par.approveBody' : 'par.rejectBody', vars)),
      confirmLabel: t(approve ? 'par.approve' : 'par.reject'),
      tone: approve ? 'primary' : 'danger',
      focusCancel: !approve,
      action: () => api.post(`/api/admin/links/${encodeURIComponent(link.id)}/${approve ? 'approve' : 'reject'}`),
    });
    if (!done) return;
    ctx.flash(h('strong', {}, t(approve ? 'par.approved' : 'par.rejected', vars)), approve ? 'good' : 'info');
    ctx.refreshBadges();
    load();
  }

  async function newInvite() {
    let members;
    try {
      members = await api.get('/api/admin/members');
    } catch (err) {
      if (!err.handled) ctx.flash(loadProblem(t, err), 'bad');
      return;
    }
    const options = [{ value: '', label: t('par.pickChild') }].concat(
      members
        .filter((m) => m.status === 'ACTIVE')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => ({ value: m.id, label: `${m.name} (${m.memberNo}${m.className ? ` · ${m.className}` : ''})` })),
    );
    let chosen = null;
    const invite = await openDialog({
      t,
      title: t('par.newInviteTitle'),
      body: h('p', {}, t('inv.body')),
      fields: [{ name: 'memberId', label: t('par.child'), type: 'select', required: true, options }],
      confirmLabel: t('inv.confirm'),
      action: (v) => {
        chosen = members.find((m) => m.id === v.memberId);
        return api.post('/api/admin/invites', { memberId: v.memberId });
      },
    });
    if (!invite) return;
    showInviteCode(ctx, invite.code, chosen?.name ?? '—');
    load();
  }

  function draw(links, invites) {
    const pending = links.filter((l) => l.status === 'PENDING');
    const decided = links.filter((l) => l.status !== 'PENDING');
    const pendHead = [t('par.parent'), t('par.child'), t('par.requested'), t('par.decision')];
    ctx.swap(
      pendingBox,
      dataTable({
        label: t('par.pending'),
        head: pendHead,
        empty: t('par.noPending'),
        rows: pending.map((l) =>
          row([
            h('span', { class: 'who' }, h('strong', {}, l.parentName), h('span', { class: 'muted small' }, l.parentEmail)),
            h('a', { href: `#/students/${encodeURIComponent(l.memberId)}` }, l.memberName),
            formatKL(l.createdAt),
            h(
              'div',
              { class: 'row nowrap' },
              h('button', { type: 'button', class: 'btn btn--small btn--primary', onclick: () => decide(l, true) }, t('par.approve')),
              h('button', { type: 'button', class: 'btn btn--small btn--danger', onclick: () => decide(l, false) }, t('par.reject')),
            ),
          ]),
        ),
      }),
    );
    ctx.swap(
      decidedBox,
      dataTable({
        label: t('par.decided'),
        head: [t('par.parent'), t('par.email'), t('par.child'), t('par.status'), t('par.requested')],
        empty: t('par.noDecided'),
        compact: true,
        rows: decided.map((l) => [
          l.parentName,
          h('span', { class: 'small' }, l.parentEmail),
          h('a', { href: `#/students/${encodeURIComponent(l.memberId)}` }, l.memberName),
          pill(t(`linkStatus.${l.status}`), LINK_TONES[l.status] ?? ''),
          formatKL(l.createdAt),
        ]),
      }),
    );
    ctx.swap(
      invitesBox,
      dataTable({
        label: t('par.invites'),
        head: [t('par.code'), t('par.child'), t('par.status'), t('par.created'), t('par.used')],
        empty: t('par.noInvites'),
        compact: true,
        rows: invites.map((i) => [
          h('code', { class: `code-chip${i.status === 'OPEN' ? ' code-chip--open' : ''}` }, i.code),
          h('a', { href: `#/students/${encodeURIComponent(i.memberId)}` }, i.memberName ?? '—'),
          pill(t(`inviteStatus.${i.status}`), INVITE_TONES[i.status] ?? ''),
          formatKL(i.createdAt),
          formatKL(i.usedAt),
        ]),
      }),
    );
  }

  async function load() {
    let links;
    let invites;
    try {
      [links, invites] = await Promise.all([api.get('/api/admin/links'), api.get('/api/admin/invites')]);
    } catch (err) {
      if (ctx.alive() && !loaded) pendingBox.replaceChildren(loadProblem(t, err, load));
      return;
    }
    if (!ctx.alive()) return;
    loaded = true;
    draw(links, invites);
  }

  ctx.poll(15000, load);
  await load();
}
