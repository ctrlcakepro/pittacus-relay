// Installs (or upgrades in place) the freshly built Windows installer for this
// machine's architecture, then launches the installed app.
// Usage: npm run install:win   (builds first, then runs this script)
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  console.error('install-local only supports Windows for now.')
  process.exit(1)
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const installer = join('dist', `Pittacus-Relay-${version}-win-${process.arch}.exe`)
if (!existsSync(installer)) {
  console.error(`Installer not found: ${installer}. Run "npm run dist:win" first.`)
  process.exit(1)
}

const exe = join(process.env.LOCALAPPDATA, 'Programs', 'Pittacus Relay', 'Pittacus Relay.exe')
const isRunning = () =>
  execFileSync('tasklist', ['/FI', 'IMAGENAME eq Pittacus Relay.exe', '/NH'], { encoding: 'utf8' }).includes('Pittacus Relay.exe')

// The installer cannot replace files of a running app. Ask it to quit cleanly
// first: a force-kill can lose Chromium's safeStorage key and with it the saved API keys.
if (isRunning()) {
  if (existsSync(exe)) execFileSync(exe, ['--quit'], { stdio: 'ignore' })
  const deadline = Date.now() + 10000
  while (isRunning() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
  if (isRunning()) {
    console.warn('Pittacus Relay did not exit in time; force-stopping it.')
    execFileSync('taskkill', ['/IM', 'Pittacus Relay.exe', '/F'], { stdio: 'ignore' })
  } else {
    console.log('Stopped the running Pittacus Relay.')
  }
}

console.log(`Installing ${installer} …`)
// /S = silent per-user install into %LOCALAPPDATA%\Programs\Pittacus Relay (no admin rights).
execFileSync(installer, ['/S'], { stdio: 'inherit' })

if (!existsSync(exe)) {
  console.error(`Install finished but ${exe} is missing.`)
  process.exit(1)
}
spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
console.log(`Installed and launched ${exe}`)
