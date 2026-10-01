import type { ActionResult, AppState, ProviderDraft, ProviderView } from '../shared/api'
import { DEFAULT_ACCENT, isAccent, isThemePref, type Accent, type ThemePref } from '../shared/appearance'
import { getLocale, isLanguagePref, joinList, resolveLocale, setLocale, t, type LanguagePref } from '../shared/i18n'
import { Gateway } from './gateway'
import type { Integration } from './integrations/types'
import {
  checkNewPin,
  formatWait,
  hashPin,
  lockoutMs,
  noSystemAuth,
  PIN_FREE_ATTEMPTS,
  PIN_MIN_LENGTH,
  pinMatches,
  type KeyAuth,
  type KeyGuardConfig,
  type SecretClipboard,
  type SystemAuth
} from './keyGuard'
import { PRESETS } from './presets'
import { listModels } from './router'
import { checkUpstreamUrl, isSafeUpstream, keyMayFollow } from './security'
import { generateLocalKey, type ConfigStore } from './store'
import type { RelayConfig, Provider, RequestLog } from './types'
import { fetchUpstreamModels } from './upstreamModels'
import { USAGE_RETENTION_DAYS, UsageStore, type UsageRecord } from './usage'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** OS "launch at login" registration, supplied by the desktop shell. */
export interface LoginItem {
  readonly supported: boolean
  isEnabled(): boolean
  setEnabled(enabled: boolean): void
  /** Explains why it is unsupported or what the OS still needs from the user. */
  note(): string | undefined
}

export const unsupportedLoginItem: LoginItem = {
  supported: false,
  isEnabled: () => false,
  setEnabled: () => {
    throw new Error(t('svc.launchAtLoginUnsupported'))
  },
  note: () => undefined
}

export interface RelayServiceOptions {
  store: ConfigStore
  integrations: Integration[]
  secureStorage: boolean
  loginItem?: LoginItem
  /** Windows Hello / Touch ID; without it only the PIN is offered. */
  systemAuth?: SystemAuth
  /** Without it, copying provider keys is unavailable. */
  clipboard?: SecretClipboard
  onLog?: (log: RequestLog) => void
  fetchImpl?: typeof fetch
  now?: () => number
  /** Persists usage statistics; without it they last until restart. */
  usageFile?: string
  /** OS language (BCP 47), used while the language preference is "system". */
  systemLanguage?: string
}

/** Everything the UI can do, independent of Electron. */
export class RelayService {
  private cfg: RelayConfig
  private gatewayError?: string
  private readonly store: ConfigStore
  private readonly integrations: Integration[]
  private readonly secureStorage: boolean
  private readonly loginItem: LoginItem
  private readonly fetchImpl: typeof fetch
  private readonly systemAuth: SystemAuth
  private readonly clipboard?: SecretClipboard
  private readonly now: () => number
  /** Serialises PIN checks and OS prompts so parallel calls cannot outrun the lockout. */
  private authChain: Promise<unknown> = Promise.resolve()
  private localKeyReset = false
  private readonly systemLanguage: string
  private readonly usage: UsageStore
  readonly gateway: Gateway

  constructor(opts: RelayServiceOptions) {
    this.store = opts.store
    this.integrations = opts.integrations
    this.secureStorage = opts.secureStorage
    this.loginItem = opts.loginItem ?? unsupportedLoginItem
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.systemAuth = opts.systemAuth ?? noSystemAuth
    this.clipboard = opts.clipboard
    this.now = opts.now ?? Date.now
    // Chinese unless told otherwise, matching the app's original language.
    this.systemLanguage = opts.systemLanguage ?? 'zh-CN'
    this.usage = new UsageStore({ file: opts.usageFile, now: this.now })
    const { config, unreadable } = this.store.load()
    this.cfg = config
    if (!isLanguagePref(this.cfg.language)) this.cfg.language = undefined
    if (!isThemePref(this.cfg.theme) || this.cfg.theme === 'system') this.cfg.theme = undefined
    if (!isAccent(this.cfg.accent) || this.cfg.accent === DEFAULT_ACCENT) this.cfg.accent = undefined
    setLocale(resolveLocale(this.cfg.language, this.systemLanguage))
    this.gateway = new Gateway({
      getConfig: () => this.cfg,
      onLog: (log) => {
        this.usage.record(log)
        opts.onLog?.(log)
      },
      fetchImpl: this.fetchImpl
    })
    if (unreadable.length) {
      // Persist the regenerated local key and push it to connected tools right away.
      this.localKeyReset = unreadable.includes('localKey')
      this.commit('')
    }
  }

