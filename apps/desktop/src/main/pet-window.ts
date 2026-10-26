// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import { IpcChannel } from '@baize/shared'
import { BrowserWindow, type Display, ipcMain, type Rectangle, screen } from 'electron'

export const PET_SIZE = 256

const DEFAULT_MARGIN = 48

function unionBounds(displays: Display[]): Rectangle {
  return displays.reduce<Rectangle>(
    (acc, d) => {
      const x = Math.min(acc.x, d.bounds.x)
      const y = Math.min(acc.y, d.bounds.y)
      const right = Math.max(acc.x + acc.width, d.bounds.x + d.bounds.width)
      const bottom = Math.max(acc.y + acc.height, d.bounds.y + d.bounds.height)
      return { x, y, width: right - x, height: bottom - y }
    },
    { x: Infinity, y: Infinity, width: 0, height: 0 },
  )
}

/** True when the window rectangle overlaps at least one display. */
export function isPositionVisible(x: number, y: number, width: number, height: number): boolean {
  const rect = { x, y, width, height }
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds
    return (
      rect.x < b.x + b.width &&
      rect.x + rect.width > b.x &&
      rect.y < b.y + b.height &&
      rect.y + rect.height > b.y
    )
  })
}

/** Keeps the whole window inside the union of all displays (multi-monitor safe). */
export function clampToDisplays(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const u = unionBounds(screen.getAllDisplays())
  return {
    x: Math.min(Math.max(x, u.x), Math.max(u.x, u.x + u.width - width)),
    y: Math.min(Math.max(y, u.y), Math.max(u.y, u.y + u.height - height)),
  }
}

function defaultPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - PET_SIZE - DEFAULT_MARGIN,
    y: area.y + area.height - PET_SIZE - DEFAULT_MARGIN,
  }
}

export interface PetWindowHandle {
  window: BrowserWindow
  onShown: () => void
}

export function createPetWindow(savedPosition?: { x: number; y: number }): BrowserWindow {
  const restored =
    savedPosition && isPositionVisible(savedPosition.x, savedPosition.y, PET_SIZE, PET_SIZE)
      ? savedPosition
      : defaultPosition()
  const { x, y } = clampToDisplays(restored.x, restored.y, PET_SIZE, PET_SIZE)

  const win = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    x,
    y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Float above normal windows but below system overlays; visible on every Space.
  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // Click-through by default; the renderer opt-in via IpcChannel.petSetInteractive
  // when the cursor is over an opaque pixel of the pet.
  win.setIgnoreMouseEvents(true, { forward: true })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  return win
}

export function registerPetIpc(
  win: BrowserWindow,
  persistPosition: (x: number, y: number) => void,
  onDragEnd?: () => void,
): void {
  let dragging = false
  let grabOffset = { x: 0, y: 0 }

  const setInteractive = (interactive: boolean) => {
    // Keep forwarding mouse moves so the renderer can re-enable interaction.
    win.setIgnoreMouseEvents(!interactive, { forward: true })
  }

  ipcMain.on(IpcChannel.petSetInteractive, (_event, interactive: unknown) => {
    if (typeof interactive === 'boolean' && !dragging) setInteractive(interactive)
  })

  ipcMain.on(IpcChannel.petDragStart, () => {
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    grabOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    dragging = true
    setInteractive(true)
  })

  ipcMain.on(IpcChannel.petDragMove, () => {
    if (!dragging) return
    const cursor = screen.getCursorScreenPoint()
    const { x, y } = clampToDisplays(
      cursor.x - grabOffset.x,
      cursor.y - grabOffset.y,
      PET_SIZE,
      PET_SIZE,
    )
    win.setPosition(x, y, false)
  })

  ipcMain.on(IpcChannel.petDragEnd, () => {
    if (!dragging) return
    dragging = false
    const bounds = win.getBounds()
    persistPosition(bounds.x, bounds.y)
    onDragEnd?.()
  })
}

export function petRendererUrl(): { url: string; isDev: boolean } {
  if (process.env.ELECTRON_RENDERER_URL) {
    return { url: process.env.ELECTRON_RENDERER_URL, isDev: true }
  }
  return { url: join(__dirname, '../renderer/index.html'), isDev: false }
}
