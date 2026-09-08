import { BrowserWindow, shell, screen } from 'electron'
import { join } from 'node:path'

/** electron-vite dev 模式下注入 ELECTRON_RENDERER_URL；无该变量即为生产（T0.5） */
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL

/**
 * 窗口生命周期管理（任务 T0.5 / design.md 第 2 节）
 * 第一阶段只实建 MainWindow；Overlay/Hud/Popover 惰性创建。
 */

export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private quickWindow: BrowserWindow | null = null

  owns(window: BrowserWindow): boolean { return window === this.mainWindow || window === this.quickWindow }

  showQuickWindow(automatic = false): BrowserWindow {
    if (!this.quickWindow || this.quickWindow.isDestroyed()) {
      const window = new BrowserWindow({
        width: 480, height: 640, minWidth: 360, minHeight: 420, show: false,
        title: 'TermLens', alwaysOnTop: true, autoHideMenuBar: true, skipTaskbar: true,
        backgroundColor: '#f5f6f8',
        webPreferences: { preload: join(__dirname, '../preload/index.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false }
      })
      this.quickWindow = window
      window.on('close', (event) => { event.preventDefault(); window.hide() })
      window.on('closed', () => { this.quickWindow = null })
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      if (DEV_SERVER_URL) {
        const url = new URL(DEV_SERVER_URL)
        url.pathname = '/main-window/index.html'
        url.hash = '/quick'
        void window.loadURL(url.toString())
      } else { void window.loadFile(join(__dirname, '../renderer/main-window/index.html'), { hash: '/quick' }) }
      window.on('ready-to-show', () => { if (automatic) window.showInactive(); else window.show() })
    }
    const cursor = screen.getCursorScreenPoint()
    const bounds = screen.getDisplayNearestPoint(cursor).workArea
    const [width, height] = this.quickWindow.getSize()
    this.quickWindow.setPosition(Math.max(bounds.x, Math.min(cursor.x + 12, bounds.x + bounds.width - width)), Math.max(bounds.y, Math.min(cursor.y + 18, bounds.y + bounds.height - height)))
    if (automatic) this.quickWindow.showInactive()
    else { this.quickWindow.show(); this.quickWindow.focus() }
    return this.quickWindow
  }

  hideQuickWindow(): void { this.quickWindow?.hide() }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  showSources(): void {
    const window = this.showMainWindow()
    const navigate = (): void => { void window.webContents.executeJavaScript("location.hash = '/sources'") }
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', navigate)
    else navigate()
    this.hideQuickWindow()
  }

  showMainWindow(): BrowserWindow {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) this.mainWindow.restore()
      this.mainWindow.show()
      this.mainWindow.focus()
      return this.mainWindow
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 380,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      title: 'TermLens',
      backgroundColor: '#0f1115',
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    win.on('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.mainWindow = null
    })

    // 外链交还系统浏览器，不在应用内打开（NFR-6）
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event) => event.preventDefault())

    if (DEV_SERVER_URL) {
      const url = new URL(DEV_SERVER_URL)
      url.pathname = '/main-window/index.html'
      void win.loadURL(url.toString())
    } else {
      void win.loadFile(join(__dirname, '../renderer/main-window/index.html'))
    }

    this.mainWindow = win
    return win
  }

  closeAll(): void {
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
  }
}
