// The lab clock: Kuala Lumpur lab time (ticking locally between refreshes while it runs),
// buttons to move it forward and to run the scheduled jobs, and "reset the demo".

import { formatKL, formatTimeKL, toast } from '/shared/api.js';
import { duration } from './describe.js';
import { setHidden, setText, setTone } from './util.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function createClock(app, root) {
  const { t } = app;
  const title = root.querySelector('#clock-title');
  const dateEl = root.querySelector('.clock__date');
  const timeEl = root.querySelector('.clock__time');
  const zoneEl = root.querySelector('.clock__zone');
  const modeEl = root.querySelector('.clock__mode');
  const noteEl = root.querySelector('.clock__note');
  const resultEl = root.querySelector('.clock__result');
  const offEl = root.querySelector('.clock__off');
  const buttons = [...root.querySelectorAll('[data-advance]')];
  const jobsBtn = root.querySelector('[data-role="jobs"]');
  const resetBtn = root.querySelector('[data-role="reset"]');
  const headerClock = document.getElementById('hdr-clock');

  const dialog = document.getElementById('reset-dialog');
  const confirmBtn = dialog.querySelector('[data-role="confirm"]');
  const cancelBtn = dialog.querySelector('[data-role="cancel"]');

  let base = null; // { now (lab ms), at (performance ms), mode }

  function labNow() {
    if (!base) return null;
    return base.mode === 'real' ? base.now + (performance.now() - base.at) : base.now;
  }

  function tick() {
    const now = labNow();
    if (now === null || document.getElementById('main').classList.contains('is-stale')) return;
    setText(dateEl, formatKL(now).slice(0, 10));
    setText(timeEl, formatTimeKL(now));
    setText(headerClock, `${t('hdr.clock')} ${formatKL(now)}`);
  }
  setInterval(tick, 1000);

  function showResult(text, tone) {
    setText(resultEl, text);
    setTone(resultEl, 'clock__result--', tone);
    setHidden(resultEl, !text);
  }

  const jobsText = (j) =>
    t('clock.jobsResult', { cancelled: j.cancelled ?? 0, refunded: j.refunded ?? 0, parked: j.parked ?? 0, gaps: j.gaps ?? 0, lag: j.lag ?? 0 });

  for (const b of buttons) {
    b.addEventListener('click', async () => {
      const ms = Number(b.dataset.advance);
      const res = await app.call('/api/lab/clock/advance', { ms }, b, t('working'));
      if (!res.ok) return app.fail(res.error);
      if (res.data.clock) base = { now: res.data.clock.now, at: performance.now(), mode: res.data.clock.mode };
      tick();
      const moved = t('clock.moved', { by: duration(ms, t) });
      showResult(`${moved} ${res.data.jobs ? jobsText(res.data.jobs) : t('clock.serverOff')}`, res.data.jobs ? 'good' : 'warn');
    });
  }

  jobsBtn.addEventListener('click', async () => {
    const res = await app.call('/api/lab/jobs/run', {}, jobsBtn, t('working'));
    if (!res.ok) return app.fail(res.error);
    showResult(jobsText(res.data), 'good');
  });

  resetBtn.addEventListener('click', () => {
    setText(dialog.querySelector('#reset-title'), t('reset.title'));
    setText(dialog.querySelector('#reset-text'), t('reset.text'));
    setText(confirmBtn, t('reset.confirm'));
    setText(cancelBtn, t('cancel'));
    dialog.showModal();
    cancelBtn.focus();
  });
  cancelBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => resetBtn.focus());
  confirmBtn.addEventListener('click', async () => {
    app.beforeReset();
    const res = await app.call('/api/lab/reset', {}, confirmBtn, t('working'));
    dialog.close();
    if (!res.ok) return app.fail(res.error);
    showResult('', '');
    toast(t('reset.done'), 'good');
  });

  function update(state) {
    setText(title, t('clock.title'));
    setText(zoneEl, t('clock.kl'));
    setText(noteEl, t('clock.note'));
    if (state?.clock) {
      base = { now: state.clock.now, at: performance.now(), mode: state.clock.mode };
      setText(modeEl, state.clock.mode === 'manual' ? t('clock.manual') : t('clock.running'));
      tick();
    }
    const labels = { [HOUR]: 'clock.h1', [DAY]: 'clock.d1', [15 * DAY]: 'clock.d15' };
    for (const b of buttons) if (!b.hasAttribute('aria-busy')) setText(b, t(labels[b.dataset.advance] ?? 'clock.h1'));
    if (!jobsBtn.hasAttribute('aria-busy')) {
      setText(jobsBtn, t('clock.jobs'));
      jobsBtn.disabled = !state?.server?.up;
    }
    setText(offEl, t('clock.jobsOff'));
    setHidden(offEl, Boolean(state?.server?.up));
    if (!resetBtn.hasAttribute('aria-busy')) setText(resetBtn, t('clock.reset'));
  }

  return { update };
}
