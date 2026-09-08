import { ConfigService } from '@main/config/config-service'
import { ModeService } from '@main/mode/mode-service'
import { SqliteRepository } from '@main/data/sqlite-repository'
import { WindowManager } from './window-manager'
import { TrayService } from './tray-service'
import { HotkeyService } from './hotkey-service'
import { registerIpc } from './register-ipc'
import { TermService } from '../terms/term-service'
import { SelectionService } from './selection-service'
import { dialog } from 'electron'

/**
 * 应用内核（任务 T0.5）
 * 装配顺序：Config → SecureStore(自动) → Mode → Repository → Windows/Tray/Hotkey → IPC
 */
export class AppKernel {
  readonly config: ConfigService
  readonly mode: ModeService
  readonly repo: SqliteRepository
  readonly windows: WindowManager
  readonly tray: TrayService
  readonly hotkeys: HotkeyService
  readonly terms: TermService
  readonly selection: SelectionService
  private cleaned = false

  constructor() {
    this.config = new ConfigService()
    this.mode = new ModeService(this.config)
    this.repo = new SqliteRepository()
    this.terms = new TermService(this.repo, this.config)
    this.windows = new WindowManager()
    this.selection = new SelectionService((_snapshot, automatic) => this.windows.showQuickWindow(automatic))
    this.tray = new TrayService(this.windows, () => this.mode.mode, async () => this.dispose())
    this.hotkeys = new HotkeyService()
  }

  async init(): Promise<void> {
    await this.repo.init()
    registerIpc(this)
    this.windows.showQuickWindow()
    this.tray.create()
    const hotkey = this.config.getRaw().term.selectionHotkey
    if (!this.hotkeys.bind(hotkey, () => { void this.selection.capture() })) {
      void dialog.showMessageBox({ type: 'warning', title: 'TermLens', message: '选词快捷键无法启用', detail: `${hotkey} 可能已被其他软件占用。关闭占用后重启 TermLens，或在浮窗中粘贴文字。` })
    }
    this.selection.configure(this.config.getRaw().term.selectionAuto)

    // mode 切换联动：托盘菜单重建 + 渲染进程通知
    this.mode.on('changed', (mode: string) => {
      this.tray.rebuildMenu()
      this.windows.getMainWindow()?.webContents.send('evt:mode:changed', mode)
    })

    this.config.on('changed', (snapshot: unknown) => {
      this.windows.getMainWindow()?.webContents.send('evt:config:changed', snapshot)
    })

    // 防录屏默认值：明确关闭（决策 D5 / FR-6.7）
    this.windows.getMainWindow()?.setContentProtection(false)
  }

  showMainWindow(): void {
    this.windows.showMainWindow()
  }

  async dispose(): Promise<void> {
    if (this.cleaned) return
    this.cleaned = true
    this.hotkeys.unregisterAll()
    this.terms.dispose()
    this.selection.dispose()
    this.tray.destroy()
    this.repo.close()
    this.windows.closeAll()
  }
}
