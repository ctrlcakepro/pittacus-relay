import { isSafeUpstream } from './security'
import type { Provider } from './types'

type Draft = Pick<Provider, 'apiKey' | 'anthropicBaseUrl' | 'openaiBaseUrl' | 'anthropicAuth'>

/** Fetches the model IDs a provider offers, preferring its OpenAI-compatible listing. */
export async function fetchUpstreamModels(p: Draft, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const attempts: Array<() => Promise<Response>> = []
  if (p.openaiBaseUrl) {
    attempts.push(() =>
      fetchImpl(`${p.openaiBaseUrl!.replace(/\/+$/, '')}/models`, {
        headers: { authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(15000),
        redirect: 'manual'
      })
    )
  }
  if (p.anthropicBaseUrl) {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (p.anthropicAuth !== 'bearer') headers['x-api-key'] = p.apiKey
    if (p.anthropicAuth !== 'x-api-key') headers.authorization = `Bearer ${p.apiKey}`
    attempts.push(() =>
      fetchImpl(`${p.anthropicBaseUrl!.replace(/\/+$/, '')}/v1/models?limit=1000`, {
        headers,
        signal: AbortSignal.timeout(15000),
        redirect: 'manual'
      })
    )
  }
  if (attempts.length === 0) throw new Error('Configure at least one base URL first.')
  for (const url of [p.openaiBaseUrl, p.anthropicBaseUrl]) {
    if (url && !isSafeUpstream(url)) throw new Error(`Refusing to send the API key over plain http: ${url}`)
  }

  let lastError = ''
  for (const attempt of attempts) {
    try {
      const res = await attempt()
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel()
        lastError = `HTTP ${res.status}: the provider redirected; Pittacus Relay does not follow redirects with your API key.`
        continue
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
        continue
      }
      const json = (await res.json()) as { data?: Array<{ id?: unknown }> }
      const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
      if (ids.length) return [...new Set(ids)].sort()
      lastError = 'The provider returned an empty model list.'
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  throw new Error(lastError)
}
