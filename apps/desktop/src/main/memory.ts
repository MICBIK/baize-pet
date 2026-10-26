// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import { SqliteMemoryEngine } from '@baize/memory'
import { app } from 'electron'

/** Single app-wide memory engine; the DB path is managed here and only here. */
export function createAppMemory(): SqliteMemoryEngine {
  const userDataDir = app.getPath('userData')
  return new SqliteMemoryEngine(join(userDataDir, 'memory.sqlite'))
}
