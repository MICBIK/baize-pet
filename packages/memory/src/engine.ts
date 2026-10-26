// SPDX-License-Identifier: AGPL-3.0-only
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type ConsolidationReport,
  type DecayState,
  type EpisodicEvent,
  type EventDraft,
  type EventDraft as EventDraftType,
  type ExportedMemory,
  MEMORY_EXPORT_FORMAT,
  MEMORY_EXPORT_VERSION,
  type MemoryEngine,
  MemoryExportSchema,
  type MemoryHit,
  type RecallQuery,
  type SemanticFact,
} from '@baize/shared'
import Database from 'better-sqlite3'
import { migrate } from './migrations'
import { WorkingMemory } from './working-memory'

/** Raised when an import file fails format or version validation. */
export class MemoryImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryImportError'
  }
}

export interface RecallWeights {
  alpha: number
  beta: number
  gamma: number
  recencyHalfLifeDays: number
}

export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  alpha: 0.3,
  beta: 0.4,
  gamma: 0.3,
  recencyHalfLifeDays: 14,
}

interface EpisodicRow {
  id: number
  created_at: number
  last_recalled_at: number | null
  event_type: string
  emotion_tags: string
  topic_tags: string
  participants: string
  importance: number
  content: string
  decay_state: DecayState
  pinned: number
}

function parseTags(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rowToEvent(row: EpisodicRow): EpisodicEvent {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastRecalledAt: row.last_recalled_at,
    eventType: row.event_type,
    emotionTags: parseTags(row.emotion_tags),
    topicTags: parseTags(row.topic_tags),
    participants: parseTags(row.participants),
    importance: row.importance,
    content: row.content,
    decayState: row.decay_state,
    pinned: row.pinned !== 0,
  }
}

/**
 * SQLite-backed MemoryEngine. All statements use parameter binding. The engine
 * is synchronous internally (better-sqlite3) and exposes the async interface
 * from docs/04 §6 so callers never block on the storage choice.
 */
export class SqliteMemoryEngine implements MemoryEngine {
  private readonly db: Database.Database
  private readonly working = new WorkingMemory()
  private readonly weights: RecallWeights
  private readonly dbPath: string

  constructor(dbPath: string, weights: RecallWeights = DEFAULT_RECALL_WEIGHTS) {
    this.dbPath = resolve(dbPath)
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.weights = weights
    migrate(this.db)
  }

  // -- Writes ---------------------------------------------------------------

