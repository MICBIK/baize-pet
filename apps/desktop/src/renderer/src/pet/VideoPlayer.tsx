// SPDX-License-Identifier: AGPL-3.0-only
import type { CharacterInfo, PetActionName } from '@baize/shared'
import { type RefObject, useCallback } from 'react'

/** Pack file URL through the CORS-enabled baize-character protocol. */
export function packUrl(info: CharacterInfo, path: string): string {
  return `baize-character://${info.id}/${path}`
}

export interface VideoPlayerProps {
  info: CharacterInfo
  action: PetActionName
  videoRef: RefObject<HTMLVideoElement | null>
  looping: boolean
  onEnded: () => void
}

/**
 * The original <video> path extracted verbatim (task book E): placeholder and
 * other video packs keep behaving exactly as before.
 */
export function VideoPlayer(props: VideoPlayerProps): React.JSX.Element {
  const { info, action, videoRef, looping, onEnded } = props
  const file = info.animations[action] ?? info.animations.idle
  const url = file ? packUrl(info, file) : ''
  return (
    <video
      ref={videoRef}
      src={url}
      crossOrigin="anonymous"
      autoPlay
      loop={looping}
      muted
      onEnded={onEnded}
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
    />
  )
}

/** The video's drawn area inside the element (object-fit letterboxing removed). */
export function containRect(video: HTMLVideoElement): {
  left: number
  top: number
  workW: number
  workH: number
} {
  const rect = video.getBoundingClientRect()
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight)
  return {
    left: rect.left + (rect.width - video.videoWidth * scale) / 2,
    top: rect.top + (rect.height - video.videoHeight * scale) / 2,
    workW: video.videoWidth * scale,
    workH: video.videoHeight * scale,
  }
}

export function usePackUrl(): (info: CharacterInfo, path: string) => string {
  return useCallback(packUrl, [])
}
