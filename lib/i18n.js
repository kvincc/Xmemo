/**
 * X-note i18n Module
 * Provides runtime language switching beyond what chrome.i18n supports.
 * Falls back to chrome.i18n.getMessage() when not initialized.
 *
 * Usage: xnoteI18n.init(() => { ... }); xnoteI18n.t('key');
 */

const xnoteI18n = (() => {
  const SUPPORTED = { en: 'English', zh_CN: '中文 (简体)' };
  let _messages = {};   // { en: {...}, zh_CN: {...} }
  let _lang = 'en';
  let _initialized = false;

  /**
   * Normalize browser locale to our supported keys.
   * "zh-CN" → "zh_CN", "zh" → "zh_CN", others → "en"
   */
  function normalizeLocale(loc) {
    if (!loc) return 'en';
    const normalized = loc.replace('-', '_');
    if (SUPPORTED[normalized]) return normalized;
    // "zh" or "zh_TW" etc → "zh_CN"
    if (normalized.startsWith('zh')) return 'zh_CN';
    return 'en';
  }

  /**
   * Initialize: read user preference, load message files, then invoke callback.
   */
  async function init(callback) {
    try {
      // 1. Read user language preference from chrome.storage.local
      const result = await new Promise((resolve) => {
        chrome.storage.local.get('xNote_language', resolve);
      });
      _lang = result.xNote_language || normalizeLocale(chrome.i18n.getUILanguage());

      // 2. Load target language + en as fallback
      await loadMessages(_lang);
      if (_lang !== 'en') await loadMessages('en');

      _initialized = true;
    } catch (e) {
      console.error('xnoteI18n init error:', e);
      _initialized = true; // still mark initialized so t() uses fallback
    }
    if (callback) callback(_lang);
  }

  async function loadMessages(lang) {
    if (_messages[lang]) return;
    try {
      const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
      const resp = await fetch(url);
      _messages[lang] = await resp.json();
    } catch (e) {
      console.error(`xnoteI18n: failed to load ${lang} messages`, e);
      _messages[lang] = {};
    }
  }

  /**
   * Translate a message key, with optional substitutions ($1, $2, ...).
   * Before init completes, falls back to chrome.i18n.getMessage().
   */
  function t(key, substitutions) {
    if (!_initialized) {
      return chrome.i18n.getMessage(key, substitutions) || key;
    }
    const entry = _messages[_lang]?.[key] || _messages['en']?.[key];
    if (!entry) return key;
    let msg = entry.message;
    if (substitutions) {
      const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
      subs.forEach((s, i) => {
        msg = msg.replaceAll('$' + (i + 1), s);
      });
    }
    return msg;
  }

  /**
   * Set (or clear) user language preference.
   * Pass null to reset to auto-detect.
   */
  function setLanguage(lang, callback) {
    if (lang) {
      chrome.storage.local.set({ xNote_language: lang }, callback);
    } else {
      chrome.storage.local.remove('xNote_language', callback);
    }
  }

  function getLanguage() {
    return _lang;
  }

  function getSupportedLanguages() {
    return { ...SUPPORTED };
  }

  /**
   * Apply translations to DOM elements with data-i18n, data-i18n-placeholder, data-i18n-title attributes.
   */
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const msg = t(key);
      if (msg && msg !== key) el.textContent = msg;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const msg = t(key);
      if (msg && msg !== key) el.placeholder = msg;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const msg = t(key);
      if (msg && msg !== key) el.title = msg;
    });
    // Set page title if available
    const titleMsg = t('options_title');
    if (titleMsg && titleMsg !== 'options_title') {
      document.title = titleMsg;
    }
  }

  return { init, t, setLanguage, getLanguage, getSupportedLanguages, applyI18n };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.xnoteI18n = xnoteI18n;
}
