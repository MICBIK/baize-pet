// SPDX-License-Identifier: AGPL-3.0-only
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IpcChannel } from '@baize/shared'
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron'
import { PetBrain } from './brain'
import { charactersRoot, loadCharacter } from './character'
import { ConfigStore } from './config'
import { createPetWindow, petRendererUrl, registerPetIpc } from './pet-window'
import { createTray } from './tray'

const BUILT_IN_PACK_ID = 'placeholder'

// Custom scheme serving character pack files to the renderer (media-src in the CSP).
protocol.registerSchemesAsPrivileged([
  { scheme: 'baize-character', privileges: { stream: true, supportFetchAPI: true } },
])

function registerCharacterProtocol(): void {
  const root = app.isPackaged
    ? resolve(process.resourcesPath, 'characters')
    : resolve(app.getAppPath(), '../../characters')
  protocol.handle('baize-character', (request) => {
    const url = new URL(request.url)
    const packDir = resolve(root, url.hostname)
    const filePath = resolve(packDir, decodeURIComponent(url.pathname).replace(/^\//, ''))
    if (!filePath.startsWith(packDir)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function createSettingsWindow(): BrowserWindow {
  const settings = new BrowserWindow({
    width: 420,
    height: 540,
    show: false,
    autoHideMenuBar: true,
    title: 'BaiZe 设置',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  settings.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  settings.webContents.on('will-navigate', (event) => event.preventDefault())
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void settings.loadURL(`${devUrl}/settings.html`)
  } else {
    void settings.loadFile(join(__dirname, '../renderer/settings.html'))
  }
  return settings
}

app
  .whenReady()
  .then(() => {
    registerCharacterProtocol()

    const config = ConfigStore.load(app.getPath('userData'))
    const character = loadCharacter(BUILT_IN_PACK_ID)
    const brain = new PetBrain(join(charactersRoot(), BUILT_IN_PACK_ID))

    const petWindow = createPetWindow(config.get().petWindow)
    registerPetIpc(
      petWindow,
      (x, y) => config.set({ petWindow: { x, y } }),
      () => {
        const line = brain.onInteraction('drag')
        if (line) petWindow.webContents.send(IpcChannel.petSay, line)
      },
    )

    ipcMain.on(IpcChannel.petClick, () => {
      const line = brain.onInteraction('click')
      if (line) petWindow.webContents.send(IpcChannel.petSay, line)
    })

    // Spontaneous behavior: suppressed while hidden or in do-not-disturb.
    setInterval(() => {
      if (!petWindow.isVisible() || config.get().dnd) return
      const pick = brain.tick()
      if (!pick) return
      petWindow.webContents.send(IpcChannel.petAction, pick.action)
      if (pick.line) petWindow.webContents.send(IpcChannel.petSay, pick.line)
    }, 60_000)

    let settingsWindow: BrowserWindow | null = null
    const openSettings = () => {
      if (!settingsWindow || settingsWindow.isDestroyed()) {
        settingsWindow = createSettingsWindow()
      }
      settingsWindow.show()
    }

    ipcMain.handle(IpcChannel.petGetCharacter, () => character)

    createTray(petWindow, {
      togglePet: () => {
        if (petWindow.isVisible()) {
          petWindow.hide()
        } else {
          petWindow.show()
        }
      },
      openSettings,
      quit: () => app.quit(),
      getDnd: () => config.get().dnd,
      setDnd: (value) => config.set({ dnd: value }),
    })

    const { url, isDev } = petRendererUrl()
    if (isDev) {
      void petWindow.loadURL(url)
    } else {
      void petWindow.loadFile(url)
    }
  })
  .catch((error: unknown) => {
    console.error('Failed to start BaiZe:', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  // The pet lives in the tray; keep running on macOS. Quit only via the tray menu.
  if (process.platform !== 'darwin') app.quit()
})
