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
  const probe = await electronApp.evaluate(async ({ protocol, net }) => {
    const out = {}
    try {
      const r = await net.fetch('baize-character://baize-b3/rig/rig.json')
      out.mainNetFetch = r.status
    } catch (e) {
      out.mainFetch = 'ERR ' + String(e).slice(0, 100)
    }
    try {
      const r = await net.fetch('file:///Users/baihaibin/Documents/WorkSpares/BaiZe/characters/baize-b3/rig/rig.json')
      out.fileFetch = r.status
    } catch (e) {
      out.fileFetch = 'ERR ' + String(e).slice(0, 100)
    }
    out.appPath = await (async () => '')() // placeholder
    return out
  })
  console.log(JSON.stringify(probe, null, 1))
} finally {
  await electronApp.close()
}
