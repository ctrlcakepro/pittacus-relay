import { useCallback, useEffect, useState } from 'react'
import type { ActionResult, AppState } from '../../shared/api'
import { HydraMark } from './brand/HydraMark'
import { LocaleProvider, useI18n } from './i18n'
import { IconActivity, IconOverview, IconPlug, IconProviders, IconSettings } from './icons'
import { Integrations } from './pages/Integrations'
import { Logs } from './pages/Logs'
import { Overview } from './pages/Overview'
import { Providers } from './pages/Providers'
import { Settings } from './pages/Settings'
import { api, errMessage, Logo, type Run, type ToastKind } from './ui'

// Inset traffic lights need room above the brand row; Windows/Linux caption buttons sit top-right.
const IS_MAC = navigator.userAgent.includes('Macintosh')

const TABS = [
  { id: 'overview', label: 'nav.overview', Icon: IconOverview },
  { id: 'providers', label: 'nav.providers', Icon: IconProviders },
  { id: 'integrations', label: 'nav.integrations', Icon: IconPlug },
  { id: 'logs', label: 'nav.logs', Icon: IconActivity },
  { id: 'settings', label: 'nav.settings', Icon: IconSettings }
] as const
export type Tab = (typeof TABS)[number]['id']

interface Toast {
  id: number
  text: string
  kind: ToastKind
}

let toastId = 0

export function App() {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    api.getState().then(setState)
    const offLog = api.onLog((log) => setState((s) => s && { ...s, logs: [...s.logs.slice(-199), log] }))
    const offState = api.onState(setState)
    return () => {
      offLog()
      offState()
    }
  }, [])

  useEffect(() => {
    if (state) document.documentElement.lang = state.locale
  }, [state?.locale])

  useEffect(() => {
    if (state) document.documentElement.dataset.accent = state.accent
  }, [state?.accent])

  if (!state) return <Loading />
  return (
    <LocaleProvider locale={state.locale}>
      <Shell state={state} setState={setState} />
    </LocaleProvider>
  )
}

function Loading() {
  const { t } = useI18n()
  return (
    <div className="loading">
      <HydraMark size={88} tile={false} />
      <span>{t('app.starting')}</span>
    </div>
  )
}

function Shell({ state, setState }: { state: AppState; setState: (s: AppState) => void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('overview')
  const [toasts, setToasts] = useState<Toast[]>([])

  const notify = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = ++toastId
    setToasts((list) => [...list, { id, text, kind }])
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), kind === 'ok' ? 4000 : 9000)
  }, [])

  const apply = useCallback(
    (result: ActionResult) => {
      setState(result.state)
      if (result.message) notify(result.message)
      result.warnings?.forEach((w) => notify(w, 'warn'))
    },
    [notify, setState]
  )

  const run: Run = useCallback(
    async (fn) => {
      try {
        apply(await fn())
        return true
      } catch (err) {
        notify(errMessage(err), 'error')
        return false
      }
    },
    [apply, notify]
  )

  const props = { state, run, apply, notify }
  const running = state.gateway.running
  return (
    <div className={`app ${IS_MAC ? 'mac' : ''}`}>
      <aside className="nav">
        <div className="brand">
          <Logo size={20} active={running} />
          <span>Pittacus Relay</span>
        </div>
        <nav className="nav-list">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`nav-item ${tab === id ? 'active' : ''}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              <Icon />
              <span>{t(label)}</span>
              {id === 'providers' && state.providers.length > 0 && <span className="nav-count">{state.providers.length}</span>}
            </button>
          ))}
        </nav>
        <div className={`nav-foot ${running ? 'on' : 'off'}`}>
          <span className="dot" />
          {running ? t('nav.running', { port: state.port }) : t('nav.stopped')}
        </div>
      </aside>
      <main className="main">
        <div className="titlebar" />
        <div className="content">
          {tab === 'overview' && <Overview {...props} goTo={setTab} />}
          {tab === 'providers' && <Providers {...props} />}
          {tab === 'integrations' && <Integrations {...props} />}
          {tab === 'logs' && <Logs {...props} />}
          {tab === 'settings' && <Settings {...props} />}
        </div>
      </main>
      <div className="toasts" role="status">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  )
}
