// SPDX-License-Identifier: AGPL-3.0-only

import type { CharacterInfo, PetActionName } from '@baize/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { alphaAt, HIT_ALPHA_THRESHOLD, makeScratchCanvas } from './pet/hitTest'
import { type P2lHitTester, P2lPlayer } from './pet/P2lPlayer'
import { RigPlayer } from './pet/RigPlayer'
import { containRect } from './pet/VideoPlayer'

const DRAG_THRESHOLD_PX = 5
const BUBBLE_MS = 4000

/**
 * The pet layer: picks the renderer from the pack manifest (video webm,
 * layered rig or p2l mesh model), runs the per-pixel alpha hit test that toggles window
 * click-through, and drives window dragging and the speech bubble.
 */
export function PetLayer() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const p2lHitRef = useRef<P2lHitTester | null>(null)
  const interactiveRef = useRef(false)
  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0 })
  const [character, setCharacter] = useState<CharacterInfo | null>(null)
  const [action, setAction] = useState<PetActionName>('idle')
  const [bubble, setBubble] = useState<string | null>(null)
  const [say, setSay] = useState<{ line: string; seq: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.baize
      .getCharacter()
      .then(setCharacter)
      .catch((error: unknown) => console.error('Failed to load character:', error))
    const offAction = window.baize.onPetAction((spontaneous: string) => setAction(spontaneous))
    const offSay = window.baize.onSay((line: string) => {
      setBubble(line)
      setSay((prev) => ({ line, seq: (prev?.seq ?? 0) + 1 }))
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      bubbleTimer.current = setTimeout(() => setBubble(null), BUBBLE_MS)
    })
    const offCursor = window.baize.onCursor((point: { x: number; y: number }) => setCursor(point))
    return () => {
      offAction()
      offSay()
      offCursor()
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    }
  }, [])

  const setInteractive = useCallback((value: boolean) => {
    if (interactiveRef.current !== value) {
      interactiveRef.current = value
      window.baize.setInteractive(value)
    }
  }, [])

  /**
   * Alpha hit test against the visible canvas (rig) or the current video
   * frame. If pixel readback fails (e.g. a tainted canvas), the drawn
   * bounding box is the fallback so the pet never becomes unclickable.
   */
  const hitTest = useCallback(
    (clientX: number, clientY: number) => {
      if (character?.renderer === 'p2l') {
        const tester = p2lHitRef.current
        if (!tester) return
        try {
          setInteractive(tester(clientX, clientY))
        } catch {
          setInteractive(true)
        }
        return
      }
      if (character?.renderer === 'rig') {
        const canvas = canvasRef.current
        if (!canvas || canvas.width === 0) return
        const rect = canvas.getBoundingClientRect()
        const insideBox =
          clientX >= rect.left &&
          clientX < rect.left + rect.width &&
          clientY >= rect.top &&
          clientY < rect.top + rect.height
        if (!insideBox) {
          setInteractive(false)
          return
        }
        try {
          const dpr = window.devicePixelRatio || 1
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) throw new Error('no 2d context')
          const x = Math.floor((clientX - rect.left) * dpr)
          const y = Math.floor((clientY - rect.top) * dpr)
          const d = ctx.getImageData(x, y, 1, 1).data
          setInteractive((d[3] ?? 0) > HIT_ALPHA_THRESHOLD)
        } catch {
          setInteractive(true)
        }
        return
      }
      const video = videoRef.current
      if (!video || video.readyState < 2 || video.videoWidth === 0) return
      const rect = containRect(video)
      const insideBox =
        clientX >= rect.left &&
        clientX < rect.left + rect.workW &&
        clientY >= rect.top &&
        clientY < rect.top + rect.workH
      if (!insideBox) {
        setInteractive(false)
        return
      }
      try {
        if (!canvasRef.current) canvasRef.current = makeScratchCanvas(256)
        const scratch = canvasRef.current
        if (scratch.width !== video.videoWidth) {
          scratch.width = video.videoWidth
          scratch.height = video.videoHeight
        }
        const alpha = alphaAt(
          scratch,
          (ctx) => ctx.drawImage(video, 0, 0, scratch.width, scratch.height),
          rect,
          clientX,
          clientY,
        )
        setInteractive(alpha > HIT_ALPHA_THRESHOLD)
      } catch {
        setInteractive(true)
      }
    },
    [character, setInteractive],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current
      if (drag.active) {
        const moved =
          drag.moved ||
          Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD_PX
        drag.moved = moved
        if (moved) window.baize.dragMove()
        return
      }
      hitTest(event.clientX, event.clientY)
    },
    [hitTest],
  )

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (!interactiveRef.current) return
    dragRef.current = { active: true, moved: false, startX: event.clientX, startY: event.clientY }
    window.baize.dragStart()
    setAction('drag')
  }, [])

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current
    if (!drag.active) return
    dragRef.current = { active: false, moved: false, startX: 0, startY: 0 }
    window.baize.dragEnd()
    if (!drag.moved) {
      // A click without movement plays the click animation (falls back to idle).
      setAction('click')
      window.baize.click()
    } else {
      // Dropped after a drag: play the landing squash (falls back to idle).
      setAction('land')
    }
  }, [])

  const onEnded = useCallback(() => {
    // One-shot actions return to idle, except the sleep chain: falling asleep
    // keeps sleeping (loops until the next interaction).
    setAction((prev) =>
      prev === 'fall-asleep' && character && 'sleep' in character.animations ? 'sleep' : 'idle',
    )
  }, [character])

  if (!character) {
    return null
  }

  const looping =
    action === 'idle' ||
    action === 'drag' ||
    action === 'sleep' ||
    !(action in character.animations)
  const isRig = character.renderer === 'rig'

  return (
    <div
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: 'transparent' }}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {character.renderer === 'p2l' ? (
        <P2lPlayer
          info={character}
          action={action}
          say={say}
          cursor={cursor}
          onEnded={onEnded}
          hitTesterRef={p2lHitRef}
        />
      ) : isRig ? (
        <>
          <RigPlayer info={character} action={action} say={say} cursor={cursor} />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </>
      ) : (
        <video
          ref={videoRef}
          src={(() => {
            const file = character.animations[action] ?? character.animations.idle
            return file ? `baize-character://${character.id}/${file}` : ''
          })()}
          crossOrigin="anonymous"
          autoPlay
          loop={looping}
          muted
          onEnded={onEnded}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      )}
      {bubble && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 8,
            transform: 'translateX(-50%)',
            maxWidth: 220,
            padding: '6px 10px',
            borderRadius: 10,
            background: 'rgba(255, 250, 240, 0.95)',
            border: '1px solid rgba(0,0,0,0.15)',
            fontSize: 12,
            color: '#3a3128',
            whiteSpace: 'normal',
          }}
        >
          {bubble}
        </div>
      )}
    </div>
  )
}
