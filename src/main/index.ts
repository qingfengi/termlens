/**
 * 主进程入口（任务 T0.5）
 * 职责：初始化内核 → 加载配置 → 注册 IPC → 拉起主窗口 → 系统托盘
 */

import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { AppKernel } from './kernel/app-kernel'

if (process.env.TERMLENS_DATA_DIR) {
  const directory = process.env.TERMLENS_DATA_DIR
  if (!isAbsolute(directory)) throw new Error('TERMLENS_DATA_DIR must be an absolute path.')
  mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
  app.setPath('sessionData', join(directory, 'chromium'))
  app.setPath('logs', join(directory, 'logs'))
}
let activeKernel: AppKernel | undefined

app.whenReady().then(async () => {
  const kernel = new AppKernel()
  activeKernel = kernel
  await kernel.init()

  app.on('activate', () => {
    // macOS 习惯兼容，Windows 下无害
    if (BrowserWindow.getAllWindows().length === 0) kernel.showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // 保留托盘驻留：关闭窗口不退出，由托盘右键"退出"才真正退出
  if (process.platform !== 'darwin') {
    // 不调用 app.quit()，等待托盘入口退出
  }
})

app.on('before-quit', () => {
  void activeKernel?.dispose()
})

process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandledRejection:', reason)
})
