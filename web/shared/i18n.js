// English by default, Chinese (中文) available. Each app passes its own dictionary.
// Elements with data-i18n="key" get their text replaced; data-i18n-attr="placeholder:key,title:key2" sets attributes.

const STORAGE_KEY = 'onecard-lab-lang';

export function createI18n(dicts) {
  let lang = 'en';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') lang = saved;
  } catch {
    // storage blocked: stay on English
  }
  const listeners = new Set();

  function t(key, vars) {
    const text = (dicts[lang] && dicts[lang][key]) ?? (dicts.en && dicts.en[key]) ?? key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? `{${name}}`));
  }

  function apply(root = document) {
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    }
  }

  function setLang(next) {
    if (next !== 'en' && next !== 'zh') return;
    lang = next;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // ignore
    }
    apply();
    for (const fn of listeners) fn(lang);
  }

  return {
    t,
    apply,
    setLang,
    get lang() {
      return lang;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** A two-button EN / 中文 switch to drop into a header. */
    switcher() {
      const wrap = document.createElement('div');
      wrap.className = 'lang-switch';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Language');
      for (const [code, label] of [['en', 'EN'], ['zh', '中文']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.setAttribute('aria-pressed', String(code === lang));
        b.addEventListener('click', () => setLang(code));
        wrap.append(b);
      }
      listeners.add((l) => {
        for (const b of wrap.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.textContent === 'EN' ? 'en' : 'zh') === l));
      });
      return wrap;
    },
  };
}
