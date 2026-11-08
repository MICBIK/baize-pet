// SPDX-License-Identifier: AGPL-3.0-only

/**
 * p2l renderer (ADR 0008): plays a PSD2Live `.p2lrt` mesh model with the
 * vendored MIT web player (WebGL + WebAssembly runtime). The runtime itself
 * blinks, breathes and follows the gaze; this component maps pet actions to
 * the model's clips/expressions, drives lip sync from say lines, and answers
 * the pet layer's per-pixel hit test.
 */

import type { CharacterInfo } from '@baize/shared'
import { type MutableRefObject, useEffect, useRef } from 'react'
import { gazeFromCursor, lipSyncDurationMs, lipSyncLevel, resolveCue } from './p2lAnimation'
import { packUrl } from './VideoPlayer'
import { P2LPlayer } from './vendor/p2l/p2l.js'
import wasmDataUrl from './vendor/p2l/p2l_runtime.wasm?url&inline'

/** Behavior flags of the runtime (p2l.js): 1 blink, 2 breathing, 4 gaze. */
const BASE_BEHAVIORS = 1 | 2 | 4
const HIT_ALPHA = 24

/** Returns whether the pet is opaque under a window point (CSS px). */
export type P2lHitTester = (clientX: number, clientY: number) => boolean

export interface P2lPlayerProps {
  info: CharacterInfo
  action: string
  say: { line: string; seq: number } | null
  cursor: { x: number; y: number } | null
  /** A one-shot clip finished (looping clips never end). */
  onEnded: () => void
  /** Filled with the hit tester once the model is ready, cleared on unmount. */
  hitTesterRef: MutableRefObject<P2lHitTester | null>
}

let runtimeModule: Promise<WebAssembly.Module> | null = null

/** Compiles the inlined runtime once per page; instances stay per player. */
function compileRuntime(): Promise<WebAssembly.Module> {
  if (!runtimeModule) {
    const base64 = wasmDataUrl.slice(wasmDataUrl.indexOf(',') + 1)
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    runtimeModule = WebAssembly.compile(bytes)
  }
  return runtimeModule
}

export function P2lPlayer(props: P2lPlayerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const latest = useRef(props)
  latest.current = props

  // biome-ignore lint/correctness/useExhaustiveDependencies: one player per pack; live props flow through `latest`
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let player: P2LPlayer | null = null
    let raf = 0

    const start = async (): Promise<void> => {
      const { info } = latest.current
      if (!info.model) throw new Error('p2l pack has no model')
      const [module, bytes] = await Promise.all([
        compileRuntime(),
        fetch(packUrl(info, info.model)).then(async (r) => {
          if (!r.ok) throw new Error(`model fetch failed: ${r.status}`)
          return new Uint8Array(await r.arrayBuffer())
        }),
      ])
      const instance = await WebAssembly.instantiate(module, {})
      if (disposed) return
      player = await P2LPlayer.fromBytes(canvas, instance.exports, bytes)
      if (disposed) {
        player.dispose()
        return
      }
      run(player)
    }

    const run = (p: P2LPlayer): void => {
      const gl = p.gl
      const pixel = new Uint8Array(4)
      latest.current.hitTesterRef.current = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect()
        if (
          clientX < rect.left ||
          clientY < rect.top ||
          clientX >= rect.right ||
          clientY >= rect.bottom
        ) {
          return false
        }
        // The default framebuffer is only readable within the task that drew
        // it, so redraw the current pose and read the pixel right away.
        p.draw()
        const dpr = window.devicePixelRatio || 1
        const x = Math.floor((clientX - rect.left) * dpr)
        const y = canvas.height - 1 - Math.floor((clientY - rect.top) * dpr)
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        return (pixel[3] ?? 0) > HIT_ALPHA
      }

      let last = performance.now()
      let requested: string | null = null
      let oneShot = false
      let lastSeq = -1
      let sayStart = 0
      let sayDuration = 0
      let lipOn = false

      const frame = (now: number): void => {
        raf = requestAnimationFrame(frame)
        const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
        last = now
        if (document.hidden) return
        const props = latest.current

        // Action -> clip/expression (re-resolved on every change).
        if (props.action !== requested) {
          requested = props.action
          const cue = resolveCue(props.info.animations, props.action, {
            clips: p.clips,
            expressions: p.expressions,
          })
          if (cue.clip) p.play(cue.clip)
          p.expression(cue.expression)
          oneShot = cue.clip !== null && !isLooping(p, cue.clip)
        }

        // Gaze: reduced motion keeps the head still.
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (props.cursor && !reduce) {
          const g = gazeFromCursor(props.cursor, {
            width: canvas.clientWidth,
            height: canvas.clientHeight,
          })
          p.lookAt(g.x, g.y)
        } else {
          p.lookAt(0, 0)
        }

        // Lip sync for the current say line.
        if (props.say && props.say.seq !== lastSeq) {
          lastSeq = props.say.seq
          sayStart = now
          sayDuration = lipSyncDurationMs(props.say.line)
        }
        const level = lipSyncLevel(now - sayStart, sayDuration)
        if (level > 0) {
          p.lipSync(level)
          lipOn = true
        } else if (lipOn) {
          p.lipSync(0)
          p.behaviors(BASE_BEHAVIORS)
          lipOn = false
        }

        p.update(dt)
        p.draw()

        if (oneShot && p.rt.p2l_clip_finished(p.rig)) {
          oneShot = false
          props.onEnded()
        }
      }
      raf = requestAnimationFrame(frame)
    }

    start().catch((error: unknown) => console.error('p2l load failed:', error))
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      latest.current.hitTesterRef.current = null
      player?.dispose()
    }
  }, [props.info.id, props.info.model])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}

/** Whether a clip loops, from the runtime's clip info (false if unknown). */
function isLooping(p: P2LPlayer, clip: string): boolean {
  const index = p.clips.indexOf(clip)
  if (index < 0) return false
  const rt = p.rt as unknown as {
    memory: WebAssembly.Memory
    p2l_alloc(n: number): number
    p2l_dealloc(ptr: number, n: number): void
    p2l_clip_info(
      rig: number,
      index: number,
      duration: number,
      fps: number,
      looping: number,
      fadeIn: number,
      fadeOut: number,
    ): number
  }
  const out = rt.p2l_alloc(20)
  try {
    if (!rt.p2l_clip_info(p.rig, index, out, out + 4, out + 8, out + 12, out + 16)) return false
    return new Uint8Array(rt.memory.buffer, out + 8, 1)[0] !== 0
  } finally {
    rt.p2l_dealloc(out, 20)
  }
}
