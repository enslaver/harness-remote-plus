import { Menu, Tray, nativeImage } from "electron"

export type TrayHandlers = {
  /** Absolute path to the icon image. */
  iconPath: string
  tooltip: string
  openLabel: string
  quitLabel: string
  onOpen: () => void
  onQuit: () => void
}

/** The menu behind a right click: the way back to the window, and the way to stop the service for good. */
export function trayMenuTemplate({ openLabel, quitLabel, onOpen, onQuit }: Pick<TrayHandlers, "openLabel" | "quitLabel" | "onOpen" | "onQuit">): Electron.MenuItemConstructorOptions[] {
  return [
    { label: openLabel, click: onOpen },
    { type: "separator" },
    { label: quitLabel, click: onQuit }
  ]
}

/**
 * A notification-area icon: click (or double-click) to bring the window back, right click for the menu.
 * The caller keeps the returned Tray for the life of the app; a collected Tray silently loses its icon.
 */
export function createTray(handlers: TrayHandlers): Tray | undefined {
  const icon = nativeImage.createFromPath(handlers.iconPath)
  if (icon.isEmpty()) return undefined
  const tray = new Tray(icon.resize({ width: 32, height: 32 }))
  tray.setToolTip(handlers.tooltip)
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(handlers)))
  tray.on("click", handlers.onOpen)
  tray.on("double-click", handlers.onOpen)
  return tray
}
