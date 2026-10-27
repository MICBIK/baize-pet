// SPDX-License-Identifier: AGPL-3.0-only
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadCharacterPack } from '@baize/core'
import { presetById } from '@baize/llm'
import { IpcChannel } from '@baize/shared'
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  ipcMain,
  net,
  protocol,
  shell,
} from 'electron'
import { PetBrain } from './brain'
import { charactersRoot, loadCharacter } from './character'
import { ChatService, type WizardDraft } from './chat-service'
import { ConfigStore } from './config'
import { createAppMemory } from './memory'
import { registerMemoryIpc } from './memory-ipc'
import { createPetWindow, petRendererUrl, registerPetIpc } from './pet-window'
import { createTray } from './tray'

const BUILT_IN_PACK_ID = 'placeholder'

// Custom scheme serving character pack files to the renderer (media-src in the CSP).
// standard/secure/corsEnabled are required so <video> frames stay untainted for the
// renderer's canvas alpha hit test (a tainted canvas makes the pet unclickable).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'baize-character',
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
])

function registerCharacterProtocol(): void {
  const root = app.isPackaged
    ? resolve(process.resourcesPath, 'characters')
    : resolve(app.getAppPath(), '../../characters')
  protocol.handle('baize-character', async (request) => {
    const url = new URL(request.url)
    // The pack directory must live directly inside the characters root, and the
    // requested file inside that pack directory (separator-aware comparison).
    const packDir = resolve(root, decodeURIComponent(url.hostname))
    if (!isInside(root, packDir)) {
      return new Response('forbidden', { status: 403 })
    }
    const filePath = resolve(packDir, decodeURIComponent(url.pathname).replace(/^\//, ''))
    if (!isInside(packDir, filePath)) {
      return new Response('forbidden', { status: 403 })
    }
    const response = await net.fetch(pathToFileURL(filePath).toString())
    // Mirror the file response with a permissive CORS header so cross-origin
    // <video> consumption keeps the drawing buffer readable.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: { ...Object.fromEntries(response.headers), 'Access-Control-Allow-Origin': '*' },
    })
  })
}

/** True when `child` equals or lies inside `parent` (no sibling-prefix escapes). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function rendererWindowOptions(title: string): BrowserWindowConstructorOptions {
  return {
    show: false,
    autoHideMenuBar: true,
    title,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

function loadRendererPage(win: BrowserWindow, page: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}/${page}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer', page))
  }
}

app
  .whenReady()
  .then(() => {
    registerCharacterProtocol()

    const config = ConfigStore.load(app.getPath('userData'))
    const character = loadCharacter(BUILT_IN_PACK_ID)
    const pack = loadCharacterPack(join(charactersRoot(), BUILT_IN_PACK_ID))
    const brain = new PetBrain(join(charactersRoot(), BUILT_IN_PACK_ID))

    let settingsWindow: BrowserWindow | null = null
    const openSettings = () => {
      if (!settingsWindow || settingsWindow.isDestroyed()) {
        settingsWindow = new BrowserWindow({
          ...rendererWindowOptions('BaiZe 设置'),
          width: 440,
          height: 640,
        })
        settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault())
        loadRendererPage(settingsWindow, 'settings.html')
      }
      settingsWindow.show()
    }

    let chatWindow: BrowserWindow | null = null
    const getChatWindow = () => (chatWindow && !chatWindow.isDestroyed() ? chatWindow : null)
    const openChat = () => {
      if (!getChatWindow()) {
        chatWindow = new BrowserWindow({
          ...rendererWindowOptions('BaiZe 对话'),
          width: 320,
          height: 480,
        })
        chatWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        chatWindow.webContents.on('will-navigate', (event) => event.preventDefault())
        loadRendererPage(chatWindow, 'chat.html')
      }
      chatWindow?.show()
    }

    const memory = createAppMemory()
    const chat = new ChatService(
      memory,
      config,
      getChatWindow,
      () => {
        petWindow.webContents.send(IpcChannel.petSay, '（悄悄把这个名字记在了心里）')
      },
      pack.persona,
    )

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
      // Clicking the pet opens the chat input (docs/07 M4).
      openChat()
    })

    // Spontaneous behavior: suppressed while hidden or in do-not-disturb.
    setInterval(() => {
      if (!petWindow.isVisible() || config.get().dnd) return
      const pick = brain.tick()
      if (!pick) return
      petWindow.webContents.send(IpcChannel.petAction, pick.action)
      if (pick.line) petWindow.webContents.send(IpcChannel.petSay, pick.line)
    }, 60_000)

    ipcMain.handle(IpcChannel.petGetCharacter, () => character)
    registerMemoryIpc(memory, () => settingsWindow)

    // -- Model wizard & chat (M4) -------------------------------------------
    ipcMain.handle(IpcChannel.modelGet, () => chat.status())
    ipcMain.handle(IpcChannel.wizardSave, (_event, draft: WizardDraft) => {
      try {
        return chat.saveWizard(draft).then(() => ({ ok: true }))
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    ipcMain.handle(IpcChannel.wizardTest, (_event, draft: WizardDraft) =>
      chat.testConnectivity(draft),
    )
    ipcMain.handle(IpcChannel.wizardOpenKeyPage, (_event, providerId: string) => {
      // Whitelist: only URLs from our own preset table are ever opened.
      const url = presetById(providerId)?.keyUrl
      if (url) void shell.openExternal(url)
    })
    ipcMain.handle(IpcChannel.chatSend, (_event, text: unknown) => {
      if (typeof text === 'string' && text.trim().length > 0 && text.length <= 2000) {
        return chat.send(text.trim()).then(() => ({ ok: true }))
      }
      return { ok: false, error: '消息为空或过长' }
    })
    ipcMain.handle(IpcChannel.chatHistory, () => chat.history())

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

    // First launch: the model wizard appears automatically (docs/07 M4).
    if (!config.get().wizardDone) {
      setTimeout(openSettings, 1200)
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
