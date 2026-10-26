// SPDX-License-Identifier: AGPL-3.0-only
import { contextBridge } from 'electron'

// Minimal API surface for now; expanded in M1-M4 behind the same namespace.
contextBridge.exposeInMainWorld('baize', {
  electronVersion: process.versions.electron,
})
