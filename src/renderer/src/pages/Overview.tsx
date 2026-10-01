import { useEffect, useState } from 'react'
import type { Tab } from '../App'
import { useI18n } from '../i18n'
import { UsageCard } from '../usage'
import { api, Badge, Card, CopyButton, PageHeader, type PageProps } from '../ui'

export function Overview({ goTo, ...props }: PageProps & { goTo: (t: Tab) => void }) {
  const { state, run } = props
  const { t } = useI18n()
  const [showKey, setShowKey] = useState(false)
  const [port, setPort] = useState(String(state.port))
  useEffect(() => setPort(String(state.port)), [state.port])

  const connected = state.integrations.some((i) => i.connected)
  const steps = [
    { done: state.providers.length > 0, text: t('start.providers'), tab: 'providers' as Tab },
    { done: !!state.defaultModel, text: t('start.defaultModel'), tab: 'overview' as Tab },
    { done: connected, text: t('start.integrate'), tab: 'integrations' as Tab }
  ]
  const maskedKey = state.localKey.slice(0, 10) + '•'.repeat(16)

  return (
    <div className="page">
      <PageHeader title={t('nav.overview')} />

      {steps.some((s) => !s.done) && (
        <Card title={t('start.title')}>
          <ol className="steps">
            {steps.map((s, i) => (
              <li key={s.text} className={s.done ? 'done' : ''}>
                <span className="check">{s.done ? '✓' : i + 1}</span>
                <span className="step-text">{s.text}</span>
                {!s.done && s.tab !== 'overview' && (
                  <button className="link" onClick={() => goTo(s.tab)}>
                    {t('start.go')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}

      {state.notices.map((n) => (
        <div key={n} className="notice warn">
          {n}
        </div>
      ))}

      {!state.secureStorage && <div className="notice warn">{t('notice.plaintextStorage')}</div>}

      <Card
        title={t('gateway.title')}
        actions={
          state.gateway.running ? <Badge tone="ok">{t('gateway.running')}</Badge> : <Badge tone="warn">{t('gateway.stopped')}</Badge>
        }
      >
        {state.gateway.error && <div className="notice error">{state.gateway.error}</div>}
        <div className="field-grid">
          <label>{t('gateway.url')}</label>
          <div className="row">
            <code className="mono">{state.baseUrl}</code>
            <CopyButton text={state.baseUrl} />
          </div>

          <label>{t('gateway.key')}</label>
          <div className="row wrap">
            <code className="mono">{showKey ? state.localKey : maskedKey}</code>
            <button className="btn ghost" onClick={() => setShowKey((v) => !v)}>
              {showKey ? t('gateway.hide') : t('gateway.show')}
            </button>
            <CopyButton text={state.localKey} />
            <button
              className="btn ghost danger"
              onClick={() => {
                if (confirm(t('gateway.regenerateConfirm'))) run(api.regenerateKey)
              }}
            >
              {t('gateway.regenerate')}
            </button>
          </div>

          <label>{t('gateway.port')}</label>
          <div className="row wrap">
            <input className="input narrow mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
            <button
              className="btn"
              disabled={port === String(state.port) && state.gateway.running}
              onClick={() => run(() => api.setPort(Number(port)))}
            >
              {t('gateway.apply')}
            </button>
            <span className="hint">{t('gateway.portHint')}</span>
          </div>
        </div>
      </Card>

      <Card title={t('models.title')}>
        {state.models.length === 0 ? (
          <p className="hint">{t('models.empty')}</p>
        ) : (
          <div className="field-grid">
            <label>{t('models.main')}</label>
            <div>
              <select
                className="input"
                value={state.defaultModel ?? ''}
                onChange={(e) => run(() => api.setDefaults(e.target.value, state.smallModel))}
              >
                {state.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.providerName} · {m.upstreamModel}
                  </option>
                ))}
              </select>
              <p className="hint">{t('models.mainHint')}</p>
            </div>

            <label>{t('models.small')}</label>
            <div>
              <select
                className="input"
                value={state.smallModel ?? ''}
                onChange={(e) => run(() => api.setDefaults(state.defaultModel, e.target.value || undefined))}
              >
                <option value="">{t('models.sameAsMain')}</option>
                {state.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.providerName} · {m.upstreamModel}
                  </option>
                ))}
              </select>
              <p className="hint">{t('models.smallHint')}</p>
            </div>
          </div>
        )}
      </Card>

      <UsageCard state={state} />
    </div>
  )
}
