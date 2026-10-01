import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { PRIVATE_FILE_MODE, restrictToOwner } from './security'
import type { RelayConfig, Provider } from './types'

/** Encrypts API keys at rest. The Electron shell plugs in safeStorage. */
export interface SecretCodec {
  readonly secure: boolean
  encrypt(plain: string): string
  decrypt(stored: string): string
}

export const plainCodec: SecretCodec = {
  secure: false,
  encrypt: (s) => s,
  decrypt: (s) => s
}

export const DEFAULT_PORT = 17800

export function generateLocalKey(): string {
  return `pittacus-${randomBytes(24).toString('base64url')}`
}

export function defaultConfig(): RelayConfig {
  return { port: DEFAULT_PORT, localKey: generateLocalKey(), providers: [] }
}

const ENC_PREFIX = 'enc:'

export interface LoadResult {
  config: RelayConfig
  /** Secrets that could not be decrypted: "localKey" and/or provider IDs. They load as empty. */
  unreadable: string[]
}

/** Loads and saves config as JSON; provider keys are encrypted on disk. */
export class ConfigStore {
  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec = plainCodec
  ) {}

  load(): LoadResult {
    if (!existsSync(this.file)) {
      const config = defaultConfig()
      this.save(config)
      return { config, unreadable: [] }
    }
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as RelayConfig
    const unreadable: string[] = []
    // A key the OS store can no longer decrypt must not stop Pittacus Relay from starting.
    const decodeOr = (value: string | undefined, label: string) => {
      try {
        return this.decode(value)
      } catch {
        unreadable.push(label)
        return ''
      }
    }
    const config: RelayConfig = {
      ...defaultConfig(),
      ...raw,
      localKey: decodeOr(raw.localKey, 'localKey') || generateLocalKey(),
      providers: (raw.providers ?? []).map((p) => ({ ...p, apiKey: decodeOr(p.apiKey, p.id) }))
    }
    // Keep the undecryptable original before anything overwrites it.
    if (unreadable.length) {
      const backup = `${this.file}.unreadable-${Date.now()}.bak`
      copyFileSync(this.file, backup)
      restrictToOwner(backup)
    }
    return { config, unreadable }
  }

  save(cfg: RelayConfig): void {
    const onDisk: RelayConfig = {
      ...cfg,
      localKey: this.encode(cfg.localKey),
      providers: cfg.providers.map((p: Provider) => ({ ...p, apiKey: this.encode(p.apiKey) }))
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    // Write-then-rename so a crash never leaves a half-written config.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    restrictToOwner(tmp)
    renameSync(tmp, this.file)
  }

  private encode(value: string): string {
    if (!value || !this.codec.secure) return value
    return ENC_PREFIX + this.codec.encrypt(value)
  }

  private decode(value: string | undefined): string {
    if (!value) return ''
    return value.startsWith(ENC_PREFIX) ? this.codec.decrypt(value.slice(ENC_PREFIX.length)) : value
  }
}
