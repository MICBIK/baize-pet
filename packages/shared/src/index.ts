// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'

/** Names of the platform-level pet actions a character pack can provide. */
export type PetActionName = 'idle' | 'click' | 'drag' | (string & {})

/** Channels used over Electron IPC between main and renderer. */
export const IpcChannel = {
  petSetInteractive: 'pet:set-interactive',
  petDragStart: 'pet:drag-start',
  petDragMove: 'pet:drag-move',
  petDragEnd: 'pet:drag-end',
  petClick: 'pet:click',
  petGetCharacter: 'pet:get-character',
  settingsOpen: 'settings:open',
} as const

/** Animation map of a character pack, as delivered to the renderer. */
export interface CharacterInfo {
  /** Pack identifier (directory name). */
  id: string
  /** Action name -> pack-relative animation file path (e.g. "animations/idle.webm"). */
  animations: Record<PetActionName, string>
}

/** Persisted application configuration (userData/config.json). */
export const AppConfigSchema = z.object({
  /** Last known pet window position; must be validated against current displays on boot. */
  petWindow: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .optional(),
  /** Do-not-disturb: suppresses spontaneous behavior (wired into behavior in M2). */
  dnd: z.boolean().default(false),
})

export type AppConfig = z.infer<typeof AppConfigSchema>

export const defaultAppConfig = (): AppConfig => AppConfigSchema.parse({})
