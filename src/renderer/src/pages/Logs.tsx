import { useI18n } from '../i18n'
import { Empty, PageHeader, type PageProps } from '../ui'

export function Logs({ state }: PageProps) {
  const { t, locale } = useI18n()
  const logs = [...state.logs].reverse()
  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale)
  const tokens = new Intl.NumberFormat(locale)
  return (
    <div className="page">
      <PageHeader title={t('nav.logs')} sub={t('logs.sub')} />
      {logs.length === 0 ? (
        <Empty title={t('logs.empty')}>{t('logs.emptyHint')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('logs.time')}</th>
                <th>{t('logs.endpoint')}</th>
                <th>{t('logs.requested')}</th>
                <th>{t('logs.actual')}</th>
                <th>{t('logs.status')}</th>
                <th className="right">{t('logs.tokens')}</th>
                <th className="right">{t('logs.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} title={l.error}>
                  <td className="num dim">{time(l.time)}</td>
                  <td className="mono">
                    {l.endpoint}
                    {l.stream ? ` · ${t('logs.stream')}` : ''}
                  </td>
                  <td className="mono">{l.requestedModel || '—'}</td>
                  <td className="mono">{l.relayModel ?? '—'}</td>
                  <td>
                    <span className={`status ${l.status >= 200 && l.status < 300 ? 'ok' : 'bad'}`}>{l.status}</span>
                    {l.error && <span className="hint"> {l.error}</span>}
                  </td>
                  <td className="num right">
                    {l.usage ? `${tokens.format(l.usage.input)} / ${tokens.format(l.usage.output)}` : <span className="dim">—</span>}
                  </td>
                  <td className="num right">{(l.durationMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
