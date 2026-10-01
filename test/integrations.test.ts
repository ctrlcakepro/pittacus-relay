import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCodeIntegration } from '../src/core/integrations/claudeCode'
import { CodexIntegration } from '../src/core/integrations/codex'
import { OpencodeIntegration } from '../src/core/integrations/opencode'
import type { RelayConfig } from '../src/core/types'
import type { SecretCodec } from '../src/core/store'

/** Stands in for safeStorage: reversible, visibly not plaintext, and can be "lost". */
function fakeCodec(): SecretCodec & { lost: boolean } {
  const codec = {
    secure: true,
    lost: false,
    encrypt: (s: string) => 'sealed:' + Buffer.from(s).toString('base64'),
    decrypt: (s: string) => {
      if (codec.lost || !s.startsWith('sealed:')) throw new Error('cannot decrypt')
      return Buffer.from(s.slice(7), 'base64').toString()
    }
  }
  return codec
}

const baseUrl = 'http://127.0.0.1:17800'
let dir: string
let cfg: RelayConfig

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-test-'))
  cfg = {
    port: 17800,
    localKey: 'relay-local',
    defaultModel: 'kimi/kimi-k2',
    providers: [
      {
        id: 'kimi',
        name: 'Kimi',
        anthropicBaseUrl: 'https://a.example',
        openaiBaseUrl: 'https://o.example/v1',
        apiKey: 'sk',
        models: ['kimi-k2'],
        enabled: true
      },
      { id: 'oa', name: 'OpenAI', openaiBaseUrl: 'https://o.example/v1', apiKey: 'sk', models: ['gpt-x'], enabled: true }
    ]
  }
})

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

describe('Claude Code integration', () => {
  it('applies env + modelPicker and restores only what it touched', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(
      file,
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_API_KEY: 'k', KEEP: '1' }, permissions: { allow: [] } })
    )
    const cc = new ClaudeCodeIntegration(file)
    const result = cc.apply({ cfg, baseUrl })

    const s = read(file)
    expect(s.env.ANTHROPIC_BASE_URL).toBe(baseUrl)
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe('relay-local')
    expect(s.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi/kimi-k2')
    expect(s.env.KEEP).toBe('1')
    expect(s.modelPicker.options.map((o: any) => o.model)).toEqual(['kimi/kimi-k2'])
    expect(result.skipped).toEqual(['oa/gpt-x'])
    expect(cc.status({ cfg, baseUrl })).toMatchObject({ connected: true, restorable: true })

    // Re-applying must keep the first recorded originals.
    cc.apply({ cfg, baseUrl })

    // A later user edit survives the restore.
    const edited = read(file)
    edited.permissions.allow.push('Bash(ls)')
    writeFileSync(file, JSON.stringify(edited))

    cc.restore()
    const r = read(file)
    expect(r.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_API_KEY: 'k', KEEP: '1' })
    expect(r.modelPicker).toBeUndefined()
    expect(r.permissions.allow).toEqual(['Bash(ls)'])
    expect(cc.status({ cfg, baseUrl })).toMatchObject({ connected: false, restorable: false })
  })

  it('seals the original credentials in its restore record and brings them back', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-old', ANTHROPIC_API_KEY: 'sk-ant-k', KEEP: '1' } }))
    const cc = new ClaudeCodeIntegration(file, fakeCodec())
    cc.apply({ cfg, baseUrl })

    const record = readFileSync(`${file}.pittacus-state.json`, 'utf8')
    expect(record).not.toContain('sk-ant-old')
    expect(record).not.toContain('sk-ant-k')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant')

    expect(cc.restore()).toEqual([])
    expect(read(file).env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-old', ANTHROPIC_API_KEY: 'sk-ant-k', KEEP: '1' })
  })

  it('seals plaintext credentials left by older versions on the next apply', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-k' } }))
    new ClaudeCodeIntegration(file).apply({ cfg, baseUrl })
    expect(readFileSync(`${file}.pittacus-state.json`, 'utf8')).toContain('sk-ant-k')

    const cc = new ClaudeCodeIntegration(file, fakeCodec())
    cc.apply({ cfg, baseUrl })
    expect(readFileSync(`${file}.pittacus-state.json`, 'utf8')).not.toContain('sk-ant-k')
    cc.restore()
    expect(read(file).env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-k' })
  })

  it('restores the rest and warns when a sealed credential can no longer be opened', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-k', KEEP: '1' }, modelPicker: { x: 1 } }))
    const codec = fakeCodec()
    const cc = new ClaudeCodeIntegration(file, codec)
    cc.apply({ cfg, baseUrl })
    codec.lost = true

    const warnings = cc.restore()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/ANTHROPIC_API_KEY/)
    expect(read(file)).toEqual({ env: { KEEP: '1' }, modelPicker: { x: 1 } })
  })

  it('creates settings when missing and removes env on restore', () => {
    const file = join(dir, 'sub', 'settings.json')
    const cc = new ClaudeCodeIntegration(file)
    cc.apply({ cfg, baseUrl })
    cc.restore()
    expect(read(file)).toEqual({})
  })

  it('requires a default model', () => {
    cfg.defaultModel = undefined
    expect(() => new ClaudeCodeIntegration(join(dir, 's.json')).apply({ cfg, baseUrl })).toThrow(/默认模型/)
  })

  it('refuses to overwrite invalid JSON', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{ // comment\n}')
    expect(() => new ClaudeCodeIntegration(file).apply({ cfg, baseUrl })).toThrow(/not plain JSON/)
    expect(readFileSync(file, 'utf8')).toBe('{ // comment\n}')
  })
})