  async record(event: EventDraftType): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO episodic_events
           (created_at, event_type, emotion_tags, topic_tags, participants, importance, content, decay_state, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        event.createdAt ?? Date.now(),
        event.eventType,
        JSON.stringify(event.emotionTags ?? []),
        JSON.stringify(event.topicTags ?? []),
        JSON.stringify(event.participants ?? []),
        event.importance ?? 5,
        event.content,
        event.pinned ? 1 : 0,
      )
  }

  /** Records a distilled stable fact (semantic memory). */
  async recordSemanticFact(
    content: string,
    source = 'chat',
    importance = 5,
    at = Date.now(),
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO semantic_facts (content, source, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(content, source, importance, at, at)
  }

  /** Records a behavioral habit pattern (procedural memory). */
  async recordProceduralRule(pattern: string, confidence = 0.5, at = Date.now()): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO procedural_rules (pattern, confidence, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(pattern, confidence, at, at)
  }

  /** Appends a chat turn to the in-RAM working memory window. */
  appendChatTurn(role: 'user' | 'assistant', content: string): void {
    this.working.append(role, content)
  }

  // -- Reads ----------------------------------------------------------------

  async recall(query: RecallQuery, budget: number): Promise<MemoryHit[]> {
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (query.since !== undefined) {
      conditions.push('created_at >= ?')
      params.push(query.since)
    }
    if (query.until !== undefined) {
      conditions.push('created_at <= ?')
      params.push(query.until)
    }
    if (query.minImportance !== undefined) {
      conditions.push('importance >= ?')
      params.push(query.minImportance)
    }
    if (query.decayStates && query.decayStates.length > 0) {
      conditions.push(`decay_state IN (${query.decayStates.map(() => '?').join(', ')})`)
      params.push(...query.decayStates)
    }
    if (query.pinnedOnly) {
      conditions.push('pinned = 1')
    }
    if (query.eventTypes && query.eventTypes.length > 0) {
      conditions.push(`event_type IN (${query.eventTypes.map(() => '?').join(', ')})`)
      params.push(...query.eventTypes)
    }

    // Tag filtering: any requested tag overlapping the stored JSON list.
    const tagGroups: string[][] = []
    for (const [column, tags] of [
      ['emotion_tags', query.emotionTags],
      ['topic_tags', query.topicTags],
    ] as const) {
      if (tags && tags.length > 0) {
        conditions.push('(' + tags.map(() => `${column} LIKE ?`).join(' OR ') + ')')
        params.push(...tags.map((tag) => `%"${tag}"%`))
        tagGroups.push([...tags])
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    // Over-fetch a bit so scoring can pick the best subset within budget.
    const rows = this.db
      .prepare(`SELECT * FROM episodic_events ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.max(budget * 5, 50)) as EpisodicRow[]

    const now = Date.now()
    const scored = rows.map((row) => {
      const event = rowToEvent(row)
      const ageDays = (now - event.createdAt) / 86_400_000
      const recency = 0.5 ** (ageDays / this.weights.recencyHalfLifeDays)
      const importance = event.importance / 10
      const requestedTags = tagGroups.flat().length
      const matchedTags = tagGroups.reduce(
        (sum, group) =>
          sum +
          (event.emotionTags.some((t) => group.includes(t)) ||
          event.topicTags.some((t) => group.includes(t))
            ? 1
            : 0),
        0,
      )
      const relevance = requestedTags > 0 ? matchedTags / requestedTags : 0.5
      const score =
        this.weights.alpha * recency +
        this.weights.beta * importance +
        this.weights.gamma * relevance
      return { id: event.id, score, event }
    })

    scored.sort((a, b) => b.score - a.score)
    const hits = scored.slice(0, Math.max(0, budget))

    // Reinforcement: refresh last_recalled_at (docs/04 §3).
    const touch = this.db.prepare(`UPDATE episodic_events SET last_recalled_at = ? WHERE id = ?`)
    for (const hit of hits) {
      touch.run(now, hit.id)
      hit.event.lastRecalledAt = now
    }
    return hits
  }

  async quickContext(): Promise<string> {
    const facts = this.db
      .prepare(`SELECT * FROM semantic_facts ORDER BY importance DESC, updated_at DESC LIMIT 10`)
      .all() as SemanticFact[]
    const parts: string[] = []
    if (facts.length > 0) {
      parts.push('关于主人的已知信息：')
      for (const fact of facts) {
        parts.push(`- ${fact.content}`)
      }
    }
    const turns = this.working.recent()
    if (turns.length > 0) {
      parts.push('最近的对话：')
      for (const turn of turns) {
        parts.push(`${turn.role === 'user' ? '主人' : '白泽'}：${turn.content}`)
      }
    }
    return parts.join('\n')
  }

  async consolidate(): Promise<ConsolidationReport> {
    // Sleep consolidation (clustering, distillation, decay transitions) is out
    // of scope this round; the interface stays stable for when it lands.
    throw new Error('consolidate() is not implemented yet (planned for a later milestone)')
  }

  // -- Export / import ------------------------------------------------------

  async exportAll(): Promise<ExportedMemory> {
    const semantic = (
      this.db.prepare(`SELECT * FROM semantic_facts ORDER BY id`).all() as Record<string, unknown>[]
    ).map((row) => ({
      id: row.id as number,
      content: row.content as string,
      source: row.source as string,
      importance: row.importance as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastRecalledAt: (row.last_recalled_at as number | null) ?? null,
    }))
    const episodic = (
      this.db.prepare(`SELECT * FROM episodic_events ORDER BY id`).all() as EpisodicRow[]
    ).map((row) => {
      const event = rowToEvent(row)
      return {
        id: event.id,
        createdAt: event.createdAt,
        lastRecalledAt: event.lastRecalledAt,
        eventType: event.eventType,
        emotionTags: event.emotionTags,
        topicTags: event.topicTags,
        participants: event.participants,
        importance: event.importance,
        content: event.content,
        decayState: event.decayState,
        pinned: event.pinned,
      }
    })
    const procedural = (
      this.db.prepare(`SELECT * FROM procedural_rules ORDER BY id`).all() as Record<
        string,
        unknown
      >[]
    ).map((row) => ({
      id: row.id as number,
      pattern: row.pattern as string,
      confidence: row.confidence as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }))
    return {
      format: MEMORY_EXPORT_FORMAT,
      version: MEMORY_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      tables: { semantic, episodic, procedural },
    }
  }

  /** Copies the current SQLite file (plus WAL) into backupDir before an import. */
  backupTo(backupDir: string, at = Date.now()): string {
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true })
    }
    const target = join(backupDir, `memory-backup-${at}.sqlite`)
    this.db.prepare('VACUUM INTO ?').run(target)
    return target
  }

  async importAll(exported: unknown): Promise<void> {
    const parsed = MemoryExportSchema.safeParse(exported)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
      throw new MemoryImportError(
        `Memory export file failed validation (format/version mismatch?): ${issues}`,
      )
    }
    const data = parsed.data
    if (data.format !== MEMORY_EXPORT_FORMAT || data.version !== MEMORY_EXPORT_VERSION) {
      throw new MemoryImportError(
        `Unsupported memory export format: ${data.format} v${data.version}`,
      )
    }

    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM semantic_facts`).run()
      this.db.prepare(`DELETE FROM episodic_events`).run()
      this.db.prepare(`DELETE FROM procedural_rules`).run()

      const insertSemantic = this.db.prepare(
        `INSERT INTO semantic_facts (id, content, source, importance, created_at, updated_at, last_recalled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const row of data.tables.semantic) {
        insertSemantic.run(
          row.id,
          row.content,
          row.source,
          row.importance,
          row.createdAt,
          row.updatedAt,
          row.lastRecalledAt,
        )
      }
      const insertEpisodic = this.db.prepare(
        `INSERT INTO episodic_events
           (id, created_at, last_recalled_at, event_type, emotion_tags, topic_tags, participants, importance, content, decay_state, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const row of data.tables.episodic) {
        insertEpisodic.run(
          row.id,
          row.createdAt,
          row.lastRecalledAt,
          row.eventType,
          JSON.stringify(row.emotionTags),
          JSON.stringify(row.topicTags),
          JSON.stringify(row.participants),
          row.importance,
          row.content,
          row.decayState,
          row.pinned ? 1 : 0,
        )
      }
      const insertProcedural = this.db.prepare(
        `INSERT INTO procedural_rules (id, pattern, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      for (const row of data.tables.procedural) {
        insertProcedural.run(row.id, row.pattern, row.confidence, row.createdAt, row.updatedAt)
      }
    })()
  }

  /** Clears all memory tables (setup page "清空记忆"); the schema is kept. */
  async clearAll(): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM semantic_facts`).run()
      this.db.prepare(`DELETE FROM episodic_events`).run()
      this.db.prepare(`DELETE FROM procedural_rules`).run()
    })()
    this.working.clear()
  }

  counts(): { semantic: number; episodic: number; procedural: number } {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return {
      semantic: count('semantic_facts'),
      episodic: count('episodic_events'),
      procedural: count('procedural_rules'),
    }
  }

  close(): void {
    this.db.close()
  }
}
