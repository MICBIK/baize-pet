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
  await petPage.waitForTimeout(2500)
  const probe = await petPage.evaluate(async () => {
    const out = { origin: location.origin.slice(0, 40) }
    for (const [k, url] of Object.entries({
      pack: 'baize-character://baize-b3/rig/rig.json',
      packHost: 'baize-character://baize-b3/rig/rig.json',
      img: 'baize-character://baize-b3/rig/parts/torso.png',
    })) {
      try {
        const r = await fetch(url)
        out[k] = r.status
      } catch (e) {
        out[k] = 'ERR ' + String(e).slice(0, 80)
      }
    }
    out.noCors = await fetch('baize-character://baize-b3/rig/rig.json', { mode: 'no-cors' })
      .then((r) => 'type=' + r.type + ' status=' + r.status)
      .catch((e) => 'ERR ' + String(e).slice(0, 60))
    try {
      const u = new URL('baize-character://baize-b3/rig/rig.json')
      out.urlParse = u.host + ' | ' + u.pathname
    } catch (e) {
      out.urlParse = 'ERR ' + String(e).slice(0, 60)
    }
    out.imgLoad = await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve('ok ' + img.naturalWidth)
      img.onerror = () => resolve('err')
      img.src = 'baize-character://baize-b3/rig/parts/torso.png'
    })
    return out
  })
  console.log(JSON.stringify(probe, null, 1))
} finally {
  await electronApp.close()
}
