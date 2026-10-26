// SPDX-License-Identifier: AGPL-3.0-only

import type { CharacterInfo, PetActionName } from '@baize/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

const HIT_ALPHA_THRESHOLD = 32
const DRAG_THRESHOLD_PX = 5

function animationUrl(info: CharacterInfo, action: PetActionName): string {
  const file = info.animations[action] ?? info.animations.idle
  if (!file) return ''
  return `baize-character://${info.id}/${file}`
}

/**
 * The pet layer: plays the current action's animation, runs the per-pixel alpha
 * hit test that toggles window click-through, and drives window dragging.
 */
export function PetLayer() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const interactiveRef = useRef(false)
  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0 })
  const [character, setCharacter] = useState<CharacterInfo | null>(null)
  const [action, setAction] = useState<PetActionName>('idle')

  useEffect(() => {
    window.baize
      .getCharacter()
      .then(setCharacter)
      .catch((error: unknown) => console.error('Failed to load character:', error))
  }, [])

  const setInteractive = useCallback((value: boolean) => {
    if (interactiveRef.current !== value) {
      interactiveRef.current = value
      window.baize.setInteractive(value)
    }
  }, [])

  /** Alpha hit test against the current video frame. */
  const hitTest = useCallback(
    (clientX: number, clientY: number) => {
      const video = videoRef.current
      if (!video || video.readyState < 2 || video.videoWidth === 0) return
      if (!canvasRef.current) canvasRef.current = document.createElement('canvas')
      const canvas = canvasRef.current
      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      const rect = video.getBoundingClientRect()
      const scale = video.videoWidth / rect.width
      const x = Math.floor((clientX - rect.left) * scale)
      const y = Math.floor((clientY - rect.top) * scale)
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
        setInteractive(false)
        return
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const alpha = ctx.getImageData(x, y, 1, 1).data[3] ?? 0
      setInteractive(alpha > HIT_ALPHA_THRESHOLD)
    },
    [setInteractive],
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
    } else {
      setAction('idle')
    }
  }, [])

  const onEnded = useCallback(() => {
    // One-shot actions (click) return to idle; loops never end.
    setAction('idle')
  }, [])

  if (!character) {
    return null
  }

  const looping = action === 'idle' || action === 'drag' || !(action in character.animations)

  return (
    <div
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: 'transparent' }}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <video
        ref={videoRef}
        src={animationUrl(character, action)}
        autoPlay
        loop={looping}
        muted
        onEnded={onEnded}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    </div>
  )
}
