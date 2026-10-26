// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SqliteMemoryEngine } from '@baize/memory'
import { IpcChannel } from '@baize/shared'
import { app, type BrowserWindow, dialog, ipcMain } from 'electron'

const MEMORY_JSON_FILTERS = [{ name: 'BaiZe Memory Export', extensions: ['json'] }]

/**
 * Setup-page memory management: export / import / clear. Import always backs up
 * the current database (docs/07 M3: "导入前校验版本并备份当前库").
 */
export function registerMemoryIpc(
  engine: SqliteMemoryEngine,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle(IpcChannel.memoryStats, () => engine.counts())

  ipcMain.handle(IpcChannel.memoryExport, async () => {
    const parent = getWindow() ?? undefined
    const result = await dialog.showSaveDialog(parent ?? (undefined as never), {
      title: '导出 BaiZe 记忆',
      defaultPath: `baize-memory-${new Date().toISOString().slice(0, 10)}.json`,
      filters: MEMORY_JSON_FILTERS,
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    const exported = await engine.exportAll()
    await writeFile(result.filePath, JSON.stringify(exported, null, 2), 'utf8')
    return { ok: true, path: result.filePath }
  })

  ipcMain.handle(IpcChannel.memoryImport, async () => {
    const parent = getWindow() ?? undefined
    const result = await dialog.showOpenDialog(parent ?? (undefined as never), {
      title: '导入 BaiZe 记忆',
      filters: MEMORY_JSON_FILTERS,
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    const raw = await readFile(result.filePaths[0] ?? '', 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, error: '文件不是有效的 JSON' }
    }
    const backupPath = engine.backupTo(join(app.getPath('userData'), 'memory-backups'))
    try {
      await engine.importAll(parsed)
      return { ok: true, backupPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IpcChannel.memoryClear, async () => {
    const parent = getWindow() ?? undefined
    const { response } = await dialog.showMessageBox(parent ?? (undefined as never), {
      type: 'warning',
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
      message: '确定清空全部记忆吗？',
      detail: '所有语义、情景与程序性记忆都会被删除，且无法撤销（建议先导出备份）。',
    })
    if (response !== 1) return { ok: false, canceled: true }
    await engine.clearAll()
    return { ok: true }
  })
}
