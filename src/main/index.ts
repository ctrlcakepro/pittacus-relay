import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent
} from 'electron'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RelayService, type LoginItem } from '../core/service'
import { ConfigStore, plainCodec, type SecretCodec } from '../core/store'
import { ClaudeCodeIntegration } from '../core/integrations/claudeCode'
import { CodexIntegration } from '../core/integrations/codex'
import { OpencodeIntegration } from '../core/integrations/opencode'
import type { Accent, KeyAuth, LanguagePref, ProviderDraft, ThemePref } from '../shared/api'
import { t } from '../shared/i18n'
import { createSecretClipboard, createSystemAuth } from './keyAccess'

// Packaged builds ship resources/ via extraResources, outside app.asar.
const resource = (name: string) =>
  app.isPackaged ? join(process.resourcesPath, name) : join(__dirname, '../../resources', name)

let win: BrowserWindow | null = null
let tray: Tray | null = null
let service: RelayService
const systemAuth = createSystemAuth(() => win)
let quitting = false
let hideNoticeShown = false

// Must match appId in electron-builder.yml; it also names the Windows Run-key value.
const APP_ID = 'io.github.ctrlcakepro.pittacus-relay'
/** Height of the drag strip; keep in sync with --titlebar in styles.css. */
const TITLEBAR_HEIGHT = 44
// Marks launches made by the OS at login (Windows passes it via the Run key).
const AUTOSTART_ARG = '--autostart'
// `Pittacus Relay --quit` asks a running instance to exit cleanly (used by install scripts;
// a force-kill right after first run can lose Chromium's safeStorage key).
const QUIT_ARG = '--quit'

function createLoginItem(): LoginItem {
  if (!app.isPackaged) {
    return {
      supported: false,
      isEnabled: () => false,
      setEnabled: () => {},
      note: () => t('loginItem.devMode')
    }
  }
  if (process.platform === 'win32') {
    return {
      supported: true,
      isEnabled: () => app.getLoginItemSettings({ args: [AUTOSTART_ARG] }).openAtLogin,
      setEnabled: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled, args: [AUTOSTART_ARG] }),
      note: () => undefined
    }
  }
  if (process.platform === 'darwin') {
    return {
      supported: true,
      isEnabled: () => app.getLoginItemSettings().openAtLogin,
      setEnabled: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
      note: () =>
        app.getLoginItemSettings().status === 'requires-approval'
          ? t('loginItem.macApproval')
          : undefined
    }
  }
  return { supported: false, isEnabled: () => false, setEnabled: () => {}, note: () => t('loginItem.unsupportedOs') }
}

function launchedAtLogin(): boolean {
  if (process.argv.includes(AUTOSTART_ARG)) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}

function trayNotice(title: string, content: string): void {
  if (process.platform === 'win32') tray?.displayBalloon({ iconType: 'info', title, content })
}

/** Pushes state to the window after changes made outside it (e.g. from the tray menu). */
function broadcastState(): void {
  win?.webContents.send('relay:state', service.state())
}

function createCodec(): SecretCodec {
  if (!safeStorage.isEncryptionAvailable()) return plainCodec
  return {
    secure: true,
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
  }
}

/** The renderer's own pages: the dev server in development, the bundled file otherwise. */
function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (process.env.ELECTRON_RENDERER_URL) return u.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    return u.protocol === 'file:' && u.pathname === pathToFileURL(join(__dirname, '../renderer/index.html')).pathname
  } catch {
    return false
  }
}

/**
 * The preload bridge can make the main process act on stored keys, so no other page
 * may ever load into Pittacus Relay's window, and IPC is answered only for Pittacus Relay's own page.
 */
function hardenContents(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (!isAppUrl(url)) e.preventDefault()
    })
    contents.on('will-redirect', (e, url) => {
      if (!isAppUrl(url)) e.preventDefault()
    })
    contents.on('will-attach-webview', (e) => e.preventDefault())
  })
  // Pittacus Relay needs no camera, notifications, clipboard-read, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

/**
 * Node's fetch ignores the system proxy, so providers that are only reachable through one
 * (OpenAI, Gemini, … from mainland China) time out. Chromium's network stack honours it.
 * An in-memory session keeps upstream traffic apart from the UI's cookies and cache.
 */
