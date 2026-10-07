import i18next from 'i18next';
import { initI18n } from '../src/renderer/locales/init.ts';

// Reuse the renderer's resource assembly, including its ordered overrides.
// Only the locale initializer's documentElement.lang assignment needs a DOM.
export async function translations(locale) {
  if (!['zh-CN', 'en'].includes(locale)) throw new Error('Use --locale zh-CN|en');
  const previous = globalThis.document;
  globalThis.document = { documentElement: { lang: '' } };
  try { await initI18n(locale); } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
  return (key, values = {}) => {
    if (!i18next.exists(key)) throw new Error(`Missing app locale key: ${key}`);
    return i18next.t(key, { ...values, lng: locale });
  };
}
