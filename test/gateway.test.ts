import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/core/gateway'
import type { RelayConfig } from '../src/core/types'

interface Seen {
  path: string
  headers: IncomingMessage['headers']
  body: any
}

let upstream: Server
let upstreamUrl = ''
let seen: Seen[] = []
let countTokensStatus = 404

let gateway: Gateway
let relayUrl = ''
let cfg: RelayConfig
const KEY = 'relay-test-key'

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    seen.push({ path: req.url ?? '', headers: req.headers, body })

    if (req.url?.startsWith('/redirect')) {
      res.writeHead(307, { location: 'https://evil.example/steal' })
      return res.end()
    }
    if (req.url?.includes('count_tokens')) {
      res.writeHead(countTokensStatus, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: 42 }))
    }
    if (req.url?.includes('/fail/')) {
      res.writeHead(429, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'slow down' } }))
    }
    if (req.url?.endsWith('/chat/completions') && body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-remaining': '9' })
      const chunk = (delta: object, extra: object = {}) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`)
      chunk({ reasoning_content: 'think' })
      chunk({ content: 'Hel' })
      chunk({ content: 'lo' })
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":' } }] })
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] })
      chunk({}, { finish_reason: 'tool_calls' })
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1', 'x-secret': 'nope' })
      res.write('event: message_start\ndata: {"a":1}\n\n')
      setTimeout(() => res.end('event: message_stop\ndata: {}\n\n'), 20)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, model: body?.model }))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

  gateway = new Gateway({ getConfig: () => cfg })
  await gateway.start(0)
  relayUrl = `http://127.0.0.1:${gateway.port}`
})

afterAll(async () => {
  await gateway.stop()
  await new Promise((r) => upstream.close(r))
})

beforeEach(() => {
  seen = []
  countTokensStatus = 404
  cfg = {
    port: 0,
    localKey: KEY,
    defaultModel: 'kimi/kimi-k2',
    smallModel: 'ds/deepseek-chat',
    providers: [
      {
        id: 'kimi',
        name: 'Kimi',
        anthropicBaseUrl: `${upstreamUrl}/anthropic`,
        openaiBaseUrl: `${upstreamUrl}/v1`,
        anthropicAuth: 'bearer',
        apiKey: 'sk-kimi',
        models: ['kimi-k2'],
        enabled: true
      },
      {
        id: 'ds',
        name: 'DeepSeek',
        anthropicBaseUrl: `${upstreamUrl}/ds/anthropic`,
        anthropicAuth: 'x-api-key',
        apiKey: 'sk-ds',
        models: ['deepseek-chat'],
        enabled: true
      },
      {
        id: 'off',
        name: 'Disabled',
        openaiBaseUrl: `${upstreamUrl}/off`,
        apiKey: 'sk-off',
        models: ['m1'],
        enabled: false
      }
    ]
  }
})

function post(path: string, body: unknown, key = KEY, headers: Record<string, string> = {}) {
  return fetch(relayUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers },
    body: JSON.stringify(body)
  })
}

