// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'node:path'
import { app, type BrowserWindow, Menu, nativeImage, Tray } from 'electron'

function trayIconPath(): string {
  if (app.isPackaged) {
    return resolve(process.resourcesPath, 'assets', 'tray.png')
  }
  return resolve(app.getAppPath(), '../../assets/tray.png')
}

export interface TrayCallbacks {
  togglePet: () => void
  openSettings: () => void
  quit: () => void
  getDnd: () => boolean
  setDnd: (value: boolean) => void
}

export function createTray(petWindow: BrowserWindow, callbacks: TrayCallbacks): Tray {
  const tray = new Tray(nativeImage.createFromPath(trayIconPath()))
  tray.setToolTip('BaiZe（白泽）')
  if (process.platform === 'darwin') {
    tray.setTitle('白泽')
  }

  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏宠物',
        click: callbacks.togglePet,
      },
      {
        label: '勿扰',
        type: 'checkbox',
        checked: callbacks.getDnd(),
        click: (item) => callbacks.setDnd(item.checked),
      },
      { type: 'separator' },
      {
        label: '设置',
        click: callbacks.openSettings,
      },
      { type: 'separator' },
      {
        label: '退出',
        click: callbacks.quit,
      },
    ])
    tray.setContextMenu(menu)
  }

  rebuildMenu()
  // Re-read the DND state whenever the menu is about to open.
  tray.on('click', () => {
    petWindow.show()
  })
  tray.on('mouse-move', rebuildMenu)
  return tray
}
