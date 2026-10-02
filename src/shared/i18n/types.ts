import type { ko } from './ko';

/** UI languages. `zh-Hans` = Simplified Chinese. */
export const LANGUAGES = ['en', 'ko', 'ja', 'zh-Hans'] as const;
export type Language = (typeof LANGUAGES)[number];
/** `settings.language`: 'system' follows the OS locale (closest supported language, else English). */
export type LanguageSetting = 'system' | Language;
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['system', ...LANGUAGES];

/** Plural message: one form per `Intl.PluralRules` category the language uses; `other` is always required. */
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Message = string | Plural;

/** Every key of the base (`ko`) dictionary. */
export type MessageKey = keyof typeof ko;

/**
 * A translated dictionary: exactly the keys of `ko` (a missing or extra key fails typecheck), and a key that is a
 * plural in `ko` must be a plural in every language.
 */
export type Messages = { [K in MessageKey]: (typeof ko)[K] extends string ? string : Plural };

export type MessageParams = Record<string, string | number>;
