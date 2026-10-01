import { t } from '../shared/i18n'
import type { RelayConfig, Provider, ResolvedModel } from './types'

export type WireFormat = 'anthropic' | 'openai'

export interface ModelEntry {
  id: string
  providerId: string
  providerName: string
  upstreamModel: string
  formats: WireFormat[]
}

export function relayModelId(provider: Provider, model: string): string {
  return `${provider.id}/${model}`
}

export function providerFormats(p: Provider): WireFormat[] {
  const formats: WireFormat[] = []
  if (p.anthropicBaseUrl) formats.push('anthropic')
  if (p.openaiBaseUrl) formats.push('openai')
  return formats
}

export function listModels(cfg: RelayConfig): ModelEntry[] {
  return cfg.providers
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.models.map((m) => ({
        id: relayModelId(p, m),
        providerId: p.id,
        providerName: p.name,
        upstreamModel: m,
        formats: providerFormats(p)
      }))
    )
}

export type Resolution =
  | (ResolvedModel & { ok: true; fallback: boolean })
  | { ok: false; status: number; message: string }

// Claude Code may tag a model with a context suffix such as "[1m]".
function stripSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '')
}

export function resolveModel(cfg: RelayConfig, requested: unknown, need: WireFormat): Resolution {
  if (typeof requested !== 'string' || !requested) {
    return { ok: false, status: 400, message: 'Request body is missing "model".' }
  }
  const wanted = stripSuffix(requested)
  const models = listModels(cfg)

  let entry = models.find((m) => m.id === wanted)
  // Bare upstream names (e.g. "deepseek-chat") work when they are unambiguous.
  if (!entry) {
    const bare = models.filter((m) => m.upstreamModel === wanted)
    if (bare.length === 1) entry = bare[0]
  }

  let fallback = false
  if (!entry) {
    const target = /haiku/i.test(wanted) && cfg.smallModel ? cfg.smallModel : cfg.defaultModel
    entry = target ? models.find((m) => m.id === target) : undefined
    fallback = true
  }
  if (!entry) {
    return {
      ok: false,
      status: 404,
      message: `Model "${requested}" is not enabled in Pittacus Relay and no default model is set.`
    }
  }
  if (!entry.formats.includes(need)) {
    return {
      ok: false,
      status: 400,
      message: `Model "${entry.id}" has no ${need === 'anthropic' ? 'Anthropic' : 'OpenAI'}-compatible endpoint configured.`
    }
  }
  const provider = cfg.providers.find((p) => p.id === entry.providerId)!
  if (!provider.apiKey) {
    return { ok: false, status: 401, message: t('router.keyUnreadable', { name: provider.name }) }
  }
  return { ok: true, provider, upstreamModel: entry.upstreamModel, relayModel: entry.id, fallback }
}