  get baseUrl(): string {
    return baseUrlFor(this.cfg.port)
  }

  get startHidden(): boolean {
    return !!this.cfg.startHidden
  }

  get theme(): ThemePref {
    return this.cfg.theme ?? 'system'
  }

  /** Starts the gateway, retrying briefly while a previous instance releases the port. */
  async start(retries = 10, retryDelayMs = 500): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.gateway.start(this.cfg.port)
        this.gatewayError = undefined
        return
      } catch (err) {
        const busy = (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        if (!busy || attempt >= retries) {
          this.gatewayError = portError(err, this.cfg.port)
          return
        }
        await new Promise((r) => setTimeout(r, retryDelayMs))
      }
    }
  }

  stop(): Promise<void> {
    try {
      this.usage.flush()
    } catch {
      // Losing the last few seconds of statistics must not block quitting.
    }
    return this.gateway.stop()
  }

  state(): AppState {
    const ctx = { cfg: this.cfg, baseUrl: this.baseUrl }
    return {
      baseUrl: this.baseUrl,
      port: this.cfg.port,
      language: this.cfg.language ?? 'system',
      locale: getLocale(),
      theme: this.theme,
      accent: this.cfg.accent ?? DEFAULT_ACCENT,
      usageRetentionDays: USAGE_RETENTION_DAYS,
      localKey: this.cfg.localKey,
      gateway: { running: this.gateway.running, error: this.gatewayError },
      providers: this.cfg.providers.map(toView),
      models: listModels(this.cfg),
      defaultModel: this.cfg.defaultModel,
      smallModel: this.cfg.smallModel,
      integrations: this.integrations.map((i) => i.status(ctx)),
      presets: PRESETS,
      secureStorage: this.secureStorage,
      startup: {
        startHidden: this.startHidden,
        launchAtLogin: this.loginItem.supported && this.loginItem.isEnabled(),
        launchAtLoginSupported: this.loginItem.supported,
        launchAtLoginNote: this.loginItem.note()
      },
      keyGuard: {
        pinSet: !!this.guard.pin,
        pinMinLength: PIN_MIN_LENGTH,
        lockedUntil: (this.guard.lockedUntil ?? 0) > this.now() ? this.guard.lockedUntil : undefined,
        systemAuthKind: this.systemAuth.kind,
        systemAuthAvailable: this.systemAuth.available(),
        systemAuthEnabled: !!this.guard.systemAuth,
        clipboardClearSeconds: this.clipboard?.clearAfterSeconds ?? 0
      },
      notices: this.notices(),
      logs: this.gateway.logs()
    }
  }

  private notices(): string[] {
    const notices: string[] = []
    const missing = this.cfg.providers.filter((p) => !p.apiKey).map((p) => p.name)
    if (missing.length) {
      notices.push(t('svc.noticeMissingKeys', { names: joinList(getLocale(), missing) }))
    }
    const insecure = this.cfg.providers
      .filter((p) => [p.anthropicBaseUrl, p.openaiBaseUrl].some((u) => u && !isSafeUpstream(u)))
      .map((p) => p.name)
    if (insecure.length) {
      notices.push(t('svc.noticeInsecure', { names: joinList(getLocale(), insecure) }))
    }
    if (this.localKeyReset) {
      notices.push(t('svc.noticeLocalKeyReset'))
    }
    return notices
  }

  saveProvider(draft: ProviderDraft): ActionResult {
    const id = draft.id.trim().toLowerCase()
    if (!ID_PATTERN.test(id)) throw new Error(t('svc.idPattern'))
    const existing = draft.originalId ? this.findProvider(draft.originalId) : undefined
    if (draft.originalId && !existing) throw new Error(t('svc.providerNotFound', { id: draft.originalId }))
    if (this.cfg.providers.some((p) => p.id === id && p !== existing)) throw new Error(t('svc.idTaken', { id }))

    const anthropicBaseUrl = cleanUrl(draft.anthropicBaseUrl)
    const openaiBaseUrl = cleanUrl(draft.openaiBaseUrl)
    if (!anthropicBaseUrl && !openaiBaseUrl) throw new Error(t('svc.needUrl'))

    const apiKey = draft.apiKey?.trim() || storedKeyFor(existing, { anthropicBaseUrl, openaiBaseUrl })
    if (!apiKey) throw new Error(t('svc.needKey'))

    const provider: Provider = {
      id,
      name: draft.name.trim() || id,
      presetId: draft.presetId,
      anthropicBaseUrl,
      openaiBaseUrl,
      openaiResponses: openaiBaseUrl && draft.openaiResponses ? true : undefined,
      anthropicAuth: draft.anthropicAuth,
      apiKey,
      models: [...new Set(draft.models.map((m) => m.trim()).filter(Boolean))],
      enabled: draft.enabled
    }

    if (existing) {
      if (existing.id !== id) this.renameDefaults(existing.id, id)
      this.cfg.providers = this.cfg.providers.map((p) => (p === existing ? provider : p))
    } else {
      this.cfg.providers = [...this.cfg.providers, provider]
    }
    return this.commit(t('svc.saved', { name: provider.name }))
  }

  deleteProvider(id: string): ActionResult {
    const p = this.findProvider(id)
    if (!p) throw new Error(t('svc.providerNotFound', { id }))
    this.cfg.providers = this.cfg.providers.filter((x) => x !== p)
    return this.commit(t('svc.deleted', { name: p.name }))
  }

  setProviderEnabled(id: string, enabled: boolean): ActionResult {
    const p = this.findProvider(id)
    if (!p) throw new Error(t('svc.providerNotFound', { id }))
    p.enabled = enabled
    return this.commit(t(enabled ? 'svc.enabled' : 'svc.disabled', { name: p.name }))
  }

  fetchModels(draft: ProviderDraft): Promise<string[]> {
    const urls = { anthropicBaseUrl: cleanUrl(draft.anthropicBaseUrl), openaiBaseUrl: cleanUrl(draft.openaiBaseUrl) }
    const existing = draft.originalId ? this.findProvider(draft.originalId) : undefined
    const apiKey = draft.apiKey?.trim() || storedKeyFor(existing, urls)
    if (!apiKey) throw new Error(t('svc.needKeyFirst'))
    return fetchUpstreamModels({ apiKey, ...urls, anthropicAuth: draft.anthropicAuth }, this.fetchImpl)
  }

  setDefaults(defaultModel?: string, smallModel?: string): ActionResult {
    const ids = new Set(listModels(this.cfg).map((m) => m.id))
    for (const m of [defaultModel, smallModel]) {
      if (m && !ids.has(m)) throw new Error(t('svc.modelMissing', { model: m }))
    }
    this.cfg.defaultModel = defaultModel || undefined
    this.cfg.smallModel = smallModel || undefined
    return this.commit(t('svc.defaultsUpdated'))
  }

  setStartHidden(enabled: boolean): ActionResult {
    this.cfg.startHidden = enabled
    this.store.save(this.cfg)
    return {
      state: this.state(),
      message: t(enabled ? 'svc.startHiddenOn' : 'svc.startHiddenOff')
    }
  }

  setLaunchAtLogin(enabled: boolean): ActionResult {
    if (!this.loginItem.supported) throw new Error(this.loginItem.note() ?? t('svc.launchAtLoginUnsupported'))
    this.loginItem.setEnabled(enabled)
    const state = this.state()
    if (state.startup.launchAtLogin !== enabled) throw new Error(t('svc.loginItemRejected'))
    const note = state.startup.launchAtLoginNote
    return {
      state,
      message: t(enabled ? 'svc.launchAtLoginOn' : 'svc.launchAtLoginOff'),
      warnings: enabled && note ? [note] : []
    }
  }

  regenerateKey(): ActionResult {
    this.cfg.localKey = generateLocalKey()
    this.localKeyReset = false
    return this.commit(t('svc.keyRegenerated'))
  }

  async setPort(port: number): Promise<ActionResult> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(t('svc.portRange'))
    const oldPort = this.cfg.port
    if (port === oldPort && this.gateway.running) return { state: this.state() }
    try {
      await this.gateway.start(port)
    } catch (err) {
      await this.start(0)
      throw new Error(portError(err, port))
    }
    this.gatewayError = undefined
    this.cfg.port = port
    return this.commit(t('svc.portSwitched', { port }), baseUrlFor(oldPort))
  }

  setLanguage(language: LanguagePref): ActionResult {
    if (!isLanguagePref(language)) throw new Error(t('svc.unknownLanguage', { language: String(language) }))
    this.cfg.language = language === 'system' ? undefined : language
    setLocale(resolveLocale(this.cfg.language, this.systemLanguage))
    this.store.save(this.cfg)
    return { state: this.state(), message: t('svc.languageChanged') }
  }

  // No toast for appearance changes: the window itself shows the result.
  setTheme(theme: ThemePref): ActionResult {
    if (!isThemePref(theme)) throw new Error(t('svc.unknownTheme', { theme: String(theme) }))
    this.cfg.theme = theme === 'system' ? undefined : theme
    this.store.save(this.cfg)
    return { state: this.state() }
  }

  setAccent(accent: Accent): ActionResult {
    if (!isAccent(accent)) throw new Error(t('svc.unknownAccent', { accent: String(accent) }))
    this.cfg.accent = accent === DEFAULT_ACCENT ? undefined : accent
    this.store.save(this.cfg)
    return { state: this.state() }
  }

  usageRecords(): UsageRecord[] {
    return this.usage.list()
  }

  clearUsage(): ActionResult {
    this.usage.clear()
    return { state: this.state(), message: t('svc.usageCleared') }
  }

  applyIntegration(id: string): ActionResult {
    const integration = this.findIntegration(id)
    const result = integration.apply({ cfg: this.cfg, baseUrl: this.baseUrl })
    const warnings: string[] = []
    if (result.skipped.length) {
      warnings.push(t('svc.skippedModels', { name: integration.name, models: joinList(getLocale(), result.skipped) }))
    }
    if (!this.gateway.running) warnings.push(t('svc.gatewayDown'))
    return {
      state: this.state(),
      message: t('svc.integrationApplied', { name: integration.name, count: result.modelCount, path: result.configPath }),
      warnings
    }
  }

  restoreIntegration(id: string): ActionResult {
    const integration = this.findIntegration(id)
    const warnings = integration.restore() ?? []
    return { state: this.state(), message: t('svc.integrationRestored', { name: integration.name }), warnings }
  }

  copyProviderKey(id: string, auth: KeyAuth): Promise<ActionResult> {
    return this.serial(async () => {
      const clipboard = this.clipboard
      if (!clipboard) throw new Error(t('svc.copyUnsupported'))
      const p = this.findProvider(id)
      if (!p) throw new Error(t('svc.providerNotFound', { id }))
      if (!p.apiKey) throw new Error(t('svc.noStoredKey', { name: p.name }))
      await this.authorize(auth, t('svc.reasonCopyKey', { name: p.name }))
      await clipboard.copy(p.apiKey)
      return {
        state: this.state(),
        message: t('svc.keyCopied', { name: p.name, seconds: clipboard.clearAfterSeconds })
      }
    })
  }

  setPin(pin: string, auth?: KeyAuth): Promise<ActionResult> {
    return this.serial(async () => {
      checkNewPin(pin)
      const changing = !!this.guard.pin
      if (changing) await this.authorize(auth, t('svc.reasonChangePin'))
      else await this.verifyFirstPin()
      this.cfg.keyGuard = { ...this.guard, pin: await hashPin(pin), failures: 0, lockedUntil: undefined }
      this.store.save(this.cfg)
      return { state: this.state(), message: t(changing ? 'svc.pinChanged' : 'svc.pinSet') }
    })
  }

  removePin(auth: KeyAuth): Promise<ActionResult> {
    return this.serial(async () => {
      if (!this.guard.pin) return { state: this.state() }
      await this.authorize(auth, t('svc.reasonRemovePin'))
      this.cfg.keyGuard = undefined
      this.store.save(this.cfg)
      return { state: this.state(), message: t('svc.pinRemoved') }
    })
  }

  /** The way out of a forgotten PIN: the keys it guarded go with it. */
  resetPin(): Promise<ActionResult> {
    return this.serial(async () => {
      this.cfg.keyGuard = undefined
      this.cfg.providers = this.cfg.providers.map((p) => ({ ...p, apiKey: '' }))
      this.store.save(this.cfg)
      return { state: this.state(), message: t('svc.pinReset') }
    })
  }

  setSystemAuth(enabled: boolean, auth?: KeyAuth): Promise<ActionResult> {
    return this.serial(async () => {
      const label = systemAuthLabel(this.systemAuth)
      if (!enabled) {
        if (this.guard.pin) this.cfg.keyGuard = { ...this.guard, systemAuth: false }
        this.store.save(this.cfg)
        return { state: this.state(), message: t('svc.systemAuthOff', { label }) }
      }
      if (!this.guard.pin) throw new Error(t('svc.systemAuthNeedsPinSet', { label }))
      if (!this.systemAuth.available()) throw new Error(t('svc.systemAuthNoDevice', { label }))
      // The OS prompt also accepts the Windows sign-in PIN, so only the app PIN may switch it on.
      if (isSystemAuth(auth)) throw new Error(t('svc.systemAuthEnableNeedsPin', { label }))
      await this.checkPin(auth)
      this.cfg.keyGuard = { ...this.guard, systemAuth: true }
      this.store.save(this.cfg)
      return { state: this.state(), message: t('svc.systemAuthOn', { label }) }
    })
  }

  private get guard(): KeyGuardConfig {
    return this.cfg.keyGuard ?? {}
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.authChain.then(fn, fn)
    this.authChain = next.catch(() => undefined)
    return next
  }

  /** Throws unless `auth` proves the user is present: the PIN, or the OS prompt when enabled. */
  private async authorize(auth: KeyAuth | undefined, reason: string): Promise<void> {
    if (!this.guard.pin) throw new Error(t('svc.setPinFirst'))
    if (!isSystemAuth(auth)) return this.checkPin(auth)
    const label = systemAuthLabel(this.systemAuth)
    if (!this.guard.systemAuth) throw new Error(t('svc.systemAuthNotEnabled', { label }))
    if (!this.systemAuth.available()) throw new Error(t('svc.systemAuthUnavailable', { label }))
    if (!(await this.systemAuth.verify(reason))) throw new Error(t('svc.systemAuthFailed', { label }))
  }

  /**
   * Whoever sets the first PIN can copy every key, so on an unlocked computer that must not
   * be just anyone: the OS prompt confirms it is the signed-in user. Without one (no Windows
   * Hello / Touch ID) the first PIN is trust-on-first-use, which the UI warns about.
   */
  private async verifyFirstPin(): Promise<void> {
    if (!this.systemAuth.available()) return
    const label = systemAuthLabel(this.systemAuth)
    if (!(await this.systemAuth.verify(t('svc.reasonSetPin')))) throw new Error(t('svc.setPinNotVerified', { label }))
  }

  private async checkPin(auth: KeyAuth | undefined): Promise<void> {
    const guard = this.guard
    if (!guard.pin) throw new Error(t('svc.pinNotSet'))
    const now = this.now()
    if ((guard.lockedUntil ?? 0) > now) {
      throw new Error(t('svc.pinLocked', { wait: formatWait(guard.lockedUntil! - now) }))
    }
    const pin = auth && typeof (auth as { pin?: unknown }).pin === 'string' ? (auth as { pin: string }).pin : ''
    if (await pinMatches(pin, guard.pin)) {
      if (guard.failures || guard.lockedUntil) {
        this.cfg.keyGuard = { ...guard, failures: 0, lockedUntil: undefined }
        this.store.save(this.cfg)
      }
      return
    }
    const failures = (guard.failures ?? 0) + 1
    const lock = lockoutMs(failures)
    this.cfg.keyGuard = { ...guard, failures, lockedUntil: lock ? now + lock : undefined }
    this.store.save(this.cfg)
    throw new Error(
      lock
        ? t('svc.pinWrongLocked', { wait: formatWait(lock) })
        : t('svc.pinWrong', { count: PIN_FREE_ATTEMPTS - failures })
    )
  }

  private findProvider(id: string): Provider | undefined {
    return this.cfg.providers.find((p) => p.id === id)
  }

  private findIntegration(id: string): Integration {
    const integration = this.integrations.find((i) => i.id === id)
    if (!integration) throw new Error(t('svc.unknownIntegration', { id }))
    return integration
  }

  private renameDefaults(from: string, to: string): void {
    const rename = (m?: string) => (m?.startsWith(`${from}/`) ? `${to}/${m.slice(from.length + 1)}` : m)
    this.cfg.defaultModel = rename(this.cfg.defaultModel)
    this.cfg.smallModel = rename(this.cfg.smallModel)
  }

  /** Normalises defaults, persists, and re-syncs every connected tool. */
  private commit(message: string, previousBaseUrl = this.baseUrl): ActionResult {
    const models = listModels(this.cfg)
    const ids = new Set(models.map((m) => m.id))
    if (this.cfg.smallModel && !ids.has(this.cfg.smallModel)) this.cfg.smallModel = undefined
    if (this.cfg.defaultModel && !ids.has(this.cfg.defaultModel)) this.cfg.defaultModel = undefined
    if (!this.cfg.defaultModel && models.length) {
      this.cfg.defaultModel = (models.find((m) => m.formats.includes('anthropic')) ?? models[0]).id
    }
    this.store.save(this.cfg)

    const warnings: string[] = []
    const synced: string[] = []
    for (const integration of this.integrations) {
      if (!integration.status({ cfg: this.cfg, baseUrl: previousBaseUrl }).connected) continue
      try {
        integration.apply({ cfg: this.cfg, baseUrl: this.baseUrl })
        synced.push(integration.name)
      } catch (err) {
        warnings.push(t('svc.syncFailed', { name: integration.name, error: (err as Error).message }))
      }
    }
    const suffix = synced.length ? t('svc.syncedSuffix', { names: joinList(getLocale(), synced) }) : ''
    return { state: this.state(), message: message + suffix, warnings }
  }
}

