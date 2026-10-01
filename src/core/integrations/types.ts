import type { RelayConfig } from '../types'

export interface IntegrationContext {
  cfg: RelayConfig
  /** e.g. http://127.0.0.1:17800 */
  baseUrl: string
}

export interface IntegrationStatus {
  id: string
  name: string
  configPath: string
  connected: boolean
  /** Pittacus Relay has recorded originals it can restore. */
  restorable: boolean
}

export interface ApplyResult {
  configPath: string
  modelCount: number
  /** Pittacus Relay model IDs left out because the tool cannot reach them yet. */
  skipped: string[]
}

export interface Integration {
  readonly id: string
  readonly name: string
  status(ctx: IntegrationContext): IntegrationStatus
  apply(ctx: IntegrationContext): ApplyResult
  /** Returns warnings about originals that could not be brought back. */
  restore(): string[] | void
}
