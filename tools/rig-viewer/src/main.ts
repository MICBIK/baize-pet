// SPDX-License-Identifier: AGPL-3.0-only

/**
 * rig-viewer debug page (task book 十一). Loads the generated pack from the
 * Vite dev server root, renders through the shared packages/rig renderer
 * (same drawRigFrame the desktop RigPlayer uses) and exposes: parameter
 * sliders, expression/action/base-idle buttons, backgrounds, an FPS meter,
 * the joint stress sweep, mouse-follow toggle and the pivot/skeleton overlay.
 */

import {
  clampParams,
  drawRigFrame,
  loadRigPack,
  mixLayers,
  PARAM_DEFS,
  ProceduralEngine,
  type RigPackResources,
  type RigParams,
  RigStateMachine,
  type SolvedPart,
  Spring,
  solve,
} from '@baize/rig'
import './style.css'

// --- helpers ---------------------------------------------------------------

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image load failed: ${url}`))
    img.src = url
  })
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  if (text !== undefined) node.textContent = text
  return node
}

/** Joint-ish numeric params the stress sweep drives through their full range. */
const STRESS_RE = /(\.rot$|\.lift$|head\.tilt$|body\.lean$|body\.x$|body\.y$)/

// --- viewer state ----------------------------------------------------------

const canvas = document.getElementById('pet') as HTMLCanvasElement
const stage = document.getElementById('stage') as HTMLElement
const hud = document.getElementById('hud') as HTMLElement
const eventsBox = document.getElementById('events') as HTMLElement
const panel = document.getElementById('panel') as HTMLElement

const ctxOrNull = canvas.getContext('2d')
if (!ctxOrNull) throw new Error('canvas 2d unavailable')
const ctx: CanvasRenderingContext2D = ctxOrNull

let res: RigPackResources | null = null
let state: RigStateMachine | null = null
const engine = new ProceduralEngine()
const springs = {
  earL: new Spring('ear'),
  earR: new Spring('ear'),
  tail: new Spring('tail'),
  stringL: new Spring('string'),
  stringR: new Spring('string'),
}

const overrides: RigParams = {}
let stress = false
let follow = true
let showPivots = false
let mouse: { x: number; y: number } | null = null
/** Active sprite sheet when a sprite state is selected (null = rig mode). */
let spriteSheet: string | null = null
const spritePlayers = new Map<string, SpritePlayerLite>()
/** Minimal sprite playback (256 grid strip) mirroring the app's SpritePlayer. */
class SpritePlayerLite {
  private startMs = 0
  private stateName = ''
  constructor(
    private readonly img: HTMLImageElement,
    private readonly meta: NonNullable<RigPackResources['spriteMeta']>,
  ) {}
  play(name: string, nowMs: number): boolean {
    const s = this.meta.states[name]
    if (!s) return false
    if (this.stateName !== name) {
      this.stateName = name
      this.startMs = nowMs
    }
    return true
  }
  draw(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const s = this.meta.states[this.stateName]
    if (!s) return
    const total = s.durations.reduce((a, b) => a + b, 0)
    let t = nowMs - this.startMs
    if (s.loop) t = t % Math.max(1, total)
    else t = Math.min(t, Math.max(1, total) - 1)
    let acc = 0
    let frame = 0
    for (let i = 0; i < s.durations.length; i++) {
      const d = s.durations[i] ?? 0
      if (t < acc + d) {
        frame = i
        break
      }
      acc += d
      frame = i
    }
    const cell = this.meta.cell
    ctx.drawImage(this.img, frame * cell, 0, cell, cell, 0, 0, cell, cell)
  }
}

// --- UI --------------------------------------------------------------------

function section(title: string): HTMLElement {
  panel.append(el('h2', {}, title))
  const box = el('div', { class: 'row' })
  panel.append(box)
  return box
}

function markActive(buttons: Map<string, HTMLButtonElement>, activeKey: string | null): void {
  for (const [key, btn] of buttons) btn.classList.toggle('active', key === activeKey)
}

const idleButtons = new Map<string, HTMLButtonElement>()
const actionButtons = new Map<string, HTMLButtonElement>()
const exprButtons = new Map<string, HTMLButtonElement>()
const spriteButtons = new Map<string, HTMLButtonElement>()
const sliderOuts = new Map<string, HTMLOutputElement>()

function buildPanel(): void {
  if (!res || !state) return
  panel.innerHTML = ''
  idleButtons.clear()
  actionButtons.clear()
  exprButtons.clear()
  spriteButtons.clear()
  sliderOuts.clear()

  panel.append(el('h1', {}, 'BaiZe rig-viewer'))

  // Base idles (emotion idle switching).
  const idleBox = section('情绪待机（base 层）')
  for (const clip of res.clips.values()) {
    if (clip.layer !== 'base') continue
    const btn = el('button', {}, clip.name)
    btn.onclick = () => {
      spriteSheet = null
      state?.request(clip.name, clock)
      markActive(idleButtons, clip.name)
      markActive(spriteButtons, null)
    }
    idleButtons.set(clip.name, btn)
    idleBox.append(btn)
  }
  markActive(idleButtons, state.currentActionName)

  // One-shot actions.
  const actionBox = section('动作（action 层）')
  for (const clip of res.clips.values()) {
    if (clip.layer === 'base') continue
    const btn = el('button', {}, clip.name)
    btn.onclick = () => {
      spriteSheet = null
      state?.request(clip.name, clock)
      markActive(spriteButtons, null)
    }
    actionButtons.set(clip.name, btn)
    actionBox.append(btn)
  }

  // Sprite sheet states (rig ↔ sprite crossfade QA).
  if (res.spriteMeta) {
    const spriteBox = section('序列帧（sprite 层）')
    for (const name of Object.keys(res.spriteMeta.states)) {
      const btn = el('button', {}, name)
      btn.onclick = () => {
        spriteSheet = name
        markActive(spriteButtons, name)
        markActive(idleButtons, null)
      }
      spriteButtons.set(name, btn)
      spriteBox.append(btn)
    }
  }

  // Expression presets.
  const exprBox = section('表情（120ms 过渡）')
  const off = el('button', {}, '关闭')
  off.onclick = () => {
    state?.setExpression(null, clock)
    markActive(exprButtons, null)
  }
  exprButtons.set('__off', off)
  exprBox.append(off)
  for (const name of res.expressions.keys()) {
    const btn = el('button', {}, name)
    btn.onclick = () => {
      state?.setExpression({ name, params: res?.expressions.get(name) ?? {} }, clock)
      markActive(exprButtons, name)
    }
    exprButtons.set(name, btn)
    exprBox.append(btn)
  }

  // Say line.
  panel.append(el('h2', {}, '口型（onSay）'))
  const sayBox = el('div', { id: 'say' })
  const input = el('input', { type: 'text', placeholder: '输入台词回车试口型' })
  const sayBtn = el('button', {}, '说话')
  const speak = (): void => {
    if (input.value.trim()) state?.say(input.value, clock)
  }
  sayBtn.onclick = speak
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') speak()
  })
  sayBox.append(input, sayBtn)
  panel.append(sayBox)

  // Parameter sliders (all PARAM_DEFS).
  panel.append(el('h2', {}, '参数（覆盖层，替换语义）'))
  for (const def of PARAM_DEFS) {
    const row = el('div', { class: 'ctl' })
    const label = el('label', { for: `ctl-${def.key}`, title: def.key }, def.key)
    row.append(label)
    if (def.kind === 'number') {
      const slider = el('input', {
        type: 'range',
        id: `ctl-${def.key}`,
        min: String(def.min),
        max: String(def.max),
        step: String((def.max - def.min) / 100),
        value: String(def.def),
      })
      const out = el('output')
      out.textContent = String(def.def)
      slider.oninput = () => {
        const v = Number(slider.value)
        overrides[def.key] = v
        out.textContent = slider.value
      }
      sliderOuts.set(def.key, out)
      row.append(slider, out)
    } else {
      const select = el('select', { id: `ctl-${def.key}` })
      for (const v of def.values) select.append(el('option', { value: v }, v))
      select.value = def.def
      select.onchange = () => {
        overrides[def.key] = select.value
      }
      const spacer = el('span')
      row.append(select, spacer)
    }
    panel.append(row)
  }
  const resetBtn = el('button', {}, '重置全部参数')
  resetBtn.onclick = () => {
    for (const [key, out] of sliderOuts) {
      const def = PARAM_DEFS.find((d) => d.key === key)
      if (def && def.kind === 'number') {
        const slider = document.getElementById(`ctl-${key}`) as HTMLInputElement | null
        if (slider) slider.value = String(def.def)
        out.textContent = String(def.def)
      }
    }
    for (const def of PARAM_DEFS) {
      const select = document.getElementById(`ctl-${def.key}`) as HTMLSelectElement | null
      if (select && def.kind === 'enum') select.value = def.def
    }
    for (const k of Object.keys(overrides)) delete overrides[k]
  }
  panel.append(resetBtn)

  // Toggles & backgrounds.
  panel.append(el('h2', {}, '调试'))
  const toggles = el('div', { class: 'toggles' })
  const stressBtn = el('button', {}, '关节压力测试')
  stressBtn.onclick = () => {
    stress = !stress
    stressBtn.classList.toggle('active', stress)
  }
  const followBtn = el('button', { class: 'active' }, '鼠标跟随')
  followBtn.onclick = () => {
    follow = !follow
    followBtn.classList.toggle('active', follow)
    if (!follow) mouse = null
  }
  const pivotBtn = el('button', {}, '轴心/骨架')
  pivotBtn.onclick = () => {
    showPivots = !showPivots
    pivotBtn.classList.toggle('active', showPivots)
  }
  toggles.append(stressBtn, followBtn, pivotBtn)
  panel.append(toggles)

  const bgs = el('div', { class: 'toggles' })
  const bgButtons: Array<[string, string, HTMLButtonElement]> = []
  for (const [cls, label] of [
    ['bg-white', '白底'],
    ['bg-black', '黑底'],
    ['bg-wallpaper', '花哨壁纸'],
  ] as Array<[string, string]>) {
    const btn = el('button', {}, label)
    bgButtons.push([cls, label, btn])
    btn.onclick = () => {
      stage.className = cls
      for (const [, , b] of bgButtons) b.classList.toggle('active', b === btn)
    }
    bgs.append(btn)
  }
  bgButtons[0]?.[2].classList.add('active')
  panel.append(bgs)
}

// --- frame loop ------------------------------------------------------------

let clock = 0
let lastFrame = performance.now()
let emaDt = 16.7

function stressParams(tMs: number): RigParams {
  const p: RigParams = {}
  let i = 0
  for (const def of PARAM_DEFS) {
    if (def.kind !== 'number' || !STRESS_RE.test(def.key)) continue
    const mid = (def.min + def.max) / 2
    const amp = (def.max - def.min) / 2
    p[def.key] = mid + amp * Math.sin((tMs / 1400) * Math.PI * 2 + i * 0.13)
    i++
  }
  return p
}

function drawSpriteFrame(sheet: string, dpr: number, size: number): void {
  const meta = res?.spriteMeta
  const img = res?.spriteImages.get(sheet)
  if (!meta || !img) return
  let sp = spritePlayers.get(sheet)
  if (!sp) {
    sp = new SpritePlayerLite(img, meta)
    spritePlayers.set(sheet, sp)
  }
  sp.play(sheet, clock)
  ctx.setTransform(dpr * (size / 256), 0, 0, dpr * (size / 256), 0, 0)
  sp.draw(ctx, clock)
}

function frame(now: number): void {
  requestAnimationFrame(frame)
  if (!res || !state) return
  const dt = Math.min(100, now - lastFrame)
  lastFrame = now
  if (dt <= 0) return
  clock += dt
  emaDt += (dt - emaDt) * 0.05

  const dpr = window.devicePixelRatio || 1
  const size = canvas.clientWidth
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
  }

  const look =
    follow && mouse
      ? {
          x: Math.min(1, Math.max(-1, (mouse.x - size / 2) / 160)),
          y: Math.min(1, Math.max(-1, (mouse.y - size * 0.45) / 160)),
        }
      : undefined
  const proc = engine.tick({ tMs: clock, dtMs: dt, look })
  if (proc.earImpulse) {
    ;(proc.earImpulse.side === 'L' ? springs.earL : springs.earR).kick(proc.earImpulse.velocity)
  }
  const physics: RigParams = {
    'ear.L.rot': springs.earL.step(dt),
    'ear.R.rot': springs.earR.step(dt),
    'tail.rot': springs.tail.step(dt),
    'string.L.rot': springs.stringL.step(dt),
    'string.R.rot': springs.stringR.step(dt),
  }

  const out = state.update(clock, dt, res.expressions)
  const mixed = mixLayers({ base: out.params, procedural: proc.params, physics })
  // Debug overrides (sliders + stress sweep) replace, then clamp once.
  const params = clampParams({ ...mixed, ...overrides, ...(stress ? stressParams(clock) : {}) })
  const parts: SolvedPart[] = solve(res.manifest, params)

  if (spriteSheet) drawSpriteFrame(spriteSheet, dpr, size)
  else drawRigFrame(ctx, res.manifest, res.images, parts, dpr, size, { showPivots })

  hud.textContent = `${(1000 / emaDt).toFixed(1)} fps · ${emaDt.toFixed(1)} ms`
  if (out.events.length > 0) eventsBox.textContent = `events: ${out.events.join(', ')}`
}

// --- boot ------------------------------------------------------------------

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect()
  mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top }
})
canvas.addEventListener('pointerleave', () => {
  mouse = null
})

loadRigPack('/', {})
  .then(async (loaded) => {
    res = loaded
    // The viewer can play any sheet, not just manifest-referenced ones.
    if (res.spriteMeta) {
      await Promise.all(
        Object.keys(res.spriteMeta.states).map(async (sheet) => {
          if (res && !res.spriteImages.has(sheet)) {
            try {
              res.spriteImages.set(sheet, await loadImage(`sprites/${sheet}.png`))
            } catch {
              /* sheet file missing: button will fall back to rig */
            }
          }
        }),
      )
    }
    state = new RigStateMachine([...loaded.clips.values()], {
      baseIdle: 'idle',
      emotionIdle: {},
    })
    buildPanel()
    requestAnimationFrame(frame)
  })
  .catch((e) => {
    panel.append(el('p', { style: 'color:#f88' }, `pack load failed: ${String(e)}`))
  })