function upstreamFetch(): typeof fetch {
  const upstream = session.fromPartition('relay-upstream', { cache: false })
  return ((input: string, init?: RequestInit) =>
    // With redirect: 'manual', net.fetch rejects instead of returning the 3xx response.
    upstream.fetch(input, { ...init, credentials: 'omit' }).catch((err: Error) => {
      if (err?.message !== 'Redirect was cancelled') throw err
      throw new Error('the provider redirected, and Pittacus Relay does not follow redirects with your API key')
    })) as typeof fetch
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  return !!win && e.sender === win.webContents && !!frame && frame === e.sender.mainFrame && isAppUrl(frame.url)
}

/** Caption-button colors; must track --bg / --text in styles.css. */
function titleBarOverlay(): Electron.TitleBarOverlay {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: dark ? '#161618' : '#fafafa', symbolColor: dark ? '#e9e9ec' : '#1d1d1f', height: TITLEBAR_HEIGHT }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: 'Pittacus Relay',
    icon: resource('icon.png'),
    // Matches the renderer's --bg so there is no white flash before first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161618' : '#fafafa',
    // The sidebar carries the only logo and name, so the native title bar is hidden;
    // Windows/Linux keep native caption buttons as an overlay, macOS keeps inset traffic lights.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: titleBarOverlay() }),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  // The gateway must keep serving agent tools, so closing only hides the window.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
      if (!hideNoticeShown) {
        hideNoticeShown = true
        trayNotice(t('tray.backgroundTitle'), t('tray.backgroundBody'))
      }
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win) createWindow()
  else {
    win.show()
    win.focus()
  }
}

/**
 * Windows gets an .ico with a frame per scale step (100-300%) so the shell never
 * resamples it, drawn white or black to suit the taskbar. The taskbar follows the
 * system theme, which can differ from the app theme nativeTheme reports.
 */
function trayIcon(): Electron.NativeImage | string {
  if (process.platform === 'win32') return resource(`tray-${taskbarIsLight() ? 'light' : 'dark'}.ico`)
  const image = nativeImage.createFromPath(resource('tray.png'))
  // macOS sizes menu bar icons in points; 32px would render oversized.
  return process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image
}

function taskbarIsLight(): boolean {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'],
      { encoding: 'utf8', windowsHide: true }
    )
    return /SystemUsesLightTheme\s+REG_DWORD\s+0x1\b/.test(out)
  } catch {
    return false // value absent before Windows 10 1903: dark taskbar
  }
}

