import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '../../shared/i18n'
import { listModels, type ModelEntry } from '../router'
import type { RelayConfig } from '../types'
import { readJsonObject, removeFile, writeJsonObject, type Json } from './jsonFile'
import { readToml, TomlDoc, tomlString, writeToml } from './tomlFile'
import type { ApplyResult, Integration, IntegrationContext, IntegrationStatus } from './types'

const PROVIDER_ID = 'pittacus'
const PROVIDER_TABLE = `model_providers.${PROVIDER_ID}`
// Root keys Pittacus Relay sets; originals are recorded before the first change.
const ROOT_KEYS = ['model_provider', 'model', 'model_catalog_json'] as const
/** Codex compacts history against this; the real window of most supported models is at least this large. */
const CONTEXT_WINDOW = 128_000
const FALLBACK_INSTRUCTIONS =
  'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.'

interface SavedState {
  version: 1
  root: Record<string, string | null>
  providerTable: string | null
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/**
 * Registers Pittacus Relay as a Responses-API provider in ~/.codex/config.toml and lists its
 * models in a model catalog, so they show up in Codex's /model picker. Codex only speaks the
 * Responses API; the gateway translates for upstreams that only serve chat completions.
 */
export class CodexIntegration implements Integration {
  readonly id = 'codex'
  readonly name = 'Codex'
  private readonly configPath: string
  private readonly catalogPath: string

  constructor(private readonly home = defaultCodexHome()) {
    this.configPath = join(home, 'config.toml')
    this.catalogPath = join(home, 'pittacus-models.json')
  }

  private get statePath(): string {
    return `${this.configPath}.pittacus-state.json`
  }

  status(ctx: IntegrationContext): IntegrationStatus {
    let connected = false
    try {
      const doc = readToml(this.configPath)
      connected =
        doc?.stringValue('model_provider') === PROVIDER_ID &&
        doc.stringValue('base_url', PROVIDER_TABLE) === `${ctx.baseUrl}/v1`
    } catch {
      // unreadable config counts as not connected
    }
    const restorable = readJsonObject(this.statePath) !== null
    return { id: this.id, name: this.name, configPath: this.configPath, connected, restorable }
  }

  apply(ctx: IntegrationContext): ApplyResult {
    const { cfg, baseUrl } = ctx
    const all = listModels(cfg)
    const models = all.filter((m) => m.formats.includes('openai'))
    if (!models.length) throw new Error(t('integration.cxNoModels'))

    const doc = readToml(this.configPath) ?? new TomlDoc('')
    if (doc.definedOutsideTable(PROVIDER_TABLE)) {
      throw new Error(t('integration.cxForeign', { path: this.configPath }))
    }
    if (!readJsonObject(this.statePath)) {
      const state: SavedState = {
        version: 1,
        root: Object.fromEntries(ROOT_KEYS.map((k) => [k, doc.rootRaw(k)])),
        providerTable: doc.tableRaw(PROVIDER_TABLE)
      }
      writeJsonObject(this.statePath, state as unknown as Json)
    }

    writeJsonObject(this.catalogPath, { models: this.catalog(models, cfg) })

    const defaultModel = models.find((m) => m.id === cfg.defaultModel) ?? models[0]
    doc.setRootRaw('model_provider', `model_provider = ${tomlString(PROVIDER_ID)}`)
    doc.setRootRaw('model', `model = ${tomlString(defaultModel.id)}`)
    doc.setRootRaw('model_catalog_json', `model_catalog_json = ${tomlString(this.catalogPath)}`)
    doc.removeTable(PROVIDER_TABLE)
    doc.appendTable(
      [
        `[${PROVIDER_TABLE}]`,
        `name = "Pittacus Relay"`,
        `base_url = ${tomlString(`${baseUrl}/v1`)}`,
        `wire_api = "responses"`,
        `experimental_bearer_token = ${tomlString(cfg.localKey)}`,
        // The gateway serves plain HTTP streaming only.
        `supports_websockets = false`
      ].join('\n')
    )
    writeToml(this.configPath, doc)
    return {
      configPath: this.configPath,
      modelCount: models.length,
      skipped: all.filter((m) => !m.formats.includes('openai')).map((m) => m.id)
    }
  }

  restore(): void {
    const state = readJsonObject(this.statePath) as SavedState | null
    if (!state) throw new Error(t('integration.noRestoreRecord'))

    const doc = readToml(this.configPath) ?? new TomlDoc('')
    for (const key of ROOT_KEYS) {
      const original = state.root?.[key]
      if (original === null || original === undefined) doc.removeRoot(key)
      else doc.setRootRaw(key, original)
    }
    doc.removeTable(PROVIDER_TABLE)
    if (state.providerTable) doc.appendTable(state.providerTable)

    writeToml(this.configPath, doc)
    removeFile(this.catalogPath)
    removeFile(this.statePath)
  }

  /**
   * Catalog entries are cloned from a model in Codex's own cache when one is there, so they carry
   * every field this Codex version requires plus its full agent instructions; a minimal entry
   * known to parse is the fallback. Codex drops the whole catalog if any entry fails to parse.
   */
  private catalog(models: ModelEntry[], cfg: RelayConfig): Json[] {
    const template = this.template()
    return models.map((m, i) => {
      const provider = cfg.providers.find((p) => p.id === m.providerId)
      const native = !!provider?.openaiResponses
      const entry: Json = template ? structuredClone(template) : minimalEntry()
      for (const key of ['comp_hash', 'available_access_programs', 'tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort']) {
        delete entry[key]
      }
      Object.assign(entry, {
        slug: m.id,
        display_name: `${m.providerName} · ${m.upstreamModel}`,
        description: 'via Pittacus Relay',
        visibility: 'list',
        supported_in_api: true,
        priority: i,
        availability_nux: null,
        upgrade: null,
        context_window: CONTEXT_WINDOW,
        max_context_window: CONTEXT_WINDOW,
        service_tiers: [],
        additional_speed_tiers: [],
        // Recent Codex accepts only the free-form variant; the gateway offers it to chat models as a one-string function.
        apply_patch_tool_type: 'freeform',
        supports_search_tool: false,
        use_responses_lite: false,
        // Reasoning effort only reaches upstreams that take Responses requests as they are.
        supported_reasoning_levels: native ? REASONING_LEVELS : [],
        default_reasoning_level: native ? 'medium' : null,
        supports_reasoning_summaries: native,
        default_reasoning_summary: 'none'
      })
      return entry
    })
  }

  private template(): Json | undefined {
    try {
      const file = join(this.home, 'models_cache.json')
      if (!existsSync(file)) return undefined
      const cache = JSON.parse(readFileSync(file, 'utf8'))
      const list: Json[] = Array.isArray(cache?.models) ? cache.models : []
      const usable = list.filter((m) => instructionsOf(m) && m.visibility === 'list')
      // Prefer a model without a special tool mode: its instructions describe the ordinary tools.
      const pick = usable.find((m) => !m.tool_mode) ?? usable[0]
      if (!pick) return undefined
      return { ...pick, base_instructions: instructionsOf(pick) }
    } catch {
      return undefined
    }
  }
}

const REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' }
]

function instructionsOf(m: Json): string | undefined {
  const text = m?.base_instructions || m?.model_messages?.instructions_template
  return typeof text === 'string' && text ? text : undefined
}

function minimalEntry(): Json {
  return {
    shell_type: 'shell_command',
    base_instructions: FALLBACK_INSTRUCTIONS,
    support_verbosity: false,
    default_verbosity: null,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: []
  }
}
