// Contract between the Electron main process and the renderer.
import type { ProviderPreset } from '../core/presets'
import type { ModelEntry } from '../core/router'
import type { AnthropicAuthMode, Provider, RequestLog } from '../core/types'
import type { IntegrationStatus } from '../core/integrations/types'
import type { KeyAuth, SystemAuthKind } from '../core/keyGuard'
import type { TokenUsage, UsageRecord } from '../core/usage'
import type { Accent, ThemePref } from './appearance'
import type { LanguagePref, Locale } from './i18n'

export type {
  ProviderPreset,
  ModelEntry,
  RequestLog,
  IntegrationStatus,
  AnthropicAuthMode,
  KeyAuth,
  SystemAuthKind,
  TokenUsage,
  UsageRecord,
  LanguagePref,
  Locale,
  ThemePref,
  Accent
}

/** A provider as the renderer sees it: the API key never leaves the main process. */
export interface ProviderView extends Omit<Provider, 'apiKey'> {
  hasKey: boolean
  keyHint: string
}

export interface ProviderDraft {
  /** Set when editing; the provider's ID before this edit. */
  originalId?: string
  id: string
  name: string
  presetId?: string
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
  anthropicAuth: AnthropicAuthMode
  /** Empty keeps the stored key when editing. */
  apiKey?: string
  models: string[]
  enabled: boolean
}

export interface AppState {
  baseUrl: string
  port: number
  /** The user's choice, possibly "system". */
  language: LanguagePref
  /** The language the interface is shown in. */
  locale: Locale
  theme: ThemePref
  accent: Accent
  /** Days of usage statistics kept on disk. */
  usageRetentionDays: number
  localKey: string
  gateway: { running: boolean; error?: string }
  providers: ProviderView[]
  models: ModelEntry[]
  defaultModel?: string
  smallModel?: string
  integrations: IntegrationStatus[]
  presets: ProviderPreset[]
  secureStorage: boolean
  startup: StartupState
  keyGuard: KeyGuardState
  /** Problems the user should act on, shown on the overview page. */
  notices: string[]
  logs: RequestLog[]
}

export interface StartupState {
  startHidden: boolean
  launchAtLogin: boolean
  launchAtLoginSupported: boolean
  launchAtLoginNote?: string
}

export interface KeyGuardState {
  /** Copying a provider key needs a PIN to be set first. */
  pinSet: boolean
  pinMinLength: number
  /** Set while too many wrong PINs lock further attempts (epoch ms). */
  lockedUntil?: number
  systemAuthKind?: SystemAuthKind
  /** The OS prompt can be used on this machine right now. */
  systemAuthAvailable: boolean
  /** The user chose to accept the OS prompt in place of the PIN. */
  systemAuthEnabled: boolean
  /** A copied key is wiped from the clipboard after this many seconds. */
  clipboardClearSeconds: number
}

export interface ActionResult {
  state: AppState
  message?: string
  warnings?: string[]
}

export interface RelayApi {
  getState(): Promise<AppState>
  saveProvider(draft: ProviderDraft): Promise<ActionResult>
  deleteProvider(id: string): Promise<ActionResult>
  setProviderEnabled(id: string, enabled: boolean): Promise<ActionResult>
  fetchModels(draft: ProviderDraft): Promise<string[]>
  setDefaults(defaultModel?: string, smallModel?: string): Promise<ActionResult>
  setStartHidden(enabled: boolean): Promise<ActionResult>
  setLaunchAtLogin(enabled: boolean): Promise<ActionResult>
  setLanguage(language: LanguagePref): Promise<ActionResult>
  setTheme(theme: ThemePref): Promise<ActionResult>
  setAccent(accent: Accent): Promise<ActionResult>
  /** Daily per-model totals for the retained period, oldest first. */
  getUsage(): Promise<UsageRecord[]>
  clearUsage(): Promise<ActionResult>
  regenerateKey(): Promise<ActionResult>
  setPort(port: number): Promise<ActionResult>
  applyIntegration(id: string): Promise<ActionResult>
  restoreIntegration(id: string): Promise<ActionResult>
  /** Verifies the user, then copies the provider's API key in the main process. */
  copyProviderKey(id: string, auth: KeyAuth): Promise<ActionResult>
  /** `auth` is required when a PIN is already set. */
  setPin(pin: string, auth?: KeyAuth): Promise<ActionResult>
  removePin(auth: KeyAuth): Promise<ActionResult>
  /** Forgotten PIN: clears it together with every stored provider key. */
  resetPin(): Promise<ActionResult>
  /** Enabling needs the PIN; disabling needs nothing. */
  setSystemAuth(enabled: boolean, auth?: KeyAuth): Promise<ActionResult>
  openExternal(url: string): Promise<void>
  onLog(callback: (log: RequestLog) => void): () => void
  /** Fires when state changes outside the window, e.g. from the tray menu. */
  onState(callback: (state: AppState) => void): () => void
}
