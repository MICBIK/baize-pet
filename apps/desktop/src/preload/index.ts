// SPDX-License-Identifier: AGPL-3.0-only

import { type CharacterInfo, IpcChannel } from '@baize/shared'
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  platform: process.platform,
  /** Ask main to make the window clickable (cursor over an opaque pet pixel) or click-through. */
  setInteractive: (interactive: boolean): void => {
    ipcRenderer.send(IpcChannel.petSetInteractive, interactive)
  },
  dragStart: (): void => {
    ipcRenderer.send(IpcChannel.petDragStart)
  },
  dragMove: (): void => {
    ipcRenderer.send(IpcChannel.petDragMove)
  },
  dragEnd: (): void => {
    ipcRenderer.send(IpcChannel.petDragEnd)
  },
  getCharacter: (): Promise<CharacterInfo> => ipcRenderer.invoke(IpcChannel.petGetCharacter),
  /** Renderer -> main: a click on the pet (no drag movement). */
  click: (): void => {
    ipcRenderer.send(IpcChannel.petClick)
  },
  /** Main -> renderer: play a spontaneous action. */
  onPetAction: (callback: (action: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => callback(action)
    ipcRenderer.on(IpcChannel.petAction, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannel.petAction, handler)
    }
  },
  /** Main -> renderer: show a speech bubble line. */
  onSay: (callback: (line: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, line: string): void => callback(line)
    ipcRenderer.on(IpcChannel.petSay, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannel.petSay, handler)
    }
  },
  // Setup-page memory management (M3). File dialogs live in the main process.
  memoryStats: (): Promise<{ semantic: number; episodic: number; procedural: number }> =>
    ipcRenderer.invoke(IpcChannel.memoryStats),
  memoryExport: (): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.memoryExport),
  memoryImport: (): Promise<{
    ok: boolean
    canceled?: boolean
    backupPath?: string
    error?: string
  }> => ipcRenderer.invoke(IpcChannel.memoryImport),
  memoryClear: (): Promise<{ ok: boolean; canceled?: boolean }> =>
    ipcRenderer.invoke(IpcChannel.memoryClear),
}

export type BaizeApi = typeof api

contextBridge.exposeInMainWorld('baize', api)