/** node:http lets tests set Host, which fetch() forbids. */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(relayUrl + path, { headers: { 'x-api-key': KEY, ...headers } }, async (res) => {
      const chunks: Buffer[] = []
      for await (const c of res) chunks.push(c)
      resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('gateway hardening', () => {
  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    const res = await rawGet('/v1/models', { host: `attacker.example:${gateway.port}` })
    expect(res.status).toBe(403)
    expect(res.body.error.type).toBe('permission_error')
    expect((await rawGet('/health', { host: 'attacker.example' })).status).toBe(403)
  })

  it('accepts loopback host names', async () => {
    for (const host of [`127.0.0.1:${gateway.port}`, `localhost:${gateway.port}`, `[::1]:${gateway.port}`]) {
      expect((await rawGet('/v1/models', { host })).status).toBe(200)
    }
  })

  it('refuses requests from web pages but not from local origins', async () => {
    expect((await rawGet('/v1/models', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await rawGet('/v1/models', { origin: 'http://localhost:5173' })).status).toBe(200)
  })

  it('does not follow upstream redirects with the provider key', async () => {
    cfg.providers[1].anthropicBaseUrl = `${upstreamUrl}/redirect`
    const res = await post('/v1/messages', { model: 'ds/deepseek-chat' })
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toMatch(/evil\.example.*does not follow redirects/)
    expect(seen).toHaveLength(1)
  })

  it('never sends a key over plain http to a remote host, even from an old config', async () => {
    const calls: string[] = []
    const guarded = new Gateway({
      getConfig: () => ({ ...cfg, providers: [{ ...cfg.providers[0], anthropicBaseUrl: 'http://api.example.com' }] }),
      fetchImpl: async (url) => {
        calls.push(String(url))
        return new Response('{}')
      }
    })
    await guarded.start(0)
    try {
      const res = await fetch(`http://127.0.0.1:${guarded.port}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': KEY },
        body: JSON.stringify({ model: 'kimi/kimi-k2' })
      })
      expect(res.status).toBe(502)
      expect((await res.json()).error.message).toMatch(/plain http/)
      expect(calls).toHaveLength(0)
    } finally {
      await guarded.stop()
    }
  })
})

describe('gateway', () => {
  it('rejects a wrong local key in the endpoint format', async () => {
    const res = await post('/v1/messages', { model: 'kimi/kimi-k2' }, 'wrong')
    expect(res.status).toBe(401)
    expect((await res.json()).type).toBe('error')

    const oa = await post('/v1/chat/completions', { model: 'kimi/kimi-k2' }, 'wrong')
    expect(oa.status).toBe(401)
    expect((await oa.json()).error.message).toMatch(/Pittacus Relay key/)
    expect(seen).toHaveLength(0)
  })

  it('accepts the key as a bearer token', async () => {
    const res = await fetch(relayUrl + '/v1/models', { headers: { authorization: `Bearer ${KEY}` } })
    expect(res.status).toBe(200)
  })

  it('accepts the bearer key when x-api-key holds a different key', async () => {
    const res = await fetch(relayUrl + '/v1/models', {
      headers: { authorization: `Bearer ${KEY}`, 'x-api-key': 'sk-ant-account-key' }
    })
    expect(res.status).toBe(200)
  })

  it('rejects when neither header holds the local key', async () => {
    const res = await fetch(relayUrl + '/v1/models', {
      headers: { authorization: 'Bearer wrong', 'x-api-key': 'also-wrong' }
    })
    expect(res.status).toBe(401)
  })

  it('lists only enabled models', async () => {
    const res = await fetch(relayUrl + '/v1/models', { headers: { 'x-api-key': KEY } })
    const ids = (await res.json()).data.map((m: any) => m.id)
    expect(ids).toEqual(['kimi/kimi-k2', 'ds/deepseek-chat'])
  })

  it('routes by Pittacus Relay model id, rewrites the model and injects the provider key', async () => {
    const res = await post('/v1/messages?beta=true', { model: 'ds/deepseek-chat', max_tokens: 5 }, KEY, {
      'anthropic-beta': 'foo-2025'
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-pittacus-model')).toBe('ds/deepseek-chat')
    expect(seen[0].path).toBe('/ds/anthropic/v1/messages?beta=true')
    expect(seen[0].body.model).toBe('deepseek-chat')
    expect(seen[0].headers['x-api-key']).toBe('sk-ds')
    expect(seen[0].headers.authorization).toBeUndefined()
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0].headers['anthropic-beta']).toBe('foo-2025')
  })

  it('uses bearer auth when the provider asks for it', async () => {
    await post('/v1/messages', { model: 'kimi/kimi-k2' })
    expect(seen[0].headers.authorization).toBe('Bearer sk-kimi')
    expect(seen[0].headers['x-api-key']).toBeUndefined()
  })

  it('maps unknown haiku models to the small model and others to the default', async () => {
    await post('/v1/messages', { model: 'claude-haiku-4-5-20251001' })
    await post('/v1/messages', { model: 'claude-opus-4-8[1m]' })
    expect(seen.map((s) => s.body.model)).toEqual(['deepseek-chat', 'kimi-k2'])
  })

  it('accepts unambiguous bare upstream names', async () => {
    await post('/v1/messages', { model: 'deepseek-chat' })
    expect(seen[0].path).toBe('/ds/anthropic/v1/messages')
  })

  it('streams SSE through and filters response headers', async () => {
    const res = await post('/v1/messages', { model: 'kimi/kimi-k2', stream: true })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('request-id')).toBe('req_1')
    expect(res.headers.get('x-secret')).toBeNull()
    const text = await res.text()
    expect(text).toContain('message_start')
    expect(text).toContain('message_stop')
    const log = gateway.logs().at(-1)!
    expect(log.stream).toBe(true)
    expect(log.status).toBe(200)
  })

  it('proxies OpenAI chat completions to the OpenAI base url', async () => {
    const res = await post('/v1/chat/completions', { model: 'kimi/kimi-k2', messages: [] })
    expect(res.status).toBe(200)
    expect(seen[0].path).toBe('/v1/chat/completions')
    expect(seen[0].headers.authorization).toBe('Bearer sk-kimi')
  })

  it('refuses OpenAI requests for a provider without an OpenAI endpoint', async () => {
    const res = await post('/v1/chat/completions', { model: 'ds/deepseek-chat', messages: [] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/OpenAI-compatible/)
    expect(seen).toHaveLength(0)
  })

  it('does not route to disabled providers', async () => {
    cfg.defaultModel = undefined
    const res = await post('/v1/chat/completions', { model: 'off/m1', messages: [] })
    expect(res.status).toBe(404)
  })

  it('estimates count_tokens when the upstream lacks it, forwards otherwise', async () => {
    const est = await post('/v1/messages/count_tokens', { model: 'kimi/kimi-k2', messages: [{ role: 'user', content: '你好世界' }] })
    const estJson = await est.json()
    expect(est.status).toBe(200)
    expect(estJson.input_tokens).toBeGreaterThan(4)

    countTokensStatus = 200
    const real = await post('/v1/messages/count_tokens', { model: 'kimi/kimi-k2', messages: [] })
    expect((await real.json()).input_tokens).toBe(42)
  })

  it('returns 502 when the upstream is unreachable', async () => {
    cfg.providers[0].anthropicBaseUrl = 'http://127.0.0.1:1'
    const res = await post('/v1/messages', { model: 'kimi/kimi-k2' })
    expect(res.status).toBe(502)
    expect((await res.json()).error.type).toBe('api_error')
  })

  it('rejects non-JSON bodies', async () => {
    const res = await fetch(relayUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY },
      body: 'not json'
    })
    expect(res.status).toBe(400)
  })
})

describe('responses api (Codex)', () => {
  const codexBody = {
    model: 'kimi/kimi-k2',
    instructions: 'base',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }, { type: 'web_search' }],
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content']
  }

  it('translates to chat completions and streams Responses events back', async () => {
    const res = await post('/v1/responses', codexBody)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9')
    expect(seen[0].path).toBe('/v1/chat/completions')
    expect(seen[0].headers.authorization).toBe('Bearer sk-kimi')
    expect(seen[0].body).toMatchObject({
      model: 'kimi-k2',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'base' },
        { role: 'user', content: 'hi' }
      ]
    })
    expect(seen[0].body.tools).toEqual([{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }])
    expect(seen[0].body.store).toBeUndefined()

    const events = (await res.text())
      .split('\n\n')
      .filter(Boolean)
      .map((e) => JSON.parse(e.split('\n')[1].slice(6)))
    expect(events[0].type).toBe('response.created')
    expect(events.at(-1).type).toBe('response.completed')
    const done = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item)
    expect(done.map((i) => i.type)).toEqual(['reasoning', 'message', 'function_call'])
    expect(done[1].content[0].text).toBe('Hello')
    expect(done[2]).toMatchObject({ call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' })
    expect(events.at(-1).response.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 })

    const log = gateway.logs().at(-1)!
    expect(log.endpoint).toBe('/responses')
    expect(log.status).toBe(200)
    expect(log.usage).toEqual({ input: 7, output: 3, cached: 0 })
  })

  it('passes Responses requests through to upstreams that serve them natively', async () => {
    cfg.providers[0].openaiResponses = true
    const res = await post('/v1/responses', { ...codexBody, stream: false })
    expect(res.status).toBe(200)
    expect(seen[0].path).toBe('/v1/responses')
    expect(seen[0].body).toMatchObject({ model: 'kimi-k2', store: false, input: codexBody.input })
  })

  it('reports upstream errors in OpenAI form with the upstream status', async () => {
    cfg.providers[0].openaiBaseUrl = `${upstreamUrl}/fail/v1`
    const res = await post('/v1/responses', codexBody)
    expect(res.status).toBe(429)
    expect((await res.json()).error.message).toBe('slow down')
  })

  it('answers non-streaming requests with a response object', async () => {
    const res = await post('/v1/responses', { ...codexBody, stream: false })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.object).toBe('response')
    expect(json.status).toBe('completed')
  })
})
