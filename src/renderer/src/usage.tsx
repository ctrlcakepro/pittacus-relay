import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppState, Locale, UsageRecord } from '../../shared/api'
import { useI18n } from './i18n'
import { api, Card } from './ui'

const RANGES = [1, 7, 30] as const
type Range = (typeof RANGES)[number]

interface Totals {
  requests: number
  errors: number
  metered: number
  input: number
  output: number
  cached: number
}

const zero = (): Totals => ({ requests: 0, errors: 0, metered: 0, input: 0, output: 0, cached: 0 })

function add(into: Totals, r: Totals): Totals {
  into.requests += r.requests
  into.errors += r.errors
  into.metered += r.metered
  into.input += r.input
  into.output += r.output
  into.cached += r.cached
  return into
}

/** Same format as the main process: the local calendar day. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function lastDays(n: number): string[] {
  const today = new Date()
  return Array.from({ length: n }, (_, i) => localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i))))
}

function formatters(locale: Locale) {
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const full = new Intl.NumberFormat(locale)
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
  return { compact: (n: number) => compact.format(n), full: (n: number) => full.format(n), pct: (n: number) => pct.format(n) }
}

/** Token usage per day and model, refreshed as requests come in. */
export function UsageCard({ state }: { state: AppState }) {
  const { t, locale } = useI18n()
  const [range, setRange] = useState<Range>(7)
  const [records, setRecords] = useState<UsageRecord[]>([])
  const lastLogId = state.logs.at(-1)?.id

  // A streaming reply logs once it ends; a short delay folds bursts into one fetch.
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => api.getUsage().then((r) => alive && setRecords(r)), lastLogId === undefined ? 0 : 600)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [lastLogId])

  const days = useMemo(() => lastDays(range), [range, records])
  const { totals, byModel, daily } = useMemo(() => {
    const first = days[0]
    const inRange = records.filter((r) => r.day >= first)
    const models = new Map<string, Totals>()
    const perDay = new Map<string, Totals>(days.map((d) => [d, zero()]))
    for (const r of inRange) {
      models.set(r.model, add(models.get(r.model) ?? zero(), r))
      const day = perDay.get(r.day)
      if (day) add(day, r)
    }
    return {
      totals: inRange.reduce(add, zero()),
      byModel: [...models.entries()].sort(
        (a, b) => b[1].input + b[1].output - (a[1].input + a[1].output) || b[1].requests - a[1].requests
      ),
      daily: days.map((d) => ({ day: d, ...perDay.get(d)! }))
    }
  }, [records, days])

  const f = formatters(locale)
  const unmetered = totals.requests - totals.metered

  return (
    <Card
      className="usage"
      title={t('usage.title')}
      actions={
        <div className="segmented" role="group" aria-label={t('usage.range')}>
          {RANGES.map((r) => (
            <button key={r} className={r === range ? 'active' : ''} aria-pressed={r === range} onClick={() => setRange(r)}>
              {r === 1 ? t('usage.today') : t('usage.days', { count: r })}
            </button>
          ))}
        </div>
      }
    >
      <div className="stats">
        <Stat label={t('usage.requests')} value={f.full(totals.requests)}>
          {totals.errors > 0 && t('usage.errorRate', { pct: f.pct(totals.errors / totals.requests) })}
        </Stat>
        <Stat label={t('usage.input')} value={f.compact(totals.input)} title={f.full(totals.input)} />
        <Stat label={t('usage.output')} value={f.compact(totals.output)} title={f.full(totals.output)} />
        <Stat label={t('usage.cached')} value={f.compact(totals.cached)} title={f.full(totals.cached)}>
          {totals.input > 0 && t('usage.cachedShare', { pct: f.pct(totals.cached / totals.input) })}
        </Stat>
      </div>

      {totals.requests === 0 ? (
        <p className="hint usage-empty">{t('usage.empty')}</p>
      ) : (
        <>
          {range > 1 && <DailyChart daily={daily} format={f} />}
          <div className="table-wrap usage-table">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('usage.model')}</th>
                  <th className="right">{t('usage.requests')}</th>
                  <th className="right">{t('usage.input')}</th>
                  <th className="right">{t('usage.output')}</th>
                  <th className="right">{t('usage.cached')}</th>
                  <th className="right">{t('usage.errors')}</th>
                </tr>
              </thead>
              <tbody>
                {byModel.map(([model, m]) => (
                  <tr key={model}>
                    <td className="mono">{model}</td>
                    <td className="num right">{f.full(m.requests)}</td>
                    <td className="num right" title={f.full(m.input)}>
                      {f.compact(m.input)}
                    </td>
                    <td className="num right" title={f.full(m.output)}>
                      {f.compact(m.output)}
                    </td>
                    <td className="num right" title={f.full(m.cached)}>
                      {f.compact(m.cached)}
                    </td>
                    <td className={`num right ${m.errors ? 'bad' : 'dim'}`}>{f.full(m.errors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {unmetered > 0 && <p className="hint">{t('usage.unmetered', { count: unmetered })}</p>}
      <p className="hint">{t('usage.note')}</p>
    </Card>
  )
}

function Stat({ label, value, title, children }: { label: string; value: string; title?: string; children?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value num" title={title}>
        {value}
      </span>
      <span className="stat-sub">{children}</span>
    </div>
  )
}

type Daily = Totals & { day: string }

/** One bar per day; hovering a column shows that day's numbers. */
function DailyChart({ daily, format }: { daily: Daily[]; format: ReturnType<typeof formatters> }) {
  const { t } = useI18n()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...daily.map((d) => d.input + d.output), 1)
  const labelAt = new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])
  const h = hover === null ? null : daily[hover]

  return (
    <figure className="chart" aria-label={t('usage.chartAria', { count: daily.length })}>
      <figcaption className="chart-title">{t('usage.daily')}</figcaption>
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <span className="chart-max num">{format.compact(max)}</span>
        <div className="chart-bars">
          {daily.map((d, i) => {
            const total = d.input + d.output
            return (
              <div key={d.day} className={`chart-col ${hover === i ? 'hover' : ''}`} onMouseEnter={() => setHover(i)}>
                {total > 0 && <div className="chart-bar" style={{ height: `${Math.max((total / max) * 100, 1.5)}%` }} />}
              </div>
            )
          })}
        </div>
        {h && hover !== null && (
          <div
            className="chart-tip"
            role="tooltip"
            style={{ left: `${((hover + 0.5) / daily.length) * 100}%` }}
            data-edge={hover < daily.length * 0.2 ? 'start' : hover > daily.length * 0.8 ? 'end' : undefined}
          >
            <strong>{h.day}</strong>
            <span>{t('usage.tooltipRequests', { count: h.requests })}</span>
            <span>
              {t('usage.input')} <b className="num">{format.full(h.input)}</b>
            </span>
            <span>
              {t('usage.output')} <b className="num">{format.full(h.output)}</b>
            </span>
          </div>
        )}
      </div>
      <div className="chart-axis">
        {daily.map((d, i) => (
          <span key={d.day}>{labelAt.has(i) ? d.day.slice(5) : ''}</span>
        ))}
      </div>
    </figure>
  )
}
