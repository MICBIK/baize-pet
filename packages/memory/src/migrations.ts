// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseSync } from 'node:sqlite'

// PRAGMA assignment cannot use bound parameters; we index into a table of
// constant statements instead of interpolating values at the call site.
const SET_USER_VERSION = [
  'PRAGMA user_version = 0',
  'PRAGMA user_version = 1',
  'PRAGMA user_version = 2',
  'PRAGMA user_version = 3',
  'PRAGMA user_version = 4',
  'PRAGMA user_version = 5',
  'PRAGMA user_version = 6',
  'PRAGMA user_version = 7',
  'PRAGMA user_version = 8',
  'PRAGMA user_version = 9',
  'PRAGMA user_version = 10',
]

/** Reads PRAGMA user_version via a prepared statement (node:sqlite has no pragma helper). */
export function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

export function setUserVersion(db: DatabaseSync, version: number): void {
  const statement = SET_USER_VERSION[version]
  if (!statement) throw new Error(`Unsupported schema version: ${version}`)
  db.prepare(statement).run()
}

/** Minimal transaction helper (node:sqlite has no transaction() wrapper). */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// v1 schema: static DDL, no user data involved (safe to run through prepare).
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

export function migrate(db: DatabaseSync): void {
  const current = userVersion(db)
  for (let version = current; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version]
    if (!migration) break
    runInTransaction(db, () => {
      for (const statement of migration.statements) {
        db.prepare(statement).run()
      }
      setUserVersion(db, version + 1)
    })
  }
}
