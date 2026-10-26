// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsApp } from './SettingsApp'

const container = document.getElementById('root')
if (!container) throw new Error('Settings bootstrap failed: missing #root element')

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
)
