// Builds the black & white brand set from src/renderer/src/brand/geometry.ts.
//
// Usage: npm run brand            (needs Pillow for the .ico files; set PYTHON
//        to pick the interpreter)
//
// Writes design/brand/:
//   svg/      static icons (dark = black tile, light = white tile), the bare
//             mark in currentColor, and a self-contained animated SVG
//   png/      16-1024px; 32px and below use the compact glyph
//   ico/      Windows icons, one per tile colour
//   showcase.html   motion spec page, from showcase.src.html (embeds
//                   reference/original-dark-256.png for the before/after)
//
// and the app's own icons (dark variant):
//   build/icon.png        1024px on the macOS grid (tile + margin) -> .icns
//   build/icon.ico        16-256px, cropped to the tile so it fills the taskbar
//   resources/icon.png    256px window icon (cropped)
//   resources/tray.png    16px + tray@2x.png 32px (compact glyph on its tile; macOS)
//   resources/tray-{dark,light}.ico   Windows tray: bare glyph, white for a dark
//                         taskbar / black for a light one, 16-48px frames
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPACT, FULL, squircle, strandVars } from '../src/renderer/src/brand/geometry.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'design/brand')
const CSS = readFileSync(join(ROOT, 'src/renderer/src/brand/hydra-mark.css'), 'utf8')

const INK = '#0b0b0c'
const PAPER = '#ffffff'
// The white tile gets a faint rim so it doesn't vanish on white desktops.
const THEMES = { dark: { tile: INK, ink: PAPER }, light: { tile: PAPER, ink: INK, rim: true } }
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const APP_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
/** One tray frame per Windows scale step, 100% to 300%, so none is resampled. */
const TRAY_SIZES = [16, 20, 24, 32, 40, 48]
/** Tray glyph colour per taskbar theme (the taskbar can differ from the app theme). */
const TRAY_INKS = { dark: PAPER, light: INK }
/** Windows icons crop to the tile plus this fraction of its side on each edge. */
const WIN_MARGIN = 0.02

const geometryFor = (size) => (size <= 32 ? COMPACT : FULL)

function staticSvg(g, { tile, ink, rim }, size, crop) {
  const dims = size ? ` width="${size}" height="${size}"` : ''
  // `crop` (a margin fraction) zooms the view onto the tile instead of the full grid.
  const pad = crop === undefined ? 0 : g.tile.size * crop
  const view = crop === undefined ? '0 0 1024 1024' : `${g.tile.at - pad} ${g.tile.at - pad} ${g.tile.size + 2 * pad} ${g.tile.size + 2 * pad}`
  const lines = g.strands
    .map((s) => `<path d="${s.d}"/>`)
    .join('')
  // Keep the rim about one device pixel wide whatever the export size.
  const rimAttr = rim ? ` stroke="#000" stroke-opacity=".14" stroke-width="${Math.max(4, 1024 / (size ?? 256))}"` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}"${dims}>` +
    (tile ? `<path fill="${tile}"${rimAttr} d="${squircle(g.tile.at, g.tile.size)}"/>` : '') +
    `<g fill="none" stroke="${ink}" stroke-width="${g.stroke}" stroke-linecap="round" stroke-linejoin="round">${lines}</g>` +
    `<circle fill="${ink}" cx="512" cy="${g.dot.cy}" r="${g.dot.r}"/></svg>\n`
  )
}

/**
 * Windows tray glyph: the compact mark with no tile, cropped to its own bounds
 * so it fills the notification-area slot, and never thinner than ~1.65px.
 */
const TRAY_VIEW = { at: [182, 205], side: 660 }
function traySvg(size, ink) {
  const g = COMPACT
  const stroke = Math.max(g.stroke, (1.65 * TRAY_VIEW.side) / size)
  const r = Math.max(g.dot.r, stroke * 1.05)
  const lines = g.strands.map((s) => `<path d="${s.d}"/>`).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${TRAY_VIEW.at.join(' ')} ${TRAY_VIEW.side} ${TRAY_VIEW.side}" width="${size}" height="${size}">` +
    `<g fill="none" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${lines}</g>` +
    `<circle fill="${ink}" cx="512" cy="${g.dot.cy}" r="${r}"/></svg>\n`
  )
}

function animatedSvg(g, { tile, ink }) {
  const vars = (s) =>
    Object.entries(strandVars(s))
      .map(([k, v]) => `${k}:${v}`)
      .join(';')
  const strands = g.strands
    .map(
      (s) =>
        `<g class="hm-s" style="${vars(s)}"><g class="hm-sway"><g class="hm-open">` +
        `<path class="hm-line" pathLength="1" d="${s.d}"/><path class="hm-bead" pathLength="1" d="${s.d}"/>` +
        `</g></g></g>`
    )
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" class="hm hm-intro hm-live hm-active" ` +
    `style="--hm-ink:${ink};--hm-tile:${tile};--hm-w:${g.stroke}px;--hm-dot-y:${g.dot.cy}px">` +
    `<style>${CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')}</style>` +
    `<path class="hm-tile" d="${squircle(g.tile.at, g.tile.size)}"/>` +
    `<circle class="hm-ring" cx="512" cy="${g.dot.cy}" r="${g.dot.r}"/>${strands}` +
    `<g class="hm-core"><circle class="hm-dot" cx="512" cy="${g.dot.cy}" r="${g.dot.r}"/></g></svg>\n`
  )
}

