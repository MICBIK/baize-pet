// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from 'react'

interface MemoryCounts {
  semantic: number
  episodic: number
  procedural: number
}

interface ModelStatus {
  configured: boolean
  providerId?: string
  model?: string
  hasKey: boolean
  dailyTokenLimit: number | null
}

/** Public preset metadata delivered over IPC (no secrets, no endpoint plumbing). */
interface ProviderPresetInfo {
  id: string
  label: string
  defaultModel: string
  needsKey: boolean
  keyUrl: string | null
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

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #ddd',
  fontSize: 13,
  marginBottom: 10,
}

/** Model configuration wizard (first launch, re-enterable from settings). */
function ModelWizard({ status, onDone }: { status: ModelStatus | null; onDone: () => void }) {
  const [presets, setPresets] = useState<ProviderPresetInfo[] | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [limit, setLimit] = useState('')
  const [statusText, setStatusText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.baize
      .wizardPresets()
      .then(setPresets)
      .catch((error: unknown) => setStatusText(`读取厂商列表失败：${String(error)}`))
  }, [])

  const preset = presets?.find((candidate) => candidate.id === providerId) ?? null
  const isCustom = preset?.id === 'custom'
  // Re-entering the wizard for the same provider: an empty key field reuses the
  // stored one (both test and save resolve through the saved ciphertext).
  const canReuseKey =
    status?.hasKey === true && status.providerId === preset?.id && apiKey.length === 0

  const pick = (candidate: ProviderPresetInfo) => {
    setProviderId(candidate.id)
    setModel(candidate.defaultModel)
    setBaseUrl('')
    setStatusText('')
  }

  const draft = useCallback(
    () => ({
      providerId: providerId ?? '',
      model,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey || undefined,
      dailyTokenLimit: limit ? Number(limit) : null,
    }),
    [providerId, model, baseUrl, apiKey, limit],
  )

  const testAndSave = async () => {
    setBusy(true)
    setStatusText('正在测试连接…')
    const test = await window.baize.wizardTest(draft())
    if (!test.ok) {
      setStatusText(`连接失败：${test.error ?? '未知错误'}`)
      setBusy(false)
      return
    }
    const save = await window.baize.wizardSave(draft())
    if (!save.ok) {
      setStatusText(`保存失败：${save.error ?? '未知错误'}`)
      setBusy(false)
      return
    }
    setStatusText('配置完成！点击宠物即可开始对话。')
    setBusy(false)
    setTimeout(onDone, 1200)
  }

  if (!presets) {
    return <p style={{ fontSize: 13, color: '#555' }}>{statusText || '正在加载厂商列表…'}</p>
  }

  if (!preset) {
    return (
      <div>
        <p style={{ fontSize: 13, color: '#555' }}>选择一个模型服务（之后也可以在设置里修改）：</p>
        {presets.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            style={buttonStyle}
            onClick={() => pick(candidate)}
          >
            {candidate.label}
            <span style={{ color: '#999', fontSize: 12 }}>
              {candidate.defaultModel
                ? ` · 默认模型 ${candidate.defaultModel}`
                : ' · 自填地址与模型'}
            </span>
          </button>
        ))}
        <button type="button" style={{ ...buttonStyle, textAlign: 'center' }} onClick={onDone}>
          稍后再说（跳过）
        </button>
        {statusText && <p style={{ fontSize: 12, color: '#555' }}>{statusText}</p>}
      </div>
    )
  }

  return (
    <div>
      <p style={{ fontSize: 14 }}>
        <strong>{preset.label}</strong>
        <button
          type="button"
          style={{
            marginLeft: 10,
            fontSize: 12,
            border: 'none',
            background: 'none',
            color: '#4a90d9',
            cursor: 'pointer',
          }}
          onClick={() => setProviderId(null)}
        >
          重新选择
        </button>
      </p>
      {preset.keyUrl && (
        <button
          type="button"
          style={buttonStyle}
          onClick={() => window.baize.wizardOpenKeyPage(preset.id)}
        >
          第 1 步：打开 {preset.label} 官网获取 API key ↗
        </button>
      )}
      <p style={{ fontSize: 13, margin: '6px 0' }}>
        {isCustom
          ? '第 2 步：填写服务地址与模型名（key 可选）'
          : preset.needsKey
            ? '第 2 步：粘贴 API key'
            : '本地服务无需 key'}
      </p>
      {isCustom && (
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="服务地址，例如 https://api.example.com/v1"
          style={inputStyle}
        />
      )}
      {(preset.needsKey || isCustom) && (
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            canReuseKey
              ? '留空沿用已保存的 key'
              : isCustom
                ? '（可选）sk-…（只存本机，经系统钥匙串加密）'
                : 'sk-…（只存本机，经系统钥匙串加密）'
          }
          style={inputStyle}
        />
      )}
      {canReuseKey && (
        <p style={{ fontSize: 12, color: '#888', margin: '-6px 0 10px' }}>
          已保存过该服务的 key，不重新填写即沿用。
        </p>
      )}
      <p style={{ fontSize: 13, margin: '6px 0' }}>第 3 步：确认模型名</p>
      <input
        value={model}
        onChange={(event) => setModel(event.target.value)}
        placeholder={preset.defaultModel || '例如 qwen2.5-7b-instruct'}
        style={inputStyle}
      />
      <p style={{ fontSize: 13, margin: '6px 0' }}>（可选）每日 token 上限</p>
      <input
        value={limit}
        onChange={(event) => setLimit(event.target.value.replace(/\D/g, ''))}
        placeholder="例如 200000（留空 = 不限制）"
        style={inputStyle}
      />
      <button
        type="button"
        style={{ ...buttonStyle, textAlign: 'center', background: '#e8f2e8' }}
        disabled={busy}
        onClick={() => void testAndSave()}
      >
        {busy ? '测试中…' : '测试连通并保存'}
      </button>
      <button
        type="button"
        style={{ ...buttonStyle, textAlign: 'center' }}
        disabled={busy}
        onClick={onDone}
      >
        返回
      </button>
      {statusText && <p style={{ fontSize: 12, color: '#555' }}>{statusText}</p>}
    </div>
  )
}

/** Settings window: model wizard (M4) + memory management (M3). */
export function SettingsApp() {
  const [counts, setCounts] = useState<MemoryCounts | null>(null)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<ModelStatus | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  const refresh = useCallback(() => {
    window.baize
      .memoryStats()
      .then(setCounts)
      .catch((error: unknown) => setStatus(`读取记忆状态失败：${String(error)}`))
    window.baize
      .modelGet()
      .then(setModel)
      .catch(() => setModel(null))
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
        <h2 style={{ fontSize: 14, color: '#666' }}>模型配置</h2>
        {wizardOpen ? (
          <ModelWizard
            status={model}
            onDone={() => {
              setWizardOpen(false)
              refresh()
            }}
          />
        ) : (
          <div>
            <p style={{ fontSize: 12, color: '#888' }}>
              {model?.configured
                ? `当前：${model.providerId} · ${model.model}${model.hasKey ? ' · 已保存 key' : ' · 无需 key'}${
                    model.dailyTokenLimit
                      ? ` · 每日上限 ${model.dailyTokenLimit} tokens`
                      : ' · 不限用量'
                  }`
                : '尚未配置模型。配置后即可与宠物对话。'}
            </p>
            <button type="button" style={buttonStyle} onClick={() => setWizardOpen(true)}>
              {model?.configured ? '重新配置模型' : '开始配置向导'}
            </button>
          </div>
        )}
      </section>

      <section>
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
    </div>
  )
}
