// SPDX-License-Identifier: AGPL-3.0-only
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
      if (page.url().endsWith('index.html')) petPage = page
    }
    if (!petPage) await new Promise((r) => setTimeout(r, 250))
  }
  await petPage.waitForTimeout(3000)
  const probe = await petPage.evaluate(async () => {
    const out = {}
    try {
      const r = await fetch('baize-character://baize-b3/rig/rig.json')
      out.manifest = r.status
    } catch (e) {
      out.manifest = 'ERR ' + String(e).slice(0, 120)
    }
    try {
      const r2 = await fetch('baize-character://baize-b3/rig/parts/torso.png')
      out.part = r2.status
    } catch (e) {
      out.part = 'ERR ' + String(e).slice(0, 120)
    }
    out.packId = localStorage.getItem('baize.pack') ?? 'none'
    return out
  })
  console.log(JSON.stringify(probe, null, 1))
} finally {
  await electronApp.close()
}
