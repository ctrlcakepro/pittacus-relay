import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SecretClipboard, SystemAuth } from '../src/core/keyGuard'
import { RelayService } from '../src/core/service'
import { ConfigStore } from '../src/core/store'

const KEY = 'sk-live-0123456789'

function setup(opts: { systemOk?: boolean; available?: boolean } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'relay-guard-')), 'config.json')
  const store = new ConfigStore(file)
  store.save({
    ...store.load().config,
    providers: [{ id: 'ds', name: 'DeepSeek', anthropicBaseUrl: 'https://api.deepseek.com/anthropic', apiKey: KEY, models: ['m'], enabled: true }]
  })
  const copied: string[] = []
  const prompts: string[] = []
  const clock = { now: 1_000_000 }
  const clipboard: SecretClipboard = { clearAfterSeconds: 30, copy: async (s) => void copied.push(s) }
  // Mutable so a test can let the first-PIN prompt pass and fail later ones.
  const system = { ok: opts.systemOk ?? true }
  const systemAuth: SystemAuth = {
    kind: 'windows-hello',
    available: () => opts.available ?? true,
    verify: async (reason) => {
      prompts.push(reason)
      return system.ok
    }
  }
  const make = () =>
    new RelayService({ store: new ConfigStore(file), integrations: [], secureStorage: false, clipboard, systemAuth, now: () => clock.now })
  return { file, copied, prompts, clock, system, make, service: make() }
}

describe('copying provider keys', () => {
  it('requires a PIN to be set first', async () => {
    const { service, copied } = setup()
    await expect(service.copyProviderKey('ds', { pin: '' })).rejects.toThrow(/设置 PIN/)
    await expect(service.copyProviderKey('ds', { system: true })).rejects.toThrow(/设置 PIN/)
    expect(copied).toEqual([])
  })

  it('copies with the right PIN only, and never exposes the key or PIN hash in state', async () => {
    const { service, copied, file } = setup()
    await service.setPin('2468')
    await expect(service.copyProviderKey('ds', { pin: '1357' })).rejects.toThrow(/PIN 不正确，还可以再试 4 次/)
    expect(copied).toEqual([])

    const result = await service.copyProviderKey('ds', { pin: '2468' })
    expect(copied).toEqual([KEY])
    expect(result.message).toMatch(/30 秒后/)

    const state = JSON.stringify(service.state())
    const hash = JSON.parse(readFileSync(file, 'utf8')).keyGuard.pin.hash
    expect(state).not.toContain(KEY)
    expect(state).not.toContain(hash)
    expect(readFileSync(file, 'utf8')).not.toContain('2468')
  })

  it('rejects malformed auth from the renderer', async () => {
    const { service, copied } = setup()
    await service.setPin('2468')
    for (const bad of [undefined, null, {}, { pin: 2468 }, { system: 'yes' }, 'pin']) {
      await expect(service.copyProviderKey('ds', bad as never)).rejects.toThrow()
    }
    expect(copied).toEqual([])
  })
})

describe('PIN lockout', () => {
  it('locks after five wrong PINs, survives a restart, and lifts after the wait', async () => {
    const { service, clock, make } = setup()
    await service.setPin('2468')
    for (let i = 0; i < 4; i++) await expect(service.copyProviderKey('ds', { pin: '0000' })).rejects.toThrow(/不正确/)
    await expect(service.copyProviderKey('ds', { pin: '0000' })).rejects.toThrow(/30 秒/)

    const restarted = make()
    expect(restarted.state().keyGuard.lockedUntil).toBe(clock.now + 30_000)
    await expect(restarted.copyProviderKey('ds', { pin: '2468' })).rejects.toThrow(/错误次数过多/)

    clock.now += 30_001
    await restarted.copyProviderKey('ds', { pin: '2468' })
    expect(restarted.state().keyGuard.lockedUntil).toBeUndefined()
  })

  it('cannot be outrun by parallel attempts', async () => {
    const { service, copied } = setup()
    await service.setPin('2468')
    const guesses = Array.from({ length: 12 }, (_, i) => service.copyProviderKey('ds', { pin: `90${i}0` }))
    const results = await Promise.allSettled(guesses)
    // Only the first five are actually checked; the rest hit the lockout.
    const checked = results.filter((r) => r.status === 'rejected' && /不正确/.test(String(r.reason)))
    expect(checked).toHaveLength(5)
    await expect(service.copyProviderKey('ds', { pin: '2468' })).rejects.toThrow(/错误次数过多/)
    expect(copied).toEqual([])
  })
})

