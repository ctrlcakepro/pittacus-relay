import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { RelayConfig, Provider, RequestLog } from './types'
import { listModels, resolveModel, type WireFormat } from './router'
import { checkLocalRequest, isSafeUpstream } from './security'
import { UsageTap } from './usage'

const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_LOGS = 200
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

// Upstream response headers worth passing back to the client.
const PASS_HEADERS = /^(content-type|cache-control|retry-after|request-id|x-request-id|anthropic-ratelimit-.*|x-ratelimit-.*)$/i

export interface GatewayOptions {
  getConfig: () => RelayConfig
  onLog?: (log: RequestLog) => void
  fetchImpl?: typeof fetch
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export class Gateway {
  private server?: Server
  private logBuffer: RequestLog[] = []
  private nextLogId = 1
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: GatewayOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  get running(): boolean {
    return !!this.server?.listening
  }

  get port(): number | undefined {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? addr.port : undefined
  }

  logs(): RequestLog[] {
    return [...this.logBuffer]
  }

  /** Listens on 127.0.0.1 only; Pittacus Relay is never exposed to the network. */
  async start(port: number): Promise<void> {
    await this.stop()
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) sendError(res, 'anthropic', 500, String(err?.message ?? err))
        else res.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const format: WireFormat = path.includes('/chat/completions') ? 'openai' : 'anthropic'

    const rejected = checkLocalRequest(headerValue(req, 'host'), headerValue(req, 'origin'))
    if (rejected) return sendError(res, format, 403, rejected)

    if (path === '/' || path === '/health') {
      return sendJson(res, 200, { ok: true, name: 'pittacus-relay' })
    }

    const cfg = this.opts.getConfig()
    if (!isAuthorized(req, cfg.localKey)) {
      return sendError(res, format, 401, 'Invalid Pittacus Relay key. Use the local key shown in the Pittacus Relay app.')
    }

    if (req.method === 'GET' && path === '/v1/models') {
      return sendJson(res, 200, modelsResponse(cfg))
    }
    if (req.method === 'POST' && (path === '/v1/messages' || path === '/v1/messages/count_tokens')) {
      return this.proxy(req, res, cfg, 'anthropic', path, url.search)
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      return this.proxy(req, res, cfg, 'openai', '/chat/completions', url.search)
    }
    return sendError(res, format, 404, `Pittacus Relay does not serve ${req.method} ${path} yet.`)
  }

  private async proxy(
    req: IncomingMessage,
    res: ServerResponse,
    cfg: RelayConfig,
    format: WireFormat,
    path: string,
    search: string
  ): Promise<void> {
    const started = Date.now()
    const log: RequestLog = {
      id: this.nextLogId++,
      time: started,
      endpoint: path,
      requestedModel: '',
      status: 0,
      durationMs: 0,
      stream: false
    }
    const finish = (status: number, error?: string) => {
      log.status = status
      log.durationMs = Date.now() - started
      if (error) log.error = error
      this.pushLog(log)
    }

    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch (err) {
      const e = err as HttpError
      finish(e.status ?? 400, e.message)
      return sendError(res, format, e.status ?? 400, e.message)
    }
    log.requestedModel = String(body.model ?? '')
    log.stream = body.stream === true

    const resolved = resolveModel(cfg, body.model, format)
    if (!resolved.ok) {
      finish(resolved.status, resolved.message)
      return sendError(res, format, resolved.status, resolved.message)
    }
    log.relayModel = resolved.relayModel
    body.model = resolved.upstreamModel

    const { provider } = resolved
    const base = (format === 'anthropic' ? provider.anthropicBaseUrl : provider.openaiBaseUrl)!
    const target = base.replace(/\/+$/, '') + path + search
    // Also covers configs saved before https became mandatory.
    if (!isSafeUpstream(target)) {
      const message = `Pittacus Relay will not send the ${provider.name} API key over plain http. Use an https address.`
      finish(502, message)
      return sendError(res, format, 502, message)
    }
    const headers =
      format === 'anthropic' ? anthropicHeaders(req, provider) : { authorization: `Bearer ${provider.apiKey}` }

    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    let upstream: Response
    try {
      upstream = await this.fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        // Following a redirect would hand custom auth headers (x-api-key) to whatever host it names.
        redirect: 'manual'
      })
    } catch (err) {
      if (controller.signal.aborted) return finish(499, 'client closed request')
      const message = `Cannot reach ${provider.name}: ${(err as Error).message}`
      finish(502, message)
      return sendError(res, format, 502, message)
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel()
      const message = `${provider.name} redirected to ${redirectHost(upstream)}; Pittacus Relay does not follow redirects with your API key. Check the provider address.`
      finish(502, message)
      return sendError(res, format, 502, message)
    }

    // Many Anthropic-compatible upstreams lack count_tokens; estimate instead of failing.
    if (path === '/v1/messages/count_tokens' && [404, 405, 501].includes(upstream.status)) {
      await upstream.body?.cancel()
      finish(200, 'count_tokens estimated locally')
      return sendJson(res, 200, { input_tokens: estimateTokens(body) })
    }

    const outHeaders: Record<string, string> = { 'x-pittacus-model': resolved.relayModel }
    upstream.headers.forEach((value, key) => {
      if (PASS_HEADERS.test(key)) outHeaders[key] = value
    })
    res.writeHead(upstream.status, outHeaders)

    const errorText = upstream.ok ? undefined : `upstream ${upstream.status}`
    if (!upstream.body) {
      res.end()
      return finish(upstream.status, errorText)
    }
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream)
    // count_tokens answers are not generations, so there is no usage to read.
    const tap =
      path === '/v1/messages/count_tokens' ? undefined : new UsageTap(/event-stream/i.test(outHeaders['content-type'] ?? ''))
    if (tap) stream.on('data', (chunk: Buffer) => tap.push(chunk))
    await new Promise<void>((resolve) => {
      stream.on('error', () => {
        res.destroy()
        resolve()
      })
      res.on('close', () => resolve())
      stream.pipe(res)
    })
    const usage = tap?.result()
    if (usage) log.usage = usage
    finish(res.writableFinished ? upstream.status : 499, errorText)
  }

  private pushLog(log: RequestLog): void {
    this.logBuffer.push(log)
    if (this.logBuffer.length > MAX_LOGS) this.logBuffer.shift()
    this.opts.onLog?.(log)
  }
}

