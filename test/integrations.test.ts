import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCodeIntegration } from '../src/core/integrations/claudeCode'
import { OpencodeIntegration } from '../src/core/integrations/opencode'
import type { RelayConfig } from '../src/core/types'

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
