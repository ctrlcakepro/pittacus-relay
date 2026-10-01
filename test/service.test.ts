import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RelayService, type LoginItem } from '../src/core/service'
import { ConfigStore } from '../src/core/store'
import type { ProviderDraft } from '../src/shared/api'

function makeService(loginItem?: LoginItem, file = join(mkdtempSync(join(tmpdir(), 'relay-svc-')), 'config.json')) {
  return { file, service: new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false, loginItem }) }
}

function fakeLoginItem(note?: string): LoginItem & { enabled: boolean } {
  const item = {
    enabled: false,
    supported: true,
    isEnabled: () => item.enabled,
    setEnabled: (v: boolean) => {
      item.enabled = v
    },
    note: () => note
  }
  return item
}

describe('unreadable secrets', () => {
  it('starts anyway, keeps a backup, regenerates the local key and asks to re-enter provider keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-enc-'))
    const file = join(dir, 'config.json')
    const codec = { secure: true, encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }
    const store = new ConfigStore(file, codec)
    const first = store.load().config
    first.providers = [{ id: 'ds', name: 'DeepSeek', anthropicBaseUrl: 'https://a', apiKey: 'sk-1', models: ['m'], enabled: true }]
    store.save(first)

    const broken = {
      secure: true,
      encrypt: codec.encrypt,
      decrypt: (): string => {
        throw new Error('Error while decrypting the ciphertext')
      }
    }
    const service = new RelayService({ store: new ConfigStore(file, broken), integrations: [], secureStorage: true })
    const state = service.state()
    expect(state.localKey).not.toBe(first.localKey)
    expect(state.providers[0].hasKey).toBe(false)
    expect(state.notices.join()).toMatch(/DeepSeek/)
    expect(state.notices.join()).toMatch(/本地密钥/)
    expect(readdirSync(dir).some((f) => f.includes('.unreadable-'))).toBe(true)
  })
})

describe('gateway start', () => {
  it('waits for a port that is still being released', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as AddressInfo).port
    const { file } = makeService()
    const store = new ConfigStore(file)
    const cfg = store.load().config
    store.save({ ...cfg, port })

    const service = new RelayService({ store, integrations: [], secureStorage: false })
    setTimeout(() => blocker.close(), 150)
    await service.start(10, 50)
    expect(service.state().gateway).toEqual({ running: true, error: undefined })
    await service.stop()
  })

  it('reports a port that stays busy', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as AddressInfo).port
    const { file } = makeService()
    const store = new ConfigStore(file)
    store.save({ ...store.load().config, port })

    const service = new RelayService({ store, integrations: [], secureStorage: false })
    await service.start(2, 20)
    expect(service.state().gateway.error).toMatch(/已被占用/)
    blocker.close()
  })
})

describe('startup settings', () => {
  it('persists silent start across restarts', () => {
    const { file, service } = makeService()
    expect(service.startHidden).toBe(false)
    const r = service.setStartHidden(true)
    expect(r.state.startup.startHidden).toBe(true)

    const reloaded = makeService(undefined, file).service
    expect(reloaded.startHidden).toBe(true)
  })

  it('toggles launch at login through the OS hook', () => {
    const item = fakeLoginItem()
    const { service } = makeService(item)
    expect(service.state().startup).toMatchObject({ launchAtLogin: false, launchAtLoginSupported: true })

    expect(service.setLaunchAtLogin(true).state.startup.launchAtLogin).toBe(true)
    expect(item.enabled).toBe(true)
    expect(service.setLaunchAtLogin(false).state.startup.launchAtLogin).toBe(false)
  })

  it('surfaces OS notes (e.g. macOS approval) as a warning when enabling', () => {
    const { service } = makeService(fakeLoginItem('需要在登录项中允许'))
    expect(service.setLaunchAtLogin(true).warnings).toEqual(['需要在登录项中允许'])
  })

  it('reports when the OS ignores the change', () => {
    const item = fakeLoginItem()
    item.setEnabled = () => {}
    const { service } = makeService(item)
    expect(() => service.setLaunchAtLogin(true)).toThrow(/没有接受/)
  })

  it('refuses launch at login when unsupported', () => {
    const { service } = makeService()
    expect(service.state().startup.launchAtLoginSupported).toBe(false)
    expect(() => service.setLaunchAtLogin(true)).toThrow()
  })
})

describe('provider key protection', () => {
  const draft = (over: Partial<ProviderDraft> = {}): ProviderDraft => ({
    id: 'ds',
    name: 'DeepSeek',
    anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    anthropicAuth: 'both',
    apiKey: 'sk-real',
    models: ['deepseek-chat'],
    enabled: true,
    ...over
  })

  function serviceWithCalls() {
    const calls: Array<{ url: string; headers: any }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers })
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }))
    }) as typeof fetch
    const file = join(mkdtempSync(join(tmpdir(), 'relay-key-')), 'config.json')
    const service = new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false, fetchImpl })
    service.saveProvider(draft())
    return { service, calls }
  }

  it('keeps the stored key when the provider origins do not change', () => {
    const { service } = serviceWithCalls()
    const edited = draft({ originalId: 'ds', apiKey: '', anthropicBaseUrl: 'https://api.deepseek.com/v2/anthropic' })
    expect(service.saveProvider(edited).state.providers[0].keyHint).toBe('••••real')
  })

  it('refuses to point a stored key at a new origin', async () => {
    const { service, calls } = serviceWithCalls()
    const moved = draft({ originalId: 'ds', apiKey: '', openaiBaseUrl: 'https://attacker.example/v1' })
    expect(() => service.saveProvider(moved)).toThrow(/重新填写 API Key/)
    expect(() => service.fetchModels(moved)).toThrow(/重新填写 API Key/)
    expect(calls).toHaveLength(0)

    // Typing the key again is an explicit decision and is allowed.
    await service.fetchModels({ ...moved, apiKey: 'sk-other' })
    expect(calls[0].url).toBe('https://attacker.example/v1/models')
    expect(calls[0].headers.authorization).toBe('Bearer sk-other')
  })

  it('rejects plain http to remote hosts and credentials in URLs, but allows local http', () => {
    const { service } = serviceWithCalls()
    expect(() => service.saveProvider(draft({ id: 'x', openaiBaseUrl: 'http://api.example.com/v1' }))).toThrow(/https/)
    expect(() => service.saveProvider(draft({ id: 'y', openaiBaseUrl: 'https://u:p@api.example.com/v1' }))).toThrow(
      /用户名或密码/
    )
    const ollama = draft({ id: 'ollama', anthropicBaseUrl: undefined, openaiBaseUrl: 'http://localhost:11434/v1' })
    expect(() => service.saveProvider(ollama)).not.toThrow()
  })

  it('warns about providers saved with plain http before the rule existed', () => {
    const { file } = makeService()
    const store = new ConfigStore(file)
    const cfg = store.load().config
    cfg.providers = [
      { id: 'old', name: 'Legacy', openaiBaseUrl: 'http://api.example.com/v1', apiKey: 'sk', models: ['m'], enabled: true }
    ]
    store.save(cfg)
    const service = new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false })
    expect(service.state().notices.join()).toMatch(/Legacy.*http/)
  })
})
