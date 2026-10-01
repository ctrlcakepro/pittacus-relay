import { mkdtempSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Gateway } from '../src/core/gateway'
import { RelayService } from '../src/core/service'
import { ConfigStore } from '../src/core/store'
import type { RelayConfig, RequestLog } from '../src/core/types'
import { localDay, UsageStore, UsageTap, usageFromPayload } from '../src/core/usage'
import { resolveLocale, setLocale, translate } from '../src/shared/i18n'

const tap = (sse: boolean, ...chunks: string[]) => {
  const t = new UsageTap(sse)
  for (const c of chunks) t.push(Buffer.from(c))
  return t.result()
}

describe('usage extraction', () => {
  it('reads Anthropic streams across message_start and message_delta, cache included', () => {
    const start = JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 20, output_tokens: 1 } }
    })
    const delta = JSON.stringify({ type: 'message_delta', usage: { output_tokens: 250 } })
    const body = `event: message_start\ndata: ${start}\n\nevent: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\nevent: message_delta\ndata: ${delta}\n\n`
    // Split mid-line to make sure partial lines are carried over.
    expect(tap(true, body.slice(0, 37), body.slice(37, 120), body.slice(120))).toEqual({ input: 520, output: 250, cached: 400 })
  })

  it('reads the final OpenAI chunk and multi-byte text split across chunks', () => {
    const text = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
    const bytes = Buffer.from(text)
    const t = new UsageTap(true)
    t.push(bytes.subarray(0, 40))
    t.push(bytes.subarray(40))
    t.push(Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":10}}}\n\ndata: [DONE]\n\n'))
    expect(t.result()).toEqual({ input: 30, output: 7, cached: 10 })
  })

  it('reads non-streaming bodies and DeepSeek cache fields', () => {
    expect(tap(false, '{"usage":{"prompt_tokens":9,', '"completion_tokens":3,"prompt_cache_hit_tokens":4}}')).toEqual({
      input: 9,
      output: 3,
      cached: 4
    })
    expect(tap(false, '{"ok":true}')).toBeUndefined()
    expect(tap(true, 'data: {"usage":null}\n\n')).toBeUndefined()
    expect(usageFromPayload({ usage: { input_tokens: -5, output_tokens: 'x' } })).toEqual({ input: 0, output: 0, cached: 0 })
  })
})

const log = (over: Partial<RequestLog>): RequestLog => ({
  id: 1,
  time: Date.now(),
  endpoint: '/v1/messages',
  requestedModel: 'm',
  relayModel: 'kimi/k2',
  status: 200,
  durationMs: 1,
  stream: true,
  ...over
})

describe('usage store', () => {
  it('sums per day and model, skips count_tokens and does not count cancellations as failures', () => {
    const store = new UsageStore()
    store.record(log({ usage: { input: 10, output: 2, cached: 5 } }))
    store.record(log({ usage: { input: 20, output: 3, cached: 0 } }))
    store.record(log({ status: 502 }))
    store.record(log({ status: 499 }))
    expect(store.record(log({ endpoint: '/v1/messages/count_tokens' }))).toBe(false)
    const [r] = store.list()
    expect(r).toMatchObject({ model: 'kimi/k2', requests: 4, errors: 1, metered: 2, input: 30, output: 5, cached: 5 })
    expect(r.day).toBe(localDay(Date.now()))
  })

  it('persists, drops days past retention and clears', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'relay-usage-')), 'usage.json')
    const now = new Date(2026, 9, 1, 12).getTime()
    const store = new UsageStore({ file, now: () => now, retentionDays: 30 })
    store.record(log({ time: now, usage: { input: 1, output: 1, cached: 0 } }))
    store.record(log({ time: now - 40 * 86_400_000 }))
    store.flush()

    const reloaded = new UsageStore({ file, now: () => now, retentionDays: 30 })
    expect(reloaded.list().map((r) => r.day)).toEqual(['2026-10-01'])
    reloaded.clear()
    expect(new UsageStore({ file, now: () => now }).list()).toEqual([])
  })
})

describe('gateway usage logging', () => {
  let upstream: Server
  let gateway: Gateway
  const logs: RequestLog[] = []

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url?.includes('chat/completions')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }))
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } })}\n\n`)
        res.end(`data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}\n\n`)
      })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const cfg: RelayConfig = {
      port: 0,
      localKey: 'k',
      providers: [{ id: 'p', name: 'P', anthropicBaseUrl: url, openaiBaseUrl: `${url}/v1`, apiKey: 'sk', models: ['m'], enabled: true }]
    }
    gateway = new Gateway({ getConfig: () => cfg, onLog: (l) => logs.push(l) })
    await gateway.start(0)
  })

  afterAll(async () => {
    await gateway.stop()
    await new Promise((r) => upstream.close(r))
  })

  const post = (path: string, body: unknown) =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: gateway.port, path, method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' } },
        (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve(text))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })

  it('attaches upstream usage to the log without altering the body', async () => {
    const streamed = await post('/v1/messages', { model: 'p/m', stream: true })
    expect(streamed).toContain('message_delta')
    const json = await post('/v1/chat/completions', { model: 'p/m' })
    expect(JSON.parse(json).usage.prompt_tokens).toBe(12)
    await new Promise((r) => setTimeout(r, 20))
    expect(logs.map((l) => l.usage)).toEqual([
      { input: 50, output: 9, cached: 0 },
      { input: 12, output: 4, cached: 0 }
    ])
  })
})

describe('i18n', () => {
  afterEach(() => setLocale('zh-CN'))

  it('resolves the system language and picks singular forms', () => {
    expect(resolveLocale('system', 'zh-TW')).toBe('zh-CN')
    expect(resolveLocale('system', 'en-GB')).toBe('en')
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(translate('en', 'providers.modelCount', { count: 1 })).toBe('1 model')
    expect(translate('en', 'providers.modelCount', { count: 3 })).toBe('3 models')
    expect(translate('zh-CN', 'providers.modelCount', { count: 1 })).toBe('1 个模型')
  })

  it('switches service messages and persists the choice', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'relay-lang-')), 'config.json')
    const service = new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false, systemLanguage: 'en-US' })
    expect(service.state()).toMatchObject({ language: 'system', locale: 'en' })
    await expect(service.setPort(80)).rejects.toThrow(/between 1024 and 65535/)

    expect(service.setLanguage('zh-CN').message).toBe('界面语言已切换为简体中文')
    await expect(service.setPort(80)).rejects.toThrow(/1024–65535/)
    const restarted = new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false, systemLanguage: 'en-US' })
    expect(restarted.state()).toMatchObject({ language: 'zh-CN', locale: 'zh-CN' })
    expect(() => restarted.setLanguage('fr' as never)).toThrow()
  })
})

describe('appearance', () => {
  it('defaults to the system theme and violet, and persists changes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'relay-look-')), 'config.json')
    const service = new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false })
    expect(service.state()).toMatchObject({ theme: 'system', accent: 'violet' })

    service.setTheme('dark')
    service.setAccent('teal')
    const restarted = new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false })
    expect(restarted.theme).toBe('dark')
    expect(restarted.state()).toMatchObject({ theme: 'dark', accent: 'teal' })
    expect(() => restarted.setTheme('sepia' as never)).toThrow()
    expect(() => restarted.setAccent('#ff0000' as never)).toThrow()
  })
})
