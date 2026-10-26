// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatApp } from './ChatApp'

const container = document.getElementById('root')
if (!container) throw new Error('Chat bootstrap failed: missing #root element')

createRoot(container).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>,
)
