// SPDX-License-Identifier: AGPL-3.0-only
// Round-3 acceptance screenshots: think / third-eye head close-ups (amber
// iris, no patch box edge), look-around / nod / sleep / happy frames (no
// seam lines), and a black-background full body (no bright halo outside
// the strokes). Writes into demo/rig-art/qa/ (round-3 report paths).
//
// Usage: node tools/rig-viewer/shoot-round3.cjs   (dev server on :5178)

const fs = require('node:fs')
const path = require('node:path')
const { globSync } = require('node:fs')

let chromium
try {
  chromium = require('playwright').chromium
} catch {
  chromium = require('playwright-core').chromium
}

const ROOT = '/Users/baihaibin/Documents/WorkSpares/BaiZe'
const OUT = path.join(ROOT, 'demo/rig-art/qa')
const URL = 'http://localhost:5178/'

const launch = async () => {
  try {
    return await chromium.launch()
  } catch (e) {
    const shells = globSync(
      `${process.env.HOME}/Library/Caches/ms-playwright/chromium*-*/chrome-*/chrome-headless-shell`,
    ).concat(
      globSync(
        `${process.env.HOME}/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/Google Chrome for Testing`,
      ),
    )
    if (!shells.length) throw e
    return chromium.launch({ executablePath: shells.sort().pop() })
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await launch()
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(URL)
  await page.waitForFunction(() => document.querySelectorAll('#panel button').length > 10, null, {
    timeout: 15000,
  })
  await page.waitForTimeout(800)

  // enlarge the canvas for head close-ups
  await page.addStyleTag({ content: '#pet { width: 900px !important; height: 900px !important; }' })

  const clickAction = async (label) => {
    const ok = await page.evaluate((name) => {
      const panel = document.getElementById('panel')
      let cur = null
      for (const node of panel.children) {
        if (node.tagName === 'H2') cur = node.textContent
        else if (cur && /动作/.test(cur)) {
          const b = [...node.querySelectorAll('button')].find((x) => x.textContent === name)
          if (b) {
            b.click()
            return true
          }
        }
      }
      return false
    }, label)
    if (!ok) throw new Error(`action button missing: ${label}`)
  }

  const snap = async (name) => {
    const buf = await page.locator('#pet').screenshot()
    fs.writeFileSync(path.join(OUT, name), buf)
    console.log('saved', name)
  }

  // --- third-eye actions: sample several frames, keep the open-eye ones ----
  await clickAction('third-eye')
  for (const t of [500, 900, 1300, 1700, 2100]) {
    await page.waitForTimeout(t === 500 ? 500 : 400)
    await snap(`round3-thirdeye-${t}.png`)
  }

  await clickAction('think')
  await page.waitForTimeout(900)
  await snap('round3-think.png')

  // --- motion actions for seam check ---------------------------------------
  for (const action of ['look-around', 'nod', 'sleep', 'happy']) {
    await clickAction(action)
    const dur = action === 'sleep' ? 4600 : action === 'look-around' ? 2600 : 1200
    const steps = 5
    for (let i = 1; i <= steps; i++) {
      await page.waitForTimeout(dur / steps)
      await snap(`round3-${action}-${Math.round((dur / steps) * i)}.png`)
    }
  }

  // --- black background full body ------------------------------------------
  await page.evaluate(() => {
    for (const [, b] of Object.entries(document.querySelectorAll('#panel button'))) {
      if (b.textContent === '黑底') b.click()
    }
  })
  await page.waitForTimeout(300)
  await snap('round3-black-fullbody.png')

  await ctx.close()
  await browser.close()
  console.log('errors:', errors.length ? errors.slice(0, 5).join(' | ') : 'none')
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
