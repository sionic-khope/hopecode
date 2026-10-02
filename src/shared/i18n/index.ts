// UI strings in four languages (en, ko, ja, zh-Hans). Shared by main (menus, native dialogs, notifications, agent
// errors) and the renderer. Each process keeps its own current language: main from settings + `app.getLocale()`,
// the renderer from the same settings + the locale main reported. `ko` is the base dictionary; the others are typed
// against its keys, so a missing translation fails typecheck.
import { en } from './en';
import { ja } from './ja';
import { ko } from './ko';
import { zhHans } from './zhHans';
import { LANGUAGES, LANGUAGE_SETTINGS, type Language, type LanguageSetting, type Message, type MessageKey, type MessageParams, type Messages } from './types';

export * from './types';

export const DICTIONARIES: Readonly<Record<Language, Messages>> = { en, ko, ja, 'zh-Hans': zhHans };

/** Each language's own name (the settings menu shows these regardless of the current language). */
export const LANGUAGE_NATIVE_NAMES: Readonly<Record<Language, string>> = {
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  'zh-Hans': '简体中文',
};

export function isLanguage(v: unknown): v is Language {
  return typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
}

export function isLanguageSetting(v: unknown): v is LanguageSetting {
  return typeof v === 'string' && (LANGUAGE_SETTINGS as readonly string[]).includes(v);
}

/** Closest supported language of one BCP 47 locale (`ko-KR` -> ko, `zh-TW` -> zh-Hans); null when none fits. */
export function matchLocale(locale: string): Language | null {
  const base = locale.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  switch (base) {
    case 'en':
      return 'en';
    case 'ko':
      return 'ko';
    case 'ja':
      return 'ja';
    // Simplified is the only Chinese script shipped: every zh locale (Hant included) reads it best.
    case 'zh':
      return 'zh-Hans';
    default:
      return null;
  }
}

/** `settings.language` -> the language to show. 'system' takes the first OS locale that maps; English otherwise. */
export function resolveLanguage(setting: LanguageSetting, systemLocales: string | readonly string[]): Language {
  if (setting !== 'system') return setting;
  for (const locale of typeof systemLocales === 'string' ? [systemLocales] : systemLocales) {
    const lang = matchLocale(locale);
    if (lang) return lang;
  }
  return 'en';
}

let current: Language = 'ko';
const listeners = new Set<(lang: Language) => void>();

export function getLanguage(): Language {
  return current;
}

/** Switches this process's language; listeners run only on a change. */
export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  for (const listener of listeners) listener(lang);
}

export function onLanguageChange(listener: (lang: Language) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const pluralRules = new Map<Language, Intl.PluralRules>();
function pluralCategory(lang: Language, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(lang);
    pluralRules.set(lang, rules);
  }
  return rules.select(count);
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function pick(lang: Language, message: Message, params: MessageParams | undefined): string {
  if (typeof message === 'string') return message;
  const count = typeof params?.count === 'number' ? params.count : Number(params?.count ?? NaN);
  const form = Number.isFinite(count) ? message[pluralCategory(lang, count)] : undefined;
  return form ?? message.other;
}

/** `key` in `lang`, with `{name}` placeholders filled; plural messages pick their form by `params.count`. */
export function translate(lang: Language, key: MessageKey, params?: MessageParams): string {
  const message = DICTIONARIES[lang][key] ?? ko[key];
  return interpolate(pick(lang, message, params), params);
}

/** `key` in the current language. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

// ---------------------------------------------------------------------------
// Dates, numbers and relative times in the current language.

/** Intl locale tag of a language. */
export function intlLocale(lang: Language = current): string {
  return lang;
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), options).format(n);
}

export function formatDate(at: number | Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(), options).format(at);
}

/** `Intl.RelativeTimeFormat` in the current language (`3 minutes ago`, `3분 전`, `昨日`). */
export function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit, numeric: 'always' | 'auto' = 'always'): string {
  return new Intl.RelativeTimeFormat(intlLocale(), { numeric }).format(value, unit);
}
