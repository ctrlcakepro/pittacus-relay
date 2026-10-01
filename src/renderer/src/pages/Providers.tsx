import { useMemo, useState } from 'react'
import type { ProviderDraft, ProviderPreset, ProviderView } from '../../../shared/api'
import type { MessageKey } from '../../../shared/i18n'
import type { T } from '../i18n'
import { useI18n } from '../i18n'
import { IconChevron } from '../icons'
import { canUseSystemAuth, PinPrompt, PinSetup } from '../keyGuard'
import { api, Badge, Empty, errMessage, Modal, PageHeader, type PageProps } from '../ui'

export function Providers(props: PageProps) {
  const { state, run, apply } = props
  const { t } = useI18n()
  const [editing, setEditing] = useState<ProviderDraft | 'pick' | null>(null)
  const [copying, setCopying] = useState<{ provider: ProviderView; error?: string } | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)

  // The key itself never reaches this window: the main process verifies and writes the clipboard.
  const copyKey = async (p: ProviderView) => {
    if (!canUseSystemAuth(state.keyGuard)) return setCopying({ provider: p })
    setVerifying(p.id)
    try {
      apply(await api.copyProviderKey(p.id, { system: true }))
    } catch (err) {
      setCopying({ provider: p, error: errMessage(err) })
    } finally {
      setVerifying(null)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={t('nav.providers')}
        sub={t('providers.sub')}
        actions={
          <button className="btn primary" onClick={() => setEditing('pick')}>
            {t('providers.add')}
          </button>
        }
      />

      {state.providers.length === 0 && (
        <Empty title={t('providers.empty')}>{t('providers.emptyHint')}</Empty>
      )}

      <div className="list">
        {state.providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            onEdit={() => setEditing(toDraft(p))}
            onCopyKey={() => copyKey(p)}
            verifying={verifying === p.id}
            onToggle={() => run(() => api.setProviderEnabled(p.id, !p.enabled))}
            onDelete={() => {
              if (confirm(t('providers.deleteConfirm', { name: p.name }))) run(() => api.deleteProvider(p.id))
            }}
          />
        ))}
      </div>

      {copying &&
        (state.keyGuard.pinSet ? (
          <PinPrompt
            title={t('providers.copyTitle', { name: copying.provider.name })}
            intro={t('providers.copyIntro')}
            guard={state.keyGuard}
            initialError={copying.error}
            submitLabel={t('providers.copy')}
            action={(auth) => api.copyProviderKey(copying.provider.id, auth)}
            onDone={(result) => {
              apply(result)
              setCopying(null)
            }}
            onClose={() => setCopying(null)}
          />
        ) : (
          <PinSetup
            guard={state.keyGuard}
            intro={t('providers.copySetupIntro')}
            onDone={(result, pin) => {
              const id = copying.provider.id
              apply(result)
              setCopying(null)
              run(() => api.copyProviderKey(id, { pin }))
            }}
            onClose={() => setCopying(null)}
          />
        ))}

      {editing === 'pick' && (
        <PresetPicker
          presets={state.presets}
          onCancel={() => setEditing(null)}
          onPick={(preset) => setEditing(fromPreset(preset, state.providers, t))}
        />
      )}
      {editing && editing !== 'pick' && (
        <ProviderEditor
          {...props}
          initial={editing}
          onClose={() => setEditing(null)}
          presetKeyUrl={state.presets.find((x) => x.id === editing.presetId)?.keyUrl}
        />
      )}
    </div>
  )
}

