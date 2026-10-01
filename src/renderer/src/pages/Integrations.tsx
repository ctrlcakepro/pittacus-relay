import type { IntegrationStatus } from '../../../shared/api'
import type { MessageKey } from '../../../shared/i18n'
import { useI18n } from '../i18n'
import { api, Badge, Card, CopyButton, PageHeader, type PageProps } from '../ui'

const NOTES: Record<string, MessageKey[]> = {
  'claude-code': ['integrations.ccNote1', 'integrations.ccNote2', 'integrations.ccNote3'],
  codex: ['integrations.cxNote1', 'integrations.cxNote2', 'integrations.cxNote3'],
  opencode: ['integrations.ocNote1', 'integrations.ocNote2']
}

export function Integrations({ state, run }: PageProps) {
  const { t } = useI18n()
  return (
    <div className="page">
      <PageHeader title={t('nav.integrations')} sub={t('integrations.sub')} />
      {state.integrations.map((i) => (
        <IntegrationCard key={i.id} status={i} run={run} />
      ))}

      <Card title={t('integrations.manualTitle')}>
        <p className="hint">{t('integrations.manualHint')}</p>
        <div className="field-grid">
          <label>{t('integrations.anthropicFormat')}</label>
          <div className="row">
            <code className="mono">{state.baseUrl}</code>
            <CopyButton text={state.baseUrl} />
          </div>
          <label>{t('integrations.openaiFormat')}</label>
          <div className="row">
            <code className="mono">{state.baseUrl}/v1</code>
            <CopyButton text={`${state.baseUrl}/v1`} />
          </div>
          <label>{t('integrations.key')}</label>
          <div className="row">
            <CopyButton text={state.localKey} label={t('integrations.copyLocalKey')} />
          </div>
          <label>{t('integrations.modelName')}</label>
          <span className="hint">{t('integrations.modelNameHint', { example: state.models[0]?.id ?? 'kimi/kimi-k2' })}</span>
        </div>
      </Card>
    </div>
  )
}

function IntegrationCard({ status: s, run }: { status: IntegrationStatus; run: PageProps['run'] }) {
  const { t } = useI18n()
  return (
    <Card
      className={`integration ${s.connected ? 'connected' : ''}`}
      title={
        <span className="row">
          {s.name}
          {s.connected ? <Badge tone="ok">{t('integrations.connected')}</Badge> : <Badge>{t('integrations.notConnected')}</Badge>}
        </span>
      }
      actions={
        <>
          {s.restorable && (
            <button className="btn ghost" onClick={() => run(() => api.restoreIntegration(s.id))}>
              {t('integrations.restore')}
            </button>
          )}
          <button className={`btn ${s.connected ? '' : 'primary'}`} onClick={() => run(() => api.applyIntegration(s.id))}>
            {s.connected ? t('integrations.resync') : t('integrations.connect')}
          </button>
        </>
      }
    >
      <ul className="notes">
        {(NOTES[s.id] ?? []).map((n) => (
          <li key={n}>{t(n)}</li>
        ))}
      </ul>
      <p className="path mono">{s.configPath}</p>
    </Card>
  )
}
