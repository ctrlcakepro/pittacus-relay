// Security rules shared by the gateway, the service and the upstream fetchers.
// Kept free of Electron like the rest of src/core.
import { chmodSync } from 'node:fs'
import { t } from '../shared/i18n'

/** File mode for anything holding a key: readable by the current user only (POSIX; ignored on Windows). */
export const PRIVATE_FILE_MODE = 0o600

/** Tightens a file that may predate Pittacus Relay or have been created with a looser mode. */
export function restrictToOwner(file: string): void {
  if (process.platform !== 'win32') chmodSync(file, PRIVATE_FILE_MODE)
}

interface UpstreamUrls {
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
}

/** Hosts that resolve to this machine only. `hostname` is as URL#hostname returns it. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  )
}

/**
 * Normalises an upstream base URL, refusing anything that would expose an API key:
 * plain http is only allowed to this machine (e.g. a local Ollama), and URLs may not
 * carry credentials of their own.
 */
export function checkUpstreamUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(t('url.invalid', { url: raw }))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(t('url.invalid', { url: raw }))
  if (url.username || url.password) throw new Error(t('url.credentials'))
  if (url.search || url.hash) throw new Error(t('url.query', { url: raw }))
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error(t('url.httpsOnly', { url: raw }))
  }
  return raw.replace(/\/+$/, '')
}

/** True when a request to `target` may carry an API key. */
export function isSafeUpstream(target: string): boolean {
  try {
    const url = new URL(target)
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  } catch {
    return false
  }
}

function origins(p: UpstreamUrls): string[] {
  return [p.anthropicBaseUrl, p.openaiBaseUrl].filter((u): u is string => !!u).map((u) => new URL(u).origin)
}

/**
 * A stored API key may only follow a provider edit when every upstream origin was
 * already trusted with it. Otherwise whoever can edit settings (or a compromised UI)
 * could point an existing key at a server of their choosing.
 */
export function keyMayFollow(previous: UpstreamUrls, next: UpstreamUrls): boolean {
  const trusted = new Set(origins(previous))
  return origins(next).every((o) => trusted.has(o))
}

/**
 * Guards the local gateway against DNS rebinding and web pages: the Host header must
 * name this machine, and browser-origin requests from other sites are refused.
 * Agent tools send neither a foreign Host nor an Origin.
 */
export function checkLocalRequest(host: string | undefined, origin: string | undefined): string | undefined {
  if (host) {
    let hostname: string
    try {
      hostname = new URL(`http://${host}`).hostname
    } catch {
      return 'Invalid Host header.'
    }
    if (!isLoopbackHost(hostname)) return `Pittacus Relay only answers requests addressed to this machine, not "${host}".`
  }
  if (origin && origin !== 'null') {
    try {
      const url = new URL(origin)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLoopbackHost(url.hostname)) {
        return 'Pittacus Relay does not accept requests from web pages.'
      }
    } catch {
      return 'Invalid Origin header.'
    }
  }
  return undefined
}
