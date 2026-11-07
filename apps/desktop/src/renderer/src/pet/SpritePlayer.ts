// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sprite atlas playback for rig packs (task book C): horizontal-strip
 * sheets on the 256 grid (ground 246) shared with the rig anchor, so rig
 * frames and sprite frames swap without a size jump.
 */

export interface SpriteStateMeta {
  frames: number
  durations: number[]
  loop: boolean
}

export interface SpriteMeta {
  cell: number
  ground: number
  states: Record<string, SpriteStateMeta>
}

export class SpritePlayer {
  private readonly image: HTMLImageElement
  private readonly meta: SpriteMeta
  private state: SpriteStateMeta | null = null
  private stateName = ''
  private startMs = 0
  /** Scratch snapshot of the previous pose for the 150 ms crossfade. */
  private fadeCanvas: HTMLCanvasElement | null = null
  private fadeUntil = 0

  constructor(image: HTMLImageElement, meta: SpriteMeta) {
    this.image = image
    this.meta = meta
  }

  /** Switch to a sheet state; returns false when the state does not exist. */
  play(name: string, nowMs: number): boolean {
    const s = this.meta.states[name]
    if (!s) return false
    if (this.stateName !== name && this.state) {
      this.beginCrossfade(nowMs)
    }
    this.stateName = name
    this.state = s
    this.startMs = nowMs
    return true
  }

  get currentState(): string {
    return this.stateName
  }
  get durationMs(): number {
    const s = this.state
    if (!s) return 0
    return s.durations.reduce((a, b) => a + b, 0)
  }

  private beginCrossfade(nowMs: number): void {
    const w = this.meta.cell
    const c = document.createElement('canvas')
    c.width = w
    c.height = w
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.drawImage(this.image, 0, 0, w, w, 0, 0, w, w)
      this.fadeCanvas = c
      this.fadeUntil = nowMs + 150
    }
  }

  /**
   * Draw the current frame into a 256x256 logical space. The caller scales
   * to the window and paints the canvas onto the display.
   */
  draw(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const s = this.state
    if (!s) return
    const total = this.durationMs
    let t = total > 0 ? (nowMs - this.startMs) % total : 0
    let index = 0
    for (let i = 0; i < s.durations.length; i++) {
      const d = s.durations[i] ?? 0
      if (t < d) {
        index = i
        break
      }
      t -= d
      index = Math.min(i + 1, s.frames - 1)
    }
    ctx.clearRect(0, 0, this.meta.cell, this.meta.cell)
    const x = index * this.meta.cell
    ctx.drawImage(
      this.image,
      x,
      0,
      this.meta.cell,
      this.meta.cell,
      0,
      0,
      this.meta.cell,
      this.meta.cell,
    )
    if (this.fadeCanvas && nowMs < this.fadeUntil) {
      // Old pose on top, fading out over 150 ms (reveals the new frame).
      const alpha = (this.fadeUntil - nowMs) / 150
      ctx.globalAlpha = alpha
      ctx.drawImage(this.fadeCanvas, 0, 0)
      ctx.globalAlpha = 1
    }
  }
}
