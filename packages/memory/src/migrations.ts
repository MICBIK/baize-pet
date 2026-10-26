// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from 'better-sqlite3'

// v1 schema: static DDL, no user data involved (safe to run with db.exec).
const SCHEMA_V1 = [
  `CREATE TABLE semantic_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'chat',
    importance REAL NOT NULL DEFAULT 5,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_recalled_at INTEGER
  )`,
  `CREATE TABLE episodic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    last_recalled_at INTEGER,
    event_type TEXT NOT NULL,
    emotion_tags TEXT NOT NULL DEFAULT '[]',
    topic_tags TEXT NOT NULL DEFAULT '[]',
    participants TEXT NOT NULL DEFAULT '[]',
    importance REAL NOT NULL DEFAULT 5,
    content TEXT NOT NULL,
    embedding BLOB,
    decay_state TEXT NOT NULL DEFAULT 'active',
    pinned INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX idx_episodic_type ON episodic_events(event_type)`,
  `CREATE INDEX idx_episodic_created ON episodic_events(created_at)`,
  `CREATE INDEX idx_episodic_decay ON episodic_events(decay_state)`,
  `CREATE TABLE procedural_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
]

type Migration = { statements: string[] }

/** Versioned schema migrations; MIGRATIONS[n] upgrades user_version n to n+1. */
export const MIGRATIONS: Migration[] = [{ statements: SCHEMA_V1 }]

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version]
    if (!migration) break
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.prepare(statement).run()
      }
      db.pragma(`user_version = ${version + 1}`)
    })()
  }
}
