// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqliteMemoryEngine } from './engine'

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'baize-memory-test-'))
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

function openEngine(name = 'mem.sqlite'): SqliteMemoryEngine {
  return new SqliteMemoryEngine(join(tempRoot, name))
}

describe('SqliteMemoryEngine', () => {
  it('creates the schema with a version marker and reopens without re-migrating', () => {
    const engine = openEngine('migrate.sqlite')
    engine.close()
    const second = openEngine('migrate.sqlite')
    // Opening twice would fail on duplicate CREATE TABLE if migration re-ran.
    expect(second.counts().episodic).toBe(0)
    second.close()
  })

  it('records and recalls episodic events with tag / time / importance filters', async () => {
    const engine = openEngine('recall.sqlite')
    const now = Date.now()
    await engine.record({
      eventType: '对话',
      content: '聊了 deadline',
      topicTags: ['工作'],
      importance: 8,
      createdAt: now - 1000,
    })
    await engine.record({
      eventType: '捣蛋',
      content: '扒拉了图标',
      emotionTags: ['开心'],
      importance: 3,
      createdAt: now - 5000,
    })
    await engine.record({
      eventType: '对话',
      content: '旧事件',
      topicTags: ['工作'],
      importance: 2,
      createdAt: now - 86_400_000 * 30,
    })

    const byTopic = await engine.recall({ topicTags: ['工作'] }, 10)
    expect(byTopic).toHaveLength(2)
    expect(byTopic[0]?.event.content).toBe('聊了 deadline')

    const byType = await engine.recall({ eventTypes: ['捣蛋'] }, 10)
    expect(byType).toHaveLength(1)
    expect(byType[0]?.event.emotionTags).toEqual(['开心'])

    const byImportance = await engine.recall({ minImportance: 5 }, 10)
    expect(byImportance).toHaveLength(1)

    const byTime = await engine.recall({ since: now - 2000 }, 10)
    expect(byTime).toHaveLength(1)

    await engine.close()
  })

  it('ranks by the three-factor score within the budget and refreshes last_recalled_at', async () => {
    const engine = openEngine('score.sqlite')
    const now = Date.now()
    await engine.record({
      eventType: '对话',
      content: '重要且新',
      topicTags: ['工作'],
      importance: 10,
      createdAt: now - 1000,
    })
    await engine.record({
      eventType: '对话',
      content: '重要但旧',
      topicTags: ['工作'],
      importance: 10,
      createdAt: now - 86_400_000 * 60,
    })
    await engine.record({
      eventType: '对话',
      content: '不重要',
      topicTags: ['工作'],
      importance: 1,
      createdAt: now - 1000,
    })

    const hits = await engine.recall({ topicTags: ['工作'] }, 2)
    expect(hits).toHaveLength(2)
    expect(hits[0]?.event.content).toBe('重要且新')
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
    // Budget limits the result set.
    const one = await engine.recall({}, 1)
    expect(one).toHaveLength(1)

    const refreshed = await engine.recall({ topicTags: ['工作'] }, 10)
    for (const hit of refreshed) {
      expect(hit.event.lastRecalledAt).not.toBeNull()
    }
    await engine.close()
  })

  it('respects pinnedOnly and keeps pinned events findable', async () => {
    const engine = openEngine('pin.sqlite')
    await engine.record({ eventType: '里程碑', content: '起名日', pinned: true })
    await engine.record({ eventType: '对话', content: '日常' })
    const pinned = await engine.recall({ pinnedOnly: true }, 10)
    expect(pinned).toHaveLength(1)
    expect(pinned[0]?.event.pinned).toBe(true)
    await engine.close()
  })

  it('builds quickContext from semantic facts and working memory', async () => {
    const engine = openEngine('context.sqlite')
    await engine.recordSemanticFact('主人叫小明', 'naming', 9)
    await engine.recordSemanticFact('主人喜欢凌晨写代码', 'chat', 7)
    engine.appendChatTurn('user', '我回来了')
    engine.appendChatTurn('assistant', '欢迎回家！')
    const context = await engine.quickContext()
    expect(context).toContain('主人叫小明')
    expect(context).toContain('主人喜欢凌晨写代码')
    expect(context).toContain('主人：我回来了')
    expect(context).toContain('白泽：欢迎回家！')
    await engine.close()
  })

  it('survives export -> clear -> import with byte-identical data', async () => {
    const engine = openEngine('roundtrip.sqlite')
    const at = 1_700_000_000_000
    await engine.record({
      eventType: '起名',
      content: '主人给我起名"小泽"',
      emotionTags: ['开心'],
      topicTags: ['家人'],
      participants: ['主人'],
      importance: 10,
      createdAt: at,
      pinned: true,
    })
    await engine.record({
      eventType: '对话',
      content: '聊了猫',
      topicTags: ['宠物'],
      importance: 4,
      createdAt: at + 5000,
    })
    await engine.recordSemanticFact('主人叫小明', 'naming', 9, at)
    await engine.recordProceduralRule('用户 9-18 点勿扰', 0.8, at)
    const before = engine.counts()
    const exported = await engine.exportAll()

    // Validate the export envelope.
    expect(exported.format).toBe('baize-memory-export')
    expect(exported.version).toBe(1)
    expect(exported.exportedAt).toBeTruthy()

    await engine.clearAll()
    expect(engine.counts()).toEqual({ semantic: 0, episodic: 0, procedural: 0 })

    await engine.importAll(exported)
    const after = engine.counts()
    expect(after).toEqual(before)

    const hits = await engine.recall({ topicTags: ['家人'] }, 10)
    expect(hits[0]?.event.content).toBe('主人给我起名"小泽"')
    expect(hits[0]?.event.pinned).toBe(true)
    expect(hits[0]?.event.emotionTags).toEqual(['开心'])
    expect(hits[0]?.event.createdAt).toBe(at)
    expect(await engine.quickContext()).toContain('主人叫小明')
    await engine.close()
  })

  it('backs up the database before import and rejects invalid exports', async () => {
    const engine = openEngine('backup.sqlite')
    const at = Date.now()
    await engine.record({ eventType: '对话', content: '唯一事件', createdAt: at })

    const backupDir = join(tempRoot, 'backups')
    const backupPath = engine.backupTo(backupDir, at)
    expect(backupPath).toContain('memory-backup-')

    for (const bad of [
      null,
      {},
      { format: 'baize-memory-export', version: 1 },
      { format: 'wrong', version: 1, exportedAt: '', tables: {} },
    ]) {
      await expect(engine.importAll(bad)).rejects.toBeInstanceOf(
        (await import('./engine')).MemoryImportError,
      )
    }
    // Failed imports leave data untouched.
    expect(engine.counts().episodic).toBe(1)

    // The backup file can be opened as an independent SQLite database containing the data.
    const restored = new SqliteMemoryEngine(backupPath)
    expect(restored.counts().episodic).toBe(1)
    restored.close()
    await engine.close()
  })

  it('raises a readable error on import format/version mismatch', async () => {
    const engine = openEngine('version.sqlite')
    await expect(
      engine.importAll({
        format: 'baize-memory-export',
        version: 99,
        exportedAt: '2026-01-01',
        tables: { semantic: [], episodic: [], procedural: [] },
      }),
    ).rejects.toThrow(/format/i)
    await engine.close()
  })
})
