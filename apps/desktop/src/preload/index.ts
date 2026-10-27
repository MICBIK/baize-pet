// SPDX-License-Identifier: AGPL-3.0-only

import { type CharacterInfo, IpcChannel } from '@baize/shared'
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'

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
    const handler = (_event: IpcRendererEvent, action: string): void => callback(action)
    ipcRenderer.on(IpcChannel.petAction, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannel.petAction, handler)
    }
  },
  /** Main -> renderer: show a speech bubble line. */
  onSay: (callback: (line: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, line: string): void => callback(line)
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
  // Model wizard + chat (M4). Plaintext keys never pass through the renderer.
  modelGet: (): Promise<{
    configured: boolean
    providerId?: string
    model?: string
    hasKey: boolean
    dailyTokenLimit: number | null
  }> => ipcRenderer.invoke(IpcChannel.modelGet),
  /** Public provider presets (id/label/defaultModel/needsKey/keyUrl) — no secrets. */
  wizardPresets: (): Promise<
    { id: string; label: string; defaultModel: string; needsKey: boolean; keyUrl: string | null }[]
  > => ipcRenderer.invoke(IpcChannel.wizardPresets),
  wizardSave: (draft: {
    providerId: string
    model: string
    baseUrl?: string
    apiKey?: string
    dailyTokenLimit?: number | null
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IpcChannel.wizardSave, draft),
  wizardTest: (draft: {
    providerId: string
    model: string
    baseUrl?: string
    apiKey?: string
    dailyTokenLimit?: number | null
  }): Promise<{ ok: boolean; error?: string; reply?: string }> =>
    ipcRenderer.invoke(IpcChannel.wizardTest, draft),
  wizardOpenKeyPage: (providerId: string): void => {
    ipcRenderer.send(IpcChannel.wizardOpenKeyPage, providerId)
  },
  chatSend: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.chatSend, text),
  chatHistory: (): Promise<{ role: 'user' | 'assistant'; content: string }[]> =>
    ipcRenderer.invoke(IpcChannel.chatHistory),
  onChatDelta: (callback: (text: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: { text: string }): void =>
      callback(payload.text)
    ipcRenderer.on(IpcChannel.chatDelta, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannel.chatDelta, handler)
    }
  },
  onChatDone: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IpcChannel.chatDone, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannel.chatDone, handler)
    }
  },
  onChatError: (callback: (message: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: { message: string }): void =>
      callback(payload.message)
    ipcRenderer.on(IpcChannel.chatError, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannel.chatError, handler)
    }
  },
}

export type BaizeApi = typeof api

contextBridge.exposeInMainWorld('baize', api)
