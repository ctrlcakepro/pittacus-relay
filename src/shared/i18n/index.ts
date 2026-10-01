// Interface strings for every layer: renderer, the main process and src/core.
// Kept free of Electron and the DOM like src/core.
import { en } from './en'
import { zh } from './zh'

export const LOCALES = ['zh-CN', 'en'] as const
export type Locale = (typeof LOCALES)[number]
/** What the user picked; "system" follows the OS language. */
export type LanguagePref = 'system' | Locale
export type MessageKey = keyof typeof zh
export type Params = Record<string, string | number>

/** Each locale's own name, shown untranslated in the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = { 'zh-CN': '简体中文', en: 'English' }

const DICTIONARIES: Record<Locale, Record<string, string | undefined>> = { 'zh-CN': zh, en }

export function isLanguagePref(value: unknown): value is LanguagePref {
  return value === 'system' || (LOCALES as readonly unknown[]).includes(value)
}

/** Chinese system languages (zh, zh-CN, zh-TW, zh-Hans…) get Chinese; everything else English. */
export function resolveLocale(pref: LanguagePref | undefined, systemLanguage: string): Locale {
  if (pref && pref !== 'system') return pref
  return /^zh\b/i.test(systemLanguage) ? 'zh-CN' : 'en'
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const dict = DICTIONARIES[locale]
  const text = (params?.count === 1 ? dict[`${key}_one`] : undefined) ?? dict[key] ?? zh[key] ?? key
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text
}

export function joinList(locale: Locale, items: string[]): string {
  return items.join(translate(locale, 'common.listSep'))
}

// The main process serves a single window, so one process-wide locale is enough for core messages.
let current: Locale = 'zh-CN'

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

/** Translates into the process-wide locale (main process and src/core). */
export function t(key: MessageKey, params?: Params): string {
  return translate(current, key, params)
}
