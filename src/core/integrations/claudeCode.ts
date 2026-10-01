import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '../../shared/i18n'
import { listModels } from '../router'
import { readJsonObject, removeFile, writeJsonObject, type Json } from './jsonFile'
import type { ApplyResult, Integration, IntegrationContext, IntegrationStatus } from './types'

// Every env key Pittacus Relay may set or remove; originals are recorded before the first change.
const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
] as const

interface SavedState {
  version: 1
  hadEnv: boolean
  env: Record<string, string | null>
  modelPicker: unknown
}

export function defaultClaudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(dir, 'settings.json')
}

/**
 * Points Claude Code at Pittacus Relay through ~/.claude/settings.json and fills the
 * /model picker (modelPicker, Claude Code v2.1.242+) with Pittacus Relay's models.
 * Only the keys Pittacus Relay touches are restored, so later user edits survive.
 */
export class ClaudeCodeIntegration implements Integration {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'

  constructor(private readonly settingsPath = defaultClaudeSettingsPath()) {}

  private get statePath(): string {
    return `${this.settingsPath}.pittacus-state.json`
  }

  status(ctx: IntegrationContext): IntegrationStatus {
    let connected = false
    try {
      connected = readJsonObject(this.settingsPath)?.env?.ANTHROPIC_BASE_URL === ctx.baseUrl
    } catch {
      // unreadable settings count as not connected
    }
    const restorable = readJsonObject(this.statePath) !== null
    return { id: this.id, name: this.name, configPath: this.settingsPath, connected, restorable }
  }

  apply(ctx: IntegrationContext): ApplyResult {
    const { cfg, baseUrl } = ctx
    if (!cfg.defaultModel) throw new Error(t('integration.ccNoDefault'))

    const all = listModels(cfg)
    const models = all.filter((m) => m.formats.includes('anthropic'))
    if (!models.length) throw new Error(t('integration.ccNoModels'))

    const settings: Json = readJsonObject(this.settingsPath) ?? {}
    if (!readJsonObject(this.statePath)) {
      const state: SavedState = {
        version: 1,
        hadEnv: 'env' in settings,
        env: Object.fromEntries(ENV_KEYS.map((k) => [k, settings.env?.[k] ?? null])),
        modelPicker: settings.modelPicker ?? null
      }
      writeJsonObject(this.statePath, state as unknown as Json)
    }

    const env: Json = { ...(settings.env ?? {}) }
    env.ANTHROPIC_BASE_URL = baseUrl
    env.ANTHROPIC_AUTH_TOKEN = cfg.localKey
    delete env.ANTHROPIC_API_KEY
    env.ANTHROPIC_MODEL = cfg.defaultModel
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = cfg.defaultModel
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = cfg.defaultModel
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.smallModel ?? cfg.defaultModel
    settings.env = env

    settings.modelPicker = {
      replaceBuiltInOptions: true,
      options: models.map((m) => ({
        model: m.id,
        label: `${m.providerName} · ${m.upstreamModel}`,
        description: 'via Pittacus Relay'
      }))
    }

    writeJsonObject(this.settingsPath, settings)
    return {
      configPath: this.settingsPath,
      modelCount: models.length,
      skipped: all.filter((m) => !m.formats.includes('anthropic')).map((m) => m.id)
    }
  }

  restore(): void {
    const state = readJsonObject(this.statePath) as SavedState | null
    if (!state) throw new Error(t('integration.noRestoreRecord'))

    const settings: Json = readJsonObject(this.settingsPath) ?? {}
    const env: Json = { ...(settings.env ?? {}) }
    for (const key of ENV_KEYS) {
      const original = state.env[key]
      if (original === null || original === undefined) delete env[key]
      else env[key] = original
    }
    if (Object.keys(env).length === 0 && !state.hadEnv) delete settings.env
    else settings.env = env

    if (state.modelPicker === null) delete settings.modelPicker
    else settings.modelPicker = state.modelPicker

    writeJsonObject(this.settingsPath, settings)
    removeFile(this.statePath)
  }
}
