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
import { SourceService } from '../sources/source-service'
import { readCurrentWindow } from '../sources/read-window'

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
  readonly sources: SourceService
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
    this.sources = new SourceService(this.repo, this.config, this.terms)
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
    this.sources.pause(this.config.getRaw().term.assistantPaused)
    this.selection.configure(this.config.getRaw().term.selectionAuto && !this.sources.status().paused)
    if (!this.hotkeys.bind('Control+Shift+R', () => {
      if (this.sources.status().paused || this.sources.status().tasks.some((task) => ['queued', 'running'].includes(task.state))) {
        void dialog.showMessageBox({ type: 'info', message: '请先恢复助手并等待当前资料任务完成，再读取当前窗口。' })
        return
      }
      this.sources.import({ kind: 'window' }, readCurrentWindow)
    })) void dialog.showMessageBox({ type: 'warning', message: '读取当前窗口快捷键 Ctrl+Shift+R 被占用，仍可从资料阅读导入文件或网址。' })

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
    this.sources.dispose()
    this.terms.dispose()
    this.selection.dispose()
    this.tray.destroy()
    this.repo.close()
    this.windows.closeAll()
  }
}
