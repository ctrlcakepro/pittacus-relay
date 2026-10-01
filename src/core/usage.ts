// Token usage: read from upstream responses as they stream through, summed per day and model.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { PRIVATE_FILE_MODE, restrictToOwner } from './security'
import type { RequestLog } from './types'

export interface TokenUsage {
  /** All prompt tokens, cache reads and writes included. */
  input: number
  output: number
  /** The part of `input` served from the provider's prompt cache. */
  cached: number
}

export interface UsageRecord extends TokenUsage {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  /** Pittacus Relay model ID, or the requested name when it never resolved. */
  model: string
  requests: number
  errors: number
  /** Requests whose response carried a usage field; the rest only count as requests. */
  metered: number
}

export const USAGE_RETENTION_DAYS = 90
// A non-streaming body larger than this is passed through but not parsed for usage.
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_SSE_LINE = 1024 * 1024

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/** Normalises an Anthropic or OpenAI `usage` object; undefined when it is neither. */
function readUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const o = u as Record<string, any>
  if ('input_tokens' in o || 'output_tokens' in o) {
    // Anthropic reports cache reads and writes apart from input_tokens.
    const cacheRead = count(o.cache_read_input_tokens)
    return {
      input: count(o.input_tokens) + cacheRead + count(o.cache_creation_input_tokens),
      output: count(o.output_tokens),
      cached: cacheRead
    }
  }
  if ('prompt_tokens' in o || 'completion_tokens' in o) {
    // OpenAI counts cached tokens inside prompt_tokens; DeepSeek names them prompt_cache_hit_tokens.
    return {
      input: count(o.prompt_tokens),
      output: count(o.completion_tokens),
      cached: count(o.prompt_tokens_details?.cached_tokens) || count(o.prompt_cache_hit_tokens)
    }
  }
  return undefined
}

/** Usage carried by a response body or one SSE event (Anthropic's message_start nests it). */
export function usageFromPayload(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, any>
  return readUsage(p.usage) ?? readUsage(p.message?.usage)
}

/**
 * Watches a response body without altering it. Streaming usage arrives cumulatively
 * (Anthropic: input in message_start, output in message_delta), so each field keeps its maximum.
 */
export class UsageTap {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private bytes = 0
  private found?: TokenUsage

  constructor(private readonly sse: boolean) {}

  push(chunk: Buffer): void {
    if (this.sse) {
      const lines = (this.buffer + this.decoder.write(chunk)).split('\n')
      this.buffer = lines.pop() ?? ''
      if (this.buffer.length > MAX_SSE_LINE) this.buffer = ''
      for (const line of lines) this.line(line)
    } else {
      this.bytes += chunk.length
      if (this.bytes <= MAX_JSON_BYTES) this.buffer += this.decoder.write(chunk)
      else this.buffer = ''
    }
  }

  result(): TokenUsage | undefined {
    const rest = this.buffer + this.decoder.end()
    this.buffer = ''
    if (this.sse) this.line(rest)
    else if (rest) this.merge(parse(rest))
    return this.found
  }

  private line(raw: string): void {
    const line = raw.trimEnd()
    if (!line.startsWith('data:') || !line.includes('"usage"')) return
    this.merge(parse(line.slice(5).trim()))
  }

  private merge(payload: unknown): void {
    const u = usageFromPayload(payload)
    if (!u) return
    const f = this.found
    this.found = f
      ? { input: Math.max(f.input, u.input), output: Math.max(f.output, u.output), cached: Math.max(f.cached, u.cached) }
      : u
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function localDay(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Counts a finished request: user cancellations (499) are not failures. */
function isError(status: number): boolean {
  return status !== 499 && (status < 200 || status >= 300)
}

export interface UsageStoreOptions {
  /** Where to persist; without it usage lives in memory only. */
  file?: string
  retentionDays?: number
  saveDelayMs?: number
  now?: () => number
}

/** Daily per-model totals, persisted with a short delay so a burst of requests is one write. */
export class UsageStore {
  private readonly records = new Map<string, UsageRecord>()
  private readonly file?: string
  private readonly retentionDays: number
  private readonly saveDelayMs: number
  private readonly now: () => number
  private timer?: ReturnType<typeof setTimeout>

  constructor(opts: UsageStoreOptions = {}) {
    this.file = opts.file
    this.retentionDays = opts.retentionDays ?? USAGE_RETENTION_DAYS
    this.saveDelayMs = opts.saveDelayMs ?? 5000
    this.now = opts.now ?? Date.now
    this.load()
  }

  /** Returns false for requests that are not generations (count_tokens). */
  record(log: RequestLog): boolean {
    if (log.endpoint.includes('count_tokens')) return false
    const day = localDay(log.time)
    const model = log.relayModel || log.requestedModel || '—'
    const key = `${day}\n${model}`
    const r = this.records.get(key) ?? { day, model, requests: 0, errors: 0, metered: 0, input: 0, output: 0, cached: 0 }
    r.requests++
    if (isError(log.status)) r.errors++
    if (log.usage) {
      r.metered++
      r.input += log.usage.input
      r.output += log.usage.output
      r.cached += log.usage.cached
    }
    this.records.set(key, r)
    this.scheduleSave()
    return true
  }

  list(): UsageRecord[] {
    this.prune()
    return [...this.records.values()].map((r) => ({ ...r })).sort((a, b) => a.day.localeCompare(b.day))
  }

  clear(): void {
    this.records.clear()
    this.flush()
  }

  /** Writes pending changes now (called on quit). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.file) return
    this.prune()
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, records: [...this.records.values()] }), {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE
    })
    restrictToOwner(tmp)
    renameSync(tmp, this.file)
  }

  private scheduleSave(): void {
    if (!this.file || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
      } catch {
        // Usage is best-effort; a failed write must not disturb the gateway.
      }
    }, this.saveDelayMs)
    this.timer.unref?.()
  }

  private prune(): void {
    const cutoff = localDay(this.now() - (this.retentionDays - 1) * 86_400_000)
    for (const [key, r] of this.records) if (r.day < cutoff) this.records.delete(key)
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { records?: UsageRecord[] }
      for (const r of raw.records ?? []) {
        if (typeof r?.day !== 'string' || typeof r.model !== 'string') continue
        const clean: UsageRecord = {
          day: r.day,
          model: r.model,
          requests: count(r.requests),
          errors: count(r.errors),
          metered: count(r.metered),
          input: count(r.input),
          output: count(r.output),
          cached: count(r.cached)
        }
        this.records.set(`${clean.day}\n${clean.model}`, clean)
      }
    } catch {
      // A corrupt usage file only loses statistics; start over.
    }
    this.prune()
  }
}
