import { Tray, Menu, app, nativeImage } from 'electron'
import type { WindowManager } from './window-manager'

/**
 * 系统托盘（design.md 第 2 节）。
 * 图标文件暂缺：先用空图标占位，后续 P5 打包阶段替换为正式 ico。
 * 托盘菜单按 mode 动态重建（C-14 双形态隔离手段之一）。
 */
export class TrayService {
  private tray: Tray | null = null

  constructor(
    private readonly windows: WindowManager,
    private readonly getMode: () => 'public' | 'developer',
    private readonly onQuit: () => Promise<void>
  ) {}

  create(): void {
    const pixels = Buffer.alloc(16 * 16 * 4)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const mark = (y >= 3 && y <= 5 && x >= 3 && x <= 12) || (y >= 6 && y <= 12 && x >= 7 && x <= 9)
      const offset = (y * 16 + x) * 4
      pixels[offset] = mark ? 255 : 90
      pixels[offset + 1] = mark ? 255 : 103
      pixels[offset + 2] = mark ? 255 : 19
      pixels[offset + 3] = 255
    }
    const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 })
    this.tray = new Tray(icon)
    this.tray.setToolTip('TermLens')
    this.tray.on('click', () => this.windows.showQuickWindow())
    this.rebuildMenu()
  }

  /** mode 切换时由 ModeService 事件驱动调用 */
  rebuildMenu(): void {
    if (!this.tray) return
    const isDev = this.getMode() === 'developer'

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: '打开解释浮窗', click: () => this.windows.showQuickWindow() },
      { label: '记录与设置', click: () => this.windows.showMainWindow() },
      { type: 'separator' },
      // 开发者形态下才出现（C-14：public 形态零泄漏）
      ...(isDev
        ? ([
            { label: '开发者工具', click: () => undefined },
            { type: 'separator' }
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { label: `当前形态：${isDev ? '开发者' : '对外'}`, enabled: false },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          void this.onQuit().then(() => app.quit())
        }
      }
    ]

    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
