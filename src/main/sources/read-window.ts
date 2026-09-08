import { app } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ExtractedSource, SourceSegment } from '@shared/types/source'

export function readCurrentWindow(signal: AbortSignal): Promise<ExtractedSource> {
  if (process.platform !== 'win32') return Promise.reject(new Error('当前窗口读取目前只支持 Windows。'))
  const temporary = join(app.getPath('userData'), 'native-temp')
  mkdirSync(temporary, { recursive: true })
  const script = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'read-window.ps1') : join(app.getAppPath(), 'scripts', 'read-window.ps1')
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('任务已停止。')); return }
    const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OwnerProcessId', String(process.pid)], { windowsHide: true, env: { ...process.env, TEMP: temporary, TMP: temporary }, stdio: ['ignore', 'pipe', 'pipe'] })
    let raw = ''
    let settled = false
    const done = (error?: string, result?: ExtractedSource): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      child.kill()
      if (error) reject(new Error(error))
      else resolve(result!)
    }
    const abort = (): void => done('任务已停止。')
    const timer = setTimeout(() => done('当前软件未及时提供文字。请导入文件，或只选择需要解释的文字。'), 12000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (part: string) => { raw += part; if (raw.length > 3200000) done('窗口文字过多，请缩小范围或导入文件。') })
    child.stderr.on('data', () => {})
    child.on('error', () => done('系统文字读取组件无法启动。'))
    child.on('close', () => {
      if (settled) return
      try {
        const result = JSON.parse(raw) as { title?: unknown; text?: unknown }
        if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('empty')
        if (result.text.length > 500000) { done('窗口文字超过 50 万字符，请改用文件导入或缩小范围。'); return }
        const segments: SourceSegment[] = []
        for (let index = 0; index < result.text.length; index += 8000) segments.push({ id: `window-${segments.length + 1}`, label: `窗口文本第 ${segments.length + 1} 段`, text: result.text.slice(index, index + 8000) })
        done(undefined, { title: typeof result.title === 'string' ? result.title.slice(0, 200) : '当前窗口', kind: 'window', location: '', format: '窗口文字', coverage: 'partial', coverageNote: '只读取软件当前向系统提供的文字区域，不能证明包含整份文档。', warnings: ['图片、未加载页和未提供给系统的内容可能缺失；此功能不进行截屏或录音。'], segments })
      } catch { done('未读取到当前软件的文字。请切到正文并按 Ctrl+Shift+R，保持窗口不切换直至读取完成；也可直接导入文件。') }
    })
  })
}
