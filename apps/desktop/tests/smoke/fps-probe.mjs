// SPDX-License-Identifier: AGPL-3.0-only
// Idle animation probe: launch the built app, count rAF frames inside the
// pet renderer for 6 s (visible window), then report fps + the renderer's
// process CPU sampled concurrently by the caller.
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
const electronPath = desktopRequire('electron')
const tempHome = mkdtempSync(join(tmpdir(), 'baize-fps-'))

const electronApp = await _electron.launch({
  executablePath: electronPath,
  args: [desktopRoot.slice(0, -1), `--user-data-dir=${join(tempHome, 'user-data')}`],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
})
try {
  let petPage = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !petPage) {
    for (const page of electronApp.windows()) {
      if (page.url().endsWith('index.html')) petPage = page
    }
    if (!petPage) await new Promise((r) => setTimeout(r, 250))
  }
  await petPage.waitForTimeout(2500)

  const state = await petPage.evaluate(() => ({
    pidInfo: null,
    visibility: document.visibilityState,
    canvasW: document.querySelector('canvas')?.width ?? 0,
    canvasH: document.querySelector('canvas')?.height ?? 0,
  }))
  console.log(JSON.stringify(state))

  // First getAppMetrics() call resets the CPU counters; the second call after
  // the rAF window below reports usage accumulated over that exact window.
  await electronApp.evaluate(({ app }) => app.getAppMetrics().map((m) => m.type))

  const fps = await petPage.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0
        const t0 = performance.now()
        const tick = () => {
          frames++
          if (performance.now() - t0 < 6000) requestAnimationFrame(tick)
          else resolve({ fps: +((frames * 1000) / (performance.now() - t0)).toFixed(1), frames })
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(JSON.stringify(fps))
  const cpu = await electronApp.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .map((m) => ({ type: m.type, pid: m.pid, cpu: +(m.cpu?.percentCPUUsage ?? 0).toFixed(2) }))
      .sort((a, b) => b.cpu - a.cpu),
  )
  console.log(JSON.stringify({ cpuByProcess: cpu }))
} finally {
  await electronApp.close()
}
