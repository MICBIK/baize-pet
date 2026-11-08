// SPDX-License-Identifier: AGPL-3.0-only
// Round-7 extreme-pose shots from tools/rig-viewer (must run on port 5178).
// Same ten poses and head crop as demo/rig-handoff/r7-diag/shoot-extreme-poses.cjs
// (the acceptance party's script), plus --bg white|black for the P7 dark set.
// Usage: node tools/rig-pipeline/shoot_extreme_poses.cjs <outdir> [--bg black]
//        (clear tools/rig-viewer/node_modules/.vite and rebuild @baize/rig first)
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
const bgIdx = process.argv.indexOf('--bg')
const BG = bgIdx >= 0 ? process.argv[bgIdx + 1] : 'white'
;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const b = await launch()
  const p = await (await b.newContext({ viewport: { width: 2000, height: 1800 } })).newPage()
  await p.goto('http://localhost:5178/')
  await p.waitForFunction(() => document.querySelectorAll('#panel button').length > 10, null, {
    timeout: 20000,
  })
  await p.addStyleTag({ content: '#pet { width: 1600px !important; height: 1600px !important; }' })
  const clickText = async (t, sec) =>
    p.evaluate(
      ([t, sec]) => {
        const panel = document.getElementById('panel')
        let cur = null
        for (const n of panel.children) {
          if (n.tagName === 'H2') cur = n.textContent
          const bs = n.tagName === 'BUTTON' ? [n] : [...n.querySelectorAll('button')]
          const f = bs.find((x) => x.textContent === t && (!sec || cur?.includes(sec)))
          if (f) {
            f.click()
            return true
          }
        }
        return false
      },
      [t, sec],
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
  if (BG !== 'white') {
    const ok = await clickText(BG === 'black' ? '黑底' : '花哨壁纸')
    if (!ok) throw new Error(`background button not found: ${BG}`)
    await p.waitForTimeout(300)
  }
  const box = await p.locator('#pet').boundingBox()
  const HEAD = [480, 400, 640, 520]
  const poses = {
    rest: {},
    tiltm12: { 'head.tilt': -12 },
    tiltp12: { 'head.tilt': 12 },
    turnXm: { 'head.turnX': -1 },
    turnXp: { 'head.turnX': 1 },
    turnYm: { 'head.turnY': -1 },
    turnYp: { 'head.turnY': 1 },
    earm20: { 'ear.L.rot': -20, 'ear.R.rot': -20 },
    earp12: { 'ear.L.rot': 12, 'ear.R.rot': 12 },
    combo: { 'head.tilt': -12, 'head.turnX': 1, 'ear.L.rot': -20, 'ear.R.rot': 12 },
  }
  for (const [n, ps] of Object.entries(poses)) {
    await clickText('重置全部参数')
    for (const [k, v] of Object.entries(ps)) await setParam(k, v)
    await p.waitForTimeout(400)
    fs.writeFileSync(
      path.join(OUT, `${n}.png`),
      await p.screenshot({
        clip: { x: box.x + HEAD[0], y: box.y + HEAD[1], width: HEAD[2], height: HEAD[3] },
      }),
    )
  }
  await b.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