function anthropicHeaders(req: IncomingMessage, p: Provider): Record<string, string> {
  const h: Record<string, string> = {
    'anthropic-version': headerValue(req, 'anthropic-version') ?? DEFAULT_ANTHROPIC_VERSION
  }
  const beta = headerValue(req, 'anthropic-beta')
  if (beta) h['anthropic-beta'] = beta
  const mode = p.anthropicAuth ?? 'both'
  if (mode !== 'bearer') h['x-api-key'] = p.apiKey
  if (mode !== 'x-api-key') h.authorization = `Bearer ${p.apiKey}`
  return h
}

function redirectHost(res: Response): string {
  try {
    return new URL(res.headers.get('location') ?? '', res.url).host || 'another address'
  } catch {
    return 'another address'
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v.join(',') : v
}

/**
 * Either header may carry the local key. Claude Code sends both when the user is also
 * signed in with /login: the relay key as a bearer token and the account key as x-api-key.
 */
function isAuthorized(req: IncomingMessage, localKey: string): boolean {
  if (!localKey) return false
  const auth = headerValue(req, 'authorization')
  const presented = [headerValue(req, 'x-api-key'), auth?.startsWith('Bearer ') ? auth.slice(7) : undefined]
  return presented.some((key) => key !== undefined && keyMatches(key, localKey))
}

function keyMatches(presented: string, localKey: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(localKey)
  return a.length === b.length && timingSafeEqual(a, b)
}

function modelsResponse(cfg: RelayConfig) {
  const now = new Date().toISOString()
  const data = listModels(cfg).map((m) => ({
    // Fields for both Anthropic- and OpenAI-style clients.
    id: m.id,
    type: 'model',
    object: 'model',
    display_name: `${m.providerName} · ${m.upstreamModel}`,
    created_at: now,
    owned_by: m.providerId
  }))
  return {
    object: 'list',
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.')
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Request body must be a JSON object.')
}

/** Rough count: one token per CJK character, four characters per token otherwise. */
export function estimateTokens(body: Record<string, unknown>): number {
  const text = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []])
  const cjk = text.match(/[　-鿿가-힯＀-￯]/g)?.length ?? 0
  return Math.max(1, cjk + Math.ceil((text.length - cjk) / 4))
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sendError(res: ServerResponse, format: WireFormat, status: number, message: string): void {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : status === 413
            ? 'request_too_large'
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error'
  const payload =
    format === 'anthropic'
      ? { type: 'error', error: { type, message } }
      : { error: { message, type, code: status } }
  sendJson(res, status, payload)
}
