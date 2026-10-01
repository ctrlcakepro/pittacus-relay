import { useState, type ReactNode } from 'react'
import type { ActionResult, KeyAuth, KeyGuardState, SystemAuthKind } from '../../shared/api'
import { useI18n, type T } from './i18n'
import { api, Badge, Card, errMessage, Modal, Switch, type PageProps } from './ui'

const IS_WINDOWS = navigator.userAgent.includes('Windows')

export function systemAuthName(t: T, kind?: SystemAuthKind): string {
  return kind === 'touch-id' ? 'Touch ID' : kind === 'windows-hello' ? 'Windows Hello' : t('keyGuard.systemAuth')
}

export function canUseSystemAuth(g: KeyGuardState): boolean {
  return g.pinSet && g.systemAuthEnabled && g.systemAuthAvailable
}

/** Runs an action that needs the user's PIN (or the OS prompt), keeping errors inside the dialog. */
export function PinPrompt({
  title,
  intro,
  guard,
  allowSystem = true,
  submitLabel,
  initialError,
  action,
  onDone,
  onClose
}: {
  title: string
  intro?: ReactNode
  guard: KeyGuardState
  /** Offer the OS prompt next to the PIN field. */
  allowSystem?: boolean
  submitLabel?: string
  initialError?: string
  action: (auth: KeyAuth) => Promise<ActionResult>
  onDone: (result: ActionResult) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [error, setError] = useState(initialError ?? '')
  const [busy, setBusy] = useState(false)

  const attempt = async (auth: KeyAuth) => {
    setBusy(true)
    setError('')
    try {
      onDone(await action(auth))
    } catch (err) {
      setError(errMessage(err))
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal compact title={title} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (pin) attempt({ pin })
        }}
      >
        {intro && <p className="hint">{intro}</p>}
        <input
          className="input"
          type="password"
          autoFocus
          autoComplete="off"
          placeholder={t('keyGuard.enterPin')}
          aria-label="PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-foot">
          {allowSystem && canUseSystemAuth(guard) && (
            <button type="button" className="btn ghost push-left" disabled={busy} onClick={() => attempt({ system: true })}>
              {t('keyGuard.useSystemShort', { name: systemAuthName(t, guard.systemAuthKind) })}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !pin}>
            {busy ? t('common.verifying') : (submitLabel ?? t('common.confirm'))}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** Sets the first PIN, or changes it after verifying the current one. */
export function PinSetup({
  guard,
  intro,
  onDone,
  onClose
}: {
  guard: KeyGuardState
  intro?: ReactNode
  /** Receives the new PIN so a caller can continue with it (e.g. copy right away). */
  onDone: (result: ActionResult, pin: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const changing = guard.pinSet
  const [current, setCurrent] = useState('')
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const problem =
    [...pin].length < guard.pinMinLength
      ? t('pin.tooShort', { count: guard.pinMinLength })
      : pin !== confirm
        ? t('keyGuard.pinMismatch')
        : ''

  const save = async (auth?: KeyAuth) => {
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      onDone(await api.setPin(pin, auth), pin)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal compact title={changing ? t('keyGuard.changePin') : t('keyGuard.setPin')} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          save(changing ? { pin: current } : undefined)
        }}
      >
        {intro && <p className="hint">{intro}</p>}
        {!changing && <FirstPinNote guard={guard} />}
        <div className="field-grid">
          {changing && (
            <>
              <label htmlFor="pin-current">{t('keyGuard.currentPin')}</label>
              <input
                id="pin-current"
                className="input"
                type="password"
                autoFocus
                autoComplete="off"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </>
          )}
          <label htmlFor="pin-new">{t('keyGuard.newPin')}</label>
          <input
            id="pin-new"
            className="input"
            type="password"
            autoFocus={!changing}
            autoComplete="new-password"
            placeholder={t('keyGuard.newPinPlaceholder', { count: guard.pinMinLength })}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <label htmlFor="pin-confirm">{t('keyGuard.confirmPin')}</label>
          <input
            id="pin-confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-foot">
          {changing && canUseSystemAuth(guard) && (
            <button type="button" className="btn ghost push-left" disabled={busy} onClick={() => save({ system: true })}>
              {t('keyGuard.verifyAndSave', { name: systemAuthName(t, guard.systemAuthKind) })}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || (changing && !current)}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** The first PIN is confirmed with the OS prompt when there is one; otherwise it is first come, first served. */
function FirstPinNote({ guard }: { guard: KeyGuardState }) {
  const { t } = useI18n()
  const name = systemAuthName(t, guard.systemAuthKind)
  return guard.systemAuthAvailable ? (
    <p className="hint">{t('keyGuard.firstPinVerified', { name })}</p>
  ) : (
    <div className="notice warn">{t('keyGuard.firstPinUnverified', { name })}</div>
  )
}

type Dialog = 'setup' | 'remove' | 'enableSystem' | null

export function KeyProtectionCard({ state, run, apply }: PageProps) {
  const { t } = useI18n()
  const g = state.keyGuard
  const [dialog, setDialog] = useState<Dialog>(null)
  const name = systemAuthName(t, g.systemAuthKind)
  const close = () => setDialog(null)
  const done = (result: ActionResult) => {
    apply(result)
    close()
  }

  const reset = () => {
    if (confirm(t('keyGuard.resetConfirm'))) run(api.resetPin)
  }

  return (
    <Card
      className="key-protection"
      title={t('keyGuard.title')}
      actions={g.pinSet ? <Badge tone="ok">{t('keyGuard.pinSet')}</Badge> : <Badge>{t('keyGuard.pinNotSet')}</Badge>}
    >
      <p className="hint">
        {t('keyGuard.hint', { seconds: g.clipboardClearSeconds, windows: IS_WINDOWS ? t('keyGuard.hintWindows') : '' })}
      </p>
      {g.lockedUntil && <div className="notice warn">{t('keyGuard.locked')}</div>}
      {!g.pinSet && !g.systemAuthAvailable && <FirstPinNote guard={g} />}
      <div className="field-grid">
        <label>PIN</label>
        <div className="row wrap">
          <button className="btn" onClick={() => setDialog('setup')}>
            {g.pinSet ? t('keyGuard.changePin') : t('keyGuard.setPin')}
          </button>
          {g.pinSet && (
            <>
              <button className="btn ghost danger" onClick={() => setDialog('remove')}>
                {t('keyGuard.removePin')}
              </button>
              <button className="link" onClick={reset}>
                {t('keyGuard.forgot')}
              </button>
            </>
          )}
        </div>
      </div>
      {g.systemAuthKind && (
        <div className="switches">
          <Switch
            label={t('keyGuard.useSystem', { name })}
            checked={g.systemAuthEnabled}
            disabled={!g.pinSet}
            onChange={(v) => (v ? setDialog('enableSystem') : run(() => api.setSystemAuth(false)))}
            hint={
              !g.pinSet
                ? t('keyGuard.systemNeedsPin', { name })
                : g.systemAuthAvailable
                  ? t('keyGuard.systemAvailable', { name })
                  : t('keyGuard.systemUnavailable', { name })
            }
          />
        </div>
      )}

      {dialog === 'setup' && <PinSetup guard={g} onDone={done} onClose={close} />}
      {dialog === 'remove' && (
        <PinPrompt
          title={t('keyGuard.removePin')}
          intro={t('keyGuard.removeIntro')}
          guard={g}
          submitLabel={t('keyGuard.remove')}
          action={api.removePin}
          onDone={done}
          onClose={close}
        />
      )}
      {dialog === 'enableSystem' && (
        <PinPrompt
          title={t('keyGuard.enableTitle', { name })}
          intro={t('keyGuard.enableIntro', { name })}
          guard={g}
          allowSystem={false}
          submitLabel={t('keyGuard.enable')}
          action={(auth) => api.setSystemAuth(true, auth)}
          onDone={done}
          onClose={close}
        />
      )}
    </Card>
  )
}
