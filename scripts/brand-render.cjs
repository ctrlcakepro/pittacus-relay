// Electron helper for scripts/brand.mjs: rasterises SVG jobs to PNG offscreen.
// Usage: electron scripts/brand-render.cjs <jobs.json>   [{ size, svg, out }]
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'))
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')
  for (const job of jobs) {
    const src = `data:image/svg+xml;base64,${Buffer.from(job.svg).toString('base64')}`
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      img.src = ${JSON.stringify(src)}
      await img.decode()
      const c = document.createElement('canvas')
      c.width = c.height = ${job.size}
      c.getContext('2d').drawImage(img, 0, 0, ${job.size}, ${job.size})
      return c.toDataURL('image/png')
    })()`)
    fs.writeFileSync(job.out, Buffer.from(png.split(',')[1], 'base64'))
  }
  fs.rmSync(process.argv[process.argv.length - 1])
  app.quit()
})
