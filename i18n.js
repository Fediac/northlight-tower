'use strict';
/* NorthLight Tower: language (i18n) runtime. Loaded right after settings.js, before core.js; the tr_*.js tables load right after this file.
   English is the source language in the code; Turkish lives in translation tables (PO.TR: English key -> original Turkish text).
   PO.lang comes from the persisted `lang` setting ('en' default). ?lang=tr|en in the URL overrides it for this page load only (testing). */
(function (PO) {
const LANGS = ['en', 'tr'];
let lang = 'en';
try { const v = PO.settings && PO.settings.get('lang'); if (LANGS.includes(v)) lang = v; } catch (e) { /* default */ }
try { const u = new URLSearchParams(location.search).get('lang'); if (LANGS.includes(u)) lang = u; } catch (e) { /* */ }
PO.lang = lang;
PO.TR = PO.TR || {};
try { document.documentElement.lang = lang; } catch (e) { /* */ }

const fill = (s, params) => (params ? String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null ? String(params[k]) : m)) : String(s));
// key = the English string; Turkish mode looks it up in PO.TR (missing -> the English key)
PO.t = (key, params) => {
  let s = key == null ? '' : String(key);
  if (PO.lang === 'tr' && Object.prototype.hasOwnProperty.call(PO.TR, s)) s = PO.TR[s];
  return fill(s, params);
};
PO.tn = (n, one, other, params) => PO.t(n === 1 ? one : other, Object.assign({ n }, params));
PO.addTr = obj => { if (obj && typeof obj === 'object') Object.assign(PO.TR, obj); };

// upper/lower case: English rules by default; Turkish rules in Turkish mode or when the text itself has a Turkish-only letter
const TR_ONLY = /[ıİğĞşŞ]/;
const trCase = s => PO.lang === 'tr' || TR_ONLY.test(s);
PO.up = s => { s = String(s == null ? '' : s); return trCase(s) ? s.toLocaleUpperCase('tr-TR') : s.toUpperCase(); };
PO.lower = s => { s = String(s == null ? '' : s); return trCase(s) ? s.toLocaleLowerCase('tr-TR') : s.toLowerCase(); };
PO.locale = () => (PO.lang === 'tr' ? 'tr-TR' : 'en-US');

// static HTML: data-i18n (textContent), data-i18n-title, -placeholder, -aria-label, -tip (the data-tip tooltip attribute)
const ATTRS = [['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria-label', 'aria-label'], ['data-i18n-tip', 'data-tip']];
PO.applyI18n = function (root) {
  root = root || document;
  const all = sel => {
    const out = Array.from(root.querySelectorAll ? root.querySelectorAll(sel) : []);
    if (root.matches && root.matches(sel)) out.unshift(root);
    return out;
  };
  all('[data-i18n]').forEach(el => { const v = PO.t(el.getAttribute('data-i18n')); if (el.textContent !== v) el.textContent = v; });
  ATTRS.forEach(([src, dst]) => all('[' + src + ']').forEach(el => { const v = PO.t(el.getAttribute(src)); if (el.getAttribute(dst) !== v) el.setAttribute(dst, v); }));
};
})(window.PO = window.PO || {});
