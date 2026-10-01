import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { resolveLocale, translate, type Locale, type MessageKey, type Params } from '../../shared/i18n'

export type T = (key: MessageKey, params?: Params) => string

const LocaleContext = createContext<Locale>(resolveLocale('system', navigator.language))

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
}

export function useI18n(): { t: T; locale: Locale } {
  const locale = useContext(LocaleContext)
  return useMemo(() => ({ locale, t: (key, params) => translate(locale, key, params) }), [locale])
}