describe('opencode integration', () => {
  it('adds and removes the pittacus provider', () => {
    const file = join(dir, 'opencode', 'opencode.json')
    const oc = new OpencodeIntegration(file)
    const result = oc.apply({ cfg, baseUrl })
    const c = read(file)
    expect(c.provider.pittacus.options.baseURL).toBe(`${baseUrl}/v1`)
    expect(Object.keys(c.provider.pittacus.models)).toEqual(['kimi/kimi-k2', 'oa/gpt-x'])
    expect(result.modelCount).toBe(2)

    oc.restore()
    expect(read(file).provider).toBeUndefined()
    expect(existsSync(`${file}.pittacus-state.json`)).toBe(false)
  })

  it('keeps other providers intact', () => {
    const file = join(dir, 'opencode.json')
    writeFileSync(file, JSON.stringify({ provider: { other: { name: 'x' } }, theme: 'dark' }))
    const oc = new OpencodeIntegration(file)
    oc.apply({ cfg, baseUrl })
    oc.restore()
    expect(read(file)).toEqual({ provider: { other: { name: 'x' } }, theme: 'dark' })
  })
})

describe('Codex integration', () => {
  const original = [
    '# my codex settings',
    'model = "gpt-6"',
    "model_reasoning_effort = 'high'",
    'notify = [',
    '  "a.exe", # trailing comment',
    '  "turn-ended",',
    ']',
    '',
    '[model_providers.other]',
    'name = "Other"',
    '',
    '# MCP',
    '[mcp_servers.x]',
    'command = "x"',
    ''
  ].join('\r\n')

  it('sets the root keys and provider table, then restores the file byte for byte', () => {
    const file = join(dir, 'config.toml')
    writeFileSync(file, original)
    const cx = new CodexIntegration(dir)
    const result = cx.apply({ cfg, baseUrl })
    expect(result.modelCount).toBe(2)

    const text = readFileSync(file, 'utf8')
    const lines = text.split('\r\n')
    // Root keys stay above the first table.
    const firstTable = lines.findIndex((l) => l.startsWith('['))
    expect(lines.indexOf('model_provider = "pittacus"')).toBeGreaterThan(-1)
    expect(lines.indexOf('model_provider = "pittacus"')).toBeLessThan(firstTable)
    expect(lines.indexOf('model = "kimi/kimi-k2"')).toBeLessThan(firstTable)
    expect(lines.some((l) => l.startsWith('model_catalog_json = '))).toBe(true)
    expect(text).not.toContain('gpt-6')
    expect(text).toContain('[model_providers.pittacus]\r\nname = "Pittacus Relay"')
    expect(text).toContain(`base_url = "${baseUrl}/v1"`)
    expect(text).toContain('experimental_bearer_token = "relay-local"')
    expect(text).toContain('notify = [\r\n  "a.exe", # trailing comment')
    expect(text).toContain('[mcp_servers.x]')
    expect(cx.status({ cfg, baseUrl }).connected).toBe(true)

    const catalog = read(join(dir, 'pittacus-models.json'))
    expect(catalog.models.map((m: any) => m.slug)).toEqual(['kimi/kimi-k2', 'oa/gpt-x'])
    expect(catalog.models[0]).toMatchObject({ visibility: 'list', apply_patch_tool_type: 'freeform', supported_reasoning_levels: [] })
    expect(catalog.models[0].base_instructions).toBeTruthy()

    // Re-applying (e.g. after a port change) must not record the relay's own values as originals.
    cx.apply({ cfg, baseUrl: 'http://127.0.0.1:18000' })
    expect(readFileSync(file, 'utf8').match(/\[model_providers\.pittacus\]/g)).toHaveLength(1)

    cx.restore()
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(existsSync(join(dir, 'pittacus-models.json'))).toBe(false)
    expect(cx.status({ cfg, baseUrl }).restorable).toBe(false)
  })

  it('creates the config when missing and removes everything on restore', () => {
    const cx = new CodexIntegration(join(dir, 'fresh'))
    cx.apply({ cfg, baseUrl })
    const file = join(dir, 'fresh', 'config.toml')
    expect(readFileSync(file, 'utf8').startsWith('model_provider = "pittacus"\n')).toBe(true)
    cx.restore()
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it("clones the template from Codex's model cache and offers reasoning levels to native Responses upstreams", () => {
    writeFileSync(
      join(dir, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'code-mode', visibility: 'list', tool_mode: 'code_mode_only', model_messages: { instructions_template: 'A' } },
          { slug: 'plain', visibility: 'list', model_messages: { instructions_template: 'B' }, comp_hash: 'x', extra_field: 1 }
        ]
      })
    )
    cfg.providers[1].openaiResponses = true
    new CodexIntegration(dir).apply({ cfg, baseUrl })
    const [kimi, oa] = read(join(dir, 'pittacus-models.json')).models
    expect(kimi).toMatchObject({ slug: 'kimi/kimi-k2', base_instructions: 'B', extra_field: 1, supported_reasoning_levels: [] })
    expect(kimi.comp_hash).toBeUndefined()
    expect(oa.supported_reasoning_levels.map((l: any) => l.effort)).toEqual(['low', 'medium', 'high'])
  })

  it('refuses a pittacus provider defined some other way', () => {
    const file = join(dir, 'config.toml')
    writeFileSync(file, '[model_providers]\npittacus = { name = "mine" }\n')
    expect(() => new CodexIntegration(dir).apply({ cfg, baseUrl })).toThrow(/pittacus/)
    expect(readFileSync(file, 'utf8')).toBe('[model_providers]\npittacus = { name = "mine" }\n')
  })

  it('puts back a provider table the user already had under the same name', () => {
    const file = join(dir, 'config.toml')
    const before = 'model = "a"\n\n[model_providers.pittacus]\nname = "old"\nbase_url = "http://x"\n'
    writeFileSync(file, before)
    const cx = new CodexIntegration(dir)
    cx.apply({ cfg, baseUrl })
    expect(readFileSync(file, 'utf8')).not.toContain('name = "old"')
    cx.restore()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