describe('Windows Hello / Touch ID', () => {
  it('must be switched on with the PIN, then replaces it', async () => {
    const { service, copied, prompts } = setup()
    await service.setPin('2468')
    await expect(service.copyProviderKey('ds', { system: true })).rejects.toThrow(/尚未开启/)
    await expect(service.setSystemAuth(true, { system: true })).rejects.toThrow(/需要输入 PIN/)
    await expect(service.setSystemAuth(true, { pin: '0000' })).rejects.toThrow(/不正确/)

    await service.setSystemAuth(true, { pin: '2468' })
    expect(service.state().keyGuard.systemAuthEnabled).toBe(true)
    await service.copyProviderKey('ds', { system: true })
    expect(copied).toEqual([KEY])
    expect(prompts).toEqual(['设置 Pittacus Relay 的 PIN', '复制 DeepSeek 的 API Key'])
  })

  it('falls back to the PIN when the prompt fails or is unavailable', async () => {
    const failing = setup()
    await failing.service.setPin('2468')
    await failing.service.setSystemAuth(true, { pin: '2468' })
    failing.system.ok = false
    await expect(failing.service.copyProviderKey('ds', { system: true })).rejects.toThrow(/验证未通过，请输入 PIN/)
    await failing.service.copyProviderKey('ds', { pin: '2468' })
    expect(failing.copied).toEqual([KEY])

    const absent = setup({ available: false })
    await absent.service.setPin('2468')
    await expect(absent.service.setSystemAuth(true, { pin: '2468' })).rejects.toThrow(/无法使用 Windows Hello/)
  })
})

describe('setting the first PIN', () => {
  it('needs the OS prompt when the device has one', async () => {
    const { service, copied, prompts } = setup({ systemOk: false })
    await expect(service.setPin('2468')).rejects.toThrow(/验证未通过，PIN 未设置/)
    expect(prompts).toEqual(['设置 Pittacus Relay 的 PIN'])
    expect(service.state().keyGuard.pinSet).toBe(false)
    await expect(service.copyProviderKey('ds', { pin: '2468' })).rejects.toThrow(/设置 PIN/)
    expect(copied).toEqual([])
  })

  it('asks again after a reset, and is first come, first served without an OS prompt', async () => {
    const { service, prompts } = setup()
    await service.setPin('2468')
    await service.resetPin()
    await service.setPin('1357')
    expect(prompts).toEqual(['设置 Pittacus Relay 的 PIN', '设置 Pittacus Relay 的 PIN'])

    const bare = setup({ available: false })
    await bare.service.setPin('2468')
    expect(bare.prompts).toEqual([])
    expect(bare.service.state().keyGuard.pinSet).toBe(true)
  })

  it('does not prompt when changing an existing PIN with the PIN', async () => {
    const { service, prompts } = setup()
    await service.setPin('2468')
    await service.setPin('1357', { pin: '2468' })
    expect(prompts).toEqual(['设置 Pittacus Relay 的 PIN'])
  })
})

describe('changing, removing and resetting the PIN', () => {
  it('needs the current PIN to change or remove it', async () => {
    const { service } = setup()
    await expect(service.setPin('12')).rejects.toThrow(/至少需要 4 位/)
    await service.setPin('2468')
    await expect(service.setPin('1111')).rejects.toThrow(/不正确/)
    await service.setPin('1111', { pin: '2468' })
    await expect(service.copyProviderKey('ds', { pin: '2468' })).rejects.toThrow(/不正确/)

    await expect(service.removePin({ pin: '2468' })).rejects.toThrow(/不正确/)
    await service.removePin({ pin: '1111' })
    expect(service.state().keyGuard).toMatchObject({ pinSet: false, systemAuthEnabled: false })
  })

  it('reset clears the PIN together with every stored key', async () => {
    const { service, make } = setup()
    await service.setPin('2468')
    await service.resetPin()
    const state = make().state()
    expect(state.keyGuard.pinSet).toBe(false)
    expect(state.providers[0].hasKey).toBe(false)
    expect(state.notices.join()).toMatch(/DeepSeek/)
  })
})