function ProviderRow({
  provider: p,
  onEdit,
  onCopyKey,
  verifying,
  onToggle,
  onDelete
}: {
  provider: ProviderView
  onEdit: () => void
  onCopyKey: () => void
  verifying: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  const { t, locale } = useI18n()
  return (
    <section className={`card provider ${p.enabled ? '' : 'disabled'}`}>
      <header className="provider-head">
        <div className="provider-title">
          <div className="row">
            <h2>{p.name}</h2>
            <code className="mono dim">{p.id}/</code>
            {!p.enabled && <Badge>{t('providers.disabled')}</Badge>}
          </div>
          <div className="meta">
            {[
              [p.anthropicBaseUrl && 'Anthropic', p.openaiBaseUrl && 'OpenAI'].filter(Boolean).join(' / '),
              t('providers.modelCount', { count: p.models.length }),
              p.hasKey && t('providers.keyHint', { hint: p.keyHint })
            ]
              .filter(Boolean)
              .join(locale === 'en' ? '  ·  ' : '　·　')}
            {!p.hasKey && <Badge tone="warn">{t('providers.needKey')}</Badge>}
          </div>
        </div>
        <div className="row">
          <button className="btn ghost" disabled={!p.hasKey || verifying} onClick={onCopyKey}>
            {verifying ? t('common.verifying') : t('providers.copyKey')}
          </button>
          <button className="btn ghost" onClick={onToggle}>
            {p.enabled ? t('common.disable') : t('common.enable')}
          </button>
          <button className="btn ghost" onClick={onEdit}>
            {t('common.edit')}
          </button>
          <button className="btn ghost danger" onClick={onDelete}>
            {t('common.delete')}
          </button>
        </div>
      </header>
      {p.models.length > 0 && (
        <div className="chips">
          {p.models.map((m) => (
            <span key={m} className="chip">
              {m}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function PresetPicker({
  presets,
  onPick,
  onCancel
}: {
  presets: ProviderPreset[]
  onPick: (p: ProviderPreset) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  return (
    <Modal title={t('providers.pick')} onClose={onCancel}>
      <div className="preset-grid">
        {presets.map((p) => (
          <button key={p.id} className="preset" onClick={() => onPick(p)}>
            <strong>{presetName(p, t)}</strong>
            <span className="hint">
              {[p.anthropicBaseUrl && 'Anthropic', p.openaiBaseUrl && 'OpenAI'].filter(Boolean).join(' / ') || t('providers.manualUrl')}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

function ProviderEditor({
  initial,
  onClose,
  run,
  notify,
  presetKeyUrl
}: PageProps & { initial: ProviderDraft; onClose: () => void; presetKeyUrl?: string }) {
  const [draft, setDraft] = useState<ProviderDraft>(initial)
  const [available, setAvailable] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState('')
  const [fetching, setFetching] = useState(false)
  const [advanced, setAdvanced] = useState(initial.presetId === 'custom')
  const { t } = useI18n()
  const editing = !!initial.originalId

  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  const allModels = useMemo(() => [...new Set([...draft.models, ...available])], [draft.models, available])
  const shown = allModels.filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
  const toggle = (m: string) =>
    set('models', draft.models.includes(m) ? draft.models.filter((x) => x !== m) : [...draft.models, m])

  const fetchModels = async () => {
    setFetching(true)
    try {
      const ids = await api.fetchModels(draft)
      setAvailable(ids)
      notify(t('providers.fetched', { count: ids.length }))
    } catch (err) {
      notify(t('providers.fetchFailed', { error: errMessage(err) }), 'warn')
    } finally {
      setFetching(false)
    }
  }

  const save = async () => {
    if (await run(() => api.saveProvider(draft))) onClose()
  }

  return (
    <Modal title={editing ? t('providers.editTitle', { name: initial.name }) : t('providers.addTitle', { name: draft.name || t('providers.providerFallback') })} onClose={onClose}>
      <div className="form">
        <div className="field-grid">
          <label>{t('providers.name')}</label>
          <input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} />

          <label>API Key</label>
          <div className="row">
            <input
              className="input"
              type="password"
              autoFocus
              placeholder={editing ? t('providers.keyPlaceholderEdit') : t('providers.keyPlaceholder')}
              value={draft.apiKey ?? ''}
              onChange={(e) => set('apiKey', e.target.value)}
            />
            {presetKeyUrl && (
              <button className="btn ghost" onClick={() => api.openExternal(presetKeyUrl)}>
                {t('providers.getKey')}
              </button>
            )}
          </div>
        </div>

        <button className={`link disclosure ${advanced ? 'open' : ''}`} onClick={() => setAdvanced((v) => !v)}>
          <IconChevron size={14} />
          {t('providers.advanced')}
        </button>
        {advanced && (
          <div className="field-grid">
            <label>{t('providers.prefixId')}</label>
            <input className="input mono" value={draft.id} onChange={(e) => set('id', e.target.value)} />

            <label>{t('providers.anthropicUrl')}</label>
            <input
              className="input mono"
              placeholder={t('providers.anthropicUrlPlaceholder')}
              value={draft.anthropicBaseUrl ?? ''}
              onChange={(e) => set('anthropicBaseUrl', e.target.value)}
            />

            <label>{t('providers.openaiUrl')}</label>
            <input
              className="input mono"
              placeholder="https://…/v1"
              value={draft.openaiBaseUrl ?? ''}
              onChange={(e) => set('openaiBaseUrl', e.target.value)}
            />

            <label>{t('providers.anthropicAuth')}</label>
            <select
              className="input"
              value={draft.anthropicAuth}
              onChange={(e) => set('anthropicAuth', e.target.value as ProviderDraft['anthropicAuth'])}
            >
              <option value="both">{t('providers.authBoth')}</option>
              <option value="x-api-key">{t('providers.authXApiKey')}</option>
              <option value="bearer">{t('providers.authBearer')}</option>
            </select>
          </div>
        )}

        <div className="models-head">
          <h3>
            {t('providers.models')} <span className="dim">· {t('providers.selected', { count: draft.models.length })}</span>
          </h3>
          <div className="row">
            <input className="input narrow" placeholder={t('providers.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="btn" disabled={fetching} onClick={fetchModels}>
              {fetching ? t('providers.fetching') : t('providers.fetch')}
            </button>
          </div>
        </div>
        <div className="model-list">
          {shown.length === 0 && <p className="hint">{t('providers.modelsEmpty')}</p>}
          {shown.map((m) => (
            <label key={m} className="model-item">
              <input type="checkbox" checked={draft.models.includes(m)} onChange={() => toggle(m)} />
              <span className="mono">{m}</span>
            </label>
          ))}
        </div>
        <div className="row">
          <input
            className="input mono"
            placeholder={t('providers.manualModel')}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manual.trim()) {
                set('models', [...new Set([...draft.models, manual.trim()])])
                setManual('')
              }
            }}
          />
          <button
            className="btn ghost"
            disabled={!manual.trim()}
            onClick={() => {
              set('models', [...new Set([...draft.models, manual.trim()])])
              setManual('')
            }}
          >
            {t('common.add')}
          </button>
        </div>

        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={save}>
            {t('common.save')}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function toDraft(p: ProviderView): ProviderDraft {
  return {
    originalId: p.id,
    id: p.id,
    name: p.name,
    presetId: p.presetId,
    anthropicBaseUrl: p.anthropicBaseUrl,
    openaiBaseUrl: p.openaiBaseUrl,
    anthropicAuth: p.anthropicAuth ?? 'both',
    apiKey: '',
    models: p.models,
    enabled: p.enabled
  }
}

function fromPreset(preset: ProviderPreset, existing: ProviderView[], t: T): ProviderDraft {
  const taken = new Set(existing.map((p) => p.id))
  let id = preset.id
  for (let n = 2; taken.has(id); n++) id = `${preset.id}-${n}`
  return {
    id,
    name: preset.id === 'custom' ? '' : presetName(preset, t),
    presetId: preset.id,
    anthropicBaseUrl: preset.anthropicBaseUrl,
    openaiBaseUrl: preset.openaiBaseUrl,
    anthropicAuth: preset.anthropicAuth,
    apiKey: '',
    models: [],
    enabled: true
  }
}

const PRESET_NAMES: Partial<Record<string, MessageKey>> = {
  kimi: 'preset.kimi',
  glm: 'preset.glm',
  qwen: 'preset.qwen',
  custom: 'preset.custom'
}

/** Presets whose display name differs between languages; the rest are brand names. */
function presetName(preset: ProviderPreset, t: T): string {
  const key = PRESET_NAMES[preset.id]
  return key ? t(key) : preset.name
}
