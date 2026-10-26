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
  /** Main -> renderer: play an action (spontaneous behavior). */
  petAction: 'pet:action',
  /** Main -> renderer: show a speech bubble. */
  petSay: 'pet:say',
  settingsOpen: 'settings:open',
  /** Setup page memory management. */
  memoryStats: 'memory:stats',
  memoryExport: 'memory:export',
  memoryImport: 'memory:import',
  memoryClear: 'memory:clear',
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

// ---------------------------------------------------------------------------
// Memory system interfaces (docs/04). The engine hides behind these types so the
// implementation can be swapped without touching consumers.
// ---------------------------------------------------------------------------

export type DecayState = 'active' | 'compressed' | 'impression' | 'cold'

/** A to-be-recorded episodic event. */
export interface EventDraft {
  eventType: string
  content: string
  emotionTags?: string[]
  topicTags?: string[]
  participants?: string[]
  /** 0-10, default 5. */
  importance?: number
  /** Epoch ms; defaults to now. */
  createdAt?: number
  pinned?: boolean
}

export interface EpisodicEvent {
  id: number
  createdAt: number
  lastRecalledAt: number | null
  eventType: string
  emotionTags: string[]
  topicTags: string[]
  participants: string[]
  importance: number
  content: string
  decayState: DecayState
  pinned: boolean
}

export interface SemanticFact {
  id: number
  content: string
  source: string
  importance: number
  createdAt: number
  updatedAt: number
  lastRecalledAt: number | null
}

export interface ProceduralRule {
  id: number
  pattern: string
  confidence: number
  createdAt: number
  updatedAt: number
}

export interface RecallQuery {
  /** Reserved for vector retrieval in a later milestone; ignored for now. */
  text?: string
  eventTypes?: string[]
  emotionTags?: string[]
  topicTags?: string[]
  since?: number
  until?: number
  minImportance?: number
  decayStates?: DecayState[]
  pinnedOnly?: boolean
}

export interface MemoryHit {
  id: number
  /** α·recency + β·importance + γ·relevance (tag overlap). */
  score: number
  event: EpisodicEvent
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  at: number
}

export interface ConsolidationReport {
  /** Reserved (sleep consolidation is out of scope this round). */
  startedAt: number
  finishedAt: number
  processed: number
}

/** The stable memory engine interface (docs/04 §6). */
export interface MemoryEngine {
  record(event: EventDraft): Promise<void>
  recall(query: RecallQuery, budget: number): Promise<MemoryHit[]>
  quickContext(): Promise<string>
  consolidate(): Promise<ConsolidationReport>
  exportAll(): Promise<ExportedMemory>
  importAll(exported: unknown): Promise<void>
}

export const MEMORY_EXPORT_FORMAT = 'baize-memory-export'
export const MEMORY_EXPORT_VERSION = 1

/** Zod schema of the JSON export format ("your memory is always exportable"). */
export const MemoryExportSchema = z.object({
  format: z.literal(MEMORY_EXPORT_FORMAT),
  version: z.literal(MEMORY_EXPORT_VERSION),
  exportedAt: z.string(),
  tables: z.object({
    semantic: z.array(
      z.object({
        id: z.number().int(),
        content: z.string(),
        source: z.string(),
        importance: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        lastRecalledAt: z.number().nullable(),
      }),
    ),
    episodic: z.array(
      z.object({
        id: z.number().int(),
        createdAt: z.number(),
        lastRecalledAt: z.number().nullable(),
        eventType: z.string(),
        emotionTags: z.array(z.string()),
        topicTags: z.array(z.string()),
        participants: z.array(z.string()),
        importance: z.number(),
        content: z.string(),
        decayState: z.enum(['active', 'compressed', 'impression', 'cold']),
        pinned: z.boolean(),
      }),
    ),
    procedural: z.array(
      z.object({
        id: z.number().int(),
        pattern: z.string(),
        confidence: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
      }),
    ),
  }),
})

export type ExportedMemory = z.infer<typeof MemoryExportSchema>
