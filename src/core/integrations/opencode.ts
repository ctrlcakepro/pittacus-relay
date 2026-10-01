import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '../../shared/i18n'
import { listModels } from '../router'
import { readJsonObject, removeFile, writeJsonObject, type Json } from './jsonFile'
import type { ApplyResult, Integration, IntegrationContext, IntegrationStatus } from './types'

const PROVIDER_KEY = 'pittacus'

interface SavedState {
  version: 1
  hadProviderSection: boolean
  addedSchema: boolean
  provider: unknown
}

export function defaultOpencodeConfigPath(): string {
  const dir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(dir, 'opencode', 'opencode.json')
}

/**
 * Registers Pittacus Relay as an OpenAI-compatible provider in opencode's global config,
 * so every Pittacus Relay model appears in opencode's model list as "pittacus/<id>".
 */
export class OpencodeIntegration implements Integration {
  readonly id = 'opencode'
  readonly name = 'opencode'

  constructor(private readonly configPath = defaultOpencodeConfigPath()) {}

  private get statePath(): string {
    return `${this.configPath}.pittacus-state.json`
  }

  status(ctx: IntegrationContext): IntegrationStatus {
    let connected = false
    try {
      const baseURL = readJsonObject(this.configPath)?.provider?.[PROVIDER_KEY]?.options?.baseURL
      connected = baseURL === `${ctx.baseUrl}/v1`
    } catch {
      // unreadable config counts as not connected
    }
    const restorable = readJsonObject(this.statePath) !== null
    return { id: this.id, name: this.name, configPath: this.configPath, connected, restorable }
  }

  apply(ctx: IntegrationContext): ApplyResult {
    const { cfg, baseUrl } = ctx
    const jsonc = this.configPath.replace(/\.json$/, '.jsonc')
    if (!existsSync(this.configPath) && existsSync(jsonc)) {
      throw new Error(t('integration.ocJsonc', { path: jsonc }))
    }

    const all = listModels(cfg)
    const models = all.filter((m) => m.formats.includes('openai'))
    if (!models.length) throw new Error(t('integration.ocNoModels'))

    const config: Json = readJsonObject(this.configPath) ?? {}
    if (!readJsonObject(this.statePath)) {
      const state: SavedState = {
        version: 1,
        hadProviderSection: 'provider' in config,
        addedSchema: !('$schema' in config),
        provider: config.provider?.[PROVIDER_KEY] ?? null
      }
      writeJsonObject(this.statePath, state as unknown as Json)
    }

    config.$schema ??= 'https://opencode.ai/config.json'
    config.provider = {
      ...(config.provider ?? {}),
      [PROVIDER_KEY]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Pittacus Relay',
        // includeUsage asks for token counts on streamed replies, which the usage statistics rely on.
        options: { baseURL: `${baseUrl}/v1`, apiKey: cfg.localKey, includeUsage: true },
        models: Object.fromEntries(models.map((m) => [m.id, { name: `${m.providerName} · ${m.upstreamModel}` }]))
      }
    }

    writeJsonObject(this.configPath, config)
    return {
      configPath: this.configPath,
      modelCount: models.length,
      skipped: all.filter((m) => !m.formats.includes('openai')).map((m) => m.id)
    }
  }

  restore(): void {
    const state = readJsonObject(this.statePath) as SavedState | null
    if (!state) throw new Error(t('integration.noRestoreRecord'))

    const config: Json = readJsonObject(this.configPath) ?? {}
    const provider: Json = { ...(config.provider ?? {}) }
    if (state.provider === null) delete provider[PROVIDER_KEY]
    else provider[PROVIDER_KEY] = state.provider

    if (Object.keys(provider).length === 0 && !state.hadProviderSection) delete config.provider
    else config.provider = provider
    if (state.addedSchema) delete config.$schema

    writeJsonObject(this.configPath, config)
    removeFile(this.statePath)
  }
}
