// PIN gate for copying provider API keys out of Pittacus Relay. The PIN only guards the
// copy action; keys at rest stay protected by the shell's SecretCodec. Kept free of
// Electron like the rest of src/core: the shell supplies OS verification and the clipboard.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { t } from '../shared/i18n'

export interface PinRecord {
  salt: string
  hash: string
  /** scrypt cost parameter (r = 8, p = 1). */
  n: number
}

export interface KeyGuardConfig {
  pin?: PinRecord
  /** Accept Windows Hello / Touch ID in place of the PIN. */
  systemAuth?: boolean
  /** Consecutive wrong PINs; persisted so restarting the app does not reset the lockout. */
  failures?: number
  lockedUntil?: number
}

export type SystemAuthKind = 'windows-hello' | 'touch-id'

/** OS user verification (Windows Hello, Touch ID), supplied by the desktop shell. */
export interface SystemAuth {
  readonly kind?: SystemAuthKind
  available(): boolean
  /** Resolves false when the user cancels or fails; rejects on errors worth showing. */
  verify(reason: string): Promise<boolean>
}

export const noSystemAuth: SystemAuth = { available: () => false, verify: async () => false }

/** Puts a secret on the system clipboard and wipes it again after a while. */
export interface SecretClipboard {
  readonly clearAfterSeconds: number
  copy(secret: string): Promise<void>
}

/** How the user proves it is them: the PIN, or the OS prompt. */
export type KeyAuth = { pin: string } | { system: true }

export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 64
/** Wrong PINs allowed before each further attempt is locked out. */
export const PIN_FREE_ATTEMPTS = 5

const SCRYPT_N = 1 << 15
const HASH_BYTES = 32

function derive(pin: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin.normalize('NFKC'), salt, HASH_BYTES, { N: n, r: 8, p: 1, maxmem: 256 * n * 8 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  )
}

export function checkNewPin(pin: string): void {
  if (typeof pin !== 'string' || [...pin].length < PIN_MIN_LENGTH) throw new Error(t('pin.tooShort', { count: PIN_MIN_LENGTH }))
  if ([...pin].length > PIN_MAX_LENGTH) throw new Error(t('pin.tooLong', { count: PIN_MAX_LENGTH }))
  if (pin.trim() !== pin) throw new Error(t('pin.spaces'))
}

export async function hashPin(pin: string, n = SCRYPT_N): Promise<PinRecord> {
  const salt = randomBytes(16)
  return { salt: salt.toString('base64'), hash: (await derive(pin, salt, n)).toString('base64'), n }
}

export async function pinMatches(pin: string, record: PinRecord): Promise<boolean> {
  if (typeof pin !== 'string' || !pin) return false
  const expected = Buffer.from(record.hash, 'base64')
  const actual = await derive(pin, Buffer.from(record.salt, 'base64'), record.n)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Lockout after `failures` wrong PINs in a row: 30 s, doubling, capped at 15 min. */
export function lockoutMs(failures: number): number {
  if (failures < PIN_FREE_ATTEMPTS) return 0
  return Math.min(30_000 * 2 ** (failures - PIN_FREE_ATTEMPTS), 15 * 60_000)
}

export function formatWait(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return s < 60 ? t('wait.seconds', { count: s }) : t('wait.minutes', { count: Math.ceil(s / 60) })
}
