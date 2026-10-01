// OpenAI Responses API (what Codex speaks) translated to and from Chat Completions,
// for upstreams that only serve /chat/completions. Pure functions, no I/O.
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

type Json = Record<string, any>

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Json[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  /** Thinking text; DeepSeek and Kimi require it back on assistant turns that called tools. */
  reasoning_content?: string
}

/** Where a Chat Completions function name came from, so calls can be turned back into Responses items. */
type ToolOrigin = { kind: 'function'; name: string; namespace?: string } | { kind: 'custom'; name: string }

export type ToolMap = Map<string, ToolOrigin>

export interface ChatPlan {
  body: Json
  tools: ToolMap
  stream: boolean
}

const MAX_TOOL_NAME = 64

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

/**
 * Chat Completions function names allow only [A-Za-z0-9_-]{1,64}. Codex groups MCP tools into
 * namespaces, which become "<namespace>__<tool>" here (or just joined when the namespace already
 * ends in an underscore, as "mcp__server__" does).
 */
function chatToolName(name: string, namespace?: string): string {
  const joined = namespace ? (namespace.endsWith('_') ? namespace + name : `${namespace}__${name}`) : name
  return joined.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_TOOL_NAME) || 'tool'
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** User content stays a plain string unless it carries images; plain strings are the most widely accepted. */
function userContent(content: unknown): string | Json[] {
  if (!Array.isArray(content)) return textOf(content)
  const parts: Json[] = []
  for (const part of content) {
    if (typeof part?.text === 'string') parts.push({ type: 'text', text: part.text })
    else if (part?.type === 'input_image' && typeof part.image_url === 'string') {
      parts.push({ type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } })
    }
  }
  return parts.some((p) => p.type === 'image_url') ? parts : parts.map((p) => p.text).join('\n')
}

function toolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((part) => (typeof part?.text === 'string' ? part.text : part?.type === 'input_image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return output === undefined || output === null ? '' : JSON.stringify(output)
}

function reasoningText(item: Json): string {
  const parts = Array.isArray(item.content) ? item.content : []
  return parts
    .map((p: Json) => (typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

function convertTools(tools: unknown): { list: Json[]; map: ToolMap } {
  const list: Json[] = []
  const map: ToolMap = new Map()
  const add = (chatName: string, origin: ToolOrigin, description: unknown, parameters: unknown) => {
    let name = chatName
    for (let n = 2; map.has(name); n++) name = `${chatName.slice(0, MAX_TOOL_NAME - 4)}_${n}`
    map.set(name, origin)
    list.push({
      type: 'function',
      function: {
        name,
        ...(typeof description === 'string' && description ? { description } : {}),
        parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', properties: {} }
      }
    })
  }
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'function' && typeof tool.name === 'string') {
      add(chatToolName(tool.name), { kind: 'function', name: tool.name }, tool.description, tool.parameters)
    } else if (tool?.type === 'namespace' && typeof tool.name === 'string' && Array.isArray(tool.tools)) {
      for (const sub of tool.tools) {
        if (sub?.type !== 'function' || typeof sub.name !== 'string') continue
        add(
          chatToolName(sub.name, tool.name),
          { kind: 'function', name: sub.name, namespace: tool.name },
          sub.description,
          sub.parameters
        )
      }
    } else if (tool?.type === 'custom' && typeof tool.name === 'string') {
      // Free-form tools take one raw string; Chat Completions only has JSON functions.
      const grammar = typeof tool.format?.definition === 'string' ? `\n\nThe input must follow this grammar:\n${tool.format.definition}` : ''
      // Codex tells the model not to wrap free-form input in JSON, which is exactly what this form needs.
      const description = `${typeof tool.description === 'string' ? tool.description.replace(/[^.\n]*\bFREEFORM\b[^.\n]*\.\s*/g, '') : ''}\n\nPut the complete raw text in the "input" string argument.`.trim()
      add(chatToolName(tool.name), { kind: 'custom', name: tool.name }, description, {
        type: 'object',
        properties: { input: { type: 'string', description: `Raw input for the ${tool.name} tool.${grammar}` } },
        required: ['input']
      })
    }
    // Hosted tools (web_search, image_generation, tool_search…) have no Chat Completions equivalent.
  }
  return { list, map }
}

function convertToolChoice(choice: unknown, map: ToolMap): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (choice && typeof choice === 'object' && (choice as Json).type === 'function') {
    const c = choice as Json
    const name = [...map].find(([, o]) => o.name === c.name && (o.kind !== 'function' || o.namespace === c.namespace))?.[0]
    return name ? { type: 'function', function: { name } } : 'auto'
  }
  return undefined
}

/**
 * Chat Completions requires every assistant tool call to be answered by tool messages right
 * after it. Codex history can break that (interrupted turns, items interleaved), so tool results
 * are moved next to their call, missing ones are marked aborted and orphans become user text.
 */
function normalizeToolOrder(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  const used = new Set<ChatMessage>()
  messages.forEach((m, i) => {
    if (used.has(m)) return
    if (m.role === 'tool') {
      out.push({ role: 'user', content: `Tool result (${m.tool_call_id}):\n${m.content ?? ''}` })
      return
    }
    out.push(m)
    for (const call of m.tool_calls ?? []) {
      const result = messages.find((x, j) => j > i && x.role === 'tool' && x.tool_call_id === call.id && !used.has(x))
      if (result) used.add(result)
      out.push(result ?? { role: 'tool', tool_call_id: call.id, content: 'aborted' })
    }
  })
  return out
}

/** Builds the /chat/completions body for a /responses request. */
export function responsesToChat(req: Json, upstreamModel: string): ChatPlan {
  const { list: tools, map } = convertTools(req.tools)
  const system: string[] = []
  if (typeof req.instructions === 'string' && req.instructions) system.push(req.instructions)

  const messages: ChatMessage[] = []
  let reasoning = ''
  const assistant = (): ChatMessage => {
    const last = messages.at(-1)
    if (last?.role === 'assistant') return last
    const m: ChatMessage = { role: 'assistant', content: null }
    messages.push(m)
    return m
  }
  const takeReasoning = (m: ChatMessage) => {
    if (reasoning) m.reasoning_content = (m.reasoning_content ? m.reasoning_content + '\n' : '') + reasoning
    reasoning = ''
  }

  const input = typeof req.input === 'string' ? [{ type: 'message', role: 'user', content: req.input }] : req.input
  for (const item of Array.isArray(input) ? input : []) {
    const type = item?.type ?? (item?.role ? 'message' : undefined)
    if (type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        const text = textOf(item.content)
        if (!text) continue
        if (messages.length === 0) system.push(text)
        else messages.push({ role: 'system', content: text })
      } else if (item.role === 'assistant') {
        const text = textOf(item.content)
        const last = messages.at(-1)
        // A new assistant message unless the previous one is still open (text before tool calls).
        const m: ChatMessage =
          last?.role === 'assistant' && !last.tool_calls ? last : { role: 'assistant', content: null }
        if (m !== last) messages.push(m)
        m.content = m.content ? `${m.content}\n${text}` : text
        takeReasoning(m)
      } else {
        messages.push({ role: 'user', content: userContent(item.content) })
      }
    } else if (type === 'reasoning') {
      const text = reasoningText(item)
      if (text) reasoning = reasoning ? `${reasoning}\n${text}` : text
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const m = assistant()
      takeReasoning(m)
      m.tool_calls ??= []
      m.tool_calls.push({
        id: String(item.call_id ?? item.id ?? newId('call')),
        type: 'function',
        function: {
          name: chatToolName(String(item.name ?? ''), type === 'function_call' ? item.namespace : undefined),
          arguments:
            type === 'function_call'
              ? typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments ?? {})
              : JSON.stringify({ input: String(item.input ?? '') })
        }
      })
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: toolOutput(item.output) })
    }
    // Other items (web_search_call, compaction markers…) have no Chat Completions form.
  }

  const chatMessages = normalizeToolOrder(messages)
  if (system.length) chatMessages.unshift({ role: 'system', content: system.join('\n\n') })

  const stream = req.stream === true
  const body: Json = { model: upstreamModel, messages: chatMessages, stream }
  if (stream) body.stream_options = { include_usage: true }
  if (tools.length) {
    body.tools = tools
    const choice = convertToolChoice(req.tool_choice, map)
    if (choice !== undefined) body.tool_choice = choice
  }
  if (typeof req.max_output_tokens === 'number') body.max_tokens = req.max_output_tokens
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (typeof req.top_p === 'number') body.top_p = req.top_p
  const format = req.text?.format
  if (format?.type === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: format.name ?? 'output', schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}) }
    }
  } else if (format?.type === 'json_object') {
    body.response_format = { type: 'json_object' }
  }
  return { body, tools: map, stream }
}

function toolCallItem(id: string, callId: string, chatName: string, args: string, tools: ToolMap): Json {
  const origin = tools.get(chatName)
  if (origin?.kind === 'custom') {
    let input = args
    try {
      const parsed = JSON.parse(args)
      if (typeof parsed?.input === 'string') input = parsed.input
    } catch {
      // keep the raw text
    }
    return { type: 'custom_tool_call', id, call_id: callId, name: origin.name, input, status: 'completed' }
  }
  return {
    type: 'function_call',
    id,
    call_id: callId,
    name: origin?.name ?? chatName,
    ...(origin?.kind === 'function' && origin.namespace ? { namespace: origin.namespace } : {}),
    arguments: args || '{}',
    status: 'completed'
  }
}

