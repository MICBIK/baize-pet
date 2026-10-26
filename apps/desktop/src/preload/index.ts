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
}

export type BaizeApi = typeof api

contextBridge.exposeInMainWorld('baize', api)
