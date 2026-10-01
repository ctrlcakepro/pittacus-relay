import { describe, expect, it } from 'vitest'
import { chatToResponse, responsesToChat, ResponsesStream } from '../src/core/responses'

const tools = [
  { type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } },
  {
    type: 'namespace',
    name: 'mcp__github__',
    tools: [{ type: 'function', name: 'get issue', parameters: { type: 'object' } }]
  },
  { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: {} }] },
  {
    type: 'custom',
    name: 'apply_patch',
    description: 'Edits files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
    format: { type: 'grammar', definition: 'start: x' }
  },
  { type: 'web_search' }
]

function run(chunks: object[], toolMap = responsesToChat({ tools }, 'm').tools, done = true) {
  let out = ''
  const s = new ResponsesStream('relay/m', toolMap, (c) => (out += c))
  for (const c of chunks) s.push(Buffer.from(`data: ${JSON.stringify(c)}\n\n`))
  if (done) s.push(Buffer.from('data: [DONE]\n\n'))
  s.end()
  return out
    .split('\n\n')
    .filter(Boolean)
    .map((e) => JSON.parse(e.split('\n')[1].slice(6)))
}

describe('responsesToChat', () => {
  it('flattens namespaces, wraps custom tools and drops hosted tools', () => {
    const { body, tools: map } = responsesToChat({ tools, tool_choice: 'auto' }, 'm')
    expect(body.tools.map((t: any) => t.function.name)).toEqual([
      'exec_command',
      'mcp__github__get_issue',
      'multi_agent_v1__spawn_agent',
      'apply_patch'
    ])
    expect(body.tools[3].function.description).toBe('Edits files.\n\nPut the complete raw text in the "input" string argument.')
    expect(body.tools[3].function.parameters.required).toEqual(['input'])
    expect(body.tools[3].function.parameters.properties.input.description).toContain('start: x')
    expect(map.get('mcp__github__get_issue')).toEqual({ kind: 'function', name: 'get issue', namespace: 'mcp__github__' })
    expect(body.tool_choice).toBe('auto')
  })

  it('rebuilds chat history: system first, reasoning on the calling turn, tool results after their call', () => {
    const { body } = responsesToChat(
      {
        instructions: 'base',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'perms' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] },
          { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thinking' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
          { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
          { type: 'function_call', call_id: 'c2', name: 'get issue', namespace: 'mcp__github__', arguments: '{}' },
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'mid-turn note' }] },
          { type: 'function_call_output', call_id: 'c2', output: 'issue body' },
          { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'a.txt' }] },
          { type: 'custom_tool_call', call_id: 'c3', name: 'apply_patch', input: '*** Begin Patch' },
          { type: 'function_call_output', call_id: 'orphan', output: 'lost' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: 'data:x' }] }
        ]
      },
      'm'
    )
    expect(body.messages).toEqual([
      { role: 'system', content: 'base\n\nperms' },
      { role: 'user', content: 'fix it' },
      {
        role: 'assistant',
        content: 'Looking.',
        reasoning_content: 'thinking',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } },
          { id: 'c2', type: 'function', function: { name: 'mcp__github__get_issue', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      { role: 'tool', tool_call_id: 'c2', content: 'issue body' },
      { role: 'system', content: 'mid-turn note' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c3', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }]
      },
      { role: 'tool', tool_call_id: 'c3', content: 'aborted' },
      { role: 'user', content: 'Tool result (orphan):\nlost' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: 'data:x' } }
        ]
      }
    ])
  })

  it('accepts a plain string input and maps output limits and formats', () => {
    const { body, stream } = responsesToChat(
      { input: 'hi', stream: true, max_output_tokens: 50, text: { format: { type: 'json_schema', name: 'o', schema: { type: 'object' } } } },
      'm'
    )
    expect(stream).toBe(true)
    expect(body).toMatchObject({
      messages: [{ role: 'user', content: 'hi' }],
      stream_options: { include_usage: true },
      max_tokens: 50,
      response_format: { type: 'json_schema', json_schema: { name: 'o', schema: { type: 'object' } } }
    })
    expect(body.tools).toBeUndefined()
  })
})

describe('ResponsesStream', () => {
  it('turns streamed tool calls back into namespaced and custom tool items', () => {
    const events = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'mcp__github__get_issue', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'apply_patch', arguments: '{"input":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"P"}' } }] }, finish_reason: 'tool_calls' }] }
    ])
    const done = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item)
    expect(done[0]).toMatchObject({ type: 'function_call', call_id: 'a', name: 'get issue', namespace: 'mcp__github__' })
    expect(done[1]).toMatchObject({ type: 'custom_tool_call', call_id: 'b', name: 'apply_patch', input: 'P' })
    const completed = events.at(-1)
    expect(completed.type).toBe('response.completed')
    expect(completed.response.output).toHaveLength(2)
  })

  it('reports a stream cut off mid-reply as failed, a length stop as incomplete', () => {
    const cut = run([{ choices: [{ delta: { content: 'par' } }] }], undefined, false)
    expect(cut.at(-1).type).toBe('response.failed')

    const long = run([{ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }])
    expect(long.at(-1)).toMatchObject({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })
  })

  it('fails on an error object inside the stream', () => {
    const events = run([{ error: { message: 'quota' } }])
    expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { message: 'quota' } } })
    expect(events.filter((e) => e.type === 'response.failed')).toHaveLength(1)
  })
})

describe('chatToResponse', () => {
  it('converts a whole completion', () => {
    const r = chatToResponse(
      {
        choices: [{ message: { content: 'ok', reasoning_content: 'hm', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1 } }
      },
      'relay/m',
      new Map()
    )
    expect(r.output.map((i: any) => i.type)).toEqual(['reasoning', 'message', 'function_call'])
    expect(r.usage).toMatchObject({ input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 1 } })
    expect(r.model).toBe('relay/m')
  })
})
