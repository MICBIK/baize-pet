// SPDX-License-Identifier: AGPL-3.0-only
// Round-7 P8 consistency shots: full-canvas viewer frames (white bg, breath
// frozen at 0) for the four poses qa_pack.py compares against its own
// composite. Requires the viewer on port 5178 with a FRESH runtime bundle
// (clear tools/rig-viewer/node_modules/.vite, rebuild @baize/rig, vite --force).
// Usage: node tools/rig-pipeline/shoot_p8.cjs <outdir>
const fs = require('node:fs')
const path = require('node:path')
let chromium
try {
  chromium = require('playwright').chromium
} catch {
  chromium = require('playwright-core').chromium
}
const { globSync } = require('node:fs')
const launch = async () => {
  try {
    return await chromium.launch()
  } catch (e) {
    const s = globSync(
      `${process.env.HOME}/Library/Caches/ms-playwright/chromium*-*/chrome-*/chrome-headless-shell`,
    )
    if (!s.length) throw e
    return chromium.launch({ executablePath: s.sort().pop() })
  }
}
const OUT = process.argv[2]
;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const b = await launch()
  const p = await (await b.newContext({ viewport: { width: 2000, height: 1800 } })).newPage()
  await p.goto('http://localhost:5178/')
  await p.waitForFunction(() => document.querySelectorAll('#panel button').length > 10, null, {
    timeout: 20000,
  })
  await p.addStyleTag({ content: '#pet { width: 1600px !important; height: 1600px !important; }' })
  const clickText = async (t) =>
    p.evaluate(
      ([t]) => {
        const panel = document.getElementById('panel')
        for (const n of panel.children) {
          const bs = n.tagName === 'BUTTON' ? [n] : [...n.querySelectorAll('button')]
          const f = bs.find((x) => x.textContent === t)
          if (f) {
            f.click()
            return true
          }
        }
        return false
      },
      [t],
    )
  const setParam = async (k, v) =>
    p.evaluate(
      ([k, v]) => {
        const s = document.getElementById(`ctl-${k}`)
        s.value = String(v)
        s.dispatchEvent(new Event('input'))
      },
      [k, v],
    )
  await p.waitForTimeout(500)
  const box = await p.locator('#pet').boundingBox()
  // Override every procedural life channel (idle breath bob, head noise,
  // blink) so the frame matches pose_dump's parameter-only solve.
  const FROZEN = { 'body.breath': 0, 'head.y': 0, 'head.tilt': 0, 'eye.L.open': 1, 'eye.R.open': 1 }
  const poses = {
    'p8-rest': {},
    'p8-tiltm12': { 'head.tilt': -12 },
    'p8-turnXp1': { 'head.turnX': 1 },
    'p8-turnYp1': { 'head.turnY': 1 },
  }
  for (const [n, ps] of Object.entries(poses)) {
    await clickText('重置全部参数')
    for (const [k, v] of Object.entries({ ...FROZEN, ...ps })) await setParam(k, v)
    await p.waitForTimeout(400)
    fs.writeFileSync(
      path.join(OUT, `${n}.png`),
      await p.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } }),
    )
  }
  await b.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