for (const dir of ['svg', 'png', 'ico']) mkdirSync(join(OUT, dir), { recursive: true })

// SVG
const write = (rel, text) => writeFileSync(join(OUT, rel), text)
write('svg/hydra-mark.svg', staticSvg(FULL, { ink: 'currentColor' }))
write('svg/hydra-mark-compact.svg', staticSvg(COMPACT, { ink: 'currentColor' }))
for (const [name, theme] of Object.entries(THEMES)) {
  write(`svg/hydra-icon-${name}.svg`, staticSvg(FULL, theme))
  write(`svg/hydra-icon-${name}-compact.svg`, staticSvg(COMPACT, theme))
  write(`svg/hydra-animated-${name}.svg`, animatedSvg(FULL, theme))
}

// PNG, rasterised by Chromium so the output matches what the app draws.
const APP = THEMES.dark
const TMP = join(OUT, 'png/.app')
mkdirSync(TMP, { recursive: true })
const winPng = (size) => join(TMP, `win-${size}.png`)
const jobs = []
for (const [name, theme] of Object.entries(THEMES))
  for (const size of PNG_SIZES)
    jobs.push({ size, svg: staticSvg(geometryFor(size), theme, size), out: join(OUT, `png/hydra-${name}-${size}.png`) })
jobs.push({ size: 1024, svg: staticSvg(FULL, APP, 1024), out: join(ROOT, 'build/icon.png') })
for (const size of APP_ICO_SIZES)
  jobs.push({ size, svg: staticSvg(geometryFor(size), APP, size, WIN_MARGIN), out: winPng(size) })
jobs.push({ size: 256, svg: staticSvg(FULL, APP, 256, WIN_MARGIN), out: join(ROOT, 'resources/icon.png') })
jobs.push({ size: 16, svg: staticSvg(COMPACT, APP, 16, WIN_MARGIN), out: join(ROOT, 'resources/tray.png') })
jobs.push({ size: 32, svg: staticSvg(COMPACT, APP, 32, WIN_MARGIN), out: join(ROOT, 'resources/tray@2x.png') })
const trayPng = (theme, size) => join(TMP, `tray-${theme}-${size}.png`)
for (const [theme, ink] of Object.entries(TRAY_INKS))
  for (const size of TRAY_SIZES) jobs.push({ size, svg: traySvg(size, ink), out: trayPng(theme, size) })
const jobFile = join(TMP, 'jobs.json')
writeFileSync(jobFile, JSON.stringify(jobs))
const electron = join(ROOT, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
execFileSync(electron, [join(ROOT, 'scripts/brand-render.cjs'), jobFile], { stdio: 'inherit' })

// ICO
// `crisp` stretches alpha 40..200 -> 0..255 on frames of 24px and below: the
// anti-aliased fringe of a 1.6px line otherwise reads as blur in the tray.
const py = [
  'import sys',
  'from PIL import Image',
  'crisp, out, *paths = sys.argv[1:]',
  'ramp = lambda v: 0 if v <= 40 else 255 if v >= 200 else round((v - 40) * 255 / 160)',
  'def load(p):',
  '    im = Image.open(p).convert("RGBA")',
  '    if crisp == "1" and im.width <= 24:',
  '        r, g, b, a = im.split()',
  '        im = Image.merge("RGBA", (r, g, b, a.point(ramp)))',
  '    return im',
  'imgs = [load(p) for p in paths]',
  'imgs[-1].save(out, format="ICO", sizes=[i.size for i in imgs], append_images=imgs[:-1])'
].join('\n')
const ico = (out, pngs, crisp = false) =>
  execFileSync(process.env.PYTHON ?? 'python', ['-c', py, crisp ? '1' : '0', out, ...pngs], { stdio: 'inherit' })
for (const name of Object.keys(THEMES))
  ico(join(OUT, `ico/hydra-${name}.ico`), ICO_SIZES.map((s) => join(OUT, `png/hydra-${name}-${s}.png`)))
ico(join(ROOT, 'build/icon.ico'), APP_ICO_SIZES.map(winPng))
for (const theme of Object.keys(TRAY_INKS))
  ico(join(ROOT, `resources/tray-${theme}.ico`), TRAY_SIZES.map((s) => trayPng(theme, s)), true)
rmSync(TMP, { recursive: true, force: true })

// Showcase
const geometryJson = JSON.stringify({
  FULL: { ...FULL, tilePath: squircle(FULL.tile.at, FULL.tile.size) },
  COMPACT: { ...COMPACT, tilePath: squircle(COMPACT.tile.at, COMPACT.tile.size) }
})
const page = readFileSync(join(OUT, 'showcase.src.html'), 'utf8')
  .replace('/*@CSS*/', () => CSS)
  .replace('/*@GEOMETRY*/', () => `const GEOMETRY = ${geometryJson};`)
  .replace('/*@BEFORE*/', () => {
    const png = readFileSync(join(OUT, 'reference/original-dark-256.png')).toString('base64')
    return `data:image/png;base64,${png}`
  })
write('showcase.html', page)

console.log(`brand: svg, png, ico and showcase written to ${OUT}`)
console.log('app icons: build/icon.{png,ico}, resources/{icon,tray,tray@2x}.png')