function responsesUsage(u: unknown): Json | undefined {
  if (!u || typeof u !== 'object') return undefined
  const o = u as Json
  const input = Number(o.prompt_tokens) || 0
  const output = Number(o.completion_tokens) || 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Number(o.prompt_tokens_details?.cached_tokens ?? o.prompt_cache_hit_tokens) || 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(o.completion_tokens_details?.reasoning_tokens) || 0 },
    total_tokens: Number(o.total_tokens) || input + output
  }
}

function responseObject(id: string, model: string, created: number, status: string, output: Json[], extra: Json = {}): Json {
  return { id, object: 'response', created_at: created, model, status, output, ...extra }
}

/** The thinking text an OpenAI-compatible upstream returns, under either common field name. */
function reasoningDelta(delta: Json | undefined): string {
  const r = delta?.reasoning_content ?? delta?.reasoning
  return typeof r === 'string' ? r : ''
}

/** Converts a complete (non-streaming) Chat Completions answer into a Responses object. */
export function chatToResponse(chat: Json, model: string, tools: ToolMap): Json {
  const message = chat?.choices?.[0]?.message ?? {}
  const output: Json[] = []
  const thinking = reasoningDelta(message)
  if (thinking) {
    output.push({ type: 'reasoning', id: newId('rs'), summary: [], content: [{ type: 'reasoning_text', text: thinking }] })
  }
  const text = textOf(message.content)
  if (text) {
    output.push({
      type: 'message',
      id: newId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    output.push(
      toolCallItem(newId('fc'), String(call.id ?? newId('call')), String(call.function?.name ?? ''), String(call.function?.arguments ?? ''), tools)
    )
  }
  const truncated = chat?.choices?.[0]?.finish_reason === 'length'
  return responseObject(newId('resp'), model, Math.floor(Date.now() / 1000), truncated ? 'incomplete' : 'completed', output, {
    usage: responsesUsage(chat?.usage),
    ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {})
  })
}

/** The SSE events a client would have seen had `response` been streamed. */
export function responseEvents(response: Json): string {
  const out: string[] = []
  let seq = 0
  const ev = (type: string, data: Json) => out.push(sse(type, { type, sequence_number: seq++, ...data }))
  ev('response.created', { response: { ...response, status: 'in_progress', output: [] } })
  response.output.forEach((item: Json, index: number) => {
    ev('response.output_item.added', { output_index: index, item })
    ev('response.output_item.done', { output_index: index, item })
  })
  ev(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response })
  return out.join('')
}

function sse(type: string, data: Json): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

interface OpenCall {
  key: string
  id: string
  callId: string
  name: string
  args: string
}

/**
 * Turns a streamed Chat Completions body into Responses SSE events. Text and reasoning are
 * forwarded as they arrive; tool calls are emitted whole once their arguments are complete.
 */
export class ResponsesStream {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private seq = 0
  private readonly id = newId('resp')
  private readonly created = Math.floor(Date.now() / 1000)
  private readonly output: Json[] = []
  private reasoning?: { item: Json; index: number; text: string }
  private message?: { item: Json; index: number; text: string }
  private readonly calls: OpenCall[] = []
  private readonly callByIndex = new Map<number, OpenCall>()
  private usage?: Json
  private finish?: string
  private done = false
  private failed = false

  constructor(
    private readonly model: string,
    private readonly tools: ToolMap,
    private readonly write: (chunk: string) => void
  ) {
    this.emit('response.created', { response: this.snapshot('in_progress') })
    this.emit('response.in_progress', { response: this.snapshot('in_progress') })
  }

  push(chunk: Buffer): void {
    const lines = (this.buffer + this.decoder.write(chunk)).split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.line(line)
  }

  /** Call once the upstream body has ended. */
  end(): void {
    this.line(this.buffer + this.decoder.end())
    this.buffer = ''
    if (this.failed) return
    if (!this.done && !this.finish) {
      return this.fail('The provider closed the stream before the reply was complete.')
    }
    this.complete()
  }

  fail(message: string): void {
    if (this.failed) return
    this.failed = true
    this.emit('response.failed', {
      response: this.snapshot('failed', { error: { code: 'upstream_error', message } })
    })
  }

