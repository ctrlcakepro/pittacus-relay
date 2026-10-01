import { useEffect, useState, type ReactNode } from 'react'
import type { ActionResult, AppState } from '../../shared/api'
import { HydraMark } from './brand/HydraMark'
import { useI18n } from './i18n'
import { IconClose } from './icons'

export const api = window.relay

export type Run = (fn: () => Promise<ActionResult>) => Promise<boolean>

export interface PageProps {
  state: AppState
  run: Run
  /** Shows an action's new state, message and warnings (what `run` does on success). */
  apply: (result: ActionResult) => void
  notify: (text: string, kind?: ToastKind) => void
}

export type ToastKind = 'ok' | 'warn' | 'error'

/** Electron wraps IPC errors as "Error invoking remote method 'x': Error: msg". */
export function errMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Sidebar logo; packets run along the mark while the gateway is up. */
export function Logo({ size = 20, active = false }: { size?: number; active?: boolean }) {
  return <HydraMark className="logo" size={size} active={active} hover />
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  )
}

export function Card({
  title,
  actions,
  children,
  className = ''
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <h2>{title}</h2>
        {actions && <div className="row">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n()
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  )
}

export function Switch({
  checked,
  disabled,
  onChange,
  label,
  hint
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: ReactNode
}) {
  return (
    <label className={`switch-row ${disabled ? 'disabled' : ''}`}>
      <span>
        <span className="switch-label">{label}</span>
        {hint && <span className="hint block">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

export function Badge({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'neutral' | 'accent'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  compact = false
}: {
  title: string
  onClose: () => void
  children: ReactNode
  compact?: boolean
}) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${compact ? 'compact' : ''}`} role="dialog" aria-label={title}>
        <header className="card-head">
          <h2>{title}</h2>
          <button className="btn ghost icon-only" onClick={onClose} aria-label={t('common.close')}>
            <IconClose size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