function updateTray(): void {
  if (!tray) return
  const s = service.state()
  const status = s.gateway.running
    ? t('tray.running', { url: s.baseUrl })
    : s.gateway.error
      ? t('tray.stoppedWithError', { error: s.gateway.error })
      : t('tray.stopped')
  const toggle = (fn: () => unknown) => () => {
    try {
      fn()
    } catch (err) {
      trayNotice('Pittacus Relay', (err as Error).message)
    }
    updateTray()
    broadcastState()
  }
  tray.setToolTip(`Pittacus Relay — ${status}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: t('tray.open'), click: showWindow },
      { type: 'separator' },
      {
        label: t('tray.launchAtLogin'),
        type: 'checkbox',
        checked: s.startup.launchAtLogin,
        enabled: s.startup.launchAtLoginSupported,
        click: toggle(() => service.setLaunchAtLogin(!s.startup.launchAtLogin))
      },
      {
        label: t('tray.startHidden'),
        type: 'checkbox',
        checked: s.startup.startHidden,
        click: toggle(() => service.setStartHidden(!s.startup.startHidden))
      },
      { type: 'separator' },
      {
        label: t('tray.quit'),
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function registerIpc(): void {
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) =>
    ipcMain.handle(`relay:${channel}`, async (e, ...args) => {
      if (!isTrustedSender(e)) throw new Error('Rejected IPC from an untrusted frame.')
      const result = await fn(...(args as A))
      updateTray()
      return result
    })

  handle('getState', () => service.state())
  handle('saveProvider', (d: ProviderDraft) => service.saveProvider(d))
  handle('deleteProvider', (id: string) => service.deleteProvider(id))
  handle('setProviderEnabled', (id: string, enabled: boolean) => service.setProviderEnabled(id, enabled))
  handle('fetchModels', (d: ProviderDraft) => service.fetchModels(d))
  handle('setDefaults', (d?: string, s?: string) => service.setDefaults(d, s))
  handle('setStartHidden', (enabled: boolean) => service.setStartHidden(enabled))
  handle('setLaunchAtLogin', (enabled: boolean) => service.setLaunchAtLogin(enabled))
  handle('setLanguage', (language: LanguagePref) => service.setLanguage(language))
  handle('setTheme', (theme: ThemePref) => {
    const result = service.setTheme(theme)
    // Drives prefers-color-scheme in the renderer and, via 'updated', the caption buttons.
    nativeTheme.themeSource = service.theme
    return result
  })
  handle('setAccent', (accent: Accent) => service.setAccent(accent))
  handle('getUsage', () => service.usageRecords())
  handle('clearUsage', () => service.clearUsage())
  handle('regenerateKey', () => service.regenerateKey())
  handle('setPort', (port: number) => service.setPort(port))
  handle('applyIntegration', (id: string) => service.applyIntegration(id))
  handle('restoreIntegration', (id: string) => service.restoreIntegration(id))
  handle('copyProviderKey', (id: string, auth: KeyAuth) => service.copyProviderKey(id, auth))
  handle('setPin', async (pin: string, auth?: KeyAuth) => {
    // A first PIN needs the OS prompt whenever it exists, so availability must be current,
    // not whatever the startup probe (possibly still running) found.
    await systemAuth.refresh()
    return service.setPin(pin, auth)
  })
  handle('removePin', (auth: KeyAuth) => service.removePin(auth))
  handle('resetPin', () => service.resetPin())
  handle('setSystemAuth', async (enabled: boolean, auth?: KeyAuth) => {
    // The user may have set up Windows Hello since launch.
    if (enabled) await systemAuth.refresh()
    return service.setSystemAuth(enabled, auth)
  })
  handle('openExternal', async (url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) await shell.openExternal(url)
  })
}

async function startApp(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
  hardenContents()
  const codec = createCodec()
  service = new RelayService({
    fetchImpl: upstreamFetch(),
    store: new ConfigStore(join(app.getPath('userData'), 'config.json'), codec),
    // The codec also seals the credentials Claude Code's settings held before Pittacus Relay took over.
    integrations: [new ClaudeCodeIntegration(undefined, codec), new CodexIntegration(), new OpencodeIntegration()],
    secureStorage: codec.secure,
    loginItem: createLoginItem(),
    systemAuth,
    clipboard: createSecretClipboard(),
    onLog: (log) => win?.webContents.send('relay:log', log),
    usageFile: join(app.getPath('userData'), 'usage.json'),
    systemLanguage: app.getPreferredSystemLanguages()[0] ?? app.getLocale()
  })
  // Before any window exists, so the first paint and backgroundColor already use it.
  nativeTheme.themeSource = service.theme
  await service.start()
  registerIpc()
  // Probing Windows Hello spawns PowerShell; do it off the startup path.
  systemAuth.refresh().then(broadcastState)

  tray = new Tray(trayIcon())
  nativeTheme.on('updated', () => {
    tray?.setImage(trayIcon())
    if (win && process.platform !== 'darwin') win.setTitleBarOverlay(titleBarOverlay())
  })
  tray.on('click', showWindow)
  updateTray()

  // Silent start: stay in the tray; the window is created on first open.
  if (!service.startHidden) createWindow()
  else if (!launchedAtLogin()) trayNotice(t('tray.silentTitle'), t('tray.silentBody'))

  app.on('activate', showWindow)
}

// DevTools-protocol switches would let any local program drive Pittacus Relay's window and its
// IPC bridge; the fuses cover --inspect but not these Chromium switches.
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe'].some((s) => app.commandLine.hasSwitch(s))) {
  // Synchronous on purpose: nothing below (window, gateway) may start.
  process.exit(1)
}

// Lets development and tests run against a throwaway data directory.
if (process.env.PITTACUS_RELAY_DATA_DIR) app.setPath('userData', process.env.PITTACUS_RELAY_DATA_DIR)

// Always request the lock first: that is what forwards our argv (e.g. --quit)
// to an already running instance.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock || process.argv.includes(QUIT_ARG)) {
  // Either another instance got our argv, or nothing is running and --quit is a no-op.
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes(QUIT_ARG)) {
      quitting = true
      app.quit()
    } else showWindow()
  })

  app.whenReady().then(startApp).catch((err) => {
    dialog.showErrorBox(t('dialog.startFailed'), String(err?.stack ?? err))
    quitting = true
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    service?.stop()
  })
  // Keep running in the tray when every window is closed.
  app.on('window-all-closed', () => {})
}