  private line(raw: string): void {
    if (this.failed) return
    const line = raw.trim()
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      this.done = true
      return
    }
    let chunk: Json
    try {
      chunk = JSON.parse(data)
    } catch {
      return
    }
    if (chunk?.error) {
      return this.fail(String(chunk.error.message ?? JSON.stringify(chunk.error)))
    }
    if (chunk?.usage) this.usage = chunk.usage
    const choice = chunk?.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? {}

    const thinking = reasoningDelta(delta)
    if (thinking) this.reasoningDelta(thinking)
    if (typeof delta.content === 'string' && delta.content) this.textDelta(delta.content)
    if (Array.isArray(delta.tool_calls)) {
      this.closeReasoning()
      this.closeMessage()
      for (const tc of delta.tool_calls) this.toolDelta(tc)
    }
    if (choice.finish_reason) this.finish = choice.finish_reason
  }

  private reasoningDelta(text: string): void {
    if (!this.reasoning) {
      const item = { type: 'reasoning', id: newId('rs'), summary: [], content: [] }
      this.reasoning = { item, index: this.output.length, text: '' }
      this.output.push(item)
      this.emit('response.output_item.added', { output_index: this.reasoning.index, item })
    }
    this.reasoning.text += text
    this.emit('response.reasoning_text.delta', {
      item_id: this.reasoning.item.id,
      output_index: this.reasoning.index,
      content_index: 0,
      delta: text
    })
  }

  private textDelta(text: string): void {
    this.closeReasoning()
    if (!this.message) {
      const item = { type: 'message', id: newId('msg'), role: 'assistant', status: 'in_progress', content: [] }
      this.message = { item, index: this.output.length, text: '' }
      this.output.push(item)
      this.emit('response.output_item.added', { output_index: this.message.index, item })
      this.emit('response.content_part.added', {
        item_id: item.id,
        output_index: this.message.index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      })
    }
    this.message.text += text
    this.emit('response.output_text.delta', {
      item_id: this.message.item.id,
      output_index: this.message.index,
      content_index: 0,
      delta: text
    })
  }

  private toolDelta(tc: Json): void {
    const index = typeof tc?.index === 'number' ? tc.index : 0
    let call = this.callByIndex.get(index)
    // A different id at the same index means the upstream started another call.
    if (!call || (tc?.id && call.callId !== tc.id && call.args)) {
      call = { key: `${index}:${this.calls.length}`, id: newId('fc'), callId: String(tc?.id ?? newId('call')), name: '', args: '' }
      this.calls.push(call)
      this.callByIndex.set(index, call)
    }
    if (tc?.id && !call.args) call.callId = String(tc.id)
    const fn = tc?.function ?? {}
    // Most upstreams send the name once; a few repeat it in every chunk.
    if (typeof fn.name === 'string' && fn.name && !call.name.endsWith(fn.name)) call.name += fn.name
    if (typeof fn.arguments === 'string') call.args += fn.arguments
  }

  private closeReasoning(): void {
    const r = this.reasoning
    if (!r) return
    this.reasoning = undefined
    const item: Json = { ...r.item, content: [{ type: 'reasoning_text', text: r.text }] }
    this.output[r.index] = item
    this.emit('response.output_item.done', { output_index: r.index, item })
  }

  private closeMessage(): void {
    const m = this.message
    if (!m) return
    this.message = undefined
    const part = { type: 'output_text', text: m.text, annotations: [] }
    const item: Json = { ...m.item, status: 'completed', content: [part] }
    this.output[m.index] = item
    this.emit('response.output_text.done', { item_id: item.id, output_index: m.index, content_index: 0, text: m.text })
    this.emit('response.content_part.done', { item_id: item.id, output_index: m.index, content_index: 0, part })
    this.emit('response.output_item.done', { output_index: m.index, item })
  }

  private complete(): void {
    this.closeReasoning()
    this.closeMessage()
    for (const call of this.calls) {
      const item = toolCallItem(call.id, call.callId, call.name, call.args, this.tools)
      const index = this.output.length
      this.output.push(item)
      this.emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress' } })
      this.emit('response.output_item.done', { output_index: index, item })
    }
    if (this.finish === 'length') {
      this.emit('response.incomplete', {
        response: this.snapshot('incomplete', { incomplete_details: { reason: 'max_output_tokens' } })
      })
    } else {
      this.emit('response.completed', { response: this.snapshot('completed') })
    }
  }

  private snapshot(status: string, extra: Json = {}): Json {
    const usage = responsesUsage(this.usage)
    return responseObject(this.id, this.model, this.created, status, status === 'in_progress' ? [] : [...this.output], {
      ...(usage ? { usage } : {}),
      ...extra
    })
  }

  private emit(type: string, data: Json): void {
    this.write(sse(type, { type, sequence_number: this.seq++, ...data }))
  }
}
