// OS pieces of the key-copy feature: Windows Hello / Touch ID and a clipboard that keeps
// secrets out of clipboard history and wipes them again. The PIN logic lives in src/core.
import { clipboard, ClipboardItem, systemPreferences, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { noSystemAuth, type SecretClipboard, type SystemAuth } from '../core/keyGuard'
import { t } from '../shared/i18n'
import helloScript from './windowsHello.ps1?raw'

const CLEAR_AFTER_SECONDS = 30
/** Long enough for the user to find their phone or retry a fingerprint. */
const HELLO_TIMEOUT_MS = 3 * 60_000

export interface ShellSystemAuth extends SystemAuth {
  /** Re-checks whether the OS prompt can be used (e.g. after the user set up Windows Hello). */
  refresh(): Promise<void>
}

export function createSystemAuth(getWindow: () => BrowserWindow | null): ShellSystemAuth {
  if (process.platform === 'darwin') {
    return {
      kind: 'touch-id',
      available: () => systemPreferences.canPromptTouchID(),
      // Rejects on cancel, failure and lockout alike; the PIN is the fallback for all of them.
      verify: (reason) => systemPreferences.promptTouchID(reason).then(
        () => true,
        () => false
      ),
      refresh: async () => {}
    }
  }
  if (process.platform === 'win32') return windowsHello(getWindow)
  return { ...noSystemAuth, refresh: async () => {} }
}

function windowsHello(getWindow: () => BrowserWindow | null): ShellSystemAuth {
  let available = false
  let pending = false
  const auth: ShellSystemAuth = {
    kind: 'windows-hello',
    available: () => available,
    async refresh() {
      try {
        available = (await runHello({ PR_HELLO_MODE: 'check' }, 30_000)) === 'Available'
      } catch {
        available = false
      }
    },
    async verify(reason) {
      const win = getWindow()
      if (!win) throw new Error(t('hello.openWindowFirst'))
      if (pending) throw new Error(t('hello.alreadyOpen'))
      pending = true
      try {
        win.focus()
        const result = await runHello(
          { PR_HELLO_MODE: 'verify', PR_HELLO_HWND: windowHandle(win), PR_HELLO_MESSAGE: reason },
          HELLO_TIMEOUT_MS
        )
        switch (result) {
          case 'Verified':
            return true
          case 'Canceled':
          case 'RetriesExhausted':
            return false
          case 'DeviceBusy':
            throw new Error(t('hello.busy'))
          default:
            // DeviceNotPresent / NotConfiguredForUser / DisabledByPolicy
            available = false
            throw new Error(t('hello.unavailable', { reason: result || t('hello.unknownReason') }))
        }
      } finally {
        pending = false
      }
    }
  }
  return auth
}

function windowHandle(win: BrowserWindow): string {
  const buf = win.getNativeWindowHandle()
  return (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString()
}

/** Runs windowsHello.ps1 through stdin (it ships inside app.asar) and returns its last output line. */
function runHello(env: Record<string, string>, timeout: number): Promise<string> {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', '-'],
      { env: { ...process.env, ...env }, windowsHide: true, timeout, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(err.killed ? t('hello.timeout') : stderr.trim() || err.message))
        else resolve(stdout.trim().split(/\r?\n/).pop() ?? '')
      }
    )
    child.stdin?.end(`${helloScript}\n\n`)
  })
}

/** Raw clipboard formats that tell clipboard history, cloud sync and clipboard managers to skip an entry. */
function concealedFormats(): Record<string, Blob> {
  const raw = (name: string) => `electron application/osclipboard;format="${name}"`
  if (process.platform === 'win32') {
    const dwordZero = new Blob([new Uint8Array(4)])
    return {
      [raw('ExcludeClipboardContentFromMonitorProcessing')]: dwordZero,
      [raw('CanIncludeInClipboardHistory')]: dwordZero,
      [raw('CanUploadToCloudClipboard')]: dwordZero
    }
  }
  if (process.platform === 'darwin') {
    // nspasteboard.org markers honoured by macOS clipboard managers.
    return { [raw('org.nspasteboard.ConcealedType')]: new Blob([]), [raw('org.nspasteboard.TransientType')]: new Blob([]) }
  }
  return {}
}

export function createSecretClipboard(): SecretClipboard {
  let timer: NodeJS.Timeout | undefined
  return {
    clearAfterSeconds: CLEAR_AFTER_SECONDS,
    async copy(secret) {
      try {
        await clipboard.write([new ClipboardItem({ 'text/plain': secret, ...concealedFormats() })])
      } catch {
        await clipboard.writeText(secret)
      }
      clearTimeout(timer)
      timer = setTimeout(async () => {
        // Leave the clipboard alone if the user has copied something else since.
        if ((await clipboard.readText().catch(() => '')) === secret) clipboard.clear()
      }, CLEAR_AFTER_SECONDS * 1000)
    }
  }
}
