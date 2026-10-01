// Readable detail objects (differences and the audit log): money in RM, times in KL, yes/no,
// student ids as names, machine types and config kinds in words. Everything is rendered as
// text: details can hold names and notes that people typed.

import { h, formatRM, formatKL } from '/shared/api.js';
import { has, humanKey } from './kit.js';

/** One value, readable. `names` maps member ids to names. */
export function detailValue(ctx, key, value, names = new Map()) {
  const { t } = ctx;
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return t(value ? 'kit.yes' : 'kit.no');
  if (typeof value === 'number' && /Sen$/.test(key)) return formatRM(value);
  if (/At$/.test(key) || key === 'currentSince') {
    if (typeof value === 'number' || (typeof value === 'string' && !Number.isNaN(Date.parse(value)))) return formatKL(value);
  }
  if (key === 'memberId' && typeof value === 'string') {
    return h('a', { href: `#/students/${encodeURIComponent(value)}` }, names.get(value) ?? t('rc.memberPage'));
  }
  if ((key === 'reportedVia' || key === 'via') && has(t, `stateVia.${value}`)) return t(`stateVia.${value}`);
  if (key === 'kind' && has(t, `saleKind.${value}`)) return t(`saleKind.${value}`);
  if (key === 'kind' && has(t, `kind.${value}`)) return t(`kind.${value}`);
  if (key === 'kind' && has(t, `orderKind.${value}`)) return t(`orderKind.${value}`);
  if (key === 'type' && has(t, `devType.${value}`)) return t(`devType.${value}`);
  if (key === 'status' && has(t, `devStatus.${value}`)) return t(`devStatus.${value}`);
  if (key === 'decision' && (value === 'ADDED' || value === 'REFUND')) return t(value === 'ADDED' ? 'tu.markAdded' : 'tu.refund');
  if (key === 'last4' || key === 'card') return h('span', { class: 'mono' }, `••${value}`);
  if (key === 'counts' && value && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, n]) => `${has(t, `rc.count${k}`) ? t(`rc.count${k}`) : k}: ${n}`)
      .join('; ');
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v && typeof v === 'object' && 'txn' in v)) return h('span', { class: 'mono small' }, value.map((v) => v.txn).join(', '));
    if (value.every((v) => typeof v !== 'object')) return value.join(', ');
  }
  if (typeof value === 'object') return h('code', { class: 'small json-inline' }, JSON.stringify(value));
  if (/^(origin|txn|fromTxn|toTxn|deviceCode|device|purchaseId|code|uid)$/.test(key)) return h('span', { class: 'mono' }, String(value));
  return String(value);
}

const label = (t, key) => (has(t, `dk.${key}`) ? t(`dk.${key}`) : humanKey(key));

/** A definition list of every field (differences). */
export function detailList(ctx, detail, names, skip = []) {
  const entries = Object.entries(detail ?? {}).filter(([k]) => !skip.includes(k));
  if (!entries.length) return null;
  return h(
    'dl',
    { class: 'kv' },
    entries.flatMap(([k, v]) => [h('dt', {}, label(ctx.t, k)), h('dd', {}, detailValue(ctx, k, v, names))]),
  );
}

/** One line "Label: value · Label: value" (audit log); ids of rows that are not people stay as they are. */
export function detailInline(ctx, detail, names) {
  const entries = Object.entries(detail ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '—';
  const parts = [];
  for (const [k, v] of entries) {
    if (parts.length) parts.push(' · ');
    parts.push(h('span', { class: 'kv-inline' }, h('span', { class: 'muted' }, `${label(ctx.t, k)}: `), detailValue(ctx, k, v, names)));
  }
  return h('span', {}, parts);
}

/** Who did it, from the audit trail's text: "Name (stf_…)", "parent:par_…", "seed", "system". */
export function actorLabel(t, actor) {
  const text = String(actor ?? '');
  const staff = /^(.*) \((stf_[A-Za-z0-9]+)\)$/.exec(text);
  if (staff) return h('span', { class: 'who' }, h('span', {}, staff[1]), h('span', { class: 'mono muted small' }, staff[2]));
  const parent = /^parent:(par_[A-Za-z0-9]+)$/.exec(text);
  if (parent) return h('span', { class: 'who' }, h('span', {}, t('au.parent')), h('span', { class: 'mono muted small' }, parent[1]));
  if (text === 'seed') return t('au.seed');
  if (text === 'system') return t('au.system');
  return text || '—';
}
