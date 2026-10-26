// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 280,
    show: false,
    autoHideMenuBar: true,
    title: 'BaiZe',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.on('ready-to-show', () => win.show())
  // Security baseline: the renderer never navigates and never opens new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app
  .whenReady()
  .then(() => {
    createMainWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
  .catch((error: unknown) => {
    console.error('Failed to start BaiZe:', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
