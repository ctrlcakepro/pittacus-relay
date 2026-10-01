import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeJsonObject } from '../src/core/integrations/jsonFile'
import { checkLocalRequest, isLoopbackHost, keyMayFollow } from '../src/core/security'
import { ConfigStore } from '../src/core/store'

describe('security helpers', () => {
  it('recognises loopback hosts only', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.8.9.10', '[::1]', 'LOCALHOST.']) {
      expect(isLoopbackHost(h), h).toBe(true)
    }
    for (const h of ['localhost.evil.com', '127.0.0.1.nip.io', '10.0.0.1', '[::ffff:7f00:1]', 'example.com']) {
      expect(isLoopbackHost(h), h).toBe(false)
    }
  })

  it('lets a key follow path changes but not origin changes', () => {
    const before = { anthropicBaseUrl: 'https://a.com/anthropic', openaiBaseUrl: 'https://a.com/v1' }
    expect(keyMayFollow(before, { openaiBaseUrl: 'https://a.com/v2' })).toBe(true)
    expect(keyMayFollow(before, { openaiBaseUrl: 'http://a.com/v1' })).toBe(false)
    expect(keyMayFollow(before, { openaiBaseUrl: 'https://a.com:8443/v1' })).toBe(false)
    expect(keyMayFollow(before, { ...before, openaiBaseUrl: 'https://b.com/v1' })).toBe(false)
  })

  it('checks Host and Origin', () => {
    expect(checkLocalRequest('127.0.0.1:17800', undefined)).toBeUndefined()
    expect(checkLocalRequest(undefined, 'null')).toBeUndefined()
    expect(checkLocalRequest('evil.com', undefined)).toMatch(/this machine/)
    expect(checkLocalRequest('127.0.0.1:17800', 'https://evil.com')).toMatch(/web pages/)
    expect(checkLocalRequest('127.0.0.1:17800', 'app://relay')).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('file permissions', () => {
  it('writes tool configs and the Pittacus Relay config owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-perm-'))
    const settings = join(dir, 'settings.json')
    writeJsonObject(settings, { env: { ANTHROPIC_AUTH_TOKEN: 'x' } })
    expect(statSync(settings).mode & 0o777).toBe(0o600)

    const config = join(dir, 'relay', 'config.json')
    new ConfigStore(config).load()
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'relay')).mode & 0o777).toBe(0o700)
  })
})
