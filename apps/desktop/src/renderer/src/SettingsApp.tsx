// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings window (skeleton). Memory import/export buttons arrive in M3 and the
 * model configuration wizard in M4.
 */
export function SettingsApp() {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 20, color: '#333' }}>
      <h1 style={{ fontSize: 18 }}>BaiZe（白泽）设置</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        骨架占位页。记忆导入 / 导出与模型配置向导将在后续里程碑中加入。
      </p>
      <p style={{ color: '#888', fontSize: 13 }}>宠物当前处于勿扰开关控制之下，可在菜单栏切换。</p>
    </div>
  )
}
