// Shared types. This folder (src/core) must stay free of Electron and native
// modules so the gateway can be reused by other shells (e.g. HarmonyOS Electron).
import type { Accent, ThemePref } from '../shared/appearance'
import type { LanguagePref } from '../shared/i18n'
import type { KeyGuardConfig } from './keyGuard'
import type { TokenUsage } from './usage'

/** How the upstream expects the API key on Anthropic-format requests. */
export type AnthropicAuthMode = 'x-api-key' | 'bearer' | 'both'

export interface Provider {
  /** Slug used as the model prefix, e.g. "kimi" -> "kimi/kimi-k2". */
  id: string
  name: string
  presetId?: string
  /** Value you would put in ANTHROPIC_BASE_URL (Pittacus Relay appends /v1/messages). */
  anthropicBaseUrl?: string
  /** OpenAI-compatible base including the version segment (Pittacus Relay appends /chat/completions). */
  openaiBaseUrl?: string
  /**
   * The OpenAI base also serves /responses natively. Otherwise Responses requests (Codex)
   * are translated to /chat/completions.
   */
  openaiResponses?: boolean
  anthropicAuth?: AnthropicAuthMode
  apiKey: string
  /** Enabled upstream model IDs. */
  models: string[]
  enabled: boolean
}

export interface RelayConfig {
  port: number
  /** The single key agent tools use to talk to Pittacus Relay. */
  localKey: string
  providers: Provider[]
  /** Pittacus Relay model ID ("provider/model") used when a request names an unknown model. */
  defaultModel?: string
  /** Pittacus Relay model ID used for unknown "haiku"-class requests (Claude Code background tasks). */
  smallModel?: string
  /** Start in the tray without opening the main window. */
  startHidden?: boolean
  /** PIN / OS verification required before a provider key may be copied. */
  keyGuard?: KeyGuardConfig
  /** Interface language; absent means follow the OS. */
  language?: LanguagePref
  /** Light or dark interface; absent means follow the OS. */
  theme?: ThemePref
  /** Accent color; absent means Pittacus violet. */
  accent?: Accent
}

export interface ResolvedModel {
  provider: Provider
  /** Model ID sent upstream. */
  upstreamModel: string
  /** Pittacus Relay model ID the request resolved to. */
  relayModel: string
}

export interface RequestLog {
  id: number
  time: number
  endpoint: string
  requestedModel: string
  relayModel?: string
  status: number
  durationMs: number
  stream: boolean
  error?: string
  /** Tokens the upstream reported, when it did. */
  usage?: TokenUsage
}
