// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from 'react'

interface MemoryCounts {
  semantic: number
  episodic: number
  procedural: number
}

const buttonStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '10px 12px',
  marginBottom: 10,
  borderRadius: 8,
  border: '1px solid #d8d2c8',
  background: '#faf6ee',
  cursor: 'pointer',
  fontSize: 14,
  textAlign: 'left',
}

/**
 * Settings window. M3: memory export / import / clear; the model wizard (M4)
 * will be added on top.
 */
export function SettingsApp() {
  const [counts, setCounts] = useState<MemoryCounts | null>(null)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    window.baize
      .memoryStats()
      .then(setCounts)
      .catch((error: unknown) => setStatus(`读取记忆状态失败：${String(error)}`))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const run = useCallback(
    async (
      action: () => Promise<{
        ok: boolean
        canceled?: boolean
        error?: string
        path?: string
        backupPath?: string
      }>,
      success: (r: { path?: string; backupPath?: string }) => string,
    ) => {
      setBusy(true)
      setStatus('')
      try {
        const result = await action()
        if (result.canceled) {
          setStatus('')
        } else if (result.ok) {
          setStatus(success(result))
        } else {
          setStatus(`操作失败：${result.error ?? '未知错误'}`)
        }
        refresh()
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 20, color: '#333' }}>
      <h1 style={{ fontSize: 18 }}>BaiZe（白泽）设置</h1>

      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 14, color: '#666' }}>记忆管理</h2>
        <p style={{ fontSize: 12, color: '#888' }}>
          {counts
            ? `语义记忆 ${counts.semantic} 条 · 情景记忆 ${counts.episodic} 条 · 程序性记忆 ${counts.procedural} 条`
            : '正在读取记忆状态…'}
        </p>
        <button
          type="button"
          style={buttonStyle}
          disabled={busy}
          onClick={() =>
            void run(
              () => window.baize.memoryExport(),
              (r) => `已导出到 ${r.path}`,
            )
          }
        >
          导出记忆（JSON 文件，可迁移到新电脑）
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={busy}
          onClick={() =>
            void run(
              () => window.baize.memoryImport(),
              (r) => `导入完成。导入前的数据库已备份到 ${r.backupPath}`,
            )
          }
        >
          导入记忆（导入前自动备份当前记忆）
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, borderColor: '#d8a8a8', background: '#faf0f0' }}
          disabled={busy}
          onClick={() =>
            void run(
              () => window.baize.memoryClear(),
              () => '记忆已清空',
            )
          }
        >
          清空记忆（不可恢复，请先导出）
        </button>
        {status && <p style={{ fontSize: 12, color: '#555' }}>{status}</p>}
      </section>

      <section>
        <h2 style={{ fontSize: 14, color: '#666' }}>模型配置</h2>
        <p style={{ color: '#888', fontSize: 13 }}>配置向导将在 M4 加入。</p>
      </section>
    </div>
  )
}
