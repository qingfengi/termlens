import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { SelectionSnapshot } from '@shared/ipc/api'

export class SelectionService {
  private child?: ChildProcessWithoutNullStreams
  private pending?: { resolve: (value: { text: string; error?: string }) => void; timer: ReturnType<typeof setTimeout> }
  private buffer = ''
  private autoTimer?: ReturnType<typeof setInterval>
  private generation = 0
  private disposed = false
  private lastText = ''
  private counter = 0
  snapshot: SelectionSnapshot = { id: 0, text: '', automatic: false }

  constructor(private readonly show: (snapshot: SelectionSnapshot, automatic: boolean) => void) {}

  configure(enabled: boolean): void {
    this.generation++
    if (this.autoTimer) clearInterval(this.autoTimer)
    this.autoTimer = undefined
    this.lastText = ''
    if (enabled && !this.disposed) this.autoTimer = setInterval(() => { if (!this.pending) void this.capture(true) }, 700)
  }

  async capture(automatic = false): Promise<void> {
    if (this.disposed || this.pending || (automatic && !this.autoTimer)) return
    const generation = this.generation
    let selected: { text: string; error?: string }
    try { selected = await this.read() }
    catch { this.fail(); selected = { text: '', error: 'unavailable' } }
    if (this.disposed || (automatic && generation !== this.generation)) return
    if (!selected.text && automatic) { this.lastText = ''; return }
    if (automatic && selected.text === this.lastText) return
    this.lastText = selected.text
    this.snapshot = {
      id: ++this.counter, text: selected.text, automatic,
      ...(!selected.text ? { error: selected.error === 'too_long' ? '选中文字超过 16000 字符，请缩小范围。' : '未读到选中文字；该软件可能没有提供文字选择接口。可在这里粘贴词语。' } : {})
    }
    this.show(this.snapshot, automatic)
  }

  private read(): Promise<{ text: string; error?: string }> {
    if (process.platform !== 'win32') return Promise.resolve({ text: '', error: 'unavailable' })
    if (!this.child) {
      const temporary = join(app.getPath('userData'), 'native-temp')
      mkdirSync(temporary, { recursive: true })
      this.child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'selected-text.ps1') : join(app.getAppPath(), 'scripts', 'selected-text.ps1'), '-OwnerProcessId', String(process.pid)],
        { windowsHide: true, env: { ...process.env, TEMP: temporary, TMP: temporary }, stdio: ['pipe', 'pipe', 'pipe'] })
      const launched = this.child
      this.child.stdout.setEncoding('utf8')
      this.child.stdout.on('data', (part: string) => {
        if (this.child !== launched) return
        this.buffer += part
        if (this.buffer.length > 150000) { this.fail(); return }
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) return
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        try {
          const value = JSON.parse(line) as { text?: unknown; error?: unknown }
          this.finish({ text: typeof value.text === 'string' ? value.text.slice(0, 16000) : '', error: typeof value.error === 'string' ? value.error : undefined })
        } catch { this.fail() }
      })
      this.child.stderr.on('data', () => { /* Native failures are reported without selection text. */ })
      this.child.on('error', () => { if (this.child === launched) this.fail() })
      this.child.on('exit', () => { if (this.child === launched) { this.child = undefined; this.buffer = ''; this.finish({ text: '', error: 'unavailable' }) } })
    }
    return new Promise((resolve) => {
      this.pending = { resolve, timer: setTimeout(() => this.fail(), 6000) }
      const launched = this.child
      launched?.stdin.write('read\n', (error) => { if (error && this.child === launched) this.fail() })
    })
  }

  private finish(value: { text: string; error?: string }): void {
    if (!this.pending) return
    const pending = this.pending
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  private fail(): void {
    const child = this.child
    this.child = undefined
    this.buffer = ''
    this.finish({ text: '', error: 'unavailable' })
    child?.kill()
  }

  dispose(): void {
    this.disposed = true
    if (this.autoTimer) clearInterval(this.autoTimer)
    this.fail()
  }
}
