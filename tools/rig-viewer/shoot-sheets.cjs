// SPDX-License-Identifier: AGPL-3.0-only
// rig-viewer contact sheets (task book 十一): drives the debug page, captures
// 25 frames at 100 ms intervals per action, composites one sheet per action
// into demo/rig-handoff/out/, and measures the ground line / hood width from
// canvas pixels for the rig-vs-sprite alignment gate.
//
// Usage: node tools/rig-viewer/shoot-sheets.cjs [--videos] [--group <substr>]
// Requires the dev server: pnpm --filter rig-viewer dev

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
const OUT = path.join(ROOT, 'demo/rig-handoff/out')
const URL = 'http://localhost:5178/'
const FRAMES = 25
const FRAME_MS = 100

const argv = process.argv.slice(2)
const wantVideos = argv.includes('--videos')
const groupIdx = argv.indexOf('--group')
const groupFilter = groupIdx >= 0 ? argv[groupIdx + 1] : null

const launch = async () => {
  try {
    return await chromium.launch()
  } catch (e) {
    const shells = globSync(
      process.env.HOME + '/Library/Caches/ms-playwright/chromium*-*/chrome-*/chrome-headless-shell',
    ).concat(
      globSync(
        process.env.HOME +
          '/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/Google Chrome for Testing',
      ),
    )
    if (!shells.length) throw e
    return chromium.launch({ executablePath: shells.sort().pop() })
  }
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'videos'), { recursive: true })
  const browser = await launch()
  const report = []
  const errors = []

  // ---- pass A: contact sheets + pixel metrics -----------------------------
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(URL)
  await page.waitForFunction(() => document.querySelectorAll('#panel button').length > 10, null, {
    timeout: 10000,
  })
  await page.waitForTimeout(800)

  // Grouped button labels (section h2 -> labels until the next h2).
  const groups = await page.evaluate(() => {
    const out = {}
    let cur = null
    for (const node of document.getElementById('panel').children) {
      if (node.tagName === 'H2') cur = node.textContent
      else if (cur && node.querySelectorAll('button').length) {
        out[cur] ||= []
        for (const b of node.querySelectorAll('button')) out[cur].push(b.textContent)
      }
    }
    return out
  })
  const targets = []
  for (const [g, labels] of Object.entries(groups)) {
    // Default sweep only animates; --group may target any section (expressions…).
    if (!groupFilter && !/待机|动作|序列帧/.test(g)) continue
    if (groupFilter && !g.includes(groupFilter)) continue
    for (const label of labels) targets.push({ group: g, label })
  }
  console.log(`actions: ${targets.length}`)

  for (const { group, label } of targets) {
    const safe = label.replace(/[^a-z0-9-]/gi, '_')
    // Section-scoped click: expression buttons share labels with some actions.
    const clicked = await page.evaluate(
      ([g, name]) => {
        const panel = document.getElementById('panel')
        let cur = null
        for (const node of panel.children) {
          if (node.tagName === 'H2') cur = node.textContent
          else if (cur === g) {
            const b = [...node.querySelectorAll('button')].find((x) => x.textContent === name)
            if (b) {
              b.click()
              return true
            }
          }
        }
        return false
      },
      [group, label],
    )
    if (!clicked) {
      report.push(`${label}\tBTN-MISSING`)
      continue
    }
    await page.waitForTimeout(FRAME_MS)

    // Grab the pet canvas snapshot each frame; composite in-page later.
    const frames = []
    const canvas = page.locator('#pet')
    for (let i = 0; i < FRAMES; i++) {
      frames.push(await canvas.screenshot())
      await page.waitForTimeout(FRAME_MS)
    }

    // Pixel metrics per frame from the live canvas.
    const metrics = await page.evaluate(() => {
      const c = document.getElementById('pet')
      const g = c.getContext('2d')
      const { width: w, height: h } = c
      const data = g.getImageData(0, 0, w, h).data
      let maxY = -1
      let hoodW = 0
      const topLimit = Math.floor(h * 0.45)
      for (let y = 0; y < h; y++) {
        let x0 = -1
        let x1 = -1
        let count = 0
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 24) {
            if (x0 < 0) x0 = x
            x1 = x
            count++
          }
        }
        if (count > 0) {
          maxY = y
          if (y < topLimit) hoodW = Math.max(hoodW, x1 - x0 + 1)
        }
      }
      const size = w // css size == width/dpr; dpr==1 in headless
      return {
        feet246: maxY >= 0 ? +((maxY * 256) / size).toFixed(1) : -1, // 246 == on-ground contract
        hoodPx: hoodW,
        hoodNorm: +(hoodW / ((92 / 256) * size)).toFixed(3), // 1.0 == contract
      }
    })
    report.push(`${label}\tfeet246=${metrics.feet246}\thood=${metrics.hoodNorm}`)

    // Composite the sheet in-page: 5 columns of 360px cells.
    const dataUrls = await Promise.all(frames.map((b) => b.toString('base64')))
    const sheetData = await page.evaluate(async (imgs) => {
      const cell = 176
      const cols = 5
      const rows = Math.ceil(imgs.length / cols)
      const sheet = document.createElement('canvas')
      sheet.width = cols * cell
      sheet.height = rows * cell
      const g = sheet.getContext('2d')
      g.fillStyle = '#e8e8e8'
      g.fillRect(0, 0, sheet.width, sheet.height)
      for (let i = 0; i < imgs.length; i++) {
        const img = new Image()
        img.src = 'data:image/png;base64,' + imgs[i]
        await img.decode()
        const s = Math.min(cell / img.width, cell / img.height)
        g.drawImage(
          img,
          (i % cols) * cell + (cell - img.width * s) / 2,
          Math.floor(i / cols) * cell,
          img.width * s,
          img.height * s,
        )
      }
      return sheet.toDataURL('image/png')
    }, dataUrls)
    fs.writeFileSync(
      path.join(OUT, `${safe}-sheet.png`),
      Buffer.from(sheetData.split(',')[1], 'base64'),
    )
    console.log(`sheet ${safe} done`)
  }
  await ctx.close()

  // ---- pass B: per-action videos ------------------------------------------
  if (wantVideos) {
    for (const { label } of targets) {
      const safe = label.replace(/[^a-z0-9-]/gi, '_')
      const vctx = await browser.newContext({
        viewport: { width: 800, height: 640 },
        recordVideo: { dir: path.join(OUT, 'videos'), size: { width: 800, height: 640 } },
      })
      const vpage = await vctx.newPage()
      vpage.on('pageerror', (e) => errors.push(e.message))
      await vpage.goto(URL)
      await vpage.waitForFunction(
        () => document.querySelectorAll('#panel button').length > 10,
        null,
        { timeout: 10000 },
      )
      await vpage.waitForTimeout(600)
      const btn = vpage.getByRole('button', { name: label, exact: true })
      if ((await btn.count()) === 1) {
        await btn.click()
        await vpage.waitForTimeout(2600)
      }
      await vctx.close()
      // recordVideo names files randomly; rename the newest webm.
      const vids = fs
        .readdirSync(path.join(OUT, 'videos'))
        .filter((f) => f.endsWith('.webm') && !f.startsWith(safe))
      const newest = vids
        .map((f) => ({ f, m: fs.statSync(path.join(OUT, 'videos', f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0]
      if (newest)
        fs.renameSync(path.join(OUT, 'videos', newest.f), path.join(OUT, 'videos', `${safe}.webm`))
      console.log(`video ${safe} done`)
    }
  }

  await browser.close()
  fs.writeFileSync(
    path.join(OUT, 'ground-report.txt'),
    `action\tfeet(246=on-ground)\thood(1.0=contract)\n` + report.join('\n') + '\n',
  )
  console.log('errors:', errors.length ? errors.slice(0, 5).join(' | ') : 'none')
  console.log('report ->', path.join(OUT, 'ground-report.txt'))
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