function toView(p: Provider): ProviderView {
  const { apiKey, ...rest } = p
  return { ...rest, hasKey: !!apiKey, keyHint: apiKey ? `••••${apiKey.slice(-4)}` : '' }
}

function isSystemAuth(auth: KeyAuth | undefined): boolean {
  return !!auth && typeof auth === 'object' && (auth as { system?: unknown }).system === true
}

function systemAuthLabel(auth: SystemAuth): string {
  return auth.kind === 'touch-id' ? 'Touch ID' : auth.kind === 'windows-hello' ? 'Windows Hello' : t('svc.systemLabel')
}

function baseUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`
}

function cleanUrl(url?: string): string | undefined {
  const trimmed = url?.trim()
  return trimmed ? checkUpstreamUrl(trimmed) : undefined
}

/** The saved key, but only while the provider still points at origins it was entered for. */
function storedKeyFor(
  existing: Provider | undefined,
  next: Pick<Provider, 'anthropicBaseUrl' | 'openaiBaseUrl'>
): string {
  if (!existing?.apiKey) return ''
  if (!keyMayFollow(existing, next)) {
    throw new Error(t('svc.urlChangedReenterKey'))
  }
  return existing.apiKey
}

function portError(err: unknown, port: number): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EADDRINUSE') return t('svc.portInUse', { port })
  if (code === 'EACCES') return t('svc.portNoPermission', { port })
  return t('svc.gatewayStartFailed', { error: String((err as Error)?.message ?? err) })
}
