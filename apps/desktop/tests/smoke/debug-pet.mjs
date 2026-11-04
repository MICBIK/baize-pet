// SPDX-License-Identifier: AGPL-3.0-only
// Smoke-test diagnostic: dump the pet window's renderer state (dev tool, not
// part of the suite).
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
const electronPath = desktopRequire('electron')
const tempHome = mkdtempSync(join(tmpdir(), 'baize-debug-'))

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
      if (page.url().includes('index.html')) petPage = page
    }
    if (!petPage) await new Promise((r) => setTimeout(r, 250))
  }
  if (!petPage) throw new Error('no pet window')
  await petPage.waitForTimeout(4000)
  const state = await petPage.evaluate(() => ({
    canvases: [...document.querySelectorAll('canvas')].map((c) => ({
      w: c.width,
      h: c.height,
      cls: c.className,
    })),
    videos: document.querySelectorAll('video').length,
    imgs: [...document.querySelectorAll('img')].map((i) => i.src.slice(0, 60)),
    bodySnippet: document.body.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
  }))
  console.log(JSON.stringify(state, null, 1))
} finally {
  await electronApp.close()
}
