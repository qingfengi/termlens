import { globalShortcut } from 'electron'

/**
 * 全局快捷键注册表（任务 T0.11 前置 / design.md 第 2 节）。
 * 所有加速器集中管理，模式切换时按需注册/注销（C-14）。
 */
export class HotkeyService {
  private readonly registered = new Map<string, () => void>()

  /** 注册全局快捷键；相同 accelerator 重复注册不会报错 */
  bind(accelerator: string, handler: () => void): boolean {
    if (this.registered.has(accelerator)) return true
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (ok) this.registered.set(accelerator, handler)
      return ok
    } catch {
      return false
    }
  }

  unbind(accelerator: string): void {
    if (this.registered.delete(accelerator)) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        /* no-op */
      }
    }
  }

  unregisterAll(): void {
    for (const key of [...this.registered.keys()]) this.unbind(key)
  }
}
