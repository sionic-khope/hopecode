import { afterEach, describe, expect, it } from 'vitest';
import {
  DICTIONARIES,
  LANGUAGES,
  getLanguage,
  matchLocale,
  resolveLanguage,
  setLanguage,
  t,
  translate,
  type Language,
  type Message,
  type MessageKey,
} from '../../src/shared/i18n';
import { ko } from '../../src/shared/i18n/ko';
import { formatRelativeTime } from '../../src/core/format';
import { describeRepeat } from '../../src/core/schedule';

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Values another language may share with ko: proper nouns / product terms kept as is, and pure placeholder templates.
 * Anything else equal to the Korean text counts as untranslated.
 */
const SAME_AS_KO_ALLOWED: ReadonlySet<MessageKey> = new Set<MessageKey>(['menu.newTaskStart', 'plugins.hooks', 'commit.subject.single']);

function forms(m: Message): string[] {
  return typeof m === 'string' ? [m] : Object.values(m).filter((v): v is string => typeof v === 'string');
}

function placeholders(m: Message): string[] {
  return [...new Set(forms(m).flatMap((s) => [...s.matchAll(PLACEHOLDER)].map((x) => x[1])))].sort();
}

const others = LANGUAGES.filter((l): l is Exclude<Language, 'ko'> => l !== 'ko');

describe('dictionaries', () => {
  const koKeys = Object.keys(ko).sort();

  it.each(others)('%s has exactly the keys of ko', (lang) => {
    expect(Object.keys(DICTIONARIES[lang]).sort()).toEqual(koKeys);
  });

  it.each(LANGUAGES)('%s has no empty value', (lang) => {
    const empty = Object.entries(DICTIONARIES[lang]).filter(([, m]) => forms(m).some((s) => s.trim() === ''));
    expect(empty.map(([k]) => k)).toEqual([]);
  });

  it.each(others)('%s is translated: no Korean copied over, no Hangul left', (lang) => {
    const dict = DICTIONARIES[lang];
    const untranslated = (Object.keys(ko) as MessageKey[]).filter((key) => {
      if (forms(dict[key]).some((s) => HANGUL.test(s))) return true;
      return !SAME_AS_KO_ALLOWED.has(key) && JSON.stringify(dict[key]) === JSON.stringify(ko[key]);
    });
    expect(untranslated).toEqual([]);
  });

  it.each(others)('%s keeps the placeholders of ko', (lang) => {
    const dict = DICTIONARIES[lang];
    const mismatched = (Object.keys(ko) as MessageKey[]).filter(
      (key) => placeholders(dict[key]).join() !== placeholders(ko[key]).join(),
    );
    expect(mismatched).toEqual([]);
  });

  it('plural messages always have an `other` form, and English adds `one` where a count is shown', () => {
    for (const lang of LANGUAGES) {
      for (const [key, m] of Object.entries(DICTIONARIES[lang])) {
        if (typeof m !== 'string') expect(m.other, `${lang} ${key}`).toBeTruthy();
      }
    }
    expect(DICTIONARIES.en['code.lines']).toMatchObject({ one: '{count} line', other: '{count} lines' });
  });
});

describe('translate', () => {
  afterEach(() => setLanguage('ko'));

  it('fills placeholders and leaves unknown ones as they are', () => {
    expect(translate('en', 'runner.switched', { from: 'a', to: 'b', reason: 'x' })).toBe('Switched accounts: a → b (x)');
    expect(translate('ko', 'settings.template.hint')).toContain('{project}');
    expect(translate('en', 'acp.error', { agent: 'Codex' })).toBe('Codex error: {error}');
  });

  it('picks plural forms through Intl.PluralRules', () => {
    expect(translate('en', 'code.lines', { count: 1 })).toBe('1 line');
    expect(translate('en', 'code.lines', { count: 2 })).toBe('2 lines');
    expect(translate('en', 'code.lines', { count: 0 })).toBe('0 lines');
    expect(translate('ko', 'code.lines', { count: 1 })).toBe('1줄');
    expect(translate('ja', 'code.lines', { count: 1 })).toBe('1 行');
    expect(translate('zh-Hans', 'images.count', { count: 3 })).toBe('3 张图片');
    // No count: the `other` form.
    expect(translate('en', 'code.lines')).toBe('{count} lines');
  });

  it('`t` follows setLanguage', () => {
    setLanguage('ja');
    expect(getLanguage()).toBe('ja');
    expect(t('settings.title')).toBe('設定');
    setLanguage('zh-Hans');
    expect(t('settings.title')).toBe('设置');
    setLanguage('en');
    expect(t('settings.title')).toBe('Settings');
  });
});

describe('language resolution', () => {
  it('maps OS locales to the closest supported language', () => {
    expect(matchLocale('ko-KR')).toBe('ko');
    expect(matchLocale('ja')).toBe('ja');
    expect(matchLocale('ja-JP')).toBe('ja');
    expect(matchLocale('zh-CN')).toBe('zh-Hans');
    expect(matchLocale('zh-Hans-CN')).toBe('zh-Hans');
    expect(matchLocale('zh_TW')).toBe('zh-Hans');
    expect(matchLocale('en-GB')).toBe('en');
    expect(matchLocale('fr-FR')).toBeNull();
  });

  it("'system' takes the first locale that maps, else English; an explicit choice wins", () => {
    expect(resolveLanguage('system', 'ko-KR')).toBe('ko');
    expect(resolveLanguage('system', ['fr-FR', 'ja-JP'])).toBe('ja');
    expect(resolveLanguage('system', ['fr-FR', 'de'])).toBe('en');
    expect(resolveLanguage('system', '')).toBe('en');
    expect(resolveLanguage('system', [])).toBe('en');
    expect(resolveLanguage('zh-Hans', 'ko-KR')).toBe('zh-Hans');
  });
});

describe('formatting follows the current language', () => {
  afterEach(() => setLanguage('ko'));
  const now = new Date(2026, 8, 26, 15, 0).getTime();
  const MINUTE = 60_000;

  it('relative times', () => {
    setLanguage('en');
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 3 * MINUTE, now)).toBe('3 minutes ago');
    expect(formatRelativeTime(new Date(2026, 8, 25, 9, 0).getTime(), now)).toBe('yesterday');
    expect(formatRelativeTime(new Date(2026, 8, 3, 12, 0).getTime(), now)).toBe('Sep 3');
    setLanguage('ja');
    expect(formatRelativeTime(new Date(2026, 8, 25, 9, 0).getTime(), now)).toBe('昨日');
    setLanguage('zh-Hans');
    expect(formatRelativeTime(now - 3 * MINUTE, now)).toBe('3分钟前');
  });

  it('schedule repeat labels', () => {
    setLanguage('en');
    expect(describeRepeat({ kind: 'weekly', weekday: 1, time: '10:00' })).toBe('Every Mon 10:00');
    setLanguage('zh-Hans');
    expect(describeRepeat({ kind: 'weekly', weekday: 1, time: '10:00' })).toBe('每周一 10:00');
    setLanguage('ja');
    expect(describeRepeat({ kind: 'daily', time: '09:00' })).toBe('毎日 09:00');
  });
});
