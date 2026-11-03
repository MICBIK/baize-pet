// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rig renderer (task book C): Canvas2D at devicePixelRatio, driven by
 * requestAnimationFrame. Loads the pack through the shared loadRigPack
 * (baize-character:// protocol), runs the state machine + procedural life +
 * springs, and draws through the shared drawRigFrame — the same code the
 * tools/rig-viewer debug page uses.
 */

import {
  drawRigFrame,
  loadRigPack,
  mixLayers,
  ProceduralEngine,
  type RigPackResources,
  type RigParams,
  RigStateMachine,
  Spring,
  solve,
} from '@baize/rig'
import type { CharacterInfo } from '@baize/shared'
import { useEffect, useRef } from 'react'
import { SpritePlayer } from './SpritePlayer'
import { packUrl } from './VideoPlayer'

export interface RigPlayerProps {
  info: CharacterInfo
  /** Current requested action (PetLayer state). */
  action: string
  /** Say line + sequence counter; a new counter restarts lip sync. */
  say: { line: string; seq: number } | null
  /** Cursor position in window coords (from onCursor), or null. */
  cursor: { x: number; y: number } | null
  onLoaded?: () => void
}

export function RigPlayer(props: RigPlayerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const resourcesRef = useRef<RigPackResources | null>(null)
  const stateRef = useRef<RigStateMachine | null>(null)
  const actionRef = useRef(props.action)
  const sayRef = useRef(props.say)
  const cursorRef = useRef(props.cursor)
  actionRef.current = props.action
  sayRef.current = props.say
  cursorRef.current = props.cursor

  useEffect(() => {
    let cancelled = false
    loadRigPack(packUrl(props.info, ''), {
      rigPath: props.info.rig ?? 'rig/rig.json',
      animations: props.info.animations,
    })
      .then((res) => {
        if (cancelled) return
        resourcesRef.current = res
        stateRef.current = new RigStateMachine([...res.clips.values()], {
          baseIdle: 'idle',
          emotionIdle: {},
        })
        props.onLoaded?.()
      })
      .catch((error: unknown) => console.error('rig load failed:', error))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.info.id, props.info, props.onLoaded])

  // The frame loop intentionally runs once: action/say/cursor arrive via
  // refs and the animation clock must not reset on re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: single rAF loop reading props through refs
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const engine = new ProceduralEngine()
    const springs = {
      earL: new Spring('ear'),
      earR: new Spring('ear'),
      tail: new Spring('tail'),
      stringL: new Spring('string'),
      stringR: new Spring('string'),
    }
    let clock = 0
    let lastFrame = performance.now()
    let raf = 0
    let lastSeq = -1
    let requestedAction = props.action
    let spriteMode = false
    let activeSheet: string | null = null
    let spriteStartMs = 0
    let fadeSnap: HTMLCanvasElement | null = null
    let fadeUntil = 0
    const spritePlayers = new Map<string, SpritePlayer>()

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const res = resourcesRef.current
      if (!res) return
      const dt = Math.min(100, now - lastFrame)
      lastFrame = now
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (document.hidden || dt <= 0) return // freeze instead of animating hidden

      clock += dt
      const dpr = window.devicePixelRatio || 1
      const size = canvas.width / Math.max(1, dpr)
      if (canvas.width !== Math.round(canvas.clientWidth * dpr)) {
        canvas.width = Math.round(canvas.clientWidth * dpr)
        canvas.height = Math.round(canvas.clientHeight * dpr)
      }

      // --- request pending action / say -------------------------------------
      const state = stateRef.current
      if (!state) return
      if (sayRef.current && sayRef.current.seq !== lastSeq) {
        state.say(sayRef.current.line, clock)
        lastSeq = sayRef.current.seq
      }
      if (actionRef.current !== requestedAction) {
        state.request(actionRef.current, clock)
        requestedAction = actionRef.current
      }

      // --- state machine + procedural + springs ------------------------------
      const cursor = cursorRef.current
      const look = cursor
        ? {
            x: clampLook((cursor.x - size / 2) / 160),
            y: clampLook((cursor.y - size * 0.45) / 160),
          }
        : undefined
      const proc = engine.tick({ tMs: clock, dtMs: dt, look: reduceMotion ? undefined : look })
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

      // --- render: sprite sheet or rig parts ---------------------------------
      const animFile = props.info.animations[actionRef.current] ?? ''
      let sheetName =
        animFile.startsWith('sprite:') && res.spriteMeta && res.spriteImages.has(animFile.slice(7))
          ? animFile.slice(7)
          : null
      // One-shot sprite states chain into their follow-up (sit -> sit-idle).
      if (
        sheetName &&
        res.spriteMeta &&
        clock - spriteStartMs > spriteTotalMs(res.spriteMeta, sheetName) &&
        !res.spriteMeta.states[sheetName]?.loop
      ) {
        const follow = SPRITE_FOLLOW[actionRef.current]
        if (follow && res.spriteMeta.states[follow]) {
          sheetName = follow
        }
      }
      const useSprite = sheetName !== null
      if (useSprite !== spriteMode || (sheetName && sheetName !== activeSheet)) {
        // Mode or sheet switch: snapshot the canvas for the 150 ms crossfade.
        const snap = document.createElement('canvas')
        snap.width = canvas.width
        snap.height = canvas.height
        snap.getContext('2d')?.drawImage(canvas, 0, 0)
        fadeSnap = snap
        fadeUntil = clock + 150
        spriteMode = useSprite
        activeSheet = sheetName
        spriteStartMs = clock
      }

      if (useSprite && sheetName && res.spriteMeta) {
        const img = res.spriteImages.get(sheetName)
        if (img) {
          let sp = spritePlayers.get(sheetName)
          if (!sp) {
            sp = new SpritePlayer(img, res.spriteMeta)
            spritePlayers.set(sheetName, sp)
          }
          sp.play(sheetName, clock)
          ctx.setTransform(dpr * (size / 256), 0, 0, dpr * (size / 256), 0, 0)
          sp.draw(ctx, clock)
        }
      } else {
        // The state machine already mixed base/action/expression; stack the
        // procedural life and spring physics on top.
        const params = mixLayers({ base: out.params, procedural: proc.params, physics })
        const parts = solve(res.manifest, params)
        drawRigFrame(ctx, res.manifest, res.images, parts, dpr, size)
      }

      // Crossfade overlay: previous pose fades out on top.
      if (fadeSnap && clock < fadeUntil) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalAlpha = Math.min(1, (fadeUntil - clock) / 150)
        ctx.drawImage(fadeSnap, 0, 0)
        ctx.globalAlpha = 1
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}

function clampLook(v: number): number {
  return Math.min(1, Math.max(-1, v))
}

/** Sprite states that follow a finished one-shot (task book D: sit chain). */
const SPRITE_FOLLOW: Record<string, string> = { sit: 'sit-idle' }

function spriteTotalMs(
  meta: { states: Record<string, { durations: number[]; loop: boolean }> },
  name: string,
): number {
  const st = meta.states[name]
  return st ? st.durations.reduce((a, b) => a + b, 0) : Number.POSITIVE_INFINITY
}
